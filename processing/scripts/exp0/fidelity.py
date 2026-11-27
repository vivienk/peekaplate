"""Exp0 fidelity score (2026-11-24): how well does a mesh match its source photo?

python fidelity.py <cutout_rgba.png> <renders_dir> [--out result.json]

For each pose rendered by fidelity_renders.mjs (unlit, transparent background), both the
photo cutout and the render are cropped to their alpha bounding boxes and uniformly scaled
into one frame, centred. Scores at the best pose (max silhouette IoU):
- silhouette_iou: shape agreement of the outline (1 = identical)
- delta_e: mean CIE76 colour difference over the overlap (lower is better; <10 is close)
- detail_corr: correlation of gradient magnitude over the overlap (texture/structure agreement)

The pose is chosen by match = silhouette_iou - delta_e/100 - (1 - detail_corr)/4, so colour and
structure break ties that silhouettes alone cannot (a round bowl and a square tray both fill
their bounding boxes). These are a QA screen, not a perceptual verdict: a mesh can match the front silhouette and
still have a wrong back. Private R&D, publication_eligible: false.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

FRAME = 224


def load_rgba(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGBA')).astype(np.float32) / 255.0


def normalise(rgba: np.ndarray) -> np.ndarray:
    """Crop to alpha bbox, scale the longer side to FRAME, centre on a FRAME x FRAME canvas."""
    alpha = rgba[..., 3] > 0.5
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        return np.zeros((FRAME, FRAME, 4), np.float32)
    crop = rgba[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    h, w = crop.shape[:2]
    s = FRAME / max(h, w)
    nh, nw = max(1, round(h * s)), max(1, round(w * s))
    img = Image.fromarray((crop * 255).astype(np.uint8), 'RGBA').resize((nw, nh), Image.LANCZOS)
    canvas = np.zeros((FRAME, FRAME, 4), np.float32)
    oy, ox = (FRAME - nh) // 2, (FRAME - nw) // 2
    canvas[oy : oy + nh, ox : ox + nw] = np.asarray(img).astype(np.float32) / 255.0
    return canvas


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def grad_mag(rgb: np.ndarray) -> np.ndarray:
    g = rgb @ np.array([0.299, 0.587, 0.114])
    gy, gx = np.gradient(g)
    return np.hypot(gx, gy)


def score(photo: np.ndarray, render: np.ndarray) -> dict:
    pa, ra = photo[..., 3] > 0.5, render[..., 3] > 0.5
    inter, union = pa & ra, pa | ra
    iou = float(inter.sum() / max(union.sum(), 1))
    if inter.sum() < 50:
        return {'silhouette_iou': iou, 'delta_e': None, 'detail_corr': None}
    de = np.linalg.norm(srgb_to_lab(photo[..., :3]) - srgb_to_lab(render[..., :3]), axis=-1)[inter]
    gp, gr = grad_mag(photo[..., :3])[inter], grad_mag(render[..., :3])[inter]
    corr = float(np.corrcoef(gp, gr)[0, 1]) if gp.std() > 0 and gr.std() > 0 else 0.0
    return {'silhouette_iou': iou, 'delta_e': float(de.mean()), 'detail_corr': corr}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('cutout')
    p.add_argument('renders')
    p.add_argument('--out')
    a = p.parse_args()
    photo = normalise(load_rgba(Path(a.cutout)))
    rdir = Path(a.renders)
    meta = json.loads((rdir / 'poses.json').read_text())
    best = None
    for pose in meta['poses']:
        s = score(photo, normalise(load_rgba(rdir / pose['file'])))
        if s['delta_e'] is None:
            continue
        s['match'] = s['silhouette_iou'] - s['delta_e'] / 100 - (1 - s['detail_corr']) / 4
        if best is None or s['match'] > best['match']:
            best = {**s, 'az': pose['az'], 'el': pose['el']}
    result = {
        'publication_eligible': False,
        'cutout': a.cutout,
        'glb': meta['glb'],
        'best_pose': {'az': best['az'], 'el': best['el']},
        'match': round(best['match'], 4),
        'silhouette_iou': round(best['silhouette_iou'], 4),
        'delta_e': None if best['delta_e'] is None else round(best['delta_e'], 2),
        'detail_corr': None if best['detail_corr'] is None else round(best['detail_corr'], 4),
    }
    text = json.dumps(result, indent=2)
    if a.out:
        Path(a.out).write_text(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
