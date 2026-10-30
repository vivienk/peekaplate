"""Verify self-contained, network-safe test execution and subprocess socket protection."""
import os
import socket
import subprocess
import sys
import unittest
from pathlib import Path

import socket_guard

socket_guard.install()


class OfflineHarnessTests(unittest.TestCase):
    def test_deliberate_connection_is_blocked_and_audited(self):
        before = socket_guard.get_attempts()
        old_probe = os.environ.get("SOCKET_GUARD_NEGATIVE_PROBE")
        os.environ["SOCKET_GUARD_NEGATIVE_PROBE"] = "1"
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with self.assertRaises(AssertionError) as caught:
                sock.connect(("192.0.2.1", 80))
            self.assertIn("Network disabled by offline socket guard", str(caught.exception))
        finally:
            sock.close()
            if old_probe is None:
                os.environ.pop("SOCKET_GUARD_NEGATIVE_PROBE", None)
            else:
                os.environ["SOCKET_GUARD_NEGATIVE_PROBE"] = old_probe
        after = socket_guard.get_attempts()
        self.assertEqual(after, before + 1)
        socket_guard.reset_attempts()

    def test_child_connection_is_blocked(self):
        tests_dir = Path(__file__).resolve().parent
        env = os.environ.copy()
        env["SOCKET_GUARD_NEGATIVE_PROBE"] = "1"
        current_pp = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = os.pathsep.join([str(tests_dir)] + [p for p in current_pp.split(os.pathsep) if p])

        code = (
            "import socket, sys\n"
            "try:\n"
            "    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n"
            "    s.connect(('192.0.2.1', 80))\n"
            "    sys.exit(0)\n"
            "except AssertionError as e:\n"
            "    if 'Network disabled by offline socket guard' in str(e):\n"
            "        sys.exit(42)\n"
            "    sys.exit(1)\n"
            "except Exception:\n"
            "    sys.exit(2)\n"
        )
        proc = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 42, f"Expected code 42 (blocked by guard), got {proc.returncode}. Stderr: {proc.stderr}")

    def test_suite_runner_is_self_contained(self):
        runner_path = Path(__file__).resolve().parent / "run_offline.py"
        self.assertTrue(runner_path.is_file(), "run_offline.py must exist in the tests directory")
        proc = subprocess.run(
            [sys.executable, str(runner_path), "-p", "test_ocr_regions.py"],
            capture_output=True,
            text=True,
            cwd=str(runner_path.parent.parent),
        )
        self.assertEqual(proc.returncode, 0, f"run_offline.py failed: {proc.stderr}\n{proc.stdout}")
        self.assertIn("Ran", proc.stderr + proc.stdout)

    def test_local_socketpair_is_permitted(self):
        if hasattr(socket, "AF_UNIX"):
            pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                pair[0].send(b"ping")
                data = pair[1].recv(4)
                self.assertEqual(data, b"ping")
            finally:
                pair[0].close()
                pair[1].close()


if __name__ == "__main__":
    unittest.main()
