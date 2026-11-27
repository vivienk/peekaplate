"""Food3D V1 Stage 1: Local ONNX cutout extraction & deterministic mask cleanup.

Supports local ONNX Runtime CPU inference with BiRefNet-general-lite (default)
or ISNet-general-use, followed by pure NumPy/SciPy post-processing:
- Main dish connected-component selection (optional side-dish retention)
- Safe exterior cast-shadow stripping that preserves solid dark bowls
- Nearest-interior edge color decontamination (zero fringe on black/white)
- Symmetric square safe-padded framing

Every emitted JSON report carries ``"publication_eligible": false``.
"""

from __future__ import annotations

import argparse
import ctypes
import glob
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from scipy import ndimage

try:
    from food3d import PUBLICATION_ELIGIBLE
except ImportError:
    try:
        from . import PUBLICATION_ELIGIBLE
    except ImportError:
        PUBLICATION_ELIGIBLE = False

MODEL_FILENAMES: dict[str, str] = {
    "birefnet-general-lite": "birefnet-general-lite.onnx",
    "isnet-general-use": "isnet-general-use.onnx",
}

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
_MODEL_INPUT_SIZE = 1024


def _normalize_rgb(rgb_arr: np.ndarray) -> np.ndarray:
    arr = np.asarray(rgb_arr, dtype=np.float32)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError(f"Expected RGB array (H, W, 3+), got {arr.shape}")
    arr = arr[..., :3]
    if arr.max() > 1.0:
        arr = arr / 255.0
    return np.clip(arr, 0.0, 1.0)


def _normalize_alpha(raw_alpha: np.ndarray) -> np.ndarray:
    arr = np.asarray(raw_alpha, dtype=np.float32)
    if arr.ndim != 2:
        raise ValueError(f"Expected 2D alpha array, got {arr.shape}")
    if arr.max() > 1.0:
        arr = arr / 255.0
    return np.clip(arr, 0.0, 1.0)


_CUDA_LIBS_PRELOADED = False


def _preload_nvidia_cuda_libs() -> None:
    """Preload pip-installed NVIDIA CUDA/cuDNN shared libs so ORT CUDAExecutionProvider resolves them."""
    global _CUDA_LIBS_PRELOADED
    if _CUDA_LIBS_PRELOADED:
        return
    _CUDA_LIBS_PRELOADED = True
    try:
        import onnxruntime as ort
        sp_root = Path(ort.__file__).resolve().parent.parent
    except Exception:
        sp_root = Path(sys.prefix)
    nvidia_dir = sp_root / "nvidia"
    if not nvidia_dir.is_dir():
        return
    # Load base CUDA runtime/BLAS before cuDNN and higher-level libs.
    ordered_prefixes = (
        "libcudart",
        "libcublasLt",
        "libcublas",
        "libnvrtc",
        "libcudnn",
        "libcufft",
        "libcurand",
        "libcusolver",
        "libcusparse",
    )
    all_libs = sorted(glob.glob(str(nvidia_dir / "*" / "lib" / "*.so*")))
    loaded: set[str] = set()
    for prefix in ordered_prefixes:
        for lib in all_libs:
            if Path(lib).name.startswith(prefix) and lib not in loaded:
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                    loaded.add(lib)
                except OSError:
                    pass


def create_onnx_session(
    model_name: str = "birefnet-general-lite",
    model_dir: Path | None = None,
    intra_op_threads: int = 4,
    prefer_gpu: bool = False,
) -> tuple[Any, str, str]:
    """Create a reusable local ONNX Runtime session for alpha matte inference."""
    if model_name not in MODEL_FILENAMES:
        raise ValueError(f"Unsupported model '{model_name}'. Choose from: {sorted(MODEL_FILENAMES)}")

    weights_dir = Path(model_dir) if model_dir is not None else (Path.home() / ".u2net")
    model_path = weights_dir / MODEL_FILENAMES[model_name]
    if not model_path.is_file():
        raise FileNotFoundError(f"ONNX model weights not found: {model_path}")

    use_gpu = bool(prefer_gpu) and os.environ.get("CUDA_VISIBLE_DEVICES", None) != ""
    if use_gpu:
        _preload_nvidia_cuda_libs()

    import onnxruntime as ort

    sess_opts = ort.SessionOptions()
    sess_opts.intra_op_num_threads = max(1, int(intra_op_threads))
    available = set(ort.get_available_providers())
    if use_gpu and "CUDAExecutionProvider" in available:
        # Keep peak VRAM under 6 GB (RTX 3060 class) by disabling layout-fusion arena bloat.
        graph_opt_cls = getattr(ort, "GraphOptimizationLevel", None)
        if graph_opt_cls is not None and hasattr(graph_opt_cls, "ORT_ENABLE_BASIC"):
            sess_opts.graph_optimization_level = graph_opt_cls.ORT_ENABLE_BASIC
        sess_opts.enable_mem_pattern = False
        sess_opts.enable_mem_reuse = False
        providers: list[Any] = [
            (
                "CUDAExecutionProvider",
                {
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "DEFAULT",
                    "cudnn_conv_use_max_workspace": "0",
                },
            ),
            "CPUExecutionProvider",
        ]
    else:
        providers = ["CPUExecutionProvider"]
    session = ort.InferenceSession(
        str(model_path),
        sess_options=sess_opts,
        providers=providers,
    )
    input_name = session.get_inputs()[0].name
    output_names = [o.name for o in session.get_outputs()]
    target_out = "output_image" if "output_image" in output_names else output_names[0]
    return session, input_name, target_out


def infer_raw_alpha_with_session(
    rgb_image: Image.Image,
    session: Any,
    input_name: str,
    target_out: str,
) -> np.ndarray:
    """Run alpha matte inference using an existing ONNX Runtime session."""
    orig_w, orig_h = rgb_image.size
    resized = rgb_image.convert("RGB").resize(
        (_MODEL_INPUT_SIZE, _MODEL_INPUT_SIZE),
        Image.Resampling.BILINEAR,
    )
    arr = np.asarray(resized, dtype=np.float32) / 255.0
    arr = (arr - _IMAGENET_MEAN) / _IMAGENET_STD
    tensor = np.transpose(arr, (2, 0, 1))[np.newaxis, ...].astype(np.float32)

    raw_out = session.run([target_out], {input_name: tensor})[0]
    mask = np.squeeze(raw_out).astype(np.float32)

    if float(mask.min()) < 0.0 or float(mask.max()) > 1.0:
        mask = 1.0 / (1.0 + np.exp(-np.clip(mask, -40.0, 40.0)))
    mask = np.clip(mask, 0.0, 1.0)

    mask_img = Image.fromarray(mask, mode="F").resize((orig_w, orig_h), Image.Resampling.BILINEAR)
    return np.clip(np.asarray(mask_img, dtype=np.float32), 0.0, 1.0)


def infer_raw_alpha(
    rgb_image: Image.Image,
    model_name: str = "birefnet-general-lite",
    model_dir: Path | None = None,
    intra_op_threads: int = 4,
) -> np.ndarray:
    """Run local ONNX Runtime CPU inference to obtain a float32 [0, 1] alpha matte."""
    session, input_name, target_out = create_onnx_session(
        model_name=model_name,
        model_dir=model_dir,
        intra_op_threads=intra_op_threads,
    )
    return infer_raw_alpha_with_session(rgb_image, session, input_name, target_out)


def _select_components(
    alpha: np.ndarray,
    keep_side_dishes: bool,
    target_xy: tuple[float, float] | None = None,
) -> tuple[np.ndarray, int, int]:
    """Keep the highest-scoring main dish component (center- or target-guided) and optional sides."""
    h, w = alpha.shape
    binary = alpha > 0.45
    labeled, num_features = ndimage.label(binary, structure=np.ones((3, 3), dtype=np.int32))
    if num_features <= 1:
        return alpha, int(num_features), 0

    cy_img = h / 2.0
    cx_img = w / 2.0
    norm_h = max(cy_img, 1.0)
    norm_w = max(cx_img, 1.0)
    diag = max(math.hypot(h, w), 1.0)

    comp_stats: list[tuple[int, int, float, float, float]] = []
    for comp_id in range(1, num_features + 1):
        ys, xs = np.nonzero(labeled == comp_id)
        area = int(ys.size)
        if area == 0:
            continue
        cy = float(np.mean(ys))
        cx = float(np.mean(xs))
        if target_xy is not None:
            tx, ty = float(target_xy[0]), float(target_xy[1])
            d_min = float(np.min(np.hypot(xs - tx, ys - ty)))
            d_centroid = math.hypot(cx - tx, cy - ty)
            score = (
                math.exp(-((d_min / (0.08 * diag)) ** 2))
                * (0.3 + 0.7 * math.exp(-((d_centroid / (0.25 * diag)) ** 2)))
                * (float(area) ** 0.25)
            )
        else:
            dist_center = math.hypot((cx - cx_img) / norm_w, (cy - cy_img) / norm_h)
            score = area * (0.4 + 0.6 * math.exp(-(dist_center * dist_center) / (0.45 * 0.45)))
        comp_stats.append((comp_id, area, cy, cx, score))

    if not comp_stats:
        return alpha, 0, 0

    comp_stats.sort(key=lambda item: item[4], reverse=True)
    main_id, main_area, main_cy, main_cx, _ = comp_stats[0]
    keep_ids: set[int] = {main_id}

    if keep_side_dishes:
        diag_norm = max(math.hypot(h, w) / 2.0, 1.0)
        for comp_id, area, cy, cx, _ in comp_stats[1:]:
            if area < 0.03 * main_area:
                continue
            dist_to_main = math.hypot(cx - main_cx, cy - main_cy) / diag_norm
            if cy >= (main_cy - 0.05 * h) and dist_to_main <= 0.45:
                keep_ids.add(comp_id)

    kept_binary = np.isin(labeled, list(keep_ids))
    keep_region = ndimage.binary_dilation(kept_binary, iterations=3)
    cleaned = np.where(keep_region, alpha, 0.0).astype(np.float32)
    return cleaned, len(keep_ids), len(comp_stats) - len(keep_ids)


def _strip_cast_shadows(rgb: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, int]:
    """Strip exterior cast-shadow halos while preserving solid dark bowls (alpha >= 0.85)."""
    out = alpha.copy()
    solid_core = out >= 0.85
    if not np.any(solid_core):
        # Lower-confidence foreground: derive a solid core from the upper percentile of
        # the foreground alpha distribution so halos around alpha ~0.70-0.82 bowls are
        # still peeled. Below 0.45 there is no reliable solid core, so leave the mask.
        fg_vals = out[out > 0.2]
        if fg_vals.size == 0:
            return out, 0
        core_thresh = float(np.percentile(fg_vals, 70))
        if core_thresh < 0.45:
            return out, 0
        solid_core = out >= core_thresh

    before_fg = int(np.sum(out > 0.01))

    # Step 1: Suppress soft exterior tail outside the core neighborhood & clean wisps
    near_core = ndimage.binary_dilation(solid_core, iterations=2)
    out = np.where((~near_core) & (out < 0.35), 0.0, out)

    rough_fg = out >= 0.35
    cleaned_fg = ndimage.binary_closing(
        ndimage.binary_opening(rough_fg, iterations=1),
        iterations=1,
    )
    allowed_region = ndimage.binary_dilation(cleaned_fg | solid_core, iterations=1)
    out = np.where(allowed_region, out, 0.0)

    # Step 2: Peel outer low-alpha / low-saturation halo band (1..18 px outside solid interior)
    dist_from_core = ndimage.distance_transform_edt(~solid_core)
    max_rgb = np.max(rgb, axis=-1)
    min_rgb = np.min(rgb, axis=-1)
    sat = (max_rgb - min_rgb) / (max_rgb + 1e-6)
    lum = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]

    gx = ndimage.sobel(lum, axis=1, mode="nearest")
    gy = ndimage.sobel(lum, axis=0, mode="nearest")
    grad_mag = np.hypot(gx, gy)

    outer_halo = (
        (out > 0.01)
        & (out < 0.85)
        & (~solid_core)
        & (dist_from_core >= 1.0)
        & (dist_from_core <= 18.0)
    )
    neutral_dark_halo = outer_halo & (sat < 0.20) & (lum < 0.55) & (grad_mag < 0.35)
    soft_neutral_halo = outer_halo & (out < 0.65) & (sat < 0.22) & (dist_from_core > 2.0)
    distant_soft_wisp = (out > 0.01) & (out < 0.85) & (dist_from_core > 18.0)

    strip_mask = neutral_dark_halo | soft_neutral_halo | distant_soft_wisp
    out = np.where(strip_mask, 0.0, out)

    # Keep only connected regions anchored to solid_core
    fg_mask = out > 0.01
    labeled, num_features = ndimage.label(fg_mask, structure=np.ones((3, 3), dtype=np.int32))
    if num_features > 1:
        anchored_ids = np.unique(labeled[solid_core & fg_mask])
        anchored_ids = anchored_ids[anchored_ids > 0]
        if anchored_ids.size > 0:
            out = np.where(np.isin(labeled, anchored_ids), out, 0.0)

    after_fg = int(np.sum(out > 0.01))
    return out.astype(np.float32), max(0, before_fg - after_fg)


def _decontaminate_edges(rgb: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Propagate nearest solid-interior RGB into semi-transparent edges; zero transparent RGB."""
    solid = alpha >= 0.98
    if not np.any(solid):
        fg = alpha > 0.5
        if np.any(fg):
            thresh = float(np.percentile(alpha[fg], 80))
            solid = alpha >= thresh

    rgb_out = rgb.copy()
    edge = (alpha > 0.01) & (alpha < 0.98)
    if np.any(solid) and np.any(edge):
        _, indices = ndimage.distance_transform_edt(~solid, return_indices=True)
        rgb_out[edge] = rgb[indices[0][edge], indices[1][edge]]

    transparent = alpha <= 0.01
    rgb_out[transparent] = 0.0
    alpha_out = np.where(transparent, 0.0, alpha).astype(np.float32)
    return rgb_out.astype(np.float32), alpha_out


def postprocess_mask(
    rgb_arr: np.ndarray,
    raw_alpha: np.ndarray,
    keep_main_dish: bool = True,
    keep_side_dishes: bool = False,
    strip_shadows: bool = True,
    pad_ratio: float = 0.10,
    target_size: int = 1024,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Run deterministic cutout cleanup, edge decontamination, and safe padded framing.

    Returns ``(rgba_uint8, stats)`` where ``rgba_uint8`` is an ``(S, S, 4)`` uint8 array.
    """
    rgb = _normalize_rgb(rgb_arr)
    alpha = _normalize_alpha(raw_alpha)
    h, w = alpha.shape
    if rgb.shape[:2] != (h, w):
        raise ValueError(f"RGB shape {rgb.shape[:2]} does not match alpha shape {(h, w)}")

    components_kept = 1
    components_dropped = 0
    shadow_pixels_stripped = 0

    if keep_main_dish:
        alpha, components_kept, components_dropped = _select_components(
            alpha,
            keep_side_dishes=keep_side_dishes,
        )

    if strip_shadows:
        alpha, shadow_pixels_stripped = _strip_cast_shadows(rgb, alpha)

    rgb_clean, alpha_clean = _decontaminate_edges(rgb, alpha)

    fg = alpha_clean > 0.01
    if not np.any(fg):
        out_side = max(1, min(max(h, w), int(target_size)))
        empty = np.zeros((out_side, out_side, 4), dtype=np.uint8)
        return empty, {
            "input_size": [w, h],
            "output_size": [out_side, out_side],
            "empty_mask": True,
            "components_kept": 0,
            "components_dropped": components_dropped,
            "shadow_pixels_stripped": shadow_pixels_stripped,
            "margin_ratios": {"left": 1.0, "right": 1.0, "top": 1.0, "bottom": 1.0},
        }

    ys, xs = np.nonzero(fg)
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    rgb_crop = rgb_clean[y0 : y1 + 1, x0 : x1 + 1]
    alpha_crop = alpha_clean[y0 : y1 + 1, x0 : x1 + 1]
    ch, cw = alpha_crop.shape
    longest = max(ch, cw)

    # Guarantee transparent margin >= pad_ratio of final canvas on all 4 sides
    eff_pad = min(max(float(pad_ratio), 0.0), 0.45)
    canvas_side = int(math.ceil(longest / (1.0 - 2.0 * eff_pad))) if eff_pad > 0.0 else longest
    canvas_side = max(canvas_side, longest)

    off_y = (canvas_side - ch) // 2
    off_x = (canvas_side - cw) // 2

    canvas_rgb = np.zeros((canvas_side, canvas_side, 3), dtype=np.float32)
    canvas_alpha = np.zeros((canvas_side, canvas_side), dtype=np.float32)
    canvas_rgb[off_y : off_y + ch, off_x : off_x + cw] = rgb_crop
    canvas_alpha[off_y : off_y + ch, off_x : off_x + cw] = alpha_crop

    out_side = min(canvas_side, int(target_size)) if int(target_size) > 0 else canvas_side

    if out_side != canvas_side:
        # Fill transparent RGB with nearest foreground color before Lanczos resize
        # so downsampling never blends black (0,0,0) into semi-transparent edges.
        fg_canvas = canvas_alpha > 0.01
        if np.any(fg_canvas) and not np.all(fg_canvas):
            _, idxs = ndimage.distance_transform_edt(~fg_canvas, return_indices=True)
            filled_rgb = canvas_rgb[idxs[0], idxs[1]]
        else:
            filled_rgb = canvas_rgb

        rgb_img = Image.fromarray(
            np.clip(np.round(filled_rgb * 255.0), 0, 255).astype(np.uint8),
            mode="RGB",
        ).resize((out_side, out_side), Image.Resampling.LANCZOS)
        alpha_img = Image.fromarray(canvas_alpha, mode="F").resize(
            (out_side, out_side),
            Image.Resampling.LANCZOS,
        )
        final_rgb = np.asarray(rgb_img, dtype=np.float32) / 255.0
        final_alpha = np.clip(np.asarray(alpha_img, dtype=np.float32), 0.0, 1.0)
        final_rgb, final_alpha = _decontaminate_edges(final_rgb, final_alpha)
    else:
        final_rgb = canvas_rgb
        final_alpha = canvas_alpha

    rgba_u8 = np.zeros((out_side, out_side, 4), dtype=np.uint8)
    rgba_u8[..., :3] = np.clip(np.round(final_rgb * 255.0), 0, 255).astype(np.uint8)
    rgba_u8[..., 3] = np.clip(np.round(final_alpha * 255.0), 0, 255).astype(np.uint8)

    # Measure final margins
    final_fg = rgba_u8[..., 3] > 2
    if np.any(final_fg):
        fys, fxs = np.nonzero(final_fg)
        margin_ratios = {
            "left": round(float(fxs.min()) / out_side, 4),
            "right": round(float(out_side - 1 - fxs.max()) / out_side, 4),
            "top": round(float(fys.min()) / out_side, 4),
            "bottom": round(float(out_side - 1 - fys.max()) / out_side, 4),
        }
    else:
        margin_ratios = {"left": 1.0, "right": 1.0, "top": 1.0, "bottom": 1.0}

    stats = {
        "input_size": [w, h],
        "output_size": [out_side, out_side],
        "empty_mask": False,
        "components_kept": components_kept,
        "components_dropped": components_dropped,
        "shadow_pixels_stripped": shadow_pixels_stripped,
        "bbox_before_pad": {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "width": cw, "height": ch},
        "margin_ratios": margin_ratios,
    }
    return rgba_u8, stats


def clean_inframe_rgba(
    rgb_arr: np.ndarray,
    raw_alpha: np.ndarray,
    *,
    keep_main_dish: bool = True,
    keep_side_dishes: bool = False,
    strip_shadows: bool = True,
    target_xy: tuple[float, float] | None = None,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Run cutout cleanup and edge decontamination in the original frame without cropping.

    Preserves exact camera intrinsics and principal point for multi-view SfM / 2DGS.
    Returns ``(rgba_uint8, stats)`` with shape ``(H, W, 4)``.
    """
    rgb = _normalize_rgb(rgb_arr)
    alpha = _normalize_alpha(raw_alpha)
    h, w = alpha.shape
    if rgb.shape[:2] != (h, w):
        raise ValueError(f"RGB shape {rgb.shape[:2]} does not match alpha shape {(h, w)}")

    components_kept = 1
    components_dropped = 0
    shadow_pixels_stripped = 0

    if keep_main_dish:
        alpha, components_kept, components_dropped = _select_components(
            alpha,
            keep_side_dishes=keep_side_dishes,
            target_xy=target_xy,
        )

    if strip_shadows:
        alpha, shadow_pixels_stripped = _strip_cast_shadows(rgb, alpha)

    rgb_clean, alpha_clean = _decontaminate_edges(rgb, alpha)
    rgba_u8 = np.zeros((h, w, 4), dtype=np.uint8)
    rgba_u8[..., :3] = np.clip(np.rint(rgb_clean * 255.0), 0, 255).astype(np.uint8)
    rgba_u8[..., 3] = np.clip(np.rint(alpha_clean * 255.0), 0, 255).astype(np.uint8)
    rgba_u8[rgba_u8[..., 3] == 0, :3] = 0

    fg = rgba_u8[..., 3] > 127
    stats = {
        "input_size": [w, h],
        "output_size": [w, h],
        "empty_mask": not bool(np.any(fg)),
        "fg_fraction": round(float(np.mean(fg)), 5),
        "components_kept": int(components_kept),
        "components_dropped": int(components_dropped),
        "shadow_pixels_stripped": int(shadow_pixels_stripped),
    }
    return rgba_u8, stats


def fuse_cutout_alphas(birefnet_alpha: np.ndarray, existing_alpha: np.ndarray) -> np.ndarray:
    """Fuse local BiRefNet alpha with solid upstream cutout regions (e.g., white bowls).

    Only solid upstream foreground (>= 0.85) plus an immediate 1 px anti-aliased rim (>= 0.35)
    are promoted, leaving exterior low-alpha cast-shadow halos to be stripped normally.
    """
    bi = _normalize_alpha(birefnet_alpha)
    ex = _normalize_alpha(existing_alpha)
    if ex.shape != bi.shape:
        ex_img = Image.fromarray(ex, mode="F").resize((bi.shape[1], bi.shape[0]), Image.Resampling.BILINEAR)
        ex = np.clip(np.asarray(ex_img, dtype=np.float32), 0.0, 1.0)
    existing_solid = ex >= 0.85
    existing_rim = ndimage.binary_dilation(existing_solid, iterations=1) & (ex >= 0.35)
    return np.where(existing_solid | existing_rim, np.maximum(bi, ex), bi).astype(np.float32)


def clean_cutout_file(
    input_path: str | Path,
    output_path: str | Path,
    *,
    model_name: str = "birefnet-general-lite",
    existing_cutout_path: str | Path | None = None,
    keep_main_dish: bool = True,
    keep_side_dishes: bool = False,
    strip_shadows: bool = True,
    pad_ratio: float = 0.10,
    target_size: int = 1024,
    report_path: str | Path | None = None,
) -> dict[str, Any]:
    """Run end-to-end local ONNX cutout extraction, cleanup, and save RGBA PNG."""
    in_p = Path(input_path)
    out_p = Path(output_path)

    with Image.open(in_p) as im:
        rgb_img = im.convert("RGB")
        rgb_arr = np.asarray(rgb_img, dtype=np.uint8)
        raw_alpha = infer_raw_alpha(rgb_img, model_name=model_name)

    used_existing_cutout = False
    existing_cutout_skipped_reason: str | None = None
    if existing_cutout_path is not None:
        ex_p = Path(existing_cutout_path)
        if ex_p.is_file():
            with Image.open(ex_p) as ex_im:
                has_alpha = "A" in ex_im.getbands()
                if not has_alpha:
                    existing_cutout_skipped_reason = (
                        f"existing cutout has no alpha channel (image mode {ex_im.mode!r}); "
                        "refusing to promote the full frame"
                    )
                else:
                    ex_rgba = np.asarray(ex_im.convert("RGBA"), dtype=np.float32) / 255.0
                    alpha_ex = ex_rgba[..., 3]
                    fully_opaque_frac = float(np.mean(alpha_ex >= 0.99))
                    non_empty_frac = float(np.mean(alpha_ex > 0.01))
                    if fully_opaque_frac > 0.99:
                        existing_cutout_skipped_reason = (
                            "existing cutout alpha is "
                            f"{fully_opaque_frac * 100.0:.2f}% fully opaque "
                            "(>99%), so it carries no matte information"
                        )
                    elif non_empty_frac < 0.005:
                        existing_cutout_skipped_reason = (
                            "existing cutout alpha is "
                            f"{non_empty_frac * 100.0:.2f}% non-empty "
                            "(<0.5%), so it is effectively empty"
                        )
                    else:
                        raw_alpha = fuse_cutout_alphas(raw_alpha, alpha_ex)
                        used_existing_cutout = True
        else:
            existing_cutout_skipped_reason = f"existing cutout path does not exist: {ex_p}"

    rgba_u8, stats = postprocess_mask(
        rgb_arr,
        raw_alpha,
        keep_main_dish=keep_main_dish,
        keep_side_dishes=keep_side_dishes,
        strip_shadows=strip_shadows,
        pad_ratio=pad_ratio,
        target_size=target_size,
    )

    out_p.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba_u8, mode="RGBA").save(out_p)

    report = {
        "publication_eligible": PUBLICATION_ELIGIBLE,
        "input_path": str(in_p),
        "output_path": str(out_p),
        "model": model_name,
        "options": {
            "existing_cutout_used": used_existing_cutout,
            "existing_cutout_skipped_reason": existing_cutout_skipped_reason,
            "keep_main_dish": keep_main_dish,
            "keep_side_dishes": keep_side_dishes,
            "strip_shadows": strip_shadows,
            "pad_ratio": pad_ratio,
            "target_size": target_size,
        },
        "stats": stats,
    }

    if report_path is not None:
        rep_p = Path(report_path)
        rep_p.parent.mkdir(parents=True, exist_ok=True)
        rep_p.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    return report


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Food3D V1 Stage 1: Clean dish cutout via local ONNX + mask post-processing.",
    )
    parser.add_argument("input_image", help="Path to input dish photo.")
    parser.add_argument("output_rgba", help="Path to output clean RGBA PNG.")
    parser.add_argument(
        "--model",
        choices=sorted(MODEL_FILENAMES.keys()),
        default="birefnet-general-lite",
        help="Local ONNX segmentation model in ~/.u2net/ (default: birefnet-general-lite).",
    )
    parser.add_argument(
        "--keep-main-dish",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Keep only the primary centered dish component (default: True).",
    )
    parser.add_argument(
        "--keep-side-dishes",
        action="store_true",
        default=False,
        help="Retain nearby lower-frame side bowls alongside the main dish.",
    )
    parser.add_argument(
        "--strip-shadows",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Strip exterior cast-shadow halo while preserving solid dark bowls (default: True).",
    )
    parser.add_argument(
        "--pad-ratio",
        type=float,
        default=0.10,
        help="Minimum transparent margin ratio on each side of the square frame (default: 0.10).",
    )
    parser.add_argument(
        "--size",
        type=int,
        default=1024,
        help="Maximum output square resolution in pixels (default: 1024).",
    )
    parser.add_argument(
        "--existing-cutout",
        dest="existing_cutout_path",
        default=None,
        help="Optional existing RGBA cutout PNG whose solid plate regions (>= 0.85 alpha) are preserved.",
    )
    parser.add_argument(
        "--report",
        dest="report_path",
        default=None,
        help="Optional JSON report output path.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    report = clean_cutout_file(
        args.input_image,
        args.output_rgba,
        model_name=args.model,
        existing_cutout_path=args.existing_cutout_path,
        keep_main_dish=args.keep_main_dish,
        keep_side_dishes=args.keep_side_dishes,
        strip_shadows=args.strip_shadows,
        pad_ratio=args.pad_ratio,
        target_size=args.size,
        report_path=args.report_path,
    )
    if not args.report_path:
        print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
