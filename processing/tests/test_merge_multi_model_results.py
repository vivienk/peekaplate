"""Offline checks for merging private multi-model 3D result directories into one studio."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from peekaplate_processing.dish_3d_studio import DEFAULT_THREE_CDN_BASE, build_studio_payload


_SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'merge_multi_model_results.py'
_spec = importlib.util.spec_from_file_location('merge_multi_model_results', _SCRIPT)
module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = module
_spec.loader.exec_module(module)

# Model slug -> (filename stem, studio backend label, appearance, device); studio ordering matters.
MODELS = {
    'moge2-relief': ('moge2_relief', 'MoGe-2 Relief + Ceramic Plate', 'captured_photo_uv_pbr', 'cpu-relief-prior'),
    'trellis2-4b': ('trellis2_4b', 'TRELLIS.2-4B', 'pbr_texture', 'cuda:0+cuda:1'),
    'triposg': ('triposg', 'TripoSG + Photo PBR', 'pbr_texture', 'cuda:0'),
    'hunyuan3d2': ('hunyuan3d2', 'Hunyuan3D-2 / 2.1', 'pbr_texture', 'cuda:1'),
    'hi3dgen': ('hi3dgen', 'Hi3DGen Normal-Bridge', 'pbr_texture', 'cuda:0'),
}
LEGACY = (('triposr', 'triposr', 'TripoSR'), ('hunyuan3d-2mini', 'hunyuan3d_2mini', 'Hunyuan3D-2mini'))
LABELS = ('01_pizza', '02_tteokbokki')


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_inputs(source: Path, label: str, *, metadata: str, image_source: str, title: str) -> dict:
    dish = source / label
    dish.mkdir(parents=True, exist_ok=True)
    image_path = dish / 'input_image.png'
    cutout_path = dish / 'cutout_rgba.png'
    Image.new('RGB', (64, 48), (190, 120, 60)).save(image_path)
    Image.new('RGBA', (64, 48), (190, 120, 60, 255)).save(cutout_path)
    source_sha = _sha(image_path.read_bytes())
    job_manifest = {
        'job_id': f'job-{label}',
        'dish_label': label,
        'publication_eligible': False,
        'source_sha256': source_sha,
    }
    job_path = dish / 'job_manifest.json'
    job_path.write_text(json.dumps(job_manifest), encoding='utf-8')
    entry = {
        'label': label,
        'image_status': 'success',
        'image_source': image_source,
        'size': [64, 48],
        'source_sha256': source_sha,
        # A digest belonging to some other tree: the merge must measure the copy, not inherit it.
        'input_image_sha256': '0' * 64,
        'artifacts': [
            {'path': f'{label}/{path.name}', 'bytes': path.stat().st_size}
            for path in (image_path, cutout_path, job_path)
        ],
    }
    if metadata == 'full':
        entry.update(
            title=title,
            tier='hero',
            page=11,
            cutout_metrics={
                'cutout_model': 'birefnet-general-lite',
                'plate_preserved': True,
                'plate_method': 'grounding_dino_sam',
                'food_coverage_pct': 57.52,
            },
        )
    elif metadata == 'nulls':
        # Later Kaggle runs serialise absent dish metadata as null/empty; it must not erase
        # earlier rows.
        entry.update(title=None, tier=None, page=None, cutout_metrics={})
    return entry


def _write_run(source: Path, label: str, slug: str, status: str, *, tag: str,
               mobile_glb_path: bool = False) -> dict:
    dish = source / label
    stem, backend, appearance, device = MODELS[slug]
    artifacts: list[str] = []
    if status == 'success':
        raw = dish / f'{stem}.glb'
        raw.write_bytes(b'glTF-' + tag.encode())
        artifacts.append(raw.name)
        mob = dish / f'{stem}_mobile.glb'
        mob.write_bytes(b'glTF-mobile-' + tag.encode())
        artifacts.append(mob.name)
        preview = dish / f'{stem}_preview.png'
        Image.new('RGB', (32, 24), (70, 90, 110)).save(preview)
        artifacts.append(preview.name)
        if slug == 'trellis2-4b':
            hf_modes = dish / f'{stem}_hf_modes.png'
            Image.new('RGB', (32, 24), (110, 70, 50)).save(hf_modes)
            artifacts.append(hf_modes.name)
    record = {
        'input_label': label,
        'image_source': 'user-uploaded-dataset',
        'backend': backend,
        'appearance': appearance,
        'device': device,
        'status': status,
        'metrics': {
            'vertices': 30000, 'faces': 60000, 'bytes': 4096,
            'has_texture': slug in ('trellis2-4b', 'triposg', 'hunyuan3d2'),
        },
        'mobile_metrics': {'vertices': 9000, 'faces': 18000, 'bytes': 2048},
        'artifacts': [{'path': f'{label}/{name}'} for name in artifacts],
    }
    if status != 'success':
        record['error'] = f'{backend} fixture failure'
        record.pop('mobile_metrics')
    elif mobile_glb_path:
        record['mobile_glb_path'] = f'{label}/{stem}_mobile.glb'
    return record


def _build_source(
    root: Path,
    name: str,
    *,
    metadata: str,
    tag: str,
    image_source: str,
    statuses: dict[str, str],
    titles: dict[str, str],
    with_legacy: bool = True,
    failed_label: str | None = None,
) -> Path:
    source = root / name
    source.mkdir(parents=True, exist_ok=True)
    inputs: dict[str, dict] = {}
    runs_3d: dict[str, dict] = {}
    for label in LABELS:
        inputs[label] = _write_inputs(
            source, label, metadata=metadata, image_source=image_source, title=titles[label],
        )
        for slug, status in statuses.items():
            runs_3d[f'{label}/{slug}'] = _write_run(
                source, label, slug, status, tag=tag,
                mobile_glb_path=(metadata == 'full' and slug == 'moge2-relief'),
            )
        if with_legacy:
            for slug, stem, backend in LEGACY:
                legacy_glb = source / label / f'{stem}.glb'
                legacy_glb.write_bytes(b'glTF-legacy')
                runs_3d[f'{label}/{slug}'] = {
                    'input_label': label,
                    'backend': backend,
                    'appearance': 'vertex_color',
                    'status': 'success',
                    'artifacts': [{'path': f'{label}/{stem}.glb'}],
                }
    if failed_label:
        dish = source / failed_label
        dish.mkdir(parents=True, exist_ok=True)
        (dish / 'job_manifest.json').write_text(
            json.dumps({'job_id': f'job-{failed_label}', 'publication_eligible': False}),
            encoding='utf-8',
        )
        inputs[failed_label] = {
            'label': failed_label,
            'image_status': 'failed',
            'image_error': 'OpenRouter HTTP 429.',
            'artifacts': [],
        }
    (source / 'manifest.json').write_text(json.dumps({
        'schema_version': 3,
        'demo_label': 'Private single-photo 3D demo (not published T0/T1/T2 menu evidence)',
        'plate_preservation_mode': 'preserve_plate',
        'publication_eligible': False,
        'inputs': inputs,
        'runs_3d': runs_3d,
        'extras': [],
    }, indent=2), encoding='utf-8')
    return source


NOTEBOOK_STATUSES = {
    'moge2-relief': 'success',
    'trellis2-4b': 'success',
    'triposg': 'success',
    'hunyuan3d2': 'success',
    'hi3dgen': 'failed',  # superseded by the later Kaggle success
}
KAGGLE_STATUSES = {
    'moge2-relief': 'failed',  # must never hide the earlier notebook success
    'trellis2-4b': 'success',  # later success replaces the earlier run
    'triposg': 'skipped',  # a later non-success keeps the earlier success
    'hunyuan3d2': 'success',
    'hi3dgen': 'success',  # later success replaces the earlier failure
}
TITLES = {'01_pizza': 'Pizza', '02_tteokbokki': 'Tteokbokki'}


def _build_sources(root: Path) -> tuple[Path, Path]:
    early = _build_source(
        root, 'notebook-results', metadata='full', tag='notebook',
        image_source='user-uploaded-dataset-notebook', statuses=NOTEBOOK_STATUSES, titles=TITLES,
    )
    late = _build_source(
        root, 'kaggle-results', metadata='nulls', tag='kaggle',
        image_source='user-uploaded-dataset-kaggle', statuses=KAGGLE_STATUSES, titles=TITLES,
        failed_label='03_broken_input',
    )
    return early, late


class MergeMultiModelResultsTest(unittest.TestCase):
    def test_merges_five_model_studio_preserving_metadata_and_legacy_filtering(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            output = root / 'merged'
            manifest_path, viewer_path, studio_path = module.merge_results_directories([early, late], output)
            self.assertEqual(manifest_path, output / 'manifest.json')
            self.assertEqual(viewer_path, output / 'comparison_viewer.html')
            self.assertEqual(studio_path, output / 'studio' / 'index.html')
            for path in (manifest_path, viewer_path, studio_path):
                self.assertTrue(path.is_file(), path)
            for label in LABELS:
                self.assertTrue((output / 'studio' / 'dishes' / f'{label}.html').is_file())
            self.assertFalse((output / 'interactive_3d_studio.html').exists())

            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            self.assertEqual(manifest['schema_version'], 3)
            self.assertIs(manifest['publication_eligible'], False)
            self.assertEqual(manifest['plate_preservation_mode'], 'preserve_plate')
            self.assertEqual(manifest['merged_source_count'], 2)

            dish = manifest['inputs']['01_pizza']
            # Later Kaggle runs omitted (null/empty) the dish metadata; the notebook values survive.
            self.assertEqual((dish['title'], dish['tier'], dish['page']), ('Pizza', 'hero', 11))
            self.assertEqual(dish['cutout_metrics']['plate_method'], 'grounding_dino_sam')
            self.assertEqual(dish['cutout_metrics']['cutout_model'], 'birefnet-general-lite')
            # Non-null values still follow later-source precedence.
            self.assertEqual(dish['image_source'], 'user-uploaded-dataset-kaggle')
            self.assertEqual(dish['size'], [64, 48])
            self.assertEqual(
                {Path(art['path']).name for art in dish['artifacts']},
                {'input_image.png', 'cutout_rgba.png', 'job_manifest.json'},
            )
            for art in dish['artifacts']:
                self.assertEqual(art['path'], f'01_pizza/{Path(art["path"]).name}')
                self.assertEqual(art['sha256'], _sha((output / art['path']).read_bytes()))
                self.assertEqual(art['bytes'], (output / art['path']).stat().st_size)
            # Staged bytes are measured; a foreign declared digest is never inherited.
            self.assertEqual(
                dish['input_image_sha256'], _sha((output / '01_pizza/input_image.png').read_bytes()),
            )
            self.assertNotEqual(dish['input_image_sha256'], '0' * 64)

            broken = manifest['inputs']['03_broken_input']
            self.assertEqual(broken['image_status'], 'failed')
            self.assertEqual(broken['image_error'], 'OpenRouter HTTP 429.')
            self.assertNotIn('artifacts', broken)

            runs_3d = manifest['runs_3d']
            for label in LABELS:
                slugs = sorted(key.split('/', 1)[1] for key in runs_3d if key.startswith(f'{label}/'))
                self.assertEqual(slugs, sorted(MODELS), label)
            for legacy_slug, legacy_stem, _ in LEGACY:
                self.assertNotIn(legacy_slug, {key.split('/', 1)[1] for key in runs_3d})
                self.assertFalse((output / '01_pizza' / f'{legacy_stem}.glb').exists())

            # Failed-over-success: the earlier notebook MoGe-2 run survives the Kaggle failure.
            moge = runs_3d['01_pizza/moge2-relief']
            self.assertEqual(moge['status'], 'success')
            raw = next(art for art in moge['artifacts'] if art['path'].endswith('moge2_relief.glb'))
            self.assertEqual(raw['path'], '01_pizza/moge2_relief.glb')
            self.assertEqual((output / raw['path']).read_bytes(), b'glTF-notebook')
            self.assertEqual(raw['sha256'], _sha(b'glTF-notebook'))
            self.assertEqual(moge['mobile_glb_path'], '01_pizza/moge2_relief_mobile.glb')
            self.assertTrue((output / moge['mobile_glb_path']).is_file())

            # Success-over-success: the later Kaggle TRELLIS run wins.
            self.assertEqual(
                (output / '01_pizza/trellis2_4b.glb').read_bytes(), b'glTF-kaggle',
            )
            self.assertEqual(
                {Path(art['path']).name for art in runs_3d['01_pizza/trellis2-4b']['artifacts']},
                {'trellis2_4b.glb', 'trellis2_4b_mobile.glb', 'trellis2_4b_preview.png', 'trellis2_4b_hf_modes.png'},
            )
            # A later non-success ("skipped") never replaces an earlier success.
            self.assertEqual(runs_3d['01_pizza/triposg']['status'], 'success')
            self.assertEqual((output / '01_pizza/triposg.glb').read_bytes(), b'glTF-notebook')
            # Failure-over-success: the later Kaggle success replaces the earlier failure.
            self.assertEqual(runs_3d['01_pizza/hi3dgen']['status'], 'success')
            self.assertEqual((output / '01_pizza/hi3dgen.glb').read_bytes(), b'glTF-kaggle')

            for run_key, record in runs_3d.items():
                self.assertEqual(record['input_label'], run_key.split('/', 1)[0])
                self.assertIsInstance(record['artifacts'], list)
                for art in record['artifacts']:
                    self.assertEqual(art['sha256'], _sha((output / art['path']).read_bytes()))
                    path = Path(art['path'])
                    self.assertFalse(path.is_absolute())
                    self.assertNotIn('..', path.parts)
                    self.assertTrue((output / path).is_file(), art['path'])
                if 'mobile_glb_path' in record:
                    self.assertFalse(Path(record['mobile_glb_path']).is_absolute())
                    self.assertTrue((output / record['mobile_glb_path']).is_file())

            payload = build_studio_payload(output)
            self.assertEqual([d['label'] for d in payload['dishes']], list(LABELS))
            pizza = payload['dishes'][0]
            self.assertEqual((pizza['title'], pizza['tier'], pizza['page']), ('Pizza', 'hero', 11))
            statuses = {m['slug']: m['status'] for m in pizza['model_statuses']}
            self.assertEqual(statuses.pop('trellis2-4b-hires'), 'not_run')
            self.assertEqual(list(statuses), list(MODELS))
            self.assertEqual(list(statuses.values()), ['success'] * len(MODELS))
            self.assertEqual([r['slug'] for r in pizza['runs']], list(MODELS))
            for run in pizza['runs']:
                self.assertTrue(run['raw']['path'].startswith('01_pizza/'))
                self.assertTrue(run['mobile']['path'].startswith('01_pizza/'))

            viewer_html = viewer_path.read_text(encoding='utf-8')
            self.assertIn('publication_eligible=false', viewer_html)
            self.assertIn('GLTFLoader.js', viewer_html)
            self.assertIn('data-view="trellis2-4b"', viewer_html)
            self.assertIn('01_pizza/moge2_relief.glb', viewer_html)
            self.assertIn('01_pizza/trellis2_4b.glb', viewer_html)
            for legacy_token in ('01_pizza/triposr.glb', '01_pizza/hunyuan3d_2mini.glb', 'TripoSR (Color)'):
                self.assertNotIn(legacy_token, viewer_html)

            studio_html = studio_path.read_text(encoding='utf-8')
            self.assertIn('PeekaPlate dish-to-3D studio — index', studio_html)
            self.assertIn('href="dishes/01_pizza.html"', studio_html)
            self.assertIn('href="dishes/02_tteokbokki.html"', studio_html)
            self.assertNotIn('importmap', studio_html)
            self.assertNotIn('base64', studio_html)
            pizza_html = (output / 'studio' / 'dishes' / '01_pizza.html').read_text(encoding='utf-8')
            self.assertIn(DEFAULT_THREE_CDN_BASE, pizza_html)
            self.assertIn('data-shader="clay"', pizza_html)

    def test_three_base_url_override_and_missing_source_directories_skipped(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            output = root / 'merged-cdn'
            _, viewer_path, studio_path = module.merge_results_directories(
                [root / 'does-not-exist', early, late], output, three_base_url='/vendor/three',
            )
            manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['merged_source_count'], 2)
            viewer_html = viewer_path.read_text(encoding='utf-8')
            self.assertIn('/vendor/three/build/three.module.js', viewer_html)
            self.assertNotIn('cdn.jsdelivr.net/npm/three', viewer_html)
            pizza_html = (output / 'studio' / 'dishes' / '01_pizza.html').read_text(encoding='utf-8')
            self.assertIn('/vendor/three/build/three.module.js', pizza_html)
            self.assertNotIn('cdn.jsdelivr.net/npm/three', pizza_html)
            self.assertFalse((output / 'interactive_3d_studio.html').exists())

    def test_rejects_publication_eligible_true_on_manifest_or_dish_job_manifest(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = _build_source(
                root, 'source', metadata='full', tag='x', image_source='user-uploaded-dataset',
                statuses=KAGGLE_STATUSES, titles=TITLES,
            )
            manifest_path = source / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            manifest['publication_eligible'] = True
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible'):
                module.merge_results_directories([source], root / 'out-manifest')

            manifest['publication_eligible'] = False
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            job_manifest_path = source / '01_pizza' / 'job_manifest.json'
            job_manifest = json.loads(job_manifest_path.read_text(encoding='utf-8'))
            job_manifest['publication_eligible'] = True
            job_manifest_path.write_text(json.dumps(job_manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible'):
                module.merge_results_directories([source], root / 'out-job-manifest')

    def test_rejects_traversal_and_absolute_artifact_paths(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = _build_source(
                root, 'source', metadata='full', tag='x', image_source='user-uploaded-dataset',
                statuses=KAGGLE_STATUSES, titles=TITLES,
            )
            (root / 'evil.png').write_bytes(b'not an image')
            manifest_path = source / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))

            for label, bad_path in (
                ('input traversal', '../evil.png'),
                ('input absolute', str(root / 'evil.png')),
            ):
                with self.subTest(label=label):
                    broken = json.loads(json.dumps(manifest))
                    broken['inputs']['01_pizza']['artifacts'][0]['path'] = bad_path
                    manifest_path.write_text(json.dumps(broken), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'Invalid inputs'):
                        module.merge_results_directories([source], root / f'out-{label.replace(" ", "-")}')

            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            for label, bad_path in (
                ('run traversal', '../../etc/passwd'),
                ('run absolute', '/etc/passwd'),
                ('mobile traversal', '../trellis2_4b_mobile.glb'),
            ):
                with self.subTest(label=label):
                    broken = json.loads(json.dumps(manifest))
                    run = broken['runs_3d']['01_pizza/trellis2-4b']
                    if label.startswith('mobile'):
                        run['mobile_glb_path'] = bad_path
                    else:
                        run['artifacts'][0]['path'] = bad_path
                    manifest_path.write_text(json.dumps(broken), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'Invalid runs_3d'):
                        module.merge_results_directories([source], root / f'out-{label.replace(" ", "-")}')

    def test_cli_requires_a_source_and_merges_repeated_directories(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            output = root / 'cli-merged'
            with self.assertRaises(SystemExit) as raised:
                module.main([])
            self.assertEqual(raised.exception.code, 2)

            self.assertEqual(
                module.main(['--source', str(early), '--source', str(late), '--output-dir', str(output)]),
                0,
            )
            for name in ('manifest.json', 'comparison_viewer.html'):
                self.assertTrue((output / name).is_file(), name)
            self.assertTrue((output / 'studio' / 'index.html').is_file())
            for label in LABELS:
                self.assertTrue((output / 'studio' / 'dishes' / f'{label}.html').is_file())
            self.assertFalse((output / 'interactive_3d_studio.html').exists())
            manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['merged_source_count'], 2)
            self.assertIs(manifest['publication_eligible'], False)

    def test_in_place_merge_reuses_existing_output_dir_without_same_file_error(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            module.merge_results_directories([early, late], early)
            manifest = json.loads((early / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['merged_source_count'], 2)
            self.assertIs(manifest['publication_eligible'], False)
            self.assertTrue((early / 'comparison_viewer.html').is_file())
            self.assertTrue((early / 'studio' / 'index.html').is_file())
            self.assertFalse((early / 'interactive_3d_studio.html').exists())

    def test_legacy_single_file_written_only_when_requested(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            output = root / 'legacy-merged'
            _, _, studio_path = module.merge_results_directories(
                [early, late], output, legacy_single_file=True,
            )
            self.assertTrue(studio_path.is_file())
            self.assertTrue((output / 'interactive_3d_studio.html').is_file())
            legacy_html = (output / 'interactive_3d_studio.html').read_text(encoding='utf-8')
            self.assertIn('Standalone Offline HTML', legacy_html)

            # Also check CLI flag
            output_cli = root / 'cli-legacy'
            self.assertEqual(
                module.main([
                    '--source', str(early), '--source', str(late),
                    '--output-dir', str(output_cli), '--legacy-single-file',
                ]),
                0,
            )
            self.assertTrue((output_cli / 'interactive_3d_studio.html').is_file())
            self.assertTrue((output_cli / 'studio' / 'index.html').is_file())

    def test_menu_manifest_passthrough(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            menu_dir = root / 'menu'
            menu_dir.mkdir()
            menu_file = menu_dir / 'dishes_manifest.json'
            menu_file.write_text(json.dumps({
                'schema_version': 1,
                'dishes': [
                    {'label': '01_pizza', 'title': 'Pizza'},
                    {'label': '02_tteokbokki', 'title': 'Tteokbokki'},
                    {'label': '03_pending_soup', 'title': 'Pending Soup'},
                ],
            }), encoding='utf-8')

            output = root / 'menu-merged'
            module.merge_results_directories(
                [early, late], output, menu_manifest=menu_file,
            )
            index_html = (output / 'studio' / 'index.html').read_text(encoding='utf-8')
            self.assertIn('data-dish="03_pending_soup"', index_html)
            self.assertIn('03_pending_soup/trellis2-4b', index_html)

            # Also check CLI flag
            output_cli = root / 'cli-menu'
            self.assertEqual(
                module.main([
                    '--source', str(early), '--source', str(late),
                    '--output-dir', str(output_cli), '--menu-manifest', str(menu_file),
                ]),
                0,
            )
            index_cli = (output_cli / 'studio' / 'index.html').read_text(encoding='utf-8')
            self.assertIn('data-dish="03_pending_soup"', index_cli)


if __name__ == '__main__':
    unittest.main()