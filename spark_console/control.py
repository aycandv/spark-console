"""Try-and-revert control of GPU and CPU knobs.

apply() changes values at once and opens a trial. Unless keep() is called before
the deadline, tick() puts the previous values back. Only one trial at a time.
"""
import json
import os
import re
import subprocess
import threading
import time

from . import helper
from .sources import read_cpufreq

HELPER_PATH = helper.SELF
KNOBS = ("governor", "epp", "x925_max_khz", "a725_max_khz", "gpu_cap_mhz")  # also the apply order
GPU_KNOBS = {"gpu_cap_mhz"}
TRIAL_S = (10, 600)


class Busy(Exception):
    """A trial is already open."""


class HelperError(Exception):
    """The root helper refused or failed."""


def sudo_helper(args):
    proc = subprocess.run(["sudo", "-n", HELPER_PATH, *args], capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise HelperError((proc.stderr or proc.stdout).strip() or f"helper exit {proc.returncode}")


def _command(knob, value):
    if knob == "gpu_cap_mhz":
        return ["gpu-reset"] if value is None else ["gpu-cap", str(value)]
    if knob == "epp":
        return ["cpu-epp", str(value)]
    if knob == "governor":
        return ["cpu-governor", value]
    return ["cpu-max", knob.split("_")[0], str(value)]


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def validate(changes: dict, limits: dict) -> dict:
    if not isinstance(changes, dict) or not changes:
        raise ValueError("no changes")
    for k, v in changes.items():
        if k not in KNOBS:
            raise ValueError(f"unknown knob {k!r}")
        if k == "gpu_cap_mhz":
            ok = v is None or (_is_int(v) and helper.GPU_MHZ[0] <= v <= helper.GPU_MHZ[1])
        elif k == "epp":
            ok = _is_int(v) and helper.EPP[0] <= v <= helper.EPP[1]
        elif k == "governor":
            ok = isinstance(v, str) and v in limits["governors"]
        else:
            lo, hi = limits[k.split("_")[0]]
            ok = _is_int(v) and lo <= v <= hi
        if not ok:
            raise ValueError(f"{k}={v!r} is not allowed")
    return changes


class Controller:
    def __init__(self, run, read_current, read_limits, read_persisted, clock=time.monotonic, trial_s=60):
        self._run, self._current, self._limits, self._persisted = run, read_current, read_limits, read_persisted
        self._clock, self.trial_s = clock, trial_s
        self._lock = threading.RLock()
        self._trial = None
        self._events = []

    def _event(self, kind, **detail):
        self._events = (self._events + [{"t": time.time(), "kind": kind, **detail}])[-50:]

    def _set(self, values: dict) -> list:
        """Apply values in KNOBS order; on error undo the ones done and re-raise."""
        done = []
        before = self._current()
        try:
            for k in KNOBS:
                if k in values:
                    self._run(_command(k, values[k]))
                    done.append(k)
        except Exception:
            for k in reversed(done):
                try:
                    self._run(_command(k, before[k]))
                except Exception as e:  # keep going: undo as much as possible
                    self._event("rollback_failed", knob=k, error=str(e))
            raise
        return done

    def apply(self, changes: dict, trial_s=None) -> dict:
        trial_s = self.trial_s if trial_s is None else trial_s
        if not _is_int(trial_s) or not TRIAL_S[0] <= trial_s <= TRIAL_S[1]:
            raise ValueError(f"trial must be {TRIAL_S[0]}..{TRIAL_S[1]} s")
        with self._lock:
            if self._trial:
                raise Busy("a trial is open; keep or revert it first")
            validate(changes, self._limits())
            cur = self._current()
            changes = {k: v for k, v in changes.items() if cur.get(k) != v}
            if not changes:
                return self.status()
            try:
                self._set(changes)
            except Exception as e:
                self._event("failed", applied=changes, error=str(e))
                raise
            now = self._clock()
            self._trial = {"applied": changes, "prev": {k: cur.get(k) for k in changes},
                           "started": now, "deadline": now + trial_s, "total_s": trial_s}
            self._event("applied", applied=changes)
            return self.status()

    def _revert(self, why):
        t, self._trial = self._trial, None
        try:
            self._set(t["prev"])
            self._event("reverted", why=why, values=t["prev"])
        except Exception as e:
            self._event("revert_failed", why=why, error=str(e))
            raise

    def revert(self):
        with self._lock:
            if self._trial:
                self._revert("user")
            return self.status()

    def tick(self):
        with self._lock:
            if self._trial and self._clock() >= self._trial["deadline"]:
                try:
                    self._revert("timeout")
                except Exception:
                    pass  # recorded as revert_failed; the UI shows it

    def keep(self, persist: bool = False):
        with self._lock:
            t = self._trial
            if not t:
                return self.status()
            self._trial = None
            self._event("kept", values=t["applied"], persist=persist)
            if persist:
                self.persist(gpu=bool(GPU_KNOBS & t["applied"].keys()), cpu=bool(t["applied"].keys() - GPU_KNOBS))
            return self.status()

    def persist(self, gpu: bool, cpu: bool):
        cur = self._current()
        if gpu:
            v = cur["gpu_cap_mhz"]
            self._run(["persist-gpu", "none" if v is None else str(v)])
        if cpu:
            self._run(["persist-cpu", str(cur["epp"]), str(cur["x925_max_khz"]), str(cur["a725_max_khz"]), cur["governor"]])
        self._event("persisted", gpu=gpu, cpu=cpu)

    def shutdown(self):
        with self._lock:
            if self._trial:
                self._revert("shutdown")

    def status(self) -> dict:
        with self._lock:
            t = self._trial
            trial = None
            if t:
                trial = {"applied": t["applied"], "prev": t["prev"], "total_s": t["total_s"],
                         "remaining_s": max(0, round(t["deadline"] - self._clock()))}
            return {"trial": trial, "events": list(self._events), "persisted": self._persisted()}


# --- readers for the real machine ------------------------------------------------

LGC_RE = re.compile(r"nvidia-smi -lgc 0,(\d+)")
HELPER_LINE_RE = re.compile(r"spark-console-helper (cpu-governor|cpu-epp|cpu-max) (\S+)(?: (\S+))?")


def _exec_lines(path):
    try:
        with open(path) as f:
            return [l.strip()[len("ExecStart="):] for l in f if l.strip().startswith("ExecStart=")]
    except OSError:
        return None


def read_persisted(unit_dir="/etc/systemd/system") -> dict:
    """Values the boot units will set. A spark-console drop-in replaces the unit's own ExecStart."""
    out = {}
    for unit, parse in (("gb10-clocklock.service", "gpu"), ("cpu-epp.service", "cpu")):
        lines = _exec_lines(f"{unit_dir}/{unit}.d/{helper.DROPIN}")
        if lines is None:
            lines = _exec_lines(f"{unit_dir}/{unit}") or []
        for cmd in lines:
            if parse == "gpu":
                m = LGC_RE.search(cmd)
                if m:
                    out["gpu_cap_mhz"] = int(m[1])
                elif "nvidia-smi -rgc" in cmd:
                    out["gpu_cap_mhz"] = None
            else:
                m = HELPER_LINE_RE.search(cmd)
                if m and m[1] == "cpu-governor":
                    out["governor"] = m[2]
                elif m and m[1] == "cpu-epp":
                    out["epp"] = int(m[2])
                elif m and m[1] == "cpu-max":
                    out[f"{m[2]}_max_khz"] = int(m[3])
                elif (e := re.search(r"echo (\d+) >", cmd)) and "energy_performance_preference" in cmd:
                    out["epp"] = int(e[1])
    return out


def read_gpu_cap(marker_path, boot_id_path, persisted):
    """The cap set this boot (from our marker), else the value the boot unit applies."""
    try:
        with open(marker_path) as f:
            value, boot = f.read().split()
        with open(boot_id_path) as f:
            if boot == f.read().strip():
                return None if value == "none" else int(value)
    except (OSError, ValueError):
        pass
    # shortcut: assumes gb10-clocklock ran at boot; the services panel shows if it failed.
    return persisted.get("gpu_cap_mhz")


def make_readers(cpu_root="/sys/devices/system/cpu", unit_dir="/etc/systemd/system",
                 marker=f"{helper.Ctx.run_dirs[0]}/{helper.MARKER}", boot_id=helper.Ctx.boot_id_path):
    def limits():
        pols = read_cpufreq(cpu_root)
        out = {"governors": pols[0]["governors"]}
        for c in ("x925", "a725"):
            ps = [p for p in pols if p["cluster"] == c]
            out[c] = (max(p["hw_min_khz"] for p in ps), min(p["hw_max_khz"] for p in ps))
        return out

    def current():
        pols = read_cpufreq(cpu_root)
        first = {c: next(p for p in pols if p["cluster"] == c) for c in ("x925", "a725")}
        return {"gpu_cap_mhz": read_gpu_cap(marker, boot_id, read_persisted(unit_dir)),
                "epp": pols[0]["epp"], "governor": pols[0]["governor"],
                "x925_max_khz": first["x925"]["max_khz"], "a725_max_khz": first["a725"]["max_khz"]}

    return current, limits, lambda: read_persisted(unit_dir)


# --- profiles ---------------------------------------------------------------------

BUILTIN_PROFILES = [
    {"name": "Quiet", "builtin": True, "values": {"gpu_cap_mhz": 1800, "epp": 192},
     "note": "~86% decode speed at ~47% GPU power (2026-11-04 sweep)"},
    {"name": "Balanced", "builtin": True, "values": {"gpu_cap_mhz": 2100, "epp": 128},
     "note": "dgx0 default since 2026-11-04"},
    {"name": "Max", "builtin": True, "values": {"gpu_cap_mhz": None, "epp": 0},
     "note": "no GPU cap, EPP 0 (DGX OS default)"},
]
NAME_RE = re.compile(r"[A-Za-z0-9 ._-]{1,40}")


class ProfileStore:
    def __init__(self, path):
        self.path = path
        try:
            with open(path) as f:
                self._user = json.load(f)
        except (OSError, ValueError):
            self._user = []

    def all(self):
        return BUILTIN_PROFILES + self._user

    def get(self, name):
        return next((p for p in self.all() if p["name"] == name), None)

    def save(self, name, values):
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            raise ValueError("name: 1-40 letters, digits, space . _ -")
        if any(p["name"] == name for p in BUILTIN_PROFILES):
            raise ValueError("built-in profiles are read-only")
        if not isinstance(values, dict) or not values or set(values) - set(KNOBS):
            raise ValueError("values must be a non-empty subset of the knobs")
        self._user = [p for p in self._user if p["name"] != name] + [{"name": name, "builtin": False, "values": values}]
        self._write()

    def delete(self, name):
        self._user = [p for p in self._user if p["name"] != name]
        self._write()

    def _write(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._user, f, indent=2)
        os.replace(tmp, self.path)
