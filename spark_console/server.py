"""HTTP server: static UI, JSON state, SSE stream, and POST controls.

Listens on a Unix socket in a 0700 directory (or TCP loopback for development);
`tailscale serve` publishes it. Checks on every request:
- Host must be a known name (DNS-rebinding guard).
- Tailscale-User-Login must be the owner's login. tailscaled sets it and drops any
  value the client sent; tagged devices and Funnel get no header, so they get no access.
- POSTs must be JSON with X-Spark-Console: 1 (forces a CORS preflight that is never
  answered, so another site cannot post) and a same-host Origin when one is sent.
"""
import json
import mimetypes
import os
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from .control import Busy, HelperError

MAX_BODY = 64 * 1024
MAX_STREAMS = 8
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2", ".svg": "image/svg+xml"}


class App:
    def __init__(self, sampler, controller, profiles, owner, hostnames, web_dir, control_state=None):
        self.sampler, self.controller, self.profiles = sampler, controller, profiles
        self.owner, self.hostnames, self.web_dir = owner, set(hostnames), os.path.realpath(web_dir)
        self.control_state = control_state or controller.status
        self.streams = threading.BoundedSemaphore(MAX_STREAMS)
        self._cached = (None, b"")

    def state(self):
        return {"snapshot": self.sampler.snapshot, "control": self.control_state(), "profiles": self.profiles.all()}

    def state_bytes(self, seq):
        """The SSE payload for one sampler tick, built once and shared by all streams."""
        cached_seq, data = self._cached
        if cached_seq != seq:
            data = json.dumps(self.state()).encode()
            self._cached = (seq, data)
        return data


class Handler(BaseHTTPRequestHandler):
    server_version = "spark-console"
    app: App = None  # set by make_server
    timeout = 30  # socket timeout: a stalled client cannot hold a thread forever

    def address_string(self):
        return self.client_address[0] if self.client_address else "unix"

    def log_message(self, fmt, *args):  # quiet: the UI polls constantly
        if not (200 <= getattr(self, "_status", 200) < 400):
            super().log_message(fmt, *args)

    # --- plumbing -----------------------------------------------------------------
    def _send(self, status, body, ctype="application/json", extra=None):
        self._status = status
        data = json.dumps(body).encode() if ctype == "application/json" else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status, msg):
        self._send(status, {"error": msg})

    def _allowed(self, mutating):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in self.app.hostnames:
            return self._error(403, f"unknown host {host!r}")
        login = self.headers.get("Tailscale-User-Login")
        if not self.app.owner or login != self.app.owner:
            return self._error(403, "open this console through tailscale serve as its owner")
        if mutating:
            if self.headers.get("X-Spark-Console") != "1" or not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self._error(403, "missing X-Spark-Console header or JSON body")
            origin = self.headers.get("Origin")
            if origin and (urlsplit(origin).hostname or "").lower() != host:
                return self._error(403, "cross-origin request")
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 <= n <= MAX_BODY:
            raise ValueError("bad body length")
        data = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    # --- GET --------------------------------------------------------------------------
    def do_GET(self):
        if self._allowed(False) is not True:
            return
        url = urlsplit(self.path)
        if url.path == "/api/state":
            return self._send(200, self.app.state())
        if url.path == "/api/history":
            q = parse_qs(url.query)
            try:
                window = max(10, min(3600, int(q.get("window", ["600"])[0])))
            except ValueError:
                return self._error(400, "window must be seconds")
            return self._send(200, self.app.sampler.history.columns(window, time.time()))
        if url.path == "/api/stream":
            return self._stream()
        return self._static(url.path)

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else unquote(path).lstrip("/")
        try:
            full = os.path.realpath(os.path.join(self.app.web_dir, rel))
        except ValueError:  # e.g. an embedded NUL
            return self._error(404, "not found")
        if not full.startswith(self.app.web_dir + os.sep) or not os.path.isfile(full):
            return self._error(404, "not found")
        ext = os.path.splitext(full)[1]
        with open(full, "rb") as f:
            self._send(200, f.read(), TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream")

    def _stream(self):
        if not self.app.streams.acquire(blocking=False):
            return self._error(503, "too many live views open")
        try:
            self._status = 200
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            s = self.app.sampler
            seen = -1
            while True:
                with s.cond:
                    if s.seq == seen:
                        s.cond.wait(timeout=15)
                    seq = s.seq
                if seq == seen:
                    self.wfile.write(b": keepalive\n\n")
                else:
                    seen = seq
                    self.wfile.write(b"data: " + self.app.state_bytes(seq) + b"\n\n")
                self.wfile.flush()
        except (OSError, TimeoutError):
            return
        finally:
            self.app.streams.release()

    # --- POST -------------------------------------------------------------------------
    def do_POST(self):
        if self._allowed(True) is not True:
            return
        route = urlsplit(self.path).path
        c, p = self.app.controller, self.app.profiles
        try:
            body = self._body()
            if route == "/api/apply":
                c.apply(body.get("changes"), trial_s=body.get("trial_s"))
            elif route == "/api/keep":
                c.keep(persist=body.get("persist") is True)
            elif route == "/api/revert":
                c.revert()
            elif route == "/api/persist":
                c.persist(gpu=body.get("gpu") is True, cpu=body.get("cpu") is True)
            elif route == "/api/profiles":
                p.save(body.get("name"), body.get("values"))
            elif route == "/api/profiles/delete":
                p.delete(body.get("name"))
            elif route == "/api/stats/reset":
                self.app.sampler.stats.reset()
            else:
                return self._error(404, "no such action")
        except Busy as e:
            return self._error(409, str(e))
        except ValueError as e:
            return self._error(400, str(e))
        except HelperError as e:
            return self._error(502, f"helper failed: {e}")
        return self._send(200, {"control": self.app.control_state(), "profiles": p.all(), "trial": c.status()["trial"]})


class UnixHTTPServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def make_server(app, bind, port):
    """bind is a TCP address, or "unix:/path/to.sock" (its directory is made 0700)."""
    handler = type("BoundHandler", (Handler,), {"app": app})
    if bind.startswith("unix:"):
        path = bind[5:]
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        os.chmod(os.path.dirname(path), 0o700)
        if os.path.exists(path):
            os.remove(path)  # stale socket from a previous run
        return UnixHTTPServer(path, handler)
    httpd = ThreadingHTTPServer((bind, port), handler)
    httpd.daemon_threads = True
    return httpd
