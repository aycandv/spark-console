"""python3 -m spark_console [--bind unix:PATH | --bind 127.0.0.1 --port N] [--simulate]"""
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time

from . import control, sampler, server

# Default ports of vLLM, SGLang and llama.cpp server. Use --llm for others.
DEFAULT_LLM = ["http://127.0.0.1:8000", "http://127.0.0.1:30000", "http://127.0.0.1:8080"]
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


def tailnet_identity():
    """(owner login, MagicDNS name) of this node, or (None, None) without Tailscale."""
    try:
        d = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=5).stdout)
        me = d["Self"]
        return d["User"][str(me["UserID"])]["LoginName"], me["DNSName"].rstrip(".").lower()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None, None


class Simulated:
    """--simulate: controls change an in-memory overlay instead of the hardware (for UI work without root).
    Keep after reboot changes a boot overlay, so the UI sees the values as saved for boot."""

    def __init__(self, real_current, real_persisted):
        self.real, self.overlay = real_current, {}
        self.real_persisted, self.boot = real_persisted, {}

    def run(self, args):
        a = args
        if a[0] == "gpu-cap":
            self.overlay["gpu_cap_mhz"] = int(a[1])
        elif a[0] == "gpu-reset":
            self.overlay["gpu_cap_mhz"] = None
        elif a[0] == "cpu-epp":
            self.overlay["epp"] = int(a[1])
        elif a[0] == "cpu-governor":
            self.overlay["governor"] = a[1]
        elif a[0] == "cpu-max":
            self.overlay[f"{a[1]}_max_khz"] = int(a[2])
        elif a[0] == "persist-gpu":
            self.boot["gpu_cap_mhz"] = None if a[1] == "none" else int(a[1])
        elif a[0] == "persist-cpu":
            self.boot.update(epp=int(a[1]), x925_max_khz=int(a[2]), a725_max_khz=int(a[3]), governor=a[4])
        print("simulate: helper", *args, flush=True)

    def current(self):
        return {**self.real(), **self.overlay}

    def persisted(self):
        return {**self.real_persisted(), **self.boot}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="spark-console")
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    ap.add_argument("--bind", default=f"unix:{runtime}/spark-console/http.sock",
                    help="unix:PATH (default; only you and root can connect) or a TCP address for development")
    ap.add_argument("--port", type=int, default=5566, help="TCP port when --bind is an address")
    ap.add_argument("--trial", type=int, default=60, help="seconds before an applied change reverts")
    ap.add_argument("--llm", action="append", help="LLM server base URL with Prometheus /metrics (repeatable)")
    ap.add_argument("--owner", help="tailnet login allowed in (default: this node's owner)")
    ap.add_argument("--profiles", default=os.path.expanduser("~/.config/spark-console/profiles.json"))
    ap.add_argument("--journal", default=os.path.expanduser("~/.local/state/spark-console/trial.json"),
                    help="records an open trial so a restarted server reverts it")
    ap.add_argument("--simulate", action="store_true", help="do not touch hardware; controls change an overlay")
    args = ap.parse_args(argv)

    owner, dns = tailnet_identity()
    owner = args.owner or owner
    if not owner:
        print("warning: no tailnet owner known (tailscale down?) and no --owner: every request will be refused", flush=True)
    hostnames = {"127.0.0.1", "localhost", "::1"} | ({dns} if dns else set())

    real_current, limits, persisted = control.make_readers()
    if args.simulate:
        sim = Simulated(real_current, persisted)
        run, current, persisted = sim.run, sim.current, sim.persisted
    else:
        run, current = control.sudo_helper, real_current
    ctl = control.Controller(run=run, read_current=current, read_limits=limits, read_persisted=persisted,
                             trial_s=args.trial, journal=None if args.simulate else args.journal)
    ctl.recover()  # a trial left open by a crash is reverted before anything else

    def control_state():
        return {**ctl.status(), "current": current(), "limits": limits(), "simulate": args.simulate,
                "default_trial_s": ctl.trial_s, "helper_installed": args.simulate or os.path.exists(control.HELPER_PATH)}

    smp = sampler.Sampler(llm_urls=args.llm or DEFAULT_LLM)
    smp.control_status = control_state
    app = server.App(sampler=smp, controller=ctl, profiles=control.ProfileStore(args.profiles), owner=owner,
                     hostnames=hostnames, web_dir=WEB_DIR, control_state=control_state)
    threading.Thread(target=smp.run_forever, daemon=True, name="sampler").start()

    def control_loop():  # own thread: a slow sudo call must not stall sampling
        while True:
            if ctl.tick():
                app.invalidate()  # an automatic revert ends a trial with no request to hang on
            time.sleep(1)

    threading.Thread(target=control_loop, daemon=True, name="control").start()
    httpd = server.make_server(app, args.bind, args.port)

    def stop(*_):
        # A trial must not outlive the server: put the previous values back first.
        try:
            ctl.shutdown()
        finally:
            threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    where = args.bind if args.bind.startswith("unix:") else f"http://{args.bind}:{args.port}"
    print(f"spark-console on {where} owner={owner} hosts={sorted(hostnames)}"
          f"{' SIMULATE' if args.simulate else ''}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
