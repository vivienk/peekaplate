"""Exp0 (2026-11-24): compose turntable frames into contact sheets.

python contact_sheet.py <exp0_dir> <dish>... [--blind]

Labelled sheet: one row per condition, 4 azimuths, with the source photo in the corner.
Blind sheet (--blind): the four textured conditions per dish shuffled under letters
(seeded by dish name); the answer key is written to blind_key.json, kept apart from the sheet.
Private R&D, publication_eligible: false.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

VIEWS = (0, 90, 180, 270)
ROWS = (
    'A_shared_mobile_unlit',
    'B_full_lit',
    'C_clean_150k_lit',
    'Cm_clean_35k_lit',
    'D_clean_150k_coat',
    'clay_full',
    'clay_150k',
)
BLIND = ('A_shared_mobile_unlit', 'B_full_lit', 'C_clean_150k_lit', 'D_clean_150k_coat')
TILE = 320
LABEL_W = 210


def font(size: int) -> ImageFont.ImageFont:
    for name in ('DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/noto/NotoSans-Regular.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheet(frames: Path, src_photo: Path, rows: list[tuple[str, str]], title: str) -> Image.Image:
    w = LABEL_W + TILE * len(VIEWS)
    h = 48 + TILE * len(rows)
    img = Image.new('RGB', (w, h), (245, 243, 239))
    d = ImageDraw.Draw(img)
    d.text((12, 12), title, fill=(20, 20, 20), font=font(22))
    for r, (cond, label) in enumerate(rows):
        y = 48 + r * TILE
        d.text((12, y + TILE - 48), label, fill=(20, 20, 20), font=font(20))
        for c, az in enumerate(VIEWS):
            tile = Image.open(frames / f'{cond}_az{az}.png').convert('RGB').resize((TILE, TILE))
            img.paste(tile, (LABEL_W + c * TILE, y))
    if src_photo.exists():
        ph = Image.open(src_photo).convert('RGB')
        ph.thumbnail((LABEL_W - 16, LABEL_W - 16))
        img.paste(ph, (8, 48 + 4))
    return img


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('root')
    p.add_argument('dishes', nargs='+')
    p.add_argument('--blind', action='store_true')
    a = p.parse_args()
    root = Path(a.root)
    key: dict[str, dict[str, str]] = {}
    key_path = root / 'blind_key.json'
    if key_path.exists():
        key = json.loads(key_path.read_text())
    for dish in a.dishes:
        frames = root / dish / 'frames'
        photo = root / '_src' / dish / 'input_image.png'
        labelled = sheet(frames, photo, [(c, c.replace('_', ' ')) for c in ROWS], f'{dish} (labelled, private R&D)')
        labelled.save(root / dish / 'sheet_labelled.png', optimize=True)
        if a.blind:
            order = list(BLIND)
            random.Random(dish).shuffle(order)
            letters = 'PQRS'
            key[dish] = {letters[i]: cond for i, cond in enumerate(order)}
            blind = sheet(frames, photo, [(cond, f'version {letters[i]}') for i, cond in enumerate(order)], f'{dish}: rate each version 1-5')
            blind.save(root / f'blind_{dish}.png', optimize=True)
    if a.blind:
        key_path.write_text(json.dumps(key, indent=2) + '\n')


if __name__ == '__main__':
    main()
