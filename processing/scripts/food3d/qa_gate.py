"""Food3D V1 Stage 4b: Automated QA Gate for PBR GLB food assets.

Executes 5 automated checks and emits qa_report.json (publication_eligible: false):
  1. glTF Validation & Budget (gltf-transform validate, byte size, triangle budget)
  2. Geometry Audit (trimesh on non-meshopt geom GLB and/or bake_report.json)
  3. PBR Material Audit (direct GLB JSON + embedded WebP/PNG texture inspection)
  4. Photo-View Fidelity across 216 poses (IoU, CIE76 Delta E, windowed SSIM, detail corr)
  5. Relighting Responsiveness (lightAz 0 deg vs 120 deg foreground diff)

CLI:
  python qa_gate.py --glb <final.glb> --cutout <clean_cutout.png> \
    --poses-dir <dir> --relit-a <png> --relit-b <png> --out <qa_report.json> \
    [--geom-glb <geom.glb>] [--bake-report <bake_report.json>] \
    [--pbr-report <pbr_report.json>] [--diag-img <fidelity_diag.png>] \
    [--max-bytes 5242880] [--max-tris 155000] [--skip-cli-validate]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

DEFAULT_GLTF_TRANSFORM = '/home/yacine105/tools/gltf-transform/node_modules/.bin/gltf-transform'
FIDELITY_FRAME = 224
GLB_MAGIC = 0x46546C67  # b'glTF'
CHUNK_JSON = 0x4E4F534A  # b'JSON'
CHUNK_BIN = 0x004E4942  # b'BIN\0'


def parse_glb_chunks(glb_path: Path) -> tuple[dict[str, Any], bytes]:
    """Read and parse the JSON and BIN chunks of a binary glTF (.glb) file."""
    data = glb_path.read_bytes()
    if len(data) < 20:
        raise ValueError(f'GLB file too short ({len(data)} bytes): {glb_path}')
    magic, version, total_len = struct.unpack_from('<III', data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f'Invalid GLB magic 0x{magic:08x}: {glb_path}')
    if version != 2:
        raise ValueError(f'Unsupported GLB version {version}: {glb_path}')

    offset = 12
    gltf_json: dict[str, Any] | None = None
    bin_chunk = b''
    limit = min(len(data), total_len)
    while offset + 8 <= limit:
        chunk_len, chunk_type = struct.unpack_from('<II', data, offset)
        offset += 8
        chunk_data = data[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == CHUNK_JSON:
            gltf_json = json.loads(chunk_data.decode('utf-8'))
        elif chunk_type == CHUNK_BIN:
            bin_chunk = chunk_data

    if gltf_json is None:
        raise ValueError(f'Missing JSON chunk in GLB: {glb_path}')
    return gltf_json, bin_chunk


def count_glb_triangles(gltf_json: dict[str, Any]) -> int:
    """Count total triangles across all mesh primitives from glTF accessor metadata."""
    accessors = gltf_json.get('accessors', [])
    total = 0
    for mesh in gltf_json.get('meshes', []):
        for prim in mesh.get('primitives', []):
            mode = prim.get('mode', 4)  # 4 = TRIANGLES
            if 'indices' in prim and prim['indices'] < len(accessors):
                count = int(accessors[prim['indices']].get('count', 0))
            else:
                pos_idx = prim.get('attributes', {}).get('POSITION')
                count = int(accessors[pos_idx].get('count', 0)) if pos_idx is not None else 0
            if mode == 4:
                total += count // 3
            elif mode in (5, 6) and count >= 3:
                total += count - 2
    return total


def check_gltf_budget(
    glb_path: Path,
    max_bytes: int = 5_242_880,
    max_tris: int = 155_000,
    skip_cli_validate: bool = False,
    gltf_transform_bin: str | None = None,
) -> dict[str, Any]:
    """Check 1: glTF validation, byte budget, and triangle budget."""
    reasons: list[str] = []
    glb_bytes = glb_path.stat().st_size
    gltf_json, _ = parse_glb_chunks(glb_path)
    triangles = count_glb_triangles(gltf_json)
    asset_extras = gltf_json.get('asset', {}).get('extras')
    if not isinstance(asset_extras, dict) or asset_extras.get('publication_eligible') is not False:
        reasons.append('GLB asset.extras.publication_eligible must be false')

    validate_ok: bool | None = None
    validate_output = ''
    if not skip_cli_validate:
        cli = gltf_transform_bin or os.environ.get('GLTF_TRANSFORM') or DEFAULT_GLTF_TRANSFORM
        command = [cli, 'validate', str(glb_path)]
        if shutil.which('systemd-run'):
            command = ['systemd-run', '--user', '--scope', '-q', '-p', 'MemoryMax=4G', *command]
        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            validate_ok = proc.returncode == 0
            validate_output = (proc.stdout + '\n' + proc.stderr).strip()
            if not validate_ok:
                reasons.append(f'gltf-transform validate failed (rc={proc.returncode})')
        except (OSError, subprocess.TimeoutExpired) as exc:
            validate_ok = False
            validate_output = str(exc)
            reasons.append(f'gltf-transform validate unavailable: {exc}')

    if glb_bytes > max_bytes:
        reasons.append(f'glb_bytes {glb_bytes} exceeds max_bytes {max_bytes}')
    if triangles <= 0:
        reasons.append('GLB contains zero triangles')
    elif triangles > max_tris:
        reasons.append(f'triangles {triangles} exceeds max_tris {max_tris}')

    status = 'FAIL' if reasons else 'PASS'
    return {
        'status': status,
        'glb_bytes': glb_bytes,
        'max_bytes': max_bytes,
        'triangles': triangles,
        'max_tris': max_tris,
        'validate_ok': validate_ok,
        'validate_output': validate_output[:1000] if validate_output else '',
        'reasons': reasons,
    }


def check_geometry(
    geom_glb: Path | None = None,
    bake_report_path: Path | None = None,
) -> dict[str, Any]:
    """Check 2: Geometry audit via trimesh on uncompressed geom GLB and/or bake_report.json."""
    reasons: list[str] = []
    warnings: list[str] = []
    result: dict[str, Any] = {
        'status': 'PASS',
        'source': [],
        'bbox_min': None,
        'bbox_max': None,
        'extents': None,
        'min_y': None,
        'seated': None,
        'shells': None,
        'faces': None,
        'reasons': reasons,
    }

    if geom_glb is not None and geom_glb.exists():
        gltf_json, _ = parse_glb_chunks(geom_glb)
        exts_used = set(gltf_json.get('extensionsUsed', [])) | set(
            gltf_json.get('extensionsRequired', [])
        )
        if 'EXT_meshopt_compression' in exts_used:
            warnings.append('Skipped trimesh on geom_glb because it uses EXT_meshopt_compression')
        else:
            import trimesh

            loaded = trimesh.load(str(geom_glb), force='mesh')
            if isinstance(loaded, trimesh.Scene):
                geoms = list(loaded.geometry.values())
                mesh = trimesh.util.concatenate(geoms) if geoms else trimesh.Trimesh()
            else:
                mesh = loaded

            faces = int(len(mesh.faces))
            result['faces'] = faces
            result['source'].append('trimesh')
            if faces <= 0:
                reasons.append('Geometry GLB has zero faces')
            else:
                bounds = mesh.bounds
                bmin = [round(float(x), 5) for x in bounds[0]]
                bmax = [round(float(x), 5) for x in bounds[1]]
                extents = [round(float(x), 5) for x in (bounds[1] - bounds[0])]
                min_y = float(bounds[0][1])
                seated = abs(min_y) < 0.02
                welded = mesh.copy()
                welded.merge_vertices(merge_tex=True, merge_norm=True)
                shells = len(welded.split(only_watertight=False))
                result.update(
                    {
                        'bbox_min': bmin,
                        'bbox_max': bmax,
                        'extents': extents,
                        'min_y': round(min_y, 5),
                        'seated': seated,
                        'shells': shells,
                    }
                )
                if any(e <= 1e-5 for e in extents):
                    reasons.append(f'Degenerate bounding box extents: {extents}')
                if not seated:
                    reasons.append(f'Mesh bottom not seated on y=0 (min_y={min_y:.4f})')

    if bake_report_path is not None and bake_report_path.exists():
        bake = json.loads(bake_report_path.read_text(encoding='utf-8'))
        result['source'].append('bake_report')
        seating = bake.get('seating', {})
        cleanup = bake.get('cleanup', {})
        if result['shells'] is None:
            if 'shells_kept' in cleanup:
                result['shells'] = cleanup['shells_kept']
            elif 'shells' in cleanup and isinstance(cleanup['shells'], list):
                result['shells'] = sum(1 for s in cleanup['shells'] if s.get('action') == 'keep')
            elif 'shell_count' in cleanup:
                result['shells'] = cleanup['shell_count']
        if result['faces'] is None and bake.get('lods'):
            result['faces'] = int(bake['lods'][0].get('faces', 0))
        min_z_val = seating.get('min_z_after', seating.get('z_min_m'))
        if result['min_y'] is None and min_z_val is not None:
            min_h = float(min_z_val)
            result['min_y'] = round(min_h, 5)
            result['seated'] = abs(min_h) < 0.02
            if not result['seated']:
                reasons.append(f'Bake report indicates unseated bottom ({min_h:.4f})')
        result['bake_diameter_cm'] = bake.get('diameter_cm')
        result['bake_calibrated'] = bake.get('calibrated')

    if not result['source']:
        warnings.append('Neither uncompressed --geom-glb nor --bake-report provided')

    if reasons:
        result['status'] = 'FAIL'
    elif warnings:
        result['status'] = 'WARN'
        reasons.extend(warnings)
    else:
        result['status'] = 'PASS'
    return result


def _extract_texture_image(
    gltf_json: dict[str, Any],
    bin_chunk: bytes,
    tex_index: int,
) -> Image.Image | None:
    """Decode an embedded GLB texture image (supports EXT_texture_webp and standard source)."""
    textures = gltf_json.get('textures', [])
    images = gltf_json.get('images', [])
    buffer_views = gltf_json.get('bufferViews', [])
    if tex_index < 0 or tex_index >= len(textures):
        return None
    tex = textures[tex_index]
    img_idx = tex.get('extensions', {}).get('EXT_texture_webp', {}).get('source')
    if img_idx is None:
        img_idx = tex.get('source')
    if img_idx is None or img_idx < 0 or img_idx >= len(images):
        return None

    img_meta = images[img_idx]
    bv_idx = img_meta.get('bufferView')
    if bv_idx is None or bv_idx < 0 or bv_idx >= len(buffer_views):
        return None
    bv = buffer_views[bv_idx]
    byte_offset = int(bv.get('byteOffset', 0))
    byte_length = int(bv.get('byteLength', 0))
    raw = bin_chunk[byte_offset : byte_offset + byte_length]
    if not raw:
        return None
    return Image.open(io.BytesIO(raw)).convert('RGB')


def audit_glb_pbr(glb_path: Path, uv_mask_path: Path | None = None) -> dict[str, Any]:
    """Check 3: Direct GLB JSON + embedded WebP/PNG PBR material audit (no trimesh)."""
    gltf_json, bin_chunk = parse_glb_chunks(glb_path)
    materials = gltf_json.get('materials', [])
    reasons: list[str] = []

    if not materials:
        return {
            'status': 'FAIL',
            'materials_checked': 0,
            'reasons': ['GLB contains no materials'],
        }

    uv_mask = None
    if uv_mask_path is not None:
        try:
            with Image.open(uv_mask_path) as image:
                uv_mask = image.convert('L')
        except OSError as exc:
            return {'status': 'FAIL', 'reasons': [f'Cannot load UV mask: {exc}']}

    def atlas_samples(channel: np.ndarray) -> np.ndarray:
        if uv_mask is None:
            return channel
        height, width = channel.shape
        # The packed scalar textures can be smaller than the baked UV atlas.
        mask = uv_mask.resize((width, height), Image.Resampling.NEAREST)
        return channel[np.asarray(mask) > 127.5]

    worst_metallic_factor = 0.0
    worst_metallic_ch_max = 0.0
    roughness_stds: list[float] = []
    roughness_means: list[float] = []
    clearcoat_stds: list[float] = []
    clearcoat_means: list[float] = []
    all_have_normal = True
    all_have_occlusion = True
    all_have_clearcoat = True

    for idx, mat in enumerate(materials):
        pbr = mat.get('pbrMetallicRoughness', {})
        # glTF default metallicFactor is 1.0 if omitted
        m_factor = float(pbr.get('metallicFactor', 1.0))
        r_factor = float(pbr.get('roughnessFactor', 1.0))
        worst_metallic_factor = max(worst_metallic_factor, m_factor)
        if m_factor != 0.0:
            reasons.append(f'material[{idx}].metallicFactor={m_factor:g} (expected 0.0)')

        mr_info = pbr.get('metallicRoughnessTexture')
        if mr_info is None:
            reasons.append(f'material[{idx}] missing metallicRoughnessTexture')
        else:
            mr_img = _extract_texture_image(gltf_json, bin_chunk, int(mr_info['index']))
            if mr_img is None:
                reasons.append(f'material[{idx}] failed to decode metallicRoughnessTexture')
            else:
                arr = np.asarray(mr_img, dtype=np.float32) / 255.0
                metal_b_max = float(arr[..., 2].max())
                worst_metallic_ch_max = max(worst_metallic_ch_max, metal_b_max)
                if metal_b_max != 0.0:
                    reasons.append(
                        f'material[{idx}] metallicRoughnessTexture B channel max={metal_b_max:.4f} (expected 0.0)'
                    )
                rough_g = atlas_samples(arr[..., 1] * r_factor)
                if rough_g.size == 0:
                    reasons.append(f'material[{idx}] UV mask has no valid roughness pixels')
                else:
                    r_std = float(rough_g.std())
                    roughness_stds.append(r_std)
                    roughness_means.append(float(rough_g.mean()))
                    if r_std < 0.06:
                        reasons.append(
                            f'material[{idx}] roughness G channel std={r_std:.4f} < 0.06 (flat roughness)'
                        )

        if 'normalTexture' not in mat:
            all_have_normal = False
            reasons.append(f'material[{idx}] missing normalTexture')
        if 'occlusionTexture' not in mat:
            all_have_occlusion = False
            reasons.append(f'material[{idx}] missing occlusionTexture')

        extensions = mat.get('extensions', {})
        if 'KHR_materials_sheen' not in extensions:
            reasons.append(f'material[{idx}] missing KHR_materials_sheen extension')
        cc = extensions.get('KHR_materials_clearcoat')
        if not cc:
            all_have_clearcoat = False
            reasons.append(f'material[{idx}] missing KHR_materials_clearcoat extension')
        else:
            cc_factor = float(cc.get('clearcoatFactor', 0.0))
            if (cc.get('clearcoatRoughnessTexture') or {}).get('index') is None:
                reasons.append(f'material[{idx}] missing clearcoatRoughnessTexture')
            cc_tex_info = cc.get('clearcoatTexture')
            if cc_tex_info is None:
                reasons.append(f'material[{idx}] missing clearcoatTexture')
            else:
                cc_img = _extract_texture_image(gltf_json, bin_chunk, int(cc_tex_info['index']))
                if cc_img is None:
                    reasons.append(f'material[{idx}] failed to decode clearcoatTexture')
                else:
                    cc_arr = atlas_samples((np.asarray(cc_img, dtype=np.float32) / 255.0)[..., 0] * cc_factor)
                    if cc_arr.size == 0:
                        reasons.append(f'material[{idx}] UV mask has no valid clearcoat pixels')
                    else:
                        cc_std = float(cc_arr.std())
                        clearcoat_stds.append(cc_std)
                        clearcoat_means.append(float(cc_arr.mean()))
                        if cc_std < 0.04:
                            reasons.append(
                                f'material[{idx}] clearcoat R channel std={cc_std:.4f} < 0.04'
                            )

    return {
        'status': 'FAIL' if reasons else 'PASS',
        'materials_checked': len(materials),
        'metallic_factor': round(worst_metallic_factor, 4),
        'metallic_channel_max': round(worst_metallic_ch_max, 4),
        'roughness_mean': round(float(np.mean(roughness_means)), 4) if roughness_means else None,
        'roughness_std': round(float(min(roughness_stds)), 4) if roughness_stds else None,
        'has_normal_texture': all_have_normal,
        'has_occlusion_texture': all_have_occlusion,
        'has_clearcoat': all_have_clearcoat,
        'clearcoat_mean': round(float(np.mean(clearcoat_means)), 4) if clearcoat_means else None,
        'clearcoat_std': round(float(min(clearcoat_stds)), 4) if clearcoat_stds else None,
        'reasons': reasons,
    }


def load_rgba(path: Path) -> np.ndarray:
    """Load an image as float32 RGBA in [0, 1]."""
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.float32) / 255.0


def normalise_rgba(rgba: np.ndarray, frame: int = FIDELITY_FRAME) -> np.ndarray:
    """Crop to alpha > 0.5 bbox, uniformly scale longer side to frame, and center."""
    alpha = rgba[..., 3] > 0.5
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        return np.zeros((frame, frame, 4), dtype=np.float32)
    crop = rgba[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape[:2]
    scale = frame / max(h, w)
    nh = max(1, round(h * scale))
    nw = max(1, round(w * scale))
    img = Image.fromarray((np.clip(crop, 0.0, 1.0) * 255).astype(np.uint8), 'RGBA').resize(
        (nw, nh), Image.LANCZOS
    )
    canvas = np.zeros((frame, frame, 4), dtype=np.float32)
    oy = (frame - nh) // 2
    ox = (frame - nw) // 2
    canvas[oy : oy + nh, ox : ox + nw] = np.asarray(img, dtype=np.float32) / 255.0
    return canvas


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Convert sRGB [0, 1] array (..., 3) to CIE Lab (D65)."""
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    mat = np.array(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ],
        dtype=np.float32,
    )
    xyz = (c @ mat.T) / np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = np.where(xyz > eps, np.cbrt(np.maximum(xyz, 0.0)), (kappa * xyz + 16.0) / 116.0)
    return np.stack(
        [116.0 * f[..., 1] - 16.0, 500.0 * (f[..., 0] - f[..., 1]), 200.0 * (f[..., 1] - f[..., 2])],
        axis=-1,
    ).astype(np.float32)


def compute_windowed_ssim(
    img_a: np.ndarray,
    img_b: np.ndarray,
    mask: np.ndarray | None = None,
    sigma: float = 1.5,
) -> float:
    """Compute windowed SSIM (11x11 Gaussian window, truncate=3.33 => 11x11) on luminance."""
    lum_a = (img_a[..., 0] * 0.299 + img_a[..., 1] * 0.587 + img_a[..., 2] * 0.114).astype(
        np.float32
    )
    lum_b = (img_b[..., 0] * 0.299 + img_b[..., 1] * 0.587 + img_b[..., 2] * 0.114).astype(
        np.float32
    )
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2
    trunc = 3.33  # int(3.33 * 1.5) = 5 -> 2*5 + 1 = 11x11 window

    mu_a = ndimage.gaussian_filter(lum_a, sigma=sigma, truncate=trunc)
    mu_b = ndimage.gaussian_filter(lum_b, sigma=sigma, truncate=trunc)
    mu_a2 = mu_a * mu_a
    mu_b2 = mu_b * mu_b
    mu_ab = mu_a * mu_b

    sig_a2 = np.maximum(ndimage.gaussian_filter(lum_a * lum_a, sigma=sigma, truncate=trunc) - mu_a2, 0.0)
    sig_b2 = np.maximum(ndimage.gaussian_filter(lum_b * lum_b, sigma=sigma, truncate=trunc) - mu_b2, 0.0)
    sig_ab = ndimage.gaussian_filter(lum_a * lum_b, sigma=sigma, truncate=trunc) - mu_ab

    num = (2.0 * mu_ab + c1) * (2.0 * sig_ab + c2)
    den = (mu_a2 + mu_b2 + c1) * (sig_a2 + sig_b2 + c2)
    ssim_map = num / np.maximum(den, 1e-8)

    if mask is not None and np.any(mask):
        return float(np.clip(ssim_map[mask].mean(), -1.0, 1.0))
    return float(np.clip(ssim_map.mean(), -1.0, 1.0))


def score_fidelity_pair(photo_norm: np.ndarray, render_norm: np.ndarray) -> dict[str, float | None]:
    """Score a normalised 224x224 RGBA photo cutout against a normalised render."""
    pa = photo_norm[..., 3] > 0.5
    ra = render_norm[..., 3] > 0.5
    inter = pa & ra
    union = pa | ra
    iou = float(inter.sum() / max(int(union.sum()), 1))
    if int(inter.sum()) < 50:
        return {
            'silhouette_iou': iou,
            'delta_e': None,
            'ssim': None,
            'detail_corr': None,
            'match': -999.0,
        }

    rgb_p = photo_norm[..., :3]
    rgb_r = render_norm[..., :3]
    de = np.linalg.norm(srgb_to_lab(rgb_p) - srgb_to_lab(rgb_r), axis=-1)[inter]
    delta_e = float(de.mean())

    ssim = compute_windowed_ssim(rgb_p, rgb_r, mask=inter)

    gp_lum = rgb_p[..., 0] * 0.299 + rgb_p[..., 1] * 0.587 + rgb_p[..., 2] * 0.114
    gr_lum = rgb_r[..., 0] * 0.299 + rgb_r[..., 1] * 0.587 + rgb_r[..., 2] * 0.114
    gpy, gpx = np.gradient(gp_lum)
    gry, grx = np.gradient(gr_lum)
    gp = np.hypot(gpx, gpy)[inter]
    gr = np.hypot(grx, gry)[inter]
    detail_corr = float(np.corrcoef(gp, gr)[0, 1]) if gp.std() > 1e-6 and gr.std() > 1e-6 else 0.0
    if not np.isfinite(detail_corr):
        detail_corr = 0.0

    match = iou - delta_e / 100.0 + 0.25 * ssim + 0.25 * detail_corr
    return {
        'silhouette_iou': iou,
        'delta_e': delta_e,
        'ssim': ssim,
        'detail_corr': detail_corr,
        'match': float(match),
    }


def _composite_on_gray(rgba: np.ndarray, bg: float = 0.88) -> np.ndarray:
    a = rgba[..., 3:4]
    rgb = rgba[..., :3] * a + bg * (1.0 - a)
    return (np.clip(rgb, 0.0, 1.0) * 255).astype(np.uint8)


def save_fidelity_diagnostic(
    photo_norm: np.ndarray,
    render_norm: np.ndarray,
    out_path: Path,
    summary_text: str,
) -> None:
    """Save 3-panel diagnostic image: Clean Cutout | Best-Pose Render | 3x Abs Diff."""
    h, w = photo_norm.shape[:2]
    p_rgb = _composite_on_gray(photo_norm)
    r_rgb = _composite_on_gray(render_norm)
    diff = np.abs(p_rgb.astype(np.float32) - r_rgb.astype(np.float32)) * 3.0
    d_rgb = np.clip(diff, 0, 255).astype(np.uint8)

    header_h = 34
    label_h = 22
    gap = 8
    canvas_w = w * 3 + gap * 4
    canvas_h = header_h + label_h + h + gap * 2
    canvas = Image.new('RGB', (canvas_w, canvas_h), (28, 28, 30))
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 9), f'{summary_text}  |  publication_eligible: false', fill=(238, 234, 226))

    panels = [
        ('Clean Cutout', p_rgb),
        ('Best-Pose Render', r_rgb),
        ('3x Abs Diff', d_rgb),
    ]
    for idx, (title, arr) in enumerate(panels):
        x = gap + idx * (w + gap)
        draw.text((x + 2, header_h + 3), title, fill=(195, 190, 182))
        canvas.paste(Image.fromarray(arr, mode='RGB'), (x, header_h + label_h))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format='PNG')


def check_photo_fidelity(
    cutout_path: Path,
    poses_dir: Path,
    diag_img_path: Path | None = None,
    expected_glb_path: Path | None = None,
    score_summary_path: Path | None = None,
) -> dict[str, Any]:
    """Check 4: Verify photo fidelity via held-out albedo metrics (when present) or 216-pose cutout search."""
    poses_meta_path = poses_dir / 'poses.json'
    if not poses_meta_path.exists():
        return {
            'status': 'FAIL',
            'poses_evaluated': 0,
            'reasons': [f'Missing poses.json in {poses_dir}'],
        }

    photo_norm = normalise_rgba(load_rgba(cutout_path))
    meta = json.loads(poses_meta_path.read_text(encoding='utf-8'))
    poses = meta.get('poses', [])
    reasons: list[str] = []
    if expected_glb_path is not None and 'source_glb_sha256' in meta:
        with expected_glb_path.open('rb') as glb:
            expected_digest = hashlib.file_digest(glb, 'sha256').hexdigest()
        if meta['source_glb_sha256'] != expected_digest:
            reasons.append('Pose source GLB SHA-256 does not match expected GLB')
    poses_evaluated = 0

    best: dict[str, Any] | None = None
    best_render_norm: np.ndarray | None = None

    for pose in poses:
        pfile = poses_dir / pose['file']
        if not pfile.is_file():
            reasons.append(f"Missing pose file: {pose['file']}")
            continue
        try:
            render_rgba = load_rgba(pfile)
        except OSError:
            reasons.append(f"Cannot decode pose file: {pose['file']}")
            continue
        poses_evaluated += 1
        render_norm = normalise_rgba(render_rgba)
        metrics = score_fidelity_pair(photo_norm, render_norm)
        if metrics['delta_e'] is None:
            continue
        if best is None or metrics['match'] > best['match']:
            best = {**metrics, 'az': pose['az'], 'el': pose['el'], 'file': pose['file']}
            best_render_norm = render_norm

    if 'expected_poses' in meta and meta['expected_poses'] != poses_evaluated:
        reasons.append(f"expected_poses {meta['expected_poses']} does not match {poses_evaluated} loaded poses")

    if best is None or best_render_norm is None:
        return {
            'status': 'FAIL',
            'poses_evaluated': poses_evaluated,
            'reasons': [*reasons, 'No valid overlapping pose found against cutout'],
        }

    warnings: list[str] = []
    iou = best['silhouette_iou']
    de = best['delta_e']
    ssim = best['ssim']
    corr = best['detail_corr']

    heldout_albedo = None
    if score_summary_path is not None and score_summary_path.is_file():
        try:
            summary_json = json.loads(score_summary_path.read_text(encoding='utf-8'))
            albedo_summary = summary_json.get('albedo')
            if isinstance(albedo_summary, dict) and 'fg_ssim' in albedo_summary and 'fg_delta_e' in albedo_summary:
                heldout_albedo = {
                    'fg_psnr_db': float(albedo_summary.get('fg_psnr_db', {}).get('mean', 0.0)),
                    'fg_ssim': float(albedo_summary['fg_ssim']['mean']),
                    'fg_delta_e': float(albedo_summary['fg_delta_e']['mean']),
                }
        except (OSError, ValueError, KeyError, TypeError):
            heldout_albedo = None

    if heldout_albedo is not None:
        h_ssim = heldout_albedo['fg_ssim']
        h_de = heldout_albedo['fg_delta_e']
        h_psnr = heldout_albedo['fg_psnr_db']
        if h_ssim < 0.30:
            reasons.append(f'heldout_albedo fg_ssim {h_ssim:.3f} < 0.30')
        elif h_ssim < 0.42:
            warnings.append(f'heldout_albedo fg_ssim {h_ssim:.3f} < 0.42')

        if h_de > 22.0:
            reasons.append(f'heldout_albedo fg_delta_e {h_de:.2f} > 22.0')
        elif h_de > 15.0:
            warnings.append(f'heldout_albedo fg_delta_e {h_de:.2f} > 15.0')

        if h_psnr < 14.0:
            reasons.append(f'heldout_albedo fg_psnr_db {h_psnr:.2f} < 14.0')
    else:
        if iou < 0.55:
            reasons.append(f'silhouette_iou {iou:.3f} < 0.55')
        elif iou < 0.75:
            warnings.append(f'silhouette_iou {iou:.3f} < 0.75')

        if de > 35.0:
            reasons.append(f'delta_e {de:.2f} > 35.0')
        elif de > 18.0:
            warnings.append(f'delta_e {de:.2f} > 18.0')

        if ssim < 0.15:
            reasons.append(f'ssim {ssim:.3f} < 0.15')
        elif ssim < 0.45:
            warnings.append(f'ssim {ssim:.3f} < 0.45')

    if diag_img_path is not None:
        summary = (
            f"az={best['az']} el={best['el']} | IoU={iou:.3f} "
            f"dE={de:.1f} SSIM={ssim:.3f} corr={corr:.3f}"
        )
        save_fidelity_diagnostic(photo_norm, best_render_norm, diag_img_path, summary)

    status = 'FAIL' if reasons else ('WARN' if warnings else 'PASS')
    out_dict: dict[str, Any] = {
        'status': status,
        'fidelity_source': 'heldout_albedo' if heldout_albedo is not None else 'pose_grid',
        'poses_evaluated': poses_evaluated,
        'best_pose': {'az': best['az'], 'el': best['el'], 'file': best['file']},
        'match': round(best['match'], 4),
        'silhouette_iou': round(iou, 4),
        'delta_e': round(de, 2),
        'ssim': round(ssim, 4),
        'detail_corr': round(corr, 4),
        'diag_img': str(diag_img_path) if diag_img_path else None,
        'reasons': reasons,
        'warnings': warnings,
    }
    if heldout_albedo is not None:
        out_dict['heldout_albedo'] = {k: round(v, 4) for k, v in heldout_albedo.items()}
    return out_dict


def check_relighting(
    relit_a_path: Path,
    relit_b_path: Path,
    min_p95_diff: float = 8.0,
) -> dict[str, Any]:
    """Check 5: Verify relighting responsiveness between lightAz=0 and lightAz=120 renders."""
    img_a = np.asarray(Image.open(relit_a_path).convert('RGBA'), dtype=np.float32)
    img_b = np.asarray(Image.open(relit_b_path).convert('RGBA'), dtype=np.float32)
    if img_a.shape != img_b.shape:
        img_b = np.asarray(
            Image.open(relit_b_path).convert('RGBA').resize((img_a.shape[1], img_a.shape[0])),
            dtype=np.float32,
        )

    rgb_a = img_a[..., :3]
    rgb_b = img_b[..., :3]
    h, w = rgb_a.shape[:2]

    # Foreground mask: use alpha if transparent background, otherwise detect non-background pixels.
    has_transparency = (img_a[..., 3].min() < 250) or (img_b[..., 3].min() < 250)
    if has_transparency:
        fg_mask = (img_a[..., 3] > 128) & (img_b[..., 3] > 128)
    else:
        patch = max(4, min(16, h // 16, w // 16))
        corners = np.concatenate(
            [
                rgb_a[:patch, :patch].reshape(-1, 3),
                rgb_a[:patch, -patch:].reshape(-1, 3),
                rgb_a[-patch:, :patch].reshape(-1, 3),
                rgb_a[-patch:, -patch:].reshape(-1, 3),
            ],
            axis=0,
        )
        bg_color = np.median(corners, axis=0)
        dist_a = np.max(np.abs(rgb_a - bg_color), axis=-1)
        dist_b = np.max(np.abs(rgb_b - bg_color), axis=-1)
        fg_mask = (dist_a > 8.0) | (dist_b > 8.0)

    if not has_transparency and int(fg_mask.sum()) < max(32, int(0.01 * h * w)):
        # Fallback to central 70% region so uniform frames still evaluate deterministically
        fg_mask = np.zeros((h, w), dtype=bool)
        y0, y1 = int(h * 0.15), int(h * 0.85)
        x0, x1 = int(w * 0.15), int(w * 0.85)
        fg_mask[y0:y1, x0:x1] = True

    diff_map = np.abs(rgb_a - rgb_b).mean(axis=-1)
    fg_diffs = diff_map[fg_mask]
    foreground_pixels = int(fg_diffs.size)
    mean_diff = float(fg_diffs.mean()) if foreground_pixels else 0.0
    p95_diff = float(np.percentile(fg_diffs, 95)) if foreground_pixels else 0.0

    reasons: list[str] = []
    if foreground_pixels < 100:
        reasons.append(f'foreground_pixels {foreground_pixels} < 100')
    if p95_diff < min_p95_diff:
        reasons.append(
            f'relit_p95_diff {p95_diff:.2f} < {min_p95_diff:.1f} (lighting unresponsive or baked)'
        )

    return {
        'status': 'FAIL' if reasons else 'PASS',
        'relit_mean_diff': round(mean_diff, 3),
        'relit_p95_diff': round(p95_diff, 3),
        'min_p95_diff': min_p95_diff,
        'foreground_pixels': foreground_pixels,
        'reasons': reasons,
    }


def compute_overall_verdict(checks: dict[str, dict[str, Any]]) -> tuple[str, list[str], list[str]]:
    """Aggregate per-check statuses into an overall PASS|WARN|FAIL verdict, reasons, and warnings."""
    statuses = [c.get('status', 'FAIL') for c in checks.values()]
    reasons: list[str] = []
    warnings: list[str] = []
    for name, c in checks.items():
        for r in c.get('reasons', []):
            reasons.append(f'[{name}] {r}')
        for w in c.get('warnings', []):
            warnings.append(f'[{name}] {w}')
    if 'FAIL' in statuses:
        return 'FAIL', reasons, warnings
    if 'WARN' in statuses:
        return 'WARN', reasons, warnings
    return 'PASS', reasons, warnings


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Food3D V1 Automated QA Gate.')
    parser.add_argument('--glb', type=Path, required=True, help='Final packed PBR GLB path.')
    parser.add_argument('--cutout', type=Path, required=True, help='Clean RGBA cutout PNG.')
    parser.add_argument('--poses-dir', type=Path, required=True, help='Directory with 216 poses + poses.json.')
    parser.add_argument('--relit-a', type=Path, required=True, help='Render at lightAz=0 deg.')
    parser.add_argument('--relit-b', type=Path, required=True, help='Render at lightAz=120 deg.')
    parser.add_argument('--out', type=Path, required=True, help='Output qa_report.json path.')
    parser.add_argument('--geom-glb', type=Path, default=None, help='Uncompressed geom GLB for trimesh audit.')
    parser.add_argument('--bake-report', type=Path, default=None, help='Optional Stage 2 bake_report.json.')
    parser.add_argument('--pbr-report', type=Path, default=None, help='Optional Stage 3a pbr_report.json.')
    parser.add_argument('--diag-img', type=Path, default=None, help='Optional 3-panel fidelity diagnostic PNG.')
    parser.add_argument('--max-bytes', type=int, default=5_242_880, help='Maximum GLB file size in bytes.')
    parser.add_argument('--max-tris', type=int, default=155_000, help='Maximum triangle count.')
    parser.add_argument('--skip-cli-validate', action='store_true', help='Skip gltf-transform validate subprocess.')
    parser.add_argument('--uv-mask', type=Path, help='Baked UV atlas coverage mask PNG.')
    parser.add_argument('--score-summary', type=Path, default=None, help='Optional held-out score_summary.json for albedo fidelity gating.')
    parser.add_argument('--strict', action='store_true', help='Exit nonzero on a FAIL verdict.')
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    checks = {
        'gltf_budget': check_gltf_budget(
            args.glb,
            max_bytes=args.max_bytes,
            max_tris=args.max_tris,
            skip_cli_validate=args.skip_cli_validate,
        ),
        'geometry': check_geometry(
            geom_glb=args.geom_glb,
            bake_report_path=args.bake_report,
        ),
        'pbr_material': audit_glb_pbr(args.glb, uv_mask_path=args.uv_mask),
        'photo_fidelity': check_photo_fidelity(
            cutout_path=args.cutout,
            poses_dir=args.poses_dir,
            diag_img_path=args.diag_img,
            expected_glb_path=args.glb,
            score_summary_path=args.score_summary,
        ),
        'relighting': check_relighting(
            relit_a_path=args.relit_a,
            relit_b_path=args.relit_b,
        ),
    }

    pbr_summary = None
    if args.pbr_report is not None and args.pbr_report.exists():
        pbr_summary = json.loads(args.pbr_report.read_text(encoding='utf-8'))

    verdict, reasons, warnings = compute_overall_verdict(checks)
    report = {
        'schema_version': 1,
        'pipeline': 'food3d-v1-qa-gate',
        'publication_eligible': False,
        'glb': str(args.glb),
        'verdict': verdict,
        'reasons': reasons,
        'warnings': warnings,
        'checks': checks,
        'pbr_report_summary': pbr_summary,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(report, indent=2) + '\n'
    args.out.write_text(text, encoding='utf-8')
    print(text)
    return int(args.strict and verdict == 'FAIL')


if __name__ == '__main__':
    raise SystemExit(main())
