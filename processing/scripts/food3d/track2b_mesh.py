"""Track 2B: Local 2DGS -> TSDF mesh extraction, multi-view texture projection,
PBR baking/packing orchestration, and held-out evaluation for real CO3D dishes.

Pure math/geometry/masking functions run in any Python 3.10+ environment with
numpy/PIL/scipy. GPU 2DGS training and Open3D TSDF fusion require the isolated
venv at /home/yacine105/tools/track2b-venv.

Every generated asset and report carries publication_eligible: false (ADR 0004).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image, ImageDraw

if __package__:
    from .build_track2_report import STAMP, _diagnostic_tiles, _load_pair, _write_eval_sheet, compute_pair_metrics
    from .pbr_author import _linear_rgb_to_lab, dilate_uv_gutters, linear_to_srgb, srgb_to_linear
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_track2_report import STAMP, _diagnostic_tiles, _load_pair, _write_eval_sheet, compute_pair_metrics
    from pbr_author import _linear_rgb_to_lab, dilate_uv_gutters, linear_to_srgb, srgb_to_linear

# Plausible physical dish diameters (cm) since CO3D scale is arbitrary.
DEFAULT_DISH_DIAMETERS_CM: dict[str, float] = {
    "co3d_sandwich": 22.0,
    "co3d_pizza": 28.0,
    "co3d_hotdog": 20.0,
}


# ---------------------------------------------------------------------------
# Pure camera, coordinate-frame, TSDF masking, and mesh cleanup functions
# ---------------------------------------------------------------------------


def opengl_c2w_to_opencv_w2c(c2w: np.ndarray) -> np.ndarray:
    """Convert a 4x4 OpenGL/Nerfstudio c2w pose into a 4x4 OpenCV w2c matrix."""
    c2w_arr = np.asarray(c2w, dtype=np.float64)
    if c2w_arr.shape != (4, 4):
        raise ValueError(f"Expected 4x4 c2w matrix, got {c2w_arr.shape}")
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    return np.linalg.inv(c2w_arr @ flip)


def opencv_w2c_to_opengl_c2w(w2c: np.ndarray) -> np.ndarray:
    """Convert a 4x4 OpenCV w2c matrix back into a 4x4 OpenGL/Nerfstudio c2w pose."""
    w2c_arr = np.asarray(w2c, dtype=np.float64)
    if w2c_arr.shape != (4, 4):
        raise ValueError(f"Expected 4x4 w2c matrix, got {w2c_arr.shape}")
    flip = np.diag([1.0, -1.0, -1.0, 1.0])
    return np.linalg.inv(w2c_arr) @ flip


def build_opengl_projection_matrix(
    w: int,
    h: int,
    fl_x: float,
    fl_y: float,
    cx: float,
    cy: float,
    near: float = 0.005,
    far: float = 50.0,
) -> np.ndarray:
    """Build an exact 4x4 OpenGL projection matrix matching pinhole intrinsics."""
    if w <= 0 or h <= 0 or fl_x <= 0 or fl_y <= 0 or near <= 0 or far <= near:
        raise ValueError("Invalid pinhole intrinsics or clip planes")
    sx = (2.0 * float(fl_x)) / float(w)
    sy = (2.0 * float(fl_y)) / float(h)
    ox = 1.0 - (2.0 * float(cx)) / float(w)
    oy = (2.0 * float(cy)) / float(h) - 1.0
    a = -(float(far) + float(near)) / (float(far) - float(near))
    b = -(2.0 * float(far) * float(near)) / (float(far) - float(near))
    return np.array(
        [
            [sx, 0.0, ox, 0.0],
            [0.0, sy, oy, 0.0],
            [0.0, 0.0, a, b],
            [0.0, 0.0, -1.0, 0.0],
        ],
        dtype=np.float64,
    )


def project_points_opencv(
    points: np.ndarray,
    w2c: np.ndarray,
    intrinsics: dict[str, float | int],
) -> tuple[np.ndarray, np.ndarray]:
    """Project (N, 3) world points using an OpenCV w2c pose and pixel intrinsics."""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    w2c_arr = np.asarray(w2c, dtype=np.float64)
    cam = pts @ w2c_arr[:3, :3].T + w2c_arr[:3, 3]
    depth = cam[:, 2]
    safe_z = np.where(np.abs(depth) > 1e-12, depth, np.nan)
    u = float(intrinsics["fl_x"]) * (cam[:, 0] / safe_z) + float(intrinsics["cx"])
    v = float(intrinsics["fl_y"]) * (cam[:, 1] / safe_z) + float(intrinsics["cy"])
    return np.stack([u, v], axis=-1), depth


def _estimate_ray_intersection_center(train_c2ws: list[np.ndarray]) -> np.ndarray:
    """Estimate the shared look-at target from OpenGL c2w optical axes (-Z)."""
    a_mat = np.zeros((3, 3), dtype=np.float64)
    b_vec = np.zeros(3, dtype=np.float64)
    eye3 = np.eye(3, dtype=np.float64)
    for c2w in train_c2ws:
        arr = np.asarray(c2w, dtype=np.float64)
        pos = arr[:3, 3]
        fwd = -arr[:3, 2]
        nrm = float(np.linalg.norm(fwd))
        if nrm < 1e-8:
            continue
        d = fwd / nrm
        proj = eye3 - np.outer(d, d)
        a_mat += proj
        b_vec += proj @ pos
    if np.linalg.matrix_rank(a_mat) >= 2:
        target, *_ = np.linalg.lstsq(a_mat, b_vec, rcond=None)
        return target
    positions = np.stack([np.asarray(c2w, dtype=np.float64)[:3, 3] for c2w in train_c2ws], axis=0)
    return positions.mean(axis=0)


def estimate_orbit_up_axis(
    train_c2ws: list[np.ndarray],
    *,
    obj_center: np.ndarray | None = None,
    planarity_ratio: float = 0.35,
) -> np.ndarray:
    """Estimate world up axis from the train camera orbit plane, with +Y fallback.

    Uses the smallest right singular vector of centered camera positions when the
    trajectory is planar (s_min / s_mid < planarity_ratio), choosing its sign so the
    cameras sit above the object center. Falls back to mean OpenGL camera +Y when
    fewer than 3 cameras exist or the trajectory is non-planar.
    """
    if not train_c2ws:
        raise ValueError("At least one training camera is required to estimate up axis")

    ups = np.stack([np.asarray(c2w, dtype=np.float64)[:3, 1] for c2w in train_c2ws], axis=0)
    mean_up = ups.mean(axis=0)
    up_norm = float(np.linalg.norm(mean_up))

    if len(train_c2ws) >= 3:
        positions = np.stack([np.asarray(c2w, dtype=np.float64)[:3, 3] for c2w in train_c2ws], axis=0)
        pos_centered = positions - positions.mean(axis=0)
        _, singular_vals, vh = np.linalg.svd(pos_centered, full_matrices=False)
        if singular_vals[1] > 1e-8 and (singular_vals[2] / singular_vals[1]) < planarity_ratio:
            normal = vh[2]
            center = (
                np.asarray(obj_center, dtype=np.float64).reshape(3)
                if obj_center is not None
                else _estimate_ray_intersection_center(train_c2ws)
            )
            med_height = float(np.median((positions - center[None, :]) @ normal))
            if abs(med_height) > 1e-8:
                if med_height < 0.0:
                    normal = -normal
            elif up_norm >= 1e-8 and float(np.dot(normal, mean_up)) < 0.0:
                normal = -normal
            return normal / float(np.linalg.norm(normal))

    if up_norm < 1e-8:
        raise ValueError("Degenerate camera up vectors")
    return mean_up / up_norm


def rotation_align_axis_to_yup(up_axis: np.ndarray) -> np.ndarray:
    """Return a 3x3 proper rotation matrix R (det=+1) mapping up_axis to [0, 1, 0]."""
    src = np.asarray(up_axis, dtype=np.float64).reshape(3)
    norm = float(np.linalg.norm(src))
    if norm < 1e-8:
        raise ValueError("up_axis must be non-zero")
    src = src / norm
    dst = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    dot = float(np.clip(np.dot(src, dst), -1.0, 1.0))
    if dot > 1.0 - 1e-10:
        return np.eye(3, dtype=np.float64)
    if dot < -1.0 + 1e-10:
        # 180-degree rotation around X axis: (x, y, z) -> (x, -y, -z)
        return np.diag([1.0, -1.0, -1.0]).astype(np.float64)
    axis = np.cross(src, dst)
    s = float(np.linalg.norm(axis))
    k = np.array(
        [
            [0.0, -axis[2], axis[1]],
            [axis[2], 0.0, -axis[0]],
            [-axis[1], axis[0], 0.0],
        ],
        dtype=np.float64,
    )
    return np.eye(3, dtype=np.float64) + k + (k @ k) * ((1.0 - dot) / (s * s))


def compute_world_to_metric_transform(
    vertices: np.ndarray,
    up_axis: np.ndarray,
    diameter_cm: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Compute exact 4x4 similarity transform from CO3D world space to Y-up metric GLB space.

    Centers X/Z at 0, seats y_min at 0, and scales max(extent_x, extent_z) to diameter_cm.
    """
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    if len(verts) == 0:
        raise ValueError("Mesh has no vertices")
    if diameter_cm <= 0:
        raise ValueError("diameter_cm must be positive")
    rot = rotation_align_axis_to_yup(up_axis)
    rotated = verts @ rot.T
    lo = rotated.min(axis=0)
    hi = rotated.max(axis=0)
    cx = 0.5 * (lo[0] + hi[0])
    cz = 0.5 * (lo[2] + hi[2])
    y_min = lo[1]
    horiz = max(float(hi[0] - lo[0]), float(hi[2] - lo[2]), 1e-9)
    scale = (float(diameter_cm) / 100.0) / horiz
    translation = -scale * np.array([cx, y_min, cz], dtype=np.float64)

    mat = np.eye(4, dtype=np.float64)
    mat[:3, :3] = scale * rot
    mat[:3, 3] = translation

    transformed = (verts @ mat[:3, :3].T) + mat[:3, 3]
    t_lo = transformed.min(axis=0)
    t_hi = transformed.max(axis=0)
    meta = {
        "diameter_cm": float(diameter_cm),
        "calibrated": False,
        "scale_assumption": f"Assumed horizontal dish diameter {diameter_cm:.1f} cm (CO3D scale is arbitrary)",
        "scale_factor": float(scale),
        "up_axis_world": [float(x) for x in up_axis],
        "rotation_yup": rot.tolist(),
        "translation_m": translation.tolist(),
        "matrix_4x4": mat.tolist(),
        "dimensions_m": [round(float(x), 5) for x in (t_hi - t_lo)],
        "y_min_m": round(float(t_lo[1]), 6),
    }
    return mat, meta


def transform_opengl_c2w(c2w: np.ndarray, m_world_to_metric: np.ndarray) -> np.ndarray:
    """Transform an OpenGL c2w pose by a 4x4 similarity transform M = [[s*R, t], [0, 1]]."""
    c2w_arr = np.asarray(c2w, dtype=np.float64)
    m = np.asarray(m_world_to_metric, dtype=np.float64)
    scale = float(np.linalg.norm(m[:3, 0]))
    if scale <= 1e-12:
        raise ValueError("Degenerate similarity transform scale")
    rot = m[:3, :3] / scale
    trans = m[:3, 3]
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = rot @ c2w_arr[:3, :3]
    out[:3, 3] = scale * (rot @ c2w_arr[:3, 3]) + trans
    return out


def se3_delta_to_matrix(rotvec: np.ndarray, trans: np.ndarray) -> np.ndarray:
    """Convert a 3D axis-angle rotation vector (rad) and 3D translation to a 4x4 SE(3) matrix."""
    rv = np.asarray(rotvec, dtype=np.float64).reshape(3)
    tr = np.asarray(trans, dtype=np.float64).reshape(3)
    theta = float(np.linalg.norm(rv))
    theta2 = theta * theta
    if theta < 1e-6:
        a = 1.0 - theta2 / 6.0
        b = 0.5 - theta2 / 24.0
    else:
        a = math.sin(theta) / theta
        b = (1.0 - math.cos(theta)) / theta2
    wx, wy, wz = float(rv[0]), float(rv[1]), float(rv[2])
    k = np.array(
        [
            [0.0, -wz, wy],
            [wz, 0.0, -wx],
            [-wy, wx, 0.0],
        ],
        dtype=np.float64,
    )
    rot = np.eye(3, dtype=np.float64) + a * k + b * (k @ k)
    mat = np.eye(4, dtype=np.float64)
    mat[:3, :3] = rot
    mat[:3, 3] = tr
    return mat


def apply_se3_delta_w2c(w2c_raw: np.ndarray, rotvec: np.ndarray, trans: np.ndarray) -> np.ndarray:
    """Left-multiply an OpenCV 4x4 w2c pose by a camera-frame SE(3) correction."""
    w2c_arr = np.asarray(w2c_raw, dtype=np.float64)
    if w2c_arr.shape != (4, 4):
        raise ValueError(f"Expected 4x4 w2c matrix, got {w2c_arr.shape}")
    delta = se3_delta_to_matrix(rotvec, trans)
    return delta @ w2c_arr


def apply_pose_deltas_with_gauge(
    w2c_raws: np.ndarray,
    rotvecs: np.ndarray,
    trans: np.ndarray,
    *,
    anchor_index: int = 0,
) -> np.ndarray:
    """Apply per-camera SE(3) deltas while keeping anchor_index strictly fixed (gauge removal)."""
    raws = np.asarray(w2c_raws, dtype=np.float64)
    rvs = np.asarray(rotvecs, dtype=np.float64)
    trs = np.asarray(trans, dtype=np.float64)
    n = len(raws)
    if n == 0:
        raise ValueError("At least one camera pose is required")
    if raws.shape != (n, 4, 4) or rvs.shape != (n, 3) or trs.shape != (n, 3):
        raise ValueError(f"Shape mismatch: w2c={raws.shape}, rotvecs={rvs.shape}, trans={trs.shape}")
    if not (0 <= anchor_index < n):
        raise ValueError(f"anchor_index {anchor_index} out of range [0, {n})")

    out = np.empty_like(raws)
    for idx in range(n):
        if idx == anchor_index:
            out[idx] = raws[idx].copy()
        else:
            out[idx] = apply_se3_delta_w2c(raws[idx], rvs[idx], trs[idx])
    return out


def select_anchor_camera_index(
    train_c2ws: list[np.ndarray],
    train_masks: list[np.ndarray],
    train_intrinsics: list[dict[str, Any]],
    obj_center: np.ndarray,
) -> int:
    """Pick the train camera whose mask centroid best agrees with obj_center projection."""
    if not train_c2ws:
        return 0
    center = np.asarray(obj_center, dtype=np.float64).reshape(1, 3)
    best_idx = 0
    best_err = float("inf")
    for idx, (c2w, mask, intr) in enumerate(zip(train_c2ws, train_masks, train_intrinsics)):
        mk = np.asarray(mask, dtype=bool)
        if not mk.any():
            continue
        w2c = opengl_c2w_to_opencv_w2c(c2w)
        uv, depth = project_points_opencv(center, w2c, intr)
        if not np.isfinite(depth[0]) or depth[0] <= 1e-4 or not np.all(np.isfinite(uv[0])):
            continue
        ys, xs = np.nonzero(mk)
        centroid = np.array([float(xs.mean()), float(ys.mean())], dtype=np.float64)
        err = float(np.linalg.norm(uv[0] - centroid))
        if err < best_err:
            best_err = err
            best_idx = idx
    return best_idx


def save_refined_train_poses(
    out_path: Path,
    *,
    dish: str,
    train_frames: list[dict[str, Any]],
    raw_c2ws: list[np.ndarray],
    refined_c2ws: list[np.ndarray],
    rotvecs: np.ndarray,
    trans_world: np.ndarray,
    scale_factor_to_m: float,
    anchor_index: int,
    warmup_steps: int,
    pose_reg_weight: float,
) -> tuple[Path, dict[str, Any]]:
    """Save refined train camera poses and correction magnitudes to JSON."""
    if not (
        len(train_frames) == len(raw_c2ws) == len(refined_c2ws) == len(rotvecs) == len(trans_world)
    ):
        raise ValueError("Mismatched lengths when saving refined train poses")
    if len(train_frames) == 0 or not (0 <= anchor_index < len(train_frames)):
        raise ValueError(f"Invalid anchor_index {anchor_index} for {len(train_frames)} frames")

    frames_out: list[dict[str, Any]] = []
    rot_degs: list[float] = []
    trans_mms: list[float] = []
    trans_worlds: list[float] = []
    for idx, frame in enumerate(train_frames):
        rv = np.zeros(3, dtype=np.float64) if idx == anchor_index else np.asarray(rotvecs[idx], dtype=np.float64)
        tr = np.zeros(3, dtype=np.float64) if idx == anchor_index else np.asarray(trans_world[idx], dtype=np.float64)
        rot_deg = float(np.degrees(np.linalg.norm(rv)))
        tr_w = float(np.linalg.norm(tr))
        tr_mm = tr_w * float(scale_factor_to_m) * 1000.0
        if idx != anchor_index:
            rot_degs.append(rot_deg)
            trans_worlds.append(tr_w)
            trans_mms.append(tr_mm)
        c2w_out = np.asarray(raw_c2ws[idx], dtype=np.float64) if idx == anchor_index else np.asarray(refined_c2ws[idx], dtype=np.float64)
        frames_out.append(
            {
                "frame_stem": Path(frame["file_path"]).stem,
                "file_path": frame["file_path"],
                "frame_number": int(frame["frame_number"]),
                "is_anchor": idx == anchor_index,
                "raw_transform_matrix": np.asarray(raw_c2ws[idx], dtype=np.float64).tolist(),
                "transform_matrix": c2w_out.tolist(),
                "delta_rotvec_rad": [float(x) for x in rv],
                "delta_trans_world": [float(x) for x in tr],
                "rot_deg": round(rot_deg, 5),
                "trans_world": round(tr_w, 6),
                "trans_mm": round(tr_mm, 4),
            }
        )

    summary = {
        "anchor_index": int(anchor_index),
        "anchor_frame_stem": Path(train_frames[anchor_index]["file_path"]).stem,
        "train_views_count": len(train_frames),
        "warmup_steps": int(warmup_steps),
        "pose_reg_weight": float(pose_reg_weight),
        "mean_rot_deg": round(float(np.mean(rot_degs)) if rot_degs else 0.0, 4),
        "median_rot_deg": round(float(np.median(rot_degs)) if rot_degs else 0.0, 4),
        "max_rot_deg": round(float(np.max(rot_degs)) if rot_degs else 0.0, 4),
        "mean_trans_world": round(float(np.mean(trans_worlds)) if trans_worlds else 0.0, 6),
        "mean_trans_mm": round(float(np.mean(trans_mms)) if trans_mms else 0.0, 4),
        "median_trans_mm": round(float(np.median(trans_mms)) if trans_mms else 0.0, 4),
        "max_trans_mm": round(float(np.max(trans_mms)) if trans_mms else 0.0, 4),
    }
    payload = {
        "schema_version": 1,
        "publication_eligible": False,
        "dish": dish,
        "pose_refine": True,
        "scale_factor_to_m": float(scale_factor_to_m),
        "summary": summary,
        "frames": frames_out,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return out_path, summary


def load_refined_train_poses(path: Path) -> dict[str, np.ndarray]:
    """Load refined train OpenGL c2w poses keyed by frame_stem from refined_train_poses.json."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1:
        raise ValueError(f"Unsupported refined_train_poses schema_version in {path}")
    frames = payload.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError(f"Missing or empty frames in {path}")
    poses: dict[str, np.ndarray] = {}
    for entry in frames:
        stem = entry.get("frame_stem") or Path(entry["file_path"]).stem
        mat = np.asarray(entry["transform_matrix"], dtype=np.float64)
        if mat.shape != (4, 4):
            raise ValueError(f"Expected 4x4 transform_matrix for {stem} in {path}, got {mat.shape}")
        poses[str(stem)] = mat
    return poses


def measure_texture_sharpness(
    tex_path: Path,
    uv_mask_path: Path,
    *,
    erosion_iters: int = 2,
) -> dict[str, Any]:
    """Measure texture sharpness (Sobel gradient magnitude & Laplacian variance) inside UV mask."""
    from scipy import ndimage

    with Image.open(tex_path) as im:
        rgb = np.asarray(im.convert("RGB"), dtype=np.float64) / 255.0
    with Image.open(uv_mask_path) as mk:
        if mk.size != (rgb.shape[1], rgb.shape[0]):
            mk = mk.resize((rgb.shape[1], rgb.shape[0]), Image.Resampling.NEAREST)
        uv_mask = np.asarray(mk.convert("L")) > 127

    if not uv_mask.any():
        raise ValueError(f"UV mask has zero valid texels: {uv_mask_path}")

    interior = ndimage.binary_erosion(uv_mask, iterations=max(0, int(erosion_iters)))
    eval_mask = interior if interior.any() else uv_mask

    lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    gx = ndimage.sobel(lum, axis=1) / 8.0
    gy = ndimage.sobel(lum, axis=0) / 8.0
    grad_mag = np.hypot(gx, gy)
    lap = ndimage.laplace(lum)

    return {
        "publication_eligible": False,
        "texture_path": str(tex_path),
        "uv_mask_path": str(uv_mask_path),
        "resolution": [int(rgb.shape[1]), int(rgb.shape[0])],
        "uv_valid_px": int(uv_mask.sum()),
        "uv_interior_px": int(eval_mask.sum()),
        "erosion_iters": int(erosion_iters),
        "mean_grad_mag": round(float(grad_mag[eval_mask].mean()), 6),
        "p95_grad_mag": round(float(np.percentile(grad_mag[eval_mask], 95)), 6),
        "laplacian_var": round(float(lap[eval_mask].var()), 8),
    }


def compose_blender_seating_transform(seating: dict[str, Any]) -> np.ndarray:
    """Convert blender_bake.py Z-up seating transform into glTF Y-up 4x4 similarity matrix."""
    scale = float(seating.get("scale_factor", 1.0))
    cx_b, cy_b = seating.get("center_xy_before", [0.0, 0.0])
    z_min_b = float(seating.get("z_min_before", 0.0))
    mat = np.eye(4, dtype=np.float64)
    mat[:3, :3] = np.eye(3, dtype=np.float64) * scale
    mat[:3, 3] = np.array([-scale * float(cx_b), -scale * z_min_b, scale * float(cy_b)], dtype=np.float64)
    return mat


def prepare_masked_tsdf_depth(
    depth: np.ndarray,
    alpha: np.ndarray,
    fg_mask: np.ndarray,
    near: float,
    far: float,
    alpha_thresh: float = 0.5,
) -> np.ndarray:
    """Restrict depth to foreground mask, sufficient opacity, and [near, far] range.

    Pixels outside the valid region are set to 0.0 so Open3D TSDF ignores them.
    """
    d = np.asarray(depth, dtype=np.float32)
    a = np.asarray(alpha, dtype=np.float32)
    m = np.asarray(fg_mask, dtype=bool)
    if d.shape != a.shape or d.shape != m.shape:
        raise ValueError(f"Shape mismatch: depth={d.shape}, alpha={a.shape}, mask={m.shape}")
    if near <= 0 or far <= near:
        raise ValueError(f"Invalid depth bounds near={near}, far={far}")
    valid = m & (a >= alpha_thresh) & np.isfinite(d) & (d >= near) & (d <= far)
    return np.where(valid, d, 0.0).astype(np.float32)


def filter_mesh_components(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    min_face_fraction: float = 0.02,
    table_height_ratio: float = 0.06,
    table_footprint_ratio: float = 0.75,
    keep_main_only: bool = True,
    up_axis_index: int = 1,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Clean a triangle mesh by dropping tiny floaters, bottom table slabs, and detached shells."""
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    tris = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(tris) == 0 or len(verts) == 0:
        raise ValueError("Cannot filter empty mesh")

    n_verts = len(verts)
    parent = np.arange(n_verts, dtype=np.int64)

    def _find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a: int, b: int) -> None:
        ra, rb = _find(a), _find(b)
        if ra != rb:
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb

    for f in tris:
        v0, v1, v2 = int(f[0]), int(f[1]), int(f[2])
        _union(v0, v1)
        _union(v1, v2)

    comp_map: dict[int, list[int]] = {}
    for fi, f in enumerate(tris):
        root = _find(int(f[0]))
        comp_map.setdefault(root, []).append(fi)

    components = sorted(comp_map.values(), key=len, reverse=True)
    total_faces = len(tris)
    horiz_axes = [ax for ax in (0, 1, 2) if ax != up_axis_index]
    g_lo = verts.min(axis=0)
    g_hi = verts.max(axis=0)
    g_ext = np.maximum(g_hi - g_lo, 1e-9)

    kept_face_indices: list[int] = []
    dropped_tiny = 0
    dropped_table = 0
    dropped_detached = 0
    kept_components = 0

    for comp in components:
        comp_tris = tris[comp]
        comp_verts = verts[np.unique(comp_tris)]
        c_lo = comp_verts.min(axis=0)
        c_hi = comp_verts.max(axis=0)
        c_ext = c_hi - c_lo
        horiz = max(float(c_ext[horiz_axes[0]]), float(c_ext[horiz_axes[1]]), 1e-9)
        h_over_w = float(c_ext[up_axis_index]) / horiz
        frac = len(comp) / total_faces

        spans_footprint = (
            float(c_ext[horiz_axes[0]]) >= table_footprint_ratio * float(g_ext[horiz_axes[0]])
            and float(c_ext[horiz_axes[1]]) >= table_footprint_ratio * float(g_ext[horiz_axes[1]])
            and (float(c_lo[up_axis_index]) - float(g_lo[up_axis_index])) < 0.15 * float(g_ext[up_axis_index])
        )
        is_table = spans_footprint and h_over_w < table_height_ratio
        is_tiny = frac < min_face_fraction

        if is_table:
            dropped_table += 1
        elif is_tiny:
            dropped_tiny += 1
        elif keep_main_only and kept_components >= 1:
            dropped_detached += 1
        else:
            kept_components += 1
            kept_face_indices.extend(comp)

    if not kept_face_indices:
        # Fallback: keep largest component if heuristics dropped everything
        kept_face_indices = list(components[0])
        kept_components = 1

    sel_tris = tris[kept_face_indices]
    used_verts, inverse = np.unique(sel_tris, return_inverse=True)
    out_verts = verts[used_verts]
    out_faces = inverse.reshape(-1, 3).astype(np.int64)
    stats = {
        "faces_before": int(total_faces),
        "faces_after": int(len(out_faces)),
        "vertices_before": int(n_verts),
        "vertices_after": int(len(out_verts)),
        "total_components": len(components),
        "kept_components": kept_components,
        "dropped_tiny": dropped_tiny,
        "dropped_table": dropped_table,
        "dropped_detached": dropped_detached,
        "kept_vertex_indices": used_verts,
    }
    return out_verts, out_faces, stats


def stamp_glb_asset_extras(glb_path: Path, extras: dict[str, Any]) -> None:
    """Update asset.extras inside a binary glTF (.glb) file in-place."""
    raw = glb_path.read_bytes()
    if len(raw) < 20:
        raise ValueError(f"GLB file too short ({len(raw)} bytes): {glb_path}")
    magic, version, total_len = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError(f"Invalid GLB header in {glb_path}")

    offset = 12
    gltf_json: dict[str, Any] | None = None
    bin_chunk = b""
    limit = min(len(raw), total_len)
    while offset + 8 <= limit:
        chunk_len, chunk_type = struct.unpack_from("<II", raw, offset)
        offset += 8
        chunk_data = raw[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:
            gltf_json = json.loads(chunk_data.decode("utf-8"))
        elif chunk_type == 0x004E4942:
            bin_chunk = chunk_data

    if gltf_json is None:
        raise ValueError(f"Missing JSON chunk in {glb_path}")

    asset = gltf_json.setdefault("asset", {})
    existing = asset.get("extras")
    if not isinstance(existing, dict):
        existing = {}
    existing.update(extras)
    asset["extras"] = existing

    json_bytes = json.dumps(gltf_json, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(json_bytes) % 4 != 0:
        json_bytes += b" " * (4 - (len(json_bytes) % 4))
    has_bin = len(bin_chunk) > 0
    if has_bin and len(bin_chunk) % 4 != 0:
        bin_chunk += b"\x00" * (4 - (len(bin_chunk) % 4))

    new_total = 12 + 8 + len(json_bytes) + (8 + len(bin_chunk) if has_bin else 0)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, new_total)
    out += struct.pack("<II", len(json_bytes), 0x4E4F534A)
    out += json_bytes
    if has_bin:
        out += struct.pack("<II", len(bin_chunk), 0x004E4942)
        out += bin_chunk
    glb_path.write_bytes(bytes(out))


def compute_dihedral_stats(vertices: np.ndarray, faces: np.ndarray) -> dict[str, float]:
    """Compute mean and p90 dihedral angles (degrees) across adjacent triangle faces."""
    import trimesh

    tm = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    angles_deg = np.degrees(tm.face_adjacency_angles)
    if len(angles_deg) == 0:
        return {"mean_deg": 0.0, "p90_deg": 0.0, "gt45_pct": 0.0}
    return {
        "mean_deg": round(float(angles_deg.mean()), 3),
        "p90_deg": round(float(np.percentile(angles_deg, 90)), 3),
        "gt45_pct": round(float((angles_deg > 45.0).mean() * 100.0), 2),
    }


def choose_adaptive_smooth_iterations(
    dihedral_before: dict[str, float],
    requested_iterations: int,
) -> int:
    """Choose smoothing iterations adaptively from pre-smooth dihedral statistics."""
    req = max(0, int(requested_iterations))
    if req == 0:
        return 0
    mean_deg = float(dihedral_before.get("mean_deg", 0.0))
    gt45_pct = float(dihedral_before.get("gt45_pct", 0.0))
    if mean_deg <= 4.5 and gt45_pct <= 0.5:
        return 0
    if mean_deg < 9.0:
        return min(req, 2)
    return req


def blend_crease_preserving_vertices(
    raw_verts: np.ndarray,
    smoothed_verts: np.ndarray,
    faces: np.ndarray,
    *,
    crease_start_deg: float = 28.0,
    crease_full_deg: float = 55.0,
    max_preserve: float = 0.85,
) -> np.ndarray:
    """Blend smoothed vertices back toward raw positions on high-dihedral crease edges."""
    import trimesh

    raw = np.asarray(raw_verts, dtype=np.float64)
    smooth = np.asarray(smoothed_verts, dtype=np.float64)
    tris = np.asarray(faces, dtype=np.int64)
    if raw.shape != smooth.shape or len(tris) == 0:
        return smooth.copy()

    tm = trimesh.Trimesh(vertices=raw, faces=tris, process=False)
    adj_edges = np.asarray(tm.face_adjacency_edges, dtype=np.int64)
    adj_angles = np.degrees(np.asarray(tm.face_adjacency_angles, dtype=np.float64))
    if len(adj_edges) == 0:
        return smooth.copy()

    v_max_deg = np.zeros(len(raw), dtype=np.float64)
    np.maximum.at(v_max_deg, adj_edges[:, 0], adj_angles)
    np.maximum.at(v_max_deg, adj_edges[:, 1], adj_angles)

    denom = max(float(crease_full_deg) - float(crease_start_deg), 1e-6)
    keep_weight = np.clip((v_max_deg - float(crease_start_deg)) / denom, 0.0, 1.0) * float(max_preserve)
    return (smooth * (1.0 - keep_weight[:, None]) + raw * keep_weight[:, None]).astype(np.float64)


def _compact_mesh(
    vertices: np.ndarray,
    faces: np.ndarray,
    vertex_colors: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Drop unreferenced vertices and remap face indices."""
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    tris = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(tris) == 0 or len(verts) == 0:
        raise ValueError("Cannot compact empty mesh")
    used, inv = np.unique(tris, return_inverse=True)
    out_verts = verts[used]
    out_faces = inv.reshape(-1, 3).astype(np.int64)
    out_cols = None
    if vertex_colors is not None:
        cols = np.asarray(vertex_colors, dtype=np.float64)
        if len(cols) == len(verts):
            out_cols = cols[used]
    return out_verts, out_faces, out_cols


def carve_mesh_by_train_masks(
    vertices: np.ndarray,
    faces: np.ndarray,
    view_masks: Sequence[np.ndarray],
    w2c_mats: Sequence[np.ndarray],
    intrinsics: Sequence[dict[str, Any]],
    *,
    mask_tol_px: float = 2.0,
    max_out_fraction: float = 0.38,
    min_seen_views: int = 8,
    vertex_colors: np.ndarray | None = None,
    keep_main_only: bool = True,
    min_face_fraction: float = 0.02,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, dict[str, Any]]:
    """Prune faces that protrude consistently outside train-view foreground masks."""
    from scipy import ndimage

    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    tris = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(verts) == 0 or len(tris) == 0 or len(view_masks) == 0:
        return verts, tris, vertex_colors, {"faces_before": len(tris), "faces_after": len(tris), "carved_faces": 0}
    if not (len(view_masks) == len(w2c_mats) == len(intrinsics)):
        raise ValueError("view_masks, w2c_mats, and intrinsics must have equal length")

    n_verts = len(verts)
    seen = np.zeros((n_verts,), dtype=np.int32)
    out_cnt = np.zeros((n_verts,), dtype=np.int32)

    for mask_raw, w2c, intr in zip(view_masks, w2c_mats, intrinsics):
        mask = np.asarray(mask_raw, dtype=bool)
        h_m, w_m = mask.shape
        tol_scale = max(1.0, float(max(h_m, w_m)) / 1024.0)
        tol_px_img = float(mask_tol_px) * tol_scale
        if tol_px_img > 0.0:
            r_int = int(math.ceil(tol_px_img))
            yy, xx = np.ogrid[-r_int : r_int + 1, -r_int : r_int + 1]
            disk = (yy * yy + xx * xx) <= (tol_px_img * tol_px_img + 1e-9)
            allowed_mask = ndimage.binary_dilation(mask, structure=disk)
        else:
            allowed_mask = mask
        uv, depth = project_points_opencv(verts, np.asarray(w2c, dtype=np.float64), intr)
        inb = (
            (depth > 1e-4)
            & (uv[:, 0] >= 0.0)
            & (uv[:, 0] < float(w_m))
            & (uv[:, 1] >= 0.0)
            & (uv[:, 1] < float(h_m))
        )
        idx = np.flatnonzero(inb)
        if len(idx) == 0:
            continue
        px = np.clip(np.rint(uv[idx, 0]).astype(np.int32), 0, w_m - 1)
        py = np.clip(np.rint(uv[idx, 1]).astype(np.int32), 0, h_m - 1)
        seen[idx] += 1
        out_cnt[idx] += (~allowed_mask[py, px]).astype(np.int32)

    out_frac = out_cnt.astype(np.float64) / np.maximum(seen, 1)
    bad_v = (seen >= int(min_seen_views)) & (out_frac >= float(max_out_fraction))
    keep_face = bad_v[tris].sum(axis=1) == 0
    if not keep_face.any():
        return verts, tris, vertex_colors, {"faces_before": len(tris), "faces_after": len(tris), "carved_faces": 0}

    kept_tris = tris[keep_face]
    out_v, out_f, out_c = _compact_mesh(verts, kept_tris, vertex_colors)
    out_v, out_f, comp_stats = filter_mesh_components(
        out_v,
        out_f,
        min_face_fraction=min_face_fraction,
        keep_main_only=keep_main_only,
        up_axis_index=1,
    )
    kept_idx = comp_stats.pop("kept_vertex_indices")
    if out_c is not None:
        out_c = out_c[kept_idx]
    return out_v, out_f, out_c, {
        "faces_before": int(len(tris)),
        "faces_after": int(len(out_f)),
        "carved_faces": int(len(tris) - len(kept_tris)),
        "carved_verts": int(bad_v.sum()),
        "mask_tol_px": float(mask_tol_px),
        "max_out_fraction": float(max_out_fraction),
    }


def trim_support_plane_drips(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    up_axis_index: int = 1,
    min_support_area_ratio: float = 0.14,
    min_vert_fraction: float = 0.01,
    max_trim_height_frac: float = 0.10,
    vertex_colors: np.ndarray | None = None,
    keep_main_only: bool = True,
    min_face_fraction: float = 0.02,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, dict[str, Any]]:
    """Trim narrow hanging blobs/drips below or attached to the dish's bottom support plane."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    tris = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(verts) == 0 or len(tris) == 0:
        return verts, tris, vertex_colors, {"trimmed": False, "faces_dropped": 0, "hanging_drips_removed": 0}

    horiz_axes = [ax for ax in (0, 1, 2) if ax != up_axis_index]
    y = verts[:, up_axis_index]
    y_min = float(y.min())
    y_max = float(y.max())
    height = max(y_max - y_min, 1e-9)
    span0 = max(float(verts[:, horiz_axes[0]].max() - verts[:, horiz_axes[0]].min()), 1e-9)
    span1 = max(float(verts[:, horiz_axes[1]].max() - verts[:, horiz_axes[1]].min()), 1e-9)
    total_area = span0 * span1

    y_support = y_min
    n_steps = 16
    max_y = y_min + float(max_trim_height_frac) * height
    for step in range(1, n_steps + 1):
        y_cut = y_min + (float(step) / float(n_steps)) * (max_y - y_min)
        sub = y <= y_cut
        v_frac = float(sub.mean())
        if not sub.any():
            continue
        pts = verts[sub]
        s0 = float(pts[:, horiz_axes[0]].max() - pts[:, horiz_axes[0]].min())
        s1 = float(pts[:, horiz_axes[1]].max() - pts[:, horiz_axes[1]].min())
        area_ratio = (s0 * s1) / total_area
        if area_ratio >= float(min_support_area_ratio) and v_frac >= float(min_vert_fraction):
            # Support starts at the start of this slice (don't shave into the main flat base)
            prev_cut = y_min + (float(step - 1) / float(n_steps)) * (max_y - y_min)
            y_support = prev_cut
            break
    else:
        y_support = max_y

    trimmed_flat = False
    y_support_offset = 0.0
    clamped_verts = 0
    out_v, out_f, out_c = verts, tris, vertex_colors

    if y_support > y_min + 1e-4 * height:
        face_y = verts[tris, up_axis_index].mean(axis=1)
        keep_face = face_y >= y_support
        if int(keep_face.sum()) >= max(12, len(tris) // 2):
            kept_tris = tris[keep_face]
            out_v, out_f, out_c = _compact_mesh(verts, kept_tris, vertex_colors)
            out_v, out_f, comp_stats = filter_mesh_components(
                out_v,
                out_f,
                min_face_fraction=min_face_fraction,
                keep_main_only=keep_main_only,
                up_axis_index=up_axis_index,
            )
            kept_idx = comp_stats.pop("kept_vertex_indices")
            if out_c is not None:
                out_c = out_c[kept_idx]
            out_v = out_v.copy()
            below = out_v[:, up_axis_index] < y_support
            if below.any():
                out_v[below, up_axis_index] = y_support
            trimmed_flat = True
            y_support_offset = float(y_support - y_min)
            clamped_verts = int(below.sum())

    # Second pass: prune narrow downward stalactite/drip lobes hanging below curved bottom corners
    # even when the middle belly already anchors y_min.
    hanging_drips_removed = 0
    if len(out_v) > 0 and len(out_f) >= 24:
        y_cur = out_v[:, up_axis_index]
        ymin_cur = float(y_cur.min())
        h_cur = max(float(y_cur.max()) - ymin_cur, 1e-9)
        s0_cur = max(float(out_v[:, horiz_axes[0]].max() - out_v[:, horiz_axes[0]].min()), 1e-9)
        s1_cur = max(float(out_v[:, horiz_axes[1]].max() - out_v[:, horiz_axes[1]].min()), 1e-9)
        max_span_cur = max(s0_cur, s1_cur)
        area_cur = s0_cur * s1_cur
        face_y_max = out_v[out_f, up_axis_index].max(axis=1)
        min_drip_faces = min(120, max(12, int(0.0002 * len(out_f))))
        drop_face = np.zeros((len(out_f),), dtype=bool)
        for frac in (0.125, 0.095):
            y_cut = ymin_cur + frac * h_cur
            sub_idx = np.flatnonzero(face_y_max <= y_cut)
            if len(sub_idx) < min_drip_faces:
                continue
            sub_tris = out_f[sub_idx]
            rows = np.repeat(np.arange(len(sub_idx), dtype=np.int32), 3)
            fv = csr_matrix((np.ones(len(rows), dtype=np.int8), (rows, sub_tris.ravel())), shape=(len(sub_idx), len(out_v)))
            n_comp, labels = connected_components(fv @ fv.T, directed=False, return_labels=True)
            counts = np.bincount(labels, minlength=n_comp)
            for cid in range(n_comp):
                cnt = int(counts[cid])
                if cnt < min_drip_faces or cnt >= 0.015 * len(out_f):
                    continue
                c_faces = sub_idx[labels == cid]
                c_verts = np.unique(out_f[c_faces].ravel())
                pts = out_v[c_verts]
                dx = float(pts[:, horiz_axes[0]].max() - pts[:, horiz_axes[0]].min())
                dz = float(pts[:, horiz_axes[1]].max() - pts[:, horiz_axes[1]].min())
                c_maxd = max(dx, dz, 1e-9)
                dy = y_cut - float(pts[:, up_axis_index].min())
                if (dx * dz) < 0.012 * area_cur and c_maxd < 0.12 * max_span_cur and dy >= 0.05 * h_cur and dy >= 0.65 * c_maxd:
                    pad = 0.025 * max_span_cur
                    h0_lo, h0_hi = float(pts[:, horiz_axes[0]].min()) - pad, float(pts[:, horiz_axes[0]].max()) + pad
                    h1_lo, h1_hi = float(pts[:, horiz_axes[1]].min()) - pad, float(pts[:, horiz_axes[1]].max()) + pad
                    y_neck = y_cut + 0.045 * h_cur
                    v_neck = (
                        (out_v[:, up_axis_index] <= y_neck)
                        & (out_v[:, horiz_axes[0]] >= h0_lo)
                        & (out_v[:, horiz_axes[0]] <= h0_hi)
                        & (out_v[:, horiz_axes[1]] >= h1_lo)
                        & (out_v[:, horiz_axes[1]] <= h1_hi)
                    )
                    v_core = np.zeros((len(out_v),), dtype=bool)
                    v_core[c_verts] = True
                    drop_face[c_faces] = True
                    drop_face |= v_core[out_f].any(axis=1)
                    drop_face |= v_neck[out_f].all(axis=1)
                    hanging_drips_removed += 1
        if drop_face.any() and int((~drop_face).sum()) >= max(12, len(out_f) // 2):
            out_v, out_f, out_c = _compact_mesh(out_v, out_f[~drop_face], out_c)
            out_v, out_f, comp_stats = filter_mesh_components(
                out_v,
                out_f,
                min_face_fraction=min_face_fraction,
                keep_main_only=keep_main_only,
                up_axis_index=up_axis_index,
            )
            kept_idx = comp_stats.pop("kept_vertex_indices")
            if out_c is not None:
                out_c = out_c[kept_idx]

    faces_dropped = int(len(tris) - len(out_f))
    return out_v, out_f, out_c, {
        "trimmed": bool(trimmed_flat or hanging_drips_removed > 0),
        "y_support_offset": round(y_support_offset, 6),
        "faces_dropped": faces_dropped,
        "clamped_verts": clamped_verts,
        "hanging_drips_removed": int(hanging_drips_removed),
    }


def _find_boundary_cycles(faces: np.ndarray, max_cycle_len: int = 600) -> list[list[int]]:
    """Trace closed directed boundary vertex cycles with consistent hole-fan winding."""
    tris = np.asarray(faces, dtype=np.int64)
    if len(tris) == 0:
        return []
    dir_edges: dict[tuple[int, int], int] = {}
    for a, b, c in tris.tolist():
        for u, v in ((a, b), (b, c), (c, a)):
            key = (u, v)
            dir_edges[key] = dir_edges.get(key, 0) + 1

    # Boundary half-edge u->v of a face means hole loop traverses v->u.
    next_map: dict[int, list[int]] = {}
    for (u, v), cnt in dir_edges.items():
        if cnt == 1 and dir_edges.get((v, u), 0) == 0:
            next_map.setdefault(v, []).append(u)

    cycles: list[list[int]] = []
    for start in list(next_map.keys()):
        while next_map.get(start):
            cycle = [start]
            curr = next_map[start].pop()
            visited = {start}
            closed = False
            while len(cycle) <= max_cycle_len:
                if curr == start:
                    closed = True
                    break
                if curr in visited:
                    # Pinch cycle at curr: extract sub-loop starting from curr
                    idx = cycle.index(curr)
                    cycle = cycle[idx:]
                    closed = True
                    break
                visited.add(curr)
                cycle.append(curr)
                nxts = next_map.get(curr)
                if not nxts:
                    break
                curr = nxts.pop()
            if closed and 3 <= len(cycle) <= max_cycle_len:
                cycles.append(cycle)
    return cycles


def fill_small_boundary_holes(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    max_hole_verts: int = 500,
    max_hole_diam_frac: float = 0.22,
    vertex_colors: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, set[int], dict[str, int]]:
    """Close small manifold/pinched boundary loops with centroid triangle fans."""
    verts = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
    tris = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(verts) == 0 or len(tris) == 0:
        return verts, tris, vertex_colors, set(), {"holes_filled": 0, "faces_added": 0}

    mesh_diag = max(float(np.linalg.norm(verts.max(axis=0) - verts.min(axis=0))), 1e-9)
    max_diam = float(max_hole_diam_frac) * mesh_diag
    cycles = _find_boundary_cycles(tris, max_cycle_len=max_hole_verts)

    new_verts: list[np.ndarray] = []
    new_cols: list[np.ndarray] = []
    new_tris: list[list[int]] = []
    touched_verts: set[int] = set()
    holes_filled = 0
    next_vid = len(verts)

    for cycle in cycles:
        pts = verts[cycle]
        diam = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)))
        if diam > max_diam:
            continue
        center = pts.mean(axis=0)
        c_idx = next_vid
        next_vid += 1
        new_verts.append(center)
        if vertex_colors is not None and len(vertex_colors) == len(verts):
            new_cols.append(vertex_colors[cycle].mean(axis=0))
        k = len(cycle)
        for i in range(k):
            u = cycle[i]
            v = cycle[(i + 1) % k]
            new_tris.append([u, v, c_idx])
        touched_verts.update(cycle)
        touched_verts.add(c_idx)
        holes_filled += 1

    if not new_tris:
        return verts, tris, vertex_colors, touched_verts, {"holes_filled": 0, "faces_added": 0}

    out_verts = np.vstack([verts, np.asarray(new_verts, dtype=np.float64)])
    out_faces = np.vstack([tris, np.asarray(new_tris, dtype=np.int64)])
    out_cols = vertex_colors
    if vertex_colors is not None and len(vertex_colors) == len(verts) and new_cols:
        out_cols = np.vstack([vertex_colors, np.asarray(new_cols, dtype=np.float64)])
    return out_verts, out_faces, out_cols, touched_verts, {
        "holes_filled": holes_filled,
        "faces_added": len(new_tris),
    }


def smooth_isolated_surface_pits(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    seed_vertices: set[int] | None = None,
    pit_normal_dot: float = 0.78,
    max_pit_cluster_verts: int = 180,
    smooth_iters: int = 8,
) -> tuple[np.ndarray, dict[str, int]]:
    """Smooth tiny isolated pits/tears and filled-hole patches while keeping creases intact."""
    import trimesh
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    verts = np.asarray(vertices, dtype=np.float64).copy()
    tris = np.asarray(faces, dtype=np.int64)
    n_verts = len(verts)
    if n_verts == 0 or len(tris) == 0 or smooth_iters <= 0:
        return verts, {"pit_vertices_smoothed": 0}

    tm = trimesh.Trimesh(vertices=verts, faces=tris, process=False)
    vn = np.asarray(tm.vertex_normals, dtype=np.float64)

    v_sum = np.zeros_like(vn)
    for i0, i1 in ((0, 1), (1, 2), (2, 0)):
        np.add.at(v_sum, tris[:, i0], vn[tris[:, i1]])
        np.add.at(v_sum, tris[:, i1], vn[tris[:, i0]])
    v_avg = v_sum / np.maximum(np.linalg.norm(v_sum, axis=-1, keepdims=True), 1e-8)
    dot_n = np.sum(vn * v_avg, axis=-1)

    # Detect sharp local pits/spikes via 1-ring centroid deviation relative to mean edge length
    u0 = np.minimum(tris[:, [0, 1, 2]], tris[:, [1, 2, 0]]).ravel()
    u1 = np.maximum(tris[:, [0, 1, 2]], tris[:, [1, 2, 0]]).ravel()
    edges_u = np.unique(np.stack([u0, u1], axis=-1), axis=0)
    ea, eb = edges_u[:, 0], edges_u[:, 1]
    elen = np.linalg.norm(verts[eb] - verts[ea], axis=-1)
    c_sum = np.zeros_like(verts)
    e_sum = np.zeros((n_verts,), dtype=np.float64)
    e_cnt = np.zeros((n_verts,), dtype=np.float64)
    np.add.at(c_sum, ea, verts[eb])
    np.add.at(c_sum, eb, verts[ea])
    np.add.at(e_sum, ea, elen)
    np.add.at(e_sum, eb, elen)
    np.add.at(e_cnt, ea, 1.0)
    np.add.at(e_cnt, eb, 1.0)
    has_nb = e_cnt > 0
    normal_disp = np.zeros((n_verts,), dtype=np.float64)
    normal_disp[has_nb] = np.abs(
        np.sum(((c_sum[has_nb] / e_cnt[has_nb, None]) - verts[has_nb]) * v_avg[has_nb], axis=-1)
    )
    mean_edge = np.maximum(e_sum / np.maximum(e_cnt, 1.0), 1e-9)
    spike_ratio = np.where(has_nb, normal_disp / mean_edge, 0.0)

    is_anom = (dot_n < float(pit_normal_dot)) | (spike_ratio > 0.45)
    pit_mask = np.zeros((n_verts,), dtype=bool)
    if is_anom.any():
        both_anom = is_anom[ea] & is_anom[eb]
        if both_anom.any():
            rows = np.concatenate([ea[both_anom], eb[both_anom]])
            cols = np.concatenate([eb[both_anom], ea[both_anom]])
            graph = csr_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(n_verts, n_verts))
            n_comp, comp_ids = connected_components(graph, directed=False, return_labels=True)
            comp_sizes = np.bincount(comp_ids, minlength=n_comp)
            pit_mask = is_anom & (comp_sizes[comp_ids] <= int(max_pit_cluster_verts))
        else:
            pit_mask = is_anom.copy()

    if seed_vertices:
        seed_arr = np.fromiter((int(sv) for sv in seed_vertices if 0 <= int(sv) < n_verts), dtype=np.int64)
        if len(seed_arr) > 0:
            pit_mask[seed_arr] = True

    if not pit_mask.any():
        return verts, {"pit_vertices_smoothed": 0}

    # Include 1-ring around pit vertices so transition into surrounding smooth surface is seamless
    active_mask = pit_mask.copy()
    active_mask[ea[pit_mask[eb]]] = True
    active_mask[eb[pit_mask[ea]]] = True
    active_mask &= has_nb
    act_idx = np.flatnonzero(active_mask)
    if len(act_idx) == 0:
        return verts, {"pit_vertices_smoothed": 0}

    for _ in range(int(smooth_iters)):
        for step_w in (0.45, -0.42):
            nb_sum = np.zeros_like(verts)
            np.add.at(nb_sum, ea, verts[eb])
            np.add.at(nb_sum, eb, verts[ea])
            centroid = nb_sum[act_idx] / e_cnt[act_idx, None]
            verts[act_idx] = verts[act_idx] + step_w * (centroid - verts[act_idx])

    return verts, {"pit_vertices_smoothed": int(len(act_idx))}


def _extract_boundary_edges_fast(faces: np.ndarray, n_verts: int) -> tuple[np.ndarray, int, int]:
    """Return (boundary_half_edges, boundary_edge_count, non_manifold_edge_count) via vectorized sort."""
    tris = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(tris) == 0 or n_verts <= 0:
        return np.zeros((0, 2), dtype=np.int64), 0, 0
    he = np.vstack([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    ue = np.sort(he, axis=1)
    keys = ue[:, 0].astype(np.uint64) * np.uint64(n_verts) + ue[:, 1].astype(np.uint64)
    order = np.argsort(keys, kind="mergesort")
    sk = keys[order]
    _, first_idx, counts = np.unique(sk, return_index=True, return_counts=True)
    b_mask = counts == 1
    b_he = he[order[first_idx[b_mask]]]
    nm_count = int((counts > 2).sum())
    return b_he, int(b_mask.sum()), nm_count


def _trace_boundary_loops_from_he(b_he: np.ndarray) -> list[list[int]]:
    """Trace all closed boundary vertex cycles (hole-fan winding v->u) from directed boundary half-edges."""
    if len(b_he) == 0:
        return []
    next_map: dict[int, list[int]] = {}
    for u, v in b_he.tolist():
        next_map.setdefault(int(v), []).append(int(u))

    cycles: list[list[int]] = []
    for start in list(next_map.keys()):
        while next_map.get(start):
            cycle = [start]
            curr = next_map[start].pop()
            visited = {start: 0}
            closed = False
            while True:
                if curr == start:
                    closed = True
                    break
                if curr in visited:
                    idx = visited[curr]
                    cycle = cycle[idx:]
                    closed = True
                    break
                visited[curr] = len(cycle)
                cycle.append(curr)
                nxts = next_map.get(curr)
                if not nxts:
                    break
                curr = nxts.pop()
            if closed and len(cycle) >= 3:
                cycles.append(cycle)
    return cycles


def _ear_clip_polygon_2d(pts_xz: np.ndarray, cycle: Sequence[int]) -> list[list[int]]:
    """Triangulate a simple 2D polygon in (x, z) with CCW-from-below winding (normal_y < 0)."""
    poly: list[int] = []
    for vid in cycle:
        iv = int(vid)
        if poly and np.linalg.norm(pts_xz[iv] - pts_xz[poly[-1]]) < 1e-12:
            continue
        poly.append(iv)
    while len(poly) >= 2 and np.linalg.norm(pts_xz[poly[0]] - pts_xz[poly[-1]]) < 1e-12:
        poly.pop()
    if len(poly) < 3:
        return []

    p = pts_xz[np.asarray(poly, dtype=np.int64)]
    x = p[:, 0]
    z = p[:, 1]
    signed_area = 0.5 * float(np.sum(x * np.roll(z, -1) - np.roll(x, -1) * z))
    if abs(signed_area) < 1e-14:
        return []
    if signed_area < 0.0:
        poly = list(reversed(poly))

    tris: list[list[int]] = []
    rem = list(poly)
    while len(rem) > 3:
        n = len(rem)
        rem_arr = np.asarray(rem, dtype=np.int64)
        rem_pts = pts_xz[rem_arr]
        clipped = False
        best_idx = -1
        best_area = -1.0
        for i in range(n):
            ia = rem[(i - 1) % n]
            ib = rem[i]
            ic = rem[(i + 1) % n]
            pa, pb, pc = pts_xz[ia], pts_xz[ib], pts_xz[ic]
            area2 = float((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]))
            if area2 <= 1e-14:
                continue
            if area2 > best_area:
                best_area = area2
                best_idx = i
            if n > 4:
                mask = np.ones(n, dtype=bool)
                mask[(i - 1) % n] = False
                mask[i] = False
                mask[(i + 1) % n] = False
                q = rem_pts[mask]
                c0 = (pb[0] - pa[0]) * (q[:, 1] - pa[1]) - (pb[1] - pa[1]) * (q[:, 0] - pa[0])
                c1 = (pc[0] - pb[0]) * (q[:, 1] - pb[1]) - (pc[1] - pb[1]) * (q[:, 0] - pb[0])
                c2 = (pa[0] - pc[0]) * (q[:, 1] - pc[1]) - (pa[1] - pc[1]) * (q[:, 0] - pc[0])
                inside = (c0 >= -1e-12) & (c1 >= -1e-12) & (c2 >= -1e-12)
                if inside.any():
                    continue
            tris.append([ia, ib, ic])
            rem.pop(i)
            clipped = True
            break
        if not clipped:
            if best_idx < 0:
                best_idx = 0
            ia = rem[(best_idx - 1) % n]
            ib = rem[best_idx]
            ic = rem[(best_idx + 1) % n]
            tris.append([ia, ib, ic])
            rem.pop(best_idx)
    if len(rem) == 3:
        tris.append([rem[0], rem[1], rem[2]])
    return tris


def _fast_fix_winding(faces: np.ndarray, n_verts: int) -> np.ndarray:
    """Propagate consistent half-edge winding across manifold shared edges in O(F) time."""
    f = np.asarray(faces, dtype=np.int64).copy()
    n_f = len(f)
    if n_f <= 1 or n_verts <= 0:
        return f
    he = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    he_f = np.tile(np.arange(n_f, dtype=np.int64), 3)
    ue = np.sort(he, axis=1)
    keys = ue[:, 0].astype(np.uint64) * np.uint64(n_verts) + ue[:, 1].astype(np.uint64)
    order = np.argsort(keys, kind="mergesort")
    sk = keys[order]
    same_key = sk[:-1] == sk[1:]
    is_pair = same_key.copy()
    if len(sk) > 2:
        triple = same_key[:-1] & same_key[1:]
        is_pair[:-1] &= ~triple
        is_pair[1:] &= ~triple
    pair_idx = np.flatnonzero(is_pair)
    if len(pair_idx) == 0:
        return f
    ia = order[pair_idx]
    ib = order[pair_idx + 1]
    fa = he_f[ia]
    fb = he_f[ib]
    disagree = he[ia, 0] == he[ib, 0]

    adj_u = np.concatenate([fa, fb])
    adj_v = np.concatenate([fb, fa])
    adj_d = np.concatenate([disagree, disagree])
    sort_u = np.argsort(adj_u, kind="mergesort")
    adj_u = adj_u[sort_u]
    adj_v = adj_v[sort_u]
    adj_d = adj_d[sort_u]
    starts_l = np.searchsorted(adj_u, np.arange(n_f, dtype=np.int64), side="left").tolist()
    ends_l = np.searchsorted(adj_u, np.arange(n_f, dtype=np.int64), side="right").tolist()
    adj_v_l = adj_v.tolist()
    adj_d_l = adj_d.tolist()

    visited = np.zeros(n_f, dtype=bool)
    flip = np.zeros(n_f, dtype=bool)
    for root in range(n_f):
        if visited[root]:
            continue
        visited[root] = True
        stack = [root]
        while stack:
            cur = stack.pop()
            cur_flip = bool(flip[cur])
            for k in range(starts_l[cur], ends_l[cur]):
                nb = adj_v_l[k]
                if not visited[nb]:
                    visited[nb] = True
                    flip[nb] = cur_flip ^ bool(adj_d_l[k])
                    stack.append(nb)
    if flip.any():
        f[flip] = f[flip][:, [0, 2, 1]]
    return f


def _ensure_outward_normals_yup(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Fix edge-connected winding consistency and orient each patch outward/upward in Y-up space."""
    import trimesh
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    tris = np.asarray(faces, dtype=np.int64).copy()
    if len(tris) == 0 or len(verts) == 0:
        return tris
    tm = trimesh.Trimesh(vertices=verts, faces=tris, process=False)
    trimesh.repair.fix_winding(tm)
    tris = np.asarray(tm.faces, dtype=np.int64).copy()

    n_f = len(tris)
    adj = np.asarray(tm.face_adjacency, dtype=np.int64)
    if len(adj) > 0:
        rows = np.concatenate([adj[:, 0], adj[:, 1]])
        cols = np.concatenate([adj[:, 1], adj[:, 0]])
        graph = csr_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(n_f, n_f))
        n_comp, labels = connected_components(graph, directed=False, return_labels=True)
    else:
        n_comp = n_f
        labels = np.arange(n_f, dtype=np.int64)

    areas = np.asarray(tm.area_faces, dtype=np.float64)
    centroids = np.asarray(tm.triangles_center, dtype=np.float64)
    normals = np.asarray(tm.face_normals, dtype=np.float64)
    y_min = float(verts[:, 1].min())
    y_max = float(verts[:, 1].max())
    height = max(y_max - y_min, 1e-6)
    cx = 0.5 * float(verts[:, 0].min() + verts[:, 0].max())
    cz = 0.5 * float(verts[:, 2].min() + verts[:, 2].max())
    c_ref = np.array([cx, y_min - 0.1 * height, cz], dtype=np.float64)

    for cid in range(n_comp):
        pm = labels == cid
        if not pm.any():
            continue
        radial_dot = float(np.sum(areas[pm] * np.sum((centroids[pm] - c_ref) * normals[pm], axis=1)))
        if radial_dot < 0.0:
            tris[pm] = tris[pm][:, [0, 2, 1]]
    return tris


def _face_shell_labels(faces: np.ndarray) -> tuple[int, np.ndarray]:
    """Return (n_shells, per_face_shell_label) via undirected shared-edge adjacency."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    f = np.asarray(faces, dtype=np.int64)
    n_f = len(f)
    if n_f == 0:
        return 0, np.zeros((0,), dtype=np.int32)
    edges = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e_lo = np.minimum(edges[:, 0], edges[:, 1]).astype(np.uint64)
    e_hi = np.maximum(edges[:, 0], edges[:, 1]).astype(np.uint64)
    keys = (e_lo << np.uint64(32)) | e_hi
    face_ids = np.tile(np.arange(n_f, dtype=np.int64), 3)
    order = np.argsort(keys, kind="mergesort")
    sk = keys[order]
    sf = face_ids[order]
    same = sk[1:] == sk[:-1]
    if not same.any():
        return n_f, np.arange(n_f, dtype=np.int32)
    fa = sf[:-1][same]
    fb = sf[1:][same]
    adj = csr_matrix((np.ones(len(fa), dtype=np.int8), (fa, fb)), shape=(n_f, n_f))
    n_comp, labels = connected_components(adj + adj.T, directed=False, return_labels=True)
    return int(n_comp), labels


def _keep_single_largest_shell(verts: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Keep strictly the single largest edge-connected triangle shell and compact vertices."""
    v = np.asarray(verts, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    if len(v) == 0 or len(f) == 0:
        return v, f
    n_comp, face_comp = _face_shell_labels(f)
    if n_comp <= 1:
        return v, f
    counts = np.bincount(face_comp, minlength=n_comp)
    best = int(np.argmax(counts))
    out_v, out_f, _ = _compact_mesh(v, f[face_comp == best])
    return out_v, out_f


def _build_xz_footprint_and_rim(
    verts: np.ndarray,
    faces: np.ndarray,
    n_grid: int = 192,
) -> dict[str, Any]:
    """Compute cleaned 2D XZ footprint, smooth SDF normals, and 180-sector inward-taper profile."""
    from scipy import ndimage

    x_lo = float(verts[:, 0].min())
    x_hi = float(verts[:, 0].max())
    z_lo = float(verts[:, 2].min())
    z_hi = float(verts[:, 2].max())
    horiz_span = max(x_hi - x_lo, z_hi - z_lo, 1e-4)
    pad = 0.06 * horiz_span
    x0 = x_lo - pad
    z0 = z_lo - pad
    span_x = max((x_hi + pad) - x0, 1e-4)
    span_z = max((z_hi + pad) - z0, 1e-4)
    cell_x = span_x / max(n_grid - 1, 1)
    cell_z = span_z / max(n_grid - 1, 1)
    cell_sz = max(cell_x, cell_z)

    if len(faces) <= 80_000:
        pts_sample = np.vstack(
            [
                verts,
                0.5 * (verts[faces[:, 0]] + verts[faces[:, 1]]),
                0.5 * (verts[faces[:, 1]] + verts[faces[:, 2]]),
                0.5 * (verts[faces[:, 2]] + verts[faces[:, 0]]),
                verts[faces].mean(axis=1),
            ]
        )
    else:
        pts_sample = np.vstack([verts, verts[faces].mean(axis=1)])

    occ = np.zeros((n_grid, n_grid), dtype=bool)
    ix = np.clip(np.rint((pts_sample[:, 0] - x0) / cell_x).astype(np.int32), 0, n_grid - 1)
    iz = np.clip(np.rint((pts_sample[:, 2] - z0) / cell_z).astype(np.int32), 0, n_grid - 1)
    occ[ix, iz] = True

    yy, xx = np.ogrid[-2:3, -2:3]
    disk2 = (xx * xx + yy * yy) <= 5
    cross1 = ndimage.generate_binary_structure(2, 1)
    footprint = ndimage.binary_closing(occ, structure=disk2)
    footprint = ndimage.binary_fill_holes(footprint)
    # Strip 1-2px ragged rim wisps/overhangs while keeping the main solid interior intact
    opened = ndimage.binary_opening(footprint, structure=cross1)
    if len(verts) > 5000 and int(opened.sum()) > 500:
        opened2 = ndimage.binary_opening(opened, structure=cross1)
        if opened2.any():
            opened = opened2
    if opened.any():
        footprint = ndimage.binary_fill_holes(opened)
    labeled, n_cc = ndimage.label(footprint)
    if n_cc > 1:
        cc_counts = np.bincount(labeled.ravel())
        cc_counts[0] = 0
        footprint = labeled == int(np.argmax(cc_counts))

    dist_out = ndimage.distance_transform_edt(~footprint) * cell_sz
    dist_in = ndimage.distance_transform_edt(footprint) * cell_sz

    fp_ix, fp_iz = np.nonzero(footprint)
    cx = float(x0 + fp_ix.mean() * cell_x) if len(fp_ix) else float(verts[:, 0].mean())
    cz = float(z0 + fp_iz.mean() * cell_z) if len(fp_iz) else float(verts[:, 2].mean())

    sdf_2d = ndimage.gaussian_filter(dist_out - dist_in, sigma=1.5)
    grad_x, grad_z = np.gradient(sdf_2d, cell_x, cell_z)

    y_min = float(verts[:, 1].min())
    y_max = float(verts[:, 1].max())
    height = max(y_max - y_min, 1e-6)

    y_grid = np.full((n_grid, n_grid), np.inf, dtype=np.float64)
    v_ix = np.clip(np.rint((verts[:, 0] - x0) / cell_x).astype(np.int32), 0, n_grid - 1)
    v_iz = np.clip(np.rint((verts[:, 2] - z0) / cell_z).astype(np.int32), 0, n_grid - 1)
    np.minimum.at(y_grid, (v_ix, v_iz), verts[:, 1])
    y_min_nbr = ndimage.minimum_filter(y_grid, size=5, mode="nearest")

    # 180 uniform angular perimeter samples from footprint_clean & smooth SDF outward normals
    n_bins = 180
    thetas = np.linspace(0.0, 2.0 * np.pi, n_bins, endpoint=False)
    cos_t = np.cos(thetas)
    sin_t = np.sin(thetas)
    r_scan = np.linspace(0.0, 0.75 * horiz_span, 192)
    rx = np.clip(np.rint((cx + cos_t[:, None] * r_scan[None, :] - x0) / cell_x).astype(np.int32), 0, n_grid - 1)
    rz = np.clip(np.rint((cz + sin_t[:, None] * r_scan[None, :] - z0) / cell_z).astype(np.int32), 0, n_grid - 1)
    hit_fp = footprint[rx, rz]
    r_rim = np.zeros(n_bins, dtype=np.float64)
    for k in range(n_bins):
        hits = np.flatnonzero(hit_fp[k])
        r_rim[k] = float(r_scan[hits[-1]]) if len(hits) else 0.25 * horiz_span

    # Circular 5-tap smoothing of contour radii
    def _circ_smooth(arr: np.ndarray, taps: np.ndarray) -> np.ndarray:
        h = len(taps) // 2
        pad_a = np.concatenate([arr[-h:], arr, arr[:h]])
        return np.convolve(pad_a, taps, mode="valid")

    r_rim = _circ_smooth(r_rim, np.array([0.1, 0.2, 0.4, 0.2, 0.1]))
    rim_x = cx + r_rim * cos_t
    rim_z = cz + r_rim * sin_t
    gx_rim = grad_x[
        np.clip(np.rint((rim_x - x0) / cell_x).astype(np.int32), 0, n_grid - 1),
        np.clip(np.rint((rim_z - z0) / cell_z).astype(np.int32), 0, n_grid - 1),
    ]
    gz_rim = grad_z[
        np.clip(np.rint((rim_x - x0) / cell_x).astype(np.int32), 0, n_grid - 1),
        np.clip(np.rint((rim_z - z0) / cell_z).astype(np.int32), 0, n_grid - 1),
    ]
    g_len = np.hypot(gx_rim, gz_rim)
    nx_rim = np.where(g_len > 1e-8, gx_rim / np.maximum(g_len, 1e-8), cos_t)
    nz_rim = np.where(g_len > 1e-8, gz_rim / np.maximum(g_len, 1e-8), sin_t)

    # Estimate intact lower-wall taper and lowest observed outer-wall height per sector
    in_fp_v = dist_out[v_ix, v_iz] <= 1.5 * cell_sz
    v_clean = verts[in_fp_v] if in_fp_v.any() else verts
    dx_v = v_clean[:, 0] - cx
    dz_v = v_clean[:, 2] - cz
    ang_v = np.mod(np.arctan2(dz_v, dx_v), 2.0 * np.pi)
    rad_v = np.hypot(dx_v, dz_v)
    bin_v = np.clip((ang_v / (2.0 * np.pi) * n_bins).astype(np.int32), 0, n_bins - 1)

    y_low_obs = np.full(n_bins, np.nan, dtype=np.float64)
    y_low_edge = np.full(n_bins, np.nan, dtype=np.float64)
    r_edge_obs = np.full(n_bins, np.nan, dtype=np.float64)
    r_bottom_obs = np.full(n_bins, np.nan, dtype=np.float64)

    for b in range(n_bins):
        bm = bin_v == b
        if not bm.any():
            continue
        rb_v = rad_v[bm]
        yb_v = v_clean[bm, 1]
        outer_m = rb_v >= 0.55 * r_rim[b]
        if outer_m.any():
            y_low_obs[b] = float(yb_v[outer_m].min())
            rim_band_m = rb_v >= 0.72 * r_rim[b]
            sub_y = yb_v[rim_band_m] if rim_band_m.any() else yb_v[outer_m]
            sub_r = rb_v[rim_band_m] if rim_band_m.any() else rb_v[outer_m]
            y_cut_b = float(np.quantile(sub_y, 0.12)) if len(sub_y) >= 4 else float(sub_y.min())
            y_low_edge[b] = y_cut_b
            low_sub_r = sub_r[sub_y <= y_cut_b + 0.04 * height]
            r_edge_obs[b] = float(np.quantile(low_sub_r, 0.85)) if len(low_sub_r) else float(r_rim[b])
        bot_m = yb_v <= (y_min + 0.12 * height)
        if bot_m.any():
            r_bottom_obs[b] = float(np.quantile(rb_v[bot_m], 0.90))

    def _circ_interp(arr: np.ndarray, fallback_val: np.ndarray | float) -> np.ndarray:
        valid = np.isfinite(arr)
        if not valid.any():
            return np.broadcast_to(np.asarray(fallback_val, dtype=np.float64), arr.shape).copy()
        if valid.all():
            return arr.copy()
        idx_v = np.flatnonzero(valid)
        idx_a = np.arange(len(arr))
        xp = np.concatenate([idx_v - len(arr), idx_v, idx_v + len(arr)])
        fp_vals = np.concatenate([arr[idx_v], arr[idx_v], arr[idx_v]])
        return np.interp(idx_a, xp, fp_vals)

    y_low_obs = _circ_interp(y_low_obs, y_min + 0.25 * height)
    y_low_edge = _circ_interp(y_low_edge, y_low_obs)
    r_edge_obs = np.minimum(r_rim, _circ_interp(r_edge_obs, r_rim * 0.96))

    intact_mask = (y_low_obs <= (y_min + 0.12 * height)) & np.isfinite(r_bottom_obs)
    if int(intact_mask.sum()) >= 8:
        ratios = r_bottom_obs[intact_mask] / np.maximum(r_rim[intact_mask], 1e-6)
        taper_ratio = float(np.clip(np.median(ratios), 0.72, 0.94))
    else:
        taper_ratio = 0.88

    r_base_intact = np.where(intact_mask, np.clip(r_bottom_obs, 0.60 * r_rim, 0.96 * r_rim), np.nan)
    r_base_interp = _circ_interp(r_base_intact, r_rim * taper_ratio)
    r_base = np.where(
        y_low_obs <= (y_min + 0.05 * height),
        np.clip(r_base_interp, 0.60 * r_rim, 0.96 * r_rim),
        np.clip(0.5 * r_base_interp + 0.5 * (r_rim * taper_ratio), 0.65 * r_rim, 0.92 * r_rim),
    )
    r_base = _circ_smooth(r_base, np.array([0.1, 0.15, 0.15, 0.2, 0.15, 0.15, 0.1]))
    y_low_edge_smooth = _circ_smooth(y_low_edge, np.array([0.1, 0.15, 0.15, 0.2, 0.15, 0.15, 0.1]))
    r_top_edge = _circ_smooth(np.minimum(r_rim * 0.98, r_edge_obs), np.array([0.1, 0.2, 0.4, 0.2, 0.1]))

    # Keep legacy 72-bin r_bins alias for fallback compatibility
    r_bins_72 = r_base[:: max(1, n_bins // 72)][:72]

    return {
        "footprint": footprint,
        "dist_out": dist_out,
        "dist_in": dist_in,
        "y_min_nbr": y_min_nbr,
        "x0": x0,
        "z0": z0,
        "cell_x": cell_x,
        "cell_z": cell_z,
        "cell_sz": cell_sz,
        "n_grid": n_grid,
        "horiz_span": horiz_span,
        "cx": cx,
        "cz": cz,
        "y_min": y_min,
        "y_max": y_max,
        "height": height,
        "thetas": thetas,
        "r_rim": r_rim,
        "r_top_edge": r_top_edge,
        "r_base": r_base,
        "nx_rim": nx_rim,
        "nz_rim": nz_rim,
        "y_low_obs": y_low_obs,
        "y_low_edge": y_low_edge_smooth,
        "r_bins": r_bins_72,
        "has_r_bins": True,
    }


def _cap_tris_need_flip(
    clipped_tris: list[list[int]],
    b_he_set: set[tuple[int, int]] | None,
    cyc: Sequence[int] | None,
) -> bool | None:
    """Return True/False if cap triangles should reverse relative to boundary half-edges, or None."""
    if not clipped_tris:
        return None
    fwd_edges: set[tuple[int, int]] = set()
    rev_edges: set[tuple[int, int]] = set()
    if b_he_set:
        fwd_edges = b_he_set
        rev_edges = {(v_id, u_id) for u_id, v_id in b_he_set}
    elif cyc:
        k = len(cyc)
        fwd_edges = {(int(cyc[i]), int(cyc[(i + 1) % k])) for i in range(k)}
        rev_edges = {(int(cyc[(i + 1) % k]), int(cyc[i])) for i in range(k)}
    if not fwd_edges:
        return None
    fwd_hits = 0
    rev_hits = 0
    for a, b, c in clipped_tris:
        for u_id, v_id in ((a, b), (b, c), (c, a)):
            if (u_id, v_id) in fwd_edges:
                fwd_hits += 1
            elif (u_id, v_id) in rev_edges:
                rev_hits += 1
    if fwd_hits == rev_hits:
        return None
    return fwd_hits > rev_hits


def _strip_duplicate_dir_he_faces(verts: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray, bool]:
    """Delete faces incident to residual duplicate directed half-edges after winding propagation."""
    v = np.asarray(verts, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    if len(f) == 0 or len(v) == 0:
        return v, f, False
    he = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    dk = he[:, 0].astype(np.uint64) * np.uint64(len(v)) + he[:, 1].astype(np.uint64)
    _, inv, counts = np.unique(dk, return_inverse=True, return_counts=True)
    bad_he = counts[inv] > 1
    if not bad_he.any():
        return v, f, False
    bad_face = bad_he.reshape(3, len(f)).any(axis=0)
    if not (~bad_face).any():
        return v, f, False
    v_c, f_c, _ = _compact_mesh(v, f[~bad_face])
    v_c, f_c = _keep_single_largest_shell(v_c, f_c)
    return v_c, f_c, True


def _orient_and_split_cap_tris(
    verts_arr: np.ndarray,
    clipped_tris: list[list[int]],
    *,
    b_he_set: set[tuple[int, int]] | None = None,
    cyc: Sequence[int] | None = None,
) -> tuple[list[np.ndarray], list[list[int]]]:
    """Orient 2D cap triangles to oppose boundary half-edges and 1-to-3 split non-slivers."""
    extra_verts: list[np.ndarray] = []
    out_tris: list[list[int]] = []
    next_id = len(verts_arr)
    flip_all = _cap_tris_need_flip(clipped_tris, b_he_set, cyc)
    for tri in clipped_tris:
        p0, p1, p2 = verts_arr[tri[0]], verts_arr[tri[1]], verts_arr[tri[2]]
        nrm = np.cross(p1 - p0, p2 - p0)
        if flip_all is not None:
            a, b, c = (tri[0], tri[2], tri[1]) if flip_all else (tri[0], tri[1], tri[2])
        else:
            a, b, c = (tri[0], tri[2], tri[1]) if nrm[1] > 0.0 else (tri[0], tri[1], tri[2])
        if abs(float(nrm[1])) > 1e-12:
            mid = (p0 + p1 + p2) / 3.0
            mid[1] = 0.0
            mid_id = next_id
            next_id += 1
            extra_verts.append(mid)
            out_tris.append([a, b, mid_id])
            out_tris.append([b, c, mid_id])
            out_tris.append([c, a, mid_id])
        else:
            out_tris.append([a, b, c])
    return extra_verts, out_tris


def _slice_mesh_at_y0_open(
    verts: np.ndarray,
    faces: np.ndarray,
    y_cut: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Slice a mesh at y >= y_cut and place cut vertices at y=0.0 without capping."""
    v = np.asarray(verts, dtype=np.float64).copy()
    f = np.asarray(faces, dtype=np.int64).copy()
    if len(v) == 0 or len(f) == 0:
        return v, f

    d = v[:, 1] - float(y_cut)
    d = np.where(np.abs(d) < 1e-10, -1e-10, d)

    above = d[f] > 0.0
    n_above = above.sum(axis=1)
    keep_full = f[n_above == 3]
    cross_idx = np.flatnonzero((n_above == 1) | (n_above == 2))

    new_verts: list[np.ndarray] = []
    edge_cache: dict[tuple[int, int], int] = {}
    base_v = len(v)

    def _get_cut_vert(u: int, w: int) -> int:
        key = (u, w) if u < w else (w, u)
        cached = edge_cache.get(key)
        if cached is not None:
            return cached
        du, dw = float(d[u]), float(d[w])
        t = du / (du - dw)
        pt = v[u] + t * (v[w] - v[u])
        pt[1] = 0.0
        idx = base_v + len(new_verts)
        new_verts.append(pt)
        edge_cache[key] = idx
        return idx

    cross_tris: list[list[int]] = []
    for fi in cross_idx.tolist():
        a, b, c = int(f[fi, 0]), int(f[fi, 1]), int(f[fi, 2])
        abv = [d[a] > 0.0, d[b] > 0.0, d[c] > 0.0]
        if n_above[fi] == 1:
            if abv[1]:
                a, b, c = b, c, a
            elif abv[2]:
                a, b, c = c, a, b
            pab = _get_cut_vert(a, b)
            pca = _get_cut_vert(c, a)
            cross_tris.append([a, pab, pca])
        else:
            if not abv[1]:
                a, b, c = b, c, a
            elif not abv[2]:
                a, b, c = c, a, b
            pab = _get_cut_vert(a, b)
            pca = _get_cut_vert(c, a)
            cross_tris.append([b, c, pca])
            cross_tris.append([b, pca, pab])

    v_all = np.vstack([v, np.asarray(new_verts, dtype=np.float64)]) if new_verts else v
    f_all = np.vstack([keep_full, np.asarray(cross_tris, dtype=np.int64)]) if cross_tris else keep_full
    if len(f_all) == 0:
        return v, f
    v_all, f_all, _ = _compact_mesh(v_all, f_all)
    v_all[v_all[:, 1] < 0.0, 1] = 0.0
    return v_all, f_all


def _slice_and_cap_at_y0(verts: np.ndarray, faces: np.ndarray, y_cut: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Slice a closed manifold mesh at y >= y_cut, set cut vertices to y=0.0, and cap flat at y=0.0."""
    v = np.asarray(verts, dtype=np.float64).copy()
    f = np.asarray(faces, dtype=np.int64).copy()
    if len(v) == 0 or len(f) == 0:
        return v, f

    he_pre = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    dk_pre = he_pre[:, 0].astype(np.uint64) * np.uint64(len(v)) + he_pre[:, 1].astype(np.uint64)
    if (np.unique(dk_pre, return_counts=True)[1] > 1).any():
        f = _fast_fix_winding(f, len(v))
    vc_pre = v - v.mean(axis=0, keepdims=True)
    if float(np.sum(vc_pre[f[:, 0]] * np.cross(vc_pre[f[:, 1]], vc_pre[f[:, 2]])) / 6.0) < 0.0:
        f = f[:, [0, 2, 1]]

    v_all, f_all = _slice_mesh_at_y0_open(v, f, y_cut=y_cut)
    if len(f_all) == 0:
        return v, f

    b_he, b_cnt, _ = _extract_boundary_edges_fast(f_all, len(v_all))
    if b_cnt > 0:
        b_he_set = {(int(u_id), int(v_id)) for u_id, v_id in b_he.tolist()}
        loops = _trace_boundary_loops_from_he(b_he)
        if not loops:
            loops = _trace_undirected_boundary_loops(b_he)
        pts_xz = v_all[:, [0, 2]]
        cap_tris: list[list[int]] = []
        cap_extra_verts: list[np.ndarray] = []
        for cyc in loops:
            v_all[cyc, 1] = 0.0
            clipped = _ear_clip_polygon_2d(pts_xz, cyc)
            ev, tris_split = _orient_and_split_cap_tris(
                np.vstack([v_all, np.asarray(cap_extra_verts, dtype=np.float64)]) if cap_extra_verts else v_all,
                clipped,
                b_he_set=b_he_set,
                cyc=cyc,
            )
            cap_extra_verts.extend(ev)
            cap_tris.extend(tris_split)
        if cap_extra_verts:
            v_all = np.vstack([v_all, np.asarray(cap_extra_verts, dtype=np.float64)])
        if cap_tris:
            f_all = np.vstack([f_all, np.asarray(cap_tris, dtype=np.int64)])
    if len(f_all) > 0 and len(v_all) > 0:
        he_post = np.vstack([f_all[:, [0, 1]], f_all[:, [1, 2]], f_all[:, [2, 0]]])
        dk_post = he_post[:, 0].astype(np.uint64) * np.uint64(len(v_all)) + he_post[:, 1].astype(np.uint64)
        if (np.unique(dk_post, return_counts=True)[1] > 1).any():
            f_all = _fast_fix_winding(f_all, len(v_all))
        v_all, f_all, stripped = _strip_duplicate_dir_he_faces(v_all, f_all)
        if stripped:
            v_all, f_all = _clean_and_close_component(v_all, f_all, _allow_strip=False)
    return v_all, f_all


def _trace_undirected_boundary_loops(b_he: np.ndarray) -> list[list[int]]:
    """Fallback boundary cycle tracer ignoring half-edge direction when adjacent faces had flipped winding."""
    if len(b_he) == 0:
        return []
    adj: dict[int, list[int]] = {}
    for u, v in b_he.tolist():
        adj.setdefault(int(u), []).append(int(v))
        adj.setdefault(int(v), []).append(int(u))
    used_edges: set[tuple[int, int]] = set()
    cycles: list[list[int]] = []
    for start in list(adj.keys()):
        for nxt in adj.get(start, ()):
            ek = (start, nxt) if start < nxt else (nxt, start)
            if ek in used_edges:
                continue
            used_edges.add(ek)
            cycle = [start, nxt]
            prev, curr = start, nxt
            while True:
                moved = False
                for cand in adj.get(curr, ()):
                    if cand == prev and len(adj[curr]) > 1:
                        continue
                    ek2 = (curr, cand) if curr < cand else (cand, curr)
                    if ek2 in used_edges:
                        continue
                    used_edges.add(ek2)
                    if cand == start:
                        cycles.append(cycle)
                        moved = True
                        break
                    cycle.append(cand)
                    prev, curr = curr, cand
                    moved = True
                    break
                if not moved or curr == start or (cycle and cycle[-1] == start):
                    break
                if len(cycle) > len(b_he) + 2:
                    break
    return [c for c in cycles if len(c) >= 3]


def _heal_t_junction_collinear_loop(
    v: np.ndarray,
    f: np.ndarray,
    cyc: list[int],
) -> np.ndarray | None:
    """Split an opposing face across a collinear T-junction boundary loop [A, m1..mr, B]."""
    pts = v[cyc]
    if len(pts) < 3:
        return None
    # Find farthest pair (A, B) in cyc
    dists = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=-1)
    i_a, i_b = np.unravel_index(int(np.argmax(dists)), dists.shape)
    span = float(dists[i_a, i_b])
    if span <= 1e-12:
        return None
    axis = (pts[i_b] - pts[i_a]) / span
    rel = pts - pts[i_a]
    proj = rel @ axis
    perp = np.linalg.norm(rel - proj[:, None] * axis[None, :], axis=-1)
    if float(perp.max()) > max(1e-6 * span, 1e-8):
        return None
    order = np.argsort(proj)
    ordered = [int(cyc[idx]) for idx in order.tolist()]
    va, vb = ordered[0], ordered[-1]
    has_ab = (
        np.any(f == va, axis=1) & np.any(f == vb, axis=1)
    )
    cand_fi = np.flatnonzero(has_ab)
    if len(cand_fi) == 0:
        return None
    fi = int(cand_fi[0])
    tri = [int(x) for x in f[fi].tolist()]
    # Rotate tri so va is at position 0 or 1 adjacent to vb
    while tri[0] != va and tri[0] != vb:
        tri = [tri[1], tri[2], tri[0]]
    if tri[1] != vb and tri[1] != va:
        # va/vb are at indices 0 and 2 -> rotate so index 2 becomes 0
        tri = [tri[2], tri[0], tri[1]]
    if tri[0] == va and tri[1] == vb:
        seq = ordered
        vd = tri[2]
    elif tri[0] == vb and tri[1] == va:
        seq = list(reversed(ordered))
        vd = tri[2]
    else:
        return None
    new_sub = [[seq[k], seq[k + 1], vd] for k in range(len(seq) - 1)]
    f_kept = np.delete(f, fi, axis=0)
    return np.vstack([f_kept, np.asarray(new_sub, dtype=np.int64)])


def _clean_and_close_component(
    verts: np.ndarray,
    faces: np.ndarray,
    *,
    _allow_strip: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """Remove degenerate/duplicate/non-manifold elements and seal any remaining boundary loops."""
    v = np.asarray(verts, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    for _ in range(6):
        # 1. Deduplicate coincident vertices quickly in NumPy
        quant = np.rint(v * 1e7).astype(np.int64)
        _, uniq_idx, inv_v = np.unique(quant, axis=0, return_index=True, return_inverse=True)
        if len(uniq_idx) < len(v):
            v = v[uniq_idx]
            f = inv_v[f]

        # 2. Drop degenerate triangles (repeated vertex index or near-zero area)
        valid_idx = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 2] != f[:, 0])
        f = f[valid_idx]
        e1 = v[f[:, 1]] - v[f[:, 0]]
        e2 = v[f[:, 2]] - v[f[:, 0]]
        area2 = np.linalg.norm(np.cross(e1, e2), axis=1)
        f = f[area2 > 1e-16]

        # 3. Drop duplicate triangles (canonical sorted vertex triple)
        _, keep_u = np.unique(np.sort(f, axis=1), axis=0, return_index=True)
        if len(keep_u) < len(f):
            f = f[np.sort(keep_u)]
        v, f, _ = _compact_mesh(v, f)

        # 4. Align half-edge winding & outward orientation before boundary extraction
        he_all = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
        dir_keys = he_all[:, 0].astype(np.uint64) * np.uint64(len(v)) + he_all[:, 1].astype(np.uint64)
        _, d_counts = np.unique(dir_keys, return_counts=True)
        if (d_counts > 1).any():
            f = _fast_fix_winding(f, len(v))

        b_he, b_cnt, nm_cnt = _extract_boundary_edges_fast(f, len(v))
        if nm_cnt > 0:
            he = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
            ue = np.sort(he, axis=1)
            keys = ue[:, 0].astype(np.uint64) * np.uint64(len(v)) + ue[:, 1].astype(np.uint64)
            _, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
            bad_edge = counts[inv] > 2
            bad_face = bad_edge.reshape(3, len(f)).any(axis=0)
            if bad_face.any() and (~bad_face).any():
                f = f[~bad_face]
                v, f, _ = _compact_mesh(v, f)
                b_he, b_cnt, _ = _extract_boundary_edges_fast(f, len(v))
        if b_cnt == 0:
            break

        b_he_set = {(int(u_id), int(v_id)) for u_id, v_id in b_he.tolist()}
        loops = _trace_boundary_loops_from_he(b_he)
        if not loops:
            loops = _trace_undirected_boundary_loops(b_he)
        if not loops:
            break

        pts_xz = v[:, [0, 2]]
        added_verts: list[np.ndarray] = []
        added_tris: list[list[int]] = []
        next_vid = len(v)
        t_healed = False
        for cyc in loops:
            healed = _heal_t_junction_collinear_loop(v, f, cyc)
            if healed is not None:
                f = healed
                t_healed = True
                continue
            if float(np.max(np.abs(v[cyc, 1]))) < 1e-4:
                clipped = _ear_clip_polygon_2d(pts_xz, cyc)
                if clipped:
                    flip_all = _cap_tris_need_flip(clipped, b_he_set, cyc)
                    for tri in clipped:
                        p0, p1, p2 = v[tri[0]], v[tri[1]], v[tri[2]]
                        nrm = np.cross(p1 - p0, p2 - p0)
                        if flip_all is not None:
                            added_tris.append([tri[0], tri[2], tri[1]] if flip_all else tri)
                        else:
                            added_tris.append([tri[0], tri[2], tri[1]] if nrm[1] > 0.0 else tri)
                    continue
            center = v[cyc].mean(axis=0)
            cid = next_vid
            next_vid += 1
            added_verts.append(center)
            k = len(cyc)
            fwd_c = sum(1 for i in range(k) if (int(cyc[i]), int(cyc[(i + 1) % k])) in b_he_set)
            rev_c = sum(1 for i in range(k) if (int(cyc[(i + 1) % k]), int(cyc[i])) in b_he_set)
            oppose_fwd = fwd_c >= rev_c
            for i in range(k):
                u_c, v_c = int(cyc[i]), int(cyc[(i + 1) % k])
                added_tris.append([v_c, u_c, cid] if oppose_fwd else [u_c, v_c, cid])

        if added_verts:
            v = np.vstack([v, np.asarray(added_verts, dtype=np.float64)])
        if added_tris:
            f = np.vstack([f, np.asarray(added_tris, dtype=np.int64)])
        elif not t_healed:
            break

    he_all = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    dir_keys = he_all[:, 0].astype(np.uint64) * np.uint64(len(v)) + he_all[:, 1].astype(np.uint64)
    _, d_counts = np.unique(dir_keys, return_counts=True)
    if (d_counts > 1).any():
        f = _fast_fix_winding(f, len(v))

    v, f, stripped = _strip_duplicate_dir_he_faces(v, f)
    if stripped and _allow_strip:
        return _clean_and_close_component(v, f, _allow_strip=False)

    vc = v - v.mean(axis=0, keepdims=True)
    signed_vol = float(np.sum(vc[f[:, 0]] * np.cross(vc[f[:, 1]], vc[f[:, 2]])) / 6.0)
    if signed_vol < 0.0:
        f = f[:, [0, 2, 1]]
    return v, f


def _complete_component_trimesh_fallback(
    comp_verts: np.ndarray,
    comp_faces: np.ndarray,
    fp_info: dict[str, Any],
) -> tuple[np.ndarray, np.ndarray]:
    """Watertight solid completion fallback using Trimesh + SciPy when Open3D is absent."""
    v = np.asarray(comp_verts, dtype=np.float64).copy()
    f = np.asarray(comp_faces, dtype=np.int64).copy()
    y_min = fp_info["y_min"]
    height = fp_info["height"]
    horiz_span = fp_info["horiz_span"]
    cx, cz = fp_info["cx"], fp_info["cz"]

    b_he, b_cnt, _ = _extract_boundary_edges_fast(f, len(v))
    if b_cnt > 0:
        loops = _trace_boundary_loops_from_he(b_he)
        new_verts: list[np.ndarray] = []
        new_tris: list[list[int]] = []
        next_vid = len(v)
        for cyc in loops:
            pts = v[cyc]
            diam_xz = max(float(pts[:, 0].max() - pts[:, 0].min()), float(pts[:, 2].max() - pts[:, 2].min()))
            loop_y_min = float(pts[:, 1].min())
            if diam_xz < 0.20 * horiz_span and loop_y_min > y_min + 0.25 * height:
                # Internal top hole: close with centroid fan
                center = pts.mean(axis=0)
                cid = next_vid
                next_vid += 1
                new_verts.append(center)
                for i in range(len(cyc)):
                    new_tris.append([cyc[i], cyc[(i + 1) % len(cyc)], cid])
            elif float(pts[:, 1].max()) > 1e-5:
                # Bridge open lower/outer boundary loop smoothly down to y=0.0, then cap flat at y=0.0
                base_ring: list[int] = []
                for vid in cyc:
                    px, py, pz = float(v[vid, 0]), float(v[vid, 1]), float(v[vid, 2])
                    dx, dz = px - cx, pz - cz
                    rb = math.hypot(dx, dz)
                    if rb > 1e-6:
                        ang = math.fmod(math.atan2(dz, dx) + 2.0 * np.pi, 2.0 * np.pi)
                        b_idx = min(len(fp_info["r_rim"]) - 1, int(ang / (2.0 * np.pi) * len(fp_info["r_rim"])))
                        r_cap = float(fp_info["r_rim"][b_idx]) * 0.96
                        r_b_tgt = float(fp_info["r_base"][b_idx])
                        rt = min(rb, r_cap, max(0.60 * rb, r_b_tgt)) if py > 0.02 * height else min(rb, r_cap)
                        bx = cx + dx * (rt / rb)
                        bz = cz + dz * (rt / rb)
                    else:
                        bx, bz = px, pz
                    bid = next_vid
                    next_vid += 1
                    new_verts.append(np.array([bx, 0.0, bz], dtype=np.float64))
                    base_ring.append(bid)
                k = len(cyc)
                for i in range(k):
                    ni = (i + 1) % k
                    new_tris.append([cyc[i], cyc[ni], base_ring[ni]])
                    new_tris.append([cyc[i], base_ring[ni], base_ring[i]])
                all_v_tmp = np.vstack([v, np.asarray(new_verts, dtype=np.float64)])
                clipped = _ear_clip_polygon_2d(all_v_tmp[:, [0, 2]], base_ring)
                ev, tris_split = _orient_and_split_cap_tris(all_v_tmp, clipped)
                new_verts.extend(ev)
                next_vid += len(ev)
                new_tris.extend(tris_split)
            else:
                v[cyc, 1] = 0.0
                all_v_tmp = np.vstack([v, np.asarray(new_verts, dtype=np.float64)]) if new_verts else v
                clipped = _ear_clip_polygon_2d(all_v_tmp[:, [0, 2]], cyc)
                ev, tris_split = _orient_and_split_cap_tris(all_v_tmp, clipped)
                new_verts.extend(ev)
                next_vid += len(ev)
                new_tris.extend(tris_split)
        if new_verts:
            v = np.vstack([v, np.asarray(new_verts, dtype=np.float64)])
        if new_tris:
            f = np.vstack([f, np.asarray(new_tris, dtype=np.int64)])

    if float(v[:, 1].min()) < -1e-5:
        v, f = _slice_and_cap_at_y0(v, f, y_cut=0.0)
    else:
        v[v[:, 1] < 0.0, 1] = 0.0
    v, f = _clean_and_close_component(v, f)
    return _keep_single_largest_shell(v, f)


def _trace_eulerian_cycles(b_he: np.ndarray) -> list[list[int]]:
    """Decompose directed boundary half-edges u->v into simple edge-disjoint cycles."""
    if len(b_he) == 0:
        return []
    adj: dict[int, list[int]] = {}
    for u, v in b_he.tolist():
        adj.setdefault(int(u), []).append(int(v))

    cycles: list[list[int]] = []
    for start_node in list(adj.keys()):
        while adj.get(start_node):
            stack = [start_node]
            path: list[int] = []
            while stack:
                curr = stack[-1]
                nxts = adj.get(curr)
                if nxts:
                    stack.append(nxts.pop())
                else:
                    path.append(stack.pop())
            trail = path[::-1]
            cur_cycle: list[int] = []
            pos: dict[int, int] = {}
            for node in trail:
                if node in pos:
                    idx = pos[node]
                    sub = cur_cycle[idx:]
                    if len(sub) >= 3:
                        cycles.append(sub)
                    for n in sub:
                        if n in pos and pos[n] >= idx:
                            del pos[n]
                    cur_cycle = cur_cycle[:idx]
                pos[node] = len(cur_cycle)
                cur_cycle.append(node)
    return cycles


def _bridge_hierarchical_ring(
    outer_ids: list[int],
    inner_ids: list[int],
    indices: np.ndarray,
    *,
    reverse_winding: bool = False,
) -> list[list[int]]:
    """Bridge an outer ring (n verts) to a reduced inner ring (m verts) with bounded vertex degree."""
    tris: list[list[int]] = []
    n = len(outer_ids)
    m = len(inner_ids)
    for j in range(m):
        j_next = (j + 1) % m
        start_i = int(indices[j])
        end_i = int(indices[j_next])
        if end_i <= start_i:
            end_i += n
        span_ids = [outer_ids[k % n] for k in range(start_i, end_i + 1)]
        w_curr = inner_ids[j]
        w_next = inner_ids[j_next]
        for k in range(len(span_ids) - 1):
            u_c = span_ids[k]
            v_c = span_ids[k + 1]
            tris.append([u_c, v_c, w_curr] if reverse_winding else [v_c, u_c, w_curr])
        tris.append([w_curr, span_ids[-1], w_next] if reverse_winding else [span_ids[-1], w_curr, w_next])
    return tris


def _build_hierarchical_base_cap(
    ring_ids: list[int],
    ring_pts: list[np.ndarray],
    cx: float,
    cz: float,
    next_vid: int,
    *,
    reverse_winding: bool = False,
) -> tuple[list[np.ndarray], list[list[int]]]:
    """Cap a flat y=0 boundary loop via concentric 4:1 hierarchical rings (max degree <= 16)."""
    added_verts: list[np.ndarray] = []
    added_tris: list[list[int]] = []
    cur_ids = list(ring_ids)
    cur_pts = list(ring_pts)

    while len(cur_ids) > 24:
        n = len(cur_ids)
        m = max(16, n // 4)
        indices = np.rint(np.linspace(0, n, m, endpoint=False)).astype(np.int64)
        cur_arr = np.asarray(cur_pts, dtype=np.float64)
        next_ids: list[int] = []
        next_pts: list[np.ndarray] = []
        for j in range(m):
            j_prev = (j - 1) % m
            j_next = (j + 1) % m
            # Smooth zigzag boundary spikes across adjacent sample spans while pulling radially inward
            pts_tri = np.vstack([cur_arr[int(indices[j_prev])], cur_arr[int(indices[j])], cur_arr[int(indices[j_next])]])
            pt = np.array([0.25, 0.50, 0.25], dtype=np.float64) @ pts_tri
            dx_c = float(pt[0] - cx) * 0.72
            dz_c = float(pt[2] - cz) * 0.72
            if next_pts and math.hypot(cx + dx_c - float(next_pts[-1][0]), cz + dz_c - float(next_pts[-1][2])) < 1e-5:
                # Preserve exact azimuth while slightly nudging radius so consecutive vertices never weld
                r_nudge = 0.992 - 0.002 * (j % 5)
                new_pt = np.array([cx + dx_c * r_nudge, 0.0, cz + dz_c * r_nudge], dtype=np.float64)
            else:
                new_pt = np.array([cx + dx_c, 0.0, cz + dz_c], dtype=np.float64)
            nid = next_vid + len(added_verts)
            added_verts.append(new_pt)
            next_ids.append(nid)
            next_pts.append(new_pt)
        added_tris.extend(_bridge_hierarchical_ring(cur_ids, next_ids, indices, reverse_winding=reverse_winding))
        cur_ids = next_ids
        cur_pts = next_pts

    center_id = next_vid + len(added_verts)
    added_verts.append(np.array([cx, 0.0, cz], dtype=np.float64))
    m_final = len(cur_ids)
    for j in range(m_final):
        u_c = cur_ids[j]
        v_c = cur_ids[(j + 1) % m_final]
        added_tris.append([u_c, v_c, center_id] if reverse_winding else [v_c, u_c, center_id])
    return added_verts, added_tris


def _fill_0_winding_hole_curved(
    cyc: list[int],
    pts: np.ndarray,
    cx: float,
    cz: float,
    next_vid: int,
    *,
    horiz_span: float,
) -> tuple[list[np.ndarray], list[list[int]]]:
    """Fill an internal 0-winding boundary loop with hierarchical rings curved along the dish outer wall."""
    center = pts.mean(axis=0)
    diam = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)))
    if len(cyc) <= 24 or diam < 0.05 * horiz_span:
        k = len(cyc)
        tris = [[cyc[(i + 1) % k], cyc[i], next_vid] for i in range(k)]
        return [center], tris

    # Estimate smooth radial profile r(y) from boundary vertices so large wall holes stay convex
    dx_b = pts[:, 0] - cx
    dz_b = pts[:, 2] - cz
    r_b = np.hypot(dx_b, dz_b)
    y_b = pts[:, 1]
    y_lo, y_hi = float(y_b.min()), float(y_b.max())
    r_center = float(np.median(r_b))

    added_verts: list[np.ndarray] = []
    added_tris: list[list[int]] = []
    cur_ids = list(cyc)
    cur_pts = [pts[i] for i in range(len(cyc))]

    for scale_t in (0.65, 0.32):
        n = len(cur_ids)
        if n <= 24:
            break
        m = max(16, n // 3)
        indices = np.rint(np.linspace(0, n, m, endpoint=False)).astype(np.int64)
        next_ids: list[int] = []
        next_pts: list[np.ndarray] = []
        for j in range(m):
            p_edge = cur_pts[int(indices[j])]
            p_lin = center + scale_t * (p_edge - center)
            # Nudge radius outward toward local boundary radius at similar height so curved walls don't flatten
            dy_tol = max(0.15 * (y_hi - y_lo), 1e-4)
            band = np.abs(y_b - p_lin[1]) <= dy_tol
            r_tgt = float(np.quantile(r_b[band], 0.65)) if band.any() else r_center
            dx_p, dz_p = p_lin[0] - cx, p_lin[2] - cz
            r_p = math.hypot(dx_p, dz_p)
            if r_p > 1e-6 and r_tgt > r_p:
                r_blend = r_p + 0.85 * (1.0 - scale_t) * (r_tgt - r_p)
                p_lin[0] = cx + dx_p * (r_blend / r_p)
                p_lin[2] = cz + dz_p * (r_blend / r_p)
            nid = next_vid + len(added_verts)
            added_verts.append(p_lin)
            next_ids.append(nid)
            next_pts.append(p_lin)
        added_tris.extend(_bridge_hierarchical_ring(cur_ids, next_ids, indices, reverse_winding=False))
        cur_ids = next_ids
        cur_pts = next_pts

    # Push center outward slightly along local average radius as well
    dx_c, dz_c = center[0] - cx, center[2] - cz
    r_c = math.hypot(dx_c, dz_c)
    if r_c > 1e-6 and r_center > r_c:
        center = center.copy()
        center[0] = cx + dx_c * (r_center / r_c)
        center[2] = cz + dz_c * (r_center / r_c)
    cid = next_vid + len(added_verts)
    added_verts.append(center)
    m_final = len(cur_ids)
    for j in range(m_final):
        added_tris.append([cur_ids[(j + 1) % m_final], cur_ids[j], cid])
    return added_verts, added_tris


def _complete_component_direct_loft(
    comp_verts: np.ndarray,
    comp_faces: np.ndarray,
    fp_info: dict[str, Any],
) -> tuple[np.ndarray, np.ndarray] | None:
    """Watertight solid completion preserving 100% of crisp TSDF vertices via cycle loft + hierarchical base cap."""
    import trimesh

    v = np.asarray(comp_verts, dtype=np.float64).copy()
    f = np.asarray(comp_faces, dtype=np.int64).copy()
    if len(v) == 0 or len(f) == 0:
        return None

    # Weld any coincident input vertices & drop resulting non-manifold/degenerate faces before tracing cycles
    tm_pre = trimesh.Trimesh(vertices=v, faces=f, process=True)
    v = np.asarray(tm_pre.vertices, dtype=np.float64).copy()
    f = np.asarray(tm_pre.faces, dtype=np.int64).copy()
    _, _, nm_pre = _extract_boundary_edges_fast(f, len(v))
    if nm_pre > 0:
        he_pre = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
        ue_pre = np.sort(he_pre, axis=1)
        keys_pre = ue_pre[:, 0].astype(np.uint64) * np.uint64(len(v)) + ue_pre[:, 1].astype(np.uint64)
        _, inv_p, cnt_p = np.unique(keys_pre, return_inverse=True, return_counts=True)
        bad_f = (cnt_p[inv_p] > 2).reshape(3, len(f)).any(axis=0)
        if bad_f.any() and (~bad_f).any():
            v, f, _ = _compact_mesh(v, f[~bad_f])
    v, f = _keep_single_largest_shell(v, f)
    f = _ensure_outward_normals_yup(v, f)

    height = max(float(fp_info["height"]), 1e-6)
    horiz_span = max(float(fp_info["horiz_span"]), 1e-6)
    cx = float(fp_info["cx"])
    cz = float(fp_info["cz"])

    if float(v[:, 1].min()) < -1e-5:
        v, f = _slice_mesh_at_y0_open(v, f, y_cut=0.0)
    else:
        v[v[:, 1] < 0.0, 1] = 0.0

    b_he, b_cnt, nm_cnt = _extract_boundary_edges_fast(f, len(v))
    if nm_cnt > 0:
        return None
    if b_cnt == 0:
        v, f = _keep_single_largest_shell(v, f)
        return v, f

    cycles = _trace_eulerian_cycles(b_he)
    if not cycles or sum(len(c) for c in cycles) != b_cnt:
        return None

    high_winding_cycles: list[tuple[float, list[int]]] = []
    hole_cycles: list[list[int]] = []
    for cyc in cycles:
        pts = v[cyc]
        angles = np.arctan2(pts[:, 2] - cz, pts[:, 0] - cx)
        d_ang = np.diff(np.unwrap(angles))
        winding = float(np.sum(d_ang) / (2.0 * np.pi)) if len(d_ang) else 0.0
        if abs(winding) >= 0.5:
            high_winding_cycles.append((winding, cyc))
        else:
            hole_cycles.append(cyc)

    if len(high_winding_cycles) > 1:
        return None

    new_verts: list[np.ndarray] = [v[i] for i in range(len(v))]
    new_tris: list[list[int]] = f.tolist()
    next_vid = len(v)

    for cyc in hole_cycles:
        h_verts, h_tris = _fill_0_winding_hole_curved(
            cyc, v[cyc], cx, cz, next_vid, horiz_span=horiz_span
        )
        new_verts.extend(h_verts)
        new_tris.extend(h_tris)
        next_vid += len(h_verts)

    if len(high_winding_cycles) == 1:
        _, main_cycle = high_winding_cycles[0]
        k_main = len(main_cycle)
        pts_main = v[main_cycle]
        on_floor = pts_main[:, 1] <= 1e-4

        # Rotate main_cycle so index 0 is on_floor (if any), simplifying span bridging
        rot_start = int(np.flatnonzero(on_floor)[0]) if on_floor.any() else 0
        if rot_start:
            main_cycle = main_cycle[rot_start:] + main_cycle[:rot_start]
            pts_main = v[main_cycle]
            on_floor = pts_main[:, 1] <= 1e-4

        for vid in np.asarray(main_cycle, dtype=np.int64)[on_floor].tolist():
            new_verts[vid] = np.array([new_verts[vid][0], 0.0, new_verts[vid][2]], dtype=np.float64)

        # Decimate dense elevated boundary runs along XZ arc-spacing (~200-220 verts, ~1.7 deg) so loft/base stay smooth & compact
        if k_main > 256:
            d_xz = np.hypot(np.diff(pts_main[:, 0], append=pts_main[0, 0]), np.diff(pts_main[:, 2], append=pts_main[0, 2]))
            perim_xz = float(np.sum(d_xz))
            min_xz_step = min(0.015 * horiz_span, perim_xz / 220.0)
            kept_idx: list[int] = [0]
            for i in range(1, k_main):
                if on_floor[i]:
                    kept_idx.append(i)
                else:
                    li = kept_idx[-1]
                    if math.hypot(float(pts_main[i, 0] - pts_main[li, 0]), float(pts_main[i, 2] - pts_main[li, 2])) >= min_xz_step:
                        kept_idx.append(i)
            if len(kept_idx) > 12 and not on_floor[kept_idx[-1]] and not on_floor[kept_idx[0]]:
                li, fi_k = kept_idx[-1], kept_idx[0]
                if math.hypot(float(pts_main[fi_k, 0] - pts_main[li, 0]), float(pts_main[fi_k, 2] - pts_main[li, 2])) < min_xz_step:
                    kept_idx.pop()
            if len(kept_idx) < 16:
                kept_idx = sorted(set(np.flatnonzero(on_floor).tolist()) | set(np.rint(np.linspace(0, k_main, min(k_main, 200), endpoint=False)).astype(np.int64).tolist()))
        else:
            kept_idx = list(range(k_main))

        m_kept = len(kept_idx)
        kept_arr = np.asarray(kept_idx, dtype=np.int64)
        kept_pts = pts_main[kept_arr]
        kept_floor = on_floor[kept_arr]
        kept_orig_ids = [main_cycle[i] for i in kept_idx]

        dx_m = kept_pts[:, 0] - cx
        dz_m = kept_pts[:, 2] - cz
        r_m = np.hypot(dx_m, dz_m)
        ang_m = np.mod(np.arctan2(dz_m, dx_m), 2.0 * np.pi)

        ang_ext = np.concatenate([fp_info["thetas"] - 2.0 * np.pi, fp_info["thetas"], fp_info["thetas"] + 2.0 * np.pi])
        r_base_ext = np.concatenate([fp_info["r_base"], fp_info["r_base"], fp_info["r_base"]])
        r_base_target = np.interp(ang_m, ang_ext, r_base_ext)

        # Clamp outward protrusions directly to r_base_target and smooth all base ring vertices (including kept_floor)
        r_floor = np.where(r_m > r_base_target, r_base_target, np.maximum(0.65 * r_m, r_base_target * 0.95))
        scale_m = r_floor / np.maximum(r_m, 1e-6)
        target_xz = np.column_stack([cx + dx_m * scale_m, cz + dz_m * scale_m])
        if m_kept >= 8:
            sm_target = target_xz.copy()
            for _ in range(2):
                sm_target = 0.25 * np.roll(sm_target, 1, axis=0) + 0.50 * sm_target + 0.25 * np.roll(sm_target, -1, axis=0)
            target_xz = sm_target
        for j in range(m_kept):
            if kept_floor[j]:
                new_verts[kept_orig_ids[j]] = np.array([float(target_xz[j, 0]), 0.0, float(target_xz[j, 1])], dtype=np.float64)

        max_drop = float(np.max(kept_pts[:, 1]))
        step_h = max(0.020 * (horiz_span / 0.24), 0.005)
        n_rows = max(1, min(4, int(math.ceil(max_drop / step_h)))) if max_drop > 1e-4 else 1

        # Row 1: bridge full high-res main_cycle spans -> reduced kept ring_1 cleanly (100% manifold across all on_floor combinations)
        frac_1 = 1.0 / n_rows
        ring1_ids: list[int] = []
        for j in range(m_kept):
            if kept_floor[j]:
                ring1_ids.append(kept_orig_ids[j])
            else:
                py = 0.0 if n_rows == 1 else float(kept_pts[j, 1]) * (1.0 - frac_1)
                px = float(kept_pts[j, 0]) * (1.0 - frac_1) + float(target_xz[j, 0]) * frac_1
                pz = float(kept_pts[j, 2]) * (1.0 - frac_1) + float(target_xz[j, 1]) * frac_1
                nid = next_vid
                next_vid += 1
                new_verts.append(np.array([px, py, pz], dtype=np.float64))
                ring1_ids.append(nid)

        for j in range(m_kept):
            start_k = kept_idx[j]
            end_k = kept_idx[j + 1] if (j + 1) < m_kept else k_main
            span = [main_cycle[k % k_main] for k in range(start_k, end_k + 1)]
            w_curr = ring1_ids[j]
            w_next = ring1_ids[(j + 1) % m_kept]
            s = len(span) - 1
            for k in range(s):
                if k == 0 and w_curr == span[0]:
                    continue
                new_tris.append([span[k + 1], span[k], w_curr])
            if w_next != span[-1]:
                new_tris.append([span[-1], w_curr, w_next])

        prev_ids = ring1_ids
        for row_idx in range(2, n_rows + 1):
            frac = row_idx / n_rows
            curr_ids: list[int] = []
            for j in range(m_kept):
                if kept_floor[j]:
                    curr_ids.append(kept_orig_ids[j])
                else:
                    py = 0.0 if row_idx == n_rows else float(kept_pts[j, 1]) * (1.0 - frac)
                    px = float(kept_pts[j, 0]) * (1.0 - frac) + float(target_xz[j, 0]) * frac
                    pz = float(kept_pts[j, 2]) * (1.0 - frac) + float(target_xz[j, 1]) * frac
                    nid = next_vid
                    next_vid += 1
                    new_verts.append(np.array([px, py, pz], dtype=np.float64))
                    curr_ids.append(nid)
            for j in range(m_kept):
                nj = (j + 1) % m_kept
                u_t, v_t = prev_ids[j], prev_ids[nj]
                u_b, v_b = curr_ids[j], curr_ids[nj]
                if u_t == u_b and v_t == v_b:
                    continue
                if u_t == u_b:
                    new_tris.append([v_t, u_t, v_b])
                elif v_t == v_b:
                    new_tris.append([v_t, u_t, u_b])
                else:
                    new_tris.append([v_t, u_t, u_b])
                    new_tris.append([v_t, u_b, v_b])
            prev_ids = curr_ids

        base_ring_ids = prev_ids
        base_ring_pts = [new_verts[vid] for vid in base_ring_ids]
        br_arr = np.asarray(base_ring_pts, dtype=np.float64)
        bx_a, bz_a = br_arr[:, 0], br_arr[:, 2]
        signed_area_xz = 0.5 * float(np.sum(bx_a * np.roll(bz_a, -1) - np.roll(bx_a, -1) * bz_a))
        # _bridge_hierarchical_ring([v_c, u_c, w_curr]) produces -Y normal when base_ring is CCW from above (signed_area_xz < 0)
        rev_cap = signed_area_xz > 0.0
        cap_verts, cap_tris = _build_hierarchical_base_cap(
            base_ring_ids, base_ring_pts, cx, cz, next_vid, reverse_winding=rev_cap
        )
        new_verts.extend(cap_verts)
        new_tris.extend(cap_tris)

    out_v = np.asarray(new_verts, dtype=np.float64)
    out_f = np.asarray(new_tris, dtype=np.int64)
    out_v, out_f = _keep_single_largest_shell(out_v, out_f)
    _, bc_chk, nm_chk = _extract_boundary_edges_fast(out_f, len(out_v))
    if bc_chk != 0 or nm_chk != 0:
        out_v, out_f = _clean_and_close_component(out_v, out_f)
        out_v, out_f = _keep_single_largest_shell(out_v, out_f)
        _, bc_chk, nm_chk = _extract_boundary_edges_fast(out_f, len(out_v))
    if bc_chk != 0 or nm_chk != 0:
        return None
    vc = out_v - out_v.mean(axis=0, keepdims=True)
    if float(np.sum(vc[out_f[:, 0]] * np.cross(vc[out_f[:, 1]], vc[out_f[:, 2]])) / 6.0) < 0.0:
        out_f = out_f[:, [0, 2, 1]]
    tm_w_chk = trimesh.Trimesh(vertices=out_v, faces=out_f, process=True)
    wv_c = np.asarray(tm_w_chk.vertices, dtype=np.float64)
    wf_c = np.asarray(tm_w_chk.faces, dtype=np.int64)
    _, w_bc, w_nm = _extract_boundary_edges_fast(wf_c, len(wv_c))
    if w_bc != 0 or w_nm != 0 or not tm_w_chk.is_watertight or not tm_w_chk.is_volume:
        out_v, out_f = _clean_and_close_component(wv_c, wf_c)
        out_v, out_f = _keep_single_largest_shell(out_v, out_f)
        tm_w_chk2 = trimesh.Trimesh(vertices=out_v, faces=out_f, process=True)
        if not (tm_w_chk2.is_watertight and tm_w_chk2.is_volume):
            return None
    return out_v, out_f


def _complete_component_open3d(
    comp_verts: np.ndarray,
    comp_faces: np.ndarray,
    fp_info: dict[str, Any],
    poisson_depth: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Watertight solid completion using Open3D Screened Poisson + contour-guided tapered skirt + flat base."""
    import open3d as o3d
    from scipy import ndimage

    v = np.asarray(comp_verts, dtype=np.float64)
    f = np.asarray(comp_faces, dtype=np.int64)
    y_min = fp_info["y_min"]
    y_max = fp_info["y_max"]
    height = fp_info["height"]
    horiz_span = fp_info["horiz_span"]
    cx, cz = fp_info["cx"], fp_info["cz"]
    x0, z0 = fp_info["x0"], fp_info["z0"]
    cell_x, cell_z = fp_info["cell_x"], fp_info["cell_z"]
    n_grid = fp_info["n_grid"]
    footprint = fp_info["footprint"]

    # 1. Surface point cloud from outward-oriented mesh, filtered to cleaned XZ footprint
    o3d_surf = o3d.geometry.TriangleMesh()
    o3d_surf.vertices = o3d.utility.Vector3dVector(v)
    o3d_surf.triangles = o3d.utility.Vector3iVector(f)
    o3d_surf.compute_vertex_normals()
    n_surf = max(25_000, min(280_000, len(f) // 2 + 25_000))
    pcd_surf = o3d_surf.sample_points_uniformly(number_of_points=n_surf)
    surf_pts = np.asarray(pcd_surf.points, dtype=np.float64)
    surf_nrm = np.asarray(pcd_surf.normals, dtype=np.float64)
    if len(v) <= 40_000:
        v_nrm = np.asarray(o3d_surf.vertex_normals, dtype=np.float64)
        surf_pts = np.vstack([surf_pts, v])
        surf_nrm = np.vstack([surf_nrm, v_nrm])

    sp_x = np.clip(np.rint((surf_pts[:, 0] - x0) / cell_x).astype(np.int32), 0, n_grid - 1)
    sp_z = np.clip(np.rint((surf_pts[:, 2] - z0) / cell_z).astype(np.int32), 0, n_grid - 1)
    in_env = fp_info["dist_out"][sp_x, sp_z] <= (0.012 * horiz_span)
    if in_env.any():
        surf_pts = surf_pts[in_env]
        surf_nrm = surf_nrm[in_env]

    # 2. Smooth contour-guided inward-tapered synthetic lower wall ONLY on eroded/open perimeter arcs
    thetas = fp_info["thetas"]
    n_bins = len(thetas)
    eroded_sector = fp_info["y_low_obs"] > (y_min + 0.05 * height)
    skirt_pts_list: list[np.ndarray] = []
    skirt_nrm_list: list[np.ndarray] = []

    if eroded_sector.any():
        # Subsample densely (540 angles) so eroded perimeter arcs have uniform azimuthal spacing
        n_dense = 540
        dense_thetas = np.linspace(0.0, 2.0 * np.pi, n_dense, endpoint=False)
        idx_ext = np.concatenate([np.arange(n_bins) - n_bins, np.arange(n_bins), np.arange(n_bins) + n_bins])
        ang_ext = np.concatenate([thetas - 2.0 * np.pi, thetas, thetas + 2.0 * np.pi])

        def _interp_periodic(arr: np.ndarray) -> np.ndarray:
            arr_ext = np.concatenate([arr, arr, arr])
            return np.interp(dense_thetas, ang_ext, arr_ext)

        r_top_d = _interp_periodic(fp_info["r_top_edge"])
        r_bot_d = _interp_periodic(fp_info["r_base"])
        y_top_d = np.clip(_interp_periodic(fp_info["y_low_edge"]), 0.02 * height, y_max)
        nx_d = _interp_periodic(fp_info["nx_rim"])
        nz_d = _interp_periodic(fp_info["nz_rim"])
        n_d_len = np.maximum(np.hypot(nx_d, nz_d), 1e-8)
        nx_d /= n_d_len
        nz_d /= n_d_len

        # Map each dense angle to nearest sector's eroded flag
        sec_idx = np.rint(dense_thetas / (2.0 * np.pi) * n_bins).astype(np.int32) % n_bins
        eroded_d = eroded_sector[sec_idx]
        if eroded_d.any():
            cos_d = np.cos(dense_thetas[eroded_d])
            sin_d = np.sin(dense_thetas[eroded_d])
            rt = r_top_d[eroded_d]
            rb = np.minimum(rt, r_bot_d[eroded_d])
            yt = y_top_d[eroded_d]
            nx = nx_d[eroded_d]
            nz = nz_d[eroded_d]

            p_top = np.stack([cx + rt * cos_d, yt, cz + rt * sin_d], axis=1)
            p_bot = np.stack([cx + rb * cos_d, np.zeros_like(rb), cz + rb * sin_d], axis=1)
            dr = rb - rt  # <= 0 inward taper
            n_sk = np.stack([yt * nx, dr, yt * nz], axis=1)
            n_sk /= np.maximum(np.linalg.norm(n_sk, axis=1, keepdims=True), 1e-9)

            step_h = max(0.010 * horiz_span, 0.0015)
            n_steps = min(32, max(4, int(math.ceil(float(yt.max()) / step_h))))
            for t_val in np.linspace(0.0, 1.0, n_steps, endpoint=True)[1:]:
                skirt_pts_list.append(p_top * (1.0 - t_val) + p_bot * t_val)
                skirt_nrm_list.append(n_sk)

    # 3. Dense flat table-contact base points strictly inside footprint_clean at y=0.0
    gx_arr = x0 + np.arange(n_grid, dtype=np.float64) * cell_x
    gz_arr = z0 + np.arange(n_grid, dtype=np.float64) * cell_z
    gxx, gzz = np.meshgrid(gx_arr, gz_arr, indexing="ij")
    dx_g = gxx - cx
    dz_g = gzz - cz
    r_g = np.hypot(dx_g, dz_g)
    ang_g = np.mod(np.arctan2(dz_g, dx_g), 2.0 * np.pi)
    ang_ext = np.concatenate([thetas - 2.0 * np.pi, thetas, thetas + 2.0 * np.pi])
    r_base_ext = np.concatenate([fp_info["r_base"], fp_info["r_base"], fp_info["r_base"]])
    r_base_g = np.interp(ang_g, ang_ext, r_base_ext)
    base_fp = footprint & (r_g <= r_base_g)

    low_v_mask = v[:, 1] <= (y_min + max(0.025 * height, 0.004 * horiz_span))
    if low_v_mask.any():
        lx = np.clip(np.rint((v[low_v_mask, 0] - x0) / cell_x).astype(np.int32), 0, n_grid - 1)
        lz = np.clip(np.rint((v[low_v_mask, 2] - z0) / cell_z).astype(np.int32), 0, n_grid - 1)
        base_fp[lx, lz] = True
    base_fp &= footprint
    if base_fp.any():
        yy, xx = np.ogrid[-2:3, -2:3]
        disk2 = (xx * xx + yy * yy) <= 5
        base_fp = ndimage.binary_closing(base_fp, structure=disk2)
        base_fp = ndimage.binary_fill_holes(base_fp) & footprint
    else:
        base_fp = footprint

    b_ix, b_iz = np.nonzero(base_fp)
    base_pts = np.stack(
        [x0 + b_ix.astype(np.float64) * cell_x, np.zeros(len(b_ix), dtype=np.float64), z0 + b_iz.astype(np.float64) * cell_z],
        axis=1,
    )
    base_nrm = np.tile(np.array([[0.0, -1.0, 0.0]], dtype=np.float64), (len(base_pts), 1))

    all_pts_arr = np.vstack([surf_pts, *skirt_pts_list, base_pts])
    all_nrm_arr = np.vstack([surf_nrm, *skirt_nrm_list, base_nrm])
    pcd_all = o3d.geometry.PointCloud()
    pcd_all.points = o3d.utility.Vector3dVector(all_pts_arr)
    pcd_all.normals = o3d.utility.Vector3dVector(all_nrm_arr)
    pcd_all.normalize_normals()

    # 4. Open3D Screened Poisson reconstruction (single-threaded for small/unit meshes to avoid OpenMP races)
    n_poisson_threads = 1 if (int(poisson_depth) <= 7 or len(all_pts_arr) < 60_000) else min(4, max(1, os.cpu_count() or 1))
    mesh_p, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd_all, depth=int(poisson_depth), width=0, scale=1.1, linear_fit=False, n_threads=n_poisson_threads
    )
    p_verts = np.asarray(mesh_p.vertices, dtype=np.float64)
    p_faces = np.asarray(mesh_p.triangles, dtype=np.int64)
    dens = np.asarray(densities, dtype=np.float64)

    # Prune low-density extrapolation and any vertices outside the footprint/height envelope
    if len(dens) == len(p_verts) and len(p_verts) > 0:
        px = np.clip(np.rint((p_verts[:, 0] - x0) / cell_x).astype(np.int32), 0, n_grid - 1)
        pz = np.clip(np.rint((p_verts[:, 2] - z0) / cell_z).astype(np.int32), 0, n_grid - 1)
        d_out = fp_info["dist_out"][px, pz]
        out_env = (d_out > 0.02 * horiz_span) | (p_verts[:, 1] < -0.05 * height) | (p_verts[:, 1] > y_max + 0.02 * height)
        low_dens = dens < float(np.quantile(dens, 0.02))
        drop_v = out_env | (low_dens & (d_out > 0.005 * horiz_span))
        if drop_v.any():
            keep_f = ~drop_v[p_faces].any(axis=1)
            if keep_f.any():
                p_verts, p_faces, _ = _compact_mesh(p_verts, p_faces[keep_f])

    # Keep strictly single largest connected component
    p_verts, p_faces = _keep_single_largest_shell(p_verts, p_faces)

    o3d_clean = o3d.geometry.TriangleMesh()
    o3d_clean.vertices = o3d.utility.Vector3dVector(p_verts)
    o3d_clean.triangles = o3d.utility.Vector3iVector(p_faces)
    o3d_clean.remove_degenerate_triangles()
    o3d_clean.remove_duplicated_triangles()
    o3d_clean.remove_duplicated_vertices()
    o3d_clean.remove_non_manifold_edges()
    p_verts = np.asarray(o3d_clean.vertices, dtype=np.float64)
    p_faces = np.asarray(o3d_clean.triangles, dtype=np.int64)

    # Seal any small hole created by outlier filtering before slicing bottom flat at y=0.0
    p_verts, p_faces = _clean_and_close_component(p_verts, p_faces)

    # Flatten/slice bottom flush at y=0.0 without re-opening holes
    p_y_min = float(p_verts[:, 1].min())
    if 0.0 < p_y_min <= 0.01 * height:
        p_verts[:, 1] -= p_y_min
    if float(p_verts[:, 1].min()) < -1e-5:
        y_cut = min(3e-4, 0.005 * height)
        p_verts, p_faces = _slice_and_cap_at_y0(p_verts, p_faces, y_cut=y_cut)
    else:
        p_verts[p_verts[:, 1] < 0.0, 1] = 0.0

    p_verts, p_faces = _clean_and_close_component(p_verts, p_faces)
    p_verts, p_faces = _keep_single_largest_shell(p_verts, p_faces)
    if len(p_faces) > 0:
        he_chk = np.vstack([p_faces[:, [0, 1]], p_faces[:, [1, 2]], p_faces[:, [2, 0]]])
        dk_chk = he_chk[:, 0].astype(np.uint64) * np.uint64(len(p_verts)) + he_chk[:, 1].astype(np.uint64)
        if (np.unique(dk_chk, return_counts=True)[1] > 1).any():
            p_faces = _fast_fix_winding(p_faces, len(p_verts))
        if float(np.sum(p_verts[p_faces[:, 0]] * np.cross(p_verts[p_faces[:, 1]], p_verts[p_faces[:, 2]])) / 6.0) < 0.0:
            p_faces = p_faces[:, [0, 2, 1]]
    return p_verts, p_faces


def complete_solid_mesh(
    verts: np.ndarray,
    faces: np.ndarray,
    colors: np.ndarray | None = None,
    *,
    up_axis_index: int = 1,
    poisson_depth: int = 9,
    keep_multi_components: bool = False,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, dict[str, Any]]:
    """Complete an open/eroded mesh into a watertight manifold solid seated flush at y=0.0."""
    import trimesh
    from scipy.spatial import cKDTree

    v_in = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
    f_in = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    if len(v_in) == 0 or len(f_in) == 0:
        raise ValueError("Cannot complete empty mesh")
    faces_before = int(len(f_in))

    c_in: np.ndarray | None = None
    if colors is not None:
        c_arr = np.asarray(colors, dtype=np.float64)
        if len(c_arr) == len(v_in):
            c_in = c_arr[:, :3].copy()
            if float(c_in.max()) > 1.0:
                c_in /= 255.0
            c_in = np.clip(c_in, 0.0, 1.0)

    # Permute axes internally if up_axis_index != 1 so Y is always up
    if up_axis_index != 1:
        perm = [ax for ax in (0, 1, 2) if ax != up_axis_index]
        perm = [perm[0], up_axis_index, perm[1]]
        inv_perm = [perm.index(0), perm.index(1), perm.index(2)]
        v_work = v_in[:, perm].copy()
    else:
        inv_perm = None
        v_work = v_in.copy()

    # Filter tiny floaters / bottom table slabs; keep multiple components only when requested
    v_filt, f_filt, filt_stats = filter_mesh_components(
        v_work,
        f_in,
        min_face_fraction=(0.05 if keep_multi_components else 0.02),
        table_height_ratio=0.06,
        table_footprint_ratio=0.75,
        keep_main_only=not keep_multi_components,
        up_axis_index=1,
    )
    kept_idx = filt_stats.pop("kept_vertex_indices")
    c_filt = c_in[kept_idx] if c_in is not None else None

    y_min_global = float(v_filt[:, 1].min())
    if y_min_global < -1e-4:
        v_filt[:, 1] -= y_min_global
    elif y_min_global < 0.0:
        v_filt[v_filt[:, 1] < 0.0, 1] = 0.0

    # Split into disjoint kept components only when keep_multi_components=True
    if keep_multi_components:
        tm_split = trimesh.Trimesh(vertices=v_filt, faces=f_filt, process=False)
        comps_raw = sorted(tm_split.split(only_watertight=False), key=lambda m: len(m.faces), reverse=True)
        comp_pairs = [(np.asarray(c.vertices, dtype=np.float64).copy(), np.asarray(c.faces, dtype=np.int64).copy()) for c in comps_raw]
        comp_verts_indices_list = None
    else:
        comp_pairs = [(v_filt, f_filt)]
        comp_verts_indices_list = None

    try:
        import open3d  # noqa: F401
        has_open3d = True
    except ImportError:
        has_open3d = False

    out_verts_list: list[np.ndarray] = []
    out_faces_list: list[np.ndarray] = []
    out_colors_list: list[np.ndarray] = []
    v_offset = 0

    for cv, cf in comp_pairs:
        if len(cv) == 0 or len(cf) == 0:
            continue
        cf = _ensure_outward_normals_yup(cv, cf)
        fp_info = _build_xz_footprint_and_rim(cv, cf, n_grid=192)

        direct_res = _complete_component_direct_loft(cv, cf, fp_info)
        if direct_res is not None:
            sv, sf = direct_res
            tm_chk = trimesh.Trimesh(vertices=sv, faces=sf, process=False)
            if not (tm_chk.is_watertight and tm_chk.is_volume):
                direct_res = None
        if direct_res is None:
            if has_open3d:
                sv, sf = _complete_component_open3d(cv, cf, fp_info, int(poisson_depth))
            else:
                sv, sf = _complete_component_trimesh_fallback(cv, cf, fp_info)

        out_verts_list.append(sv)
        out_faces_list.append(sf + v_offset)
        v_offset += len(sv)

        if c_filt is not None:
            # Map component colors cleanly via nearest vertex on v_filt if multi-component, or c_filt directly
            if keep_multi_components:
                tree_comp_c = cKDTree(v_filt)
                _, idx_cc = tree_comp_c.query(cv)
                c_comp = c_filt[idx_cc]
            else:
                c_comp = c_filt

            tree_full = cKDTree(cv)
            _, nn_full = tree_full.query(sv)
            sc = c_comp[nn_full].copy()

            # Sample original triangle interiors on sparser meshes so smooth original triangles are never flagged as synthetic
            if len(cf) <= 40_000:
                v0, v1, v2 = cv[cf[:, 0]], cv[cf[:, 1]], cv[cf[:, 2]]
                orig_pts = np.vstack(
                    [
                        cv,
                        0.5 * (v0 + v1),
                        0.5 * (v1 + v2),
                        0.5 * (v2 + v0),
                        (v0 + v1 + v2) / 3.0,
                        0.6 * v0 + 0.2 * v1 + 0.2 * v2,
                        0.2 * v0 + 0.6 * v1 + 0.2 * v2,
                        0.2 * v0 + 0.2 * v1 + 0.6 * v2,
                    ]
                )
                dist_to_orig, _ = cKDTree(orig_pts).query(sv)
            else:
                dist_to_orig, _ = tree_full.query(sv)

            tm_s = trimesh.Trimesh(vertices=sv, faces=sf, process=False)
            fn_s = np.asarray(tm_s.face_normals, dtype=np.float64)
            vn_s = np.asarray(tm_s.vertex_normals, dtype=np.float64)
            down_faces = fn_s[:, 1] < -0.75
            down_verts = vn_s[:, 1] < -0.75
            if down_faces.any():
                down_verts[sf[down_faces].ravel()] = True

            cv_ymin = float(cv[:, 1].min())
            cv_h = max(float(cv[:, 1].max() - cv_ymin), 1e-6)
            r_cv = np.hypot(cv[:, 0] - fp_info["cx"], cv[:, 2] - fp_info["cz"])
            r_local_max = float(np.quantile(r_cv, 0.90)) if len(r_cv) else 0.0
            rim_ext_cand = (cv[:, 1] <= (cv_ymin + 0.30 * cv_h)) & (r_cv >= 0.70 * r_local_max)
            if not rim_ext_cand.any():
                rim_ext_cand = cv[:, 1] <= (cv_ymin + 0.30 * cv_h)
            if not rim_ext_cand.any():
                rim_ext_cand = cv[:, 1] <= np.quantile(cv[:, 1], 0.15)
            # Reject chroma/hue outliers (e.g., orange table reflections) from exterior rim color candidates
            cand_idx = np.flatnonzero(rim_ext_cand)
            if len(cand_idx) >= 16:
                rc = c_comp[cand_idx]
                med_col = np.median(rc, axis=0)
                chr_val = np.max(rc, axis=1) - np.min(rc, axis=1)
                med_chr = float(np.median(chr_val))
                mad_chr = float(np.median(np.abs(chr_val - med_chr)))
                col_dist = np.linalg.norm(rc - med_col[None, :], axis=1)
                med_dist = float(np.median(col_dist))
                mad_dist = float(np.median(np.abs(col_dist - med_dist)))
                inliers = (
                    (chr_val <= max(med_chr + 2.5 * max(mad_chr, 0.02), med_chr + 0.08))
                    & (col_dist <= max(med_dist + 2.5 * max(mad_dist, 0.02), 0.15))
                )
                if int(np.count_nonzero(inliers)) >= max(8, int(0.10 * len(cand_idx))):
                    clean_mask = np.zeros_like(rim_ext_cand)
                    clean_mask[cand_idx[inliers]] = True
                    rim_ext_cand = clean_mask
            tree_rim_ext = cKDTree(cv[rim_ext_cand])

            # Newly synthesized wall/skirt vertices must sample from intact lower-exterior rim, never interior food
            synth_wall = (dist_to_orig > 0.015 * fp_info["horiz_span"]) & (~down_verts)
            if synth_wall.any():
                _, nn_ext = tree_rim_ext.query(sv[synth_wall])
                sc[synth_wall] = c_comp[rim_ext_cand][nn_ext]

            if down_verts.any():
                _, nn_rim = tree_rim_ext.query(sv[down_verts])
                rim_cols = c_comp[rim_ext_cand][nn_rim]
                # Darken/mute lower-rim tone slightly so base never glows brighter than the rim
                sc[down_verts] = np.clip(rim_cols * 0.65, 0.03, 0.45)
            out_colors_list.append(sc)

    if not out_verts_list:
        raise RuntimeError("complete_solid_mesh produced no valid solid components")

    expected_shells = len(out_verts_list) if keep_multi_components else 1
    verts_out = np.vstack(out_verts_list)
    faces_out = np.vstack(out_faces_list)
    colors_out = np.vstack(out_colors_list) if c_filt is not None else None

    if inv_perm is not None:
        verts_out = verts_out[:, inv_perm]

    tm_verify = trimesh.Trimesh(vertices=verts_out, faces=faces_out, process=False)
    _, boundary_edges, non_manifold_edges = _extract_boundary_edges_fast(faces_out, len(verts_out))
    is_watertight = bool(tm_verify.is_watertight)
    is_volume = bool(tm_verify.is_volume)

    shell_count, _ = _face_shell_labels(faces_out)

    # Verify welded vertex copy too so duplicate vertices cannot mask holes or extra shells
    tm_welded = trimesh.Trimesh(vertices=verts_out, faces=faces_out, process=True)
    w_verts = np.asarray(tm_welded.vertices, dtype=np.float64)
    w_faces = np.asarray(tm_welded.faces, dtype=np.int64)
    _, w_boundary_edges, w_non_manifold_edges = _extract_boundary_edges_fast(w_faces, len(w_verts))
    w_shell_count, _ = _face_shell_labels(w_faces)
    w_is_watertight = bool(tm_welded.is_watertight)
    w_is_volume = bool(tm_welded.is_volume)

    if (
        not is_watertight
        or not w_is_watertight
        or not is_volume
        or not w_is_volume
        or boundary_edges != 0
        or w_boundary_edges != 0
        or non_manifold_edges != 0
        or w_non_manifold_edges != 0
        or shell_count != expected_shells
        or w_shell_count != expected_shells
    ):
        raise RuntimeError(
            f"complete_solid_mesh failed watertight verification: "
            f"is_watertight={is_watertight}/{w_is_watertight}, "
            f"is_volume={is_volume}/{w_is_volume}, "
            f"boundary_edges={boundary_edges}/{w_boundary_edges}, "
            f"non_manifold_edges={non_manifold_edges}/{w_non_manifold_edges}, "
            f"shell_count={shell_count}/{w_shell_count} (expected {expected_shells})"
        )

    stats = {
        "is_watertight": is_watertight,
        "is_volume": is_volume,
        "boundary_edges": int(boundary_edges),
        "non_manifold_edges": int(non_manifold_edges),
        "shell_count": int(shell_count),
        "faces_before": faces_before,
        "faces_after": int(len(faces_out)),
        "poisson_depth": int(poisson_depth),
    }
    return verts_out, faces_out, colors_out, stats


def _resolve_frame_mask_path(dataset_dir: Path, frame: dict[str, Any]) -> Path:
    """Resolve per-frame foreground mask path, falling back from eval_mask_path to mask_path."""
    rel = frame.get("eval_mask_path") or frame.get("mask_path")
    if not rel:
        raise RuntimeError(f"Frame missing both eval_mask_path and mask_path: {frame.get('file_path')}")
    return dataset_dir / rel


def prepare_qa_cutout_from_train(dataset_dir: Path, out_cutout_path: Path) -> Path:
    """Return an RGBA cutout path from transforms_train.json frame 0 (combining RGB+mask if needed)."""
    train_json = dataset_dir / "transforms_train.json"
    frames = json.loads(train_json.read_text(encoding="utf-8"))["frames"]
    if not frames:
        raise RuntimeError(f"No frames in {train_json}")
    frame = frames[0]
    img_path = dataset_dir / frame["file_path"]
    with Image.open(img_path) as im:
        has_alpha_band = im.mode in ("RGBA", "LA", "PA")
        rgba = im.convert("RGBA")
        arr = np.asarray(rgba, dtype=np.uint8)
        alpha = arr[..., 3]
        if has_alpha_band and int(alpha.min()) < 250 and bool((alpha > 127).any()):
            if img_path.suffix.lower() == ".png":
                return img_path
            out_cutout_path.parent.mkdir(parents=True, exist_ok=True)
            rgba.save(out_cutout_path, format="PNG")
            return out_cutout_path

    mask_path = _resolve_frame_mask_path(dataset_dir, frame)
    with Image.open(mask_path) as mk:
        mk_l = mk.convert("L")
        if mk_l.size != (arr.shape[1], arr.shape[0]):
            mk_l = mk_l.resize((arr.shape[1], arr.shape[0]), Image.Resampling.NEAREST)
        mk_arr = np.asarray(mk_l, dtype=np.uint8)
    fg = mk_arr > 127
    out_arr = arr.copy()
    out_arr[~fg, :3] = 0
    out_arr[..., 3] = np.where(fg, 255, 0).astype(np.uint8)
    out_cutout_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out_arr, mode="RGBA").save(out_cutout_path, format="PNG")
    return out_cutout_path


def _squeeze_single_batch(arr: Any, target_ndim: int, name: str) -> Any:
    """Normalize [1, ...] or [...] arrays/tensors to target_ndim without slicing spatial rows."""
    if arr.ndim == target_ndim:
        return arr
    if arr.ndim == target_ndim + 1 and arr.shape[0] == 1:
        return arr[0]
    raise ValueError(f"Expected {name} with ndim {target_ndim} or [1, ...], got shape {tuple(arr.shape)}")


def normalize_2dgs_geometry_tensors(
    render_normals: Any,
    normals_from_depth: Any,
    render_distort: Any,
    alpha_pred: Any,
) -> tuple[Any, Any, Any, Any]:
    """Normalize gsplat rasterization_2dgs C=1 geometry outputs to matching [H, W, ...] shapes."""
    alpha = _squeeze_single_batch(alpha_pred, 2, "alpha_pred")
    if alpha.ndim == 3 and alpha.shape[-1] == 1:
        alpha = alpha[..., 0]
    n_pred = _squeeze_single_batch(render_normals, 3, "render_normals")
    n_surf = _squeeze_single_batch(normals_from_depth, 3, "normals_from_depth")
    if render_distort.ndim == 4 and render_distort.shape[0] == 1 and render_distort.shape[-1] == 1:
        distort = render_distort[0, ..., 0]
    elif render_distort.ndim == 3 and render_distort.shape[-1] == 1:
        distort = render_distort[..., 0]
    else:
        distort = _squeeze_single_batch(render_distort, 2, "render_distort")

    if n_pred.shape != n_surf.shape or n_pred.shape[-1] != 3:
        raise ValueError(
            f"Normal shape mismatch: render_normals={tuple(n_pred.shape)}, normals_from_depth={tuple(n_surf.shape)}"
        )
    if n_pred.shape[:2] != alpha.shape or distort.shape != alpha.shape:
        raise ValueError(
            f"Spatial shape mismatch: alpha={tuple(alpha.shape)}, normals={tuple(n_pred.shape)}, distort={tuple(distort.shape)}"
        )
    return n_pred, n_surf, distort, alpha


def compute_2dgs_geometry_losses(
    render_normals: Any,
    normals_from_depth: Any,
    render_distort: Any,
    alpha_pred: Any,
    *,
    normal_weight: float = 0.05,
    distort_weight: float = 0.5,
) -> tuple[Any, dict[str, float]]:
    """Compute alpha-weighted 2DGS normal-consistency and depth-distortion losses (torch or numpy)."""
    n_pred, n_surf, distort, alpha = normalize_2dgs_geometry_tensors(
        render_normals, normals_from_depth, render_distort, alpha_pred
    )
    alpha_w = alpha.detach() if hasattr(alpha, "detach") else alpha
    surf_valid = (n_surf * n_surf).sum(-1) > 0.25
    normal_err = (1.0 - (n_pred * n_surf).sum(-1)) * alpha_w * surf_valid
    distort_err = distort * alpha_w
    normal_loss = normal_err.mean()
    distort_loss = distort_err.mean()
    total = float(normal_weight) * normal_loss + float(distort_weight) * distort_loss
    stats = {
        "normal_loss": float(normal_loss.detach().item() if hasattr(normal_loss, "detach") else normal_loss),
        "distort_loss": float(distort_loss.detach().item() if hasattr(distort_loss, "detach") else distort_loss),
    }
    return total, stats


def sample_unpremultiplied_bilinear(
    rgba: np.ndarray,
    uv_coords: np.ndarray,
    *,
    min_alpha: float = 0.95,
    mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Sample un-premultiplied RGB bilinearly where all 4 neighbor pixels have alpha >= min_alpha."""
    rgba_arr = np.asarray(rgba, dtype=np.float32)
    if rgba_arr.ndim != 3 or rgba_arr.shape[2] != 4:
        raise ValueError(f"Expected (H, W, 4) RGBA array, got {rgba_arr.shape}")
    pts = np.asarray(uv_coords, dtype=np.float64).reshape(-1, 2)
    h_img, w_img = rgba_arr.shape[:2]
    if len(pts) == 0 or h_img < 2 or w_img < 2:
        return np.zeros((0, 3), dtype=np.float32), np.zeros((len(pts),), dtype=bool)

    fx = pts[:, 0]
    fy = pts[:, 1]
    in_bounds = (fx >= 0.0) & (fx < float(w_img - 1)) & (fy >= 0.0) & (fy < float(h_img - 1))

    x0 = np.clip(np.floor(fx).astype(np.int32), 0, w_img - 2)
    y0 = np.clip(np.floor(fy).astype(np.int32), 0, h_img - 2)
    alpha = rgba_arr[..., 3]
    valid = (
        in_bounds
        & (alpha[y0, x0] >= min_alpha)
        & (alpha[y0, x0 + 1] >= min_alpha)
        & (alpha[y0 + 1, x0] >= min_alpha)
        & (alpha[y0 + 1, x0 + 1] >= min_alpha)
    )
    if mask is not None:
        mk = np.asarray(mask, dtype=bool)
        valid &= mk[y0, x0] & mk[y0, x0 + 1] & mk[y0 + 1, x0] & mk[y0 + 1, x0 + 1]

    if not valid.any():
        return np.zeros((0, 3), dtype=np.float32), valid

    xv = x0[valid]
    yv = y0[valid]
    dx = (fx[valid] - xv)[:, None].astype(np.float32)
    dy = (fy[valid] - yv)[:, None].astype(np.float32)
    rgb = rgba_arr[..., :3]
    sampled = (
        rgb[yv, xv] * (1.0 - dx) * (1.0 - dy)
        + rgb[yv, xv + 1] * dx * (1.0 - dy)
        + rgb[yv + 1, xv] * (1.0 - dx) * dy
        + rgb[yv + 1, xv + 1] * dx * dy
    )
    return sampled.astype(np.float32), valid


def make_turntable_contact_sheet(
    lit_paths: list[Path],
    clay_paths: list[Path],
    out_path: Path,
    title: str,
) -> Path:
    """Assemble a 2x4 lit turntable contact sheet (textured top row, clay bottom row)."""
    tile = 384
    pad = 12
    header_h = 44
    label_h = 24
    cols = max(len(lit_paths), len(clay_paths), 1)
    width = pad + cols * (tile + pad)
    height = header_h + 2 * (label_h + tile + pad) + 28
    canvas = Image.new("RGB", (width, height), "#18232c")
    draw = ImageDraw.Draw(canvas)
    draw.text((pad, 10), f"{title}  |  {STAMP}", fill="white")

    rows = [
        ("Lit PBR (Textured)", lit_paths),
        ("Clay Geometry", clay_paths),
    ]
    for r_idx, (row_label, paths) in enumerate(rows):
        y0 = header_h + r_idx * (label_h + tile + pad)
        draw.text((pad, y0 + 2), row_label, fill="#ffd293")
        for c_idx, p in enumerate(paths):
            with Image.open(p) as im:
                im_rgb = im.convert("RGB").resize((tile, tile), Image.Resampling.LANCZOS)
            x0 = pad + c_idx * (tile + pad)
            canvas.paste(im_rgb, (x0, y0 + label_h))
    draw.text((pad, height - 22), STAMP, fill="white")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path


def measure_turntable_luminance(tt_dir: Path, azimuths: tuple[int, ...] = (0, 90, 180, 270)) -> dict[str, dict[str, float]]:
    """Measure per-azimuth foreground mean Rec.709 luminance on studio turntable renders."""
    out: dict[str, dict[str, float]] = {}
    for mode in ("lit", "clay"):
        per_az: dict[str, float] = {}
        for az in azimuths:
            p = tt_dir / f"{mode}_az{az}.png"
            if not p.is_file():
                continue
            with Image.open(p) as im:
                arr = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
            bg = np.median(arr[:20, :20], axis=(0, 1))
            fg = np.max(np.abs(arr - bg), axis=-1) > 0.08
            lum = 0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]
            per_az[str(az)] = round(float(lum[fg].mean()) if fg.any() else 0.0, 4)
        out[mode] = per_az
    return out


# ---------------------------------------------------------------------------
# Dataset loading (strict train-only guard)
# ---------------------------------------------------------------------------


def _load_ply_xyz_rgb(ply_path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Read binary little-endian xyz+rgb PLY written by co3d_to_colmap.py."""
    with ply_path.open("rb") as fh:
        vertex_count = None
        while True:
            line = fh.readline().decode("ascii").strip()
            if line.startswith("element vertex "):
                vertex_count = int(line.split()[-1])
            elif line == "end_header":
                break
        if vertex_count is None:
            raise RuntimeError(f"Missing vertex count in {ply_path}")
        dtype = np.dtype([("xyz", "<f4", 3), ("rgb", "u1", 3)])
        data = np.fromfile(fh, dtype=dtype, count=vertex_count)
    return data["xyz"].astype(np.float32), (data["rgb"].astype(np.float32) / 255.0)


def load_train_split_strict(dataset_dir: Path) -> tuple[list[dict[str, Any]], np.ndarray, np.ndarray]:
    """Load strictly transforms_train.json and points3d.ply, verifying disjointness from val."""
    train_json = dataset_dir / "transforms_train.json"
    val_json = dataset_dir / "transforms_val.json"
    if not train_json.is_file():
        raise RuntimeError(f"Missing {train_json}")
    train_data = json.loads(train_json.read_text(encoding="utf-8"))
    train_frames = train_data["frames"]
    if val_json.is_file():
        val_stems = {Path(f["file_path"]).stem for f in json.loads(val_json.read_text(encoding="utf-8"))["frames"]}
        train_stems = {Path(f["file_path"]).stem for f in train_frames}
        overlap = train_stems & val_stems
        if overlap:
            raise RuntimeError(f"Train/val leakage detected: {sorted(overlap)[:5]}")
    ply_path = dataset_dir / train_data.get("ply_file_path", "points3d.ply")
    xyz, rgb = _load_ply_xyz_rgb(ply_path)
    return train_frames, xyz, rgb


# ---------------------------------------------------------------------------
# Stage 1: 2DGS training + Open3D TSDF fusion (runs in track2b-venv on GPU)
# ---------------------------------------------------------------------------


def _rgb_to_sh0(rgb: np.ndarray) -> np.ndarray:
    c0 = 0.28209479177387814
    return (rgb - 0.5) / c0


def _ssim_loss_torch(img1, img2):
    import torch
    import torch.nn.functional as F

    # img1, img2: [1, 3, H, W]
    window_size = 11
    sigma = 1.5
    coords = torch.arange(window_size, dtype=img1.dtype, device=img1.device) - window_size // 2
    g = torch.exp(-(coords**2) / (2 * sigma**2))
    g = g / g.sum()
    window = (g[:, None] * g[None, :]).expand(3, 1, window_size, window_size).contiguous()
    pad = window_size // 2
    mu1 = F.conv2d(img1, window, padding=pad, groups=3)
    mu2 = F.conv2d(img2, window, padding=pad, groups=3)
    mu1_sq, mu2_sq, mu1_mu2 = mu1 * mu1, mu2 * mu2, mu1 * mu2
    sigma1_sq = F.conv2d(img1 * img1, window, padding=pad, groups=3) - mu1_sq
    sigma2_sq = F.conv2d(img2 * img2, window, padding=pad, groups=3) - mu2_sq
    sigma12 = F.conv2d(img1 * img2, window, padding=pad, groups=3) - mu1_mu2
    c1, c2 = 0.01**2, 0.03**2
    ssim_map = ((2 * mu1_mu2 + c1) * (2 * sigma12 + c2)) / (
        (mu1_sq + mu2_sq + c1) * (sigma1_sq + sigma2_sq + c2)
    )
    return 1.0 - ssim_map.mean()


def se3_delta_to_matrix_torch(rotvec, trans):
    """Differentiable PyTorch 4x4 SE(3) matrix from axis-angle rotvec (rad) and translation."""
    import torch

    theta2 = (rotvec * rotvec).sum()
    theta = torch.sqrt(theta2.clamp(min=1e-16))
    small = theta < 1e-6
    theta_safe = torch.where(small, torch.ones_like(theta), theta)
    a = torch.where(small, 1.0 - theta2 / 6.0, torch.sin(theta_safe) / theta_safe)
    b = torch.where(small, 0.5 - theta2 / 24.0, (1.0 - torch.cos(theta_safe)) / (theta_safe * theta_safe))

    wx, wy, wz = rotvec[0], rotvec[1], rotvec[2]
    z = torch.zeros_like(wx)
    k = torch.stack(
        [
            torch.stack([z, -wz, wy]),
            torch.stack([wz, z, -wx]),
            torch.stack([-wy, wx, z]),
        ]
    )
    eye3 = torch.eye(3, dtype=rotvec.dtype, device=rotvec.device)
    rot = eye3 + a * k + b * (k @ k)
    mat = torch.eye(4, dtype=rotvec.dtype, device=rotvec.device)
    mat = mat.clone()
    mat[:3, :3] = rot
    mat[:3, 3] = trans
    return mat


def run_2dgs_and_tsdf(
    dataset_dir: Path,
    out_dir: Path,
    *,
    dish: str,
    steps: int = 6000,
    max_splats: int = 120_000,
    diameter_cm: float | None = None,
    voxel_divisions: int = 320,
    tsdf_alpha_thresh: float = 0.10,
    tsdf_depth_source: str = "expected",
    tsdf_trunc_voxels: float = 6.0,
    tsdf_cube_padding: float = 1.5,
    smooth_iterations: int = 2,
    seed: int = 42,
    refine_stop_iter: int | None = None,
    pose_refine: bool = False,
    pose_warmup_steps: int = 1000,
    pose_lr_rot: float = 6e-4,
    pose_lr_trans: float = 3e-4,
    pose_reg_weight: float = 1e-2,
    pose_reg_trans_weight: float = 0.2,
    mask_carve: bool = False,
    mask_carve_tol_px: float = 2.0,
    mask_carve_max_out_frac: float = 0.38,
    trim_drips: bool = False,
    repair_pits: bool = False,
    solid_complete: bool = False,
    poisson_depth: int = 9,
    keep_multi_components: bool = False,
) -> dict[str, Any]:
    """Train 2DGS strictly on train views, fuse masked depth via Open3D TSDF, clean & export GLB."""
    import gsplat
    import open3d as o3d
    import torch
    import trimesh
    from scipy.spatial import cKDTree

    torch.manual_seed(seed)
    np.random.seed(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise RuntimeError("CUDA GPU required for gsplat 2DGS training")

    out_dir.mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    train_frames, init_xyz, init_rgb = load_train_split_strict(dataset_dir)
    n_train = len(train_frames)
    print(f"[track2b] Loaded {n_train} train views and {len(init_xyz)} init points for {dish}")

    # Preload train views (images composited on black, masks, OpenCV w2c, K)
    train_views = []
    train_c2ws = []
    for frame in train_frames:
        c2w = np.asarray(frame["transform_matrix"], dtype=np.float64)
        w2c = opengl_c2w_to_opencv_w2c(c2w)
        train_c2ws.append(c2w)
        K = np.array(
            [
                [frame["fl_x"], 0.0, frame["cx"]],
                [0.0, frame["fl_y"], frame["cy"]],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float32,
        )
        with Image.open(dataset_dir / frame["file_path"]) as im:
            rgba = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0
        with Image.open(_resolve_frame_mask_path(dataset_dir, frame)) as mk:
            mask = np.asarray(mk.convert("L")) > 127
        rgb_black = rgba[..., :3] * rgba[..., 3:4]
        alpha_gt = rgba[..., 3]
        train_views.append(
            {
                "frame": frame,
                "w": int(frame["w"]),
                "h": int(frame["h"]),
                "c2w": c2w,
                "w2c": w2c.astype(np.float32),
                "w2c_raw": w2c.astype(np.float64),
                "c2w_raw": c2w.copy(),
                "K": K,
                "rgb": torch.from_numpy(rgb_black).to(device),
                "alpha": torch.from_numpy(alpha_gt).to(device),
                "rgb_np": rgb_black,
                "mask": mask,
            }
        )

    # Scene scale from camera centers
    cam_centers = np.stack([v["c2w"][:3, 3] for v in train_views], axis=0)
    obj_center = init_xyz.mean(axis=0)
    cam_dists = np.linalg.norm(cam_centers - obj_center[None, :], axis=1)
    scene_scale = float(np.median(cam_dists))
    near_plane = max(0.05, float(cam_dists.min()) * 0.15)
    far_plane = float(cam_dists.max()) * 2.5

    # Initialize 2DGS parameters from visual-hull points3d.ply
    tree = cKDTree(init_xyz)
    dists, _ = tree.query(init_xyz, k=4)
    avg_dist = np.clip(dists[:, 1:].mean(axis=1), 1e-4, scene_scale * 0.1).astype(np.float32)
    init_scales = np.log(np.repeat(avg_dist[:, None], 3, axis=1))
    # Keep 3rd scale tiny for 2D surfels
    init_scales[:, 2] = np.log(np.maximum(avg_dist * 0.01, 1e-5))

    n_pts = len(init_xyz)
    sh_degree = 3
    n_sh_rest = (sh_degree + 1) ** 2 - 1

    params = torch.nn.ParameterDict(
        {
            "means": torch.nn.Parameter(torch.from_numpy(init_xyz).to(device)),
            "scales": torch.nn.Parameter(torch.from_numpy(init_scales).to(device)),
            "quats": torch.nn.Parameter(
                torch.tensor([[1.0, 0.0, 0.0, 0.0]], device=device).repeat(n_pts, 1)
            ),
            "opacities": torch.nn.Parameter(torch.logit(torch.full((n_pts,), 0.5, device=device))),
            "sh0": torch.nn.Parameter(
                torch.from_numpy(_rgb_to_sh0(init_rgb).astype(np.float32)).unsqueeze(1).to(device)
            ),
            "shN": torch.nn.Parameter(torch.zeros((n_pts, n_sh_rest, 3), device=device)),
        }
    )

    optimizers = {
        "means": torch.optim.Adam([params["means"]], lr=1.6e-4 * scene_scale, eps=1e-15),
        "scales": torch.optim.Adam([params["scales"]], lr=5e-3, eps=1e-15),
        "quats": torch.optim.Adam([params["quats"]], lr=1e-3, eps=1e-15),
        "opacities": torch.optim.Adam([params["opacities"]], lr=5e-2, eps=1e-15),
        "sh0": torch.optim.Adam([params["sh0"]], lr=2.5e-3, eps=1e-15),
        "shN": torch.optim.Adam([params["shN"]], lr=2.5e-3 / 20.0, eps=1e-15),
    }

    effective_refine_stop = int(refine_stop_iter) if refine_stop_iter is not None else min(4000, int(steps * 0.7))
    strategy = gsplat.DefaultStrategy(
        verbose=False,
        prune_opa=0.05,
        grow_grad2d=0.00025,
        grow_scale3d=0.01,
        prune_scale3d=0.1,
        refine_start_iter=500,
        refine_stop_iter=effective_refine_stop,
        reset_every=1500,
        refine_every=100,
        key_for_gradient="gradient_2dgs",
    )
    strategy.check_sanity(params, optimizers)
    strategy_state = strategy.initialize_state(scene_scale=scene_scale)

    pose_rot = None
    pose_trans = None
    pose_optimizer = None
    anchor_idx = 0
    if pose_refine:
        anchor_idx = select_anchor_camera_index(
            train_c2ws,
            [v["mask"] for v in train_views],
            train_frames,
            obj_center,
        )
        pose_rot = torch.zeros((n_train, 3), dtype=torch.float32, device=device, requires_grad=True)
        pose_trans = torch.zeros((n_train, 3), dtype=torch.float32, device=device, requires_grad=True)
        pose_optimizer = torch.optim.Adam(
            [
                {"params": [pose_rot], "lr": float(pose_lr_rot)},
                {"params": [pose_trans], "lr": float(pose_lr_trans) * scene_scale},
            ],
            eps=1e-15,
        )
        print(
            f"[track2b][pose] Pose refinement enabled: warmup={pose_warmup_steps} steps, "
            f"anchor_idx={anchor_idx} ({Path(train_frames[anchor_idx]['file_path']).stem}), "
            f"lr_rot={pose_lr_rot}, lr_trans={pose_lr_trans}*scale, reg={pose_reg_weight}"
        )

    lr_init = 1.6e-4 * scene_scale
    lr_final = 1.6e-6 * scene_scale

    rng = np.random.default_rng(seed)
    order = rng.permutation(n_train)
    cursor = 0

    pose_stop_step = max(pose_warmup_steps, steps - 500) if steps >= 2000 else steps
    for step in range(steps):
        if cursor >= n_train:
            order = rng.permutation(n_train)
            cursor = 0
        view_idx = int(order[cursor])
        view = train_views[view_idx]
        cursor += 1

        # Exponential LR decay on means
        t_frac = step / max(steps - 1, 1)
        optimizers["means"].param_groups[0]["lr"] = math.exp(
            math.log(lr_init) * (1.0 - t_frac) + math.log(lr_final) * t_frac
        )

        cur_sh_deg = min(step // 1000, sh_degree)
        colors = torch.cat([params["sh0"], params["shN"]], dim=1)
        w2c_raw_t = torch.from_numpy(view["w2c"]).to(device)
        use_refined_pose = bool(pose_refine and step >= pose_warmup_steps and view_idx != anchor_idx)
        refine_active = bool(use_refined_pose and step < pose_stop_step)
        if use_refined_pose:
            if refine_active:
                p_frac = (step - pose_warmup_steps) / max(pose_stop_step - 1 - pose_warmup_steps, 1)
                lr_mult = math.exp(math.log(1.0) * (1.0 - p_frac) + math.log(0.05) * p_frac)
                pose_optimizer.param_groups[0]["lr"] = float(pose_lr_rot) * lr_mult
                pose_optimizer.param_groups[1]["lr"] = float(pose_lr_trans) * scene_scale * lr_mult
                delta_mat = se3_delta_to_matrix_torch(pose_rot[view_idx], pose_trans[view_idx])
            else:
                with torch.no_grad():
                    delta_mat = se3_delta_to_matrix_torch(pose_rot[view_idx], pose_trans[view_idx])
            viewmat = (delta_mat @ w2c_raw_t).unsqueeze(0)
        else:
            viewmat = w2c_raw_t.unsqueeze(0)
        K_mat = torch.from_numpy(view["K"]).unsqueeze(0).to(device)

        (
            render_colors,
            render_alphas,
            render_normals,
            normals_from_depth,
            render_distort,
            _render_median,
            info,
        ) = gsplat.rasterization_2dgs(
            means=params["means"],
            quats=params["quats"],
            scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]),
            colors=colors,
            viewmats=viewmat,
            Ks=K_mat,
            width=view["w"],
            height=view["h"],
            near_plane=near_plane,
            far_plane=far_plane,
            sh_degree=cur_sh_deg,
            render_mode="RGB+ED",
            distloss=True,
            packed=False,
        )

        strategy.step_pre_backward(params, optimizers, strategy_state, step, info)

        rgb_pred = render_colors[0, ..., :3].clamp(0.0, 1.0)
        alpha_pred = render_alphas[0, ..., 0].clamp(0.0, 1.0)
        rgb_gt = view["rgb"]
        alpha_gt = view["alpha"]

        l1_loss = torch.abs(rgb_pred - rgb_gt).mean()
        ssim_loss = _ssim_loss_torch(
            rgb_pred.permute(2, 0, 1).unsqueeze(0),
            rgb_gt.permute(2, 0, 1).unsqueeze(0),
        )
        alpha_loss = torch.abs(alpha_pred - alpha_gt).mean()
        loss = 0.8 * l1_loss + 0.2 * ssim_loss + 0.5 * alpha_loss

        geom_stats = {"normal_loss": 0.0, "distort_loss": 0.0}
        if step >= 1000:
            geom_loss, geom_stats = compute_2dgs_geometry_losses(
                render_normals,
                normals_from_depth,
                render_distort,
                alpha_pred,
                normal_weight=0.05,
                distort_weight=0.5,
            )
            loss = loss + geom_loss

        if refine_active:
            trans_norm = pose_trans[view_idx] / max(scene_scale, 1e-6)
            # Stronger Z penalty counters 2DGS depth-distortion's radial scale-shrink bias
            trans_reg = float(pose_reg_trans_weight) * (trans_norm[:2] ** 2).sum() + max(
                float(pose_reg_trans_weight), 5.0
            ) * (trans_norm[2] ** 2)
            pose_reg = float(pose_reg_weight) * (pose_rot[view_idx] ** 2).sum() + trans_reg
            loss = loss + pose_reg

        loss.backward()
        for opt in optimizers.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        if refine_active:
            pose_optimizer.step()
            pose_optimizer.zero_grad(set_to_none=True)

        # Cap splats to stay comfortably inside 6 GB VRAM
        if len(params["means"]) < max_splats:
            strategy.step_post_backward(params, optimizers, strategy_state, step, info, packed=False)

        if (step + 1) % 1000 == 0 or step == 0:
            print(
                f"[track2b][2dgs] step={step + 1}/{steps} loss={loss.item():.4f} "
                f"n_err={geom_stats['normal_loss']:.4f} dist={geom_stats['distort_loss']:.4f} "
                f"splats={len(params['means'])} vram_mb={torch.cuda.max_memory_allocated() / 1e6:.0f}"
            )

    train_seconds = round(time.time() - t_start, 2)
    final_splats = int(len(params["means"]))

    pose_rot_np = np.zeros((n_train, 3), dtype=np.float64)
    pose_trans_np = np.zeros((n_train, 3), dtype=np.float64)
    if pose_refine:
        pose_rot_np = pose_rot.detach().cpu().numpy().astype(np.float64)
        pose_trans_np = pose_trans.detach().cpu().numpy().astype(np.float64)
        pose_rot_np[anchor_idx] = 0.0
        pose_trans_np[anchor_idx] = 0.0
        w2c_raws_np = np.stack([v["w2c_raw"] for v in train_views], axis=0)
        w2c_refined_np = apply_pose_deltas_with_gauge(
            w2c_raws_np, pose_rot_np, pose_trans_np, anchor_index=anchor_idx
        )
        for i, v in enumerate(train_views):
            v["w2c"] = w2c_refined_np[i].astype(np.float32)
            v["c2w"] = opencv_w2c_to_opengl_c2w(w2c_refined_np[i])
            train_c2ws[i] = v["c2w"]
        rot_degs_log = np.degrees(np.linalg.norm(pose_rot_np, axis=1))
        print(
            f"[track2b][pose] Refined {n_train} train poses (anchor={anchor_idx}): "
            f"mean_rot={rot_degs_log[np.arange(n_train) != anchor_idx].mean():.3f} deg, "
            f"max_rot={rot_degs_log.max():.3f} deg"
        )

    # Save 2DGS checkpoint for reproducibility / fast TSDF re-extraction
    torch.save({k: v.detach().cpu() for k, v in params.items()}, out_dir / "2dgs_ckpt.pt")

    # Measure TRAIN-view 2DGS photometric fit (strictly train views only)
    train_l1_list = []
    train_fg_l1_list = []
    train_psnr_list = []
    train_fg_psnr_list = []
    with torch.no_grad():
        colors_all_eval = torch.cat([params["sh0"], params["shN"]], dim=1)
        scales_exp_eval = torch.exp(params["scales"])
        opacities_sig_eval = torch.sigmoid(params["opacities"])
        for view in train_views:
            viewmat = torch.from_numpy(view["w2c"]).unsqueeze(0).to(device)
            K_mat = torch.from_numpy(view["K"]).unsqueeze(0).to(device)
            rc, *_ = gsplat.rasterization_2dgs(
                means=params["means"],
                quats=params["quats"],
                scales=scales_exp_eval,
                opacities=opacities_sig_eval,
                colors=colors_all_eval,
                viewmats=viewmat,
                Ks=K_mat,
                width=view["w"],
                height=view["h"],
                near_plane=near_plane,
                far_plane=far_plane,
                sh_degree=sh_degree,
                render_mode="RGB",
                distloss=False,
                packed=False,
            )
            pred = rc[0, ..., :3].clamp(0.0, 1.0)
            gt = view["rgb"]
            diff = pred - gt
            abs_diff = torch.abs(diff)
            sq_diff = diff * diff
            train_l1_list.append(float(abs_diff.mean().item()))
            mse_full = max(float(sq_diff.mean().item()), 1e-10)
            train_psnr_list.append(float(-10.0 * math.log10(mse_full)))
            fg_m = view["alpha"] > 0.5
            if bool(fg_m.any()):
                train_fg_l1_list.append(float(abs_diff[fg_m].mean().item()))
                mse_fg = max(float(sq_diff[fg_m].mean().item()), 1e-10)
                train_fg_psnr_list.append(float(-10.0 * math.log10(mse_fg)))
    train_photometric = {
        "views": n_train,
        "full_l1": round(float(np.mean(train_l1_list)), 6) if train_l1_list else None,
        "full_psnr_db": round(float(np.mean(train_psnr_list)), 4) if train_psnr_list else None,
        "fg_l1": round(float(np.mean(train_fg_l1_list)), 6) if train_fg_l1_list else None,
        "fg_psnr_db": round(float(np.mean(train_fg_psnr_list)), 4) if train_fg_psnr_list else None,
    }
    print(
        f"[track2b][train_photo] 2DGS train-view fit ({n_train} views): "
        f"FG PSNR={train_photometric['fg_psnr_db']:.2f} dB, FG L1={train_photometric['fg_l1']:.5f}"
    )

    # Estimate tight object bounding cube from opaque 2DGS centers for UniformTSDFVolume
    with torch.no_grad():
        op_mask = torch.sigmoid(params["opacities"]) > 0.25
        active_xyz = params["means"][op_mask].detach().cpu().numpy()
        if len(active_xyz) < 100:
            active_xyz = params["means"].detach().cpu().numpy()
    p_lo, p_hi = np.percentile(active_xyz, [0.2, 99.8], axis=0)
    bbox_center = 0.5 * (p_lo + p_hi)
    max_extent = float(np.max(p_hi - p_lo))
    vol_length = max(max_extent * float(tsdf_cube_padding), 1e-2)
    vol_origin = (bbox_center - 0.5 * vol_length).tolist()
    voxel_length = vol_length / float(voxel_divisions)
    sdf_trunc = float(tsdf_trunc_voxels) * voxel_length
    print(
        f"[track2b][tsdf] UniformTSDF len={vol_length:.3f} res={voxel_divisions} "
        f"voxel={voxel_length:.5f} trunc={sdf_trunc:.5f} src={tsdf_depth_source} "
        f"alpha>={tsdf_alpha_thresh} fusing {n_train} train views..."
    )

    # Open3D UniformTSDFVolume integration over train views ONLY
    t_tsdf = time.time()
    volume = o3d.pipelines.integration.UniformTSDFVolume(
        length=vol_length,
        resolution=int(voxel_divisions),
        sdf_trunc=sdf_trunc,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        origin=vol_origin,
    )

    with torch.no_grad():
        colors_all = torch.cat([params["sh0"], params["shN"]], dim=1)
        scales_exp = torch.exp(params["scales"])
        opacities_sig = torch.sigmoid(params["opacities"])
        for view in train_views:
            viewmat = torch.from_numpy(view["w2c"]).unsqueeze(0).to(device)
            K_mat = torch.from_numpy(view["K"]).unsqueeze(0).to(device)
            (
                render_colors,
                render_alphas,
                _render_normals,
                _normals_from_depth,
                _render_distort,
                render_median,
                _info,
            ) = gsplat.rasterization_2dgs(
                means=params["means"],
                quats=params["quats"],
                scales=scales_exp,
                opacities=opacities_sig,
                colors=colors_all,
                viewmats=viewmat,
                Ks=K_mat,
                width=view["w"],
                height=view["h"],
                near_plane=near_plane,
                far_plane=far_plane,
                sh_degree=sh_degree,
                render_mode="RGB+ED",
                depth_mode="median",
                distloss=False,
                packed=False,
            )
            # Select TSDF depth source (median with expected fallback, or expected directly)
            med_np = render_median[0, ..., 0].detach().cpu().numpy()
            ed_np = render_colors[0, ..., 3].detach().cpu().numpy()
            if tsdf_depth_source == "expected":
                depth_np = ed_np
            elif tsdf_depth_source == "median":
                depth_np = np.where(med_np > 0.0, med_np, ed_np)
            else:
                raise ValueError(f"Unsupported tsdf_depth_source: {tsdf_depth_source}")
            alpha_np = render_alphas[0, ..., 0].detach().cpu().numpy()
            depth_masked = prepare_masked_tsdf_depth(
                depth_np,
                alpha_np,
                view["mask"],
                near=near_plane,
                far=far_plane,
                alpha_thresh=tsdf_alpha_thresh,
            )
            rgb_u8 = np.clip(np.rint(view["rgb_np"] * 255.0), 0, 255).astype(np.uint8)
            o3d_color = o3d.geometry.Image(np.ascontiguousarray(rgb_u8))
            o3d_depth = o3d.geometry.Image(np.ascontiguousarray(depth_masked))
            rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                o3d_color,
                o3d_depth,
                depth_scale=1.0,
                depth_trunc=far_plane,
                convert_rgb_to_intensity=False,
            )
            f = view["frame"]
            intrinsic = o3d.camera.PinholeCameraIntrinsic(
                int(f["w"]),
                int(f["h"]),
                float(f["fl_x"]),
                float(f["fl_y"]),
                float(f["cx"]),
                float(f["cy"]),
            )
            volume.integrate(rgbd, intrinsic, view["w2c"].astype(np.float64))

    mesh_o3d = volume.extract_triangle_mesh()
    mesh_o3d.remove_duplicated_vertices()
    mesh_o3d.remove_degenerate_triangles()
    mesh_o3d.remove_duplicated_triangles()
    mesh_o3d.remove_non_manifold_edges()
    tsdf_seconds = round(time.time() - t_tsdf, 2)

    raw_verts = np.asarray(mesh_o3d.vertices, dtype=np.float64)
    raw_faces = np.asarray(mesh_o3d.triangles, dtype=np.int64)
    raw_colors = np.asarray(mesh_o3d.vertex_colors, dtype=np.float64)
    if len(raw_colors) != len(raw_verts):
        raw_colors = np.full_like(raw_verts, 0.5)
    print(f"[track2b][tsdf] Extracted raw mesh: {len(raw_verts)} verts, {len(raw_faces)} faces in {tsdf_seconds}s")

    # Estimate Y-up orientation from train camera orbit
    up_axis = estimate_orbit_up_axis(train_c2ws)
    rot_yup = rotation_align_axis_to_yup(up_axis)
    verts_yup_unscaled = raw_verts @ rot_yup.T

    # Clean floaters / bottom table plane / keep main component (or multi-components when requested) in Y-up orientation
    clean_verts_yup, clean_faces, clean_stats = filter_mesh_components(
        verts_yup_unscaled,
        raw_faces,
        min_face_fraction=(0.05 if keep_multi_components else 0.02),
        table_height_ratio=0.06,
        table_footprint_ratio=0.75,
        keep_main_only=not keep_multi_components,
        up_axis_index=1,
    )
    kept_idx = clean_stats.pop("kept_vertex_indices")
    clean_colors = raw_colors[kept_idx]

    # Map cleaned vertices back to world space to compute initial world->metric transform
    clean_verts_world = clean_verts_yup @ rot_yup
    target_diam_cm = diameter_cm if diameter_cm is not None else DEFAULT_DISH_DIAMETERS_CM.get(dish, 24.0)
    m_world_to_metric, transform_meta = compute_world_to_metric_transform(
        clean_verts_world, up_axis, target_diam_cm
    )

    carve_stats: dict[str, Any] = {"enabled": bool(mask_carve)}
    if mask_carve:
        m_world_to_yup = np.eye(4, dtype=np.float64)
        m_world_to_yup[:3, :3] = rot_yup
        yup_w2cs = [opengl_c2w_to_opencv_w2c(transform_opengl_c2w(v["c2w"], m_world_to_yup)) for v in train_views]
        clean_verts_yup, clean_faces, clean_colors, c_res = carve_mesh_by_train_masks(
            clean_verts_yup,
            clean_faces,
            [v["mask"] for v in train_views],
            yup_w2cs,
            [v["frame"] for v in train_views],
            mask_tol_px=mask_carve_tol_px,
            max_out_fraction=mask_carve_max_out_frac,
            vertex_colors=clean_colors,
            keep_main_only=not keep_multi_components,
            min_face_fraction=(0.05 if keep_multi_components else 0.02),
        )
        carve_stats.update(c_res)
        print(
            f"[track2b][carve] Train-mask visual-hull carve: "
            f"faces {c_res['faces_before']}->{c_res['faces_after']} (carved {c_res['carved_faces']})"
        )

    drip_stats: dict[str, Any] = {"enabled": bool(trim_drips)}
    if trim_drips:
        clean_verts_yup, clean_faces, clean_colors, d_res = trim_support_plane_drips(
            clean_verts_yup,
            clean_faces,
            up_axis_index=1,
            vertex_colors=clean_colors,
            keep_main_only=not keep_multi_components,
            min_face_fraction=(0.05 if keep_multi_components else 0.02),
        )
        drip_stats.update(d_res)
        print(
            f"[track2b][drip] Support-plane drip trim: trimmed={d_res['trimmed']}, "
            f"offset={d_res.get('y_support_offset', 0.0)}, dropped={d_res['faces_dropped']}"
        )

    if mask_carve or trim_drips:
        clean_verts_world = clean_verts_yup @ rot_yup
        m_world_to_metric, transform_meta = compute_world_to_metric_transform(
            clean_verts_world, up_axis, target_diam_cm
        )

    metric_verts = (clean_verts_world @ m_world_to_metric[:3, :3].T) + m_world_to_metric[:3, 3]

    dihedral_before = compute_dihedral_stats(metric_verts, clean_faces)
    effective_iters = choose_adaptive_smooth_iterations(dihedral_before, smooth_iterations)
    if effective_iters > 0:
        o3d_clean = o3d.geometry.TriangleMesh()
        o3d_clean.vertices = o3d.utility.Vector3dVector(np.asarray(metric_verts, dtype=np.float64))
        o3d_clean.triangles = o3d.utility.Vector3iVector(np.asarray(clean_faces, dtype=np.int32))
        o3d_clean.vertex_colors = o3d.utility.Vector3dVector(np.clip(clean_colors, 0.0, 1.0))
        o3d_clean = o3d_clean.filter_smooth_taubin(
            number_of_iterations=effective_iters,
            lambda_filter=0.35,
            mu=-0.36,
        )
        smoothed_verts = np.asarray(o3d_clean.vertices, dtype=np.float64)
        metric_verts = blend_crease_preserving_vertices(metric_verts, smoothed_verts, clean_faces)
        clean_colors = np.asarray(o3d_clean.vertex_colors, dtype=np.float64)
        if len(clean_colors) != len(metric_verts):
            clean_colors = np.full_like(metric_verts, 0.5)

    pit_stats: dict[str, Any] = {"enabled": bool(repair_pits)}
    if repair_pits:
        metric_verts, clean_faces, clean_colors, touched_1, hole_res_1 = fill_small_boundary_holes(
            metric_verts,
            clean_faces,
            max_hole_verts=600,
            max_hole_diam_frac=0.22,
            vertex_colors=clean_colors,
        )
        metric_verts, smooth_pit_res_1 = smooth_isolated_surface_pits(
            metric_verts,
            clean_faces,
            seed_vertices=touched_1,
            pit_normal_dot=0.68,
            max_pit_cluster_verts=180,
            smooth_iters=6,
        )
        o3d_pre = o3d.geometry.TriangleMesh()
        o3d_pre.vertices = o3d.utility.Vector3dVector(np.asarray(metric_verts, dtype=np.float64))
        o3d_pre.triangles = o3d.utility.Vector3iVector(np.asarray(clean_faces, dtype=np.int32))
        if clean_colors is not None and len(clean_colors) == len(metric_verts):
            o3d_pre.vertex_colors = o3d.utility.Vector3dVector(np.clip(clean_colors, 0.0, 1.0))
        o3d_pre.remove_degenerate_triangles()
        o3d_pre.remove_duplicated_triangles()
        o3d_pre.remove_duplicated_vertices()
        o3d_pre.remove_non_manifold_edges()

        metric_verts = np.asarray(o3d_pre.vertices, dtype=np.float64)
        clean_faces = np.asarray(o3d_pre.triangles, dtype=np.int64)
        clean_colors = np.asarray(o3d_pre.vertex_colors, dtype=np.float64)
        if len(clean_colors) != len(metric_verts):
            clean_colors = np.full_like(metric_verts, 0.5)

        metric_verts, clean_faces, clean_colors, touched_2, hole_res_2 = fill_small_boundary_holes(
            metric_verts,
            clean_faces,
            max_hole_verts=400,
            max_hole_diam_frac=0.18,
            vertex_colors=clean_colors,
        )
        metric_verts, smooth_pit_res_2 = smooth_isolated_surface_pits(
            metric_verts,
            clean_faces,
            seed_vertices=touched_2,
            pit_normal_dot=0.68,
            max_pit_cluster_verts=180,
            smooth_iters=6,
        )
        pit_stats.update(
            {
                "holes_filled_pass1": hole_res_1["holes_filled"],
                "holes_filled_pass2": hole_res_2["holes_filled"],
                "pit_vertices_smoothed_pass1": smooth_pit_res_1["pit_vertices_smoothed"],
                "pit_vertices_smoothed_pass2": smooth_pit_res_2["pit_vertices_smoothed"],
            }
        )
        print(
            f"[track2b][pits] Repaired holes=({hole_res_1['holes_filled']}, {hole_res_2['holes_filled']}), "
            f"smoothed pit verts=({smooth_pit_res_1['pit_vertices_smoothed']}, {smooth_pit_res_2['pit_vertices_smoothed']})"
        )

    # Fill small holes first, then repair topology (degenerate/duplicated/non-manifold) AFTER fill_holes.
    tm = trimesh.Trimesh(
        vertices=metric_verts,
        faces=clean_faces,
        vertex_colors=np.clip(np.rint(clean_colors * 255.0), 0, 255).astype(np.uint8),
        process=False,
    )
    trimesh.repair.fill_holes(tm)

    o3d_repaired = o3d.geometry.TriangleMesh()
    o3d_repaired.vertices = o3d.utility.Vector3dVector(np.asarray(tm.vertices, dtype=np.float64))
    o3d_repaired.triangles = o3d.utility.Vector3iVector(np.asarray(tm.faces, dtype=np.int32))
    vcols_after = np.asarray(tm.visual.vertex_colors)[:, :3].astype(np.float64) / 255.0
    if len(vcols_after) == len(tm.vertices):
        o3d_repaired.vertex_colors = o3d.utility.Vector3dVector(np.clip(vcols_after, 0.0, 1.0))
    o3d_repaired.remove_degenerate_triangles()
    o3d_repaired.remove_duplicated_triangles()
    o3d_repaired.remove_duplicated_vertices()
    o3d_repaired.remove_non_manifold_edges()
    non_manifold_edges_after = len(o3d_repaired.get_non_manifold_edges(allow_boundary_edges=True))

    repaired_verts = np.asarray(o3d_repaired.vertices, dtype=np.float64)
    repaired_faces = np.asarray(o3d_repaired.triangles, dtype=np.int64)
    repaired_colors = np.asarray(o3d_repaired.vertex_colors, dtype=np.float64)
    if len(repaired_colors) != len(repaired_verts):
        repaired_colors = np.full_like(repaired_verts, 0.5)
    if repair_pits:
        repaired_verts, repaired_faces, repaired_colors, touched_3, hole_res_3 = fill_small_boundary_holes(
            repaired_verts,
            repaired_faces,
            max_hole_verts=400,
            max_hole_diam_frac=0.18,
            vertex_colors=repaired_colors,
        )
        if hole_res_3["holes_filled"] > 0:
            repaired_verts, _ = smooth_isolated_surface_pits(
                repaired_verts,
                repaired_faces,
                seed_vertices=touched_3,
                pit_normal_dot=0.68,
                max_pit_cluster_verts=180,
                smooth_iters=4,
            )
            o3d_final = o3d.geometry.TriangleMesh()
            o3d_final.vertices = o3d.utility.Vector3dVector(np.asarray(repaired_verts, dtype=np.float64))
            o3d_final.triangles = o3d.utility.Vector3iVector(np.asarray(repaired_faces, dtype=np.int32))
            if repaired_colors is not None and len(repaired_colors) == len(repaired_verts):
                o3d_final.vertex_colors = o3d.utility.Vector3dVector(np.clip(repaired_colors, 0.0, 1.0))
            o3d_final.remove_degenerate_triangles()
            o3d_final.remove_duplicated_triangles()
            o3d_final.remove_duplicated_vertices()
            o3d_final.remove_non_manifold_edges()
            non_manifold_edges_after = len(o3d_final.get_non_manifold_edges(allow_boundary_edges=True))
            repaired_verts = np.asarray(o3d_final.vertices, dtype=np.float64)
            repaired_faces = np.asarray(o3d_final.triangles, dtype=np.int64)
            repaired_colors = np.asarray(o3d_final.vertex_colors, dtype=np.float64)
            if len(repaired_colors) != len(repaired_verts):
                repaired_colors = np.full_like(repaired_verts, 0.5)
        pit_stats["holes_filled_post_nm"] = hole_res_3["holes_filled"]

    solid_stats: dict[str, Any] = {"enabled": bool(solid_complete)}
    if solid_complete:
        repaired_verts, repaired_faces, completed_cols, sc_res = complete_solid_mesh(
            repaired_verts,
            repaired_faces,
            repaired_colors,
            up_axis_index=1,
            poisson_depth=int(poisson_depth),
            keep_multi_components=bool(keep_multi_components),
        )
        if completed_cols is not None:
            repaired_colors = completed_cols
        solid_stats.update(sc_res)
        non_manifold_edges_after = int(sc_res["non_manifold_edges"])
        print(
            f"[track2b][solid] Completed watertight solid: faces {sc_res['faces_before']}->{sc_res['faces_after']}, "
            f"shells={sc_res['shell_count']}, watertight={sc_res['is_watertight']}, "
            f"boundary_edges={sc_res['boundary_edges']}"
        )

    tm = trimesh.Trimesh(
        vertices=repaired_verts,
        faces=repaired_faces,
        vertex_colors=np.clip(np.rint(repaired_colors * 255.0), 0, 255).astype(np.uint8),
        process=False,
    )
    if not solid_complete:
        tm.fix_normals()
    dihedral_after = compute_dihedral_stats(np.asarray(tm.vertices), np.asarray(tm.faces))
    print(
        f"[track2b][smooth] adaptive crease-preserving Taubin iters={effective_iters} (req={smooth_iterations}): "
        f"dihedral mean {dihedral_before['mean_deg']:.2f}->{dihedral_after['mean_deg']:.2f} deg, "
        f"p90 {dihedral_before['p90_deg']:.2f}->{dihedral_after['p90_deg']:.2f} deg, "
        f"gt45 {dihedral_before['gt45_pct']:.2f}%->{dihedral_after['gt45_pct']:.2f}%, "
        f"nm_edges={non_manifold_edges_after}"
    )

    # Measure TRAIN-view silhouette IoU against train masks (never held-out views)
    tmesh_eval = o3d.t.geometry.TriangleMesh()
    tmesh_eval.vertex.positions = o3d.core.Tensor(np.asarray(tm.vertices, dtype=np.float32))
    tmesh_eval.triangle.indices = o3d.core.Tensor(np.asarray(tm.faces, dtype=np.int32))
    rc_scene = o3d.t.geometry.RaycastingScene()
    rc_scene.add_triangles(tmesh_eval)
    train_ious = []
    for view in train_views:
        c2w_m = transform_opengl_c2w(view["c2w"], m_world_to_metric)
        w2c_m = opengl_c2w_to_opencv_w2c(c2w_m)
        rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(
            intrinsic_matrix=o3d.core.Tensor(view["K"].astype(np.float64)),
            extrinsic_matrix=o3d.core.Tensor(w2c_m),
            width_px=view["w"],
            height_px=view["h"],
        )
        hit = rc_scene.cast_rays(rays)["primitive_ids"].numpy() != o3d.t.geometry.RaycastingScene.INVALID_ID
        mk = view["mask"]
        train_ious.append(float((hit & mk).sum() / max(1, int((hit | mk).sum()))))
    train_iou_mean = round(float(np.mean(train_ious)), 5)
    print(f"[track2b][train_iou] Mean train-view silhouette IoU ({len(train_ious)} views): {train_iou_mean:.4f}")

    dense_glb = out_dir / "dense_clean.glb"
    tm.export(str(dense_glb))
    stamp_glb_asset_extras(dense_glb, {"publication_eligible": False, "pipeline": "food3d-track2b-dense"})
    print(
        f"[track2b][clean] Saved {dense_glb}: {len(tm.vertices)} verts, {len(tm.faces)} faces, "
        f"dims={transform_meta['dimensions_m']} m"
    )

    pose_refinement_summary: dict[str, Any] | None = None
    refined_poses_file: Path | None = None
    if pose_refine:
        refined_poses_file, pose_refinement_summary = save_refined_train_poses(
            out_dir / "refined_train_poses.json",
            dish=dish,
            train_frames=train_frames,
            raw_c2ws=[v["c2w_raw"] for v in train_views],
            refined_c2ws=[v["c2w"] for v in train_views],
            rotvecs=pose_rot_np,
            trans_world=pose_trans_np,
            scale_factor_to_m=float(transform_meta["scale_factor"]),
            anchor_index=anchor_idx,
            warmup_steps=pose_warmup_steps,
            pose_reg_weight=pose_reg_weight,
        )
        print(
            f"[track2b][pose] Saved {refined_poses_file}: "
            f"mean_rot={pose_refinement_summary['mean_rot_deg']:.3f} deg, "
            f"mean_trans={pose_refinement_summary['mean_trans_mm']:.3f} mm"
        )

    # Free GPU memory cleanly
    del params, optimizers, train_views
    torch.cuda.empty_cache()

    meta_report = {
        "schema_version": 1,
        "pipeline": "food3d-track2b-2dgs-tsdf",
        "publication_eligible": False,
        "dish": dish,
        "dataset_dir": str(dataset_dir),
        "train_views_used": n_train,
        "steps": steps,
        "final_splats": final_splats,
        "train_seconds": train_seconds,
        "tsdf_seconds": tsdf_seconds,
        "voxel_length_world": voxel_length,
        "sdf_trunc_world": sdf_trunc,
        "tsdf_settings": {
            "voxel_divisions": int(voxel_divisions),
            "alpha_thresh": float(tsdf_alpha_thresh),
            "depth_source": tsdf_depth_source,
            "trunc_voxels": float(tsdf_trunc_voxels),
            "cube_padding": float(tsdf_cube_padding),
        },
        "train_photometric": train_photometric,
        "smoothing": {
            "method": "adaptive_crease_preserving_taubin",
            "requested_iterations": int(smooth_iterations),
            "effective_iterations": int(effective_iters),
            "non_manifold_edges_after": int(non_manifold_edges_after),
            "dihedral_before": dihedral_before,
            "dihedral_after": dihedral_after,
        },
        "train_silhouette_iou": train_iou_mean,
        "pose_refine": bool(pose_refine),
        "pose_refinement": pose_refinement_summary,
        "refined_train_poses": str(refined_poses_file) if refined_poses_file else None,
        "cleanup": clean_stats,
        "mask_carve": carve_stats,
        "drip_trim": drip_stats,
        "pit_repair": pit_stats,
        "solid_complete": solid_stats,
        "keep_multi_components": bool(keep_multi_components),
        "world_to_metric": transform_meta,
        "dense_clean_glb": str(dense_glb),
        "dense_faces": int(len(tm.faces)),
    }
    (out_dir / "track2b_recon_meta.json").write_text(json.dumps(meta_report, indent=2) + "\n", encoding="utf-8")
    return meta_report


# ---------------------------------------------------------------------------
# Stage 2b: Multi-view train photo projection onto baked UV atlas
# ---------------------------------------------------------------------------


def compute_view_sharpness_map(
    rgb: np.ndarray,
    mask: np.ndarray | None = None,
    *,
    smooth_sigma: float = 16.0,
) -> tuple[np.ndarray, float]:
    """Compute smoothed local Laplacian energy inside foreground mask and global frame Laplacian var."""
    from scipy import ndimage

    rgb_f = np.asarray(rgb, dtype=np.float32)
    lum = (0.2126 * rgb_f[..., 0] + 0.7152 * rgb_f[..., 1] + 0.0722 * rgb_f[..., 2]).astype(np.float32)
    lap = ndimage.laplace(lum)

    if mask is not None:
        mk = np.asarray(mask, dtype=bool)
        interior = ndimage.binary_erosion(mk, iterations=2)
        eval_mk = interior if interior.any() else mk
        if eval_mk.any():
            frame_lap_var = float(lap[eval_mk].var())
            fg_abs = np.where(eval_mk, np.abs(lap), 0.0).astype(np.float32)
            weight = eval_mk.astype(np.float32)
            denom = ndimage.gaussian_filter(weight, sigma=float(smooth_sigma))
            num = ndimage.gaussian_filter(fg_abs, sigma=float(smooth_sigma))
            local_sharp = np.where(denom > 1e-6, num / np.maximum(denom, 1e-6), 0.0).astype(np.float32)
        else:
            frame_lap_var = 0.0
            local_sharp = np.zeros_like(lum, dtype=np.float32)
    else:
        frame_lap_var = float(lap.var())
        local_sharp = ndimage.gaussian_filter(np.abs(lap), sigma=float(smooth_sigma)).astype(np.float32)

    return local_sharp, frame_lap_var


def compute_texel_view_score(
    cos_theta: np.ndarray,
    dist: np.ndarray,
    fl_x: float,
    fl_y: float,
    *,
    local_sharpness: np.ndarray | None = None,
    ref_sharpness: float = 1.0,
    mask_dist_px: np.ndarray | None = None,
    boundary_fade_px: float = 8.0,
) -> np.ndarray:
    """Score view suitability by projected pixel area, frontality (cos^3), sharpness, and mask margin."""
    cos_c = np.maximum(np.asarray(cos_theta, dtype=np.float64), 0.0)
    dist_c = np.maximum(np.asarray(dist, dtype=np.float64), 1e-6)
    focal_area = float(fl_x) * float(fl_y)
    score = (cos_c ** 3) * (focal_area / (dist_c ** 2))

    if local_sharpness is not None and float(ref_sharpness) > 1e-12:
        sharp_ratio = np.clip(np.asarray(local_sharpness, dtype=np.float64) / float(ref_sharpness), 0.4, 1.6)
        score = score * (sharp_ratio ** 0.25)

    if mask_dist_px is not None and float(boundary_fade_px) > 0.0:
        margin = np.clip(np.asarray(mask_dist_px, dtype=np.float64) / float(boundary_fade_px), 0.10, 1.0)
        score = score * margin

    return score.astype(np.float64)


def build_face_adjacency(faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return undirected shared-edge face pairs (edge_a, edge_b) for a triangle mesh."""
    f_arr = np.asarray(faces, dtype=np.int64)
    n_faces = len(f_arr)
    if n_faces == 0:
        return np.zeros((0,), dtype=np.int64), np.zeros((0,), dtype=np.int64)

    e01 = np.sort(f_arr[:, [0, 1]], axis=1)
    e12 = np.sort(f_arr[:, [1, 2]], axis=1)
    e20 = np.sort(f_arr[:, [2, 0]], axis=1)
    edges = np.concatenate([e01, e12, e20], axis=0)
    face_ids = np.tile(np.arange(n_faces, dtype=np.int64), 3)

    order = np.lexsort((face_ids, edges[:, 1], edges[:, 0]))
    edges_s = edges[order]
    fids_s = face_ids[order]

    same = (edges_s[:-1, 0] == edges_s[1:, 0]) & (edges_s[:-1, 1] == edges_s[1:, 1])
    fa = fids_s[:-1][same]
    fb = fids_s[1:][same]
    valid = fa != fb
    return fa[valid], fb[valid]


def smooth_face_view_labels(
    face_scores: np.ndarray,
    face_valid: np.ndarray,
    edge_a: np.ndarray,
    edge_b: np.ndarray,
    *,
    potts_weight: float = 0.75,
    n_iters: int = 14,
    min_patch_faces: int = 120,
) -> np.ndarray:
    """Assign each face a coherent visible best view using 3D-adjacency Potts ICM + small-patch cleanup."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components

    scores = np.asarray(face_scores, dtype=np.float32)
    valid = np.asarray(face_valid, dtype=bool)
    n_faces, n_views = scores.shape
    if n_faces == 0 or n_views == 0:
        return np.full((n_faces,), -1, dtype=np.int32)

    any_valid = valid.any(axis=1)
    max_s = np.where(any_valid, np.max(np.where(valid, scores, 0.0), axis=1), 1.0)
    norm_s = np.where(valid, scores / np.maximum(max_s[:, None], 1e-12), -1.0).astype(np.float32)

    # Build up to 3 neighbors per face for fast vectorized Potts updates
    nbrs = np.full((n_faces, 3), -1, dtype=np.int32)
    deg = np.zeros((n_faces,), dtype=np.int32)
    for u, v in zip(edge_a.tolist(), edge_b.tolist()):
        if deg[u] < 3:
            nbrs[u, deg[u]] = v
            deg[u] += 1
        if deg[v] < 3:
            nbrs[v, deg[v]] = u
            deg[v] += 1

    # Gentle neighbor score blend (strictly restricted to visible views) to damp single-face spikes
    if len(edge_a) > 0:
        has_nbr = nbrs >= 0
        safe_nbr = np.where(has_nbr, nbrs, 0)
        accum = norm_s.copy()
        cnt = valid.astype(np.float32)
        for k in range(3):
            nk = safe_nbr[:, k]
            mk = (has_nbr[:, k])[:, None] & valid[nk]
            accum += np.where(mk, np.maximum(norm_s[nk], 0.0), 0.0)
            cnt += mk.astype(np.float32)
        norm_s = np.where(valid, accum / np.maximum(cnt, 1.0), -1.0)

    best_unary = np.where(any_valid, np.argmax(np.where(valid, norm_s, -1.0), axis=1), -1).astype(np.int32)
    labels = best_unary.copy()

    if float(potts_weight) <= 0.0 or int(n_iters) <= 0 or len(edge_a) == 0:
        return labels

    has_nbr = nbrs >= 0
    safe_nbr = np.where(has_nbr, nbrs, 0)
    deg_f = np.maximum(deg.astype(np.float32), 1.0)
    n_batches = 16

    for _ in range(int(n_iters)):
        for phase in range(n_batches):
            idx = np.arange(phase, n_faces, n_batches, dtype=np.int64)
            idx = idx[any_valid[idx]]
            if len(idx) == 0:
                continue
            nbr_lbls = labels[safe_nbr[idx]]  # [K, 3]
            nbr_valid_mask = has_nbr[idx] & (nbr_lbls >= 0)
            cands = np.concatenate([labels[idx, None], best_unary[idx, None], nbr_lbls], axis=1)  # [K, 5]
            cand_ok = cands >= 0
            cands_safe = np.where(cand_ok, cands, 0)
            unary_vals = norm_s[idx[:, None], cands_safe]
            cand_vis = valid[idx[:, None], cands_safe] & cand_ok

            match_cnt = np.sum(
                nbr_valid_mask[:, :, None] & (nbr_lbls[:, :, None] == cands_safe[:, None, :]),
                axis=1,
            ).astype(np.float32)
            total_obj = np.where(
                cand_vis,
                unary_vals + float(potts_weight) * (match_cnt / deg_f[idx, None]),
                -1e9,
            )
            best_c = np.argmax(total_obj, axis=1)
            labels[idx] = cands_safe[np.arange(len(idx)), best_c]

    # Small-patch cleanup: absorb tiny connected patches (< effective_min) into majority visible neighbor view
    effective_min = min(int(min_patch_faces), max(2, n_faces // 60)) if n_faces >= 30 else 0
    if effective_min >= 2 and len(edge_a) > 0:
        for _ in range(3):
            same = (labels[edge_a] >= 0) & (labels[edge_a] == labels[edge_b])
            if not same.any():
                break
            rows = np.concatenate([edge_a[same], edge_b[same]])
            cols = np.concatenate([edge_b[same], edge_a[same]])
            graph = csr_matrix((np.ones(len(rows), dtype=np.int8), (rows, cols)), shape=(n_faces, n_faces))
            n_comp, comp_ids = connected_components(graph, directed=False, return_labels=True)
            comp_sizes = np.bincount(comp_ids, minlength=n_comp)
            small_comps = np.flatnonzero(comp_sizes < effective_min)
            if len(small_comps) == 0:
                break

            # Precompute boundary transitions between components
            diff_e = (labels[edge_a] >= 0) & (labels[edge_b] >= 0) & (labels[edge_a] != labels[edge_b])
            if not diff_e.any():
                break
            ea_d = edge_a[diff_e]
            eb_d = edge_b[diff_e]
            small_set = set(small_comps.tolist())
            comp_faces: dict[int, list[int]] = {}
            for f_i in np.flatnonzero(np.isin(comp_ids, small_comps)).tolist():
                comp_faces.setdefault(int(comp_ids[f_i]), []).append(f_i)
            comp_nbr_views: dict[int, dict[int, int]] = {}
            for fa, fb in zip(ea_d.tolist(), eb_d.tolist()):
                ca, cb = int(comp_ids[fa]), int(comp_ids[fb])
                if ca in small_set:
                    la = int(labels[fb])
                    comp_nbr_views.setdefault(ca, {})[la] = comp_nbr_views.get(ca, {}).get(la, 0) + 1
                if cb in small_set:
                    lb = int(labels[fa])
                    comp_nbr_views.setdefault(cb, {})[lb] = comp_nbr_views.get(cb, {}).get(lb, 0) + 1

            changed = False
            for cid, f_list in comp_faces.items():
                cand_counts = comp_nbr_views.get(cid)
                if not cand_counts:
                    continue
                f_arr = np.asarray(f_list, dtype=np.int64)
                for tgt_view, _cnt in sorted(cand_counts.items(), key=lambda kv: kv[1], reverse=True):
                    if bool(np.all(valid[f_arr, tgt_view])):
                        labels[f_arr] = tgt_view
                        changed = True
                        break
            if not changed:
                break

    return labels


def solve_global_color_levelling(
    obs_rgb_linear: np.ndarray,
    obs_weights: np.ndarray,
    *,
    reg_gain: float = 0.08,
    reg_offset: float = 0.50,
    irls_iters: int = 3,
    huber_delta: float = 0.04,
    gain_bounds: tuple[float, float] = (0.80, 1.25),
    offset_bounds: tuple[float, float] = (-0.02, 0.02),
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Solve per-view linear-light exposure gain & tightly bounded offset across overlapping samples."""
    rgb = np.asarray(obs_rgb_linear, dtype=np.float64)
    w_base = np.asarray(obs_weights, dtype=np.float64)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or w_base.shape != rgb.shape[:2]:
        raise ValueError(f"Shape mismatch: obs_rgb_linear={rgb.shape}, obs_weights={w_base.shape}")

    n_pts, n_views, _ = rgb.shape
    gains = np.ones((n_views, 3), dtype=np.float64)
    offsets = np.zeros((n_views, 3), dtype=np.float64)

    overlap_mask = (w_base > 0.0).sum(axis=1) >= 2
    if n_pts == 0 or n_views < 2 or not overlap_mask.any():
        return gains.astype(np.float32), offsets.astype(np.float32), {
            "overlap_points": 0,
            "mean_abs_residual_before": 0.0,
            "mean_abs_residual_after": 0.0,
            "gain_min": 1.0,
            "gain_max": 1.0,
            "offset_min": 0.0,
            "offset_max": 0.0,
        }

    rgb_ov = rgb[overlap_mask]
    w_ov = w_base[overlap_mask]
    m_b = (w_ov > 0.0).astype(np.float64)
    view_w_tot = w_ov.sum(axis=0)
    eye_v = np.eye(n_views, dtype=np.float64)

    # Initial consensus residual before levelling
    w_sum0 = np.maximum(w_ov.sum(axis=1, keepdims=True), 1e-12)
    mu0 = np.sum(w_ov[..., None] * rgb_ov, axis=1, keepdims=True) / w_sum0[..., None]
    res0 = np.abs(rgb_ov - mu0)
    valid_ov = w_ov > 0.0
    before_res = float(np.average(res0[valid_ov])) if valid_ov.any() else 0.0

    for ch in range(3):
        m_g = np.where(valid_ov, rgb_ov[..., ch], 0.0)
        w_cur = w_ov.copy()
        g_ch = np.ones((n_views,), dtype=np.float64)
        b_ch = np.zeros((n_views,), dtype=np.float64)

        for _ in range(max(1, int(irls_iters))):
            w_sum = np.maximum(w_cur.sum(axis=1, keepdims=True), 1e-12)
            inv_sqrt_w = 1.0 / np.sqrt(w_sum)
            ug = w_cur * m_g
            ub = w_cur * m_b
            ug_n = ug * inv_sqrt_w
            ub_n = ub * inv_sqrt_w

            nv = np.maximum(w_cur.sum(axis=0), 1e-6)
            h_gg = np.diag((w_cur * m_g * m_g).sum(axis=0) + float(reg_gain) * nv) - (ug_n.T @ ug_n)
            h_gb = np.diag((w_cur * m_g * m_b).sum(axis=0)) - (ug_n.T @ ub_n)
            h_bb = np.diag((w_cur * m_b).sum(axis=0) + float(reg_offset) * nv) - (ub_n.T @ ub_n)

            h_mat = np.block([[h_gg, h_gb], [h_gb.T, h_bb]]) + 1e-6 * np.eye(2 * n_views)
            rhs = np.concatenate([float(reg_gain) * nv, np.zeros((n_views,), dtype=np.float64)])
            sol = np.linalg.solve(h_mat, rhs)
            g_ch = np.clip(sol[:n_views], gain_bounds[0], gain_bounds[1])
            b_ch = np.clip(sol[n_views:], offset_bounds[0], offset_bounds[1])

            y_cur = m_g * g_ch[None, :] + m_b * b_ch[None, :]
            mu_cur = (w_cur * y_cur).sum(axis=1, keepdims=True) / w_sum
            abs_r = np.abs(y_cur - mu_cur)
            huber_w = np.where(abs_r <= float(huber_delta), 1.0, float(huber_delta) / np.maximum(abs_r, 1e-9))
            w_cur = w_ov * huber_w

        # Re-center weighted mean gain=1, offset=0 so global exposure/white-balance stays anchored
        active_v = view_w_tot > 0.0
        if active_v.any():
            vw = view_w_tot[active_v]
            g_mean = float(np.sum(vw * g_ch[active_v]) / np.sum(vw))
            b_mean = float(np.sum(vw * b_ch[active_v]) / np.sum(vw))
            g_ch = np.clip(g_ch / max(g_mean, 1e-6), gain_bounds[0], gain_bounds[1])
            b_ch = np.clip((b_ch - b_mean) / max(g_mean, 1e-6), offset_bounds[0], offset_bounds[1])

        gains[:, ch] = g_ch
        offsets[:, ch] = b_ch

    # Residual after levelling
    y_after = rgb_ov * gains[None, :, :] + offsets[None, :, :]
    mu_after = np.sum(w_ov[..., None] * y_after, axis=1, keepdims=True) / w_sum0[..., None]
    res_after = np.abs(y_after - mu_after)
    after_res = float(np.average(res_after[valid_ov])) if valid_ov.any() else 0.0

    del eye_v
    return gains.astype(np.float32), offsets.astype(np.float32), {
        "overlap_points": int(overlap_mask.sum()),
        "mean_abs_residual_before": round(before_res, 6),
        "mean_abs_residual_after": round(after_res, 6),
        "gain_min": round(float(gains.min()), 4),
        "gain_max": round(float(gains.max()), 4),
        "offset_min": round(float(offsets.min()), 5),
        "offset_max": round(float(offsets.max()), 5),
    }


def solve_color_levelling_field(
    obs_rgb_linear: np.ndarray,
    obs_weights: np.ndarray,
    obs_xy_norm: np.ndarray | None = None,
    *,
    spatial_order: int = 1,
    reg_gain: float = 0.004,
    reg_spatial: float = 0.04,
    reg_offset: float = 0.20,
    reg_wb: float = 0.004,
    chroma_weight: float = 1.2,
    irls_iters: int = 3,
    huber_delta: float = 0.035,
    gain_bounds: tuple[float, float] = (0.70, 1.45),
    spatial_bounds: tuple[float, float] = (-0.20, 0.20),
    offset_bounds: tuple[float, float] = (-0.03, 0.03),
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Fit per-view 3-channel low-frequency colour field (g0 + gx*x + gy*y) + offset with chroma term."""
    rgb = np.asarray(obs_rgb_linear, dtype=np.float64)
    w_base = np.asarray(obs_weights, dtype=np.float64)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or w_base.shape != rgb.shape[:2]:
        raise ValueError(f"Shape mismatch: obs_rgb_linear={rgb.shape}, obs_weights={w_base.shape}")
    n_pts, n_views, _ = rgb.shape
    if obs_xy_norm is not None:
        xy = np.asarray(obs_xy_norm, dtype=np.float64)
        if xy.shape != (n_pts, n_views, 2):
            raise ValueError(f"obs_xy_norm shape mismatch: {xy.shape} vs {(n_pts, n_views, 2)}")
    else:
        xy = np.zeros((n_pts, n_views, 2), dtype=np.float64)

    gain_params = np.zeros((n_views, 3, 3), dtype=np.float64)
    gain_params[:, :, 0] = 1.0
    offsets = np.zeros((n_views, 3), dtype=np.float64)

    overlap_mask = (w_base > 0.0).sum(axis=1) >= 2
    if n_pts == 0 or n_views < 2 or not overlap_mask.any():
        return gain_params.astype(np.float32), offsets.astype(np.float32), {
            "mode": "spatial_chroma",
            "overlap_points": 0,
            "mean_abs_residual_before": 0.0,
            "mean_abs_residual_after": 0.0,
            "chroma_residual_before": 0.0,
            "chroma_residual_after": 0.0,
            "gain_min": 1.0,
            "gain_max": 1.0,
            "spatial_max_abs": 0.0,
            "offset_min": 0.0,
            "offset_max": 0.0,
        }

    rgb_ov = rgb[overlap_mask]
    w_ov = w_base[overlap_mask]
    xy_ov = xy[overlap_mask]
    valid_ov = w_ov > 0.0
    n_ov = len(rgb_ov)
    view_w_tot = w_ov.sum(axis=0)
    use_spatial = int(spatial_order) >= 1 and obs_xy_norm is not None

    w_sum0 = np.maximum(w_ov.sum(axis=1, keepdims=True), 1e-12)
    mu0 = np.sum(w_ov[..., None] * rgb_ov, axis=1, keepdims=True) / w_sum0[..., None]
    before_res = float(np.average(np.abs(rgb_ov - mu0)[valid_ov])) if valid_ov.any() else 0.0
    chr0 = np.stack([rgb_ov[..., 0] - rgb_ov[..., 1], rgb_ov[..., 2] - rgb_ov[..., 1]], axis=-1)
    chrm0 = np.stack([mu0[..., 0] - mu0[..., 1], mu0[..., 2] - mu0[..., 1]], axis=-1)
    before_chr = float(np.average(np.abs(chr0 - chrm0)[valid_ov])) if valid_ov.any() else 0.0

    # Joint 3-channel metric: L2 + chroma_weight * ||(I - 1/3 11^T) r||^2
    m_col = np.eye(3, dtype=np.float64) + float(chroma_weight) * (
        np.eye(3, dtype=np.float64) - np.full((3, 3), 1.0 / 3.0, dtype=np.float64)
    )
    evals, evecs = np.linalg.eigh(m_col)
    m_sqrt = evecs @ np.diag(np.sqrt(np.maximum(evals, 0.0))) @ evecs.T

    # 12 params per view: 4 per channel [g0, gx, gy, b]
    x_v = np.where(valid_ov, np.clip(xy_ov[..., 0], -1.0, 1.0), 0.0) if use_spatial else np.zeros((n_ov, n_views))
    y_v = np.where(valid_ov, np.clip(xy_ov[..., 1], -1.0, 1.0), 0.0) if use_spatial else np.zeros((n_ov, n_views))
    m_v = np.where(valid_ov[..., None], rgb_ov, 0.0)
    v_ind = valid_ov.astype(np.float64)

    a_mat = np.zeros((n_ov, n_views, 3, 12), dtype=np.float64)
    for ch in range(3):
        a_mat[:, :, ch, 4 * ch + 0] = m_v[:, :, ch]
        a_mat[:, :, ch, 4 * ch + 1] = m_v[:, :, ch] * x_v
        a_mat[:, :, ch, 4 * ch + 2] = m_v[:, :, ch] * y_v
        a_mat[:, :, ch, 4 * ch + 3] = v_ind

    sp_reg = float(reg_spatial) if use_spatial else 1e6
    reg_12 = np.tile(np.array([float(reg_gain), sp_reg, sp_reg, float(reg_offset)], dtype=np.float64), 3)
    # Mild cross-channel g0 white-balance coupling: reg_wb * sum_c (g0_c - mean_c(g0))^2
    wb_mat = np.zeros((12, 12), dtype=np.float64)
    g0_idx = [0, 4, 8]
    for i_a in g0_idx:
        for i_b in g0_idx:
            wb_mat[i_a, i_b] += (2.0 / 3.0 if i_a == i_b else -1.0 / 3.0) * float(reg_wb)

    w_cur = w_ov.copy()
    sol = np.zeros((n_views, 3, 4), dtype=np.float64)
    sol[:, :, 0] = 1.0

    for _ in range(max(1, int(irls_iters))):
        w_sum = np.maximum(w_cur.sum(axis=1, keepdims=True), 1e-12)
        u_raw = (w_cur[:, :, None, None] / np.sqrt(w_sum)[:, :, None, None]) * a_mat  # [N, V, 3, 12]
        um = np.einsum("cd,nvdj->ncvj", m_sqrt, u_raw).reshape(n_ov * 3, n_views * 12)
        h_mat = -(um.T @ um)
        nv_v = np.maximum(w_cur.sum(axis=0), 1e-6)
        rhs = np.zeros((n_views * 12,), dtype=np.float64)
        for vi in range(n_views):
            ma_v = np.einsum("cd,ndj->ncj", m_sqrt, a_mat[:, vi]) * np.sqrt(w_cur[:, vi])[:, None, None]
            ma_f = ma_v.reshape(n_ov * 3, 12)
            blk = ma_f.T @ ma_f + (np.diag(reg_12) + wb_mat) * nv_v[vi]
            h_mat[12 * vi : 12 * vi + 12, 12 * vi : 12 * vi + 12] += blk
            for ch in range(3):
                rhs[12 * vi + 4 * ch] = float(reg_gain) * nv_v[vi]
        h_mat += 1e-6 * np.eye(n_views * 12)
        sol = np.linalg.solve(h_mat, rhs).reshape(n_views, 3, 4)
        sol[:, :, 0] = np.clip(sol[:, :, 0], gain_bounds[0], gain_bounds[1])
        if use_spatial:
            sol[:, :, 1:3] = np.clip(sol[:, :, 1:3], spatial_bounds[0], spatial_bounds[1])
        else:
            sol[:, :, 1:3] = 0.0
        sol[:, :, 3] = np.clip(sol[:, :, 3], offset_bounds[0], offset_bounds[1])

        g_pt = np.clip(
            sol[None, :, :, 0] + sol[None, :, :, 1] * x_v[:, :, None] + sol[None, :, :, 2] * y_v[:, :, None],
            gain_bounds[0] - 0.1,
            gain_bounds[1] + 0.1,
        )
        pred = np.where(valid_ov[..., None], rgb_ov * g_pt + sol[None, :, :, 3], 0.0)
        mu_cur = np.sum(w_cur[..., None] * pred, axis=1, keepdims=True) / w_sum[..., None]
        diff = pred - mu_cur
        # Joint 3-channel residual norm (including chroma weight)
        diff_m = np.einsum("cd,nvd->nvc", m_sqrt, diff)
        r_norm = np.sqrt(np.mean(diff_m * diff_m, axis=-1))
        huber_w = np.where(r_norm <= float(huber_delta), 1.0, float(huber_delta) / np.maximum(r_norm, 1e-9))
        w_cur = w_ov * huber_w

    # Re-center across active views once after IRLS convergence so global exposure/WB stay anchored
    active_v = view_w_tot > 0.0
    if active_v.any():
        vw = view_w_tot[active_v] / np.sum(view_w_tot[active_v])
        g0_mean = np.sum(vw[:, None] * sol[active_v, :, 0], axis=0)
        gx_mean = np.sum(vw[:, None] * sol[active_v, :, 1], axis=0)
        gy_mean = np.sum(vw[:, None] * sol[active_v, :, 2], axis=0)
        b_mean = np.sum(vw[:, None] * sol[active_v, :, 3], axis=0)
        sol[:, :, 0] = np.clip(sol[:, :, 0] / np.maximum(g0_mean[None, :], 1e-6), gain_bounds[0], gain_bounds[1])
        if use_spatial:
            sol[:, :, 1] = np.clip(sol[:, :, 1] - gx_mean[None, :], spatial_bounds[0], spatial_bounds[1])
            sol[:, :, 2] = np.clip(sol[:, :, 2] - gy_mean[None, :], spatial_bounds[0], spatial_bounds[1])
        sol[:, :, 3] = np.clip((sol[:, :, 3] - b_mean[None, :]) / np.maximum(g0_mean[None, :], 1e-6), offset_bounds[0], offset_bounds[1])

    gain_params = sol[:, :, :3]
    offsets = sol[:, :, 3]

    g_final = np.clip(
        gain_params[None, :, :, 0] + gain_params[None, :, :, 1] * x_v[:, :, None] + gain_params[None, :, :, 2] * y_v[:, :, None],
        0.60,
        1.60,
    )
    y_after = rgb_ov * g_final + offsets[None, :, :]
    mu_after = np.sum(w_ov[..., None] * y_after, axis=1, keepdims=True) / w_sum0[..., None]
    after_res = float(np.average(np.abs(y_after - mu_after)[valid_ov])) if valid_ov.any() else 0.0
    chra = np.stack([y_after[..., 0] - y_after[..., 1], y_after[..., 2] - y_after[..., 1]], axis=-1)
    chrma = np.stack([mu_after[..., 0] - mu_after[..., 1], mu_after[..., 2] - mu_after[..., 1]], axis=-1)
    after_chr = float(np.average(np.abs(chra - chrma)[valid_ov])) if valid_ov.any() else 0.0

    return gain_params.astype(np.float32), offsets.astype(np.float32), {
        "mode": "spatial_chroma" if use_spatial else "global_chroma",
        "overlap_points": int(n_ov),
        "mean_abs_residual_before": round(before_res, 6),
        "mean_abs_residual_after": round(after_res, 6),
        "chroma_residual_before": round(before_chr, 6),
        "chroma_residual_after": round(after_chr, 6),
        "gain_min": round(float(gain_params[:, :, 0].min()), 4),
        "gain_max": round(float(gain_params[:, :, 0].max()), 4),
        "spatial_max_abs": round(float(np.abs(gain_params[:, :, 1:3]).max()), 4),
        "offset_min": round(float(offsets.min()), 5),
        "offset_max": round(float(offsets.max()), 5),
    }


def apply_color_levelling_field(
    sampled_srgb: np.ndarray,
    uv_img: np.ndarray,
    img_w: int,
    img_h: int,
    gain_params_v: np.ndarray,
    offset_v: np.ndarray,
    *,
    gain_bounds: tuple[float, float] = (0.60, 1.60),
) -> np.ndarray:
    """Apply per-view low-frequency 2D colour field (g0 + gx*x + gy*y, offset) in linear light."""
    lin = srgb_to_linear(sampled_srgb)
    gp = np.asarray(gain_params_v, dtype=np.float32)
    off = np.asarray(offset_v, dtype=np.float32)
    if gp.shape == (3,):
        g_eff = gp[None, :]
    else:
        x_norm = np.clip((uv_img[:, 0] / max(float(img_w), 1.0)) * 2.0 - 1.0, -1.0, 1.0).astype(np.float32)
        y_norm = np.clip((uv_img[:, 1] / max(float(img_h), 1.0)) * 2.0 - 1.0, -1.0, 1.0).astype(np.float32)
        g_eff = np.clip(
            gp[None, :, 0] + gp[None, :, 1] * x_norm[:, None] + gp[None, :, 2] * y_norm[:, None],
            gain_bounds[0],
            gain_bounds[1],
        )
    return linear_to_srgb(np.clip(lin * g_eff + off[None, :], 0.0, 1.0))


def inpaint_unprojected_texels(
    atlas_rgb: np.ndarray,
    valid_mask: np.ndarray,
    good_proj_mask: np.ndarray,
    *,
    smooth_iters: int = 3,
    downward_base_mask: np.ndarray | None = None,
    downward_base_color: Sequence[float] | np.ndarray | None = None,
    isolated_wall_mask: np.ndarray | None = None,
    isolated_wall_color: Sequence[float] | np.ndarray | None = None,
) -> tuple[np.ndarray, dict[str, int]]:
    """Inpaint valid UV texels lacking a good photo projection from neighbouring projected texels.

    Strictly downward table-contact base texels (``downward_base_mask``) are isolated from food
    neighbour propagation and filled with ``downward_base_color`` (muted dark neutral/rim-median)
    so bright top food colours cannot bleed onto the table-contact base. Isolated unprojected
    side-wall islands (``isolated_wall_mask`` with no projected texels in their UV component) can
    optionally fall back to ``isolated_wall_color`` instead of raw TSDF vertex-colour patches.
    """
    from scipy import ndimage

    out = np.array(atlas_rgb, dtype=np.float32, copy=True)
    valid = np.asarray(valid_mask, dtype=bool)
    good = valid & np.asarray(good_proj_mask, dtype=bool)

    down_filled = 0
    if downward_base_mask is not None:
        down_mask = valid & np.asarray(downward_base_mask, dtype=bool)
        down_need = down_mask & (~good)
        down_filled = int(down_need.sum())
        if down_filled > 0:
            tone = (
                np.asarray(downward_base_color, dtype=np.float32).reshape(3)
                if downward_base_color is not None
                else np.array([0.12, 0.11, 0.10], dtype=np.float32)
            )
            out[down_need] = np.clip(tone, 0.0, 1.0)
        inpaint_domain = valid & (~down_mask)
        good_src = inpaint_domain & good
        need = inpaint_domain & (~good)
    else:
        inpaint_domain = valid
        good_src = good
        need = valid & (~good)

    iso_wall_filled = 0
    n_need = int(need.sum())
    if n_need == 0 or not good_src.any():
        if isolated_wall_mask is not None and isolated_wall_color is not None and n_need > 0 and not good_src.any():
            iso_need = need & np.asarray(isolated_wall_mask, dtype=bool)
            iso_wall_filled = int(iso_need.sum())
            if iso_wall_filled > 0:
                out[iso_need] = np.clip(np.asarray(isolated_wall_color, dtype=np.float32).reshape(3), 0.0, 1.0)
        return out, {
            "inpainted_texels": 0,
            "good_texels": int(good.sum()),
            "downward_base_filled": down_filled,
            "isolated_wall_filled": iso_wall_filled,
        }

    # 1. Iterative 8-step masked spread strictly inside each connected valid island (never crosses UV gutters)
    filled = good_src.copy()
    cur = out.copy()
    for _ in range(8):
        need_cur = inpaint_domain & (~filled)
        if not need_cur.any():
            break
        # 8-neighbor average of currently filled texels inside inpaint_domain
        num = np.zeros_like(cur)
        den = np.zeros(cur.shape[:2], dtype=np.float32)
        f_fl = filled.astype(np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ys_dst = slice(max(0, dy), cur.shape[0] + min(0, dy))
                xs_dst = slice(max(0, dx), cur.shape[1] + min(0, dx))
                ys_src = slice(max(0, -dy), cur.shape[0] - max(0, dy))
                xs_src = slice(max(0, -dx), cur.shape[1] - max(0, dx))
                w_nb = f_fl[ys_src, xs_src]
                num[ys_dst, xs_dst] += cur[ys_src, xs_src] * w_nb[..., None]
                den[ys_dst, xs_dst] += w_nb
        hit = need_cur & (den > 0.0)
        if not hit.any():
            break
        cur[hit] = num[hit] / den[hit, None]
        filled[hit] = True

    # 2. Remaining interior texels on islands that contain good_src fall back to same-component EDT;
    # completely isolated unprojected islands either fall back to isolated_wall_color (for side-wall
    # islands) or preserve their baked vertex-color fallback (atlas_rgb).
    still_need = inpaint_domain & (~filled)
    if still_need.any():
        uv_comp, n_comp = ndimage.label(inpaint_domain, structure=np.ones((3, 3), dtype=bool))
        _, indices = ndimage.distance_transform_edt(~good_src, return_indices=True)
        same_comp = still_need & (uv_comp[indices[0], indices[1]] == uv_comp)
        if same_comp.any():
            cur[same_comp] = cur[indices[0][same_comp], indices[1][same_comp]]
            filled[same_comp] = True
        if isolated_wall_mask is not None and isolated_wall_color is not None:
            comp_has_good = np.zeros(int(n_comp) + 1, dtype=bool)
            comp_has_good[uv_comp[good_src]] = True
            iso_wall = still_need & (~comp_has_good[uv_comp]) & np.asarray(isolated_wall_mask, dtype=bool)
            iso_wall_filled = int(iso_wall.sum())
            if iso_wall_filled > 0:
                iso_tone = np.clip(np.asarray(isolated_wall_color, dtype=np.float32).reshape(3), 0.0, 1.0)
                cur[iso_wall] = iso_tone
                filled[iso_wall] = True

    inpaint_mask = filled & (~good_src) & inpaint_domain
    out[inpaint_mask] = cur[inpaint_mask]

    # Gentle masked smoothing passes restricted strictly to filled inpainted texels inside inpaint_domain
    if inpaint_mask.any():
        for _ in range(max(0, int(smooth_iters))):
            blurred = np.stack(
                [ndimage.gaussian_filter(np.where(inpaint_domain, out[..., c], 0.0), sigma=1.2) for c in range(3)],
                axis=-1,
            )
            denom = ndimage.gaussian_filter(inpaint_domain.astype(np.float32), sigma=1.2)
            safe = np.where(denom[..., None] > 1e-6, blurred / np.maximum(denom[..., None], 1e-6), out)
            out[inpaint_mask] = np.clip(safe[inpaint_mask], 0.0, 1.0)

    return out, {
        "inpainted_texels": int(inpaint_mask.sum()),
        "good_texels": int(good.sum()),
        "downward_base_filled": down_filled,
        "isolated_wall_filled": iso_wall_filled,
    }


def detect_uv_seam_pixels(
    valid_mask: np.ndarray,
    label_atlas: np.ndarray,
    *,
    seam_seed_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Find valid UV pixels on a view-label transition boundary and their neighbor view label."""
    valid = np.asarray(valid_mask, dtype=bool)
    labels = np.asarray(label_atlas, dtype=np.int32)
    h, w = valid.shape
    is_seam = np.zeros((h, w), dtype=bool)
    nbr_label = np.full((h, w), -1, dtype=np.int32)

    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
        y0 = max(0, -dy)
        y1 = min(h, h - dy)
        x0 = max(0, -dx)
        x1 = min(w, w - dx)
        src_v = valid[y0:y1, x0:x1] & valid[y0 + dy : y1 + dy, x0 + dx : x1 + dx]
        src_l = labels[y0:y1, x0:x1]
        dst_l = labels[y0 + dy : y1 + dy, x0 + dx : x1 + dx]
        diff = src_v & (src_l >= 0) & (dst_l >= 0) & (src_l != dst_l)
        if diff.any():
            sub_seam = is_seam[y0:y1, x0:x1]
            sub_nbr = nbr_label[y0:y1, x0:x1]
            update = diff & (~sub_seam)
            sub_nbr[update] = dst_l[update]
            sub_seam |= diff

    if seam_seed_mask is not None:
        is_seam |= valid & np.asarray(seam_seed_mask, dtype=bool) & (labels >= 0)
    return is_seam, nbr_label


def blend_narrow_seam_band(
    primary_rgb: np.ndarray,
    other_rgb: np.ndarray,
    other_valid: np.ndarray,
    valid_mask: np.ndarray,
    label_atlas: np.ndarray,
    *,
    seam_radius_px: float = 4.0,
    seam_seed_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Blend primary view with alternate view only inside a narrow band around view seams."""
    from scipy import ndimage

    out = np.array(primary_rgb, dtype=np.float32, copy=True)
    valid = np.asarray(valid_mask, dtype=bool)
    alt_ok = np.asarray(other_valid, dtype=bool)
    if float(seam_radius_px) <= 0.0 or not valid.any():
        return out, np.zeros_like(valid, dtype=bool)

    is_seam, _ = detect_uv_seam_pixels(valid, label_atlas, seam_seed_mask=seam_seed_mask)
    if not is_seam.any():
        return out, np.zeros_like(valid, dtype=bool)

    dist = ndimage.distance_transform_edt(~is_seam)
    seam_band = valid & alt_ok & (dist <= float(seam_radius_px))
    if not seam_band.any():
        return out, seam_band

    w_primary = 0.5 + 0.5 * np.clip(dist[seam_band] / max(float(seam_radius_px), 1e-6), 0.0, 1.0)
    w_primary = w_primary[:, None].astype(np.float32)
    out[seam_band] = w_primary * primary_rgb[seam_band] + (1.0 - w_primary) * other_rgb[seam_band]
    return np.clip(out, 0.0, 1.0).astype(np.float32), seam_band


def measure_seam_visibility(
    tex_rgb: np.ndarray,
    valid_mask: np.ndarray,
    label_atlas: np.ndarray,
) -> dict[str, Any]:
    """Measure Lab Delta E across view-label seam transitions vs same-view interior neighbors."""
    rgb = np.asarray(tex_rgb, dtype=np.float32)
    if rgb.max() > 1.0:
        rgb = rgb / 255.0
    valid = np.asarray(valid_mask, dtype=bool) & (np.asarray(label_atlas, dtype=np.int32) >= 0)
    labels = np.asarray(label_atlas, dtype=np.int32)
    lab = _linear_rgb_to_lab(srgb_to_linear(rgb))

    seam_des: list[np.ndarray] = []
    int_des: list[np.ndarray] = []
    for dy, dx in ((0, 1), (1, 0)):
        h, w = valid.shape
        v_pair = valid[: h - dy, : w - dx] & valid[dy:, dx:]
        if not v_pair.any():
            continue
        de = np.linalg.norm(lab[: h - dy, : w - dx][v_pair] - lab[dy:, dx:][v_pair], axis=-1)
        same_lbl = labels[: h - dy, : w - dx][v_pair] == labels[dy:, dx:][v_pair]
        if (~same_lbl).any():
            seam_des.append(de[~same_lbl])
        if same_lbl.any():
            int_des.append(de[same_lbl])

    seam_arr = np.concatenate(seam_des) if seam_des else np.zeros((0,), dtype=np.float32)
    int_arr = np.concatenate(int_des) if int_des else np.zeros((0,), dtype=np.float32)
    seam_mean = float(seam_arr.mean()) if len(seam_arr) else 0.0
    seam_p95 = float(np.percentile(seam_arr, 95)) if len(seam_arr) else 0.0
    int_mean = float(int_arr.mean()) if len(int_arr) else 0.0
    return {
        "seam_boundary_edges": int(len(seam_arr)),
        "interior_edges": int(len(int_arr)),
        "seam_mean_delta_e": round(seam_mean, 4),
        "seam_p95_delta_e": round(seam_p95, 4),
        "interior_mean_delta_e": round(int_mean, 4),
        "seam_excess_delta_e": round(seam_mean - int_mean, 4),
    }


def compute_face_luminance_quantiles(
    face_lum: np.ndarray,
    face_weight: np.ndarray,
    quantiles: Sequence[float],
) -> np.ndarray:
    """Weighted per-view luminance quantiles for each face (rows with no valid view are NaN)."""
    lum = np.asarray(face_lum, dtype=np.float64)
    w = np.asarray(face_weight, dtype=np.float64)
    if lum.shape != w.shape:
        raise ValueError("face_lum and face_weight must share a shape")
    valid = np.isfinite(lum) & (w > 0.0)
    key = np.where(valid, lum, np.inf)
    order = np.argsort(key, axis=1, kind="stable")
    lum_s = np.take_along_axis(key, order, axis=1)
    w_s = np.take_along_axis(np.where(valid, w, 0.0), order, axis=1)
    cum = np.cumsum(w_s, axis=1)
    total = cum[:, -1]
    out = np.full((lum.shape[0], len(quantiles)), np.nan, dtype=np.float64)
    ok = total > 1e-12
    if ok.any():
        cumn = cum[ok] / total[ok, None]
        for k, q in enumerate(quantiles):
            idx = np.argmax(cumn >= float(q), axis=1)
            out[ok, k] = np.take_along_axis(lum_s[ok], idx[:, None], axis=1)[:, 0]
    return out.astype(np.float32)


def compute_bright_concave_target_weight(
    ao: np.ndarray,
    spread: np.ndarray,
    *,
    ao_thresh: float = 0.95,
    ao_ramp: float = 0.30,
    spread_thresh: float = 0.35,
    spread_ramp: float = 0.45,
    spread_max: float = 0.85,
) -> np.ndarray:
    """Per-texel blend weight toward the bright upper-percentile colour for concave/shadow-spread texels."""
    a = np.asarray(ao, dtype=np.float32)
    s = np.asarray(spread, dtype=np.float32)
    w_ao = np.clip((float(ao_thresh) - a) / max(float(ao_ramp), 1e-6), 0.0, 1.0)
    w_spread = np.clip((s - float(spread_thresh)) / max(float(spread_ramp), 1e-6), 0.0, float(spread_max))
    return np.maximum(w_ao, w_spread).astype(np.float32)


def compute_bright_concave_upper_color(
    samples_u8: np.ndarray,
    weights: np.ndarray,
    base_srgb: np.ndarray,
    *,
    q_lo: float = 0.60,
    q_hi: float = 0.92,
    chroma_sigma: float = 0.22,
    chunk: int = 50000,
) -> np.ndarray:
    """Robust per-texel upper-percentile colour from the luminance band [q_lo, q_hi] of a texel's views.

    For each row the per-view luminances are weighted-sorted, the weighted q_lo/q_hi
    luminance band is selected, chroma outliers against the view-weighted mean chroma
    are down-weighted, and the remaining observations are averaged. Rows with no valid
    observation keep ``base_srgb``. Samples are sRGB-encoded (uint8); averaging happens
    in linear light. This prefers the less self-shadowed observations of concave texels
    instead of the single darkest perpendicicular view that best-view scoring can pick.
    """
    samples = np.asarray(samples_u8)
    w = np.asarray(weights, dtype=np.float32)
    base = np.asarray(base_srgb, dtype=np.float32)
    if samples.ndim != 3 or samples.shape[2] != 3:
        raise ValueError("samples_u8 must have shape (n, n_views, 3)")
    if samples.shape[:2] != w.shape:
        raise ValueError("samples_u8 and weights must share (n, n_views)")
    out = np.array(base, dtype=np.float32, copy=True)
    n = samples.shape[0]
    if n == 0:
        return out
    for s0 in range(0, n, max(1, int(chunk))):
        s1 = min(n, s0 + max(1, int(chunk)))
        sub_srgb = samples[s0:s1].astype(np.float32) / 255.0
        sub_w = w[s0:s1]
        sub_lin = srgb_to_linear(sub_srgb)
        sub_lum = 0.2126 * sub_lin[..., 0] + 0.7152 * sub_lin[..., 1] + 0.0722 * sub_lin[..., 2]
        sub_val = sub_w > 1e-4
        w_eff = np.where(sub_val, sub_w, 0.0)
        order = np.argsort(np.where(sub_val, sub_lum, np.inf), axis=1)
        w_s = np.take_along_axis(w_eff, order, axis=1)
        l_s = np.take_along_axis(sub_lum, order, axis=1)
        tot_w = np.maximum(w_s.sum(axis=1, keepdims=True), 1e-8)
        cum_w = np.cumsum(w_s, axis=1) / tot_w
        chr_vec = sub_lin / np.maximum(sub_lum[..., None], 1e-3)
        chr_med = np.sum(chr_vec * w_eff[..., None], axis=1, keepdims=True) / np.maximum(tot_w[..., None], 1e-8)
        chr_ok = np.exp(-((np.linalg.norm(chr_vec - chr_med, axis=-1) / float(chroma_sigma)) ** 2))
        rows = np.arange(s1 - s0)
        i_lo = np.argmax(cum_w >= float(q_lo), axis=1)
        i_hi = np.argmax(cum_w >= float(q_hi), axis=1)
        l_lo = l_s[rows, i_lo][:, None]
        l_hi = l_s[rows, i_hi][:, None]
        band = sub_val & (sub_lum >= l_lo - 1e-5) & (sub_lum <= l_hi + 1e-5)
        wb = np.where(band, w_eff * chr_ok, 0.0)
        wsum = wb.sum(axis=1)
        mean_lin = np.sum(sub_lin * wb[..., None], axis=1) / np.maximum(wsum[:, None], 1e-8)
        res_srgb = linear_to_srgb(np.clip(mean_lin, 0.0, 1.0))
        keep_row = np.flatnonzero(wsum > 1e-8) + s0
        out[keep_row] = res_srgb[wsum > 1e-8].astype(np.float32)
    return out


def accumulate_specular_gloss(
    accum_lum: np.ndarray,
    accum_lum2: np.ndarray,
    accum_lum_max: np.ndarray,
    accum_views: np.ndarray,
    *,
    min_views: int = 3,
    gloss_scale: float = 0.32,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Turn per-view luminance accumulators into a per-texel view-angle gloss cue.

    A texel that is much brighter in its brightest view than in its average view is picking up a
    moving specular highlight (glossy); a matte texel stays near its mean. Returns
    (gloss in [0, 1], relative luminance variance, observed-view mask).
    """
    n_obs = np.maximum(np.asarray(accum_views, dtype=np.float64), 1.0)
    mean_lum = np.asarray(accum_lum, dtype=np.float64) / n_obs
    var_lum = np.maximum(np.asarray(accum_lum2, dtype=np.float64) / n_obs - mean_lum * mean_lum, 0.0)
    enough = np.asarray(accum_views) >= int(min_views)
    excursion = np.where(enough, np.asarray(accum_lum_max, dtype=np.float64) - mean_lum, 0.0)
    gloss = np.clip(excursion / max(float(gloss_scale), 1e-6), 0.0, 1.0).astype(np.float32)
    rel_var = np.where(enough, var_lum / np.maximum(mean_lum * mean_lum, 0.02), 0.0)
    return gloss, rel_var.astype(np.float32), enough


def project_train_photos_to_uv(
    geom_glb: Path,
    maps_dir: Path,
    dataset_dir: Path,
    m_world_to_glb: np.ndarray,
    *,
    view_stride: int = 1,
    min_cos: float = 0.15,
    refined_poses_path: Path | None = None,
    texture_mode: str = "blend",
    seam_width_px: float = 3.0,
    potts_weight: float = 0.75,
    color_levelling: bool = True,
    color_field: bool = False,
    inpaint_unprojected: bool = False,
    specular_gloss_out: Path | None = None,
    specular_min_views: int = 3,
    specular_gloss_scale: float = 0.32,
    bright_concave: bool = False,
    bright_concave_q_lo: float = 0.60,
    bright_concave_q_hi: float = 0.92,
    bright_concave_ao_thresh: float = 0.95,
    bright_concave_ao_ramp: float = 0.30,
    bright_concave_spread_thresh: float = 0.35,
    bright_concave_spread_ramp: float = 0.45,
    bright_concave_spread_max: float = 0.85,
) -> dict[str, Any]:
    """Project real train photos onto a baked UV atlas using Open3D raycasting visibility.

    Overwrites maps_dir/basecolor.png (saving basecolor_tsdf.png as backup) so unseen
    texels fall back cleanly to the Cycles-baked TSDF vertex color.
    """
    import open3d as o3d
    import trimesh
    from scipy import ndimage

    if texture_mode not in ("blend", "best_view"):
        raise ValueError(f"Unsupported texture_mode: {texture_mode!r}")

    t0 = time.time()
    train_frames, _, _ = load_train_split_strict(dataset_dir)
    selected_frames = train_frames[:: max(1, view_stride)]
    refined_poses: dict[str, np.ndarray] | None = None
    if refined_poses_path is not None and refined_poses_path.is_file():
        refined_poses = load_refined_train_poses(refined_poses_path)
        print(f"[track2b][project] Using refined train poses from {refined_poses_path} ({len(refined_poses)} frames)")

    loaded = trimesh.load(str(geom_glb), force="mesh")
    mesh = trimesh.util.concatenate(list(loaded.geometry.values())) if isinstance(loaded, trimesh.Scene) else loaded
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.faces, dtype=np.int32)
    uvs = np.asarray(mesh.visual.uv, dtype=np.float32)
    v_normals = np.asarray(mesh.vertex_normals, dtype=np.float32)

    base_path = maps_dir / "basecolor.png"
    backup_path = maps_dir / "basecolor_tsdf.png"
    if not backup_path.exists():
        shutil.copy2(base_path, backup_path)
    with Image.open(backup_path) as im:
        fallback_rgb = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    h_tex, w_tex = fallback_rgb.shape[:2]

    # Rasterize (world_pos, world_normal, tri_idx, min_edge_bary) into UV atlas
    pos_atlas = np.zeros((h_tex, w_tex, 3), dtype=np.float32)
    nrm_atlas = np.zeros((h_tex, w_tex, 3), dtype=np.float32)
    valid_atlas = np.zeros((h_tex, w_tex), dtype=bool)
    track_tris = texture_mode == "best_view"
    tri_atlas = np.full((h_tex, w_tex), -1, dtype=np.int32) if track_tris else None
    edge_bary_atlas = np.zeros((h_tex, w_tex, 3), dtype=np.float32) if track_tris else None

    u_px = uvs[:, 0] * (w_tex - 1)
    v_px = (1.0 - uvs[:, 1]) * (h_tex - 1)

    for f_idx, tri in enumerate(faces):
        i0, i1, i2 = int(tri[0]), int(tri[1]), int(tri[2])
        x0, y0 = u_px[i0], v_px[i0]
        x1, y1 = u_px[i1], v_px[i1]
        x2, y2 = u_px[i2], v_px[i2]
        min_x = max(0, int(math.floor(min(x0, x1, x2))))
        max_x = min(w_tex - 1, int(math.ceil(max(x0, x1, x2))))
        min_y = max(0, int(math.floor(min(y0, y1, y2))))
        max_y = min(h_tex - 1, int(math.ceil(max(y0, y1, y2))))
        if min_x > max_x or min_y > max_y:
            continue
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-8:
            continue
        xs = np.arange(min_x, max_x + 1, dtype=np.float32)
        ys = np.arange(min_y, max_y + 1, dtype=np.float32)
        gx, gy = np.meshgrid(xs, ys)
        w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / denom
        w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / denom
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue
        iy, ix = np.nonzero(inside)
        py_idx = min_y + iy
        px_idx = min_x + ix
        bw0, bw1, bw2 = w0[iy, ix, None], w1[iy, ix, None], w2[iy, ix, None]
        pos_atlas[py_idx, px_idx] = bw0 * verts[i0] + bw1 * verts[i1] + bw2 * verts[i2]
        nrm = bw0 * v_normals[i0] + bw1 * v_normals[i1] + bw2 * v_normals[i2]
        nrm_len = np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-6)
        nrm_atlas[py_idx, px_idx] = nrm / nrm_len
        valid_atlas[py_idx, px_idx] = True
        if track_tris:
            tri_atlas[py_idx, px_idx] = f_idx
            edge_bary_atlas[py_idx, px_idx, 0] = bw2[:, 0]  # opposite edge (i0, i1)
            edge_bary_atlas[py_idx, px_idx, 1] = bw0[:, 0]  # opposite edge (i1, i2)
            edge_bary_atlas[py_idx, px_idx, 2] = bw1[:, 0]  # opposite edge (i2, i0)

    vy, vx = np.nonzero(valid_atlas)
    tex_pos = pos_atlas[vy, vx]  # [M, 3]
    tex_nrm = nrm_atlas[vy, vx]  # [M, 3]
    m_count = len(tex_pos)
    tex_y_min = float(tex_pos[:, 1].min()) if m_count else 0.0
    tex_h = max(float(tex_pos[:, 1].max()) - tex_y_min, 1e-6) if m_count else 1.0
    tex_h_norm = ((tex_pos[:, 1] - tex_y_min) / tex_h) if m_count else np.zeros((0,), dtype=np.float32)
    non_base_tex = (tex_nrm[:, 1] >= -0.55) if m_count else np.zeros((0,), dtype=bool)
    eff_min_cos_tex = np.where(tex_h_norm < 0.25, max(float(min_cos), 0.22), float(min_cos)) if m_count else np.zeros((0,), dtype=np.float32)

    # Build Open3D Embree raycasting scene for fast visibility checks
    tmesh = o3d.t.geometry.TriangleMesh()
    tmesh.vertex.positions = o3d.core.Tensor(verts, dtype=o3d.core.Dtype.Float32)
    tmesh.triangle.indices = o3d.core.Tensor(faces, dtype=o3d.core.Dtype.Int32)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(tmesh)

    # Mesh scale for ray epsilon
    bbox_diag = float(np.linalg.norm(verts.max(axis=0) - verts.min(axis=0)))
    vis_eps = max(bbox_diag * 0.008, 1e-4)

    def _frame_c2w_glb(frame: dict[str, Any]) -> np.ndarray:
        stem = Path(frame["file_path"]).stem
        if refined_poses is not None:
            if stem not in refined_poses:
                raise KeyError(f"Refined pose missing frame_stem {stem!r}")
            c2w_world = refined_poses[stem]
        else:
            c2w_world = np.asarray(frame["transform_matrix"], dtype=np.float64)
        return transform_opengl_c2w(c2w_world, m_world_to_glb)

    best_view_extra: dict[str, Any] = {}
    specular_gloss_stats: dict[str, Any] = {}

    if texture_mode == "blend":
        accum_rgb = np.zeros((m_count, 3), dtype=np.float64)
        accum_w = np.zeros((m_count,), dtype=np.float64)
        want_specvar = specular_gloss_out is not None
        accum_lum = np.zeros((m_count,), dtype=np.float64) if want_specvar else None
        accum_lum2 = np.zeros((m_count,), dtype=np.float64) if want_specvar else None
        accum_lum_max = np.zeros((m_count,), dtype=np.float64) if want_specvar else None
        accum_views = np.zeros((m_count,), dtype=np.int32) if want_specvar else None

        for frame in selected_frames:
            c2w_glb = _frame_c2w_glb(frame)
            w2c_glb = opengl_c2w_to_opencv_w2c(c2w_glb)
            cam_pos = c2w_glb[:3, 3].astype(np.float32)

            # Direction from surface point toward camera
            to_cam = cam_pos[None, :] - tex_pos
            dist = np.linalg.norm(to_cam, axis=-1)
            dir_cam = to_cam / np.maximum(dist[:, None], 1e-6)
            cos_theta = np.sum(tex_nrm * dir_cam, axis=-1)

            # Project into image
            uv_img, depth = project_points_opencv(tex_pos, w2c_glb, frame)
            w_img, h_img = int(frame["w"]), int(frame["h"])
            in_bounds = (
                non_base_tex
                & (cos_theta > eff_min_cos_tex)
                & (depth > 1e-4)
                & (uv_img[:, 0] >= 1.0)
                & (uv_img[:, 0] < w_img - 1.0)
                & (uv_img[:, 1] >= 1.0)
                & (uv_img[:, 1] < h_img - 1.0)
            )
            cand_idx = np.flatnonzero(in_bounds)
            if len(cand_idx) == 0:
                continue

            with Image.open(_resolve_frame_mask_path(dataset_dir, frame)) as mk:
                mask = np.asarray(mk.convert("L")) > 127
            px_i = np.rint(uv_img[cand_idx, 0]).astype(np.int32)
            py_i = np.rint(uv_img[cand_idx, 1]).astype(np.int32)
            in_fg = mask[py_i, px_i]
            cand_idx = cand_idx[in_fg]
            if len(cand_idx) == 0:
                continue

            # Cast visibility rays from surface + normal*eps toward camera
            origins = tex_pos[cand_idx] + tex_nrm[cand_idx] * (vis_eps * 0.5)
            dirs = dir_cam[cand_idx]
            rays = np.concatenate([origins, dirs], axis=-1).astype(np.float32)
            hit_t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            target_dist = dist[cand_idx]
            visible = np.isinf(hit_t) | (hit_t > (target_dist - vis_eps))
            vis_idx = cand_idx[visible]
            if len(vis_idx) == 0:
                continue

            with Image.open(dataset_dir / frame["file_path"]) as im:
                rgba = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0

            sampled, sample_valid = sample_unpremultiplied_bilinear(
                rgba, uv_img[vis_idx], min_alpha=0.95, mask=mask
            )
            if not sample_valid.any():
                continue
            vis_idx = vis_idx[sample_valid]

            # Sharp view-angle weighting (cos^4) favors perpendicular observations;
            # prefer foreground pixels >= 2.5px inside mask when mask is substantial
            weights = (cos_theta[vis_idx].astype(np.float64)) ** 4
            if int(mask.sum()) > 2500:
                mask_dist_b = ndimage.distance_transform_edt(mask).astype(np.float32)
                px_b = np.clip(np.rint(uv_img[vis_idx, 0]).astype(np.int32), 0, w_img - 1)
                py_b = np.clip(np.rint(uv_img[vis_idx, 1]).astype(np.int32), 0, h_img - 1)
                is_int_b = mask_dist_b[py_b, px_b] >= 2.5
                weights = np.where(is_int_b, weights, weights * 1e-3)
            accum_rgb[vis_idx] += sampled.astype(np.float64) * weights[:, None]
            accum_w[vis_idx] += weights
            if want_specvar:
                s = np.clip(sampled.astype(np.float64), 0.0, 1.0)
                s_lin = np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)
                lum = 0.2126 * s_lin[:, 0] + 0.7152 * s_lin[:, 1] + 0.0722 * s_lin[:, 2]
                # Unweighted per-view accumulation so the spread reflects the full view set.
                accum_lum[vis_idx] += lum
                accum_lum2[vis_idx] += lum * lum
                np.maximum.at(accum_lum_max, vis_idx, lum)
                accum_views[vis_idx] += 1

        out_rgb = fallback_rgb.copy()
        has_proj = accum_w > 1e-8
        proj_colors = np.zeros((m_count, 3), dtype=np.float32)
        proj_colors[has_proj] = np.clip(accum_rgb[has_proj] / accum_w[has_proj, None], 0.0, 1.0).astype(np.float32)
        proj_colors[~has_proj] = fallback_rgb[vy[~has_proj], vx[~has_proj]]
        out_rgb[vy, vx] = proj_colors

        if want_specvar:
            spec_gloss, rel_var, enough = accumulate_specular_gloss(
                accum_lum,
                accum_lum2,
                accum_lum_max,
                accum_views,
                min_views=int(specular_min_views),
                gloss_scale=float(specular_gloss_scale),
            )
            atlas_gloss = np.zeros((h_tex, w_tex), dtype=np.float32)
            atlas_gloss[vy, vx] = spec_gloss
            atlas_gloss = dilate_uv_gutters(atlas_gloss, valid_atlas, max_dist=16)
            specular_gloss_out.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray((np.clip(atlas_gloss, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), mode='L').save(
                specular_gloss_out, format='PNG'
            )
            specular_gloss_stats = {
                'specular_gloss_map': str(specular_gloss_out),
                'specular_min_views': int(specular_min_views),
                'specular_gloss_scale': round(float(specular_gloss_scale), 5),
                'specular_texels': int(np.count_nonzero(enough)),
                'specular_gloss_mean': round(float(np.mean(spec_gloss[enough])), 5) if enough.any() else 0.0,
                'specular_gloss_p90': round(float(np.percentile(spec_gloss[enough], 90)), 5) if enough.any() else 0.0,
                'specular_gloss_frac_ge_0_5': round(float(np.mean(spec_gloss[enough] >= 0.5)), 4) if enough.any() else 0.0,
                'specular_relvar_mean': round(float(np.mean(rel_var[enough])), 5) if enough.any() else 0.0,
            }
    else:
        # Best-view texturing: face-coherent view selection + global colour levelling + narrow seam blend
        n_views = len(selected_frames)
        n_faces = len(faces)
        face_centers = verts[faces].mean(axis=1).astype(np.float32)
        fn_raw = v_normals[faces].mean(axis=1).astype(np.float32)
        face_normals = fn_raw / np.maximum(np.linalg.norm(fn_raw, axis=-1, keepdims=True), 1e-6)
        non_base_face = face_normals[:, 1] >= -0.55
        face_h_norm = (face_centers[:, 1] - tex_y_min) / tex_h
        eff_min_cos_face = np.where(face_h_norm < 0.25, max(float(min_cos), 0.22), float(min_cos))

        sample_stride = max(1, n_faces // 35000)
        sample_f_idx = np.arange(0, n_faces, sample_stride, dtype=np.int64)
        sample_f_map = np.full((n_faces,), -1, dtype=np.int32)
        sample_f_map[sample_f_idx] = np.arange(len(sample_f_idx), dtype=np.int32)

        face_scores = np.zeros((n_faces, n_views), dtype=np.float32)
        face_valid = np.zeros((n_faces, n_views), dtype=bool)
        face_sum_rgb = np.zeros((n_faces, 3), dtype=np.float32)
        face_sum_w = np.zeros((n_faces,), dtype=np.float32)
        obs_rgb_lin = np.zeros((len(sample_f_idx), n_views, 3), dtype=np.float32)
        obs_weights = np.zeros((len(sample_f_idx), n_views), dtype=np.float32)
        obs_xy_norm = np.zeros((len(sample_f_idx), n_views, 2), dtype=np.float32) if color_field else None
        bright_concave_active = bool(bright_concave)
        face_lum = np.full((n_faces, n_views), np.inf, dtype=np.float32) if bright_concave_active else None
        face_lum_w = np.zeros((n_faces, n_views), dtype=np.float32) if bright_concave_active else None

        sharp_maps_small: list[np.ndarray] = []
        frame_lap_vars: list[float] = []
        raw_sharp_entries: list[tuple[int, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, float, float, np.ndarray, np.ndarray | None, bool]] = []

        # Step A: Face-centroid visibility, sharpness maps, and overlap samples for colour levelling
        for v_idx, frame in enumerate(selected_frames):
            with Image.open(_resolve_frame_mask_path(dataset_dir, frame)) as mk:
                mask = np.asarray(mk.convert("L")) > 127
            with Image.open(dataset_dir / frame["file_path"]) as im:
                rgba = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0

            sharp_full, lap_var = compute_view_sharpness_map(rgba[..., :3], mask=mask, smooth_sigma=16.0)
            frame_lap_vars.append(lap_var)
            # Store 4x downsampled sharpness map (~0.5 MB per frame) to keep RAM tiny
            sh_h, sh_w = max(8, sharp_full.shape[0] // 4), max(8, sharp_full.shape[1] // 4)
            sharp_small = np.asarray(
                Image.fromarray(sharp_full, mode="F").resize((sh_w, sh_h), Image.Resampling.BILINEAR),
                dtype=np.float32,
            )
            sharp_maps_small.append(sharp_small)
            mask_dist = ndimage.distance_transform_edt(mask).astype(np.float32)

            c2w_glb = _frame_c2w_glb(frame)
            w2c_glb = opengl_c2w_to_opencv_w2c(c2w_glb)
            cam_pos = c2w_glb[:3, 3].astype(np.float32)

            to_cam = cam_pos[None, :] - face_centers
            dist = np.linalg.norm(to_cam, axis=-1)
            dir_cam = to_cam / np.maximum(dist[:, None], 1e-6)
            cos_theta = np.sum(face_normals * dir_cam, axis=-1)
            uv_img, depth = project_points_opencv(face_centers, w2c_glb, frame)
            w_img, h_img = int(frame["w"]), int(frame["h"])
            in_bounds = (
                non_base_face
                & (cos_theta > eff_min_cos_face)
                & (depth > 1e-4)
                & (uv_img[:, 0] >= 1.0)
                & (uv_img[:, 0] < w_img - 1.0)
                & (uv_img[:, 1] >= 1.0)
                & (uv_img[:, 1] < h_img - 1.0)
            )
            cand_f = np.flatnonzero(in_bounds)
            if len(cand_f) == 0:
                continue

            px_i = np.rint(uv_img[cand_f, 0]).astype(np.int32)
            py_i = np.rint(uv_img[cand_f, 1]).astype(np.int32)
            in_fg = mask[py_i, px_i]
            cand_f = cand_f[in_fg]
            if len(cand_f) == 0:
                continue

            origins = face_centers[cand_f] + face_normals[cand_f] * (vis_eps * 0.5)
            rays = np.concatenate([origins, dir_cam[cand_f]], axis=-1).astype(np.float32)
            hit_t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            visible = np.isinf(hit_t) | (hit_t > (dist[cand_f] - vis_eps))
            vis_f = cand_f[visible]
            if len(vis_f) == 0:
                continue

            sampled_f, s_ok = sample_unpremultiplied_bilinear(rgba, uv_img[vis_f], min_alpha=0.95, mask=mask)
            if not s_ok.any():
                continue
            vis_f = vis_f[s_ok]
            px_v = np.rint(uv_img[vis_f, 0]).astype(np.int32)
            py_v = np.rint(uv_img[vis_f, 1]).astype(np.int32)
            local_sh = sharp_full[py_v, px_v]
            m_dist = mask_dist[py_v, px_v]

            w_cons = (np.maximum(cos_theta[vis_f], 0.0) ** 3) * np.clip(m_dist / 8.0, 0.1, 1.0)
            face_sum_rgb[vis_f] += sampled_f * w_cons[:, None]
            face_sum_w[vis_f] += w_cons

            uv_norm_v = None
            if color_field:
                uv_norm_v = np.stack(
                    [
                        np.clip((uv_img[vis_f, 0] / max(float(w_img), 1.0)) * 2.0 - 1.0, -1.0, 1.0),
                        np.clip((uv_img[vis_f, 1] / max(float(h_img), 1.0)) * 2.0 - 1.0, -1.0, 1.0),
                    ],
                    axis=-1,
                ).astype(np.float32)

            raw_sharp_entries.append(
                (
                    v_idx,
                    vis_f,
                    cos_theta[vis_f],
                    dist[vis_f],
                    local_sh,
                    m_dist,
                    float(frame["fl_x"]),
                    float(frame["fl_y"]),
                    sampled_f,
                    uv_norm_v,
                    bool(int(mask.sum()) > 2500),
                )
            )

        positive_vars = [float(np.sqrt(max(lv, 0.0))) for lv in frame_lap_vars if lv > 0.0]
        ref_sharp = float(np.median(positive_vars)) if positive_vars else 1.0
        ref_sharp = max(ref_sharp * 0.65, 1e-6)
        face_mean_rgb = face_sum_rgb / np.maximum(face_sum_w[:, None], 1e-6)

        for v_idx, vis_f, cos_v, dist_v, local_sh, m_dist, flx, fly, sampled_f, uv_norm_v, large_mask in raw_sharp_entries:
            sc = compute_texel_view_score(
                cos_v,
                dist_v,
                flx,
                fly,
                local_sharpness=local_sh,
                ref_sharpness=ref_sharp,
                mask_dist_px=m_dist,
            )
            # Strongly prefer interior foreground pixels (>= 2.5px from mask edge) on full-res views
            if large_mask:
                sc = np.where(m_dist >= 2.5, sc, sc * 0.05)
            # Photometric consensus gate: penalize oblique/occlusion outliers that disagree with multi-view mean
            color_err = np.linalg.norm(sampled_f - face_mean_rgb[vis_f], axis=-1)
            cons_factor = np.exp(-((color_err / 0.16) ** 2)).astype(np.float64)
            face_scores[vis_f, v_idx] = (sc * cons_factor).astype(np.float32)
            face_valid[vis_f, v_idx] = True

            if bright_concave_active:
                lin_f = srgb_to_linear(sampled_f)
                lum_f = 0.2126 * lin_f[:, 0] + 0.7152 * lin_f[:, 1] + 0.0722 * lin_f[:, 2]
                face_lum[vis_f, v_idx] = lum_f.astype(np.float32)
                face_lum_w[vis_f, v_idx] = (
                    (np.maximum(cos_v, 0.0) ** 2) * np.clip(m_dist / 8.0, 0.1, 1.0)
                ).astype(np.float32)

            s_pos = sample_f_map[vis_f]
            keep_s = s_pos >= 0
            if keep_s.any():
                s_rows = s_pos[keep_s]
                obs_rgb_lin[s_rows, v_idx] = srgb_to_linear(sampled_f[keep_s])
                # Robust interior weighting for colour levelling (downweight silhouette/grazing)
                obs_weights[s_rows, v_idx] = (
                    (np.maximum(cos_v[keep_s], 0.0) ** 2) * np.clip(m_dist[keep_s] / 8.0, 0.0, 1.0)
                ).astype(np.float32)
                if obs_xy_norm is not None and uv_norm_v is not None:
                    obs_xy_norm[s_rows, v_idx] = uv_norm_v[keep_s]
        del raw_sharp_entries, face_sum_rgb, face_sum_w, face_mean_rgb

        face_spread = None
        if bright_concave_active:
            face_quants = compute_face_luminance_quantiles(face_lum, face_lum_w, (0.20, 0.75, 0.85))
            face_q20, face_q75, face_q85 = face_quants[:, 0], face_quants[:, 1], face_quants[:, 2]
            face_spread = np.where(
                np.isfinite(face_q75),
                np.maximum(face_q85 - face_q20, 0.0) / np.maximum(face_q75, 0.04),
                0.0,
            ).astype(np.float32)
            del face_lum, face_lum_w, face_quants, face_q20, face_q75, face_q85

        edge_a, edge_b = build_face_adjacency(faces)
        face_view = smooth_face_view_labels(
            face_scores, face_valid, edge_a, edge_b, potts_weight=float(potts_weight), n_iters=14
        )
        del face_scores, face_valid

        if color_levelling and color_field:
            gains, offsets, level_diag = solve_color_levelling_field(
                obs_rgb_lin, obs_weights, obs_xy_norm=obs_xy_norm
            )
        elif color_levelling:
            gains, offsets, level_diag = solve_global_color_levelling(obs_rgb_lin, obs_weights)
        else:
            gains = np.ones((n_views, 3), dtype=np.float32)
            offsets = np.zeros((n_views, 3), dtype=np.float32)
            level_diag = {"overlap_points": 0, "disabled": True}
        del obs_rgb_lin, obs_weights, obs_xy_norm

        # Identify 3D view-transition edges across UV cuts so cross-island seams also feather cleanly
        face_seam_edge = np.zeros((n_faces, 3), dtype=bool)
        if len(edge_a) > 0:
            diff_3d = (face_view[edge_a] >= 0) & (face_view[edge_b] >= 0) & (face_view[edge_a] != face_view[edge_b])
            if diff_3d.any():
                seam_verts = set()
                for fa, fb in zip(edge_a[diff_3d].tolist(), edge_b[diff_3d].tolist()):
                    va = set(faces[fa].tolist())
                    vb = set(faces[fb].tolist())
                    shared = va & vb
                    if len(shared) == 2:
                        seam_verts.add(tuple(sorted(shared)))
                for e_k, (ia, ib) in enumerate(((0, 1), (1, 2), (2, 0))):
                    u_col = np.minimum(faces[:, ia], faces[:, ib])
                    v_col = np.maximum(faces[:, ia], faces[:, ib])
                    face_seam_edge[:, e_k] = [((int(u), int(v)) in seam_verts) for u, v in zip(u_col, v_col)]

        label_atlas = np.where(valid_atlas, face_view[np.maximum(tri_atlas, 0)], -1).astype(np.int32)
        seam_seed_mask = np.zeros((h_tex, w_tex), dtype=bool)
        if m_count > 0:
            t_idx_m = tri_atlas[vy, vx]
            eb_m = edge_bary_atlas[vy, vx]
            f_se_m = face_seam_edge[np.maximum(t_idx_m, 0)]
            on_3d_seam = np.any(f_se_m & (eb_m < 0.10), axis=1)
            seam_seed_mask[vy[on_3d_seam], vx[on_3d_seam]] = True

        scaled_seam_radius = float(seam_width_px) * max(1.0, float(h_tex) / 2048.0)
        is_seam, nbr_label_atlas = detect_uv_seam_pixels(valid_atlas, label_atlas, seam_seed_mask=seam_seed_mask)
        if is_seam.any() and scaled_seam_radius > 0.0:
            seam_dist = ndimage.distance_transform_edt(~is_seam)
            seam_band_atlas = valid_atlas & (seam_dist <= scaled_seam_radius)
        else:
            seam_band_atlas = np.zeros((h_tex, w_tex), dtype=bool)

        tex_primary_view = label_atlas[vy, vx]
        tex_in_seam = seam_band_atlas[vy, vx]
        tex_nbr_view = nbr_label_atlas[vy, vx]
        seam_indices = np.flatnonzero(tex_in_seam)
        seam_lookup = np.full((m_count,), -1, dtype=np.int32)
        seam_lookup[seam_indices] = np.arange(len(seam_indices), dtype=np.int32)

        target_indices = np.zeros((0,), dtype=np.int64)
        target_map = np.full((m_count,), -1, dtype=np.int32)
        target_weight = np.zeros((m_count,), dtype=np.float32)
        t_samples = None
        t_weights = None
        if bright_concave_active:
            with Image.open(maps_dir / "ao.png") as ao_im:
                ao_atlas = np.asarray(ao_im.convert("L"), dtype=np.float32) / 255.0
            tex_ao = ao_atlas[vy, vx]
            tex_spread = face_spread[np.maximum(tri_atlas[vy, vx], 0)]
            target_weight = compute_bright_concave_target_weight(
                tex_ao,
                tex_spread,
                ao_thresh=bright_concave_ao_thresh,
                ao_ramp=bright_concave_ao_ramp,
                spread_thresh=bright_concave_spread_thresh,
                spread_ramp=bright_concave_spread_ramp,
                spread_max=bright_concave_spread_max,
            )
            target_indices = np.flatnonzero(target_weight > 0.0)
            target_map[target_indices] = np.arange(len(target_indices), dtype=np.int32)
            t_samples = np.zeros((len(target_indices), n_views, 3), dtype=np.uint8)
            t_weights = np.zeros((len(target_indices), n_views), dtype=np.float16)

        primary_rgb = np.zeros((m_count, 3), dtype=np.float32)
        has_primary = np.zeros((m_count,), dtype=bool)
        fallback_rgb_m = np.zeros((m_count, 3), dtype=np.float32)
        fallback_score = np.full((m_count,), -1.0, dtype=np.float64)
        seam_other_rgb = np.zeros((len(seam_indices), 3), dtype=np.float64)
        seam_other_w = np.zeros((len(seam_indices),), dtype=np.float64)

        # Step B: Full-resolution UV texel projection with exposure levelling & narrow seam band
        for v_idx, frame in enumerate(selected_frames):
            c2w_glb = _frame_c2w_glb(frame)
            w2c_glb = opengl_c2w_to_opencv_w2c(c2w_glb)
            cam_pos = c2w_glb[:3, 3].astype(np.float32)

            to_cam = cam_pos[None, :] - tex_pos
            dist = np.linalg.norm(to_cam, axis=-1)
            dir_cam = to_cam / np.maximum(dist[:, None], 1e-6)
            cos_theta = np.sum(tex_nrm * dir_cam, axis=-1)

            uv_img, depth = project_points_opencv(tex_pos, w2c_glb, frame)
            w_img, h_img = int(frame["w"]), int(frame["h"])
            in_bounds = (
                non_base_tex
                & (cos_theta > eff_min_cos_tex)
                & (depth > 1e-4)
                & (uv_img[:, 0] >= 1.0)
                & (uv_img[:, 0] < w_img - 1.0)
                & (uv_img[:, 1] >= 1.0)
                & (uv_img[:, 1] < h_img - 1.0)
            )
            cand_idx = np.flatnonzero(in_bounds)
            if len(cand_idx) == 0:
                continue

            with Image.open(_resolve_frame_mask_path(dataset_dir, frame)) as mk:
                mask = np.asarray(mk.convert("L")) > 127
            px_i = np.rint(uv_img[cand_idx, 0]).astype(np.int32)
            py_i = np.rint(uv_img[cand_idx, 1]).astype(np.int32)
            in_fg = mask[py_i, px_i]
            cand_idx = cand_idx[in_fg]
            if len(cand_idx) == 0:
                continue

            origins = tex_pos[cand_idx] + tex_nrm[cand_idx] * (vis_eps * 0.5)
            rays = np.concatenate([origins, dir_cam[cand_idx]], axis=-1).astype(np.float32)
            hit_t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            visible = np.isinf(hit_t) | (hit_t > (dist[cand_idx] - vis_eps))
            vis_idx = cand_idx[visible]
            if len(vis_idx) == 0:
                continue

            with Image.open(dataset_dir / frame["file_path"]) as im:
                rgba = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0
            sampled, sample_valid = sample_unpremultiplied_bilinear(
                rgba, uv_img[vis_idx], min_alpha=0.95, mask=mask
            )
            if not sample_valid.any():
                continue
            vis_idx = vis_idx[sample_valid]

            # Apply per-view linear-light colour levelling / low-frequency spatial field
            sampled_adj = apply_color_levelling_field(
                sampled, uv_img[vis_idx], w_img, h_img, gains[v_idx], offsets[v_idx]
            )

            if bright_concave_active:
                target_loc = target_map[vis_idx]
                in_target = target_loc >= 0
                if in_target.any():
                    t_loc = target_loc[in_target]
                    t_samples[t_loc, v_idx] = np.clip(sampled_adj[in_target] * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
                    t_weights[t_loc, v_idx] = (np.maximum(cos_theta[vis_idx[in_target]], 0.0) ** 2).astype(np.float16)

            # Local sharpness lookup from cached 4x-downsampled map
            sh_small = sharp_maps_small[v_idx]
            sh_x = np.clip(np.rint(uv_img[vis_idx, 0] * (sh_small.shape[1] / max(w_img, 1))).astype(np.int32), 0, sh_small.shape[1] - 1)
            sh_y = np.clip(np.rint(uv_img[vis_idx, 1] * (sh_small.shape[0] / max(h_img, 1))).astype(np.int32), 0, sh_small.shape[0] - 1)
            tex_scores = compute_texel_view_score(
                cos_theta[vis_idx],
                dist[vis_idx],
                float(frame["fl_x"]),
                float(frame["fl_y"]),
                local_sharpness=sh_small[sh_y, sh_x],
                ref_sharpness=ref_sharp,
            )
            is_int_tex = np.ones(len(vis_idx), dtype=bool)
            if int(mask.sum()) > 2500:
                mask_dist_b = ndimage.distance_transform_edt(mask).astype(np.float32)
                px_b = np.clip(np.rint(uv_img[vis_idx, 0]).astype(np.int32), 0, w_img - 1)
                py_b = np.clip(np.rint(uv_img[vis_idx, 1]).astype(np.int32), 0, h_img - 1)
                is_int_tex = mask_dist_b[py_b, px_b] >= 2.5
                tex_scores = np.where(is_int_tex, tex_scores, tex_scores * 1e-3)

            # 1) Primary assigned view (prefer interior >= 2.5px; silhouette fringe falls back if interior exists)
            is_prim = (tex_primary_view[vis_idx] == v_idx) & is_int_tex
            if is_prim.any():
                p_idx = vis_idx[is_prim]
                primary_rgb[p_idx] = sampled_adj[is_prim]
                has_primary[p_idx] = True

            # 2) Best fallback view (if primary view is occluded at a sub-triangle texel)
            better_fb = tex_scores > fallback_score[vis_idx]
            if better_fb.any():
                fb_idx = vis_idx[better_fb]
                fallback_score[fb_idx] = tex_scores[better_fb]
                fallback_rgb_m[fb_idx] = sampled_adj[better_fb]

            # 3) Narrow seam-band alternate views
            s_loc = seam_lookup[vis_idx]
            in_seam_other = (s_loc >= 0) & (~is_prim)
            if in_seam_other.any():
                so_vis = vis_idx[in_seam_other]
                so_loc = s_loc[in_seam_other]
                so_sc = tex_scores[in_seam_other]
                # Prefer exact across-seam neighbor view when visible
                is_exact_nbr = tex_nbr_view[so_vis] == v_idx
                w_seam = np.where(is_exact_nbr, so_sc * 100.0, so_sc)
                np.add.at(seam_other_rgb, so_loc, sampled_adj[in_seam_other].astype(np.float64) * w_seam[:, None])
                np.add.at(seam_other_w, so_loc, w_seam)

        has_fb = fallback_score >= 0.0
        has_proj = has_primary | has_fb
        proj_colors = np.where(has_primary[:, None], primary_rgb, fallback_rgb_m)
        proj_colors[~has_proj] = fallback_rgb[vy[~has_proj], vx[~has_proj]]

        primary_atlas = fallback_rgb.copy()
        primary_atlas[vy, vx] = proj_colors

        other_atlas = np.zeros_like(primary_atlas)
        other_valid_atlas = np.zeros((h_tex, w_tex), dtype=bool)
        if len(seam_indices) > 0:
            so_ok = seam_other_w > 1e-8
            if so_ok.any():
                ok_tex_idx = seam_indices[so_ok]
                other_atlas[vy[ok_tex_idx], vx[ok_tex_idx]] = np.clip(
                    seam_other_rgb[so_ok] / seam_other_w[so_ok, None], 0.0, 1.0
                ).astype(np.float32)
                other_valid_atlas[vy[ok_tex_idx], vx[ok_tex_idx]] = True

        out_rgb, blended_seam_mask = blend_narrow_seam_band(
            primary_atlas,
            other_atlas,
            other_valid_atlas,
            valid_atlas,
            label_atlas,
            seam_radius_px=scaled_seam_radius,
            seam_seed_mask=seam_seed_mask,
        )
        seam_vis_metrics = measure_seam_visibility(out_rgb, valid_atlas, label_atlas)
        bright_concave_report: dict[str, Any] = {
            "enabled": bool(bright_concave_active),
            "q_lo": float(bright_concave_q_lo),
            "q_hi": float(bright_concave_q_hi),
            "ao_thresh": float(bright_concave_ao_thresh),
            "spread_thresh": float(bright_concave_spread_thresh),
        }
        if bright_concave_active:
            if len(target_indices) > 0:
                ty_t, tx_t = vy[target_indices], vx[target_indices]
                base_target = out_rgb[ty_t, tx_t].copy()
                upper = compute_bright_concave_upper_color(
                    t_samples,
                    t_weights,
                    base_target,
                    q_lo=float(bright_concave_q_lo),
                    q_hi=float(bright_concave_q_hi),
                )
                w_t = target_weight[target_indices][:, None]
                out_rgb[ty_t, tx_t] = (1.0 - w_t) * base_target + w_t * upper
            bright_concave_report.update(
                {
                    "target_texels": int(len(target_indices)),
                    "target_fraction": round(float(len(target_indices)) / max(m_count, 1), 4),
                    "mean_blend_weight": round(float(target_weight[target_indices].mean()) if len(target_indices) else 0.0, 4),
                }
            )
        del t_samples, t_weights
        best_view_extra = {
            "potts_weight": float(potts_weight),
            "seam_width_px": float(seam_width_px),
            "scaled_seam_radius_px": round(scaled_seam_radius, 3),
            "seam_band_texels": int(blended_seam_mask.sum()),
            "seam_band_fraction": round(float(blended_seam_mask.sum()) / max(m_count, 1), 4),
            "primary_view_coverage": round(float(has_primary.mean()) if m_count else 0.0, 4),
            "unique_views_used": int(len(set(face_view[face_view >= 0].tolist()))),
            "color_levelling": level_diag,
            "seam_visibility": seam_vis_metrics,
            "bright_concave": bright_concave_report,
        }

    inpaint_stats: dict[str, int] = {"inpainted_texels": 0, "good_texels": int(has_proj.sum()), "downward_base_filled": 0}
    if inpaint_unprojected and m_count > 0:
        proj_atlas = np.zeros((h_tex, w_tex), dtype=bool)
        if texture_mode == "best_view":
            proj_lum = (
                0.2126 * out_rgb[vy, vx, 0] + 0.7152 * out_rgb[vy, vx, 1] + 0.0722 * out_rgb[vy, vx, 2]
            )
            good_proj = has_proj & (has_primary | (proj_lum >= 0.05))
        else:
            good_proj = has_proj
        proj_atlas[vy, vx] = good_proj

        down_base_atlas = np.zeros((h_tex, w_tex), dtype=bool)
        down_base_atlas[vy, vx] = tex_nrm[:, 1] < -0.55
        y_min_m = float(tex_pos[:, 1].min())
        y_max_m = float(tex_pos[:, 1].max())
        h_m = max(y_max_m - y_min_m, 1e-6)
        rim_cand = (
            good_proj
            & (tex_nrm[:, 1] >= -0.50)
            & (tex_nrm[:, 1] <= 0.55)
            & (tex_pos[:, 1] <= y_min_m + 0.35 * h_m)
        )
        if not rim_cand.any():
            rim_cand = good_proj & (tex_nrm[:, 1] >= -0.50) & (tex_nrm[:, 1] <= 0.65)
        if rim_cand.any():
            rim_med = np.median(out_rgb[vy[rim_cand], vx[rim_cand]], axis=0).astype(np.float32)
            lum = float(0.2126 * rim_med[0] + 0.7152 * rim_med[1] + 0.0722 * rim_med[2])
            muted = 0.70 * rim_med + 0.30 * np.array([lum, lum, lum], dtype=np.float32)
            down_tone = np.clip(muted * 0.60, 0.04, 0.25).astype(np.float32)
            iso_wall_tone = np.clip(muted * 0.85, 0.04, 0.35).astype(np.float32)
        else:
            down_tone = np.array([0.12, 0.11, 0.10], dtype=np.float32)
            iso_wall_tone = down_tone

        iso_wall_atlas = np.zeros((h_tex, w_tex), dtype=bool)
        iso_wall_atlas[vy, vx] = (tex_nrm[:, 1] < 0.55) & (tex_pos[:, 1] <= y_min_m + 0.55 * h_m)

        out_rgb, inpaint_stats = inpaint_unprojected_texels(
            out_rgb,
            valid_atlas,
            proj_atlas,
            smooth_iters=3,
            downward_base_mask=down_base_atlas,
            downward_base_color=down_tone,
            isolated_wall_mask=iso_wall_atlas,
            isolated_wall_color=iso_wall_tone,
        )
        if texture_mode == "best_view":
            best_view_extra["seam_visibility"] = measure_seam_visibility(out_rgb, valid_atlas, label_atlas)

    # Dilate UV gutters so mipmaps/seams stay clean
    out_rgb = dilate_uv_gutters(out_rgb, valid_atlas, max_dist=16)
    u8 = np.clip(out_rgb * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
    Image.fromarray(u8, mode="RGB").save(base_path, format="PNG")

    coverage = float(has_proj.mean()) if m_count else 0.0
    stats = {
        "publication_eligible": False,
        "texture_mode": texture_mode,
        "geom_glb": str(geom_glb),
        "texture_size": [w_tex, h_tex],
        "valid_texels": int(m_count),
        "projected_texel_fraction": round(coverage, 4),
        "inpaint_unprojected": bool(inpaint_unprojected),
        **inpaint_stats,
        "train_views_projected": len(selected_frames),
        "used_refined_poses": refined_poses is not None,
        "elapsed_seconds": round(time.time() - t0, 2),
        **best_view_extra,
        **specular_gloss_stats,
    }
    (maps_dir / "uv_projection_report.json").write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
    print(
        f"[track2b][project] {geom_glb.name} ({w_tex}x{h_tex}, mode={texture_mode}): "
        f"{coverage * 100:.1f}% texels photo-projected in {stats['elapsed_seconds']}s "
        f"(refined_poses={refined_poses is not None})"
    )
    return stats


def downsample_texture_sharpened(
    tex_path: Path,
    target_size: int,
    *,
    sharpen_radius: float = 1.0,
    sharpen_percent: int = 40,
    sharpen_threshold: int = 2,
) -> Path:
    """Downsample a baked/projected texture with Lanczos + mild unsharp mask (for 4096->2048 tests)."""
    from PIL import ImageFilter

    with Image.open(tex_path) as im:
        im_rgb = im.convert("RGB")
        if im_rgb.size != (int(target_size), int(target_size)):
            im_rgb = im_rgb.resize((int(target_size), int(target_size)), Image.Resampling.LANCZOS)
        if int(sharpen_percent) > 0:
            im_rgb = im_rgb.filter(
                ImageFilter.UnsharpMask(
                    radius=float(sharpen_radius),
                    percent=int(sharpen_percent),
                    threshold=int(sharpen_threshold),
                )
            )
        im_rgb.save(tex_path, format="PNG")
    return tex_path


# ---------------------------------------------------------------------------
# Stage 3: Held-out evaluation against transforms_val.json (reuses build_track2_report)
# ---------------------------------------------------------------------------


def prepare_heldout_cameras_json(
    dataset_dir: Path,
    m_world_to_glb: np.ndarray,
    out_json: Path,
    *,
    split: str = "val",
    stride: int = 1,
) -> Path:
    """Transform transforms_val.json (or transforms_train.json) cameras into the final hero GLB's Y-up metric space."""
    if split not in ("val", "train"):
        raise ValueError(f"Unsupported split: {split!r}")
    src_name = "transforms_val.json" if split == "val" else "transforms_train.json"
    val_data = json.loads((dataset_dir / src_name).read_text(encoding="utf-8"))
    cameras = []
    for frame in val_data["frames"][:: max(1, int(stride))]:
        c2w_glb = transform_opengl_c2w(np.asarray(frame["transform_matrix"], dtype=np.float64), m_world_to_glb)
        cameras.append(
            {
                "frame_stem": Path(frame["file_path"]).stem,
                "frame_number": int(frame["frame_number"]),
                "w": int(frame["w"]),
                "h": int(frame["h"]),
                "fl_x": float(frame["fl_x"]),
                "fl_y": float(frame["fl_y"]),
                "cx": float(frame["cx"]),
                "cy": float(frame["cy"]),
                "transform_matrix": c2w_glb.tolist(),
            }
        )
    payload = {
        "schema_version": 1,
        "publication_eligible": False,
        "split": split,
        "cameras": cameras,
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return out_json


def align_heldout_cameras(
    geom_glb: Path,
    basecolor_path: Path,
    cameras_json: Path,
    dataset_dir: Path,
    out_json: Path,
    *,
    report_out: Path | None = None,
) -> dict[str, Any]:
    """Optimize ONLY each held-out camera's SE(3) pose against the frozen final mesh/texture.

    Held-out images are used solely to optimize each held-out camera's 6-DoF pose at test time,
    never to modify the 2DGS model, geometry, or texture.
    """
    import open3d as o3d
    import trimesh
    from scipy.optimize import minimize

    t0 = time.time()
    cam_payload = json.loads(cameras_json.read_text(encoding="utf-8"))
    cameras = cam_payload["cameras"]
    val_frames = json.loads((dataset_dir / "transforms_val.json").read_text(encoding="utf-8"))["frames"]
    val_by_stem = {Path(f["file_path"]).stem: f for f in val_frames}

    loaded = trimesh.load(str(geom_glb), force="mesh")
    mesh = trimesh.util.concatenate(list(loaded.geometry.values())) if isinstance(loaded, trimesh.Scene) else loaded
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.faces, dtype=np.int32)
    uvs = np.asarray(mesh.visual.uv, dtype=np.float32)
    with Image.open(basecolor_path) as im:
        tex = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    th, tw = tex.shape[:2]

    tmesh = o3d.t.geometry.TriangleMesh()
    tmesh.vertex.positions = o3d.core.Tensor(verts, dtype=o3d.core.Dtype.Float32)
    tmesh.triangle.indices = o3d.core.Tensor(faces, dtype=o3d.core.Dtype.Int32)
    rc = o3d.t.geometry.RaycastingScene()
    rc.add_triangles(tmesh)

    def _render_mesh(w2c: np.ndarray, cam: dict[str, Any], scale: float) -> np.ndarray:
        w_s = max(16, int(round(float(cam["w"]) * scale)))
        h_s = max(16, int(round(float(cam["h"]) * scale)))
        k_mat = np.array(
            [
                [float(cam["fl_x"]) * scale, 0.0, float(cam["cx"]) * scale],
                [0.0, float(cam["fl_y"]) * scale, float(cam["cy"]) * scale],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )
        rays = o3d.t.geometry.RaycastingScene.create_rays_pinhole(
            intrinsic_matrix=o3d.core.Tensor(k_mat),
            extrinsic_matrix=o3d.core.Tensor(np.asarray(w2c, dtype=np.float64)),
            width_px=w_s,
            height_px=h_s,
        )
        ans = rc.cast_rays(rays)
        pid = ans["primitive_ids"].numpy()
        buv = ans["primitive_uvs"].numpy()
        valid = pid != o3d.t.geometry.RaycastingScene.INVALID_ID
        out = np.zeros((h_s, w_s, 3), dtype=np.float32)
        if valid.any():
            tris = faces[pid[valid]]
            b1 = buv[valid, 0:1]
            b2 = buv[valid, 1:2]
            b0 = 1.0 - b1 - b2
            uv_hit = b0 * uvs[tris[:, 0]] + b1 * uvs[tris[:, 1]] + b2 * uvs[tris[:, 2]]
            px = np.clip(uv_hit[:, 0] * (tw - 1), 0.0, float(tw - 1))
            py = np.clip((1.0 - uv_hit[:, 1]) * (th - 1), 0.0, float(th - 1))
            x0 = np.floor(px).astype(np.int32)
            x1 = np.minimum(x0 + 1, tw - 1)
            y0 = np.floor(py).astype(np.int32)
            y1 = np.minimum(y0 + 1, th - 1)
            dx = (px - x0)[:, None]
            dy = (py - y0)[:, None]
            out[valid] = (
                tex[y0, x0] * (1.0 - dx) * (1.0 - dy)
                + tex[y0, x1] * dx * (1.0 - dy)
                + tex[y1, x0] * (1.0 - dx) * dy
                + tex[y1, x1] * dx * dy
            )
        return out

    aligned_cameras = []
    view_reports = []
    for cam in cameras:
        stem = cam["frame_stem"]
        frame = val_by_stem[stem]
        with Image.open(dataset_dir / frame["file_path"]) as im:
            gt_rgba = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0
        gt_black = gt_rgba[..., :3] * gt_rgba[..., 3:4]
        gt_img = Image.fromarray(np.clip(np.rint(gt_black * 255.0), 0, 255).astype(np.uint8), mode="RGB")

        w_q = max(16, int(round(float(cam["w"]) * 0.25)))
        h_q = max(16, int(round(float(cam["h"]) * 0.25)))
        w_h = max(16, int(round(float(cam["w"]) * 0.50)))
        h_h = max(16, int(round(float(cam["h"]) * 0.50)))
        gt_q = np.asarray(gt_img.resize((w_q, h_q), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        gt_h = np.asarray(gt_img.resize((w_h, h_h), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0

        c2w_raw = np.asarray(cam["transform_matrix"], dtype=np.float64)
        w2c_raw = opengl_c2w_to_opencv_w2c(c2w_raw)
        cam_dist = float(np.linalg.norm(c2w_raw[:3, 3]))
        t_scale = max(0.02 * cam_dist, 0.005)
        s_vec = np.array([0.02, 0.02, 0.02, t_scale, t_scale, t_scale], dtype=np.float64)

        raw_h = _render_mesh(w2c_raw, cam, 0.50)
        mse_before = float(np.mean((raw_h - gt_h) ** 2))

        def _obj_q(u: np.ndarray) -> float:
            d = u * s_vec
            r = _render_mesh(apply_se3_delta_w2c(w2c_raw, d[:3], d[3:]), cam, 0.25)
            return float(np.mean((r - gt_q) ** 2) + 1e-6 * float(np.dot(u, u)))

        def _obj_h(u: np.ndarray) -> float:
            d = u * s_vec
            r = _render_mesh(apply_se3_delta_w2c(w2c_raw, d[:3], d[3:]), cam, 0.50)
            return float(np.mean((r - gt_h) ** 2) + 1e-6 * float(np.dot(u, u)))

        res1 = minimize(
            _obj_q,
            np.zeros(6, dtype=np.float64),
            method="Powell",
            options={"xtol": 5e-3, "ftol": 1e-5, "maxfev": 220},
        )
        res2 = minimize(
            _obj_h,
            res1.x,
            method="Powell",
            options={"xtol": 2e-3, "ftol": 5e-6, "maxfev": 180},
        )
        delta_best = res2.x * s_vec
        w2c_opt = apply_se3_delta_w2c(w2c_raw, delta_best[:3], delta_best[3:])
        opt_h = _render_mesh(w2c_opt, cam, 0.50)
        mse_after = float(np.mean((opt_h - gt_h) ** 2))

        improved = mse_after < mse_before
        if not improved:
            delta_best = np.zeros(6, dtype=np.float64)
            w2c_opt = w2c_raw
            mse_after = mse_before

        c2w_opt = opencv_w2c_to_opengl_c2w(w2c_opt)
        rot_deg = float(np.degrees(np.linalg.norm(delta_best[:3])))
        trans_mm = float(np.linalg.norm(delta_best[3:])) * 1000.0
        aligned_cameras.append({**cam, "transform_matrix": c2w_opt.tolist()})
        view_reports.append(
            {
                "frame_stem": stem,
                "rot_deg": round(rot_deg, 4),
                "trans_mm": round(trans_mm, 4),
                "halfres_mse_before": round(mse_before, 7),
                "halfres_mse_after": round(mse_after, 7),
                "nfev": int(res1.nfev + res2.nfev),
                "improved": bool(improved),
            }
        )

    rots = [v["rot_deg"] for v in view_reports]
    trs = [v["trans_mm"] for v in view_reports]
    summary = {
        "views_count": len(view_reports),
        "mean_rot_deg": round(float(np.mean(rots)) if rots else 0.0, 4),
        "median_rot_deg": round(float(np.median(rots)) if rots else 0.0, 4),
        "max_rot_deg": round(float(np.max(rots)) if rots else 0.0, 4),
        "mean_trans_mm": round(float(np.mean(trs)) if trs else 0.0, 4),
        "median_trans_mm": round(float(np.median(trs)) if trs else 0.0, 4),
        "max_trans_mm": round(float(np.max(trs)) if trs else 0.0, 4),
        "mean_halfres_mse_before": round(float(np.mean([v["halfres_mse_before"] for v in view_reports])), 7),
        "mean_halfres_mse_after": round(float(np.mean([v["halfres_mse_after"] for v in view_reports])), 7),
        "elapsed_seconds": round(time.time() - t0, 2),
    }

    out_payload = {
        "schema_version": 1,
        "publication_eligible": False,
        "pose_alignment": {
            "heldout_images_used_for": "test_time_pose_alignment_only_never_for_model",
            "frozen_mesh_glb": str(geom_glb),
            "frozen_basecolor": str(basecolor_path),
            "summary": summary,
        },
        "cameras": aligned_cameras,
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(out_payload, indent=2) + "\n", encoding="utf-8")

    report = {
        "schema_version": 1,
        "publication_eligible": False,
        "heldout_images_used_for": "test_time_pose_alignment_only_never_for_model",
        "frozen_mesh_glb": str(geom_glb),
        "frozen_basecolor": str(basecolor_path),
        "out_cameras_json": str(out_json),
        "summary": summary,
        "views": view_reports,
    }
    if report_out is not None:
        report_out.parent.mkdir(parents=True, exist_ok=True)
        report_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        f"[track2b][align-eval] Aligned {len(view_reports)} held-out cameras in {summary['elapsed_seconds']}s: "
        f"mean_rot={summary['mean_rot_deg']:.3f} deg, mean_trans={summary['mean_trans_mm']:.3f} mm"
    )
    return report


def score_heldout_renders(
    dish: str,
    dataset_dir: Path,
    renders_dir: Path,
    out_dir: Path,
    *,
    mode_label: str = "albedo",
    background: str = "black",
    split: str = "val",
    stride: int = 1,
) -> dict[str, Any]:
    """Score rendered PNGs (val held-out or train-only) using build_track2_report.py's exact metrics."""
    if split not in ("val", "train"):
        raise ValueError(f"Unsupported split: {split!r}")
    src_name = "transforms_val.json" if split == "val" else "transforms_train.json"
    val_frames = json.loads((dataset_dir / src_name).read_text(encoding="utf-8"))["frames"][:: max(1, int(stride))]
    views = []
    sheet_rows = []
    selected = {i * len(val_frames) // 4 for i in range(4)}

    for idx, frame in enumerate(val_frames):
        stem = Path(frame["file_path"]).stem
        render_path = renders_dir / f"{stem}.png"
        if not render_path.is_file():
            raise RuntimeError(f"Missing {split} mesh render: {render_path}")
        gt, render, mask = _load_pair(dataset_dir, frame, render_path, background=background)
        metrics = compute_pair_metrics(gt, render, mask)
        view = {
            "frame_number": int(frame["frame_number"]),
            "frame_stem": stem,
            "render_path": str(render_path),
            **metrics,
        }
        views.append(view)
        if idx in selected:
            sheet_rows.append((view, _diagnostic_tiles(gt, render)))

    summary = {}
    for metric in ("full_psnr_db", "fg_psnr_db", "full_ssim", "fg_ssim", "fg_delta_e"):
        values = [v[metric] for v in views]
        summary[metric] = {
            "mean": float(np.mean(values)),
            "median": float(np.median(values)),
            "min": float(min(values)),
            "max": float(max(values)),
            "p10": float(np.percentile(values, 10)),
        }

    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = "heldout" if split == "val" else "train"
    sheet_path = out_dir / f"{prefix}_eval_sheet_{mode_label}.png"
    _write_eval_sheet(sheet_path, sheet_rows, render_label=f"Track 2B mesh ({mode_label})")
    benchmark_role = (
        f"train_only_diagnostic_{mode_label}"
        if split == "train"
        else ("primary_heldout_benchmark" if mode_label == "albedo" else "diagnostic_lit_vs_photo")
    )
    report = {
        "schema_version": 1,
        "publication_eligible": False,
        "dish": dish,
        "split": split,
        "render_mode": mode_label,
        "benchmark_role": benchmark_role,
        "background": background,
        "eval_views_count": len(views),
        "summary": summary,
        "views": views,
        "eval_sheet": str(sheet_path),
    }
    report_path = out_dir / f"{prefix}_metrics_{mode_label}.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_recon = sub.add_parser("reconstruct", help="Run 2DGS + Open3D TSDF mesh extraction on train views.")
    p_recon.add_argument("--dish", required=True)
    p_recon.add_argument("--dataset-dir", type=Path, required=True)
    p_recon.add_argument("--out-dir", type=Path, required=True)
    p_recon.add_argument("--steps", type=int, default=6000)
    p_recon.add_argument("--max-splats", type=int, default=120_000)
    p_recon.add_argument("--diameter-cm", type=float, default=None)
    p_recon.add_argument("--voxel-divisions", type=int, default=320)
    p_recon.add_argument("--tsdf-alpha-thresh", type=float, default=0.10)
    p_recon.add_argument("--tsdf-depth-source", choices=("median", "expected"), default="expected")
    p_recon.add_argument("--tsdf-trunc-voxels", type=float, default=6.0)
    p_recon.add_argument("--tsdf-cube-padding", type=float, default=1.5)
    p_recon.add_argument("--smooth-iterations", type=int, default=2)
    p_recon.add_argument("--seed", type=int, default=42)
    p_recon.add_argument("--refine-stop-iter", type=int, default=None)
    p_recon.add_argument("--pose-refine", action="store_true", help="Enable per-train-camera SE(3) pose refinement.")
    p_recon.add_argument("--pose-warmup-steps", type=int, default=1000)
    p_recon.add_argument("--pose-lr-rot", type=float, default=6e-4)
    p_recon.add_argument("--pose-lr-trans", type=float, default=3e-4)
    p_recon.add_argument("--pose-reg-weight", type=float, default=1e-2)
    p_recon.add_argument("--pose-reg-trans-weight", type=float, default=0.2)
    p_recon.add_argument("--mask-carve", action="store_true", help="Carve faces outside train-view masks.")
    p_recon.add_argument("--mask-carve-tol-px", type=float, default=2.0)
    p_recon.add_argument("--mask-carve-max-out-frac", type=float, default=0.38)
    p_recon.add_argument("--trim-drips", action="store_true", help="Trim hanging blobs below support plane.")
    p_recon.add_argument("--repair-pits", action="store_true", help="Fill small boundary holes and smooth tiny surface pits.")
    p_recon.add_argument("--solid-complete", action="store_true", help="Complete mesh into a watertight solid seated on y=0.")
    p_recon.add_argument("--poisson-depth", type=int, default=9, help="Screened Poisson octree depth for --solid-complete.")
    p_recon.add_argument(
        "--keep-multi-components",
        action="store_true",
        help="Keep multiple significant dish components (min_face_fraction=0.05) instead of main-only.",
    )

    p_comp = sub.add_parser("complete-mesh", help="Complete an open reconstructed GLB into a watertight solid on y=0.")
    p_comp.add_argument("--in-glb", type=Path, required=True)
    p_comp.add_argument("--out-glb", type=Path, required=True)
    p_comp.add_argument("--poisson-depth", type=int, default=9)
    p_comp.add_argument("--keep-multi-components", action="store_true")
    p_comp.add_argument("--report-out", type=Path, default=None)

    p_proj = sub.add_parser("project-uv", help="Project train photos onto baked UV atlas.")
    p_proj.add_argument("--geom-glb", type=Path, required=True)
    p_proj.add_argument("--maps-dir", type=Path, required=True)
    p_proj.add_argument("--dataset-dir", type=Path, required=True)
    p_proj.add_argument("--recon-meta", type=Path, required=True)
    p_proj.add_argument("--bake-report", type=Path, required=True)
    p_proj.add_argument("--view-stride", type=int, default=1)
    p_proj.add_argument("--refined-poses", type=Path, default=None)
    p_proj.add_argument("--texture-mode", choices=("blend", "best_view"), default="blend")
    p_proj.add_argument("--seam-width-px", type=float, default=3.0)
    p_proj.add_argument("--potts-weight", type=float, default=0.75)
    p_proj.add_argument("--no-color-levelling", action="store_true")
    p_proj.add_argument("--color-field", action="store_true", help="Use low-frequency 2D spatial + chroma colour levelling.")
    p_proj.add_argument("--inpaint-unprojected", action="store_true", help="Inpaint unprojected/dark fallback texels from neighbours.")
    p_proj.add_argument(
        "--bright-concave",
        action="store_true",
        help="For concave/self-shadowed texels, blend toward a robust upper-percentile per-texel colour (best_view only).",
    )
    p_proj.add_argument(
        "--specular-gloss-out",
        type=Path,
        default=None,
        help="Optional path for a per-texel view-angle highlight-excursion (glossiness) map; blend mode only.",
    )
    p_proj.add_argument("--specular-min-views", type=int, default=3)
    p_proj.add_argument("--specular-gloss-scale", type=float, default=0.32)
    p_proj.add_argument("--bright-concave-q-lo", type=float, default=0.60, help="Lower weighted luminance percentile of the robust band.")
    p_proj.add_argument("--bright-concave-q-hi", type=float, default=0.92, help="Upper weighted luminance percentile of the robust band.")
    p_proj.add_argument("--bright-concave-ao-thresh", type=float, default=0.95, help="AO below which a texel is treated as concave.")
    p_proj.add_argument("--bright-concave-spread-thresh", type=float, default=0.35, help="Inter-view shadow-spread above which a texel is treated as self-shadowed.")

    p_prep_eval = sub.add_parser("prep-eval-cameras", help="Write transformed held-out (or train) cameras JSON.")
    p_prep_eval.add_argument("--dataset-dir", type=Path, required=True)
    p_prep_eval.add_argument("--recon-meta", type=Path, required=True)
    p_prep_eval.add_argument("--bake-report", type=Path, required=True)
    p_prep_eval.add_argument("--out-json", type=Path, required=True)
    p_prep_eval.add_argument("--split", choices=("val", "train"), default="val")
    p_prep_eval.add_argument("--stride", type=int, default=1)

    p_align = sub.add_parser(
        "align-heldout-cameras",
        help="Optimize ONLY each held-out camera SE(3) pose against frozen final mesh/texture.",
    )
    p_align.add_argument("--geom-glb", type=Path, required=True)
    p_align.add_argument("--basecolor", type=Path, required=True)
    p_align.add_argument("--cameras", type=Path, required=True)
    p_align.add_argument("--dataset-dir", type=Path, required=True)
    p_align.add_argument("--out-json", type=Path, required=True)
    p_align.add_argument("--report-out", type=Path, default=None)

    p_sharp = sub.add_parser("texture-sharpness", help="Measure texture sharpness inside UV-valid mask.")
    p_sharp.add_argument("--tex", type=Path, required=True)
    p_sharp.add_argument("--uv-mask", type=Path, required=True)
    p_sharp.add_argument("--erosion-iters", type=int, default=2)
    p_sharp.add_argument("--out-json", type=Path, default=None)

    p_cutout = sub.add_parser("prep-qa-cutout", help="Prepare RGBA cutout PNG from train frame 0 for qa_gate.")
    p_cutout.add_argument("--dataset-dir", type=Path, required=True)
    p_cutout.add_argument("--out-cutout", type=Path, required=True)

    p_score = sub.add_parser("score-heldout", help="Score rendered held-out (or train) views and build turntable sheet.")
    p_score.add_argument("--dish", required=True)
    p_score.add_argument("--dataset-dir", type=Path, required=True)
    p_score.add_argument("--eval-dir", type=Path, required=True)
    p_score.add_argument("--out-dir", type=Path, required=True)
    p_score.add_argument("--modes", default="albedo,lit")
    p_score.add_argument("--split", choices=("val", "train"), default="val")
    p_score.add_argument("--stride", type=int, default=1)

    args = parser.parse_args(argv)

    def _composed_matrix(recon_meta_path: Path, bake_report_path: Path) -> np.ndarray:
        recon_meta = json.loads(recon_meta_path.read_text(encoding="utf-8"))
        bake_report = json.loads(bake_report_path.read_text(encoding="utf-8"))
        m_world_to_metric = np.asarray(recon_meta["world_to_metric"]["matrix_4x4"], dtype=np.float64)
        m_blender = compose_blender_seating_transform(bake_report.get("seating", {}))
        return m_blender @ m_world_to_metric

    if args.command == "reconstruct":
        report = run_2dgs_and_tsdf(
            args.dataset_dir,
            args.out_dir,
            dish=args.dish,
            steps=args.steps,
            max_splats=args.max_splats,
            diameter_cm=args.diameter_cm,
            voxel_divisions=args.voxel_divisions,
            tsdf_alpha_thresh=args.tsdf_alpha_thresh,
            tsdf_depth_source=args.tsdf_depth_source,
            tsdf_trunc_voxels=args.tsdf_trunc_voxels,
            tsdf_cube_padding=args.tsdf_cube_padding,
            smooth_iterations=args.smooth_iterations,
            seed=args.seed,
            refine_stop_iter=args.refine_stop_iter,
            pose_refine=args.pose_refine,
            pose_warmup_steps=args.pose_warmup_steps,
            pose_lr_rot=args.pose_lr_rot,
            pose_lr_trans=args.pose_lr_trans,
            pose_reg_weight=args.pose_reg_weight,
            pose_reg_trans_weight=args.pose_reg_trans_weight,
            mask_carve=args.mask_carve,
            mask_carve_tol_px=args.mask_carve_tol_px,
            mask_carve_max_out_frac=args.mask_carve_max_out_frac,
            trim_drips=args.trim_drips,
            repair_pits=args.repair_pits,
            solid_complete=args.solid_complete,
            poisson_depth=args.poisson_depth,
            keep_multi_components=args.keep_multi_components,
        )
        print(json.dumps(report, indent=2))
    elif args.command == "complete-mesh":
        import trimesh

        loaded = trimesh.load(str(args.in_glb), force="mesh")
        mesh = trimesh.util.concatenate(list(loaded.geometry.values())) if isinstance(loaded, trimesh.Scene) else loaded
        verts_in = np.asarray(mesh.vertices, dtype=np.float64)
        faces_in = np.asarray(mesh.faces, dtype=np.int64)
        colors_in: np.ndarray | None = None
        if getattr(mesh.visual, "vertex_colors", None) is not None and len(mesh.visual.vertex_colors) == len(verts_in):
            colors_in = np.asarray(mesh.visual.vertex_colors, dtype=np.float64)[:, :3] / 255.0

        verts_out, faces_out, colors_out, stats = complete_solid_mesh(
            verts_in,
            faces_in,
            colors_in,
            up_axis_index=1,
            poisson_depth=args.poisson_depth,
            keep_multi_components=args.keep_multi_components,
        )
        if colors_out is not None:
            vcols_u8 = np.column_stack(
                [
                    np.clip(np.rint(colors_out * 255.0), 0, 255).astype(np.uint8),
                    np.full((len(verts_out),), 255, dtype=np.uint8),
                ]
            )
            out_tm = trimesh.Trimesh(vertices=verts_out, faces=faces_out, vertex_colors=vcols_u8, process=False)
        else:
            out_tm = trimesh.Trimesh(vertices=verts_out, faces=faces_out, process=False)

        args.out_glb.parent.mkdir(parents=True, exist_ok=True)
        out_tm.export(str(args.out_glb))
        stamp_glb_asset_extras(
            args.out_glb,
            {"publication_eligible": False, "pipeline": "food3d-track2b-solid-complete"},
        )
        report = {
            "schema_version": 1,
            "pipeline": "food3d-track2b-solid-complete",
            "publication_eligible": False,
            "in_glb": str(args.in_glb),
            "out_glb": str(args.out_glb),
            "keep_multi_components": bool(args.keep_multi_components),
            **stats,
        }
        if args.report_out is not None:
            args.report_out.parent.mkdir(parents=True, exist_ok=True)
            args.report_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    elif args.command == "project-uv":
        m_total = _composed_matrix(args.recon_meta, args.bake_report)
        refined_path = args.refined_poses
        if refined_path is None:
            candidate = args.recon_meta.parent / "refined_train_poses.json"
            if candidate.is_file():
                refined_path = candidate
        stats = project_train_photos_to_uv(
            args.geom_glb,
            args.maps_dir,
            args.dataset_dir,
            m_total,
            view_stride=args.view_stride,
            refined_poses_path=refined_path,
            texture_mode=args.texture_mode,
            seam_width_px=args.seam_width_px,
            potts_weight=args.potts_weight,
            color_levelling=not args.no_color_levelling,
            color_field=args.color_field,
            inpaint_unprojected=args.inpaint_unprojected,
            specular_gloss_out=args.specular_gloss_out,
            specular_min_views=args.specular_min_views,
            specular_gloss_scale=args.specular_gloss_scale,
            bright_concave=args.bright_concave,
            bright_concave_q_lo=args.bright_concave_q_lo,
            bright_concave_q_hi=args.bright_concave_q_hi,
            bright_concave_ao_thresh=args.bright_concave_ao_thresh,
            bright_concave_spread_thresh=args.bright_concave_spread_thresh,
        )
        print(json.dumps(stats, indent=2))
    elif args.command == "prep-eval-cameras":
        m_total = _composed_matrix(args.recon_meta, args.bake_report)
        out = prepare_heldout_cameras_json(
            args.dataset_dir,
            m_total,
            args.out_json,
            split=args.split,
            stride=args.stride,
        )
        print(out)
    elif args.command == "align-heldout-cameras":
        report = align_heldout_cameras(
            args.geom_glb,
            args.basecolor,
            args.cameras,
            args.dataset_dir,
            args.out_json,
            report_out=args.report_out,
        )
        print(json.dumps(report["summary"], indent=2))
    elif args.command == "texture-sharpness":
        stats = measure_texture_sharpness(
            args.tex,
            args.uv_mask,
            erosion_iters=args.erosion_iters,
        )
        if args.out_json is not None:
            args.out_json.parent.mkdir(parents=True, exist_ok=True)
            args.out_json.write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(stats, indent=2))
    elif args.command == "prep-qa-cutout":
        out_cutout = prepare_qa_cutout_from_train(args.dataset_dir, args.out_cutout)
        print(out_cutout)
    elif args.command == "score-heldout":
        modes = [m.strip() for m in args.modes.split(",") if m.strip()]
        results = {}
        split_file = "transforms_val.json" if args.split == "val" else "transforms_train.json"
        if (args.dataset_dir / split_file).is_file():
            for mode in modes:
                prefix = "heldout" if args.split == "val" else "train"
                results[mode] = score_heldout_renders(
                    args.dish,
                    args.dataset_dir,
                    args.eval_dir / f"{prefix}_{mode}",
                    args.out_dir,
                    mode_label=mode,
                    background="black",
                    split=args.split,
                    stride=args.stride,
                )["summary"]
        else:
            print(f"[track2b][score] Skipping {args.split} scoring: {args.dataset_dir / split_file} not found")
        tt_dir = args.eval_dir / "turntable"
        lit_paths = [tt_dir / f"lit_az{az}.png" for az in (0, 90, 180, 270)]
        clay_paths = [tt_dir / f"clay_az{az}.png" for az in (0, 90, 180, 270)]
        if all(p.is_file() for p in (*lit_paths, *clay_paths)):
            sheet = make_turntable_contact_sheet(
                lit_paths,
                clay_paths,
                args.out_dir / "turntable_contact_sheet.png",
                title=f"Track 2B Mesh - {args.dish}",
            )
            results["turntable_contact_sheet"] = str(sheet)
            results["turntable_fg_luminance"] = measure_turntable_luminance(tt_dir)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        (args.out_dir / "score_summary.json").write_text(
            json.dumps({"schema_version": 1, "publication_eligible": False, **results}, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
