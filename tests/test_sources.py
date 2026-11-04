import tempfile
import unittest
from pathlib import Path

from spark_console import sources
from tests.fakesys import build_cpu_tree


class ParserTest(unittest.TestCase):
    def test_proc_stat_and_util(self):
        a = sources.parse_proc_stat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\nintr 1\n")
        b = sources.parse_proc_stat("cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 100 0 50 450 0 0 0 0 0 0\n")
        self.assertEqual(sources.util(a["cpu"], b["cpu"]), 50.0)
        self.assertEqual(sources.util(a["cpu0"], b["cpu0"]), 50.0)
        self.assertIsNone(sources.util(b["cpu"], b["cpu"]))  # no elapsed ticks

    def test_iowait_counts_as_idle(self):
        a = sources.parse_proc_stat("cpu0 0 0 0 0 0 0 0 0 0 0\n")
        b = sources.parse_proc_stat("cpu0 10 0 0 0 90 0 0 0 0 0\n")
        self.assertEqual(sources.util(a["cpu0"], b["cpu0"]), 10.0)

    def test_meminfo(self):
        m = sources.parse_meminfo("MemTotal:       127597272 kB\nMemAvailable:   16901860 kB\nHugePages_Total:       0\n")
        self.assertEqual(m["MemTotal"], 127597272)
        self.assertEqual(m["HugePages_Total"], 0)

    def test_psi(self):
        p = sources.parse_psi("some avg10=1.50 avg60=0.20 avg300=0.00 total=19995928\n"
                              "full avg10=0.30 avg60=0.00 avg300=0.00 total=100\n")
        self.assertEqual(p["some"]["avg10"], 1.5)
        self.assertEqual(p["full"]["total"], 100)

    def test_nvsmi_line_with_na_and_units_stripped(self):
        line = "94, 2086, 3003, 61, 12, 54.21, 0x0000000000000004, 89008930, 0, 0, 0, P0"
        g = sources.parse_nvsmi(line)
        self.assertEqual(g["util"], 94)
        self.assertEqual(g["sm_mhz"], 2086)
        self.assertEqual(g["tlimit_c"], 12)
        self.assertAlmostEqual(g["power_w"], 54.21)
        self.assertEqual(g["reasons"], ["sw_power_cap"])
        self.assertEqual(g["counters_us"]["sw_power_cap"], 89008930)
        self.assertEqual(g["pstate"], "P0")
        g = sources.parse_nvsmi("[N/A], 2086, 3003, 61, [N/A], 6.4, 0x0, 0, 0, 0, 0, P8")
        self.assertIsNone(g["util"])
        self.assertIsNone(g["tlimit_c"])
        self.assertEqual(g["reasons"], [])

    def test_nvsmi_rejects_wrong_field_count(self):
        self.assertIsNone(sources.parse_nvsmi("1, 2"))

    def test_decode_reasons(self):
        self.assertEqual(sources.decode_reasons(0x1 | 0x40), ["gpu_idle", "hw_thermal_slowdown"])

    def test_prometheus_sums_label_sets_and_skips_comments(self):
        text = ('# HELP vllm:generation_tokens_total x\n'
                'vllm:generation_tokens_total{engine="0",model_name="a"} 200.0\n'
                'vllm:generation_tokens_total{engine="1",model_name="a"} 1e2\n'
                'vllm:num_requests_running{engine="0"} 2.0\n'
                'llamacpp:tokens_predicted_total 7\n')
        p = sources.parse_prom(text)
        self.assertEqual(p["vllm:generation_tokens_total"], 300.0)
        self.assertEqual(p["vllm:num_requests_running"], 2.0)
        self.assertEqual(p["llamacpp:tokens_predicted_total"], 7.0)

    def test_pid_stat_with_spaces_and_parens_in_comm(self):
        line = "1701308 (VLLM::Engine (x) y) S 1700000 1 1 0 -1 4194560 0 0 0 0 120 30 0 0 20 0 50 0 100 0 2500\n"
        s = sources.parse_pid_stat(line)
        self.assertEqual(s["pid"], 1701308)
        self.assertEqual(s["comm"], "VLLM::Engine (x) y")
        self.assertEqual(s["state"], "S")
        self.assertEqual(s["ppid"], 1700000)
        self.assertEqual(s["ticks"], 150)
        self.assertEqual(s["rss_pages"], 2500)

    def test_compute_apps(self):
        apps = sources.parse_compute_apps("1701308, 97121\n42, [N/A]\n\n")
        self.assertEqual(apps, {1701308: 97121, 42: None})

    def test_systemctl_show_blocks(self):
        text = ("Id=gb10-clocklock.service\nActiveState=active\nUnitFileState=enabled\n\n"
                "Id=cpu-epp.service\nActiveState=failed\nUnitFileState=enabled\n")
        units = sources.parse_systemctl_show(text)
        self.assertEqual(units["cpu-epp.service"]["ActiveState"], "failed")


class SysfsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_read_cpufreq(self):
        cpu = build_cpu_tree(self.root / "sys")
        (cpu / "cpufreq/policy5/scaling_cur_freq").write_text("3456000\n")
        pols = sources.read_cpufreq(str(cpu))
        self.assertEqual(len(pols), 20)
        p5 = next(p for p in pols if p["policy"] == 5)
        self.assertEqual(p5["cluster"], "x925")
        self.assertEqual(p5["cur_khz"], 3456000)
        self.assertEqual(p5["hw_max_khz"], 3900000)
        self.assertEqual(p5["epp"], 128)
        self.assertEqual(p5["governor"], "performance")
        self.assertEqual(p5["perf_limited"], 0)

    def test_read_sensors_thermal_zones_and_labelled_hwmon(self):
        tz = self.root / "class/thermal/thermal_zone0"
        tz.mkdir(parents=True)
        (tz / "type").write_text("acpitz\n")
        (tz / "temp").write_text("40100\n")
        hw = self.root / "class/hwmon/hwmon7"
        hw.mkdir(parents=True)
        (hw / "name").write_text("nvme\n")
        (hw / "temp1_input").write_text("35850\n")
        (hw / "temp1_label").write_text("Composite\n")
        acpi = self.root / "class/hwmon/hwmon0"
        acpi.mkdir(parents=True)
        (acpi / "name").write_text("acpitz_0\n")
        (acpi / "temp1_input").write_text("40100\n")
        sensors = sources.read_sensors(str(self.root / "class"))
        by_id = {s["id"]: s for s in sensors}
        self.assertEqual(by_id["thermal_zone0"]["temp_c"], 40.1)
        self.assertEqual(by_id["hwmon7/temp1"]["name"], "nvme Composite")
        self.assertNotIn("hwmon0/temp1", by_id)  # acpitz hwmon mirrors the thermal zones


if __name__ == "__main__":
    unittest.main()
