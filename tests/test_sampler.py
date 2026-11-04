import unittest

from spark_console import sampler


class HistoryTest(unittest.TestCase):
    def test_columns_for_window_with_missing_values(self):
        h = sampler.History(maxlen=5)
        for t in range(10):
            h.add(float(t), {"a": t, **({"b": t * 2} if t % 2 else {})})
        cols = h.columns(window_s=3, now=9.0)
        self.assertEqual(cols["t"], [6.0, 7.0, 8.0, 9.0])
        self.assertEqual(cols["a"], [6, 7, 8, 9])
        self.assertEqual(cols["b"], [None, 14, None, 18])

    def test_maxlen_drops_oldest(self):
        h = sampler.History(maxlen=2)
        for t in range(3):
            h.add(float(t), {"a": t})
        self.assertEqual(h.columns(window_s=100, now=2.0)["a"], [1, 2])


class StatsTest(unittest.TestCase):
    def test_min_max_avg_and_reset(self):
        s = sampler.Stats()
        for v in (3, 1, None, 5):
            s.add({"x": v})
        self.assertEqual(s.get()["x"], {"min": 1, "max": 5, "avg": 3.0, "n": 3})
        s.reset()
        self.assertEqual(s.get(), {})


class DerivedTest(unittest.TestCase):
    def test_energy_per_token_needs_real_decode(self):
        self.assertAlmostEqual(sampler.j_per_token(54.0, 43.2), 1.25)
        self.assertIsNone(sampler.j_per_token(54.0, 0.5))  # idle server: no meaningful ratio
        self.assertIsNone(sampler.j_per_token(None, 40.0))

    def test_cluster_summary(self):
        pols = [{"policy": 0, "cluster": "a725", "cur_khz": 2000000, "max_khz": 2808000, "hw_max_khz": 2808000,
                 "hw_min_khz": 338000, "perf_limited": 0},
                {"policy": 5, "cluster": "x925", "cur_khz": 3900000, "max_khz": 3000000, "hw_max_khz": 3900000,
                 "hw_min_khz": 1378000, "perf_limited": 1},
                {"policy": 6, "cluster": "x925", "cur_khz": 2900000, "max_khz": 3000000, "hw_max_khz": 3900000,
                 "hw_min_khz": 1378000, "perf_limited": 0}]
        utils = {"cpu0": 10.0, "cpu5": 50.0, "cpu6": 30.0}
        s = sampler.cluster_summary(pols, utils)
        self.assertEqual(s["x925"]["mhz"], 3400)
        self.assertEqual(s["x925"]["util"], 40.0)
        self.assertEqual(s["x925"]["max_mhz"], 3000)
        self.assertEqual(s["x925"]["perf_limited"], 1)
        self.assertEqual(s["a725"]["cores"], 1)

    def test_rate_from_counters(self):
        r = sampler.Rate()
        self.assertIsNone(r.update(100.0, t=10.0))
        self.assertEqual(r.update(160.0, t=12.0), 30.0)
        self.assertIsNone(r.update(5.0, t=13.0))  # counter reset (server restart)

    def test_process_rows(self):
        prev = {1: {"pid": 1, "comm": "a", "state": "S", "ppid": 0, "ticks": 100, "rss_pages": 10}}
        cur = [{"pid": 1, "comm": "a", "state": "S", "ppid": 0, "ticks": 150, "rss_pages": 10},
               {"pid": 2, "comm": "b", "state": "R", "ppid": 1, "ticks": 5, "rss_pages": 1},
               {"pid": 3, "comm": "c", "state": "S", "ppid": 1, "ticks": 0, "rss_pages": 0}]
        rows = sampler.process_rows(prev, cur, dt=1.0, gpu_mib={3: 2048}, hz=100, page_kib=4, limit=1)
        self.assertEqual([r["pid"] for r in rows], [1, 3])  # top CPU, then any process holding GPU memory
        self.assertEqual(rows[0]["cpu"], 50.0)
        self.assertEqual(rows[0]["rss_mib"], 0.04)
        self.assertEqual(rows[1]["gpu_mib"], 2048)
        self.assertIsNone(rows[1]["cpu"])  # new since last sample: no rate yet


if __name__ == "__main__":
    unittest.main()
