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
import os
from pathlib import Path
import re
import struct
from urllib.parse import quote, unquote, urlsplit

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

#: The legacy template is frozen byte-for-byte (the multi-model notebooks embed it and
#: `test_dish_3d_notebook.py` asserts parity), so its hardcoded TRELLIS-only mesh-profile labels
#: are corrected at render time. Each anchor must match exactly once or rendering fails closed.
_LEGACY_LABEL_FIXES = (
    ('<button class="ctrl active" data-profile="mobile">TRELLIS Fast (&lt;=35k)</button>',
     '<button class="ctrl active" data-profile="mobile">Mobile (&lt;=35k)</button>'),
    ('<button class="ctrl" data-profile="raw">TRELLIS Full (Raw)</button>',
     '<button class="ctrl" data-profile="raw">Full (Raw)</button>'),
    ("label: 'TRELLIS Full (Raw)'", "label: 'Full (Raw)'"),
    ("label: 'TRELLIS Fast (<=35k)'", "label: 'Mobile (<=35k)'"),
    ("vp.titleEl.textContent = run.backend + ' (' + profLabel + ')';",
     "vp.titleEl.textContent = (dish?.model_statuses?.find((m) => m.slug === run.slug)?.name || run.backend)"
     " + ' (' + profLabel + ')';"),
)

#: Split-studio file names derive from manifest labels and run slugs, so both are allowlisted.
_SAFE_LABEL_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
_SAFE_SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
#: A run without a mobile export embeds its full GLB only below this size; larger ones are linked.
RAW_EMBED_LIMIT_BYTES = 8 * 1024 * 1024
INDEX_THUMB_PX = 160
DISH_REF_PX = 512


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
        backend_l = (rec.get('backend') or '').lower()
        if backend_l in ('triposr', 'hunyuan3d-2mini') or run_key.split('/')[-1] in ('triposr', 'hunyuan3d-2mini'):
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

        if not raw_exists and not mob_exists:
            continue
        runs_out.append({
            'key': run_key,
            'backend': rec.get('backend') or run_key.split('/')[-1],
            'slug': run_key.split('/')[-1],
            'appearance': rec.get('appearance') or 'unknown',
            'device': rec.get('device') or 'unknown',
            'elapsed_seconds': rec.get('elapsed_seconds', raw_m.get('elapsed_seconds')),
            **{k: rec.get(k) for k in ('license', 'tier', 'watertight', 'status', 'error')},
            'has_vertex_color': bool(raw_m.get('has_vertex_color', False)),
            'has_texture': bool(raw_m.get('has_texture', False)),
            'raw': raw_entry,
            'mobile': mob_entry,
            'fallback_image': fallback_ref,
        })
    order = ['moge2-relief', 'trellis2-4b-hires', 'trellis2-4b', 'triposg', 'hunyuan3d2', 'hi3dgen']
    runs_out.sort(key=lambda r: order.index(r['slug']) if r['slug'] in order else len(order))
    return runs_out


MODELS = {
    'moge2-relief': ('MoGe-2 Relief + Ceramic Plate', 'MIT'),
    'trellis2-4b-hires': ('TRELLIS.2-4B Max detail (L4, 1024 cascade, 4K texture)', 'MIT'),
    'trellis2-4b': ('TRELLIS.2-4B', 'MIT'),
    'triposg': ('TripoSG + Photo PBR', 'MIT'),
    'hunyuan3d2': ('Hunyuan3D-2 / 2.1', 'Tencent Community R&D'),
    'hi3dgen': ('Hi3DGen Normal-Bridge', 'MIT'),
}


def _model_statuses(manifest: dict, label: str, runs: list[dict]) -> list[dict]:
    records = {}
    for key, rec in (manifest.get('runs_3d') or {}).items():
        slug = key.split('/')[-1]
        if rec.get('input_label') != label or slug in ('triposr', 'hunyuan3d-2mini') or (rec.get('backend') or '').lower() in ('triposr', 'hunyuan3d-2mini'):
            continue
        records[slug] = rec
    result = []
    for slug in dict.fromkeys([*MODELS, *records]):
        rec = records.get(slug, {})
        metrics = rec.get('metrics') or {}
        name, license_name = MODELS.get(slug, (rec.get('backend') or slug, None))
        status = rec.get('status', 'not_run')
        if status == 'success' and not any(r['slug'] == slug for r in runs):
            status = 'failed'
        result.append({'slug': slug, 'name': name, 'status': status,
                       'license': rec.get('license') or license_name, 'tier': rec.get('tier'),
                       'watertight': rec.get('watertight', metrics.get('watertight')),
                       'elapsed_seconds': rec.get('elapsed_seconds', metrics.get('elapsed_seconds')),
                       'vertices': metrics.get('vertices', metrics.get('vertex_count')),
                       'faces': metrics.get('faces'),
                       'kb': metrics.get('bytes') / 1024 if metrics.get('bytes') is not None else None,
                       'error': rec.get('error'), 'appearance': rec.get('appearance')})
    return result


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
            'title': entry.get('title'), 'tier': entry.get('tier'), 'page': entry.get('page'),
            'model_statuses': _model_statuses(manifest, label, runs_out),
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
    demo_badge = _demo_badge(payload)
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
    return _TEMPLATE_TOKEN_RE.sub(lambda match: replacements[match.group(0)], _legacy_template_with_model_labels())


def _demo_badge(payload: dict) -> str:
    return f"{payload.get('demo_label') or TRUTHFUL_DEMO_LABEL} | publication_eligible=false"


def _import_map(three_base_url: str) -> dict:
    base_url = three_base_url.rstrip('/')
    return {'imports': {'three': f'{base_url}/build/three.module.js', 'three/addons/': f'{base_url}/examples/jsm/'}}


def _legacy_template_with_model_labels() -> str:
    template = _STUDIO_HTML_TEMPLATE
    for old, new in _LEGACY_LABEL_FIXES:
        if template.count(old) != 1:
            raise ValueError(f'Legacy studio template drifted; label anchor not found exactly once: {old!r}')
        template = template.replace(old, new)
    return template


def build_comparison_viewer(results_dir: Path, three_base_url: str = DEFAULT_THREE_CDN_BASE) -> Path:
    """Write the multi-file `comparison_viewer.html` (GLBs loaded by relative path; needs HTTP)."""
    viewer_path = results_dir / 'comparison_viewer.html'
    viewer_path.write_text(
        render_studio_html(build_studio_payload(results_dir), three_base_url=three_base_url, standalone=False),
        encoding='utf-8',
    )
    return viewer_path


def build_legacy_single_file_studio(results_dir: Path) -> Path:
    """Write the legacy all-dishes `interactive_3d_studio.html` (base64 of every mobile GLB; heavy)."""
    standalone_payload = build_studio_payload(results_dir, embed_mobile_assets=True, max_thumb_px=512)
    standalone_path = results_dir / 'interactive_3d_studio.html'
    standalone_path.write_text(
        render_studio_html(standalone_payload, three_base_url=DEFAULT_THREE_CDN_BASE, standalone=True),
        encoding='utf-8',
    )
    return standalone_path


def build_studio_files(
    results_dir: Path,
    three_base_url: str = DEFAULT_THREE_CDN_BASE,
) -> tuple[Path, Path]:
    """Generate both multi-file `comparison_viewer.html` and self-contained `interactive_3d_studio.html`.

    Kept for existing callers (`merge_multi_model_results.py`); new builds should prefer
    `build_split_studio`, which keeps every page small.
    """
    return build_comparison_viewer(results_dir, three_base_url), build_legacy_single_file_studio(results_dir)


_GLB_MAGIC = b'glTF'
_GLB_JSON_CHUNK = 0x4E4F534A
_GLB_JSON_LIMIT_BYTES = 64 * 1024 * 1024


def measure_glb_faces(path: Path) -> int | None:
    """Count triangles declared by a GLB's own JSON chunk (indices, else POSITION accessor counts).

    Reads only the 20-byte header and the JSON chunk, never the binary buffer. Returns ``None`` for
    a missing/undecodable file or one with no triangle primitives, never a misleading zero.
    """
    try:
        with open(path, 'rb') as fh:
            header = fh.read(20)
            if len(header) < 20:
                return None
            magic, _version, _total, json_len, chunk_type = struct.unpack('<4sIIII', header)
            if magic != _GLB_MAGIC or chunk_type != _GLB_JSON_CHUNK or json_len > _GLB_JSON_LIMIT_BYTES:
                return None
            gltf = json.loads(fh.read(json_len).decode('utf-8'))
    except (OSError, ValueError, struct.error, UnicodeDecodeError):
        return None
    accessors = gltf.get('accessors') or []

    def _count(index: object) -> int | None:
        if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(accessors):
            count = accessors[index].get('count') if isinstance(accessors[index], dict) else None
            if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
                return count
        return None

    faces = 0
    seen = False
    for mesh in gltf.get('meshes') or []:
        for prim in (mesh or {}).get('primitives') or []:
            mode = prim.get('mode', 4)
            if mode not in (4, 5, 6):
                continue
            count = _count(prim['indices']) if 'indices' in prim else _count((prim.get('attributes') or {}).get('POSITION'))
            if count is None:
                continue
            seen = True
            faces += count // 3 if mode == 4 else max(count - 2, 0)
    return faces if seen else None


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
        if target.suffix.lower() == '.html':
            # Built pages pin the CDN; only the live loopback server swaps in the vendored copy.
            vendor_base = resolve_default_three_base_url(self.three_dir)
            if vendor_base != DEFAULT_THREE_CDN_BASE:
                body = body.replace(
                    f'"{DEFAULT_THREE_CDN_BASE}/'.encode('utf-8'), f'"{vendor_base}/'.encode('utf-8')
                )
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
    if (results_dir / 'studio' / 'index.html').is_file():
        print(f'Split studio index at   http://127.0.0.1:{server.server_port}/studio/index.html', flush=True)
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
    """Serving-time base: explicit URL, else `/vendor/three` when a local package exists, else CDN.

    Built files always pin the CDN; the loopback server rewrites it to this base on the fly.
    """
    if explicit_base_url:
        return explicit_base_url
    if three_dir is not None:
        return '/vendor/three'
    return DEFAULT_THREE_CDN_BASE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results-dir', required=True, type=Path, help='Notebook results directory holding manifest.json')
    parser.add_argument('--build', action='store_true',
                        help='Generate comparison_viewer.html and the split studio (index + one page per dish)')
    parser.add_argument('--out-dir', type=Path, default=None,
                        help='Split studio output directory (default: <results-dir>/studio)')
    parser.add_argument('--menu-manifest', type=Path, default=None,
                        help='Canonical dish list (extract_gmn9c8_dishes.py dishes_manifest.json); '
                             'dishes without outputs are listed as pending')
    parser.add_argument('--legacy-single-file', action='store_true',
                        help='Also write the heavy all-dishes interactive_3d_studio.html (base64 of every GLB)')
    parser.add_argument('--serve', action='store_true', help='Start loopback 127.0.0.1 HTTP server')
    parser.add_argument('--port', type=int, default=8765, help='Loopback HTTP port (default 8765)')
    parser.add_argument(
        '--three-base-url',
        default=None,
        help='Importmap base URL baked into built pages (default: pinned jsDelivr three@0.182.0; '
             '--serve swaps in /vendor/three on the fly when a local copy exists)',
    )
    args = parser.parse_args(argv)
    if not (args.build or args.serve):
        parser.error('Specify at least one of --build or --serve.')

    three_dir = find_local_three_dir()
    if args.build:
        base_url = args.three_base_url or DEFAULT_THREE_CDN_BASE
        v_path = build_comparison_viewer(args.results_dir, three_base_url=base_url)
        print(f'Built HTTP studio:       {v_path} ({v_path.stat().st_size} B)')
        out_dir = args.out_dir or (args.results_dir / 'studio')
        index_path, dish_paths = build_split_studio(
            args.results_dir, out_dir, menu_manifest=args.menu_manifest, three_base_url=base_url,
        )
        sizes = sorted(p.stat().st_size for p in dish_paths)
        print(f'Built split studio:      {index_path} ({index_path.stat().st_size} B, '
              f'{len(dish_paths)} dish pages, largest {sizes[-1] if sizes else 0} B)')
        if args.legacy_single_file:
            s_path = build_legacy_single_file_studio(args.results_dir)
            print(f'Built legacy standalone: {s_path} ({s_path.stat().st_size} B)')
    if args.serve:
        serve_studio(args.results_dir, port=args.port, three_dir=three_dir)
    return 0


def _check_label(label: object) -> str:
    if not isinstance(label, str) or not _SAFE_LABEL_RE.match(label):
        raise ValueError(f'Unsafe dish label for split studio file name: {label!r}')
    return label


def _check_slug(slug: object) -> str:
    if not isinstance(slug, str) or not _SAFE_SLUG_RE.match(slug):
        raise ValueError(f'Unsafe model slug for split studio: {slug!r}')
    return slug


def _load_menu(menu_manifest: Path | None) -> list[dict]:
    """Read the canonical dish list (`dishes_manifest.json` dict or a plain JSON list)."""
    if menu_manifest is None:
        return []
    raw = json.loads(Path(menu_manifest).read_text(encoding='utf-8'))
    items = raw.get('dishes') if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise ValueError(f'Menu manifest {menu_manifest} has no dish list')
    menu: list[dict] = []
    seen: set[str] = set()
    for item in items:
        entry = {'label': item} if isinstance(item, str) else dict(item) if isinstance(item, dict) else {}
        label = _check_label(entry.get('label'))
        if label in seen:
            raise ValueError(f'Duplicate dish label in menu manifest: {label}')
        seen.add(label)
        image_path = None
        image_file = entry.get('image_file')
        if isinstance(image_file, str) and image_file:
            candidate = _safe_child_path(Path(menu_manifest).parent, image_file)
            image_path = candidate if candidate.is_file() else None
        menu.append({'label': label, 'title': entry.get('title'), 'tier': entry.get('tier'),
                     'page': entry.get('page'), 'image_path': image_path})
    return menu


def _write_image(src: Path, dst: Path, max_dim: int, *, keep_alpha: bool) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        img = ImageOps.exif_transpose(im)
        if keep_alpha:
            img = img.convert('RGBA')
        elif 'A' in img.getbands():
            img = Image.alpha_composite(Image.new('RGBA', img.size, (19, 26, 38, 255)), img.convert('RGBA')).convert('RGB')
        else:
            img = img.convert('RGB')
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        if keep_alpha:
            img.save(dst, format='PNG', optimize=True)
        else:
            img.save(dst, format='JPEG', quality=82, optimize=True)


def _rel_href(target: Path, page_dir: Path) -> str:
    rel = os.path.relpath(target.resolve(), page_dir.resolve())
    return '/'.join(quote(part) for part in Path(rel).as_posix().split('/'))


def _split_model_entries(results_dir: Path, dish: dict, assets_dir: Path, page_dir: Path,
                         raw_embed_limit: int) -> tuple[list[dict], dict[str, str]]:
    """Per-model status rows for one dish plus base64 of the single viewable GLB per model."""
    runs = {r['slug']: r for r in dish['runs']}
    models: list[dict] = []
    embeds: dict[str, str] = {}
    for status in dish['model_statuses']:
        slug = _check_slug(status['slug'])
        run = runs.get(slug)
        entry = {
            'slug': slug, 'name': status['name'],
            'status': 'pending' if status['status'] == 'not_run' else status['status'],
            'license': status.get('license'), 'appearance': status.get('appearance'),
            'elapsed_seconds': status.get('elapsed_seconds'), 'watertight': status.get('watertight'),
            'error': status.get('error'), 'mobile': None, 'raw': None, 'fallback_image': None,
        }
        if run is not None:
            raw_abs = _safe_child_path(results_dir, run['raw']['path']) if (run.get('raw') or {}).get('path') else None
            mob_abs = _safe_child_path(results_dir, run['mobile']['path']) if (run.get('mobile') or {}).get('path') else None
            if raw_abs is not None and raw_abs.is_file():
                entry['raw'] = {'href': _rel_href(raw_abs, page_dir), 'filename': raw_abs.name,
                                'bytes': raw_abs.stat().st_size, 'faces_measured': measure_glb_faces(raw_abs)}
            embed_src = mob_abs if (mob_abs is not None and mob_abs.is_file()) else None
            raw_fallback = False
            if embed_src is None and raw_abs is not None and raw_abs.is_file() and raw_abs.stat().st_size <= raw_embed_limit:
                embed_src, raw_fallback = raw_abs, True
            if embed_src is not None:
                embed_id = f'glb-{slug}'
                embeds[embed_id] = _encode_file_base64(embed_src)
                entry['mobile'] = {'embed_id': embed_id, 'filename': embed_src.name, 'is_raw': raw_fallback,
                                   'bytes': embed_src.stat().st_size, 'faces_measured': measure_glb_faces(embed_src)}
            if run.get('fallback_image'):
                fb_src = _safe_child_path(results_dir, run['fallback_image'])
                if fb_src.is_file():
                    fb_dst = assets_dir / f'{slug}_fallback.png'
                    _write_image(fb_src, fb_dst, DISH_REF_PX, keep_alpha=True)
                    entry['fallback_image'] = _rel_href(fb_dst, page_dir)
        models.append(entry)
    return models, embeds


def _status_rows_without_page(manifest: dict, label: str) -> list[dict]:
    rows = []
    for status in _model_statuses(manifest, label, []):
        _check_slug(status['slug'])
        rows.append({'slug': status['slug'], 'name': status['name'],
                     'status': 'pending' if status['status'] == 'not_run' else status['status'],
                     'error': status.get('error'), 'mobile': None, 'raw': None})
    return rows


def render_split_dish_page(dish_data: dict, embeds: dict[str, str], three_base_url: str = DEFAULT_THREE_CDN_BASE) -> str:
    """Render one dish page holding only that dish's viewable GLBs as inert base64 script blocks."""
    if dish_data.get('publication_eligible') is not False:
        raise ValueError('Studio payload must retain publication_eligible=false.')
    glb_scripts = '\n'.join(
        f'  <script type="application/octet-stream" id="{html_lib.escape(embed_id)}">{b64}</script>'
        for embed_id, b64 in embeds.items()
    )
    title = dish_data.get('title') or dish_data['label']
    replacements = {
        '__TITLE__': html_lib.escape(f'{title} — PeekaPlate 3D Dish Studio'),
        '__DISH_TITLE__': html_lib.escape(title),
        '__IMPORTMAP_JSON__': _safe_json_for_script(_import_map(three_base_url)),
        '__DISH_DATA_JSON__': _safe_json_for_script(dish_data),
        '__DEMO_BADGE__': html_lib.escape(_demo_badge(dish_data)),
        '__GLB_SCRIPTS__': glb_scripts,
    }
    return _SPLIT_TOKEN_RE.sub(lambda match: replacements[match.group(0)], _SPLIT_DISH_TEMPLATE)


_SPLIT_TOKEN_RE = re.compile(r'__(?:TITLE|DISH_TITLE|IMPORTMAP_JSON|DISH_DATA_JSON|DEMO_BADGE|GLB_SCRIPTS)__')


def _fmt_faces(value: object) -> str:
    return f'{value:,}' if isinstance(value, int) else '?'


def render_split_index(cards: list[dict], model_order: list[tuple[str, str]], demo_label: str) -> str:
    """Render the light index: coverage per model over every listed dish, then one card per dish."""
    e = html_lib.escape
    total = len(cards)
    coverage_rows = []
    for slug, name in model_order:
        counts = {key: 0 for key in ('success', 'skipped', 'failed', 'pending')}
        for card in cards:
            status = next((m['status'] for m in card['models'] if m['slug'] == slug), 'pending')
            counts[status if status in counts else 'failed'] += 1
        coverage_rows.append(
            f'<tr data-coverage="{e(slug)}" data-success="{counts["success"]}" data-skipped="{counts["skipped"]}" '
            f'data-failed="{counts["failed"]}" data-pending="{counts["pending"]}" data-total="{total}">'
            f'<th scope="row">{e(name)}</th><td>{counts["success"]}</td><td>{counts["skipped"]}</td>'
            f'<td>{counts["failed"]}</td><td>{counts["pending"]}</td><td>{total}</td></tr>'
        )
    card_html = []
    for card in cards:
        cells = []
        for model in card['models']:
            mob_faces = (model.get('mobile') or {}).get('faces_measured')
            raw_faces = (model.get('raw') or {}).get('faces_measured')
            detail = []
            if mob_faces is not None:
                detail.append(f'{_fmt_faces(mob_faces)} mobile faces')
            if raw_faces is not None:
                detail.append(f'{_fmt_faces(raw_faces)} full')
            reason = model.get('error') if model['status'] in ('skipped', 'failed') else None
            cells.append(
                f'<li data-cell="{e(card["label"])}/{e(model["slug"])}" data-status="{e(model["status"])}" '
                f'data-mobile-faces="{"" if mob_faces is None else mob_faces}" '
                f'data-raw-faces="{"" if raw_faces is None else raw_faces}"'
                + (f' title="{e(str(reason))}"' if reason else '')
                + f'><span class="m">{e(model["name"])}</span>'
                f'<span class="st st-{e(model["status"])}">{e(model["status"])}</span>'
                f'<span class="fc">{e(" · ".join(detail))}</span></li>'
            )
        thumb = (f'<img src="{e(card["thumb"])}" alt="" loading="lazy" width="96" height="96" />'
                 if card.get('thumb') else '<div class="noimg">no image</div>')
        heading = e(card.get('title') or card['label'])
        meta = ' · '.join(e(str(v)) for v in (card['label'], card.get('tier'),
                                              f'p{card["page"]}' if card.get('page') else None) if v)
        link = (f'<a class="open" href="{e(card["href"])}">Open 3D viewer</a>' if card.get('href')
                else '<span class="open none">No 3D outputs yet</span>')
        card_html.append(
            f'<article class="card" data-dish="{e(card["label"])}">{thumb}<div class="body">'
            f'<h2>{heading}</h2><div class="meta">{meta}</div><ul>{"".join(cells)}</ul>{link}</div></article>'
        )
    with_pages = sum(1 for c in cards if c.get('href'))
    return (_SPLIT_INDEX_HEAD
            + f'<header><h1>PeekaPlate dish-to-3D studio</h1><p class="sub">{total} dishes listed · '
              f'{with_pages} with 3D outputs · statuses from the merged manifest; face counts measured from '
              f'each GLB · <span class="badge">{e(_demo_badge({"demo_label": demo_label}))}</span></p></header>'
            + '<section aria-label="Per-model coverage"><table class="cov"><thead><tr><th>Model</th><th>Success</th>'
              '<th>Skipped</th><th>Failed</th><th>Pending</th><th>Dishes</th></tr></thead><tbody>'
            + ''.join(coverage_rows) + '</tbody></table></section>'
            + '<input id="q" type="search" placeholder="Filter dishes" aria-label="Filter dishes" />'
            + '<main class="grid">' + ''.join(card_html) + '</main>'
            + _SPLIT_INDEX_TAIL)


def build_split_studio(
    results_dir: Path,
    out_dir: Path,
    *,
    menu_manifest: Path | None = None,
    three_base_url: str = DEFAULT_THREE_CDN_BASE,
    raw_embed_limit: int = RAW_EMBED_LIMIT_BYTES,
) -> tuple[Path, list[Path]]:
    """Write `index.html` + `dishes/<label>.html` + small image assets under `out_dir`.

    Each dish page embeds only that dish's mobile GLBs (so it opens from file:// without fetch),
    links full-resolution GLBs relatively, and the index carries no Three.js or GLB bytes.
    """
    results_dir = Path(results_dir)
    out_dir = Path(out_dir)
    manifest = json.loads((results_dir / 'manifest.json').read_text(encoding='utf-8'))
    payload = build_studio_payload(results_dir, embed_mobile_assets=False)
    menu = _load_menu(menu_manifest)
    dishes_dir = out_dir / 'dishes'
    dishes_dir.mkdir(parents=True, exist_ok=True)

    by_label = {_check_label(d['label']): d for d in payload['dishes']}
    menu_by_label = {m['label']: m for m in menu}
    order = [m['label'] for m in menu] + [label for label in by_label if label not in menu_by_label]
    page_labels = [label for label in order if label in by_label]
    model_order = [(slug, name) for slug, (name, _license) in MODELS.items()]

    cards: list[dict] = []
    dish_paths: list[Path] = []
    for label in order:
        dish = by_label.get(label)
        menu_entry = menu_by_label.get(label, {})
        assets_dir = out_dir / 'assets' / label
        thumb_src = None
        if dish is not None and dish.get('source_image'):
            thumb_src = _safe_child_path(results_dir, dish['source_image'])
        elif menu_entry.get('image_path') is not None:
            thumb_src = menu_entry['image_path']
        thumb_href = None
        if thumb_src is not None and thumb_src.is_file():
            _write_image(thumb_src, assets_dir / 'thumb.jpg', INDEX_THUMB_PX, keep_alpha=False)
            thumb_href = f'assets/{label}/thumb.jpg'
        title = (dish or {}).get('title') or menu_entry.get('title')
        tier = (dish or {}).get('tier') or menu_entry.get('tier')
        page = (dish or {}).get('page') or menu_entry.get('page')

        if dish is None:
            cards.append({'label': label, 'title': title, 'tier': tier, 'page': page, 'thumb': thumb_href,
                          'href': None, 'models': _status_rows_without_page(manifest, label)})
            continue

        models, embeds = _split_model_entries(results_dir, dish, assets_dir, dishes_dir, raw_embed_limit)
        refs = {}
        for key, rel, dst_name, alpha in (('source', dish.get('source_image'), 'source.jpg', False),
                                          ('cutout', dish.get('cutout_image'), 'cutout.png', True)):
            if rel:
                src = _safe_child_path(results_dir, rel)
                if src.is_file():
                    _write_image(src, assets_dir / dst_name, DISH_REF_PX, keep_alpha=alpha)
                    refs[key] = f'../assets/{label}/{dst_name}'
        idx = page_labels.index(label)
        dish_data = {
            'schema_version': 1,
            'label': label, 'title': title, 'tier': tier, 'page': page,
            'demo_label': payload['demo_label'], 'publication_eligible': False,
            'three_version': THREE_VERSION,
            'size': dish.get('size'), 'source_sha256': dish.get('source_sha256'), 'job_id': dish.get('job_id'),
            'cutout_metrics': dish.get('cutout_metrics') or {},
            'source_image': refs.get('source'), 'cutout_image': refs.get('cutout'),
            'prev': f'{page_labels[idx - 1]}.html' if idx > 0 else None,
            'next': f'{page_labels[idx + 1]}.html' if idx + 1 < len(page_labels) else None,
            'models': models,
        }
        page_path = dishes_dir / f'{label}.html'
        page_path.write_text(render_split_dish_page(dish_data, embeds, three_base_url), encoding='utf-8')
        dish_paths.append(page_path)
        cards.append({'label': label, 'title': title, 'tier': tier, 'page': page, 'thumb': thumb_href,
                      'href': f'dishes/{label}.html', 'models': models})

    index_path = out_dir / 'index.html'
    index_path.write_text(render_split_index(cards, model_order, payload['demo_label']), encoding='utf-8')
    return index_path, dish_paths


_SPLIT_INDEX_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PeekaPlate dish-to-3D studio — index</title>
<style>
:root { color-scheme: dark; --bg: #0b0f17; --panel: #131a26; --border: #2a374d; --text: #eef3fa; --muted: #93a6c2; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 20px 40px; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
h1 { margin: 0 0 4px; font-size: 18px; }
.sub { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.badge { padding: 2px 8px; border-radius: 999px; border: 1px solid #3c5478; background: #1a273b; color: #bfdbfe; }
table.cov { border-collapse: collapse; margin-bottom: 14px; font-size: 12px; }
table.cov th, table.cov td { border: 1px solid var(--border); padding: 4px 10px; text-align: right; }
table.cov th[scope=row], table.cov thead th:first-child { text-align: left; }
#q { margin-bottom: 12px; padding: 6px 10px; width: min(360px, 100%); background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
.card { display: flex; gap: 10px; padding: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
.card[hidden] { display: none; }
.card img, .noimg { width: 96px; height: 96px; flex-shrink: 0; border-radius: 8px; object-fit: cover; background: #0a0e14; }
.noimg { display: grid; place-items: center; color: var(--muted); font-size: 11px; }
.body { min-width: 0; flex: 1; }
h2 { margin: 0; font-size: 14px; }
.meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
ul { list-style: none; margin: 0 0 6px; padding: 0; font-size: 11px; }
li { display: grid; grid-template-columns: 1fr auto; column-gap: 6px; }
li .fc { grid-column: 1 / -1; color: var(--muted); }
li .fc:empty { display: none; }
.st { font-weight: 700; text-transform: uppercase; font-size: 10px; }
.st-success { color: #34d399; } .st-skipped { color: #f59e0b; } .st-failed { color: #f87171; } .st-pending { color: #93a6c2; }
.open { display: inline-block; font-size: 12px; color: #93c5fd; }
.open.none { color: var(--muted); }
</style>
</head>
<body>
"""

_SPLIT_INDEX_TAIL = """
<script>
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    const needle = q.value.trim().toLowerCase();
    for (const card of document.querySelectorAll('.card')) {
      card.hidden = needle !== '' && !card.textContent.toLowerCase().includes(needle);
    }
  });
</script>
</body>
</html>
"""

_SPLIT_DISH_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__TITLE__</title>
  <script type="importmap">__IMPORTMAP_JSON__</script>
  <style>
    :root { color-scheme: dark; --bg: #0b0f17; --panel: #131a26; --panel-2: #192232; --border: #2a374d; --text: #eef3fa; --muted: #93a6c2; --accent: #3b82f6; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 10px 16px; border-bottom: 1px solid var(--border); background: #0f1520; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
    header h1 { margin: 0; font-size: 16px; }
    .sub { font-size: 12px; color: var(--muted); }
    .nav { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .badge { padding: 3px 9px; border-radius: 999px; font-size: 11px; border: 1px solid #3c5478; background: #1a273b; color: #bfdbfe; }
    .layout { flex: 1; display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
    @media (max-width: 960px) { .layout { grid-template-columns: 1fr; } }
    aside { border-right: 1px solid var(--border); background: #0f151f; padding: 12px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
    .sec-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 4px; }
    .ref-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .ref-box { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--muted); }
    .ref-box img { width: 100%; height: 110px; object-fit: contain; border-radius: 6px; background: #0a0e14; }
    .ref-box img.checker { background: repeating-conic-gradient(#1e2633 0% 25%, #2b3648 0% 50%) 50% / 14px 14px; }
    .kv { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
    .kv b { color: var(--text); font-weight: 600; }
    table.mx { border-collapse: collapse; width: 100%; font-size: 11px; }
    table.mx th, table.mx td { border-bottom: 1px solid var(--border); padding: 4px 3px; text-align: left; vertical-align: top; }
    .st-success { color: #34d399; } .st-skipped { color: #f59e0b; } .st-failed { color: #f87171; } .st-pending { color: #93a6c2; }
    main { display: flex; flex-direction: column; min-width: 0; padding: 12px; gap: 10px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
    .grp { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-right: 8px; border-right: 1px solid var(--border); }
    .grp:last-child { border-right: none; }
    .grp-lbl { font-size: 11px; color: var(--muted); margin-right: 4px; }
    button.ctrl, a.ctrl { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px; font-size: 12px; cursor: pointer; text-decoration: none; }
    button.ctrl.active { background: var(--accent); border-color: #60a5fa; color: #fff; }
    button.ctrl:disabled { opacity: 0.45; cursor: not-allowed; }
    a.ctrl[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
    label.slider { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
    .stage-wrap { flex: 1; display: grid; grid-template-columns: 1fr; gap: 10px; min-height: 460px; }
    .stage-wrap.compare { grid-template-columns: 1fr 1fr; }
    @media (max-width: 960px) { .stage-wrap.compare { grid-template-columns: 1fr; } }
    .vp-card { position: relative; display: flex; flex-direction: column; border-radius: 12px; border: 1px solid var(--border); background: #080b10; overflow: hidden; min-height: 440px; }
    .vp-card.hidden { display: none; }
    .vp-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(19, 26, 38, 0.92); border-bottom: 1px solid var(--border); font-size: 12px; gap: 8px; flex-wrap: wrap; }
    .vp-title { font-weight: 700; }
    .vp-stats { color: var(--muted); }
    .vp-canvas-host { position: relative; flex: 1; width: 100%; min-height: 380px; }
    .vp-canvas-host.no-webgl { display: none; }
    .vp-canvas-host canvas { display: block; width: 100%; height: 100%; outline: none; }
    .vp-overlay { position: absolute; inset: 10px; pointer-events: none; display: flex; align-items: flex-end; font-size: 11px; color: var(--muted); }
    .vp-pill { background: rgba(11, 15, 23, 0.78); border: 1px solid var(--border); padding: 3px 8px; border-radius: 6px; }
    .fallback-box { display: none; padding: 14px; gap: 10px; flex-direction: column; align-items: flex-start; }
    .fallback-box.active { display: flex; }
    .fallback-box img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); }
    .fallback-msg { font-size: 12px; color: var(--muted); }
    .notice { padding: 8px 10px; border-radius: 8px; border: 1px solid #6b4e1b; background: rgba(245, 158, 11, 0.1); color: #fde68a; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>__DISH_TITLE__</h1>
      <div class="sub" id="dish-sub">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
    </div>
    <div class="nav">
      <a class="ctrl" href="../index.html">All dishes</a>
      <a class="ctrl" id="nav-prev" href="#">Previous</a>
      <a class="ctrl" id="nav-next" href="#">Next</a>
      <span class="badge">__DEMO_BADGE__</span>
    </div>
  </header>

  <div class="layout">
    <aside>
      <div>
        <div class="sec-title">Plate + Food Reference</div>
        <div class="ref-pair">
          <div class="ref-box"><span>Source photo</span><img id="ref-source" alt="Source photo" /></div>
          <div class="ref-box"><span>Cutout (plate + food)</span><img id="ref-cutout" class="checker" alt="Plate cutout" /></div>
        </div>
      </div>
      <div class="kv" id="dish-telemetry"></div>
      <div>
        <div class="sec-title">Models for this dish</div>
        <table class="mx" id="model-matrix" aria-label="Per-model results for this dish"></table>
      </div>
    </aside>

    <main>
      <div class="toolbar">
        <div class="grp" id="grp-backend"><span class="grp-lbl">Model</span></div>
        <div class="grp" id="grp-profile">
          <span class="grp-lbl">Mesh</span>
          <button class="ctrl active" data-profile="mobile">Mobile (&lt;=35k, embedded)</button>
          <button class="ctrl" data-profile="raw">Full resolution</button>
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
        </div>
      </div>

      <div id="webgl-notice" class="notice" hidden></div>
      <div id="compare-controls" hidden><label>Left <select id="cmp-left"></select></label> <label>Right <select id="cmp-right"></select></label></div>

      <div class="stage-wrap" id="stage-wrap">
        <div class="vp-card" id="vp-primary">
          <div class="vp-head"><span class="vp-title" data-role="title">Loading…</span><span class="vp-stats" data-role="stats"></span></div>
          <div class="vp-canvas-host" data-role="host"><div class="vp-overlay"><span class="vp-pill" data-role="status">Initializing WebGL…</span></div></div>
          <div class="fallback-box" data-role="fallback"></div>
        </div>
        <div class="vp-card hidden" id="vp-secondary">
          <div class="vp-head"><span class="vp-title" data-role="title">Compare</span><span class="vp-stats" data-role="stats"></span></div>
          <div class="vp-canvas-host" data-role="host"><div class="vp-overlay"><span class="vp-pill" data-role="status">Synced camera</span></div></div>
          <div class="fallback-box" data-role="fallback"></div>
        </div>
      </div>
    </main>
  </div>

  <script id="dish-data" type="application/json">__DISH_DATA_JSON__</script>
__GLB_SCRIPTS__
  <script type="module">
    const DATA = JSON.parse(document.getElementById('dish-data').textContent);
    const BG_HEX = { dark: 0x080b10, neutral: 0x263142, light: 0xe6ebf2 };
    const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'envMap'];
    const CAN_FETCH = location.protocol === 'http:' || location.protocol === 'https:';
    const MODELS = DATA.models;
    const VIEWABLE = MODELS.filter((m) => m.mobile || (CAN_FETCH && m.raw));
    const state = {
      view: VIEWABLE[0]?.slug || null, profile: 'mobile', shader: 'pbr', wireframe: false,
      autoRotate: false, grid: true, bg: 'dark', exposure: 1.1, webglReady: false,
    };
    let THREE, OrbitControls, GLTFLoader, RoomEnvironment;
    const noticeEl = document.getElementById('webgl-notice');
    const stageWrap = document.getElementById('stage-wrap');
    const cmpLeft = document.getElementById('cmp-left');
    const cmpRight = document.getElementById('cmp-right');

    function shell(cardId) {
      const card = document.getElementById(cardId);
      const q = (role) => card.querySelector('[data-role="' + role + '"]');
      return { card, hostEl: q('host'), titleEl: q('title'), statsEl: q('stats'), statusEl: q('status'), fallbackEl: q('fallback'),
               renderer: null, scene: null, camera: null, controls: null, gridHelper: null, envTex: null, observer: null,
               onLost: null, root: null, originalMeshes: [], loadToken: 0, key: null };
    }
    const vpA = shell('vp-primary');
    const vpB = shell('vp-secondary');
    const comparing = () => state.view === 'compare' && VIEWABLE.length >= 2;
    const modelBySlug = (slug) => MODELS.find((m) => m.slug === slug) || null;

    function decodeEmbedded(id) {
      const bin = atob(document.getElementById(id).textContent.trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }

    function disposeMaterial(mat, disposeTextures = true) {
      for (const m of (Array.isArray(mat) ? mat : [mat])) {
        if (!m) continue;
        if (disposeTextures) {
          for (const slot of TEX_SLOTS) {
            const tex = m[slot];
            if (tex && typeof tex.dispose === 'function') { tex.source?.data?.close?.(); tex.dispose(); }
          }
        }
        m.dispose?.();
      }
    }

    function disposeObject3D(root) {
      root?.traverse((obj) => { obj.geometry?.dispose(); if (obj.material) disposeMaterial(obj.material, true); });
    }

    function clearViewportModel(vp) {
      if (vp.scene && vp.root) vp.scene.remove(vp.root);
      for (const entry of vp.originalMeshes) {
        if (entry.origMat && entry.origMat !== entry.mesh?.material) disposeMaterial(entry.origMat, true);
      }
      disposeObject3D(vp.root);
      vp.root = null;
      vp.originalMeshes = [];
      vp.key = null;
    }

    function disposeViewport(vp) {
      vp.loadToken++;
      clearViewportModel(vp);
      if (!vp.renderer) return;
      vp.observer?.disconnect();
      vp.controls?.dispose();
      vp.envTex?.dispose();
      vp.gridHelper?.geometry.dispose();
      disposeMaterial(vp.gridHelper?.material, false);
      vp.renderer.domElement.removeEventListener('webglcontextlost', vp.onLost);
      vp.renderer.renderLists.dispose();
      vp.renderer.dispose();
      vp.renderer.forceContextLoss();
      vp.renderer.domElement.remove();
      Object.assign(vp, { renderer: null, scene: null, camera: null, controls: null, gridHelper: null, envTex: null, observer: null });
    }

    function showFallback(vp, model, message) {
      vp.hostEl.classList.add('no-webgl');
      vp.fallbackEl.replaceChildren();
      vp.fallbackEl.classList.add('active');
      const p = document.createElement('div');
      p.className = 'fallback-msg';
      p.textContent = message;
      vp.fallbackEl.appendChild(p);
      const src = model?.fallback_image || DATA.cutout_image || DATA.source_image;
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = (model?.name || DATA.label) + ' static preview';
        vp.fallbackEl.appendChild(img);
      }
    }

    function ensureRenderer(vp) {
      if (vp.renderer || !state.webglReady) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = state.exposure;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      vp.hostEl.insertBefore(renderer.domElement, vp.hostEl.firstChild);
      vp.onLost = (ev) => {
        ev.preventDefault();
        clearViewportModel(vp);
        noticeEl.hidden = false;
        noticeEl.textContent = 'WebGL context lost. Showing static plate-preserving renders; GLB downloads remain available.';
        showFallback(vp, null, 'WebGL context lost');
      };
      renderer.domElement.addEventListener('webglcontextlost', vp.onLost);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(BG_HEX[state.bg]);
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      vp.envTex = pmrem.fromScene(envScene, 0.04).texture;
      scene.environment = vp.envTex;
      envScene.dispose();
      pmrem.dispose();
      const key = new THREE.DirectionalLight(0xfff5e8, 1.85);
      key.position.set(2.5, 4.0, 2.2);
      key.castShadow = true;
      const rim = new THREE.DirectionalLight(0x9ec5fe, 0.75);
      rim.position.set(-2.6, 2.2, -2.5);
      scene.add(new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 0.45), key, rim);
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
      controls.autoRotate = state.autoRotate;
      controls.update();
      controls.addEventListener('change', () => syncCamera(vp));
      Object.assign(vp, { renderer, scene, camera, controls, gridHelper: grid });

      const resize = () => {
        const w = Math.max(vp.hostEl.clientWidth, 100);
        const h = Math.max(vp.hostEl.clientHeight, 360);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      vp.observer = new ResizeObserver(resize);
      vp.observer.observe(vp.hostEl);
      resize();
    }

    let syncingCam = false;
    function syncCamera(src) {
      const dst = src === vpA ? vpB : vpA;
      if (syncingCam || !comparing() || !dst.controls) return;
      syncingCam = true;
      dst.camera.position.copy(src.camera.position);
      dst.controls.target.copy(src.controls.target);
      dst.controls.update();
      syncingCam = false;
    }

    function applyShaderToViewport(vp) {
      if (!vp.root) return;
      for (const { mesh, origMat, hasVC } of vp.originalMeshes) {
        const baseMap = (Array.isArray(origMat) ? origMat[0] : origMat)?.map || null;
        let nextMat;
        if (state.shader === 'base_color') {
          nextMat = new THREE.MeshBasicMaterial({ map: hasVC ? null : baseMap, vertexColors: hasVC, color: (hasVC || baseMap) ? 0xffffff : 0xd8cdbf, side: THREE.DoubleSide, wireframe: state.wireframe });
        } else if (state.shader === 'clay') {
          nextMat = new THREE.MeshStandardMaterial({ color: 0xdfd3c3, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide, wireframe: state.wireframe });
        } else if (state.shader === 'normal') {
          nextMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, wireframe: state.wireframe });
        } else if (Array.isArray(origMat)) {
          nextMat = origMat.map((m) => { const c = m.clone(); c.side = THREE.DoubleSide; c.wireframe = state.wireframe; return c; });
        } else if (origMat) {
          nextMat = origMat.clone();
          nextMat.side = THREE.DoubleSide;
          nextMat.wireframe = state.wireframe;
          if (!hasVC && !nextMat.map && nextMat.color && origMat.color?.getHex() === 0xffffff) nextMat.color.setHex(0xd9cec1);
        } else {
          nextMat = new THREE.MeshStandardMaterial({ color: 0xd9cec1, roughness: 0.55, metalness: 0.05, vertexColors: hasVC, side: THREE.DoubleSide, wireframe: state.wireframe });
        }
        const prev = mesh.material;
        mesh.material = nextMat;
        if (prev && prev !== origMat) disposeMaterial(prev, false);
      }
    }

    function pickProfile(model) {
      if (!model) return null;
      if (state.profile === 'raw' && CAN_FETCH && model.raw) {
        return { kind: 'url', url: model.raw.href, label: 'Full resolution', faces: model.raw.faces_measured, bytes: model.raw.bytes, filename: model.raw.filename };
      }
      if (model.mobile) {
        return { kind: 'embed', id: model.mobile.embed_id, label: model.mobile.is_raw ? 'Full resolution (no mobile export)' : 'Mobile (<=35k)', faces: model.mobile.faces_measured, bytes: model.mobile.bytes, filename: model.mobile.filename };
      }
      if (CAN_FETCH && model.raw) {
        return { kind: 'url', url: model.raw.href, label: 'Full resolution', faces: model.raw.faces_measured, bytes: model.raw.bytes, filename: model.raw.filename };
      }
      return null;
    }

    async function loadModelIntoViewport(vp, model) {
      const prof = pickProfile(model);
      const key = model ? model.slug + ':' + (prof?.kind === 'url' ? 'raw' : 'mobile') : 'none';
      if (vp.key === key && vp.root) return;
      const token = ++vp.loadToken;
      vp.fallbackEl.classList.remove('active');
      vp.fallbackEl.replaceChildren();
      vp.titleEl.textContent = model ? model.name + ' · ' + (prof?.label || 'no GLB') : 'No model selected';
      vp.statsEl.textContent = prof ? (prof.faces != null ? prof.faces.toLocaleString() + ' faces (measured)' : 'faces ?') + ' · ' + Math.round((prof.bytes || 0) / 1024) + ' KB' : '';
      if (!model || !prof || !state.webglReady) {
        clearViewportModel(vp);
        const reason = !state.webglReady ? 'Static fallback (WebGL unavailable)' : 'No viewable GLB for this model';
        vp.statusEl.textContent = reason;
        showFallback(vp, model, reason);
        return;
      }
      ensureRenderer(vp);
      vp.hostEl.classList.remove('no-webgl');
      vp.statusEl.textContent = 'Loading ' + (prof.filename || 'mesh') + '…';
      try {
        let buffer;
        if (prof.kind === 'embed') {
          buffer = decodeEmbedded(prof.id);
        } else {
          const res = await fetch(prof.url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          buffer = await res.arrayBuffer();
        }
        const gltf = await new GLTFLoader().parseAsync(buffer, '');
        buffer = null;
        if (token !== vp.loadToken || !vp.scene) { disposeObject3D(gltf.scene); return; }
        clearViewportModel(vp);
        const root = gltf.scene;
        const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
        root.scale.setScalar(1.8 / Math.max(size.x, size.y, size.z, 1e-4));
        const sBox = new THREE.Box3().setFromObject(root);
        const center = sBox.getCenter(new THREE.Vector3());
        root.position.set(-center.x, -sBox.min.y, -center.z);
        const meshes = [];
        root.traverse((obj) => {
          if (obj.isMesh && obj.geometry) {
            if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
            obj.castShadow = true;
            obj.receiveShadow = true;
            meshes.push({ mesh: obj, origMat: obj.material, hasVC: Boolean(obj.geometry.attributes.color) });
          }
        });
        vp.root = root;
        vp.originalMeshes = meshes;
        vp.key = key;
        vp.scene.add(root);
        applyShaderToViewport(vp);
        vp.controls.target.set(0, (sBox.max.y - sBox.min.y) * 0.42, 0);
        vp.controls.update();
        vp.statusEl.textContent = 'Loaded (' + (prof.faces ?? '?') + ' faces)';
      } catch (err) {
        if (token !== vp.loadToken) return;
        clearViewportModel(vp);
        const msg = 'Load failed: ' + (err?.message || err);
        vp.statusEl.textContent = msg;
        showFallback(vp, model, msg);
      }
    }

    function setPreset(preset) {
      const presets = { front: [1.85, 1.25, 2.05], top: [0.01, 2.85, 0.35], side: [2.75, 0.85, 0.01], low: [1.95, 0.42, 1.95] };
      const pos = presets[preset] || presets.front;
      for (const vp of [vpA, vpB]) {
        if (!vp.camera) continue;
        vp.camera.position.set(pos[0], pos[1], pos[2]);
        vp.controls.update();
      }
    }

    function downloadEmbedded(model) {
      const url = URL.createObjectURL(new Blob([decodeEmbedded(model.mobile.embed_id)], { type: 'model/gltf-binary' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = DATA.label + '_' + model.mobile.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function renderStatic() {
      document.getElementById('ref-source').src = DATA.source_image || '';
      document.getElementById('ref-cutout').src = DATA.cutout_image || '';
      for (const [id, target] of [['nav-prev', DATA.prev], ['nav-next', DATA.next]]) {
        const a = document.getElementById(id);
        if (target) a.href = target; else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
      }
      document.getElementById('dish-sub').textContent = [DATA.label, DATA.tier, DATA.page ? 'page ' + DATA.page : null].filter(Boolean).join(' · ') + ' · Drag to orbit · Scroll to zoom · Right-drag to pan';
      const cm = DATA.cutout_metrics || {};
      const tel = document.getElementById('dish-telemetry');
      for (const [k, v] of [
        ['Photo', DATA.size ? DATA.size.join('×') : '?'],
        ['Plate mode', (cm.plate_preserved ? 'preserved' : 'food-only') + ' (+' + (cm.plate_added_pct ?? 0) + '%)'],
        ['Method', cm.plate_method || '?'],
        ['Source SHA', DATA.source_sha256 ? DATA.source_sha256.slice(0, 12) + '…' : 'n/a'],
      ]) {
        const div = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = k + ': ';
        div.append(b, document.createTextNode(String(v)));
        tel.appendChild(div);
      }
      const table = document.getElementById('model-matrix');
      const head = document.createElement('tr');
      for (const h of ['Model', 'Status', 'Faces mobile / full', 'Download']) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
      table.appendChild(head);
      for (const m of MODELS) {
        const tr = document.createElement('tr');
        const name = document.createElement('td'); name.textContent = m.name; name.title = [m.license, m.appearance].filter(Boolean).join(' · ');
        const st = document.createElement('td'); st.textContent = m.status; st.className = 'st-' + m.status; if (m.error) st.title = m.error;
        const fc = document.createElement('td');
        fc.textContent = (m.mobile?.faces_measured?.toLocaleString() ?? '—') + ' / ' + (m.raw?.faces_measured?.toLocaleString() ?? '—');
        const dl = document.createElement('td');
        if (m.mobile) {
          const btn = document.createElement('button'); btn.className = 'ctrl'; btn.textContent = m.mobile.is_raw ? 'GLB' : 'Mobile';
          btn.onclick = () => downloadEmbedded(m); dl.appendChild(btn);
        }
        if (m.raw) {
          const a = document.createElement('a'); a.className = 'ctrl'; a.href = m.raw.href; a.download = DATA.label + '_' + m.raw.filename;
          a.textContent = 'Full ' + (m.raw.bytes / 1048576).toFixed(1) + ' MB'; dl.appendChild(a);
        }
        tr.append(name, st, fc, dl);
        table.appendChild(tr);
      }
      const group = document.getElementById('grp-backend');
      for (const m of MODELS) {
        const btn = document.createElement('button');
        btn.className = 'ctrl'; btn.dataset.view = m.slug;
        btn.textContent = m.name + (m.status === 'success' ? '' : ' (' + m.status + ')');
        btn.disabled = !VIEWABLE.includes(m);
        btn.onclick = () => setView(m.slug);
        group.appendChild(btn);
      }
      const cmp = document.createElement('button');
      cmp.className = 'ctrl'; cmp.dataset.view = 'compare'; cmp.textContent = 'Compare Side-by-Side';
      cmp.disabled = VIEWABLE.length < 2;
      cmp.onclick = () => setView('compare');
      group.appendChild(cmp);
      for (const [select, idx] of [[cmpLeft, 0], [cmpRight, 1]]) {
        for (const m of VIEWABLE) { const o = document.createElement('option'); o.value = m.slug; o.textContent = m.name; select.appendChild(o); }
        select.value = VIEWABLE[Math.min(idx, VIEWABLE.length - 1)]?.slug || '';
        select.onchange = () => refresh();
      }
      const rawBtn = document.querySelector('#grp-profile [data-profile="raw"]');
      rawBtn.disabled = !CAN_FETCH || !MODELS.some((m) => m.raw);
      rawBtn.title = CAN_FETCH ? 'Fetch the full-resolution GLB' : 'Opened from file:// — use the Full download link, or run dish_3d_studio --serve';
    }

    async function refresh() {
      const cmpOn = comparing();
      for (const btn of document.querySelectorAll('#grp-backend [data-view]')) btn.classList.toggle('active', btn.dataset.view === state.view);
      for (const btn of document.querySelectorAll('#grp-profile [data-profile]')) btn.classList.toggle('active', btn.dataset.profile === state.profile);
      stageWrap.classList.toggle('compare', cmpOn);
      vpB.card.classList.toggle('hidden', !cmpOn);
      document.getElementById('compare-controls').hidden = !cmpOn;
      if (!cmpOn) disposeViewport(vpB);
      const primary = modelBySlug(cmpOn ? cmpLeft.value : state.view);
      await Promise.all([
        loadModelIntoViewport(vpA, primary),
        cmpOn ? loadModelIntoViewport(vpB, modelBySlug(cmpRight.value)) : null,
      ]);
    }

    function setView(view) { state.view = view; return refresh(); }

    document.querySelectorAll('#grp-profile [data-profile]').forEach((btn) => {
      btn.onclick = () => { if (!btn.disabled) { state.profile = btn.dataset.profile; refresh(); } };
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
    document.querySelectorAll('#grp-camera [data-preset]').forEach((btn) => { btn.onclick = () => setPreset(btn.dataset.preset); });
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
        for (const vp of [vpA, vpB]) if (vp.scene) vp.scene.background = new THREE.Color(BG_HEX[state.bg]);
      };
    });
    document.getElementById('rng-exposure').oninput = (ev) => {
      state.exposure = parseFloat(ev.target.value);
      for (const vp of [vpA, vpB]) if (vp.renderer) vp.renderer.toneMappingExposure = state.exposure;
    };

    function animate() {
      requestAnimationFrame(animate);
      if (document.hidden) return;
      for (const vp of [vpA, vpB]) {
        if (!vp.renderer || vp.card.classList.contains('hidden')) continue;
        vp.controls.update();
        vp.renderer.render(vp.scene, vp.camera);
      }
    }

    window.__PEEK_STUDIO__ = {
      state,
      setView,
      setProfile: (p) => { state.profile = p; return refresh(); },
      setShader: (s) => { state.shader = s; applyShaderToViewport(vpA); applyShaderToViewport(vpB); },
      snapshot: () => ({
        renderers: [vpA, vpB].filter((vp) => vp.renderer).length,
        models: [vpA, vpB].filter((vp) => vp.root).length,
        triangles: [vpA, vpB].map((vp) => vp.renderer?.info.render.triangles ?? 0),
        primary: { title: vpA.titleEl.textContent, status: vpA.statusEl.textContent },
        secondary: { title: vpB.titleEl.textContent, status: vpB.statusEl.textContent },
        viewable: VIEWABLE.map((m) => m.slug),
      }),
    };

    renderStatic();
    (async () => {
      try {
        [THREE, { OrbitControls }, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
          import('three'),
          import('three/addons/controls/OrbitControls.js'),
          import('three/addons/loaders/GLTFLoader.js'),
          import('three/addons/environments/RoomEnvironment.js'),
        ]);
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2') || probe.getContext('webgl');
        if (!gl) throw new Error('WebGL context is unavailable in this browser.');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        state.webglReady = true;
      } catch (err) {
        noticeEl.hidden = false;
        noticeEl.textContent = 'WebGL 3D renderer unavailable (' + (err?.message || err) + '). Showing static renders; GLB downloads remain available.';
      }
      if (state.webglReady) animate();
      await refresh();
    })();
  </script>
</body>
</html>
"""


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
      min-height: 760px;
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
        <input id="dish-search" type="search" placeholder="Search dishes" aria-label="Search dishes" />
        <div id="tier-filters"><button data-tier="">All</button><button data-tier="benchmark_4">Benchmark</button><button data-tier="hero">Hero</button><button data-tier="page12">Menu P12</button></div>
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
          <button class="ctrl active" data-view="trellis2-4b">TRELLIS.2-4B (PBR)</button>
        </div>
        <div class="grp" id="grp-profile">
          <span class="grp-lbl">Mesh</span>
          <button class="ctrl active" data-profile="mobile">TRELLIS Fast (&lt;=35k)</button>
          <button class="ctrl" data-profile="raw">TRELLIS Full (Raw)</button>
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

      <div id="compare-controls" hidden><label>Left <select id="cmp-left"></select></label> <label>Right <select id="cmp-right"></select></label></div>
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
            <span class="vp-title" id="vp-secondary-title">Secondary View</span>
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
      <section id="model-matrix" aria-label="Per-Dish Model Benchmark Matrix"></section>
    </main>
  </div>

  <script id="studio-data" type="application/json">__STUDIO_DATA_JSON__</script>
  <script type="module">
    const DATA = JSON.parse(document.getElementById('studio-data').textContent);
    const BG_HEX = { dark: 0x080b10, neutral: 0x263142, light: 0xe6ebf2 };
    const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'envMap'];

    const state = {
      dishIdx: 0,
      view: 'trellis2-4b',
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
    let vpA = { hostEl: document.getElementById('vp-primary-host'), titleEl: document.getElementById('vp-primary-title'), statsEl: document.getElementById('vp-primary-stats'), statusEl: document.getElementById('vp-primary-status'), fallbackEl: document.getElementById('vp-primary-fallback'), originalMeshes: [], loadToken: 0 };
    let vpB = { hostEl: document.getElementById('vp-secondary-host'), titleEl: document.getElementById('vp-secondary-title'), statsEl: document.getElementById('vp-secondary-stats'), statusEl: document.getElementById('vp-secondary-status'), fallbackEl: document.getElementById('vp-secondary-fallback'), originalMeshes: [], loadToken: 0 };

    const initThreeAsync = async () => {
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
      vpA = createViewport(
        document.getElementById('vp-primary-host'),
        document.getElementById('vp-primary-title'),
        document.getElementById('vp-primary-stats'),
        document.getElementById('vp-primary-status'),
        document.getElementById('vp-primary-fallback'),
      );
      vpB = createViewport(
        document.getElementById('vp-secondary-host'),
        document.getElementById('vp-secondary-title'),
        document.getElementById('vp-secondary-stats'),
        document.getElementById('vp-secondary-status'),
        document.getElementById('vp-secondary-fallback'),
      );
      linkCameras(vpA, vpB);
      linkCameras(vpB, vpA);
      if (state.webglReady) animate();
      refreshStage();
    };

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
        return { prof: run.raw, label: 'TRELLIS Full (Raw)', isRaw: true };
      }
      return { prof: run.mobile, label: 'TRELLIS Fast (<=35k)', isRaw: false };
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

    let tierFilter = '';
    document.getElementById('dish-search').oninput = renderDishSidebar;
    document.getElementById('tier-filters').onclick = (event) => {
      if (event.target.dataset.tier !== undefined) { tierFilter = event.target.dataset.tier; renderDishSidebar(); }
    };
    function renderDishSidebar() {
      dishListEl.innerHTML = '';
      DATA.dishes.forEach((dish, idx) => {
        const query = document.getElementById('dish-search').value.toLowerCase();
        if (!(dish.title || dish.label).toLowerCase().includes(query) || (tierFilter && dish.tier !== tierFilter && String(dish.page) !== tierFilter)) return;
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
        nm.textContent = dish.title || dish.label;
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

      const group = document.getElementById('grp-backend');
      group.replaceChildren();
      for (const model of dish.model_statuses) {
        const btn = document.createElement('button');
        btn.className = 'ctrl'; btn.dataset.view = model.slug; btn.textContent = model.name;
        btn.disabled = !dish.runs.some(r => r.slug === model.slug);
        btn.classList.toggle('active', state.view === model.slug);
        btn.onclick = () => { state.view = model.slug; refreshStage(); };
        group.appendChild(btn);
      }
      const compare = document.createElement('button');
      compare.className = 'ctrl'; compare.dataset.view = 'compare'; compare.textContent = 'Compare Side-by-Side';
      compare.disabled = dish.runs.length < 2;
      compare.onclick = () => { state.view = 'compare'; refreshStage(); };
      group.appendChild(compare);
      const comparing = state.view === 'compare' && dish.runs.length >= 2;
      stageWrap.classList.toggle('compare', comparing);
      document.getElementById('vp-secondary').classList.toggle('hidden', !comparing);
      document.getElementById('compare-controls').hidden = !comparing;
      const left = document.getElementById('cmp-left'), right = document.getElementById('cmp-right');
      for (const [select, fallback] of [[left, 0], [right, 1]]) {
        const previous = select.value;
        select.replaceChildren(...dish.runs.map(r => { const o = document.createElement('option'); o.value = r.slug; o.textContent = dish.model_statuses.find(m => m.slug === r.slug)?.name || r.slug; return o; }));
        select.value = dish.runs.some(r => r.slug === previous) ? previous : dish.runs[Math.min(fallback, dish.runs.length - 1)]?.slug || '';
        select.onchange = () => refreshStage();
      }
      const chosen = dish.runs.find(r => r.slug === (comparing ? left.value : state.view)) || dish.runs[0];
      updateDownloadLink(dish, chosen);
      renderMatrix(dish);
      await loadRunIntoViewport(vpA, chosen, dish);
      if (comparing) await loadRunIntoViewport(vpB, dish.runs.find(r => r.slug === right.value), dish);
    }

    function renderMatrix(dish) {
      const matrix = document.getElementById('model-matrix'); matrix.replaceChildren();
      const summary = document.createElement('p');
      summary.textContent = DATA.dishes.length + ' dishes · ' + dish.model_statuses.map(m => m.name + ': ' + DATA.dishes.filter(d => d.runs.some(r => r.slug === m.slug)).length).join(' · ');
      matrix.appendChild(summary);
      const table = document.createElement('table');
      for (const row of [['Model','Status','License','Vertices','Faces','GLB KB','Latency (s)','Watertight','Appearance'], ...dish.model_statuses.map(m => [m.name,m.status,m.license,m.vertices,m.faces,m.kb,m.elapsed_seconds,m.watertight,m.appearance])]) {
        const tr = document.createElement('tr'); for (const value of row) { const cell = document.createElement('td'); cell.textContent = value ?? '—'; tr.appendChild(cell); } table.appendChild(tr);
      }
      matrix.appendChild(table);
    }
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
    refreshStage();
    initThreeAsync();
  </script>
</body>
</html>
"""


if __name__ == '__main__':
    raise SystemExit(main())
