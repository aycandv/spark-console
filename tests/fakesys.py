"""Builds a fake /sys CPU tree shaped like a GB10 (10 x X925 + 10 x A725)."""
from pathlib import Path

X925_MIDR = "0x00000000410fd851"
A725_MIDR = "0x00000000410fd871"
# Same split as a real GB10: policies 5-9 and 15-19 are X925.
X925_CPUS = {5, 6, 7, 8, 9, 15, 16, 17, 18, 19}


def build_cpu_tree(root: Path, ncpu: int = 20) -> Path:
    cpu = root / "devices/system/cpu"
    for n in range(ncpu):
        big = n in X925_CPUS
        ident = cpu / f"cpu{n}/regs/identification"
        ident.mkdir(parents=True)
        (ident / "midr_el1").write_text((X925_MIDR if big else A725_MIDR) + "\n")
        p = cpu / f"cpufreq/policy{n}"
        p.mkdir(parents=True)
        lo, hi = ("1378000", "3900000") if big else ("338000", "2808000")
        files = {
            "related_cpus": f"{n}",
            "cpuinfo_min_freq": lo,
            "cpuinfo_max_freq": hi,
            "scaling_min_freq": lo,
            "scaling_max_freq": hi,
            "scaling_cur_freq": hi,
            "energy_performance_preference_val": "128",
            "scaling_governor": "performance",
            "scaling_available_governors": "conservative ondemand userspace powersave performance schedutil ",
            "perf_limited": "0",
        }
        for name, value in files.items():
            (p / name).write_text(value + "\n")
    return cpu


def read(path: Path) -> str:
    return path.read_text().strip()
