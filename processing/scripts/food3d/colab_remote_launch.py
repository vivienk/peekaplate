"""Runs in the Colab kernel: start colab_remote_recon.py as a detached process and return."""

import os
import subprocess
import sys

out = open("/content/t2b_remote.out", "ab")
proc = subprocess.Popen([sys.executable, "/content/t2b_remote.py"], stdout=out, stderr=subprocess.STDOUT,
                        env=dict(os.environ), start_new_session=True)
print(f"LAUNCHED pid={proc.pid}", flush=True)
