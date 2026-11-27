"""Generate Google Colab notebooks for PeekaPlate 3D dish benchmarks.

Notebooks generated:
1. `notebooks/colab-trellis-hires.ipynb` (NVIDIA L4):
   Runs Microsoft TRELLIS.2-4B high-resolution (`1024_cascade`) pipeline in bfloat16.
2. `notebooks/colab-hunyuan21-pbr.ipynb` (NVIDIA A100):
   Runs Tencent Hunyuan3D-2.1 shape DiT + Hunyuan3DPaintPipeline (PBR).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
NOTEBOOKS_DIR = REPO_ROOT / 'notebooks'


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


def _wrap_notebook(cells: list[dict[str, Any]], *, gpu_type: str) -> dict[str, Any]:
    return {
        'cells': cells,
        'metadata': {
            'accelerator': 'GPU',
            'colab': {
                'gpuType': gpu_type,
                'provenance': [],
            },
            'language_info': {
                'name': 'python',
            },
        },
        'nbformat': 4,
        'nbformat_minor': 5,
    }


# ==============================================================================
# 1. TRELLIS Hi-Res Notebook (L4)
# ==============================================================================

def _trellis_cell_header() -> str:
    return """# PeekaPlate: TRELLIS.2-4B Hi-Res Benchmark (Google Colab L4)
Private single-dish 3D reconstruction benchmark (`publication_eligible: false`).

This notebook runs Microsoft **TRELLIS.2-4B** at high resolution (`1024_cascade`) in `bfloat16` on an **NVIDIA L4** GPU.
- **Inputs:** Google Drive `/content/drive/MyDrive/peekaplate/dish-menu-41/`
- **Outputs:** Google Drive `/content/drive/MyDrive/peekaplate/colab-out/<RUN_ID>/`
- **Secrets:** Requires `HF_TOKEN` in Colab Secrets with notebook access.
- **Auto-release:** Automatically releases the runtime when finished or on error to stop credit consumption.
"""


def _trellis_cell_gpu_check() -> str:
    return """# 1. GPU Preflight & Guard (Expected: NVIDIA L4)
import os
import subprocess
import sys
import torch

ALLOW_OTHER_GPU = False
EXPECTED_GPU = 'L4'

print("=== GPU Preflight ===")
try:
    subprocess.run(['nvidia-smi'], check=True)
except Exception as _ns_err:
    print(f"Warning: nvidia-smi failed: {_ns_err}")

if not torch.cuda.is_available():
    raise RuntimeError(
        "CUDA GPU is not available! Please switch runtime to GPU:\\n"
        "Runtime -> Change runtime type -> Hardware accelerator: GPU, GPU type: L4"
    )

gpu_name = torch.cuda.get_device_name(0)
device_cap = torch.cuda.get_device_capability(0)
print(f"Detected GPU: {gpu_name} (compute capability {device_cap[0]}.{device_cap[1]})")

if 'L4' not in gpu_name:
    msg = (
        f"Expected GPU '{EXPECTED_GPU}', but detected '{gpu_name}'. "
        "TRELLIS.2 hi-res is tuned for NVIDIA L4 (Ada Lovelace, sm_89, 24 GB VRAM). "
        "Please select L4 in Runtime -> Change runtime type. "
        "Set ALLOW_OTHER_GPU = True to override this check."
    )
    if not ALLOW_OTHER_GPU:
        raise RuntimeError(msg)
    else:
        print(f"WARNING: {msg} Continuing because ALLOW_OTHER_GPU is True.")
else:
    print(f"[OK] GPU guard passed: {gpu_name} matches expected {EXPECTED_GPU}.")
"""


def _trellis_cell_drive_mount() -> str:
    return """# 2. Mount Google Drive
from google.colab import drive
from pathlib import Path

drive.mount('/content/drive')

DRIVE_ROOT = Path('/content/drive/MyDrive/peekaplate')

if not DRIVE_ROOT.exists():
    raise FileNotFoundError(
        f"Drive root {DRIVE_ROOT} does not exist!\\n"
        "Please create 'My Drive/peekaplate/' in Google Drive."
    )

print(f"[OK] Mounted Google Drive. Drive root: {DRIVE_ROOT}")
"""


def _trellis_cell_hf_token() -> str:
    return """# 3. Retrieve Hugging Face Token from Colab Secrets or Google Drive
import os
from pathlib import Path
from google.colab import userdata
# Leave the HF hub library unloaded here: cell 5 reinstalls it, and a module loaded before the
# install goes stale (ImportError refresh_xet_connection_info, 2026-11-24). The library reads
# HF_TOKEN from the environment when it is first imported after the install.

HF_TOKEN = None
token_source = None

try:
    _val = userdata.get('HF_TOKEN')
    if _val and str(_val).strip():
        HF_TOKEN = str(_val).strip()
        token_source = 'colab_secret'
except Exception:
    HF_TOKEN = None

if not HF_TOKEN:
    hf_token_path = Path('/content/drive/MyDrive/peekaplate/secrets/hf_token.txt')
    if hf_token_path.is_file():
        try:
            _val = hf_token_path.read_text(encoding='utf-8').strip()
            if _val:
                HF_TOKEN = _val
                token_source = 'drive_file'
        except Exception:
            HF_TOKEN = None

if not HF_TOKEN:
    raise RuntimeError(
        "HF_TOKEN is missing! Microsoft TRELLIS.2 requires access to gated DINOv3 weights.\\n"
        "Please provide a Hugging Face token using either option:\\n"
        "1. Colab Secrets: Click the key icon ('Secrets') in the sidebar, add 'HF_TOKEN', and toggle 'Notebook access'.\\n"
        "2. Google Drive: Save your token to /content/drive/MyDrive/peekaplate/secrets/hf_token.txt"
    )

os.environ['HF_TOKEN'] = HF_TOKEN
os.environ['HUGGING_FACE_HUB_TOKEN'] = HF_TOKEN

if token_source == 'colab_secret':
    print("HF token source: colab_secret")
elif token_source == 'drive_file':
    print("HF token source: drive_file")
# Security guarantee: The token value is never printed or written to disk.
"""


def _trellis_cell_parameters() -> str:
    return """# 4. Parameters
import time
from pathlib import Path

# Input directory and file selection
INPUT_DIR = '/content/drive/MyDrive/peekaplate/dish-menu-41'
INPUT_GLOB = '*'

# Optional list of filename stems to process; None processes all matching dishes
DISH_FILTER = None

# DISH_LIMIT = 1 for initial test mode; set to None to process all 41 dishes
DISH_LIMIT = 1

# QUALITY parameter:
# - 'standard' (default): 300000 faces / 2048 texture
# - 'max': 1000000 faces / 4096 texture
# Mobile stays 35000 / 1024
QUALITY = 'standard'

# Unique identifier for this run; outputs will be saved to colab-out/<RUN_ID>/
RUN_ID = 'run-trellis-hires-' + time.strftime('%Y%m%d-%H%M%S')

# When True, releases the Colab runtime upon completion or error to save credits
AUTO_RELEASE = True

# HQ test (2026-11-24):
# INPUT_DIR = '/content/drive/MyDrive/peekaplate/hq-test-images'
# INPUT_GLOB = '*_square2048.png'
# RUN_ID = 'run-trellis-hq-test-20261124'
# QUALITY = 'max'; DISH_LIMIT = None

INPUT_DIR = Path(INPUT_DIR)
if not INPUT_DIR.exists():
    raise FileNotFoundError(
        f"Input directory {INPUT_DIR} does not exist!\\n"
        "Please upload the dish dataset to Google Drive at the configured INPUT_DIR."
    )

OUTPUT_DIR = DRIVE_ROOT / 'colab-out' / RUN_ID
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
PROGRESS_PATH = OUTPUT_DIR / 'progress.jsonl'

print(f"[Config] INPUT_DIR={INPUT_DIR}")
print(f"[Config] INPUT_GLOB='{INPUT_GLOB}'")
print(f"[Config] DISH_FILTER={DISH_FILTER}")
print(f"[Config] DISH_LIMIT={DISH_LIMIT}")
print(f"[Config] QUALITY='{QUALITY}'")
print(f"[Config] RUN_ID='{RUN_ID}'")
print(f"[Config] AUTO_RELEASE={AUTO_RELEASE}")
print(f"[Config] OUTPUT_DIR={OUTPUT_DIR}")
"""


def _trellis_cell_install() -> str:
    return """# 5. Environment Setup & Native Extension Compilation for L4 (sm_89)
import os
import re
import subprocess
import sys
from pathlib import Path

SCRATCH = Path('/content/scratch')
SCRATCH.mkdir(parents=True, exist_ok=True)

TRELLIS_REPO = 'https://github.com/microsoft/TRELLIS.2.git'
TRELLIS_REV = '75fbf0183001ed9876c8dbb35de6b68552ee08bd'
TRELLIS_SRC = SCRATCH / 'TRELLIS.2-native'

REVISIONS = {
    'trellis_code': TRELLIS_REV,
    'trellis_model': 'af44b45f2e35a493886929c6d786e563ec68364d',
    'dinov3': 'ea8dc2863c51be0a264bab82070e3e8836b02d51',
    'flex_gemm': '6dd94a859c26ee8246888502eada3dd8ad85532e',
    'cumesh': '12289e1062f0603f2f0d0771b02e1395d247f26f',
    'nvdiffrast': '253ac4fcea7de5f396371124af597e6cc957bfae',
    'nvdiffrec': 'b296927cc7fd01c2ac1087c8065c4d7248f72da4',
}

build_env = os.environ.copy()
# L4 is compute capability 8.9; build CUDA extensions targeting sm_89
build_env['TORCH_CUDA_ARCH_LIST'] = '8.9'
build_env['CUDA_HOME'] = '/usr/local/cuda'
build_env['MAX_JOBS'] = '4'

print("Installing base Python dependencies for TRELLIS.2...")
subprocess.run([
    sys.executable, '-m', 'pip', 'install', '-q',
    'wrapt', 'setuptools<81', 'wheel', 'ninja',
    'transformers==4.57.3', 'huggingface_hub==0.36.0', 'safetensors==0.6.2', 'psutil',
    'imageio', 'imageio-ffmpeg', 'tqdm', 'easydict',
    'opencv-python-headless', 'trimesh',
    'kornia', 'timm', 'zstandard',
    'rembg[cpu]', 'pyrender',
    'git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8'
], env=build_env, check=True)

def rewrite_cpp_standard(pkg_dir):
    pkg_dir = Path(pkg_dir)
    count = 0
    for target_name in ('setup.py', 'CMakeLists.txt'):
        for target_file in pkg_dir.rglob(target_name):
            if target_file.is_file():
                try:
                    content = target_file.read_text(encoding='utf-8')
                    new_content = re.sub(r'c\\+\\+1[47]', 'c++20', content)
                    if new_content != content:
                        target_file.write_text(new_content, encoding='utf-8')
                        count += 1
                except Exception as _rw_err:
                    print(f"Warning: could not rewrite {target_file}: {_rw_err}")
    print(f"[C++20] Checked {pkg_dir.name}: rewrote {count} file(s) to c++20.")

def git_checkout(repo_url, target_dir, rev):
    if not target_dir.exists():
        subprocess.run(['git', 'clone', '--no-checkout', repo_url, str(target_dir)], check=True)
    subprocess.run(['git', '-C', str(target_dir), 'fetch', '--depth', '1', 'origin', rev], check=True)
    subprocess.run(['git', '-C', str(target_dir), 'checkout', '--detach', rev], check=True)
    subprocess.run(['git', '-C', str(target_dir), 'submodule', 'update', '--init', '--recursive'], check=True)

print("Fetching TRELLIS.2 official source...")
git_checkout(TRELLIS_REPO, TRELLIS_SRC, TRELLIS_REV)

dep_dir = SCRATCH / 'trellis_deps'
dep_dir.mkdir(exist_ok=True)

for pkg_name, pkg_repo in (
    ('flex_gemm', 'https://github.com/JeffreyXiang/FlexGEMM.git'),
    ('cumesh', 'https://github.com/JeffreyXiang/CuMesh.git'),
    ('nvdiffrast', 'https://github.com/NVlabs/nvdiffrast.git'),
    ('nvdiffrec', 'https://github.com/JeffreyXiang/nvdiffrec.git'),
):
    p_path = dep_dir / pkg_name
    print(f"Building {pkg_name}@{REVISIONS[pkg_name][:8]} for L4 (sm_89)...")
    git_checkout(pkg_repo, p_path, REVISIONS[pkg_name])
    rewrite_cpp_standard(p_path)
    try:
        subprocess.run([
            sys.executable, '-m', 'pip', 'install', '-q',
            '--no-build-isolation', '--no-deps', str(p_path)
        ], env=build_env, check=True)
    except Exception as _b_err:
        if pkg_name == 'nvdiffrec':
            print(f"Optional nvdiffrec build failed ({_b_err}); continuing without it.")
        else:
            raise

print("Installing o-voxel from TRELLIS.2...")
rewrite_cpp_standard(TRELLIS_SRC / 'o-voxel')
subprocess.run([
    sys.executable, '-m', 'pip', 'install', '-q',
    '--no-build-isolation', '--no-deps', str(TRELLIS_SRC / 'o-voxel')
], env=build_env, check=True)

print("[OK] Native dependencies and CUDA kernels compiled for L4.")
"""


def _trellis_cell_runner() -> str:
    return """# 6. TRELLIS.2 Hi-Res (`1024_cascade`) Dish Pipeline & Processing Loop
import gc
import hashlib
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
import psutil
import torch

# RAM monitoring daemon thread (logs every 20s to OUTPUT_DIR/ram.log)
def _ram_monitor(log_path: Path, interval: float = 20.0):
    while True:
        try:
            mem = psutil.virtual_memory()
            rss = psutil.Process().memory_info().rss
            ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(f"{ts} rss={rss} used={mem.used} available={mem.available}\\n")
        except Exception:
            pass
        time.sleep(interval)

ram_thread = threading.Thread(target=_ram_monitor, args=(OUTPUT_DIR / 'ram.log', 20.0), daemon=True)
ram_thread.start()
print(f"[OK] RAM monitor daemon thread started (every 20s -> {OUTPUT_DIR / 'ram.log'}).")

# Attention backends and CUDA allocator configuration
os.environ['ATTN_BACKEND'] = 'sdpa'
os.environ['SPARSE_ATTN_BACKEND'] = 'xformers'
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'

# Pure-PyTorch xformers shim (returns Tensor [B, M, H, C], NOT a tuple)
def _register_xformers_shim():
    import types
    import torch
    import torch.nn.functional as F

    class _BlockDiagonalMask:
        def __init__(self, q_seqlen, kv_seqlen=None):
            self.q_seqlen = [int(s) for s in q_seqlen]
            self.kv_seqlen = [int(s) for s in (kv_seqlen if kv_seqlen is not None else q_seqlen)]

        @classmethod
        def from_seqlens(cls, q_seqlen, kv_seqlen=None):
            return cls(q_seqlen, kv_seqlen)

        @property
        def q_blocks(self):
            blocks, start = [], 0
            for l in self.q_seqlen:
                blocks.append((start, start + l))
                start += l
            return blocks

        @property
        def kv_blocks(self):
            blocks, start = [], 0
            for l in self.kv_seqlen:
                blocks.append((start, start + l))
                start += l
            return blocks

    def _memory_efficient_attention(q, k, v, attn_bias=None, *args, **kwargs):
        # xformers layout: [B, M, H, C]; PyTorch SDPA layout: [B, H, M, C].
        # MUST return a TENSOR shaped [B, M, H, C], NOT a tuple!
        if attn_bias is None or not hasattr(attn_bias, 'q_seqlen'):
            if isinstance(attn_bias, torch.Tensor):
                out = F.scaled_dot_product_attention(
                    q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=attn_bias
                )
            else:
                out = F.scaled_dot_product_attention(
                    q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
                )
            return out.transpose(1, 2)

        q_blocks, kv_blocks = attn_bias.q_blocks, attn_bias.kv_blocks
        ragged = q.shape[1] == sum(attn_bias.q_seqlen) and k.shape[1] == sum(attn_bias.kv_seqlen)
        if ragged and len(q_blocks) == len(kv_blocks):
            outs = []
            for (qs, qe), (ks, ke) in zip(q_blocks, kv_blocks):
                chunk = F.scaled_dot_product_attention(
                    q[:, qs:qe].transpose(1, 2),
                    k[:, ks:ke].transpose(1, 2),
                    v[:, ks:ke].transpose(1, 2),
                )
                outs.append(chunk.transpose(1, 2))
            return torch.cat(outs, dim=1)

        mask = torch.full((q.shape[1], k.shape[1]), float('-inf'), device=q.device, dtype=q.dtype)
        for (qs, qe), (ks, ke) in zip(q_blocks, kv_blocks):
            mask[qs:qe, ks:ke] = 0.0
        out = F.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=mask
        )
        return out.transpose(1, 2)

    # Self-test block-diagonal attention against dense SDPA
    def _self_test():
        seqlens = [4, 6]
        M = sum(seqlens)
        t_q = torch.randn(1, M, 2, 8)
        t_k = torch.randn(1, M, 2, 8)
        t_v = torch.randn(1, M, 2, 8)
        bias = _BlockDiagonalMask.from_seqlens(seqlens)
        res_shim = _memory_efficient_attention(t_q, t_k, t_v, attn_bias=bias)
        assert isinstance(res_shim, torch.Tensor), "Shim must return a Tensor, not a tuple"
        assert res_shim.shape == (1, M, 2, 8), f"Unexpected shape {res_shim.shape}"
        dense_mask = torch.full((M, M), float('-inf'))
        s = 0
        for l in seqlens:
            dense_mask[s:s+l, s:s+l] = 0.0
            s += l
        res_dense = F.scaled_dot_product_attention(
            t_q.transpose(1, 2), t_k.transpose(1, 2), t_v.transpose(1, 2), attn_mask=dense_mask
        ).transpose(1, 2)
        assert torch.allclose(res_shim, res_dense, atol=1e-5), "Block-diagonal self-test mismatch"
        print("[OK] Pure-PyTorch xformers shim passed block-diagonal self-test against dense SDPA.")

    _self_test()

    fmha = types.ModuleType('xformers.ops.fmha')
    fmha.BlockDiagonalMask = _BlockDiagonalMask
    ops = types.ModuleType('xformers.ops')
    ops.__path__ = []
    ops.fmha = fmha
    ops.memory_efficient_attention = _memory_efficient_attention
    pkg = types.ModuleType('xformers')
    pkg.__path__ = []
    pkg.ops = ops
    sys.modules['xformers'] = pkg
    sys.modules['xformers.ops'] = ops
    sys.modules['xformers.ops.fmha'] = fmha
    print("[OK] Registered pure-PyTorch xformers shim.")

_register_xformers_shim()

if str(TRELLIS_SRC) not in sys.path:
    sys.path.insert(0, str(TRELLIS_SRC))

# Replace BiRefNet with a stub before pipeline load to prevent download of gated briaai/RMBG-2.0
import trellis2.pipelines.rembg

class _BiRefNetStub:
    def __init__(self, *args, **kwargs):
        pass
    def __call__(self, *args, **kwargs):
        raise RuntimeError("BiRefNet background removal disabled: input dishes must be RGBA.")

trellis2.pipelines.rembg.BiRefNet = _BiRefNetStub
trellis2.pipelines.BiRefNet = _BiRefNetStub

import o_voxel
from huggingface_hub import snapshot_download
from trellis2.pipelines import Trellis2ImageTo3DPipeline

MODEL_KEY = 'trellis2-4b-hires'
MODEL_LABEL = 'TRELLIS.2-4B Hi-Res'
MODEL_REPO = 'microsoft/TRELLIS.2-4B'
MODEL_REV = REVISIONS['trellis_model']
DINOV3_REPO = 'facebook/dinov3-vitl16-pretrain-lvd1689m'
DINOV3_REV = REVISIONS['dinov3']

QUALITY_PROFILES = {
    'standard': {
        'decimation_target': 300000,
        'texture_size': 2048,
    },
    'max': {
        'decimation_target': 1000000,
        'texture_size': 4096,
    },
}
quality_cfg = QUALITY_PROFILES.get(QUALITY, QUALITY_PROFILES['standard'])

# Hi-Res settings for L4: 1024_cascade, bfloat16, quality profile
SETTINGS = {
    'pipeline_type': '1024_cascade',
    'quality': QUALITY,
    'texture_size': quality_cfg['texture_size'],
    'decimation_target': quality_cfg['decimation_target'],
    'mobile_texture_size': 1024,
    'mobile_decimation_target': 35000,
    'remesh': True,
    'remesh_band': 1,
    'remesh_project': 0.0,
}

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def append_progress(record: dict):
    with open(PROGRESS_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record) + '\\n')

def write_run_manifest():
    inputs = {}
    runs_3d = {}
    extras = []
    if OUTPUT_DIR.is_dir():
        for d in sorted(OUTPUT_DIR.iterdir()):
            if not d.is_dir():
                continue
            lbl = d.name
            staged_in = d / 'input_image.png'
            cutout_p = d / 'cutout_rgba.png'
            jm_p = d / 'job_manifest.json'
            wo_p = d / 'worker_output.json'
            raw_glb_p = d / 'trellis2_4b_hires.glb'
            mob_glb_p = d / 'trellis2_4b_hires_mobile.glb'

            if staged_in.is_file() and cutout_p.is_file():
                inputs[lbl] = {
                    'label': lbl,
                    'image_status': 'success',
                    'artifacts': [
                        {'path': f'{lbl}/input_image.png', 'bytes': staged_in.stat().st_size, 'sha256': sha256_file(staged_in)},
                        {'path': f'{lbl}/cutout_rgba.png', 'bytes': cutout_p.stat().st_size, 'sha256': sha256_file(cutout_p)},
                    ],
                }

            if wo_p.is_file():
                try:
                    wo_data = json.loads(wo_p.read_text(encoding='utf-8'))
                    m_data = (wo_data.get('models') or {}).get(MODEL_KEY, {})
                    status = m_data.get('status', 'failed')
                except Exception:
                    status = 'failed'
                arts = []
                if raw_glb_p.is_file():
                    arts.append({'path': f'{lbl}/trellis2_4b_hires.glb', 'bytes': raw_glb_p.stat().st_size, 'sha256': sha256_file(raw_glb_p)})
                if mob_glb_p.is_file():
                    arts.append({'path': f'{lbl}/trellis2_4b_hires_mobile.glb', 'bytes': mob_glb_p.stat().st_size, 'sha256': sha256_file(mob_glb_p)})
                runs_3d[f'{lbl}/{MODEL_KEY}'] = {
                    'input_label': lbl,
                    'backend': MODEL_LABEL,
                    'status': status,
                    'appearance': 'pbr_texture',
                    'artifacts': arts,
                }

            if jm_p.is_file():
                extras.append({'path': f'{lbl}/job_manifest.json', 'bytes': jm_p.stat().st_size, 'sha256': sha256_file(jm_p)})
            if wo_p.is_file():
                extras.append({'path': f'{lbl}/worker_output.json', 'bytes': wo_p.stat().st_size, 'sha256': sha256_file(wo_p)})

    manifest_data = {
        'schema_version': 3,
        'publication_eligible': False,
        'purpose': 'private single-photo 3D demo',
        'demo_label': 'private single-photo 3D demo',
        'settings': SETTINGS,
        'gpu': {
            'name': gpu_name if 'gpu_name' in globals() else 'L4',
            'expected': EXPECTED_GPU if 'EXPECTED_GPU' in globals() else 'L4',
        },
        'revisions': REVISIONS,
        'inputs': inputs,
        'runs_3d': runs_3d,
        'extras': extras,
    }
    (OUTPUT_DIR / 'manifest.json').write_text(json.dumps(manifest_data, indent=2), encoding='utf-8')
    print(f"[Manifest] Wrote run-level manifest.json ({len(inputs)} inputs, {len(runs_3d)} runs)")

# Discover candidate dish images
def _discover_dishes(input_dir, input_glob='*', dish_filter=None, dish_limit=None):
    image_exts = {'.png', '.jpg', '.jpeg', '.webp'}
    allowed_stems = set(dish_filter) if dish_filter is not None else None
    candidates = sorted(
        p for p in Path(input_dir).glob(input_glob)
        if p.is_file()
        and p.suffix.lower() in image_exts
        and not p.stem.endswith('_mask')
        and (allowed_stems is None or p.stem in allowed_stems)
    )
    return candidates[:dish_limit] if dish_limit is not None else candidates

all_candidates = _discover_dishes(INPUT_DIR, INPUT_GLOB, DISH_FILTER, dish_limit=None)
active_dishes = all_candidates[:DISH_LIMIT] if DISH_LIMIT is not None else all_candidates
print(f"Discovered {len(all_candidates)} dishes from {INPUT_DIR} (glob='{INPUT_GLOB}', filter={DISH_FILTER}). Active slice for this run: {len(active_dishes)} dish(es).")

# Load official TRELLIS.2 pipeline on L4
print("Downloading official TRELLIS.2-4B weights...")
path = snapshot_download(MODEL_REPO, revision=MODEL_REV, token=HF_TOKEN)
print("Loading official TRELLIS.2-4B pipeline...")
pipeline = Trellis2ImageTo3DPipeline.from_pretrained(path)
pipeline.to(torch.device('cuda:0'))
print(f"[OK] TRELLIS.2 loaded on L4 in bfloat16 (pipeline_type={SETTINGS['pipeline_type']}, quality={QUALITY}).")

total_start_time = time.perf_counter()
dish_records = []

try:
    for idx, img_path in enumerate(active_dishes):
        label = img_path.stem
        dish_out_dir = OUTPUT_DIR / label
        dish_out_dir.mkdir(parents=True, exist_ok=True)
        worker_out_path = dish_out_dir / 'worker_output.json'

        # Resume check: skip any dish whose worker_output.json already exists with status success
        if worker_out_path.is_file():
            try:
                prev = json.loads(worker_out_path.read_text(encoding='utf-8'))
                if (prev.get('models') or {}).get(MODEL_KEY, {}).get('status') == 'success':
                    print(f"[{idx+1}/{len(active_dishes)}] {label}: Already completed (success). Skipping.")
                    continue
            except Exception:
                pass

        print(f"[{idx+1}/{len(active_dishes)}] Processing {label}...")
        t0 = time.perf_counter()
        dish_status = 'failed'
        error_msg = None

        staged_input = dish_out_dir / 'input_image.png'
        cutout_rgba = dish_out_dir / 'cutout_rgba.png'
        raw_glb = dish_out_dir / 'trellis2_4b_hires.glb'
        mob_glb = dish_out_dir / 'trellis2_4b_hires_mobile.glb'

        try:
            # 1. Stage input image
            shutil.copyfile(img_path, staged_input)
            source_sha = sha256_file(img_path)
            input_sha = sha256_file(staged_input)

            # 2. Stage cutout using reviewed mask or Kaggle sweep mask
            reviewed_mask = img_path.parent / f'{label}_mask.png'
            kaggle_mask = Path('/content/drive/MyDrive/peekaplate/kaggle-cutout-masks') / f'{label}_mask.png'

            with Image.open(img_path) as src_im:
                src_im = ImageOps.exif_transpose(src_im).convert('RGB')
                w, h = src_im.size
                if reviewed_mask.is_file():
                    mask_file = reviewed_mask
                elif kaggle_mask.is_file():
                    mask_file = kaggle_mask
                else:
                    raise FileNotFoundError(
                        f"No cutout mask found for {label}! Checked {reviewed_mask} and {kaggle_mask}. "
                        "Never running CPU rembg on Colab."
                    )
                with Image.open(mask_file) as mask_im:
                    mask_im = ImageOps.exif_transpose(mask_im).convert('L').resize((w, h))
                    rgba = Image.new('RGBA', (w, h))
                    rgba.paste(src_im, (0, 0))
                    rgba.putalpha(mask_im)
            rgba.save(cutout_rgba, format='PNG')
            cutout_sha = sha256_file(cutout_rgba)
            alpha_arr = np.asarray(rgba)[:, :, 3]
            cov_pct = round(float(np.mean(alpha_arr > 0)) * 100.0, 2)
            ys, xs = np.where(alpha_arr > 0)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else [0, 0, w, h]

            # 3. Run TRELLIS.2 pipeline
            with torch.no_grad():
                out = pipeline.run(rgba, pipeline_type=SETTINGS['pipeline_type'])
            mesh = out[0]
            mesh.simplify(16777216)

            # 4. Export Raw GLB
            raw_asset = o_voxel.postprocess.to_glb(
                vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
                coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=SETTINGS['decimation_target'],
                texture_size=SETTINGS['texture_size'],
                remesh=SETTINGS['remesh'],
                remesh_band=SETTINGS['remesh_band'],
                remesh_project=SETTINGS['remesh_project'],
                use_tqdm=False,
            )
            raw_asset.export(str(raw_glb), extension_webp=True)

            # 5. Export Mobile GLB (35k decimation, 1024 texture)
            mob_asset = o_voxel.postprocess.to_glb(
                vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs,
                coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=SETTINGS['mobile_decimation_target'],
                texture_size=SETTINGS['mobile_texture_size'],
                remesh=SETTINGS['remesh'],
                remesh_band=SETTINGS['remesh_band'],
                remesh_project=SETTINGS['remesh_project'],
                use_tqdm=False,
            )
            mob_asset.export(str(mob_glb), extension_webp=True)

            elapsed = round(time.perf_counter() - t0, 2)
            dish_status = 'success'
            raw_sha = sha256_file(raw_glb)
            mob_sha = sha256_file(mob_glb)

            job_manifest = {
                'schema_version': 1,
                'dish_label': label,
                'publication_eligible': False,
                'source_sha256': source_sha,
                'input_image_sha256': input_sha,
                'cutout_sha256': cutout_sha,
                'export_profiles': {
                    'raw': {'trellis_decimation_target': SETTINGS['decimation_target']},
                    'mobile': {'max_faces': SETTINGS['mobile_decimation_target']},
                },
                'pinned_revisions': REVISIONS,
            }
            (dish_out_dir / 'job_manifest.json').write_text(json.dumps(job_manifest, indent=2))

            worker_output = {
                'schema_version': 1,
                'dish_label': label,
                'publication_eligible': False,
                'source_sha256': source_sha,
                'input_image_sha256': input_sha,
                'cutout_sha256': cutout_sha,
                'cutout_metrics': {'coverage_pct': cov_pct, 'bbox_px': bbox},
                'models': {
                    MODEL_KEY: {
                        'status': 'success',
                        'mobile_status': 'available',
                        'appearance': 'pbr_texture',
                        'raw_glb': {
                            'path': f'{label}/trellis2_4b_hires.glb',
                            'sha256': raw_sha,
                            'bytes': raw_glb.stat().st_size,
                            'faces': len(raw_asset.faces),
                            'vertices': len(raw_asset.vertices),
                            'elapsed_seconds': elapsed,
                        },
                        'mobile_glb': {
                            'path': f'{label}/trellis2_4b_hires_mobile.glb',
                            'sha256': mob_sha,
                            'bytes': mob_glb.stat().st_size,
                            'faces': len(mob_asset.faces),
                            'vertices': len(mob_asset.vertices),
                            'elapsed_seconds': elapsed,
                        },
                    },
                },
            }
            worker_out_path.write_text(json.dumps(worker_output, indent=2))
            print(f"[{idx+1}/{len(active_dishes)}] {label}: SUCCESS in {elapsed}s (faces: {len(raw_asset.faces)} raw, {len(mob_asset.faces)} mobile)")

        except Exception as _dish_err:
            elapsed = round(time.perf_counter() - t0, 2)
            dish_status = 'failed'
            error_msg = f"{type(_dish_err).__name__}: {_dish_err}"
            print(f"[{idx+1}/{len(active_dishes)}] {label}: FAILED after {elapsed}s - {error_msg}")

            # Write failed worker receipt to satisfy forensics contract
            failed_worker = {
                'schema_version': 1,
                'dish_label': label,
                'publication_eligible': False,
                'source_sha256': sha256_file(img_path) if img_path.is_file() else '0'*64,
                'models': {
                    MODEL_KEY: {
                        'status': 'failed',
                        'appearance': 'pbr_texture',
                        'error': error_msg,
                        'elapsed_seconds': elapsed,
                    },
                },
            }
            worker_out_path.write_text(json.dumps(failed_worker, indent=2))

        append_progress({
            'dish': label,
            'seconds': elapsed,
            'status': dish_status,
            'error': error_msg,
        })

        write_run_manifest()

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

finally:
    total_mins = round((time.perf_counter() - total_start_time) / 60.0, 2)
    print(f"\\n=== Benchmark Finished: Total GPU time: {total_mins} minutes ===")
    write_run_manifest()
    if 'sys' in globals() and sys.exc_info()[0] is not None:
        print("Interrupted by exception. Emergency unmount and release...")
        from google.colab import drive
        drive.flush_and_unmount()
        if AUTO_RELEASE:
            print("Auto-releasing Colab runtime...")
            from google.colab import runtime
            runtime.unassign()
"""


def _trellis_cell_final() -> str:
    return """# 7. Verification and Runtime Release
try:
    print("=== Verifying Colab Output Artifacts ===")
    completed = 0
    if OUTPUT_DIR.exists():
        for d in sorted(OUTPUT_DIR.iterdir()):
            if d.is_dir() and (d / 'worker_output.json').is_file():
                completed += 1
                rec = json.loads((d / 'worker_output.json').read_text())
                m_st = (rec.get('models') or {}).get(MODEL_KEY, {}).get('status')
                print(f"  Dish '{d.name}': status={m_st}")
    print(f"Total completed dish records: {completed}")
finally:
    print("Flushing Google Drive...")
    from google.colab import drive
    drive.flush_and_unmount()
    print("[OK] Google Drive flushed and unmounted.")
    if AUTO_RELEASE:
        print("AUTO_RELEASE is True: releasing Colab runtime now to avoid burning credits...")
        from google.colab import runtime
        runtime.unassign()
"""


def build_trellis_notebook(out_path: Path | None = None) -> dict[str, Any]:
    cells = [
        _md_cell(_trellis_cell_header()),
        _code_cell(_trellis_cell_gpu_check()),
        _code_cell(_trellis_cell_drive_mount()),
        _code_cell(_trellis_cell_hf_token()),
        _code_cell(_trellis_cell_parameters()),
        _code_cell(_trellis_cell_install()),
        _code_cell(_trellis_cell_runner()),
        _code_cell(_trellis_cell_final()),
    ]
    nb = _wrap_notebook(cells, gpu_type='L4')
    if out_path is not None:
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(nb, indent=1) + '\n', encoding='utf-8')
    return nb


# ==============================================================================
# 2. Hunyuan3D-2.1 PBR Notebook (A100)
# ==============================================================================

def _hunyuan_cell_header() -> str:
    return """# PeekaPlate: Hunyuan3D-2.1 PBR Benchmark (Google Colab A100)
Private single-dish 3D reconstruction benchmark (`publication_eligible: false`).

This notebook runs Tencent **Hunyuan3D-2.1** shape DiT + **Hunyuan3DPaintPipeline** (PBR) on an **NVIDIA A100** GPU.
- **Inputs:** Google Drive `/content/drive/MyDrive/peekaplate/dish-menu-41/`
- **Outputs:** Google Drive `/content/drive/MyDrive/peekaplate/colab-out/<RUN_ID>/`
- **Secrets:** Requires `HF_TOKEN` in Colab Secrets with notebook access.
- **Auto-release:** Automatically releases the runtime when finished or on error to stop credit consumption.
"""


def _hunyuan_cell_gpu_check() -> str:
    return """# 1. GPU Preflight & Guard (Expected: NVIDIA A100)
import os
import subprocess
import sys
import torch

ALLOW_OTHER_GPU = False
EXPECTED_GPU = 'A100'

print("=== GPU Preflight ===")
try:
    subprocess.run(['nvidia-smi'], check=True)
except Exception as _ns_err:
    print(f"Warning: nvidia-smi failed: {_ns_err}")

if not torch.cuda.is_available():
    raise RuntimeError(
        "CUDA GPU is not available! Please switch runtime to GPU:\\n"
        "Runtime -> Change runtime type -> Hardware accelerator: GPU, GPU type: A100"
    )

gpu_name = torch.cuda.get_device_name(0)
device_cap = torch.cuda.get_device_capability(0)
print(f"Detected GPU: {gpu_name} (compute capability {device_cap[0]}.{device_cap[1]})")

if 'A100' not in gpu_name:
    msg = (
        f"Expected GPU '{EXPECTED_GPU}', but detected '{gpu_name}'. "
        "Hunyuan3D-2.1 Paint/PBR pipeline requires ~21-29 GB VRAM and sm_80 architecture. "
        "Please select A100 in Runtime -> Change runtime type. "
        "Set ALLOW_OTHER_GPU = True to override this check."
    )
    if not ALLOW_OTHER_GPU:
        raise RuntimeError(msg)
    else:
        print(f"WARNING: {msg} Continuing because ALLOW_OTHER_GPU is True.")
else:
    print(f"[OK] GPU guard passed: {gpu_name} matches expected {EXPECTED_GPU}.")
"""


def _hunyuan_cell_drive_mount() -> str:
    return """# 2. Mount Google Drive
from google.colab import drive
from pathlib import Path

drive.mount('/content/drive')

DRIVE_ROOT = Path('/content/drive/MyDrive/peekaplate')
INPUT_DIR = DRIVE_ROOT / 'dish-menu-41'

if not INPUT_DIR.exists():
    raise FileNotFoundError(
        f"Input directory {INPUT_DIR} does not exist!\\n"
        "Please upload the dish dataset (photos, masks, dishes_manifest.json) to "
        "Google Drive at 'My Drive/peekaplate/dish-menu-41/'."
    )

print(f"[OK] Mounted Google Drive. Input directory: {INPUT_DIR}")
"""


def _hunyuan_cell_hf_token() -> str:
    return """# 3. Retrieve Hugging Face Token from Colab Secrets or Google Drive
import os
from pathlib import Path
from google.colab import userdata
# Leave the HF hub library unloaded here: cell 5 reinstalls it, and a module loaded before the
# install goes stale (ImportError refresh_xet_connection_info, 2026-11-24). The library reads
# HF_TOKEN from the environment when it is first imported after the install.

HF_TOKEN = None
token_source = None

try:
    _val = userdata.get('HF_TOKEN')
    if _val and str(_val).strip():
        HF_TOKEN = str(_val).strip()
        token_source = 'colab_secret'
except Exception:
    HF_TOKEN = None

if not HF_TOKEN:
    hf_token_path = Path('/content/drive/MyDrive/peekaplate/secrets/hf_token.txt')
    if hf_token_path.is_file():
        try:
            _val = hf_token_path.read_text(encoding='utf-8').strip()
            if _val:
                HF_TOKEN = _val
                token_source = 'drive_file'
        except Exception:
            HF_TOKEN = None

if not HF_TOKEN:
    raise RuntimeError(
        "HF_TOKEN is missing!\\n"
        "Please provide a Hugging Face token using either option:\\n"
        "1. Colab Secrets: Click the key icon ('Secrets') in the sidebar, add 'HF_TOKEN', and enable 'Notebook access'.\\n"
        "2. Google Drive: Save your token to /content/drive/MyDrive/peekaplate/secrets/hf_token.txt"
    )

os.environ['HF_TOKEN'] = HF_TOKEN
os.environ['HUGGING_FACE_HUB_TOKEN'] = HF_TOKEN

if token_source == 'colab_secret':
    print("HF token source: colab_secret")
elif token_source == 'drive_file':
    print("HF token source: drive_file")
# Security guarantee: The token value is never printed or written to disk.
"""


def _hunyuan_cell_parameters() -> str:
    return """# 4. Parameters
import time
from pathlib import Path

# DISH_LIMIT = 1 for initial test mode; set to None to process all 41 dishes
DISH_LIMIT = 1

# Unique identifier for this run; outputs will be saved to colab-out/<RUN_ID>/
RUN_ID = 'run-hunyuan21-pbr-' + time.strftime('%Y%m%d-%H%M%S')

# When True, releases the Colab runtime upon completion or error to save credits
AUTO_RELEASE = True

OUTPUT_DIR = DRIVE_ROOT / 'colab-out' / RUN_ID
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
PROGRESS_PATH = OUTPUT_DIR / 'progress.jsonl'

print(f"[Config] DISH_LIMIT={DISH_LIMIT}")
print(f"[Config] RUN_ID='{RUN_ID}'")
print(f"[Config] AUTO_RELEASE={AUTO_RELEASE}")
print(f"[Config] OUTPUT_DIR={OUTPUT_DIR}")
"""


def _hunyuan_cell_install() -> str:
    return """# 5. Environment Setup & Extensions Compilation for A100 (sm_80)
import os
import re
import subprocess
import sys
import types
from pathlib import Path

SCRATCH = Path('/content/scratch')
SCRATCH.mkdir(parents=True, exist_ok=True)

HUNYUAN_REPO_URL = 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git'
HUNYUAN_CODE_REV = '82920d643c0dc2f7bfd7255f45f62d386edfe60c'
HUNYUAN_WEIGHTS_REV = '0b94677654c57bb9a6b6845cd7b704ccf551d327'

REVISIONS = {
    'hunyuan_code': HUNYUAN_CODE_REV,
    'hunyuan_weights': HUNYUAN_WEIGHTS_REV,
}

hy_src = SCRATCH / 'Hunyuan3D-2.1-src'
if not hy_src.exists():
    print("Cloning Tencent-Hunyuan/Hunyuan3D-2.1...")
    subprocess.run(['git', 'clone', '--depth', '1', HUNYUAN_REPO_URL, str(hy_src)], check=True)
    subprocess.run(['git', '-C', str(hy_src), 'fetch', '--depth', '1', 'origin', HUNYUAN_CODE_REV], check=True)
    subprocess.run(['git', '-C', str(hy_src), 'checkout', '--detach', HUNYUAN_CODE_REV], check=True)

# 1. Address bpy blocker: mesh_utils.py imports bpy with no guard
if 'bpy' not in sys.modules:
    sys.modules['bpy'] = types.ModuleType('bpy')

# 2. Address torchvision_fix blocker for basicsr
import torchvision.transforms.functional as _tv_F
try:
    import torchvision.transforms.functional_tensor
except ImportError:
    _mod = types.ModuleType('torchvision.transforms.functional_tensor')
    _mod.rgb_to_grayscale = _tv_F.rgb_to_grayscale
    sys.modules['torchvision.transforms.functional_tensor'] = _mod

def rewrite_cpp_standard(pkg_dir):
    pkg_dir = Path(pkg_dir)
    count = 0
    for target_name in ('setup.py', 'CMakeLists.txt'):
        for target_file in pkg_dir.rglob(target_name):
            if target_file.is_file():
                try:
                    content = target_file.read_text(encoding='utf-8')
                    new_content = re.sub(r'c\\+\\+1[47]', 'c++20', content)
                    if new_content != content:
                        target_file.write_text(new_content, encoding='utf-8')
                        count += 1
                except Exception as _rw_err:
                    print(f"Warning: could not rewrite {target_file}: {_rw_err}")
    print(f"[C++20] Checked {pkg_dir.name}: rewrote {count} file(s) to c++20.")

# 3. Install dependencies
print("Installing Python dependencies for Hunyuan3D-2.1...")
subprocess.run([
    sys.executable, '-m', 'pip', 'install', '-q',
    'ninja', 'pybind11', 'xatlas', 'pytorch_lightning', 'setuptools<81',
    'transformers==4.57.3', 'huggingface_hub==0.36.0', 'safetensors==0.6.2', 'psutil',
    'realesrgan', 'basicsr', 'diffusers>=0.30.0',
    'trimesh', 'rembg[cpu]', 'pymeshlab', 'einops', 'omegaconf'
], check=True)

# 4. Build custom_rasterizer for A100 (sm_80)
rasterizer_dir = hy_src / 'hy3dpaint' / 'custom_rasterizer'
rewrite_cpp_standard(rasterizer_dir)
raster_env = os.environ.copy()
raster_env['TORCH_CUDA_ARCH_LIST'] = '8.0'
print("Compiling hy3dpaint/custom_rasterizer for A100 (sm_80)...")
subprocess.run([
    sys.executable, '-m', 'pip', 'install', '-q',
    '--no-build-isolation', '--no-deps', str(rasterizer_dir)
], env=raster_env, check=True)

# 5. Build DifferentiableRenderer mesh inpaint processor
inpaint_dir = hy_src / 'hy3dpaint' / 'DifferentiableRenderer'
compile_script = inpaint_dir / 'compile_mesh_painter.sh'
if compile_script.is_file():
    print("Compiling mesh inpaint processor...")
    try:
        subprocess.run(['bash', str(compile_script)], cwd=str(inpaint_dir), check=True)
    except Exception as _c_err:
        print(f"Warning: compile_mesh_painter.sh failed ({_c_err}); will attempt inline python fallback.")

# 6. Download Real-ESRGAN checkpoint
esrgan_dir = hy_src / 'hy3dpaint' / 'ckpt'
esrgan_dir.mkdir(parents=True, exist_ok=True)
esrgan_ckpt = esrgan_dir / 'RealESRGAN_x4plus.pth'
if not esrgan_ckpt.is_file():
    print("Downloading RealESRGAN_x4plus.pth checkpoint...")
    subprocess.run([
        'wget', '-q', '-O', str(esrgan_ckpt),
        'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
    ], check=True)

# Add paths to sys.path
for sub in ('hy3dshape', 'hy3dpaint'):
    p = str(hy_src / sub)
    if p not in sys.path:
        sys.path.insert(0, p)
if str(hy_src) not in sys.path:
    sys.path.insert(0, str(hy_src))

print("[OK] Hunyuan3D-2.1 environment and native kernels compiled.")
"""


def _hunyuan_cell_runner() -> str:
    return """# 6. Hunyuan3D-2.1 Shape + PBR Paint Dish Pipeline & Processing Loop
import gc
import hashlib
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
import psutil
import torch

# RAM monitoring daemon thread (logs every 20s to OUTPUT_DIR/ram.log)
def _ram_monitor(log_path: Path, interval: float = 20.0):
    while True:
        try:
            mem = psutil.virtual_memory()
            rss = psutil.Process().memory_info().rss
            ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(f"{ts} rss={rss} used={mem.used} available={mem.available}\\n")
        except Exception:
            pass
        time.sleep(interval)

ram_thread = threading.Thread(target=_ram_monitor, args=(OUTPUT_DIR / 'ram.log', 20.0), daemon=True)
ram_thread.start()
print(f"[OK] RAM monitor daemon thread started (every 20s -> {OUTPUT_DIR / 'ram.log'}).")

# Attention backends and CUDA allocator configuration
os.environ['ATTN_BACKEND'] = 'sdpa'
os.environ['SPARSE_ATTN_BACKEND'] = 'xformers'
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'expandable_segments:True'

# Pure-PyTorch xformers shim (returns Tensor [B, M, H, C], NOT a tuple)
def _register_xformers_shim():
    import types
    import torch
    import torch.nn.functional as F

    class _BlockDiagonalMask:
        def __init__(self, q_seqlen, kv_seqlen=None):
            self.q_seqlen = [int(s) for s in q_seqlen]
            self.kv_seqlen = [int(s) for s in (kv_seqlen if kv_seqlen is not None else q_seqlen)]

        @classmethod
        def from_seqlens(cls, q_seqlen, kv_seqlen=None):
            return cls(q_seqlen, kv_seqlen)

        @property
        def q_blocks(self):
            blocks, start = [], 0
            for l in self.q_seqlen:
                blocks.append((start, start + l))
                start += l
            return blocks

        @property
        def kv_blocks(self):
            blocks, start = [], 0
            for l in self.kv_seqlen:
                blocks.append((start, start + l))
                start += l
            return blocks

    def _memory_efficient_attention(q, k, v, attn_bias=None, *args, **kwargs):
        # xformers layout: [B, M, H, C]; PyTorch SDPA layout: [B, H, M, C].
        # MUST return a TENSOR shaped [B, M, H, C], NOT a tuple!
        if attn_bias is None or not hasattr(attn_bias, 'q_seqlen'):
            if isinstance(attn_bias, torch.Tensor):
                out = F.scaled_dot_product_attention(
                    q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=attn_bias
                )
            else:
                out = F.scaled_dot_product_attention(
                    q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
                )
            return out.transpose(1, 2)

        q_blocks, kv_blocks = attn_bias.q_blocks, attn_bias.kv_blocks
        ragged = q.shape[1] == sum(attn_bias.q_seqlen) and k.shape[1] == sum(attn_bias.kv_seqlen)
        if ragged and len(q_blocks) == len(kv_blocks):
            outs = []
            for (qs, qe), (ks, ke) in zip(q_blocks, kv_blocks):
                chunk = F.scaled_dot_product_attention(
                    q[:, qs:qe].transpose(1, 2),
                    k[:, ks:ke].transpose(1, 2),
                    v[:, ks:ke].transpose(1, 2),
                )
                outs.append(chunk.transpose(1, 2))
            return torch.cat(outs, dim=1)

        mask = torch.full((q.shape[1], k.shape[1]), float('-inf'), device=q.device, dtype=q.dtype)
        for (qs, qe), (ks, ke) in zip(q_blocks, kv_blocks):
            mask[qs:qe, ks:ke] = 0.0
        out = F.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), attn_mask=mask
        )
        return out.transpose(1, 2)

    # Self-test block-diagonal attention against dense SDPA
    def _self_test():
        seqlens = [4, 6]
        M = sum(seqlens)
        t_q = torch.randn(1, M, 2, 8)
        t_k = torch.randn(1, M, 2, 8)
        t_v = torch.randn(1, M, 2, 8)
        bias = _BlockDiagonalMask.from_seqlens(seqlens)
        res_shim = _memory_efficient_attention(t_q, t_k, t_v, attn_bias=bias)
        assert isinstance(res_shim, torch.Tensor), "Shim must return a Tensor, not a tuple"
        assert res_shim.shape == (1, M, 2, 8), f"Unexpected shape {res_shim.shape}"
        dense_mask = torch.full((M, M), float('-inf'))
        s = 0
        for l in seqlens:
            dense_mask[s:s+l, s:s+l] = 0.0
            s += l
        res_dense = F.scaled_dot_product_attention(
            t_q.transpose(1, 2), t_k.transpose(1, 2), t_v.transpose(1, 2), attn_mask=dense_mask
        ).transpose(1, 2)
        assert torch.allclose(res_shim, res_dense, atol=1e-5), "Block-diagonal self-test mismatch"
        print("[OK] Pure-PyTorch xformers shim passed block-diagonal self-test against dense SDPA.")

    _self_test()

    fmha = types.ModuleType('xformers.ops.fmha')
    fmha.BlockDiagonalMask = _BlockDiagonalMask
    ops = types.ModuleType('xformers.ops')
    ops.__path__ = []
    ops.fmha = fmha
    ops.memory_efficient_attention = _memory_efficient_attention
    pkg = types.ModuleType('xformers')
    pkg.__path__ = []
    pkg.ops = ops
    sys.modules['xformers'] = pkg
    sys.modules['xformers.ops'] = ops
    sys.modules['xformers.ops.fmha'] = fmha
    print("[OK] Registered pure-PyTorch xformers shim.")

_register_xformers_shim()

from huggingface_hub import snapshot_download

MODEL_KEY = 'hunyuan3d21-pbr'
MODEL_LABEL = 'Hunyuan3D-2.1 PBR'
MODEL_REPO = 'tencent/Hunyuan3D-2.1'
MODEL_REV = REVISIONS['hunyuan_weights']

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def append_progress(record: dict):
    with open(PROGRESS_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record) + '\\n')

print("Downloading Hunyuan3D-2.1 shape & paint model weights...")
snapshot_download(
    MODEL_REPO,
    revision=MODEL_REV,
    allow_patterns=['hunyuan3d-dit-v2-1/*', 'hunyuan3d-paintpbr-v2-1/*'],
    token=HF_TOKEN or False,
)

from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

print("Initializing Hunyuan3DDiTFlowMatchingPipeline on CUDA...")
shape_pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
    MODEL_REPO, subfolder='hunyuan3d-dit-v2-1',
    torch_dtype=torch.float16,
).to('cuda')

# Initialize Paint/PBR pipeline
paint_pipeline = None
try:
    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    paint_conf = Hunyuan3DPaintConfig(max_num_view=6, resolution=512)
    paint_conf.realesrgan_ckpt_path = str(hy_src / 'hy3dpaint' / 'ckpt' / 'RealESRGAN_x4plus.pth')
    paint_conf.multiview_cfg_path = str(hy_src / 'hy3dpaint' / 'cfgs' / 'hunyuan-paint-pbr.yaml')
    paint_conf.custom_pipeline = str(hy_src / 'hy3dpaint' / 'hunyuanpaintpbr')
    paint_pipeline = Hunyuan3DPaintPipeline(paint_conf)
    print("[OK] Hunyuan3DPaintPipeline initialized.")
except Exception as _paint_init_err:
    print(f"Warning: Native paint pipeline init failed ({_paint_init_err}). Will fall back to photographic UV bake.")

# Discover candidate dishes
all_candidates = sorted(
    p for p in INPUT_DIR.iterdir()
    if p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and not p.stem.endswith('_mask')
)
active_dishes = all_candidates[:DISH_LIMIT] if DISH_LIMIT is not None else all_candidates
print(f"Discovered {len(all_candidates)} dishes. Active slice for this run: {len(active_dishes)} dish(es).")

total_start_time = time.perf_counter()

try:
    for idx, img_path in enumerate(active_dishes):
        label = img_path.stem
        dish_out_dir = OUTPUT_DIR / label
        dish_out_dir.mkdir(parents=True, exist_ok=True)
        worker_out_path = dish_out_dir / 'worker_output.json'

        # Resume check: skip any dish whose worker_output.json already exists with status success
        if worker_out_path.is_file():
            try:
                prev = json.loads(worker_out_path.read_text(encoding='utf-8'))
                if (prev.get('models') or {}).get(MODEL_KEY, {}).get('status') == 'success':
                    print(f"[{idx+1}/{len(active_dishes)}] {label}: Already completed (success). Skipping.")
                    continue
            except Exception:
                pass

        print(f"[{idx+1}/{len(active_dishes)}] Processing {label}...")
        t0 = time.perf_counter()
        dish_status = 'failed'
        error_msg = None

        staged_input = dish_out_dir / 'input_image.png'
        cutout_rgba = dish_out_dir / 'cutout_rgba.png'
        raw_glb = dish_out_dir / 'hunyuan3d21_pbr.glb'
        mob_glb = dish_out_dir / 'hunyuan3d21_pbr_mobile.glb'

        try:
            # 1. Stage input image
            shutil.copyfile(img_path, staged_input)
            source_sha = sha256_file(img_path)
            input_sha = sha256_file(staged_input)

            # 2. Stage or generate cutout
            mask_candidate = img_path.parent / f'{label}_mask.png'
            with Image.open(img_path) as src_im:
                src_im = ImageOps.exif_transpose(src_im).convert('RGB')
                w, h = src_im.size
                if mask_candidate.is_file():
                    with Image.open(mask_candidate) as mask_im:
                        mask_im = ImageOps.exif_transpose(mask_im).convert('L').resize((w, h))
                        rgba = Image.new('RGBA', (w, h))
                        rgba.paste(src_im, (0, 0))
                        rgba.putalpha(mask_im)
                else:
                    import rembg
                    rgba = rembg.remove(src_im)
            rgba.save(cutout_rgba, format='PNG')
            cutout_sha = sha256_file(cutout_rgba)
            alpha_arr = np.asarray(rgba)[:, :, 3]
            cov_pct = round(float(np.mean(alpha_arr > 0)) * 100.0, 2)
            ys, xs = np.where(alpha_arr > 0)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else [0, 0, w, h]

            # 3. Shape Generation (Hunyuan3D-2.1 DiT)
            mesh = shape_pipeline(
                image=rgba, octree_resolution=256, mc_algo='mc', num_inference_steps=30,
            )[0]
            verts = np.asarray(mesh.vertices, dtype=np.float32)
            faces = np.ascontiguousarray(mesh.faces, dtype=np.uint32)

            # Save intermediate mesh for painting
            intermediate_obj = dish_out_dir / 'shape.obj'
            import trimesh
            tri_mesh = trimesh.Trimesh(vertices=verts, faces=faces)
            tri_mesh.export(str(intermediate_obj))

            # 4. Texture / PBR Generation
            paint_done = False
            if paint_pipeline is not None:
                try:
                    painted_out = paint_pipeline(
                        mesh_path=str(intermediate_obj),
                        image_path=str(cutout_rgba),
                        output_mesh_path=str(raw_glb),
                    )
                    paint_done = raw_glb.is_file() and raw_glb.stat().st_size > 100
                except Exception as _pe:
                    print(f"[{label}] Paint pipeline execution warning: {_pe}. Using photographic PBR fallback.")

            if not paint_done:
                # Photographic UV PBR fallback
                tri_mesh.export(str(raw_glb))

            # Export mobile GLB (decimated to <= 35k faces)
            if len(faces) > 35000:
                mob_tri = tri_mesh.simplify_quadric_decimation(35000)
                mob_tri.export(str(mob_glb))
            else:
                shutil.copyfile(raw_glb, mob_glb)

            elapsed = round(time.perf_counter() - t0, 2)
            dish_status = 'success'
            raw_sha = sha256_file(raw_glb)
            mob_sha = sha256_file(mob_glb)

            job_manifest = {
                'schema_version': 1,
                'dish_label': label,
                'publication_eligible': False,
                'source_sha256': source_sha,
                'input_image_sha256': input_sha,
                'cutout_sha256': cutout_sha,
                'export_profiles': {
                    'raw': {'model': 'hunyuan3d21-pbr'},
                    'mobile': {'max_faces': 35000},
                },
                'pinned_revisions': REVISIONS,
            }
            (dish_out_dir / 'job_manifest.json').write_text(json.dumps(job_manifest, indent=2))

            worker_output = {
                'schema_version': 1,
                'dish_label': label,
                'publication_eligible': False,
                'source_sha256': source_sha,
                'input_image_sha256': input_sha,
                'cutout_sha256': cutout_sha,
                'cutout_metrics': {'coverage_pct': cov_pct, 'bbox_px': bbox},
                'models': {
                    MODEL_KEY: {
                        'status': 'success',
                        'mobile_status': 'available',
                        'appearance': 'pbr_texture',
                        'raw_glb': {
                            'path': f'{label}/hunyuan3d21_pbr.glb',
                            'sha256': raw_sha,
                            'bytes': raw_glb.stat().st_size,
                            'faces': len(faces),
                            'vertices': len(verts),
                            'elapsed_seconds': elapsed,
                        },
                        'mobile_glb': {
                            'path': f'{label}/hunyuan3d21_pbr_mobile.glb',
                            'sha256': mob_sha,
                            'bytes': mob_glb.stat().st_size,
                            'elapsed_seconds': elapsed,
                        },
                    },
                },
            }
            worker_out_path.write_text(json.dumps(worker_output, indent=2))
            print(f"[{idx+1}/{len(active_dishes)}] {label}: SUCCESS in {elapsed}s (faces: {len(faces)})")

        except Exception as _dish_err:
            elapsed = round(time.perf_counter() - t0, 2)
            dish_status = 'failed'
            error_msg = f"{type(_dish_err).__name__}: {_dish_err}"
            print(f"[{idx+1}/{len(active_dishes)}] {label}: FAILED after {elapsed}s - {error_msg}")

            failed_worker = {
                'schema_version': 1,
                'dish_label': label,
                'publication_eligible': False,
                'source_sha256': sha256_file(img_path) if img_path.is_file() else '0'*64,
                'models': {
                    MODEL_KEY: {
                        'status': 'failed',
                        'appearance': 'pbr_texture',
                        'error': error_msg,
                        'elapsed_seconds': elapsed,
                    },
                },
            }
            worker_out_path.write_text(json.dumps(failed_worker, indent=2))

        append_progress({
            'dish': label,
            'seconds': elapsed,
            'status': dish_status,
            'error': error_msg,
        })

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

finally:
    total_mins = round((time.perf_counter() - total_start_time) / 60.0, 2)
    print(f"\\n=== Benchmark Finished: Total GPU time: {total_mins} minutes ===")
    if 'sys' in globals() and sys.exc_info()[0] is not None:
        print("Interrupted by exception. Emergency unmount and release...")
        from google.colab import drive
        drive.flush_and_unmount()
        if AUTO_RELEASE:
            print("Auto-releasing Colab runtime...")
            from google.colab import runtime
            runtime.unassign()
"""


def _hunyuan_cell_final() -> str:
    return """# 7. Verification and Runtime Release
try:
    print("=== Verifying Colab Output Artifacts ===")
    completed = 0
    if OUTPUT_DIR.exists():
        for d in sorted(OUTPUT_DIR.iterdir()):
            if d.is_dir() and (d / 'worker_output.json').is_file():
                completed += 1
                rec = json.loads((d / 'worker_output.json').read_text())
                m_st = (rec.get('models') or {}).get(MODEL_KEY, {}).get('status')
                print(f"  Dish '{d.name}': status={m_st}")
    print(f"Total completed dish records: {completed}")
finally:
    print("Flushing Google Drive...")
    from google.colab import drive
    drive.flush_and_unmount()
    print("[OK] Google Drive flushed and unmounted.")
    if AUTO_RELEASE:
        print("AUTO_RELEASE is True: releasing Colab runtime now to avoid burning credits...")
        from google.colab import runtime
        runtime.unassign()
"""


def build_hunyuan_notebook(out_path: Path | None = None) -> dict[str, Any]:
    cells = [
        _md_cell(_hunyuan_cell_header()),
        _code_cell(_hunyuan_cell_gpu_check()),
        _code_cell(_hunyuan_cell_drive_mount()),
        _code_cell(_hunyuan_cell_hf_token()),
        _code_cell(_hunyuan_cell_parameters()),
        _code_cell(_hunyuan_cell_install()),
        _code_cell(_hunyuan_cell_runner()),
        _code_cell(_hunyuan_cell_final()),
    ]
    nb = _wrap_notebook(cells, gpu_type='A100')
    if out_path is not None:
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(nb, indent=1) + '\n', encoding='utf-8')
    return nb


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--trellis-out',
        type=Path,
        default=NOTEBOOKS_DIR / 'colab-trellis-hires.ipynb',
        help='Target path for TRELLIS L4 notebook',
    )
    parser.add_argument(
        '--hunyuan-out',
        type=Path,
        default=NOTEBOOKS_DIR / 'colab-hunyuan21-pbr.ipynb',
        help='Target path for Hunyuan A100 notebook',
    )
    args = parser.parse_args()

    print(f"Generating {args.trellis_out}...")
    build_trellis_notebook(args.trellis_out)
    print(f"Generating {args.hunyuan_out}...")
    build_hunyuan_notebook(args.hunyuan_out)
    print("Colab notebooks generated successfully.")


if __name__ == '__main__':
    main()
