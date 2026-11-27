"""Offline checks for the self-contained dish-to-3D model report page."""

from __future__ import annotations

import hashlib
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import re
import struct
import sys
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image


_SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'build_dish_model_report.py'
_spec = importlib.util.spec_from_file_location('build_dish_model_report', _SCRIPT)
module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = module
_spec.loader.exec_module(module)

LABELS = ('01_pizza', '02_tteokbokki')
TITLES = {'01_pizza': 'Pizza', '02_tteokbokki': 'Tteokbokki'}
STEMS = {
    'moge2-relief': 'moge2_relief',
    'trellis2-4b': 'trellis2_4b',
    'triposg': 'triposg',
    'hunyuan3d2': 'hunyuan3d2',
    'hunyuan3d21': 'hunyuan3d21',
    'hi3dgen': 'hi3dgen',
}
BACKENDS = {
    'moge2-relief': 'MoGe-2 Relief + Ceramic Plate',
    'trellis2-4b': 'TRELLIS.2-4B',
    'triposg': 'TripoSG + Photo PBR',
    'hunyuan3d2': 'Hunyuan3D-2 / 2.1',
    'hunyuan3d21': 'Hunyuan3D-2.1',
    'hi3dgen': 'Hi3DGen Normal-Bridge',
}

#: Recorded reasons, one per non-success bucket; the dtype string also probes HTML escaping.
REASONS = {
    'hf': 'Skipped (missing_or_unauthorized_hf_token)',
    'dtype': 'RuntimeError: mat1 and mat2 must have the same dtype <script>alert(1)</script>',
    'late': 'late failure must never hide an earlier success',
    'spconv': 'spconv_unavailable: no spconv build matches cu128',
}

#: (source, label, slug, status, reason) — earliest source first.
FIXTURE_RUNS = (
    ('kamodels-early', '01_pizza', 'moge2-relief', 'success', None),
    ('kamodels-early', '01_pizza', 'trellis2-4b', 'skipped', REASONS['hf']),
    ('kamodels-early', '01_pizza', 'triposg', 'failed', REASONS['dtype']),
    ('kamodels-early', '02_tteokbokki', 'moge2-relief', 'success', None),
    ('kamodels-early', '02_tteokbokki', 'trellis2-4b', 'skipped', REASONS['hf']),
    ('kamodels-early', '02_tteokbokki', 'triposg', 'failed', REASONS['dtype']),
    ('kamodels-early', '02_tteokbokki', 'hunyuan3d2', 'success', None),
    # A later failure must not replace the earlier success; hi3dgen is only skipped, only later.
    ('kamodels-late', '01_pizza', 'moge2-relief', 'failed', REASONS['late']),
    ('kamodels-late', '01_pizza', 'hi3dgen', 'skipped', REASONS['spconv']),
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _png_bytes(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def _glb_bytes(label: str, slug: str) -> bytes:
    """A real, structurally valid closed-cube GLB with one 6x4 embedded PNG.

    The report decodes the bytes themselves, so the fixture must be a genuine GLB: a fake
    ``b'glTF-...'`` string would only ever render *quality not measured* and prove nothing.
    """
    positions = np.array([
        [-1.0, -1.0, -1.0], [1.0, -1.0, -1.0], [1.0, 1.0, -1.0], [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0], [1.0, -1.0, 1.0], [1.0, 1.0, 1.0], [-1.0, 1.0, 1.0],
    ], dtype=np.float32)
    indices = np.array([
        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
        [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
    ], dtype=np.uint32)
    normals = np.tile(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), (len(positions), 1))
    uvs = np.tile(np.array([[0.5, 0.5]], dtype=np.float32), (len(positions), 1))
    texture = _png_bytes(Image.new('RGB', (6, 4), (196, 110, 58)))

    binary_parts: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes) -> int:
        offset = sum(len(part) for part in binary_parts)
        binary_parts.append(data + b'\x00' * ((-len(data)) % 4))
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)})
        return len(views) - 1

    def add_accessor(array: np.ndarray, dtype: str, kind: str, component_type: int) -> int:
        accessors.append({'bufferView': add_view(np.ascontiguousarray(array, dtype=dtype).tobytes()),
                          'componentType': component_type, 'count': int(len(array)), 'type': kind})
        return len(accessors) - 1

    attributes = {
        'POSITION': add_accessor(positions, '<f4', 'VEC3', 5126),
        'NORMAL': add_accessor(normals, '<f4', 'VEC3', 5126),
        'TEXCOORD_0': add_accessor(uvs, '<f4', 'VEC2', 5126),
    }
    primitive = {'attributes': attributes, 'mode': 4,
                 'indices': add_accessor(indices.reshape(-1), '<u4', 'SCALAR', 5125)}
    doc: dict = {
        'asset': {'version': '2.0', 'generator': f'peekaplate-report-{label}-{slug}'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': [primitive]}],
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': 0}],
        'images': [{'bufferView': add_view(texture), 'mimeType': 'image/png'}],
        'samplers': [{}],
        'textures': [{'sampler': 0, 'source': 0}],
        'materials': [{'name': 'captured',
                       'pbrMetallicRoughness': {'baseColorTexture': {'index': 0},
                                                'metallicFactor': 0.0, 'roughnessFactor': 0.5}}],
    }
    binary = b''.join(binary_parts)
    doc['buffers'][0]['byteLength'] = len(binary)
    json_bytes = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    json_bytes += b' ' * ((-len(json_bytes)) % 4)
    binary += b'\x00' * ((-len(binary)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    return (struct.pack('<4sII', b'glTF', 2, total)
            + struct.pack('<II', len(json_bytes), module.verify.GLB_JSON_CHUNK) + json_bytes
            + struct.pack('<II', len(binary), module.verify.GLB_BIN_CHUNK) + binary)


def _write_dish(source: Path, label: str) -> dict:
    dish = source / label
    dish.mkdir(parents=True, exist_ok=True)
    image = dish / 'input_image.png'
    image.write_bytes(f'input-image-{label}'.encode())
    digest = _sha(image.read_bytes())
    (dish / 'job_manifest.json').write_text(
        json.dumps({
            'job_id': f'job-{label}',
            'dish_label': label,
            'publication_eligible': False,
            'source_sha256': digest,
            'pinned_revisions': {'dinov3': 'ea8dc2863c51be0a264bab82070e3e8836b02d51'},
        }),
        encoding='utf-8',
    )
    return {
        'label': label,
        'title': TITLES[label],
        'dataset_slug': 'peekaplate-dish-test-photos',
        'image_status': 'success',
        'image_source': 'user-uploaded-dataset',
        'source_sha256': digest,
        'input_image_sha256': digest,
        'artifacts': [{'path': f'{label}/{image.name}', 'sha256': digest}],
    }


def _write_run(source: Path, label: str, slug: str, status: str, reason: str | None) -> dict:
    dish = source / label
    dish.mkdir(parents=True, exist_ok=True)
    stem = STEMS[slug]
    record: dict = {
        'input_label': label,
        'backend': BACKENDS[slug],
        'status': status,
        'artifacts': [],
    }
    if status == 'success':
        glb = dish / f'{stem}.glb'
        glb.write_bytes(_glb_bytes(label, slug))
        mobile = dish / f'{stem}_mobile.glb'
        mobile.write_bytes(f'glTF-mobile-{label}-{slug}'.encode())
        record.update(
            metrics={'faces': 60000, 'bytes': glb.stat().st_size, 'has_texture': True},
            mobile_status='available',
            artifacts=[
                {'path': f'{label}/{glb.name}', 'bytes': glb.stat().st_size,
                 'sha256': _sha(glb.read_bytes())},
                {'path': f'{label}/{mobile.name}', 'bytes': mobile.stat().st_size},
            ],
        )
    else:
        record['error'] = reason
    return record


def _build_sources(root: Path) -> tuple[Path, Path]:
    directories = {name: root / name for name in ('kamodels-early', 'kamodels-late')}
    for source in directories.values():
        source.mkdir(parents=True, exist_ok=True)
    inputs: dict[str, dict] = {name: {} for name in directories}
    runs: dict[str, dict] = {name: {} for name in directories}
    for name, label, slug, status, reason in FIXTURE_RUNS:
        source = directories[name]
        if label not in inputs[name]:
            inputs[name][label] = _write_dish(source, label)
        runs[name][f'{label}/{slug}'] = _write_run(source, label, slug, status, reason)

    for name, source in directories.items():
        manifest = {
            'schema_version': 3,
            'purpose': 'private single-photo 3D demo & Docker worker blueprint',
            'demo_label': 'Private single-photo 3D demo (not published T0/T1/T2 menu evidence)',
            'plate_preservation_mode': 'preserve_plate',
            'publication_eligible': False,
            'inputs': inputs[name],
            'runs_3d': runs[name],
            'extras': [],
        }
        if name == 'kamodels-early':
            manifest['source_revisions'] = {
                'trellis_model': 'af44b45f2e35a493886929c6d786e563ec68364d',
                'moge2': 'cb0e8bbd6b1e243589717c78e750b1ba4c093acf',
                'input_01_pizza': 'user-uploaded-dataset',
            }
            manifest['generated_at'] = '2026-11-23T01:46:00Z'
        (source / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return directories['kamodels-early'], directories['kamodels-late']


class BuildDishModelReportTest(unittest.TestCase):
    def test_matrix_has_five_model_columns_once_each(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            out, data = module.build_report([early, late], root / 'out' / 'report.html')
            page = out.read_text(encoding='utf-8')
            self.assertEqual(page.count('class="model-head"'), len(module.MODEL_COLUMNS))
            for slug, label in module.MODEL_COLUMNS:
                with self.subTest(slug=slug):
                    self.assertEqual(page.count(f'id="col-{slug}"'), 1)
                    self.assertIn(f'<th class="model-head" id="col-{slug}">{label}</th>', page)
            self.assertEqual([dish['label'] for dish in data['dishes']], list(LABELS))
            self.assertEqual(len(data['dishes']), len(LABELS))

    def test_every_status_and_reason_renders_escaped_and_verbatim(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            out, data = module.build_report([early, late], root / 'report.html')
            page = out.read_text(encoding='utf-8')
            self.assertEqual(page.count('class="cell success"'), 3)
            self.assertEqual(page.count('class="cell skipped"'), 3)
            self.assertEqual(page.count('class="cell failed"'), 2)
            self.assertEqual(page.count('class="cell not_run"'), 10)
            for reason in (REASONS['hf'], REASONS['dtype'], REASONS['spconv']):
                self.assertIn(module._e(reason), page)
            # The late failure lost the precedence contest, so its reason never reaches the page.
            self.assertNotIn(REASONS['late'], page)
            self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', page)
            self.assertNotIn('<script>alert(1)</script>', page)
            self.assertIn('no run record in any source', page)

            cells = {dish['label']: dish['cells'] for dish in data['dishes']}
            self.assertEqual(cells['01_pizza']['moge2-relief']['status'], 'success')
            self.assertEqual(cells['01_pizza']['moge2-relief']['source'], str(early))
            self.assertEqual(cells['01_pizza']['triposg']['reason'], REASONS['dtype'])
            self.assertEqual(cells['01_pizza']['hunyuan3d2']['status'], 'not_run')
            self.assertEqual(cells['01_pizza']['hi3dgen']['reason'], REASONS['spconv'])
            glbs = cells['01_pizza']['moge2-relief']['glbs']
            self.assertEqual([Path(glb['path']).name for glb in glbs], ['moge2_relief.glb'])
            self.assertEqual(glbs[0]['measured_bytes'], len(_glb_bytes('01_pizza', 'moge2-relief')))
            self.assertIn('declared faces: 60,000', page)
            self.assertIn('texture: embedded', page)
            # Mesh quality is decoded from the bytes, next to the manifest's declared face count.
            self.assertIn('measured <strong>12</strong> faces', page)
            self.assertIn('<strong>0</strong> boundary edges', page)
            self.assertIn('texture 6x4 px', page)
            self.assertIn('&middot; watertight &middot;', page)
            # Welded topology sits beside index topology so a seam-split mesh is not misread.
            self.assertIn('welded: <strong>0</strong> boundary / 0 non-manifold', page)
            self.assertIn('1 shell (100.0% in the largest)', page)
            quality = glbs[0]['quality']
            self.assertTrue(quality['measured'])
            self.assertEqual(8, quality['vertices'])
            self.assertEqual(12, quality['triangles'])
            self.assertEqual(0, quality['boundary_edges'])
            self.assertEqual(0, quality['nonmanifold_edges'])
            self.assertEqual(0, quality['degenerate_triangles'])
            self.assertTrue(quality['watertight'])
            self.assertEqual([[6, 4]], quality['texture_pixels'])
            self.assertEqual(['image/png'], quality['texture_mime_types'])
            self.assertEqual(round(len(_glb_bytes('01_pizza', 'moge2-relief')) / 12, 3),
                             quality['bytes_per_face'])

    def test_coverage_counts_and_provenance_render(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            # A page one directory down still links relatively: the parent hop is not absolute.
            out, data = module.build_report([early, late], root / 'out' / 'report.html')
            page = out.read_text(encoding='utf-8')
            rows = {row['slug']: row for row in data['coverage']}
            expected = {
                'moge2-relief': dict(attempted=2, success=2, skipped=0, failed=0, not_run=0, glbs=2),
                'trellis2-4b': dict(attempted=2, success=0, skipped=2, failed=0, not_run=0, glbs=0),
                'trellis2-4b-hires': dict(attempted=0, success=0, skipped=0, failed=0, not_run=2, glbs=0),
                'triposg': dict(attempted=2, success=0, skipped=0, failed=2, not_run=0, glbs=0),
                'hunyuan3d2': dict(attempted=1, success=1, skipped=0, failed=0, not_run=1, glbs=1),
                'hunyuan3d21': dict(attempted=0, success=0, skipped=0, failed=0, not_run=2, glbs=0),
                'hunyuan3d21-pbr': dict(attempted=0, success=0, skipped=0, failed=0, not_run=2, glbs=0),
                'hi3dgen': dict(attempted=1, success=0, skipped=1, failed=0, not_run=1, glbs=0),
                'spar3d': dict(attempted=0, success=0, skipped=0, failed=0, not_run=2, glbs=0),
            }
            for slug, counts in expected.items():
                with self.subTest(slug=slug):
                    for key, value in counts.items():
                        self.assertEqual(rows[slug][key], value, key)
            self.assertEqual(
                rows['moge2-relief']['bytes'],
                sum(len(_glb_bytes(label, 'moge2-relief')) for label in LABELS),
            )
            self.assertEqual(rows['hunyuan3d2']['bytes'], len(_glb_bytes('02_tteokbokki', 'hunyuan3d2')))
            self.assertEqual(rows['trellis2-4b']['reasons'],
                             [{'status': 'skipped', 'reason': REASONS['hf'], 'count': 2}])
            self.assertEqual(rows['triposg']['reasons'],
                             [{'status': 'failed', 'reason': REASONS['dtype'], 'count': 2}])
            self.assertEqual(rows['hunyuan3d2']['reasons'],
                             [{'status': 'not_run', 'reason': 'no run record in any source', 'count': 1}])
            self.assertEqual(rows['hunyuan3d21']['reasons'],
                             [{'status': 'not_run', 'reason': 'no run record in any source', 'count': 2}])
            self.assertEqual(rows['trellis2-4b-hires']['reasons'],
                             [{'status': 'not_run', 'reason': 'no run record in any source', 'count': 2}])
            self.assertEqual(rows['hunyuan3d21-pbr']['reasons'],
                             [{'status': 'not_run', 'reason': 'no run record in any source', 'count': 2}])
            self.assertEqual(rows['spar3d']['reasons'],
                             [{'status': 'not_run', 'reason': 'no run record in any source', 'count': 2}])
            self.assertEqual(rows['moge2-relief']['reasons'], [])

            self.assertEqual([(item['label'], item['slug']) for item in data['missing']],
                             [('01_pizza', 'trellis2-4b-hires'), ('01_pizza', 'hunyuan3d2'),
                              ('01_pizza', 'hunyuan3d21'), ('01_pizza', 'hunyuan3d21-pbr'),
                              ('01_pizza', 'spar3d'),
                              ('02_tteokbokki', 'trellis2-4b-hires'), ('02_tteokbokki', 'hunyuan3d21'),
                              ('02_tteokbokki', 'hunyuan3d21-pbr'), ('02_tteokbokki', 'hi3dgen'),
                              ('02_tteokbokki', 'spar3d')])
            self.assertEqual(data['dataset_slugs'], ['peekaplate-dish-test-photos'])
            self.assertEqual(data['declared_dates'], ['2026-11-23T01:46:00Z'])
            self.assertIn('2026-11-23T01:46:00Z', page)
            revisions = dict(data['revisions'])
            self.assertEqual(revisions['trellis_model'], ['af44b45f2e35a493886929c6d786e563ec68364d'])
            self.assertNotIn('user-uploaded-dataset', revisions)
            self.assertIn('af44b45f2e35a493886929c6d786e563ec68364d', page)

            self.assertIn('publication_eligible', page)
            self.assertIn('<strong>false</strong>', page)
            self.assertIn('publication_eligible: false', page)
            presence = data['input_sha256_presence']
            self.assertEqual(presence['staged'], len(LABELS))
            self.assertEqual(presence['declared'], len(LABELS))
            self.assertIn(_sha('input-image-01_pizza'.encode()), page)

            hrefs = re.findall(r'href="([^"]*)"', page)
            self.assertTrue(hrefs)
            for href in hrefs:
                with self.subTest(href=href):
                    self.assertFalse(href.startswith('/'), href)
                    self.assertNotIn('file:', href)
                    self.assertNotIn('://', href)
            self.assertIn('../kamodels-early/01_pizza/moge2_relief.glb', hrefs)
            self.assertIn('../kamodels-early/01_pizza/moge2_relief.glb', page)
            self.assertNotIn('moge2_relief_mobile.glb', page)

    def test_rejects_traversal_absolute_and_publishable_sources(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            manifest_path = early / 'manifest.json'
            original = json.loads(manifest_path.read_text(encoding='utf-8'))
            evil = root / 'evil.glb'
            evil.write_bytes(b'glTF-evil')
            for label, bad_path in (
                ('traversal', '../evil.glb'),
                ('absolute', str(evil)),
                ('nested traversal', '01_pizza/../../evil.glb'),
            ):
                with self.subTest(case=label):
                    broken = json.loads(json.dumps(original))
                    broken['runs_3d']['01_pizza/moge2-relief']['artifacts'][0]['path'] = bad_path
                    manifest_path.write_text(json.dumps(broken), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, 'Invalid runs_3d'):
                        module.load_report_data([early])

            manifest_path.write_text(json.dumps(original), encoding='utf-8')
            publishable = json.loads(json.dumps(original))
            publishable['publication_eligible'] = True
            manifest_path.write_text(json.dumps(publishable), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible'):
                module.load_report_data([early])

    def test_quality_summary_table_reports_medians_and_watertight_share(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            out, data = module.build_report([early, late], root / 'report.html')
            page = out.read_text(encoding='utf-8')
            rows = {row['slug']: row for row in data['quality']}
            self.assertEqual(
                {key: rows['moge2-relief'][key] for key in (
                    'measured', 'watertight', 'open_shells', 'median_faces', 'min_faces',
                    'max_faces', 'median_boundary_edges', 'max_boundary_edges',
                    'degenerate_triangles', 'nonmanifold_edges', 'texture_pixels')},
                {'measured': 2, 'watertight': 2, 'open_shells': 0, 'median_faces': 12.0,
                 'min_faces': 12.0, 'max_faces': 12.0, 'median_boundary_edges': 0.0,
                 'max_boundary_edges': 0.0, 'degenerate_triangles': 0, 'nonmanifold_edges': 0,
                 'texture_pixels': ['6x4']},
            )
            self.assertEqual(100.0, rows['moge2-relief']['watertight_pct'])
            self.assertEqual(
                {key: rows['moge2-relief'][key] for key in (
                    'welded_watertight', 'median_welded_boundary_edges', 'median_shell_count',
                    'median_main_shell_pct')},
                {'welded_watertight': 2, 'median_welded_boundary_edges': 0.0,
                 'median_shell_count': 1.0, 'median_main_shell_pct': 100.0},
            )
            self.assertIn('<th>Welded watertight</th>', page)
            self.assertEqual(12.0, rows['hunyuan3d2']['median_faces'])
            self.assertEqual(1, rows['hunyuan3d2']['measured'])
            # Models with no success cell carry no measurement, never a zero that reads as good.
            for slug in ('trellis2-4b', 'triposg', 'hunyuan3d21', 'hi3dgen', 'spar3d'):
                with self.subTest(slug=slug):
                    self.assertEqual(0, rows[slug]['measured'])
                    self.assertIsNone(rows[slug]['median_faces'])
                    self.assertIsNone(rows[slug]['median_boundary_edges'])
                    self.assertIsNone(rows[slug]['watertight_pct'])
                    self.assertIsNone(rows[slug]['median_welded_boundary_edges'])
                    self.assertIsNone(rows[slug]['median_shell_count'])
                    self.assertEqual([], rows[slug]['unmeasured'])

            self.assertIn('Mesh quality (measured from the GLB bytes)', page)
            self.assertIn('Median boundary edges', page)
            self.assertIn('Watertight GLBs', page)
            self.assertIn('2 (100.0%)', page)
            self.assertIn('12.0', page)
            self.assertIn('never turn a structural failure into a pass', page)

    def test_undecodable_glb_renders_as_quality_not_measured(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            broken = early / '01_pizza' / 'moge2_relief.glb'
            broken.write_bytes(b'not-a-glb')
            out, data = module.build_report([early, late], root / 'report.html')
            page = out.read_text(encoding='utf-8')
            self.assertIn('quality not measured:', page)
            row = {item['slug']: item for item in data['quality']}['moge2-relief']
            self.assertEqual(1, row['measured'])
            self.assertEqual(1, len(row['unmeasured']))
            self.assertEqual('01_pizza/moge2_relief.glb', row['unmeasured'][0]['path'])
            self.assertIn('unmeasured', page)

    def test_same_inputs_produce_byte_identical_output(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            first, _ = module.build_report([early, late], root / 'a' / 'report.html')
            first_bytes = first.read_bytes()
            second, _ = module.build_report([early, late], root / 'a' / 'report.html')
            self.assertEqual(first_bytes, second.read_bytes())
            again, _ = module.build_report([early, late], root / 'a' / 'second-report.html')
            self.assertEqual(first_bytes, again.read_bytes())
            self.assertNotIn(b'\r\n', first_bytes)
            self.assertIn(b'publication_eligible: false', first_bytes)

    def test_cli_requires_a_source_and_writes_the_requested_page(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            early, late = _build_sources(root)
            with self.assertRaises(SystemExit) as raised:
                module.main([])
            self.assertEqual(raised.exception.code, 2)
            out = root / 'cli-report.html'
            self.assertEqual(
                module.main(['--source', str(early), '--source', str(late), '--out', str(out),
                             '--title', 'Fixture report']),
                0,
            )
            page = out.read_text(encoding='utf-8')
            self.assertIn('<title>Fixture report</title>', page)
            self.assertNotIn('href="/', page)


if __name__ == '__main__':
    unittest.main()