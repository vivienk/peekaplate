"""Food3D V1 Stage 1: Multi-view image directory / video preparation.

Accepts either a directory of 2..N dish images or a turntable/orbit video
(extracting frames via ``/usr/bin/ffmpeg``), selects the sharpest frame in each
uniform time bucket using Laplacian variance, optionally runs Stage 0 QA and
Stage 1 clean cutout extraction, and writes ``multiview_manifest.json``.

Every emitted manifest carries ``"publication_eligible": false``.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    from food3d import PUBLICATION_ELIGIBLE, VALID_TRIAGE_STATES
    from food3d import input_qa
except ImportError:
    try:
        from . import PUBLICATION_ELIGIBLE, VALID_TRIAGE_STATES
        from . import input_qa
    except ImportError:
        _THIS_DIR = Path(__file__).resolve().parent
        if str(_THIS_DIR) not in sys.path:
            sys.path.insert(0, str(_THIS_DIR))
        import input_qa  # type: ignore[no-redef]

        PUBLICATION_ELIGIBLE = False
        VALID_TRIAGE_STATES = (
            "ready_single_photo",
            "needs_clean_cutout",
            "needs_reshoot_clipped",
            "needs_multiview_or_reshoot",
        )

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}
FFMPEG_BIN = "/usr/bin/ffmpeg"
CUTOUT_SCRIPT = Path(__file__).resolve().parent / "cutout_clean.py"
CUTOUT_MEMORY_MAX = "4G"
_systemd_run_probe: bool | None = None


def _systemd_run_available() -> bool:
    """Return True when ``systemd-run --user --scope`` really works on this host."""
    global _systemd_run_probe
    if _systemd_run_probe is None:
        if shutil.which("systemd-run") is None or not os.environ.get("XDG_RUNTIME_DIR"):
            _systemd_run_probe = False
        else:
            try:
                probe = subprocess.run(
                    ["systemd-run", "--user", "--scope", "-q", sys.executable, "-c", "pass"],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=20,
                )
                _systemd_run_probe = probe.returncode == 0
            except (OSError, subprocess.SubprocessError):
                _systemd_run_probe = False
    return bool(_systemd_run_probe)


def _cutout_env() -> dict[str, str]:
    env = dict(os.environ)
    scripts_root = str(Path(__file__).resolve().parents[1])
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{scripts_root}{os.pathsep}{existing}" if existing else scripts_root
    return env


def _run_cutout_isolated(
    view_path: Path,
    cutout_path: Path,
    report_path: Path,
    model_name: str,
) -> None:
    """Run cutout_clean.py in a child process, memory-capped via systemd-run when possible.

    Stage-1 ONNX inference must stay out of this (long-lived) parent process, so the
    clean cutout is produced by ``cutout_clean.py`` as a script rather than through
    ``cutout_clean.clean_cutout_file``. When ``systemd-run --user --scope`` is usable the
    child gets ``MemoryMax=4G``; otherwise the plain interpreter subprocess is used.
    """
    argv = [
        sys.executable,
        str(CUTOUT_SCRIPT),
        str(view_path),
        str(cutout_path),
        "--model",
        model_name,
        "--report",
        str(report_path),
    ]
    if _systemd_run_available():
        cmd = [
            "systemd-run",
            "--user",
            "--scope",
            "-q",
            "-p",
            f"MemoryMax={CUTOUT_MEMORY_MAX}",
            *argv,
        ]
    else:
        cmd = argv
    subprocess.run(
        cmd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_cutout_env(),
    )


def _extract_video_frames(video_path: Path, raw_frames_dir: Path) -> list[Path]:
    """Extract all frames from a video file using /usr/bin/ffmpeg."""
    raw_frames_dir.mkdir(parents=True, exist_ok=True)
    out_pattern = raw_frames_dir / "frame_%05d.png"
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-fps_mode",
        "passthrough",
        str(out_pattern),
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode and re.search(r"Unrecognized option\s+['\"]?-?fps_mode\b", stderr):
        legacy_cmd = [*cmd[:-3], "-vsync", "0", cmd[-1]]
        result = subprocess.run(legacy_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(f"FFmpeg frame extraction failed (exit {result.returncode}): {stderr[-600:]}")
    frames = sorted(raw_frames_dir.glob("frame_*.png"))
    if len(frames) < 2:
        raise RuntimeError(f"Expected at least 2 extracted frames, found {len(frames)}: {video_path}")
    return frames


def _score_frame_sharpness(frame_path: Path) -> float:
    """Compute Laplacian variance sharpness score for an image file."""
    with Image.open(frame_path) as im:
        rgb = np.asarray(im.convert("RGB"), dtype=np.uint8)
    return input_qa.compute_laplacian_variance(rgb, None)


def select_sharpest_per_bucket(
    frame_paths: list[Path],
    target_frames: int,
) -> list[tuple[int, Path, float]]:
    """Partition frames into uniform buckets and pick the sharpest frame per bucket."""
    if not frame_paths:
        return []
    bucket_count = max(1, min(int(target_frames), len(frame_paths)))
    scores = [_score_frame_sharpness(p) for p in frame_paths]
    indices = np.arange(len(frame_paths))
    buckets = np.array_split(indices, bucket_count)

    selected: list[tuple[int, Path, float]] = []
    for bucket_idx, bucket_indices in enumerate(buckets):
        if bucket_indices.size == 0:
            continue
        best_i = max((int(i) for i in bucket_indices), key=lambda idx: scores[idx])
        selected.append((bucket_idx, frame_paths[best_i], scores[best_i]))
    return selected


def prepare_multiview(
    input_path: str | Path,
    out_dir: str | Path,
    *,
    target_frames: int = 24,
    diameter_cm: float | None = None,
    skip_cutout: bool = False,
    cutout_model: str = "birefnet-general-lite",
) -> dict[str, Any]:
    """Prepare selected multi-view frames, optional cutouts, QA, and manifest JSON."""
    if target_frames < 2:
        raise ValueError("target_frames must be at least 2")
    src = Path(input_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    views_dir = out / "views"
    views_dir.mkdir(parents=True, exist_ok=True)
    cutouts_dir = out / "cutouts"
    if not skip_cutout:
        cutouts_dir.mkdir(parents=True, exist_ok=True)

    copied_views: list[tuple[int, dict[str, str | int], Path, float]] = []
    with contextlib.ExitStack() as stack:
        if src.is_dir():
            source_type = "directory"
            candidate_frames = sorted(
                p for p in src.iterdir()
                if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
            )
            if len(candidate_frames) < 2:
                raise ValueError(
                    f"Multi-view directory must contain at least 2 images, found {len(candidate_frames)} in {src}"
                )
        elif src.is_file() and src.suffix.lower() in VIDEO_EXTENSIONS:
            source_type = "video"
            # Fresh private frame directory per run: stale frames from an earlier, shorter
            # extraction can never be re-selected, and temporary frames are cleaned up
            # immediately after copying the selected views into views_dir.
            raw_frames_tmp = Path(
                stack.enter_context(tempfile.TemporaryDirectory(prefix="food3d_frames_", dir=out))
            )
            candidate_frames = _extract_video_frames(src, raw_frames_tmp)
            if len(candidate_frames) < 2:
                raise RuntimeError(f"Expected at least 2 extracted frames, found {len(candidate_frames)}: {src}")
        else:
            raise ValueError(f"Unsupported input path (expected image dir or video file): {src}")

        selected = select_sharpest_per_bucket(candidate_frames, target_frames=target_frames)
        candidate_positions = {path: i for i, path in enumerate(candidate_frames, start=1)}
        for view_idx, (bucket_idx, frame_path, sharpness) in enumerate(selected):
            view_dst = views_dir / f"view_{view_idx:03d}{frame_path.suffix.lower()}"
            shutil.copy2(frame_path, view_dst)
            source_frame: dict[str, str | int] = {"source_frame": str(frame_path)}
            if source_type == "video":
                match = re.fullmatch(r"frame_(\d+)", frame_path.stem)
                frame_num = (int(match[1]) if match else 0) or candidate_positions[frame_path]
                source_frame = {"source_frame": f"{src}#frame={frame_num}", "source_frame_index": frame_num}
            copied_views.append((bucket_idx, source_frame, view_dst, sharpness))

    if len(copied_views) < 2:
        raise RuntimeError(f"Expected at least 2 selected views, found {len(copied_views)}")

    triage_counts: dict[str, int] = {state: 0 for state in VALID_TRIAGE_STATES}
    view_entries: list[dict[str, Any]] = []

    for view_idx, (bucket_idx, source_frame, view_dst, sharpness) in enumerate(copied_views):

        cutout_dst: Path | None = None
        if not skip_cutout:
            cutout_dst = cutouts_dir / f"view_{view_idx:03d}_rgba.png"
            cutout_report_dst = cutouts_dir / f"view_{view_idx:03d}_cutout_report.json"
            _run_cutout_isolated(view_dst, cutout_dst, cutout_report_dst, cutout_model)

        qa_report = input_qa.analyze_image(view_dst, cutout_dst)
        triage = qa_report["triage"]
        triage_counts[triage] = triage_counts.get(triage, 0) + 1

        view_entries.append(
            {
                "index": view_idx,
                "bucket_index": bucket_idx,
                **source_frame,
                "view_path": str(view_dst),
                "cutout_path": str(cutout_dst) if cutout_dst is not None else None,
                "sharpness_laplacian_var": round(float(sharpness), 3),
                "qa_triage": triage,
                "qa_issues": qa_report["issues"],
                "qa_metrics": qa_report["metrics"],
            }
        )

    manifest = {
        "publication_eligible": PUBLICATION_ELIGIBLE,
        "source_path": str(src),
        "source_type": source_type,
        "out_dir": str(out),
        "target_frames": int(target_frames),
        "total_candidate_frames": len(candidate_frames),
        "selected_count": len(view_entries),
        "diameter_cm": float(diameter_cm) if diameter_cm is not None else None,
        "skip_cutout": bool(skip_cutout),
        "counts_by_triage": triage_counts,
        "views": view_entries,
    }

    manifest_path = out / "multiview_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Food3D V1 Stage 1: Multi-view image directory or video frame prep.",
    )
    parser.add_argument(
        "input_dir_or_video",
        help="Directory of 2..N dish images or a video file (.mp4/.mov/.webm).",
    )
    parser.add_argument(
        "out_dir",
        help="Output directory for selected views, optional cutouts, and multiview_manifest.json.",
    )
    parser.add_argument(
        "--target-frames",
        type=int,
        default=24,
        help="Number of uniform time buckets / target frames to select (default: 24).",
    )
    parser.add_argument(
        "--diameter-cm",
        type=float,
        default=None,
        help="Optional physical plate diameter in cm for downstream metric scale.",
    )
    parser.add_argument(
        "--skip-cutout",
        action="store_true",
        default=False,
        help="Skip ONNX cutout generation and run QA directly on selected views.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    manifest = prepare_multiview(
        args.input_dir_or_video,
        args.out_dir,
        target_frames=args.target_frames,
        diameter_cm=args.diameter_cm,
        skip_cutout=args.skip_cutout,
    )
    print(
        json.dumps(
            {
                "publication_eligible": manifest["publication_eligible"],
                "manifest": str(Path(args.out_dir) / "multiview_manifest.json"),
                "selected_count": manifest["selected_count"],
                "counts_by_triage": manifest["counts_by_triage"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
