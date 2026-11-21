"""Offline verification suite for the Kaggle 2xT4 multi-model 3D notebook."""

import ast
import base64
import hashlib
import json
from pathlib import Path
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
        cell_src = ''.join(self.notebook['cells'][13]['source'])
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
            install_cell = ''.join(self.notebook['cells'][11]['source'])
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
        cell7_src = ''.join(self.notebook['cells'][7]['source'])
        cell9_src = ''.join(self.notebook['cells'][9]['source'])

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
        for src in (cell5_src, cell7_src, cell9_src):
            self.assertIn("stats_path", src)

    def test_prompt_length_and_triposr_vit_remap(self):
        cell1_scope = {}
        exec(compile(''.join(self.notebook['cells'][1]['source']), 'cell_1', 'exec'), cell1_scope)
        self.assertLessEqual(len(cell1_scope['DISH_PROMPT'].split()), 60)

        cell7_src = ''.join(self.notebook['cells'][7]['source'])
        tree = ast.parse(cell7_src)
        worker_code = next(
            node.value.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and getattr(node.targets[0], 'id', None) == 'triposr_worker_code'
        )
        worker_ast = ast.parse(worker_code, filename='run_triposr_worker.py')
        fn_node = next(
            n for n in worker_ast.body
            if isinstance(n, ast.FunctionDef) and n.name == 'remap_triposr_vit_state_dict'
        )
        fn_mod = ast.Module(body=[fn_node], type_ignores=[])
        ns = {}
        exec(compile(fn_mod, 'remap_only', 'exec'), ns)
        remap = ns['remap_triposr_vit_state_dict']

        prefix = 'image_tokenizer.model.'
        v4_to_v5 = {
            f'{prefix}encoder.layer.0.attention.attention.query.weight': f'{prefix}layers.0.attention.q_proj.weight',
            f'{prefix}encoder.layer.0.attention.attention.query.bias': f'{prefix}layers.0.attention.q_proj.bias',
            f'{prefix}encoder.layer.0.attention.attention.key.weight': f'{prefix}layers.0.attention.k_proj.weight',
            f'{prefix}encoder.layer.0.attention.attention.key.bias': f'{prefix}layers.0.attention.k_proj.bias',
            f'{prefix}encoder.layer.0.attention.attention.value.weight': f'{prefix}layers.0.attention.v_proj.weight',
            f'{prefix}encoder.layer.0.attention.attention.value.bias': f'{prefix}layers.0.attention.v_proj.bias',
            f'{prefix}encoder.layer.0.attention.output.dense.weight': f'{prefix}layers.0.attention.o_proj.weight',
            f'{prefix}encoder.layer.0.attention.output.dense.bias': f'{prefix}layers.0.attention.o_proj.bias',
            f'{prefix}encoder.layer.0.intermediate.dense.weight': f'{prefix}layers.0.mlp.fc1.weight',
            f'{prefix}encoder.layer.0.intermediate.dense.bias': f'{prefix}layers.0.mlp.fc1.bias',
            f'{prefix}encoder.layer.0.output.dense.weight': f'{prefix}layers.0.mlp.fc2.weight',
            f'{prefix}encoder.layer.0.output.dense.bias': f'{prefix}layers.0.mlp.fc2.bias',
            f'{prefix}encoder.layer.0.layernorm_before.weight': f'{prefix}layers.0.layernorm_before.weight',
            f'{prefix}encoder.layer.0.layernorm_before.bias': f'{prefix}layers.0.layernorm_before.bias',
            f'{prefix}encoder.layer.0.layernorm_after.weight': f'{prefix}layers.0.layernorm_after.weight',
            f'{prefix}encoder.layer.0.layernorm_after.bias': f'{prefix}layers.0.layernorm_after.bias',
        }
        ckpt = {k: f'v:{i}' for i, k in enumerate(v4_to_v5)}
        ckpt['backbone.layers.0.weight'] = 'untouched'

        # Transformers 5.x target keys -> exact 1-to-1 remap
        v5_targets = set(v4_to_v5.values()) | {'backbone.layers.0.weight'}
        remapped = remap(ckpt, v5_targets)
        self.assertEqual(set(remapped.keys()), v5_targets)
        for old_k, new_k in v4_to_v5.items():
            self.assertEqual(remapped[new_k], ckpt[old_k])
        self.assertEqual(remapped['backbone.layers.0.weight'], 'untouched')

        # Transformers 4.x target keys -> no-op
        v4_targets = set(ckpt.keys())
        self.assertEqual(remap(ckpt, v4_targets), ckpt)

    def test_trellis_revision_pinning_and_bounded_timeout(self):
        cell1_src = ''.join(self.notebook['cells'][1]['source'])
        cell13_src = ''.join(self.notebook['cells'][13]['source'])
        cell15_src = ''.join(self.notebook['cells'][15]['source'])

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
        cell7_src = ''.join(self.notebook['cells'][7]['source'])
        cell9_src = ''.join(self.notebook['cells'][9]['source'])
        cell11_src = ''.join(self.notebook['cells'][11]['source'])
        cell17_src = ''.join(self.notebook['cells'][17]['source'])
        cell19_src = ''.join(self.notebook['cells'][19]['source'])

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

        triposr_code = extract_str_assign(cell7_src, 'triposr_worker_code')
        self.assertIn("'resolution': 256", cell7_src)
        self.assertIn('192', triposr_code)
        self.assertIn('[:, [1, 2, 0]]', triposr_code)
        self.assertIn('mesh.split(only_watertight=False)', triposr_code)
        self.assertIn('MAX_GPU_WORKERS', cell7_src)

        hy_code = extract_str_assign(cell9_src, 'hy_worker_code')
        for token in ('FloaterRemover', 'DegenerateFaceRemover', 'FaceReducer'):
            self.assertIn(token, hy_code)
        self.assertIn("'max_faces': 80000", cell9_src)
        self.assertIn('MAX_GPU_WORKERS', cell9_src)

        ast.parse(cell19_src, filename='cell_19')
        for token in (
            '1.0 / 2.2',
            'Cutout (Plate + Food)',
            'make_checkerboard',
            'render_hf_trellis_modes',
            'hf_modes_sheet.png',
            'dish_panels',
        ):
            self.assertIn(token, cell19_src)

    def test_v10_plate_preservation_and_docker_contract(self):
        cell1_src = ''.join(self.notebook['cells'][1]['source'])
        cell3_src = ''.join(self.notebook['cells'][3]['source'])
        cell5_src = ''.join(self.notebook['cells'][5]['source'])
        cell7_src = ''.join(self.notebook['cells'][7]['source'])
        cell9_src = ''.join(self.notebook['cells'][9]['source'])
        cell19_src = ''.join(self.notebook['cells'][19]['source'])

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
                'triposr_repo': '107cefdc',
                'grounding_dino': scope['GROUNDING_DINO_REVISION'],
                'sam_vit_base': scope['SAM_REVISION'],
                'input_01_pizza': 'user-uploaded-dataset',
            }
            jm = scope['build_job_manifest']('01_pizza', found['01_pizza'], revs)
            self.assertFalse(jm['publication_eligible'])
            self.assertEqual(jm['plate_preservation_mode'], 'preserve_plate')
            self.assertEqual(jm['reviewed_mask'], '01_pizza_mask.png')
            self.assertNotIn('input_01_pizza', jm['pinned_revisions'])
            jm_path = out_dir / '01_pizza' / 'job_manifest.json'
            jm_path.write_text(json.dumps(jm, indent=2), encoding='utf-8')
            found['01_pizza']['job_manifest_path'] = jm_path

            # Dummy cutout + raw/mobile GLBs
            cut_path = out_dir / '01_pizza' / 'cutout_rgba.png'
            Image.new('RGBA', (32, 32), (220, 140, 40, 255)).save(cut_path)
            found['01_pizza']['cutout_path'] = cut_path
            found['01_pizza']['cutout_metrics'] = {'plate_preserved': True, 'plate_added_pct': 18.5}

            raw_glb = out_dir / '01_pizza' / 'triposr.glb'
            mob_glb = out_dir / '01_pizza' / 'triposr_mobile.glb'
            raw_glb.write_bytes(b'glTF-raw-stub')
            mob_glb.write_bytes(b'glTF-mob-stub')
            runs = {
                '01_pizza/triposr': {
                    'input_label': '01_pizza',
                    'backend': 'TripoSR',
                    'appearance': 'vertex_color',
                    'status': 'success',
                    'metrics': {'vertices': 50000, 'faces': 100000, 'has_vertex_color': True, 'elapsed_seconds': 9.1},
                    'mobile_metrics': {'vertices': 17000, 'faces': 34000, 'has_vertex_color': True},
                    'mobile_glb_path': mob_glb,
                    'artifact_paths': [raw_glb, mob_glb],
                }
            }
            receipt = scope['build_worker_receipt'](jm, found['01_pizza'], runs, out_dir)
            self.assertFalse(receipt['publication_eligible'])
            self.assertTrue(receipt['plate_preserved'])
            self.assertEqual(receipt['models']['TripoSR']['mobile_glb']['faces'], 34000)

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

        triposr_code = extract_str_assign(cell7_src, 'triposr_worker_code')
        for token in ('mobile_glb', 'meshing_decimation_quadric_edge_collapse'):
            self.assertIn(token, triposr_code)
        self.assertIn("'mobile_max_faces': 34000", cell7_src)

        hy_code = extract_str_assign(cell9_src, 'hy_worker_code')
        for token in ('pad_rgba_for_reconstruction', 'mobile_glb'):
            self.assertIn(token, hy_code)
        self.assertIn("'mobile_max_faces': 34000", cell9_src)
        self.assertIn("'margin': 0.08", cell9_src)

        for token in ('Dockerfile.worker.template', 'requirements.lock.txt', 'pinned_revisions.json', 'worker_output.json'):
            self.assertIn(token, cell19_src)

    def test_hunyuan_transformers5_conditioner_remap_and_v12_guards(self):
        cell5_src = ''.join(self.notebook['cells'][5]['source'])
        cell9_src = ''.join(self.notebook['cells'][9]['source'])
        cell19_src = ''.join(self.notebook['cells'][19]['source'])

        def extract_str_assign(src_text, var_name):
            tree = ast.parse(src_text)
            for node in tree.body:
                if (isinstance(node, ast.Assign) and len(node.targets) == 1
                        and getattr(node.targets[0], 'id', None) == var_name):
                    val = node.value.value
                    ast.parse(val, filename=var_name)
                    return val
            raise AssertionError(f'Missing {var_name}')

        # Verify Cell 9 remap_hunyuan_conditioner_state_dict purely via AST without GPU deps
        hy_code = extract_str_assign(cell9_src, 'hy_worker_code')
        hy_tree = ast.parse(hy_code, filename='hy_worker_code')
        remap_fn = next(
            node for node in hy_tree.body
            if isinstance(node, ast.FunctionDef) and node.name == 'remap_hunyuan_conditioner_state_dict'
        )
        ns = {}
        exec(compile(ast.Module(body=[remap_fn], type_ignores=[]), 'remap_fn', 'exec'), ns)
        remap_fn_obj = ns['remap_hunyuan_conditioner_state_dict']

        class _FakeTensor:
            def __init__(self, data):
                self.data = list(data)

            def chunk(self, chunks, dim=0):
                assert chunks == 2 and dim == 0
                mid = len(self.data) // 2
                return _FakeTensor(self.data[:mid]), _FakeTensor(self.data[mid:])

            def contiguous(self):
                return self

        layer0_v4 = {
            'main_image_encoder.model.embeddings.patch_embeddings.projection.weight': _FakeTensor([100]),
            'main_image_encoder.model.encoder.layer.0.attention.attention.query.weight': _FakeTensor([1, 2]),
            'main_image_encoder.model.encoder.layer.0.attention.attention.query.bias': _FakeTensor([3]),
            'main_image_encoder.model.encoder.layer.0.attention.attention.key.weight': _FakeTensor([4, 5]),
            'main_image_encoder.model.encoder.layer.0.attention.attention.key.bias': _FakeTensor([6]),
            'main_image_encoder.model.encoder.layer.0.attention.attention.value.weight': _FakeTensor([7, 8]),
            'main_image_encoder.model.encoder.layer.0.attention.attention.value.bias': _FakeTensor([9]),
            'main_image_encoder.model.encoder.layer.0.attention.output.dense.weight': _FakeTensor([10, 11]),
            'main_image_encoder.model.encoder.layer.0.attention.output.dense.bias': _FakeTensor([12]),
            'main_image_encoder.model.encoder.layer.0.mlp.weights_in.weight': _FakeTensor([1, 2, 3, 4, 5, 6, 7, 8]),
            'main_image_encoder.model.encoder.layer.0.mlp.weights_in.bias': _FakeTensor([10, 20, 30, 40, 50, 60, 70, 80]),
            'main_image_encoder.model.encoder.layer.0.mlp.weights_out.weight': _FakeTensor([13, 14, 15, 16]),
            'main_image_encoder.model.encoder.layer.0.mlp.weights_out.bias': _FakeTensor([17, 18, 19, 20]),
        }
        v5_targets = {
            'main_image_encoder.model.embeddings.patch_embeddings.projection.weight',
            'main_image_encoder.model.encoder.layer.0.attention.q_proj.weight',
            'main_image_encoder.model.encoder.layer.0.attention.q_proj.bias',
            'main_image_encoder.model.encoder.layer.0.attention.k_proj.weight',
            'main_image_encoder.model.encoder.layer.0.attention.k_proj.bias',
            'main_image_encoder.model.encoder.layer.0.attention.v_proj.weight',
            'main_image_encoder.model.encoder.layer.0.attention.v_proj.bias',
            'main_image_encoder.model.encoder.layer.0.attention.o_proj.weight',
            'main_image_encoder.model.encoder.layer.0.attention.o_proj.bias',
            'main_image_encoder.model.encoder.layer.0.mlp.gate_proj.weight',
            'main_image_encoder.model.encoder.layer.0.mlp.gate_proj.bias',
            'main_image_encoder.model.encoder.layer.0.mlp.up_proj.weight',
            'main_image_encoder.model.encoder.layer.0.mlp.up_proj.bias',
            'main_image_encoder.model.encoder.layer.0.mlp.down_proj.weight',
            'main_image_encoder.model.encoder.layer.0.mlp.down_proj.bias',
        }
        remapped_v5 = remap_fn_obj(layer0_v4, v5_targets)
        self.assertEqual(set(remapped_v5.keys()), v5_targets)
        self.assertEqual(
            remapped_v5['main_image_encoder.model.encoder.layer.0.mlp.gate_proj.weight'].data,
            [1, 2, 3, 4],
        )
        self.assertEqual(
            remapped_v5['main_image_encoder.model.encoder.layer.0.mlp.up_proj.weight'].data,
            [5, 6, 7, 8],
        )
        self.assertEqual(
            remapped_v5['main_image_encoder.model.encoder.layer.0.mlp.gate_proj.bias'].data,
            [10, 20, 30, 40],
        )
        self.assertEqual(
            remapped_v5['main_image_encoder.model.encoder.layer.0.mlp.up_proj.bias'].data,
            [50, 60, 70, 80],
        )
        # transformers 4.x target schema stays a complete no-op
        noop_v4 = remap_fn_obj(layer0_v4, set(layer0_v4.keys()))
        self.assertEqual(set(noop_v4.keys()), set(layer0_v4.keys()))

        # Verify upgraded Cell 5 plate detection & Cell 19 ASCII/CUDA-matched Docker guards
        cutout_code = extract_str_assign(cell5_src, 'cutout_worker_code')
        for token in (
            'PLATE_PROMPT_PASSES',
            'count_top_non_food_corners',
            'sam_vessel_points',
            'ring_contact',
            'bbox_fill',
        ):
            self.assertIn(token, cutout_code)

        self.assertIn("('triposr', 'TripoSR - HF 4-Mode Strip')", cell19_src)
        self.assertIn("('hunyuan3d-2mini', 'Hunyuan3D-2mini - HF 4-Mode Strip')", cell19_src)
        self.assertIn('--extra-index-url https://download.pytorch.org/whl/', cell19_src)

        # Verify Cell 11/15 skips TRELLIS cleanly on CUDA 13.0 ("latest") even when DINOV3_OK=True
        cell11_src = ''.join(self.notebook['cells'][11]['source'])
        cell15_src = ''.join(self.notebook['cells'][15]['source'])
        self.assertNotIn("Use a CUDA 12.x Kaggle image for T4.", cell11_src)
        self.assertIn("TRELLIS_SKIP_REASON = 'requires_cuda_12_toolchain'", cell11_src)
        self.assertIn('TRELLIS_SKIP_REASON', cell15_src)

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
