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
        self.assertNotIn('/kaggle/input/', self.raw)
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
