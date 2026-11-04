import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from spark_console import helper
from tests.fakesys import build_cpu_tree, read


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, **kw):
        self.calls.append(list(argv))


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cpu = build_cpu_tree(root / "sys")
        (root / "boot_id").write_text("abc-123\n")
        self.run = Recorder()
        self.ctx = helper.Ctx(
            cpu_root=str(self.cpu),
            unit_dir=str(root / "units"),
            run_dirs=(str(root / "run/spark-console"), str(root / "run/sparkdash")),
            boot_id_path=str(root / "boot_id"),
            run=self.run,
        )
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def main(self, *argv):
        with contextlib.redirect_stderr(io.StringIO()):  # refusals print a reason; keep test output clean
            return helper.main(list(argv), self.ctx)

    # --- cluster detection -------------------------------------------------
    def test_policies_are_grouped_by_core_type(self):
        groups = helper.policies(self.ctx.cpu_root)
        self.assertEqual(sorted(int(p.rsplit("policy", 1)[1]) for p in groups["x925"]),
                         [5, 6, 7, 8, 9, 15, 16, 17, 18, 19])
        self.assertEqual(len(groups["a725"]), 10)

    # --- GPU ---------------------------------------------------------------
    def test_gpu_cap_runs_nvidia_smi_and_writes_both_markers(self):
        self.assertEqual(self.main("gpu-cap", "1800"), 0)
        self.assertEqual(self.run.calls, [["/usr/bin/nvidia-smi", "-lgc", "0,1800"]])
        for d in self.ctx.run_dirs:
            self.assertEqual(read(Path(d) / "gpu-clock-cap"), "1800 abc-123")

    def test_gpu_reset_records_no_cap_and_removes_sparkdash_marker(self):
        self.main("gpu-cap", "2000")
        self.assertEqual(self.main("gpu-reset"), 0)
        self.assertEqual(self.run.calls[-1], ["/usr/bin/nvidia-smi", "-rgc"])
        self.assertEqual(read(Path(self.ctx.run_dirs[0]) / "gpu-clock-cap"), "none abc-123")
        self.assertFalse((Path(self.ctx.run_dirs[1]) / "gpu-clock-cap").exists())

    def test_gpu_cap_refuses_bad_values(self):
        for bad in ["299", "3101", "18x0", "-1800", "1800 -q", "", "0,1800", "1e3", "01800"]:
            with self.subTest(bad=bad):
                self.assertEqual(self.main("gpu-cap", bad), 2)
        self.assertEqual(self.run.calls, [])

    # --- CPU ---------------------------------------------------------------
    def test_cpu_epp_writes_every_policy(self):
        self.assertEqual(self.main("cpu-epp", "200"), 0)
        vals = {read(p / "energy_performance_preference_val") for p in (self.cpu / "cpufreq").iterdir()}
        self.assertEqual(vals, {"200"})

    def test_cpu_epp_refuses_out_of_range(self):
        self.assertEqual(self.main("cpu-epp", "256"), 2)

    def test_cpu_max_writes_only_its_cluster(self):
        self.assertEqual(self.main("cpu-max", "x925", "3000000"), 0)
        self.assertEqual(read(self.cpu / "cpufreq/policy5/scaling_max_freq"), "3000000")
        self.assertEqual(read(self.cpu / "cpufreq/policy0/scaling_max_freq"), "2808000")

    def test_cpu_max_refuses_outside_hardware_range_or_bad_cluster(self):
        self.assertEqual(self.main("cpu-max", "x925", "4000000"), 2)
        self.assertEqual(self.main("cpu-max", "x925", "1000000"), 2)  # below X925 min 1378000
        self.assertEqual(self.main("cpu-max", "a925", "2000000"), 2)
        self.assertEqual(self.main("cpu-max", "x925"), 2)

    def test_cpu_governor_must_be_available(self):
        self.assertEqual(self.main("cpu-governor", "schedutil"), 0)
        self.assertEqual(read(self.cpu / "cpufreq/policy3/scaling_governor"), "schedutil")
        self.assertEqual(self.main("cpu-governor", "turbo"), 2)
        self.assertEqual(self.main("cpu-governor", "../x"), 2)

    # --- persistence -------------------------------------------------------
    def test_persist_gpu_writes_dropin_and_reloads(self):
        self.assertEqual(self.main("persist-gpu", "1900"), 0)
        text = (Path(self.ctx.unit_dir) / "gb10-clocklock.service.d/50-spark-console.conf").read_text()
        self.assertIn("ExecStart=\nExecStart=/usr/bin/nvidia-smi -lgc 0,1900\n", text)
        self.assertIn("ExecStartPost=/usr/local/sbin/spark-console-helper mark-gpu 1900", text)
        self.assertEqual(self.run.calls[-1], ["/usr/bin/systemctl", "daemon-reload"])

    def test_persist_gpu_none_resets_at_boot(self):
        self.assertEqual(self.main("persist-gpu", "none"), 0)
        text = (Path(self.ctx.unit_dir) / "gb10-clocklock.service.d/50-spark-console.conf").read_text()
        self.assertIn("ExecStart=/usr/bin/nvidia-smi -rgc", text)
        self.assertNotIn("mark-gpu", text)

    def test_persist_cpu_writes_dropin_with_checked_values(self):
        self.assertEqual(self.main("persist-cpu", "192", "3000000", "2808000", "performance"), 0)
        text = (Path(self.ctx.unit_dir) / "cpu-epp.service.d/50-spark-console.conf").read_text()
        for line in ["ExecStart=/usr/local/sbin/spark-console-helper cpu-governor performance",
                     "ExecStart=/usr/local/sbin/spark-console-helper cpu-epp 192",
                     "ExecStart=/usr/local/sbin/spark-console-helper cpu-max x925 3000000",
                     "ExecStart=/usr/local/sbin/spark-console-helper cpu-max a725 2808000"]:
            self.assertIn(line + "\n", text)
        self.assertEqual(self.main("persist-cpu", "192", "3000000", "2808000", "turbo"), 2)

    def test_mark_gpu_writes_markers_without_touching_clocks(self):
        self.assertEqual(self.main("mark-gpu", "2100"), 0)
        self.assertEqual(self.run.calls, [])
        self.assertEqual(read(Path(self.ctx.run_dirs[1]) / "gpu-clock-cap"), "2100 abc-123")

    def test_unknown_action_and_extra_args_are_refused(self):
        self.assertEqual(self.main("shell", "id"), 2)
        self.assertEqual(self.main("gpu-reset", "now"), 2)
        self.assertEqual(self.main(), 2)


if __name__ == "__main__":
    unittest.main()
