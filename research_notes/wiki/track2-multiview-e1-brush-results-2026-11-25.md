# Track 2 E1, 2026-11-25: local multi-view reconstruction with Brush

Track 2 tested all-sides food reconstruction on three real CO3D v2 phone-orbit captures for the [photoreal food-3D goal](goal-photoreal-food-3d-pipeline.md). The run spent $0 on paid GPU time and $0 on APIs. Every R&D asset, report, contact sheet and studio stays `"publication_eligible": false` under [ADR 0004](../../docs/adr/0004-visual-tiers.md).

## Local stack and capture prep

Brush v0.3.0 ran on an NVIDIA GeForce RTX 3060 Laptop GPU (6144 MiB VRAM). Setting `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/nvidia_icd.json` forced NVIDIA Vulkan 1.4.357 so WebGPU/CubeCL selected the RTX 3060 over the integrated AMD Radeon graphics. The executable was `/home/yacine105/tools/brush/brush-app-x86_64-unknown-linux-gnu/brush_app`. Runs used `RUST_LOG=info` and these flags:

```sh
--total-steps 10000 --max-splats 500000 --max-resolution 1024 --eval-split-every 8 \
  --eval-every 5000 --eval-save-to-disk --export-every 10000 --match-alpha-weight 0.5 --seed 42
```

Run artifacts are in `/home/yacine105/kaggle-evals/track2-multiview-20261125/`. Each sequence had 202 raw entries, of which 100 `test_unseen` entries were skipped. All 102 known frames were retained at a maximum image dimension of 1024 px, with 89 training views and 13 held-out views per dish.

| Dish | CO3D sequence | Source dimensions | `train_mean_mask_hit_rate` | Median centroid reprojection | Visual-hull initial points |
|---|---|---|---:|---:|---:|
| `co3d_pizza` | `586_87341_172687` | 1016×1807 | 0.9895 | 3.12 px | 20,000 |
| `co3d_sandwich` | `432_61184_119599` | 1068×1901 | 0.9836 | 12.82 px | 20,000 |
| `co3d_hotdog` | `592_89300_179377` | 703×1251 | 0.9858 | 23.23 px | 20,000 |

- [co3d_to_colmap.py](../../processing/scripts/food3d/co3d_to_colmap.py) converts PyTorch3D `ndc_isotropic` cameras to OpenCV world-to-camera and Nerfstudio/OpenGL `transforms_train.json` and `transforms_val.json`. It initializes `points3d.ply` from the training-view visual hull, resizes premultiplied RGBA, isolates `eval_masks/` and checks symlinks and path containment.
- [multiview_prep.py](../../processing/scripts/food3d/multiview_prep.py) uses `-fps_mode passthrough` after FFmpeg n9.1 removed `-vsync 0`, with a legacy `-vsync 0` fallback. It requires at least two frames and records stable `<video>#frame=<n>` references.
- [build_track2_report.py](../../processing/scripts/food3d/build_track2_report.py) verifies the `eval_<step>` checkpoint and matches exact filename stems. It composites on the declared `--background black|white`, scores mask-normalized Gaussian `fg_ssim` and CIE76 `fg_delta_e`, and writes a 4×3 `track2_eval_sheet.png` and a safe, zero-CDN `track2_studio.html` (27,310 B).
- The recorded offline suite passed 30 tests across [test_food3d_track2.py](../../processing/tests/test_food3d_track2.py) and [test_food3d_input_qa.py](../../processing/tests/test_food3d_input_qa.py).

## Held-out results

The step 10,000 reports cover 13/13 held-out views per dish with `--background black` and masked foreground SSIM. Per-dish metrics and contact sheets are in the run's `reports/` directory.

| Dish | Train / eval | Train time (GPU / wall) | Final splats / PLY size | Full PSNR (mean / median) | FG PSNR (mean / median) | Full SSIM (mean) | FG SSIM (mean / median) | FG ΔE (mean / median) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `co3d_pizza` | 89 / 13 | 137 s / 141 s | 24,478 / 5.78 MB | 37.73 / 37.66 dB | 29.99 / 30.48 dB | 0.986 | 0.914 / 0.921 | 3.74 / 3.52 |
| `co3d_sandwich` | 89 / 13 | 139 s / 142 s | 25,565 / 6.03 MB | 37.98 / 37.83 dB | 30.99 / 31.55 dB | 0.990 | 0.945 / 0.951 | 2.26 / 2.01 |
| `co3d_hotdog` | 89 / 13 | 143 s / 146 s | 26,662 / 6.29 MB | 37.46 / 38.05 dB | 32.73 / 33.12 dB | 0.988 | 0.948 / 0.951 | 2.56 / 2.35 |

## Orbit video ingestion

The run made 102-frame MP4 orbit videos from the real captures and passed each through `multiview_prep.py --target-frames 4`. Each run selected four views and produced four RGBA cutouts.

| Orbit video | Size | Prep time | Triage |
|---|---:|---:|---|
| `co3d_pizza_orbit.mp4` | 13.27 MB | 157 s | `ready_single_photo` 1, `needs_multiview_or_reshoot` 3 |
| `co3d_sandwich_orbit.mp4` | 11.62 MB | 158 s | `ready_single_photo` 1, `needs_reshoot_clipped` 2, `needs_multiview_or_reshoot` 1 |
| `co3d_hotdog_orbit.mp4` | 4.91 MB | 148 s | `ready_single_photo` 2, `needs_multiview_or_reshoot` 2 |

`_run_cutout_isolated` starts a fresh [cutout_clean.py](../../processing/scripts/food3d/cutout_clean.py) subprocess per frame under `MemoryMax=4G`. Each frame took about 34–39 s with the cold CPU load of the 214 MB `birefnet-general-lite` ONNX model. A persistent or batch worker under the same memory cap could avoid those repeated loads before running 24-frame cutouts on long videos.

## Review and fixes

- **Brush ignore masks.** With CO3D masks in `masks/`, Brush's `find_mask_path` selected `AlphaMode::Masked`. Training ignored background loss and left white needle streaks in empty space. The pizza pilot scored 12.91 dB full-frame PSNR. Moving evaluation masks to `eval_masks/`, zeroing CO3D soft-tail alpha at values ≤127 and resizing premultiplied RGBA restored a clean black background with zero streaks and 37.73 dB full-frame PSNR.
- **Evaluation split.** The converter freezes split membership before pixel and mask QA and initializes `points3d.ply` strictly from training views. The separate `transforms_train.json` and `transforms_val.json` files avoid shadowing by `transforms.json`. A 10-step Brush v0.3.0 loader smoke test produced exactly 13/13 evaluation PNGs. The regression checks that changes to held-out data leave the initialization bytes identical. The three saved dish point clouds have distinct SHA-256 hashes. [Track 2 tests](../../processing/tests/test_food3d_track2.py)
- **Metrics and paths.** Foreground Gaussian SSIM normalizes local statistics over the mask, so changes outside the foreground leave it invariant. The run declared a black background. The report requires a unique highest `eval_<step>` checkpoint and complete view coverage by default, with symlink and root-containment checks across inputs, checkpoints, outputs and Track 1 reports. [Report builder](../../processing/scripts/food3d/build_track2_report.py)

## Exclusions and open gates

- `lerf_ramen` was excluded because the unpacked archive contained only a pre-trained `scene.ply` and binary semantic masks. `dxgl_apple` (405 MB) exceeded the dataset size cap. The CO3D `singlesequence` archives contained zero dense depth or `pointcloud.ply` files. Track 2B surface mesh and PBR extraction remain open pending a dense-depth or 2DGS run.
- [Track 1](food3d-v1-pbr-qa-pipeline-2026-11-24.md) evaluated relit single-photo GLBs at one inferred camera angle (5 WARN, 3 FAIL, IoU 0.6985–0.9892, ΔE 19.91–37.79, SSIM 0.096–0.402). Track 2 evaluated 3D Gaussian splats against held-out real camera views from a 360° orbit. The different reference views and protocols preclude ranking the tracks by these scores.
- First/last-frame video generation (FL2V) from 2–4 real photos remains open. The local 6 GB RTX 3060 configuration cannot fit the 14B FL2V models considered for the run, such as Wan2.1 14B. In-between synthesis awaits explicit approval for paid API or cloud credits (run estimate, $0.30–$0.40 per 5 s).

Serve the local studio:

```sh
python3 -m http.server -d /home/yacine105/kaggle-evals/track2-multiview-20261125 8766
```

Open `http://localhost:8766/track2_studio.html`.
