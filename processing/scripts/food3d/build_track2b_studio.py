"""Track 2B Menu Dishes 3D Studio HTML Generator.

CLI:
  python build_track2b_studio.py <recon_dir> [--dishes <d1> <d2> ...]
      [--refs-dir <dir>] [--out <recon_dir>/studio.html] [--title "..."]

Produces a zero-CDN dark-slate multi-dish 3D review studio (`studio.html`),
copies `viewer.html` and matched reference photos (`_refs/`), and links `_three`
to the local Three.js package.

Every manifest, HTML badge/text, and ratings export enforces:
  "publication_eligible": false (ADR 0004)
and discloses that 150k photo-fidelity QA failed using generated Flow footage,
so fidelity to the real dishes remains unverified.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
from pathlib import Path
from typing import Any

SKIP_DIRS = frozenset({'datasets', 'colab', 'logs'})
REF_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp')
GLB_150K = 'lod_150k_2048.pbr.glb'
GLB_35K = 'lod_35k_1024.pbr.glb'

FLOW_DISCLOSURE = (
    'ADR 0004 · publication_eligible: false — All 150k models failed photo-fidelity QA '
    '(e.g. SSIM < 0.15; super burrito Delta E 38.92 > 35.0). Photo-fidelity checks used '
    'generated Flow footage, so fidelity to the real dishes remains unverified.'
)


def find_three_package_dir() -> Path:
    """Locate the local Three.js package directory containing build/three.module.js."""
    repo_root = Path(__file__).resolve().parents[3]
    direct = repo_root / 'node_modules' / 'three'
    if (direct / 'build' / 'three.module.js').is_file():
        return direct.resolve()
    pnpm_root = repo_root / 'node_modules' / '.pnpm'
    if pnpm_root.is_dir():
        for cand in sorted(pnpm_root.glob('three@*/node_modules/three')):
            if (cand / 'build' / 'three.module.js').is_file():
                return cand.resolve()
    raise RuntimeError(f'Could not locate local three package under {repo_root / "node_modules"}')


def _validate_rel_segments(root: Path, root_resolved: Path, path: Path, label: str) -> Path:
    """Ensure no path segment from root down to path is a symlink and path resolves within root."""
    rel = path.relative_to(root)
    cur = root
    for part in rel.parts:
        cur = cur / part
        if cur.is_symlink():
            raise RuntimeError(f'{label} must not be or traverse a symlink: {cur}')
    resolved = path.resolve()
    if not resolved.is_relative_to(root_resolved):
        raise RuntimeError(f'{label} escapes root {root}: {path}')
    return resolved


def _read_contained_json(root: Path, root_resolved: Path, path: Path, label: str) -> dict[str, Any] | None:
    """Read JSON from a non-symlink file strictly contained inside root, or return None if absent."""
    resolved = _validate_rel_segments(root, root_resolved, path, label)
    if not path.exists():
        return None
    if not resolved.is_file():
        raise RuntimeError(f'{label} is not a regular file: {path}')
    return json.loads(resolved.read_text(encoding='utf-8'))


def _resolve_contained_file(root: Path, root_resolved: Path, path: Path, label: str) -> Path | None:
    """Return resolved path for an existing regular file contained inside root, else None."""
    resolved = _validate_rel_segments(root, root_resolved, path, label)
    if not path.exists():
        return None
    if not resolved.is_file():
        raise RuntimeError(f'{label} is not a regular file: {path}')
    return resolved


def _validate_dish_name(dish: str) -> None:
    if (
        not dish
        or '/' in dish
        or '\\' in dish
        or dish in ('.', '..')
        or dish.startswith('.')
        or dish.startswith('_')
        or dish in SKIP_DIRS
    ):
        raise RuntimeError(f'Invalid dish directory name: {dish!r}')


def discover_dishes(recon_dir: Path) -> list[str]:
    """Discover valid Track 2B dish directories containing 150k or 35k PBR GLBs."""
    recon_root = recon_dir.resolve()
    dishes: list[str] = []
    for child in sorted(recon_dir.iterdir()):
        if child.name.startswith('_') or child.name.startswith('.') or child.name in SKIP_DIRS:
            continue
        if child.is_symlink():
            if child.is_dir():
                raise RuntimeError(f'Dish directory must not be a symlink: {child}')
            continue
        if not child.is_dir():
            continue
        resolved_child = child.resolve()
        if not resolved_child.is_relative_to(recon_root):
            raise RuntimeError(f'Dish directory escapes recon_dir: {child}')
        glb_150 = _resolve_contained_file(recon_dir, recon_root, child / GLB_150K, 'GLB 150k')
        glb_35 = _resolve_contained_file(recon_dir, recon_root, child / GLB_35K, 'GLB 35k')
        if glb_150 is not None or glb_35 is not None:
            dishes.append(child.name)
    return dishes


def _fmt_mb(byte_count: int | None) -> str:
    if byte_count is None:
        return 'n/a'
    return f'{byte_count / (1024 * 1024):.2f} MB'


def _find_matching_ref(refs_dir: Path | None, dish: str) -> Path | None:
    if refs_dir is None:
        return None
    if refs_dir.is_symlink() or not refs_dir.is_dir():
        raise RuntimeError(f'refs_dir must be a real directory: {refs_dir}')
    refs_root = refs_dir.resolve()
    stems = [dish]
    if dish.startswith('refined_'):
        stems.append(dish[len('refined_'):])
    for stem in stems:
        for ext in REF_EXTENSIONS:
            cand = refs_dir / f'{stem}{ext}'
            resolved = _resolve_contained_file(refs_dir, refs_root, cand, 'Reference photo')
            if resolved is not None:
                return resolved
    return None


def _rel_href(target_resolved: Path, out_dir_resolved: Path) -> str:
    return Path(os.path.relpath(target_resolved, out_dir_resolved)).as_posix()


def _format_dish_title(dish: str) -> str:
    base = dish[len('refined_'):] if dish.startswith('refined_') else dish
    return base.replace('_', ' ').title()


def _extract_qa_block(qa: dict[str, Any] | None, glb_bytes_disk: int | None) -> dict[str, Any]:
    if qa is None:
        return {
            'present': False,
            'verdict': 'UNKNOWN',
            'reasons': [],
            'warnings': [],
            'glb_bytes': glb_bytes_disk,
            'mb': _fmt_mb(glb_bytes_disk),
            'triangles': None,
            'validate_ok': None,
            'checks': {},
            'pbr_summary': {},
        }
    checks = qa.get('checks') or {}
    budget = checks.get('gltf_budget') or {}
    geom = checks.get('geometry') or {}
    pbr = checks.get('pbr_material') or {}
    fid = checks.get('photo_fidelity') or {}
    relit = checks.get('relighting') or {}
    pbr_sum = qa.get('pbr_report_summary') or {}

    glb_bytes = glb_bytes_disk if glb_bytes_disk is not None else budget.get('glb_bytes')
    triangles = budget.get('triangles') if budget.get('triangles') is not None else geom.get('faces')

    return {
        'present': True,
        'verdict': qa.get('verdict', 'UNKNOWN'),
        'reasons': list(qa.get('reasons') or []),
        'warnings': list(qa.get('warnings') or []),
        'glb_bytes': glb_bytes,
        'mb': _fmt_mb(glb_bytes),
        'triangles': triangles,
        'validate_ok': budget.get('validate_ok'),
        'checks': {
            'gltf_budget': {
                'status': budget.get('status'),
                'glb_bytes': budget.get('glb_bytes'),
                'max_bytes': budget.get('max_bytes'),
                'triangles': budget.get('triangles'),
                'max_tris': budget.get('max_tris'),
                'validate_ok': budget.get('validate_ok'),
            },
            'geometry': {
                'status': geom.get('status'),
                'extents': geom.get('extents'),
                'seated': geom.get('seated'),
                'shells': geom.get('shells'),
                'faces': geom.get('faces'),
                'bake_diameter_cm': geom.get('bake_diameter_cm'),
                'bake_calibrated': geom.get('bake_calibrated'),
            },
            'pbr_material': {
                'status': pbr.get('status'),
                'metallic_factor': pbr.get('metallic_factor'),
                'roughness_mean': pbr.get('roughness_mean'),
                'roughness_std': pbr.get('roughness_std'),
                'clearcoat_mean': pbr.get('clearcoat_mean'),
                'clearcoat_std': pbr.get('clearcoat_std'),
                'has_normal_texture': pbr.get('has_normal_texture'),
                'has_occlusion_texture': pbr.get('has_occlusion_texture'),
                'has_clearcoat': pbr.get('has_clearcoat'),
            },
            'photo_fidelity': {
                'status': fid.get('status'),
                'poses_evaluated': fid.get('poses_evaluated'),
                'best_pose': fid.get('best_pose'),
                'match': fid.get('match'),
                'silhouette_iou': fid.get('silhouette_iou'),
                'delta_e': fid.get('delta_e'),
                'ssim': fid.get('ssim'),
                'detail_corr': fid.get('detail_corr'),
                'reasons': list(fid.get('reasons') or []),
                'warnings': list(fid.get('warnings') or []),
            } if fid else None,
            'relighting': {
                'status': relit.get('status'),
                'relit_mean_diff': relit.get('relit_mean_diff'),
                'relit_p95_diff': relit.get('relit_p95_diff'),
                'min_p95_diff': relit.get('min_p95_diff'),
                'foreground_pixels': relit.get('foreground_pixels'),
            } if relit else None,
        },
        'pbr_summary': {
            'delight_mean_delta_e': pbr_sum.get('delight_mean_delta_e'),
            'wet_fraction': pbr_sum.get('wet_fraction'),
            'dry_fraction': pbr_sum.get('dry_fraction'),
            'vessel_fraction': pbr_sum.get('vessel_fraction'),
            'clearcoat_max': pbr_sum.get('clearcoat_max'),
        } if pbr_sum else {},
    }


def collect_dish_manifest(
    recon_dir: Path,
    recon_root: Path,
    dish: str,
    *,
    out_dir_resolved: Path,
    refs_dir: Path | None = None,
    copy_refs_to: Path | None = None,
) -> dict[str, Any]:
    """Validate containment, extract real JSON metrics, and build one dish manifest entry."""
    _validate_dish_name(dish)
    dish_dir = recon_dir / dish
    _validate_rel_segments(recon_dir, recon_root, dish_dir, f'Dish directory {dish}')
    if not dish_dir.is_dir():
        raise RuntimeError(f'Dish directory does not exist: {dish_dir}')

    glb_150_res = _resolve_contained_file(recon_dir, recon_root, dish_dir / GLB_150K, f'{dish} 150k GLB')
    glb_35_res = _resolve_contained_file(recon_dir, recon_root, dish_dir / GLB_35K, f'{dish} 35k GLB')
    if glb_150_res is None and glb_35_res is None:
        raise RuntimeError(f'Dish directory has neither {GLB_150K} nor {GLB_35K}: {dish_dir}')

    qa150_raw = _read_contained_json(recon_dir, recon_root, dish_dir / 'qa_report_150k.json', f'{dish} qa_report_150k')
    qa35_raw = _read_contained_json(recon_dir, recon_root, dish_dir / 'qa_report_35k.json', f'{dish} qa_report_35k')
    recon_meta_raw = _read_contained_json(
        recon_dir, recon_root, dish_dir / 'track2b_recon_meta.json', f'{dish} track2b_recon_meta'
    )
    score_raw = _read_contained_json(
        recon_dir, recon_root, dish_dir / 'eval' / 'score_summary.json', f'{dish} score_summary'
    )
    conv_raw = _read_contained_json(
        recon_dir,
        recon_root,
        recon_dir / 'datasets' / dish / 'conversion_report.json',
        f'{dish} conversion_report',
    )

    bytes_150 = glb_150_res.stat().st_size if glb_150_res is not None else None
    bytes_35 = glb_35_res.stat().st_size if glb_35_res is not None else None

    qa_150 = _extract_qa_block(qa150_raw, bytes_150)
    qa_35 = _extract_qa_block(qa35_raw, bytes_35)

    # Diagnostic images inside recon_dir
    diag_specs = {
        'turntable_contact_sheet': dish_dir / 'eval' / 'turntable_contact_sheet.png',
        'heldout_eval_sheet_lit': dish_dir / 'eval' / 'heldout_eval_sheet_lit.png',
        'heldout_eval_sheet_albedo': dish_dir / 'eval' / 'heldout_eval_sheet_albedo.png',
        'fidelity_diag': dish_dir / 'eval' / 'fidelity_diag.png',
        'pbr_masks_debug': dish_dir / 'pbr_150k' / 'pbr_masks_debug.png',
    }
    assets: dict[str, str | None] = {}
    ref_src = _find_matching_ref(refs_dir, dish)
    if ref_src is not None and copy_refs_to is not None:
        if copy_refs_to.is_symlink():
            raise RuntimeError(f'_refs directory must not be a symlink: {copy_refs_to}')
        copy_refs_to.mkdir(parents=True, exist_ok=True)
        ref_dst = copy_refs_to / ref_src.name
        if ref_dst.is_symlink():
            ref_dst.unlink()
        shutil.copyfile(ref_src, ref_dst)
        assets['reference_photo'] = _rel_href(ref_dst.resolve(), out_dir_resolved)
    else:
        assets['reference_photo'] = None

    for key, img_path in diag_specs.items():
        resolved = _resolve_contained_file(recon_dir, recon_root, img_path, f'{dish} {key}')
        assets[key] = _rel_href(resolved, out_dir_resolved) if resolved is not None else None

    # Held-out evaluation scores
    heldout_eval: dict[str, Any] = {}
    if score_raw is not None:
        for branch in ('albedo', 'lit'):
            branch_data = score_raw.get(branch)
            if isinstance(branch_data, dict):
                heldout_eval[branch] = {
                    metric: {
                        stat: stats_dict.get(stat)
                        for stat in ('mean', 'median', 'min', 'max', 'p10')
                        if isinstance(stats_dict, dict)
                    }
                    for metric, stats_dict in branch_data.items()
                }
        if 'turntable_fg_luminance' in score_raw:
            heldout_eval['turntable_fg_luminance'] = score_raw['turntable_fg_luminance']

    # Recon metadata
    meta_out: dict[str, Any] = {}
    if recon_meta_raw is not None:
        tsdf_settings = recon_meta_raw.get('tsdf_settings') or {}
        train_photo = recon_meta_raw.get('train_photometric') or {}
        cleanup = recon_meta_raw.get('cleanup') or {}
        smoothing = recon_meta_raw.get('smoothing') or {}
        dihedral_after = smoothing.get('dihedral_after') or {}
        w2m = recon_meta_raw.get('world_to_metric') or {}
        remote = recon_meta_raw.get('remote') or {}
        meta_out = {
            'pipeline': recon_meta_raw.get('pipeline'),
            'train_views_used': recon_meta_raw.get('train_views_used'),
            'steps': recon_meta_raw.get('steps'),
            'final_splats': recon_meta_raw.get('final_splats'),
            'train_seconds': recon_meta_raw.get('train_seconds'),
            'tsdf_seconds': recon_meta_raw.get('tsdf_seconds'),
            'voxel_divisions': tsdf_settings.get('voxel_divisions') or remote.get('voxel_divisions_chosen'),
            'train_full_psnr_db': train_photo.get('full_psnr_db'),
            'train_fg_psnr_db': train_photo.get('fg_psnr_db'),
            'train_silhouette_iou': recon_meta_raw.get('train_silhouette_iou'),
            'dense_faces': recon_meta_raw.get('dense_faces'),
            'cleanup_faces_after': cleanup.get('faces_after'),
            'cleanup_kept_components': cleanup.get('kept_components'),
            'smoothing_method': smoothing.get('method'),
            'dihedral_after_mean_deg': dihedral_after.get('mean_deg'),
            'diameter_cm': w2m.get('diameter_cm'),
            'calibrated': w2m.get('calibrated'),
            'dimensions_m': w2m.get('dimensions_m'),
            'remote_host': remote.get('host'),
            'remote_gpu': remote.get('gpu'),
            'remote_mem_total_gib': remote.get('mem_total_gib'),
        }

    # Dataset conversion stats
    dataset_out: dict[str, Any] = {}
    if conv_raw is not None:
        dataset_out = {
            'train_frames': conv_raw.get('train_frames'),
            'eval_frames': conv_raw.get('eval_frames'),
            'registered_frames': conv_raw.get('registered_frames'),
            'target_frames': conv_raw.get('target_frames'),
            'selected_candidate_frames': conv_raw.get('selected_candidate_frames'),
            'registration_rate': conv_raw.get('registration_rate'),
            'sampled_views': conv_raw.get('sampled_views'),
            'mean_reprojection_error_px': conv_raw.get('mean_reprojection_error_px'),
            'num_colmap_points3d': conv_raw.get('num_colmap_points3d'),
            'mean_mask_hit_rate': conv_raw.get('mean_mask_hit_rate'),
            'cutout_model': conv_raw.get('cutout_model'),
            'source_total_frames': conv_raw.get('source_total_frames'),
        }

    variants = {
        '150k': {
            'key': '150k',
            'label': 'High-detail 150k (2048 maps)',
            'short_label': '150k',
            'glb': _rel_href(glb_150_res, out_dir_resolved) if glb_150_res is not None else None,
            'bytes': qa_150['glb_bytes'],
            'mb': qa_150['mb'],
            'triangles': qa_150['triangles'],
            'verdict': qa_150['verdict'],
        },
        '35k': {
            'key': '35k',
            'label': 'Mobile 35k (1024 maps)',
            'short_label': '35k',
            'glb': _rel_href(glb_35_res, out_dir_resolved) if glb_35_res is not None else None,
            'bytes': qa_35['glb_bytes'],
            'mb': qa_35['mb'],
            'triangles': qa_35['triangles'],
            'verdict': qa_35['verdict'],
        },
    }

    return {
        'dish': dish,
        'display_name': _format_dish_title(dish),
        'publication_eligible': False,
        'variants': variants,
        'qa_150k': qa_150,
        'qa_35k': qa_35,
        'heldout_eval': heldout_eval,
        'recon_meta': meta_out,
        'dataset': dataset_out,
        'assets': assets,
    }


def _escape_json_for_script(data: dict[str, Any]) -> str:
    raw = json.dumps(data, indent=2, ensure_ascii=False)
    for ch in '<>&\u2028\u2029':
        raw = raw.replace(ch, f'\\u{ord(ch):04x}')
    return raw


def _prepare_runtime_support(out_dir_resolved: Path) -> None:
    """Copy viewer.html and link _three into out_dir_resolved."""
    three_pkg_dir = find_three_package_dir()
    three_link = out_dir_resolved / '_three'
    if three_link.is_symlink():
        three_link.unlink()
    if not three_link.exists():
        three_link.symlink_to(three_pkg_dir)
    elif not (three_link / 'build' / 'three.module.js').is_file():
        raise RuntimeError(f'Existing _three directory is missing build/three.module.js: {three_link}')

    viewer_src = Path(__file__).resolve().parent / 'viewer.html'
    if not viewer_src.is_file():
        raise RuntimeError(f'Missing viewer.html next to build_track2b_studio.py: {viewer_src}')
    viewer_dst = out_dir_resolved / 'viewer.html'
    if viewer_dst.is_symlink():
        viewer_dst.unlink()
    shutil.copyfile(viewer_src, viewer_dst)


def render_studio_html(manifest: dict[str, Any], title: str) -> str:
    """Render the self-contained zero-CDN studio HTML document."""
    safe_title = html.escape(title, quote=True)
    safe_json = _escape_json_for_script(manifest)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{safe_title}</title>
<style>
  :root {{
    --bg: #0f1419;
    --panel: #161e26;
    --panel-2: #1e2833;
    --panel-3: #24303d;
    --border: #2e3d4d;
    --text: #eef3f7;
    --muted: #9aa9b8;
    --accent: #f0b35a;
    --accent-dim: rgba(240, 179, 90, 0.14);
    --pass: #4cc980;
    --pass-bg: rgba(76, 201, 128, 0.14);
    --warn: #ebb248;
    --warn-bg: rgba(235, 178, 72, 0.14);
    --fail: #eb5c5c;
    --fail-bg: rgba(235, 92, 92, 0.15);
  }}
  * {{ box-sizing: border-box; }}
  html, body {{
    margin: 0;
    min-height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.45;
  }}
  button, select, input, textarea {{
    font-family: inherit;
    font-size: 12px;
  }}
  button, select {{
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 6px 10px;
    cursor: pointer;
    transition: border-color 0.14s ease, background 0.14s ease;
  }}
  button:hover:not(:disabled), select:hover:not(:disabled) {{
    border-color: var(--accent);
  }}
  button:disabled {{
    opacity: 0.4;
    cursor: not-allowed;
  }}
  button.active {{
    background: var(--accent);
    border-color: var(--accent);
    color: #16130e;
    font-weight: 600;
  }}
  .app-shell {{
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }}
  header.topbar {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 18px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }}
  .brand-group {{
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }}
  .brand-title {{
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }}
  .badge {{
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 999px;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--muted);
    white-space: nowrap;
  }}
  .badge-adr {{
    background: var(--accent-dim);
    color: var(--accent);
    border-color: rgba(240, 179, 90, 0.4);
  }}
  .badge-PASS {{
    background: var(--pass-bg);
    color: var(--pass);
    border-color: rgba(76, 201, 128, 0.4);
  }}
  .badge-WARN {{
    background: var(--warn-bg);
    color: var(--warn);
    border-color: rgba(235, 178, 72, 0.4);
  }}
  .badge-FAIL {{
    background: var(--fail-bg);
    color: var(--fail);
    border-color: rgba(235, 92, 92, 0.4);
  }}
  .tabs {{
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }}
  .tab-btn {{
    padding: 7px 13px;
    font-weight: 600;
  }}
  .disclosure-banner {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 18px;
    background: rgba(235, 92, 92, 0.11);
    border-bottom: 1px solid rgba(235, 92, 92, 0.35);
    color: #ffd7d7;
    font-size: 12px;
    flex-wrap: wrap;
  }}
  .disclosure-banner strong {{
    color: #ff9c9c;
  }}
  .file-help-banner {{
    display: none;
    padding: 10px 18px;
    background: rgba(240, 179, 90, 0.12);
    border-bottom: 1px solid rgba(240, 179, 90, 0.35);
    color: #fae0b5;
    font-size: 12px;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }}
  .file-help-banner.visible {{
    display: flex;
  }}
  code {{
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #ffe3b0;
  }}
  .toolbar {{
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 18px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }}
  .tool-group {{
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    padding-right: 10px;
    border-right: 1px solid var(--border);
  }}
  .tool-group:last-child {{
    border-right: 0;
    padding-right: 0;
  }}
  .tool-label {{
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-right: 3px;
  }}
  .slider-inline {{
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }}
  .slider-inline input[type="range"] {{
    width: 115px;
    accent-color: var(--accent);
    cursor: pointer;
  }}
  .view-panel {{
    display: none;
    flex: 1;
  }}
  .view-panel.active {{
    display: flex;
    flex-direction: column;
  }}

  /* Gallery View */
  .gallery-grid {{
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    padding: 16px 18px 24px;
  }}
  @media (max-width: 1200px) {{
    .gallery-grid {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
  }}
  @media (max-width: 780px) {{
    .gallery-grid {{ grid-template-columns: 1fr; }}
  }}
  .dish-card {{
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }}
  .dish-card-head {{
    padding: 11px 14px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }}
  .dish-title {{
    font-size: 15px;
    font-weight: 700;
  }}
  .dish-id {{
    font-size: 11px;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }}
  .viewer-box {{
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    background: #d8d5cf;
    border-bottom: 1px solid var(--border);
  }}
  .viewer-box iframe {{
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }}
  .dish-card-body {{
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }}
  .lod-pills {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }}
  .lod-pill {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 9px;
    font-size: 11px;
    text-align: left;
  }}
  .stats-grid {{
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px 12px;
    font-size: 12px;
  }}
  .stat-row {{
    display: flex;
    justify-content: space-between;
    gap: 6px;
    border-bottom: 1px dashed rgba(46, 61, 77, 0.7);
    padding-bottom: 2px;
  }}
  .stat-k {{ color: var(--muted); }}
  .stat-v {{ font-weight: 600; font-variant-numeric: tabular-nums; }}
  .card-actions {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 4px;
  }}

  /* Focus Studio View */
  .focus-layout {{
    display: grid;
    grid-template-columns: 1fr 410px;
    height: calc(100vh - 104px);
    min-height: 620px;
  }}
  @media (max-width: 980px) {{
    .focus-layout {{
      grid-template-columns: 1fr;
      height: auto;
    }}
    .focus-viewport {{
      height: 60vh;
    }}
  }}
  .focus-viewport {{
    position: relative;
    background: #d8d5cf;
    overflow: hidden;
  }}
  .focus-viewport iframe {{
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }}
  .viewport-overlay {{
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    pointer-events: none;
  }}
  .viewport-overlay .badge {{
    background: rgba(15, 20, 25, 0.82);
    color: var(--text);
    backdrop-filter: blur(8px);
  }}
  aside.focus-sidebar {{
    background: var(--panel);
    border-left: 1px solid var(--border);
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }}
  .side-card {{
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 11px;
  }}
  .side-card h3 {{
    margin: 0 0 8px 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }}
  .btn-grid-2 {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }}
  .reasons-list {{
    margin: 8px 0 0 0;
    padding-left: 16px;
    font-size: 11px;
    color: #ffb8b8;
  }}
  .warnings-list {{
    margin: 6px 0 0 0;
    padding-left: 16px;
    font-size: 11px;
    color: #ffd996;
  }}
  table.score-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }}
  table.score-table th, table.score-table td {{
    border-bottom: 1px solid var(--border);
    padding: 4px 5px;
    text-align: right;
  }}
  table.score-table th:first-child, table.score-table td:first-child {{
    text-align: left;
    color: var(--muted);
  }}
  .thumb-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }}
  .thumb-btn {{
    padding: 0;
    background: #131920;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    text-align: left;
  }}
  .thumb-btn img {{
    width: 100%;
    height: 104px;
    object-fit: contain;
    background: #d8d5cf;
    display: block;
  }}
  .thumb-btn span {{
    padding: 5px 7px;
    font-size: 11px;
    color: var(--muted);
  }}
  .stars {{
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }}
  .star-btn {{
    flex: 1;
    padding: 7px 0;
    font-weight: 700;
  }}
  textarea {{
    width: 100%;
    min-height: 62px;
    background: #12181f;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 7px;
    resize: vertical;
  }}

  /* Compare View */
  .compare-grid {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    padding: 14px 18px 20px;
    flex: 1;
  }}
  @media (max-width: 900px) {{
    .compare-grid {{ grid-template-columns: 1fr; }}
  }}
  .compare-pane {{
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 540px;
  }}
  .compare-head {{
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }}
  .compare-iframe-wrap {{
    flex: 1;
    background: #d8d5cf;
    min-height: 460px;
  }}
  .compare-iframe-wrap iframe {{
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }}

  /* Lightbox Modal */
  .lightbox {{
    position: fixed;
    inset: 0;
    background: rgba(8, 12, 16, 0.86);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 100;
  }}
  .lightbox.open {{
    display: flex;
  }}
  .lightbox-dialog {{
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    max-width: 94vw;
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }}
  .lightbox-head {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }}
  .lightbox-body {{
    padding: 12px;
    overflow: auto;
    display: flex;
    justify-content: center;
    background: #10151b;
  }}
  .lightbox-body img {{
    max-width: 88vw;
    max-height: 78vh;
    object-fit: contain;
    display: block;
  }}
</style>
</head>
<body>
<div class="app-shell">
  <header class="topbar">
    <div class="brand-group">
      <span class="brand-title" id="studio-title"></span>
      <span class="badge badge-adr">publication_eligible: false</span>
      <span class="badge">ADR 0004 · Private R&amp;D</span>
    </div>
    <div class="tabs" role="tablist" aria-label="Studio Views">
      <button class="tab-btn active" type="button" data-tab="gallery" role="tab" aria-selected="true">Gallery (All 3)</button>
      <button class="tab-btn" type="button" data-tab="focus" role="tab" aria-selected="false">Focus Studio</button>
      <button class="tab-btn" type="button" data-tab="compare" role="tab" aria-selected="false">150k vs 35k Compare</button>
      <button id="toggle-server-help-btn" type="button">Local Server Help</button>
    </div>
  </header>

  <div class="disclosure-banner" id="adr-disclosure"></div>

  <div class="file-help-banner" id="file-help-banner">
    <span><strong>Local HTTP server required for module/GLB loading:</strong> run</span>
    <code id="http-server-cmd"></code>
    <span>then open</span>
    <code>http://localhost:8767/studio.html</code>
  </div>

  <!-- GALLERY VIEW -->
  <section class="view-panel active" id="view-gallery" aria-label="Gallery View">
    <div class="toolbar">
      <div class="tool-group">
        <span class="tool-label">LOD</span>
        <button id="all-150k-btn" type="button">All 150k</button>
        <button id="all-35k-btn" type="button">All 35k</button>
      </div>
      <div class="tool-group" id="gallery-mode-buttons"></div>
      <div class="tool-group">
        <label class="slider-inline" for="gallery-light-slider">
          <span class="tool-label">Light</span>
          <input id="gallery-light-slider" type="range" min="0" max="360" step="1" value="0">
          <span id="gallery-light-val" style="min-width: 34px; text-align: right;">0&deg;</span>
        </label>
      </div>
      <div class="tool-group">
        <button id="gallery-autorotate-btn" type="button" aria-pressed="false">Auto-Rotate</button>
        <button id="gallery-reset-cam-btn" type="button">Reset Camera</button>
      </div>
      <div class="tool-group">
        <button id="gallery-export-btn" type="button">Export Ratings JSON</button>
      </div>
    </div>
    <div class="gallery-grid" id="gallery-grid"></div>
  </section>

  <!-- FOCUS STUDIO VIEW -->
  <section class="view-panel" id="view-focus" aria-label="Focus Studio View">
    <div class="focus-layout">
      <div class="focus-viewport">
        <iframe id="focus-viewer-frame" title="Focus Studio 3D Viewport"></iframe>
        <div class="viewport-overlay" id="focus-overlay"></div>
      </div>
      <aside class="focus-sidebar">
        <div class="side-card">
          <h3>Dish &amp; LOD</h3>
          <select id="focus-dish-select" style="width: 100%; margin-bottom: 8px;"></select>
          <div class="btn-grid-2" id="focus-lod-buttons"></div>
        </div>

        <div class="side-card">
          <h3>Diagnostic Mode &amp; Light</h3>
          <div class="btn-grid-2" id="focus-mode-buttons" style="margin-bottom: 10px;"></div>
          <div class="slider-inline" style="width: 100%; margin-bottom: 8px;">
            <label class="tool-label" for="focus-light-slider">Light</label>
            <input id="focus-light-slider" type="range" min="0" max="360" step="1" value="0" style="flex: 1;">
            <span id="focus-light-val" style="min-width: 34px; text-align: right;">0&deg;</span>
          </div>
          <div class="btn-grid-2">
            <button id="focus-autorotate-btn" type="button" aria-pressed="false">Auto-Rotate</button>
            <button id="focus-reset-cam-btn" type="button">Reset Camera</button>
          </div>
        </div>

        <div class="side-card">
          <h3>Automated QA Gate (150k &amp; 35k)</h3>
          <div id="focus-qa-block"></div>
        </div>

        <div class="side-card">
          <h3>Held-Out Eval Scores</h3>
          <div id="focus-eval-block"></div>
        </div>

        <div class="side-card">
          <h3>Reconstruction &amp; Dataset Metadata</h3>
          <div id="focus-meta-block"></div>
        </div>

        <div class="side-card">
          <h3>Diagnostic Images (Click to Enlarge)</h3>
          <div class="thumb-grid" id="focus-thumbs"></div>
        </div>

        <div class="side-card">
          <h3>Human Review Rating (1&ndash;5)</h3>
          <div class="stars" id="focus-star-buttons">
            <button class="star-btn" type="button" data-score="1">1</button>
            <button class="star-btn" type="button" data-score="2">2</button>
            <button class="star-btn" type="button" data-score="3">3</button>
            <button class="star-btn" type="button" data-score="4">4</button>
            <button class="star-btn" type="button" data-score="5">5</button>
          </div>
          <textarea id="focus-rating-note" placeholder="Notes on silhouette, texture fidelity, seams, glazing..."></textarea>
          <div style="margin-top: 8px; display: flex; justify-content: flex-end;">
            <button id="focus-export-btn" type="button">Export Ratings JSON</button>
          </div>
        </div>
      </aside>
    </div>
  </section>

  <!-- COMPARE VIEW -->
  <section class="view-panel" id="view-compare" aria-label="150k vs 35k Compare View">
    <div class="toolbar">
      <div class="tool-group">
        <label class="tool-label" for="compare-dish-select">Dish</label>
        <select id="compare-dish-select"></select>
      </div>
      <div class="tool-group" id="compare-mode-buttons"></div>
      <div class="tool-group">
        <label class="slider-inline" for="compare-light-slider">
          <span class="tool-label">Light</span>
          <input id="compare-light-slider" type="range" min="0" max="360" step="1" value="0">
          <span id="compare-light-val" style="min-width: 34px; text-align: right;">0&deg;</span>
        </label>
      </div>
      <div class="tool-group">
        <button id="compare-autorotate-btn" type="button" aria-pressed="false">Auto-Rotate</button>
        <button id="compare-reset-cam-btn" type="button">Reset Camera</button>
      </div>
    </div>
    <div class="compare-grid">
      <div class="compare-pane">
        <div class="compare-head">
          <strong>High-detail 150k (2048 maps)</strong>
          <div id="compare-150k-badges" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
        </div>
        <div class="compare-iframe-wrap">
          <iframe id="compare-150k-frame" title="High-detail 150k Viewport"></iframe>
        </div>
      </div>
      <div class="compare-pane">
        <div class="compare-head">
          <strong>Mobile 35k (1024 maps)</strong>
          <div id="compare-35k-badges" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
        </div>
        <div class="compare-iframe-wrap">
          <iframe id="compare-35k-frame" title="Mobile 35k Viewport"></iframe>
        </div>
      </div>
    </div>
  </section>
</div>

<div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Diagnostic Image Preview">
  <div class="lightbox-dialog">
    <div class="lightbox-head">
      <strong id="lightbox-title"></strong>
      <button id="lightbox-close-btn" type="button">Close (Esc)</button>
    </div>
    <div class="lightbox-body">
      <img id="lightbox-img" alt="Diagnostic Preview">
    </div>
  </div>
</div>

<script id="studio-manifest" type="application/json">{safe_json}</script>
<script>
(() => {{
  const STORAGE_KEY = 'peekaplate_track2b_studio_ratings_v1';
  const manifest = JSON.parse(document.getElementById('studio-manifest').textContent);
  const dishes = manifest.dishes || [];

  const MODES = [
    ['lit', 'Lit PBR'],
    ['relit', 'Relit +120°'],
    ['clay', 'Clay'],
    ['albedo', 'Albedo'],
    ['roughness', 'Roughness'],
    ['clearcoat', 'Clearcoat'],
    ['normal', 'Normal'],
    ['unlit', 'Unlit'],
  ];

  const state = {{
    tab: 'gallery',
    dishIndex: 0,
    focusLod: '150k',
    galleryLods: Object.fromEntries(dishes.map((d) => [d.dish, d.variants?.['150k']?.glb ? '150k' : '35k'])),
    mode: 'lit',
    lightAz: 0,
    autoRotate: false,
    helpPinned: false,
  }};

  const el = (tag, attrs = {{}}, text = null) => {{
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {{
      if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    }}
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }};

  const fmtNum = (val, digits = 3) => (
    typeof val === 'number' && Number.isFinite(val) ? val.toFixed(digits) : 'n/a'
  );
  const fmtInt = (val) => (
    typeof val === 'number' && Number.isFinite(val) ? val.toLocaleString('en-US') : 'n/a'
  );
  const verdictClass = (v) => (
    v === 'PASS' ? 'badge-PASS' : v === 'WARN' ? 'badge-WARN' : 'badge-FAIL'
  );
  const safeAssetHref = (relPath) => (
    encodeURI('./' + relPath).replaceAll('#', '%23').replaceAll('?', '%3F')
  );
  const viewerUrl = (glbRel) => {{
    const params = new URLSearchParams({{
      glb: glbRel,
      mode: state.mode,
      lightAz: String(state.lightAz),
      orbit: '1',
      hud: '0',
      autoRotate: state.autoRotate ? '1' : '0',
    }});
    return `./viewer.html?${{params.toString()}}`;
  }};

  // Header & Banners
  document.getElementById('studio-title').textContent = manifest.title || 'PeekaPlate Track 2B Studio';
  const adrEl = document.getElementById('adr-disclosure');
  const adrStrong = el('strong', {{}}, 'publication_eligible: false (ADR 0004)');
  const adrBody = el('span', {{}}, ' — ' + (manifest.disclosure || ''));
  adrEl.replaceChildren(adrStrong, adrBody);

  document.getElementById('http-server-cmd').textContent =
    `python3 -m http.server -d ${{manifest.out_dir || '.'}} 8767`;
  const fileHelpBanner = document.getElementById('file-help-banner');
  const syncHelpBanner = () => {{
    const show = location.protocol === 'file:' || state.helpPinned;
    fileHelpBanner.classList.toggle('visible', show);
  }};
  syncHelpBanner();
  document.getElementById('toggle-server-help-btn').addEventListener('click', () => {{
    state.helpPinned = !state.helpPinned;
    syncHelpBanner();
  }});

  // Ratings persistence & export
  const loadRatings = () => {{
    try {{
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{{}}');
    }} catch (_err) {{
      return {{}};
    }}
  }};
  const saveRatings = (obj) => {{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }};
  const exportRatings = () => {{
    const payload = {{
      schema_version: 1,
      publication_eligible: false,
      disclosure: manifest.disclosure,
      exported_at: new Date().toISOString(),
      ratings: loadRatings(),
    }};
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\\n'], {{ type: 'application/json' }});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'track2b_studio_ratings.json';
    a.click();
    URL.revokeObjectURL(url);
  }};
  document.getElementById('gallery-export-btn').addEventListener('click', exportRatings);
  document.getElementById('focus-export-btn').addEventListener('click', exportRatings);

  // Mode buttons builders
  const modeButtonGroups = [];
  const registerModeGroup = (containerId, gridClass = false) => {{
    const container = document.getElementById(containerId);
    const btns = [];
    for (const [modeKey, label] of MODES) {{
      const btn = el('button', {{ type: 'button', 'data-mode': modeKey }}, label);
      btn.addEventListener('click', () => {{
        state.mode = modeKey;
        if (modeKey === 'relit') state.lightAz = 120;
        else if (modeKey === 'lit' && state.lightAz === 120) state.lightAz = 0;
        syncControlsUI();
        broadcastToActiveFrames({{ type: 'food3d:setMode', mode: state.mode, lightAz: state.lightAz }});
      }});
      btns.push(btn);
      container.appendChild(btn);
    }}
    if (gridClass) container.classList.add('btn-grid-2');
    modeButtonGroups.push(btns);
  }};
  registerModeGroup('gallery-mode-buttons');
  registerModeGroup('focus-mode-buttons', true);
  registerModeGroup('compare-mode-buttons');

  // Light sliders & Auto-Rotate & Reset Camera
  const lightSliders = [
    [document.getElementById('gallery-light-slider'), document.getElementById('gallery-light-val')],
    [document.getElementById('focus-light-slider'), document.getElementById('focus-light-val')],
    [document.getElementById('compare-light-slider'), document.getElementById('compare-light-val')],
  ];
  for (const [slider] of lightSliders) {{
    slider.addEventListener('input', () => {{
      state.lightAz = Number(slider.value);
      syncControlsUI();
      broadcastToActiveFrames({{ type: 'food3d:setLightAz', lightAz: state.lightAz }});
    }});
  }}

  const autoRotateBtns = [
    document.getElementById('gallery-autorotate-btn'),
    document.getElementById('focus-autorotate-btn'),
    document.getElementById('compare-autorotate-btn'),
  ];
  for (const btn of autoRotateBtns) {{
    btn.addEventListener('click', () => {{
      state.autoRotate = !state.autoRotate;
      syncControlsUI();
      broadcastToActiveFrames({{ type: 'food3d:setAutoRotate', enabled: state.autoRotate }});
    }});
  }}

  const resetCamBtns = [
    document.getElementById('gallery-reset-cam-btn'),
    document.getElementById('focus-reset-cam-btn'),
    document.getElementById('compare-reset-cam-btn'),
  ];
  for (const btn of resetCamBtns) {{
    btn.addEventListener('click', () => {{
      broadcastToActiveFrames({{ type: 'food3d:resetCamera' }});
    }});
  }}

  const syncControlsUI = () => {{
    for (const group of modeButtonGroups) {{
      for (const btn of group) {{
        btn.classList.toggle('active', btn.dataset.mode === state.mode);
      }}
    }}
    for (const [slider, valEl] of lightSliders) {{
      slider.value = String(state.lightAz);
      valEl.textContent = `${{state.lightAz}}°`;
    }}
    for (const btn of autoRotateBtns) {{
      btn.classList.toggle('active', state.autoRotate);
      btn.setAttribute('aria-pressed', String(state.autoRotate));
    }}
  }};

  const galleryIframes = new Map();
  const focusIframe = document.getElementById('focus-viewer-frame');
  const compare150Iframe = document.getElementById('compare-150k-frame');
  const compare35Iframe = document.getElementById('compare-35k-frame');

  const activeIframes = () => {{
    if (state.tab === 'gallery') return Array.from(galleryIframes.values());
    if (state.tab === 'focus') return [focusIframe];
    if (state.tab === 'compare') return [compare150Iframe, compare35Iframe];
    return [];
  }};

  const broadcastToActiveFrames = (payload) => {{
    for (const frame of activeIframes()) {{
      if (frame && frame.contentWindow) {{
        frame.contentWindow.postMessage(payload, '*');
      }}
    }}
  }};

  const setIframeSource = (iframe, glbRel) => {{
    if (!glbRel) {{
      iframe.removeAttribute('src');
      return;
    }}
    const nextUrl = viewerUrl(glbRel);
    if (iframe.getAttribute('src') !== nextUrl) {{
      iframe.setAttribute('src', nextUrl);
    }}
  }};

  const clearInactiveIframes = () => {{
    if (state.tab !== 'gallery') {{
      for (const iframe of galleryIframes.values()) iframe.setAttribute('src', 'about:blank');
    }}
    if (state.tab !== 'focus') {{
      focusIframe.setAttribute('src', 'about:blank');
    }}
    if (state.tab !== 'compare') {{
      compare150Iframe.setAttribute('src', 'about:blank');
      compare35Iframe.setAttribute('src', 'about:blank');
    }}
  }};

  // Dish selectors for Focus and Compare
  const focusDishSelect = document.getElementById('focus-dish-select');
  const compareDishSelect = document.getElementById('compare-dish-select');
  dishes.forEach((d, idx) => {{
    for (const sel of [focusDishSelect, compareDishSelect]) {{
      const label = `${{d.display_name}} (150k ${{d.qa_150k?.verdict || 'UNKNOWN'}} / 35k ${{d.qa_35k?.verdict || 'UNKNOWN'}})`;
      sel.appendChild(el('option', {{ value: String(idx) }}, label));
    }}
  }});

  const currentDish = () => dishes[state.dishIndex] || null;

  // Build Gallery Cards
  const galleryGrid = document.getElementById('gallery-grid');
  const galleryCardRefs = [];
  dishes.forEach((d, idx) => {{
    const card = el('article', {{ class: 'dish-card' }});
    const head = el('div', {{ class: 'dish-card-head' }});
    const titleWrap = el('div');
    titleWrap.append(
      el('div', {{ class: 'dish-title' }}, d.display_name),
      el('div', {{ class: 'dish-id' }}, d.dish),
    );
    const ds = d.dataset || {{}};
    const regText = ds.registered_frames != null
      ? `${{ds.registered_frames}}/${{ds.target_frames ?? '?'}} reg · ${{ds.sampled_views ?? '?'}} hull`
      : 'views n/a';
    const viewsBadge = el('span', {{ class: 'badge' }}, regText);
    head.append(titleWrap, viewsBadge);

    const viewerBox = el('div', {{ class: 'viewer-box' }});
    const iframe = el('iframe', {{ title: `${{d.display_name}} 3D Viewport` }});
    viewerBox.appendChild(iframe);
    galleryIframes.set(d.dish, iframe);

    const body = el('div', {{ class: 'dish-card-body' }});
    const lodPills = el('div', {{ class: 'lod-pills' }});
    const pill150 = el('button', {{ type: 'button', class: 'lod-pill' }});
    const pill35 = el('button', {{ type: 'button', class: 'lod-pill' }});

    const populatePill = (btn, vKey) => {{
      const v = d.variants?.[vKey];
      btn.disabled = !v || !v.glb;
      const verdict = v?.verdict || 'UNKNOWN';
      btn.replaceChildren(
        el('span', {{}}, `${{vKey}} · ${{v?.mb || 'n/a'}}`),
        el('span', {{ class: `badge ${{verdictClass(verdict)}}` }}, verdict),
      );
    }};
    populatePill(pill150, '150k');
    populatePill(pill35, '35k');

    pill150.addEventListener('click', () => {{
      state.galleryLods[d.dish] = '150k';
      syncGalleryCards();
    }});
    pill35.addEventListener('click', () => {{
      state.galleryLods[d.dish] = '35k';
      syncGalleryCards();
    }});
    lodPills.append(pill150, pill35);

    const statsGrid = el('div', {{ class: 'stats-grid' }});
    const fid = d.qa_150k?.checks?.photo_fidelity || {{}};
    const litEval = d.heldout_eval?.lit || {{}};
    const activeTris = () => {{
      const k = state.galleryLods[d.dish];
      return fmtInt(d.variants?.[k]?.triangles);
    }};
    const addStat = (k, v) => {{
      const row = el('div', {{ class: 'stat-row' }});
      row.append(el('span', {{ class: 'stat-k' }}, k), el('span', {{ class: 'stat-v' }}, v));
      statsGrid.appendChild(row);
      return row.lastChild;
    }};
    addStat('Photo SSIM', fmtNum(fid.ssim, 3));
    addStat('Photo ΔE', fmtNum(fid.delta_e, 1));
    addStat('Held-out Lit SSIM', fmtNum(litEval.fg_ssim?.mean, 3));
    addStat('Held-out Lit ΔE', fmtNum(litEval.fg_delta_e?.mean, 1));
    addStat('Train / Eval', `${{ds.train_frames ?? 'n/a'}} / ${{ds.eval_frames ?? 'n/a'}}`);
    const trisValEl = addStat('Triangles', activeTris());

    const actions = el('div', {{ class: 'card-actions' }});
    const ratingChip = el('span', {{ class: 'badge' }}, 'Unrated');
    const actionBtns = el('div', {{ style: 'display:flex; gap:6px;' }});
    const inspectBtn = el('button', {{ type: 'button', class: 'active' }}, 'Inspect');
    inspectBtn.addEventListener('click', () => {{
      state.dishIndex = idx;
      state.focusLod = state.galleryLods[d.dish] || '150k';
      switchTab('focus');
    }});
    const compareBtn = el('button', {{ type: 'button' }}, 'Compare');
    compareBtn.addEventListener('click', () => {{
      state.dishIndex = idx;
      switchTab('compare');
    }});
    actionBtns.append(compareBtn, inspectBtn);
    actions.append(ratingChip, actionBtns);

    body.append(lodPills, statsGrid, actions);
    card.append(head, viewerBox, body);
    galleryGrid.appendChild(card);
    galleryCardRefs.push({{ dish: d, iframe, pill150, pill35, trisValEl, ratingChip }});
  }});

  const syncGalleryCards = () => {{
    const ratings = loadRatings();
    for (const ref of galleryCardRefs) {{
      const activeKey = state.galleryLods[ref.dish.dish] || '150k';
      ref.pill150.classList.toggle('active', activeKey === '150k');
      ref.pill35.classList.toggle('active', activeKey === '35k');
      ref.trisValEl.textContent = fmtInt(ref.dish.variants?.[activeKey]?.triangles);
      const r = ratings[ref.dish.dish];
      ref.ratingChip.textContent = r?.score ? `Rating: ${{r.score}}/5` : 'Unrated';
      if (state.tab === 'gallery') {{
        setIframeSource(ref.iframe, ref.dish.variants?.[activeKey]?.glb);
      }}
    }}
  }};

  document.getElementById('all-150k-btn').addEventListener('click', () => {{
    for (const d of dishes) {{
      if (d.variants?.['150k']?.glb) state.galleryLods[d.dish] = '150k';
    }}
    syncGalleryCards();
  }});
  document.getElementById('all-35k-btn').addEventListener('click', () => {{
    for (const d of dishes) {{
      if (d.variants?.['35k']?.glb) state.galleryLods[d.dish] = '35k';
    }}
    syncGalleryCards();
  }});

  // Focus Studio rendering
  const focusOverlay = document.getElementById('focus-overlay');
  const focusLodBtnsEl = document.getElementById('focus-lod-buttons');
  const focusQaEl = document.getElementById('focus-qa-block');
  const focusEvalEl = document.getElementById('focus-eval-block');
  const focusMetaEl = document.getElementById('focus-meta-block');
  const focusThumbsEl = document.getElementById('focus-thumbs');
  const focusStarBtns = Array.from(document.querySelectorAll('#focus-star-buttons button'));
  const focusNoteInput = document.getElementById('focus-rating-note');

  const renderMetricRows = (container, rows) => {{
    container.replaceChildren();
    const wrap = el('div', {{ style: 'display:flex; flex-direction:column; gap:4px;' }});
    for (const [k, v, badgeCls] of rows) {{
      const row = el('div', {{ class: 'stat-row' }});
      row.appendChild(el('span', {{ class: 'stat-k' }}, k));
      if (badgeCls) {{
        row.appendChild(el('span', {{ class: `badge ${{badgeCls}}` }}, v));
      }} else {{
        row.appendChild(el('span', {{ class: 'stat-v' }}, v));
      }}
      wrap.appendChild(row);
    }}
    container.appendChild(wrap);
  }};

  const renderFocusStudio = () => {{
    const d = currentDish();
    if (!d) return;
    focusDishSelect.value = String(state.dishIndex);

    const activeVariant = d.variants?.[state.focusLod]?.glb
      ? d.variants[state.focusLod]
      : (d.variants?.['150k']?.glb ? d.variants['150k'] : d.variants?.['35k']);
    if (activeVariant) state.focusLod = activeVariant.key;

    focusOverlay.replaceChildren(
      el('span', {{ class: 'badge' }}, `${{d.display_name}} (${{d.dish}})`),
      el('span', {{ class: 'badge' }}, activeVariant ? `${{activeVariant.short_label}} · ${{activeVariant.mb}}` : 'n/a'),
      el('span', {{ class: 'badge badge-adr' }}, 'publication_eligible: false'),
    );

    focusLodBtnsEl.replaceChildren();
    for (const key of ['150k', '35k']) {{
      const v = d.variants?.[key];
      const btn = el(
        'button',
        {{ type: 'button', class: state.focusLod === key ? 'active' : '' }},
        `${{key}} (${{v?.mb || 'n/a'}}) · ${{v?.verdict || 'UNKNOWN'}}`,
      );
      btn.disabled = !v?.glb;
      btn.addEventListener('click', () => {{
        state.focusLod = key;
        renderFocusStudio();
      }});
      focusLodBtnsEl.appendChild(btn);
    }}

    if (state.tab === 'focus') {{
      setIframeSource(focusIframe, activeVariant?.glb);
    }}

    // QA Block
    const q150 = d.qa_150k || {{}};
    const q35 = d.qa_35k || {{}};
    const c150 = q150.checks || {{}};
    const fid = c150.photo_fidelity || {{}};
    const pbr = c150.pbr_material || {{}};
    const relit = c150.relighting || {{}};
    const qaRows = [
      ['150k QA Verdict', q150.verdict || 'UNKNOWN', verdictClass(q150.verdict)],
      ['35k QA Verdict', q35.verdict || 'UNKNOWN', verdictClass(q35.verdict)],
      ['150k Size / Tris', `${{q150.mb || 'n/a'}} · ${{fmtInt(q150.triangles)}}`],
      ['35k Size / Tris', `${{q35.mb || 'n/a'}} · ${{fmtInt(q35.triangles)}}`],
      ['glTF Budget / Geometry', `${{c150.gltf_budget?.status || 'n/a'}} / ${{c150.geometry?.status || 'n/a'}}`],
      ['PBR Material / Relight', `${{pbr.status || 'n/a'}} / ${{relit.status || 'n/a'}}`],
      ['Photo Fidelity (Flow)', fid.status || 'n/a', fid.status ? verdictClass(fid.status) : null],
      ['Photo Silhouette IoU', fmtNum(fid.silhouette_iou, 4)],
      ['Photo SSIM / Delta E', `${{fmtNum(fid.ssim, 4)}} / ${{fmtNum(fid.delta_e, 2)}}`],
      ['Relit p95 / mean diff', `${{fmtNum(relit.relit_p95_diff, 1)}} / ${{fmtNum(relit.relit_mean_diff, 2)}}`],
      ['Roughness mean / std', `${{fmtNum(pbr.roughness_mean, 3)}} / ${{fmtNum(pbr.roughness_std, 3)}}`],
      ['Clearcoat mean / std', `${{fmtNum(pbr.clearcoat_mean, 3)}} / ${{fmtNum(pbr.clearcoat_std, 3)}}`],
    ];
    renderMetricRows(focusQaEl, qaRows);

    const allReasons = [
      ...(q150.reasons || []).map((r) => `150k: ${{r}}`),
      ...(q35.reasons || []).map((r) => `35k: ${{r}}`),
    ];
    if (allReasons.length) {{
      const ul = el('ul', {{ class: 'reasons-list' }});
      for (const r of allReasons) ul.appendChild(el('li', {{}}, r));
      focusQaEl.appendChild(ul);
    }}
    const allWarnings = [
      ...(q150.warnings || []).map((w) => `150k WARN: ${{w}}`),
      ...(q35.warnings || []).map((w) => `35k WARN: ${{w}}`),
    ];
    if (allWarnings.length) {{
      const ul = el('ul', {{ class: 'warnings-list' }});
      for (const w of allWarnings) ul.appendChild(el('li', {{}}, w));
      focusQaEl.appendChild(ul);
    }}

    // Held-out Eval Scores table
    focusEvalEl.replaceChildren();
    const he = d.heldout_eval || {{}};
    if (he.albedo || he.lit) {{
      const table = el('table', {{ class: 'score-table' }});
      const thead = table.createTHead().insertRow();
      for (const col of ['Metric (Mean)', 'Albedo', 'Lit']) {{
        thead.appendChild(el('th', {{ scope: 'col' }}, col));
      }}
      const tbody = table.createTBody();
      const scoreRows = [
        ['Full PSNR (dB)', 'full_psnr_db', 2],
        ['FG PSNR (dB)', 'fg_psnr_db', 2],
        ['Full SSIM', 'full_ssim', 3],
        ['FG SSIM', 'fg_ssim', 3],
        ['FG Delta E', 'fg_delta_e', 2],
      ];
      for (const [label, key, digits] of scoreRows) {{
        const tr = tbody.insertRow();
        tr.insertCell().textContent = label;
        tr.insertCell().textContent = fmtNum(he.albedo?.[key]?.mean, digits);
        tr.insertCell().textContent = fmtNum(he.lit?.[key]?.mean, digits);
      }}
      focusEvalEl.appendChild(table);
    }} else {{
      focusEvalEl.appendChild(el('div', {{ class: 'stat-k' }}, 'No held-out score_summary.json found.'));
    }}

    // Recon & Dataset Metadata
    const rm = d.recon_meta || {{}};
    const ds = d.dataset || {{}};
    const metaRows = [
      ['Registered / Target', `${{ds.registered_frames ?? 'n/a'}} / ${{ds.target_frames ?? 'n/a'}}`],
      ['Train / Eval frames', `${{ds.train_frames ?? rm.train_views_used ?? 'n/a'}} / ${{ds.eval_frames ?? 'n/a'}}`],
      ['Hull sampled views', String(ds.sampled_views ?? 'n/a')],
      ['Mean reproj err (px)', fmtNum(ds.mean_reprojection_error_px, 4)],
      ['COLMAP 3D points', fmtInt(ds.num_colmap_points3d)],
      ['2DGS splats / steps', `${{fmtInt(rm.final_splats)}} / ${{fmtInt(rm.steps)}}`],
      ['Train / TSDF time', `${{fmtNum(rm.train_seconds, 1)}}s / ${{fmtNum(rm.tsdf_seconds, 1)}}s`],
      ['TSDF / Dense faces', `${{rm.voxel_divisions ?? 'n/a'}} / ${{fmtInt(rm.dense_faces)}}`],
      ['Train FG PSNR (dB)', fmtNum(rm.train_fg_psnr_db, 2)],
      ['Train Silh IoU', fmtNum(rm.train_silhouette_iou, 4)],
      ['Remote GPU', rm.remote_gpu || 'n/a'],
      ['Scale (calibrated)', `${{rm.diameter_cm ?? 'n/a'}} cm (${{String(rm.calibrated ?? false)}})`],
    ];
    renderMetricRows(focusMetaEl, metaRows);

    // Diagnostic Thumbnails
    const assetPairs = [
      ['Reference Photo', d.assets?.reference_photo],
      ['Turntable Sheet', d.assets?.turntable_contact_sheet],
      ['Held-out Lit', d.assets?.heldout_eval_sheet_lit],
      ['Held-out Albedo', d.assets?.heldout_eval_sheet_albedo],
      ['Fidelity Diag', d.assets?.fidelity_diag],
      ['PBR Masks Debug', d.assets?.pbr_masks_debug],
    ].filter(([, rel]) => Boolean(rel));

    focusThumbsEl.replaceChildren();
    for (const [label, rel] of assetPairs) {{
      const href = safeAssetHref(rel);
      const btn = el('button', {{ type: 'button', class: 'thumb-btn' }});
      const img = el('img', {{ src: href, alt: label, loading: 'lazy' }});
      btn.append(img, el('span', {{}}, label));
      btn.addEventListener('click', () => openLightbox(label, href));
      focusThumbsEl.appendChild(btn);
    }}

    // Ratings
    const ratings = loadRatings();
    const curRating = ratings[d.dish] || {{ score: null, note: '' }};
    for (const btn of focusStarBtns) {{
      btn.classList.toggle('active', Number(btn.dataset.score) === curRating.score);
    }}
    focusNoteInput.value = curRating.note || '';
  }};

  focusDishSelect.addEventListener('change', () => {{
    state.dishIndex = Number(focusDishSelect.value);
    renderFocusStudio();
  }});

  for (const btn of focusStarBtns) {{
    btn.addEventListener('click', () => {{
      const d = currentDish();
      if (!d) return;
      const ratings = loadRatings();
      ratings[d.dish] = {{
        score: Number(btn.dataset.score),
        note: focusNoteInput.value,
        updated_at: new Date().toISOString(),
      }};
      saveRatings(ratings);
      renderFocusStudio();
      syncGalleryCards();
    }});
  }}
  focusNoteInput.addEventListener('input', () => {{
    const d = currentDish();
    if (!d) return;
    const ratings = loadRatings();
    const prev = ratings[d.dish] || {{ score: null }};
    ratings[d.dish] = {{
      ...prev,
      note: focusNoteInput.value,
      updated_at: new Date().toISOString(),
    }};
    saveRatings(ratings);
  }});

  // Compare View rendering
  const compare150Badges = document.getElementById('compare-150k-badges');
  const compare35Badges = document.getElementById('compare-35k-badges');
  const renderCompare = () => {{
    const d = currentDish();
    if (!d) return;
    compareDishSelect.value = String(state.dishIndex);
    const v150 = d.variants?.['150k'] || {{}};
    const v35 = d.variants?.['35k'] || {{}};

    compare150Badges.replaceChildren(
      el('span', {{ class: 'badge' }}, v150.mb || 'n/a'),
      el('span', {{ class: 'badge' }}, `${{fmtInt(v150.triangles)}} tris`),
      el('span', {{ class: `badge ${{verdictClass(v150.verdict)}}` }}, v150.verdict || 'UNKNOWN'),
    );
    compare35Badges.replaceChildren(
      el('span', {{ class: 'badge' }}, v35.mb || 'n/a'),
      el('span', {{ class: 'badge' }}, `${{fmtInt(v35.triangles)}} tris`),
      el('span', {{ class: `badge ${{verdictClass(v35.verdict)}}` }}, v35.verdict || 'UNKNOWN'),
    );

    if (state.tab === 'compare') {{
      setIframeSource(compare150Iframe, v150.glb);
      setIframeSource(compare35Iframe, v35.glb);
    }}
  }};

  compareDishSelect.addEventListener('change', () => {{
    state.dishIndex = Number(compareDishSelect.value);
    renderCompare();
  }});

  // Lightbox Modal
  const lightbox = document.getElementById('lightbox');
  const lightboxTitle = document.getElementById('lightbox-title');
  const lightboxImg = document.getElementById('lightbox-img');
  const openLightbox = (titleText, src) => {{
    lightboxTitle.textContent = titleText;
    lightboxImg.setAttribute('src', src);
    lightbox.classList.add('open');
  }};
  const closeLightbox = () => {{
    lightbox.classList.remove('open');
    lightboxImg.removeAttribute('src');
  }};
  document.getElementById('lightbox-close-btn').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (ev) => {{
    if (ev.target === lightbox) closeLightbox();
  }});
  window.addEventListener('keydown', (ev) => {{
    if (ev.key === 'Escape' && lightbox.classList.contains('open')) {{
      closeLightbox();
    }}
  }});

  // Tab Switching
  const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
  const viewPanels = {{
    gallery: document.getElementById('view-gallery'),
    focus: document.getElementById('view-focus'),
    compare: document.getElementById('view-compare'),
  }};
  const switchTab = (nextTab) => {{
    state.tab = nextTab;
    for (const btn of tabBtns) {{
      const active = btn.dataset.tab === nextTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    }}
    for (const [k, panel] of Object.entries(viewPanels)) {{
      panel.classList.toggle('active', k === nextTab);
    }}
    clearInactiveIframes();
    if (nextTab === 'gallery') syncGalleryCards();
    else if (nextTab === 'focus') renderFocusStudio();
    else if (nextTab === 'compare') renderCompare();
  }};
  for (const btn of tabBtns) {{
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }}

  syncControlsUI();
  if (dishes.length > 0) {{
    syncGalleryCards();
  }}
}})();
</script>
</body>
</html>
"""


def build_track2b_studio(
    recon_dir: Path,
    *,
    dishes: list[str] | None = None,
    refs_dir: Path | None = None,
    out_path: Path | None = None,
    title: str = 'PeekaPlate Track 2B Menu Dishes 3D Studio',
) -> Path:
    """Build studio.html and supporting viewer/_three/_refs files for Track 2B outputs."""
    if recon_dir.is_symlink() or not recon_dir.is_dir():
        raise RuntimeError(f'recon_dir must be a real directory: {recon_dir}')
    recon_root = recon_dir.resolve()
    target_out = (out_path if out_path is not None else recon_dir / 'studio.html')
    if target_out.is_symlink():
        raise RuntimeError(f'Output HTML path must not be a symlink: {target_out}')
    out_dir_resolved = target_out.parent.resolve()
    out_dir_resolved.mkdir(parents=True, exist_ok=True)

    dish_names = dishes if dishes else discover_dishes(recon_dir)
    if not dish_names:
        raise RuntimeError(f'No Track 2B dish directories with GLBs found under {recon_dir}')

    _prepare_runtime_support(out_dir_resolved)
    copy_refs_to = out_dir_resolved / '_refs' if refs_dir is not None else None

    dishes_manifest = [
        collect_dish_manifest(
            recon_dir,
            recon_root,
            dish,
            out_dir_resolved=out_dir_resolved,
            refs_dir=refs_dir,
            copy_refs_to=copy_refs_to,
        )
        for dish in dish_names
    ]

    manifest = {
        'schema_version': 1,
        'publication_eligible': False,
        'disclosure': FLOW_DISCLOSURE,
        'title': title,
        'out_dir': str(out_dir_resolved),
        'dishes': dishes_manifest,
    }

    html_doc = render_studio_html(manifest, title)
    target_out.write_text(html_doc, encoding='utf-8')
    return target_out


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Build Track 2B Menu Dishes 3D Studio HTML.')
    parser.add_argument('recon_dir', type=Path, help='Track 2B reconstruction root directory.')
    parser.add_argument('--dishes', nargs='*', default=None, help='Optional explicit dish directory names.')
    parser.add_argument('--refs-dir', type=Path, default=None, help='Optional reference photos directory.')
    parser.add_argument('--out', type=Path, default=None, help='Output studio HTML path (default: <recon_dir>/studio.html).')
    parser.add_argument(
        '--title',
        type=str,
        default='PeekaPlate Track 2B Menu Dishes 3D Studio',
        help='Studio page title.',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        out_html = build_track2b_studio(
            args.recon_dir,
            dishes=args.dishes,
            refs_dir=args.refs_dir,
            out_path=args.out,
            title=args.title,
        )
    except (RuntimeError, ValueError, OSError) as exc:
        print(f'[build_track2b_studio] ERROR: {exc}')
        return 1
    print(json.dumps({'publication_eligible': False, 'studio_html': str(out_html.resolve())}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
