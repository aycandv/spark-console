"""1 Hz sampler: one snapshot per second, 1 h of history in memory, min/max/avg since reset."""
import json
import os
import subprocess
import threading
import time
import urllib.request
from collections import deque

from . import sources

PAGE_KIB = os.sysconf("SC_PAGE_SIZE") // 1024
HZ = os.sysconf("SC_CLK_TCK")
SERVICES = ("gb10-clocklock.service", "cpu-epp.service", "nv-cpu-governor.service",
            "nvidia-persistenced.service", "dgx-dashboard.service")


# --- pure helpers (tested) -----------------------------------------------------------

class History:
    def __init__(self, maxlen=3600):
        self._rows = deque(maxlen=maxlen)

    def add(self, t, values: dict):
        self._rows.append((t, values))

    def columns(self, window_s, now):
        rows = [r for r in self._rows if r[0] >= now - window_s]
        keys = sorted({k for _, v in rows for k in v})
        out = {"t": [t for t, _ in rows]}
        for k in keys:
            out[k] = [v.get(k) for _, v in rows]
        return out


class Stats:
    def __init__(self):
        self.reset()

    def reset(self):
        self._s = {}
        self.since = time.time()

    def add(self, values: dict):
        for k, v in values.items():
            if v is None:
                continue
            s = self._s.setdefault(k, [v, v, 0.0, 0])
            s[0], s[1], s[2], s[3] = min(s[0], v), max(s[1], v), s[2] + v, s[3] + 1

    def get(self):
        return {k: {"min": s[0], "max": s[1], "avg": round(s[2] / s[3], 2), "n": s[3]} for k, s in self._s.items()}


class Rate:
    """Per-second rate of a monotonic counter."""

    def __init__(self):
        self._last = None

    def update(self, value, t):
        last, self._last = self._last, (value, t)
        if last is None or value < last[0] or t <= last[1]:
            return None
        return round((value - last[0]) / (t - last[1]), 2)


def j_per_token(power_w, tok_s):
    if power_w is None or tok_s is None or tok_s < 1:
        return None
    return round(power_w / tok_s, 3)


def cluster_summary(pols, utils):
    out = {}
    for c in ("x925", "a725"):
        ps = [p for p in pols if p["cluster"] == c]
        if not ps:
            continue
        us = [utils.get(f"cpu{p['policy']}") for p in ps]
        us = [u for u in us if u is not None]
        out[c] = {
            "cores": len(ps),
            "mhz": round(sum(p["cur_khz"] or 0 for p in ps) / len(ps) / 1000),
            "util": round(sum(us) / len(us), 1) if us else None,
            "max_mhz": round(ps[0]["max_khz"] / 1000),
            "hw_min_mhz": round(ps[0]["hw_min_khz"] / 1000),
            "hw_max_mhz": round(ps[0]["hw_max_khz"] / 1000),
            "perf_limited": sum(1 for p in ps if p.get("perf_limited")),
        }
    return out


def process_rows(prev, cur, dt, gpu_mib, hz=HZ, page_kib=PAGE_KIB, limit=150):
    """Top `limit` processes by CPU %, plus every process that holds GPU memory."""
    rows = []
    for p in cur:
        old = prev.get(p["pid"])
        cpu = round(100.0 * (p["ticks"] - old["ticks"]) / hz / dt, 1) if old and dt > 0 else None
        rows.append({"pid": p["pid"], "ppid": p["ppid"], "comm": p["comm"], "state": p["state"], "cpu": cpu,
                     "rss_mib": round(p["rss_pages"] * page_kib / 1024, 2), "gpu_mib": gpu_mib.get(p["pid"])})
    rows.sort(key=lambda r: -(r["cpu"] or 0))
    top = rows[:limit]
    seen = {r["pid"] for r in top}
    # shortcut: only the top rows are sent; tree view shows missing parents as roots. Send all if users need full trees.
    return top + [r for r in rows[limit:] if r["gpu_mib"] and r["pid"] not in seen]


# --- the sampler (glue) ------------------------------------------------------------------

def _read(path):
    with open(path) as f:
        return f.read()


class GpuStream:
    """One long-lived `nvidia-smi -lms 1000` instead of a 40 ms process start every second."""

    def __init__(self, cmd="nvidia-smi"):
        self.cmd, self.latest, self.error = cmd, None, None
        threading.Thread(target=self._loop, daemon=True, name="gpu-stream").start()

    def _loop(self):
        while True:
            try:
                p = subprocess.Popen([self.cmd, f"--query-gpu={sources.NVSMI_QUERY}",
                                      "--format=csv,noheader,nounits", "-lms", "1000"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                for line in p.stdout:
                    g = sources.parse_nvsmi(line.strip())
                    if g:
                        self.latest, self.error = (time.time(), g), None
                p.wait()
                self.error = f"nvidia-smi exited ({p.returncode})"
            except OSError as e:
                self.error = str(e)
            time.sleep(5)


class Sampler:
    def __init__(self, llm_urls=(), cpu_root="/sys/devices/system/cpu", class_root="/sys/class", proc_root="/proc"):
        self.llm_urls, self.cpu_root, self.class_root, self.proc_root = list(llm_urls), cpu_root, class_root, proc_root
        self.history, self.stats = History(), Stats()
        self.snapshot, self.seq = None, 0
        self.cond = threading.Condition()
        self.gpu = GpuStream()
        self.control_status = lambda: None
        self._prev_stat = None
        self._prev_procs, self._prev_procs_t = {}, None
        self._llm = {u: {"rate": Rate(), "ok": False, "tok_s": None, "running": None, "model": None, "engine": None}
                     for u in self.llm_urls}
        self._slow = {"gpu_mib": {}, "services": {}}
        threading.Thread(target=self._slow_loop, daemon=True, name="slow").start()

    # Slow sources: GPU memory per process, LLM metrics, service states.
    def _slow_loop(self):
        n = 0
        while True:
            for u in self.llm_urls:
                self._poll_llm(u, models=n % 30 == 0)
            if n % 5 == 0:
                self._slow["gpu_mib"] = self._compute_apps()
            if n % 10 == 0:
                self._slow["services"] = self._services()
            n += 1
            time.sleep(1)

    def _poll_llm(self, url, models):
        st = self._llm[url]
        try:
            with urllib.request.urlopen(f"{url}/metrics", timeout=0.5) as r:
                prom = sources.parse_prom(r.read().decode("utf-8", "replace"))
            gen = next((prom[m] for m in sources.GEN_TOKEN_METRICS if m in prom), None)
            st["engine"] = next((m.split(":")[0] for m in sources.GEN_TOKEN_METRICS if m in prom), None)
            st["tok_s"] = st["rate"].update(gen, time.time()) if gen is not None else None
            st["running"] = next((prom[m] for m in sources.RUNNING_METRICS if m in prom), None)
            st["ok"] = True
            if models or st["model"] is None:
                with urllib.request.urlopen(f"{url}/v1/models", timeout=0.5) as r:
                    st["model"] = (json.load(r).get("data") or [{}])[0].get("id")
        except (OSError, ValueError):
            st.update(ok=False, tok_s=None, running=None)

    @staticmethod
    def _compute_apps():
        try:
            out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=5).stdout
            return sources.parse_compute_apps(out)
        except (OSError, subprocess.SubprocessError, ValueError):
            return {}

    @staticmethod
    def _services():
        out = {}
        try:
            text = subprocess.run(["systemctl", "show", "-p", "Id,ActiveState,SubState,UnitFileState", *SERVICES],
                                  capture_output=True, text=True, timeout=5).stdout
            out = {k: {"active": v.get("ActiveState"), "sub": v.get("SubState"), "enabled": v.get("UnitFileState")}
                   for k, v in sources.parse_systemctl_show(text).items()}
            st = subprocess.run(["docker", "inspect", "-f", "{{.State.Status}}", "sparkDash"],
                                capture_output=True, text=True, timeout=5)
            out["sparkDash (docker)"] = {"active": st.stdout.strip() or "absent", "sub": "", "enabled": ""}
        except (OSError, subprocess.SubprocessError):
            pass
        return out

    def tick(self):
        now = time.time()
        stat = sources.parse_proc_stat(_read(f"{self.proc_root}/stat"))
        utils = {k: sources.util(self._prev_stat[k], v) for k, v in stat.items()
                 if self._prev_stat and k in self._prev_stat}
        self._prev_stat = stat
        pols = sources.read_cpufreq(self.cpu_root)
        mem = sources.parse_meminfo(_read(f"{self.proc_root}/meminfo"))
        try:
            psi = sources.parse_psi(_read(f"{self.proc_root}/pressure/memory"))
        except OSError:
            psi = {}
        gpu_t, gpu = self.gpu.latest or (None, None)
        if gpu_t and now - gpu_t > 5:
            gpu = None  # stale stream
        procs = sources.read_processes(self.proc_root)
        dt = now - self._prev_procs_t if self._prev_procs_t else 0
        rows = process_rows(self._prev_procs, procs, dt, self._slow["gpu_mib"])
        self._prev_procs, self._prev_procs_t = {p["pid"]: p for p in procs}, now
        llm = [{"url": u, **{k: v for k, v in s.items() if k != "rate"}} for u, s in self._llm.items()]
        tok_s = sum(l["tok_s"] or 0 for l in llm if l["ok"]) if any(l["ok"] for l in llm) else None
        sensors = sources.read_sensors(self.class_root)
        clusters = cluster_summary(pols, utils)
        control = self.control_status()
        cur = (control or {}).get("current", {})
        snap = {
            "t": now,
            "gpu": gpu, "gpu_error": self.gpu.error,
            "cpu": {"util": utils.get("cpu"), "clusters": clusters,
                    "cores": [{"cpu": p["policy"], "cluster": p["cluster"], "mhz": round((p["cur_khz"] or 0) / 1000),
                               "util": utils.get(f"cpu{p['policy']}"), "perf_limited": p["perf_limited"]} for p in pols],
                    "epp": pols[0]["epp"], "governor": pols[0]["governor"], "governors": pols[0]["governors"]},
            "mem": {"total_kib": mem.get("MemTotal"), "avail_kib": mem.get("MemAvailable"),
                    "cached_kib": mem.get("Cached"), "swap_total_kib": mem.get("SwapTotal"),
                    "swap_used_kib": (mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)), "psi": psi},
            "sensors": sensors,
            "llm": {"endpoints": llm, "tok_s": tok_s, "j_per_tok": j_per_token((gpu or {}).get("power_w"), tok_s)},
            "procs": rows,
            "services": self._slow["services"],
            "control": control,
        }
        series = {
            "gpu.power_w": (gpu or {}).get("power_w"), "gpu.sm_mhz": (gpu or {}).get("sm_mhz"),
            "gpu.util": (gpu or {}).get("util"), "gpu.temp_c": (gpu or {}).get("temp_c"),
            "gpu.tlimit_c": (gpu or {}).get("tlimit_c"),
            "cpu.util": utils.get("cpu"),
            "mem.avail_gib": round(mem["MemAvailable"] / 1048576, 2) if "MemAvailable" in mem else None,
            "mem.psi_some10": (psi.get("some") or {}).get("avg10"),
            "llm.tok_s": tok_s, "llm.j_per_tok": snap["llm"]["j_per_tok"],
            "set.gpu_cap_mhz": cur.get("gpu_cap_mhz"),
        }
        for c, s in clusters.items():
            series[f"cpu.{c}_mhz"], series[f"cpu.{c}_util"], series[f"set.{c}_max_mhz"] = s["mhz"], s["util"], s["max_mhz"]
        for s in sensors:
            series[f"temp.{s['id']}"] = s["temp_c"]
        self.history.add(now, series)
        self.stats.add({k: v for k, v in series.items() if not k.startswith("set.")})
        snap["series"] = series
        snap["stats"] = self.stats.get()
        snap["stats_since"] = self.stats.since
        with self.cond:
            self.snapshot, self.seq = snap, self.seq + 1
            self.cond.notify_all()
        return snap

    def run_forever(self, on_tick=lambda: None):
        while True:
            start = time.time()
            try:
                on_tick()
                self.tick()
            except Exception as e:  # never let one bad read stop sampling
                print(f"sampler: {type(e).__name__}: {e}", flush=True)
            time.sleep(max(0.05, 1 - (time.time() - start)))
