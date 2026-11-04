#!/usr/bin/python3 -I
"""spark-console root helper.

Installed root-owned at /usr/local/sbin/spark-console-helper and run through one
sudoers line. It is the only code that runs as root, so every action and value
is checked here against a fixed list; nothing is passed to a shell.
"""
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable

SELF = "/usr/local/sbin/spark-console-helper"
NVIDIA_SMI = "/usr/bin/nvidia-smi"
SYSTEMCTL = "/usr/bin/systemctl"
DROPIN = "50-spark-console.conf"
MARKER = "gpu-clock-cap"  # file name sparkDash reads; content "<MHz> <boot_id>"

# GB10 reports no max graphics clock; 3100 MHz sits above the 3003 MHz memory clock it does report.
GPU_MHZ = (300, 3100)
EPP = (0, 255)
CLUSTER_PARTS = {"x925": 0xD85, "a725": 0xD87}  # MIDR part numbers of the two core types

INT_RE = re.compile(r"[1-9][0-9]{0,8}|0")
GOV_RE = re.compile(r"[a-z]{1,32}")


class Refused(Exception):
    """A request outside the allowlist. Exit code 2."""


@dataclass
class Ctx:
    cpu_root: str = "/sys/devices/system/cpu"
    unit_dir: str = "/etc/systemd/system"
    run_dirs: tuple = ("/run/spark-console", "/run/sparkdash")
    boot_id_path: str = "/proc/sys/kernel/random/boot_id"
    run: Callable = field(default=lambda argv: subprocess.run(argv, check=True, timeout=20))


def _int(text: str, lo: int, hi: int) -> int:
    if not INT_RE.fullmatch(text or ""):
        raise Refused(f"not a plain integer: {text!r}")
    value = int(text)
    if not lo <= value <= hi:
        raise Refused(f"{value} is outside {lo}..{hi}")
    return value


def _read(path: str) -> str:
    with open(path) as f:
        return f.read().strip()


def _write(path: str, value: str) -> None:
    with open(path, "w") as f:
        f.write(value)


def policies(cpu_root: str) -> dict:
    """Map cluster name -> sorted list of cpufreq policy dirs, by the MIDR part of each policy's first CPU."""
    groups = {name: [] for name in CLUSTER_PARTS}
    base = os.path.join(cpu_root, "cpufreq")
    for entry in sorted(os.listdir(base), key=lambda s: int(s[6:]) if s[6:].isdigit() else -1):
        if not (entry.startswith("policy") and entry[6:].isdigit()):
            continue
        pol = os.path.join(base, entry)
        first = _read(os.path.join(pol, "related_cpus")).split()[0]
        midr = int(_read(os.path.join(cpu_root, f"cpu{first}/regs/identification/midr_el1")), 16)
        part = (midr >> 4) & 0xFFF
        for name, want in CLUSTER_PARTS.items():
            if part == want:
                groups[name].append(pol)
    return groups


def _all_policies(ctx: Ctx) -> list:
    return [p for group in policies(ctx.cpu_root).values() for p in group]


def _markers(ctx: Ctx, mhz) -> None:
    """NVML cannot read a -lgc cap back, so record it. run_dirs[0] is ours, the rest are sparkDash's."""
    boot = _read(ctx.boot_id_path)
    for i, d in enumerate(ctx.run_dirs):
        path = os.path.join(d, MARKER)
        if mhz is None and i > 0:
            if os.path.exists(path):
                os.remove(path)
            continue
        os.makedirs(d, mode=0o755, exist_ok=True)
        _write(path, f"{'none' if mhz is None else mhz} {boot}\n")


def _dropin(ctx: Ctx, unit: str, body: str) -> None:
    d = os.path.join(ctx.unit_dir, f"{unit}.d")
    os.makedirs(d, mode=0o755, exist_ok=True)
    path = os.path.join(d, DROPIN)
    tmp = path + ".tmp"
    _write(tmp, body)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    ctx.run([SYSTEMCTL, "daemon-reload"])


# --- actions -----------------------------------------------------------------

def gpu_cap(ctx, mhz):
    mhz = _int(mhz, *GPU_MHZ)
    ctx.run([NVIDIA_SMI, "-lgc", f"0,{mhz}"])
    _markers(ctx, mhz)


def gpu_reset(ctx):
    ctx.run([NVIDIA_SMI, "-rgc"])
    _markers(ctx, None)


def mark_gpu(ctx, mhz):
    _markers(ctx, _int(mhz, *GPU_MHZ))


def cpu_epp(ctx, value):
    value = _int(value, *EPP)
    for pol in _all_policies(ctx):
        _write(os.path.join(pol, "energy_performance_preference_val"), str(value))


def cpu_max(ctx, cluster, khz):
    group = policies(ctx.cpu_root).get(cluster)
    if not group:
        raise Refused(f"unknown cluster {cluster!r}")
    lo = max(int(_read(os.path.join(p, "cpuinfo_min_freq"))) for p in group)
    hi = min(int(_read(os.path.join(p, "cpuinfo_max_freq"))) for p in group)
    khz = _int(khz, lo, hi)
    for pol in group:
        _write(os.path.join(pol, "scaling_max_freq"), str(khz))


def _check_governor(ctx, name):
    if not GOV_RE.fullmatch(name or ""):
        raise Refused(f"bad governor {name!r}")
    pols = _all_policies(ctx)
    available = _read(os.path.join(pols[0], "scaling_available_governors")).split()
    if name not in available:
        raise Refused(f"governor {name!r} not in {available}")
    return pols


def cpu_governor(ctx, name):
    for pol in _check_governor(ctx, name):
        _write(os.path.join(pol, "scaling_governor"), name)


def persist_gpu(ctx, mhz):
    if mhz == "none":
        start = f"ExecStart={NVIDIA_SMI} -rgc\n"
    else:
        mhz = _int(mhz, *GPU_MHZ)
        start = f"ExecStart={NVIDIA_SMI} -lgc 0,{mhz}\nExecStartPost={SELF} mark-gpu {mhz}\n"
    _dropin(ctx, "gb10-clocklock.service", "# Written by spark-console. Remove this file to restore the unit's own value.\n"
            "[Service]\nExecStart=\n" + start)


def persist_cpu(ctx, epp, x925_khz, a725_khz, governor):
    epp = _int(epp, *EPP)
    _check_governor(ctx, governor)
    groups = policies(ctx.cpu_root)
    khz = {}
    for cluster, text in (("x925", x925_khz), ("a725", a725_khz)):
        group = groups[cluster]
        lo = max(int(_read(os.path.join(p, "cpuinfo_min_freq"))) for p in group)
        hi = min(int(_read(os.path.join(p, "cpuinfo_max_freq"))) for p in group)
        khz[cluster] = _int(text, lo, hi)
    _dropin(ctx, "cpu-epp.service",
            "# Written by spark-console. Remove this file to restore the unit's own value.\n"
            "[Unit]\nAfter=nv-cpu-governor.service\n"
            "[Service]\nExecStart=\n"
            f"ExecStart={SELF} cpu-governor {governor}\n"
            f"ExecStart={SELF} cpu-epp {epp}\n"
            f"ExecStart={SELF} cpu-max x925 {khz['x925']}\n"
            f"ExecStart={SELF} cpu-max a725 {khz['a725']}\n")


def reapply_boot(ctx):
    """Run the two boot units now, exactly as at boot (ExecStop, then ExecStart with any drop-in)."""
    ctx.run([SYSTEMCTL, "restart", "gb10-clocklock.service", "cpu-epp.service"])


ACTIONS = {
    "gpu-cap": (gpu_cap, 1),
    "gpu-reset": (gpu_reset, 0),
    "mark-gpu": (mark_gpu, 1),
    "cpu-epp": (cpu_epp, 1),
    "cpu-max": (cpu_max, 2),
    "cpu-governor": (cpu_governor, 1),
    "persist-gpu": (persist_gpu, 1),
    "persist-cpu": (persist_cpu, 4),
    "reapply-boot": (reapply_boot, 0),
}


def main(argv, ctx=None) -> int:
    ctx = ctx or Ctx()
    if not argv or argv[0] not in ACTIONS:
        print(f"usage: spark-console-helper {{{','.join(ACTIONS)}}} ARGS", file=sys.stderr)
        return 2
    fn, nargs = ACTIONS[argv[0]]
    if len(argv) - 1 != nargs:
        print(f"{argv[0]} takes {nargs} argument(s)", file=sys.stderr)
        return 2
    try:
        fn(ctx, *argv[1:])
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    except (OSError, subprocess.SubprocessError) as e:
        print(f"failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
