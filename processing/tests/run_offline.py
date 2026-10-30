"""Run unittest test discovery with the repository-owned offline socket guard installed."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

tests_dir = Path(__file__).resolve().parent
if str(tests_dir) not in sys.path:
    sys.path.insert(0, str(tests_dir))

import socket_guard

socket_guard.install()


def _read_child_attempts(audit_path: Path) -> int:
    if not audit_path.exists():
        return 0
    lines = [line.strip() for line in audit_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return len(lines)


if __name__ == "__main__":
    current_pp = os.environ.get("PYTHONPATH", "")
    pp_parts = [p for p in current_pp.split(os.pathsep) if p]
    if str(tests_dir) not in pp_parts:
        os.environ["PYTHONPATH"] = os.pathsep.join([str(tests_dir)] + pp_parts)

    if sys.argv[1:]:
        if sys.argv[1] == "discover":
            argv = sys.argv[1:]
        else:
            argv = ["discover", "-s", str(tests_dir)] + sys.argv[1:]
    else:
        argv = ["discover", "-s", str(tests_dir)]

    with tempfile.TemporaryDirectory(prefix="peekaplate-socket-guard-") as temp_dir:
        audit_path = Path(temp_dir) / "attempts.log"
        os.environ["SOCKET_GUARD_AUDIT_FILE"] = str(audit_path)
        try:
            prog = unittest.main(module=None, argv=[sys.argv[0]] + argv, exit=False)
            unexpected = socket_guard.get_attempts() + _read_child_attempts(audit_path)
            if unexpected > 0:
                print(
                    f"FAILED: Offline test suite made {unexpected} unexpected socket attempts!",
                    file=sys.stderr,
                )
                sys.exit(1)
            if not prog.result.wasSuccessful() or prog.result.testsRun == 0:
                sys.exit(1)
            sys.exit(0)
        except SystemExit:
            unexpected = socket_guard.get_attempts() + _read_child_attempts(audit_path)
            if unexpected > 0:
                print(
                    f"FAILED: Offline test suite made {unexpected} unexpected socket attempts!",
                    file=sys.stderr,
                )
                sys.exit(1)
            raise
