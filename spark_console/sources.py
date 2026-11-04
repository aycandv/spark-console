"""Readers and parsers for the data spark-console shows. No root needed for any of them.

Parsers take text and return plain dicts so they can be tested without hardware.
"""
import os
import re

from .helper import policies

# --- /proc/stat ----------------------------------------------------------------

def parse_proc_stat(text: str) -> dict:
    """Return {"cpu": (busy, total), "cpu0": ...} in clock ticks. iowait counts as idle."""
    out = {}
    for line in text.splitlines():
        if not line.startswith("cpu"):
            continue
        name, *vals = line.split()
        v = [int(x) for x in vals[:8]] + [0] * (8 - len(vals[:8]))
        idle = v[3] + v[4]
        total = sum(v)  # guest time is already inside user/nice
        out[name] = (total - idle, total)
    return out


def util(prev, cur):
    """Busy % between two (busy, total) samples, or None when no ticks passed."""
    dt = cur[1] - prev[1]
    if dt <= 0:
        return None
    return round(100.0 * (cur[0] - prev[0]) / dt, 1)


# --- memory --------------------------------------------------------------------

def parse_meminfo(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            out[key] = int(parts[0])
    return out


def parse_psi(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        kind, *pairs = line.split()
        out[kind] = {k: (int(v) if k == "total" else float(v)) for k, v in (p.split("=") for p in pairs)}
    return out


# --- CPU frequency ---------------------------------------------------------------

def _readint(path):
    try:
        with open(path) as f:
            return int(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def _readstr(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def read_cpufreq(cpu_root: str) -> list:
    out = []
    for cluster, pols in policies(cpu_root).items():
        for pol in pols:
            n = int(pol.rsplit("policy", 1)[1])
            out.append({
                "policy": n,
                "cluster": cluster,
                "cur_khz": _readint(f"{pol}/scaling_cur_freq"),
                "min_khz": _readint(f"{pol}/scaling_min_freq"),
                "max_khz": _readint(f"{pol}/scaling_max_freq"),
                "hw_min_khz": _readint(f"{pol}/cpuinfo_min_freq"),
                "hw_max_khz": _readint(f"{pol}/cpuinfo_max_freq"),
                "epp": _readint(f"{pol}/energy_performance_preference_val"),
                "governor": _readstr(f"{pol}/scaling_governor"),
                "governors": (_readstr(f"{pol}/scaling_available_governors") or "").split(),
                "perf_limited": _readint(f"{pol}/perf_limited"),
            })
    return sorted(out, key=lambda p: p["policy"])


# --- temperatures ----------------------------------------------------------------

def read_sensors(class_root: str = "/sys/class") -> list:
    """Thermal zones plus labelled hwmon temps. acpitz hwmon entries are skipped: they mirror the zones."""
    out = []
    tz_dir = os.path.join(class_root, "thermal")
    for z in sorted(os.listdir(tz_dir)) if os.path.isdir(tz_dir) else []:
        if not z.startswith("thermal_zone"):
            continue
        t = _readint(os.path.join(tz_dir, z, "temp"))
        if t is not None:
            out.append({"id": z, "name": f"{_readstr(os.path.join(tz_dir, z, 'type'))} {z[12:]}", "temp_c": t / 1000})
    hw_dir = os.path.join(class_root, "hwmon")
    for h in sorted(os.listdir(hw_dir)) if os.path.isdir(hw_dir) else []:
        base = os.path.join(hw_dir, h)
        name = _readstr(os.path.join(base, "name")) or h
        if name.startswith("acpitz"):
            continue
        for f in sorted(os.listdir(base)):
            m = re.fullmatch(r"(temp\d+)_input", f)
            if not m:
                continue
            t = _readint(os.path.join(base, f))
            label = _readstr(os.path.join(base, f"{m[1]}_label"))
            if t is not None:
                out.append({"id": f"{h}/{m[1]}", "name": f"{name} {label or m[1]}", "temp_c": t / 1000})
    return out


# --- nvidia-smi ------------------------------------------------------------------

NVSMI_FIELDS = [
    ("util", "utilization.gpu", int),
    ("sm_mhz", "clocks.sm", int),
    ("mem_mhz", "clocks.mem", int),
    ("temp_c", "temperature.gpu", int),
    ("tlimit_c", "temperature.gpu.tlimit", int),  # headroom to HW slowdown
    ("power_w", "power.draw", float),
    ("reasons_mask", "clocks_event_reasons.active", lambda s: int(s, 16)),
    ("sw_power_cap", "clocks_event_reasons_counters.sw_power_cap", int),
    ("sw_thermal_slowdown", "clocks_event_reasons_counters.sw_thermal_slowdown", int),
    ("hw_thermal_slowdown", "clocks_event_reasons_counters.hw_thermal_slowdown", int),
    ("hw_power_brake_slowdown", "clocks_event_reasons_counters.hw_power_brake_slowdown", int),
    ("pstate", "pstate", str),
]
NVSMI_QUERY = ",".join(q for _, q, _ in NVSMI_FIELDS)
COUNTERS = ("sw_power_cap", "sw_thermal_slowdown", "hw_thermal_slowdown", "hw_power_brake_slowdown")

# NVML clocks-event reason bits.
REASON_BITS = [
    (0x1, "gpu_idle"),
    (0x2, "applications_clocks_setting"),
    (0x4, "sw_power_cap"),
    (0x8, "hw_slowdown"),
    (0x10, "sync_boost"),
    (0x20, "sw_thermal_slowdown"),
    (0x40, "hw_thermal_slowdown"),
    (0x80, "hw_power_brake_slowdown"),
    (0x100, "display_clock_setting"),
]


def decode_reasons(mask: int) -> list:
    return [name for bit, name in REASON_BITS if mask & bit]


def parse_nvsmi(line: str):
    """Parse one `--format=csv,noheader,nounits` line of NVSMI_QUERY. N/A becomes None."""
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != len(NVSMI_FIELDS):
        return None
    g = {}
    for (key, _, conv), raw in zip(NVSMI_FIELDS, parts):
        raw = raw.removesuffix(" us").strip()
        try:
            g[key] = None if raw.startswith("[") or raw in ("N/A", "") else conv(raw)
        except ValueError:
            g[key] = None
    g["reasons"] = decode_reasons(g.pop("reasons_mask") or 0)
    g["counters_us"] = {k: g.pop(k) for k in COUNTERS}
    return g


def parse_compute_apps(text: str) -> dict:
    """`--query-compute-apps=pid,used_memory --format=csv,noheader,nounits` -> {pid: MiB or None}."""
    out = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        pid, mem = (p.strip() for p in line.split(",", 1))
        out[int(pid)] = int(mem) if mem.isdigit() else None
    return out


# --- Prometheus text (LLM servers) ----------------------------------------------

PROM_RE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)")


def parse_prom(text: str) -> dict:
    """Sum every sample per metric name across label sets."""
    out = {}
    for line in text.splitlines():
        m = PROM_RE.match(line)
        if not m:
            continue
        try:
            out[m[1]] = out.get(m[1], 0.0) + float(m[3])
        except ValueError:
            pass
    return out


# Decode token counters by engine; the first one present wins.
GEN_TOKEN_METRICS = ("vllm:generation_tokens_total", "sglang:generation_tokens_total", "llamacpp:tokens_predicted_total")
RUNNING_METRICS = ("vllm:num_requests_running", "sglang:num_running_reqs", "llamacpp:requests_processing")


# --- processes -------------------------------------------------------------------

def parse_pid_stat(text: str) -> dict:
    head, _, rest = text.rpartition(")")
    pid, _, comm = head.partition(" (")
    f = rest.split()
    # f[0] is field 3 (state); utime/stime are fields 14/15, rss is field 24.
    return {"pid": int(pid), "comm": comm, "state": f[0], "ppid": int(f[1]),
            "ticks": int(f[11]) + int(f[12]), "rss_pages": int(f[21])}


def read_processes(proc_root: str = "/proc") -> list:
    out = []
    for name in os.listdir(proc_root):
        if not name.isdigit():
            continue
        try:
            with open(f"{proc_root}/{name}/stat") as fh:
                out.append(parse_pid_stat(fh.read()))
        except (OSError, ValueError, IndexError):
            continue  # process exited while reading
    return out


# --- systemd -----------------------------------------------------------------------

def parse_systemctl_show(text: str) -> dict:
    units, cur = {}, {}
    for line in text.splitlines() + [""]:
        if not line.strip():
            if "Id" in cur:
                units[cur["Id"]] = cur
            cur = {}
            continue
        k, _, v = line.partition("=")
        cur[k] = v
    return units
