"""Offline checks for the TRELLIS notebook's delivery artifacts."""

import ast
from contextlib import redirect_stdout
from copy import deepcopy
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image, ImageOps


NOTEBOOK = Path(__file__).resolve().parents[2] / 'notebooks' / 'trellislast-version.ipynb'


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _kaggle_style_png(path: Path, *, size: tuple[int, int] = (56, 40), seed: int = 11) -> bytes:
    """Write a PNG whose re-encode emits different deflate bytes for identical pixels (Kaggle case)."""
    rng = np.random.default_rng(seed)
    pixels = rng.integers(0, 256, size=(size[1], size[0], 3), dtype=np.uint8)
    Image.fromarray(pixels, 'RGB').save(path, format='PNG', compress_level=1)
    return path.read_bytes()


def _naive_reencode(path: Path) -> bytes:
    """The pre-fix staging path: decode, normalize, and re-encode into a fresh image."""
    buffer = BytesIO()
    with Image.open(path) as im:
        mode = 'RGBA' if 'A' in im.getbands() or 'transparency' in im.info else 'RGB'
        ImageOps.exif_transpose(im).convert(mode).save(buffer, format='PNG')
    return buffer.getvalue()


def write_glb(path, mesh, binary):
    payload = json.dumps(mesh).encode()
    payload += b' ' * (-len(payload) % 4)
    binary += b'\0' * (-len(binary) % 4)
    path.write_bytes(
        struct.pack('<4sIIII', b'glTF', 2, 28 + len(payload) + len(binary), len(payload), 0x4E4F534A)
        + payload + struct.pack('<II', len(binary), 0x004E4942) + binary
    )


class TrellisLastNotebookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cells = json.loads(NOTEBOOK.read_text())['cells']

    def setUp(self):
        self.scope = {}
        self.run_cell(1)

    def run_cell(self, index):
        exec(compile(''.join(self.cells[index]['source']), f'cell_{index}', 'exec'), self.scope)

    def test_discovery_stages_source_bytes_verbatim_and_declares_source_digest(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_dir = root / 'input' / 'peekaplate-dish-test-photos'
            src_dir.mkdir(parents=True)
            source = src_dir / '01_pizza.png'
            original = _kaggle_style_png(source)
            # Non-vacuous reproducer: the pre-fix staging bytes differ from the dataset photo bytes.
            self.assertNotEqual(_naive_reencode(source), original)

            found = self.scope['discover_user_dish_images'](root / 'results', input_root=root / 'input')
            entry = found['01_pizza']
            staged = Path(entry['image_path'])

            self.assertEqual(staged.name, 'input_image.png')
            self.assertEqual(staged.read_bytes(), original)
            self.assertEqual(entry['source_sha256'], _sha256(original))
            self.assertEqual(entry['input_image_sha256'], entry['source_sha256'])
            self.assertEqual(entry['input_transformation'], 'none')
            self.assertTrue(entry['input_byte_identical'])
            self.assertEqual(entry['size'], [56, 40])

            job_manifest = self.scope['build_job_manifest']('01_pizza', entry, {'trellis_model': 'fixture'})
            self.assertEqual(job_manifest['input_filename'], 'input_image.png')
            self.assertEqual(job_manifest['source_sha256'], _sha256(original))
            self.assertEqual(job_manifest['input_image_sha256'], job_manifest['source_sha256'])
            self.assertEqual(job_manifest['input_transformation'], 'none')
            self.assertTrue(job_manifest['input_byte_identical'])

    def test_discovery_keeps_original_hash_when_staging_needs_transformation(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_dir = root / 'input' / 'peekaplate-dish-test-photos'
            src_dir.mkdir(parents=True)
            # EXIF orientation 6 forces a real rotate + PNG re-encode while staging.
            exif = Image.Exif()
            exif[0x0112] = 6
            source = src_dir / '02_rotated.jpg'
            Image.new('RGB', (40, 24), (200, 120, 60)).save(source, format='JPEG', quality=95, exif=exif)
            original = source.read_bytes()

            found = self.scope['discover_user_dish_images'](root / 'results', input_root=root / 'input')
            entry = found['02_rotated']
            staged = Path(entry['image_path'])
            staged_bytes = staged.read_bytes()

            self.assertEqual(entry['source_sha256'], _sha256(original))
            self.assertEqual(entry['input_image_sha256'], _sha256(staged_bytes))
            self.assertNotEqual(entry['input_image_sha256'], entry['source_sha256'])
            self.assertFalse(entry['input_byte_identical'])
            self.assertIn('exif_transpose', entry['input_transformation'])
            self.assertEqual(entry['size'], [24, 40])
            with Image.open(staged) as staged_image:
                self.assertEqual(staged_image.format, 'PNG')
                self.assertIn(staged_image.getexif().get(0x0112), (None, 1))

            job_manifest = self.scope['build_job_manifest']('02_rotated', entry, {})
            self.assertEqual(job_manifest['source_sha256'], _sha256(original))
            self.assertEqual(job_manifest['input_image_sha256'], _sha256(staged_bytes))
            self.assertFalse(job_manifest['input_byte_identical'])

    def test_worker_entrypoint_verifies_staged_digest_against_source_identity(self):
        tree = ast.parse(''.join(self.cells[15]['source']), filename='cell_15')
        template = next(
            node.value.value
            for node in tree.body
            if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', None) == 'worker_entrypoint_template'
        )
        entrypoint = {}
        exec(compile(template, 'worker_entrypoint.py', 'exec'), entrypoint)

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            dish = root / '01_pizza'
            dish.mkdir()
            staged_bytes = _kaggle_style_png(dish / 'input_image.png')
            source_bytes = bytes(staged_bytes) + b'\x00derived-marker'
            manifest = {
                'job_id': 'fixture-job',
                'dish_label': '01_pizza',
                'publication_eligible': False,
                'input_filename': 'input_image.png',
                'source_sha256': _sha256(source_bytes),
                'input_image_sha256': _sha256(staged_bytes),
                'input_transformation': 'exif_transpose+png_encode',
                'input_byte_identical': False,
            }
            manifest_path = dish / 'job_manifest.json'
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            receipt_path = entrypoint['run_worker'](manifest_path, dish, root / 'dry', dry_run=True)
            receipt = json.loads(Path(receipt_path).read_text(encoding='utf-8'))
            self.assertEqual(receipt['source_sha256'], _sha256(source_bytes))
            self.assertEqual(receipt['input_image_sha256'], _sha256(staged_bytes))
            self.assertEqual(receipt['input_transformation'], 'exif_transpose+png_encode')

            # Tampering the staged artifact must fail against the derived digest.
            (dish / 'input_image.png').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, 'Staged input SHA-256 mismatch'):
                entrypoint['run_worker'](manifest_path, dish, root / 'fail', dry_run=True)

            # A byte-identical declaration whose digests disagree is a contradiction, never a pass.
            (dish / 'input_image.png').write_bytes(staged_bytes)
            contradictory = dict(manifest, input_byte_identical=True)
            manifest_path.write_text(json.dumps(contradictory), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'byte-identical'):
                entrypoint['run_worker'](manifest_path, dish, root / 'fail2', dry_run=True)

    def test_rejects_previous_json_only_fixture(self):
        payload = json.dumps({
            'asset': {'version': '2.0'},
            'textures': [{'source': 0}],
            'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'TEXCOORD_0': 1}}]}],
            'accessors': [
                {'type': 'VEC3', 'count': 3, 'componentType': 5126},
                {'type': 'VEC2', 'count': 3, 'componentType': 5126},
            ],
        }).encode()
        payload += b' ' * (-len(payload) % 4)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'invalid.glb'
            path.write_bytes(struct.pack('<4sIIII', b'glTF', 2, 20 + len(payload), len(payload), 0x4E4F534A) + payload)
            with self.assertRaises(self.scope['DemoError']):
                self.scope['validate_glb'](path)

    def test_secret_source_prefers_secret_then_dataset_then_environment(self):
        secret_source = self.scope['secret_source']
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'peekaplate-hf-token').mkdir()
            token_file = root / 'peekaplate-hf-token' / 'hf_token.txt'
            token_file.write_text('dataset-token', encoding='utf-8')
            # A private attached dataset file is used when no Kaggle Secret is attached, the
            # state an API-pushed kernel started in on 2026-11-22 (ConnectionError, 4/4 skipped).
            self.assertEqual(
                secret_source('HF_TOKEN', input_root=root, environ={}),
                ('dataset-token', 'dataset:peekaplate-hf-token/hf_token.txt'),
            )
            token_file.unlink()
            self.assertEqual(
                secret_source('HF_TOKEN', input_root=root, environ={'HF_TOKEN': 'env-token'}),
                ('env-token', 'environment'),
            )
            self.assertEqual(secret_source('HF_TOKEN', input_root=root, environ={}), (None, 'missing'))

    def test_preflight_distinguishes_an_absent_token_from_denied_access(self):
        preflight = self.scope['preflight_dinov3']

        def denied(repo, path, revision=None, token=None):
            raise PermissionError('403 Forbidden')

        def granted(repo, path, revision=None, token=None):
            return str(path)

        self.assertEqual(preflight(None), (False, 'missing_hf_token'))
        self.assertEqual(preflight(None, downloader=granted), (False, 'missing_hf_token'))
        self.assertEqual(preflight('hf-token', downloader=denied), (False, 'missing_or_unauthorized_hf_token'))
        self.assertEqual(preflight('hf-token', downloader=granted), (True, 'ok'))

    def test_raw_only_summary_names_missing_mobile_export(self):
        studio = ''.join(self.cells[15]['source'])
        summary = studio[studio.index("print('\\n=== FINAL PLATE-PRESERVING DEMO SUMMARY ===')"):]
        out = StringIO()
        with redirect_stdout(out):
            exec(summary, {'RUNS_3D': {
                'raw-only/trellis2-4b': {'status': 'success', 'appearance': 'pbr_texture'},
            }, **self.scope})
        self.assertIn('mobile=missing', out.getvalue())

    def test_offline_fixture_cell(self):
        for cell in self.cells:
            if cell['cell_type'] == 'code':
                ast.parse(''.join(cell['source']))
        self.run_cell(2)

    def test_geometry_and_texture_must_resolve_independently(self):
        self.run_cell(2)
        mesh = self.scope['fixture_mesh']
        binary = self.scope['fixture_binary']
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'mesh.glb'
            for label in ('missing image', 'missing binding', 'missing positions', 'short position view',
                          'out of bounds index', 'degenerate triangle', 'invalid image bytes'):
                with self.subTest(label=label):
                    invalid = deepcopy(mesh)
                    contents = binary
                    if label == 'missing image':
                        invalid['images'].clear()
                    elif label == 'missing binding':
                        del invalid['meshes'][0]['primitives'][0]['material']
                    elif label == 'missing positions':
                        del invalid['accessors'][0]['bufferView']
                    elif label == 'short position view':
                        invalid['bufferViews'][0]['byteLength'] = 12
                    elif label == 'out of bounds index':
                        offset = len(binary) + (-len(binary) % 4)
                        contents = binary.ljust(offset, b'\0') + struct.pack('<3H', 0, 1, 3)
                        invalid['buffers'][0]['byteLength'] = len(contents)
                        invalid['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': 6})
                        invalid['accessors'].append({
                            'bufferView': 3, 'type': 'SCALAR', 'count': 3, 'componentType': 5123,
                        })
                        invalid['meshes'][0]['primitives'][0]['indices'] = 2
                    elif label == 'degenerate triangle':
                        contents = bytes(36) + binary[36:]
                    else:
                        offset = invalid['bufferViews'][2]['byteOffset']
                        contents = binary[:offset] + bytes(len(binary) - offset)
                    write_glb(path, invalid, contents)
                    with self.assertRaises(self.scope['DemoError']):
                        self.scope['validate_glb'](path)

    def test_collect_mobile_glb_preserves_upstream_failed_status_when_missing(self):
        self.run_cell(2)
        collect = self.scope['collect_mobile_glb']
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / 'generated_mobile.glb'
            destination = Path(tmp) / 'trellis2_4b_mobile.glb'
            run = {'status': 'success'}
            collect(source, destination, {'mobile_status': 'failed'}, run)
            self.assertFalse(source.exists())
            self.assertFalse(destination.exists())
            self.assertEqual(run['mobile_status'], 'failed')
            self.assertNotIn('mobile_glb_path', run)
            self.assertNotIn('mobile_metrics', run)
            self.assertEqual(self.scope['mobile_delivery_status'](run), 'failed')

    def test_validate_glb_checks_secondary_texture_binding(self):
        self.run_cell(2)
        mesh = deepcopy(self.scope['fixture_mesh'])
        binary = self.scope['fixture_binary']
        with BytesIO() as encoded:
            Image.new('RGB', (2, 2), (10, 20, 30)).save(encoded, format='PNG')
            normal_bytes = encoded.getvalue()

        offset = len(binary) + (-len(binary) % 4)
        contents = binary.ljust(offset, b'\0') + normal_bytes
        secondary = deepcopy(mesh)
        secondary['buffers'][0]['byteLength'] = len(contents)
        secondary['bufferViews'].append(
            {'buffer': 0, 'byteOffset': offset, 'byteLength': len(normal_bytes)}
        )
        secondary['images'].append({'bufferView': 3, 'mimeType': 'image/png'})
        secondary['textures'].append({'source': 1})
        secondary['materials'][0]['normalTexture'] = {'index': 1}

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'secondary_texture.glb'
            write_glb(path, secondary, contents)
            self.assertTrue(self.scope['validate_glb'](path)['has_texture'])

            # A normal map as the material's only bound texture must still count as has_texture.
            secondary_only = deepcopy(secondary)
            secondary_only['materials'][0].pop('pbrMetallicRoughness')
            write_glb(path, secondary_only, contents)
            self.assertTrue(self.scope['validate_glb'](path)['has_texture'])

            for label in ('corrupt secondary image bytes', 'unresolvable secondary image'):
                with self.subTest(label=label):
                    invalid = deepcopy(secondary)
                    payload = contents
                    if label == 'corrupt secondary image bytes':
                        payload = contents[:offset] + bytes(len(normal_bytes))
                    else:
                        invalid['textures'][1] = {'source': 9}
                    write_glb(path, invalid, payload)
                    with self.assertRaises(self.scope['DemoError']):
                        self.scope['validate_glb'](path)

    def test_mobile_collection_distinguishes_missing_failed_and_available_exports(self):
        self.run_cell(2)
        mesh = deepcopy(self.scope['fixture_mesh'])
        texture = BytesIO()
        Image.new('RGB', (2, 2)).save(texture, format='WEBP')
        view = mesh['bufferViews'][2]
        view['byteLength'] = len(texture.getvalue())
        binary = self.scope['fixture_binary'][:view['byteOffset']] + texture.getvalue()
        mesh['buffers'][0]['byteLength'] = len(binary)
        mesh['images'][0]['mimeType'] = 'image/webp'
        mesh['extensionsUsed'] = mesh['extensionsRequired'] = ['EXT_texture_webp']
        mesh['textures'][0] = {'extensions': {'EXT_texture_webp': {'source': 0}}}
        collect = self.scope['collect_mobile_glb']
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / 'generated_mobile.glb'
            destination = Path(tmp) / 'trellis2_4b_mobile.glb'
            for status in ('missing', 'failed', 'available'):
                with self.subTest(status=status):
                    if status == 'failed':
                        source.write_bytes(b'invalid GLB')
                    elif status == 'available':
                        write_glb(source, mesh, binary)
                    run = {'status': 'success'}
                    collect(source, destination, {'mobile_faces': 1}, run)
                    self.assertEqual(run['status'], 'success')
                    self.assertEqual(run['mobile_status'], status)
                    self.assertEqual(destination.is_file(), status == 'available')
                    if status == 'available':
                        self.assertEqual(run['mobile_glb_path'], destination)
                        self.assertEqual(run['mobile_metrics']['faces'], 1)
                        self.assertTrue(run['mobile_metrics']['has_texture'])
                    else:
                        self.assertNotIn('mobile_glb_path', run)

    def test_raw_only_receipt_and_studio_payload_report_missing_mobile(self):
        self.run_cell(2)
        studio = ast.parse(''.join(self.cells[15]['source']))
        builder = next(node for node in studio.body
                       if isinstance(node, ast.FunctionDef) and node.name == '_build_notebook_studio_payload')
        exec(compile(ast.Module(body=[builder], type_ignores=[]), 'studio_payload', 'exec'), self.scope)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / 'trellis2_4b.glb'
            write_glb(raw, self.scope['fixture_mesh'], self.scope['fixture_binary'])
            input_entry = {
                'image_status': 'success',
                'image_path': root / 'input.png',
                'cutout_path': root / 'cutout.png',
            }
            run = {
                'status': 'success', 'mobile_status': 'missing', 'input_label': 'raw-only',
                'backend': 'TRELLIS.2-4B', 'artifact_paths': [raw],
            }
            runs = {'raw-only/trellis2-4b': run}
            receipt = self.scope['build_worker_receipt'](
                {'job_id': 'fixture', 'dish_label': 'raw-only'}, input_entry, runs, root,
            )
            model = receipt['models']['TRELLIS.2-4B']
            self.assertEqual(model['mobile_status'], 'missing')
            self.assertIn('raw_glb', model)
            self.assertNotIn('mobile_glb', model)

            self.scope.update(
                ACTIVE_LABELS=['raw-only'], RESULTS_DIR=root, image_results={'raw-only': input_entry},
                RUNS_3D=runs, STUDIO_THREE_VERSION='fixture',
            )
            payload = self.scope['_build_notebook_studio_payload']()
            studio_run = payload['dishes'][0]['runs'][0]
            self.assertEqual(studio_run['raw']['path'], raw.name)
            self.assertEqual(studio_run['mobile_status'], 'missing')
            self.assertIsNone(studio_run['mobile'])
