"""Convert local CO3D captures into a Brush/Nerfstudio dataset and visual hull."""

from __future__ import annotations

import argparse
import gzip
import json
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


@dataclass
class Camera:
    intrinsics: dict[str, int | float]
    rotation: np.ndarray
    translation: np.ndarray
    transform_matrix: np.ndarray

    def project(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        camera = points @ self.rotation.T + self.translation
        depth = camera[:, 2]
        xy = camera[:, :2] / np.where(depth != 0, depth, np.nan)[:, None]
        k = self.intrinsics
        return xy * [k["fl_x"], k["fl_y"]] + [k["cx"], k["cy"]], depth


def pytorch3d_ndc_to_opencv_and_opengl(
    R: np.ndarray,
    T: np.ndarray,
    focal_length: list[float],
    principal_point: list[float],
    original_size: tuple[int, int],
    output_size: tuple[int, int] | None = None,
) -> Camera:
    """Convert isotropic NDC and row-vector w2c into pixel intrinsics and both poses."""
    R, T = np.asarray(R, dtype=float), np.asarray(T, dtype=float)
    original_w, original_h = original_size
    w, h = output_size or original_size
    sx, sy = w / original_w, h / original_h
    scale = min(original_w, original_h) / 2
    intrinsics = {
        "w": w, "h": h,
        "fl_x": float(focal_length[0]) * scale * sx,
        "fl_y": float(focal_length[1]) * scale * sy,
        "cx": (original_w / 2 - float(principal_point[0]) * scale) * sx,
        "cy": (original_h / 2 - float(principal_point[1]) * scale) * sy,
    }
    cv_axes = np.diag([-1., -1., 1.])
    transform = np.eye(4)
    transform[:3, :3] = R @ np.diag([-1., 1., -1.])
    transform[:3, 3] = -R @ T
    return Camera(intrinsics, cv_axes @ R.T, cv_axes @ T, transform)


@dataclass
class View:
    camera: Camera
    mask: np.ndarray
    centroid: np.ndarray
    radius_px: float
    image_path: Path

    def hits(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        xy, depth = self.camera.project(points)
        h, w = self.mask.shape
        inside = (depth > 0) & ((xy >= 0) & (xy < [w, h])).all(axis=1)
        indices = np.flatnonzero(inside)
        pixels = xy[inside].astype(int)
        foreground = self.mask[pixels[:, 1], pixels[:, 0]]
        return indices[foreground], pixels[foreground]


def _find_annotations(directory: Path) -> Path:
    direct = directory / "frame_annotations.jgz"
    if direct.is_file():
        return direct
    nested = sorted(directory.glob("*/frame_annotations.jgz"))
    if len(nested) != 1:
        raise RuntimeError(f"Expected one frame_annotations.jgz under {directory}, found {len(nested)}")
    return nested[0]


def _asset_path(category: Path, relative_path: str) -> Path:
    path = Path(relative_path)
    candidates = [category.parent / path, category / path]
    if path.parts and path.parts[0] == category.name:
        candidates.append(category.joinpath(*path.parts[1:]))
    return next((candidate for candidate in candidates if candidate.is_file()), candidates[0])


def _target_size(size: tuple[int, int], max_dim: int) -> tuple[int, int]:
    if max_dim <= 0 or max(size) <= max_dim:
        return size
    ratio = max_dim / max(size)
    return tuple(max(2, round(dimension * ratio)) for dimension in size)


def _prepare_view(item: dict, category: Path, out_dir: Path, mask_mode: str, max_dim: int):
    if (item.get("meta") or {}).get("frame_type") == "test_unseen":
        return None
    if not item.get("image", {}).get("path") or not (item.get("mask") or {}).get("path"):
        return None
    image_path = _asset_path(category, item["image"]["path"])
    mask_path = _asset_path(category, item["mask"]["path"])
    if not image_path.is_file() or not mask_path.is_file():
        return None
    with Image.open(image_path) as source:
        image = source.convert("RGB")
    with Image.open(mask_path) as source:
        mask_image = source.convert("L")
    if np.asarray(image).max() <= 10 or np.count_nonzero(np.asarray(mask_image) > 127) < 100:
        return None
    if mask_image.size != image.size:
        raise RuntimeError(f"Mask dimensions differ from image dimensions for {image_path}")
    if item["image"].get("size") != list(reversed(image.size)):
        warnings.warn(f"Using decoded dimensions for {image_path}: {image.size}", stacklevel=2)
    size = _target_size(image.size, max_dim)
    pose = item["viewpoint"]
    if pose.get("intrinsics_format", "ndc_isotropic") != "ndc_isotropic":
        raise RuntimeError(f"Expected ndc_isotropic intrinsics for {image_path}")
    camera = pytorch3d_ndc_to_opencv_and_opengl(
        pose["R"], pose["T"], pose["focal_length"], pose["principal_point"], image.size, size
    )
    if mask_mode == "rgba":
        raw_alpha = np.asarray(mask_image, dtype=np.float32)
        alpha = np.where(
            raw_alpha > 127.0,
            np.clip(np.rint((raw_alpha - 127.0) * (255.0 / 127.0)), 1.0, 255.0),
            0.0,
        )
        rgb = np.asarray(image).copy()
        if size != image.size:
            premultiplied = rgb * (alpha[..., None] / 255.0)
            channels = [
                np.asarray(Image.fromarray(channel).resize(size, Image.Resampling.BILINEAR))
                for channel in (*np.moveaxis(premultiplied, -1, 0), alpha)
            ]
            alpha = channels[3]
            rgb = np.rint(np.clip(
                np.stack(channels[:3], axis=-1) * (255.0 / np.maximum(alpha[..., None], 1e-6)),
                0.0, 255.0,
            )).astype(np.uint8)
        clean_alpha = np.rint(alpha).astype(np.uint8)
        rgb[clean_alpha == 0] = 0
        image = Image.fromarray(np.dstack((rgb, clean_alpha)))
        mask_image = Image.fromarray(clean_alpha)
    else:
        image = image.resize(size, Image.Resampling.LANCZOS)
        mask_image = mask_image.resize(size, Image.Resampling.BILINEAR)
    mask = np.asarray(mask_image) > 127
    y, x = np.nonzero(mask)
    if not x.size:
        return None
    number = int(item["frame_number"])
    filename = f"frame_{number:06d}.png"
    relative_image = f"images/{filename}"
    relative_mask = f"eval_masks/{filename}"
    image.save(out_dir / relative_image)
    mask_image.save(out_dir / relative_mask)
    view = View(camera, mask, np.array([x.mean(), y.mean()]), np.sqrt(x.size / np.pi), out_dir / relative_image)
    frame = {
        "file_path": relative_image, "eval_mask_path": relative_mask, "frame_number": number,
        **camera.intrinsics, "transform_matrix": camera.transform_matrix.tolist(),
    }
    return view, frame


def _estimate_hull_bounds(views: list[View]) -> tuple[np.ndarray, float]:
    projectors, centers, angular_radii = [], [], []
    for view in views:
        k = view.camera.intrinsics
        u, v = view.centroid
        direction = np.array([(u - k["cx"]) / k["fl_x"], (v - k["cy"]) / k["fl_y"], 1.])
        direction = view.camera.rotation.T @ (direction / np.linalg.norm(direction))
        projectors.append(np.eye(3) - np.outer(direction, direction))
        centers.append(view.camera.transform_matrix[:3, 3])
        angular_radii.append(2 * view.radius_px / (k["fl_x"] + k["fl_y"]))
    projectors = np.asarray(projectors)
    centers = np.asarray(centers)
    center = np.linalg.lstsq(projectors.sum(axis=0), np.einsum("vij,vj->i", projectors, centers), rcond=None)[0]
    distance = np.median(np.linalg.norm(center - centers, axis=1))
    radius = 1.6 * distance * np.median(angular_radii)
    return center, float(np.clip(radius, 1e-6, max(1e-6, 2 * distance)))


def _carve_hull(views: list[View], resolution: int, max_points: int, rng: np.random.Generator):
    center, radius = _estimate_hull_bounds(views)
    step = 2 * radius / resolution
    axis = -radius + (np.arange(resolution) + 0.5) * step
    grid = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1).reshape(-1, 3)
    grid += center
    votes = np.zeros(len(grid), dtype=np.uint8)
    for view in views:
        indices, _ = view.hits(grid)
        votes[indices] += 1
    for threshold in (0.85, 0.80, 0.75, 0.70, 0.60, 0.50):
        kept = grid[votes >= threshold * len(views)]
        if len(kept) >= 2000:
            break
    fallback = threshold == 0.50 and len(kept) < 200
    if fallback:
        relative = (grid - center) / (radius * np.array([0.5, 0.5, 0.35]))
        ellipsoid = (relative ** 2).sum(axis=1) <= 1
        kept = grid[ellipsoid & (votes > 0)]
        if not len(kept):
            kept = grid[ellipsoid]
        if not len(kept):
            kept = center[None, :]
    points = kept[rng.choice(len(kept), max_points, replace=len(kept) < max_points)]
    jitter = rng.uniform(-1, 1, size=points.shape)
    points += 0.4 * step * jitter / np.maximum(1, np.linalg.norm(jitter, axis=1, keepdims=True))
    # Validate the float32 coordinates that will be written to the PLY.
    points = points.astype("<f4")
    colors = np.full((len(points), 3), 128, dtype=np.uint8)
    if not fallback:
        samples = np.full((len(views), len(points), 3), np.nan, dtype=np.float32)
        for i, view in enumerate(views):
            indices, pixels = view.hits(points)
            with Image.open(view.image_path) as image:
                rgb = np.asarray(image.convert("RGB"))
            samples[i, indices] = rgb[pixels[:, 1], pixels[:, 0]]
        visible = np.isfinite(samples[:, :, 0]).any(axis=0)
        colors[visible] = np.rint(np.nanmedian(samples[:, visible], axis=0)).astype(np.uint8)
    return center, points, colors, None if fallback else threshold


def _write_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    vertices = np.empty(len(points), dtype=[("xyz", "<f4", 3), ("rgb", "u1", 3)])
    vertices["xyz"], vertices["rgb"] = points, colors
    with path.open("wb") as stream:
        stream.write((
            f"ply\nformat binary_little_endian 1.0\nelement vertex {len(points)}\n"
            "property float x\nproperty float y\nproperty float z\n"
            "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
        ).encode("ascii"))
        vertices.tofile(stream)


def _build_transforms_json(
    frame_views: list[View], frame_dicts: list[dict], *, include_ply: bool = True
) -> dict:
    transforms: dict = {
        "publication_eligible": False,
        "camera_model": "OPENCV",
        "frames": frame_dicts,
    }
    if include_ply:
        transforms["ply_file_path"] = "points3d.ply"
    if frame_views:
        intrinsics = frame_views[0].camera.intrinsics
        if all(
            all(view.camera.intrinsics[key] == intrinsics[key] for key in ("w", "h"))
            and all(abs(view.camera.intrinsics[key] - intrinsics[key]) <= 1e-9 for key in ("fl_x", "fl_y", "cx", "cy"))
            for view in frame_views
        ):
            transforms.update(intrinsics)
    return transforms


def convert_co3d_sequence(
    co3d_category_dir: Path, out_dir: Path, *, sequence: str | None = None,
    mask_mode: str = "rgba", max_points: int = 20000, voxel_res: int = 48, max_dim: int = 1024,
    eval_split_every: int = 8,
) -> dict:
    """Prepare one sequence and require its initialization to pass reprojection QA."""
    if mask_mode not in ("rgba", "rgb") or max_points < 1 or voxel_res < 2 or max_dim == 1:
        raise ValueError("Expected rgba/rgb, max_points >= 1, voxel_res >= 2 and max_dim != 1")
    if eval_split_every < 0:
        raise ValueError("eval_split_every must be >= 0")
    annotations = _find_annotations(Path(co3d_category_dir))
    with gzip.open(annotations, "rt", encoding="utf-8") as stream:
        items = json.load(stream)
    if sequence is None:
        sequence = min((item["sequence_name"] for item in items), default=None)
    items = sorted(
        (item for item in items if item["sequence_name"] == sequence),
        key=lambda item: int(item["frame_number"]),
    )
    out_dir = Path(out_dir)
    for subdir in ("images", "eval_masks"):
        (out_dir / subdir).mkdir(parents=True, exist_ok=True)
    # Freeze candidate split membership by sequence metadata before pixel/mask QA
    # so blacking out or failing QA on a held-out frame cannot shift other frames into training.
    candidates = [
        item for item in items if (item.get("meta") or {}).get("frame_type") != "test_unseen"
    ]
    eval_candidate_indices = set(range(0, len(candidates), eval_split_every)) if eval_split_every else set()
    views, frames, is_eval_view = [], [], []
    dropped_known_frames = 0
    for cand_idx, item in enumerate(candidates):
        prepared = _prepare_view(item, annotations.parent, out_dir, mask_mode, max_dim)
        if prepared is not None:
            view, frame = prepared
            views.append(view)
            frames.append(frame)
            is_eval_view.append(cand_idx in eval_candidate_indices)
        else:
            dropped_known_frames += 1
    eval_indices = {i for i, flag in enumerate(is_eval_view) if flag}
    train_views = [view for i, view in enumerate(views) if i not in eval_indices]
    eval_views = [view for i, view in enumerate(views) if i in eval_indices]
    train_frames_list = [frame for i, frame in enumerate(frames) if i not in eval_indices]
    eval_frames_list = [frame for i, frame in enumerate(frames) if i in eval_indices]
    if len(train_views) < 2:
        raise RuntimeError(f"Sequence {sequence!r} has {len(train_views)} training frames; at least 2 are required")
    if len({frame["frame_number"] for frame in frames}) != len(frames):
        raise RuntimeError(f"Sequence {sequence!r} contains duplicate valid frame numbers")
    out_root = out_dir.resolve()
    for target_name in ("points3d.ply", "transforms.json", "transforms_train.json", "transforms_val.json", "conversion_report.json"):
        target = out_dir / target_name
        if target.is_symlink() or not target.resolve().is_relative_to(out_root):
            raise RuntimeError(f"Refusing to write through symlink or outside output directory: {target}")
    sampled = [
        train_views[i] for i in np.linspace(0, len(train_views) - 1, min(32, len(train_views)), dtype=int)
    ]
    rng = np.random.default_rng(42)
    center, points, colors, threshold = _carve_hull(sampled, voxel_res, max_points, rng)
    _write_ply(out_dir / "points3d.ply", points, colors)
    checked = points[rng.choice(len(points), min(2000, len(points)), replace=False)]
    hit_rates, reprojection_errors = [], []
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
            ("transforms_train.json", _build_transforms_json(train_views, train_frames_list, include_ply=True)),
            ("transforms_val.json", _build_transforms_json(eval_views, eval_frames_list, include_ply=False)),
        )
        transforms_mode = "train_val_split"
    else:
        train_path.unlink(missing_ok=True)
        val_path.unlink(missing_ok=True)
        transforms_files = (
            ("transforms.json", _build_transforms_json(views, frames, include_ply=True)),
        )
        transforms_mode = "single"
    report = {
        "publication_eligible": False, "sequence": sequence, "mask_mode": mask_mode,
        "transforms_mode": transforms_mode,
        "valid_frames": len(views), "skipped_frames": len(items) - len(views),
        "dropped_known_frames": dropped_known_frames,
        "eval_stride_shifted_by_dropped_frames": bool(eval_split_every > 0 and dropped_known_frames > 0),
        "sampled_views": len(sampled), "initial_point_count": len(points),
        "hull_threshold_used": threshold, "ellipsoid_fallback": threshold is None,
        "eval_split_every": int(eval_split_every),
        "train_frames": len(train_views), "eval_frames": len(eval_views),
        "eval_frame_numbers": [frame["frame_number"] for frame in eval_frames_list],
        "eval_frame_stems": [Path(frame["file_path"]).stem for frame in eval_frames_list],
        "train_mean_mask_hit_rate": float(np.mean(hit_rates[:len(train_views)])),
        "mean_mask_hit_rate": float(np.mean(hit_rates)),
        "median_centroid_reproj_px": float(np.median(reprojection_errors)) if reprojection_errors else None,
        "centroid_behind_camera_views": len(views) - len(reprojection_errors),
    }
    for name, data in (*transforms_files, ("conversion_report.json", report)):
        (out_dir / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    if report["train_mean_mask_hit_rate"] < 0.85:
        raise RuntimeError(f"Visual hull train_mean_mask_hit_rate {report['train_mean_mask_hit_rate']:.3f} is below 0.85")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("co3d_category_dir", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--sequence")
    parser.add_argument("--mask-mode", choices=("rgba", "rgb"), default="rgba")
    parser.add_argument("--max-points", type=int, default=20000)
    parser.add_argument("--voxel-res", type=int, default=48)
    parser.add_argument("--max-dim", type=int, default=1024)
    parser.add_argument("--eval-split-every", type=int, default=8, help="Hold out every Nth frame (0 disables)")
    try:
        report = convert_co3d_sequence(**vars(parser.parse_args(argv)))
    except (RuntimeError, ValueError, OSError) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
