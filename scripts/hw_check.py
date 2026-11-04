#!/usr/bin/env python3
"""Live hardware check through the running service (needs the root helper installed).

Applies a short trial (GPU cap one step below the current cap, EPP +1), checks
that the hardware and the sparkDash marker follow, lets the trial run out, and
checks that every value came back. Exit code 1 on any failure.

    python3 scripts/hw_check.py [--socket PATH] [--owner LOGIN]
"""
import argparse
import http.client
import json
import os
import socket
import subprocess
import sys
import time


class UnixConn(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=30)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(30)
        self.sock.connect(self.path)


def call(args, method, url, body=None):
    c = UnixConn(args.socket)
    headers = {"Host": "localhost", "Tailscale-User-Login": args.owner}
    if body is not None:
        headers.update({"Content-Type": "application/json", "X-Spark-Console": "1"})
        body = json.dumps(body)
    c.request(method, url, body=body, headers=headers)
    r = c.getresponse()
    data = json.loads(r.read() or b"{}")
    c.close()
    if r.status != 200:
        raise SystemExit(f"FAIL {method} {url}: {r.status} {data}")
    return data


def epp():
    with open("/sys/devices/system/cpu/cpufreq/policy0/energy_performance_preference_val") as f:
        return int(f.read())


def marker(path):
    try:
        with open(path) as f:
            return f.read().split()[0]
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default=f"{os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')}/spark-console/http.sock")
    ap.add_argument("--owner", default=None)
    args = ap.parse_args()
    if not args.owner:
        st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True).stdout)
        args.owner = st["User"][str(st["Self"]["UserID"])]["LoginName"]

    failures = []

    def check(cond, msg):
        print(("ok   - " if cond else "FAIL - ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    state = call(args, "GET", "/api/state")
    ctl = state["control"]
    check(ctl["helper_installed"] and not ctl["simulate"], "service runs with the real helper")
    check(ctl["trial"] is None, "no trial open before the check")
    before = ctl["current"]
    cap0 = before["gpu_cap_mhz"]
    cap1 = (cap0 or 2100) - 100
    epp1 = (before["epp"] + 1) % 256
    print(f"before: {before}")

    call(args, "POST", "/api/apply", {"changes": {"gpu_cap_mhz": cap1, "epp": epp1}, "trial_s": 15})
    time.sleep(3)
    cur = call(args, "GET", "/api/state")["control"]["current"]
    check(cur["gpu_cap_mhz"] == cap1, f"GPU cap reads back as {cap1} MHz (got {cur['gpu_cap_mhz']})")
    check(epp() == epp1, f"EPP in sysfs is {epp1} (got {epp()})")
    check(marker("/run/sparkdash/gpu-clock-cap") == str(cap1), "sparkDash marker shows the trial cap")
    sm = int(subprocess.run(["nvidia-smi", "--query-gpu=clocks.sm", "--format=csv,noheader,nounits"],
                            capture_output=True, text=True).stdout.strip())
    check(sm <= cap1 + 15, f"SM clock {sm} MHz is at or under the cap {cap1}")

    time.sleep(16)  # let the trial run out
    st = call(args, "GET", "/api/state")["control"]
    check(st["trial"] is None, "trial closed by itself")
    check(st["events"][-1]["kind"] == "reverted" and st["events"][-1]["why"] == "timeout", "last event is a timeout revert")
    check(st["current"] == before, f"all values back: {st['current']}")
    check(epp() == before["epp"], "EPP restored in sysfs")
    want_marker = None if cap0 is None else str(cap0)
    check(marker("/run/sparkdash/gpu-clock-cap") == want_marker, f"sparkDash marker back to {want_marker}")

    print("hw check:", "FAIL" if failures else "pass")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
