"""Build one self-contained HTML report of every open model's dish-to-3D result.

The page answers the question the interactive studios do not: for each menu dish and each
suggested open model, what happened, why, and where are the bytes. It is derived read-only from
one or more result directories that already contain ``manifest.json`` plus per-dish folders, so
it never runs a model, never calls the network and never rewrites the artefacts it describes.

Provenance, the model x dish matrix and the per-model coverage table come from the manifest files
only; nothing is inferred from the clock, a filesystem mtime or a guess. Every manifest path is
re-validated here (``merge_multi_model_results._safe_rel_path``) and an absolute or traversal
artefact path aborts the build instead of shipping a broken link.

Mesh quality is the one exception to "manifest only": faces, boundary edges, non-manifold and
degenerate triangles and texture pixel dimensions are decoded from the raw GLB bytes by
``verify_kaggle_outputs.measure_glb_quality`` (one implementation, shared with the verifier). A GLB
that cannot be decoded is rendered as *quality not measured*, never as a clean zero.
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import statistics
import sys

MERGE_MODULE_NAME = 'merge_multi_model_results'
MERGE_SCRIPT_PATH = Path(__file__).resolve().parent / f'{MERGE_MODULE_NAME}.py'
VERIFY_MODULE_NAME = 'verify_kaggle_outputs'
VERIFY_SCRIPT_PATH = Path(__file__).resolve().parent / f'{VERIFY_MODULE_NAME}.py'


def _load_sibling(module_name: str, script_path: Path):
    """Load a sibling script once, so its guards and measurements are reused, never re-implemented."""
    cached = sys.modules.get(module_name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Cannot load {script_path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


merge = _load_sibling(MERGE_MODULE_NAME, MERGE_SCRIPT_PATH)
#: Single implementation of the measured mesh-quality metric (see `verify_kaggle_outputs`).
verify = _load_sibling(VERIFY_MODULE_NAME, VERIFY_SCRIPT_PATH)

DEFAULT_REPORT_NAME = 'dish-3d-model-report.html'
DEFAULT_TITLE = 'Dish to 3D model result matrix (private research)'

#: The five backends of the current comparison, in the order the studio presents them.
MODEL_COLUMNS = (
    ('moge2-relief', 'MoGe-2 relief'),
    ('trellis2-4b', 'TRELLIS.2-4B'),
    ('trellis2-4b-hires', 'TRELLIS.2-4B Hi-Res'),
    ('triposg', 'TripoSG'),
    ('hunyuan3d2', 'Hunyuan3D-2 / 2.1'),
    ('hunyuan3d21', 'Hunyuan3D-2.1'),
    ('hunyuan3d21-pbr', 'Hunyuan3D-2.1 PBR'),
    ('hi3dgen', 'Hi3DGen'),
    ('spar3d', 'SPAR3D'),
)

#: Cell states. ``not_run`` means no source manifest declares a run record for that pair.
STATUSES = ('success', 'skipped', 'failed', 'not_run')

#: Top-level manifest keys that may carry the generation date; the clock is never a substitute.
MANIFEST_DATE_KEYS = ('generated_at', 'generated_utc', 'generation_date', 'created_at', 'date')

#: Manifest keys that carry pinned upstream revisions (``source_revisions`` also holds slugs).
REVISION_KEYS = ('source_revisions', 'pinned_revisions')
HEX_REVISION = re.compile(r'^[0-9a-f]{7,40}$')

SHORT_REASON_LIMIT = 96


def _e(value: object) -> str:
    """Escape any value for HTML text or an attribute (quotes included)."""
    return html.escape('' if value is None else str(value), quote=True)


def _shorten(text: str, limit: int = SHORT_REASON_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + '\u2026'


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _text_or_none(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _manifest_date(manifests: list[dict]) -> list[str]:
    """Return the declared generation date(s); an absent declaration stays absent."""
    declared: set[str] = set()
    for manifest in manifests:
        for key in MANIFEST_DATE_KEYS:
            value = manifest.get(key)
            if isinstance(value, str) and value.strip():
                declared.add(value.strip())
    return sorted(declared)


def _revisions(sources: list[tuple[Path, dict]]) -> list[tuple[str, list[str]]]:
    """Collect pinned revisions from manifest dicts and per-dish job manifests, deduplicated."""
    found: dict[str, set[str]] = {}

    def _record(mapping: object) -> None:
        if not isinstance(mapping, dict):
            return
        for name, value in mapping.items():
            if isinstance(value, str) and HEX_REVISION.match(value):
                found.setdefault(str(name), set()).add(value)

    for source_dir, manifest in sources:
        for key in REVISION_KEYS:
            _record(manifest.get(key))
        for job_path in sorted(source_dir.glob('*/job_manifest.json')):
            try:
                job = json.loads(job_path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue
            if isinstance(job, dict):
                _record(job.get('pinned_revisions'))
    return [(name, sorted(found[name])) for name in sorted(found)]


def _dataset_slugs(sources: list[tuple[Path, dict]]) -> list[str]:
    slugs: set[str] = set()
    for _, manifest in sources:
        for entry in (manifest.get('inputs') or {}).values():
            slug = _text_or_none(entry.get('dataset_slug')) if isinstance(entry, dict) else None
            if slug:
                slugs.add(slug)
    return sorted(slugs)

def _select_run(sources: list[tuple[Path, dict]], label: str, slug: str) -> tuple[Path, dict] | None:
    """Pick the run record the merge tool would keep: a later run wins only if it succeeded."""
    winner: tuple[Path, dict] | None = None
    for source_dir, manifest in sources:
        record = (manifest.get('runs_3d') or {}).get(f'{label}/{slug}')
        if record is None:
            continue
        if not isinstance(record, dict):
            raise ValueError(f'Run {label}/{slug} in {source_dir} must be an object.')
        if winner is not None:
            later_succeeded = record.get('status') == 'success'
            earlier_succeeded = winner[1].get('status') == 'success'
            if not (later_succeeded or not earlier_succeeded):
                continue
        winner = (source_dir, record)
    return winner


def _validated_artifacts(source_dir: Path, record: dict, *, what: str) -> list[dict]:
    """Return every artefact entry of a run after fail-closed path validation."""
    entries: list[dict] = []
    artifacts = record.get('artifacts') or []
    if not isinstance(artifacts, list):
        raise ValueError(f'{what} must be a list of artefacts in {source_dir}.')
    for artifact in artifacts:
        rel = merge._artifact_rel(artifact, where=what)
        resolved = merge._safe_rel_path(source_dir, rel, what=what)
        declared = _int_or_none(artifact.get('bytes')) if isinstance(artifact, dict) else None
        sha = _text_or_none(artifact.get('sha256')) if isinstance(artifact, dict) else None
        entries.append({
            'path': rel,
            'abs_path': str(resolved),
            'declared_bytes': declared,
            'measured_bytes': resolved.stat().st_size if resolved.is_file() else None,
            'sha256': sha,
            'is_raw_glb': Path(rel).name.endswith('.glb') and not Path(rel).name.endswith('_mobile.glb'),
        })
    mobile = record.get('mobile_glb_path')
    if isinstance(mobile, str) and mobile.strip():
        merge._safe_rel_path(source_dir, mobile, what=f'{what} mobile_glb_path')
    return entries


def _measure_quality(abs_path: str) -> dict:
    """Measure one GLB's quality block; an absent or undecodable file stays unmeasured, not zero."""
    try:
        return verify.measure_glb_quality(abs_path)
    except (OSError, ValueError) as exc:  # defensive: the verifier already reports unreadable files
        return {'measured': False, 'reason': f'{type(exc).__name__}: {exc}'}


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def _cell(sources: list[tuple[Path, dict]], label: str, slug: str) -> dict:
    selected = _select_run(sources, label, slug)
    if selected is None:
        return {
            'status': 'not_run',
            'reason': 'no run record in any source',
            'source': None,
            'glbs': [],
            'faces': None,
            'has_texture': None,
            'recorded_status': None,
        }
    source_dir, record = selected
    what = f'runs_3d.{label}/{slug} artifact'
    artifacts = _validated_artifacts(source_dir, record, what=what)
    recorded_status = record.get('status')
    status = recorded_status if recorded_status in ('success', 'skipped', 'failed') else 'not_run'
    reason = ''
    if status != 'success':
        reason = (
            _text_or_none(record.get('error'))
            or _text_or_none(record.get('reason'))
            or (f'run status {recorded_status!r} is not success/skipped/failed'
                if status == 'not_run' else 'no reason recorded')
        )
    metrics = record.get('metrics') if isinstance(record.get('metrics'), dict) else {}
    glbs = [entry for entry in artifacts if entry['is_raw_glb']]
    for glb in glbs:
        glb['quality'] = _measure_quality(glb['abs_path'])
    return {
        'status': status,
        'reason': reason,
        'source': str(source_dir),
        'glbs': glbs,
        'faces': _int_or_none(metrics.get('faces')),
        'has_texture': metrics.get('has_texture') if isinstance(metrics.get('has_texture'), bool) else None,
        'recorded_status': recorded_status if isinstance(recorded_status, str) else None,
    }


def _size_label(glb: dict) -> str:
    declared = glb['declared_bytes']
    measured = glb['measured_bytes']
    if measured is None and declared is None:
        return 'size: unknown'
    if measured is None:
        return f'{declared:,} B declared, file absent'
    if declared is not None and declared != measured:
        return f'{measured:,} B (manifest declares {declared:,})'
    return f'{measured:,} B'


def _texture_label(value: bool | None) -> str:
    if value is None:
        return 'texture: not declared'
    return 'texture: embedded' if value else 'texture: not embedded'


def _coverage(dishes: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for slug, label in MODEL_COLUMNS:
        buckets: dict[str, dict[str, int]] = {name: {} for name in ('skipped', 'failed', 'not_run')}
        counts = {name: 0 for name in STATUSES}
        glbs = 0
        total_bytes = 0
        unknown_bytes = 0
        for dish in dishes:
            cell = dish['cells'][slug]
            counts[cell['status']] += 1
            if cell['status'] in buckets:
                buckets[cell['status']][cell['reason']] = (
                    buckets[cell['status']].get(cell['reason'], 0) + 1)
            if cell['status'] == 'success':
                glbs += len(cell['glbs'])
                for glb in cell['glbs']:
                    size = glb['measured_bytes'] if glb['measured_bytes'] is not None else glb['declared_bytes']
                    if size is None:
                        unknown_bytes += 1
                    else:
                        total_bytes += size
        reasons: list[dict] = []
        for status in ('skipped', 'failed', 'not_run'):
            for reason in sorted(buckets[status]):
                reasons.append({'status': status, 'reason': reason, 'count': buckets[status][reason]})
        rows.append({
            'slug': slug,
            'label': label,
            'attempted': counts['success'] + counts['skipped'] + counts['failed'],
            'success': counts['success'],
            'skipped': counts['skipped'],
            'failed': counts['failed'],
            'not_run': counts['not_run'],
            'glbs': glbs,
            'bytes': total_bytes,
            'unknown_bytes': unknown_bytes,
            'reasons': reasons,
        })
    return rows


def _quality_summary(dishes: list[dict]) -> list[dict]:
    """Per-model measured mesh quality: medians over the raw GLBs of every success cell."""
    rows: list[dict] = []
    for slug, label in MODEL_COLUMNS:
        measured: list[dict] = []
        unmeasured: list[dict] = []
        for dish in dishes:
            for glb in dish['cells'][slug]['glbs']:
                quality = glb.get('quality') or {}
                if quality.get('measured'):
                    measured.append(quality)
                else:
                    unmeasured.append({'path': glb['path'], 'reason': quality.get('reason')})
        faces = [float(entry['triangles']) for entry in measured if entry.get('triangles')]
        boundary = [float(entry['boundary_edges']) for entry in measured
                    if entry.get('boundary_edges') is not None]
        per_face = [float(entry['bytes_per_face']) for entry in measured
                    if entry.get('bytes_per_face') is not None]
        watertight = sum(1 for entry in measured if entry.get('watertight'))
        welded_boundary = [float(entry['welded_boundary_edges']) for entry in measured
                           if entry.get('welded_boundary_edges') is not None]
        shells = [float(entry['shell_count']) for entry in measured
                  if entry.get('shell_count') is not None]
        main_shell = [float(entry['main_shell_triangle_pct']) for entry in measured
                      if entry.get('main_shell_triangle_pct') is not None]
        pixels: list[str] = []
        for entry in measured:
            for width, height in entry.get('texture_pixels') or []:
                if width and height and f'{width}x{height}' not in pixels:
                    pixels.append(f'{width}x{height}')
        rows.append({
            'slug': slug,
            'label': label,
            'measured': len(measured),
            'unmeasured': unmeasured,
            'watertight': watertight,
            'open_shells': len(measured) - watertight,
            'watertight_pct': (round(100.0 * watertight / len(measured), 2) if measured else None),
            'median_faces': _median(faces),
            'min_faces': min(faces) if faces else None,
            'max_faces': max(faces) if faces else None,
            'median_boundary_edges': _median(boundary),
            'max_boundary_edges': max(boundary) if boundary else None,
            'welded_watertight': sum(1 for entry in measured if entry.get('welded_watertight')),
            'median_welded_boundary_edges': _median(welded_boundary),
            'median_shell_count': _median(shells),
            'median_main_shell_pct': _median(main_shell),
            'degenerate_triangles': sum(int(entry['degenerate_triangles'] or 0)
                                        for entry in measured),
            'nonmanifold_edges': sum(int(entry['nonmanifold_edges'] or 0) for entry in measured),
            'median_bytes_per_face': _median(per_face),
            'texture_pixels': pixels,
        })
    return rows


def load_report_data(source_dirs: list[Path]) -> dict:
    """Read every source manifest and return the structured report data.

    Sources are ordered earliest-first, matching the merge tool: a later run replaces an earlier
    one only when it succeeded or the earlier run did not. Raises ``ValueError``/
    ``FileNotFoundError`` for a missing directory, a publishable manifest or an unsafe path.
    """
    paths = [Path(path) for path in source_dirs]
    if not paths:
        raise ValueError('At least one source directory is required.')
    for path in paths:
        if not path.is_dir():
            raise ValueError(f'Source directory does not exist: {path}')
    sources = [(path, merge._load_source(path)) for path in paths]

    labels: list[str] = []
    for path, manifest in sources:
        for raw_label, entry in (manifest.get('inputs') or {}).items():
            label = merge._safe_label(raw_label)
            if not isinstance(entry, dict):
                raise ValueError(f'Dish {label} input entry in {path} must be an object.')
            if label not in labels:
                labels.append(label)
            artifacts = entry.get('artifacts') or []
            if not isinstance(artifacts, list):
                raise ValueError(f'inputs.{label}.artifacts in {path} must be a list.')
            for artifact in artifacts:
                rel = merge._artifact_rel(artifact, where=f'inputs.{label}')
                merge._safe_rel_path(path, rel, what=f'inputs.{label} artifact')
    labels.sort()

    known = set(labels)
    orphan_runs = 0
    for path, manifest in sources:
        for raw_key in (manifest.get('runs_3d') or {}):
            if not isinstance(raw_key, str):
                raise ValueError(f'Invalid runs_3d key in {path}: {raw_key!r}')
            label, separator, slug = raw_key.partition('/')
            if not separator or not label or not slug:
                raise ValueError(f'Invalid runs_3d key in {path}: {raw_key!r}')
            merge._safe_label(label)
            if label not in known:
                orphan_runs += 1

    dish_records: list[dict] = []
    for label in labels:
        entry: dict = {}
        for _, manifest in sources:
            candidate = (manifest.get('inputs') or {}).get(label)
            if isinstance(candidate, dict) and candidate.get('image_status') == 'success':
                entry = candidate
        dish_records.append({
            'label': label,
            'title': _text_or_none(entry.get('title')),
            'image_status': _text_or_none(entry.get('image_status')),
            'input_image_sha256': _text_or_none(entry.get('input_image_sha256')),
            'source_sha256': _text_or_none(entry.get('source_sha256')),
            'cells': {slug: _cell(sources, label, slug) for slug, _ in MODEL_COLUMNS},
        })

    manifests = [manifest for _, manifest in sources]
    staged = sum(1 for dish in dish_records if dish['input_image_sha256'])
    declared = sum(1 for dish in dish_records if dish['source_sha256'])
    missing = [
        {'label': dish['label'], 'slug': slug, 'label_model': label}
        for dish in dish_records
        for slug, label in MODEL_COLUMNS
        if dish['cells'][slug]['status'] == 'not_run'
    ]
    return {
        'sources': [
            {
                'path': str(path),
                'manifest': str(path / 'manifest.json'),
                'dishes': len(manifest.get('inputs') or {}),
                'runs': len(manifest.get('runs_3d') or {}),
                'merged_source_count': _int_or_none(manifest.get('merged_source_count')),
                'demo_label': _text_or_none(manifest.get('demo_label')),
                'publication_eligible': manifest.get('publication_eligible'),
            }
            for path, manifest in sources
        ],
        'dishes': dish_records,
        'coverage': _coverage(dish_records),
        'quality': _quality_summary(dish_records),
        'dataset_slugs': _dataset_slugs(sources),
        'revisions': _revisions(sources),
        'declared_dates': _manifest_date(manifests),
        'publication_eligible': False,
        'input_sha256_presence': {
            'staged': staged,
            'declared': declared,
            'dishes': len(dish_records),
        },
        'orphan_runs': orphan_runs,
        'missing': missing,
    }


def _href(abs_path: str, page_dir: Path) -> str:
    """Relative href from the page directory to an artefact, never absolute, never ``file://``."""
    relative = os.path.relpath(abs_path, start=str(Path(page_dir).resolve()))
    if os.path.isabs(relative):
        raise ValueError(f'Cannot express a relative link for {abs_path}')
    return Path(relative).as_posix()


STYLE = """
:root { color-scheme: light dark; --line: #d5d9e0; --muted: #5c6572; --bg: #ffffff;
        --panel: #f5f7fa; --ink: #16191d; --ok: #1a7f4b; --warn: #9a6700; --bad: #b32d2d;
        --idle: #5c6572; }
@media (prefers-color-scheme: dark) {
  :root { --line: #39404a; --muted: #a3adba; --bg: #14171b; --panel: #1c2026; --ink: #eceff4;
          --ok: #6fd39a; --warn: #e2b34a; --bad: #f08383; --idle: #a3adba; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1180px; padding: 24px 18px 64px; background: var(--bg);
       color: var(--ink); font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 6px; }
h2 { font-size: 1.1rem; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
p { margin: 6px 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em;
       word-break: break-all; }
.banner { border: 1px solid var(--bad); background: var(--panel); border-radius: 6px;
          padding: 8px 12px; margin: 14px 0; font-weight: 600; color: var(--bad); }
table { border-collapse: collapse; width: 100%; margin: 10px 0 4px; }
th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
thead th { background: var(--panel); font-size: 0.85rem; }
table.kv th { width: 15rem; background: var(--panel); }
table.matrix { font-size: 0.86rem; }
table.matrix th.dish { white-space: nowrap; background: var(--panel); }
table.matrix th.dish small, td small { display: block; color: var(--muted); font-weight: 400; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 0.75rem;
         font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
         border: 1px solid currentColor; }
.badge.success { color: var(--ok); }
.badge.skipped { color: var(--warn); }
.badge.failed { color: var(--bad); }
.badge.not_run { color: var(--idle); }
td.cell.success { border-left: 4px solid var(--ok); }
td.cell.skipped { border-left: 4px solid var(--warn); }
td.cell.failed { border-left: 4px solid var(--bad); }
td.cell.not_run { border-left: 4px solid var(--idle); }
.glb a { color: inherit; }
.meta { color: var(--muted); font-size: 0.82rem; }
.reason { margin-top: 4px; }
.reason-full { margin-top: 4px; padding: 4px 6px; background: var(--panel); border-radius: 4px;
               display: block; }
details { margin-top: 4px; }
summary { cursor: pointer; color: var(--muted); font-size: 0.82rem; }
ul.reasons { margin: 0; padding-left: 18px; }
ul.reasons li { margin: 1px 0; }
.muted { color: var(--muted); }
tr.attention td, tr.attention th { background: var(--panel); }
footer { margin-top: 36px; border-top: 1px solid var(--line); padding-top: 10px;
         color: var(--muted); font-size: 0.82rem; }
"""


def _render_cell(cell: dict, page_dir: Path) -> str:
    status = cell['status']
    parts = [f'<td class="cell {status}">', f'<span class="badge {status}">{status}</span>']
    if status == 'success':
        if not cell['glbs']:
            parts.append('<div class="reason muted">success recorded, no raw GLB artefact listed</div>')
        faces = (f'declared faces: {cell["faces"]:,}' if cell['faces'] is not None
                 else 'declared faces: not reported')
        for glb in cell['glbs']:
            href = _href(glb['abs_path'], page_dir)
            parts.append(
                f'<div class="glb"><a href="{_e(href)}">{_e(glb["path"])}</a></div>'
                f'<div class="meta">{_e(_size_label(glb))} &middot; {_e(faces)} &middot; '
                f'{_e(_texture_label(cell["has_texture"]))}</div>'
            )
            parts.append(_render_quality(glb.get('quality') or {}))
    else:
        reason = cell['reason']
        parts.append(
            f'<div class="reason" title="{_e(reason)}">{_e(_shorten(reason))}</div>'
        )
        if len(reason) > SHORT_REASON_LIMIT:
            parts.append(
                f'<details><summary>full reason</summary><code class="reason-full">{_e(reason)}</code></details>'
            )
    parts.append('</td>')
    return ''.join(parts)


def _render_quality(quality: dict) -> str:
    """Render one measured `quality` block beside its GLB; an unmeasured artifact stays visible."""
    if not quality.get('measured'):
        return (f'<div class="meta quality">quality not measured: '
                f'{_e(quality.get("reason") or "no quality block")}</div>')
    pixels = ', '.join(f'{width}x{height}' for width, height
                       in quality.get('texture_pixels') or []) or 'none'
    state = 'watertight' if quality.get('watertight') else 'open shell'
    return (
        f'<div class="meta quality">measured <strong>{quality["triangles"]:,}</strong> faces &middot; '
        f'<strong>{quality["boundary_edges"]:,}</strong> boundary edges &middot; '
        f'{quality["nonmanifold_edges"]:,} non-manifold &middot; '
        f'{quality["degenerate_triangles"]:,} degenerate &middot; '
        f'texture {_e(pixels)} px &middot; {_e(state)} &middot; '
        f'{quality["bytes_per_face"]} B/face</div>'
        + _render_welded(quality)
    )


def _render_welded(quality: dict) -> str:
    """Welded topology: UV seams split glTF vertices, so index edges overstate open shells."""
    if quality.get('welded_boundary_edges') is None:
        reason = quality.get('welded_reason') or 'not measured'
        return f'<div class="meta quality">welded topology not measured: {_e(reason)}</div>'
    shells = quality.get('shell_count')
    noun = 'shell' if shells == 1 else 'shells'
    sizes = ', '.join(f'{size:,}' for size in quality.get('shell_triangle_sizes_top5') or [])
    return (
        f'<div class="meta quality">welded: <strong>{quality["welded_boundary_edges"]:,}</strong> '
        f'boundary / {quality["welded_nonmanifold_edges"]:,} non-manifold &middot; '
        f'{shells:,} {noun} ({quality["main_shell_triangle_pct"]}% in the largest) &middot; '
        f'{quality.get("shells_ge_1pct")} with &ge;1% of faces &middot; top sizes {_e(sizes)}</div>'
    )


def _render_provenance(data: dict) -> str:
    rows: list[str] = []
    sources = data['sources']
    items = []
    for index, source in enumerate(sources, start=1):
        merged = (f', merged_source_count {source["merged_source_count"]}'
                  if source['merged_source_count'] is not None else '')
        items.append(
            f'<li><code>{_e(source["path"])}</code> &mdash; {source["dishes"]} input dishes, '
            f'{source["runs"]} run records{_e(merged)}</li>'
        )
    rows.append(
        '<tr><th>Source directories</th><td><ol class="reasons">' + ''.join(items) + '</ol></td></tr>'
    )
    slugs = data['dataset_slugs']
    rows.append(
        '<tr><th>Input dataset slugs</th><td>'
        + (''.join(f'<code>{_e(slug)}</code><br>' for slug in slugs)
           if slugs else '<span class="muted">not declared by the source manifest(s)</span>')
        + '</td></tr>'
    )
    rows.append(
        '<tr><th>publication_eligible</th><td><strong>false</strong> '
        '<span class="muted">(private research; every source manifest declares false)</span></td></tr>'
    )
    dates = data['declared_dates']
    rows.append(
        '<tr><th>Generation date (from manifest)</th><td>'
        + (''.join(f'<code>{_e(value)}</code><br>' for value in dates)
           if dates else
           '<span class="muted">not declared by the source manifest(s); no date is substituted '
           'from the clock</span>')
        + '</td></tr>'
    )
    revisions = data['revisions']
    rows.append(
        '<tr><th>Pinned model revisions</th><td>'
        + (''.join(
            f'<code>{_e(name)}</code> = ' + ', '.join(f'<code>{_e(value)}</code>' for value in values)
            + '<br>'
            for name, values in revisions)
           if revisions else '<span class="muted">not declared by the source manifest(s)</span>')
        + '</td></tr>'
    )
    presence = data['input_sha256_presence']
    rows.append(
        '<tr><th>Input sha256 presence</th><td>'
        f'<code>input_image_sha256</code> {presence["staged"]}/{presence["dishes"]} dishes, '
        f'<code>source_sha256</code> {presence["declared"]}/{presence["dishes"]} dishes '
        '<span class="muted">(a re-encoded stage without a staged digest is visible below, not '
        'hidden)</span></td></tr>'
    )
    if data['orphan_runs']:
        rows.append(
            '<tr class="attention"><th>Ignored run records</th><td>'
            f'{data["orphan_runs"]} run record(s) name a dish absent from every inputs mapping; '
            'they are excluded from the matrix.</td></tr>'
        )
    digest_rows = ''.join(
        f'<tr><th>{_e(dish["label"])}</th>'
        f'<td><code>{_e(dish["input_image_sha256"] or "absent")}</code></td>'
        f'<td><code>{_e(dish["source_sha256"] or "absent")}</code></td></tr>'
        for dish in data['dishes']
    )
    return (
        '<section id="provenance"><h2>Provenance</h2>'
        '<table class="kv"><tbody>' + ''.join(rows) + '</tbody></table>'
        '<h2>Per-dish input digests</h2>'
        '<table class="digests"><thead><tr><th>Dish</th>'
        '<th>input_image_sha256 (staged bytes)</th><th>source_sha256 (declared upload)</th>'
        '</tr></thead><tbody>' + digest_rows + '</tbody></table></section>'
    )


def _render_matrix(data: dict, page_dir: Path) -> str:
    header = ''.join(
        f'<th class="model-head" id="col-{_e(slug)}">{_e(label)}</th>' for slug, label in MODEL_COLUMNS
    )
    body: list[str] = []
    for dish in data['dishes']:
        title = (f'<small>{_e(dish["title"])}</small>'
                 if dish['title'] and dish['title'] != dish['label'] else '')
        cells = ''.join(_render_cell(dish['cells'][slug], page_dir) for slug, _ in MODEL_COLUMNS)
        body.append(f'<tr><th class="dish">{_e(dish["label"])}{title}</th>{cells}</tr>')
    missing = data['missing']
    missing_note = (
        '<p class="muted">Not run, with no run record in any source: '
        + ', '.join(f'<code>{_e(item["label"])} / {_e(item["label_model"])}</code>' for item in missing)
        + '.</p>'
        if missing else
        '<p class="muted">Every dish declares a run record for every one of the five models.</p>'
    )
    return (
        '<section id="matrix"><h2>Model &times; dish matrix</h2>'
        '<p class="muted">Rows are dishes sorted by label; columns are the five suggested open '
        'models. A later source replaces an earlier run only when it succeeded, so a stale Kaggle '
        'failure never hides a good authoring run.</p>'
        '<table class="matrix"><thead><tr><th>Dish</th>' + header + '</tr></thead><tbody>'
        + ''.join(body) + '</tbody></table>' + missing_note + '</section>'
    )


def _render_quality_summary(data: dict) -> str:
    rows: list[str] = []
    for row in data['quality']:
        unmeasured = ''
        if row['unmeasured']:
            unmeasured = (
                '<details><summary>unmeasured</summary><ul class="reasons">'
                + ''.join(f'<li><code>{_e(item["path"])}</code>: {_e(item["reason"])}</li>'
                          for item in row['unmeasured'])
                + '</ul></details>'
            )
        pixels = ', '.join(row['texture_pixels']) or 'none'
        pct = ('-' if row['watertight_pct'] is None else f'{row["watertight_pct"]}%')
        watertight_cell = ('-' if row['watertight_pct'] is None
                           else f'{row["watertight"]} ({_e(pct)})')
        median_faces = '-' if row['median_faces'] is None else f'{row["median_faces"]:,.1f}'
        median_boundary = ('-' if row['median_boundary_edges'] is None
                           else f'{row["median_boundary_edges"]:,.1f}')
        median_welded = ('-' if row['median_welded_boundary_edges'] is None
                         else f'{row["median_welded_boundary_edges"]:,.1f}')
        welded_cell = '-' if not row['measured'] else f'{row["welded_watertight"]}'
        median_shells = ('-' if row['median_shell_count'] is None
                         else f'{row["median_shell_count"]:,.1f}')
        main_shell = ('-' if row['median_main_shell_pct'] is None
                      else f'{row["median_main_shell_pct"]:.2f}%')
        median_bytes = ('-' if row['median_bytes_per_face'] is None
                        else f'{row["median_bytes_per_face"]:.2f}')
        rows.append(
            f'<tr><th>{_e(row["label"])}<small>{_e(row["slug"])}</small></th>'
            f'<td>{row["measured"]}{unmeasured}</td><td>{median_faces}</td>'
            f'<td>{median_boundary}</td><td>{watertight_cell}</td>'
            f'<td>{median_welded}</td><td>{_e(welded_cell)}</td><td>{median_shells}</td>'
            f'<td>{_e(main_shell)}</td>'
            f'<td>{row["degenerate_triangles"]:,}</td><td>{row["nonmanifold_edges"]:,}</td>'
            f'<td>{_e(median_bytes)}</td><td>{_e(pixels)}</td></tr>'
        )
    return (
        '<section id="quality"><h2>Mesh quality (measured from the GLB bytes)</h2>'
        '<p class="muted">Decoded from each raw GLB with the same single decoder the verifier uses '
        '(<code>verify_kaggle_outputs.measure_glb_quality</code>): boundary edges are undirected '
        'edges used by one triangle (an open shell reads as a thin sheet, not a solid), '
        'non-manifold edges are used by three or more, and a degenerate triangle encloses no '
        'area (documented tolerance). Welded columns recount the same edges after merging '
        'vertices with identical positions: a UV-atlased export splits every seam into separate '
        'vertices, so index boundary edges can describe a closed solid as an open sheet. Shells '
        'are connected welded surfaces; two large shells mean the plate and the food (or a '
        'ground slab) were reconstructed as separate objects. '
        'These are measurements, not a quality grade: they never '
        'turn a structural failure into a pass, and a watertight mesh can still be the wrong '
        'shape.</p>'
        '<table class="quality"><thead><tr><th>Model</th><th>Measured raw GLBs</th>'
        '<th>Median faces</th><th>Median boundary edges</th><th>Watertight GLBs</th>'
        '<th>Median welded boundary edges</th><th>Welded watertight</th>'
        '<th>Median shells</th><th>Median largest-shell share</th>'
        '<th>Degenerate triangles</th><th>Non-manifold edges</th><th>Median B/face</th>'
        '<th>Texture px observed</th></tr></thead><tbody>'
        + ''.join(rows) + '</tbody></table>'
        '<p class="muted">“Measured” counts raw (not mobile) GLBs of success cells. A cell'
        ' that reports <em>quality not measured</em> could not be decoded and is never scored'
        ' as good.</p></section>'
    )


def _render_coverage(data: dict) -> str:
    rows: list[str] = []
    for row in data['coverage']:
        reasons = ''.join(
            f'<li><span class="badge {_e(item["status"])}">{_e(item["status"])}</span> '
            f'<code>{_e(item["reason"])}</code> &times;{item["count"]}</li>'
            for item in row['reasons']
        )
        unknown = (f' <span class="muted">(+{row["unknown_bytes"]} GLBs of unknown size)</span>'
                   if row['unknown_bytes'] else '')
        rows.append(
            f'<tr><th>{_e(row["label"])}<small>{_e(row["slug"])}</small></th>'
            f'<td>{row["attempted"]}</td><td>{row["success"]}</td><td>{row["skipped"]}</td>'
            f'<td>{row["failed"]}</td><td>{row["not_run"]}</td><td>{row["glbs"]}</td>'
            f'<td>{row["bytes"]:,} B{unknown}</td>'
            f'<td>' + (f'<ul class="reasons">{reasons}</ul>' if reasons else
                       '<span class="muted">no non-success bucket</span>') + '</td></tr>'
        )
    return (
        '<section id="coverage"><h2>Coverage per model</h2>'
        '<p class="muted">Attempted = success + skipped + failed. Byte totals count the raw (not '
        'mobile) GLB recorded for each success.</p>'
        '<table class="coverage"><thead><tr><th>Model</th><th>Attempted</th><th>Success</th>'
        '<th>Skipped</th><th>Failed</th><th>Not run</th><th>Raw GLBs</th><th>Total bytes</th>'
        '<th>Non-success reasons</th></tr></thead><tbody>'
        + ''.join(rows) + '</tbody></table></section>'
    )


LIMITS = """
<section id="limits"><h2>What this page is not</h2>
<ul>
  <li>Private research only: every source manifest declares <code>publication_eligible: false</code>,
      and this page itself never claims publication eligibility.</li>
  <li>Single-photo reconstruction from a reviewed cutout. It is not captured multi-view evidence,
      not a measured portion and not an approved T0/T1/T2 dish asset.</li>
  <li>No invented menu content: dish labels, titles and reasons are rendered verbatim from the
      manifests, and a missing model run is reported as <code>not_run</code> rather than omitted or
      guessed.</li>
  <li>A page cannot establish that a mesh loads or looks correct. The mesh-quality table measures
      boundary edges, non-manifold edges, degenerate area and texture size; those numbers can
      explain a thin, open or coarse result but never prove a dish looks right. Inspect the GLBs
      in the studio and compare them against the captured photo before drawing any quality
      conclusion.</li>
</ul></section>
"""


def render_report(data: dict, *, title: str = DEFAULT_TITLE, page_dir: Path) -> str:
    """Render the whole report as one self-contained HTML document (inline CSS, no web assets)."""
    page_dir = Path(page_dir)
    dish_count = len(data['dishes'])
    head = (
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<title>{_e(title)}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n'
        f'<header>\n<h1>{_e(title)}</h1>\n'
        f'<p class="muted">{dish_count} dish(es) &times; {len(MODEL_COLUMNS)} open models, built from '
        f'{len(data["sources"])} source result director(ies). Every value below comes from the '
        'manifests; artefact links are relative to this page.</p>\n'
        '<p class="banner">Private single-photo 3D research &mdash; publication_eligible: false. '
        'Not published menu evidence.</p>\n</header>\n'
    )
    footer = (
        f'<footer>Built by <code>processing/scripts/build_dish_model_report.py</code>. '
        f'{dish_count} dishes, {len(data["coverage"])} models, '
        f'{sum(row["glbs"] for row in data["coverage"])} raw GLBs referenced. '
        'Deterministic output: the same source trees and output directory reproduce this file '
        'byte for byte.</footer>\n</body>\n</html>\n'
    )
    return (
        head
        + _render_provenance(data)
        + _render_matrix(data, page_dir)
        + _render_quality_summary(data)
        + _render_coverage(data)
        + LIMITS
        + footer
    )


def build_report(
    source_dirs: list[Path],
    out_path: Path | None = None,
    *,
    title: str = DEFAULT_TITLE,
) -> tuple[Path, dict]:
    """Write the report next to the artefacts (default) or to ``out_path``; return path and data."""
    paths = [Path(path) for path in source_dirs]
    data = load_report_data(paths)
    out = Path(out_path) if out_path is not None else paths[0] / DEFAULT_REPORT_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_report(data, title=title, page_dir=out.parent), encoding='utf-8')
    return out, data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, prog='build_dish_model_report.py')
    parser.add_argument(
        '--source', type=Path, action='append', default=[], metavar='DIR',
        help='Results directory containing manifest.json and dish folders; repeat earliest-first.',
    )
    parser.add_argument(
        '--out', type=Path, default=None, metavar='PATH',
        help=f'Report file (default: <first-source>/{DEFAULT_REPORT_NAME}).',
    )
    parser.add_argument('--title', default=DEFAULT_TITLE, help='Page title and heading.')
    args = parser.parse_args(argv)
    if not args.source:
        parser.error('at least one --source DIR is required')
    for path in args.source:
        if not path.is_dir():
            parser.error(f'source directory does not exist: {path}')

    out_path, data = build_report(args.source, args.out, title=args.title)
    print(f'Report: {out_path} ({out_path.stat().st_size:,} B)')
    print(f'  sources: {len(data["sources"])}  dishes: {len(data["dishes"])}  '
          f'models: {len(MODEL_COLUMNS)}  publication_eligible: false')
    for row in data['coverage']:
        print(f'  {row["slug"]:<13} attempted {row["attempted"]:>3}  success {row["success"]:>3}  '
              f'skipped {row["skipped"]:>3}  failed {row["failed"]:>3}  not_run {row["not_run"]:>3}  '
              f'raw GLBs {row["glbs"]:>3}  bytes {row["bytes"]:,}')
    for row in data['quality']:
        pct = '-' if row['watertight_pct'] is None else f'{row["watertight_pct"]}%'
        print(f'  quality {row["slug"]:<13} measured {row["measured"]:>3}  '
              f'median faces {row["median_faces"]}  '
              f'median boundary edges {row["median_boundary_edges"]}  '
              f'welded {row["median_welded_boundary_edges"]}  '
              f'shells {row["median_shell_count"]}  '
              f'watertight {row["watertight"]}/{row["measured"]} ({pct})')
    if data['missing']:
        missing = ', '.join(f'{item["label"]}/{item["slug"]}' for item in data['missing'])
        print(f'  not_run pairs: {missing}')
    if data['orphan_runs']:
        print(f'  ignored run records naming an unknown dish: {data["orphan_runs"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
