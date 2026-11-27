"""Tests for Colab dish-3D benchmark notebooks and generator.

Verifies deterministic notebook generation, GPU guards, drive mount/unmount,
safe HF token handling, parameter defaults, resume checking, and output contracts.
"""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = REPO_ROOT / 'processing' / 'scripts' / 'build_colab_notebooks.py'
TRELLIS_NOTEBOOK = REPO_ROOT / 'notebooks' / 'colab-trellis-hires.ipynb'
HUNYUAN_NOTEBOOK = REPO_ROOT / 'notebooks' / 'colab-hunyuan21-pbr.ipynb'

VERIFY_SCRIPT = REPO_ROOT / 'processing' / 'scripts' / 'verify_kaggle_outputs.py'
REPORT_SCRIPT = REPO_ROOT / 'processing' / 'scripts' / 'build_dish_model_report.py'


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'Cannot load {path}')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _load_notebook(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def _get_notebook_source(nb: dict) -> str:
    return '\n'.join(''.join(c.get('source', [])) for c in nb.get('cells', []))


class TestColabNotebooks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # We try loading the generator script; if it does not exist yet,
        # tests expecting it will fail as required by TDD.
        if BUILD_SCRIPT.is_file():
            cls.builder = _load_module('build_colab_notebooks', BUILD_SCRIPT)
        else:
            cls.builder = None

    def test_build_script_exists(self):
        self.assertTrue(BUILD_SCRIPT.is_file(), f'Missing {BUILD_SCRIPT}')

    def test_notebooks_generated_deterministically(self):
        self.assertIsNotNone(self.builder, 'build_colab_notebooks script not found')
        with TemporaryDirectory() as tmp_dir:
            tmp_root = Path(tmp_dir)
            t_out1 = tmp_root / 'trellis1.ipynb'
            h_out1 = tmp_root / 'hunyuan1.ipynb'
            t_out2 = tmp_root / 'trellis2.ipynb'
            h_out2 = tmp_root / 'hunyuan2.ipynb'

            self.builder.build_trellis_notebook(t_out1)
            self.builder.build_hunyuan_notebook(h_out1)
            self.builder.build_trellis_notebook(t_out2)
            self.builder.build_hunyuan_notebook(h_out2)

            self.assertEqual(t_out1.read_bytes(), t_out2.read_bytes(),
                             'TRELLIS notebook generation is not deterministic')
            self.assertEqual(h_out1.read_bytes(), h_out2.read_bytes(),
                             'Hunyuan notebook generation is not deterministic')

            # Ensure committed repo notebooks match generator
            if TRELLIS_NOTEBOOK.is_file():
                self.assertEqual(t_out1.read_bytes(), TRELLIS_NOTEBOOK.read_bytes())
            if HUNYUAN_NOTEBOOK.is_file():
                self.assertEqual(h_out1.read_bytes(), HUNYUAN_NOTEBOOK.read_bytes())

    def test_gpu_guard_exists(self):
        self.assertTrue(TRELLIS_NOTEBOOK.is_file(), f'Missing {TRELLIS_NOTEBOOK}')
        self.assertTrue(HUNYUAN_NOTEBOOK.is_file(), f'Missing {HUNYUAN_NOTEBOOK}')

        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn('nvidia-smi', t_src)
        self.assertIn('torch.cuda.get_device_name', t_src)
        self.assertIn('L4', t_src)
        self.assertIn('ALLOW_OTHER_GPU', t_src)

        h_nb = _load_notebook(HUNYUAN_NOTEBOOK)
        h_src = _get_notebook_source(h_nb)
        self.assertIn('nvidia-smi', h_src)
        self.assertIn('torch.cuda.get_device_name', h_src)
        self.assertIn('A100', h_src)
        self.assertIn('ALLOW_OTHER_GPU', h_src)

    def test_drive_mount_and_paths(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn('drive.mount', src)
            self.assertIn('/content/drive/MyDrive/peekaplate/dish-menu-41', src)
            self.assertIn('/content/drive/MyDrive/peekaplate/colab-out', src)

    def test_hf_token_never_printed(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn("userdata.get('HF_TOKEN')", src)
            # Never print the token
            self.assertNotRegex(src, r'print\([^)]*HF_TOKEN[^)]*\)')
            self.assertNotRegex(src, r'print\([^)]*userdata\.get\([^)]*\)')
            # Check secrets panel instruction when missing
            self.assertIn('Secrets', src)

    def test_drive_fallback_path_in_both_notebooks(self):
        fallback_path = '/content/drive/MyDrive/peekaplate/secrets/hf_token.txt'
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn(
                fallback_path,
                src,
                f"Missing Drive fallback path {fallback_path} in {nb_path.name}",
            )

    def test_mount_comes_before_token_read(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            cells = nb.get('cells', [])
            mount_idx = None
            token_idx = None
            for idx, cell in enumerate(cells):
                src = ''.join(cell.get('source', []))
                if 'drive.mount' in src:
                    mount_idx = idx
                if '/content/drive/MyDrive/peekaplate/secrets/hf_token.txt' in src:
                    token_idx = idx
            self.assertIsNotNone(mount_idx, f"drive.mount not found in {nb_path.name}")
            self.assertIsNotNone(token_idx, f"Drive token fallback not found in {nb_path.name}")
            self.assertLess(
                mount_idx,
                token_idx,
                f"Drive mount (cell {mount_idx}) must precede token read (cell {token_idx}) in {nb_path.name}",
            )

    def test_token_source_line_is_printed(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn("HF token source: colab_secret", src)
            self.assertIn("HF token source: drive_file", src)
            self.assertRegex(src, r'print\(["\']HF token source: colab_secret["\']\)')
            self.assertRegex(src, r'print\(["\']HF token source: drive_file["\']\)')
            self.assertIn("os.environ['HF_TOKEN'] = HF_TOKEN", src)
            # Regression (2026-11-24): importing huggingface_hub before the dependency
            # install leaves stale modules and breaks the pipeline cell.
            token_cell = src.split('# 3. Retrieve Hugging Face Token', 1)[1].split('# 4. Parameters', 1)[0]
            self.assertNotIn('import huggingface_hub', token_cell)
            self.assertNotIn('huggingface_hub.login', token_cell)

    def test_no_code_prints_or_writes_token_value(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertNotRegex(src, r'print\([^)]*HF_TOKEN[^)]*\)')
            self.assertNotRegex(src, r'print\([^)]*userdata\.get\([^)]*\)')
            self.assertNotRegex(src, r'write(_text|_bytes)?\([^)]*HF_TOKEN[^)]*\)')
            for idx, cell in enumerate(nb.get('cells', [])):
                if cell.get('cell_type') != 'code':
                    continue
                code = ''.join(cell.get('source', []))
                tree = ast.parse(code)
                for node in ast.walk(tree):
                    if isinstance(node, ast.Call):
                        if isinstance(node.func, ast.Name) and node.func.id == 'print':
                            for arg in node.args:
                                if isinstance(arg, ast.Name) and arg.id in ('HF_TOKEN', 'token'):
                                    self.fail(f"Cell {idx} in {nb_path.name} prints token variable: {ast.unparse(node)}")
                                if isinstance(arg, ast.JoinedStr):
                                    for val in arg.values:
                                        if isinstance(val, ast.FormattedValue) and isinstance(val.value, ast.Name):
                                            if val.value.id in ('HF_TOKEN', 'token'):
                                                self.fail(f"Cell {idx} in {nb_path.name} prints token in f-string: {ast.unparse(node)}")
                        if isinstance(node.func, ast.Attribute) and node.func.attr in ('write', 'write_text', 'write_bytes'):
                            for arg in node.args:
                                if isinstance(arg, ast.Name) and arg.id in ('HF_TOKEN', 'token'):
                                    self.fail(f"Cell {idx} in {nb_path.name} writes token variable to disk: {ast.unparse(node)}")

    def test_dish_limit_defaults_to_1(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertRegex(src, r'DISH_LIMIT\s*=\s*1\b')
            self.assertIn('AUTO_RELEASE', src)
            self.assertRegex(src, r'AUTO_RELEASE\s*=\s*True\b')

    def test_resume_check_exists(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn('worker_output.json', src)
            self.assertIn("'status'", src)
            self.assertIn("'success'", src)

    def test_unassign_after_flush_and_inside_finally(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            cells = nb.get('cells', [])
            unassign_found = False

            for idx, cell in enumerate(cells):
                src = ''.join(cell.get('source', []))
                if 'unassign' in src:
                    unassign_found = True
                    # flush_and_unmount must appear in the notebook before unassign is called
                    self.assertIn('flush_and_unmount', src)
                    flush_idx = src.find('flush_and_unmount')
                    unassign_idx = src.find('unassign')
                    self.assertLess(flush_idx, unassign_idx,
                                    f'unassign must come after flush_and_unmount in {nb_path.name} cell {idx}')
                    # Must be inside a finally block
                    self.assertIn('finally:', src)
                    finally_idx = src.rfind('finally:', 0, unassign_idx)
                    self.assertGreater(finally_idx, -1,
                                       f'unassign must be inside a finally: block in {nb_path.name} cell {idx}')

            self.assertTrue(unassign_found, f'runtime.unassign() not found in {nb_path.name}')

    def test_output_paths_and_schema_keys(self):
        # TRELLIS
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn('trellis2-4b-hires', t_src)
        self.assertIn('progress.jsonl', t_src)
        self.assertIn('job_manifest.json', t_src)
        self.assertIn('worker_output.json', t_src)

        # Hunyuan
        h_nb = _load_notebook(HUNYUAN_NOTEBOOK)
        h_src = _get_notebook_source(h_nb)
        self.assertIn('hunyuan3d21-pbr', h_src)
        self.assertIn('progress.jsonl', h_src)
        self.assertIn('job_manifest.json', h_src)
        self.assertIn('worker_output.json', h_src)

    def test_model_keys_accepted_by_report_and_verify(self):
        report_mod = _load_module('build_dish_model_report', REPORT_SCRIPT)
        report_slugs = [slug for slug, _ in report_mod.MODEL_COLUMNS]
        self.assertIn('trellis2-4b-hires', report_slugs)
        self.assertIn('hunyuan3d21-pbr', report_slugs)

        # Test verifier on synthetic folder with the two model keys
        verify_mod = _load_module('verify_kaggle_outputs', VERIFY_SCRIPT)
        with TemporaryDirectory() as tmp_dir:
            tmp_root = Path(tmp_dir)
            source_dir = tmp_root / 'colab-run-test'
            source_dir.mkdir(parents=True)
            dish_dir = source_dir / '01_pizza'
            dish_dir.mkdir(parents=True)

            img = Image.new('RGB', (16, 16), (200, 100, 50))
            img_path = dish_dir / 'input_image.png'
            img.save(img_path)

            cutout = Image.new('RGBA', (16, 16), (200, 100, 50, 255))
            cutout_path = dish_dir / 'cutout_rgba.png'
            cutout.save(cutout_path)

            # Minimal valid GLB
            glb_path = dish_dir / 'trellis2_4b_hires.glb'
            positions = np.array([[-1, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
            indices = np.array([[0, 1, 2]], dtype=np.uint32)
            uvs = np.array([[0, 0], [1, 0], [0.5, 1]], dtype=np.float32)
            # Use multi_model_3d helper if available or write basic GLB
            from peekaplate_processing.multi_model_3d import write_pbr_glb
            write_pbr_glb(positions, indices, uvs, Image.new('RGB', (8, 8), (255, 255, 255)), glb_path)

            img_sha = verify_mod._sha256_file(img_path)
            cut_sha = verify_mod._sha256_file(cutout_path)
            glb_sha = verify_mod._sha256_file(glb_path)

            job_manifest = {
                'schema_version': 1,
                'dish_label': '01_pizza',
                'publication_eligible': False,
                'source_sha256': img_sha,
                'input_image_sha256': img_sha,
                'cutout_sha256': cut_sha,
            }
            (dish_dir / 'job_manifest.json').write_text(json.dumps(job_manifest, indent=2))

            worker_output = {
                'schema_version': 1,
                'dish_label': '01_pizza',
                'publication_eligible': False,
                'source_sha256': img_sha,
                'input_image_sha256': img_sha,
                'cutout_sha256': cut_sha,
                'cutout_metrics': {'coverage_pct': 100.0, 'bbox_px': [0, 0, 16, 16]},
                'models': {
                    'TRELLIS.2-4B Hi-Res': {
                        'status': 'success',
                        'appearance': 'pbr_texture',
                        'raw_glb': {
                            'path': '01_pizza/trellis2_4b_hires.glb',
                            'sha256': glb_sha,
                            'bytes': glb_path.stat().st_size,
                            'faces': 1,
                            'vertices': 3,
                        },
                    },
                },
            }
            (dish_dir / 'worker_output.json').write_text(json.dumps(worker_output, indent=2))

            jm_path = dish_dir / 'job_manifest.json'
            wo_path = dish_dir / 'worker_output.json'
            jm_sha = verify_mod._sha256_file(jm_path)
            wo_sha = verify_mod._sha256_file(wo_path)

            manifest = {
                'schema_version': 3,
                'publication_eligible': False,
                'purpose': 'private single-photo 3D demo',
                'demo_label': 'private (verifier test)',
                'inputs': {
                    '01_pizza': {
                        'label': '01_pizza',
                        'image_status': 'success',
                        'artifacts': [
                            {'path': '01_pizza/input_image.png', 'bytes': img_path.stat().st_size, 'sha256': img_sha},
                            {'path': '01_pizza/cutout_rgba.png', 'bytes': cutout_path.stat().st_size, 'sha256': cut_sha},
                        ],
                    },
                },
                'runs_3d': {
                    '01_pizza/trellis2-4b-hires': {
                        'input_label': '01_pizza',
                        'backend': 'TRELLIS.2-4B Hi-Res',
                        'status': 'success',
                        'appearance': 'pbr_texture',
                        'artifacts': [
                            {'path': '01_pizza/trellis2_4b_hires.glb', 'bytes': glb_path.stat().st_size, 'sha256': glb_sha},
                        ],
                    },
                },
                'extras': [
                    {'path': '01_pizza/job_manifest.json', 'bytes': jm_path.stat().st_size, 'sha256': jm_sha},
                    {'path': '01_pizza/worker_output.json', 'bytes': wo_path.stat().st_size, 'sha256': wo_sha},
                ],
            }
            (source_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2))

            report = verify_mod.verify_source(source_dir)
            self.assertTrue(report['passed'], f'Verifier failed: {report.get("findings")}')
            self.assertEqual(report['counts']['errors'], 0)

    def test_stage5_cpp20_rewrite(self):
        # TRELLIS
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn(r'c\+\+1[47]', t_src)
        self.assertIn('c++20', t_src)
        self.assertIn('CMakeLists.txt', t_src)
        self.assertIn('setup.py', t_src)
        for pkg in ('flex_gemm', 'cumesh', 'nvdiffrast', 'nvdiffrec', 'o-voxel'):
            self.assertIn(pkg, t_src)

        # Hunyuan (custom_rasterizer builds against torch)
        h_nb = _load_notebook(HUNYUAN_NOTEBOOK)
        h_src = _get_notebook_source(h_nb)
        self.assertIn(r'c\+\+1[47]', h_src)
        self.assertIn('c++20', h_src)
        self.assertIn('custom_rasterizer', h_src)

    def test_base_pip_pins(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn('transformers==4.57.3', src, f"transformers pin missing in {nb_path.name}")
            self.assertIn('huggingface_hub==0.36.0', src, f"huggingface_hub pin missing in {nb_path.name}")
            self.assertIn('safetensors==0.6.2', src, f"safetensors pin missing in {nb_path.name}")

    def test_attention_backends_and_xformers_shim(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn("ATTN_BACKEND", src)
            self.assertIn("'sdpa'", src)
            self.assertIn("SPARSE_ATTN_BACKEND", src)
            self.assertIn("'xformers'", src)
            self.assertIn("PYTORCH_CUDA_ALLOC_CONF", src)
            self.assertIn("expandable_segments:True", src)
            self.assertIn("memory_efficient_attention", src)
            self.assertIn("BlockDiagonalMask", src)
            self.assertIn("from_seqlens", src)
            # Must include block-diagonal self-test against dense SDPA
            self.assertIn("scaled_dot_product_attention", src)
            self.assertIn("dense", src.lower())

        # Test that the shim returns a tensor, NOT a tuple
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        found_fn = False
        for cell in t_nb.get('cells', []):
            if cell.get('cell_type') != 'code':
                continue
            code = ''.join(cell.get('source', []))
            if '_memory_efficient_attention' in code:
                found_fn = True
                tree = ast.parse(code)
                for node in ast.walk(tree):
                    if isinstance(node, ast.FunctionDef) and node.name == '_memory_efficient_attention':
                        for subnode in ast.walk(node):
                            if isinstance(subnode, ast.Return) and subnode.value is not None:
                                self.assertNotIsInstance(
                                    subnode.value, ast.Tuple,
                                    f"Shim must return a Tensor, NOT a tuple! Found return of tuple: {ast.unparse(subnode)}"
                                )
        self.assertTrue(found_fn, "_memory_efficient_attention not found in TRELLIS notebook")

    def test_trellis_model_snapshot_load(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn("snapshot_download(MODEL_REPO, revision=MODEL_REV, token=HF_TOKEN)", t_src)
        self.assertIn("Trellis2ImageTo3DPipeline.from_pretrained(path)", t_src)
        self.assertIn("pipeline.to(torch.device('cuda:0'))", t_src)
        self.assertNotIn("from_pretrained(MODEL_REPO", t_src)
        self.assertNotIn("from_pretrained(path, revision=", t_src)

    def test_rembg_birefnet_stub(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn("trellis2.pipelines.rembg.BiRefNet", t_src)
        self.assertIn("trellis2.pipelines.BiRefNet", t_src)
        self.assertIn("raise", t_src)

    def test_trellis_inference_pipeline_run_with_simplify(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn("pipeline.run(rgba, pipeline_type=SETTINGS['pipeline_type'])", t_src)
        self.assertIn("mesh = out[0]", t_src)
        self.assertIn("mesh.simplify(16777216)", t_src)
        self.assertNotIn("pipeline(image=rgba", t_src)
        self.assertNotIn("pipeline(rgba", t_src)

    def test_mask_fallback_no_rembg_remove(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertNotIn("rembg.remove", t_src)
        self.assertIn("kaggle-cutout-masks", t_src)
        self.assertIn("/content/drive/MyDrive/peekaplate/kaggle-cutout-masks", t_src)

    def test_quality_parameter(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertRegex(t_src, r"QUALITY\s*=\s*['\"]standard['\"]")
        self.assertIn("300000", t_src)
        self.assertIn("2048", t_src)
        self.assertIn("1000000", t_src)
        self.assertIn("4096", t_src)
        self.assertIn("35000", t_src)
        self.assertIn("1024", t_src)

    def test_run_level_manifest_json(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        self.assertIn("manifest.json", t_src)
        self.assertIn("'publication_eligible': False", t_src)
        self.assertIn("'inputs'", t_src)
        self.assertIn("'runs_3d'", t_src)

    def test_ram_logger_daemon(self):
        for nb_path in (TRELLIS_NOTEBOOK, HUNYUAN_NOTEBOOK):
            nb = _load_notebook(nb_path)
            src = _get_notebook_source(nb)
            self.assertIn("psutil", src, f"psutil missing in {nb_path.name}")
            self.assertIn("ram.log", src, f"ram.log missing in {nb_path.name}")
            self.assertIn("daemon=True", src, f"daemon=True missing in {nb_path.name}")
            self.assertRegex(src, r'20\b', f"20s interval missing in {nb_path.name}")

    def test_trellis_input_selection_parameters_and_hq_example(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        t_src = _get_notebook_source(t_nb)
        params_cell = t_src.split('# 4. Parameters', 1)[1].split('# 5. Environment Setup', 1)[0]

        # New parameters with backward-compatible defaults
        self.assertRegex(
            params_cell,
            r"INPUT_DIR\s*=\s*'/content/drive/MyDrive/peekaplate/dish-menu-41'",
        )
        self.assertRegex(params_cell, r"INPUT_GLOB\s*=\s*'\*'")
        self.assertRegex(params_cell, r"DISH_FILTER\s*=\s*None\b")
        # Printed like the other config values
        self.assertIn('print(f"[Config] INPUT_DIR={INPUT_DIR}")', params_cell)
        self.assertIn("print(f\"[Config] INPUT_GLOB='{INPUT_GLOB}'\")", params_cell)
        self.assertIn('print(f"[Config] DISH_FILTER={DISH_FILTER}")', params_cell)

        # Commented HQ test example block
        for line in (
            '# HQ test (2026-11-24):',
            "# INPUT_DIR = '/content/drive/MyDrive/peekaplate/hq-test-images'",
            "# INPUT_GLOB = '*_square2048.png'",
            "# RUN_ID = 'run-trellis-hq-test-20261124'",
            "# QUALITY = 'max'; DISH_LIMIT = None",
        ):
            self.assertIn(line, params_cell)

    def test_trellis_discovery_uses_params_and_skips_non_images(self):
        t_nb = _load_notebook(TRELLIS_NOTEBOOK)
        runner_cell = None
        for cell in t_nb.get('cells', []):
            if cell.get('cell_type') == 'code':
                src = ''.join(cell.get('source', []))
                if '# 6. TRELLIS.2 Hi-Res' in src:
                    runner_cell = src
                    break
        self.assertIsNotNone(runner_cell, 'TRELLIS cell 6 not found')

        self.assertIn('_discover_dishes(INPUT_DIR, INPUT_GLOB, DISH_FILTER', runner_cell)

        # Extract _discover_dishes from cell 6 AST and verify behavior on a temp directory
        tree = ast.parse(runner_cell)
        fn_node = next(
            (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_discover_dishes'),
            None,
        )
        self.assertIsNotNone(fn_node, '_discover_dishes function not found in cell 6')
        ns: dict = {'Path': Path}
        exec(compile(ast.Module(body=[fn_node], type_ignores=[]), '<trellis-cell-6>', 'exec'), ns)
        discover = ns['_discover_dishes']

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / 'rice_chicken_square2048.png').write_bytes(b'png')
            (root / 'apple_cake_icecream_square2048.png').write_bytes(b'png')
            (root / 'rice_chicken.jpg').write_bytes(b'jpg')
            (root / 'rice_chicken_mask.png').write_bytes(b'mask')
            (root / 'CREDITS.md').write_text('credits', encoding='utf-8')
            (root / 'dishes_manifest.json').write_text('{}', encoding='utf-8')
            (root / 'nested_dir').mkdir()

            # Default glob skips non-image files, masks, and directories
            default_found = [p.name for p in discover(str(root), '*', None, None)]
            self.assertEqual(
                default_found,
                ['apple_cake_icecream_square2048.png', 'rice_chicken.jpg', 'rice_chicken_square2048.png'],
            )

            # HQ glob selects only square2048 PNGs
            hq_found = [p.stem for p in discover(root, '*_square2048.png', None, None)]
            self.assertEqual(
                hq_found,
                ['apple_cake_icecream_square2048', 'rice_chicken_square2048'],
            )

            # DISH_FILTER narrows by stem
            filtered = [p.stem for p in discover(root, '*_square2048.png', ['rice_chicken_square2048'], None)]
            self.assertEqual(filtered, ['rice_chicken_square2048'])

            # DISH_LIMIT slices results
            limited = [p.stem for p in discover(root, '*_square2048.png', None, 1)]
            self.assertEqual(limited, ['apple_cake_icecream_square2048'])


if __name__ == '__main__':
    unittest.main()
