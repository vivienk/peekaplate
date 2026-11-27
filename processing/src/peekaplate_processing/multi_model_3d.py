"""Watertight MoGe-2 2.5D/3D dish relief + ceramic plate builder & photographic UV PBR baker.

NOTE: All artifacts emitted by this module are private single-photo R&D benchmarks
with `publication_eligible: false` (never published T0/T1/T2 menu evidence). All
food surface color comes strictly from unmodified pixels of the captured dish photo.
"""

from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import shutil
import struct
import time
from typing import Any

import numpy as np
from PIL import Image, ImageOps


MAX_MOBILE_FACES = 35000
MAX_PIXELS = 4096 * 4096
STAGED_INPUT_NAME = 'input_image.png'
STAGED_TRANSFORMATION_NONE = 'none'


def sha256_file(path: Path) -> str:
    """Return the SHA-256 hex digest of `path`'s encoded bytes."""
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _exif_orientation(image: Image.Image) -> int | None:
    """Return the EXIF orientation tag (0x0112) without forcing a full decode."""
    try:
        return image.getexif().get(0x0112, 1)
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return 1


def _staging_eligible_for_verbatim_copy(image: Image.Image) -> bool:
    """True when `input_image.png` can be a byte-identical copy of the source file."""
    return (
        image.format == 'PNG'
        and getattr(image, 'n_frames', 1) == 1
        and image.width * image.height <= MAX_PIXELS
        and _exif_orientation(image) in (None, 1)
    )


def _staging_transformation_steps(image: Image.Image, target_mode: str) -> list[str]:
    """Name every operation applied when the source must be re-encoded."""
    steps: list[str] = []
    if getattr(image, 'n_frames', 1) != 1:
        steps.append('first_frame')
    if _exif_orientation(image) not in (None, 1):
        steps.append('exif_transpose')
    if image.mode != target_mode:
        steps.append(f'to_{target_mode.lower()}')
    steps.append('png_encode')
    return steps


def stage_source_image(src: Path, dst: Path) -> dict[str, Any]:
    """Stage `src` at `dst` without letting derived bytes occupy the source identity.

    `source_sha256` is hashed from the untouched source bytes before any decode. A single-frame PNG
    (the encoded form of `dst`) without EXIF orientation is copied byte-for-byte, so the staged
    artifact and the declared digest describe the same bytes. Otherwise the derived bytes get their
    own `input_image_sha256` plus a named `input_transformation`, and `source_sha256` still names the
    original source bytes.
    """
    src, dst = Path(src), Path(dst)
    source_sha256 = sha256_file(src)
    input_transformation = STAGED_TRANSFORMATION_NONE

    with Image.open(src) as im:
        if _staging_eligible_for_verbatim_copy(im):
            shutil.copyfile(src, dst)
            size = [im.width, im.height]
        else:
            steps = _staging_transformation_steps(im, 'RGB')
            rgb = ImageOps.exif_transpose(im).convert('RGB')
            rgb.save(dst, format='PNG', optimize=True)
            input_transformation = '+'.join(steps)
            size = list(rgb.size)

    input_image_sha256 = sha256_file(dst)
    return {
        'source_sha256': source_sha256,
        'source_bytes': src.stat().st_size,
        'input_filename': dst.name,
        'input_image_sha256': input_image_sha256,
        'input_bytes': dst.stat().st_size,
        'input_transformation': input_transformation,
        'input_byte_identical': input_transformation == STAGED_TRANSFORMATION_NONE,
        'size': size,
    }


def _ensure_vec3_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Compute area-weighted smooth per-vertex normals."""
    normals = np.zeros_like(vertices, dtype=np.float64)
    if len(faces) == 0:
        normals[:, 1] = 1.0
        return normals.astype(np.float32)

    v0 = vertices[faces[:, 0]].astype(np.float64)
    v1 = vertices[faces[:, 1]].astype(np.float64)
    v2 = vertices[faces[:, 2]].astype(np.float64)
    fn = np.cross(v1 - v0, v2 - v0)
    np.add.at(normals, faces[:, 0], fn)
    np.add.at(normals, faces[:, 1], fn)
    np.add.at(normals, faces[:, 2], fn)
    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    bad = norms[:, 0] < 1e-12
    norms[bad] = 1.0
    normals /= norms
    normals[bad] = np.array([0.0, 1.0, 0.0], dtype=np.float64)
    return normals.astype(np.float32)


def check_watertight_edges(faces: np.ndarray) -> tuple[bool, int, int]:
    """Return `(is_watertight, boundary_edges, nonmanifold_edges)` for triangle mesh `faces`."""
    if len(faces) == 0:
        return False, 0, 0
    f = np.asarray(faces, dtype=np.int64)
    e01 = np.sort(f[:, [0, 1]], axis=1)
    e12 = np.sort(f[:, [1, 2]], axis=1)
    e20 = np.sort(f[:, [2, 0]], axis=1)
    edges = np.vstack([e01, e12, e20])
    _, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = int(np.sum(counts == 1))
    nonmanifold = int(np.sum(counts > 2))
    return (boundary == 0 and nonmanifold == 0), boundary, nonmanifold


def write_pbr_glb(
    vertices: np.ndarray,
    faces: np.ndarray,
    uvs: np.ndarray,
    base_color_image: Image.Image,
    out_path: Path,
    *,
    normals: np.ndarray | None = None,
    normal_image: Image.Image | None = None,
    metallic: float = 0.0,
    roughness: float = 0.48,
    double_sided: bool = False,
    image_format: str = 'PNG',
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write a valid binary glTF 2.0 `.glb` embedding PNG or JPEG PBR texture(s)."""
    verts = np.ascontiguousarray(vertices, dtype=np.float32)
    tris = np.ascontiguousarray(faces, dtype=np.uint32)
    texcoords = np.ascontiguousarray(uvs, dtype=np.float32)
    if normals is None:
        norms = _ensure_vec3_normals(verts, tris)
    else:
        norms = np.ascontiguousarray(normals, dtype=np.float32)

    if len(verts) == 0 or len(tris) == 0:
        raise ValueError('Cannot export empty mesh to GLB.')
    if not (np.isfinite(verts).all() and np.isfinite(norms).all() and np.isfinite(texcoords).all()):
        raise ValueError('Cannot export non-finite mesh attributes to GLB.')

    fmt_u = image_format.upper()
    if fmt_u not in ('PNG', 'JPEG'):
        raise ValueError(f'Unsupported core glTF 2.0 image format: {image_format!r}')
    mime = 'image/jpeg' if fmt_u == 'JPEG' else 'image/png'

    img_buf = BytesIO()
    if fmt_u == 'JPEG':
        base_rgb = base_color_image.convert('RGB')
        base_rgb.save(img_buf, format='JPEG', quality=88, optimize=True)
    else:
        base_rgb = base_color_image.convert('RGB') if base_color_image.mode != 'RGBA' else base_color_image
        base_rgb.save(img_buf, format='PNG', optimize=True)
    base_bytes = img_buf.getvalue()

    norm_bytes: bytes | None = None
    if normal_image is not None:
        nbuf = BytesIO()
        normal_image.convert('RGB').save(nbuf, format='PNG', optimize=True)
        norm_bytes = nbuf.getvalue()

    bin_parts: list[bytes] = []
    buffer_views: list[dict[str, Any]] = []
    byte_offset = 0

    def _append_view(data: bytes, target: int | None = None) -> int:
        nonlocal byte_offset
        pad = (-len(data)) % 4
        bin_parts.append(data + (b'\x00' * pad))
        bv: dict[str, Any] = {'buffer': 0, 'byteOffset': byte_offset, 'byteLength': len(data)}
        if target is not None:
            bv['target'] = target
        idx = len(buffer_views)
        buffer_views.append(bv)
        byte_offset += len(data) + pad
        return idx

    idx_bytes = tris.reshape(-1).tobytes()
    bv_idx = _append_view(idx_bytes, target=34963)
    bv_pos = _append_view(verts.tobytes(), target=34962)
    bv_norm = _append_view(norms.tobytes(), target=34962)
    bv_uv = _append_view(texcoords.tobytes(), target=34962)
    bv_base_img = _append_view(base_bytes)
    bv_norm_img = _append_view(norm_bytes) if norm_bytes is not None else None

    v_min = [float(x) for x in verts.min(axis=0)]
    v_max = [float(x) for x in verts.max(axis=0)]

    images = [{'bufferView': bv_base_img, 'mimeType': mime}]
    textures = [{'sampler': 0, 'source': 0}]
    material: dict[str, Any] = {
        'name': 'DishPhotoCeramicPBR',
        'pbrMetallicRoughness': {
            'baseColorTexture': {'index': 0},
            'metallicFactor': float(metallic),
            'roughnessFactor': float(roughness),
        },
        'doubleSided': bool(double_sided),
    }
    if bv_norm_img is not None:
        images.append({'bufferView': bv_norm_img, 'mimeType': 'image/png'})
        textures.append({'sampler': 0, 'source': 1})
        material['normalTexture'] = {'index': 1, 'scale': 0.85}

    asset_extras = {'publication_eligible': False}
    if extras:
        asset_extras.update(extras)
        asset_extras['publication_eligible'] = False

    gltf = {
        'asset': {
            'version': '2.0',
            'generator': 'peekaplate-multi-model-3d',
            'extras': asset_extras,
        },
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': 'dish_3d'}],
        'meshes': [{
            'primitives': [{
                'attributes': {'POSITION': 1, 'NORMAL': 2, 'TEXCOORD_0': 3},
                'indices': 0,
                'material': 0,
            }]
        }],
        'materials': [material],
        'samplers': [{
            'magFilter': 9729,
            'minFilter': 9987 if min(base_rgb.size) >= 4 else 9729,
            'wrapS': 33071,
            'wrapT': 33071,
        }],
        'textures': textures,
        'images': images,
        'buffers': [{'byteLength': byte_offset}],
        'bufferViews': buffer_views,
        'accessors': [
            {
                'bufferView': bv_idx,
                'componentType': 5125,  # UNSIGNED_INT
                'count': int(tris.size),
                'type': 'SCALAR',
                'min': [int(tris.min())],
                'max': [int(tris.max())],
            },
            {
                'bufferView': bv_pos,
                'componentType': 5126,  # FLOAT
                'count': int(len(verts)),
                'type': 'VEC3',
                'min': v_min,
                'max': v_max,
            },
            {
                'bufferView': bv_norm,
                'componentType': 5126,
                'count': int(len(norms)),
                'type': 'VEC3',
            },
            {
                'bufferView': bv_uv,
                'componentType': 5126,
                'count': int(len(texcoords)),
                'type': 'VEC2',
            },
        ],
    }

    json_bytes = json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    json_pad = (-len(json_bytes)) % 4
    json_chunk = json_bytes + (b' ' * json_pad)
    bin_blob = b''.join(bin_parts)
    total_len = 12 + 8 + len(json_chunk) + 8 + len(bin_blob)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open('wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total_len))
        f.write(struct.pack('<II', len(json_chunk), 0x4E4F534A))
        f.write(json_chunk)
        f.write(struct.pack('<II', len(bin_blob), 0x004E4942))
        f.write(bin_blob)

    wt, b_edges, nm_edges = check_watertight_edges(tris)
    return {
        'vertices': int(len(verts)),
        'faces': int(len(tris)),
        'bytes': int(out_path.stat().st_size),
        'has_texture': True,
        'has_vertex_color': False,
        'watertight': bool(wt),
        'boundary_edges': b_edges,
        'nonmanifold_edges': nm_edges,
        'publication_eligible': False,
    }


def _fast_chamfer_distance(mask: np.ndarray) -> np.ndarray:
    """Compute normalized [0, 1] distance from background in pure NumPy."""
    h, w = mask.shape
    inf = float(h + w) * 4.0
    dist = np.where(mask, inf, 0.0).astype(np.float32)
    # Forward / backward chamfer passes in NumPy slices (fast, O(H+W) ops only? Use iterative relaxation)
    # 25 iterations of vector shift min gives smooth radial distance up to 50% grid radius
    iters = max(24, max(h, w) // 2)
    diag = np.float32(1.4142135)
    for _ in range(iters):
        p = np.pad(dist, 1, mode='constant', constant_values=0.0)
        cand = np.minimum.reduce([
            p[1:-1, 1:-1],
            p[:-2, 1:-1] + 1.0,
            p[2:, 1:-1] + 1.0,
            p[1:-1, :-2] + 1.0,
            p[1:-1, 2:] + 1.0,
            p[:-2, :-2] + diag,
            p[:-2, 2:] + diag,
            p[2:, :-2] + diag,
            p[2:, 2:] + diag,
        ])
        dist = np.where(mask, cand, 0.0)
    mx = float(dist.max())
    return (dist / mx) if mx > 1e-6 else dist


def _remove_diagonal_pinches_and_keep_largest(quads: np.ndarray) -> np.ndarray:
    """Ensure active quad union has simple closed boundary loops without checkerboard pinches."""
    q = quads.copy()
    h, w = q.shape
    # Fill 1-cell enclosed background holes first
    padded = np.pad(q, 1, mode='constant', constant_values=False)
    n4 = (
        padded[:-2, 1:-1].astype(np.int8)
        + padded[2:, 1:-1].astype(np.int8)
        + padded[1:-1, :-2].astype(np.int8)
        + padded[1:-1, 2:].astype(np.int8)
    )
    q = q | (n4 == 4)

    # Keep only the largest 4-connected component (with > 4 quads) so zero floating specks cause pinches
    visited = np.zeros_like(q, dtype=bool)
    best_comp: list[tuple[int, int]] = []
    for r in range(h):
        for c in range(w):
            if q[r, c] and not visited[r, c]:
                stack = [(r, c)]
                visited[r, c] = True
                comp = []
                while stack:
                    cr, cc = stack.pop()
                    comp.append((cr, cc))
                    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        nr, nc = cr + dr, cc + dc
                        if 0 <= nr < h and 0 <= nc < w and q[nr, nc] and not visited[nr, nc]:
                            visited[nr, nc] = True
                            stack.append((nr, nc))
                if len(comp) > len(best_comp):
                    best_comp = comp

    if best_comp:
        clean = np.zeros_like(q, dtype=bool)
        rr, cc = zip(*best_comp)
        clean[np.array(rr), np.array(cc)] = True
        q = clean

    # Iteratively bridge any 2x2 diagonal checkerboard pinch so boundary is strictly 2-manifold
    for _ in range(8):
        tl = q[:-1, :-1]
        tr = q[:-1, 1:]
        bl = q[1:, :-1]
        br = q[1:, 1:]
        pinch_a = tl & br & (~tr) & (~bl)
        pinch_b = tr & bl & (~tl) & (~br)
        if not (pinch_a.any() or pinch_b.any()):
            break
        q[:-1, 1:][pinch_a] = True
        q[:-1, :-1][pinch_b] = True
    return q


def _sanitize_depth_map(
    depth_map: np.ndarray | None,
    fg_mask: np.ndarray | None = None,
) -> np.ndarray | None:
    """Replace non-finite MoGe-2 background/mask depth values with the finite far-rim percentile."""
    if depth_map is None:
        return None
    dm = np.asarray(depth_map, dtype=np.float32)
    if dm.ndim > 2:
        dm = np.squeeze(dm)
    while dm.ndim > 2:
        dm = dm[0]
    if dm.ndim != 2 or dm.size == 0:
        return None
    finite = np.isfinite(dm)
    if not finite.any():
        return None
    if fg_mask is not None and fg_mask.shape == dm.shape and (finite & fg_mask).any():
        ref_vals = dm[finite & fg_mask]
    else:
        ref_vals = dm[finite]
    hi = float(np.percentile(ref_vals, 97))
    return np.where(finite, dm, np.float32(hi)).astype(np.float32, copy=False)


def _sanitize_normal_map(normal_map: np.ndarray | None) -> np.ndarray | None:
    """Convert float/uint8 MoGe-2 normal maps to finite uint8 RGB images."""
    if normal_map is None:
        return None
    nm = np.asarray(normal_map)
    if nm.ndim == 3 and nm.shape[0] == 3 and nm.shape[-1] != 3:
        nm = np.transpose(nm, (1, 2, 0))
    if np.issubdtype(nm.dtype, np.floating):
        nm_f = nm.astype(np.float32, copy=False)
        if nm_f.ndim == 3 and nm_f.shape[-1] == 3:
            bad = ~np.isfinite(nm_f).all(axis=-1)
            if bad.any():
                nm_f = nm_f.copy()
                nm_f[bad] = np.array([0.0, 0.0, 1.0], dtype=np.float32)
        else:
            nm_f = np.nan_to_num(nm_f, nan=0.0, posinf=1.0, neginf=-1.0)
        return np.clip((nm_f * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    return np.asarray(nm, dtype=np.uint8)


def _build_watertight_relief_geometry(
    rgba_arr: np.ndarray,
    grid_res: int,
    depth_map: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, tuple[int, int, int]]:
    """Build watertight top photo-relief + bottom lathed ceramic plate mesh."""
    img_h, img_w = rgba_arr.shape[:2]
    depth_map = _sanitize_depth_map(depth_map, rgba_arr[..., 3] > 20)
    aspect = img_w / max(1, img_h)
    gh = max(20, int(grid_res))
    gw = max(20, int(round(grid_res * aspect)))
    if gw > 1.45 * grid_res:
        gw = int(round(grid_res * 1.45))
        gh = max(20, int(round(gw / max(0.25, aspect))))

    # Resample RGBA alpha & luminance onto vertex grid (gh x gw)
    ys_px = np.linspace(0, img_h - 1, gh).astype(np.int32)
    xs_px = np.linspace(0, img_w - 1, gw).astype(np.int32)
    grid_rgba = rgba_arr[ys_px[:, None], xs_px[None, :]]
    v_alpha = grid_rgba[..., 3] > 20
    # Estimate ceramic color from near-rim pixels (alpha>180 and outer 20% distance)
    lum = (
        0.299 * grid_rgba[..., 0]
        + 0.587 * grid_rgba[..., 1]
        + 0.114 * grid_rgba[..., 2]
    ).astype(np.float32) / 255.0

    # Active quads where at least 2 corners or center are inside foreground alpha
    q_count = (
        v_alpha[:-1, :-1].astype(np.int8)
        + v_alpha[:-1, 1:].astype(np.int8)
        + v_alpha[1:, :-1].astype(np.int8)
        + v_alpha[1:, 1:].astype(np.int8)
    )
    quads = q_count >= 2
    if int(quads.sum()) < 4:
        # Fallback to full center circle if mask is nearly empty
        yy, xx = np.mgrid[0:gh - 1, 0:gw - 1]
        cy, cx = (gh - 2) / 2.0, (gw - 2) / 2.0
        quads = (((yy - cy) / max(1.0, cy)) ** 2 + ((xx - cx) / max(1.0, cx)) ** 2) <= 0.65
    quads = _remove_diagonal_pinches_and_keep_largest(quads)

    # Mark vertices touched by active quads
    v_active = np.zeros((gh, gw), dtype=bool)
    v_active[:-1, :-1] |= quads
    v_active[:-1, 1:] |= quads
    v_active[1:, :-1] |= quads
    v_active[1:, 1:] |= quads

    # Sample ceramic glaze color from outer foreground rim (safe non-white neutral)
    d_norm = _fast_chamfer_distance(v_active)
    rim_mask = v_active & (d_norm > 0.01) & (d_norm < 0.22)
    if rim_mask.any():
        rim_rgb = np.median(grid_rgba[rim_mask, :3], axis=0).astype(np.uint8)
        ceramic_rgb = (
            int(0.75 * rim_rgb[0] + 0.25 * 225),
            int(0.75 * rim_rgb[1] + 0.25 * 222),
            int(0.75 * rim_rgb[2] + 0.25 * 218),
        )
    else:
        ceramic_rgb = (224, 220, 214)

    # Height relief map y_top(r, c)
    if depth_map is not None:
        dm = np.asarray(depth_map, dtype=np.float32)
        if dm.shape != (img_h, img_w):
            dm_im = Image.fromarray(dm).resize((gw, gh), Image.Resampling.BILINEAR)
            d_grid = np.asarray(dm_im, dtype=np.float32)
        else:
            d_grid = dm[ys_px[:, None], xs_px[None, :]]
        finite_fg = d_grid[v_active & np.isfinite(d_grid)]
        lo = float(np.percentile(finite_fg, 3)) if len(finite_fg) else 0.0
        hi = float(np.percentile(finite_fg, 97)) if len(finite_fg) else 1.0
        d_grid = np.where(np.isfinite(d_grid), d_grid, np.float32(hi))
        # Invert typical camera depth (closer -> higher relief), clamp softly
        rel_h = np.clip(
            np.nan_to_num((hi - d_grid) / max(1e-5, hi - lo), nan=0.0, posinf=1.0, neginf=0.0),
            0.0,
            1.0,
        )
        # Taper cleanly at the rim silhouette to meet the plate edge
        rim_blend = np.clip(d_norm * 3.5, 0.25, 1.0)
        y_top = 0.09 + (0.28 * rel_h * rim_blend) + 0.05 * np.sqrt(d_norm)
    else:
        # Smooth foreground food/bowl relief prior guided by radial distance and local luminance
        # Compute high-frequency local contrast to lift toppings/ingredients slightly relative to bowl/broth
        pad_l = np.pad(lum, 2, mode='edge')
        local_avg = (
            pad_l[:-4, 2:-2] + pad_l[4:, 2:-2] + pad_l[2:-2, :-4] + pad_l[2:-2, 4:] + lum
        ) / 5.0
        detail = np.clip((lum - local_avg) * 2.5, -0.35, 0.45)
        dome = np.sin(np.clip(d_norm, 0.0, 1.0) * (math.pi * 0.62))
        y_top = 0.09 + 0.24 * dome + 0.045 * detail * np.clip(d_norm * 4.0, 0.0, 1.0)

    # Parametric ceramic bowl/plate underside y_bot(r, c) sitting at y=0 foot ring
    # Rim curves smoothly down into a flat resting base at d_norm >= 0.42
    bowl_curve = np.clip(d_norm / 0.42, 0.0, 1.0)
    y_bot = 0.08 * np.power(1.0 - bowl_curve, 1.45)
    y_top = np.nan_to_num(y_top, nan=0.09, posinf=0.42, neginf=0.09)
    y_top = np.maximum(y_top, y_bot + 0.015)

    # Map image plane -> metric platter coords [-0.9..0.9] centered on foreground bbox
    rs_act, cs_act = np.where(v_active)
    c_mid = 0.5 * (cs_act.min() + cs_act.max())
    r_mid = 0.5 * (rs_act.min() + rs_act.max())
    span = max(1.0, float(max(cs_act.max() - cs_act.min(), rs_act.max() - rs_act.min())))
    scale_xz = 1.65 / span

    jj, ii = np.meshgrid(np.arange(gw, dtype=np.float32), np.arange(gh, dtype=np.float32))
    pos_x = (jj - c_mid) * scale_xz
    pos_z = (ii - r_mid) * scale_xz

    # Active vertex compact indices
    n_act = int(v_active.sum())
    top_vid = np.full((gh, gw), -1, dtype=np.int32)
    top_vid[v_active] = np.arange(n_act, dtype=np.int32)
    bot_vid = np.where(top_vid >= 0, top_vid + n_act, -1)

    top_xyz = np.stack([pos_x[v_active], y_top[v_active], pos_z[v_active]], axis=1).astype(np.float32)
    bot_xyz = np.stack([pos_x[v_active], y_bot[v_active], pos_z[v_active]], axis=1).astype(np.float32)
    vertices = np.vstack([top_xyz, bot_xyz])

    # UV coords: top maps [0..1, 0..H/(H+16)] to unmodified captured photo; bottom maps to bottom ceramic swatch
    uv_scale_v = img_h / float(img_h + 16)
    u_coords = (jj / max(1, gw - 1))[v_active]
    v_coords = (ii / max(1, gh - 1))[v_active] * uv_scale_v
    top_uv = np.stack([u_coords, v_coords], axis=1).astype(np.float32)
    swatch_v = (img_h + 8) / float(img_h + 16)
    bot_uv = np.tile(np.array([[0.5, swatch_v]], dtype=np.float32), (n_act, 1))
    uvs = np.vstack([top_uv, bot_uv])

    # Build top + bottom triangles for every active quad (r, c)
    ar, ac = np.where(quads)
    tl_t = top_vid[ar, ac]
    tr_t = top_vid[ar, ac + 1]
    bl_t = top_vid[ar + 1, ac]
    br_t = top_vid[ar + 1, ac + 1]

    tl_b = bot_vid[ar, ac]
    tr_b = bot_vid[ar, ac + 1]
    bl_b = bot_vid[ar + 1, ac]
    br_b = bot_vid[ar + 1, ac + 1]

    # Top faces CCW looking down (+Y normal)
    t1 = np.stack([tl_t, bl_t, tr_t], axis=1)
    t2 = np.stack([tr_t, bl_t, br_t], axis=1)
    # Bottom faces opposite winding (-Y normal)
    b1 = np.stack([tl_b, tr_b, bl_b], axis=1)
    b2 = np.stack([tr_b, br_b, bl_b], axis=1)

    # Boundary side quads for every active quad side lacking a neighbor (keeps half-edge orientation exact!)
    side_tris: list[np.ndarray] = []
    qh, qw = quads.shape

    def _add_side(a_idx, b_idx):
        at = top_vid[a_idx]
        bt = top_vid[b_idx]
        ab = bot_vid[a_idx]
        bb = bot_vid[b_idx]
        side_tris.append(np.stack([at, bt, bb], axis=1))
        side_tris.append(np.stack([at, bb, ab], axis=1))

    # Top boundary (quad[r,c] has no neighbor at [r-1, c]): top triangle edge is (tr -> tl)
    mask_n = quads.copy()
    mask_n[1:, :] &= ~quads[:-1, :]
    rn, cn = np.where(mask_n)
    if len(rn):
        _add_side((rn, cn + 1), (rn, cn))

    # Bottom boundary (no neighbor at [r+1, c]): top triangle edge is (bl -> br)
    mask_s = quads.copy()
    mask_s[:-1, :] &= ~quads[1:, :]
    rs, cs = np.where(mask_s)
    if len(rs):
        _add_side((rs + 1, cs), (rs + 1, cs + 1))

    # Left boundary (no neighbor at [r, c-1]): top triangle edge is (tl -> bl)
    mask_w = quads.copy()
    mask_w[:, 1:] &= ~quads[:, :-1]
    rw, cw = np.where(mask_w)
    if len(rw):
        _add_side((rw, cw), (rw + 1, cw))

    # Right boundary (no neighbor at [r, c+1]): top triangle edge is (br -> tr)
    mask_e = quads.copy()
    mask_e[:, :-1] &= ~quads[:, 1:]
    re_, ce = np.where(mask_e)
    if len(re_):
        _add_side((re_ + 1, ce + 1), (re_, ce + 1))

    all_blocks = [t1, t2, b1, b2, *side_tris]
    faces = np.vstack(all_blocks).astype(np.uint32)
    return vertices, faces, uvs, ceramic_rgb


def _compose_atlas_with_ceramic_band(
    cutout_rgba_path: Path,
    ceramic_rgb: tuple[int, int, int],
    max_tex_dim: int,
) -> tuple[Image.Image, np.ndarray]:
    """Composite captured foreground RGB onto rim-tinted backdrop plus a bottom 16px ceramic swatch."""
    with Image.open(cutout_rgba_path) as im:
        rgba = ImageOps.exif_transpose(im).convert('RGBA')
    orig_w, orig_h = rgba.size
    if max(orig_w, orig_h) > max_tex_dim:
        rgba.thumbnail((max_tex_dim, max_tex_dim), Image.Resampling.LANCZOS)
    rgba_arr = np.asarray(rgba, dtype=np.uint8)
    h, w = rgba_arr.shape[:2]

    # Blend transparent margins against neutral ceramic color so linear texture sampling has zero dark fringing
    alpha = rgba_arr[..., 3:4].astype(np.float32) / 255.0
    bg = np.array(ceramic_rgb, dtype=np.float32).reshape(1, 1, 3)
    rgb_clean = np.clip(rgba_arr[..., :3].astype(np.float32) * alpha + bg * (1.0 - alpha), 0, 255).astype(np.uint8)

    band = np.broadcast_to(np.array(ceramic_rgb, dtype=np.uint8).reshape(1, 1, 3), (16, w, 3)).copy()
    atlas_arr = np.vstack([rgb_clean, band])
    return Image.fromarray(atlas_arr, mode='RGB'), rgba_arr


def _normal_map_from_rgba(rgba_arr: np.ndarray, ceramic_rgb: tuple[int, int, int]) -> Image.Image:
    """Create a subtle tangent-space normal map from foreground photo luminance gradients."""
    gray = (0.299 * rgba_arr[..., 0] + 0.587 * rgba_arr[..., 1] + 0.114 * rgba_arr[..., 2]) / 255.0
    fg = rgba_arr[..., 3] > 20
    gray = np.where(fg, gray, 0.5)
    gx = np.zeros_like(gray, dtype=np.float32)
    gy = np.zeros_like(gray, dtype=np.float32)
    gx[:, 1:-1] = (gray[:, 2:] - gray[:, :-2]) * 1.15
    gy[1:-1, :] = (gray[2:, :] - gray[:-2, :]) * 1.15
    nz = np.ones_like(gray, dtype=np.float32)
    vec = np.stack([-gx, -gy, nz], axis=-1)
    vec /= np.linalg.norm(vec, axis=-1, keepdims=True).clip(min=1e-6)
    nmap = np.clip((vec * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    # Neutral flat tangent normal (128, 128, 255) for the ceramic underside band
    flat_band = np.broadcast_to(np.array([128, 128, 255], dtype=np.uint8).reshape(1, 1, 3), (16, rgba_arr.shape[1], 3)).copy()
    _ = ceramic_rgb
    return Image.fromarray(np.vstack([nmap, flat_band]), mode='RGB')


def build_moge2_relief_and_ceramic_plate_glb(
    cutout_rgba_path: Path,
    raw_glb_path: Path,
    mobile_glb_path: Path | None = None,
    *,
    depth_map: np.ndarray | None = None,
    normal_map: np.ndarray | None = None,
    raw_grid_res: int = 160,
    mobile_grid_res: int = 86,
) -> dict[str, Any]:
    """Export watertight captured-photo dish relief + ceramic plate GLBs (`raw` + `<=35k` mobile)."""
    t0 = time.perf_counter()
    with Image.open(cutout_rgba_path) as im:
        rgba = ImageOps.exif_transpose(im).convert('RGBA')
    rgba_arr = np.asarray(rgba, dtype=np.uint8)

    verts_raw, faces_raw, uvs_raw, ceramic_rgb = _build_watertight_relief_geometry(
        rgba_arr, raw_grid_res, depth_map
    )
    atlas_raw, clean_raw_arr = _compose_atlas_with_ceramic_band(cutout_rgba_path, ceramic_rgb, max_tex_dim=1536)
    normal_map = _sanitize_normal_map(normal_map)
    if normal_map is not None:
        nm_arr = np.asarray(normal_map, dtype=np.uint8)
        nm_im = Image.fromarray(nm_arr).resize((atlas_raw.width, atlas_raw.height - 16), Image.Resampling.BILINEAR)
        flat_band = Image.new('RGB', (atlas_raw.width, 16), (128, 128, 255))
        norm_tex_raw = Image.new('RGB', atlas_raw.size)
        norm_tex_raw.paste(nm_im, (0, 0))
        norm_tex_raw.paste(flat_band, (0, atlas_raw.height - 16))
    else:
        norm_tex_raw = _normal_map_from_rgba(clean_raw_arr, ceramic_rgb)

    raw_metrics = write_pbr_glb(
        verts_raw,
        faces_raw,
        uvs_raw,
        atlas_raw,
        raw_glb_path,
        normal_image=norm_tex_raw,
        roughness=0.42,
        extras={'backend': 'moge2-relief', 'plate_base_added': True},
    )

    mob_metrics: dict[str, Any] | None = None
    if mobile_glb_path is not None:
        g_mob = min(mobile_grid_res, 88)
        verts_m, faces_m, uvs_m, _ = _build_watertight_relief_geometry(rgba_arr, g_mob, depth_map)
        while len(faces_m) > MAX_MOBILE_FACES and g_mob > 28:
            g_mob = max(28, int(g_mob * 0.85))
            verts_m, faces_m, uvs_m, _ = _build_watertight_relief_geometry(rgba_arr, g_mob, depth_map)
        atlas_mob, _ = _compose_atlas_with_ceramic_band(cutout_rgba_path, ceramic_rgb, max_tex_dim=1024)
        mob_metrics = write_pbr_glb(
            verts_m,
            faces_m,
            uvs_m,
            atlas_mob,
            mobile_glb_path,
            roughness=0.42,
            image_format='JPEG',
            extras={'backend': 'moge2-relief-mobile', 'plate_base_added': True},
        )

    elapsed = round(time.perf_counter() - t0, 3)
    raw_metrics['elapsed_seconds'] = elapsed
    if mob_metrics is not None:
        mob_metrics['elapsed_seconds'] = elapsed
    return {
        'raw': raw_metrics,
        'mobile': mob_metrics,
        'elapsed_seconds': elapsed,
        'plate_base_added': True,
        'publication_eligible': False,
    }


def _decimate_vertex_cluster(vertices: np.ndarray, faces: np.ndarray, target_faces: int) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic fallback mesh decimation by voxel vertex clustering.

    Returns the smallest mesh the clustering can reach, never the unchanged input when a target below
    its face count was requested: the previous six-round loop fell through to `return vertices, faces`,
    so Kaggle `benchmark-a/4` exported 5,445,228-face "mobile" GLBs (225-354 MB) while claiming
    `mobile_status=available`. A result still above `target_faces` is returned as measured, and
    :func:`bake_photographic_uv_pbr_glb` then omits the mobile artifact instead of shipping it.
    """
    source_vertices = np.asarray(vertices, dtype=np.float32)
    source_faces = np.asarray(faces, dtype=np.uint32)
    if len(source_faces) <= target_faces:
        return source_vertices, source_faces
    if target_faces < 4:
        raise ValueError(f'Cannot decimate to {target_faces} faces; a closed mesh needs at least 4.')
    bmin = source_vertices.min(axis=0)
    span = max(1e-5, float((source_vertices.max(axis=0) - bmin).max()))
    bins = max(18, int(round(math.sqrt(target_faces * 0.48))))
    best_v = None
    best_f = None
    for _ in range(64):
        q = np.floor(((source_vertices - bmin) / span) * bins).astype(np.int64)
        _, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
        new_v = np.zeros((len(counts), 3), dtype=np.float64)
        np.add.at(new_v, inv, source_vertices)
        new_v /= counts[:, None]
        nf = inv[source_faces]
        valid = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 2] != nf[:, 0])
        nf = nf[valid]
        if best_f is None or len(nf) < len(best_f):
            best_v, best_f = new_v.astype(np.float32), nf.astype(np.uint32)
        if len(nf) <= target_faces or bins <= 4:
            return best_v, best_f
        bins = max(4, int(bins * 0.82))
    return best_v, best_f


def bake_photographic_uv_pbr_glb(
    vertices: np.ndarray,
    faces: np.ndarray,
    cutout_rgba_path: Path,
    out_glb_path: Path,
    mobile_glb_path: Path | None = None,
    *,
    texture_size: int = 1536,
    max_mobile_faces: int = MAX_MOBILE_FACES,
) -> dict[str, Any]:
    """Project captured photo `cutout_rgba.png` onto an arbitrary untextured 3D mesh and export GLB(s)."""
    t0 = time.perf_counter()
    v = np.asarray(vertices, dtype=np.float32).copy()
    f = np.asarray(faces, dtype=np.uint32).copy()
    if len(v) == 0 or len(f) == 0:
        raise ValueError('Cannot bake UVs onto empty geometry.')

    # Normalize onto tabletop centered XZ, resting at Y=0
    vmin, vmax = v.min(axis=0), v.max(axis=0)
    span = max(1e-5, float((vmax - vmin).max()))
    v = (v - np.array([0.5 * (vmin[0] + vmax[0]), vmin[1], 0.5 * (vmin[2] + vmax[2])], dtype=np.float32)) * (1.8 / span)

    with Image.open(cutout_rgba_path) as im:
        rgba = ImageOps.exif_transpose(im).convert('RGBA')
    rgba_arr = np.asarray(rgba, dtype=np.uint8)
    ys, xs = np.where(rgba_arr[..., 3] > 20)
    if len(xs):
        u_min, u_max = xs.min() / max(1, rgba_arr.shape[1] - 1), xs.max() / max(1, rgba_arr.shape[1] - 1)
        v_min, v_max = ys.min() / max(1, rgba_arr.shape[0] - 1), ys.max() / max(1, rgba_arr.shape[0] - 1)
        fg_rgb = np.median(rgba_arr[ys, xs, :3], axis=0).astype(np.uint8)
        ceramic_rgb = (int(fg_rgb[0]), int(fg_rgb[1]), int(fg_rgb[2]))
    else:
        u_min, u_max, v_min, v_max = 0.1, 0.9, 0.1, 0.9
        ceramic_rgb = (210, 205, 198)

    atlas_raw, _ = _compose_atlas_with_ceramic_band(cutout_rgba_path, ceramic_rgb, max_tex_dim=texture_size)
    uv_h_scale = (atlas_raw.height - 16) / float(atlas_raw.height)
    swatch_v = (atlas_raw.height - 8) / float(atlas_raw.height)

    def _project_uvs(verts: np.ndarray, tris: np.ndarray) -> np.ndarray:
        norms = _ensure_vec3_normals(verts, tris)
        vx0, vx1 = float(verts[:, 0].min()), float(verts[:, 0].max())
        vz0, vz1 = float(verts[:, 2].min()), float(verts[:, 2].max())
        u = u_min + ((verts[:, 0] - vx0) / max(1e-5, vx1 - vx0)) * (u_max - u_min)
        vv = (v_min + ((verts[:, 2] - vz0) / max(1e-5, vz1 - vz0)) * (v_max - v_min)) * uv_h_scale
        uv = np.stack([np.clip(u, 0.0, 1.0), np.clip(vv, 0.0, uv_h_scale)], axis=1).astype(np.float32)
        # Underside downward normals point to clean ceramic swatch instead of top stretching
        under = norms[:, 1] < -0.25
        uv[under] = np.array([0.5, swatch_v], dtype=np.float32)
        return uv

    uv_raw = _project_uvs(v, f)
    raw_metrics = write_pbr_glb(
        v,
        f,
        uv_raw,
        atlas_raw,
        out_glb_path,
        roughness=0.50,
        extras={'backend': 'photographic-uv-baker'},
    )

    mob_metrics: dict[str, Any] | None = None
    mobile_error: str | None = None
    if mobile_glb_path is not None:
        try:
            vm, fm = _decimate_vertex_cluster(v, f, max_mobile_faces)
            if len(fm) > max_mobile_faces:
                raise ValueError(
                    f'Cannot decimate {len(f)} faces to {max_mobile_faces} by vertex clustering '
                    f'(best {len(fm)}); refusing to export an oversized mobile GLB.'
                )
        except ValueError as exc:
            # A mobile export that cannot honour the face ceiling is omitted and reported, so a
            # raw-resolution mesh is never shipped as a <=35k mobile artifact.
            mobile_error = f'{type(exc).__name__}: {exc}'
            Path(mobile_glb_path).unlink(missing_ok=True)
        else:
            uv_m = _project_uvs(vm, fm)
            atlas_mob, _ = _compose_atlas_with_ceramic_band(cutout_rgba_path, ceramic_rgb, max_tex_dim=1024)
            mob_metrics = write_pbr_glb(
                vm,
                fm,
                uv_m,
                atlas_mob,
                mobile_glb_path,
                roughness=0.50,
                image_format='JPEG',
                extras={'backend': 'photographic-uv-baker-mobile'},
            )

    elapsed = round(time.perf_counter() - t0, 3)
    raw_metrics['elapsed_seconds'] = elapsed
    if mob_metrics is not None:
        mob_metrics['elapsed_seconds'] = elapsed
    return {
        'raw': raw_metrics,
        'mobile': mob_metrics,
        'mobile_error': mobile_error,
        'elapsed_seconds': elapsed,
        'publication_eligible': False,
    }


def infer_moge2_maps(
    image_rgb: Image.Image,
    device: str | None = None,
    model_cache: dict[str, Any] | None = None,
) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Lazy GPU helper for `Ruicheng/moge-2-vitl-normal`; returns `(None, None)` cleanly if offline."""
    try:
        import torch
        from moge.model.v2 import MoGeModel
    except Exception:
        return None, None

    dev = device or ('cuda' if torch.cuda.is_available() else 'cpu')
    model = None if model_cache is None else model_cache.get('moge2')
    if model is None:
        model = MoGeModel.from_pretrained('Ruicheng/moge-2-vitl-normal').to(dev).eval()
        if model_cache is not None:
            model_cache['moge2'] = model

    arr = np.asarray(image_rgb.convert('RGB'), dtype=np.float32) / 255.0
    ten = torch.tensor(arr, dtype=torch.float32, device=dev).permute(2, 0, 1)
    with torch.no_grad():
        out = model.infer(ten)
    depth = (
        _sanitize_depth_map(out['depth'].detach().cpu().numpy())
        if 'depth' in out and out['depth'] is not None else None
    )
    normal = (
        _sanitize_normal_map(out['normal'].detach().cpu().numpy())
        if 'normal' in out and out['normal'] is not None else None
    )
    return depth, normal


def _extract_cutout_from_image_and_mask(src_path: Path, mask_path: Path | None, out_cutout: Path) -> dict[str, Any]:
    """Bind native `_mask.png` if present, else compute corner-background color distance matte."""
    with Image.open(src_path) as im:
        rgb = ImageOps.exif_transpose(im).convert('RGB')
    w, h = rgb.size
    arr = np.asarray(rgb, dtype=np.float32)

    if mask_path is not None and mask_path.is_file():
        with Image.open(mask_path) as mm:
            m = ImageOps.exif_transpose(mm).convert('L')
        if m.size != (w, h):
            m = m.resize((w, h), Image.Resampling.BILINEAR)
        alpha = np.asarray(m, dtype=np.uint8)
        method = 'precomputed_pdf_smask'
        plate_preserved = True
    else:
        # Border color matte fallback for unmasked photos
        pad = max(6, min(w, h) // 25)
        corners = np.concatenate([
            arr[:pad, :pad].reshape(-1, 3),
            arr[:pad, -pad:].reshape(-1, 3),
            arr[-pad:, :pad].reshape(-1, 3),
            arr[-pad:, -pad:].reshape(-1, 3),
        ], axis=0)
        bg = np.median(corners, axis=0)
        dist = np.linalg.norm(arr - bg.reshape(1, 1, 3), axis=2)
        alpha = np.where(dist > 28.0, 255, 0).astype(np.uint8)
        # Keep center safe if low-contrast rim
        if np.mean(alpha > 128) < 0.12:
            yy, xx = np.mgrid[0:h, 0:w]
            ell = (((yy - h / 2) / (0.42 * h)) ** 2 + ((xx - w / 2) / (0.42 * w)) ** 2) <= 1.0
            alpha = np.where(ell, 255, 0).astype(np.uint8)
        method = 'border_color_matte'
        plate_preserved = True

    rgba = np.dstack([arr.astype(np.uint8), alpha])
    Image.fromarray(rgba, mode='RGBA').save(out_cutout, format='PNG', optimize=True)
    cov = round(float(np.mean(alpha > 128) * 100.0), 2)
    return {
        'plate_preserved': plate_preserved,
        'plate_added_pct': 0.0,
        'plate_method': method,
        'fg_coverage_pct': cov,
    }


def run_local_moge2_relief_batch(
    dataset_dir: Path,
    out_dir: Path,
    *,
    v31_results_dir: Path | None = None,
    max_dishes: int = 64,
) -> dict[str, Any]:
    """Run local `moge2-relief` relief+ceramic-plate generation across all dishes & merge v31 TRELLIS outputs."""
    dataset_dir = Path(dataset_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    meta_by_label: dict[str, dict[str, Any]] = {}
    dm_path = dataset_dir / 'dishes_manifest.json'
    if dm_path.is_file():
        for rec in json.loads(dm_path.read_text(encoding='utf-8')).get('dishes', []):
            meta_by_label[rec['label']] = rec

    v31_manifest: dict[str, Any] = {}
    if v31_results_dir is not None and (Path(v31_results_dir) / 'manifest.json').is_file():
        v31_manifest = json.loads((Path(v31_results_dir) / 'manifest.json').read_text(encoding='utf-8'))

    images = sorted(
        (
            p for p in dataset_dir.iterdir()
            if p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and not p.stem.endswith('_mask')
        ),
        key=lambda p: p.name,
    )[:max_dishes]

    inputs_manifest: dict[str, Any] = {}
    runs_3d: dict[str, Any] = {}

    for src in images:
        label = src.stem
        dish_dir = out_dir / label
        dish_dir.mkdir(parents=True, exist_ok=True)

        input_dst = dish_dir / STAGED_INPUT_NAME
        staging = stage_source_image(src, input_dst)
        img_size = staging['size']

        cutout_dst = dish_dir / 'cutout_rgba.png'
        v31_in = (v31_manifest.get('inputs') or {}).get(label)
        v31_cut = Path(v31_results_dir) / label / 'cutout_rgba.png' if v31_results_dir else None
        if v31_in and v31_cut and v31_cut.is_file():
            shutil.copy2(v31_cut, cutout_dst)
            cutout_metrics = v31_in.get('cutout_metrics') or {}
        else:
            mask_cand = dataset_dir / f'{label}_mask.png'
            cutout_metrics = _extract_cutout_from_image_and_mask(src, mask_cand if mask_cand.is_file() else None, cutout_dst)

        meta = meta_by_label.get(label, {})
        jm = {
            'job_id': f'rd-{label}',
            'dish_label': label,
            'publication_eligible': False,
            'source_sha256': staging['source_sha256'],
            'source_bytes': staging['source_bytes'],
            'input_filename': staging['input_filename'],
            'input_image_sha256': staging['input_image_sha256'],
            'input_bytes': staging['input_bytes'],
            'input_transformation': staging['input_transformation'],
            'input_byte_identical': staging['input_byte_identical'],
        }
        (dish_dir / 'job_manifest.json').write_text(json.dumps(jm, indent=2), encoding='utf-8')

        inputs_manifest[label] = {
            'label': label,
            'title': meta.get('title') or label.replace('_', ' ').title(),
            'tier': meta.get('tier') or 'custom',
            'page': meta.get('page'),
            'image_source': meta.get('source') or 'user-uploaded-dataset',
            'image_status': 'success',
            'size': img_size,
            'source_sha256': staging['source_sha256'],
            'source_bytes': staging['source_bytes'],
            'input_filename': staging['input_filename'],
            'input_image_sha256': staging['input_image_sha256'],
            'input_bytes': staging['input_bytes'],
            'input_transformation': staging['input_transformation'],
            'input_byte_identical': staging['input_byte_identical'],
            'cutout_metrics': cutout_metrics,
            'artifacts': [
                {'path': f'{label}/input_image.png'},
                {'path': f'{label}/cutout_rgba.png'},
                {'path': f'{label}/job_manifest.json'},
            ],
        }

        # 1) Always build watertight MoGe-2 Relief + Ceramic Plate GLB
        raw_glb = dish_dir / 'moge2_relief.glb'
        mob_glb = dish_dir / 'moge2_relief_mobile.glb'
        moge_res = build_moge2_relief_and_ceramic_plate_glb(cutout_dst, raw_glb, mob_glb)
        runs_3d[f'{label}/moge2-relief'] = {
            'input_label': label,
            'backend': 'MoGe-2 Relief + Ceramic Plate',
            'license': 'MIT',
            'appearance': 'captured_photo_uv_pbr',
            'device': 'cpu-relief-prior',
            'status': 'success',
            'watertight': moge_res['raw']['watertight'],
            'elapsed_seconds': moge_res['elapsed_seconds'],
            'metrics': moge_res['raw'],
            'mobile_metrics': moge_res['mobile'],
            'artifacts': [
                {'path': f'{label}/moge2_relief.glb'},
                {'path': f'{label}/moge2_relief_mobile.glb'},
            ],
        }

        # 2) Preserve existing TRELLIS.2-4B runs from trellislast-version v31 if present
        v31_t_key = f'{label}/trellis2-4b'
        v31_t = (v31_manifest.get('runs_3d') or {}).get(v31_t_key)
        if v31_t and v31_t.get('status') == 'success' and v31_results_dir is not None:
            copied_arts = []
            for art in v31_t.get('artifacts') or []:
                rel = art.get('path')
                if not rel:
                    continue
                src_art = Path(v31_results_dir) / rel
                if src_art.is_file():
                    dst_art = out_dir / rel
                    dst_art.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src_art, dst_art)
                    copied_arts.append({'path': rel})
            if copied_arts:
                runs_3d[v31_t_key] = {**v31_t, 'license': 'MIT', 'artifacts': copied_arts}

    manifest = {
        'schema_version': 1,
        'demo_label': 'Private single-photo 3D demo (not published T0/T1/T2 menu evidence)',
        'publication_eligible': False,
        'plate_preservation_mode': 'preserve_plate',
        'inputs': inputs_manifest,
        'runs_3d': runs_3d,
    }
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset-dir', required=True, type=Path)
    parser.add_argument('--out-dir', required=True, type=Path)
    parser.add_argument('--v31-results-dir', default=None, type=Path)
    parser.add_argument('--max-dishes', default=64, type=int)
    args = parser.parse_args(argv)
    man = run_local_moge2_relief_batch(
        args.dataset_dir,
        args.out_dir,
        v31_results_dir=args.v31_results_dir,
        max_dishes=args.max_dishes,
    )
    print(f"Processed {len(man['inputs'])} dishes, {len(man['runs_3d'])} 3D runs -> {args.out_dir}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
