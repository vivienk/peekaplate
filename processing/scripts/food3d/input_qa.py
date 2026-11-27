"""Food3D V1 Stage 0: Deterministic input photo and cutout QA.

Evaluates resolution, sharpness (Laplacian variance), border clipping (both
unpadded frame-edge clips and pre-padded straight-sliced bowl cutouts),
multi-object clutter, cast-shadow perimeter contamination, and specular glare
or flame blowout.

Every emitted JSON report carries ``"publication_eligible": false``.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

try:
    from food3d import (
        PUBLICATION_ELIGIBLE,
        TRIAGE_NEEDS_CLEAN_CUTOUT,
        TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT,
        TRIAGE_NEEDS_RESHOOT_CLIPPED,
        TRIAGE_READY_SINGLE_PHOTO,
        VALID_TRIAGE_STATES,
    )
except ImportError:
    try:
        from . import (
            PUBLICATION_ELIGIBLE,
            TRIAGE_NEEDS_CLEAN_CUTOUT,
            TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT,
            TRIAGE_NEEDS_RESHOOT_CLIPPED,
            TRIAGE_READY_SINGLE_PHOTO,
            VALID_TRIAGE_STATES,
        )
    except ImportError:
        PUBLICATION_ELIGIBLE = False
        TRIAGE_READY_SINGLE_PHOTO = "ready_single_photo"
        TRIAGE_NEEDS_CLEAN_CUTOUT = "needs_clean_cutout"
        TRIAGE_NEEDS_RESHOOT_CLIPPED = "needs_reshoot_clipped"
        TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT = "needs_multiview_or_reshoot"
        VALID_TRIAGE_STATES = (
            TRIAGE_READY_SINGLE_PHOTO,
            TRIAGE_NEEDS_CLEAN_CUTOUT,
            TRIAGE_NEEDS_RESHOOT_CLIPPED,
            TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT,
        )

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}

_LAPLACIAN_KERNEL = np.array(
    [[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]],
    dtype=np.float32,
)


def _longest_true_run(arr_1d: np.ndarray) -> int:
    """Return length of the longest contiguous True run in a 1D boolean array."""
    if arr_1d.size == 0 or not np.any(arr_1d):
        return 0
    padded = np.concatenate(([False], arr_1d.astype(bool), [False]))
    diffs = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(diffs == 1)
    ends = np.flatnonzero(diffs == -1)
    return int(np.max(ends - starts)) if starts.size > 0 else 0


def _to_float_rgb(rgb: np.ndarray) -> np.ndarray:
    """Normalize an RGB array to float32 in [0, 1]."""
    arr = np.asarray(rgb, dtype=np.float32)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError(f"Expected RGB array with shape (H, W, 3+), got {arr.shape}")
    arr = arr[..., :3]
    if arr.max() > 1.0:
        arr = arr / 255.0
    return np.clip(arr, 0.0, 1.0)


def _to_float_alpha(alpha: np.ndarray) -> np.ndarray:
    """Normalize an alpha array to float32 in [0, 1]."""
    arr = np.asarray(alpha, dtype=np.float32)
    if arr.ndim != 2:
        raise ValueError(f"Expected 2D alpha array, got {arr.shape}")
    if arr.max() > 1.0:
        arr = arr / 255.0
    return np.clip(arr, 0.0, 1.0)


def compute_laplacian_variance(
    rgb: np.ndarray,
    mask: np.ndarray | None = None,
) -> float:
    """Compute discrete Laplacian variance on luminance (0..255 scale)."""
    rgb_f = _to_float_rgb(rgb)
    lum = (0.2126 * rgb_f[..., 0] + 0.7152 * rgb_f[..., 1] + 0.0722 * rgb_f[..., 2]) * 255.0
    lap = ndimage.convolve(lum, _LAPLACIAN_KERNEL, mode="nearest")
    if mask is not None and np.any(mask):
        vals = lap[mask]
    else:
        vals = lap.ravel()
    if vals.size < 4:
        return 0.0
    return float(np.var(vals, dtype=np.float64))


def analyze_arrays(
    rgb: np.ndarray,
    alpha: np.ndarray | None = None,
    *,
    image_path: str | None = None,
    cutout_path: str | None = None,
) -> dict[str, Any]:
    """Run all deterministic Food3D Stage 0 QA checks on in-memory arrays."""
    rgb_f = _to_float_rgb(rgb)
    h, w = rgb_f.shape[:2]
    min_side = min(h, w)
    long_side = max(h, w)

    alpha_f: np.ndarray | None = None
    if alpha is not None:
        alpha_f = _to_float_alpha(alpha)
        if alpha_f.shape != (h, w):
            alpha_img = Image.fromarray(alpha_f, mode="F").resize((w, h), Image.Resampling.BILINEAR)
            alpha_f = np.clip(np.asarray(alpha_img, dtype=np.float32), 0.0, 1.0)

    issues: list[str] = []

    # (a) Resolution check
    if min_side < 512:
        resolution_status = "fail"
        issues.append("low_resolution_fail")
    elif min_side < 1024:
        resolution_status = "warn"
        issues.append("low_resolution_warn")
    else:
        resolution_status = "pass"

    # Luminance & HSV-like saturation
    lum = 0.2126 * rgb_f[..., 0] + 0.7152 * rgb_f[..., 1] + 0.0722 * rgb_f[..., 2]
    max_rgb = np.max(rgb_f, axis=-1)
    min_rgb = np.min(rgb_f, axis=-1)
    sat = (max_rgb - min_rgb) / (max_rgb + 1e-6)

    fg_solid: np.ndarray | None = None
    if alpha_f is not None:
        fg_solid = alpha_f > 0.5

    # (b) Sharpness (Laplacian variance on foreground interior & center crop)
    sharp_mask: np.ndarray | None = None
    if fg_solid is not None and np.any(fg_solid):
        eroded = ndimage.binary_erosion(fg_solid, iterations=2)
        sharp_mask = eroded if int(np.sum(eroded)) >= 64 else fg_solid
    lap_var_fg = compute_laplacian_variance(rgb_f, sharp_mask)

    cy0, cy1 = h // 4, max(h // 4 + 1, (3 * h) // 4)
    cx0, cx1 = w // 4, max(w // 4 + 1, (3 * w) // 4)
    lap_var_center = compute_laplacian_variance(rgb_f[cy0:cy1, cx0:cx1], None)
    blurry = lap_var_fg < 40.0 and lap_var_center < 40.0
    if blurry:
        issues.append("blurry_image")

    # (c) Border-clipping detector (raw edges + pre-padded alpha bbox edges)
    clipped_sides: list[str] = []
    raw_border_touches: dict[str, float] = {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0}
    bbox_edge_runs: dict[str, float] = {"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0}
    circularity = 0.0
    bbox_dict: dict[str, int] | None = None

    if fg_solid is not None and np.any(fg_solid):
        # Raw frame edge touches (outer 2 px of image frame)
        edge_band = 2
        raw_border_touches = {
            "left": float(np.mean(np.any(fg_solid[:, :edge_band], axis=1))),
            "right": float(np.mean(np.any(fg_solid[:, max(0, w - edge_band) :], axis=1))),
            "top": float(np.mean(np.any(fg_solid[:edge_band, :], axis=0))),
            "bottom": float(np.mean(np.any(fg_solid[max(0, h - edge_band) :, :], axis=0))),
        }
        for side, frac in raw_border_touches.items():
            if frac >= 0.05 and side not in clipped_sides:
                clipped_sides.append(side)

        # Alpha bounding box edge straight-cut inspection
        ys, xs = np.nonzero(fg_solid)
        y0, y1 = int(ys.min()), int(ys.max())
        x0, x1 = int(xs.min()), int(xs.max())
        bh = y1 - y0 + 1
        bw = x1 - x0 + 1
        bbox_dict = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "width": bw, "height": bh}

        strip_lr = 2 if bh >= 200 else 1
        strip_tb = 2 if bw >= 200 else 1

        left_strip = np.any(fg_solid[y0 : y1 + 1, x0 : min(x1 + 1, x0 + strip_lr)], axis=1)
        right_strip = np.any(fg_solid[y0 : y1 + 1, max(x0, x1 - strip_lr + 1) : x1 + 1], axis=1)
        top_strip = np.any(fg_solid[y0 : min(y1 + 1, y0 + strip_tb), x0 : x1 + 1], axis=0)
        bottom_strip = np.any(fg_solid[max(y0, y1 - strip_tb + 1) : y1 + 1, x0 : x1 + 1], axis=0)

        bbox_edge_runs = {
            "left": _longest_true_run(left_strip) / float(bh),
            "right": _longest_true_run(right_strip) / float(bh),
            "top": _longest_true_run(top_strip) / float(bw),
            "bottom": _longest_true_run(bottom_strip) / float(bw),
        }

        if bbox_edge_runs["left"] >= 0.22 and "left" not in clipped_sides:
            clipped_sides.append("left")
        if bbox_edge_runs["right"] >= 0.22 and "right" not in clipped_sides:
            clipped_sides.append("right")
        if bbox_edge_runs["top"] >= 0.28 and "top" not in clipped_sides:
            clipped_sides.append("top")
        if bbox_edge_runs["bottom"] >= 0.28 and "bottom" not in clipped_sides:
            clipped_sides.append("bottom")

        # Circularity of main foreground component
        area = float(np.sum(fg_solid))
        eroded_1 = ndimage.binary_erosion(fg_solid, iterations=1)
        perimeter = float(np.sum(fg_solid & (~eroded_1)))
        if perimeter > 0.0:
            circularity = min(1.0, (4.0 * math.pi * area) / (perimeter * perimeter))

    border_clipped = len(clipped_sides) > 0
    if border_clipped:
        issues.append("border_clipped")

    # (d) Clutter / multi-object detector
    secondary_component_count = 0
    largest_secondary_ratio = 0.0
    total_components = 0
    clutter_detected = False

    if fg_solid is not None and np.any(fg_solid):
        labeled, num_features = ndimage.label(fg_solid, structure=np.ones((3, 3), dtype=np.int32))
        total_components = int(num_features)
        if num_features > 1:
            counts = np.bincount(labeled.ravel())[1:]  # exclude background 0
            main_area = int(np.max(counts))
            if main_area > 0:
                secondary_areas = [
                    int(c) for idx, c in enumerate(counts)
                    if idx != int(np.argmax(counts)) and c >= 0.02 * main_area
                ]
                secondary_component_count = len(secondary_areas)
                if secondary_areas:
                    largest_secondary_ratio = max(secondary_areas) / float(main_area)
                if largest_secondary_ratio >= 0.12 or secondary_component_count >= 3:
                    clutter_detected = True
                    issues.append("clutter_detected")

    # (e) Cast-shadow perimeter contamination
    shadow_contamination_ratio = 0.0
    shadow_contamination = False

    if alpha_f is not None:
        fg_any = alpha_f > 0.05
        fg_any_count = int(np.sum(fg_any))
        if fg_any_count > 0:
            semi_alpha = (alpha_f > 0.05) & (alpha_f < 0.85)
            solid_core = alpha_f >= 0.85
            if bbox_dict is not None:
                erode_r = max(3, min(16, int(0.04 * min(bbox_dict["width"], bbox_dict["height"]))))
            else:
                erode_r = 4
            eroded_core = ndimage.binary_erosion(solid_core, iterations=erode_r)
            core_ref = eroded_core if np.any(eroded_core) else solid_core
            if np.any(core_ref):
                core_median_lum = float(np.median(lum[core_ref]))
                outer_ring = fg_any & (~core_ref)
                dark_low_sat_outer = (
                    outer_ring
                    & (sat < 0.18)
                    & (lum < min(core_median_lum * 0.85, 0.55))
                )
            else:
                dark_low_sat_outer = np.zeros_like(fg_any, dtype=bool)

            shadow_suspect = semi_alpha | dark_low_sat_outer
            shadow_contamination_ratio = float(np.sum(shadow_suspect)) / float(fg_any_count)
            if shadow_contamination_ratio >= 0.08:
                shadow_contamination = True
                issues.append("shadow_contamination")

    # (f) Specular glare / flame blowout
    glare_mask_region = fg_solid if (fg_solid is not None and np.any(fg_solid)) else np.ones((h, w), dtype=bool)
    glare_region_count = int(np.sum(glare_mask_region))
    if glare_region_count > 0:
        specular_glare = (lum > 0.94) & (sat < 0.12)
        flame_blowout = (rgb_f[..., 0] > 0.96) & (rgb_f[..., 1] > 0.78)
        glare_ratio = float(np.sum((specular_glare | flame_blowout) & glare_mask_region)) / float(glare_region_count)
    else:
        glare_ratio = 0.0
    glare_detected = glare_ratio >= 0.03
    if glare_detected:
        issues.append("specular_glare_blowout")

    # Triage classification
    if border_clipped:
        triage = TRIAGE_NEEDS_RESHOOT_CLIPPED
    elif resolution_status == "fail" or blurry or (glare_detected and glare_ratio >= 0.10):
        triage = TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT
    elif clutter_detected or shadow_contamination:
        triage = TRIAGE_NEEDS_CLEAN_CUTOUT
    else:
        triage = TRIAGE_READY_SINGLE_PHOTO

    return {
        "publication_eligible": PUBLICATION_ELIGIBLE,
        "image_path": image_path,
        "cutout_path": cutout_path,
        "triage": triage,
        "issues": issues,
        "metrics": {
            "width": w,
            "height": h,
            "min_side": min_side,
            "long_side": long_side,
            "resolution_status": resolution_status,
            "laplacian_var_fg": round(lap_var_fg, 3),
            "laplacian_var_center": round(lap_var_center, 3),
            "blurry": blurry,
            "border_clipped": border_clipped,
            "clipped_sides": clipped_sides,
            "raw_border_touches": {k: round(v, 4) for k, v in raw_border_touches.items()},
            "bbox_edge_runs": {k: round(v, 4) for k, v in bbox_edge_runs.items()},
            "circularity": round(circularity, 4),
            "alpha_bbox": bbox_dict,
            "total_components": total_components,
            "secondary_component_count": secondary_component_count,
            "largest_secondary_ratio": round(largest_secondary_ratio, 4),
            "clutter_detected": clutter_detected,
            "shadow_contamination_ratio": round(shadow_contamination_ratio, 4),
            "shadow_contamination": shadow_contamination,
            "glare_ratio": round(glare_ratio, 4),
            "glare_detected": glare_detected,
        },
    }


def analyze_image(
    image_path: str | Path,
    cutout_path: str | Path | None = None,
) -> dict[str, Any]:
    """Load an image (and optional RGBA cutout) from disk and run Stage 0 QA."""
    img_p = Path(image_path)
    cut_p = Path(cutout_path) if cutout_path is not None else None

    with Image.open(img_p) as im:
        has_embedded_alpha = "A" in im.getbands()
        if has_embedded_alpha:
            rgba = np.asarray(im.convert("RGBA"), dtype=np.uint8)
            rgb = rgba[..., :3]
            embedded_alpha = rgba[..., 3]
        else:
            rgb = np.asarray(im.convert("RGB"), dtype=np.uint8)
            embedded_alpha = None

    alpha: np.ndarray | None = None
    if cut_p is not None:
        with Image.open(cut_p) as cim:
            if "A" in cim.getbands():
                alpha = np.asarray(cim.convert("RGBA"), dtype=np.uint8)[..., 3]
            else:
                alpha = np.asarray(cim.convert("L"), dtype=np.uint8)
    elif embedded_alpha is not None and int(embedded_alpha.min()) < 250:
        alpha = embedded_alpha

    return analyze_arrays(
        rgb,
        alpha,
        image_path=str(img_p),
        cutout_path=str(cut_p) if cut_p is not None else None,
    )


def analyze_batch_dir(batch_dir: str | Path) -> dict[str, Any]:
    """Scan a batch directory of dish folders or flat image files and summarize QA."""
    root = Path(batch_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"Batch directory not found: {root}")

    targets: list[tuple[Path, Path | None]] = []

    subdirs = sorted(p for p in root.iterdir() if p.is_dir())
    for sub in subdirs:
        input_img = sub / "input_image.png"
        if input_img.is_file():
            cutout = sub / "cutout_rgba.png"
            targets.append((input_img, cutout if cutout.is_file() else None))

    if not targets:
        for p in sorted(root.iterdir()):
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
                targets.append((p, None))

    items = [analyze_image(img_p, cut_p) for img_p, cut_p in targets]
    counts: dict[str, int] = {state: 0 for state in VALID_TRIAGE_STATES}
    for item in items:
        state = item["triage"]
        counts[state] = counts.get(state, 0) + 1

    return {
        "publication_eligible": PUBLICATION_ELIGIBLE,
        "batch_dir": str(root),
        "total": len(items),
        "counts_by_triage": counts,
        "items": items,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Food3D V1 Stage 0 deterministic input photo & cutout QA.",
    )
    parser.add_argument(
        "image_path",
        nargs="?",
        help="Path to a single input image (omit when using --batch-dir).",
    )
    parser.add_argument(
        "--cutout",
        dest="cutout_path",
        default=None,
        help="Optional RGBA cutout PNG aligned with image_path.",
    )
    parser.add_argument(
        "--batch-dir",
        dest="batch_dir",
        default=None,
        help="Directory of dish subdirectories (input_image.png) or flat image files.",
    )
    parser.add_argument(
        "--out",
        dest="out_path",
        default=None,
        help="Optional output path for the JSON QA report.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if bool(args.image_path) == bool(args.batch_dir):
        parser.error("Provide either <image_path> or --batch-dir (not both).")

    if args.batch_dir:
        report = analyze_batch_dir(args.batch_dir)
    else:
        report = analyze_image(args.image_path, args.cutout_path)

    payload = json.dumps(report, indent=2)
    if args.out_path:
        out_p = Path(args.out_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        out_p.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
