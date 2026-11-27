"""Extract plated food dish images and alpha masks from Noka Ramen menu PDF (GMn9C8.pdf)."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
from io import BytesIO
import json
from pathlib import Path

import numpy as np
from PIL import Image
import pymupdf


@dataclass(frozen=True)
class SmaskDishSpec:
    stem: str
    title: str
    page: int
    xref: int
    smask: int
    tier: str
    min_side: int = 512


@dataclass(frozen=True)
class CropDishSpec:
    stem: str
    title: str
    page: int
    xref: int
    crop_box: tuple[int, int, int, int]
    tier: str
    min_side: int = 512


SMASK_DISHES: tuple[SmaskDishSpec, ...] = (
    # Page 11 Signature Hero Dishes (high resolution with native artist cutouts)
    SmaskDishSpec('05_ikari_steak_ramen', 'Ikari Steak Ramen', 11, 706, 705, 'hero'),
    SmaskDishSpec('06_garlic_butter_shrimp', 'Garlic Butter Shrimp', 11, 735, 734, 'hero'),
    SmaskDishSpec('07_pikachu_burger', 'Pikachu Burger', 11, 688, 687, 'hero'),
    SmaskDishSpec('08_lobster_shio_ramen', 'Lobster Shio Ramen', 11, 640, 638, 'hero'),
    SmaskDishSpec('09_kuroshio_no_koki_ramen', 'Kuroshio No Koki Ramen', 11, 727, 726, 'hero'),
    SmaskDishSpec('10_short_rib_mazesoba', 'Short Rib Mazesoba', 11, 702, 701, 'hero'),
    SmaskDishSpec('11_loco_moco', 'Loco Moco', 11, 678, 677, 'hero'),
    SmaskDishSpec('12_tempura_ramen', 'Tempura Ramen', 11, 721, 720, 'hero'),
    SmaskDishSpec('13_crabby_ramen', 'Crabby Ramen', 11, 682, 681, 'hero'),
    SmaskDishSpec('14_a5_gold_chahan', 'A5 Gold Chahan Fried Rice', 11, 671, 670, 'hero'),
    # Page 10 Special Bento Combo (high resolution with native artist cutout)
    SmaskDishSpec('16_mafia_bento_box', 'Mafia Bento Box', 10, 563, 561, 'hero'),
    # Page 12 Appetizers, Kids Menu, and Classic Ramen Bowls (native cutouts, upscaled to >=512px)
    SmaskDishSpec('20_chicken_karaage', 'Chicken Karaage', 12, 807, 805, 'page12'),
    SmaskDishSpec('21_corn_ribs', 'Corn Ribs', 12, 854, 853, 'page12'),
    SmaskDishSpec('22_shishito_peppers', 'Shishito Peppers', 12, 932, 930, 'page12'),
    SmaskDishSpec('23_brussels_sprouts', 'Brussels Sprouts', 12, 840, 839, 'page12'),
    SmaskDishSpec('24_truffle_fries', 'Truffle Fries', 12, 847, 845, 'page12'),
    SmaskDishSpec('25_gyoza', 'Gyoza', 12, 863, 861, 'page12'),
    SmaskDishSpec('26_chashu_pork_bun', 'Chashu Pork Bun', 12, 913, 912, 'page12'),
    SmaskDishSpec('27_garlic_shoyu_beef_jerky', 'Garlic Shoyu Beef Jerky', 12, 939, 937, 'page12'),
    SmaskDishSpec('28_chamame', 'Chamame Edamame', 12, 966, 965, 'page12'),
    SmaskDishSpec('29_kakuni', 'Kakuni Braised Pork Belly', 12, 951, 950, 'page12'),
    SmaskDishSpec('30_mini_ramen', 'Mini Ramen', 12, 875, 874, 'page12'),
    SmaskDishSpec('31_mini_rice', 'Mini Rice', 12, 869, 868, 'page12'),
    SmaskDishSpec('32_classic_tonkotsu', 'Classic Tonkotsu', 12, 815, 814, 'page12'),
    SmaskDishSpec('33_black_garlic_tonkotsu', 'Black Garlic Tonkotsu', 12, 824, 822, 'page12'),
    SmaskDishSpec('34_spicy_miso_ramen', 'Spicy Miso Ramen', 12, 832, 831, 'page12'),
    SmaskDishSpec('35_tofu_ramen', 'Tofu Ramen', 12, 972, 971, 'page12'),
    SmaskDishSpec('36_gyoza_ramen', 'Gyoza Ramen', 12, 925, 924, 'page12'),
    SmaskDishSpec('37_shoyu_ramen', 'Shoyu Ramen', 12, 919, 918, 'page12'),
    SmaskDishSpec('38_clam_dashio_ramen', 'Clam Dashio Ramen', 12, 945, 944, 'page12'),
    SmaskDishSpec('39_tempura_ramen_bowl', 'Tempura Ramen Bowl', 12, 958, 956, 'page12'),
    SmaskDishSpec('40_chicken_karamen', 'Chicken Karamen', 12, 978, 977, 'page12'),
    SmaskDishSpec('41_itamemono_ramen', 'Itamemono Ramen', 12, 982, 981, 'page12'),
)

CROP_DISHES: tuple[CropDishSpec, ...] = (
    CropDishSpec('15_zaru_ramen', 'Zaru Ramen', 7, 370, (10, 260, 996, 1110), 'hero'),
    CropDishSpec('17_green_tea_tiramisu', 'Green Tea Tiramisu', 14, 1244, (245, 860, 582, 1115), 'hero'),
    CropDishSpec('18_choco_cake_ice_cream', 'Choco Cake & Ice Cream', 14, 1244, (35, 985, 465, 1255), 'hero'),
    CropDishSpec('19_fried_ice_cream_sandwich', 'Fried Ice Cream Sandwich', 14, 1244, (485, 958, 1008, 1255), 'hero'),
)

_SLATE_BG = (28, 34, 44)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _derived_image_identity(derived_path: Path, source_bytes: bytes, steps: list[str]) -> dict:
    """Declare the derived file digest beside the identity of the bytes it was derived from.

    `sha256` keeps naming the on-disk dataset file (what downstream staging reads), while
    `original_sha256` preserves the repository photo identity captured before any decode or
    re-encode, so the chain original -> dataset -> staged artifact stays complete.
    """
    return {
        'sha256': _sha256_file(derived_path),
        'original_sha256': _sha256_bytes(source_bytes),
        'derived_transformation': '+'.join(steps),
    }


def _tight_alpha_crop_and_upscale(
    rgb: Image.Image,
    alpha: Image.Image,
    min_side: int = 512,
    pad_frac: float = 0.08,
    steps: list[str] | None = None,
) -> tuple[Image.Image, Image.Image]:
    """Tightly crop to alpha>8 with margin, composite cleanly on dark slate, and upscale if small.

    `steps`, when given, collects the names of the transformations actually applied.
    """
    a_np = np.array(alpha, dtype=np.uint8)
    ys, xs = np.where(a_np > 8)
    if len(xs) == 0 or len(ys) == 0:
        raise ValueError('Empty alpha mask extracted from PDF stream.')
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    bw, bh = x1 - x0, y1 - y0
    pad = max(12, int(round(max(bw, bh) * pad_frac)))

    # Paste onto padded dark-slate canvas so even edge-touching rims get uniform margin
    crop_rgb = rgb.crop((x0, y0, x1, y1)).convert('RGBA')
    crop_a = alpha.crop((x0, y0, x1, y1)).convert('L')
    crop_rgb.putalpha(crop_a)
    if steps is not None:
        steps.extend(['crop_to_alpha', 'slate_composite'])

    canvas_w = bw + 2 * pad
    canvas_h = bh + 2 * pad
    bg = Image.new('RGBA', (canvas_w, canvas_h), (*_SLATE_BG, 255))
    fg_canvas = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    fg_canvas.paste(crop_rgb, (pad, pad))
    composited = Image.alpha_composite(bg, fg_canvas).convert('RGB')

    mask_canvas = Image.new('L', (canvas_w, canvas_h), 0)
    mask_canvas.paste(crop_a, (pad, pad))

    if min(canvas_w, canvas_h) < min_side:
        scale = min_side / max(1, min(canvas_w, canvas_h))
        new_size = (int(round(canvas_w * scale)), int(round(canvas_h * scale)))
        composited = composited.resize(new_size, Image.Resampling.LANCZOS)
        mask_canvas = mask_canvas.resize(new_size, Image.Resampling.BILINEAR)
        if steps is not None:
            steps.append('upscale')
    if steps is not None:
        steps.append('png_encode')
    return composited, mask_canvas


def _compose_smask_record(spec: SmaskDishSpec, image_stream: bytes, mask_stream: bytes, out_dir: Path) -> dict:
    """Crop/composite one native-cutout dish and declare both the stream and derived identities."""
    rgb = Image.open(BytesIO(image_stream)).convert('RGB')
    alpha = Image.open(BytesIO(mask_stream)).convert('L')
    if alpha.size != rgb.size:
        alpha = alpha.resize(rgb.size, Image.Resampling.BILINEAR)

    steps: list[str] = []
    img_out, mask_out = _tight_alpha_crop_and_upscale(rgb, alpha, min_side=spec.min_side, steps=steps)
    img_path = out_dir / f'{spec.stem}.png'
    mask_path = out_dir / f'{spec.stem}_mask.png'
    img_out.save(img_path, format='PNG', optimize=True)
    mask_out.save(mask_path, format='PNG', optimize=True)
    return {
        'label': spec.stem,
        'title': spec.title,
        'source': 'GMn9C8.pdf',
        'page': spec.page,
        'tier': spec.tier,
        'has_native_mask': True,
        'image_file': img_path.name,
        'mask_file': mask_path.name,
        'size': list(img_out.size),
        **_derived_image_identity(img_path, image_stream, steps),
        'mask_sha256': _sha256_file(mask_path),
        'original_mask_sha256': _sha256_bytes(mask_stream),
    }


def _compose_crop_record(spec: CropDishSpec, image_stream: bytes, out_dir: Path) -> dict:
    """Crop/upscale one opaque dish and declare both the stream and derived identities."""
    rgb = Image.open(BytesIO(image_stream)).convert('RGB')
    x0, y0, x1, y1 = spec.crop_box
    cropped = rgb.crop((
        max(0, x0),
        max(0, y0),
        min(rgb.width, x1),
        min(rgb.height, y1),
    ))
    steps = ['crop', 'png_encode']
    if min(cropped.size) < spec.min_side:
        scale = spec.min_side / max(1, min(cropped.size))
        cropped = cropped.resize(
            (int(round(cropped.width * scale)), int(round(cropped.height * scale))),
            Image.Resampling.LANCZOS,
        )
        steps.insert(1, 'upscale')
    img_path = out_dir / f'{spec.stem}.png'
    cropped.save(img_path, format='PNG', optimize=True)
    return {
        'label': spec.stem,
        'title': spec.title,
        'source': 'GMn9C8.pdf',
        'page': spec.page,
        'tier': spec.tier,
        'has_native_mask': False,
        'image_file': img_path.name,
        'mask_file': None,
        'size': list(cropped.size),
        **_derived_image_identity(img_path, image_stream, steps),
    }


def _benchmark_record(photo_path: Path, mask_path: Path | None) -> dict:
    """Declare a pre-existing 01..04 benchmark photo, whose own bytes are the source identity."""
    with Image.open(photo_path) as im:
        size = list(im.size)
    return {
        'label': photo_path.stem,
        'title': photo_path.stem.split('_', 1)[-1].replace('_', ' ').title(),
        'source': 'original_benchmark',
        'page': None,
        'tier': 'benchmark_4',
        'has_native_mask': mask_path is not None,
        'image_file': photo_path.name,
        'mask_file': mask_path.name if mask_path is not None else None,
        'size': size,
        'sha256': _sha256_file(photo_path),
        # No extraction hop produced this file, so the original bytes and the dataset bytes are one object.
        'original_sha256': _sha256_file(photo_path),
        'derived_transformation': 'none',
    }


def extract_menu_dishes(pdf_path: Path, out_dir: Path) -> list[dict]:
    """Extract all GMn9C8.pdf dishes + optional sibling `_mask.png` into `out_dir`."""
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(str(pdf_path))
    records: list[dict] = []

    try:
        for spec in SMASK_DISHES:
            rgb_raw = doc.extract_image(spec.xref)
            mask_raw = doc.extract_image(spec.smask)
            records.append(_compose_smask_record(spec, rgb_raw['image'], mask_raw['image'], out_dir))

        for spec in CROP_DISHES:
            raw = doc.extract_image(spec.xref)
            records.append(_compose_crop_record(spec, raw['image'], out_dir))
    finally:
        doc.close()

    # Record existing 01..04 benchmark dishes if present so manifest covers the full dataset
    existing_benchmarks = []
    for p in sorted(out_dir.iterdir()):
        if (
            p.is_file()
            and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')
            and not p.stem.endswith('_mask')
            and p.stem[:2] in ('01', '02', '03', '04')
        ):
            mask_path = out_dir / f'{p.stem}_mask.png'
            existing_benchmarks.append(_benchmark_record(p, mask_path if mask_path.is_file() else None))

    full_records = existing_benchmarks + sorted(records, key=lambda r: r['label'])
    (out_dir / 'dishes_manifest.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'count': len(full_records),
                'dishes': full_records,
            },
            indent=2,
        ),
        encoding='utf-8',
    )
    return full_records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, default=Path('/home/yacine105/Menus/GMn9C8.pdf'))
    parser.add_argument('--out-dir', type=Path, default=Path('/tmp/peekaplate-dish-dataset'))
    args = parser.parse_args(argv)
    recs = extract_menu_dishes(args.pdf, args.out_dir)
    print(f'Extracted {len(recs)} total dishes into {args.out_dir}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
