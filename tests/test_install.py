"""install.sh against stub commands: a temporary HOME and a PATH with stubs plus the few real tools it needs."""
import os
import pty
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "install.sh"
UNIT = REPO / "deploy/spark-console.service"
DNS = "spark.example.ts.net"

# Each stub appends "<name> <args>" to $STUB_LOG. uname and id only answer.
STUBS = {
    "sudo": "",
    "systemctl": "",
    "nvidia-smi": "",
    "tailscale": f"""case "$1 $2" in
  "status --json") echo '{{"Self": {{"DNSName": "{DNS}."}}}}' ;;
  "status ") exit "${{STUB_STATUS_EXIT:-0}}" ;;
  "serve "*) exit "${{STUB_SERVE_EXIT:-0}}" ;;
esac""",
    "git": f'exec {shutil.which("git")} "$@"',
}


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home, self.run_dir, self.stubs, self.tools = (root / n for n in ("home", "run", "stubs", "tools"))
        for d in (self.home, self.run_dir, self.stubs, self.tools):
            d.mkdir()
        for name, body in STUBS.items():
            self.stub(name, f'printf "%s\\n" "{name} $*" >> "$STUB_LOG"\n{body}')
        self.stub("uname", 'echo "Linux ${STUB_ARCH:-aarch64}"')
        self.stub("sleep", "")
        for tool in ("sh", "mkdir", "sed", "id"):
            (self.tools / tool).symlink_to(shutil.which(tool))
        (self.tools / "python3").symlink_to(sys.executable)
        self.logfile = root / "log"
        self.logfile.touch()
        self.clone = self.home / "projects/spark-console"
        self.sock_path = self.run_dir / "spark-console/http.sock"
        self.sock = f"unix:{self.sock_path}"
        self.sock_path.parent.mkdir()
        with socket.socket(socket.AF_UNIX) as s:  # stands for the started server, which install.sh waits for
            s.bind(str(self.sock_path))
        self.repo_url = REPO.as_uri()

    def tearDown(self):
        self.tmp.cleanup()

    def stub(self, name, body):
        path = self.stubs / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)

    def env(self, **env):
        return {"HOME": str(self.home), "PATH": f"{self.stubs}:{self.tools}", "XDG_RUNTIME_DIR": str(self.run_dir),
                "STUB_LOG": str(self.logfile), "SPARK_CONSOLE_REPO": self.repo_url, **env}

    def install(self, *args, **env):
        # A new session has no controlling terminal, so a prompt on /dev/tty cannot block the test.
        return subprocess.run([shutil.which("sh"), str(SCRIPT), *args], env=self.env(**env), capture_output=True,
                              text=True, timeout=60, start_new_session=True)

    def piped(self, script, answer):
        """Run the script as curl | sh does: the script on stdin, the answer typed ahead on a terminal."""
        master, slave = pty.openpty()
        tty = os.ttyname(slave)
        try:
            os.write(master, answer + b"\n")
            # Opening the tty in a new session makes it the controlling terminal, which /dev/tty names.
            return subprocess.run([shutil.which("sh")], input=script, env=self.env(), capture_output=True, timeout=60,
                                  start_new_session=True, preexec_fn=lambda: os.close(os.open(tty, os.O_RDWR)))
        finally:
            os.close(master)
            os.close(slave)

    def log(self):
        return self.logfile.read_text().splitlines()

    def expected_log(self):
        return [
            "systemctl --user show-environment",
            "tailscale status",
            f"git clone {self.repo_url} {self.clone}",
            f"sudo sh {self.clone}/deploy/install.sh",
            "systemctl --user daemon-reload",
            "systemctl --user try-restart spark-console",
            "systemctl --user enable --now spark-console",
            f"tailscale serve --bg --https=9443 {self.sock}",
            "tailscale status --json",
        ]

    def assert_refused(self, p):
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(len(p.stderr.splitlines()), 1, p.stderr)  # one line that names the cause
        self.assertFalse(any(line.startswith(("git ", "sudo ", "systemctl --user daemon-reload")) for line in self.log()))
        self.assertFalse((self.home / ".config").exists())

    def test_fresh_install_runs_the_steps_in_order(self):
        p = self.install(SPARK_CONSOLE_YES="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.log(), self.expected_log())
        self.assertEqual(p.stdout.splitlines()[-1], f"https://{DNS}:9443/")
        self.assertTrue((self.clone / "deploy/install.sh").is_file())

    def test_user_unit_points_at_the_clone(self):
        self.install("-y")
        unit = (self.home / ".config/systemd/user/spark-console.service").read_text()
        self.assertEqual(unit, UNIT.read_text().replace("%h/projects/spark-console", str(self.clone)))
        self.assertIn(f"WorkingDirectory={self.clone}\n", unit)

    def test_rerun_uses_the_clone_and_repeats_the_other_steps(self):
        self.install("-y")
        first, unit = self.log(), (self.home / ".config/systemd/user/spark-console.service").read_text()
        self.logfile.write_text("")
        p = self.install("-y")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.log(), [line for line in first if not line.startswith("git ")])
        self.assertEqual((self.home / ".config/systemd/user/spark-console.service").read_text(), unit)

    def test_serve_falls_back_to_sudo(self):
        p = self.install("-y", STUB_SERVE_EXIT="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        serve = f"tailscale serve --bg --https=9443 {self.sock}"
        log = self.log()
        self.assertEqual(log[log.index(serve) + 1], f"sudo {serve}")

    def test_missing_requirement_stops_before_any_change(self):
        for tool, where in [("nvidia-smi", self.stubs), ("python3", self.tools), ("git", self.stubs),
                            ("systemctl", self.stubs), ("tailscale", self.stubs)]:
            with self.subTest(tool):
                (where / tool).rename(where / f"{tool}.off")
                try:
                    p = self.install("-y")
                finally:
                    (where / f"{tool}.off").rename(where / tool)
                self.assert_refused(p)
                self.assertFalse((self.home / "projects").exists())

    def test_logged_out_tailscale_stops_before_any_change(self):
        self.assert_refused(self.install("-y", STUB_STATUS_EXIT="1"))

    def test_folder_without_deploy_script_stops(self):
        self.clone.mkdir(parents=True)
        (self.clone / "notes.txt").write_text("mine\n")
        self.assert_refused(self.install("-y"))
        self.assertEqual([f.name for f in self.clone.iterdir()], ["notes.txt"])

    def test_folder_with_characters_that_break_the_unit_stops(self):
        for name in ("R&D", "a|b", "100%", "back\\slash"):
            with self.subTest(name):
                self.assert_refused(self.install("-y", SPARK_CONSOLE_DIR=str(self.home / name / "spark-console")))

    def test_folder_of_another_user_stops(self):
        p = self.install("-y", SPARK_CONSOLE_DIR="/")
        self.assert_refused(p)
        self.assertIn("is not owned by you", p.stderr)

    def test_service_that_does_not_start_stops_before_serve(self):
        self.sock_path.unlink()
        p = self.install("-y")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stderr.splitlines()[-1], "spark-console did not start. Read: journalctl --user -u spark-console")
        self.assertFalse(any(line.startswith("tailscale serve") for line in self.log()))

    def test_piped_script_reads_the_answer_on_the_terminal(self):
        p = self.piped(SCRIPT.read_bytes(), b"n")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stderr, b"Stopped. Nothing changed.\n")
        self.assertEqual(self.log(), self.expected_log()[:2])
        self.logfile.write_text("")
        p = self.piped(SCRIPT.read_bytes(), b"y")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.log(), self.expected_log())

    def test_partial_download_runs_nothing(self):
        script = SCRIPT.read_bytes()
        p = self.piped(script[:script.rstrip(b"\n").rindex(b"\n") + 1], b"y")  # without the last line
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.log(), [])

    def test_no_terminal_and_no_yes_stops(self):
        self.assert_refused(self.install())

    def test_refuses_root(self):
        self.stub("id", "echo 0")
        p = self.install("-y")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stderr, "Run as your own user, not root.\n")
        self.assertEqual(self.log(), [])

    def test_refuses_x86_64(self):
        p = self.install("-y", STUB_ARCH="x86_64")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(len(p.stderr.splitlines()), 1, p.stderr)
        self.assertEqual(self.log(), [])


if __name__ == "__main__":
    unittest.main()
