import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from spark_console import control, sampler, server
from tests.test_control import LIMITS, Clock, FakeMachine


class FakeSampler:
    def __init__(self):
        self.history, self.stats = sampler.History(), sampler.Stats()
        self.history.add(time.time(), {"gpu.power_w": 50})
        self.snapshot, self.seq = {"t": 1.0, "gpu": {"power_w": 50}}, 1
        self.cond = threading.Condition()


class ServerTest(unittest.TestCase):
    def setUp(self):
        server.Handler.log_message = lambda *a: None
        self.tmp = tempfile.TemporaryDirectory()
        web = Path(self.tmp.name) / "web"
        web.mkdir()
        (web / "index.html").write_text("<!doctype html><title>t</title>")
        (web / "app.js").write_text("1")
        self.m = FakeMachine()
        self.ctl = control.Controller(run=self.m.run, read_current=self.m.current, read_limits=lambda: LIMITS,
                                      read_persisted=lambda: {}, clock=Clock(), trial_s=60)
        app = server.App(sampler=FakeSampler(), controller=self.ctl,
                         profiles=control.ProfileStore(str(Path(self.tmp.name) / "p.json")),
                         owner="owner@github", hostnames={"127.0.0.1", "localhost", "dgx0.example.ts.net"},
                         web_dir=str(web))
        self.httpd = server.make_server(app, "127.0.0.1", 0)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def req(self, method, path, body=None, headers=None):
        h = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        if body is not None:
            h.setdefault("Content-Type", "application/json")
            h.setdefault("X-Spark-Console", "1")
            body = json.dumps(body)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if r.getheader("Content-Type", "").startswith("application/json") else data)

    def test_static_and_state(self):
        status, body = self.req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>", body)
        status, body = self.req("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(body["snapshot"]["gpu"]["power_w"], 50)

    def test_path_traversal_is_refused(self):
        for path in ("/../etc/passwd", "/%2e%2e/etc/passwd", "/static/../../x"):
            with self.subTest(path=path):
                self.assertIn(self.req("GET", path)[0], (403, 404))

    def test_history(self):
        status, body = self.req("GET", "/api/history?window=3600")
        self.assertEqual(status, 200)
        self.assertIn("gpu.power_w", body)

    def test_apply_keep_flow(self):
        status, body = self.req("POST", "/api/apply", {"changes": {"epp": 64}})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["trial"]["applied"], {"epp": 64})
        self.assertEqual(self.req("POST", "/api/apply", {"changes": {"epp": 65}})[0], 409)
        status, body = self.req("POST", "/api/keep", {"persist": False})
        self.assertEqual(status, 200)
        self.assertIsNone(body["trial"])

    def test_bad_values_are_400_and_helper_errors_are_502(self):
        self.assertEqual(self.req("POST", "/api/apply", {"changes": {"epp": 999}})[0], 400)
        self.assertEqual(self.req("POST", "/api/apply", {"changes": "x"})[0], 400)
        self.m.fail_on = "cpu-epp"
        status, body = self.req("POST", "/api/apply", {"changes": {"epp": 1}})
        self.assertEqual(status, 502)
        self.assertIn("failed", body["error"])

    def test_mutation_needs_csrf_header_and_json(self):
        self.assertEqual(self.req("POST", "/api/revert", {}, {"X-Spark-Console": ""})[0], 403)
        self.assertEqual(self.req("POST", "/api/revert", {}, {"Content-Type": "text/plain"})[0], 403)

    def test_cross_origin_mutation_is_refused(self):
        self.assertEqual(self.req("POST", "/api/revert", {}, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/revert", {}, {"Origin": f"http://127.0.0.1:{self.port}"})[0], 200)

    def test_tailnet_identity_must_be_owner(self):
        tail = {"Host": "dgx0.example.ts.net:9443"}
        self.assertEqual(self.req("GET", "/api/state", headers={**tail, "Tailscale-User-Login": "owner@github"})[0], 200)
        self.assertEqual(self.req("GET", "/api/state", headers={**tail, "Tailscale-User-Login": "guest@github"})[0], 403)

    def test_unknown_host_is_refused(self):
        self.assertEqual(self.req("GET", "/api/state", headers={"Host": "rebind.evil.example"})[0], 403)

    def test_profiles_and_stats_reset(self):
        self.assertEqual(self.req("POST", "/api/profiles", {"name": "Bench", "values": {"epp": 0}})[0], 200)
        status, body = self.req("GET", "/api/state")
        self.assertIn("Bench", [p["name"] for p in body["profiles"]])
        self.assertEqual(self.req("POST", "/api/profiles", {"name": "Quiet", "values": {"epp": 0}})[0], 400)
        self.assertEqual(self.req("POST", "/api/profiles/delete", {"name": "Bench"})[0], 200)
        self.assertEqual(self.req("POST", "/api/stats/reset", {})[0], 200)

    def test_sse_stream_sends_snapshot(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/api/stream", headers={"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")
        line = r.fp.readline()
        self.assertTrue(line.startswith(b"data: "))
        self.assertEqual(json.loads(line[6:])["snapshot"]["gpu"]["power_w"], 50)
        c.close()


if __name__ == "__main__":
    unittest.main()
