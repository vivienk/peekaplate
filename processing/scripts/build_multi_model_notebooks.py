"""Generate sharded Kaggle 2xT4 benchmark notebooks testing all 5 Deep Research 3D models.

Notebooks generated:
1. `notebooks/dish-3d-multi-model-bench-a.ipynb`:
   Runs `moge2-relief`, `triposg`, `hunyuan3d2`, and `hi3dgen` across dishes [0:19]
   (4 original benchmarks + 15 GMn9C8.pdf Hero dishes) with HF cache cleanup between models.
2. `notebooks/dish-3d-multi-model-bench-b.ipynb`:
   Runs `trellis2-4b` (gated DINOv3 via Kaggle Secret `HF_TOKEN`) + `moge2-relief`
   across the 15 new GMn9C8.pdf Hero dishes [4:19] (preserving `01..04` from `trellislast version` v31).

Every baseline patch goes through `_strict_replace`, so a drifted anchor in
`notebooks/trellislast-version.ipynb` fails the build instead of silently emitting a
notebook that raises `NameError` on Kaggle.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_NOTEBOOK = REPO_ROOT / 'notebooks' / 'trellislast-version.ipynb'
FALLBACK_BASELINE_NOTEBOOK = REPO_ROOT / 'notebooks' / 'dish-3d-openrouter.ipynb'
MULTI_MODEL_MODULE = REPO_ROOT / 'processing' / 'src' / 'peekaplate_processing' / 'multi_model_3d.py'
STUDIO_MODULE = REPO_ROOT / 'processing' / 'src' / 'peekaplate_processing' / 'dish_3d_studio.py'


MODEL_CATALOG: dict[str, tuple[str, str]] = {
    'moge2-relief': ('MoGe-2 Relief + Ceramic Plate', 'MIT'),
    'trellis2-4b': ('TRELLIS.2-4B', 'MIT'),
    'triposg': ('TripoSG + Photo PBR', 'MIT'),
    'hunyuan3d2': ('Hunyuan3D-2 / 2.1', 'Tencent Community R&D'),
    'hunyuan3d21': ('Hunyuan3D-2.1', 'Tencent Community R&D'),
    'hi3dgen': ('Hi3DGen Normal-Bridge', 'MIT'),
    'spar3d': ('SPAR3D', 'Stability AI Community'),
}


def _strict_replace(text: str, old: str, new: str, label: str) -> str:
    """Replace the single `old` occurrence with `new`, or fail loudly when the anchor drifted."""
    if old not in text:
        raise ValueError(f'Missing patch anchor: {label}')
    return text.replace(old, new, 1)


def _load_baseline_cells() -> list[dict[str, Any]]:
    src = BASELINE_NOTEBOOK if BASELINE_NOTEBOOK.is_file() else FALLBACK_BASELINE_NOTEBOOK
    nb = json.loads(src.read_text(encoding='utf-8'))
    return nb['cells']


def _md_cell(text: str) -> dict[str, Any]:
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith('\n'):
        lines[-1] += '\n'
    return {'cell_type': 'markdown', 'metadata': {}, 'source': lines}


def _code_cell(text: str) -> dict[str, Any]:
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith('\n'):
        lines[-1] += '\n'
    return {
        'cell_type': 'code',
        'execution_count': None,
        'metadata': {},
        'outputs': [],
        'source': lines,
    }


def _patch_cell1_for_slice(
    cell1_src: str,
    *,
    enabled_models: list[str],
    dish_start: int,
    dish_end: int,
) -> str:
    """Raise MAX_USER_DISHES, inject slice/model config, and read `dishes_manifest.json` metadata."""
    patched = _strict_replace(
        cell1_src,
        'MAX_USER_DISHES = 4',
        'MAX_USER_DISHES = 64',
        'cell1_max_user_dishes',
    )
    config_block = f"""
import os as _os
DISH_SLICE_START = int(_os.environ.get('PEEK_DISH_START', '{dish_start}'))
DISH_SLICE_END = int(_os.environ.get('PEEK_DISH_END', '{dish_end}'))
_ENV_MODELS = _os.environ.get('PEEK_MODELS')
ENABLED_MODELS = [m.strip() for m in _ENV_MODELS.split(',') if m.strip()] if _ENV_MODELS else {json.dumps(enabled_models)}
# TripoSG's marching-cubes decoder emits 1.4M-7.1M faces; cap the raw mesh so the exported GLB stays
# inside the 50 MB production limit that `generate_model.validate_glb` enforces.
MAX_RAW_FACES = int(_os.environ.get('PEEK_MAX_RAW_FACES', '300000'))
print(f'[config] ENABLED_MODELS={{ENABLED_MODELS}}, DISH_SLICE=[{{DISH_SLICE_START}}:{{DISH_SLICE_END}}], MAX_RAW_FACES={{MAX_RAW_FACES}}')
"""
    patched = _strict_replace(
        patched,
        "candidates = [p for p in all_images if not p.stem.endswith('_mask')][:max_dishes]",
        "candidates = [p for p in all_images if not p.stem.endswith('_mask')]"
        "[DISH_SLICE_START:min(DISH_SLICE_END, DISH_SLICE_START + max_dishes)]",
        'cell1_slice_candidates',
    )

    # Also read optional dishes_manifest.json title/tier/page metadata if present in the input root
    manifest_hook = """
    dish_meta_lookup = {}
    for dm_file in sorted(root.rglob('dishes_manifest.json')):
        try:
            for item in json.loads(dm_file.read_text(encoding='utf-8')).get('dishes', []):
                dish_meta_lookup[item['label']] = item
        except Exception:
            pass
"""
    patched = _strict_replace(
        patched,
        '    results_dir = Path(results_dir)',
        manifest_hook + '    results_dir = Path(results_dir)',
        'cell1_dish_manifest_lookup',
    )
    patched = _strict_replace(
        patched,
        "'label': label,\n"
        "                'model': 'user-photo-upload',\n"
        "                'image_source': 'user-uploaded-dataset',\n"
        "                'original_filename': src.name,\n"
        "                'dataset_slug': src.parent.name,",
        "'label': label,\n"
        "                'title': (dish_meta_lookup.get(src.stem) or {}).get('title'),\n"
        "                'tier': (dish_meta_lookup.get(src.stem) or {}).get('tier'),\n"
        "                'page': (dish_meta_lookup.get(src.stem) or {}).get('page'),\n"
        "                'model': 'user-photo-upload',\n"
        "                'image_source': 'user-uploaded-dataset',\n"
        "                'original_filename': src.name,\n"
        "                'dataset_slug': src.parent.name,",
        'cell1_dish_meta_fields',
    )
    # Recursive hf_token.txt and dataset credential search
    old_secret_glob = (
        "    for candidate in sorted(Path(input_root).glob(f'*/*{name.lower()}*')):\n"
        "        if candidate.is_file():\n"
        "            value = candidate.read_text(encoding='utf-8').strip()\n"
        "            if value:\n"
        "                return value, f'dataset:{candidate.parent.name}/{candidate.name}'"
    )
    new_secret_glob = (
        "    input_path = Path(input_root)\n"
        "    candidates = []\n"
        "    if input_path.is_dir():\n"
        "        if name.upper() == 'HF_TOKEN':\n"
        "            candidates.extend(sorted(input_path.rglob('hf_token.txt')))\n"
        "        candidates.extend(sorted(input_path.rglob(f'*{name.lower()}*')))\n"
        "    seen = set()\n"
        "    unique_candidates = []\n"
        "    for c in candidates:\n"
        "        if c not in seen and c.is_file():\n"
        "            seen.add(c)\n"
        "            unique_candidates.append(c)\n"
        "    for candidate in unique_candidates:\n"
        "        value = candidate.read_text(encoding='utf-8').strip()\n"
        "        if value:\n"
        "            rel = candidate.relative_to(input_path)\n"
        "            return value, f'dataset:{rel}'"
    )
    patched = _strict_replace(patched, old_secret_glob, new_secret_glob, 'cell1_secret_source_recursive')

    # Add dump_kaggle_input_tree helper
    tree_helper = (
        "def kaggle_secret(name):\n"
        "    return secret_source(name)[0]\n\n\n"
        "def dump_kaggle_input_tree(root=Path('/kaggle/input'), max_depth=3):\n"
        '    """Print the directory tree under `root` up to `max_depth` (never file contents)."""\n'
        "    root_path = Path(root)\n"
        "    print(f'Listing {root_path} tree (max depth {max_depth}):', flush=True)\n"
        "    if not root_path.exists():\n"
        "        print(f'  {root_path} does not exist.', flush=True)\n"
        "        return\n"
        "    for item in sorted(root_path.rglob('*')):\n"
        "        try:\n"
        "            rel = item.relative_to(root_path)\n"
        "            if len(rel.parts) <= max_depth:\n"
        "                indent = '  ' * len(rel.parts)\n"
        "                suffix = '/' if item.is_dir() else ''\n"
        "                print(f'{indent}{item.name}{suffix}', flush=True)\n"
        "        except Exception:\n"
        "            pass\n"
    )
    patched = _strict_replace(
        patched,
        "def kaggle_secret(name):\n    return secret_source(name)[0]",
        tree_helper.strip('\n'),
        'cell1_dump_kaggle_input_tree',
    )

    # Record plate_preserved and plate_method in build_worker_receipt
    old_worker_receipt_entry = (
        "        if run.get('mobile_error'):\n"
        "            entry['mobile_error'] = run['mobile_error']"
    )
    new_worker_receipt_entry = (
        "        if run.get('mobile_error'):\n"
        "            entry['mobile_error'] = run['mobile_error']\n"
        "        cm = input_entry.get('cutout_metrics') or {}\n"
        "        if 'plate_preserved' in run:\n"
        "            entry['plate_preserved'] = bool(run['plate_preserved'])\n"
        "        elif 'plate_preserved' in cm:\n"
        "            entry['plate_preserved'] = bool(cm['plate_preserved'])\n"
        "        if 'plate_method' in run:\n"
        "            entry['plate_method'] = run['plate_method']\n"
        "        elif 'plate_method' in cm:\n"
        "            entry['plate_method'] = cm['plate_method']"
    )
    patched = _strict_replace(
        patched,
        old_worker_receipt_entry,
        new_worker_receipt_entry,
        'cell1_worker_receipt_plate_fields',
    )
    return patched.rstrip() + '\n' + config_block


def _studio_models_cfg_snippet(enabled_models: list[str] | None = None) -> str:
    """Notebook-local `models_cfg`/`order_list`/`model_statuses`/`runs_by_slug` block."""
    catalog = dict(MODEL_CATALOG)
    if enabled_models is not None and 'spar3d' not in enabled_models:
        catalog.pop('spar3d', None)
    entries = '\n'.join(
        f"            '{slug}': ({name!r}, {lic!r})," for slug, (name, lic) in catalog.items()
    )
    return (
        "        models_cfg = {\n" + entries + "\n        }\n"
        "        order_list = list(models_cfg.keys())\n"
        "        model_statuses = []\n"
        "        runs_by_slug = {}\n"
        "        runs_out = []\n"
        "        for run_key, rec in RUNS_3D.items():\n"
        "            if rec.get('input_label') != label:\n"
        "                continue\n"
        "            _slug_key = run_key.split('/')[-1]\n"
        "            runs_by_slug[_slug_key] = rec\n"
        "            if rec.get('status') != 'success' or not rec.get('artifact_paths'):\n"
        "                continue"
    )


def _studio_model_statuses_snippet() -> str:
    """Ordered `runs_out` sort plus one `model_statuses` entry per canonical model."""
    return (
        "        runs_out.sort(key=lambda _r: order_list.index(_r['slug']) "
        "if _r['slug'] in order_list else len(order_list))\n"
        "        for _sk, (_sn, _sl) in models_cfg.items():\n"
        "            _sr = runs_by_slug.get(_sk, {})\n"
        "            _sm = _sr.get('metrics') or {}\n"
        "            _status = _sr.get('status', 'not_run')\n"
        "            if _status == 'success' and not any(_r['slug'] == _sk for _r in runs_out):\n"
        "                _status = 'failed'\n"
        "            model_statuses.append({\n"
        "                'slug': _sk, 'name': _sn, 'status': _status,\n"
        "                'license': _sr.get('license') or _sl,\n"
        "                'watertight': _sr.get('watertight', _sm.get('watertight')),\n"
        "                'elapsed_seconds': _sr.get('elapsed_seconds', _sm.get('elapsed_seconds')),\n"
        "                'vertices': _sm.get('vertices', _sm.get('vertex_count')),\n"
        "                'faces': _sm.get('faces'),\n"
        "                'kb': (_sm['bytes'] / 1024.0) if _sm.get('bytes') is not None else None,\n"
        "                'error': _sr.get('error'), 'appearance': _sr.get('appearance'),\n"
        "            })\n"
        "        dishes.append({\n"
        "            'label': label,\n"
        "            'title': in_entry.get('title'),\n"
        "            'tier': in_entry.get('tier'),\n"
        "            'page': in_entry.get('page'),\n"
        "            'model_statuses': model_statuses,\n"
        "            'job_id': jm_data.get('job_id'),"
    )


def _patch_cell15_for_multi_model(cell15_src: str, *, enabled_models: list[str] | None = None) -> str:
    """Extend Cell 15 studio & comparison sheet generator to surface all 5 recommended models."""
    spar3d_active = enabled_models is not None and 'spar3d' in enabled_models
    spar3d_backend_order = "    ('spar3d', 'SPAR3D'),\n" if spar3d_active else ""
    spar3d_hf_backend = ", ('spar3d', 'SPAR3D')" if spar3d_active else ""

    patched = _strict_replace(
        cell15_src,
        "backends_order = [\n    ('trellis2-4b', 'TRELLIS.2-4B (PBR)'),\n]",
        "backends_order = [\n"
        "    ('moge2-relief', 'MoGe-2 Relief + Plate'),\n"
        "    ('trellis2-4b', 'TRELLIS.2-4B (PBR)'),\n"
        "    ('triposg', 'TripoSG + Photo PBR'),\n"
        "    ('hunyuan3d2', 'Hunyuan3D-2 + PBR'),\n"
        "    ('hunyuan3d21', 'Hunyuan3D-2.1 + PBR'),\n"
        "    ('hi3dgen', 'Hi3DGen Normal-Bridge'),\n"
        + spar3d_backend_order +
        "]",
        'cell15_backends_order',
    )
    patched = _strict_replace(
        patched,
        "hf_backends = [('trellis2-4b', 'TRELLIS.2-4B - HF 4-Mode Strip')]",
        "hf_backends = [('moge2-relief', 'MoGe-2 Relief'), ('trellis2-4b', 'TRELLIS.2-4B'), "
        "('triposg', 'TripoSG'), ('hunyuan3d2', 'Hunyuan3D-2'), ('hunyuan3d21', 'Hunyuan3D-2.1'), "
        f"('hi3dgen', 'Hi3DGen'){spar3d_hf_backend}]",
        'cell15_hf_backends',
    )
    # Reuse the canonical 5-model HTML template from dish_3d_studio.py so the Kaggle standalone
    # studio keeps the full compare/filter/matrix UI instead of the TRELLIS-only template.
    studio_src = STUDIO_MODULE.read_text(encoding='utf-8')
    tmpl_marker = '_STUDIO_HTML_TEMPLATE = '
    start_idx = studio_src.index(tmpl_marker) + len(tmpl_marker)
    end_idx = studio_src.index('\n\nif __name__ == ', start_idx)
    studio_tmpl_expr = studio_src[start_idx:end_idx].strip()

    old_tmpl_line_prefix = "STUDIO_HTML_TEMPLATE = '<!doctype html>"
    s_pos = patched.find(old_tmpl_line_prefix)
    e_pos = patched.find('\ndef _studio_encode_png_data_url', s_pos)
    if s_pos == -1 or e_pos == -1:
        raise ValueError('Missing patch anchor: cell15_studio_html_template')
    patched = patched[:s_pos] + f'STUDIO_HTML_TEMPLATE = {studio_tmpl_expr}\n\n' + patched[e_pos:]

    # Replace the TRELLIS-only run filter (which also raised `NameError: models_cfg`) with the
    # canonical 5-model run collection + per-model status matrix.
    patched = _strict_replace(
        patched,
        "        runs_out = []\n"
        "        for run_key, rec in RUNS_3D.items():\n"
        "            if rec.get('input_label') != label or rec.get('status') != 'success' "
        "or not rec.get('artifact_paths'):\n"
        "                continue\n"
        "            if rec.get('backend') != 'TRELLIS.2-4B' and not run_key.endswith('/trellis2-4b'):\n"
        "                continue",
        _studio_models_cfg_snippet(enabled_models=enabled_models),
        'cell15_studio_runs_filter',
    )
    patched = _strict_replace(
        patched,
        "                'mobile_status': 'available' if mob_exists else (\n"
        "                    'failed' if rec.get('mobile_status') == 'failed' else 'missing'\n"
        "                ),",
        "                'mobile_status': rec.get('mobile_status', "
        "'available' if (mob_exists or embed_mob_b64) else 'missing'),",
        'cell15_studio_mobile_status',
    )
    patched = _strict_replace(
        patched,
        "        dishes.append({\n            'label': label,\n            'job_id': jm_data.get('job_id'),",
        _studio_model_statuses_snippet(),
        'cell15_studio_dish_entry',
    )
    return patched


def _patch_cell7_for_shard(cell7_src: str) -> str:
    """Gate the native TRELLIS.2 CUDA build on the shard's `ENABLED_MODELS` and allow CUDA 13.x."""
    patched = _strict_replace(
        cell7_src,
        'TRELLIS_BUILD_OK = False',
        "TRELLIS_BUILD_OK = False\nRUN_TRELLIS_BUILD = 'trellis2-4b' in ENABLED_MODELS",
        'cell7_run_trellis_build_flag',
    )
    patched = _strict_replace(
        patched,
        'if not DINOV3_OK:',
        "if not RUN_TRELLIS_BUILD:\n"
        "    TRELLIS_SKIP_REASON = 'disabled_in_shard'\n"
        "    print('Skipping TRELLIS.2 native CUDA build: trellis2-4b is disabled in this shard.')\n"
        'elif not DINOV3_OK:',
        'cell7_disabled_in_shard',
    )
    patched = _strict_replace(
        patched,
        "elif ('release 12.' not in subprocess.check_output(['nvcc', '--version'], text=True)) "
        "or (not str(torch.version.cuda).startswith('12.')):\n"
        "    TRELLIS_SKIP_REASON = 'requires_cuda_12_toolchain'\n"
        "    print(f'Skipping TRELLIS.2 native CUDA build: FlexGEMM/CuMesh/nvdiffrast pin CUDA 12.x "
        "(detected CUDA {torch.version.cuda}).')",
        "elif (not any(_cuda_rel in subprocess.check_output(['nvcc', '--version'], text=True) "
        "for _cuda_rel in ('release 12.', 'release 13.'))) "
        "or (not str(torch.version.cuda).startswith(('12.', '13.'))):\n"
        "    TRELLIS_SKIP_REASON = 'requires_cuda_12_or_13_toolchain'\n"
        "    print(f'Skipping TRELLIS.2 native CUDA build: FlexGEMM/CuMesh/nvdiffrast pin "
        "CUDA 12.x/13.x (detected CUDA {torch.version.cuda}).')",
        'cell7_cuda_12_or_13',
    )
    # A failed CUDA 13 compile must be a skip, never a notebook-wide crash.
    else_anchor = '\nelse:\n'
    if patched.count(else_anchor) != 1:
        raise ValueError('Missing patch anchor: cell7_native_build_else')
    head, _, body = patched.partition(else_anchor)
    indented = '\n'.join(('    ' + ln) if ln.strip() else ln for ln in body.splitlines()).rstrip('\n')
    except_block = (
        '\n    except Exception as _trellis_build_exc:\n'
        '        TRELLIS_BUILD_OK = False\n'
        '        NVDIFFREC_AVAILABLE = False\n'
        "        TRELLIS_SKIP_REASON = f'cuda_build_failed:{type(_trellis_build_exc).__name__}'\n"
        "        print('[trellis2-4b] Native CUDA build failed (non-fatal):', TRELLIS_SKIP_REASON, "
        'flush=True)\n'
    )
    return head + '\nelse:\n    try:' + indented + except_block


def _patch_cell3_for_token_abort(cell3_src: str) -> str:
    """Abort early when trellis2-4b is in ENABLED_MODELS and HF token is missing."""
    anchor = (
        "HF_TOKEN, HF_TOKEN_SOURCE = secret_source('HF_TOKEN')\n"
        "print(f'TRELLIS.2 HF token source: {HF_TOKEN_SOURCE}')\n"
    )
    replacement = (
        "HF_TOKEN, HF_TOKEN_SOURCE = secret_source('HF_TOKEN')\n"
        "print(f'TRELLIS.2 HF token source: {HF_TOKEN_SOURCE}')\n"
        "if 'trellis2-4b' in ENABLED_MODELS and (HF_TOKEN_SOURCE == 'missing' or not HF_TOKEN):\n"
        "    print('[trellis2-4b] HF token is missing while trellis2-4b is enabled; dumping /kaggle/input and aborting.', flush=True)\n"
        "    if globals().get('dump_kaggle_input_tree'):\n"
        "        dump_kaggle_input_tree('/kaggle/input', max_depth=3)\n"
        "    else:\n"
        "        _in_root = Path('/kaggle/input')\n"
        "        print(f'Listing {_in_root} tree (max depth 3):', flush=True)\n"
        "        if _in_root.exists():\n"
        "            for _p in sorted(_in_root.rglob('*')):\n"
        "                try:\n"
        "                    if len(_p.relative_to(_in_root).parts) <= 3:\n"
        "                        print(f'  {_p}', flush=True)\n"
        "                except Exception:\n"
        "                    pass\n"
        "    raise RuntimeError('Aborting kernel early: trellis2-4b is in ENABLED_MODELS but HF token is missing.')\n"
    )
    return _strict_replace(cell3_src, anchor, replacement, 'cell3_missing_token_abort')


def _patch_cell11_for_trellis(cell11_src: str) -> str:
    """Gate runner loop on ENABLED_MODELS, and fall back to food-only cutout when plate is not preserved."""
    patched = _strict_replace(
        cell11_src,
        'for label in ACTIVE_LABELS:',
        "if 'trellis2-4b' in ENABLED_MODELS:\n"
        "    print('[trellis2-4b] Running on active slice...')\n"
        "for label in (ACTIVE_LABELS if 'trellis2-4b' in ENABLED_MODELS else []):",
        'cell11_trellis_runner_loop',
    )
    old_plate_guard = (
        "    if not (in_entry.get('cutout_metrics') or {}).get('plate_preserved'):\n"
        "        rec.update(status='skipped', mobile_status='not_run', error='Skipped (plate_preserved is false or missing).')\n"
        "        RUNS_3D[key] = rec\n"
        "        continue\n"
    )
    new_plate_fallback = (
        "    cm = in_entry.get('cutout_metrics') or {}\n"
        "    is_plate_preserved = bool(cm.get('plate_preserved', False))\n"
        "    plate_method = cm.get('plate_method', 'food_only_fallback' if not is_plate_preserved else 'unknown')\n"
        "    rec['plate_preserved'] = is_plate_preserved\n"
        "    rec['plate_method'] = plate_method\n"
        "    if not is_plate_preserved:\n"
        "        print(f'[trellis2-4b] {label}: plate not preserved ({plate_method}); falling back to food-only cutout for generation.', flush=True)\n"
    )
    patched = _strict_replace(patched, old_plate_guard, new_plate_fallback, 'cell11_plate_guard_fallback')
    patched = _strict_replace(
        patched,
        "raise DemoError(f'Missing plate-preserving cutout_path for {label}.')",
        "raise DemoError(f'Missing cutout_path for {label}.')",
        'cell11_cutout_path_error',
    )
    patched = _strict_replace(
        patched,
        "rec.update(\n"
        "            status='success',\n"
        "            appearance='pbr_texture',",
        "rec.update(\n"
        "            status='success',\n"
        "            appearance='pbr_texture',\n"
        "            plate_preserved=is_plate_preserved,\n"
        "            plate_method=plate_method,",
        'cell11_record_plate_fields',
    )
    return patched


def _shared_multi_model_helper_cell() -> str:
    """Embed `multi_model_3d.py` core GLB/MoGe-2/UV-baking functions and HF cache purge helper."""
    src = MULTI_MODEL_MODULE.read_text(encoding='utf-8')
    # Strip top module docstring and `if __name__ == '__main__':` block cleanly
    main_idx = src.find('\ndef main(')
    if main_idx != -1:
        src = src[:main_idx]
    lines = [
        ln for ln in src.splitlines()
        if not ln.startswith('from __future__')
    ]
    helper_trailer = """

def purge_hf_and_torch_caches(extra_dirs=()):
    import gc as _gc
    import torch as _torch
    _gc.collect()
    if _torch.cuda.is_available():
        _torch.cuda.empty_cache()
    for target in (HF_CACHE / 'hub', SCRATCH_ROOT / 'torch_cache', *extra_dirs):
        p = Path(target)
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    (HF_CACHE / 'hub').mkdir(parents=True, exist_ok=True)
    print('[cleanup] Purged model weights cache; free disk:',
          round(shutil.disk_usage(ROOT).free / (2**30), 2), 'GiB', flush=True)
"""
    return '\n'.join(lines) + helper_trailer


def _moge2_runner_cell() -> str:
    return r"""# Benchmark Option 1: MoGe-2 (Ruicheng/moge-2-vitl-normal, MIT) 2.5D/3D Relief + Parametric Ceramic Plate
if 'RUNS_3D' not in globals():
    RUNS_3D = {}

MOGE2_REPO = 'Ruicheng/moge-2-vitl-normal'
MOGE2_REVISION = 'cb0e8bbd6b1e243589717c78e750b1ba4c093acf'
MOGE_CODE_REV = '74fbce054ebed49800de42d0ad0e83495065719a'
UTILS3D_MOGE_REV = '62f09d58509485564e24d5d9f6aac9ee9ebc0c37'
REVISIONS['moge2'] = MOGE2_REVISION

if 'moge2-relief' in ENABLED_MODELS:
    print(f'[moge2-relief] Installing/loading {MOGE2_REPO}@{MOGE2_REVISION[:8]}...', flush=True)
    moge_model = None
    try:
        try:
            from moge.model import import_model_class_by_version
        except ImportError:
            _moge_env = os.environ.copy()
            for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
                _moge_env.pop(_s, None)
            # MoGe pins `utils3d-moge`; --no-deps keeps pip from dragging gradio>=6.0 or a
            # conflicting PyPI `utils3d` into the Kaggle torch/CUDA stack.
            run([PYTHON, '-m', 'pip', 'install', '-q', '--no-deps',
                 f'git+https://github.com/EasternJournalist/utils3d-moge.git@{UTILS3D_MOGE_REV}',
                 f'git+https://github.com/microsoft/MoGe.git@{MOGE_CODE_REV}'], env=_moge_env)
            from moge.model import import_model_class_by_version
        _MoGeV2 = import_model_class_by_version('v2')
        moge_model = _MoGeV2.from_pretrained(MOGE2_REPO, revision=MOGE2_REVISION).to('cuda').eval()
        print('[moge2-relief] Loaded MoGe-2 ViT-L Normal on CUDA.', flush=True)
    except Exception as _moge_err:
        print(f'[moge2-relief] Live MoGe-2 weights unavailable ({type(_moge_err).__name__}: {_moge_err}); using geometric relief fallback.', flush=True)

    for label in ACTIVE_LABELS:
        in_entry = image_results[label]
        key = f'{label}/moge2-relief'
        rec = {
            'input_label': label,
            'image_source': in_entry['image_source'],
            'image_model': in_entry.get('model', 'user-photo-upload'),
            'backend': 'MoGe-2 Relief + Ceramic Plate',
            'license': 'MIT',
            'appearance': 'captured_photo_uv_pbr',
            'artifact_paths': [],
        }
        try:
            t0 = time.perf_counter()
            cutout_p = Path(in_entry['cutout_path'])
            depth_map, normal_map = None, None
            if moge_model is not None:
                with Image.open(cutout_p) as _cim:
                    _rgb = ImageOps.exif_transpose(_cim).convert('RGB')
                    _arr = np.asarray(_rgb, dtype=np.float32) / 255.0
                _ten = torch.tensor(_arr, dtype=torch.float32, device='cuda').permute(2, 0, 1)
                with torch.no_grad():
                    _out = moge_model.infer(_ten)
                if 'depth' in _out and _out['depth'] is not None:
                    depth_map = _out['depth'].detach().cpu().numpy()
                if 'normal' in _out and _out['normal'] is not None:
                    normal_map = _sanitize_normal_map(_out['normal'].detach().cpu().numpy())
            raw_glb = RESULTS_DIR / label / 'moge2_relief.glb'
            mob_glb = RESULTS_DIR / label / 'moge2_relief_mobile.glb'
            res = build_moge2_relief_and_ceramic_plate_glb(
                cutout_p, raw_glb, mob_glb, depth_map=depth_map, normal_map=normal_map,
            )
            elapsed = round(time.perf_counter() - t0, 2)
            glb_meta = validate_glb(raw_glb)
            mob_meta = validate_glb(mob_glb)
            res['raw']['elapsed_seconds'] = elapsed
            res['mobile']['elapsed_seconds'] = elapsed
            rec.update(
                status='success',
                device='cuda:0' if moge_model is not None else 'cpu-fallback',
                watertight=res['raw']['watertight'],
                elapsed_seconds=elapsed,
                metrics={**res['raw'], **glb_meta},
                mobile_metrics={**res['mobile'], **mob_meta},
                mobile_glb_path=mob_glb,
                mobile_status='available',
                artifact_paths=[raw_glb, mob_glb],
            )
            print(f'[moge2-relief] {label}: {elapsed}s, faces={res["raw"]["faces"]} (mob={res["mobile"]["faces"]}), watertight={res["raw"]["watertight"]}', flush=True)
        except Exception as _exc:
            rec.update(status='failed', error=f'{type(_exc).__name__}: {_exc}')
            print(f'[moge2-relief] {label} FAILED:', _exc, flush=True)
        RUNS_3D[key] = rec

    del moge_model
    purge_hf_and_torch_caches()
"""


def _triposg_runner_cell() -> str:
    return r"""# Benchmark Option 3: VAST AI TripoSG (1.5B Rectified Flow SDF DiT, MIT) + Photo UV PBR Baker (Bypassing NC RMBG-1.4)
TRIPOSG_REPO = 'VAST-AI/TripoSG'
TRIPOSG_REVISION = '2c1c516d22d58db486a058d98d31bb6177344e06'
TRIPOSG_CODE_REV = 'fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c'
REVISIONS['triposg'] = TRIPOSG_REVISION

if 'triposg' in ENABLED_MODELS:
    triposg_src = SCRATCH_ROOT / 'TripoSG-src'
    triposg_weights = SCRATCH_ROOT / 'TripoSG-weights'
    triposg_pipe = None
    triposg_setup_err = None
    _has_diso = False
    try:
        if not triposg_src.exists():
            run(['git', 'clone', '--depth', '1', 'https://github.com/VAST-AI-Research/TripoSG.git', str(triposg_src)])
            run(['git', '-C', str(triposg_src), 'fetch', '--depth', '1', 'origin', TRIPOSG_CODE_REV])
            run(['git', '-C', str(triposg_src), 'checkout', '--detach', TRIPOSG_CODE_REV])
        _tsg_env = os.environ.copy()
        for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
            _tsg_env.pop(_s, None)
        run([PYTHON, '-m', 'pip', 'install', '-q', '-c', str(SCRATCH_ROOT / 'kaggle_constraints.txt'),
             'peft', 'jaxtyping', 'typeguard', 'einops', 'omegaconf', 'scikit-image'], env=_tsg_env)
        # `diso` has no cp313 wheel and needs a CUDA build; it is optional (only the flash decoder
        # dereferences DiffDMC), so a failed install must not lose the shard.
        try:
            run([PYTHON, '-m', 'pip', 'install', '-q', '--no-build-isolation', 'diso'], env=_tsg_env)
        except Exception as _diso_install_err:
            print(f'[triposg] Optional diso build unavailable ({type(_diso_install_err).__name__}); using marching-cubes decoder.', flush=True)
        try:
            import diso  # noqa: F401
            _has_diso = True
        except Exception:
            _has_diso = False
        if not _has_diso:
            # `triposg.inference_utils` imports DiffDMC at module scope; the stub keeps that import
            # clean because use_flash_decoder=False never constructs it.
            import sys as _diso_sys
            import types as _diso_types
            if 'diso' not in _diso_sys.modules:
                _diso_stub = _diso_types.ModuleType('diso')

                class DiffDMC:
                    pass

                _diso_stub.DiffDMC = DiffDMC
                _diso_sys.modules['diso'] = _diso_stub
        from huggingface_hub import snapshot_download as _snap_dl
        _snap_dl(repo_id=TRIPOSG_REPO, revision=TRIPOSG_REVISION, local_dir=str(triposg_weights), token=HF_TOKEN or False)
        import sys as _sys
        for _p in (str(triposg_src), str(triposg_src / 'scripts')):
            if _p not in _sys.path:
                _sys.path.insert(0, _p)
        from triposg.pipelines.pipeline_triposg import TripoSGPipeline
        # Upstream `scripts/inference_triposg.py` casts the whole pipeline with `.to(device, dtype)`.
        # Passing `torch_dtype=` to `from_pretrained` alone left the DINOv2 image encoder in float32,
        # and because `TripoSGPipeline` derives `latents.dtype` from `image_embeds.dtype`, its features
        # reached FP16 DiT linears and every dish died with
        # `mat1 and mat2 must have the same dtype, but got Float and Half` (benchmark-a/3, 19/19).
        _candidate_pipe = TripoSGPipeline.from_pretrained(str(triposg_weights)).to('cuda', torch.float16)
        # Belt and braces: pin the component that decides the latent dtype.
        _candidate_pipe.image_encoder_dinov2.to(dtype=torch.float16)
        # A dtype probe is a diagnostic, never a gate: benchmark-a/4 lost its own setup report to
        # `TypeError: 'dict' object is not callable` while the pipeline itself was already usable.
        try:
            _triposg_dtypes = {
                _name: torch.nn.Module.parameters(_module).__next__().dtype
                for _name, _module in (
                    ('vae', _candidate_pipe.vae),
                    ('transformer', _candidate_pipe.transformer),
                    ('image_encoder_dinov2', _candidate_pipe.image_encoder_dinov2),
                )
            }
        except Exception as _dtype_probe_err:
            print(
                f'[triposg] dtype probe unavailable ({type(_dtype_probe_err).__name__}: '
                f'{_dtype_probe_err}); continuing with the pipeline-level cast.',
                flush=True,
            )
        else:
            if set(_triposg_dtypes.values()) != {torch.float16}:
                raise RuntimeError(
                    f'TripoSG component dtypes {_triposg_dtypes} must all be float16; '
                    f'latents inherit image_embeds.dtype, so a float32 encoder breaks the DiT linears.',
                )
            print(f'[triposg] dtype probe ok: {_triposg_dtypes}', flush=True)
        triposg_pipe = _candidate_pipe
        print(
            f'[triposg] Loaded TripoSGPipeline FP16 on CUDA (diso={_has_diso}, RMBG-1.4 bypassed).',
            flush=True,
        )
    except Exception as _exc:
        triposg_setup_err = f'{type(_exc).__name__}: {_exc}'
        print('[triposg] Setup failed:', triposg_setup_err, flush=True)

    for label in ACTIVE_LABELS:
        in_entry = image_results[label]
        key = f'{label}/triposg'
        rec = {
            'input_label': label,
            'image_source': in_entry['image_source'],
            'image_model': in_entry.get('model', 'user-photo-upload'),
            'backend': 'TripoSG + Photo PBR',
            'license': 'MIT',
            'appearance': 'pbr_photo_projection',
            'artifact_paths': [],
        }
        if triposg_pipe is None:
            rec.update(status='failed', error=triposg_setup_err or 'TripoSG setup failed')
            RUNS_3D[key] = rec
            continue
        try:
            t0 = time.perf_counter()
            cutout_p = Path(in_entry['cutout_path'])
            # Prepare white-background square RGB directly from plate-preserving RGBA cutout (no RMBG-1.4)
            with Image.open(cutout_p) as _im:
                _rgba = _im.convert('RGBA')
                _bg = Image.new('RGBA', _rgba.size, (255, 255, 255, 255))
                _white_rgb = Image.alpha_composite(_bg, _rgba).convert('RGB')
            gen = torch.Generator(device=triposg_pipe.device).manual_seed(42)
            sample = triposg_pipe(
                image=_white_rgb,
                generator=gen,
                num_inference_steps=50,
                guidance_scale=7.0,
                use_flash_decoder=_has_diso,
            ).samples[0]
            verts = np.asarray(sample[0], dtype=np.float32)
            faces = np.ascontiguousarray(sample[1], dtype=np.uint32)
            # TripoSG's hierarchical marching-cubes decoder emits 1.4M-7.1M faces (benchmark-a/4);
            # without simplification the raw GLB breaks the 50 MB production cap that
            # `validate_glb` (generate_model) enforces and leaves nothing for the mobile ceiling.
            raw_faces_before = int(len(faces))
            if len(faces) > MAX_RAW_FACES:
                verts, faces = _decimate_vertex_cluster(verts, faces, MAX_RAW_FACES)
            raw_glb = RESULTS_DIR / label / 'triposg.glb'
            mob_glb = RESULTS_DIR / label / 'triposg_mobile.glb'
            baked = bake_photographic_uv_pbr_glb(verts, faces, cutout_p, raw_glb, mob_glb, texture_size=1536)
            elapsed = round(time.perf_counter() - t0, 2)
            glb_meta = validate_glb(raw_glb)
            mob_meta = validate_glb(mob_glb) if baked.get('mobile') else {}
            baked['raw']['elapsed_seconds'] = elapsed
            rec.update(
                status='success',
                device='cuda:0',
                watertight=baked['raw'].get('watertight'),
                elapsed_seconds=elapsed,
                metrics={**baked['raw'], **glb_meta, 'raw_faces_before_decimation': raw_faces_before},
                mobile_metrics={**baked['mobile'], **mob_meta} if baked.get('mobile') else None,
                mobile_glb_path=mob_glb if baked.get('mobile') else None,
                mobile_status='available' if baked.get('mobile') else 'failed',
                **({'mobile_error': baked['mobile_error']} if baked.get('mobile_error') else {}),
                artifact_paths=[raw_glb, mob_glb] if baked.get('mobile') else [raw_glb],
            )
            print(
                f'[triposg] {label}: {elapsed}s, faces={baked["raw"]["faces"]} '
                f'(was {raw_faces_before}, mob={(baked["mobile"] or {}).get("faces")})',
                flush=True,
            )
        except Exception as _exc:
            rec.update(status='failed', error=f'{type(_exc).__name__}: {_exc}')
            print(f'[triposg] {label} FAILED:', _exc, flush=True)
        RUNS_3D[key] = rec

    del triposg_pipe
    purge_hf_and_torch_caches((triposg_weights, triposg_src))
"""

def _hunyuan3d2_runner_cell() -> str:
    return r"""# Benchmark Option 4: Tencent Hunyuan3D-2 (1.1B SDF DiT, Community R&D Non-EU/UK/KR) + Texture/PBR
HUNYUAN2_REPO = 'tencent/Hunyuan3D-2'
HUNYUAN2_REVISION = '9cd649ba6913f7a852e3286bad86bfa9a2d83dcf'
HUNYUAN2_CODE_REV = 'f8db63096c8282cb27354314d896feba5ba6ff8a'
REVISIONS['hunyuan3d2'] = HUNYUAN2_REVISION

if 'hunyuan3d2' in ENABLED_MODELS:
    hy2_src = SCRATCH_ROOT / 'Hunyuan3D-2-src'
    hy2_shape = None
    hy2_paint = None
    hy2_err = None
    try:
        if not hy2_src.exists():
            run(['git', 'clone', '--depth', '1', 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git', str(hy2_src)])
            run(['git', '-C', str(hy2_src), 'fetch', '--depth', '1', 'origin', HUNYUAN2_CODE_REV])
            run(['git', '-C', str(hy2_src), 'checkout', '--detach', HUNYUAN2_CODE_REV])
        import sys as _sys
        if str(hy2_src) not in _sys.path:
            _sys.path.insert(0, str(hy2_src))
        _hy_env = os.environ.copy()
        for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
            _hy_env.pop(_s, None)
        run([PYTHON, '-m', 'pip', 'install', '-q', '-c', str(SCRATCH_ROOT / 'kaggle_constraints.txt'),
             'ninja', 'pybind11'], env=_hy_env)
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        hy2_shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            HUNYUAN2_REPO, revision=HUNYUAN2_REVISION, subfolder='hunyuan3d-dit-v2-0-fast',
            torch_dtype=torch.float16, token=HF_TOKEN or False,
        )
        hy2_shape.to('cuda')
        print('[hunyuan3d2] Loaded Hunyuan3D-2 (v2-0-fast) shape pipeline on CUDA.', flush=True)
    except Exception as _exc:
        hy2_err = f'{type(_exc).__name__}: {_exc}'
        print('[hunyuan3d2] Setup failed:', hy2_err, flush=True)

    # Pass 1: shape only. `mc_algo='mc'` uses skimage marching cubes (no diso / CUDA extension), and
    # the photographic UV PBR baker supplies captured-photo colour immediately.
    for label in ACTIVE_LABELS:
        in_entry = image_results[label]
        key = f'{label}/hunyuan3d2'
        rec = {
            'input_label': label,
            'image_source': in_entry['image_source'],
            'image_model': in_entry.get('model', 'user-photo-upload'),
            'backend': 'Hunyuan3D-2 / 2.1',
            'license': 'Tencent Community R&D (Non-EU/UK/KR)',
            'appearance': 'pbr_photo_projection',
            'artifact_paths': [],
        }
        if hy2_shape is None:
            rec.update(status='failed', error=hy2_err or 'Hunyuan3D-2 setup failed')
            RUNS_3D[key] = rec
            continue
        try:
            t0 = time.perf_counter()
            cutout_p = Path(in_entry['cutout_path'])
            with Image.open(cutout_p) as _im:
                _rgba = _im.convert('RGBA')
            mesh = hy2_shape(
                image=_rgba, octree_resolution=256, mc_algo='mc', num_inference_steps=30,
            )[0]
            verts = np.asarray(mesh.vertices, dtype=np.float32)
            faces = np.ascontiguousarray(mesh.faces, dtype=np.uint32)
            np.savez(RESULTS_DIR / label / 'hunyuan3d2_mesh.npz', vertices=verts, faces=faces)
            raw_glb = RESULTS_DIR / label / 'hunyuan3d2.glb'
            mob_glb = RESULTS_DIR / label / 'hunyuan3d2_mobile.glb'
            baked = bake_photographic_uv_pbr_glb(verts, faces, cutout_p, raw_glb, mob_glb, texture_size=1536)
            elapsed = round(time.perf_counter() - t0, 2)
            glb_meta = validate_glb(raw_glb)
            mob_meta = validate_glb(mob_glb) if baked.get('mobile') else {}
            baked['raw']['elapsed_seconds'] = elapsed
            rec.update(
                status='success',
                device='cuda:0',
                watertight=bool(check_watertight_edges(faces)[0]),
                appearance='pbr_photo_projection',
                elapsed_seconds=elapsed,
                metrics={**baked['raw'], **glb_meta},
                mobile_metrics={**baked['mobile'], **mob_meta} if baked.get('mobile') else None,
                mobile_glb_path=mob_glb if baked.get('mobile') else None,
                mobile_status='available' if baked.get('mobile') else 'failed',
                **({'mobile_error': baked['mobile_error']} if baked.get('mobile_error') else {}),
                artifact_paths=[raw_glb, mob_glb] if baked.get('mobile') else [raw_glb],
            )
            print(f'[hunyuan3d2] {label}: {elapsed}s, faces={len(faces)}, photo_uv_pbr=True', flush=True)
        except Exception as _exc:
            rec.update(status='failed', error=f'{type(_exc).__name__}: {_exc}')
            print(f'[hunyuan3d2] {label} FAILED:', _exc, flush=True)
        RUNS_3D[key] = rec

    # Free the shape pipeline before the optional texture stage so both never co-reside in 15GB T4 VRAM.
    if 'hy2_shape' in globals():
        del hy2_shape
    hy2_shape = None
    import gc as _hy_gc
    _hy_gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print('[hunyuan3d2] Released shape pipeline VRAM before the optional paint pass.', flush=True)

    # Pass 2 (optional): native Hunyuan3DPaintPipeline over the meshes saved in pass 1.
    _hy2_paint_labels = [
        label for label in ACTIVE_LABELS
        if (RUNS_3D.get(f'{label}/hunyuan3d2') or {}).get('status') == 'success'
        and (RESULTS_DIR / label / 'hunyuan3d2_mesh.npz').is_file()
    ]
    if not _hy2_paint_labels:
        print('[hunyuan3d2] Skipping native paint pass: no successful shape meshes.', flush=True)
    else:
        try:
            _hy_env2 = os.environ.copy()
            for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
                _hy_env2.pop(_s, None)
            run([PYTHON, '-m', 'pip', 'install', '-q', '--no-build-isolation',
                 'xatlas', str(hy2_src / 'hy3dgen' / 'texgen' / 'custom_rasterizer')], env=_hy_env2)
            from hy3dgen.texgen import Hunyuan3DPaintPipeline
            hy2_paint = Hunyuan3DPaintPipeline.from_pretrained(HUNYUAN2_REPO)
            print('[hunyuan3d2] Loaded Hunyuan3DPaintPipeline for second-pass texture.', flush=True)
        except Exception as _pe:
            hy2_paint = None
            print(f'[hunyuan3d2] Native paint unavailable on T4 ({type(_pe).__name__}: {_pe}); keeping Photographic UV PBR output.', flush=True)

        if hy2_paint is not None:
            import trimesh as _hy_tm
            for label in _hy2_paint_labels:
                rec = RUNS_3D.get(f'{label}/hunyuan3d2') or {}
                mesh_npz = RESULTS_DIR / label / 'hunyuan3d2_mesh.npz'
                try:
                    t_paint = time.perf_counter()
                    with np.load(mesh_npz) as _saved:
                        _verts, _faces = _saved['vertices'], _saved['faces']
                    cutout_p = Path(image_results[label]['cutout_path'])
                    with Image.open(cutout_p) as _im:
                        _rgba = _im.convert('RGBA')
                    painted = hy2_paint(_hy_tm.Trimesh(vertices=_verts, faces=_faces, process=False), image=_rgba)
                    raw_glb = RESULTS_DIR / label / 'hunyuan3d2.glb'
                    painted.export(str(raw_glb))
                    glb_meta = validate_glb(raw_glb)
                    rec['metrics'] = {
                        **(rec.get('metrics') or {}),
                        **{k: glb_meta.get(k) for k in ('vertex_count', 'has_texture', 'has_vertex_color', 'bytes')},
                    }
                    rec['appearance'] = 'native_paint_glb'
                    rec['texture_seconds'] = round(time.perf_counter() - t_paint, 2)
                    print(f'[hunyuan3d2] {label}: native paint pass done in {rec["texture_seconds"]}s', flush=True)
                except Exception as _pr_err:
                    print(f'[hunyuan3d2] {label} native paint pass skipped ({type(_pr_err).__name__}: {_pr_err})', flush=True)
            if 'hy2_paint' in globals():
                del hy2_paint
            hy2_paint = None

    purge_hf_and_torch_caches((hy2_src,))
"""


def _hunyuan3d21_runner_cell() -> str:
    return r"""# Benchmark Option 4b: Tencent Hunyuan3D-2.1 (3.3B MoE DiT Shape, Community R&D Non-EU/UK/KR) + Photo UV PBR
HUNYUAN21_REPO = 'tencent/Hunyuan3D-2.1'
HUNYUAN21_REVISION = '0b94677654c57bb9a6b6845cd7b704ccf551d327'
HUNYUAN21_CODE_REV = '82920d643c0dc2f7bfd7255f45f62d386edfe60c'
REVISIONS['hunyuan3d21'] = HUNYUAN21_REVISION

if 'hunyuan3d21' in ENABLED_MODELS:
    hy21_src = SCRATCH_ROOT / 'Hunyuan3D-2.1-src'
    hy21_shape = None
    hy21_err = None
    try:
        if not hy21_src.exists():
            run(['git', 'clone', '--depth', '1', 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git', str(hy21_src)])
            run(['git', '-C', str(hy21_src), 'fetch', '--depth', '1', 'origin', HUNYUAN21_CODE_REV])
            run(['git', '-C', str(hy21_src), 'checkout', '--detach', HUNYUAN21_CODE_REV])
        import sys as _sys
        if str(hy21_src) not in _sys.path:
            _sys.path.insert(0, str(hy21_src))
        _hy21_shape_dir = str(hy21_src / 'hy3dshape')
        if _hy21_shape_dir not in _sys.path:
            _sys.path.insert(0, _hy21_shape_dir)
        _hy_env = os.environ.copy()
        for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
            _hy_env.pop(_s, None)
        run([PYTHON, '-m', 'pip', 'install', '-q', '-c', str(SCRATCH_ROOT / 'kaggle_constraints.txt'),
             'ninja', 'pybind11'], env=_hy_env)
        from huggingface_hub import snapshot_download
        snapshot_download(
            HUNYUAN21_REPO,
            revision=HUNYUAN21_REVISION,
            allow_patterns=['hunyuan3d-dit-v2-1/*'],
            token=HF_TOKEN or False,
        )
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
        hy21_shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            HUNYUAN21_REPO, subfolder='hunyuan3d-dit-v2-1',
            torch_dtype=torch.float16,
        )
        hy21_shape.to('cuda')
        print('[hunyuan3d21] Loaded Hunyuan3D-2.1 (v2-1) shape pipeline on CUDA.', flush=True)
    except Exception as _exc:
        hy21_err = f'{type(_exc).__name__}: {_exc}'
        print('[hunyuan3d21] Setup failed:', hy21_err, flush=True)

    for label in ACTIVE_LABELS:
        in_entry = image_results[label]
        key = f'{label}/hunyuan3d21'
        rec = {
            'input_label': label,
            'image_source': in_entry['image_source'],
            'image_model': in_entry.get('model', 'user-photo-upload'),
            'backend': 'Hunyuan3D-2.1',
            'license': 'Tencent Community R&D (Non-EU/UK/KR)',
            'appearance': 'pbr_photo_projection',
            'artifact_paths': [],
        }
        if hy21_shape is None:
            rec.update(status='failed', error=hy21_err or 'Hunyuan3D-2.1 setup failed')
            RUNS_3D[key] = rec
            continue
        try:
            t0 = time.perf_counter()
            cutout_p = Path(in_entry['cutout_path'])
            with Image.open(cutout_p) as _im:
                _rgba = _im.convert('RGBA')
            mesh = hy21_shape(
                image=_rgba, octree_resolution=256, mc_algo='mc', num_inference_steps=30,
            )[0]
            verts = np.asarray(mesh.vertices, dtype=np.float32)
            faces = np.ascontiguousarray(mesh.faces, dtype=np.uint32)
            np.savez(RESULTS_DIR / label / 'hunyuan3d21_mesh.npz', vertices=verts, faces=faces)
            raw_glb = RESULTS_DIR / label / 'hunyuan3d21.glb'
            mob_glb = RESULTS_DIR / label / 'hunyuan3d21_mobile.glb'
            baked = bake_photographic_uv_pbr_glb(verts, faces, cutout_p, raw_glb, mob_glb, texture_size=1536)
            elapsed = round(time.perf_counter() - t0, 2)
            glb_meta = validate_glb(raw_glb)
            mob_meta = validate_glb(mob_glb) if baked.get('mobile') else {}
            baked['raw']['elapsed_seconds'] = elapsed
            rec.update(
                status='success',
                device='cuda:0',
                watertight=bool(check_watertight_edges(faces)[0]),
                appearance='pbr_photo_projection',
                elapsed_seconds=elapsed,
                metrics={**baked['raw'], **glb_meta},
                mobile_metrics={**baked['mobile'], **mob_meta} if baked.get('mobile') else None,
                mobile_glb_path=mob_glb if baked.get('mobile') else None,
                mobile_status='available' if baked.get('mobile') else 'failed',
                **({'mobile_error': baked['mobile_error']} if baked.get('mobile_error') else {}),
                artifact_paths=[raw_glb, mob_glb] if baked.get('mobile') else [raw_glb],
            )
            print(f'[hunyuan3d21] {label}: {elapsed}s, faces={len(faces)}, photo_uv_pbr=True', flush=True)
        except Exception as _exc:
            rec.update(status='failed', error=f'{type(_exc).__name__}: {_exc}')
            print(f'[hunyuan3d21] {label} FAILED:', _exc, flush=True)
        RUNS_3D[key] = rec

    if 'hy21_shape' in globals():
        del hy21_shape
    hy21_shape = None
    import gc as _hy21_gc
    _hy21_gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    purge_hf_and_torch_caches((hy21_src,))
"""


XFORMERS_SHIM = r'''
def _install_xformers_sdpa_shim():
    """Return True when native `xformers.ops` exists, else register a pure-PyTorch SDPA stand-in."""
    import sys as _x_sys
    import types as _x_types
    try:
        import xformers.ops as _x_ops  # noqa: F401
        print('[hi3dgen] Native xformers.ops is available; using it unchanged.', flush=True)
        return True
    except Exception:
        pass

    import torch as _x_torch
    import torch.nn.functional as _x_F

    class _SeqLensBlocks:
        """Minimal `xformers.ops.fmha.BlockDiagonalMask` replacement (seqlens -> block slices)."""

        def __init__(self, q_seqlen, kv_seqlen=None):
            self.q_seqlen = [int(s) for s in q_seqlen]
            self.kv_seqlen = [int(s) for s in (kv_seqlen if kv_seqlen is not None else q_seqlen)]

        @staticmethod
        def _blocks(seqlens):
            blocks, start = [], 0
            for length in seqlens:
                blocks.append((start, start + length))
                start += length
            return blocks

        @property
        def q_blocks(self):
            return self._blocks(self.q_seqlen)

        @property
        def kv_blocks(self):
            return self._blocks(self.kv_seqlen)

        @classmethod
        def from_seqlens(cls, q_seqlen, kv_seqlen=None):
            return cls(q_seqlen, kv_seqlen)

    def _x_memory_efficient_attention(q, k, v, attn_bias=None, *args, **kwargs):
        # xformers layout is [batch, seq, heads, channels]; torch SDPA wants [batch, heads, seq, channels].
        # Real xformers returns a tensor [B, M, H, C] (not a tuple). Callers index [0] to drop batch=1.
        if attn_bias is None or not hasattr(attn_bias, 'q_seqlen'):
            out = _x_F.scaled_dot_product_attention(
                q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2),
            )
            return out.transpose(1, 2)
        q_blocks, kv_blocks = attn_bias.q_blocks, attn_bias.kv_blocks
        ragged = q.shape[1] == sum(attn_bias.q_seqlen) and k.shape[1] == sum(attn_bias.kv_seqlen)
        if ragged and len(q_blocks) == len(kv_blocks):
            # Pure block-diagonal (varlen) attention: each query block only sees its own key block.
            outs = []
            for (qs, qe), (ks, ke) in zip(q_blocks, kv_blocks):
                outs.append(_x_F.scaled_dot_product_attention(
                    q[:, qs:qe].transpose(1, 2),
                    k[:, ks:ke].transpose(1, 2),
                    v[:, ks:ke].transpose(1, 2),
                ).transpose(1, 2))
            return _x_torch.cat(outs, dim=1)
        # Rare mixed-shape fallback: build the additive block mask explicitly.
        mask = _x_torch.full((q.shape[1], k.shape[1]), float('-inf'), device=q.device, dtype=q.dtype)
        for (qs, qe), (ks, ke) in zip(q_blocks, kv_blocks):
            mask[qs:qe, ks:ke] = 0.0
        out = _x_F.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=mask,
        )
        return out.transpose(1, 2)

    _x_fmha = _x_types.ModuleType('xformers.ops.fmha')
    _x_fmha.BlockDiagonalMask = _SeqLensBlocks
    _x_ops = _x_types.ModuleType('xformers.ops')
    _x_ops.__path__ = []
    _x_ops.fmha = _x_fmha
    _x_ops.memory_efficient_attention = _x_memory_efficient_attention
    _x_pkg = _x_types.ModuleType('xformers')
    _x_pkg.__path__ = []
    _x_pkg.ops = _x_ops
    _x_sys.modules['xformers'] = _x_pkg
    _x_sys.modules['xformers.ops'] = _x_ops
    _x_sys.modules['xformers.ops.fmha'] = _x_fmha
    print('[hi3dgen] xformers has no cp313 wheel; registered pure-PyTorch SDPA attention shim.', flush=True)
    return False


'''

HI3DGEN_SETUP = r"""if 'hi3dgen' in ENABLED_MODELS:
    hi3d_src = SCRATCH_ROOT / 'Stable3DGen-src'
    hi3d_weights = SCRATCH_ROOT / 'Stable3DGen-weights'
    hi3d_pipe = None
    normal_pred = None
    hi3d_err = None
    # A model whose dependency cannot work on this image is `skipped`, never 19 failed dishes.
    hi3d_unavailable = False
    try:
        os.environ['SPCONV_ALGO'] = 'native'
        # The cp313 manylinux `cumm`/`spconv` wheels already ship compiled `core_cc` extensions and
        # their own CUDA 12.6 runtime. `pccm.utils.project_is_editable()` nevertheless reports them
        # as source checkouts whenever `site-packages/setup.py` or `site-packages/.gitignore`
        # exists, and the import then JIT-rebuilds `cumm` with `ninja` against headers the binary
        # wheel does not ship (benchmark-a/3 and /5: `tensorview/pybind_utils.h: No such file`).
        # These are the packages' own switches for skipping that rebuild; set before any import.
        os.environ['CUMM_DISABLE_JIT'] = '1'
        os.environ['SPCONV_DISABLE_JIT'] = '1'
        _xformers_native = _install_xformers_sdpa_shim()
        os.environ['SPARSE_ATTN_BACKEND'] = 'xformers'
        if not _xformers_native:
            os.environ['ATTN_BACKEND'] = 'sdpa'
        else:
            os.environ.setdefault('ATTN_BACKEND', 'sdpa')
        if not hi3d_src.exists():
            run(['git', 'clone', '--depth', '1', 'https://github.com/Stable-X/Stable3DGen.git', str(hi3d_src)])
            run(['git', '-C', str(hi3d_src), 'fetch', '--depth', '1', 'origin', HI3D_CODE_REV])
            run(['git', '-C', str(hi3d_src), 'checkout', '--detach', HI3D_CODE_REV])
        _h_env = os.environ.copy()
        for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
            _h_env.pop(_s, None)
        # spconv 2.3.8 ships cp313 manylinux wheels for cu126 and cu124; try cu126 first.
        _spconv_installed = None
        for _spconv_pkg in ('spconv-cu126', 'spconv-cu124'):
            try:
                run([PYTHON, '-m', 'pip', 'install', '-q', '-c', str(SCRATCH_ROOT / 'kaggle_constraints.txt'),
                     _spconv_pkg, 'easydict', 'kornia', 'timm'], env=_h_env)
                _spconv_installed = _spconv_pkg
                break
            except Exception as _spconv_err:
                print(f'[hi3dgen] {_spconv_pkg} install failed ({type(_spconv_err).__name__}); trying next.', flush=True)
        if _spconv_installed is None:
            run([PYTHON, '-m', 'pip', 'install', '-q', '-c', str(SCRATCH_ROOT / 'kaggle_constraints.txt'),
                 'easydict', 'kornia', 'timm'], env=_h_env)
            print('[hi3dgen] No spconv wheel matched; continuing without sparse-conv acceleration.', flush=True)
        else:
            print(f'[hi3dgen] Installed {_spconv_installed}.', flush=True)
            # Run one real sparse convolution in a bounded child process before loading weights, so
            # an unusable wheel is one measured, actionable shard skip instead of per-dish failures.
            try:
                _probe = subprocess.run(
                    [PYTHON, '-c', HI3D_SPCONV_SMOKE], capture_output=True, text=True, env=_h_env,
                    timeout=600,
                )
            except subprocess.TimeoutExpired:
                _probe = subprocess.CompletedProcess(
                    [PYTHON, '-c', 'spconv smoke'], 124, '', 'spconv smoke timed out after 600s',
                )
            if _probe.returncode != 0:
                _probe_lines = [
                    line.strip() for line in f'{_probe.stderr}\n{_probe.stdout}'.splitlines()
                    if line.strip()
                ]
                _probe_tail = _probe_lines[-1] if _probe_lines else 'no output'
                print(
                    f'[hi3dgen] {_spconv_installed} unusable on this CUDA image; last line: '
                    f'{_probe_tail}',
                    flush=True,
                )
                run([PYTHON, '-m', 'pip', 'uninstall', '-y', '-q', _spconv_installed], env=_h_env)
                raise RuntimeError(
                    f'spconv_unavailable:{_spconv_installed}:{_probe_tail[:160]}',
                )
            for _probe_line in _probe.stdout.splitlines():
                if _probe_line.strip():
                    print(f'[hi3dgen] {_probe_line.strip()}', flush=True)
        from huggingface_hub import snapshot_download as _snap_dl
        _tn_dir = hi3d_weights / 'trellis-normal-v0-1'
        _snap_dl(repo_id=HI3D_TRELLIS_NORMAL_REPO, local_dir=str(_tn_dir), token=HF_TOKEN or False)
        import sys as _sys
        if str(hi3d_src) not in _sys.path:
            _sys.path.insert(0, str(hi3d_src))
        from hi3dgen.pipelines import Hi3DGenPipeline
        hi3d_pipe = Hi3DGenPipeline.from_pretrained(str(_tn_dir))
        hi3d_pipe.cuda()
        normal_pred = torch.hub.load('hugoycj/StableNormal', 'StableNormal_turbo', trust_repo=True, yoso_version='yoso-normal-v1-8-1', local_cache_dir=str(hi3d_weights))
        print('[hi3dgen] Loaded Hi3DGenPipeline + StableNormal_turbo on CUDA.', flush=True)
    except Exception as _exc:
        hi3d_err = f'{type(_exc).__name__}: {_exc}'
        # Classify the measured environment, not just the probe's own marker: an spconv/cumm import
        # that still rebuilds `cumm` dies in `ninja` on the wheel's missing `tensorview` headers
        # (benchmark-a/3, 19/19 `CalledProcessError`). The no-wheel fallback above can still reach
        # that same import, so those failures stay one shard skip with the measured reason instead
        # of per-dish failures. A genuine Hi3DGen setup error (bad API, missing unrelated module)
        # keeps its `failed` status.
        hi3d_unavailable = str(_exc).startswith('spconv_unavailable:') or any(
            _marker in hi3d_err for _marker in ('spconv', 'cumm', 'tensorview', 'ninja')
        )
        print('[hi3dgen] Setup failed:', hi3d_err, flush=True)
"""

HI3DGEN_GENERATION = r"""    for label in ACTIVE_LABELS:
        in_entry = image_results[label]
        key = f'{label}/hi3dgen'
        rec = {
            'input_label': label,
            'image_source': in_entry['image_source'],
            'image_model': in_entry.get('model', 'user-photo-upload'),
            'backend': 'Hi3DGen Normal-Bridge',
            'license': 'MIT',
            'appearance': 'pbr_photo_projection',
            'artifact_paths': [],
        }
        if hi3d_pipe is None or normal_pred is None:
            if hi3d_unavailable:
                rec.update(
                    status='skipped',
                    error=f'Skipped ({hi3d_err or "Hi3DGen dependencies unavailable"})',
                )
            else:
                rec.update(status='failed', error=hi3d_err or 'Hi3DGen setup failed')
            RUNS_3D[key] = rec
            continue
        try:
            t0 = time.perf_counter()
            cutout_p = Path(in_entry['cutout_path'])
            with Image.open(cutout_p) as _im:
                _rgba = _im.convert('RGBA')
            _prep = hi3d_pipe.preprocess_image(_rgba, resolution=768)
            _norm_img = normal_pred(_prep, resolution=768, match_input_resolution=True, data_type='object')
            _outs = hi3d_pipe.run(
                _norm_img,
                seed=42,
                formats=['mesh'],
                preprocess_image=False,
                sparse_structure_sampler_params={'steps': 25, 'cfg_strength': 3.0},
                slat_sampler_params={'steps': 6, 'cfg_strength': 3.0},
            )
            _tm_mesh = _outs['mesh'][0].to_trimesh(transform_pose=True)
            verts = np.asarray(_tm_mesh.vertices, dtype=np.float32)
            faces = np.ascontiguousarray(_tm_mesh.faces, dtype=np.uint32)
            raw_glb = RESULTS_DIR / label / 'hi3dgen.glb'
            mob_glb = RESULTS_DIR / label / 'hi3dgen_mobile.glb'
            baked = bake_photographic_uv_pbr_glb(verts, faces, cutout_p, raw_glb, mob_glb, texture_size=1536)
            elapsed = round(time.perf_counter() - t0, 2)
            glb_meta = validate_glb(raw_glb)
            mob_meta = validate_glb(mob_glb) if baked.get('mobile') else {}
            baked['raw']['elapsed_seconds'] = elapsed
            rec.update(
                status='success',
                device='cuda:0',
                watertight=baked['raw'].get('watertight'),
                elapsed_seconds=elapsed,
                metrics={**baked['raw'], **glb_meta},
                mobile_metrics={**baked['mobile'], **mob_meta} if baked.get('mobile') else None,
                mobile_glb_path=mob_glb if baked.get('mobile') else None,
                mobile_status='available' if baked.get('mobile') else 'failed',
                **({'mobile_error': baked['mobile_error']} if baked.get('mobile_error') else {}),
                artifact_paths=[raw_glb, mob_glb] if baked.get('mobile') else [raw_glb],
            )
            print(f'[hi3dgen] {label}: {elapsed}s, faces={baked["raw"]["faces"]} (mob={baked["mobile"]["faces"]})', flush=True)
        except Exception as _exc:
            rec.update(status='failed', error=f'{type(_exc).__name__}: {_exc}')
            print(f'[hi3dgen] {label} FAILED:', _exc, flush=True)
        RUNS_3D[key] = rec

    del hi3d_pipe, normal_pred
    purge_hf_and_torch_caches((hi3d_weights, hi3d_src))
"""

HI3DGEN_HEADER = r"""# Benchmark Option 5: Stable-X Hi3DGen (Normal-Bridging 3D, MIT) + Photo UV PBR Baker
HI3D_TRELLIS_NORMAL_REPO = 'Stable-X/trellis-normal-v0-1'
HI3D_TRELLIS_NORMAL_REV = 'fdfac1d0e0cb'
HI3D_YOSO_NORMAL_REPO = 'Stable-X/yoso-normal-v1-8-1'
HI3D_YOSO_NORMAL_REV = '4dd7d000d76f'
HI3D_CODE_REV = 'c29f668ecec44b197275e9bf77f823c0c8a21076'
REVISIONS['hi3dgen'] = HI3D_TRELLIS_NORMAL_REV
# Child-process spconv check: report pccm's editable-install markers, then run one submanifold
# sparse convolution on the GPU Hi3DGen will use.
HI3D_SPCONV_SMOKE = '''
import importlib.util, pathlib
_root = pathlib.Path(importlib.util.find_spec('cumm').origin).parent.parent
print('pccm editable markers:', [n for n in ('setup.py', '.gitignore') if (_root / n).exists()])
import torch
import spconv.pytorch as spconv
dev = 'cuda' if torch.cuda.is_available() else 'cpu'
idx = torch.tensor([[0, 0, 0, 0], [0, 1, 1, 1], [0, 1, 2, 1]], dtype=torch.int32, device=dev)
x = spconv.SparseConvTensor(torch.ones(3, 4, device=dev), idx, [4, 4, 4], 1)
conv = spconv.SubMConv3d(4, 8, 3, bias=False, algo=spconv.ConvAlgo.Native).to(dev)
y = conv(x)
assert tuple(y.features.shape) == (3, 8), tuple(y.features.shape)
print('spconv smoke ok:', dev, tuple(y.features.shape))
'''

"""


def _hi3dgen_runner_cell() -> str:
    return HI3DGEN_HEADER + XFORMERS_SHIM.strip('\n') + '\n\n\n' + HI3DGEN_SETUP + '\n' + HI3DGEN_GENERATION


def _spar3d_runner_cell() -> str:
    return r"""# Benchmark Option 5b: Stability AI SPAR3D (Point-Aware Reconstruction 3D, Stability Community)
SPAR3D_REPO = 'stabilityai/stable-point-aware-3d'
SPAR3D_REVISION = '5699918cb34f55cd7d828493d2725f3038313761'
SPAR3D_CODE_REV = 'fdc311b16809e6a8adc2f5a3407ebb3db1a95bd1'
REVISIONS['spar3d'] = SPAR3D_REVISION

if 'spar3d' in ENABLED_MODELS:
    spar3d_src = SCRATCH_ROOT / 'SPAR3D-src'
    spar3d_weights = SCRATCH_ROOT / 'SPAR3D-weights'
    spar3d_model = None
    spar3d_err = None
    try:
        if not spar3d_src.exists():
            run(['git', 'clone', '--depth', '1', 'https://github.com/Stability-AI/stable-point-aware-3d.git', str(spar3d_src)])
            run(['git', '-C', str(spar3d_src), 'fetch', '--depth', '1', 'origin', SPAR3D_CODE_REV])
            run(['git', '-C', str(spar3d_src), 'checkout', '--detach', SPAR3D_CODE_REV])
        import sys as _sys
        if str(spar3d_src) not in _sys.path:
            _sys.path.insert(0, str(spar3d_src))
        _spar_env = os.environ.copy()
        for _s in ('HF_TOKEN', 'OPENROUTER_API_KEY'):
            _spar_env.pop(_s, None)
        _spar_env['TORCH_CUDA_ARCH_LIST'] = '7.5'
        # If their setup pins c++17 and torch requires newer, rewrite it before building
        for _setup_path in (spar3d_src / 'texture_baker' / 'setup.py', spar3d_src / 'uv_unwrapper' / 'setup.py'):
            if _setup_path.exists():
                _setup_text = _setup_path.read_text(encoding='utf-8')
                if 'c++17' in _setup_text:
                    _setup_path.write_text(_setup_text.replace('c++17', 'c++20'), encoding='utf-8')
        run([PYTHON, '-m', 'pip', 'install', '-q', '-c', str(SCRATCH_ROOT / 'kaggle_constraints.txt'),
             'einops', 'jaxtyping', 'omegaconf', 'loralib'], env=_spar_env)
        # Avoid heavy non-commercial RMBG-1.4 or transparent-background installs; provide stub for Remover
        import types as _types
        if 'transparent_background' not in _sys.modules:
            _tb_stub = _types.ModuleType('transparent_background')
            class Remover:
                def __init__(self, *args, **kwargs): pass
            _tb_stub.Remover = Remover
            _sys.modules['transparent_background'] = _tb_stub
        # Install AlphaCLIP and CLIP
        run([PYTHON, '-m', 'pip', 'install', '-q', '--no-deps',
             'git+https://github.com/openai/CLIP.git',
             'git+https://github.com/SunzeY/AlphaCLIP.git'], env=_spar_env)
        # Build custom CUDA extensions: texture baker and uv unwrapper
        run([PYTHON, '-m', 'pip', 'install', '-q', '--no-build-isolation',
             str(spar3d_src / 'texture_baker'), str(spar3d_src / 'uv_unwrapper')], env=_spar_env)
        from huggingface_hub import snapshot_download
        snapshot_download(
            SPAR3D_REPO,
            revision=SPAR3D_REVISION,
            local_dir=str(spar3d_weights),
            token=HF_TOKEN or False,
        )
        from spar3d.system import SPAR3D
        spar3d_model = SPAR3D.from_pretrained(
            str(spar3d_weights),
            config_name='config.yaml',
            weight_name='model.safetensors',
            low_vram_mode=False,
        )
        spar3d_model.to('cuda')
        spar3d_model.eval()
        print('[spar3d] Loaded SPAR3D on CUDA.', flush=True)
    except Exception as _exc:
        spar3d_err = f'{type(_exc).__name__}: {_exc}'
        print('[spar3d] Setup failed:', spar3d_err, flush=True)

    for label in ACTIVE_LABELS:
        in_entry = image_results[label]
        key = f'{label}/spar3d'
        rec = {
            'input_label': label,
            'image_source': in_entry['image_source'],
            'image_model': in_entry.get('model', 'user-photo-upload'),
            'backend': 'SPAR3D',
            'license': 'Stability AI Community',
            'appearance': 'pbr_texture',
            'artifact_paths': [],
        }
        if spar3d_model is None:
            rec.update(status='skipped', error=f'Skipped ({spar3d_err or "SPAR3D setup failed"})')
            RUNS_3D[key] = rec
            continue
        try:
            t0 = time.perf_counter()
            cutout_p = Path(in_entry['cutout_path'])
            with Image.open(cutout_p) as _im:
                _rgba = _im.convert('RGBA')
            with torch.no_grad():
                with torch.autocast(device_type='cuda', dtype=torch.float16):
                    _out_mesh, _ = spar3d_model.run_image(
                        _rgba,
                        bake_resolution=1024,
                        return_points=False,
                    )
            if isinstance(_out_mesh, list):
                _out_mesh = _out_mesh[0]
            verts = np.asarray(_out_mesh.vertices, dtype=np.float32)
            faces = np.ascontiguousarray(_out_mesh.faces, dtype=np.uint32)
            raw_glb = RESULTS_DIR / label / 'spar3d.glb'
            mob_glb = RESULTS_DIR / label / 'spar3d_mobile.glb'
            _out_mesh.export(str(raw_glb))
            glb_meta = validate_glb(raw_glb)
            mob_meta = {}
            mob_err = None
            if len(faces) <= MAX_MOBILE_FACES:
                shutil.copyfile(raw_glb, mob_glb)
                mob_meta = validate_glb(mob_glb)
            else:
                try:
                    mob_mesh = _out_mesh.simplify_quadric_decimation(MAX_MOBILE_FACES)
                    mob_mesh.export(str(mob_glb))
                    mob_meta = validate_glb(mob_glb)
                except Exception as _m_err:
                    try:
                        vm, fm = _decimate_vertex_cluster(verts, faces, MAX_MOBILE_FACES)
                        if len(fm) <= MAX_MOBILE_FACES:
                            bake_photographic_uv_pbr_glb(vm, fm, cutout_p, mob_glb, mobile_glb_path=None, texture_size=1024)
                            mob_meta = validate_glb(mob_glb)
                        else:
                            mob_err = f'Decimation could not reach <= {MAX_MOBILE_FACES} faces'
                    except Exception as _fb_err:
                        mob_err = f'{type(_fb_err).__name__}: {_fb_err}'
                        mob_glb.unlink(missing_ok=True)
            elapsed = round(time.perf_counter() - t0, 2)
            watertight = bool(check_watertight_edges(faces)[0])
            raw_meta = {
                'vertices': len(verts),
                'faces': len(faces),
                'watertight': watertight,
                'bytes': raw_glb.stat().st_size,
                'sha256': sha256_file(raw_glb),
                'elapsed_seconds': elapsed,
                **glb_meta,
            }
            mob_available = mob_glb.is_file() and mob_meta.get('face_count', len(faces)) <= MAX_MOBILE_FACES
            rec.update(
                status='success',
                device='cuda:0',
                watertight=watertight,
                appearance='pbr_texture',
                elapsed_seconds=elapsed,
                metrics=raw_meta,
                mobile_metrics={**mob_meta} if mob_available else None,
                mobile_glb_path=mob_glb if mob_available else None,
                mobile_status='available' if mob_available else 'failed',
                **({'mobile_error': mob_err} if mob_err else {}),
                artifact_paths=[raw_glb, mob_glb] if mob_available else [raw_glb],
            )
            print(f'[spar3d] {label}: {elapsed}s, faces={len(faces)}, pbr_texture=True', flush=True)
        except Exception as _exc:
            rec.update(status='failed', error=f'{type(_exc).__name__}: {_exc}')
            print(f'[spar3d] {label} FAILED:', _exc, flush=True)
        RUNS_3D[key] = rec

    if 'spar3d_model' in globals():
        del spar3d_model
    spar3d_model = None
    purge_hf_and_torch_caches((spar3d_weights, spar3d_src))
"""


def build_multi_model_notebook(
    *,
    title: str,
    enabled_models: list[str],
    dish_start: int,
    dish_end: int,
) -> dict[str, Any]:
    """Assemble a clean nbformat-4.4 multi-model benchmark notebook."""
    base = _load_baseline_cells()
    c1 = _patch_cell1_for_slice(
        ''.join(base[1]['source']),
        enabled_models=enabled_models,
        dish_start=dish_start,
        dish_end=dish_end,
    )
    c2 = ''.join(base[2]['source'])
    c3 = _patch_cell3_for_token_abort(''.join(base[3]['source']))
    c5 = ''.join(base[5]['source'])
    c7 = _patch_cell7_for_shard(''.join(base[7]['source']))
    # Cell 9 only writes `trellis_prepare_full_plate.py`/`trellis_native_compat.py` and runs CPU unit
    # tests; it has no `DINOV3_OK and TRELLIS_BUILD_OK` guard, so it is copied verbatim.
    c9 = ''.join(base[9]['source'])
    c11 = _patch_cell11_for_trellis(''.join(base[11]['source']))
    c13 = ''.join(base[13]['source'])
    c15 = _patch_cell15_for_multi_model(''.join(base[15]['source']), enabled_models=enabled_models)

    cells = [
        _md_cell(
            f"# {title}\n\n"
            f"- **Enabled Models:** `{enabled_models}`\n"
            f"- **Dataset Slice:** `[{dish_start}:{dish_end}]` from `yacine105/peekaplate-dish-test-photos`\n"
            f"- **Compliance:** `publication_eligible: False` (private R&D comparison studio).\n"
        ),
        _code_cell(c1),
        _md_cell(
            '## 0. Offline fixture checks (no GPU, no network)\n\n'
            'Validates OpenRouter payload decoding, DINOv3 preflight notes, GLB validation, and the\n'
            'manifest/ZIP writer before any GPU work. Cell 2 of `trellislast-version.ipynb`, unchanged.'
        ),
        _code_cell(c2),
        _code_cell(c3),
        _code_cell(_shared_multi_model_helper_cell()),
        _md_cell('## 1. Stage 0/1: Dish Discovery & Plate-Preserving Cutouts'),
        _code_cell(c5),
        _md_cell('## 2. Option 1 — `MoGe-2` Depth/Normal Relief + Parametric Ceramic Plate'),
        _code_cell(_moge2_runner_cell()),
        _md_cell('## 3. Option 3 — `TripoSG` (1.5B Flow SDF DiT) + Photo UV PBR'),
        _code_cell(_triposg_runner_cell()),
        _md_cell('## 4. Option 4 — `Hunyuan3D-2` (DiT Shape + Texture/Photo UV PBR)'),
        _code_cell(_hunyuan3d2_runner_cell()),
        _md_cell('## 4b. Option 4b — `Hunyuan3D-2.1` (DiT Shape + Photo UV PBR)'),
        _code_cell(_hunyuan3d21_runner_cell()),
        _md_cell('## 5. Option 5 — `Hi3DGen` (Normal-Bridging 3D + Photo UV PBR)'),
        _code_cell(_hi3dgen_runner_cell()),
        _md_cell('## 5b. Option 5b — `SPAR3D` (Point-Aware Reconstruction 3D + Native PBR)'),
        _code_cell(_spar3d_runner_cell()),
        _md_cell('## 6. Option 2 — `TRELLIS.2-4B` Native CUDA Build & Generation (when enabled & `HF_TOKEN` attached)'),
        _code_cell(c7),
        _code_cell(c9),
        _code_cell(c11),
        _code_cell(c13),
        _md_cell('## 7. Multi-Model Studio HTML & Archive Export'),
        _code_cell(c15),
    ]
    return {
        'nbformat': 4,
        'nbformat_minor': 4,
        'metadata': {
            'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
            'language_info': {'name': 'python'},
        },
        'cells': cells,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, default=REPO_ROOT / 'notebooks')
    parser.add_argument('--filename', help='emit one explicit variant instead of the canonical pair')
    parser.add_argument('--title')
    parser.add_argument('--models', help='comma-separated ids from MODEL_CATALOG')
    parser.add_argument('--start', type=int)
    parser.add_argument('--end', type=int)
    args = parser.parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    specs = [
        (
            'dish-3d-multi-model-bench-a.ipynb',
            'PeekaPlate 5-Model Dish Benchmark A (MoGe-2, TripoSG, Hunyuan3D-2, Hi3DGen on 19 Core Dishes)',
            ['moge2-relief', 'triposg', 'hunyuan3d2', 'hunyuan3d21', 'hi3dgen'],
            0,
            19,
        ),
        (
            'dish-3d-multi-model-bench-b.ipynb',
            'PeekaPlate 5-Model Dish Benchmark B (TRELLIS.2-4B + MoGe-2 on GMn9C8.pdf Hero Dishes)',
            ['trellis2-4b', 'moge2-relief'],
            4,
            19,
        ),
    ]
    explicit = (args.filename, args.title, args.models, args.start, args.end)
    if any(value is not None for value in explicit):
        if any(value is None for value in explicit):
            parser.error('--filename, --title, --models, --start and --end are required together')
        models = [model.strip() for model in args.models.split(',') if model.strip()]
        if not models:
            parser.error('--models needs at least one id')
        unknown = sorted(set(models) - set(MODEL_CATALOG))
        if unknown:
            parser.error(f'unknown model id(s): {unknown}; known: {sorted(MODEL_CATALOG)}')
        if not 0 <= args.start < args.end:
            parser.error('--start must be >= 0 and lower than --end')
        specs = [(args.filename, args.title, models, args.start, args.end)]
    for filename, title, models, start, end in specs:
        nb = build_multi_model_notebook(title=title, enabled_models=models, dish_start=start, dish_end=end)
        out_path = args.out_dir / filename
        out_path.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        print(f'Generated {out_path} ({len(nb["cells"])} cells, {out_path.stat().st_size} B)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

