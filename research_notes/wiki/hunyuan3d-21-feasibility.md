# Hunyuan3D-2.1 on Kaggle 2xT4: feasibility, 2026-11-23

This is read-only research done on 2026-11-23 and nothing was run on Kaggle. It compares code at GitHub `Tencent-Hunyuan/Hunyuan3D-2.1@82920d643c0dc2f7bfd7255f45f62d386edfe60c` (2025-10-17) with weights at HF `tencent/Hunyuan3D-2.1@0b94677654c57bb9a6b6845cd7b704ccf551d327`. Any per-dish time on a T4 below is an **estimate**. Measured numbers are labelled as measured.

## What runs today (measured, 2026-11-23)
- `processing/scripts/build_multi_model_notebooks.py` (`_hunyuan3d2_runner_cell`) loads `tencent/Hunyuan3D-2@9cd649ba…` with subfolder `hunyuan3d-dit-v2-0-fast` in fp16. It runs `octree_resolution=256, mc_algo='mc', num_inference_steps=30`. **The model output is shape only.** Colour comes from our own `bake_photographic_uv_pbr_glb` (appearance `pbr_photo_projection`, 1536 texture).
- An optional second pass with the native `Hunyuan3DPaintPipeline` has never run. The benchmark-a log reports `Native paint unavailable on T4 (ModuleNotFoundError: No module named 'xatlas')`, which means the 2.0 `custom_rasterizer` build got past `pip` on the cu128 image and the import then failed on xatlas. That is indirect evidence that the rasterizer compiles for sm_75 + cu128.
- Results from `/tmp/report/build-console.txt`: 19/19 success, median 440k faces, 11/19 watertight, roughly 66–71 s per dish including the bake. See [studio-build-2026-11-23](studio-build-2026-11-23.md) and [trellis-run-profile](trellis-run-profile.md).
- Kaggle image per `docs/research/dish-3d-delivery.md` and the notebook constraints: Python 3.13, torch 2.11.0+cu128.

## Shape model `hunyuan3d-dit-v2-1`
- [README "Models Zoo"](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1#-models-zoo) gives **10 GB VRAM for shape**, 21 GB for texture and 29 GB for both. The model has 3.3B parameters: [config.yaml](https://huggingface.co/tencent/Hunyuan3D-2.1/blob/main/hunyuan3d-dit-v2-1/config.yaml) describes a 21-layer DiT with 6 MoE layers (8 experts, top-2), 4096 latents and a DINOv2-large conditioner. The checkpoint `model.fp16.ckpt` is 7.37 GB.
- **fp16 works on a T4.** `pipelines.py` defaults to `dtype=torch.float16`, and attention is plain `F.scaled_dot_product_attention`. `use_flash_attn=False` is the default, and SageAttention loads only with `CA_USE_SAGEATTN=1`. The `bfloat16` autocasts sit in `flow_matching_sit.py`, which is the Lightning training module and is not imported at inference.
- There is no guidance-distilled "fast" variant. Defaults are `num_inference_steps=50`, `guidance_scale=7.5` (CFG, so batch 2) and `octree_resolution=384`.
- `from_pretrained` has no `revision` argument (`smart_load_model` in `hy3dshape/utils/utils.py`). To pin, pre-download into `$HY3DGEN_MODELS/tencent/Hunyuan3D-2.1/` with `snapshot_download(revision=…)`.
- Known bug: the shape pipeline's `enable_model_cpu_offload()` is broken ([#223](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/223), [#224](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/224), both opened 2026-11-21). It isn't needed at 10 GB.
- **Estimate:** 2–4 min per dish at 50 steps and octree 256. Compared with 2.0-fast this is about 3x the parameters, has CFG and uses 50 rather than 30 steps. Use 30 steps if that is too slow. That puts 41 dishes at roughly 1.5–3 h, inside one 12 h session.

## Paint/PBR model `hunyuan3d-paintpbr-v2-1`
- **The README states 21 GB.** `textureGenPipeline.py` puts everything on one `"cuda"` device: the multiview UNet in fp16, `facebook/dinov2-giant` in fp16 and Real-ESRGAN x4 at `half=True`. Defaults are `render_size=2048` and `texture_size=4096`, and there is no offload switch. In `gradio_app.py` the 2.1 `enable_model_cpu_offload` is commented out.
- Users report OOM on 16 GB and 24 GB cards ([#80](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/80)). Low-VRAM support is still open ([#85](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/85)). The only reported 16 GB success is a community third-party `mmgp` offload on a laptop 5080 ([#15](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/15)). The documented knobs are `max_num_view` 6–9 and `resolution` 512/768 (`demo.py`). Lowering `render_size`/`texture_size` means editing the config object. Moving DINOv2-giant and Real-ESRGAN to `cuda:1` would need code patches. **No one has demonstrated it on a 16 GB T4.**
- Extensions:
  - `custom_rasterizer` is a CUDA extension. It needs `--no-build-isolation` ([#81](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/81)). Set `TORCH_CUDA_ARCH_LIST=7.5`.
  - `DifferentiableRenderer/mesh_inpaint_processor` is CPU-only C++ built with pybind11.
  - Neither extension uses bf16 or flash-attn. The paint inference path is fp16 only, and its `.bfloat16()` calls sit in the Lightning `HunyuanPaint` class.
- Install blockers on Python 3.13:
  - `mesh_utils.py` imports `bpy` with no guard ([#200](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/issues/200), PR [#215](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/pull/215): no cp310 Linux bpy wheel exists).
  - `requirements.txt` pins `numpy==1.24.4`, `diffusers==0.30.0` and `transformers==4.46.0`.
  - `hunyuanpaintpbr/__init__` imports `pytorch_lightning`.
  - `basicsr` needs `torchvision_fix`.
  - None of this has been verified against diffusers or transformers 5.x on the Kaggle image.
- **Estimate (unmeasured):** 5–10 min per dish at 6 views/512, if it fits at all.

## Recommendation (2026-11-23)
- **(a) Use 2.1 shape with the existing photo-projection bake.** It drops in for v2-0-fast: the VRAM fits, it runs in fp16, it needs no CUDA extension and its imports are already present for 2.0 (`diffusers`, `transformers`, `pymeshlab`, `rembg`, `skimage`, `omegaconf`, `einops`). The output stays comparable with the other four models, which also use photo projection.
- (b) Defer full 2.1 PBR. Try it later in a separate probe kernel and treat it as likely to OOM.
- (c) Keep 2.0 as the measured baseline. Its paint pass is blocked only by a missing `pip install xatlas`, which is a cheap fix.

Install sketch for (a):
1. `git clone` the repo and check out `82920d64`.
2. Run `sys.path.insert(0, src/'hy3dshape')`.
3. Run `snapshot_download('tencent/Hunyuan3D-2.1', revision='0b946776…', allow_patterns=['hunyuan3d-dit-v2-1/*'], local_dir=$HY3DGEN_MODELS/tencent/Hunyuan3D-2.1)`.
4. Load with `from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline` and then `.from_pretrained('tencent/Hunyuan3D-2.1', subfolder='hunyuan3d-dit-v2-1')`.
5. Call it with `octree_resolution=256, mc_algo='mc', num_inference_steps=30–50`.

The model is not gated, so no HF token is needed.

Additional steps for (b):
1. `pip install xatlas pytorch_lightning "setuptools<81" realesrgan basicsr` (pins unverified).
2. `TORCH_CUDA_ARCH_LIST=7.5 pip install --no-build-isolation hy3dpaint/custom_rasterizer`.
3. Build the pybind11 `mesh_inpaint_processor` with the `EXT_SUFFIX` of the running interpreter.
4. Stub `sys.modules['bpy']` and call `paint(..., save_glb=False)`, then convert OBJ to GLB with trimesh.
5. Download the [RealESRGAN_x4plus.pth](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth) checkpoint.
6. Use `allow_patterns=['hunyuan3d-paintpbr-v2-1/*']` plus `facebook/dinov2-giant`.
7. Set absolute `multiview_cfg_path`/`custom_pipeline` paths.

## License
The [Tencent Hunyuan 3D 2.1 Community License](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE) has the same terms as the 2.0 licence already recorded in the notebook:
- It **does not apply in the EU, UK or South Korea**, and use of the Works or their Output outside that Territory is unlicensed (§5c). This covers where the operator is and, arguably, where the Kaggle VM runs.
- Output must not be used to improve any other AI model (§5b).
- A separate licence is needed above 1M MAU (§4).
- Tencent claims no rights in Output (§6d).

A private benchmark is allowed inside the Territory. Using the output as training data for any non-Hunyuan model is not.

Related: [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md), [studio-build-2026-11-23](studio-build-2026-11-23.md), [trellis-run-profile](trellis-run-profile.md), [kaggle-gpu-session-cap](kaggle-gpu-session-cap.md).
