"""Offline tests for the Colab Track 2B stage: spend cap, train-only packing, teardown."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
import unittest.mock
from pathlib import Path

FOOD3D = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
sys.path.insert(0, str(FOOD3D))

import colab_budget as cb  # noqa: E402
import colab_job as cj  # noqa: E402


def make_dataset(root: Path) -> Path:
    ds = root / "ds"
    (ds / "images").mkdir(parents=True)
    (ds / "eval_masks").mkdir()
    train, val = [], []
    for i in range(6):
        name = f"frame_{i:06d}.png"
        (ds / "images" / name).write_bytes(b"img%d" % i)
        (ds / "eval_masks" / name).write_bytes(b"mask%d" % i)
        frame = {"file_path": f"images/{name}", "eval_mask_path": f"eval_masks/{name}"}
        (val if i % 3 == 0 else train).append(frame)
    (ds / "transforms_train.json").write_text(json.dumps({"ply_file_path": "points3d.ply", "frames": train}))
    (ds / "transforms_val.json").write_text(json.dumps({"frames": val}))
    (ds / "points3d.ply").write_bytes(b"ply")
    return ds


class BudgetTests(unittest.TestCase):
    def test_parse_usage(self):
        u = cb.parse_usage("Current balance: 184.49 compute units\nUsage rate: 1.71/hr\nActive assignments: 1\n")
        self.assertEqual((u.balance, u.rate_per_hour, u.active_assignments), (184.49, 1.71, 1))
        with self.assertRaises(ValueError):
            cb.parse_usage("nothing here")

    def test_plan_uses_assumed_rate_when_idle(self):
        p = cb.plan_dish(cap=25, start_balance=184.49, current_balance=184.49, reported_rate=0.0)
        self.assertEqual(p.rate_source, "assumed")
        self.assertEqual(p.rate_per_hour, 8.0)
        self.assertEqual(p.max_seconds, int(0.8 * 25 / 8 * 3600 - 600))
        self.assertTrue(p.run)

    def test_plan_prefers_higher_of_reported_and_measured_with_floor(self):
        p = cb.plan_dish(cap=25, start_balance=100, current_balance=95, reported_rate=1.7, measured_rate=2.5)
        self.assertEqual((p.rate_per_hour, p.rate_source), (4.0, "floor(measured)"))
        self.assertAlmostEqual(p.remaining, 20.0)
        p = cb.plan_dish(cap=25, start_balance=100, current_balance=95, reported_rate=11.0, measured_rate=2.5)
        self.assertEqual((p.rate_per_hour, p.rate_source), (11.0, "reported"))

    def test_plan_skips_when_budget_too_small_or_spent(self):
        low = cb.plan_dish(cap=25, start_balance=100, current_balance=77, reported_rate=5)
        self.assertFalse(low.run)
        self.assertIn("minimum", low.reason)
        gone = cb.plan_dish(cap=25, start_balance=100, current_balance=74)
        self.assertFalse(gone.run)
        self.assertEqual(gone.reason, "cap reached")

    def test_log_start_balance_and_measured_rate(self):
        with tempfile.TemporaryDirectory() as td:
            log = Path(td) / "spend.jsonl"
            usage = "Current balance: 100.0 compute units\nUsage rate: 0.00/hr\n"
            out = io.StringIO()
            with unittest.mock.patch("sys.stdout", out):
                cb.main(["plan", "--log", str(log), "--dish", "a", "--cap", "25", "--usage-text", usage])
                cb.main(["done", "--log", str(log), "--dish", "a", "--before", "100",
                         "--usage-text", "Current balance: 97.0 compute units", "--elapsed-s", "3600", "--status", "ok"])
            self.assertEqual(cb.start_balance_from_log(log), 100.0)
            self.assertAlmostEqual(cb.measured_rate_from_log(log), 3.0)
            with unittest.mock.patch("sys.stdout", io.StringIO()) as o2:
                cb.main(["plan", "--log", str(log), "--dish", "b", "--cap", "25",
                         "--usage-text", "Current balance: 97.0 compute units\nUsage rate: 0.00/hr"])
            self.assertIn("PLAN_REMAINING=22.00", o2.getvalue())


class JobTests(unittest.TestCase):
    def test_pack_excludes_heldout_files(self):
        with tempfile.TemporaryDirectory() as td:
            ds = make_dataset(Path(td))
            info = cj.build_job_tar(ds, Path(td) / "job.tar.gz")
            with tarfile.open(info["tar"]) as tf:
                names = set(tf.getnames())
            self.assertIn("code/track2b_mesh.py", names)
            self.assertIn("dataset/transforms_val.json", names)
            for i in range(6):
                img = f"dataset/images/frame_{i:06d}.png"
                if i % 3 == 0:
                    self.assertNotIn(img, names)
                    self.assertNotIn(f"dataset/eval_masks/frame_{i:06d}.png", names)
                else:
                    self.assertIn(img, names)
            self.assertEqual(info["images"], 4)

    def test_pack_rejects_train_val_overlap(self):
        with tempfile.TemporaryDirectory() as td:
            ds = make_dataset(Path(td))
            val = json.loads((ds / "transforms_val.json").read_text())
            train = json.loads((ds / "transforms_train.json").read_text())
            train["frames"].append(val["frames"][0])
            (ds / "transforms_train.json").write_text(json.dumps(train))
            with self.assertRaises(RuntimeError):
                cj.build_job_tar(ds, Path(td) / "job.tar.gz")

    def test_unpack_rewrites_dataset_dir_and_keeps_private(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            tar = tdp / "result.tar.gz"
            write_result_tar(tar)
            info = cj.unpack_result(tar, tdp / "recon", tdp / "local_ds")
            meta = json.loads((tdp / "recon" / "track2b_recon_meta.json").read_text())
            self.assertEqual(meta["dataset_dir"], str(tdp / "local_ds"))
            self.assertEqual(meta["remote"]["dataset_dir_remote"], "/content/t2b/job/dataset")
            self.assertFalse(meta["publication_eligible"])
            self.assertEqual(info["voxel_divisions"], 768)
            self.assertTrue((tdp / "recon" / "dense_clean.glb").is_file())


def write_result_tar(path: Path) -> None:
    meta = {"dataset_dir": "/content/t2b/job/dataset", "publication_eligible": False,
            "tsdf_settings": {"voxel_divisions": 768}, "steps": 30000, "final_splats": 500000}
    with tarfile.open(path, "w:gz") as tf:
        for name, data in (("dense_clean.glb", b"glTF"), ("track2b_recon_meta.json", json.dumps(meta).encode()),
                           ("remote_recon.log", b"log")):
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))


STUB = textwrap.dedent("""\
    #!/usr/bin/env bash
    echo "$*" >> "$STUB_LOG"
    case "$1" in
      usage) printf 'Current balance: %s compute units\\nUsage rate: %s/hr\\nActive assignments: 0\\n' "$STUB_BALANCE" "$STUB_RATE" ;;
      exec)
        case "$*" in
          *colab_remote_launch.py*)
            if [[ "${STUB_LAUNCH_SLEEP:-0}" != "0" ]]; then sleep "$STUB_LAUNCH_SLEEP"; fi
            echo "LAUNCHED pid=42" ;;
          *colab_remote_poll.py*)
            case "$STUB_EXEC" in
              ok) echo "REMOTE| step 30000"; echo "STATUS=done" ;;
              fail) echo "REMOTE| boom"; echo "STATUS=failed" ;;
              hang) echo "STATUS=running" ;;
              lost) exit 1 ;;
            esac ;;
        esac ;;
      download) cp "$STUB_RESULT" "${@: -1}" ;;
      new) case " $* " in *" --gpu ${STUB_NO_CAPACITY:-none} "*) echo "Service Unavailable"; exit 1 ;; esac ;;
    esac
    exit 0
    """)


class ShellTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.ds = make_dataset(self.root)
        self.stub = self.root / "colab"
        self.stub.write_text(STUB)
        self.stub.chmod(0o755)
        self.log = self.root / "calls.log"
        self.result = self.root / "result.tar.gz"
        write_result_tar(self.result)
        self.out = self.root / "out"

    def tearDown(self):
        self.td.cleanup()

    def run_script(self, *extra, balance="184.49", rate="0.00", exec_mode="ok", env_extra=None):
        env = dict(os.environ, COLAB_NEW_BACKOFF_S="0", COLAB_POLL_S="0.1", COLAB_POLL_MAX_FAILURES="3", COLAB_BIN=str(self.stub), STUB_LOG=str(self.log), STUB_BALANCE=balance,
                   STUB_RATE=rate, STUB_EXEC=exec_mode, STUB_RESULT=str(self.result), REPO_PY=sys.executable)
        env.update(env_extra or {})
        return subprocess.run(["bash", str(FOOD3D / "colab_track2b.sh"), "co3d_pizza", str(self.ds), str(self.out), *extra],
                              env=env, capture_output=True, text=True, timeout=120)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_dry_run_never_provisions(self):
        r = self.run_script("--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("DRY RUN", r.stdout)
        self.assertEqual([c.split()[0] for c in self.calls()], ["usage"])

    def test_skip_when_budget_exhausted(self):
        self.out.mkdir()
        cb.append_log(self.out / "colab_spend.jsonl", {"event": "budget_start", "balance": 184.49, "cap": 25})
        r = self.run_script(balance="160.0")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertNotIn("new", [c.split()[0] for c in self.calls()])

    def test_success_downloads_unpacks_and_stops(self):
        r = self.run_script("--remote-only")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        verbs = [c.split()[0] for c in self.calls()]
        self.assertEqual(verbs.count("stop"), 1)
        self.assertLess(verbs.index("download"), verbs.index("stop"))
        self.assertTrue((self.out / "colab" / "co3d_pizza" / "recon" / "dense_clean.glb").is_file())
        events = [json.loads(l) for l in (self.out / "colab_spend.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["event"], "dish_done")
        self.assertEqual(events[-1]["status"], "ok")

    def test_live_low_rate_uses_floor_and_still_runs(self):
        r = self.run_script("--remote-only", rate="1.71")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("floor(reported)", r.stdout)

    def test_gpu_fallback_when_first_choice_has_no_capacity(self):
        r = self.run_script("--remote-only", "--gpu", "L4,T4", env_extra={"STUB_NO_CAPACITY": "L4", "COLAB_NEW_RETRIES": "2"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        news = [c for c in self.calls() if c.startswith("new")]
        self.assertEqual([c.split()[-1] for c in news], ["L4", "L4", "T4"])

    def test_no_capacity_anywhere_exits_without_running(self):
        r = self.run_script("--remote-only", "--gpu", "L4", env_extra={"STUB_NO_CAPACITY": "L4", "COLAB_NEW_RETRIES": "1"})
        self.assertEqual(r.returncode, 7, r.stdout + r.stderr)
        self.assertNotIn("exec", [c.split()[0] for c in self.calls()])

    def test_remote_failure_still_stops_runtime(self):
        r = self.run_script("--remote-only", exec_mode="fail")
        self.assertEqual(r.returncode, 5, r.stdout + r.stderr)
        verbs = [c.split()[0] for c in self.calls()]
        self.assertIn("stop", verbs)
        self.assertNotIn("download", verbs)
        last = json.loads((self.out / "colab_spend.jsonl").read_text().splitlines()[-1])
        self.assertEqual(last["status"], "remote_failed")

    def test_lost_connection_stops_runtime(self):
        r = self.run_script("--remote-only", exec_mode="lost")
        self.assertEqual(r.returncode, 5, r.stdout + r.stderr)
        self.assertIn("lost contact", r.stderr)
        self.assertIn("stop", [c.split()[0] for c in self.calls()])

    def test_timeout_stops_runtime(self):
        # max_seconds = 0.8*25/8*3600 - overhead; pick overhead so the limit is ~2 s.
        env = {"COLAB_OVERHEAD_S": str(0.8 * 25 / 8 * 3600 - 2), "COLAB_MIN_S": "1"}
        r = self.run_script("--remote-only", exec_mode="hang", env_extra=env)
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertIn("stop", [c.split()[0] for c in self.calls()])

    def test_launch_timeout_stops_runtime(self):
        colab_sh = (FOOD3D / "colab_track2b.sh").read_text(encoding="utf-8")
        self.assertIn("timeout ", colab_sh)
        r = self.run_script(
            "--remote-only",
            env_extra={"COLAB_LAUNCH_TIMEOUT_S": "1", "STUB_LAUNCH_SLEEP": "3"},
        )
        self.assertEqual(r.returncode, 5, r.stdout + r.stderr)
        self.assertIn("stop", [c.split()[0] for c in self.calls()])
        last = json.loads((self.out / "colab_spend.jsonl").read_text().splitlines()[-1])
        self.assertEqual(last["status"], "launch_failed")


if __name__ == "__main__":
    import unittest.mock  # noqa: F401
    unittest.main()
