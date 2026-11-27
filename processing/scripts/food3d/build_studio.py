"""Food3D V1 Stage 5: Comparison Contact Sheet & Interactive Local Multi-Dish Studio.

CLI:
  python build_studio.py <out_dir> [--dishes <dish1> <dish2> ...] [--exp0-dir <dir>]

Produces:
  - <out_dir>/<dish>/comparison_sheet.png (QA header + photo/cutout/PBR masks + turntables)
  - <out_dir>/studio.html (zero-CDN interactive local studio with Light Angle slider,
    variant toggles, diagnostic modes, QA metrics, and localStorage 1-5 ratings export)

Every output stays private R&D: publication_eligible: false (ADR 0004).
"""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageOps

TILE_SIZE = 256
VIEWS = (0, 90, 180, 270)
TURNTABLE_ROWS = [
    ('A_unlit_mobile', 'A: Unlit Mobile (Raw)'),
    ('C_exp0_clean_150k', 'C: Exp0 Clean 150k'),
    ('E_v1_pbr_150k', 'E: V1 PBR 150k'),
    ('Em_v1_pbr_35k', 'Em: V1 PBR 35k'),
    ('E_relit_120', 'E: V1 Relit +120 deg'),
    ('E_clay_150k', 'E: V1 Clay 150k'),
]


def _load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if path.exists():
        return json.loads(path.read_text(encoding='utf-8'))
    return None


def _find_source_photo(out_dir: Path, dish: str) -> Path | None:
    dish_dir = out_dir / dish
    candidates = [
        dish_dir / 'source_photo.jpg',
        dish_dir / 'source_photo.jpeg',
        dish_dir / 'source_photo.png',
        dish_dir / 'source_photo.webp',
        dish_dir / 'input.jpg',
        dish_dir / 'input.png',
        out_dir / '_raw' / dish / 'input.jpg',
        out_dir / '_raw' / dish / 'input.png',
    ]
    for p in candidates:
        if p.exists():
            return p
    for pattern in ('source_photo.*', 'input.*'):
        matches = sorted(dish_dir.glob(pattern))
        if matches:
            return matches[0]
    return None


def _fit_tile(img_path: Path | None, size: int, label: str = 'missing') -> Image.Image:
    bg = (232, 229, 223)
    if img_path is None or not img_path.exists():
        tile = Image.new('RGB', (size, size), (42, 42, 46))
        draw = ImageDraw.Draw(tile)
        draw.rectangle([1, 1, size - 2, size - 2], outline=(76, 76, 82))
        draw.text((12, size // 2 - 6), f'[{label}]', fill=(155, 152, 146))
        return tile

    img = Image.open(img_path)
    if img.mode in ('RGBA', 'LA'):
        rgba = img.convert('RGBA')
        base = Image.new('RGBA', rgba.size, (*bg, 255))
        base.alpha_composite(rgba)
        rgb = base.convert('RGB')
    else:
        rgb = img.convert('RGB')
    contained = ImageOps.contain(rgb, (size, size), Image.LANCZOS)
    canvas = Image.new('RGB', (size, size), bg)
    ox = (size - contained.width) // 2
    oy = (size - contained.height) // 2
    canvas.paste(contained, (ox, oy))
    return canvas


def _fmt_mb(path: Path) -> str:
    if not path.exists():
        return 'n/a'
    return f'{path.stat().st_size / (1024 * 1024):.2f} MB'


def _extract_dish_metrics(out_dir: Path, dish: str) -> dict[str, Any]:
    dish_dir = out_dir / dish
    qa = _load_json_if_exists(dish_dir / 'qa_report.json') or {}
    checks = qa.get('checks', {})
    pbr = checks.get('pbr_material', {})
    fid = checks.get('photo_fidelity', {})
    relit = checks.get('relighting', {})

    return {
        'dish': dish,
        'publication_eligible': False,
        'mb_150k': _fmt_mb(dish_dir / 'lod_150k_2048.pbr.glb'),
        'mb_35k': _fmt_mb(dish_dir / 'lod_35k_1024.pbr.glb'),
        'roughness_std': pbr.get('roughness_std'),
        'clearcoat_std': pbr.get('clearcoat_std'),
        'iou': fid.get('silhouette_iou'),
        'delta_e': fid.get('delta_e'),
        'ssim': fid.get('ssim'),
        'relit_p95': relit.get('relit_p95_diff'),
        'verdict': qa.get('verdict', 'UNKNOWN'),
        'reasons': qa.get('reasons', []),
        'warnings': qa.get('warnings', []),
        'qa': qa,
    }


def build_comparison_sheet(out_dir: Path, dish: str) -> Path:
    """Build <out_dir>/<dish>/comparison_sheet.png with QA header, strips, and turntables."""
    dish_dir = out_dir / dish
    frames_dir = dish_dir / 'frames'
    m = _extract_dish_metrics(out_dir, dish)

    # Determine which turntable rows have at least one frame (skip optional Exp0 if absent)
    active_rows: list[tuple[str, str]] = []
    for cond_id, title in TURNTABLE_ROWS:
        exists_any = any((frames_dir / f'{cond_id}_az{az}.png').exists() for az in VIEWS)
        if cond_id == 'C_exp0_clean_150k' and not exists_any:
            continue
        active_rows.append((cond_id, title))

    cols = 4
    pad = 12
    row_label_w = 180
    header_h = 68
    strip_label_h = 22
    top_strip_h = TILE_SIZE + strip_label_h
    grid_w = row_label_w + cols * TILE_SIZE + (cols + 1) * pad
    grid_h = (
        header_h
        + pad
        + top_strip_h
        + pad
        + len(active_rows) * (TILE_SIZE + pad)
        + pad
    )

    sheet = Image.new('RGB', (grid_w, grid_h), (24, 24, 27))
    draw = ImageDraw.Draw(sheet)

    # Header bar
    verdict = str(m['verdict'])
    v_color = (82, 204, 128) if verdict == 'PASS' else (238, 178, 72) if verdict == 'WARN' else (235, 92, 92)
    draw.rectangle([0, 0, grid_w, header_h], fill=(32, 32, 37))
    draw.text((pad, 10), f'Food3D V1 Comparison  |  {dish}', fill=(244, 240, 232))
    draw.text((grid_w - 220, 10), 'publication_eligible: false', fill=(180, 174, 164))

    def _f(val: Any, fmt: str = '{:.3f}') -> str:
        if val is None:
            return 'n/a'
        try:
            return fmt.format(val)
        except (TypeError, ValueError):
            return str(val)

    metrics_line = (
        f"150k: {m['mb_150k']}  |  35k: {m['mb_35k']}  |  "
        f"rough std: {_f(m['roughness_std'])}  |  IoU: {_f(m['iou'])}  |  "
        f"dE: {_f(m['delta_e'], '{:.1f}')}  |  SSIM: {_f(m['ssim'])}  |  "
        f"relit p95: {_f(m['relit_p95'], '{:.1f}')}  |  verdict: {verdict}"
    )
    draw.text((pad, 38), metrics_line, fill=v_color)

    # Top strip: Source Photo | Clean Cutout | PBR Masks Debug | Fidelity Diag
    y = header_h + pad
    draw.text((pad, y + TILE_SIZE // 2 - 6), 'Inputs & Diagnostics', fill=(215, 210, 202))
    top_items = [
        ('Source Photo', _find_source_photo(out_dir, dish)),
        ('Clean Cutout', dish_dir / 'cutout_clean.png'),
        ('PBR Masks Debug', dish_dir / 'pbr_150k' / 'pbr_masks_debug.png'),
        ('Fidelity Diag', dish_dir / 'fidelity_diag.png'),
    ]
    for c_idx, (title, path) in enumerate(top_items):
        x = row_label_w + pad + c_idx * (TILE_SIZE + pad)
        draw.text((x + 2, y), title, fill=(195, 190, 182))
        tile = _fit_tile(path, TILE_SIZE, label=title)
        sheet.paste(tile, (x, y + strip_label_h))

    y += top_strip_h + pad

    # Turntable rows
    for cond_id, title in active_rows:
        draw.text((pad, y + TILE_SIZE // 2 - 12), title, fill=(235, 231, 224))
        draw.text((pad, y + TILE_SIZE // 2 + 6), 'az: 0 / 90 / 180 / 270', fill=(148, 144, 138))
        for c_idx, az in enumerate(VIEWS):
            x = row_label_w + pad + c_idx * (TILE_SIZE + pad)
            fp = frames_dir / f'{cond_id}_az{az}.png'
            if cond_id == 'E_relit_120':
                relit_frame = frames_dir / f'E_v1_relit120_150k_az{az}.png'
                if relit_frame.is_file():
                    fp = relit_frame
            tile = _fit_tile(fp, TILE_SIZE, label=f'{cond_id} az{az}')
            sheet.paste(tile, (x, y))
        y += TILE_SIZE + pad

    out_path = dish_dir / 'comparison_sheet.png'
    sheet.save(out_path, format='PNG')
    return out_path


def _rel_if_exists(out_dir: Path, path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    try:
        return path.resolve().relative_to(out_dir.resolve()).as_posix()
    except ValueError:
        return None


def _collect_dish_manifest(out_dir: Path, dish: str, exp0_dir: Path | None) -> dict[str, Any]:
    dish_dir = out_dir / dish
    metrics = _extract_dish_metrics(out_dir, dish)

    # Resolve optional raw mobile & exp0 GLBs via relative paths inside out_dir
    raw_candidates = [
        out_dir / '_raw' / dish / 'raw_mobile.glb',
        out_dir / '_raw' / dish / 'trellis2_4b_hires_mobile.glb',
        dish_dir / 'raw_mobile.glb',
    ]
    raw_rel = next((_rel_if_exists(out_dir, p) for p in raw_candidates if p.exists()), None)

    exp0_candidates = [
        out_dir / '_exp0' / dish / 'lod_150k_2048.meshopt.glb',
        out_dir / '_exp0' / dish / 'lod_150k_2048.glb',
    ]
    if exp0_dir is not None:
        exp0_candidates.extend(
            [
                exp0_dir / dish / 'lod_150k_2048.meshopt.glb',
                exp0_dir / dish / 'lod_150k_2048.glb',
            ]
        )
    exp0_rel = next((_rel_if_exists(out_dir, p) for p in exp0_candidates if _rel_if_exists(out_dir, p)), None)

    variants = {
        'E_v1_150k': _rel_if_exists(out_dir, dish_dir / 'lod_150k_2048.pbr.glb'),
        'Em_v1_35k': _rel_if_exists(out_dir, dish_dir / 'lod_35k_1024.pbr.glb'),
        'A_raw_mobile': raw_rel,
        'C_exp0_150k': exp0_rel,
    }

    assets = {
        'source_photo': _rel_if_exists(out_dir, _find_source_photo(out_dir, dish)),
        'cutout_clean': _rel_if_exists(out_dir, dish_dir / 'cutout_clean.png'),
        'pbr_masks_debug': _rel_if_exists(out_dir, dish_dir / 'pbr_150k' / 'pbr_masks_debug.png'),
        'fidelity_diag': _rel_if_exists(out_dir, dish_dir / 'fidelity_diag.png'),
        'comparison_sheet': _rel_if_exists(out_dir, dish_dir / 'comparison_sheet.png'),
        'qa_report': _rel_if_exists(out_dir, dish_dir / 'qa_report.json'),
    }

    return {
        'dish': dish,
        'publication_eligible': False,
        'variants': variants,
        'assets': assets,
        'metrics': {
            'mb_150k': metrics['mb_150k'],
            'mb_35k': metrics['mb_35k'],
            'roughness_std': metrics['roughness_std'],
            'clearcoat_std': metrics['clearcoat_std'],
            'iou': metrics['iou'],
            'delta_e': metrics['delta_e'],
            'ssim': metrics['ssim'],
            'relit_p95': metrics['relit_p95'],
            'verdict': metrics['verdict'],
            'reasons': metrics['reasons'],
            'warnings': metrics['warnings'],
        },
    }


def build_studio_html(out_dir: Path, dishes_data: list[dict[str, Any]]) -> Path:
    """Write self-contained local <out_dir>/studio.html with zero external network links."""
    manifest_json = json.dumps(
        {
            'schema_version': 1,
            'publication_eligible': False,
            'dishes': dishes_data,
        },
        indent=2,
        ensure_ascii=False,
    )
    safe_json = (
        manifest_json.replace('<', '\\u003c')
        .replace('>', '\\u003e')
        .replace('&', '\\u0026')
        .replace('\u2028', '\\u2028')
        .replace('\u2029', '\\u2029')
    )

    html_doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PeekaPlate Food3D V1 Comparison Studio</title>
<style>
  :root {{
    --bg: #121316;
    --panel: #1a1c21;
    --panel-2: #22252c;
    --border: #2e323c;
    --text: #f2efe9;
    --muted: #9da1ab;
    --accent: #f0b35a;
    --pass: #4cc980;
    --warn: #ebb248;
    --fail: #eb5c5c;
  }}
  * {{ box-sizing: border-box; }}
  html, body {{
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
  }}
  .app {{
    display: grid;
    grid-template-columns: 1fr 370px;
    grid-template-rows: 52px 1fr;
    height: 100vh;
  }}
  header {{
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    gap: 12px;
  }}
  .brand {{
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }}
  .pill {{
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(240, 179, 90, 0.14);
    color: var(--accent);
    border: 1px solid rgba(240, 179, 90, 0.35);
    font-weight: 500;
  }}
  .dish-bar {{
    display: flex;
    align-items: center;
    gap: 8px;
  }}
  select, button {{
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 6px 10px;
    font-size: 12px;
    cursor: pointer;
  }}
  button:hover:not(:disabled) {{
    border-color: var(--accent);
  }}
  button:disabled {{
    opacity: 0.38;
    cursor: not-allowed;
  }}
  button.active {{
    background: var(--accent);
    border-color: var(--accent);
    color: #171410;
    font-weight: 600;
  }}
  .viewport-wrap {{
    position: relative;
    background: #d8d5cf;
    overflow: hidden;
  }}
  #viewer-frame {{
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }}
  aside {{
    background: var(--panel);
    border-left: 1px solid var(--border);
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }}
  .card {{
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 11px;
  }}
  .card h3 {{
    margin: 0 0 8px 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }}
  .btn-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }}
  .slider-row {{
    display: flex;
    align-items: center;
    gap: 10px;
  }}
  .slider-row input[type="range"] {{
    flex: 1;
    accent-color: var(--accent);
  }}
  .metrics-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 10px;
    font-size: 12px;
  }}
  .metric-k {{ color: var(--muted); }}
  .metric-v {{ font-weight: 600; text-align: right; }}
  .verdict-PASS {{ color: var(--pass); }}
  .verdict-WARN {{ color: var(--warn); }}
  .verdict-FAIL {{ color: var(--fail); }}
  .thumb-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }}
  .thumb {{
    background: #141518;
    border: 1px solid var(--border);
    border-radius: 7px;
    overflow: hidden;
    text-decoration: none;
    color: var(--muted);
    display: flex;
    flex-direction: column;
  }}
  .thumb img {{
    width: 100%;
    height: 112px;
    object-fit: contain;
    background: #e2dfd9;
    display: block;
  }}
  .thumb span {{
    padding: 4px 6px;
    font-size: 11px;
  }}
  .stars {{
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }}
  .star-btn {{
    flex: 1;
    padding: 7px 0;
    font-weight: 600;
  }}
  textarea {{
    width: 100%;
    min-height: 54px;
    background: #15171b;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 7px;
    font-family: inherit;
    font-size: 12px;
    resize: vertical;
  }}
  .reasons {{
    margin: 8px 0 0 0;
    padding-left: 16px;
    color: var(--muted);
    font-size: 11px;
  }}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand">
      <span>PeekaPlate Food3D V1 Studio</span>
      <span class="pill">publication_eligible: false</span>
    </div>
    <div class="dish-bar">
      <label for="dish-select">Dish:</label>
      <select id="dish-select"></select>
      <button id="export-ratings-btn" type="button">Export Ratings JSON</button>
    </div>
  </header>

  <main class="viewport-wrap">
    <iframe id="viewer-frame" title="Food3D V1 Interactive Viewer"></iframe>
  </main>

  <aside>
    <div class="card">
      <h3>Model Variant</h3>
      <div class="btn-grid" id="variant-buttons">
        <button data-variant="E_v1_150k">E: V1 PBR 150k</button>
        <button data-variant="Em_v1_35k">Em: V1 PBR 35k</button>
        <button data-variant="A_raw_mobile">A: Unlit Mobile</button>
        <button data-variant="C_exp0_150k">C: Exp0 Clean</button>
      </div>
    </div>

    <div class="card">
      <h3>Diagnostic Mode &amp; Light Angle</h3>
      <div class="btn-grid" id="mode-buttons" style="margin-bottom: 10px;">
        <button data-mode="lit">Lit PBR</button>
        <button data-mode="relit">Relit +120&deg;</button>
        <button data-mode="clay">Clay</button>
        <button data-mode="albedo">Albedo</button>
        <button data-mode="roughness">Roughness</button>
        <button data-mode="clearcoat">Clearcoat</button>
        <button data-mode="normal">Normal</button>
        <button data-mode="unlit">Unlit</button>
      </div>
      <div class="slider-row">
        <label for="studio-light-slider">Light</label>
        <input id="studio-light-slider" type="range" min="0" max="360" step="1" value="0">
        <span id="studio-light-val" style="min-width: 34px; text-align: right;">0&deg;</span>
      </div>
    </div>

    <div class="card">
      <h3>Automated QA Gate</h3>
      <div class="metrics-grid" id="qa-metrics"></div>
      <ul class="reasons" id="qa-reasons"></ul>
    </div>

    <div class="card">
      <h3>Reference &amp; Diagnostics</h3>
      <div class="thumb-grid" id="ref-thumbs"></div>
    </div>

    <div class="card">
      <h3>Human Review Rating (1-5)</h3>
      <div class="stars" id="star-buttons">
        <button class="star-btn" data-score="1">1</button>
        <button class="star-btn" data-score="2">2</button>
        <button class="star-btn" data-score="3">3</button>
        <button class="star-btn" data-score="4">4</button>
        <button class="star-btn" data-score="5">5</button>
      </div>
      <textarea id="rating-note" placeholder="Notes on silhouette, glazing, roughness, seams..."></textarea>
    </div>
  </aside>
</div>

<script id="studio-manifest" type="application/json">{safe_json}</script>
<script>
(() => {{
  const STORAGE_KEY = 'peekaplate_food3d_v1_ratings';
  const manifest = JSON.parse(document.getElementById('studio-manifest').textContent);
  const dishes = manifest.dishes || [];

  const dishSelect = document.getElementById('dish-select');
  const viewerFrame = document.getElementById('viewer-frame');
  const variantBtns = Array.from(document.querySelectorAll('#variant-buttons button'));
  const modeBtns = Array.from(document.querySelectorAll('#mode-buttons button'));
  const lightSlider = document.getElementById('studio-light-slider');
  const lightVal = document.getElementById('studio-light-val');
  const qaMetricsEl = document.getElementById('qa-metrics');
  const qaReasonsEl = document.getElementById('qa-reasons');
  const refThumbsEl = document.getElementById('ref-thumbs');
  const starBtns = Array.from(document.querySelectorAll('#star-buttons button'));
  const noteInput = document.getElementById('rating-note');
  const exportBtn = document.getElementById('export-ratings-btn');

  let state = {{
    dishIndex: 0,
    variant: 'E_v1_150k',
    mode: 'lit',
    lightAz: 0,
  }};

  function loadRatings() {{
    try {{
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{{}}');
    }} catch (_e) {{
      return {{}};
    }}
  }}

  function saveRatings(obj) {{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }}

  function currentDish() {{
    return dishes[state.dishIndex] || null;
  }}

  function fmt(v, digits = 3) {{
    if (v === null || v === undefined) return 'n/a';
    return typeof v === 'number' ? v.toFixed(digits) : String(v);
  }}

  function loadViewer() {{
    const d = currentDish();
    if (!d) return;
    let glb = d.variants[state.variant];
    if (!glb) {{
      const fallback = Object.entries(d.variants).find(([, v]) => Boolean(v));
      if (fallback) {{
        state.variant = fallback[0];
        glb = fallback[1];
      }}
    }}
    if (!glb) {{
      viewerFrame.srcdoc = '<body style="font:14px system-ui;padding:24px;">No GLB available for this dish.</body>';
      return;
    }}
    const effectiveMode = state.variant === 'A_raw_mobile' && state.mode === 'lit' ? 'unlit' : state.mode;
    const url = `./viewer.html?glb=${{encodeURIComponent(glb)}}&mode=${{encodeURIComponent(effectiveMode)}}&lightAz=${{state.lightAz}}&orbit=1`;
    viewerFrame.src = url;
  }}

  function postViewerMessage(payload) {{
    if (viewerFrame.contentWindow) {{
      viewerFrame.contentWindow.postMessage(payload, '*');
    }}
  }}

  function renderSidebar() {{
    const d = currentDish();
    if (!d) return;

    for (const btn of variantBtns) {{
      const key = btn.dataset.variant;
      const avail = Boolean(d.variants[key]);
      btn.disabled = !avail;
      btn.classList.toggle('active', key === state.variant);
    }}

    for (const btn of modeBtns) {{
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    }}
    lightSlider.value = String(state.lightAz);
    lightVal.textContent = `${{state.lightAz}}°`;

    const m = d.metrics || {{}};
    const rows = [
      ['Verdict', m.verdict || 'UNKNOWN'],
      ['150k / 35k', `${{m.mb_150k || 'n/a'}} / ${{m.mb_35k || 'n/a'}}`],
      ['Roughness std', fmt(m.roughness_std, 3)],
      ['Clearcoat std', fmt(m.clearcoat_std, 3)],
      ['Silhouette IoU', fmt(m.iou, 3)],
      ['Color Delta E', fmt(m.delta_e, 1)],
      ['Windowed SSIM', fmt(m.ssim, 3)],
      ['Relit p95 diff', fmt(m.relit_p95, 1)],
    ];
    qaMetricsEl.replaceChildren();
    for (const [label, value] of rows) {{
      const key = document.createElement('div');
      key.className = 'metric-k';
      key.textContent = label;
      const metric = document.createElement('div');
      metric.className = 'metric-v';
      metric.textContent = value;
      if (label === 'Verdict') {{
        const status = ['PASS', 'WARN', 'FAIL'].includes(value) ? value : 'FAIL';
        metric.classList.add(`verdict-${{status}}`);
      }}
      qaMetricsEl.append(key, metric);
    }}

    qaReasonsEl.replaceChildren();
    for (const reason of [...(m.reasons || []), ...(m.warnings || []).map((w) => 'WARN: ' + w)]) {{
      const item = document.createElement('li');
      item.textContent = reason;
      qaReasonsEl.appendChild(item);
    }}

    const thumbs = [
      ['Source Photo', d.assets.source_photo],
      ['Clean Cutout', d.assets.cutout_clean],
      ['PBR Masks Debug', d.assets.pbr_masks_debug],
      ['Fidelity Diag', d.assets.fidelity_diag],
      ['Comparison Sheet', d.assets.comparison_sheet],
    ].filter(([, url]) => Boolean(url));

    refThumbsEl.replaceChildren();
    for (const [label, url] of thumbs) {{
      const path = encodeURI('./' + url).replaceAll('#', '%23').replaceAll('?', '%3F');
      const thumb = document.createElement('a');
      thumb.className = 'thumb';
      thumb.href = path;
      thumb.target = '_blank';
      thumb.rel = 'noopener';
      const image = document.createElement('img');
      image.src = path;
      image.alt = label;
      const caption = document.createElement('span');
      caption.textContent = label;
      thumb.append(image, caption);
      refThumbsEl.appendChild(thumb);
    }}

    const ratings = loadRatings();
    const cur = ratings[d.dish] || {{ score: null, note: '' }};
    for (const btn of starBtns) {{
      btn.classList.toggle('active', Number(btn.dataset.score) === cur.score);
    }}
    noteInput.value = cur.note || '';
  }}

  dishes.forEach((d, idx) => {{
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${{d.dish}} [${{d.metrics?.verdict || 'UNKNOWN'}}]`;
    dishSelect.appendChild(opt);
  }});

  dishSelect.addEventListener('change', () => {{
    state.dishIndex = Number(dishSelect.value);
    renderSidebar();
    loadViewer();
  }});

  for (const btn of variantBtns) {{
    btn.addEventListener('click', () => {{
      state.variant = btn.dataset.variant;
      if (state.variant === 'A_raw_mobile') {{
        state.mode = 'unlit';
      }} else if (state.mode === 'unlit') {{
        state.mode = 'lit';
      }}
      renderSidebar();
      loadViewer();
    }});
  }}

  for (const btn of modeBtns) {{
    btn.addEventListener('click', () => {{
      state.mode = btn.dataset.mode;
      if (state.mode === 'relit') {{
        state.lightAz = 120;
      }} else if (state.mode === 'lit' && state.lightAz === 120) {{
        state.lightAz = 0;
      }}
      renderSidebar();
      postViewerMessage({{ type: 'food3d:setMode', mode: state.mode, lightAz: state.lightAz }});
    }});
  }}

  lightSlider.addEventListener('input', () => {{
    state.lightAz = Number(lightSlider.value);
    lightVal.textContent = `${{state.lightAz}}°`;
    postViewerMessage({{ type: 'food3d:setLightAz', lightAz: state.lightAz }});
  }});

  for (const btn of starBtns) {{
    btn.addEventListener('click', () => {{
      const d = currentDish();
      if (!d) return;
      const ratings = loadRatings();
      ratings[d.dish] = {{
        score: Number(btn.dataset.score),
        note: noteInput.value,
        updated_at: new Date().toISOString(),
      }};
      saveRatings(ratings);
      renderSidebar();
    }});
  }}

  noteInput.addEventListener('input', () => {{
    const d = currentDish();
    if (!d) return;
    const ratings = loadRatings();
    const prev = ratings[d.dish] || {{ score: null }};
    ratings[d.dish] = {{
      ...prev,
      note: noteInput.value,
      updated_at: new Date().toISOString(),
    }};
    saveRatings(ratings);
  }});

  exportBtn.addEventListener('click', () => {{
    const payload = {{
      schema_version: 1,
      publication_eligible: false,
      exported_at: new Date().toISOString(),
      ratings: loadRatings(),
    }};
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\\n'], {{ type: 'application/json' }});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'food3d_v1_ratings.json';
    a.click();
    URL.revokeObjectURL(url);
  }});

  if (dishes.length > 0) {{
    renderSidebar();
    loadViewer();
  }}
}})();
</script>
</body>
</html>
"""
    studio_path = out_dir / 'studio.html'
    studio_path.write_text(html_doc, encoding='utf-8')
    return studio_path


def discover_dishes(out_dir: Path) -> list[str]:
    """Auto-discover dish subdirectories in out_dir."""
    dishes: list[str] = []
    for child in sorted(out_dir.iterdir()):
        if not child.is_dir() or child.name.startswith('_') or child.name.startswith('.'):
            continue
        if (
            (child / 'qa_report.json').exists()
            or (child / 'frames').is_dir()
            or (child / 'lod_150k_2048.pbr.glb').exists()
        ):
            dishes.append(child.name)
    return dishes


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Food3D V1 Comparison Sheet & Studio Builder.')
    parser.add_argument('out_dir', type=Path, help='Pipeline output root directory.')
    parser.add_argument('--dishes', nargs='*', default=None, help='Optional explicit dish names.')
    parser.add_argument('--exp0-dir', type=Path, default=None, help='Optional Exp0 reference dir.')
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    out_dir = args.out_dir.resolve()
    dishes = args.dishes if args.dishes else discover_dishes(out_dir)

    dishes_data: list[dict[str, Any]] = []
    for dish in dishes:
        sheet = build_comparison_sheet(out_dir, dish)
        print(f'[build_studio] wrote {sheet}')
        dishes_data.append(_collect_dish_manifest(out_dir, dish, args.exp0_dir))

    studio_path = build_studio_html(out_dir, dishes_data)
    print(
        json.dumps(
            {
                'publication_eligible': False,
                'studio_html': str(studio_path),
                'dishes': [d['dish'] for d in dishes_data],
            }
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
