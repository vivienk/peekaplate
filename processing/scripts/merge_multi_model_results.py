"""Merge private multi-model 3D result directories into one plate-preserving comparison studio."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
from typing import Iterable

from peekaplate_processing.dish_3d_studio import (
    DEFAULT_THREE_CDN_BASE,
    TRUTHFUL_DEMO_LABEL,
    _safe_child_path,
    build_comparison_viewer,
    build_legacy_single_file_studio,
    build_split_studio,
)

SCHEMA_VERSION = 3
PLATE_PRESERVATION_MODE = 'preserve_plate'
PURPOSE = 'private single-photo 3D demo & Docker worker blueprint'

#: Historical backends that must never reappear in the current 5-model comparison studio.
LEGACY_RUN_SLUGS = frozenset({'triposr', 'hunyuan3d-2mini'})

#: Dish input artifacts copied next to their label (basename prefixes / names).
INPUT_ARTIFACT_PREFIXES = ('input_image.', 'cutout_rgba.')
INPUT_ARTIFACT_NAMES = ('job_manifest.json',)

#: Run artifacts worth publishing for the viewer; legacy `.obj`/`.ply` exports are dropped.
RUN_ARTIFACT_SUFFIXES = ('.glb',)
RUN_ARTIFACT_NAME_SUFFIXES = ('_preview.png', '_hf_modes.png')

#: Rich dish metadata is usually present in the authoring notebook manifest but omitted (or
#: downgraded to null) by later Kaggle runs; a null value must never erase an earlier one.
PRESERVED_INPUT_METADATA = (
    'title', 'tier', 'page', 'cutout_metrics', 'source_sha256', 'image_source', 'size',
)

#: Path-bearing keys that must never survive verbatim from a source manifest.
INPUT_ENTRY_SKIP_KEYS = (
    'image_path', 'cutout_path', 'reviewed_mask_path', 'job_manifest_path', 'directory', 'artifacts',
    # Measured from the staged `input_image.png` copy below: an inherited value could describe a
    # different source's bytes, so it is never carried across a merge.
    'input_image_sha256',
)
RUN_ENTRY_SKIP_KEYS = (
    'artifact_paths', 'artifacts', 'preview_path', 'hf_modes_path', 'mobile_glb_path', 'directory',
)


def _sha256_file(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _safe_rel_path(root: Path, rel_path: object, *, what: str) -> Path:
    """Resolve a manifest-relative path, rejecting empty, absolute and traversal forms."""
    if not isinstance(rel_path, str) or not rel_path.strip() or '\x00' in rel_path:
        raise ValueError(f'Invalid {what} path: {rel_path!r}')
    candidate = Path(rel_path)
    if candidate.is_absolute() or candidate.anchor or rel_path.startswith(('/', '\\')):
        raise ValueError(f'Invalid {what} path (absolute): {rel_path!r}')
    if '..' in candidate.parts:
        raise ValueError(f'Invalid {what} path (traversal): {rel_path!r}')
    resolved = _safe_child_path(root, rel_path)
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f'Invalid {what} path (escapes root): {rel_path!r}')
    return resolved


def _safe_label(label: object) -> str:
    if (not isinstance(label, str) or not label.strip() or '\x00' in label
            or label in ('.', '..') or '/' in label or '\\' in label):
        raise ValueError(f'Invalid dish label: {label!r}')
    return label


def _artifact_rel(art: object, *, where: str) -> str:
    rel = art.get('path') if isinstance(art, dict) else art
    if isinstance(rel, Path):
        rel = rel.as_posix()
    if not isinstance(rel, str) or not rel.strip():
        raise ValueError(f'Invalid artifact entry in {where}: {art!r}')
    return rel


def _require_non_publishable(payload: object, origin: Path) -> None:
    if not isinstance(payload, dict):
        raise ValueError(f'{origin} must be a JSON object.')
    if payload.get('publication_eligible') is not False:
        raise ValueError(
            f'{origin} must set publication_eligible to false (found '
            f'{payload.get("publication_eligible")!r}); this studio is private R&D only.'
        )


def _load_source(source_dir: Path) -> dict:
    manifest_path = source_dir / 'manifest.json'
    if not manifest_path.is_file():
        raise FileNotFoundError(f'Missing manifest.json in source directory: {source_dir}')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    _require_non_publishable(manifest, manifest_path)
    for job_manifest_path in sorted(source_dir.glob('*/job_manifest.json')):
        _require_non_publishable(json.loads(job_manifest_path.read_text(encoding='utf-8')), job_manifest_path)
    if not isinstance(manifest.get('inputs') or {}, dict):
        raise ValueError(f'{manifest_path} has a malformed inputs mapping.')
    if not isinstance(manifest.get('runs_3d') or {}, dict):
        raise ValueError(f'{manifest_path} has a malformed runs_3d mapping.')
    return manifest


def _is_input_artifact(rel: str) -> bool:
    name = Path(rel).name
    return name in INPUT_ARTIFACT_NAMES or name.startswith(INPUT_ARTIFACT_PREFIXES)


def _is_run_artifact(rel: str) -> bool:
    name = Path(rel).name
    return name.endswith(RUN_ARTIFACT_SUFFIXES) or name.endswith(RUN_ARTIFACT_NAME_SUFFIXES)


def _copy_if_distinct(source_path: Path, dest_path: Path) -> None:
    """Copy a validated artifact unless source and destination refer to the same file."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if source_path.resolve() != dest_path.resolve():
        shutil.copyfile(source_path, dest_path)


def _merge_inputs(
    sources: list[tuple[Path, dict]],
    output_dir: Path,
) -> dict[str, dict]:
    """Merge dish inputs in source order (later sources win for non-null values)."""
    order: list[str] = []
    grouped: dict[str, list[tuple[Path, dict]]] = {}
    for source_dir, manifest in sources:
        for raw_label, entry in (manifest.get('inputs') or {}).items():
            label = _safe_label(raw_label)
            if label not in grouped:
                grouped[label] = []
                order.append(label)
            if not isinstance(entry, dict):
                raise ValueError(f'Dish {label} input entry in {source_dir} must be an object.')
            grouped[label].append((source_dir, entry))

    merged: dict[str, dict] = {}
    for label in order:
        entries = grouped[label]
        successes = [(source_dir, entry) for source_dir, entry in entries
                     if entry.get('image_status') == 'success']
        base = (successes or entries)[-1][1]
        record = {
            key: value for key, value in base.items()
            if key not in INPUT_ENTRY_SKIP_KEYS and key != 'label'
        }
        record['label'] = label
        if successes:
            record['image_status'] = 'success'
        else:
            record['image_status'] = base.get('image_status') or 'failed'

        # Later sources override metadata, but a null or empty value never erases an earlier row
        # (Kaggle reruns serialise omitted dish metadata as ``null`` or ``{}``).
        for _, entry in (successes or entries):
            for key in PRESERVED_INPUT_METADATA:
                value = entry.get(key)
                if value is None or value == '' or value == {} or value == []:
                    continue
                record[key] = value

        dish_dir = _safe_rel_path(output_dir, label, what='dish directory')
        dish_dir.mkdir(parents=True, exist_ok=True)
        artifacts: list[dict] = []
        staged: dict[str, str] = {}
        for source_dir, entry in successes:
            for art in entry.get('artifacts') or []:
                rel = _artifact_rel(art, where=f'inputs.{label}')
                source_path = _safe_rel_path(source_dir, rel, what=f'inputs.{label} artifact')
                if not _is_input_artifact(rel) or not source_path.is_file():
                    continue
                if source_path.name == 'job_manifest.json':
                    _require_non_publishable(
                        json.loads(source_path.read_text(encoding='utf-8')), source_path,
                    )
                dest_rel = f'{label}/{source_path.name}'
                dest_path = _safe_rel_path(output_dir, dest_rel, what=f'inputs.{label} artifact')
                _copy_if_distinct(source_path, dest_path)
                staged[dest_rel] = _sha256_file(dest_path)
        for dest_rel, digest in staged.items():
            dest_path = _safe_rel_path(output_dir, dest_rel, what=f'inputs.{label} artifact')
            artifacts.append({'path': dest_rel, 'sha256': digest, 'bytes': dest_path.stat().st_size})
        if successes:
            record['artifacts'] = artifacts
            # The staged copy is the local truth: record the digest of the bytes this studio
            # actually ships, separately from the declared upload digest (`source_sha256`),
            # which a re-encoded stage may not match.
            staged_input = staged.get(f'{label}/input_image.png')
            if staged_input is not None:
                record['input_image_sha256'] = staged_input
        else:
            record.pop('artifacts', None)
            record.pop('input_image_sha256', None)
        merged[label] = record
    return merged


def _copy_run_artifact(
    source_dir: Path,
    output_dir: Path,
    label: str,
    rel: str,
    staged: dict[str, str],
    *,
    what: str,
) -> str | None:
    source_path = _safe_rel_path(source_dir, rel, what=what)
    if not source_path.is_file():
        return None
    dest_rel = f'{label}/{source_path.name}'
    dest_path = _safe_rel_path(output_dir, dest_rel, what=what)
    _copy_if_distinct(source_path, dest_path)
    staged[rel] = dest_rel
    return dest_rel


def _merge_runs(sources: list[tuple[Path, dict]], output_dir: Path, labels: Iterable[str]) -> dict[str, dict]:
    """Merge runs_3d in source order: a later run wins only if it succeeded or the prior did not."""
    known_labels = set(labels)
    winners: dict[str, tuple[Path, dict]] = {}
    order: list[str] = []
    for source_dir, manifest in sources:
        for raw_key, rec in (manifest.get('runs_3d') or {}).items():
            if not isinstance(raw_key, str):
                raise ValueError(f'Invalid runs_3d key in {source_dir}: {raw_key!r}')
            if not isinstance(rec, dict):
                raise ValueError(f'Run {raw_key} in {source_dir} must be an object.')
            label, sep, slug = raw_key.partition('/')
            if not sep or not label or not slug:
                raise ValueError(f'Invalid runs_3d key in {source_dir}: {raw_key!r}')
            _safe_label(label)
            if slug in LEGACY_RUN_SLUGS:
                continue
            if label not in known_labels:
                continue
            previous = winners.get(raw_key)
            if previous is not None:
                if not (rec.get('status') == 'success' or previous[1].get('status') != 'success'):
                    continue
            else:
                order.append(raw_key)
            winners[raw_key] = (source_dir, rec)

    merged: dict[str, dict] = {}
    for run_key in order:
        source_dir, rec = winners[run_key]
        label = run_key.split('/', 1)[0]
        record = {key: value for key, value in rec.items() if key not in RUN_ENTRY_SKIP_KEYS}
        if rec.get('input_label') not in (None, label):
            raise ValueError(
                f'Run {run_key} declares input_label {rec.get("input_label")!r} that conflicts with its key.'
            )
        record['input_label'] = label

        staged: dict[str, str] = {}
        artifacts: list[dict] = []
        seen: set[str] = set()
        what = f'runs_3d.{run_key} artifact'
        for art in rec.get('artifacts') or []:
            rel = _artifact_rel(art, where=f'runs_3d.{run_key}')
            _safe_rel_path(source_dir, rel, what=what)
            if not _is_run_artifact(rel):
                continue
            dest_rel = _copy_run_artifact(source_dir, output_dir, label, rel, staged, what=what)
            if dest_rel is None or dest_rel in seen:
                continue
            seen.add(dest_rel)
        mobile_path = rec.get('mobile_glb_path')
        if mobile_path is not None:
            mobile_rel = str(mobile_path)
            _safe_rel_path(source_dir, mobile_rel, what=f'runs_3d.{run_key} mobile_glb_path')
            if mobile_rel not in staged:
                _copy_run_artifact(source_dir, output_dir, label, mobile_rel, staged, what=what)
        for rel, dest_rel in staged.items():
            dest_path = _safe_rel_path(output_dir, dest_rel, what=f'runs_3d.{run_key} artifact')
            artifacts.append({'path': dest_rel, 'sha256': _sha256_file(dest_path),
                              'bytes': dest_path.stat().st_size})
        record['artifacts'] = artifacts
        record.pop('mobile_glb_path', None)
        if mobile_path is not None:
            dest_rel = staged.get(str(mobile_path))
            if dest_rel is None:
                # Look for the copied file by basename when the source path was reformatted.
                name = Path(str(mobile_path)).name
                dest_rel = next((value for key, value in staged.items() if Path(key).name == name), None)
            if dest_rel is None:
                raise ValueError(f'Run {run_key} references a mobile GLB missing from its artifacts.')
            record['mobile_glb_path'] = dest_rel
        merged[run_key] = record
    return merged


def merge_results_directories(
    source_dirs: list[Path],
    output_dir: Path,
    *,
    three_base_url: str | None = None,
    menu_manifest: Path | None = None,
    legacy_single_file: bool = False,
    split_dir: Path | None = None,
) -> tuple[Path, Path, Path]:
    """Merge private multi-model result directories into one viewer + studio pair.

    ``source_dirs`` is ordered from earliest to latest: a later directory updates a
    ``runs_3d`` entry ``[label]/[slug]`` only when its run succeeded or the earlier run did
    not, so a stale Kaggle failure never hides a good authoring run. Runs whose label is
    absent from every ``inputs`` mapping are ignored. Legacy ``triposr`` /
    ``hunyuan3d-2mini`` runs are dropped everywhere. Every source manifest and dish
    ``job_manifest.json`` must keep ``publication_eligible: false``.

    Merged artifact paths are rewritten relative to ``output_dir`` and traversal is rejected.
    The written manifest keeps ``schema_version: 3``, ``publication_eligible: false`` and
    ``plate_preservation_mode: 'preserve_plate'``.

    Returns ``(manifest_path, viewer_path, split_index_path)``.
    """
    output_dir = Path(output_dir)
    existing = [Path(path) for path in source_dirs if Path(path).is_dir()]
    if not existing:
        raise ValueError('No existing source directories were supplied for merging.')
    sources = [(source_dir, _load_source(source_dir)) for source_dir in existing]

    output_dir.mkdir(parents=True, exist_ok=True)
    inputs = _merge_inputs(sources, output_dir)
    runs_3d = _merge_runs(sources, output_dir, inputs)

    manifest = {
        'schema_version': SCHEMA_VERSION,
        'purpose': PURPOSE,
        'demo_label': TRUTHFUL_DEMO_LABEL,
        'plate_preservation_mode': PLATE_PRESERVATION_MODE,
        'publication_eligible': False,
        'merged_source_count': len(sources),
        'inputs': inputs,
        'runs_3d': runs_3d,
        'extras': [],
    }
    manifest_path = output_dir / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

    base_url = three_base_url or DEFAULT_THREE_CDN_BASE
    viewer_path = build_comparison_viewer(output_dir, three_base_url=base_url)
    out_split = Path(split_dir) if split_dir is not None else (output_dir / 'studio')
    split_index_path, _ = build_split_studio(
        output_dir,
        out_split,
        menu_manifest=menu_manifest,
        three_base_url=base_url,
    )
    if legacy_single_file:
        build_legacy_single_file_studio(output_dir)
    return manifest_path, viewer_path, split_index_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, prog='merge_multi_model_results.py')
    parser.add_argument(
        '--source', type=Path, action='append', default=[], metavar='DIR',
        help='Results directory with manifest.json; repeat earliest-first (later wins).',
    )
    parser.add_argument(
        '--output-dir', type=Path, default=Path('/tmp/peekaplate-all-models-studio/results'),
        help='Merged results directory (default: /tmp/peekaplate-all-models-studio/results).',
    )
    parser.add_argument(
        '--three-base-url', default=None,
        help='Override the Three.js CDN base (default: jsDelivr three r182).',
    )
    parser.add_argument(
        '--menu-manifest', type=Path, default=None,
        help='Canonical dish list (extract_gmn9c8_dishes.py dishes_manifest.json); '
             'dishes without outputs are listed as pending.',
    )
    parser.add_argument(
        '--legacy-single-file', action='store_true',
        help='Also write the heavy all-dishes interactive_3d_studio.html (base64 of every GLB).',
    )
    args = parser.parse_args(argv)
    if not args.source:
        parser.error('at least one --source DIR is required')

    existing = [path for path in args.source if path.is_dir()]
    manifest_path, viewer_path, studio_path = merge_results_directories(
        args.source,
        args.output_dir,
        three_base_url=args.three_base_url,
        menu_manifest=args.menu_manifest,
        legacy_single_file=args.legacy_single_file,
    )
    print(f'Merged {len(existing)} existing source directory(ies) into {args.output_dir}')
    print(f'  manifest: {manifest_path}')
    print(f'  viewer:   {viewer_path}')
    print(f'  studio:   {studio_path}')
    if args.legacy_single_file:
        print(f'  legacy:   {args.output_dir / "interactive_3d_studio.html"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())