"""Runs inside a Colab kernel (via `colab exec -f`): high-res 2DGS + TSDF for one dish.

Launched detached by colab_remote_launch.py and polled by colab_remote_poll.py, so a dropped
`colab exec` connection never interrupts the job. Writes /content/t2b/DONE or /content/t2b/FAILED.

Inputs (uploaded by colab_track2b.sh):
  /content/t2b_job.tar.gz   code/ (track2b_mesh.py + helpers) and dataset/ (train-only images)
Environment (colab exec --env):
  T2B_DISH, T2B_STEPS, T2B_MAX_SPLATS, T2B_REFINE_STOP_ITER, T2B_VOXEL_DIVISIONS ("auto" or int),
  T2B_TSDF_TRUNC_VOXELS, T2B_TSDF_CUBE_PADDING, T2B_DIAMETER_CM, T2B_RECON_FLAGS (space-separated)
Output:
  /content/t2b_result.tar.gz  containing dense_clean.glb, track2b_recon_meta.json, remote_recon.log
"""

import json
import os
import subprocess
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path("/content/t2b")
JOB = ROOT / "job"
OUT = ROOT / "out"
LOG = ROOT / "remote_recon.log"

# Legacy Open3D UniformTSDFVolume: dense voxels plus mesh-extraction maps, with headroom.
VOXEL_BYTES = 48  # 32 B dense voxel + marching-cubes maps; 1024^3 OOM-killed on a 53 GiB L4 VM (2026-11-26)
RAM_HEADROOM = 1.8


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def mem_total_bytes() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) * 1024
    return 0


def choose_voxel_divisions(requested: str, mem_bytes: int) -> int:
    if requested != "auto":
        return int(requested)
    for div in (1024, 896, 768, 640, 512):
        if div**3 * VOXEL_BYTES * RAM_HEADROOM <= mem_bytes:
            return div
    return 512


def run(cmd: list[str]) -> None:
    log("$ " + " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                            env={**os.environ, "PYTHONUNBUFFERED": "1"})
    assert proc.stdout is not None
    with LOG.open("a", encoding="utf-8") as fh:
        for line in proc.stdout:
            print(line, end="", flush=True)
            fh.write(line)
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"command failed ({rc}): {cmd[:3]}")


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    env = os.environ
    dish = env["T2B_DISH"]
    log(f"dish={dish} python={sys.version.split()[0]}")
    run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv"])

    if JOB.exists():
        subprocess.run(["rm", "-rf", str(JOB)], check=True)
    JOB.mkdir(parents=True)
    with tarfile.open("/content/t2b_job.tar.gz") as tf:
        tf.extractall(JOB)

    run([sys.executable, "-m", "pip", "install", "-q", "gsplat==1.5.3", "open3d", "trimesh", "ninja"])
    # Trigger gsplat's CUDA JIT build up front so the timing is visible in the log.
    run([sys.executable, "-c", "import gsplat, torch, open3d, trimesh, scipy; from gsplat.cuda._backend import _C; print(open3d.__version__, 'gsplat ok', torch.__version__, torch.version.cuda)"])

    mem = mem_total_bytes()
    voxel = choose_voxel_divisions(env.get("T2B_VOXEL_DIVISIONS", "auto"), mem)
    log(f"MemTotal={mem/2**30:.1f} GiB -> voxel_divisions={voxel}")

    out_dir = OUT / dish
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, str(JOB / "code" / "track2b_mesh.py"), "reconstruct",
        "--dish", dish,
        "--dataset-dir", str(JOB / "dataset"),
        "--out-dir", str(out_dir),
        "--steps", env.get("T2B_STEPS", "30000"),
        "--max-splats", env.get("T2B_MAX_SPLATS", "600000"),
        "--voxel-divisions", str(voxel),
        "--tsdf-trunc-voxels", env.get("T2B_TSDF_TRUNC_VOXELS", "5.0"),
        "--tsdf-cube-padding", env.get("T2B_TSDF_CUBE_PADDING", "1.15"),
        "--tsdf-depth-source", "expected",
        "--tsdf-alpha-thresh", "0.10",
    ]
    if env.get("T2B_REFINE_STOP_ITER"):
        cmd += ["--refine-stop-iter", env["T2B_REFINE_STOP_ITER"]]
    if env.get("T2B_DIAMETER_CM"):
        cmd += ["--diameter-cm", env["T2B_DIAMETER_CM"]]
    cmd += [f for f in env.get("T2B_RECON_FLAGS", "").split() if f]
    t0 = time.time()
    run(cmd)
    log(f"reconstruct finished in {time.time()-t0:.0f}s")

    meta_path = out_dir / "track2b_recon_meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["remote"] = {
        "host": "colab",
        "gpu": subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                              capture_output=True, text=True).stdout.strip(),
        "mem_total_gib": round(mem / 2**30, 1),
        "tsdf_impl": "open3d.pipelines.integration.UniformTSDFVolume (CPU, Colab VM)",
        "voxel_divisions_chosen": voxel,
    }
    meta["publication_eligible"] = False
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    with tarfile.open("/content/t2b_result.tar.gz", "w:gz") as tf:
        for name in ("dense_clean.glb", "track2b_recon_meta.json"):
            tf.add(out_dir / name, arcname=name)
        tf.add(LOG, arcname="remote_recon.log")
    log("RESULT_READY /content/t2b_result.tar.gz")


def entry() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for marker in ("DONE", "FAILED"):
        (ROOT / marker).unlink(missing_ok=True)
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 - surface every failure to the poller
        import traceback

        (ROOT / "FAILED").write_text(f"{exc!r}\n{traceback.format_exc()}", encoding="utf-8")
        raise
    (ROOT / "DONE").write_text("ok", encoding="utf-8")


if __name__ == "__main__":
    entry()
