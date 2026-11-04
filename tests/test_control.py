import tempfile
import unittest
from pathlib import Path

from spark_console import control

LIMITS = {
    "x925": (1378000, 3900000),
    "a725": (338000, 2808000),
    "governors": ["performance", "schedutil", "powersave"],
}


class FakeMachine:
    """Stands in for sudo + helper: records argv and changes state like the hardware would."""

    def __init__(self):
        self.state = {"gpu_cap_mhz": 2100, "epp": 128, "governor": "performance",
                      "x925_max_khz": 3900000, "a725_max_khz": 2808000}
        self.calls = []
        self.fail_on = None

    def run(self, args):
        self.calls.append(list(args))
        if self.fail_on and args[0] == self.fail_on:
            raise control.HelperError(f"{args[0]} failed")
        a = args
        if a[0] == "gpu-cap":
            self.state["gpu_cap_mhz"] = int(a[1])
        elif a[0] == "gpu-reset":
            self.state["gpu_cap_mhz"] = None
        elif a[0] == "cpu-epp":
            self.state["epp"] = int(a[1])
        elif a[0] == "cpu-governor":
            self.state["governor"] = a[1]
        elif a[0] == "cpu-max":
            self.state[f"{a[1]}_max_khz"] = int(a[2])

    def current(self):
        return dict(self.state)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.m = FakeMachine()
        self.clock = Clock()
        self.c = control.Controller(run=self.m.run, read_current=self.m.current,
                                    read_limits=lambda: LIMITS, read_persisted=lambda: {},
                                    clock=self.clock, trial_s=60)

    def test_apply_starts_trial_and_reverts_after_deadline(self):
        self.c.apply({"gpu_cap_mhz": 1800, "epp": 200})
        self.assertEqual(self.m.state["gpu_cap_mhz"], 1800)
        st = self.c.status()
        self.assertEqual(st["trial"]["applied"], {"gpu_cap_mhz": 1800, "epp": 200})
        self.assertEqual(st["trial"]["remaining_s"], 60)
        self.clock.t += 59
        self.c.tick()
        self.assertEqual(self.m.state["gpu_cap_mhz"], 1800)
        self.clock.t += 1
        self.c.tick()
        self.assertEqual(self.m.state["gpu_cap_mhz"], 2100)
        self.assertEqual(self.m.state["epp"], 128)
        self.assertIsNone(self.c.status()["trial"])
        self.assertEqual(self.c.status()["events"][-1]["kind"], "reverted")

    def test_keep_ends_trial_without_revert(self):
        self.c.apply({"epp": 64})
        self.c.keep(persist=False)
        self.clock.t += 600
        self.c.tick()
        self.assertEqual(self.m.state["epp"], 64)
        self.assertFalse(any(c[0].startswith("persist") for c in self.m.calls))

    def test_keep_after_reboot_persists_only_touched_scopes(self):
        self.c.apply({"gpu_cap_mhz": None})
        self.c.keep(persist=True)
        self.assertEqual(self.m.calls[-1], ["persist-gpu", "none"])
        self.c.apply({"x925_max_khz": 3000000})
        self.c.keep(persist=True)
        self.assertEqual(self.m.calls[-1], ["persist-cpu", "128", "3000000", "2808000", "performance"])

    def test_revert_now(self):
        self.c.apply({"governor": "schedutil"})
        self.c.revert()
        self.assertEqual(self.m.state["governor"], "performance")
        self.assertIsNone(self.c.status()["trial"])

    def test_second_apply_during_trial_is_busy(self):
        self.c.apply({"epp": 10})
        with self.assertRaises(control.Busy):
            self.c.apply({"epp": 20})

    def test_unchanged_values_are_skipped(self):
        self.c.apply({"epp": 128, "gpu_cap_mhz": 2100})
        self.assertEqual(self.m.calls, [])
        self.assertIsNone(self.c.status()["trial"])

    def test_failure_midway_rolls_back_what_was_applied(self):
        self.m.fail_on = "gpu-cap"
        with self.assertRaises(control.HelperError):
            self.c.apply({"epp": 50, "gpu_cap_mhz": 1500})
        self.assertEqual(self.m.state["epp"], 128)
        self.assertIsNone(self.c.status()["trial"])
        self.assertEqual(self.c.status()["events"][-1]["kind"], "failed")

    def test_validation(self):
        bad = [{"gpu_cap_mhz": 100}, {"gpu_cap_mhz": "1800"}, {"gpu_cap_mhz": True}, {"epp": 300},
               {"x925_max_khz": 4000000}, {"a725_max_khz": 100}, {"governor": "turbo"}, {"fan": 1}, {}]
        for changes in bad:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.c.apply(changes)
        self.assertEqual(self.m.calls, [])

    def test_trial_seconds_can_be_set_per_apply_within_bounds(self):
        self.c.apply({"epp": 1}, trial_s=15)
        self.assertEqual(self.c.status()["trial"]["remaining_s"], 15)
        self.c.revert()
        with self.assertRaises(ValueError):
            self.c.apply({"epp": 1}, trial_s=1)

    def test_failed_revert_reverts_what_it_can_keeps_trial_and_retries(self):
        self.c.apply({"epp": 0, "gpu_cap_mhz": 3000})
        self.m.fail_on = "gpu-cap"
        self.clock.t += 60
        self.c.tick()
        self.assertEqual(self.m.state["epp"], 128)  # reverted despite the GPU failure
        self.assertEqual(self.m.state["gpu_cap_mhz"], 3000)
        st = self.c.status()
        self.assertIsNotNone(st["trial"])
        self.assertTrue(st["trial"]["revert_error"])
        self.m.fail_on = None
        self.clock.t += 10
        self.c.tick()
        self.assertEqual(self.m.state["gpu_cap_mhz"], 2100)
        self.assertIsNone(self.c.status()["trial"])

    def test_persist_refused_during_trial(self):
        self.c.apply({"epp": 0})
        with self.assertRaises(control.Busy):
            self.c.persist(gpu=True, cpu=True)

    def test_keep_after_trial_ended_is_refused(self):
        self.c.apply({"epp": 0})
        self.clock.t += 60
        self.c.tick()
        with self.assertRaises(control.Busy):
            self.c.keep(persist=True)
        self.assertFalse(any(c[0].startswith("persist") for c in self.m.calls))

    def test_keep_with_failing_persist_keeps_values_and_reports(self):
        self.c.apply({"epp": 7})
        self.m.fail_on = "persist-cpu"
        with self.assertRaises(control.HelperError):
            self.c.keep(persist=True)
        self.assertEqual(self.m.state["epp"], 7)
        self.assertIsNone(self.c.status()["trial"])
        kinds = [e["kind"] for e in self.c.status()["events"]]
        self.assertEqual(kinds[-2:], ["kept", "persist_failed"])

    def test_trial_journal_lets_a_restarted_server_revert(self):
        with tempfile.TemporaryDirectory() as d:
            journal, boot = f"{d}/trial.json", f"{d}/boot_id"
            Path(boot).write_text("boot-1\n")
            c1 = control.Controller(run=self.m.run, read_current=self.m.current, read_limits=lambda: LIMITS,
                                    read_persisted=lambda: {}, clock=self.clock, journal=journal, boot_id_path=boot)
            c1.apply({"epp": 5, "gpu_cap_mhz": 1500})
            self.assertTrue(Path(journal).exists())
            # The process dies here without reverting. A new one starts:
            c2 = control.Controller(run=self.m.run, read_current=self.m.current, read_limits=lambda: LIMITS,
                                    read_persisted=lambda: {}, clock=self.clock, journal=journal, boot_id_path=boot)
            c2.recover()
            self.assertEqual(self.m.state["epp"], 128)
            self.assertEqual(self.m.state["gpu_cap_mhz"], 2100)
            self.assertFalse(Path(journal).exists())
            self.assertEqual(c2.status()["events"][-1]["why"], "recovered after restart")

    def test_journal_from_an_earlier_boot_is_discarded(self):
        # After a reboot the boot units have already set the boot values; reverting would override them.
        with tempfile.TemporaryDirectory() as d:
            journal, boot = f"{d}/trial.json", f"{d}/boot_id"
            Path(boot).write_text("boot-1\n")
            mk = lambda: control.Controller(run=self.m.run, read_current=self.m.current, read_limits=lambda: LIMITS,
                                            read_persisted=lambda: {}, clock=self.clock, journal=journal, boot_id_path=boot)
            mk().apply({"epp": 5})
            Path(boot).write_text("boot-2\n")
            self.m.state["epp"] = 128  # what the boot unit set
            calls = len(self.m.calls)
            c = mk()
            c.recover()
            self.assertEqual(len(self.m.calls), calls)  # nothing applied
            self.assertEqual(self.m.state["epp"], 128)
            self.assertFalse(Path(journal).exists())
            self.assertEqual(c.status()["events"][-1]["kind"], "trial_dropped_by_reboot")

    def test_journal_removed_on_keep_and_revert(self):
        with tempfile.TemporaryDirectory() as d:
            journal = f"{d}/trial.json"
            c = control.Controller(run=self.m.run, read_current=self.m.current, read_limits=lambda: LIMITS,
                                   read_persisted=lambda: {}, clock=self.clock, journal=journal)
            c.apply({"epp": 5})
            c.keep()
            self.assertFalse(Path(journal).exists())
            c.apply({"epp": 6})
            c.revert()
            self.assertFalse(Path(journal).exists())
            c.recover()  # nothing to do
            self.assertEqual(self.m.state["epp"], 5)

    def test_reapply_boot(self):
        self.c.reapply_boot()
        self.assertEqual(self.m.calls[-1], ["reapply-boot"])
        self.c.apply({"epp": 1})
        with self.assertRaises(control.Busy):
            self.c.reapply_boot()

    def test_shutdown_reverts_open_trial(self):
        self.c.apply({"epp": 1})
        self.c.shutdown()
        self.assertEqual(self.m.state["epp"], 128)


class ReadersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "boot_id").write_text("b1\n")
        self.units = self.root / "units"
        self.units.mkdir()
        (self.units / "gb10-clocklock.service").write_text(
            "[Service]\nExecStart=/usr/bin/nvidia-smi -lgc 0,2100\nExecStop=/usr/bin/nvidia-smi -rgc\n")
        (self.units / "cpu-epp.service").write_text(
            "[Service]\nExecStart=/bin/sh -c 'for f in /x/energy_performance_preference_val; do echo 128 > \"$f\"; done'\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_persisted_from_base_units(self):
        p = control.read_persisted(str(self.units))
        self.assertEqual(p, {"gpu_cap_mhz": 2100, "epp": 128})

    def test_persisted_dropins_override_base_units(self):
        d = self.units / "gb10-clocklock.service.d"
        d.mkdir()
        (d / "50-spark-console.conf").write_text("[Service]\nExecStart=\nExecStart=/usr/bin/nvidia-smi -rgc\n")
        d = self.units / "cpu-epp.service.d"
        d.mkdir()
        (d / "50-spark-console.conf").write_text(
            "[Service]\nExecStart=\nExecStart=/usr/local/sbin/spark-console-helper cpu-governor schedutil\n"
            "ExecStart=/usr/local/sbin/spark-console-helper cpu-epp 192\n"
            "ExecStart=/usr/local/sbin/spark-console-helper cpu-max x925 3000000\n"
            "ExecStart=/usr/local/sbin/spark-console-helper cpu-max a725 2808000\n")
        p = control.read_persisted(str(self.units))
        self.assertEqual(p, {"gpu_cap_mhz": None, "epp": 192, "governor": "schedutil",
                             "x925_max_khz": 3000000, "a725_max_khz": 2808000})

    def test_gpu_cap_from_marker_of_this_boot_else_boot_value(self):
        marker = self.root / "gpu-clock-cap"
        boot = str(self.root / "boot_id")
        self.assertEqual(control.read_gpu_cap(str(marker), boot, {"gpu_cap_mhz": 2100}), 2100)
        marker.write_text("1800 b1\n")
        self.assertEqual(control.read_gpu_cap(str(marker), boot, {"gpu_cap_mhz": 2100}), 1800)
        marker.write_text("none b1\n")
        self.assertIsNone(control.read_gpu_cap(str(marker), boot, {"gpu_cap_mhz": 2100}))
        marker.write_text("1800 old-boot\n")
        self.assertEqual(control.read_gpu_cap(str(marker), boot, {"gpu_cap_mhz": 2100}), 2100)


class ProfilesTest(unittest.TestCase):
    def test_builtins_and_user_profiles(self):
        with tempfile.TemporaryDirectory() as d:
            store = control.ProfileStore(str(Path(d) / "profiles.json"))
            names = [p["name"] for p in store.all()]
            self.assertEqual(names[:3], ["Quiet", "Balanced", "Max"])
            store.save("Bench", {"gpu_cap_mhz": 2400, "epp": 0})
            self.assertEqual(store.get("Bench")["values"], {"gpu_cap_mhz": 2400, "epp": 0})
            again = control.ProfileStore(str(Path(d) / "profiles.json"))
            self.assertIsNotNone(again.get("Bench"))
            again.delete("Bench")
            self.assertIsNone(again.get("Bench"))
            with self.assertRaises(ValueError):
                again.save("Quiet", {"epp": 1})  # built-ins are read-only
            with self.assertRaises(ValueError):
                again.save("x" * 41, {"epp": 1})
            with self.assertRaises(ValueError):
                again.save("Ok", {"fan": 1})


if __name__ == "__main__":
    unittest.main()
