"""Food3D V1 Stage 3a: deterministic food PBR texture authoring.

Reads baked maps (basecolor, roughness, normal, ao, geom_features, uv_mask) and synthesizes:
- basecolor_delit.png (chromaticity-preserving specular de-lighting + gentle AO crevice lift)
- orm.png             (R=AO^1.15, G=spatially varying roughness, B=0 metallic)
- clearcoat.png       (R=clearcoat factor, G=clearcoat roughness, B=0)
- normal_final.png    (base normal blended with luminance micro-normal via exact RNM)
- pbr_masks_debug.png (2x2 visual debug composite)

Every output report carries publication_eligible: false.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def srgb_to_linear(arr: np.ndarray) -> np.ndarray:
    """Convert sRGB [0, 1] array to linear light [0, 1]."""
    x = np.clip(arr.astype(np.float32), 0.0, 1.0)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(arr: np.ndarray) -> np.ndarray:
    """Convert linear light [0, 1] array to sRGB [0, 1]."""
    x = np.clip(arr.astype(np.float32), 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * (x ** (1.0 / 2.4)) - 0.055).astype(np.float32)


def _linear_rgb_to_lab(rgb_lin: np.ndarray) -> np.ndarray:
    """Convert linear sRGB (..., 3) to CIE Lab (D65) for Delta E76 diagnostics."""
    r = rgb_lin[..., 0]
    g = rgb_lin[..., 1]
    b = rgb_lin[..., 2]
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.00000
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0

    def _f(t: np.ndarray) -> np.ndarray:
        return np.where(t > eps, np.cbrt(np.maximum(t, 0.0)), (kappa * t + 16.0) / 116.0)

    fx, fy, fz = _f(x), _f(y), _f(z)
    l_star = 116.0 * fy - 16.0
    a_star = 500.0 * (fx - fy)
    b_star = 200.0 * (fy - fz)
    return np.stack([l_star, a_star, b_star], axis=-1).astype(np.float32)


def _masked_gaussian(arr: np.ndarray, valid_mask: np.ndarray, sigma: float) -> np.ndarray:
    """Normalized Gaussian blur restricted to valid UV texels."""
    vm = valid_mask.astype(np.float32)
    denom = ndimage.gaussian_filter(vm, sigma=sigma)
    num = ndimage.gaussian_filter(arr.astype(np.float32) * vm, sigma=sigma)
    return np.where(denom > 1e-6, num / np.maximum(denom, 1e-6), arr).astype(np.float32)


def dilate_uv_gutters(arr: np.ndarray, valid_mask: np.ndarray, max_dist: int = 16) -> np.ndarray:
    """Fill UV gutter pixels within max_dist of valid UV texels using EDT nearest-neighbor."""
    mask = np.asarray(valid_mask, dtype=bool)
    out = np.array(arr, copy=True)
    if mask.all() or not mask.any() or max_dist <= 0:
        return out

    distances, indices = ndimage.distance_transform_edt(~mask, return_indices=True)
    fill = (~mask) & (distances <= max_dist)
    if not fill.any():
        return out

    nearest_y = indices[0][fill]
    nearest_x = indices[1][fill]
    out[fill] = arr[nearest_y, nearest_x]
    return out


def delight_albedo(
    albedo_rgb: np.ndarray,
    ao: np.ndarray,
    valid_mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Attenuate localized specular hotspots preserving chromaticity and gently lift AO crevices.

    Args:
        albedo_rgb: sRGB float32 array in [0, 1] of shape (H, W, 3).
        ao: Ambient occlusion float32 array in [0, 1] of shape (H, W).
        valid_mask: Boolean UV island mask of shape (H, W).

    Returns:
        (albedo_delit_srgb, highlight_cue, delight_mean_delta_e)
    """
    vm = np.asarray(valid_mask, dtype=bool)
    srgb = np.clip(albedo_rgb.astype(np.float32), 0.0, 1.0)
    lin = srgb_to_linear(srgb)

    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)
    cmax = np.max(srgb, axis=-1)
    cmin = np.min(srgb, axis=-1)
    sat = np.where(cmax > 1e-6, (cmax - cmin) / np.maximum(cmax, 1e-6), 0.0).astype(np.float32)

    lum_local = _masked_gaussian(lum, vm, sigma=9.0 * max(1.0, srgb.shape[0] / 1024.0))
    residual = lum - lum_local

    # Specular hotspot gates: L > 0.78, S < 0.24, local residual > 0.08.
    l_gate = np.clip((lum - 0.78) / 0.14, 0.0, 1.0)
    s_gate = np.clip((0.24 - sat) / 0.14, 0.0, 1.0)
    r_gate = np.clip((residual - 0.08) / 0.10, 0.0, 1.0)
    highlight_cue = (l_gate * s_gate * r_gate * vm.astype(np.float32)).astype(np.float32)

    # Attenuate excess highlight luminance only, preserving RGB chromaticity ratios.
    excess = np.maximum(residual, 0.0) * highlight_cue
    target_lum = np.maximum(lum - 0.70 * excess, 0.62 * lum)
    scale = np.where(lum > 1e-6, target_lum / np.maximum(lum, 1e-6), 1.0).astype(np.float32)
    lin_delit = lin * scale[..., None]

    # Gentle AO-correlated crevice lift to prevent double-darkening; skip dark vessel regions (lum < 0.15).
    ao_clipped = np.clip(ao.astype(np.float32), 0.35, 1.0)
    lift_factor = np.clip(1.0 / (1.0 - 0.35 * (1.0 - ao_clipped)), 1.0, 1.30)
    lift_factor = np.where(vm & (lum >= 0.15), lift_factor, 1.0).astype(np.float32)
    lin_delit = np.clip(lin_delit * lift_factor[..., None], 0.0, 1.0)

    delit_srgb = linear_to_srgb(lin_delit)

    if vm.any():
        lab_before = _linear_rgb_to_lab(lin[vm])
        lab_after = _linear_rgb_to_lab(lin_delit[vm])
        delta_e = float(np.mean(np.linalg.norm(lab_before - lab_after, axis=-1)))
    else:
        delta_e = 0.0

    return delit_srgb, highlight_cue, round(delta_e, 4)


def cap_mask_fraction_over_half(
    mask: np.ndarray,
    valid_mask: np.ndarray,
    cap: float | None,
) -> np.ndarray:
    """Return a copy of a soft mask bounded so at most `cap` of valid texels stay >= 0.5.

    Deterministic: texels above the (1 - cap) quantile keep their value, the rest are
    scaled below 0.5, with a stable top-k fallback for exact 1.0 ties. A `cap` >= 1.0
    or None leaves the mask untouched.
    """
    out = np.array(mask, dtype=np.float32, copy=True)
    if cap is None:
        return out
    cap = float(np.clip(cap, 0.0, 1.0))
    if cap >= 1.0:
        return out

    vm = np.asarray(valid_mask, dtype=bool)
    if not vm.any() or cap <= 0.0:
        out[:] = 0.0
        return out

    vals_sel = out[vm]
    if float(np.mean(vals_sel >= 0.5)) <= cap:
        return out

    q = float(np.quantile(vals_sel, 1.0 - cap))
    if q >= 0.5:
        scale = 0.48 / max(q, 1e-6)
        out = np.where(out > q, out, out * scale).astype(np.float32)
    if float(np.mean(out[vm] >= 0.5)) > cap:
        flat_idx = np.flatnonzero(vm)
        vals = out.ravel()[flat_idx]
        keep_n = int(np.floor(cap * len(flat_idx)))
        if keep_n <= 0:
            out[:] = 0.0
        else:
            order = np.argsort(vals, kind='stable')
            drop_idx = flat_idx[order[: len(flat_idx) - keep_n]]
            flat = out.ravel()
            flat[drop_idx] = np.minimum(flat[drop_idx], 0.48)
            out = flat.reshape(out.shape)
    return out


def apply_wet_cap(
    masks: dict[str, np.ndarray],
    valid_mask: np.ndarray,
    wet_cap: float | None,
) -> dict[str, np.ndarray]:
    """Enforce an upper bound on the fraction of valid UV texels marked wet (>= 0.5)."""
    if wet_cap is None:
        return masks
    cap = float(np.clip(wet_cap, 0.0, 1.0))
    if cap >= 1.0:
        return masks

    vm = np.asarray(valid_mask, dtype=bool)
    vm_f = vm.astype(np.float32)
    vessel = masks['vessel_mask']
    dry = masks['dry_mask']
    liquid = masks['liquid_mask']
    wet = cap_mask_fraction_over_half(masks['wet_mask'], vm, cap)

    moist = np.clip(1.0 - vessel - dry - wet, 0.0, 1.0) * vm_f
    return {
        'vessel_mask': vessel.astype(np.float32),
        'dry_mask': dry.astype(np.float32),
        'wet_mask': wet.astype(np.float32),
        'liquid_mask': np.minimum(liquid, wet).astype(np.float32),
        'moist_mask': moist.astype(np.float32),
    }


def compute_food_masks(
    albedo_delit: np.ndarray,
    geom_features: np.ndarray,
    ao: np.ndarray,
    highlight_cue: np.ndarray,
    valid_mask: np.ndarray,
    *,
    wet_cap: float | None = None,
) -> dict[str, np.ndarray]:
    """Compute soft surface-type masks (vessel, dry, wet, liquid, moist) in [0, 1]."""
    del ao  # Reserved for future crevice-aware masking; kept in signature per contract.
    vm = np.asarray(valid_mask, dtype=bool)
    vm_f = vm.astype(np.float32)

    srgb = np.clip(albedo_delit.astype(np.float32), 0.0, 1.0)
    lin = srgb_to_linear(srgb)
    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)

    cmax = np.max(srgb, axis=-1)
    cmin = np.min(srgb, axis=-1)
    sat = np.where(cmax > 1e-6, (cmax - cmin) / np.maximum(cmax, 1e-6), 0.0).astype(np.float32)

    height_norm = np.clip(geom_features[..., 0].astype(np.float32), 0.0, 1.0)
    radius_norm = np.clip(geom_features[..., 1].astype(np.float32), 0.0, 1.0)
    normal_z = np.clip(geom_features[..., 2].astype(np.float32), 0.0, 1.0)

    # Scale spatial windows with resolution so 2048px and 1024px maps classify identically.
    res_scale = max(1.0, srgb.shape[0] / 1024.0)
    std_win = max(5, int(round(7 * res_scale)) | 1)
    lap_win = max(3, int(round(5 * res_scale)) | 1)
    mask_sigma = 1.5 * res_scale

    # Local luminance standard deviation, relative contrast, and Laplacian micro-detail energy.
    lum_dilated = dilate_uv_gutters(lum, vm, max_dist=max(8, int(round(8 * res_scale))))
    mean_l = ndimage.uniform_filter(lum_dilated, size=std_win)
    mean_l2 = ndimage.uniform_filter(lum_dilated * lum_dilated, size=std_win)
    local_std = np.sqrt(np.maximum(mean_l2 - mean_l * mean_l, 0.0)).astype(np.float32)
    rel_std = (local_std / np.maximum(mean_l, 0.06)).astype(np.float32)
    lap_energy = ndimage.uniform_filter(np.abs(ndimage.laplace(lum_dilated)), size=lap_win).astype(np.float32)
    rel_lap = (lap_energy / np.maximum(mean_l, 0.06)).astype(np.float32)

    # 1. Vessel mask: neutral/bright ceramic outer rim or smooth underside (not browned crust rim).
    neutral_rim = np.maximum(
        np.clip((0.32 - sat) / 0.12, 0.0, 1.0),
        np.clip((lum - 0.55) / 0.15, 0.0, 1.0),
    )
    outer_rim = np.clip((radius_norm - 0.74) / 0.08, 0.0, 1.0) * neutral_rim
    underside = np.clip((0.38 - normal_z) / 0.08, 0.0, 1.0)
    smooth_vessel = np.clip((0.055 - local_std) / 0.018, 0.0, 1.0)
    vessel_raw = np.maximum(outer_rim, underside) * smooth_vessel

    food_interior = np.clip(1.0 - vessel_raw, 0.0, 1.0)

    # 2. Dry mask: food interior with absolute or relative micro-texture detail and low highlight cue.
    std_detail = np.maximum(
        np.clip((local_std - 0.025) / 0.035, 0.0, 1.0),
        np.clip((rel_std - 0.10) / 0.12, 0.0, 1.0),
    )
    lap_detail = np.maximum(
        np.clip((lap_energy - 0.018) / 0.030, 0.0, 1.0),
        np.clip((rel_lap - 0.05) / 0.08, 0.0, 1.0),
    )
    detail_score = np.maximum(std_detail, lap_detail)
    low_hl = np.clip(1.0 - 2.0 * highlight_cue, 0.0, 1.0)
    dry_raw = food_interior * detail_score * low_hl

    # 3. Wet mask: recessed flat broth, specular sheen cue, or bright saturated smooth glaze.
    # Requires colour/luminance/specular evidence and low relative contrast so dark matte
    # multi-view surfaces (e.g. baked cheese and crust) are not misclassified as wet plastic.
    liquid_h = np.clip((0.38 - height_norm) / 0.08, 0.0, 1.0)
    liquid_nz = np.clip((normal_z - 0.84) / 0.08, 0.0, 1.0)
    liquid_smooth = (
        np.clip((0.025 - local_std) / 0.010, 0.0, 1.0)
        * np.clip((0.14 - rel_std) / 0.06, 0.0, 1.0)
    )
    liquid_raw = food_interior * liquid_h * liquid_nz * liquid_smooth

    spec_local = np.clip(((lum_dilated - mean_l) - 0.012) / 0.025, 0.0, 1.0)
    hl_wet = np.maximum(
        np.clip(highlight_cue * 1.4, 0.0, 1.0),
        spec_local * np.clip((lum - 0.18) / 0.15, 0.0, 1.0),
    )
    glaze_wet = (
        np.clip((sat - 0.45) / 0.20, 0.0, 1.0)
        * np.clip((lum - 0.18) / 0.12, 0.0, 1.0)
        * np.clip((0.016 - local_std) / 0.008, 0.0, 1.0)
        * np.clip((0.09 - rel_std) / 0.04, 0.0, 1.0)
        * np.clip((normal_z - 0.60) / 0.15, 0.0, 1.0)
        * 0.70
    )
    wet_raw = food_interior * np.maximum(liquid_raw, np.maximum(hl_wet, glaze_wet)) * (1.0 - 0.9 * dry_raw)

    # Smooth masks gently inside valid UV area.
    vessel_mask = np.clip(_masked_gaussian(vessel_raw, vm, sigma=mask_sigma), 0.0, 1.0) * vm_f
    dry_mask = np.clip(_masked_gaussian(dry_raw, vm, sigma=mask_sigma), 0.0, 1.0) * vm_f
    liquid_mask = np.clip(_masked_gaussian(liquid_raw, vm, sigma=mask_sigma), 0.0, 1.0) * vm_f
    wet_mask = np.clip(_masked_gaussian(wet_raw, vm, sigma=mask_sigma), 0.0, 1.0) * vm_f

    # Enforce mutual priority cleanly on strong dry vs wet overlap.
    wet_mask = np.where(dry_mask > 0.5, wet_mask * (1.0 - dry_mask), wet_mask)
    moist_mask = np.clip(1.0 - vessel_mask - dry_mask - wet_mask, 0.0, 1.0) * vm_f

    masks = {
        'vessel_mask': vessel_mask.astype(np.float32),
        'dry_mask': dry_mask.astype(np.float32),
        'wet_mask': wet_mask.astype(np.float32),
        'liquid_mask': liquid_mask.astype(np.float32),
        'moist_mask': moist_mask.astype(np.float32),
    }
    return apply_wet_cap(masks, vm, wet_cap)


def _srgb_hue(albedo_srgb: np.ndarray) -> np.ndarray:
    """Return HSV hue in [0, 1) for an sRGB float array in [0, 1] (0 = red)."""
    r = albedo_srgb[..., 0]
    g = albedo_srgb[..., 1]
    b = albedo_srgb[..., 2]
    cmax = np.maximum(np.maximum(r, g), b)
    cmin = np.minimum(np.minimum(r, g), b)
    den = np.maximum(cmax - cmin, 1e-6)
    hue = np.zeros_like(r, dtype=np.float32)
    m = cmax == r
    hue[m] = ((g - b) / den)[m] % 6.0
    m = (cmax == g) & (cmax != r)
    hue[m] = ((b - r) / den)[m] + 2.0
    m = (cmax == b) & (cmax != r) & (cmax != g)
    hue[m] = ((r - g) / den)[m] + 4.0
    return (hue / 6.0).astype(np.float32)


def compute_wet_oil_mask(
    albedo_delit: np.ndarray,
    masks: dict[str, np.ndarray],
    valid_mask: np.ndarray,
    highlight_cue: np.ndarray | None = None,
    specular_gloss: np.ndarray | None = None,
    normal_z_map: np.ndarray | None = None,
    *,
    cheese_blue_red_lo: float = 0.55,
    cheese_blue_red_ramp: float = 0.18,
    cheese_lum_lo: float = 0.18,
    cheese_lum_ramp: float = 0.18,
    grease_sat_lo: float = 0.42,
    grease_sat_ramp: float = 0.18,
    grease_lum_lo: float = 0.14,
    grease_lum_ramp: float = 0.16,
    grease_hue_center: float = 0.065,
    grease_hue_halfwidth: float = 0.075,
    top_face_lo: float = 0.35,
    top_face_ramp: float = 0.25,
    smooth_sigma_scale: float = 2.0,
) -> np.ndarray:
    """Per-texel wet/oily film mask in [0, 1] from de-lit albedo colour cues plus geometry.

    Evidence is the maximum of three physically-grounded cues inside upward-facing food:
    (a) pale mozzarella (high blue/red ratio, moderate luminance), (b) saturated orange
    grease (hue around orange, mid luminance), and (c) specular sheen already captured in
    the baked albedo (`highlight_cue`). A per-texel view-angle brightness-variance map may
    be supplied to add texels that are glossy across training views.

    Unlike the v3 `wet_mask`, this mask is gated on colour evidence inside upward-facing
    non-vessel food, so dark matte crust cannot be swept in by a global smoothness prior.
    """
    vm = np.asarray(valid_mask, dtype=bool)
    vm_f = vm.astype(np.float32)
    srgb = np.clip(albedo_delit.astype(np.float32), 0.0, 1.0)
    lin = srgb_to_linear(srgb)
    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)
    cmax = np.max(srgb, axis=-1)
    cmin = np.min(srgb, axis=-1)
    sat = np.where(cmax > 1e-6, (cmax - cmin) / np.maximum(cmax, 1e-6), 0.0).astype(np.float32)
    blue_red = (srgb[..., 2] / np.maximum(srgb[..., 0], 1e-3)).astype(np.float32)

    cheese = (
        np.clip((blue_red - cheese_blue_red_lo) / max(cheese_blue_red_ramp, 1e-6), 0.0, 1.0)
        * np.clip((lum - cheese_lum_lo) / max(cheese_lum_ramp, 1e-6), 0.0, 1.0)
    )

    hue = _srgb_hue(srgb)
    hue_orange = np.clip(1.0 - np.abs(hue - grease_hue_center) / max(grease_hue_halfwidth, 1e-6), 0.0, 1.0)
    grease = (
        np.clip((sat - grease_sat_lo) / max(grease_sat_ramp, 1e-6), 0.0, 1.0)
        * np.clip((lum - grease_lum_lo) / max(grease_lum_ramp, 1e-6), 0.0, 1.0)
        * hue_orange
    )

    evidence = np.maximum(cheese, grease)
    if highlight_cue is not None:
        evidence = np.maximum(evidence, np.clip(highlight_cue.astype(np.float32), 0.0, 1.0))
    if specular_gloss is not None:
        sv = np.clip(specular_gloss.astype(np.float32), 0.0, 1.0)
        evidence = np.maximum(evidence, sv)

    normal_z = np.clip(
        normal_z_map.astype(np.float32) if normal_z_map is not None else np.ones_like(lum),
        0.0,
        1.0,
    )
    top_face = np.clip((normal_z - top_face_lo) / max(top_face_ramp, 1e-6), 0.0, 1.0)
    film = (1.0 - np.clip(masks['vessel_mask'], 0.0, 1.0)) * top_face

    res_scale = max(1.0, srgb.shape[0] / 1024.0)
    sigma = max(1.0, float(smooth_sigma_scale) * res_scale)
    wet_oil = _masked_gaussian(evidence * film, vm, sigma=sigma)
    return (np.clip(wet_oil, 0.0, 1.0) * vm_f).astype(np.float32)


def combine_normals_rnm(base_normal: np.ndarray, micro_normal: np.ndarray) -> np.ndarray:
    """Blend tangent-space normals via RNM with weaker detail at grazing angles."""
    n1 = base_normal.astype(np.float32)
    n2 = micro_normal.astype(np.float32)

    n1 = n1 / np.maximum(np.linalg.norm(n1, axis=-1, keepdims=True), 1e-6)
    n2 = n2 / np.maximum(np.linalg.norm(n2, axis=-1, keepdims=True), 1e-6)
    n2[..., :2] *= np.clip(n1[..., 2:3], 0.15, 1.0)

    t = n1 + np.array([0.0, 0.0, 1.0], dtype=np.float32)
    u = n2 * np.array([-1.0, -1.0, 1.0], dtype=np.float32)
    dot_tu = np.sum(t * u, axis=-1, keepdims=True)
    r = t * dot_tu - u * t[..., 2:3]

    r_norm = np.linalg.norm(r, axis=-1, keepdims=True)
    r = np.where(r_norm > 1e-6, r / np.maximum(r_norm, 1e-6), np.array([0.0, 0.0, 1.0], dtype=np.float32))
    # Leave enough room for Z to stay above 0.05 after renormalization.
    r[..., 2] = np.maximum(r[..., 2], 0.051)
    r = r / np.maximum(np.linalg.norm(r, axis=-1, keepdims=True), 1e-6)
    return r.astype(np.float32)


def _scharr_gradients(arr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Compute rotationally isotropic 3x3 Scharr derivatives (d/dcol, d/drow)."""
    kx = np.array([[-3.0, 0.0, 3.0], [-10.0, 0.0, 10.0], [-3.0, 0.0, 3.0]], dtype=np.float32) / 32.0
    ky = np.array([[-3.0, -10.0, -3.0], [0.0, 0.0, 0.0], [3.0, 10.0, 3.0]], dtype=np.float32) / 32.0
    src = arr.astype(np.float32)
    return ndimage.correlate(src, kx, mode='nearest'), ndimage.correlate(src, ky, mode='nearest')


def compute_detail_height_and_cavity(
    albedo_delit: np.ndarray,
    masks: dict[str, np.ndarray],
    valid_mask: np.ndarray,
    *,
    cavity_strength: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Derive frequency-split detail gradients and crevice cavity factor from de-lit albedo.

    Uses perceptual luminance sqrt(L) and masked Gaussian band splits so UV gutters never
    bleed across island seams. Derivatives are scaled by H / 2048 for LOD parity.
    """
    vm = np.asarray(valid_mask, dtype=bool)
    s = max(0.5, albedo_delit.shape[0] / 2048.0)

    lin = srgb_to_linear(np.clip(albedo_delit.astype(np.float32), 0.0, 1.0))
    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)
    l_perc = np.sqrt(np.maximum(lum, 0.0)).astype(np.float32)

    l_macro = _masked_gaussian(l_perc, vm, sigma=18.0 * s)
    l_meso = _masked_gaussian(l_perc, vm, sigma=3.0 * s)
    l_micro = _masked_gaussian(l_perc, vm, sigma=0.9 * s)

    h_meso = (0.14 * np.tanh((l_meso - l_macro) / 0.14)).astype(np.float32)
    h_micro = (0.07 * np.tanh((l_micro - l_meso) / 0.07)).astype(np.float32)
    h_detail = (h_meso + 0.45 * h_micro).astype(np.float32)

    h_rep = dilate_uv_gutters(h_detail, vm, max_dist=max(4, int(round(6.0 * s))))
    gx, gy = _scharr_gradients(h_rep)
    gx = (gx * s).astype(np.float32)
    gy = (gy * s).astype(np.float32)

    food_w = np.clip(masks['dry_mask'] + 0.85 * masks['moist_mask'], 0.0, 1.0) * (
        1.0 - 0.90 * masks['vessel_mask']
    )
    if cavity_strength > 0.0:
        h_meso_smooth = _masked_gaussian(h_meso, vm, sigma=3.5 * s)
        valley = np.maximum(0.0, h_meso_smooth - h_meso)
        trough = np.maximum(0.0, -h_meso)
        cav_sig = np.clip(6.5 * valley + 2.5 * trough, 0.0, 1.0)
        cavity_factor = (1.0 - np.clip(float(cavity_strength) * cav_sig * food_w, 0.0, 0.75)).astype(np.float32)
    else:
        cavity_factor = np.ones_like(l_perc, dtype=np.float32)

    return gx, gy, cavity_factor, h_meso


def synthesize_pbr_maps(
    albedo_delit: np.ndarray,
    base_normal_rgb: np.ndarray,
    ao: np.ndarray,
    masks: dict[str, np.ndarray],
    valid_mask: np.ndarray,
    *,
    micro_normal_strength: float = 0.65,
    detail_normal_strength: float = 0.0,
    cavity_strength: float = 0.0,
    wet_oil_mask: np.ndarray | None = None,
    oil_roughness_min: float = 0.25,
    oil_roughness_max: float = 0.40,
    oil_roughness_mid: float = 0.50,
    oil_roughness_span: float = 0.15,
    oil_clearcoat_max: float = 0.15,
    oil_clearcoat_roughness: float = 0.12,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, float]]:
    """Synthesize ORM, Clearcoat, and RNM Normal maps (float32 in [0, 1]) plus summary metrics."""
    vm = np.asarray(valid_mask, dtype=bool)
    wet = masks['wet_mask']
    dry = masks['dry_mask']
    vessel = masks['vessel_mask']
    liquid = masks['liquid_mask']
    moist = masks['moist_mask']

    res_scale = max(1.0, albedo_delit.shape[0] / 1024.0)
    lin = srgb_to_linear(np.clip(albedo_delit.astype(np.float32), 0.0, 1.0))
    lum = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)
    lum_dilated = dilate_uv_gutters(lum, vm, max_dist=max(8, int(round(8 * res_scale))))
    hf_var = np.clip(lum_dilated - ndimage.gaussian_filter(lum_dilated, sigma=3.0 * res_scale), -0.15, 0.15)

    detail_gx = detail_gy = cavity_factor = None
    if detail_normal_strength > 0.0 or cavity_strength > 0.0:
        detail_gx, detail_gy, cavity_factor, _ = compute_detail_height_and_cavity(
            albedo_delit,
            masks,
            vm,
            cavity_strength=cavity_strength,
        )

    # Spatially varying roughness across wet, vessel, moist, dry + subtle organic variation + crevice occlusion.
    w_sum = np.maximum(wet + vessel + moist + dry, 1e-6)
    r_wet = np.clip(0.20 - 0.06 * liquid + 0.25 * hf_var, 0.14, 0.28)
    r_vessel = np.clip(0.30 + 0.20 * hf_var, 0.24, 0.38)
    r_moist = np.clip(0.50 + 0.30 * hf_var, 0.42, 0.58)
    r_dry = np.clip(0.80 + 0.35 * hf_var, 0.70, 0.90)

    roughness = (wet * r_wet + vessel * r_vessel + moist * r_moist + dry * r_dry) / w_sum
    ao_clean = np.clip(ao.astype(np.float32), 0.0, 1.0)
    if cavity_factor is not None and cavity_strength > 0.0:
        ao_clean = np.clip(ao_clean * cavity_factor, 0.0, 1.0).astype(np.float32)
    roughness = np.clip(roughness + 0.10 * (1.0 - ao_clean), 0.08, 0.96).astype(np.float32)

    # Optional wet/oily film: lower roughness toward 0.25-0.40 and add a mask-limited clearcoat.
    oil = None
    if wet_oil_mask is not None:
        oil = (np.clip(wet_oil_mask.astype(np.float32), 0.0, 1.0) * vm.astype(np.float32)).astype(np.float32)
        oil_rough = np.clip(
            float(oil_roughness_mid) - float(oil_roughness_span) * oil + 0.06 * hf_var,
            float(oil_roughness_min),
            float(oil_roughness_max),
        ).astype(np.float32)
        roughness = np.clip(roughness * (1.0 - oil) + oil_rough * oil, 0.08, 0.96).astype(np.float32)

    # ORM: R=clip(ao^1.15, ao_floor, 1.0), G=roughness, B=0 (strictly non-metallic).
    ao_floor = 0.15 if cavity_strength > 0.0 else 0.25
    ao_out = np.clip(ao_clean ** 1.15, ao_floor, 1.0).astype(np.float32)
    metallic = np.zeros_like(roughness, dtype=np.float32)
    orm = np.stack([ao_out, roughness, metallic], axis=-1)

    # Clearcoat: R=factor (0.65..0.85 wet, 0.22..0.35 vessel, strictly 0.0 on dry), G=roughness, B=0.
    coat_wet = np.clip(0.68 + 0.16 * liquid, 0.65, 0.85) * wet
    coat_vessel = 0.28 * vessel
    coat_factor = np.clip(coat_wet + coat_vessel, 0.0, 0.85)
    # Suppress clearcoat on dry regions and enforce strict 0.0 where dry dominates.
    coat_factor = np.where(dry >= 0.45, 0.0, coat_factor * np.clip(1.0 - dry, 0.0, 1.0)).astype(np.float32)

    coat_r_wet = np.clip(0.16 - 0.06 * liquid, 0.10, 0.18)
    coat_r_vessel = 0.10
    coat_r_else = 0.50
    other_w = np.clip(1.0 - wet - vessel, 0.0, 1.0)
    coat_rough = (wet * coat_r_wet + vessel * coat_r_vessel + other_w * coat_r_else) / np.maximum(
        wet + vessel + other_w, 1e-6
    )
    coat_rough = np.where(dry >= 0.45, 0.50, coat_rough).astype(np.float32)
    if oil is not None:
        coat_oil = (np.clip(float(oil_clearcoat_max) * oil, 0.0, 1.0)).astype(np.float32)
        coat_factor = np.clip(coat_factor + coat_oil * (1.0 - coat_factor), 0.0, 0.85).astype(np.float32)
        coat_rough = (coat_rough * (1.0 - oil) + float(oil_clearcoat_roughness) * oil).astype(np.float32)
    clearcoat = np.stack([coat_factor, coat_rough, np.zeros_like(coat_factor)], axis=-1)

    # RNM micro-normal derived from de-lit luminance Sobel gradients.
    gx = ndimage.sobel(lum_dilated, axis=1).astype(np.float32)
    gy = ndimage.sobel(lum_dilated, axis=0).astype(np.float32)
    micro_weight = (
        (0.75 * dry + 0.35 * moist)
        * (1.0 - 0.95 * vessel)
        * (1.0 - 0.85 * liquid)
    ).astype(np.float32)
    strength = float(micro_normal_strength) * micro_weight
    micro_n = np.stack([-gx * strength, gy * strength, np.ones_like(gx)], axis=-1)
    micro_n = micro_n / np.maximum(np.linalg.norm(micro_n, axis=-1, keepdims=True), 1e-6)

    base_n = np.clip(base_normal_rgb.astype(np.float32), 0.0, 1.0) * 2.0 - 1.0
    final_n = combine_normals_rnm(base_n, micro_n)
    if detail_gx is not None and detail_gy is not None and detail_normal_strength > 0.0:
        detail_weight = (
            np.clip(dry + 0.85 * moist, 0.0, 1.0)
            * (1.0 - 0.90 * vessel)
            * (1.0 - 0.85 * liquid)
        ).astype(np.float32)
        d_str = float(detail_normal_strength) * detail_weight
        detail_n = np.stack([-detail_gx * d_str, detail_gy * d_str, np.ones_like(detail_gx)], axis=-1)
        detail_n = detail_n / np.maximum(np.linalg.norm(detail_n, axis=-1, keepdims=True), 1e-6)
        final_n = combine_normals_rnm(final_n, detail_n)
    normal_final = np.clip(final_n * 0.5 + 0.5, 0.0, 1.0).astype(np.float32)

    # Summary statistics over valid UV texels.
    if vm.any():
        r_valid = roughness[vm]
        wet_sel = vm & (wet >= 0.5)
        dry_sel = vm & (dry >= 0.5)
        vessel_sel = vm & (vessel >= 0.5)
        stats = {
            'metallic_max': float(np.max(metallic[vm])),
            'roughness_mean': round(float(np.mean(r_valid)), 4),
            'roughness_std': round(float(np.std(r_valid)), 4),
            'roughness_p10': round(float(np.percentile(r_valid, 10)), 4),
            'roughness_p90': round(float(np.percentile(r_valid, 90)), 4),
            'ao_p10': round(float(np.percentile(ao_out[vm], 10)), 4),
            'normal_xy_abs_mean': round(float(np.mean(np.abs(final_n[vm, :2]))), 4),
            'clearcoat_wet_mean': round(float(np.mean(coat_factor[wet_sel])), 4) if wet_sel.any() else 0.0,
            'clearcoat_dry_mean': round(float(np.mean(coat_factor[dry_sel])), 4) if dry_sel.any() else 0.0,
            'wet_fraction': round(float(np.mean(wet_sel[vm])), 4),
            'dry_fraction': round(float(np.mean(dry_sel[vm])), 4),
            'vessel_fraction': round(float(np.mean(vessel_sel[vm])), 4),
            'wet_oil_fraction': round(float(np.mean((oil >= 0.5)[vm])), 4) if oil is not None else 0.0,
            'wet_oil_mean': round(float(np.mean(oil[vm])), 4) if oil is not None else 0.0,
            'roughness_oil_mean': round(float(np.mean(r_valid[oil[vm] >= 0.5])), 4)
            if oil is not None and bool((oil >= 0.5)[vm].any())
            else 0.0,
            'clearcoat_max': round(float(np.max(coat_factor[vm])), 4),
            'clearcoat_oil_mean': round(float(np.mean(coat_factor[vm & (oil >= 0.5)])), 4)
            if oil is not None and bool((vm & (oil >= 0.5)).any())
            else 0.0,
        }
    else:
        stats = {
            'metallic_max': 0.0,
            'roughness_mean': 0.0,
            'roughness_std': 0.0,
            'roughness_p10': 0.0,
            'roughness_p90': 0.0,
            'ao_p10': 0.0,
            'normal_xy_abs_mean': 0.0,
            'clearcoat_wet_mean': 0.0,
            'clearcoat_dry_mean': 0.0,
            'wet_fraction': 0.0,
            'dry_fraction': 0.0,
            'vessel_fraction': 0.0,
            'wet_oil_fraction': 0.0,
            'wet_oil_mean': 0.0,
            'roughness_oil_mean': 0.0,
            'clearcoat_max': 0.0,
            'clearcoat_oil_mean': 0.0,
        }

    return orm, clearcoat, normal_final, stats


def build_debug_composite(
    albedo_delit: np.ndarray,
    masks: dict[str, np.ndarray],
    highlight_cue: np.ndarray,
    wet_oil_mask: np.ndarray | None = None,
) -> np.ndarray:
    """Create a 2x2 debug visualization: Wet=Blue, Dry=Orange, Vessel=Green, Highlight=White.

    When a wet/oily film mask is supplied, a third column adds the oil overlay (magenta)
    and its capped form, so the mask footprint is visible at a glance.
    """
    base = np.clip(albedo_delit.astype(np.float32), 0.0, 1.0)
    h, w = base.shape[:2]
    half_h, half_w = max(1, h // 2), max(1, w // 2)

    def _overlay(mask: np.ndarray, color: tuple[float, float, float]) -> np.ndarray:
        alpha = np.clip(mask[..., None] * 0.72, 0.0, 0.72)
        tint = np.array(color, dtype=np.float32)[None, None, :]
        blended = np.clip(base * (1.0 - alpha) + tint * alpha, 0.0, 1.0)
        img = Image.fromarray((blended * 255.0 + 0.5).astype(np.uint8), mode='RGB')
        return np.asarray(img.resize((half_w, half_h), Image.Resampling.BILINEAR), dtype=np.uint8)

    top = [
        _overlay(masks['wet_mask'], (0.10, 0.45, 1.00)),
        _overlay(masks['dry_mask'], (1.00, 0.50, 0.05)),
    ]
    bot = [
        _overlay(masks['vessel_mask'], (0.15, 0.85, 0.30)),
        _overlay(highlight_cue, (1.00, 1.00, 1.00)),
    ]
    if wet_oil_mask is not None:
        top.append(_overlay(wet_oil_mask, (0.95, 0.20, 0.85)))
        bot.append(_overlay((wet_oil_mask >= 0.5).astype(np.float32), (0.20, 0.95, 0.95)))
    return np.concatenate([np.concatenate(top, axis=1), np.concatenate(bot, axis=1)], axis=0)


def _load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as img:
        return np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0


def _load_gray(path: Path) -> np.ndarray:
    with Image.open(path) as img:
        return np.asarray(img.convert('L'), dtype=np.float32) / 255.0


def _save_rgb(arr: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    u8 = np.clip(arr * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)
    Image.fromarray(u8, mode='RGB').save(path, format='PNG')


def author_pbr_maps(
    maps_dir: Path,
    out_maps_dir: Path,
    report_path: Path | None = None,
    *,
    micro_normal_strength: float = 0.65,
    occlusion_strength: float = 0.85,
    wet_cap: float | None = None,
    detail_normal_strength: float = 0.0,
    cavity_strength: float = 0.0,
    wet_food: bool = False,
    wet_oil_cap: float = 0.35,
    oil_roughness_min: float = 0.25,
    oil_roughness_max: float = 0.40,
    oil_roughness_mid: float = 0.50,
    oil_roughness_span: float = 0.15,
    oil_clearcoat_max: float = 0.15,
    oil_clearcoat_roughness: float = 0.12,
    oil_albedo_removal: float = 0.18,
    specular_gloss_map: Path | None = None,
) -> dict:
    """Run full Food3D PBR authoring pipeline from baked maps directory."""
    out_maps_dir.mkdir(parents=True, exist_ok=True)

    albedo = _load_rgb(maps_dir / 'basecolor.png')
    base_normal = _load_rgb(maps_dir / 'normal.png')
    ao = _load_gray(maps_dir / 'ao.png')
    geom_features = _load_rgb(maps_dir / 'geom_features.png')
    uv_mask = _load_gray(maps_dir / 'uv_mask.png') > 0.5

    albedo_delit, highlight_cue, delta_e = delight_albedo(albedo, ao, uv_mask)
    masks = compute_food_masks(
        albedo_delit,
        geom_features,
        ao,
        highlight_cue,
        uv_mask,
        wet_cap=wet_cap,
    )

    wet_oil_mask = None
    specular_gloss = None
    if specular_gloss_map is not None and Path(specular_gloss_map).is_file():
        specular_gloss = _load_gray(Path(specular_gloss_map))
        if specular_gloss.shape[:2] != uv_mask.shape[:2]:
            raise SystemExit(
                f'--specular-gloss-map shape {specular_gloss.shape[:2]} does not match uv_mask {uv_mask.shape[:2]}'
            )
    if wet_food:
        wet_oil_mask = compute_wet_oil_mask(
            albedo_delit,
            masks,
            uv_mask,
            highlight_cue=highlight_cue,
            specular_gloss=specular_gloss,
            normal_z_map=geom_features[..., 2],
        )
        wet_oil_mask = cap_mask_fraction_over_half(wet_oil_mask, uv_mask, wet_oil_cap)
    orm, clearcoat, normal_final, stats = synthesize_pbr_maps(
        albedo_delit=albedo_delit,
        base_normal_rgb=base_normal,
        ao=ao,
        masks=masks,
        valid_mask=uv_mask,
        micro_normal_strength=micro_normal_strength,
        detail_normal_strength=detail_normal_strength,
        cavity_strength=cavity_strength,
        wet_oil_mask=wet_oil_mask,
        oil_roughness_min=oil_roughness_min,
        oil_roughness_max=oil_roughness_max,
        oil_roughness_mid=oil_roughness_mid,
        oil_roughness_span=oil_roughness_span,
        oil_clearcoat_max=oil_clearcoat_max,
        oil_clearcoat_roughness=oil_clearcoat_roughness,
    )

    oil_albedo_delta_e = 0.0
    if wet_oil_mask is not None and float(oil_albedo_removal) > 0.0:
        # The baked albedo already contains the photo highlight, so a new glossy BRDF would
        # double-count it. Remove a mask-scaled share of linear luminance (chromaticity kept)
        # so global brightness/saturation stay put while the highlight becomes view-dependent.
        scale = np.clip(1.0 - float(oil_albedo_removal) * np.clip(wet_oil_mask, 0.0, 1.0), 0.0, 1.0)
        lin_adj = np.clip(srgb_to_linear(albedo_delit) * scale[..., None], 0.0, 1.0)
        if uv_mask.any():
            lab_a = _linear_rgb_to_lab(srgb_to_linear(albedo_delit)[uv_mask])
            lab_b = _linear_rgb_to_lab(lin_adj[uv_mask])
            oil_albedo_delta_e = round(float(np.mean(np.linalg.norm(lab_a - lab_b, axis=-1))), 4)
        albedo_delit = linear_to_srgb(lin_adj)

    albedo_out = dilate_uv_gutters(albedo_delit, uv_mask, max_dist=16)
    orm_out = dilate_uv_gutters(orm, uv_mask, max_dist=16)
    clearcoat_out = dilate_uv_gutters(clearcoat, uv_mask, max_dist=16)
    normal_out = dilate_uv_gutters(normal_final, uv_mask, max_dist=16)

    # Guarantee strictly zero metallic even after dilation.
    orm_out[..., 2] = 0.0

    _save_rgb(albedo_out, out_maps_dir / 'basecolor_delit.png')
    _save_rgb(orm_out, out_maps_dir / 'orm.png')
    _save_rgb(clearcoat_out, out_maps_dir / 'clearcoat.png')
    _save_rgb(normal_out, out_maps_dir / 'normal_final.png')

    debug_img = build_debug_composite(albedo_out, masks, highlight_cue, wet_oil_mask)
    Image.fromarray(debug_img, mode='RGB').save(out_maps_dir / 'pbr_masks_debug.png', format='PNG')

    report = {
        'schema_version': 1,
        'pipeline': 'food3d-v1-stage3a-pbr',
        'publication_eligible': False,
        'maps_dir': str(maps_dir),
        'out_maps_dir': str(out_maps_dir),
        'delight_mean_delta_e': delta_e,
        'micro_normal_strength': round(float(micro_normal_strength), 4),
        'detail_normal_strength': round(float(detail_normal_strength), 4),
        'cavity_strength': round(float(cavity_strength), 4),
        'occlusion_strength': round(float(occlusion_strength), 4),
        'wet_cap': round(float(wet_cap), 4) if wet_cap is not None else None,
        'wet_food': bool(wet_food),
        'wet_oil_cap': round(float(wet_oil_cap), 4) if wet_food else None,
        'oil_roughness_min': round(float(oil_roughness_min), 4) if wet_food else None,
        'oil_roughness_max': round(float(oil_roughness_max), 4) if wet_food else None,
        'oil_roughness_mid': round(float(oil_roughness_mid), 4) if wet_food else None,
        'oil_roughness_span': round(float(oil_roughness_span), 4) if wet_food else None,
        'oil_clearcoat_max': round(float(oil_clearcoat_max), 4) if wet_food else None,
        'oil_clearcoat_roughness': round(float(oil_clearcoat_roughness), 4) if wet_food else None,
        'oil_albedo_removal': round(float(oil_albedo_removal), 4) if wet_food else None,
        'oil_albedo_delta_e': oil_albedo_delta_e if wet_food else None,
        'specular_gloss_map': str(specular_gloss_map) if specular_gloss is not None else None,
        **stats,
    }
    target_report = report_path if report_path is not None else out_maps_dir / 'pbr_report.json'
    target_report.parent.mkdir(parents=True, exist_ok=True)
    target_report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Food3D V1 PBR texture authoring.')
    parser.add_argument('maps_dir', type=Path, help='Directory containing baked PNG maps.')
    parser.add_argument('out_maps_dir', type=Path, help='Output directory for authored PBR maps.')
    parser.add_argument('--report', type=Path, default=None, help='Optional output JSON report path.')
    parser.add_argument(
        '--micro-normal-strength',
        type=float,
        default=0.65,
        help='Sobel luminance micro-normal strength (lower for real multi-view captures).',
    )
    parser.add_argument(
        '--detail-normal-strength',
        type=float,
        default=0.0,
        help='Opt-in frequency-split perceptual luminance detail normal strength (0 disables).',
    )
    parser.add_argument(
        '--cavity-strength',
        type=float,
        default=0.0,
        help='Opt-in crevice/cavity darkening strength derived from detail height (0 disables).',
    )
    parser.add_argument(
        '--occlusion-strength',
        type=float,
        default=0.85,
        help='Target glTF occlusionStrength logged alongside PBR metrics.',
    )
    parser.add_argument(
        '--wet-cap',
        type=float,
        default=None,
        help='Optional upper bound in [0, 1] on valid UV texel wet_fraction.',
    )
    parser.add_argument(
        '--wet-food',
        action='store_true',
        help='Opt-in wet/oily film pass: albedo-derived oil mask lowers roughness to 0.25-0.40 and adds a modest clearcoat.',
    )
    parser.add_argument(
        '--wet-oil-cap',
        type=float,
        default=0.35,
        help='Upper bound in [0, 1] on the fraction of valid texels the wet/oily mask may cover at >= 0.5.',
    )
    parser.add_argument('--oil-roughness-min', type=float, default=0.25)
    parser.add_argument('--oil-roughness-max', type=float, default=0.40)
    parser.add_argument('--oil-roughness-mid', type=float, default=0.50)
    parser.add_argument('--oil-roughness-span', type=float, default=0.15)
    parser.add_argument(
        '--oil-clearcoat-max',
        type=float,
        default=0.15,
        help='Peak clearcoat factor on the wettest texels (keep modest to avoid plastic gloss).',
    )
    parser.add_argument('--oil-clearcoat-roughness', type=float, default=0.12)
    parser.add_argument(
        '--oil-albedo-removal',
        type=float,
        default=0.18,
        help='Mask-scaled linear-luminance removal on the wet/oil mask so the baked photo highlight is not double-counted.',
    )
    parser.add_argument(
        '--specular-gloss-map',
        type=Path,
        default=None,
        help='Optional grayscale per-texel view-angle highlight-excursion map (glossiness cue).',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.wet_cap is not None and not (0.0 <= args.wet_cap <= 1.0):
        raise SystemExit(f'--wet-cap must be in [0, 1], got {args.wet_cap}')
    if not (0.0 <= args.occlusion_strength <= 1.0):
        raise SystemExit(f'--occlusion-strength must be in [0, 1], got {args.occlusion_strength}')
    if args.detail_normal_strength < 0.0:
        raise SystemExit(f'--detail-normal-strength must be >= 0, got {args.detail_normal_strength}')
    if not (0.0 <= args.cavity_strength <= 1.0):
        raise SystemExit(f'--cavity-strength must be in [0, 1], got {args.cavity_strength}')
    if not (0.0 <= args.wet_oil_cap <= 1.0):
        raise SystemExit(f'--wet-oil-cap must be in [0, 1], got {args.wet_oil_cap}')
    if args.oil_roughness_min < 0.0 or args.oil_roughness_max > 1.0 or args.oil_roughness_min > args.oil_roughness_max:
        raise SystemExit('--oil-roughness bounds must satisfy 0 <= min <= max <= 1')
    if not (0.0 <= args.oil_clearcoat_max <= 1.0):
        raise SystemExit(f'--oil-clearcoat-max must be in [0, 1], got {args.oil_clearcoat_max}')
    if not (0.0 <= args.oil_albedo_removal <= 0.6):
        raise SystemExit(f'--oil-albedo-removal must be in [0, 0.6], got {args.oil_albedo_removal}')
    report = author_pbr_maps(
        args.maps_dir,
        args.out_maps_dir,
        args.report,
        micro_normal_strength=args.micro_normal_strength,
        occlusion_strength=args.occlusion_strength,
        wet_cap=args.wet_cap,
        detail_normal_strength=args.detail_normal_strength,
        cavity_strength=args.cavity_strength,
        wet_food=args.wet_food,
        wet_oil_cap=args.wet_oil_cap,
        oil_roughness_min=args.oil_roughness_min,
        oil_roughness_max=args.oil_roughness_max,
        oil_roughness_mid=args.oil_roughness_mid,
        oil_roughness_span=args.oil_roughness_span,
        oil_clearcoat_max=args.oil_clearcoat_max,
        oil_clearcoat_roughness=args.oil_clearcoat_roughness,
        oil_albedo_removal=args.oil_albedo_removal,
        specular_gloss_map=args.specular_gloss_map,
    )
    print('PBR_REPORT', json.dumps(report))


if __name__ == '__main__':
    main()
