"""Checks for the menu extraction specifications, alpha handling, and multi-model Kaggle notebooks."""
import ast
import base64
import hashlib
import html as html_lib
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import re
import struct
import sys
from tempfile import TemporaryDirectory
import unittest

from PIL import Image, ImageDraw, ImageOps

REPO_ROOT = Path(__file__).resolve().parents[2]
NOTEBOOKS = REPO_ROOT / 'notebooks'
GENERATED_NOTEBOOKS = (
    'dish-3d-multi-model-bench-a.ipynb',
    'dish-3d-multi-model-bench-b.ipynb',
)
CANONICAL_MODELS = ('moge2-relief', 'trellis2-4b', 'triposg', 'hunyuan3d2', 'hunyuan3d21', 'hi3dgen')
path = Path(__file__).resolve().parents[1] / 'scripts' / 'extract_gmn9c8_dishes.py'
spec = importlib.util.spec_from_file_location('extract_gmn9c8_dishes', path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class ExtractionTests(unittest.TestCase):
    def test_specifications_cover_menu_dishes_once(self):
        specs = module.SMASK_DISHES + module.CROP_DISHES
        self.assertEqual(len(specs), 37)
        self.assertEqual({int(s.stem[:2]) for s in specs}, set(range(5, 42)))
        for item in module.SMASK_DISHES:
            self.assertGreater(item.xref, 0)
            self.assertGreater(item.smask, 0)
            self.assertNotEqual(item.xref, item.smask)
        for item in module.CROP_DISHES:
            x0, y0, x1, y1 = item.crop_box
            self.assertTrue(0 <= x0 < x1 and 0 <= y0 < y1)

    def test_crop_preserves_mask_and_pads_edge(self):
        rgb = Image.new('RGB', (20, 20), 'red')
        alpha = Image.new('L', (20, 20), 0)
        for x in range(10):
            for y in range(5):
                alpha.putpixel((x, y), 255)
        image, mask = module._tight_alpha_crop_and_upscale(rgb, alpha, min_side=64)
        self.assertEqual(image.size, mask.size)
        self.assertGreaterEqual(min(image.size), 64)
        self.assertEqual(mask.getpixel((0, 0)), 0)
        self.assertEqual(mask.getextrema()[1], 255)

    def test_empty_alpha_rejected(self):
        with self.assertRaises(ValueError):
            module._tight_alpha_crop_and_upscale(Image.new('RGB', (4, 4)), Image.new('L', (4, 4)))

    def test_crop_hop_declares_original_stream_bytes_and_derived_file_identity(self):
        spec = next(item for item in module.CROP_DISHES if item.stem == '15_zaru_ramen')
        with TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            # Encoder settings chosen so the derived crop cannot share the stream bytes (Kaggle case).
            stream = BytesIO()
            plate = Image.new('RGB', (1200, 1000), (26, 32, 40))
            ImageDraw.Draw(plate).ellipse((300, 250, 900, 800), fill=(190, 110, 60))
            plate.save(stream, format='PNG', compress_level=1)
            original = stream.getvalue()

            record = module._compose_crop_record(spec, original, out_dir)
            derived = out_dir / record['image_file']

            self.assertEqual(record['original_sha256'], hashlib.sha256(original).hexdigest())
            self.assertEqual(record['sha256'], hashlib.sha256(derived.read_bytes()).hexdigest())
            self.assertEqual(record['sha256'], module._sha256_file(derived))
            self.assertNotEqual(record['sha256'], record['original_sha256'])
            self.assertEqual(record['derived_transformation'], 'crop+png_encode')
            # Existing manifest keys other code reads remain unchanged in meaning.
            self.assertEqual(record['label'], '15_zaru_ramen')
            self.assertEqual(record['source'], 'GMn9C8.pdf')
            self.assertFalse(record['has_native_mask'])
            with Image.open(derived) as derived_image:
                self.assertEqual(record['size'], list(derived_image.size))

    def test_smask_hop_declares_photo_and_mask_stream_identity_beside_derived_files(self):
        spec = next(item for item in module.SMASK_DISHES if item.stem == '05_ikari_steak_ramen')
        with TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            photo_stream = BytesIO()
            photo = Image.new('RGB', (60, 40), (30, 34, 44))
            ImageDraw.Draw(photo).ellipse((10, 6, 50, 34), fill=(200, 95, 45))
            photo.save(photo_stream, format='PNG', compress_level=1)
            mask_stream = BytesIO()
            mask = Image.new('L', (60, 40), 0)
            ImageDraw.Draw(mask).ellipse((10, 6, 50, 34), fill=255)
            mask.save(mask_stream, format='PNG', compress_level=1)

            record = module._compose_smask_record(spec, photo_stream.getvalue(), mask_stream.getvalue(), out_dir)

            self.assertEqual(record['original_sha256'], hashlib.sha256(photo_stream.getvalue()).hexdigest())
            self.assertEqual(record['original_mask_sha256'], hashlib.sha256(mask_stream.getvalue()).hexdigest())
            self.assertEqual(record['sha256'], module._sha256_file(out_dir / record['image_file']))
            self.assertEqual(record['mask_sha256'], module._sha256_file(out_dir / record['mask_file']))
            self.assertNotEqual(record['sha256'], record['original_sha256'])
            self.assertEqual(record['derived_transformation'], 'crop_to_alpha+slate_composite+upscale+png_encode')

    def test_benchmark_photo_declares_its_own_bytes_as_source_identity(self):
        with TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            photo = out_dir / '01_pizza.png'
            rng_bytes = bytes(range(256)) * 12  # 32*32*3 bytes of non-uniform pixel data
            pixels = Image.frombytes('RGB', (32, 32), rng_bytes)
            pixels.save(photo, format='PNG', compress_level=1)
            mask = out_dir / '01_pizza_mask.png'
            Image.new('L', (32, 32), 255).save(mask)

            record = module._benchmark_record(photo, mask)
            self.assertEqual(record['sha256'], module._sha256_file(photo))
            self.assertEqual(record['original_sha256'], record['sha256'])
            self.assertEqual(record['derived_transformation'], 'none')
            self.assertEqual(record['mask_file'], '01_pizza_mask.png')
            self.assertTrue(record['has_native_mask'])
            self.assertEqual(record['size'], [32, 32])

    def test_generated_multi_model_notebooks_hygiene_and_syntax(self):
        for fname, expected_models in (
            ('dish-3d-multi-model-bench-a.ipynb', ('moge2-relief', 'triposg', 'hunyuan3d2', 'hi3dgen')),
            ('dish-3d-multi-model-bench-b.ipynb', ('trellis2-4b', 'moge2-relief')),
        ):
            nb_path = REPO_ROOT / 'notebooks' / fname
            self.assertTrue(nb_path.is_file(), f'Missing {nb_path}')
            raw = nb_path.read_text(encoding='utf-8')
            self.assertNotIn('/kaggle/input/datasets/', raw)
            self.assertNotIn('AIza', raw)
            self.assertNotIn('sk-or-v1-', raw)
            self.assertIsNone(re.search(r'hf_[A-Za-z0-9]{16,}', raw))
            self.assertIn('purge_hf_and_torch_caches', raw)
            for model_id in expected_models:
                self.assertIn(model_id, raw)

            nb = json.loads(raw)
            self.assertEqual((nb['nbformat'], nb['nbformat_minor']), (4, 4))
            for idx, cell in enumerate(nb['cells']):
                if cell['cell_type'] != 'code':
                    continue
                self.assertIsNone(cell['execution_count'], f'{fname} cell {idx} execution_count not cleared')
                self.assertEqual(cell['outputs'], [], f'{fname} cell {idx} outputs not cleared')
                ast.parse(''.join(cell['source']), filename=f'{fname}:cell_{idx}')


def _minimal_glb_bytes() -> bytes:
    """Return a real, minimal, valid binary GLB (one untextured triangle)."""
    positions = struct.pack('<9f', 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
    mesh = {
        'asset': {'version': '2.0'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'buffers': [{'byteLength': len(positions)}],
        'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': len(positions), 'target': 34962}],
        'accessors': [{
            'bufferView': 0, 'type': 'VEC3', 'count': 3, 'componentType': 5126,
            'min': [0.0, 0.0, 0.0], 'max': [1.0, 1.0, 0.0],
        }],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
    }
    json_chunk = json.dumps(mesh).encode()
    json_chunk += b' ' * (-len(json_chunk) % 4)
    binary_chunk = positions + b'\0' * (-len(positions) % 4)
    return (
        struct.pack('<4sIIII', b'glTF', 2, 28 + len(json_chunk) + len(binary_chunk), len(json_chunk), 0x4E4F534A)
        + json_chunk + struct.pack('<II', len(binary_chunk), 0x004E4942) + binary_chunk
    )


def _notebook_studio_scope(notebook_name: str) -> dict:
    """Exec Cell 15's studio assignments + helpers from a generated notebook into a fresh scope."""
    cells = json.loads((NOTEBOOKS / notebook_name).read_text(encoding='utf-8'))['cells']
    studio_cell = next(
        ''.join(cell['source']) for cell in cells
        if cell['cell_type'] == 'code' and 'def _build_notebook_studio_payload' in ''.join(cell['source'])
    )
    tree = ast.parse(studio_cell, filename=f'{notebook_name}:cell_studio')
    wanted_assigns = {'STUDIO_THREE_VERSION', 'STUDIO_THREE_CDN_BASE', 'STUDIO_HTML_TEMPLATE'}
    wanted_funcs = {'_studio_encode_png_data_url', '_build_notebook_studio_payload', '_render_notebook_studio'}
    nodes = [
        node for node in tree.body
        if (isinstance(node, ast.Assign)
            and any(getattr(target, 'id', None) in wanted_assigns for target in node.targets))
        or (isinstance(node, ast.FunctionDef) and node.name in wanted_funcs)
    ]
    scope = {
        'base64': base64, 'html_lib': html_lib, 'json': json, 're': re, 'Path': Path,
        'Image': Image, 'ImageOps': ImageOps,
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), f'{notebook_name}:studio', 'exec'), scope)
    return scope


class GeneratedNotebookModelRuntimeTests(unittest.TestCase):
    """Regressions for the two model-runtime failures measured in Kaggle benchmark-a/3."""

    def _source(self, notebook_name: str) -> str:
        raw = (NOTEBOOKS / notebook_name).read_text(encoding='utf-8')
        return '\n'.join(''.join(cell['source']) for cell in json.loads(raw)['cells'] if cell['cell_type'] == 'code')

    def test_triposg_casts_the_whole_pipeline_including_the_image_encoder(self):
        source = self._source('dish-3d-multi-model-bench-a.ipynb')
        # Upstream inference_triposg.py: `TripoSGPipeline.from_pretrained(dir).to(device, dtype)`.
        self.assertIn("TripoSGPipeline.from_pretrained(str(triposg_weights)).to('cuda', torch.float16)", source)
        self.assertNotIn(
            'TripoSGPipeline.from_pretrained(str(triposg_weights), torch_dtype=torch.float16)', source,
        )
        # `TripoSGPipeline` derives `latents.dtype` from `image_embeds.dtype`, so the DINOv2 encoder is
        # pinned and every component dtype is asserted: a float32 encoder is the exact defect.
        self.assertIn('_candidate_pipe.image_encoder_dinov2.to(dtype=torch.float16)', source)
        self.assertIn("('image_encoder_dinov2', _candidate_pipe.image_encoder_dinov2)", source)
        self.assertIn('if set(_triposg_dtypes.values()) != {torch.float16}:', source)
        # `DiffusionPipeline` has no `.parameters()`, and a probe must never withhold the pipeline:
        # benchmark-a/4 printed `TypeError: 'dict' object is not callable` yet still generated.
        self.assertNotIn('next(triposg_pipe.parameters())', source)
        self.assertIn('torch.nn.Module.parameters(_module).__next__().dtype', source)
        self.assertIn('triposg_pipe = _candidate_pipe', source)
        self.assertIn('dtype probe unavailable', source)

    def test_triposg_caps_the_raw_mesh_and_reports_mobile_state_honestly(self):
        source = self._source('dish-3d-multi-model-bench-a.ipynb')
        # benchmark-a/4 exported 1.4M-7.1M-face TripoSG GLBs of 107-354 MB.
        self.assertIn("MAX_RAW_FACES = int(_os.environ.get('PEEK_MAX_RAW_FACES', '300000'))", source)
        self.assertIn('if len(faces) > MAX_RAW_FACES:', source)
        self.assertIn('verts, faces = _decimate_vertex_cluster(verts, faces, MAX_RAW_FACES)', source)
        self.assertIn("mobile_status='available' if baked.get('mobile') else 'failed'", source)
        self.assertIn("'mobile_error': baked['mobile_error']", source)
        self.assertIn("artifact_paths=[raw_glb, mob_glb] if baked.get('mobile') else [raw_glb]", source)

    def test_hi3dgen_probes_spconv_in_a_child_process_and_skips_instead_of_failing(self):
        source = self._source('dish-3d-multi-model-bench-a.ipynb')
        # pccm's editable heuristic must not JIT-rebuild the binary cumm/spconv wheels (benchmark-a/3, /5).
        self.assertIn("os.environ['CUMM_DISABLE_JIT'] = '1'", source)
        self.assertIn("os.environ['SPCONV_DISABLE_JIT'] = '1'", source)
        self.assertIn("[PYTHON, '-c', HI3D_SPCONV_SMOKE]", source)
        self.assertIn('import spconv.pytorch as spconv', source)
        self.assertIn('spconv.SubMConv3d(', source)
        self.assertIn("'spconv_unavailable:", source)
        self.assertIn("str(_exc).startswith('spconv_unavailable:')", source)
        self.assertIn("rec.update(\n                    status='skipped',", source)
        # The unusable wheel is removed so the rest of the notebook cannot inherit it.
        self.assertIn("'uninstall', '-y', '-q', _spconv_installed", source)
        # A genuine model failure still reports `failed`, not a silent skip.
        self.assertIn("rec.update(status='failed', error=hi3d_err or 'Hi3DGen setup failed')", source)


class GeneratedNotebookStudioTests(unittest.TestCase):
    """Regressions for the generated Kaggle notebooks' 5-model studio payload."""

    def test_generated_notebooks_cell15_builds_all_5_models_studio_payload(self):
        payloads = {}
        for notebook_name in GENERATED_NOTEBOOKS:
            with self.subTest(notebook=notebook_name), TemporaryDirectory() as tmp:
                root = Path(tmp)
                label = '01_hero_dish'
                dish_dir = root / label
                dish_dir.mkdir(parents=True)
                Image.new('RGB', (24, 24), (200, 120, 60)).save(dish_dir / 'input_image.png')
                Image.new('RGBA', (24, 24), (200, 120, 60, 255)).save(dish_dir / 'cutout_rgba.png')
                (dish_dir / 'job_manifest.json').write_text(json.dumps({
                    'job_id': 'fixture-job',
                    'publication_eligible': False,
                    'source_sha256': 'a' * 64,
                }), encoding='utf-8')

                glb_bytes = _minimal_glb_bytes()
                runs = {}
                for slug in CANONICAL_MODELS:
                    raw_glb = dish_dir / f'{slug}.glb'
                    raw_glb.write_bytes(glb_bytes)
                    mobile_glb = dish_dir / f'{slug}_mobile.glb'
                    mobile_glb.write_bytes(glb_bytes)
                    runs[f'{label}/{slug}'] = {
                        'input_label': label,
                        'status': 'success',
                        'backend': slug,
                        'appearance': 'pbr_photo_projection',
                        'license': 'MIT',
                        'device': 'cuda:0',
                        'elapsed_seconds': 1.5,
                        'artifact_paths': [raw_glb],
                        'mobile_glb_path': mobile_glb,
                        'mobile_status': 'available',
                        'metrics': {'vertices': 3, 'faces': 1, 'bytes': len(glb_bytes), 'has_texture': False},
                        'mobile_metrics': {'vertices': 3, 'faces': 1, 'bytes': len(glb_bytes)},
                    }

                scope = _notebook_studio_scope(notebook_name)
                scope.update(
                    ACTIVE_LABELS=[label],
                    RESULTS_DIR=root,
                    DEMO_TRUTHFUL_LABEL='fixture demo (private R&D)',
                    PLATE_PRESERVATION_MODE='preserve_plate',
                    image_results={label: {
                        'image_status': 'success',
                        'image_source': 'user-uploaded-dataset',
                        'image_path': dish_dir / 'input_image.png',
                        'cutout_path': dish_dir / 'cutout_rgba.png',
                        'job_manifest_path': dish_dir / 'job_manifest.json',
                        'size': [24, 24],
                        'source_sha256': 'a' * 64,
                        'cutout_metrics': {'plate_preserved': True, 'plate_method': 'grounding-dino-tiny'},
                    }},
                    RUNS_3D=runs,
                )

                try:
                    payload = scope['_build_notebook_studio_payload'](embed_mobile_assets=False)
                except NameError as error:  # pragma: no cover - regression guard for Bug A
                    self.fail(f'{notebook_name} studio payload raised NameError: {error}')

                self.assertIs(payload['publication_eligible'], False)
                dish = payload['dishes'][0]
                self.assertEqual(len(dish['runs']), len(CANONICAL_MODELS))
                self.assertEqual([run['slug'] for run in dish['runs']], list(CANONICAL_MODELS))
                self.assertEqual(len(dish['model_statuses']), len(CANONICAL_MODELS))
                self.assertEqual([status['slug'] for status in dish['model_statuses']], list(CANONICAL_MODELS))
                self.assertTrue(all(status['status'] == 'success' for status in dish['model_statuses']))
                self.assertTrue(all(run['mobile_status'] == 'available' for run in dish['runs']))
                html = scope['_render_notebook_studio'](payload)
                self.assertIn('publication_eligible=false', html)
                payloads[notebook_name] = payload

        self.assertEqual(set(payloads), set(GENERATED_NOTEBOOKS))


if __name__ == '__main__':
    unittest.main()
