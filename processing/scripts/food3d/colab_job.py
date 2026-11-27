#!/usr/bin/env python3
"""Package one Track 2B dataset for the Colab stage (train split only) and unpack its result.

Held-out images and masks are never packed: only frames listed in transforms_train.json,
their masks, points3d.ply and the two transforms files (transforms_val.json carries poses
only, so reconstruct can keep its train/val leakage check).
"""

from __future__ import annotations

import argparse
import json
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
def code_files(code_dir: Path) -> list[Path]:
    """Every food3d Python module (track2b_mesh.py imports siblings transitively)."""
    return sorted(p for p in code_dir.glob("*.py") if p.is_file())
RESULT_FILES = ("dense_clean.glb", "track2b_recon_meta.json")


def train_members(dataset_dir: Path) -> list[Path]:
    train = json.loads((dataset_dir / "transforms_train.json").read_text(encoding="utf-8"))
    val_path = dataset_dir / "transforms_val.json"
    val_files: set[str] = set()
    if val_path.is_file():
        for f in json.loads(val_path.read_text(encoding="utf-8"))["frames"]:
            for key in ("file_path", "eval_mask_path", "mask_path"):
                if f.get(key):
                    val_files.add(Path(f[key]).as_posix())
    rels: list[str] = ["transforms_train.json", train.get("ply_file_path", "points3d.ply")]
    if val_path.is_file():
        rels.append("transforms_val.json")
    for f in train["frames"]:
        for key in ("file_path", "eval_mask_path", "mask_path"):
            if f.get(key):
                rels.append(Path(f[key]).as_posix())
    leaked = sorted(set(rels) & val_files)
    if leaked:
        raise RuntimeError(f"held-out files referenced by the train split: {leaked[:5]}")
    out: list[Path] = []
    for rel in dict.fromkeys(rels):
        p = dataset_dir / rel
        if not p.is_file():
            raise FileNotFoundError(p)
        out.append(Path(rel))
    return out


def build_job_tar(dataset_dir: Path, out_tar: Path, code_dir: Path = HERE) -> dict:
    members = train_members(dataset_dir)
    out_tar.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out_tar, "w:gz") as tf:
        for src in code_files(code_dir):
            tf.add(src, arcname=f"code/{src.name}")
        for rel in members:
            tf.add(dataset_dir / rel, arcname=f"dataset/{rel.as_posix()}")
    return {
        "tar": str(out_tar),
        "bytes": out_tar.stat().st_size,
        "dataset_files": len(members),
        "images": sum(1 for m in members if m.parts[0] == "images"),
    }


def unpack_result(result_tar: Path, recon_dir: Path, local_dataset_dir: Path) -> dict:
    recon_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(result_tar) as tf:
        names = set(tf.getnames())
        for name in (*RESULT_FILES, "remote_recon.log"):
            if name not in names:
                if name in RESULT_FILES:
                    raise RuntimeError(f"result missing {name}")
                continue
            member = tf.getmember(name)
            if not member.isfile():
                raise RuntimeError(f"unexpected member type: {name}")
            data = tf.extractfile(member).read()  # type: ignore[union-attr]
            (recon_dir / name).write_bytes(data)
    meta_path = recon_dir / "track2b_recon_meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.setdefault("remote", {})["dataset_dir_remote"] = meta.get("dataset_dir")
    meta["dataset_dir"] = str(local_dataset_dir)
    meta["publication_eligible"] = False
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return {"recon_dir": str(recon_dir), "voxel_divisions": meta.get("tsdf_settings", {}).get("voxel_divisions"),
            "final_splats": meta.get("final_splats"), "steps": meta.get("steps")}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("pack")
    b.add_argument("--dataset-dir", type=Path, required=True)
    b.add_argument("--out-tar", type=Path, required=True)
    u = sub.add_parser("unpack")
    u.add_argument("--result-tar", type=Path, required=True)
    u.add_argument("--recon-dir", type=Path, required=True)
    u.add_argument("--dataset-dir", type=Path, required=True)
    args = ap.parse_args(argv)
    if args.cmd == "pack":
        print(json.dumps(build_job_tar(args.dataset_dir, args.out_tar)))
    else:
        print(json.dumps(unpack_result(args.result_tar, args.recon_dir, args.dataset_dir)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
