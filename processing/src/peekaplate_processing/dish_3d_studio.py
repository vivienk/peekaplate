"""Build and serve interactive Three.js 3D dish studio HTML pages for demo outputs."""

from __future__ import annotations

import argparse
import base64
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import html as html_lib
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

from PIL import Image, ImageOps

THREE_VERSION = '0.182.0'
DEFAULT_THREE_CDN_BASE = f'https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}'
TRUTHFUL_DEMO_LABEL = 'Private single-photo 3D demo (not published T0/T1/T2 menu evidence)'

MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
}

_TEMPLATE_TOKEN_RE = re.compile(
    r'__(?:TITLE|IMPORTMAP_JSON|STUDIO_DATA_JSON|DEMO_BADGE|MODE_TAG)__'
)


def _safe_child_path(root: Path, rel_path: str) -> Path:
    if not isinstance(rel_path, str) or not rel_path.strip() or '\x00' in rel_path:
        raise ValueError(f'Invalid relative artifact path: {rel_path!r}')
    base = root.resolve()
    candidate = (base / rel_path).resolve()
    if not candidate.is_relative_to(base):
        raise ValueError(f'Path escapes results root: {rel_path!r}')
    return candidate


def _encode_png_data_url(path: Path, max_dim: int = 512) -> str:
    with Image.open(path) as im:
        normalized = ImageOps.exif_transpose(im)
        mode = 'RGBA' if 'A' in normalized.getbands() else 'RGB'
        converted = normalized.convert(mode)
        if max(converted.size) > max_dim:
            converted.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        buf = BytesIO()
        converted.save(buf, format='PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return f'data:image/png;base64,{b64}'


def _encode_file_base64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode('ascii')


def _pick_image_ref(path: Path, rel_path: str, embed: bool, max_thumb_px: int) -> str:
    if embed:
        return _encode_png_data_url(path, max_dim=max_thumb_px)
    return rel_path


def _extract_dish_runs(
    results_dir: Path,
    manifest: dict,
    dish_label: str,
    embed_mobile_assets: bool,
    max_thumb_px: int,
) -> list[dict]:
    runs_out: list[dict] = []
    runs_3d = manifest.get('runs_3d') or {}
    for run_key, rec in runs_3d.items():
        if rec.get('input_label') != dish_label or rec.get('status') != 'success':
            continue
        raw_rel = None
        mob_rel = None
        preview_rel = None
        hf_modes_rel = None
        for art in rec.get('artifacts') or []:
            rel = str(art.get('path') or '')
            if not rel:
                continue
            _safe_child_path(results_dir, rel)
            name = Path(rel).name
            if name.endswith('_mobile.glb'):
                mob_rel = rel
            elif name.endswith('.glb'):
                raw_rel = rel
            elif name.endswith('_hf_modes.png'):
                hf_modes_rel = rel
            elif name.endswith('_preview.png'):
                preview_rel = rel

        raw_path = _safe_child_path(results_dir, raw_rel) if raw_rel else None
        mob_path = _safe_child_path(results_dir, mob_rel) if mob_rel else None
        raw_exists = bool(raw_path and raw_path.is_file())
        mob_exists = bool(mob_path and mob_path.is_file())

        embed_mob_b64 = _encode_file_base64(mob_path) if (embed_mobile_assets and mob_exists) else None
        embed_raw_b64 = (
            _encode_file_base64(raw_path)
            if (embed_mobile_assets and not mob_exists and raw_exists)
            else None
        )

        fallback_rel = hf_modes_rel or preview_rel
        fallback_path = _safe_child_path(results_dir, fallback_rel) if fallback_rel else None
        fallback_ref = (
            _pick_image_ref(fallback_path, fallback_rel, embed_mobile_assets, max_thumb_px)
            if (fallback_path and fallback_path.is_file() and fallback_rel)
            else None
        )

        raw_m = rec.get('metrics') or {}
        mob_m = rec.get('mobile_metrics') or {}
        raw_verts = raw_m.get('vertices', raw_m.get('vertex_count'))
        raw_entry = (
            {
                'path': None if embed_mobile_assets else (raw_rel if raw_exists else None),
                'base64': embed_raw_b64,
                'filename': Path(raw_rel).name if raw_rel else None,
                'vertices': raw_verts,
                'faces': raw_m.get('faces'),
                'bytes': raw_m.get('bytes', raw_path.stat().st_size if raw_exists else None),
            }
            if raw_rel
            else None
        )
        mob_entry = (
            {
                'path': None if embed_mobile_assets else (mob_rel if mob_exists else None),
                'base64': embed_mob_b64,
                'filename': Path(mob_rel).name if mob_rel else None,
                'vertices': mob_m.get('vertices', mob_m.get('vertex_count', raw_verts)),
                'faces': mob_m.get('faces', raw_m.get('faces')),
                'bytes': mob_m.get('bytes', mob_path.stat().st_size if mob_exists else raw_m.get('bytes')),
            }
            if mob_exists or embed_mob_b64
            else None
        )

        runs_out.append({
            'key': run_key,
            'backend': rec.get('backend') or run_key.split('/')[-1],
            'slug': run_key.split('/')[-1],
            'appearance': rec.get('appearance') or 'unknown',
            'device': rec.get('device') or 'unknown',
            'elapsed_seconds': raw_m.get('elapsed_seconds'),
            'has_vertex_color': bool(raw_m.get('has_vertex_color', False)),
            'has_texture': bool(raw_m.get('has_texture', False)),
            'raw': raw_entry,
            'mobile': mob_entry,
            'fallback_image': fallback_ref,
        })
    return runs_out


def build_studio_payload(
    results_dir: Path,
    embed_mobile_assets: bool = False,
    max_thumb_px: int = 512,
) -> dict:
    """Collect verified dish cutouts and 3D GLB metadata from a results directory."""
    manifest_path = results_dir / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('publication_eligible') is not False:
        raise ValueError('Single-photo 3D studio must retain publication_eligible=false.')

    dishes: list[dict] = []
    inputs = manifest.get('inputs') or {}
    for label, entry in inputs.items():
        if entry.get('image_status') != 'success':
            continue
        src_rel = None
        cut_rel = None
        jm_rel = None
        for art in entry.get('artifacts') or []:
            rel = str(art.get('path') or '')
            if not rel:
                continue
            _safe_child_path(results_dir, rel)
            name = Path(rel).name
            if name.startswith('input_image.'):
                src_rel = rel
            elif name.startswith('cutout_rgba.'):
                cut_rel = rel
            elif name == 'job_manifest.json':
                jm_rel = rel

        source_sha256 = entry.get('source_sha256')
        job_id = None
        if jm_rel:
            jm_path = _safe_child_path(results_dir, jm_rel)
            if jm_path.is_file():
                jm = json.loads(jm_path.read_text(encoding='utf-8'))
                if jm.get('publication_eligible') is not False:
                    raise ValueError(f'Dish {label} job_manifest has publication_eligible != false')
                source_sha256 = source_sha256 or jm.get('source_sha256')
                job_id = jm.get('job_id')

        src_path = _safe_child_path(results_dir, src_rel) if src_rel else None
        cut_path = _safe_child_path(results_dir, cut_rel) if cut_rel else None
        src_ref = (
            _pick_image_ref(src_path, src_rel, embed_mobile_assets, max_thumb_px)
            if (src_path and src_path.is_file() and src_rel)
            else None
        )
        cut_ref = (
            _pick_image_ref(cut_path, cut_rel, embed_mobile_assets, max_thumb_px)
            if (cut_path and cut_path.is_file() and cut_rel)
            else None
        )

        runs_out = _extract_dish_runs(results_dir, manifest, label, embed_mobile_assets, max_thumb_px)
        dishes.append({
            'label': label,
            'job_id': job_id,
            'image_source': entry.get('image_source'),
            'size': entry.get('size'),
            'source_sha256': source_sha256,
            'cutout_metrics': entry.get('cutout_metrics') or {},
            'source_image': src_ref,
            'cutout_image': cut_ref,
            'runs': runs_out,
        })

    return {
        'schema_version': 1,
        'demo_label': manifest.get('demo_label') or TRUTHFUL_DEMO_LABEL,
        'publication_eligible': False,
        'plate_preservation_mode': manifest.get('plate_preservation_mode') or 'preserve_plate',
        'standalone': bool(embed_mobile_assets),
        'three_version': THREE_VERSION,
        'dishes': dishes,
    }


def _safe_json_for_script(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')


def render_studio_html(
    payload: dict,
    three_base_url: str = DEFAULT_THREE_CDN_BASE,
    standalone: bool | None = None,
) -> str:
    """Render an interactive Three.js r182 WebGL 3D Dish Studio page."""
    if payload.get('publication_eligible') is not False:
        raise ValueError('Studio payload must retain publication_eligible=false.')
    is_standalone = payload.get('standalone', False) if standalone is None else bool(standalone)
    base_url = three_base_url.rstrip('/')
    import_map = {
        'imports': {
            'three': f'{base_url}/build/three.module.js',
            'three/addons/': f'{base_url}/examples/jsm/',
        }
    }
    demo_badge = f"{payload.get('demo_label') or TRUTHFUL_DEMO_LABEL} | publication_eligible=false"
    mode_tag = (
        'Standalone Offline HTML (Embedded Mobile <=35k GLBs)'
        if is_standalone
        else 'Interactive Multi-File Studio (Mobile <=35k + Raw GLBs)'
    )
    replacements = {
        '__TITLE__': html_lib.escape('PeekaPlate — Interactive Plate-Preserving 3D Dish Studio'),
        '__IMPORTMAP_JSON__': _safe_json_for_script(import_map),
        '__STUDIO_DATA_JSON__': _safe_json_for_script(payload),
        '__DEMO_BADGE__': html_lib.escape(demo_badge),
        '__MODE_TAG__': html_lib.escape(mode_tag),
    }
    return _TEMPLATE_TOKEN_RE.sub(lambda match: replacements[match.group(0)], _STUDIO_HTML_TEMPLATE)


def build_studio_files(
    results_dir: Path,
    three_base_url: str = DEFAULT_THREE_CDN_BASE,
) -> tuple[Path, Path]:
    """Generate both multi-file `comparison_viewer.html` and self-contained `interactive_3d_studio.html`."""
    http_payload = build_studio_payload(results_dir, embed_mobile_assets=False)
    viewer_path = results_dir / 'comparison_viewer.html'
    viewer_path.write_text(
        render_studio_html(http_payload, three_base_url=three_base_url, standalone=False),
        encoding='utf-8',
    )

    standalone_payload = build_studio_payload(results_dir, embed_mobile_assets=True, max_thumb_px=512)
    standalone_path = results_dir / 'interactive_3d_studio.html'
    standalone_path.write_text(
        render_studio_html(standalone_payload, three_base_url=DEFAULT_THREE_CDN_BASE, standalone=True),
        encoding='utf-8',
    )
    return viewer_path, standalone_path


def find_local_three_dir(repo_root: Path | None = None) -> Path | None:
    """Locate local installed `three@0.182.0` package directory for loopback HTTP serving."""
    root = repo_root or Path(__file__).resolve().parents[3]
    candidates = [
        root / 'frontend' / 'diner' / 'node_modules' / 'three',
        root / 'node_modules' / '.pnpm' / f'three@{THREE_VERSION}' / 'node_modules' / 'three',
        root / 'node_modules' / 'three',
    ]
    for cand in candidates:
        resolved = cand.resolve()
        if (resolved / 'build' / 'three.module.js').is_file():
            return resolved
    return None


def _resolve_safe_path(raw_url_path: str, results_dir: Path, three_dir: Path | None) -> Path | None:
    clean_path = unquote(urlsplit(raw_url_path).path)
    if '\x00' in clean_path:
        return None
    if clean_path in ('', '/'):
        rel = 'comparison_viewer.html'
    else:
        rel = clean_path.lstrip('/')

    if rel.startswith('vendor/three/'):
        if three_dir is None:
            return None
        sub = rel[len('vendor/three/'):]
        if not sub:
            return None
        base = three_dir.resolve()
        target = (base / sub).resolve()
        return target if (target.is_relative_to(base) and target.is_file()) else None

    base = results_dir.resolve()
    target = (base / rel).resolve()
    return target if (target.is_relative_to(base) and target.is_file()) else None


class _StudioRequestHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, results_dir: Path, three_dir: Path | None, **kwargs):
        self.results_dir = results_dir
        self.three_dir = three_dir
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        target = _resolve_safe_path(self.path, self.results_dir, self.three_dir)
        if target is None:
            self.send_error(HTTPStatus.NOT_FOUND, 'Not found')
            return
        body = target.read_bytes()
        ctype = MIME_TYPES.get(target.suffix.lower(), 'application/octet-stream')
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        return


def create_studio_server(
    results_dir: Path,
    port: int = 8765,
    three_dir: Path | None = None,
) -> tuple[ThreadingHTTPServer, Path | None]:
    """Create a bound loopback HTTP server for `results_dir` and optional local `three` package."""
    resolved_results = results_dir.resolve()
    resolved_three = three_dir if three_dir is not None else find_local_three_dir()
    handler = partial(_StudioRequestHandler, results_dir=resolved_results, three_dir=resolved_three)
    server = ThreadingHTTPServer(('127.0.0.1', port), handler)
    return server, resolved_three


def serve_studio(results_dir: Path, port: int = 8765, three_dir: Path | None = None) -> None:
    """Serve `results_dir` and local `/vendor/three/` strictly on loopback `127.0.0.1`."""
    server, resolved_three = create_studio_server(results_dir, port=port, three_dir=three_dir)
    print(f'Serving PeekaPlate 3D Studio at http://127.0.0.1:{server.server_port}/comparison_viewer.html', flush=True)
    if resolved_three is not None:
        print(f'Mounted local Three.js ({resolved_three}) at /vendor/three/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def resolve_default_three_base_url(
    three_dir: Path | None,
    explicit_base_url: str | None = None,
) -> str:
    """Pick explicit URL, local `/vendor/three` only when local package exists, else pinned CDN."""
    if explicit_base_url:
        return explicit_base_url
    if three_dir is not None:
        return '/vendor/three'
    return DEFAULT_THREE_CDN_BASE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results-dir', required=True, type=Path, help='Notebook results directory holding manifest.json')
    parser.add_argument('--build', action='store_true', help='Generate comparison_viewer.html and interactive_3d_studio.html')
    parser.add_argument('--serve', action='store_true', help='Start loopback 127.0.0.1 HTTP server')
    parser.add_argument('--port', type=int, default=8765, help='Loopback HTTP port (default 8765)')
    parser.add_argument(
        '--three-base-url',
        default=None,
        help='Importmap base URL for comparison_viewer.html (defaults to /vendor/three when local three exists, else CDN)',
    )
    args = parser.parse_args(argv)
    if not (args.build or args.serve):
        parser.error('Specify at least one of --build or --serve.')

    three_dir = find_local_three_dir()
    if args.build:
        base_url = resolve_default_three_base_url(three_dir, args.three_base_url)
        v_path, s_path = build_studio_files(args.results_dir, three_base_url=base_url)
        print(f'Built HTTP studio:       {v_path} ({v_path.stat().st_size} B)')
        print(f'Built standalone studio: {s_path} ({s_path.stat().st_size} B)')
    if args.serve:
        serve_studio(args.results_dir, port=args.port, three_dir=three_dir)
    return 0


_STUDIO_HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__TITLE__</title>
  <script type="importmap">__IMPORTMAP_JSON__</script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f17;
      --panel: #131a26;
      --panel-2: #192232;
      --border: #2a374d;
      --text: #eef3fa;
      --muted: #93a6c2;
      --accent: #3b82f6;
      --accent-soft: rgba(59, 130, 246, 0.16);
      --ok: #34d399;
      --warn: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 18px;
      border-bottom: 1px solid var(--border);
      background: #0f1520;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand { display: flex; flex-direction: column; gap: 2px; }
    .brand h1 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.01em; }
    .sub { font-size: 12px; color: var(--muted); }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid #3c5478;
      background: #1a273b;
      color: #bfdbfe;
    }
    .layout {
      flex: 1;
      display: grid;
      grid-template-columns: 270px 1fr;
      min-height: 0;
    }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
    }
    aside {
      border-right: 1px solid var(--border);
      background: #0f151f;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
    }
    .sec-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .dish-list { display: flex; flex-direction: column; gap: 8px; }
    .dish-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 8px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
    }
    .dish-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .dish-btn img {
      width: 52px;
      height: 52px;
      border-radius: 6px;
      object-fit: cover;
      background: repeating-conic-gradient(#1f2733 0% 25%, #2b3545 0% 50%) 50% / 12px 12px;
      flex-shrink: 0;
    }
    .dish-meta { display: flex; flex-direction: column; min-width: 0; }
    .dish-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dish-sub { font-size: 11px; color: var(--muted); }
    .dish-pill { font-size: 11px; color: var(--ok); }
    .ref-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ref-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .ref-box { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); }
    .ref-box img {
      width: 100%;
      height: 100px;
      object-fit: contain;
      border-radius: 6px;
      background: #0a0e14;
    }
    .ref-box img.checker {
      background: repeating-conic-gradient(#1e2633 0% 25%, #2b3648 0% 50%) 50% / 14px 14px;
    }
    .kv { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
    .kv b { color: var(--text); font-weight: 600; }

    main {
      display: flex;
      flex-direction: column;
      min-width: 0;
      padding: 14px;
      gap: 12px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .grp { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-right: 8px; border-right: 1px solid var(--border); }
    .grp:last-child { border-right: none; padding-right: 0; }
    .grp-lbl { font-size: 11px; color: var(--muted); margin-right: 4px; }
    button.ctrl, a.ctrl {
      background: var(--panel-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
    }
    button.ctrl.active { background: var(--accent); border-color: #60a5fa; color: #fff; }
    button.ctrl:disabled { opacity: 0.45; cursor: not-allowed; }
    label.slider { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }

    .stage-wrap {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      min-height: 480px;
    }
    .stage-wrap.compare { grid-template-columns: 1fr 1fr; }
    @media (max-width: 960px) {
      .stage-wrap.compare { grid-template-columns: 1fr; }
    }
    .vp-card {
      position: relative;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #080b10;
      overflow: hidden;
      min-height: 460px;
    }
    .vp-card.hidden { display: none; }
    .vp-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: rgba(19, 26, 38, 0.92);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      gap: 8px;
      flex-wrap: wrap;
    }
    .vp-title { font-weight: 700; }
    .vp-stats { color: var(--muted); }
    .vp-canvas-host {
      position: relative;
      flex: 1;
      width: 100%;
      min-height: 400px;
    }
    .vp-canvas-host.no-webgl { display: none; }
    .vp-canvas-host canvas { display: block; width: 100%; height: 100%; outline: none; }
    .vp-overlay {
      position: absolute;
      inset: 12px;
      pointer-events: none;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      font-size: 11px;
      color: var(--muted);
    }
    .vp-pill {
      background: rgba(11, 15, 23, 0.78);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 6px;
    }
    .fallback-box {
      display: none;
      padding: 16px;
      gap: 10px;
      flex-direction: column;
      align-items: flex-start;
    }
    .fallback-box.active { display: flex; }
    .fallback-box img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); }
    .fallback-msg { font-size: 12px; color: var(--muted); }
    .notice {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #6b4e1b;
      background: rgba(245, 158, 11, 0.1);
      color: #fde68a;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>PeekaPlate Interactive 3D Dish Studio</h1>
      <div class="sub">__MODE_TAG__ · Drag to orbit · Scroll to zoom · Right-drag to pan</div>
    </div>
    <div class="badges">
      <span class="badge" id="demo-badge">__DEMO_BADGE__</span>
    </div>
  </header>

  <div class="layout">
    <aside>
      <div>
        <div class="sec-title">Dish Samples</div>
        <div class="dish-list" id="dish-list"></div>
      </div>
      <div class="ref-card">
        <div class="sec-title">Plate + Food Reference</div>
        <div class="ref-pair">
          <div class="ref-box"><span>Source Photo</span><img id="ref-source" alt="Source photo" /></div>
          <div class="ref-box"><span>Cutout (Plate + Food)</span><img id="ref-cutout" class="checker" alt="Plate cutout" /></div>
        </div>
        <div class="kv" id="dish-telemetry"></div>
      </div>
    </aside>

    <main>
      <div class="toolbar">
        <div class="grp" id="grp-backend">
          <span class="grp-lbl">View</span>
          <button class="ctrl active" data-view="triposr">TripoSR (Color)</button>
          <button class="ctrl" data-view="hunyuan3d-2mini">Hunyuan3D-2mini (Mesh)</button>
          <button class="ctrl" data-view="trellis2-4b">TRELLIS.2-4B (PBR)</button>
          <button class="ctrl" data-view="compare">Side-by-Side Sync</button>
        </div>
        <div class="grp" id="grp-profile">
          <span class="grp-lbl">Mesh</span>
          <button class="ctrl active" data-profile="mobile">Mobile &lt;=35k</button>
          <button class="ctrl" data-profile="raw">Raw Full</button>
        </div>
        <div class="grp" id="grp-shader">
          <span class="grp-lbl">Shading</span>
          <button class="ctrl active" data-shader="pbr">Studio PBR</button>
          <button class="ctrl" data-shader="base_color">Base Color</button>
          <button class="ctrl" data-shader="clay">Clay</button>
          <button class="ctrl" data-shader="normal">Normal</button>
          <button class="ctrl" id="btn-wireframe">Wireframe</button>
        </div>
        <div class="grp" id="grp-camera">
          <span class="grp-lbl">Camera</span>
          <button class="ctrl" data-preset="front">Front 3/4</button>
          <button class="ctrl" data-preset="top">Top</button>
          <button class="ctrl" data-preset="side">Side</button>
          <button class="ctrl" data-preset="low">Low Rim</button>
          <button class="ctrl" id="btn-rotate">Auto-Rotate: OFF</button>
          <button class="ctrl" id="btn-grid">Grid: ON</button>
        </div>
        <div class="grp" id="grp-env">
          <span class="grp-lbl">Bg</span>
          <button class="ctrl active" data-bg="dark">Dark</button>
          <button class="ctrl" data-bg="neutral">Slate</button>
          <button class="ctrl" data-bg="light">Light</button>
          <label class="slider">Exposure <input id="rng-exposure" type="range" min="0.5" max="2.0" step="0.05" value="1.10" /></label>
          <a class="ctrl" id="btn-download" download="dish.glb" href="#">Download GLB</a>
        </div>
      </div>

      <div id="webgl-notice" class="notice" style="display:none"></div>

      <div class="stage-wrap" id="stage-wrap">
        <div class="vp-card" id="vp-primary">
          <div class="vp-head">
            <span class="vp-title" id="vp-primary-title">Loading…</span>
            <span class="vp-stats" id="vp-primary-stats"></span>
          </div>
          <div class="vp-canvas-host" id="vp-primary-host">
            <div class="vp-overlay">
              <span class="vp-pill" id="vp-primary-status">Initializing WebGL…</span>
              <span class="vp-pill" id="vp-primary-hint">3D Orbit Active</span>
            </div>
          </div>
          <div class="fallback-box" id="vp-primary-fallback"></div>
        </div>

        <div class="vp-card hidden" id="vp-secondary">
          <div class="vp-head">
            <span class="vp-title" id="vp-secondary-title">Hunyuan3D-2mini</span>
            <span class="vp-stats" id="vp-secondary-stats"></span>
          </div>
          <div class="vp-canvas-host" id="vp-secondary-host">
            <div class="vp-overlay">
              <span class="vp-pill" id="vp-secondary-status">Synced Camera</span>
              <span class="vp-pill">Geometry Compare</span>
            </div>
          </div>
          <div class="fallback-box" id="vp-secondary-fallback"></div>
        </div>
      </div>
    </main>
  </div>

  <script id="studio-data" type="application/json">__STUDIO_DATA_JSON__</script>
  <script type="module">
    const DATA = JSON.parse(document.getElementById('studio-data').textContent);
    const BG_HEX = { dark: 0x080b10, neutral: 0x263142, light: 0xe6ebf2 };
    const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'envMap'];

    const state = {
      dishIdx: 0,
      view: 'triposr',
      profile: 'mobile',
      shader: 'pbr',
      wireframe: false,
      autoRotate: false,
      grid: true,
      bg: 'dark',
      exposure: 1.1,
      webglReady: false,
    };

    const dishListEl = document.getElementById('dish-list');
    const refSourceEl = document.getElementById('ref-source');
    const refCutoutEl = document.getElementById('ref-cutout');
    const telemetryEl = document.getElementById('dish-telemetry');
    const noticeEl = document.getElementById('webgl-notice');
    const stageWrap = document.getElementById('stage-wrap');
    const btnDownload = document.getElementById('btn-download');

    let THREE, OrbitControls, GLTFLoader, RoomEnvironment;
    try {
      [THREE, { OrbitControls }, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/environments/RoomEnvironment.js'),
      ]);
      const testCanvas = document.createElement('canvas');
      if (!testCanvas.getContext('webgl2') && !testCanvas.getContext('webgl')) {
        throw new Error('WebGL context is unavailable in this browser.');
      }
      state.webglReady = true;
    } catch (err) {
      noticeEl.style.display = 'block';
      noticeEl.textContent = 'WebGL 3D renderer unavailable (' + (err?.message || err) + '). Showing static plate-preserving renders and GLB downloads.';
      state.webglReady = false;
    }

    function base64ToArrayBuffer(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }

    function disposeMaterial(mat, disposeTextures = true) {
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        if (!m) continue;
        if (disposeTextures) {
          for (const slot of TEX_SLOTS) {
            const tex = m[slot];
            if (tex && typeof tex.dispose === 'function') {
              tex.source?.data?.close?.();
              tex.dispose();
            }
          }
        }
        if (typeof m.dispose === 'function') m.dispose();
      }
    }

    function disposeObject3D(root, disposeTextures = true) {
      if (!root) return;
      root.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) disposeMaterial(obj.material, disposeTextures);
      });
    }

    function clearViewportModel(vp) {
      if (vp.scene && vp.root) vp.scene.remove(vp.root);
      for (const entry of vp.originalMeshes) {
        if (entry.origMat && entry.origMat !== entry.mesh?.material) {
          disposeMaterial(entry.origMat, true);
        }
      }
      if (vp.root) disposeObject3D(vp.root, true);
      vp.root = null;
      vp.originalMeshes = [];
    }

    function showFallback(vp, run, dish, message) {
      vp.hostEl.classList.add('no-webgl');
      vp.fallbackEl.innerHTML = '';
      vp.fallbackEl.classList.add('active');
      if (message) {
        const p = document.createElement('div');
        p.className = 'fallback-msg';
        p.textContent = message;
        vp.fallbackEl.appendChild(p);
      }
      const imgSrc = (run && run.fallback_image) || dish?.cutout_image || dish?.source_image || '';
      if (imgSrc) {
        const img = document.createElement('img');
        img.src = imgSrc;
        img.alt = (run ? run.backend : dish?.label || 'Dish') + ' static preview';
        vp.fallbackEl.appendChild(img);
      }
    }

    function createViewport(hostEl, titleEl, statsEl, statusEl, fallbackEl) {
      const vp = {
        hostEl, titleEl, statsEl, statusEl, fallbackEl,
        renderer: null, scene: null, camera: null, controls: null,
        gridHelper: null, root: null, originalMeshes: [],
        lastRun: null, loadToken: 0,
      };
      if (!state.webglReady) {
        hostEl.classList.add('no-webgl');
        return vp;
      }

      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = state.exposure;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      hostEl.insertBefore(renderer.domElement, hostEl.firstChild);

      renderer.domElement.addEventListener('webglcontextlost', (ev) => {
        ev.preventDefault();
        state.webglReady = false;
        clearViewportModel(vp);
        noticeEl.style.display = 'block';
        noticeEl.textContent = 'WebGL context lost. Showing static plate-preserving renders and GLB downloads.';
        showFallback(vp, vp.lastRun, DATA.dishes[state.dishIdx], 'WebGL context lost');
      });

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(BG_HEX[state.bg]);
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      const envTex = pmrem.fromScene(envScene, 0.04).texture;
      scene.environment = envTex;
      envScene.dispose();
      pmrem.dispose();

      const hemi = new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 0.45);
      const key = new THREE.DirectionalLight(0xfff5e8, 1.85);
      key.position.set(2.5, 4.0, 2.2);
      key.castShadow = true;
      const rim = new THREE.DirectionalLight(0x9ec5fe, 0.75);
      rim.position.set(-2.6, 2.2, -2.5);
      scene.add(hemi, key, rim);

      const grid = new THREE.GridHelper(3.2, 16, 0x3b4d6b, 0x1e293b);
      grid.visible = state.grid;
      scene.add(grid);

      const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
      camera.position.set(1.85, 1.35, 2.05);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.07;
      controls.target.set(0, 0.28, 0);
      controls.minDistance = 0.7;
      controls.maxDistance = 7.0;
      controls.update();

      vp.renderer = renderer;
      vp.scene = scene;
      vp.camera = camera;
      vp.controls = controls;
      vp.gridHelper = grid;

      const resize = () => {
        const w = Math.max(hostEl.clientWidth, 100);
        const h = Math.max(hostEl.clientHeight, 360);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      new ResizeObserver(resize).observe(hostEl);
      resize();
      return vp;
    }

    const vpA = createViewport(
      document.getElementById('vp-primary-host'),
      document.getElementById('vp-primary-title'),
      document.getElementById('vp-primary-stats'),
      document.getElementById('vp-primary-status'),
      document.getElementById('vp-primary-fallback'),
    );
    const vpB = createViewport(
      document.getElementById('vp-secondary-host'),
      document.getElementById('vp-secondary-title'),
      document.getElementById('vp-secondary-stats'),
      document.getElementById('vp-secondary-status'),
      document.getElementById('vp-secondary-fallback'),
    );

    let syncingCam = false;
    function linkCameras(src, dst) {
      if (!src.controls || !dst.controls) return;
      src.controls.addEventListener('change', () => {
        if (syncingCam || state.view !== 'compare') return;
        syncingCam = true;
        dst.camera.position.copy(src.camera.position);
        dst.controls.target.copy(src.controls.target);
        dst.controls.update();
        syncingCam = false;
      });
    }
    linkCameras(vpA, vpB);
    linkCameras(vpB, vpA);

    function applyShaderToViewport(vp) {
      if (!vp.root) return;
      for (const entry of vp.originalMeshes) {
        const { mesh, origMat, hasVC } = entry;
        const baseOrig = Array.isArray(origMat) ? origMat[0] : origMat;
        const baseMap = baseOrig?.map || null;
        let nextMat;
        if (state.shader === 'base_color') {
          nextMat = new THREE.MeshBasicMaterial({
            map: hasVC ? null : baseMap,
            vertexColors: hasVC,
            color: (hasVC || baseMap) ? 0xffffff : 0xd8cdbf,
            side: THREE.DoubleSide,
            wireframe: state.wireframe,
          });
        } else if (state.shader === 'clay') {
          nextMat = new THREE.MeshStandardMaterial({
            color: 0xdfd3c3,
            roughness: 0.62,
            metalness: 0.04,
            vertexColors: false,
            side: THREE.DoubleSide,
            wireframe: state.wireframe,
          });
        } else if (state.shader === 'normal') {
          nextMat = new THREE.MeshNormalMaterial({
            side: THREE.DoubleSide,
            wireframe: state.wireframe,
          });
        } else {
          if (Array.isArray(origMat)) {
            nextMat = origMat.map((m) => {
              const c = m.clone();
              c.side = THREE.DoubleSide;
              c.wireframe = state.wireframe;
              return c;
            });
          } else if (origMat) {
            nextMat = origMat.clone();
            nextMat.side = THREE.DoubleSide;
            nextMat.wireframe = state.wireframe;
            if (!hasVC && !nextMat.map && nextMat.color && origMat.color.getHex() === 0xffffff) {
              nextMat.color.setHex(0xd9cec1);
            }
          } else {
            nextMat = new THREE.MeshStandardMaterial({
              color: 0xd9cec1,
              roughness: 0.55,
              metalness: 0.05,
              vertexColors: hasVC,
              side: THREE.DoubleSide,
              wireframe: state.wireframe,
            });
          }
        }
        const prev = mesh.material;
        mesh.material = nextMat;
        if (prev && prev !== origMat) {
          disposeMaterial(prev, false);
        }
      }
    }

    function pickProfile(run) {
      if (!run) return { prof: null, label: 'None', isRaw: false };
      const canRaw = Boolean(run.raw && (run.raw.path || run.raw.base64));
      const canMob = Boolean(run.mobile && (run.mobile.path || run.mobile.base64));
      if ((state.profile === 'raw' && canRaw) || !canMob) {
        return { prof: run.raw, label: 'Raw Full', isRaw: true };
      }
      return { prof: run.mobile, label: 'Mobile <=35k', isRaw: false };
    }

    async function loadRunIntoViewport(vp, run, dish) {
      const token = ++vp.loadToken;
      vp.lastRun = run;
      vp.fallbackEl.classList.remove('active');
      vp.fallbackEl.innerHTML = '';
      if (!run) {
        clearViewportModel(vp);
        vp.titleEl.textContent = 'Unavailable backend';
        vp.statsEl.textContent = '';
        vp.statusEl.textContent = 'Skipped / Not generated';
        showFallback(vp, null, dish, 'Backend did not produce a GLB for this dish; showing plate+food reference.');
        return;
      }

      const { prof, label: profLabel } = pickProfile(run);
      vp.titleEl.textContent = run.backend + ' (' + profLabel + ')';
      vp.statsEl.textContent = (prof?.vertices ?? '?') + 'v / ' + (prof?.faces ?? '?') + 'f · ' + Math.round((prof?.bytes || 0) / 1024) + ' KB · ' + run.appearance;

      if (!state.webglReady || !prof || (!prof.path && !prof.base64)) {
        clearViewportModel(vp);
        const reason = !state.webglReady ? 'Static fallback (WebGL unavailable)' : 'No GLB payload available';
        vp.statusEl.textContent = reason;
        showFallback(vp, run, dish, reason);
        return;
      }

      vp.hostEl.classList.remove('no-webgl');
      vp.statusEl.textContent = 'Loading ' + (prof.filename || 'mesh') + '…';
      try {
        const loader = new GLTFLoader();
        const gltf = prof.base64
          ? await new Promise((resolve, reject) => loader.parse(base64ToArrayBuffer(prof.base64), '', resolve, reject))
          : await loader.loadAsync(prof.path);
        if (token !== vp.loadToken) {
          disposeObject3D(gltf.scene, true);
          return;
        }
        clearViewportModel(vp);

        const root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const sz = box.getSize(new THREE.Vector3());
        const scale = 1.8 / Math.max(sz.x, sz.y, sz.z, 1e-4);
        root.scale.setScalar(scale);
        const sBox = new THREE.Box3().setFromObject(root);
        const center = sBox.getCenter(new THREE.Vector3());
        root.position.set(-center.x, -sBox.min.y, -center.z);

        const meshes = [];
        root.traverse((obj) => {
          if (obj.isMesh && obj.geometry) {
            if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
            obj.castShadow = true;
            obj.receiveShadow = true;
            meshes.push({
              mesh: obj,
              origMat: obj.material,
              hasVC: Boolean(obj.geometry.attributes.color),
            });
          }
        });
        vp.root = root;
        vp.originalMeshes = meshes;
        vp.scene.add(root);
        applyShaderToViewport(vp);

        const midY = (sBox.max.y - sBox.min.y) * 0.42;
        vp.controls.target.set(0, midY, 0);
        vp.controls.update();
        vp.statusEl.textContent = 'Loaded (' + (prof.faces || '?') + ' faces)';
      } catch (err) {
        clearViewportModel(vp);
        const errMsg = 'Load failed: ' + (err?.message || err);
        vp.statusEl.textContent = errMsg;
        showFallback(vp, run, dish, errMsg);
      }
    }

    function setPreset(preset) {
      const presets = {
        front: [1.85, 1.25, 2.05],
        top: [0.01, 2.85, 0.35],
        side: [2.75, 0.85, 0.01],
        low: [1.95, 0.42, 1.95],
      };
      const pos = presets[preset] || presets.front;
      for (const vp of [vpA, vpB]) {
        if (!vp.camera || !vp.controls) continue;
        vp.camera.position.set(pos[0], pos[1], pos[2]);
        vp.controls.update();
      }
    }

    function updateDownloadLink(dish, primaryRun) {
      const { prof } = pickProfile(primaryRun);
      if (!dish || !primaryRun || !prof || (!prof.path && !prof.base64)) {
        btnDownload.style.display = 'none';
        return;
      }
      btnDownload.style.display = 'inline-block';
      btnDownload.download = dish.label + '_' + (prof.filename || 'dish.glb');
      if (prof.base64) {
        btnDownload.onclick = (ev) => {
          ev.preventDefault();
          const blob = new Blob([base64ToArrayBuffer(prof.base64)], { type: 'model/gltf-binary' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = btnDownload.download;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        btnDownload.href = '#';
      } else {
        btnDownload.onclick = null;
        btnDownload.href = prof.path || '#';
      }
    }

    function renderDishSidebar() {
      dishListEl.innerHTML = '';
      DATA.dishes.forEach((dish, idx) => {
        const cm = dish.cutout_metrics || {};
        const btn = document.createElement('button');
        btn.className = 'dish-btn' + (idx === state.dishIdx ? ' active' : '');
        btn.dataset.dish = dish.label;
        const img = document.createElement('img');
        img.src = dish.cutout_image || dish.source_image || '';
        img.alt = dish.label;
        const meta = document.createElement('div');
        meta.className = 'dish-meta';
        const nm = document.createElement('span');
        nm.className = 'dish-name';
        nm.textContent = dish.label;
        const sb = document.createElement('span');
        sb.className = 'dish-sub';
        sb.textContent = (cm.plate_method || 'cutout') + ' · fg ' + (cm.fg_coverage_pct ?? '?') + '%';
        const pl = document.createElement('span');
        pl.className = 'dish-pill';
        pl.textContent = cm.plate_preserved ? ('Plate +' + cm.plate_added_pct + '%') : 'Food only';
        meta.append(nm, sb, pl);
        btn.append(img, meta);
        btn.onclick = () => { state.dishIdx = idx; refreshStage(); };
        dishListEl.appendChild(btn);
      });
    }

    async function refreshStage() {
      renderDishSidebar();
      const dish = DATA.dishes[state.dishIdx];
      if (!dish) return;
      const cm = dish.cutout_metrics || {};
      refSourceEl.src = dish.source_image || '';
      refCutoutEl.src = dish.cutout_image || '';
      telemetryEl.innerHTML = '';
      const lines = [
        ['Dish', dish.label + ' (' + (dish.size ? dish.size.join('×') : '?') + ')'],
        ['Plate Mode', (cm.plate_preserved ? 'PRESERVED' : 'food-only') + ' (+' + (cm.plate_added_pct ?? 0) + '%)'],
        ['Method', cm.plate_method || '?'],
        ['Source SHA', dish.source_sha256 ? dish.source_sha256.slice(0, 12) + '…' : 'n/a'],
      ];
      for (const [k, v] of lines) {
        const div = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = k + ': ';
        div.appendChild(b);
        div.appendChild(document.createTextNode(String(v)));
        telemetryEl.appendChild(div);
      }

      const rawBtn = document.querySelector('#grp-profile [data-profile="raw"]');
      const mobBtn = document.querySelector('#grp-profile [data-profile="mobile"]');
      const hasRaw = dish.runs.some((r) => r.raw && (r.raw.path || r.raw.base64));
      const hasMob = dish.runs.some((r) => r.mobile && (r.mobile.path || r.mobile.base64));
      rawBtn.disabled = !hasRaw;
      mobBtn.disabled = !hasMob;
      if (!hasRaw && state.profile === 'raw') state.profile = 'mobile';
      if (!hasMob && hasRaw && state.profile === 'mobile') state.profile = 'raw';
      rawBtn.classList.toggle('active', state.profile === 'raw');
      mobBtn.classList.toggle('active', state.profile === 'mobile');

      const trellisBtn = document.querySelector('#grp-backend [data-view="trellis2-4b"]');
      const runTripo = dish.runs.find((r) => r.slug === 'triposr');
      const runHunyuan = dish.runs.find((r) => r.slug === 'hunyuan3d-2mini');
      const runTrellis = dish.runs.find((r) => r.slug === 'trellis2-4b');
      if (trellisBtn) trellisBtn.disabled = !runTrellis;

      const isCompare = state.view === 'compare';
      stageWrap.classList.toggle('compare', isCompare);
      document.getElementById('vp-secondary').classList.toggle('hidden', !isCompare);

      if (isCompare) {
        updateDownloadLink(dish, runTripo || dish.runs[0]);
        await Promise.all([
          loadRunIntoViewport(vpA, runTripo, dish),
          loadRunIntoViewport(vpB, runHunyuan || runTrellis, dish),
        ]);
      } else {
        const chosen = state.view === 'hunyuan3d-2mini'
          ? runHunyuan
          : (state.view === 'trellis2-4b' ? runTrellis : (runTripo || dish.runs[0]));
        updateDownloadLink(dish, chosen);
        await loadRunIntoViewport(vpA, chosen, dish);
      }
    }

    document.querySelectorAll('#grp-backend [data-view]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        state.view = btn.dataset.view;
        document.querySelectorAll('#grp-backend [data-view]').forEach((b) => b.classList.toggle('active', b === btn));
        refreshStage();
      };
    });
    document.querySelectorAll('#grp-profile [data-profile]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        state.profile = btn.dataset.profile;
        document.querySelectorAll('#grp-profile [data-profile]').forEach((b) => b.classList.toggle('active', b === btn));
        refreshStage();
      };
    });
    document.querySelectorAll('#grp-shader [data-shader]').forEach((btn) => {
      btn.onclick = () => {
        state.shader = btn.dataset.shader;
        document.querySelectorAll('#grp-shader [data-shader]').forEach((b) => b.classList.toggle('active', b === btn));
        applyShaderToViewport(vpA);
        applyShaderToViewport(vpB);
      };
    });
    document.getElementById('btn-wireframe').onclick = (ev) => {
      state.wireframe = !state.wireframe;
      ev.currentTarget.classList.toggle('active', state.wireframe);
      applyShaderToViewport(vpA);
      applyShaderToViewport(vpB);
    };
    document.querySelectorAll('#grp-camera [data-preset]').forEach((btn) => {
      btn.onclick = () => setPreset(btn.dataset.preset);
    });
    document.getElementById('btn-rotate').onclick = (ev) => {
      state.autoRotate = !state.autoRotate;
      ev.currentTarget.classList.toggle('active', state.autoRotate);
      ev.currentTarget.textContent = 'Auto-Rotate: ' + (state.autoRotate ? 'ON' : 'OFF');
      for (const vp of [vpA, vpB]) if (vp.controls) vp.controls.autoRotate = state.autoRotate;
    };
    document.getElementById('btn-grid').onclick = (ev) => {
      state.grid = !state.grid;
      ev.currentTarget.classList.toggle('active', state.grid);
      ev.currentTarget.textContent = 'Grid: ' + (state.grid ? 'ON' : 'OFF');
      for (const vp of [vpA, vpB]) if (vp.gridHelper) vp.gridHelper.visible = state.grid;
    };
    document.querySelectorAll('#grp-env [data-bg]').forEach((btn) => {
      btn.onclick = () => {
        state.bg = btn.dataset.bg;
        document.querySelectorAll('#grp-env [data-bg]').forEach((b) => b.classList.toggle('active', b === btn));
        for (const vp of [vpA, vpB]) {
          if (vp.scene) vp.scene.background = new THREE.Color(BG_HEX[state.bg]);
        }
      };
    });
    document.getElementById('rng-exposure').oninput = (ev) => {
      state.exposure = parseFloat(ev.target.value);
      for (const vp of [vpA, vpB]) if (vp.renderer) vp.renderer.toneMappingExposure = state.exposure;
    };

    window.__PEEK_STUDIO__ = {
      state,
      setDish: (label) => {
        const idx = DATA.dishes.findIndex((d) => d.label === label);
        if (idx >= 0) { state.dishIdx = idx; return refreshStage(); }
      },
      setView: (v) => { state.view = v; return refreshStage(); },
      setShader: (s) => { state.shader = s; applyShaderToViewport(vpA); applyShaderToViewport(vpB); },
    };

    function animate() {
      requestAnimationFrame(animate);
      for (const vp of [vpA, vpB]) {
        if (!vp.renderer || vp.hostEl.closest('.vp-card')?.classList.contains('hidden')) continue;
        vp.controls.update();
        vp.renderer.render(vp.scene, vp.camera);
      }
    }
    if (state.webglReady) animate();
    refreshStage();
  </script>
</body>
</html>
"""


if __name__ == '__main__':
    raise SystemExit(main())
