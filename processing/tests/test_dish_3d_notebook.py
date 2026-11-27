"""Offline verification suite for the Kaggle 2xT4 multi-model 3D notebook."""

import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, Mock
from zipfile import ZipFile

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]
NOTEBOOK_PATH = REPO_ROOT / 'notebooks' / 'dish-3d-openrouter.ipynb'


class Dish3DNotebookTest(unittest.TestCase):
    def setUp(self):
        self.raw = NOTEBOOK_PATH.read_text(encoding='utf-8')
        self.notebook = json.loads(self.raw)

    def test_notebook_hygiene_and_syntax(self):
        self.assertEqual((self.notebook['nbformat'], self.notebook['nbformat_minor']), (4, 4))
        self.assertNotIn('/kaggle/input/datasets/', self.raw)
        for marker in ('AIza', 'sk-or-v1-', 'hf_'):
            # Avoid matching valid repo/code identifiers; check common token prefixes cleanly
            if marker == 'hf_':
                self.assertNotRegex(self.raw, r'hf_[A-Za-z0-9]{16,}')
            else:
                self.assertNotIn(marker, self.raw)

        for idx, cell in enumerate(self.notebook['cells']):
            if cell['cell_type'] != 'code':
                continue
            self.assertIsNone(cell['execution_count'], f'Cell {idx} execution_count not cleared')
            self.assertEqual(cell['outputs'], [], f'Cell {idx} outputs not cleared')
            source = ''.join(cell['source'])
            ast.parse(source, filename=f'cell_{idx}')

    def test_cell1_and_cell2_offline_fixtures(self):
        scope = {}
        exec(compile(''.join(self.notebook['cells'][1]['source']), 'cell_1', 'exec'), scope)
        exec(compile(''.join(self.notebook['cells'][2]['source']), 'cell_2', 'exec'), scope)

        # Extra regression: 429 retry exhaustion leaks no secret and surfaces HTTP status
        reply_429 = MagicMock()
        reply_429.__enter__.return_value = reply_429
        reply_429.status_code = 429
        post = Mock(return_value=reply_429)
        sleeps = []
        secret = 'sk-secret-do-not-leak'
        with self.assertRaises(scope['DemoError']) as ctx:
            scope['request_image']('google/gemini-3.1-flash-image', secret, post=post, sleep=sleeps.append, max_retries=2)
        self.assertEqual(post.call_count, 3)
        self.assertEqual(sleeps, [2, 4])
        self.assertNotIn(secret, str(ctx.exception))
        self.assertIn('429', str(ctx.exception))

        # Extra regression: write_results sets distinct OpenRouter vs fallback provenance cleanly
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            p1 = root / 'gemini.png'
            p2 = root / 'sd_turbo.png'
            Image.new('RGB', (12, 12), (200, 100, 50)).save(p1)
            Image.new('RGB', (12, 12), (100, 200, 50)).save(p2)
            inputs = {
                'gemini-3.1-flash-image': {
                    'label': 'gemini-3.1-flash-image',
                    'model': 'google/gemini-3.1-flash-image',
                    'image_source': 'openrouter',
                    'image_status': 'success',
                    'image_path': p1,
                },
                'sd-turbo': {
                    'label': 'sd-turbo',
                    'model': 'stabilityai/sd-turbo',
                    'revision': 'b261bac6fd2cf515557d5d0707481eafa0485ec2',
                    'image_source': 'kaggle-open-weights-fallback',
                    'image_status': 'success',
                    'image_path': p2,
                },
            }
            runs_3d = {
                'sd-turbo/triposr': {
                    'input_label': 'sd-turbo',
                    'backend': 'TripoSR',
                    'appearance': 'vertex_color',
                    'status': 'success',
                    'preview_path': root / 'preview.png',
                    'artifact_paths': [],
                }
            }
            manifest_path, zip_path = scope['write_results'](root, inputs, runs_3d, {}, {'a': 'b'})
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            self.assertFalse(manifest['publication_eligible'])
            self.assertEqual(manifest['inputs']['gemini-3.1-flash-image']['image_source'], 'openrouter')
            self.assertEqual(manifest['inputs']['sd-turbo']['image_source'], 'kaggle-open-weights-fallback')
            with ZipFile(zip_path) as zf:
                for entry in manifest['inputs'].values():
                    for art in entry['artifacts']:
                        self.assertEqual(hashlib.sha256(zf.read(art['path'])).hexdigest(), art['sha256'])

    def test_embedded_trellis_scripts_and_astra_fixes(self):
        cell_src = ''.join(self.notebook['cells'][9]['source'])
        tree = ast.parse(cell_src)
        extracted = {}
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for node in tree.body:
                if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                        and isinstance(node.value.func, ast.Attribute)
                        and node.value.func.attr == 'write_text'):
                    target = node.value.func.value
                    if isinstance(target, ast.BinOp) and isinstance(target.right, ast.Constant):
                        name = target.right.value
                        content = node.value.args[0].value
                        ast.parse(content, filename=name)
                        (root / name).write_text(content, encoding='utf-8')
                        extracted[name] = content

            self.assertIn('trellis_native_compat.py', extracted)
            self.assertIn('trellis_native_runner.py', extracted)
            self.assertIn('test_trellis_full_plate.py', extracted)
            self.assertIn('test_trellis_native_compat.py', extracted)

            # Verify Astra P1: broken flex_gemm pure-python fallback removed from install cell
            install_cell = ''.join(self.notebook['cells'][7]['source'])
            self.assertNotIn("if name == 'flex_gemm':", install_cell)
            self.assertIn("if name == 'nvdiffrec':", install_cell)

            # Verify Astra P2: points.trunc().long() and negative-fractional regression test present
            self.assertIn('points.trunc().long()', extracted['trellis_native_compat.py'])
            self.assertNotIn('points.floor().long()', extracted['trellis_native_compat.py'].split("if mode == 'nearest':")[1].split('continue')[0])
            self.assertIn('test_nearest_sampling_truncates_negative_fractional_queries', extracted['test_trellis_native_compat.py'])

            # Verify runner fixes undefined `pinned`
            self.assertIn("pinned = config.get('checkpoint_revisions') or {}", extracted['trellis_native_runner.py'])

            # Execute embedded full_plate + Space gallery CPU test suite directly
            subprocess.run([sys.executable, str(root / 'test_trellis_full_plate.py')], check=True)

    def test_cell3_and_cell5_constraints_and_rembg_isolation(self):
        cell1_src = ''.join(self.notebook['cells'][1]['source'])
        cell3_src = ''.join(self.notebook['cells'][3]['source'])
        cell5_src = ''.join(self.notebook['cells'][5]['source'])

        self.assertIn("'b261bac6fd2cf515557d5d0707481eafa0485ec2'", cell1_src)
        self.assertIn("'a7e52b98680b1ba8ff7bce97c7f9f2e2e5337917'", cell1_src)

        self.assertIn("SCRATCH_ROOT = Path('/tmp/peekaplate_scratch') if ON_KAGGLE else ROOT / '.scratch'", cell3_src)
        self.assertIn("kaggle_constraints.txt", cell3_src)
        for pkg in ('numpy', 'numba'):
            self.assertIn(f"'{pkg}'", cell3_src)
        self.assertIn("'rembg[cpu]==2.0.67'", cell3_src)

        top_imports = {
            alias.name
            for node in ast.parse(cell5_src).body
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertNotIn("rembg", top_imports)
        self.assertIn("run_rembg_cutout.py", cell5_src)
        self.assertNotIn("upcast_vae", cell5_src)
        self.assertIn("StableDiffusionPipeline", cell5_src)
        self.assertIn("safety_checker=None", cell5_src)
        self.assertIn("run_streaming", cell5_src)
        self.assertIn("stats_path", cell5_src)

    def test_prompt_length_and_trellis_only_pipeline(self):
        cell1_scope = {}
        exec(compile(''.join(self.notebook['cells'][1]['source']), 'cell_1', 'exec'), cell1_scope)
        self.assertLessEqual(len(cell1_scope['DISH_PROMPT'].split()), 60)

        self.assertEqual(len(self.notebook['cells']), 16)
        self.assertNotIn('triposr', self.raw.lower())
        self.assertNotIn('hunyuan', self.raw.lower())

        cell9_src = ''.join(self.notebook['cells'][9]['source'])
        cell11_src = ''.join(self.notebook['cells'][11]['source'])
        for tok in ('use_bf16', 'bfloat16', '1536_cascade', 'mesh.simplify(16777216)'):
            self.assertIn(tok, cell9_src)
        for tok in ('MARGIN = 0.0', "'decimation_target': 300000", "'remesh_project': 0.0", '_default_trellis_pipeline_type', "'auto_bf16': True"):
            self.assertIn(tok, cell11_src)

    def test_trellis_notebook_runtime_environment(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / 'TRELLIS.2-native'
            source_dir.mkdir()
            result_dir = root / 'results'
            (result_dir / 'dish').mkdir(parents=True)
            cutout = root / 'cutout.png'
            Image.new('RGBA', (16, 16)).save(cutout)

            def fake_popen(cmd, **kwargs):
                if Path(cmd[1]).name == 'trellis_native_runner.py':
                    folder = Path(cmd[2]).parent
                    (folder / 'run_status.json').write_text('{"status": "success"}')
                    (folder / 'model_revision.json').write_text('{}')
                    (folder / 'generated_original.glb').touch()
                return Mock(wait=Mock(return_value=0))

            fake_subprocess = Mock(wraps=subprocess)
            fake_subprocess.Popen.side_effect = fake_popen
            scope = {}
            exec(compile(''.join(self.notebook['cells'][1]['source']), 'cell_1', 'exec'), scope)
            scope.update(
                os=os,
                shutil=shutil,
                subprocess=fake_subprocess,
                SCRATCH_ROOT=root,
                TRELLIS_SOURCE=source_dir,
                RESULTS_DIR=result_dir,
                PYTHON=Path(sys.executable),
                DINOV3_OK=True,
                TRELLIS_BUILD_OK=True,
                NVDIFFREC_AVAILABLE=True,
                GPU_COUNT=2,
                BUILD_ENV={'TORCH_CUDA_ARCH_LIST': '7.5'},
                HF_TOKEN='fixture-token',
                ACTIVE_LABELS=['dish'],
                image_results={'dish': {
                    'cutout_path': cutout,
                    'image_source': 'fixture',
                    'model': 'fixture',
                    'cutout_metrics': {'plate_preserved': True},
                }},
                REVISIONS={},
                RUNS_3D={},
                run=Mock(),
                validate_glb=Mock(return_value={'has_texture': True}),
                display=Mock(),
                FileLink=Mock(),
            )
            for idx in (9, 11, 13):
                exec(compile(''.join(self.notebook['cells'][idx]['source']), f'cell_{idx}', 'exec'), scope)

            self.assertEqual(scope['RUNS_3D']['dish/trellis2-4b']['status'], 'success')
            prep, generation = fake_subprocess.Popen.call_args_list
            self.assertEqual(Path(prep.args[0][1]).name, 'trellis_prepare_full_plate.py')
            self.assertEqual(Path(generation.args[0][1]).name, 'trellis_native_runner.py')
            prep_env = prep.kwargs['env']
            self.assertEqual(prep_env['PYTHONPATH'], os.pathsep.join(map(str, (source_dir, root))))
            self.assertEqual(prep_env['ATTN_BACKEND'], 'sdpa')
            self.assertEqual(prep_env['SPARSE_CONV_BACKEND'], 'none')
            self.assertEqual(prep_env['TRELLIS_TEST_DEVICE'], 'cuda:0')
            self.assertNotIn('HF_TOKEN', prep_env)
            self.assertEqual(generation.kwargs['env'], {**prep_env, 'HF_TOKEN': 'fixture-token'})
            full_plate_tests, adapter_tests, render = scope['run'].call_args_list
            self.assertEqual(Path(full_plate_tests.args[0][1]).name, 'test_trellis_full_plate.py')
            self.assertEqual(Path(adapter_tests.args[0][1]).name, 'test_trellis_native_compat.py')
            self.assertEqual(full_plate_tests.kwargs['env'], prep_env)
            self.assertEqual(adapter_tests.kwargs['env'], prep_env)
            self.assertEqual(Path(render.args[0][1]).name, 'trellis_native_space_tools.py')
            self.assertEqual(render.kwargs['env'], {**prep_env, 'CUDA_VISIBLE_DEVICES': '1'})

    def test_trellis_revision_pinning_and_bounded_timeout(self):
        cell1_src = ''.join(self.notebook['cells'][1]['source'])
        cell13_src = ''.join(self.notebook['cells'][9]['source'])
        cell15_src = ''.join(self.notebook['cells'][11]['source'])

        scope = {}
        exec(compile(cell1_src, 'cell_1', 'exec'), scope)
        self.assertEqual(scope['TRELLIS_MODEL_REPO'], 'microsoft/TRELLIS.2-4B')
        self.assertEqual(scope['TRELLIS_MODEL_REVISION'], 'af44b45f2e35a493886929c6d786e563ec68364d')

        self.assertIn(
            "revision = config.get('model_revision') or pinned.get(model_repo) or api.model_info(model_repo, token=token).sha",
            cell13_src.replace("\\'", "'"),
        )
        self.assertIn("checkpoint_revisions = {\n    DINOV3_REPO: DINOV3_REVISION,\n    TRELLIS_MODEL_REPO: TRELLIS_MODEL_REVISION,\n}", cell15_src)

        # Extract _run_logged_bounded, trellis_generation, SETTINGS, MARGIN, MAX_SIZE from Cell 15 AST
        tree15 = ast.parse(cell15_src, filename='cell_15')
        helper_nodes = []
        for node in tree15.body:
            if isinstance(node, (ast.Import, ast.FunctionDef)):
                helper_nodes.append(node)
            elif isinstance(node, ast.Assign):
                target_ids = {t.id for t in node.targets if isinstance(t, ast.Name)}
                if target_ids & {'SEED', 'MARGIN', 'MAX_SIZE', 'SETTINGS', 'TRELLIS_WORKERS'}:
                    helper_nodes.append(node)

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_path = root / 'dish.png'
            Image.new('RGB', (16, 16), (120, 80, 40)).save(img_path)

            captured_cmds = []

            class FakeProcOk:
                pid = 99999
                def wait(self, timeout=None):
                    captured_cmds.append(timeout)
                    return 0

            class FakeProcTimeout:
                pid = 88888
                def __init__(self):
                    self.killed = False
                def wait(self, timeout=None):
                    if self.killed:
                        return -9
                    raise subprocess.TimeoutExpired(['trellis'], timeout or 1)
                def kill(self):
                    self.killed = True

            # Case 1: prepare succeeds (rc=0) and captures generation_config.json with pinned revisions; runner times out -> DemoError
            call_idx = {'n': 0}
            def fake_popen(cmd, **kwargs):
                call_idx['n'] += 1
                if call_idx['n'] == 1:
                    self.assertTrue(kwargs.get('start_new_session'))
                    return FakeProcOk()
                return FakeProcTimeout()

            fake_sub = MagicMock(wraps=subprocess)
            fake_sub.Popen = fake_popen
            fake_sub.TimeoutExpired = subprocess.TimeoutExpired
            fake_sub.SubprocessError = subprocess.SubprocessError

            exec_ns = {
                **scope,
                'os': __import__('os'),
                'subprocess': fake_sub,
                'PYTHON': Path(sys.executable),
                'SCRATCH_ROOT': root / 'scratch',
                'TRELLIS_SOURCE': root / 'trellis_src',
                'RUNTIME_ENV': {},
            }
            exec(compile(ast.Module(body=helper_nodes, type_ignores=[]), 'cell15_helpers', 'exec'), exec_ns)

            work_dir = root / 'trellis_run'
            seeded = {
                scope['DINOV3_REPO']: scope['DINOV3_REVISION'],
                scope['TRELLIS_MODEL_REPO']: scope['TRELLIS_MODEL_REVISION'],
            }
            with self.assertRaises(scope['DemoError']) as ctx:
                exec_ns['trellis_generation'](work_dir, img_path, {}, seeded)
            self.assertIn('timed out', str(ctx.exception))

            gen_cfg = json.loads((work_dir / 'generation_config.json').read_text(encoding='utf-8'))
            self.assertEqual(gen_cfg['model_revision'], 'af44b45f2e35a493886929c6d786e563ec68364d')
            self.assertEqual(gen_cfg['checkpoint_revisions'][scope['DINOV3_REPO']], scope['DINOV3_REVISION'])

            # Confirm failure status can still be packaged into manifest via write_results
            runs_3d = {
                'sd-turbo/trellis2-4b': {
                    'input_label': 'sd-turbo',
                    'backend': 'TRELLIS.2-4B',
                    'appearance': 'pbr_texture',
                    'status': 'failed',
                    'error': str(ctx.exception),
                    'artifact_paths': [],
                }
            }
            manifest_path, _ = scope['write_results'](root / 'out', {}, runs_3d, exec_ns['SETTINGS'], {})
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            self.assertFalse(manifest['publication_eligible'])
            self.assertEqual(manifest['runs_3d']['sd-turbo/trellis2-4b']['status'], 'failed')

    def test_discover_user_dish_images_and_gpu_flexibility(self):
        cell1_src = ''.join(self.notebook['cells'][1]['source'])
        cell3_src = ''.join(self.notebook['cells'][3]['source'])
        cell5_src = ''.join(self.notebook['cells'][5]['source'])
        cell11_src = ''.join(self.notebook['cells'][7]['source'])
        cell17_src = ''.join(self.notebook['cells'][13]['source'])
        cell19_src = ''.join(self.notebook['cells'][15]['source'])

        scope = {}
        exec(compile(cell1_src, 'cell_1', 'exec'), scope)
        discover = scope['discover_user_dish_images']

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            empty_in = root / 'empty_input'
            empty_in.mkdir()
            self.assertEqual(discover(root / 'out_empty', input_root=empty_in), {})

            ds_in = root / 'input' / 'peekaplate-dish-test-photos'
            ds_in.mkdir(parents=True)
            names = ['01_pizza.png', '02_tteokbokki.jpg', '03_kimchi.webp', '04_gimbap.png', '05_extra.png']
            for idx, name in enumerate(names):
                Image.new('RGB', (20 + idx * 4, 24), (40 * idx, 120, 200)).save(ds_in / name)
            (ds_in / 'dataset-metadata.json').write_text('{"ignored": true}', encoding='utf-8')
            (ds_in / '.hidden.png').write_text('ignored', encoding='utf-8')

            out_dir = root / 'results'
            found = discover(out_dir, input_root=root / 'input')
            self.assertEqual(list(found.keys()), ['01_pizza', '02_tteokbokki', '03_kimchi', '04_gimbap'])
            for label, entry in found.items():
                self.assertEqual(entry['image_source'], 'user-uploaded-dataset')
                self.assertEqual(entry['image_status'], 'success')
                self.assertTrue(entry['image_path'].is_file())

            manifest_path, zip_path = scope['write_results'](out_dir, found, {}, {}, {'a': 'b'})
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            self.assertFalse(manifest['publication_eligible'])
            self.assertEqual(len(manifest['inputs']), 4)
            with ZipFile(zip_path) as zf:
                for entry in manifest['inputs'].values():
                    for art in entry['artifacts']:
                        self.assertEqual(hashlib.sha256(zf.read(art['path'])).hexdigest(), art['sha256'])

        # Flexible 1-or-2 GPU execution and dynamic CUDA arch detection
        self.assertNotIn('Select the Kaggle T4 x2 accelerator for this dual-GPU demo.', cell3_src)
        self.assertIn('GPU_COUNT = torch.cuda.device_count()', cell3_src)
        self.assertIn('MAX_GPU_WORKERS = max(1, min(GPU_COUNT, 2))', cell3_src)
        self.assertIn("('scipy', 'scipy')", cell3_src)
        self.assertIn('TORCH_CUDA_ARCH_LIST', cell11_src)
        self.assertIn('GPU_COUNT > 1', cell17_src)

        # Validate embedded worker scripts via AST and required quality upgrades
        def extract_str_assign(cell_src, var_name):
            tree = ast.parse(cell_src)
            for node in tree.body:
                if (isinstance(node, ast.Assign) and len(node.targets) == 1
                        and getattr(node.targets[0], 'id', None) == var_name):
                    content = node.value.value
                    ast.parse(content, filename=var_name)
                    return content
            raise AssertionError(f'Missing string assignment {var_name}')

        cutout_code = extract_str_assign(cell5_src, 'cutout_worker_code')
        for token in ('birefnet-general-lite', 'isnet-general-use', 'u2net', 'binary_fill_holes', 'fg_coverage_pct', 'edge_touch_sides'):
            self.assertIn(token, cutout_code)
        self.assertIn('discover_user_dish_images(RESULTS_DIR)', cell5_src)
        self.assertIn('MAX_GPU_WORKERS', cell5_src)

        ast.parse(cell19_src, filename='cell_15')
        for token in (
            '1.0 / 2.2',
            'Cutout (Plate + Food)',
            'make_checkerboard',
            'render_hf_trellis_modes',
            'hf_modes_sheet.png',
            'interactive_3d_studio.html',
            'comparison_viewer.html',
        ):
            self.assertIn(token, cell19_src)

        # Verify baseline studio template preserves Three.js version and updated multi-model notebooks match dish_3d_studio identically
        from peekaplate_processing.dish_3d_studio import THREE_VERSION, _STUDIO_HTML_TEMPLATE
        tree19_chk = ast.parse(cell19_src, filename='cell_19_studio')
        nb_tpl = next(
            node.value.value
            for node in tree19_chk.body
            if isinstance(node, ast.Assign)
            and getattr(node.targets[0], 'id', None) == 'STUDIO_HTML_TEMPLATE'
        )
        self.assertIn('__DEMO_BADGE__', nb_tpl)
        self.assertIn(f"STUDIO_THREE_VERSION = '{THREE_VERSION}'", cell19_src)
        for mm_name in ('dish-3d-multi-model-bench-a.ipynb', 'dish-3d-multi-model-bench-b.ipynb'):
            mm_path = REPO_ROOT / 'notebooks' / mm_name
            if mm_path.is_file():
                mm_nb = json.loads(mm_path.read_text(encoding='utf-8'))
                mm_tree = ast.parse(''.join(mm_nb['cells'][-1]['source']), filename=f'{mm_name}:last')
                mm_tpl = next(
                    node.value.value
                    for node in mm_tree.body
                    if isinstance(node, ast.Assign)
                    and getattr(node.targets[0], 'id', None) == 'STUDIO_HTML_TEMPLATE'
                )
                self.assertEqual(mm_tpl, _STUDIO_HTML_TEMPLATE)

        # Execute Cell 19 studio helpers + write_results together and verify both HTML files land in manifest & ZIP
        studio_nodes = [
            node for node in tree19_chk.body
            if (isinstance(node, ast.Assign) and any(
                getattr(t, 'id', None) in ('STUDIO_THREE_VERSION', 'STUDIO_THREE_CDN_BASE', 'STUDIO_HTML_TEMPLATE')
                for t in node.targets
            ))
            or (isinstance(node, ast.FunctionDef) and node.name in (
                '_studio_encode_png_data_url', '_build_notebook_studio_payload', '_render_notebook_studio'
            ))
        ]
        self.assertEqual(len(studio_nodes), 6)
        with TemporaryDirectory() as tmp19:
            res19 = Path(tmp19) / 'results'
            dish_dir = res19 / '01_pizza'
            dish_dir.mkdir(parents=True)
            Image.new('RGB', (32, 32), (210, 120, 40)).save(dish_dir / 'input_image.png')
            Image.new('RGBA', (32, 32), (210, 120, 40, 255)).save(dish_dir / 'cutout_rgba.png')
            Image.new('RGB', (32, 32), (100, 100, 110)).save(dish_dir / 'trellis2_4b_hf_modes.png')
            (dish_dir / 'trellis2_4b.glb').write_bytes(b'glTF-raw')
            (dish_dir / 'trellis2_4b_mobile.glb').write_bytes(b'glTF-mob')
            jm19 = scope['build_job_manifest']('01_pizza', {
                'image_path': dish_dir / 'input_image.png',
                'image_source': 'user-uploaded-dataset',
                'size': [32, 32],
                'source_sha256': 'b' * 64,
            }, {'trellis_model': scope['TRELLIS_MODEL_REVISION']})
            jm19_path = dish_dir / 'job_manifest.json'
            jm19_path.write_text(json.dumps(jm19), encoding='utf-8')
            in19 = {
                '01_pizza': {
                    'label': '01_pizza',
                    'model': 'user-photo-upload',
                    'image_status': 'success',
                    'image_source': 'user-uploaded-dataset',
                    'size': [32, 32],
                    'source_sha256': 'b' * 64,
                    'image_path': dish_dir / 'input_image.png',
                    'cutout_path': dish_dir / 'cutout_rgba.png',
                    'job_manifest_path': jm19_path,
                    'cutout_metrics': {'plate_preserved': True, 'plate_added_pct': 10.0, 'plate_method': 'grounding_dino_sam', 'fg_coverage_pct': 60.0},
                },
                '00_failed': {'label': '00_failed', 'image_status': 'failed'},
            }
            runs19 = {
                '01_pizza/trellis2-4b': {
                    'input_label': '01_pizza',
                    'backend': 'TRELLIS.2-4B',
                    'appearance': 'pbr_texture',
                    'device': 'cuda:0+cuda:1',
                    'status': 'success',
                    'metrics': {'vertices': 50000, 'faces': 100000, 'bytes': 8, 'has_texture': True},
                    'mobile_metrics': {'vertices': 17000, 'faces': 33000, 'bytes': 8},
                    'mobile_glb_path': dish_dir / 'trellis2_4b_mobile.glb',
                    'hf_modes_path': dish_dir / 'trellis2_4b_hf_modes.png',
                    'artifact_paths': [dish_dir / 'trellis2_4b.glb', dish_dir / 'trellis2_4b_mobile.glb', dish_dir / 'trellis2_4b_hf_modes.png'],
                }
            }
            ns19 = {
                **scope,
                'ACTIVE_LABELS': ['01_pizza', '00_failed'],
                'RESULTS_DIR': res19,
                'image_results': in19,
                'RUNS_3D': runs19,
                'ImageOps': __import__('PIL.ImageOps', fromlist=['ImageOps']),
                'html_lib': __import__('html'),
                're': __import__('re'),
            }
            exec(compile(ast.Module(body=studio_nodes, type_ignores=[]), 'cell_19_exec', 'exec'), ns19)
            http_p = ns19['_build_notebook_studio_payload'](embed_mobile_assets=False)
            self.assertEqual([d['label'] for d in http_p['dishes']], ['01_pizza'])
            vp19 = res19 / 'comparison_viewer.html'
            sp19 = res19 / 'interactive_3d_studio.html'
            vp19.write_text(ns19['_render_notebook_studio'](http_p), encoding='utf-8')
            sp19.write_text(ns19['_render_notebook_studio'](ns19['_build_notebook_studio_payload'](embed_mobile_assets=True)), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible=false'):
                ns19['_render_notebook_studio']({'publication_eligible': True})
            m19_path, z19_path = scope['write_results'](res19, {'01_pizza': in19['01_pizza']}, runs19, {}, {}, [vp19, sp19])
            with ZipFile(z19_path) as zf19:
                self.assertIn('comparison_viewer.html', zf19.namelist())
                self.assertIn('interactive_3d_studio.html', zf19.namelist())

    def test_v10_plate_preservation_and_docker_contract(self):
        cell1_src = ''.join(self.notebook['cells'][1]['source'])
        cell3_src = ''.join(self.notebook['cells'][3]['source'])
        cell5_src = ''.join(self.notebook['cells'][5]['source'])
        cell19_src = ''.join(self.notebook['cells'][15]['source'])

        scope = {}
        exec(compile(cell1_src, 'cell_1', 'exec'), scope)
        self.assertEqual(scope['GROUNDING_DINO_REVISION'], 'a2bb814dd30d776dcf7e30523b00659f4f141c71')
        self.assertEqual(scope['SAM_REVISION'], '70c1a07f894ebb5b307fd9eaaee97b9dfc16068f')
        self.assertIn("'grounding_dino': GROUNDING_DINO_REVISION", cell3_src)
        self.assertIn("'sam_vit_base': SAM_REVISION", cell3_src)

        # Verify sibling _mask pairing + immutable Docker job_manifest -> worker_entrypoint -> worker_output contract
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds = root / 'input' / 'peekaplate-dish-test-photos'
            ds.mkdir(parents=True)
            Image.new('RGB', (32, 32), (220, 140, 40)).save(ds / '01_pizza.png')
            Image.new('L', (32, 32), 255).save(ds / '01_pizza_mask.png')
            Image.new('RGB', (40, 28), (180, 50, 30)).save(ds / '02_tteokbokki.png')

            out_dir = root / 'results'
            found = scope['discover_user_dish_images'](out_dir, input_root=root / 'input')
            self.assertEqual(list(found.keys()), ['01_pizza', '02_tteokbokki'])
            self.assertIsNotNone(found['01_pizza']['reviewed_mask_path'])
            self.assertIsNone(found['02_tteokbokki']['reviewed_mask_path'])
            self.assertEqual(len(found['01_pizza']['source_sha256']), 64)

            revs = {
                'trellis_model': scope['TRELLIS_MODEL_REVISION'],
                'grounding_dino': scope['GROUNDING_DINO_REVISION'],
                'sam_vit_base': scope['SAM_REVISION'],
                'input_01_pizza': 'user-uploaded-dataset',
            }
            jm = scope['build_job_manifest']('01_pizza', found['01_pizza'], revs)
            self.assertFalse(jm['publication_eligible'])
            self.assertEqual(jm['plate_preservation_mode'], 'preserve_plate')
            self.assertEqual(jm['reviewed_mask'], '01_pizza_mask.png')
            self.assertNotIn('input_01_pizza', jm['pinned_revisions'])
            self.assertEqual(jm['export_profiles']['raw']['trellis_decimation_target'], 300000)
            jm_path = out_dir / '01_pizza' / 'job_manifest.json'
            jm_path.write_text(json.dumps(jm, indent=2), encoding='utf-8')
            found['01_pizza']['job_manifest_path'] = jm_path

            # Dummy cutout + raw/mobile TRELLIS GLBs
            cut_path = out_dir / '01_pizza' / 'cutout_rgba.png'
            Image.new('RGBA', (32, 32), (220, 140, 40, 255)).save(cut_path)
            found['01_pizza']['cutout_path'] = cut_path
            found['01_pizza']['cutout_metrics'] = {'plate_preserved': True, 'plate_added_pct': 18.5}

            raw_glb = out_dir / '01_pizza' / 'trellis2_4b.glb'
            mob_glb = out_dir / '01_pizza' / 'trellis2_4b_mobile.glb'
            raw_glb.write_bytes(b'glTF-raw-stub')
            mob_glb.write_bytes(b'glTF-mob-stub')
            runs = {
                '01_pizza/trellis2-4b': {
                    'input_label': '01_pizza',
                    'backend': 'TRELLIS.2-4B',
                    'appearance': 'pbr_texture',
                    'status': 'success',
                    'metrics': {'vertices': 50000, 'faces': 100000, 'has_texture': True, 'elapsed_seconds': 9.1},
                    'mobile_metrics': {'vertices': 17000, 'faces': 34000, 'has_texture': True},
                    'mobile_glb_path': mob_glb,
                    'artifact_paths': [raw_glb, mob_glb],
                }
            }
            receipt = scope['build_worker_receipt'](jm, found['01_pizza'], runs, out_dir)
            self.assertFalse(receipt['publication_eligible'])
            self.assertTrue(receipt['plate_preserved'])
            self.assertEqual(receipt['models']['TRELLIS.2-4B']['mobile_glb']['faces'], 34000)

            manifest_path, _ = scope['write_results'](out_dir, found, runs, {}, revs)
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            self.assertFalse(manifest['publication_eligible'])
            self.assertEqual(manifest['demo_label'], scope['DEMO_TRUTHFUL_LABEL'])
            self.assertEqual(manifest['plate_preservation_mode'], 'preserve_plate')

            # Extract and run worker_entrypoint_template offline dry-run & tamper check
            tree19 = ast.parse(cell19_src, filename='cell_19')
            entrypoint_src = next(
                node.value.value
                for node in tree19.body
                if isinstance(node, ast.Assign)
                and getattr(node.targets[0], 'id', None) == 'worker_entrypoint_template'
            )
            ast.parse(entrypoint_src, filename='worker_entrypoint.py')
            ep_ns = {}
            exec(compile(entrypoint_src, 'worker_entrypoint.py', 'exec'), ep_ns)
            dry_receipt = ep_ns['run_worker'](jm_path, out_dir / '01_pizza', out_dir / 'docker_dry', dry_run=True)
            self.assertTrue(dry_receipt.is_file())
            dry_data = json.loads(dry_receipt.read_text(encoding='utf-8'))
            self.assertEqual(dry_data['status'], 'validated_dry_run')
            self.assertFalse(dry_data['publication_eligible'])

            # Tampering input bytes must fail source SHA-256 verification
            (out_dir / '01_pizza' / 'input_image.png').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                ep_ns['run_worker'](jm_path, out_dir / '01_pizza', out_dir / 'docker_fail', dry_run=True)

            # Missing, null, empty, or malformed source_sha256 must fail closed (never skip digest verification)
            for bad_sha in (None, '', 'deadbeef', 'A' * 64):
                bad_manifest = dict(jm)
                if bad_sha is None:
                    bad_manifest.pop('source_sha256', None)
                else:
                    bad_manifest['source_sha256'] = bad_sha
                bad_jm_path = out_dir / '01_pizza' / 'bad_manifest.json'
                bad_jm_path.write_text(json.dumps(bad_manifest), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'valid 64-char'):
                    ep_ns['run_worker'](bad_jm_path, out_dir / '01_pizza', out_dir / 'docker_fail_bad', dry_run=True)

        # Verify embedded GPU worker scripts for plate segmentation, mobile GLBs, padding & Docker template
        def extract_str_assign(src_text, var_name):
            tree = ast.parse(src_text)
            for node in tree.body:
                if (isinstance(node, ast.Assign) and len(node.targets) == 1
                        and getattr(node.targets[0], 'id', None) == var_name):
                    val = node.value.value
                    ast.parse(val, filename=var_name)
                    return val
            raise AssertionError(f'Missing {var_name}')

        cutout_code = extract_str_assign(cell5_src, 'cutout_worker_code')
        for token in (
            'post_process_grounded_object_detection',
            'inspect.signature',
            'count_non_food_corners',
            'sam_ring_points',
            'plate_preserved',
            'plate_added_pct',
        ):
            self.assertIn(token, cutout_code)

        for token in ('Dockerfile.worker.template', 'requirements.lock.txt', 'pinned_revisions.json', 'worker_output.json'):
            self.assertIn(token, cell19_src)

    def test_cutout_inset_corners_and_cuda12_guards(self):
        cell5_src = ''.join(self.notebook['cells'][5]['source'])
        cell15_out_src = ''.join(self.notebook['cells'][15]['source'])

        def extract_str_assign(src_text, var_name):
            tree = ast.parse(src_text)
            for node in tree.body:
                if (isinstance(node, ast.Assign) and len(node.targets) == 1
                        and getattr(node.targets[0], 'id', None) == var_name):
                    val = node.value.value
                    ast.parse(val, filename=var_name)
                    return val
            raise AssertionError(f'Missing {var_name}')

        # Verify upgraded Cell 5 plate detection & Cell 15 TRELLIS-only & CUDA-matched Docker guards
        cutout_code = extract_str_assign(cell5_src, 'cutout_worker_code')
        for token in (
            'PLATE_PROMPT_PASSES',
            'count_top_non_food_corners',
            'sam_vessel_points',
            'ring_contact',
            'bbox_fill',
        ):
            self.assertIn(token, cutout_code)

        self.assertIn("('trellis2-4b', 'TRELLIS.2-4B - HF 4-Mode Strip')", cell15_out_src)
        self.assertIn('--extra-index-url https://download.pytorch.org/whl/', cell15_out_src)

        # Verify Cell 7/11 skips TRELLIS cleanly on CUDA 13.0 ("latest") even when DINOV3_OK=True
        cell7_src = ''.join(self.notebook['cells'][7]['source'])
        cell11_src = ''.join(self.notebook['cells'][11]['source'])
        self.assertNotIn("Use a CUDA 12.x Kaggle image for T4.", cell7_src)
        self.assertIn("TRELLIS_SKIP_REASON = 'requires_cuda_12_toolchain'", cell7_src)
        self.assertIn('TRELLIS_SKIP_REASON', cell11_src)

        # Verify Cell 5 inset-corner guard catches tabletop leaks with a 10px transparent outer border
        import numpy as np

        cut_tree = ast.parse(cutout_code, filename='cutout_worker_code')
        corner_fns = [
            node for node in cut_tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name in ('_corner_block_pair', 'count_non_food_corners', 'count_top_non_food_corners')
        ]
        self.assertEqual(len(corner_fns), 3)
        c_ns = {'np': np}
        exec(compile(ast.Module(body=corner_fns, type_ignores=[]), 'corner_fns', 'exec'), c_ns)

        food = np.zeros((200, 300), dtype=bool)
        food[45:155, 65:235] = True

        # Tabletop rectangle with a 10px outer border hole must still be caught at inset corners
        bg_leak = np.zeros((200, 300), dtype=bool)
        bg_leak[10:190, 10:290] = True
        self.assertEqual(c_ns['count_non_food_corners'](bg_leak, food), 4)
        self.assertEqual(c_ns['count_top_non_food_corners'](bg_leak, food), 2)

        # Wide centered oval bowl touching left/right mid-edges keeps all corners clear
        yy, xx = np.ogrid[:200, :300]
        oval_bowl = (((yy - 110.0) / 80.0) ** 2 + ((xx - 150.0) / 149.0) ** 2) <= 1.0
        self.assertEqual(c_ns['count_non_food_corners'](oval_bowl, food), 0)
        self.assertEqual(c_ns['count_top_non_food_corners'](oval_bowl, food), 0)

    def test_trellis_skips_food_only_cutout(self):
        with TemporaryDirectory() as tmp:
            scope = self.trellis_cell_scope(Path(tmp), plate_preserved=False)
            exec(''.join(self.notebook['cells'][11]['source']), scope)

            record = scope['RUNS_3D']['dish/trellis2-4b']
            scope['subprocess'].Popen.assert_not_called()
            self.assertEqual(record['status'], 'skipped')
            self.assertIn('plate_preserved is false', record['error'])
            self.assertEqual(record['artifact_paths'], [])

    def test_trellis_retry_collects_only_current_mobile_export(self):
        with TemporaryDirectory() as tmp:
            scope = self.trellis_cell_scope(Path(tmp), plate_preserved=True)
            cell = ''.join(self.notebook['cells'][11]['source'])
            attempts = []

            def run_process(cmd, **kwargs):
                if Path(cmd[1]).name == 'trellis_native_runner.py':
                    config = json.loads(Path(cmd[2]).read_text(encoding='utf-8'))
                    folder = Path(config['output_dir'])
                    attempts.append(folder)
                    (folder / 'run_status.json').write_text('{"status":"success"}', encoding='utf-8')
                    (folder / 'model_revision.json').write_text('{}', encoding='utf-8')
                    (folder / 'generated_original.glb').write_bytes(b'raw')
                    if len(attempts) == 1:
                        (folder / 'generated_mobile.glb').write_bytes(b'first attempt mobile')
                return Mock(wait=Mock(return_value=0))

            scope['subprocess'].Popen.side_effect = run_process
            exec(cell, scope)
            key = 'dish/trellis2-4b'
            self.assertIn('mobile_glb_path', scope['RUNS_3D'][key])

            exec(cell, scope)
            record = scope['RUNS_3D'][key]
            self.assertEqual(record['status'], 'success')
            self.assertNotIn('mobile_glb_path', record)
            self.assertNotIn('mobile_metrics', record)
            self.assertEqual(record['artifact_paths'], [scope['RESULTS_DIR'] / 'dish' / 'trellis2_4b.glb'])
            self.assertNotEqual(attempts[0], attempts[1])
            self.assertEqual(scope['TRELLIS_WORKERS']['dish'], attempts[1])

    def trellis_cell_scope(self, root, *, plate_preserved):
        cutout = root / 'cutout.png'
        image = Image.new('RGBA', (16, 16))
        image.paste((120, 80, 40, 255), (2, 2, 14, 14))
        image.save(cutout)
        results = root / 'results'
        (results / 'dish').mkdir(parents=True)
        scope = {}
        exec(''.join(self.notebook['cells'][1]['source']), scope)
        scope.update(
            ACTIVE_LABELS=['dish'],
            image_results={'dish': {
                'image_source': 'fixture',
                'model': None,
                'cutout_path': cutout,
                'cutout_metrics': {'plate_preserved': plate_preserved},
            }},
            DINOV3_OK=True,
            TRELLIS_BUILD_OK=True,
            SCRATCH_ROOT=root / 'scratch',
            RESULTS_DIR=results,
            RUNTIME_ENV={},
            HF_TOKEN=None,
            PYTHON=Path(sys.executable),
            TRELLIS_SOURCE=root / 'trellis',
            RUNS_3D={},
            REVISIONS={},
            subprocess=Mock(Popen=Mock(return_value=Mock(wait=Mock(return_value=0)))),
            shutil=shutil,
            validate_glb=Mock(return_value={'has_texture': True}),
            display=Mock(),
            FileLink=Mock(),
        )
        return scope

    def test_v21_trellis_cutout_remesh_and_dual_gpu_sharding(self):
        cell13_src = ''.join(self.notebook['cells'][9]['source'])
        cell15_src = ''.join(self.notebook['cells'][11]['source'])

        # Extract Cell 9 scripts by target filename
        tree13 = ast.parse(cell13_src, filename='cell_9')
        scripts = {}
        for node in tree13.body:
            if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                    and isinstance(node.value.func, ast.Attribute)
                    and node.value.func.attr == 'write_text'):
                name = node.value.func.value.right.value
                content = node.value.args[0].value
                ast.parse(content, filename=name)
                scripts[name] = content

        # 1. Cell 11 passes cutout_path (never image_path) into trellis_generation, with HF Space settings + mobile + 1200s bound
        self.assertIn("cutout_input = in_entry.get('cutout_path')", cell15_src)
        self.assertIn("trellis_generation(work_folder, cutout_input, runtime, checkpoint_revisions)", cell15_src)
        self.assertNotIn("trellis_generation(work_folder, in_entry['image_path']", cell15_src)
        for token in (
            'MARGIN = 0.0',
            '_default_trellis_pipeline_type',
            "'pipeline_type': _default_trellis_pipeline_type()",
            "'auto_bf16': True",
            "'max_num_tokens': 49152",
            "'texture_size': 2048",
            "'decimation_target': 300000",
            "'remesh': True",
            "'remesh_project': 0.0",
            "'mobile_decimation_target': 34000",
            "'crop_to_alpha': True",
            "'require_alpha': True",
            "'use_dual_gpu_sharding': True",
            "'--crop-to-alpha'",
            "'--require-alpha'",
            "'trellis2_4b_mobile.glb'",
            "'cuda:0+cuda:1'",
            'timeout=1200',
            '_sanitize_trellis_line',
        ):
            self.assertIn(token, cell15_src)

        # 2. Runner loads roles stage-by-stage (_release_model), supports 1536_cascade/1024_cascade/512 & auto_bf16, puts tex_slat_decoder on cuda:1
        runner_src = scripts['trellis_native_runner.py']
        for token in (
            'DualGpuShardedFlowModel',
            'move_to_device',
            'run_pipeline_staged',
            '_release_model',
            '[trellis:stage]',
            'use_bf16',
            '1536_cascade',
            'shape_slat_flow_model_1024',
            'tex_slat_flow_model_512',
            'decode_tex_slat_gpu1',
            'torch.OutOfMemoryError',
            'mesh.simplify(16777216)',
            'generated_mobile.glb',
            'o_voxel.postprocess.to_glb',
            'encoder([image])',
        ):
            self.assertIn(token, runner_src)
        self.assertNotIn('encoder(image)', runner_src)
        self.assertNotIn('for role in required:\n            loaded_models[role] = load_role(role)', runner_src)
        self.assertIn('q_chunk = min(1024, max(256, 8_000_000 // kv_len))', scripts['trellis_native_compat.py'])

        # 3. Execute updated test_trellis_full_plate.py (including crop_to_alpha + require_alpha fail-closed tests)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('trellis_prepare_full_plate.py', 'trellis_native_space_tools.py', 'test_trellis_full_plate.py'):
                (root / name).write_text(scripts[name], encoding='utf-8')
            proc = subprocess.run(
                [sys.executable, str(root / 'test_trellis_full_plate.py')],
                capture_output=True, text=True, check=True,
            )
            self.assertIn('test_crop_to_alpha_centers_foreground_and_preserves_translucent_rim', proc.stderr + proc.stdout)
            self.assertIn('test_require_alpha_rejects_unmasked_opaque_image', proc.stderr + proc.stdout)

        # 4. Pure-Python mock test on move_to_device extracted from trellis_native_compat.py (works without torch installed locally)
        compat_tree = ast.parse(scripts['trellis_native_compat.py'], filename='trellis_native_compat.py')
        move_fn = next(
            n for n in compat_tree.body
            if isinstance(n, ast.FunctionDef) and n.name == 'move_to_device'
        )
        class FakeTensor:
            def __init__(self, device='cuda:0'):
                self.device = device
            def to(self, dev):
                return FakeTensor(dev)
        class FakeSparse:
            def __init__(self, feats, coords, shape=None, scale=None, spatial_cache=None):
                self.feats = feats
                self.coords = coords
                self._shape = shape
                self._scale = scale
                self._spatial_cache = {} if spatial_cache is None else spatial_cache
        class FakeVarLen:
            def __init__(self, feats, layout=None):
                self.feats = feats
                self.layout = layout
                self._cache = {}
        fake_torch = type('FakeTorch', (), {'Tensor': FakeTensor})
        mv_ns = {'torch': fake_torch}
        exec(compile(ast.Module(body=[move_fn], type_ignores=[]), 'move_to_device', 'exec'), mv_ns)
        mv = mv_ns['move_to_device']

        sp_orig = FakeSparse(FakeTensor('cuda:0'), FakeTensor('cuda:0'), shape=(1, 8), scale=(1, 1, 1))
        sp_orig._spatial_cache['layout'] = 'stale_cuda0'
        sp_moved = mv(sp_orig, 'cuda:1')
        self.assertEqual(sp_moved.feats.device, 'cuda:1')
        self.assertEqual(sp_moved.coords.device, 'cuda:1')
        self.assertEqual(sp_moved._spatial_cache, {})
        vl_orig = FakeVarLen(FakeTensor('cuda:0'), layout=[slice(0, 4)])
        vl_orig._cache['seqlen'] = 'stale_cuda0'
        vl_moved = mv([vl_orig], 'cuda:1')
        self.assertEqual(vl_moved[0].feats.device, 'cuda:1')
        self.assertEqual(vl_moved[0]._cache, {})
        self.assertEqual(vl_moved[0].layout, [slice(0, 4)])

        test_tree = ast.parse(scripts['test_trellis_native_compat.py'], filename='test_trellis_native_compat.py')
        seq_cls = next(
            n for n in test_tree.body
            if isinstance(n, ast.ClassDef) and n.name == 'Sequence'
        )
        seq_ns = {}
        exec(compile(ast.Module(body=[seq_cls], type_ignores=[]), 'Sequence', 'exec'), seq_ns)
        Seq = seq_ns['Sequence']
        seq_orig = Seq(FakeTensor('cuda:0'), [2, 2])
        seq_orig._cache['stale'] = 'cuda0'
        seq_moved = mv(seq_orig, 'cuda:1')
        self.assertEqual(seq_moved.feats.device, 'cuda:1')
        self.assertEqual(seq_moved._cache, {})
        self.assertEqual(seq_moved.layout, [slice(0, 2), slice(2, 4)])

        # 5. Real subprocess check on Cell 15 _run_logged_bounded streaming + redaction
        import contextlib, io as _stdio, os as _os, re as _re_mod, signal as _sig, threading as _thr
        tree15 = ast.parse(cell15_src, filename='cell_15')
        stream_nodes = [
            n for n in tree15.body
            if isinstance(n, ast.FunctionDef) and n.name in ('_sanitize_trellis_line', '_run_logged_bounded')
        ]
        self.assertEqual(len(stream_nodes), 2)
        stream_ns = {
            'DemoError': RuntimeError,
            'os': _os,
            'subprocess': subprocess,
            '_io': _stdio,
            '_re': _re_mod,
            '_signal': _sig,
            '_sys': sys,
            '_threading': _thr,
        }
        exec(compile(ast.Module(body=stream_nodes, type_ignores=[]), 'cell15_stream', 'exec'), stream_ns)
        with TemporaryDirectory() as tmp15:
            log_file = Path(tmp15) / 'sub.log'
            captured = _stdio.StringIO()
            with log_file.open('w', encoding='utf-8') as lf, contextlib.redirect_stdout(captured):
                rc = stream_ns['_run_logged_bounded'](
                    [sys.executable, '-c', 'print("debug detail"); print("[trellis:stage] 1/6 dinov3_cond hf_secretAbc12345")'],
                    _os.environ.copy(), lf, timeout=30, label='stream check',
                )
            self.assertEqual(rc, 0)
            self.assertIn('[trellis:stage] 1/6 dinov3_cond [REDACTED_TOKEN]', captured.getvalue())
            self.assertNotIn('debug detail', captured.getvalue())
            self.assertIn('debug detail', log_file.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
