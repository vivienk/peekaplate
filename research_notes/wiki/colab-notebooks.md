# Google Colab Dish-3D Benchmark Notebooks (2026-11-23)

Private R&D benchmark notebooks for dish-to-3D models that exceed Kaggle 2xT4 VRAM or architecture limits:
- `notebooks/colab-trellis-hires.ipynb`: Microsoft TRELLIS.2-4B high-resolution (`1024_cascade`) on an **NVIDIA L4** (24 GB VRAM).
- `notebooks/colab-hunyuan21-pbr.ipynb`: Tencent Hunyuan3D-2.1 shape DiT + full PBR paint pipeline on an **NVIDIA A100** (40/80 GB VRAM).

Generated deterministically by `processing/scripts/build_colab_notebooks.py`.

---

## 1. What Each Notebook Does

### `colab-trellis-hires.ipynb` (NVIDIA L4)
- **Model key:** `trellis2-4b-hires`
- **Architecture:** TRELLIS.2-4B (`af44b45f`) official pipeline at high-resolution `1024_cascade` in native `bfloat16`.
- **Target GPU:** NVIDIA L4 (Ada Lovelace, sm_89, 24 GB VRAM). Fails closed if the GPU is not an L4 (override via `ALLOW_OTHER_GPU = True`).
- **Workaround removals:** Eliminates the T4 fp32 dual-GPU flow block sharding workaround used on Kaggle; runs unified single-GPU inference.
- **Output profiles:**
  - Raw PBR GLB: `trellis2_4b_hires.glb` (2048² texture, 300,000 face decimation).
  - Mobile PBR GLB: `trellis2_4b_hires_mobile.glb` (1024² texture, <=35,000 face decimation).
- **Drive streaming:** Each dish writes immediately to `/content/drive/MyDrive/peekaplate/colab-out/<RUN_ID>/<dish>/`.

### `colab-hunyuan21-pbr.ipynb` (NVIDIA A100)
- **Model key:** `hunyuan3d21-pbr`
- **Architecture:** Tencent Hunyuan3D-2.1 (`82920d64`) 3.3B MoE shape DiT (`hunyuan3d-dit-v2-1`) followed by `Hunyuan3DPaintPipeline` (`hunyuan-paint-pbr`, 6 views, 512 texture resolution) for true PBR albedo, metallic, roughness, and normal map synthesis.
- **Target GPU:** NVIDIA A100 (Ampere, sm_80, 40 GB or 80 GB). Fails closed if not on an A100 (override via `ALLOW_OTHER_GPU = True`).
- **Handled blockers (from [hunyuan3d21-feasibility](hunyuan3d-21-feasibility.md)):**
  - **`bpy` import:** `mesh_utils.py` imports `bpy` unconditionally; stubbed via `types.ModuleType('bpy')` so headless Colab avoids missing Blender dependencies.
  - **`basicsr` torchvision import:** Patches `torchvision.transforms.functional_tensor` to alias `torchvision.transforms.functional`.
  - **CUDA rasterizer:** Compiles `hy3dpaint/custom_rasterizer` with `TORCH_CUDA_ARCH_LIST="8.0"` for A100.
  - **Real-ESRGAN:** Automatically fetches `RealESRGAN_x4plus.pth` checkpoint to `hy3dpaint/ckpt/`.
- **Output profiles:**
  - Raw PBR GLB: `hunyuan3d21_pbr.glb` (PBR paint texture).
  - Mobile PBR GLB: `hunyuan3d21_pbr_mobile.glb` (decimated to <=35,000 faces).

---

## 2. User Steps to Run

1. **Upload Dataset to Google Drive:**
   Upload the 41 dish photos, reviewed masks, and `dishes_manifest.json` from `yacine105/peekaplate-dish-menu-41` to:
   ```
   My Drive/peekaplate/dish-menu-41/
   ├── 01_pizza.png
   ├── 01_pizza_mask.png
   ├── 02_tteokbokki.png
   ├── ...
   └── dishes_manifest.json
   ```
2. **Add HF Token Secret in Colab:**
   - In Colab, click the **key icon** ("Secrets") on the left sidebar.
   - Add a secret named `HF_TOKEN` with your personal Hugging Face user access token (required for gated `facebook/dinov3-vitl16-pretrain-lvd1689m` weights).
   - Toggle **Notebook access** to ON.
   - *Note:* The token is fetched via `google.colab.userdata` and is never printed or saved to disk.
3. **Open and Set Runtime:**
   - For TRELLIS hi-res: Open `notebooks/colab-trellis-hires.ipynb`, select **Runtime -> Change runtime type -> L4 GPU**.
   - For Hunyuan3D-2.1 PBR: Open `notebooks/colab-hunyuan21-pbr.ipynb`, select **Runtime -> Change runtime type -> A100 GPU**.
4. **Execution & Test Mode:**
   - `DISH_LIMIT = 1` by default (test mode). Run all cells to verify end-to-end setup and timing on dish `01`.
   - For the full sweep, set `DISH_LIMIT = None` and run.
5. **Resume:**
   - If interrupted or rerun with the same `RUN_ID`, any dish whose `worker_output.json` records `'status': 'success'` is skipped automatically.
6. **Auto-Release & Credit Protection:**
   - `AUTO_RELEASE = True` by default.
   - The final cell calls `drive.flush_and_unmount()` and then `google.colab.runtime.unassign()`.
   - The dish processing loop wraps execution in a `try...finally` block so that if an unhandled error terminates the loop, Google Drive is flushed and the runtime is unassigned immediately.

---

## 3. Expected Credit Consumption

Based on Google Colab Pro compute unit (CU) burn rates:
- **L4 GPU:** ~2.0 compute units per hour (~$0.20/hr equivalent).
  - 1-dish test: ~8–10 min (setup + compile + 1 dish) => **~0.3–0.4 credits**.
  - Full 41-dish run: ~6–7 min/dish => ~4.5–5 hours => **~9–12 credits**.
- **A100 GPU (Standard 40GB):** ~10–13 compute units per hour.
  - 1-dish test: ~10–12 min (setup + compile + shape + paint) => **~2.0–2.5 credits**.
  - Full 41-dish run: ~7–9 min/dish => ~5–6.5 hours => **~50–70 credits**.
- **Total budget:** Well within the user's current reserve of ~200 Colab credits.

---

## 4. Output Contract & Forensic Verification

Each completed dish folder `/content/drive/MyDrive/peekaplate/colab-out/<RUN_ID>/<dish>/` satisfies:
- `input_image.png`: Single-frame staged RGB image.
- `cutout_rgba.png`: Masked RGBA cutout preserving plate/dish boundaries.
- `job_manifest.json`: Stage 0/1 provenance and SHA-256 digests.
- `worker_output.json`: Worker receipt declaring model execution status, wall time, face/vertex counts, and artifact paths.
- `progress.jsonl`: Appended at `/content/drive/MyDrive/peekaplate/colab-out/<RUN_ID>/progress.jsonl` with per-dish elapsed time and status.
- Compatible with `processing/scripts/verify_kaggle_outputs.py` and `processing/scripts/build_dish_model_report.py`.
