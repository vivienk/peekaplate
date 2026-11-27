"""Convert a phone orbit video of a dish into a Track 2B dataset without GT poses.

Pipeline:
1. Extract all frames via FFmpeg (reusing ``multiview_prep``), score sharpness
   by Laplacian variance, and pick ``target_frames`` (default 80) evenly spaced
   sharpest frames.
2. Freeze the deterministic held-out split (every ``eval_split_every``-th frame,
   default 8) BEFORE any mask QA or registration filtering.
3. Run batched local BiRefNet ONNX segmentation (reusing ``cutout_clean``) in
   a single reusable session without cropping, preserving full-frame pinhole
   geometry.
4. Estimate camera poses via ``pycolmap`` SIFT + exhaustive matching +
   incremental mapping, capping background keypoints so the foreground dish
   dominates while retaining bounded nearby background features to aid
   registration (with automatic fallback if registration ratio is low).
   Note: all frames (train + held-out) participate in pose registration because
   every evaluation frame needs a pose; held-out frames are strictly excluded
   from visual-hull initialization, 2DGS training, TSDF fusion, and texturing.
5. Write ``transforms_train.json``, ``transforms_val.json``, premultiplied-alpha
   resized ``images/``, ``eval_masks/``, train-only visual-hull ``points3d.ply``,
   and ``conversion_report.json`` reusing ``co3d_to_colmap`` writers.

Every generated dataset and report carries ``"publication_eligible": false``.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np
from PIL import Image
from scipy import ndimage

if __package__:
    from . import co3d_to_colmap, cutout_clean, input_qa, multiview_prep
else:
    _THIS_DIR = Path(__file__).resolve().parent
    if str(_THIS_DIR) not in sys.path:
        sys.path.insert(0, str(_THIS_DIR))
    import co3d_to_colmap
    import cutout_clean
    import input_qa
    import multiview_prep


PUBLICATION_ELIGIBLE = False
DEFAULT_TARGET_FRAMES = 80
DEFAULT_EVAL_SPLIT_EVERY = 8
DEFAULT_MAX_DIM = 1024


# ---------------------------------------------------------------------------
# Pure, offline-testable functions
# ---------------------------------------------------------------------------


def select_sharpest_bucket_indices(
    scores: Sequence[float],
    target_frames: int,
) -> list[int]:
    """Partition ``len(scores)`` indices into uniform buckets and pick sharpest per bucket."""
    n_total = len(scores)
    if n_total < 2:
        raise ValueError(f"Expected at least 2 candidate frames, got {n_total}")
    if int(target_frames) < 2:
        raise ValueError(f"target_frames must be at least 2, got {target_frames}")
    bucket_count = min(int(target_frames), n_total)
    buckets = np.array_split(np.arange(n_total, dtype=np.int64), bucket_count)
    selected: list[int] = []
    for bucket in buckets:
        if bucket.size == 0:
            continue
        best_idx = max((int(i) for i in bucket), key=lambda idx: float(scores[idx]))
        selected.append(best_idx)
    return selected


def freeze_eval_split_indices(
    num_candidates: int,
    eval_split_every: int = DEFAULT_EVAL_SPLIT_EVERY,
) -> set[int]:
    """Deterministically select held-out indices BEFORE any mask or pose QA."""
    if num_candidates < 2:
        raise ValueError(f"Expected at least 2 candidates, got {num_candidates}")
    if int(eval_split_every) < 0:
        raise ValueError(f"eval_split_every must be >= 0, got {eval_split_every}")
    if int(eval_split_every) == 0:
        return set()
    return set(range(0, int(num_candidates), int(eval_split_every)))


def filter_keypoints_with_mask(
    keypoints: np.ndarray,
    descriptors: np.ndarray,
    fg_mask: np.ndarray,
    *,
    dilate_px: int = 16,
    max_bg_fraction: float = 0.35,
    min_bg_keep: int = 200,
    max_bg_keep: int = 1200,
) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    """Keep all foreground keypoints and cap background keypoints so foreground dominates.

    Background keypoints closest to the foreground mask (and larger SIFT scale on ties)
    are prioritized so supporting table/rim features can still aid registration without
    allowing distant room clutter to dominate.
    """
    kp = np.asarray(keypoints, dtype=np.float32)
    desc = np.asarray(descriptors)
    mask = np.asarray(fg_mask, dtype=bool)
    if kp.ndim != 2 or kp.shape[1] < 2:
        raise ValueError(f"Expected 2D keypoints array (N, 2+), got {kp.shape}")
    if len(kp) != len(desc):
        raise ValueError(f"Keypoint/descriptor length mismatch: {len(kp)} vs {len(desc)}")
    if mask.ndim != 2:
        raise ValueError(f"Expected 2D fg_mask, got {mask.shape}")
    if not (0.0 <= float(max_bg_fraction) <= 1.0):
        raise ValueError(f"max_bg_fraction must be in [0, 1], got {max_bg_fraction}")

    n_total = len(kp)
    if n_total == 0:
        return kp, desc, {"raw_total": 0, "raw_fg": 0, "raw_bg": 0, "kept_fg": 0, "kept_bg": 0}

    h, w = mask.shape
    xs = np.clip(np.rint(kp[:, 0]).astype(np.int64), 0, w - 1)
    ys = np.clip(np.rint(kp[:, 1]).astype(np.int64), 0, h - 1)

    if np.any(mask):
        dist_to_fg = ndimage.distance_transform_edt(~mask)
        in_fg = dist_to_fg[ys, xs] <= float(max(0, int(dilate_px)))
    else:
        dist_to_fg = np.zeros((h, w), dtype=np.float64)
        in_fg = np.zeros(n_total, dtype=bool)

    fg_idx = np.flatnonzero(in_fg)
    bg_idx = np.flatnonzero(~in_fg)
    n_fg = int(len(fg_idx))
    n_bg = int(len(bg_idx))

    if max_bg_fraction >= 1.0:
        bg_cap = n_bg
    elif max_bg_fraction <= 0.0:
        bg_cap = 0
    elif n_fg == 0:
        bg_cap = min(n_bg, max(0, int(max_bg_keep)))
    else:
        ratio_cap = int(np.floor(n_fg * float(max_bg_fraction) / max(1e-6, 1.0 - float(max_bg_fraction))))
        bg_cap = min(max(ratio_cap, int(min_bg_keep)), int(max_bg_keep))

    if n_bg <= bg_cap:
        kept_bg = bg_idx
    elif bg_cap <= 0:
        kept_bg = np.empty(0, dtype=np.int64)
    else:
        bg_dists = dist_to_fg[ys[bg_idx], xs[bg_idx]]
        if kp.shape[1] >= 4:
            # SIFT keypoint columns [x, y, a11, a12, a21, a22]: prefer larger scale on distance ties
            scales = np.hypot(kp[bg_idx, 2], kp[bg_idx, 4])
        else:
            scales = np.zeros(n_bg, dtype=np.float32)
        order = np.lexsort((-scales, bg_dists))
        kept_bg = np.sort(bg_idx[order[:bg_cap]])

    kept_idx = np.sort(np.concatenate([fg_idx, kept_bg]))
    stats = {
        "raw_total": n_total,
        "raw_fg": n_fg,
        "raw_bg": n_bg,
        "kept_fg": n_fg,
        "kept_bg": int(len(kept_bg)),
    }
    return kp[kept_idx], desc[kept_idx], stats


def colmap_w2c_to_opencv_and_opengl(
    w2c: np.ndarray,
    intrinsics: dict[str, int | float],
    original_size: tuple[int, int] | None = None,
    output_size: tuple[int, int] | None = None,
) -> co3d_to_colmap.Camera:
    """Convert a COLMAP 3x4 or 4x4 OpenCV w2c pose and pixel intrinsics to OpenCV + OpenGL Camera."""
    arr = np.asarray(w2c, dtype=np.float64)
    if arr.shape == (3, 4):
        w2c_4 = np.eye(4, dtype=np.float64)
        w2c_4[:3, :4] = arr
    elif arr.shape == (4, 4):
        w2c_4 = arr.copy()
    else:
        raise ValueError(f"Expected 3x4 or 4x4 w2c matrix, got {arr.shape}")
    if not np.all(np.isfinite(w2c_4)):
        raise ValueError("Non-finite values in w2c pose")

    rot_cv = w2c_4[:3, :3]
    trans_cv = w2c_4[:3, 3]
    if np.linalg.norm(rot_cv.T @ rot_cv - np.eye(3)) > 1e-3 or abs(np.linalg.det(rot_cv) - 1.0) > 1e-3:
        raise ValueError("w2c rotation block is not a valid SO(3) matrix")

    orig_w = int(original_size[0]) if original_size is not None else int(intrinsics["w"])
    orig_h = int(original_size[1]) if original_size is not None else int(intrinsics["h"])
    out_w, out_h = output_size if output_size is not None else (orig_w, orig_h)
    if orig_w <= 0 or orig_h <= 0 or out_w <= 0 or out_h <= 0:
        raise ValueError("Camera dimensions must be positive")
    sx, sy = float(out_w) / float(orig_w), float(out_h) / float(orig_h)
    scaled_intrinsics: dict[str, int | float] = {
        "w": int(out_w),
        "h": int(out_h),
        "fl_x": float(intrinsics["fl_x"]) * sx,
        "fl_y": float(intrinsics["fl_y"]) * sy,
        "cx": float(intrinsics["cx"]) * sx,
        "cy": float(intrinsics["cy"]) * sy,
    }

    c2w_cv = np.eye(4, dtype=np.float64)
    c2w_cv[:3, :3] = rot_cv.T
    c2w_cv[:3, 3] = -rot_cv.T @ trans_cv
    flip_yz = np.diag([1.0, -1.0, -1.0, 1.0])
    c2w_opengl = c2w_cv @ flip_yz
    return co3d_to_colmap.Camera(scaled_intrinsics, rot_cv, trans_cv, c2w_opengl)


def opengl_c2w_to_colmap_w2c(transform_matrix: np.ndarray) -> np.ndarray:
    """Invert an OpenGL/Nerfstudio 4x4 c2w transform back into a 4x4 COLMAP/OpenCV w2c matrix."""
    c2w = np.asarray(transform_matrix, dtype=np.float64)
    if c2w.shape != (4, 4):
        raise ValueError(f"Expected 4x4 transform_matrix, got {c2w.shape}")
    flip_yz = np.diag([1.0, -1.0, -1.0, 1.0])
    c2w_cv = c2w @ flip_yz
    rot_cv = c2w_cv[:3, :3].T
    trans_cv = -rot_cv @ c2w_cv[:3, 3]
    w2c = np.eye(4, dtype=np.float64)
    w2c[:3, :3] = rot_cv
    w2c[:3, 3] = trans_cv
    return w2c


def resize_rgba_premultiplied(
    rgb_u8: np.ndarray,
    alpha_u8: np.ndarray,
    output_size: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray]:
    """Resize RGB+alpha using premultiplied bilinear filtering (matching co3d_to_colmap.py)."""
    rgb = np.asarray(rgb_u8, dtype=np.uint8)
    alpha = np.asarray(alpha_u8, dtype=np.uint8)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or alpha.ndim != 2 or rgb.shape[:2] != alpha.shape:
        raise ValueError(f"Shape mismatch: rgb={rgb.shape}, alpha={alpha.shape}")
    h_in, w_in = alpha.shape
    out_w, out_h = int(output_size[0]), int(output_size[1])
    if (w_in, h_in) == (out_w, out_h):
        rgb_out = rgb.copy()
        rgb_out[alpha == 0] = 0
        return np.dstack((rgb_out, alpha)), alpha.copy()

    alpha_f = alpha.astype(np.float32)
    premult = rgb.astype(np.float32) * (alpha_f[..., None] / 255.0)
    channels = [
        np.asarray(Image.fromarray(ch).resize((out_w, out_h), Image.Resampling.BILINEAR), dtype=np.float32)
        for ch in (*np.moveaxis(premult, -1, 0), alpha_f)
    ]
    alpha_r = channels[3]
    rgb_r = np.rint(
        np.clip(np.stack(channels[:3], axis=-1) * (255.0 / np.maximum(alpha_r[..., None], 1e-6)), 0.0, 255.0)
    ).astype(np.uint8)
    clean_alpha = np.rint(np.clip(alpha_r, 0.0, 255.0)).astype(np.uint8)
    rgb_r[clean_alpha == 0] = 0
    return np.dstack((rgb_r, clean_alpha)), clean_alpha


def compute_orbit_coverage(camera_centers: np.ndarray) -> dict[str, float]:
    """Compute 2D PCA-plane azimuth coverage and radius spread metrics around the orbit mean."""
    centers = np.asarray(camera_centers, dtype=np.float64)
    if centers.ndim != 2 or centers.shape[1] != 3:
        raise ValueError(f"Expected (N, 3) camera_centers, got {centers.shape}")
    if len(centers) < 2:
        return {
            "orbit_span_deg": 0.0,
            "max_azimuth_gap_deg": 360.0,
            "radius_ratio": 1.0,
            "radius_p95_p05_ratio": 1.0,
        }

    center = centers.mean(axis=0)
    rel = centers - center[None, :]
    radii = np.linalg.norm(rel, axis=1)
    if float(np.max(radii)) <= 1e-12:
        return {
            "orbit_span_deg": 0.0,
            "max_azimuth_gap_deg": 360.0,
            "radius_ratio": 1.0,
            "radius_p95_p05_ratio": 1.0,
        }

    _, _, vt = np.linalg.svd(rel, full_matrices=False)
    proj2d = rel @ vt[:2].T
    angles = np.degrees(np.arctan2(proj2d[:, 1], proj2d[:, 0])) % 360.0
    angles_sorted = np.sort(angles)
    gaps = np.diff(np.concatenate([angles_sorted, [angles_sorted[0] + 360.0]]))
    max_gap = float(np.max(gaps))
    orbit_span = max(0.0, 360.0 - max_gap)

    r_min = float(np.min(radii))
    r_max = float(np.max(radii))
    p05, p95 = np.percentile(radii, [5.0, 95.0])
    return {
        "orbit_span_deg": round(orbit_span, 3),
        "max_azimuth_gap_deg": round(max_gap, 3),
        "radius_ratio": round(r_max / max(r_min, 1e-9), 4),
        "radius_p95_p05_ratio": round(float(p95) / max(float(p05), 1e-9), 4),
    }


def rank_sfm_candidate_pass(
    candidate: Mapping[str, Any],
    *,
    total_frames: int | None = None,
) -> float:
    """Rank an SfM candidate pass/submodel, favoring high registration and smooth 360 orbits."""
    reg_frames = int(candidate.get("registered_frames", 0))
    if reg_frames < 2:
        return -1e9
    denom = int(
        total_frames
        if total_frames is not None
        else (candidate.get("total_frames") or candidate.get("total_input_frames") or reg_frames)
    )
    reg_ratio = min(1.0, max(0.0, reg_frames / max(1, denom)))

    orbit = candidate.get("orbit_coverage") or {}
    max_gap = float(orbit.get("max_azimuth_gap_deg", candidate.get("max_azimuth_gap_deg", 360.0)))
    radius_ratio = float(orbit.get("radius_ratio", candidate.get("radius_ratio", 999.0)))
    reproj_raw = candidate.get("mean_reprojection_error_px")
    reproj = float(reproj_raw) if reproj_raw is not None else 10.0

    gap_penalty = 0.1 * min(max_gap, 55.0) + 0.5 * max(0.0, max_gap - 55.0)
    # Cap radius penalty at 32.0 (>= 3.68x) so minor differences among already-eccentric trajectories
    # cannot outweigh losing most registered frames (e.g., 20/80 fragment beating 51/80 submodel).
    radius_penalty = min(32.0, 2.0 * max(0.0, min(radius_ratio, 2.2) - 1.0) + 20.0 * max(0.0, radius_ratio - 2.2))
    reproj_penalty = 1.0 * min(max(0.0, reproj), 10.0)
    return round(100.0 * reg_ratio - gap_penalty - radius_penalty - reproj_penalty, 6)


def _needs_sfm_fallback(
    candidate: Mapping[str, Any],
    target_min_reg: int,
    total_frames: int | None = None,
) -> bool:
    reg = int(candidate.get("registered_frames", 0))
    if total_frames is not None and int(total_frames) > 0 and reg >= int(total_frames):
        return False
    orbit = candidate.get("orbit_coverage") or {}
    return (
        reg < int(target_min_reg)
        or float(orbit.get("max_azimuth_gap_deg", 360.0)) > 55.0
        or float(orbit.get("radius_ratio", 999.0)) > 2.2
    )


def estimate_consensus_3d_center(
    train_cameras_and_masks: Sequence[tuple[co3d_to_colmap.Camera, np.ndarray]],
) -> np.ndarray:
    """Estimate the shared 3D foreground dish center strictly from registered train masks.

    Handles frames where BiRefNet emits a secondary larger object (e.g., table edge)
    by triangulating candidate ray-pair midpoints across all foreground components and
    selecting the 3D point supported by the most train views.
    """
    if not train_cameras_and_masks:
        raise ValueError("At least one train camera and mask is required")

    per_view_comps: list[tuple[co3d_to_colmap.Camera, np.ndarray, list[tuple[float, float, np.ndarray, np.ndarray]]]] = []
    for cam, raw_mask in train_cameras_and_masks:
        mask = np.asarray(raw_mask, dtype=bool)
        h, w = mask.shape
        min_area = max(64, int(0.005 * h * w))
        labeled, n_comp = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.int32))
        k = cam.intrinsics
        origin = cam.transform_matrix[:3, 3]
        comps: list[tuple[float, float, np.ndarray, np.ndarray]] = []
        for cid in range(1, n_comp + 1):
            ys, xs = np.nonzero(labeled == cid)
            if ys.size < min_area:
                continue
            u, v = float(xs.mean()), float(ys.mean())
            d_cam = np.array([(u - k["cx"]) / k["fl_x"], (v - k["cy"]) / k["fl_y"], 1.0], dtype=np.float64)
            d_world = cam.rotation.T @ (d_cam / np.linalg.norm(d_cam))
            comps.append((u, v, origin, d_world))
        if not comps and np.any(mask):
            ys, xs = np.nonzero(mask)
            u, v = float(xs.mean()), float(ys.mean())
            d_cam = np.array([(u - k["cx"]) / k["fl_x"], (v - k["cy"]) / k["fl_y"], 1.0], dtype=np.float64)
            d_world = cam.rotation.T @ (d_cam / np.linalg.norm(d_cam))
            comps.append((u, v, origin, d_world))
        if comps:
            per_view_comps.append((cam, mask, comps))

    if not per_view_comps:
        centers = np.stack([cam.transform_matrix[:3, 3] for cam, _ in train_cameras_and_masks], axis=0)
        return centers.mean(axis=0)

    # Sample up to 24 evenly spaced views to generate candidate 3D intersections
    sample_idx = np.linspace(0, len(per_view_comps) - 1, min(24, len(per_view_comps)), dtype=int)
    candidates_3d: list[np.ndarray] = []
    min_cos = float(np.cos(np.radians(12.0)))
    for ii in range(len(sample_idx)):
        _, _, comps_a = per_view_comps[int(sample_idx[ii])]
        for jj in range(ii + 1, len(sample_idx)):
            _, _, comps_b = per_view_comps[int(sample_idx[jj])]
            for _, _, o1, d1 in comps_a:
                for _, _, o2, d2 in comps_b:
                    dot = float(np.dot(d1, d2))
                    if abs(dot) >= min_cos:
                        continue
                    w0 = o1 - o2
                    denom = 1.0 - dot * dot
                    if denom <= 1e-8:
                        continue
                    b_val = float(np.dot(d1, w0))
                    c_val = float(np.dot(d2, w0))
                    s = (dot * c_val - b_val) / denom
                    t = (c_val - dot * b_val) / denom
                    if s <= 0.0 or t <= 0.0:
                        continue
                    p_mid = 0.5 * ((o1 + s * d1) + (o2 + t * d2))
                    candidates_3d.append(p_mid)

    if not candidates_3d:
        # Fallback: least-squares intersection of primary rays
        a_mat = np.zeros((3, 3), dtype=np.float64)
        b_vec = np.zeros(3, dtype=np.float64)
        eye3 = np.eye(3, dtype=np.float64)
        for _, _, comps in per_view_comps:
            _, _, o, d = comps[0]
            proj = eye3 - np.outer(d, d)
            a_mat += proj
            b_vec += proj @ o
        return np.linalg.lstsq(a_mat, b_vec, rcond=None)[0]

    # Subsample candidates if many to keep scoring O(1)
    if len(candidates_3d) > 300:
        keep_c = np.linspace(0, len(candidates_3d) - 1, 300, dtype=int)
        candidates_3d = [candidates_3d[i] for i in keep_c]

    best_score = (-1, -1e9)
    best_pt = candidates_3d[0]
    for pt in candidates_3d:
        pt_arr = pt[None, :]
        hits = 0
        dist_sum = 0.0
        for cam, mask, comps in per_view_comps:
            uv, depth = cam.project(pt_arr)
            if depth[0] <= 0.0:
                dist_sum += 200.0
                continue
            u_px, v_px = float(uv[0, 0]), float(uv[0, 1])
            h, w = mask.shape
            iu, iv = int(round(u_px)), int(round(v_px))
            if 0 <= iu < w and 0 <= iv < h and mask[iv, iu]:
                hits += 1
            min_c_dist = min(float(np.hypot(u_px - cu, v_px - cv)) for cu, cv, _, _ in comps)
            dist_sum += min(min_c_dist, 200.0)
        score = (hits, -dist_sum / len(per_view_comps))
        if score > best_score:
            best_score = score
            best_pt = pt

    # Refine center with least-squares ray intersection of the closest component per inlier view
    a_mat = np.zeros((3, 3), dtype=np.float64)
    b_vec = np.zeros(3, dtype=np.float64)
    eye3 = np.eye(3, dtype=np.float64)
    inlier_count = 0
    for cam, mask, comps in per_view_comps:
        uv, depth = cam.project(best_pt[None, :])
        if depth[0] <= 0.0:
            continue
        h, w = mask.shape
        diag = float(np.hypot(h, w))
        u_px, v_px = float(uv[0, 0]), float(uv[0, 1])
        closest = min(comps, key=lambda c: float(np.hypot(u_px - c[0], v_px - c[1])))
        if np.hypot(u_px - closest[0], v_px - closest[1]) <= 0.20 * diag:
            _, _, o, d = closest
            proj = eye3 - np.outer(d, d)
            a_mat += proj
            b_vec += proj @ o
            inlier_count += 1
    if inlier_count >= 2 and np.linalg.matrix_rank(a_mat) >= 2:
        return np.linalg.lstsq(a_mat, b_vec, rcond=None)[0]
    return best_pt


def write_dataset_outputs(
    out_dir: Path,
    train_views: list[co3d_to_colmap.View],
    eval_views: list[co3d_to_colmap.View],
    train_frames: list[dict[str, Any]],
    eval_frames: list[dict[str, Any]],
    report_meta: dict[str, Any],
    *,
    voxel_res: int = 48,
    max_points: int = 20000,
    eval_split_every: int = DEFAULT_EVAL_SPLIT_EVERY,
    min_train_hit_rate: float = 0.85,
) -> dict[str, Any]:
    """Write train-only visual-hull PLY, transforms_train/val.json, and conversion_report.json."""
    if len(train_views) < 2:
        raise RuntimeError(f"Only {len(train_views)} training views available; at least 2 are required")
    all_frames = [*train_frames, *eval_frames]
    if len({int(f["frame_number"]) for f in all_frames}) != len(all_frames):
        raise RuntimeError("Dataset contains duplicate frame numbers")
    train_stems = {Path(f["file_path"]).stem for f in train_frames}
    eval_stems = {Path(f["file_path"]).stem for f in eval_frames}
    if train_stems & eval_stems:
        raise RuntimeError(f"Train/eval leakage detected: {sorted(train_stems & eval_stems)[:5]}")

    out_dir = Path(out_dir)
    out_root = out_dir.resolve()
    for target_name in (
        "points3d.ply",
        "transforms.json",
        "transforms_train.json",
        "transforms_val.json",
        "conversion_report.json",
    ):
        target = out_dir / target_name
        if target.is_symlink() or not target.resolve().is_relative_to(out_root):
            raise RuntimeError(f"Refusing to write through symlink or outside output directory: {target}")

    # Visual hull carved strictly from train_views (never eval_views)
    sampled = [
        train_views[i] for i in np.linspace(0, len(train_views) - 1, min(32, len(train_views)), dtype=int)
    ]
    rng = np.random.default_rng(42)
    center, points, colors, threshold = co3d_to_colmap._carve_hull(sampled, voxel_res, max_points, rng)
    co3d_to_colmap._write_ply(out_dir / "points3d.ply", points, colors)

    checked = points[rng.choice(len(points), min(2000, len(points)), replace=False)]
    hit_rates: list[float] = []
    reprojection_errors: list[float] = []
    for view in train_views + eval_views:
        hits, _ = view.hits(checked)
        hit_rates.append(len(hits) / len(checked))
        projected, depth = view.camera.project(center[None, :])
        if depth[0] > 0:
            reprojection_errors.append(float(np.linalg.norm(projected[0] - view.centroid)))

    single_path = out_dir / "transforms.json"
    train_path = out_dir / "transforms_train.json"
    val_path = out_dir / "transforms_val.json"
    if eval_split_every > 0:
        single_path.unlink(missing_ok=True)
        transforms_files = (
            ("transforms_train.json", co3d_to_colmap._build_transforms_json(train_views, train_frames, include_ply=True)),
            ("transforms_val.json", co3d_to_colmap._build_transforms_json(eval_views, eval_frames, include_ply=False)),
        )
        transforms_mode = "train_val_split"
    else:
        train_path.unlink(missing_ok=True)
        val_path.unlink(missing_ok=True)
        transforms_files = (
            ("transforms.json", co3d_to_colmap._build_transforms_json(train_views, train_frames, include_ply=True)),
        )
        transforms_mode = "single"

    train_hit = float(np.mean(hit_rates[: len(train_views)]))
    report = {
        "publication_eligible": PUBLICATION_ELIGIBLE,
        "transforms_mode": transforms_mode,
        "eval_split_every": int(eval_split_every),
        "train_frames": len(train_views),
        "eval_frames": len(eval_views),
        "eval_frame_numbers": [int(f["frame_number"]) for f in eval_frames],
        "eval_frame_stems": [Path(f["file_path"]).stem for f in eval_frames],
        "sampled_views": len(sampled),
        "initial_point_count": len(points),
        "hull_threshold_used": threshold,
        "ellipsoid_fallback": threshold is None,
        "train_mean_mask_hit_rate": train_hit,
        "mean_mask_hit_rate": float(np.mean(hit_rates)),
        "median_centroid_reproj_px": float(np.median(reprojection_errors)) if reprojection_errors else None,
        "centroid_behind_camera_views": len(train_views) + len(eval_views) - len(reprojection_errors),
        **report_meta,
    }
    for name, data in (*transforms_files, ("conversion_report.json", report)):
        (out_dir / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    if train_hit < float(min_train_hit_rate):
        raise RuntimeError(f"Visual hull train_mean_mask_hit_rate {train_hit:.3f} is below {min_train_hit_rate:.2f}")
    return report


# ---------------------------------------------------------------------------
# Batched BiRefNet masking + pycolmap SfM
# ---------------------------------------------------------------------------


def _extract_submodel_summary(recons: Mapping[int, Any], image_names: Sequence[str]) -> list[dict[str, Any]]:
    order = {name: idx for idx, name in enumerate(image_names)}
    submodels: list[dict[str, Any]] = []
    for rid, sub_recon in sorted(recons.items()):
        reg_names = [img.name for img in sub_recon.images.values() if img.has_pose]
        if not reg_names:
            continue
        reg_names.sort(key=lambda name: (order.get(name, sys.maxsize), name))
        reproj = (
            round(float(sub_recon.compute_mean_reprojection_error()), 4)
            if sub_recon.num_points3D() > 0
            else None
        )
        submodels.append(
            {
                "id": int(rid),
                "registered_frames": int(sub_recon.num_reg_images()),
                "first_frame": reg_names[0],
                "last_frame": reg_names[-1],
                "mean_reprojection_error_px": reproj,
            }
        )
    return submodels


def _run_pycolmap_sfm(
    rgb_dir: Path,
    image_names: list[str],
    masks_by_name: dict[str, np.ndarray],
    sfm_dir: Path,
    *,
    camera_model: str = "PINHOLE",
    dilate_px: int = 16,
    max_bg_fraction: float = 0.35,
    min_bg_keep: int = 200,
    max_bg_keep: int = 1200,
    min_reg_ratio: float = 0.85,
    num_threads: int = 4,
) -> dict[str, Any]:
    """Extract SIFT features, apply mask-guided background cap, match, and run incremental mapping."""
    import pycolmap

    if sfm_dir.exists():
        shutil.rmtree(sfm_dir)
    sfm_dir.mkdir(parents=True, exist_ok=True)
    db_full_path = sfm_dir / "database_full.db"

    def _extract_db(target_db: Path, pass_cam_model: str, cam_mode: Any, label: str) -> float:
        reader_opts = pycolmap.ImageReaderOptions()
        reader_opts.camera_model = pass_cam_model

        ext_opts = pycolmap.FeatureExtractionOptions()
        ext_opts.num_threads = max(1, int(num_threads))
        ext_opts.use_gpu = False
        ext_opts.sift.max_num_features = 4096

        t_ext = time.time()
        print(
            f"[video2ds][sfm:{label}] Extracting SIFT ({pass_cam_model}, {cam_mode.name}, max_num_features=4096) "
            f"for {len(image_names)} frames...",
            flush=True,
        )
        pycolmap.extract_features(
            target_db,
            rgb_dir,
            image_names=image_names,
            camera_mode=cam_mode,
            reader_options=reader_opts,
            extraction_options=ext_opts,
            device=pycolmap.Device.cpu,
        )
        sec = round(time.time() - t_ext, 2)
        print(f"[video2ds][sfm:{label}] Feature extraction done in {sec}s", flush=True)
        return sec

    extract_seconds = _extract_db(db_full_path, camera_model, pycolmap.CameraMode.SINGLE, "shared")

    def _run_pass(
        pass_name: str,
        *,
        pass_camera_model: str,
        camera_mode: Any,
        bg_frac: float,
        bg_min: int,
        bg_max: int,
        matching_mode: str,
        shared_db_path: Path | None,
    ) -> dict[str, Any]:
        pass_dir = sfm_dir / pass_name
        pass_dir.mkdir(parents=True, exist_ok=True)
        db_path = pass_dir / "database.db"
        if shared_db_path is not None:
            shutil.copy2(shared_db_path, db_path)
            pass_extract_seconds = 0.0
        else:
            pass_extract_seconds = _extract_db(db_path, pass_camera_model, camera_mode, pass_name)

        # Filter keypoints & descriptors per image using foreground mask
        db = pycolmap.Database.open(db_path)
        agg_stats = {"raw_total": 0, "raw_fg": 0, "raw_bg": 0, "kept_fg": 0, "kept_bg": 0}
        filtered_data: list[tuple[int, np.ndarray, Any]] = []
        for img in db.read_all_images():
            kp = db.read_keypoints(img.image_id)
            desc = db.read_descriptors(img.image_id)
            if bg_frac < 1.0 and img.name in masks_by_name:
                kp_f, desc_arr, st = filter_keypoints_with_mask(
                    kp,
                    desc.data,
                    masks_by_name[img.name],
                    dilate_px=dilate_px,
                    max_bg_fraction=bg_frac,
                    min_bg_keep=bg_min,
                    max_bg_keep=bg_max,
                )
            else:
                kp_f, desc_arr = kp, desc.data
                st = {
                    "raw_total": len(kp),
                    "raw_fg": 0,
                    "raw_bg": len(kp),
                    "kept_fg": 0,
                    "kept_bg": len(kp),
                }
            for k, v in st.items():
                agg_stats[k] += v
            fd = pycolmap.FeatureDescriptors()
            fd.type = desc.type
            fd.data = np.ascontiguousarray(desc_arr)
            filtered_data.append((img.image_id, np.ascontiguousarray(kp_f, dtype=np.float32), fd))

        db.clear_descriptors()
        for iid, kp_f, fd in filtered_data:
            db.update_keypoints(iid, kp_f)
            db.write_descriptors(iid, fd)
        db.close()
        print(
            f"[video2ds][sfm:{pass_name}] Features kept: fg={agg_stats['kept_fg']}/{agg_stats['raw_fg']}, "
            f"bg={agg_stats['kept_bg']}/{agg_stats['raw_bg']}; matching ({matching_mode})...",
            flush=True,
        )

        match_opts = pycolmap.FeatureMatchingOptions()
        match_opts.num_threads = max(1, int(num_threads))
        match_opts.use_gpu = False
        match_opts.guided_matching = False

        t_match = time.time()
        if matching_mode == "exhaustive":
            exh_opts = pycolmap.ExhaustivePairingOptions()
            pycolmap.match_exhaustive(
                db_path,
                matching_options=match_opts,
                pairing_options=exh_opts,
                device=pycolmap.Device.cpu,
            )
        elif matching_mode == "sequential":
            overlap = 18
            seq_opts = pycolmap.SequentialPairingOptions()
            seq_opts.overlap = overlap
            seq_opts.loop_detection = False
            seq_opts.num_threads = max(1, int(num_threads))
            pycolmap.match_sequential(
                db_path,
                matching_options=match_opts,
                pairing_options=seq_opts,
                device=pycolmap.Device.cpu,
            )
            n_imgs = len(image_names)
            wrap = min(overlap, n_imgs // 2)
            wrap_pairs: list[str] = []
            for i in range(n_imgs - wrap, n_imgs):
                for j in range(0, wrap):
                    if (j + n_imgs - i) <= overlap and i != j:
                        wrap_pairs.append(f"{image_names[i]} {image_names[j]}")
            if wrap_pairs and len(wrap_pairs) < 500:
                pairs_path = pass_dir / "wrap_pairs.txt"
                pairs_path.write_text("\n".join(wrap_pairs) + "\n", encoding="utf-8")
                imp_opts = pycolmap.ImportedPairingOptions()
                imp_opts.match_list_path = pairs_path
                pycolmap.match_image_pairs(
                    db_path,
                    matching_options=match_opts,
                    pairing_options=imp_opts,
                    device=pycolmap.Device.cpu,
                )
        else:
            raise ValueError(f"Unsupported matching_mode: {matching_mode}")

        match_seconds = round(time.time() - t_match, 2)
        print(f"[video2ds][sfm:{pass_name}] Matching done in {match_seconds}s; mapping...", flush=True)

        sparse_dir = pass_dir / "sparse"
        sparse_dir.mkdir(parents=True, exist_ok=True)
        inc_opts = pycolmap.IncrementalPipelineOptions()
        inc_opts.num_threads = max(1, int(num_threads))
        inc_opts.extract_colors = False
        inc_opts.ba_use_gpu = False
        inc_opts.random_seed = 42

        t_map = time.time()
        recons = pycolmap.incremental_mapping(
            db_path,
            rgb_dir,
            sparse_dir,
            options=inc_opts,
        )
        map_seconds = round(time.time() - t_map, 2)
        submodels = _extract_submodel_summary(recons, image_names)

        if not submodels:
            empty_cov = compute_orbit_coverage(np.zeros((0, 3), dtype=np.float64))
            return {
                "pass": pass_name,
                "camera_model": pass_camera_model,
                "camera_mode": camera_mode.name,
                "matching_mode": matching_mode,
                "registered_frames": 0,
                "num_points3d": 0,
                "mean_reprojection_error_px": None,
                "orbit_coverage": empty_cov,
                "score": -1e9,
                "submodels": [],
                "reconstruction": None,
                "feature_stats": agg_stats,
                "extract_seconds": pass_extract_seconds,
                "match_seconds": match_seconds,
                "map_seconds": map_seconds,
                "total_pass_seconds": round(pass_extract_seconds + match_seconds + map_seconds, 2),
            }

        best_candidate: dict[str, Any] | None = None
        for sub in submodels:
            sub_recon = recons[sub["id"]]
            sub_centers = [
                np.asarray(im.projection_center(), dtype=np.float64)
                for im in sub_recon.images.values()
                if im.has_pose
            ]
            cov = (
                compute_orbit_coverage(np.stack(sub_centers, axis=0))
                if sub_centers
                else compute_orbit_coverage(np.zeros((0, 3), dtype=np.float64))
            )
            cand_entry = {
                "registered_frames": sub["registered_frames"],
                "mean_reprojection_error_px": sub["mean_reprojection_error_px"],
                "orbit_coverage": cov,
                "recon": sub_recon,
                "submodel_id": sub["id"],
            }
            cand_entry["score"] = rank_sfm_candidate_pass(cand_entry, total_frames=len(image_names))
            if best_candidate is None or cand_entry["score"] > best_candidate["score"]:
                best_candidate = cand_entry

        assert best_candidate is not None
        recon = best_candidate["recon"]
        print(
            f"[video2ds][sfm:{pass_name}] Mapped {best_candidate['registered_frames']}/{len(image_names)} frames "
            f"in {map_seconds}s (submodels={len(submodels)}, span={best_candidate['orbit_coverage']['orbit_span_deg']}deg, "
            f"max_gap={best_candidate['orbit_coverage']['max_azimuth_gap_deg']}deg, "
            f"radius_ratio={best_candidate['orbit_coverage']['radius_ratio']}, score={best_candidate['score']})",
            flush=True,
        )
        return {
            "pass": pass_name,
            "camera_model": pass_camera_model,
            "camera_mode": camera_mode.name,
            "matching_mode": matching_mode,
            "selected_submodel_id": best_candidate["submodel_id"],
            "registered_frames": int(recon.num_reg_images()),
            "num_points3d": int(recon.num_points3D()),
            "mean_reprojection_error_px": best_candidate["mean_reprojection_error_px"],
            "orbit_coverage": best_candidate["orbit_coverage"],
            "score": best_candidate["score"],
            "submodels": submodels,
            "reconstruction": recon,
            "feature_stats": agg_stats,
            "extract_seconds": pass_extract_seconds,
            "match_seconds": match_seconds,
            "map_seconds": map_seconds,
            "total_pass_seconds": round(pass_extract_seconds + match_seconds + map_seconds, 2),
        }

    passes_tried: list[dict[str, Any]] = []
    primary = _run_pass(
        "fg_guided",
        pass_camera_model=camera_model,
        camera_mode=pycolmap.CameraMode.SINGLE,
        bg_frac=max_bg_fraction,
        bg_min=min_bg_keep,
        bg_max=max_bg_keep,
        matching_mode="exhaustive",
        shared_db_path=db_full_path,
    )
    passes_tried.append({k: v for k, v in primary.items() if k != "reconstruction"})
    best = primary

    target_min_reg = int(np.ceil(min_reg_ratio * len(image_names)))
    if _needs_sfm_fallback(best, target_min_reg, total_frames=len(image_names)):
        relaxed = _run_pass(
            "relaxed_bg",
            pass_camera_model=camera_model,
            camera_mode=pycolmap.CameraMode.SINGLE,
            bg_frac=1.0 if max_bg_fraction >= 1.0 else max(max_bg_fraction, 0.75),
            bg_min=max(min_bg_keep, 500),
            bg_max=max(max_bg_keep, 4000),
            matching_mode="exhaustive",
            shared_db_path=db_full_path,
        )
        passes_tried.append({k: v for k, v in relaxed.items() if k != "reconstruction"})
        if rank_sfm_candidate_pass(relaxed, total_frames=len(image_names)) > rank_sfm_candidate_pass(
            best, total_frames=len(image_names)
        ):
            best = relaxed

    if _needs_sfm_fallback(best, target_min_reg, total_frames=len(image_names)):
        radial_seq = _run_pass(
            "simple_radial_per_image",
            pass_camera_model="SIMPLE_RADIAL",
            camera_mode=pycolmap.CameraMode.PER_IMAGE,
            bg_frac=1.0 if max_bg_fraction >= 1.0 else max(max_bg_fraction, 0.75),
            bg_min=max(min_bg_keep, 500),
            bg_max=max(max_bg_keep, 4000),
            matching_mode="sequential",
            shared_db_path=None,
        )
        passes_tried.append({k: v for k, v in radial_seq.items() if k != "reconstruction"})
        if rank_sfm_candidate_pass(radial_seq, total_frames=len(image_names)) > rank_sfm_candidate_pass(
            best, total_frames=len(image_names)
        ):
            best = radial_seq

    if best["reconstruction"] is None or best["registered_frames"] < 2:
        raise RuntimeError(f"pycolmap failed to register at least 2 frames ({passes_tried})")

    recon = best["reconstruction"]
    poses_by_name: dict[str, tuple[np.ndarray, dict[str, int | float]]] = {}
    cam_centers: list[np.ndarray] = []
    for image in recon.images.values():
        if not image.has_pose:
            continue
        cam = recon.cameras[image.camera_id]
        w2c = image.cam_from_world().matrix()
        intrinsics = {
            "w": int(cam.width),
            "h": int(cam.height),
            "fl_x": float(cam.focal_length_x),
            "fl_y": float(cam.focal_length_y),
            "cx": float(cam.principal_point_x),
            "cy": float(cam.principal_point_y),
        }
        poses_by_name[image.name] = (w2c, intrinsics)
        cam_centers.append(np.asarray(image.projection_center(), dtype=np.float64))

    centers_arr = np.stack(cam_centers, axis=0)
    orbit_center = centers_arr.mean(axis=0)
    orbit_radii = np.linalg.norm(centers_arr - orbit_center[None, :], axis=1)
    orbit_coverage = compute_orbit_coverage(centers_arr)
    pts3d = np.array([pt.xyz for pt in recon.points3D.values()], dtype=np.float64)
    if len(pts3d) > 0:
        p05, p95 = np.percentile(pts3d, [5, 95], axis=0)
        sparse_extent = float(np.linalg.norm(p95 - p05))
    else:
        sparse_extent = 0.0

    return {
        "poses_by_name": poses_by_name,
        "registered_frames": best["registered_frames"],
        "total_input_frames": len(image_names),
        "registration_rate": round(best["registered_frames"] / max(1, len(image_names)), 4),
        "mean_reprojection_error_px": best["mean_reprojection_error_px"],
        "num_colmap_points3d": best.get("num_points3d", 0),
        "selected_pass": best["pass"],
        "selected_camera_model": best["camera_model"],
        "orbit_coverage": orbit_coverage,
        "sfm_submodels": best["submodels"],
        "feature_stats": best["feature_stats"],
        "passes_tried": passes_tried,
        "extract_seconds": round(extract_seconds + sum(p.get("extract_seconds", 0.0) for p in passes_tried), 2),
        "match_seconds": best["match_seconds"],
        "map_seconds": best["map_seconds"],
        "scale_summary": {
            "scale_type": "arbitrary_sfm_units",
            "median_camera_orbit_radius": round(float(np.median(orbit_radii)), 5),
            "min_camera_orbit_radius": round(float(np.min(orbit_radii)), 5),
            "max_camera_orbit_radius": round(float(np.max(orbit_radii)), 5),
            "sparse_points_p05_p95_diag": round(sparse_extent, 5),
            "note": "COLMAP reconstruction scale is arbitrary (up to global similarity); downstream Track 2B scales uniformly to assumed dish diameter_cm.",
        },
    }


@contextlib.contextmanager
def _low_mem_onnx_session_options():
    """Disable ORT CPU arena/pattern preallocation so BiRefNet fits within bounded cgroup RAM."""
    try:
        import onnxruntime as ort
    except ImportError:
        yield
        return
    orig_session_options = ort.SessionOptions

    def _bounded_opts(*args: Any, **kwargs: Any) -> Any:
        opts = orig_session_options(*args, **kwargs)
        opts.enable_cpu_mem_arena = False
        opts.enable_mem_pattern = False
        return opts

    ort.SessionOptions = _bounded_opts
    try:
        yield
    finally:
        ort.SessionOptions = orig_session_options


def video_to_dataset(
    video_path: Path,
    out_dir: Path,
    *,
    target_frames: int = DEFAULT_TARGET_FRAMES,
    max_dim: int = DEFAULT_MAX_DIM,
    eval_split_every: int = DEFAULT_EVAL_SPLIT_EVERY,
    cutout_model: str = "birefnet-general-lite",
    keep_main_dish: bool = True,
    keep_side_dishes: bool = False,
    strip_shadows: bool = True,
    camera_model: str = "PINHOLE",
    dilate_px: int = 16,
    max_bg_fraction: float = 0.35,
    max_points: int = 20000,
    voxel_res: int = 48,
    intra_op_threads: int = 4,
    keep_sfm_work: bool = False,
) -> dict[str, Any]:
    """Convert an orbit video into a Track 2B dataset (images, eval_masks, transforms, points3d.ply)."""
    t_total = time.time()
    video_path = Path(video_path)
    if not video_path.is_file():
        raise FileNotFoundError(f"Video not found: {video_path}")
    if target_frames < 2:
        raise ValueError("target_frames must be at least 2")
    if eval_split_every < 0:
        raise ValueError("eval_split_every must be >= 0")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for subdir in ("images", "eval_masks"):
        (out_dir / subdir).mkdir(parents=True, exist_ok=True)

    with contextlib.ExitStack() as stack:
        # Keep temp directories inside out_dir (NOT /tmp RAM disk)
        raw_tmp = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="video_raw_", dir=out_dir)))
        work_tmp = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="video_work_", dir=out_dir)))

        t_ffmpeg = time.time()
        all_raw_frames = multiview_prep._extract_video_frames(video_path, raw_tmp)
        ffmpeg_seconds = round(time.time() - t_ffmpeg, 2)
        print(f"[video2ds] Extracted {len(all_raw_frames)} frames in {ffmpeg_seconds}s; scoring sharpness...", flush=True)

        scores = [multiview_prep._score_frame_sharpness(p) for p in all_raw_frames]
        selected_indices = select_sharpest_bucket_indices(scores, target_frames=target_frames)

        # Freeze held-out split indices BEFORE any pixel/mask/SfM QA
        eval_cand_set = freeze_eval_split_indices(len(selected_indices), eval_split_every=eval_split_every)

        # Determine unified work resolution from first selected frame
        with Image.open(all_raw_frames[selected_indices[0]]) as first_im:
            orig_size = first_im.size
        work_size = co3d_to_colmap._target_size(orig_size, max_dim)

        # Batch BiRefNet segmentation in a single ONNX session (avoid reloading 214 MB model per frame)
        t_seg = time.time()
        use_gpu_cutout = os.environ.get("CUDA_VISIBLE_DEVICES", None) != ""
        print(f"[video2ds] Segmenting {len(selected_indices)} frames at {work_size} with {cutout_model}...", flush=True)
        with _low_mem_onnx_session_options():
            session, input_name, target_out = cutout_clean.create_onnx_session(
                model_name=cutout_model,
                intra_op_threads=intra_op_threads,
                prefer_gpu=use_gpu_cutout,
            )

        rgb_sfm_dir = work_tmp / "rgb_sfm"
        rgb_sfm_dir.mkdir(parents=True, exist_ok=True)

        candidates: list[dict[str, Any]] = []
        masks_by_name: dict[str, np.ndarray] = {}
        for cand_idx, raw_idx in enumerate(selected_indices):
            src_frame = all_raw_frames[raw_idx]
            match = re.fullmatch(r"frame_(\d+)", src_frame.stem)
            frame_number = int(match[1]) if match else (raw_idx + 1)
            filename = f"frame_{frame_number:06d}.png"

            with Image.open(src_frame) as im:
                rgb_orig = im.convert("RGB")
                rgb_work = rgb_orig.resize(work_size, Image.Resampling.LANCZOS) if rgb_orig.size != work_size else rgb_orig
                try:
                    raw_alpha = cutout_clean.infer_raw_alpha_with_session(rgb_work, session, input_name, target_out)
                except Exception as exc:
                    if not use_gpu_cutout:
                        raise
                    print(f"[video2ds] GPU cutout inference failed ({exc}); falling back to CPU...", flush=True)
                    use_gpu_cutout = False
                    with _low_mem_onnx_session_options():
                        session, input_name, target_out = cutout_clean.create_onnx_session(
                            model_name=cutout_model,
                            intra_op_threads=intra_op_threads,
                            prefer_gpu=False,
                        )
                    raw_alpha = cutout_clean.infer_raw_alpha_with_session(rgb_work, session, input_name, target_out)

            # Save RGB frame for COLMAP SfM (full background present for optional bg features)
            rgb_work.save(rgb_sfm_dir / filename)
            raw_alpha_u8 = np.clip(np.rint(raw_alpha * 255.0), 0, 255).astype(np.uint8)
            masks_by_name[filename] = raw_alpha_u8 > 115

            candidates.append(
                {
                    "cand_idx": cand_idx,
                    "source_frame_index": frame_number,
                    "filename": filename,
                    "sharpness": round(float(scores[raw_idx]), 3),
                    "is_eval": cand_idx in eval_cand_set,
                    "raw_alpha_u8": raw_alpha_u8,
                }
            )
            if (cand_idx + 1) % 10 == 0 or (cand_idx + 1) == len(selected_indices):
                print(
                    f"[video2ds] Segmented {cand_idx + 1}/{len(selected_indices)} "
                    f"({time.time() - t_seg:.1f}s elapsed)",
                    flush=True,
                )
        seg_seconds = round(time.time() - t_seg, 2)
        del session  # Release ONNX model RAM before pycolmap SfM

        sfm_dir = (out_dir / "_sfm_work") if keep_sfm_work else (work_tmp / "sfm")
        image_names = [c["filename"] for c in candidates]
        sfm_result = _run_pycolmap_sfm(
            rgb_sfm_dir,
            image_names,
            masks_by_name,
            sfm_dir,
            camera_model=camera_model,
            dilate_px=dilate_px,
            max_bg_fraction=max_bg_fraction,
            num_threads=intra_op_threads,
        )

        poses_by_name = sfm_result["poses_by_name"]
        train_cameras_and_masks: list[tuple[co3d_to_colmap.Camera, np.ndarray]] = []
        for cand in candidates:
            fname = cand["filename"]
            if fname not in poses_by_name:
                continue
            w2c, intrinsics = poses_by_name[fname]
            cam = colmap_w2c_to_opencv_and_opengl(w2c, intrinsics, original_size=work_size, output_size=work_size)
            cand["camera"] = cam
            if not cand["is_eval"]:
                train_cameras_and_masks.append((cam, cand["raw_alpha_u8"] > 115))

        if len(train_cameras_and_masks) < 2:
            raise RuntimeError(f"Only {len(train_cameras_and_masks)} registered training views; at least 2 required")
        consensus_center = estimate_consensus_3d_center(train_cameras_and_masks)

        # Build Views and frame dicts strictly respecting frozen eval split
        train_views: list[co3d_to_colmap.View] = []
        eval_views: list[co3d_to_colmap.View] = []
        train_frames: list[dict[str, Any]] = []
        eval_frames: list[dict[str, Any]] = []
        dropped_unregistered = 0
        dropped_empty_mask = 0

        for cand in candidates:
            fname = cand["filename"]
            if "camera" not in cand:
                dropped_unregistered += 1
                continue
            camera = cand["camera"]
            uv_c, depth_c = camera.project(consensus_center[None, :])
            target_xy = (float(uv_c[0, 0]), float(uv_c[0, 1])) if depth_c[0] > 0.0 else None

            with Image.open(rgb_sfm_dir / fname) as rgb_im:
                rgb_work_arr = np.asarray(rgb_im.convert("RGB"), dtype=np.uint8)
            raw_alpha_f = cand["raw_alpha_u8"].astype(np.float32) / 255.0
            rgba_u8, _seg_stats = cutout_clean.clean_inframe_rgba(
                rgb_work_arr,
                raw_alpha_f,
                keep_main_dish=keep_main_dish,
                keep_side_dishes=keep_side_dishes,
                strip_shadows=strip_shadows,
                target_xy=target_xy,
            )
            rgba_final, clean_alpha = resize_rgba_premultiplied(rgba_u8[..., :3], rgba_u8[..., 3], work_size)
            mask_bool = clean_alpha > 127
            y_idx, x_idx = np.nonzero(mask_bool)
            if x_idx.size < 100:
                dropped_empty_mask += 1
                continue

            rel_image = f"images/{fname}"
            rel_mask = f"eval_masks/{fname}"
            Image.fromarray(rgba_final, mode="RGBA").save(out_dir / rel_image)
            Image.fromarray(clean_alpha, mode="L").save(out_dir / rel_mask)

            view = co3d_to_colmap.View(
                camera=camera,
                mask=mask_bool,
                centroid=np.array([float(x_idx.mean()), float(y_idx.mean())]),
                radius_px=float(np.sqrt(x_idx.size / np.pi)),
                image_path=out_dir / rel_image,
            )
            frame_dict = {
                "file_path": rel_image,
                "eval_mask_path": rel_mask,
                "frame_number": int(cand["source_frame_index"]),
                **camera.intrinsics,
                "transform_matrix": camera.transform_matrix.tolist(),
            }
            if cand["is_eval"]:
                eval_views.append(view)
                eval_frames.append(frame_dict)
            else:
                train_views.append(view)
                train_frames.append(frame_dict)

        report_meta = {
            "pipeline": "food3d-video-to-dataset",
            "source_video": str(video_path),
            "source_total_frames": len(all_raw_frames),
            "target_frames": int(target_frames),
            "selected_candidate_frames": len(candidates),
            "work_size": list(work_size),
            "cutout_model": cutout_model,
            "keep_main_dish": bool(keep_main_dish),
            "keep_side_dishes": bool(keep_side_dishes),
            "strip_shadows": bool(strip_shadows),
            "camera_model_colmap": sfm_result["selected_camera_model"],
            "requested_camera_model_colmap": camera_model,
            "registered_frames": sfm_result["registered_frames"],
            "registration_rate": sfm_result["registration_rate"],
            "dropped_unregistered_frames": dropped_unregistered,
            "dropped_empty_mask_frames": dropped_empty_mask,
            "mean_reprojection_error_px": sfm_result["mean_reprojection_error_px"],
            "num_colmap_points3d": sfm_result["num_colmap_points3d"],
            "orbit_coverage": sfm_result["orbit_coverage"],
            "sfm_selected_pass": sfm_result["selected_pass"],
            "sfm_submodels": sfm_result["sfm_submodels"],
            "sfm_feature_stats": sfm_result["feature_stats"],
            "sfm_passes_tried": sfm_result["passes_tried"],
            "scale_summary": sfm_result["scale_summary"],
            "poses_include_heldout_frames_for_registration": True,
            "heldout_excluded_from_hull_and_training": True,
            "timing_seconds": {
                "ffmpeg_extract": ffmpeg_seconds,
                "birefnet_batch": seg_seconds,
                "pycolmap_extract": sfm_result["extract_seconds"],
                "pycolmap_match": sfm_result["match_seconds"],
                "pycolmap_map": sfm_result["map_seconds"],
                "total": round(time.time() - t_total, 2),
            },
        }

        return write_dataset_outputs(
            out_dir,
            train_views,
            eval_views,
            train_frames,
            eval_frames,
            report_meta,
            voxel_res=voxel_res,
            max_points=max_points,
            eval_split_every=eval_split_every,
        )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video_path", type=Path, help="Input dish orbit video (.mp4/.mov/.webm)")
    parser.add_argument("out_dir", type=Path, help="Output dataset directory")
    parser.add_argument("--target-frames", type=int, default=DEFAULT_TARGET_FRAMES)
    parser.add_argument("--max-dim", type=int, default=DEFAULT_MAX_DIM)
    parser.add_argument("--eval-split-every", type=int, default=DEFAULT_EVAL_SPLIT_EVERY)
    parser.add_argument(
        "--cutout-model",
        choices=sorted(cutout_clean.MODEL_FILENAMES.keys()),
        default="birefnet-general-lite",
    )
    parser.add_argument(
        "--keep-main-dish",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--keep-side-dishes", action="store_true", default=False)
    parser.add_argument(
        "--strip-shadows",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--camera-model",
        choices=("PINHOLE", "SIMPLE_PINHOLE", "SIMPLE_RADIAL"),
        default="PINHOLE",
    )
    parser.add_argument("--dilate-px", type=int, default=16)
    parser.add_argument("--max-bg-fraction", type=float, default=0.35)
    parser.add_argument("--max-points", type=int, default=20000)
    parser.add_argument("--voxel-res", type=int, default=48)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--keep-sfm-work", action="store_true", default=False)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    try:
        report = video_to_dataset(
            args.video_path,
            args.out_dir,
            target_frames=args.target_frames,
            max_dim=args.max_dim,
            eval_split_every=args.eval_split_every,
            cutout_model=args.cutout_model,
            keep_main_dish=args.keep_main_dish,
            keep_side_dishes=args.keep_side_dishes,
            strip_shadows=args.strip_shadows,
            camera_model=args.camera_model,
            dilate_px=args.dilate_px,
            max_bg_fraction=args.max_bg_fraction,
            max_points=args.max_points,
            voxel_res=args.voxel_res,
            intra_op_threads=args.threads,
            keep_sfm_work=args.keep_sfm_work,
        )
    except (RuntimeError, ValueError, FileNotFoundError, OSError) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
