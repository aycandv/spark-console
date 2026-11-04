#!/usr/bin/env python3
"""After a boot (or Re-apply Boot Values): check that the boot chain set what spark-console persisted.

    python3 scripts/boot_check.py

Checks: both boot units succeeded, the live values equal the persisted ones, the GPU
marker carries this boot's id, no trial journal is left, the user service runs
(linger on), and tailscale serve points at its socket. Exit code 1 on any failure.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from spark_console import control  # noqa: E402


def sh(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def main():
    failures = []

    def check(cond, msg):
        print(("ok   - " if cond else "FAIL - ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    for unit in ("gb10-clocklock.service", "cpu-epp.service"):
        props = dict(l.split("=", 1) for l in sh("systemctl", "show", "-p", "ActiveState,Result,UnitFileState", unit).splitlines())
        check(props == {"ActiveState": "active", "Result": "success", "UnitFileState": "enabled"}, f"{unit}: {props}")

    current, _, persisted = control.make_readers()
    cur, per = current(), persisted()
    check(all(cur.get(k) == v for k, v in per.items()), f"live values equal boot values {per} (live {cur})")

    boot = open("/proc/sys/kernel/random/boot_id").read().strip()
    want_gpu = per.get("gpu_cap_mhz")
    for marker in ("/run/spark-console/gpu-clock-cap", "/run/sparkdash/gpu-clock-cap"):
        try:
            value, mboot = open(marker).read().split()
        except OSError:
            value, mboot = None, None
        if want_gpu is None and marker.startswith("/run/sparkdash"):
            check(value is None, f"{marker} absent (no cap at boot)")
        elif want_gpu is not None:
            check(value == str(want_gpu) and mboot == boot, f"{marker} = {value} for this boot")

    journal = os.path.expanduser("~/.local/state/spark-console/trial.json")
    check(not os.path.exists(journal), "no trial journal left")
    check(sh("systemctl", "--user", "is-active", "spark-console") == "active", "spark-console user service active")
    check(sh("loginctl", "show-user", os.environ.get("USER", ""), "-p", "Linger", "--value") == "yes", "linger on (service starts at boot)")
    try:
        web = json.loads(sh("tailscale", "serve", "status", "--json")).get("Web", {})
        targets = [h.get("Proxy") for site in web.values() for h in site.get("Handlers", {}).values()]
    except ValueError:
        targets = []
    check(any(t and t.startswith("unix:") and t.endswith("spark-console/http.sock") for t in targets), "tailscale serve proxies to the spark-console socket")

    print("boot check:", "FAIL" if failures else "pass")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
