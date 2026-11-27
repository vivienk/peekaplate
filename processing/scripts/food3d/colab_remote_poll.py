"""Runs in the Colab kernel: report the detached job's state and its latest log lines."""

from pathlib import Path

root = Path("/content/t2b")
out = Path("/content/t2b_remote.out")
tail = out.read_text(errors="replace").splitlines()[-4:] if out.exists() else []
for line in tail:
    print("REMOTE| " + line[-300:])
if (root / "DONE").exists():
    print("STATUS=done")
elif (root / "FAILED").exists():
    print("REMOTE| " + (root / "FAILED").read_text(errors="replace")[-1500:].replace("\n", "\nREMOTE| "))
    print("STATUS=failed")
else:
    print("STATUS=running")
