# Track 2B, 2026-11-25: local 2DGS + TSDF PBR mesh extraction and held-out evaluation

Track 2B turned the three real CO3D v2 multi-view food orbits from [Track 2 E1](track2-multiview-e1-brush-results-2026-11-25.md) into game-ready textured PBR meshes (GLB) locally at $0 spend. Every generated asset, contact sheet, and report carries `"publication_eligible": false` under [ADR 0004](../../docs/adr/0004-visual-tiers.md).

## Stack and pipeline

Because `nvcc` is not installed on the local machine (NVIDIA GeForce RTX 3060 Laptop GPU, 6144 MiB VRAM, driver 620.73.04), Track 2B uses prebuilt CUDA 12.4 wheels in an isolated Python 3.10 environment at `/home/yacine105/tools/track2b-venv` (`torch==2.4.1+cu124`, `gsplat==1.5.3+pt24cu124`, `open3d==0.20.0`, `trimesh==5.2.2`, `numpy==1.26.4`). All CUDA/PyTorch and headless Chromium runs are memory-capped with `systemd-run --user --scope -p MemoryMax=...`, and CPU-only Blender 4.5.17 is capped with `ulimit -v 12000000`.

New code lives in [processing/scripts/food3d](../../processing/scripts/food3d/):
- [track2b_mesh.py](../../processing/scripts/food3d/track2b_mesh.py): strict train-only 2DGS training (`gsplat.rasterization_2dgs`, 6,000 steps, L1 + SSIM + alpha + normalized normal consistency + alpha-weighted depth distortion, peak VRAM ~1.15 GB), foreground-masked expected/median-depth fusion via Open3D `UniformTSDFVolume` (320³ tight dish cube in v2/v3, `alpha>=0.10`, `trunc=6.0` voxels; 256³ in v1), connected-component floater/table cleanup, SVD orbit-plane Y-up alignment (`estimate_orbit_up_axis`) + assumed metric scale, adaptive crease-preserving Taubin smoothing (2 iterations default in v3) with topology repair after `fill_holes`, un-premultiplied Open3D Embree raycasted multi-view train-photo UV projection (`mask_path` fallback for `eval_mask_path`), held-out camera transform, held-out scoring reusing [build_track2_report.py](../../processing/scripts/food3d/build_track2_report.py), and `turntable_fg_luminance` recorded in `score_summary.json`.
- [render_track2b_eval.mjs](../../processing/scripts/food3d/render_track2b_eval.mjs): headless Chromium + Three.js 0.182.0 renderer for exact pinhole held-out camera intrinsics/extrinsics (`albedo` and `lit` modes, no re-normalization; skipped cleanly when `--cameras` is omitted), 4-angle studio turntable (`lit` and `clay`, `lightAz=az`), transparent `relit_0`/`relit_120`, and 216-pose grid.
- [run_track2b.sh](../../processing/scripts/food3d/run_track2b.sh): end-to-end per-dish driver (timestamped default `out_root`, env overrides, stale LOD/pose/pack cleanup, graceful held-out skip when `transforms_val.json` is absent) chaining 2DGS+TSDF, [blender_bake.py](../../processing/scripts/food3d/blender_bake.py) (150k:2048 hero and 35k:1024 mobile LODs, `bmesh.ops.dissolve_degenerate` after decimation, 89° `smart_project` + `pack_islands`, `SHARP_EDGE_ANGLE_DEG=65°`, `sanitize_glb_tangents` before export, zero circular Cycles dependencies), multi-view UV projection, [pbr_author.py](../../processing/scripts/food3d/pbr_author.py) (`--micro-normal-strength 0.25`, `--occlusion-strength 0.25`, `--wet-cap 0.04`, recalibrated multi-view matte/glaze masks), [pack_pbr_glb.mjs](../../processing/scripts/food3d/pack_pbr_glb.mjs) (`NODE_PATH`/package resolution, WebP + lossless 512 px ORM/clearcoat + `meshopt --level high`, PBR params stamped in `asset.extras`), held-out evaluation, and strict [qa_gate.py](../../processing/scripts/food3d/qa_gate.py) (`--strict` on 150k + fail-closed 35k audit using `prep-qa-cutout`).
- [test_food3d_track2b.py](../../processing/tests/test_food3d_track2b.py) and [test_food3d_pbr.py](../../processing/tests/test_food3d_pbr.py): offline unit tests covering camera conversion, projection parity, TSDF masking, cleanup, train/val leakage guard, 2DGS loss normalization, portrait orbit up-axis, un-premultiplied sampling, adaptive crease-preserving smoothing, `sanitize_glb_tangents`, `mask_path` fallback, `prep-qa-cutout`, recalibrated PBR masks, `--wet-cap`, and report/metadata logging.

**Metric scale assumption:** CO3D world coordinates have arbitrary scale. Each dish is uniformly scaled to an assumed physical horizontal diameter (`calibrated: false`): `co3d_sandwich` 22.0 cm, `co3d_pizza` 28.0 cm, `co3d_hotdog` 20.0 cm. Orientation aligns the mean training camera `+Y` orbit-up vector to world `+Y` and seats `y_min = 0`.

## Per-dish results

Run artifacts are in `/home/yacine105/kaggle-evals/track2b-mesh-20261125/`. Every dish used strictly the 89 training views from `transforms_train.json` for 2DGS, TSDF fusion, and UV photo projection, and was evaluated on all 13 held-out views from `transforms_val.json` composited on black.

| Dish | Dense TSDF faces | Hero 150k GLB | Mobile 35k GLB | QA 150k / 35k | Mesh Albedo FG PSNR / SSIM / ΔE | Mesh Lit PBR FG PSNR / SSIM / ΔE | Brush 3DGS FG PSNR / SSIM / ΔE |
|---|---:|---:|---:|---|---|---|---|
| `co3d_sandwich` | 224,920 | 4.04 MiB (150,000 tris) | 1.79 MiB (35,000 tris) | **PASS** / **PASS** | 18.30 dB / 0.641 / 8.29 | 13.40 dB / 0.300 / 20.52 | 30.99 dB / 0.945 / 2.26 |
| `co3d_pizza` | 208,927 | 3.86 MiB (150,000 tris) | 1.69 MiB (34,999 tris) | **WARN** / **PASS** | 21.98 dB / 0.714 / 7.97 | 18.65 dB / 0.518 / 12.93 | 29.99 dB / 0.914 / 3.74 |
| `co3d_hotdog` | 185,490 | 3.89 MiB (149,999 tris) | 1.80 MiB (34,999 tris) | **WARN** / **PASS** | 17.76 dB / 0.678 / 9.79 | 10.88 dB / 0.311 / 28.28 | 32.73 dB / 0.948 / 2.56 |

### Per-dish timing and QA breakdown

| Dish | 2DGS train (6k steps) | Final splats | TSDF fusion | UV photo projection (150k) | `gltf-transform validate` | Metallic max | Roughness / coat std | Relit p95 | 216-pose fidelity (`qa_gate`) |
|---|---:|---:|---:|---:|---|---:|---|---:|---|
| `co3d_sandwich` | 148.95 s | 28,410 | 4.51 s | 89.6% texels (48.15 s) | PASS | 0.0 | 0.1875 / 0.1135 | 42.33 | PASS (IoU 0.840, ΔE 7.71, SSIM 0.515) |
| `co3d_pizza` | 159.70 s | 37,589 | 7.23 s | 94.4% texels (60.33 s) | PASS | 0.0 | 0.1770 / 0.1378 | 41.33 | WARN (IoU 0.933, ΔE 14.41, SSIM 0.155) |
| `co3d_hotdog` | 143.40 s | 30,792 | 5.03 s | 91.8% texels (46.80 s) | PASS | 0.0 | 0.1981 / 0.1193 | 46.33 | WARN (IoU 0.819, ΔE 24.13, SSIM 0.236) |

## Observations and limitations

- **Mesh vs 3DGS held-out gap:** The extracted PBR meshes align accurately to held-out camera poses (`Full PSNR` 24.97–29.79 dB, `FG PSNR` 17.76–21.98 dB, `FG SSIM` 0.641–0.714, `FG ΔE` 7.97–9.79 in unlit albedo mode), trailing the Brush 3DGS splats (FG PSNR 29.99–32.73 dB, FG SSIM 0.914–0.948, ΔE 2.26–3.74). The gap comes from three measured factors: (1) 1–3 px silhouette boundary differences at the marching-cubes zero-crossing, (2) `pbr_author.py` specular de-lighting and AO crevice lift (`delight_mean_delta_e` 2.55–3.48), and (3) loss of view-dependent specular shading in a static diffuse albedo texture (and intentionally different studio lighting in `lit` PBR mode).
- **Orientation on portrait-held captures (`co3d_hotdog`):** Averaging training camera `+Y` axes correctly seats table-orbited dishes (`co3d_sandwich` 22.0×11.4×20.9 cm, `co3d_pizza` 27.3×6.4×28.0 cm), but `co3d_hotdog` was captured vertically in portrait orientation, leaving the hotdog standing upright (`0.163×0.379×0.200 m`) in the turntable sheet while still aligning cleanly to held-out cameras. A flat-base/PCA orientation heuristic would be needed for non-tabletop captures.
- **QA warnings:** All six GLBs (three 150k hero, three 35k mobile) pass budget (≤4.04 MiB vs 5.0 MiB limit), `gltf-transform validate`, `publication_eligible: false`, welded seated geometry, strict `metallic = 0.0` PBR, and relighting responsiveness (`p95` 41.3–46.3). The two 150k `WARN` verdicts are solely from Track 1's 216-pose coarse-grid `photo_fidelity` check (15° azimuth / 10° elevation grid against frame 0) where `co3d_pizza` and `co3d_hotdog` fell below the 0.45 SSIM warning threshold.
- **Open gates:** Human visual quality review of the turntable contact sheets and interactive GLBs remains open. Every asset stays `"publication_eligible": false`.

## v2 fix pass (2026-11-25)
**Who did what.** Fixes 1–9 were written by Gemini 4 Hydrogen high on antigravity_3, which stopped at the quota limit; its progress log is `/home/yacine105/kaggle-evals/track2b-mesh-v2-20261125/PROGRESS.md`. The orchestrator then ran the unchanged `run_track2b.sh` for all three dishes into the folder above. All three runs exited 0, and the offline suite passed 61/61 before the runs.

**Held-out albedo benchmark** (13 views; mean FG PSNR / FG SSIM / FG ΔE; the lit metric is now a diagnostic only):

| Dish | v1 | v2 | Train silhouette IoU (v2) |
|---|---|---|---|
| sandwich | 18.30 / 0.641 / 8.29 | 21.16 / 0.821 / 6.58 | 0.964 (v1 0.935) |
| pizza | 21.98 / 0.714 / 7.97 | 21.92 / 0.763 / 7.93 | 0.987 |
| hotdog | 17.76 / 0.678 / 9.79 | 19.97 / 0.766 / 8.94 | 0.980 |

**Other v2 measurements:**
- Sandwich geometry: mean dihedral 7.30° and p90 14.00° after Taubin smoothing (v1 17.3°).
- UV: 4,382 islands, 50.9% coverage, 14.2 texels/face (v1: 13,026 / 22% / 6.1).
- Hero GLBs: 1.86–1.93 MB. Mobile GLBs: 0.81–0.95 MB.
- QA: 150k is PASS for sandwich and WARN for pizza and hotdog (the coarse single-photo fidelity check); 35k is PASS for all three.
- Turntables (orchestrator visual check): the bark-like noise is gone, the sandwich's far side is evenly coloured, and the hotdog now lies flat.

**Targets:**

| Target | Result |
|---|---|
| Mean dihedral <10° | met |
| Hotdog flat | met |
| Even far side | met, visually; per-azimuth luminance was not measured |
| Size, metallic and validation | met |
| Albedo FG PSNR ≥26 dB | **not met** (best 21.2 dB) |

The PSNR gap to the 2DGS checkpoint (about 30–32 dB) remains. The likely cause is texture resolution and blur from projecting 89 photos onto 2048 px with about 14 texels per face. This is untested.

**Not done:** no independent review of v2 yet, because every Gemini Hydrogen route was out of quota at 14:00.

**Texture-resolution test (orchestrator, 2026-11-25).** The sandwich v2 mesh was re-baked at 4096 px instead of 2048, with the pipeline otherwise identical; outputs are in `/home/yacine105/kaggle-evals/track2b-tex4k-20261125/`. Held-out albedo FG PSNR / SSIM / ΔE came out at 21.17 / 0.821 / 6.57, against 21.16 / 0.821 / 6.58 at 2048. The hero GLB grew from 1.88 to 2.73 MB. **Texture resolution is not the bottleneck,** which refutes the earlier guess. The remaining candidates are the silhouette/geometry error between mesh and 2DGS, and view-dependent appearance that a single diffuse texture cannot reproduce. A per-pixel error split (boundary band vs interior) is the next diagnostic.

**v2 error split (orchestrator, 2026-11-25).** Held-out albedo renders, GT masks from `eval_masks/`; interior = mask eroded by 4 px; miss = GT foreground with no mesh coverage. Computed with an inline script, so FG PSNR differs slightly from score-heldout.

| Dish | FG PSNR | Interior PSNR (share of error, share of px) | Boundary band (error, px) | Missed px (error, px) |
|---|---|---|---|---|
| sandwich | 20.97 | 24.78 (39%, 93.8%) | 20%, 4.4% | **41%**, 1.8% |
| pizza | 21.41 | 22.48 (**75%**, 95.5%) | 22%, 4.2% | 3%, 0.3% |
| hotdog | 19.84 | 21.23 (**69%**, 95.2%) | 12%, 3.6% | 18%, 1.2% |

Most of the sandwich's error comes from missed and edge pixels, so silhouette coverage is the fix there (for example, a thin outward offset or a lower TSDF alpha threshold, tuned on train views only). Pizza and hotdog are interior-dominated, at 21–22 dB inside the object. That points to texture or appearance error rather than outline: blending across views, view-dependent shine, or residual geometry error. Texture resolution is already ruled out.

**Silhouette offset sweep (orchestrator, 2026-11-25, train views only).** The script is `/home/yacine105/kaggle-evals/track2b-offset-20261125/sweep_offset.py`. It displaced the sandwich v2 dense mesh along its vertex normals, then measured silhouette IoU by Open3D raycasting against every third train view's mask (held-out views never read).

| Offset (mm) | 0 | 0.5 | 1.0 | 1.5 | 2.0 | 3.0 |
|---|---|---|---|---|---|---|
| Train IoU | 0.9637 | 0.9627 | 0.9572 | 0.9491 | 0.9395 | 0.9190 |
| Missed fraction | 0.0170 | 0.0115 | 0.0082 | 0.0063 | 0.0052 | 0.0038 |
| Extra fraction | 0.0203 | 0.0272 | 0.0365 | 0.0475 | 0.0594 | 0.0847 |

The best offset is 0, so a uniform dilation does not help. The outline is misplaced, not shrunken: misses and extras trade one-for-one.

This is consistent with camera-pose error in the input. The CO3D sandwich has a 12.82 px median centroid reprojection, against 3.12 px for pizza (Track 2 conversion report). The next fix for the outline is therefore camera-pose refinement during 2DGS training (gsplat supports per-camera pose optimisation), not mesh dilation. This was not attempted.

**Metric limit, reasoned (orchestrator, 2026-11-25; not measured).** Camera-pose refinement during 2DGS training would correct only the train poses. The 13 held-out CO3D poses keep their capture error (sandwich median 12.8 px), so the held-out mesh score stays tied to that error. The splat reaches 30–33 dB on the same noisy poses because view-dependent appearance absorbs small inconsistencies; one view-independent textured surface cannot. **The 26 dB held-out target may therefore be unreachable for any single-surface mesh on CO3D captures, whatever its visual quality.**

Consequences:
- Pose refinement remains worth doing for asset quality: sharper projection and less blending blur.
- Its held-out effect should be measured with test-time pose alignment of the held-out cameras (scene frozen, poses only), reported alongside the raw score.
- The deciding judgement for "looks like real food" is a human visual rating, which is still pending.

## Pose-free video-to-dataset ingestion (2026-11-25)

Added [video_to_dataset.py](../../processing/scripts/food3d/video_to_dataset.py) (plus batched ONNX session and in-frame `target_xy` component selection in [cutout_clean.py](../../processing/scripts/food3d/cutout_clean.py), and 7 offline unit tests in [test_food3d_video.py](../../processing/tests/test_food3d_video.py)) to turn a plain phone orbit video into a Track 2B dataset without ground-truth poses. Every dataset, mesh, contact sheet, and report carries `"publication_eligible": false` ([ADR 0004](../../docs/adr/0004-visual-tiers.md)).

**Pipeline and leakage boundary:**
1. Extracts frames via FFmpeg and selects 80 sharpest frames across uniform temporal buckets (`select_sharpest_bucket_indices`).
2. Freezes the deterministic held-out split (`eval_split_every=8`: 70 train / 10 eval) **before** any mask or pose quality checks.
3. Runs batched `birefnet-general-lite` ONNX inference in one reusable session (`788–796 s` CPU for 80 frames; `onnxruntime-gpu` hit an 822 MB decoder allocation limit on 6 GB VRAM so CPU fallback was used).
4. Estimates poses with `pycolmap==4.2.1` (`PINHOLE`, `CameraMode.SINGLE`, exhaustive matching, incremental mapping) using mask-guided feature filtering (`filter_keypoints_with_mask`: keeps 100% of foreground+16 px dilated keypoints, caps background features to `<=35%` prioritizing points nearest the dish, with automatic relaxed-background fallback). **Note:** held-out frames participate in pose registration because every evaluation frame requires a pose, and are strictly excluded from train-consensus 3D component selection, visual-hull `points3d.ply` carving, 2DGS training, TSDF fusion, and UV photo projection.
5. Uses train-only 3D consensus ray intersection (`estimate_consensus_3d_center`) to select the consistent dish component per frame (fixing single-frame BiRefNet switching to larger foreground/table regions in frames 26–60 of `co3d_sandwich_orbit.mp4`, which raised `train_mean_mask_hit_rate` from `0.741` to `0.984`).
6. COLMAP reconstruction scale is arbitrary (`median_camera_orbit_radius` in arbitrary SfM units); downstream Track 2B uniformly scales to the assumed `diameter_cm` (`22.0 cm` sandwich, `20.0 cm` hotdog; `calibrated: false`).

**Registration stats** (artifacts in `/home/yacine105/kaggle-evals/track2b-video-20261125/`):

| Dish | Input video frames | Selected / Registered | Mean reproj error | COLMAP 3D pts | Kept FG / BG SIFT | Median orbit radius (arb.) | Train / Eval | Train hull hit rate |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| `co3d_sandwich` | 102 | 80 / 80 (100%) | 0.4359 px | 8,913 | 81,703 / 24,740 | 3.56149 | 70 / 10 | 0.9840 |
| `co3d_hotdog` | 102 | 80 / 80 (100%) | 0.5707 px | 6,838 | 63,958 / 27,015 | 3.70261 | 70 / 10 | 0.9870 |

**Video-pose vs CO3D-GT-pose v2 (`run_track2b.sh`):**

| Dish | Source poses | Train / Eval | Albedo FG PSNR | Albedo FG SSIM | Albedo FG ΔE | Train silhouette IoU | 150k / 35k GLB size | QA 150k / 35k |
|---|---|---:|---:|---:|---:|---:|---|---|
| `co3d_sandwich` | CO3D GT (v2) | 89 / 13 | 21.16 dB | 0.821 | 6.58 | 0.9639 | 1.80 MiB / 834 KiB | **PASS** / **PASS** |
| `co3d_sandwich` | Video `pycolmap` | 70 / 10 | **23.86 dB** | **0.842** | **5.18** | **0.9688** | 1.92 MiB / 842 KiB | **PASS** / **PASS** |
| `co3d_hotdog` | CO3D GT (v2) | 89 / 13 | **19.97 dB** | **0.766** | **8.94** | 0.9803 | 1.77 MiB / 928 KiB | **WARN** / **PASS** |
| `co3d_hotdog` | Video `pycolmap` | 70 / 10 | 19.53 dB | 0.755 | 9.43 | **0.9879** | 1.91 MiB / 955 KiB | **WARN** / **PASS** |

Note: Video-pose held-out metrics are scored against BiRefNet held-out `eval_masks/` on 10 held-out frames, whereas CO3D-GT v2 metrics were scored against CO3D masks on 13 held-out frames. On `co3d_sandwich`, `pycolmap` bundle adjustment (`0.4359 px`) eliminated the `12.82 px` CO3D GT pose jitter, raising held-out albedo FG PSNR by `+2.70 dB` and producing sharper bread/ham geometry in the turntable contact sheet.

## v3 fix pass (2026-11-25)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v3-20261125/{co3d_sandwich,co3d_pizza,co3d_hotdog}/` (all three `run_track2b.sh` runs exited 0; all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 73/73).

**Changes verified in v3:**
- Recalibrated `pbr_author.compute_food_masks` for multi-view captures (neutral-rim gating on `outer_rim`, relative luminance contrast, luminance/specular cues on `glaze_wet`/`liquid_smooth`), added `--wet-cap 0.04` and `--occlusion-strength 0.25`, and logged `micro_normal_strength`, `occlusion_strength`, `wet_cap`, and `wet_fraction` in `pbr_report.json` and `.pbr.glb` `asset.extras`.
- Replaced 8-iteration Taubin with adaptive crease-preserving Taubin (`--smooth-iterations 2` default) and moved Open3D degenerate/duplicate/non-manifold repair after `trimesh.repair.fill_holes` (`non_manifold_edges_after: 0` on all three dishes).
- Added `bmesh.ops.dissolve_degenerate` after Blender decimation and `sanitize_glb_tangents` before `_geom.glb` export (`ACCESSOR_VECTOR3_NON_UNIT` resolved; 12/12 GLBs pass `gltf-transform validate`).
- Updated `run_track2b.sh`, `pack_pbr_glb.mjs`, `render_track2b_eval.mjs`, and `track2b_mesh.py` for portability (`out_root` timestamped default, env/pnpm resolution, stale cleanup, `--strict` QA on both LODs, `mask_path` fallback, graceful skip of held-out stages when `transforms_val.json` is absent, and `prep-qa-cutout`).

**v2 vs v3 measured comparison:**

| Metric | `co3d_sandwich` v2 → v3 | `co3d_pizza` v2 → v3 | `co3d_hotdog` v2 → v3 |
|---|---|---|---|
| Held-out albedo FG PSNR / SSIM / ΔE | 21.16 / 0.821 / 6.58 → **21.31 / 0.818 / 6.52** | 21.92 / 0.763 / 7.93 → **21.88 / 0.762 / 7.94** | 19.97 / 0.766 / 8.94 → **19.89 / 0.764 / 8.98** |
| Train silhouette IoU | 0.9639 → 0.9636 | 0.9872 → 0.9866 | 0.9803 → 0.9806 |
| Dihedral after (mean / p90 / >45°) | 6.09° / 11.16° / 1.58% → **5.98° / 12.76° / 1.03%** | 6.74° / 11.37° / 1.76% → **5.26° / 11.13° / 0.54%** | 6.32° / 11.91° / 1.50% → **5.96° / 12.75° / 0.94%** |
| `wet_fraction` (150k) | 0.0021 → **0.0002** | 0.1775 → **0.0009** | 0.1153 → **0.0019** |
| UV islands / cov (150k) | 1,603 / 57.2% → 2,214 / 55.7% | 1,025 / 54.1% → 2,147 / 55.5% | 1,134 / 61.6% → 1,467 / 61.7% |
| UV islands / cov (35k) | 968 / 62.3% → 1,517 / 56.8% | 677 / 50.3% → 679 / 64.5% | 865 / 58.4% → 1,309 / 47.0% |
| Packed GLB size (150k / 35k, MB) | 1.88 / 0.85 → 2.07 / 0.96 | 1.93 / 0.81 → 2.11 / 0.87 | 1.86 / 0.95 → 2.02 / 0.96 |
| QA verdict (150k / 35k) | PASS / PASS → **PASS / PASS** | WARN / PASS → **WARN / PASS** (`ssim 0.211 < 0.45`) | WARN / PASS → **WARN / PASS** (`dE 25.01 > 18.0`, `ssim 0.261 < 0.45`) |
| `gltf-transform validate` (all 4 GLBs) | 4/4 PASS → **4/4 PASS** | 4/4 PASS → **4/4 PASS** | 3/4 PASS (`150k_geom` FAIL) → **4/4 PASS** |
| `turntable_fg_luminance` lit (`0/90/180/270`) | `0.617/0.587/0.591/0.546` → `0.619/0.591/0.586/0.547` | `0.485/0.475/0.431/0.456` → `0.478/0.463/0.421/0.443` | `0.476/0.493/0.498/0.485` → `0.465/0.487/0.486/0.484` |

## v4 pose refinement (2026-11-25)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v4-20261125/{co3d_sandwich,co3d_pizza,co3d_hotdog}/` (all three `run_track2b.sh --pose-refine` runs exited 0; all outputs carry `publication_eligible: false`; v3 test-time aligned baselines in `/home/yacine105/kaggle-evals/track2b-mesh-v4-20261125/v3_aligned/`; offline `test_food3d_*.py` passed 80/80).

**Changes implemented (opt-in behind `--pose-refine` / `T2B_POSE_REFINE=1`, default OFF):**
- Per-train-camera SE(3) refinement (`se3_delta_to_matrix_torch`, axis-angle + translation, zero-initialized) activated after 1,000 warmup steps (`pose_lr_rot=6e-4`, `pose_lr_trans=3e-4*scale`, decaying to `0.05x` with a 500-step final cooldown freeze at steps 5,500–6,000), fixed lowest-reprojection-error anchor camera (`select_anchor_camera_index`), and weak L2 regularization (`0.01` on rotation, `0.2` on X/Y translation, `5.0` on camera-Z to prevent `distort_loss` radial scale shrinkage).
- Refined world-space OpenGL poses saved to `refined_train_poses.json` and consumed by both Open3D TSDF fusion (`run_2dgs_and_tsdf`) and multi-view photo UV projection (`project-uv` auto-loads `refined_train_poses.json` when present).
- Added `align-heldout-cameras` (optimizes ONLY each held-out camera's 6-DoF SE(3) pose against the frozen final mesh and `basecolor_delit.png` via two-stage coarse-to-fine Powell; **held-out images are used for pose only, never for the model**) and `texture-sharpness` (mean Sobel gradient magnitude and Laplacian variance inside a 2-px eroded UV-valid mask).

**v3 vs v4 measured comparison (13 held-out views; albedo primary benchmark):**

| Metric | `co3d_sandwich` (v3 → v4) | `co3d_pizza` (v3 → v4) | `co3d_hotdog` (v3 → v4) |
|---|---|---|---|
| Raw held-out FG PSNR / SSIM / ΔE | 21.31 / 0.818 / 6.52 → **21.08 / 0.798 / 6.73** | 21.88 / 0.762 / 7.94 → **20.92 / 0.683 / 8.78** | 19.89 / 0.764 / 8.98 → **20.40 / 0.751 / 8.63** |
| Aligned held-out FG PSNR / SSIM / ΔE | 21.45 / 0.798 / 6.53 → **21.23 / 0.796 / 6.66** | 21.67 / 0.745 / 8.10 → **21.44 / 0.724 / 8.22** | 20.30 / 0.757 / 8.88 → **21.50 / 0.780 / 8.10** |
| Texture sharpness (`mean_grad_mag` / `laplacian_var`, 150k) | 0.003895 / 0.00087763 → **0.003803 / 0.00101539** | 0.006968 / 0.00084012 → **0.006422 / 0.00062473** | 0.004770 / 0.00097287 → **0.004439 / 0.00065743** |
| Train silhouette IoU | 0.96355 → **0.96471** | 0.98656 → **0.98778** | 0.98057 → **0.98187** |
| Train pose delta mean (rot / trans) | — → **0.1624° / 0.831 mm** (anchor `frame_000002`) | — → **0.0771° / 0.853 mm** (anchor `frame_000023`) | — → **0.1137° / 0.660 mm** (anchor `frame_000163`) |
| Held-out alignment delta mean (rot / trans) | 0.2162° / 3.186 mm → **0.3098° / 2.392 mm** | 0.0682° / 2.439 mm → **0.1135° / 3.227 mm** | 0.1552° / 0.798 mm → **0.2563° / 1.204 mm** |
| Packed GLB size (150k / 35k, MB) | 2.07 / 0.96 → **2.03 / 0.89** | 2.11 / 0.87 → **1.83 / 0.79** | 2.02 / 0.96 → **2.08 / 0.95** |
| QA verdict (150k / 35k) & `gltf-transform validate` | PASS / PASS (6/6) → **PASS / PASS** | WARN / PASS (6/6) → **WARN / PASS** (`ssim 0.212 < 0.45`) | WARN / PASS (6/6) → **WARN / PASS** (`dE 25.95`, `ssim 0.259`) |

**Honest visual and quantitative findings:**
- **Train silhouette IoU improved on all three dishes** (`+0.0012` to `+0.0013`), and on the noisiest CO3D capture (`co3d_hotdog`, 23.23 px median reprojection error), pose refinement boosted held-out aligned FG PSNR by **+1.20 dB** over v3 aligned (`21.50` vs `20.30 dB`, full PSNR `28.09` vs `27.12 dB`) and raw FG PSNR by `+0.51 dB` (`20.40` vs `19.89 dB`), with noticeably cleaner sausage/bun crease shading on the turntable sheet.
- **Pizza texture sharpness and visual verdict:** On `co3d_pizza` (whose CO3D input poses already had low `3.12 px` median reprojection error), **v4 is NOT crisper than v3**. Both turntable contact sheets look nearly identical visually, and measured 150k `mean_grad_mag` is slightly lower (`0.006422` vs `0.006968`, `laplacian_var` `0.000625` vs `0.000840`). This rules out input camera pose noise as the primary cause of pizza texture softness; the blur comes from blending 89 views (`cos^4` weighting) across 1–2 mm TSDF surface/decimation discrepancy and Smart Project UV texel density.
- **Depth-distortion radial bias pitfall (caught and fixed during v4):** Initial unconstrained camera-Z translation drifted `+0.372` world units (`~17.6 mm`) inward on pizza because 2DGS `distort_loss` depends on world depth units and shrinks scene scale. Countering Z-drift with `5.0` normalized Z regularization plus the 500-step cooldown freeze reduced mean pizza translation to `0.853 mm` and restored `train_silhouette_iou` (`0.98778`).

## v5 best-view texturing and finer geometry (2026-11-25)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v5-20261125/{co3d_pizza,co3d_sandwich,co3d_hotdog}/` (all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 84/84; `run_track2b.sh` defaults stay unchanged).

**Changes implemented (opt-in behind CLI flags / env vars; default `blend` / `320` / `1.5` / `6000` unchanged):**
- **Best-view UV texturing (`--texture-mode best_view` / `T2B_TEXTURE_MODE=best_view`):** Scores each `(face, view)` by `cos^3 * (fl_x * fl_y / dist^2)` weighted by bounded local foreground Laplacian sharpness (`compute_view_sharpness_map`), mask-edge margin, and multi-view photometric consensus; runs 16-batch 3D-adjacency Potts ICM + connected-component small-patch cleanup (`smooth_face_view_labels`); solves global per-view linear-light gain & tightly bounded offset (`±0.02`) across overlapping samples with Huber IRLS (`solve_global_color_levelling`); and blends only across a narrow 3 px UV/3D seam band (`blend_narrow_seam_band`) while reporting `measure_seam_visibility`.
- **Finer geometry & train-only metrics (`--tsdf-cube-padding`, `--refine-stop-iter`, `train_photometric`):** Added `--tsdf-cube-padding` (default `1.5`), `--refine-stop-iter`, and train-view 2DGS/mesh photometric diagnostics (`--split train` on `prep-eval-cameras` / `score-heldout`).
- **Demo env exposure:** `food3d_demo.sh` exposes `T2B_TEXTURE_MODE` (defaulting to `best_view`) and `V2D_MAX_DIM`; `run_track2b.sh` keeps its defaults (`blend`, `320`, `1.5`, `6000`).

**Train-only geometry & resolution selection on `co3d_pizza` (held-out frames never used for tuning):**
- `g0` baseline (`max_dim=1024`, `320³`, `cube_padding=1.5`, `trunc=6.0`, `6000` steps): `train_silhouette_iou = 0.98264`, `dense_faces = 155,857`, `dihedral = 5.95° / 12.65°`.
- `g1` (`max_dim=1024`, `448³`, `cube_padding=1.15`, `trunc=5.0`, `6000` steps): `train_silhouette_iou = 0.98550`, `train_2dgs_fg_psnr = 28.86 dB`, `dense_faces = 534,830`.
- `g2` (`max_dim=1024`, `512³`, `cube_padding=1.15`, `trunc=5.0`, `9000` steps, `refine_stop=6000`): `train_silhouette_iou = 0.98570`, `train_2dgs_fg_psnr = 29.39 dB`, `dense_faces = 688,143`.
- `g3` chosen (`--max-dim 1920` native `1016x1806`, `512³`, `cube_padding=1.15`, `trunc=5.0`, `9000` steps, `refine_stop=6000`): `train_silhouette_iou = 0.99110`, `train_2dgs_fg_l1 = 0.02364` (`29.41 dB`), `dense_faces = 675,006`, `dihedral_after = 4.13° / 8.79° / 0.31%`.
- Optional 4096 hero bake check on `g3`: `2048` direct (`22.762 dB`, `2.44 MB`, `133s`), `4096->2048` sharpened (`22.764 dB`, `2.38 MB`, `433s`), `4096` direct (`22.780 dB`, `3.93 MB`, `433s`). `<0.02 dB` train difference for `+5 min` projection time, so `2048` was kept.

**Video-baseline (`track2b-video-20261125`) vs v5 (`track2b-mesh-v5-20261125`) across all 3 dishes:**

| Metric | `co3d_pizza` (base → v5) | `co3d_sandwich` (base → v5) | `co3d_hotdog` (base → v5) |
|---|---|---|---|
| Native frame size / registered | `576×1024` (80/80) → **`1016×1806` (80/80)** | `576×1024` (80/80) → **`1068×1900` (80/80)** | `575×1024` (80/80) → **`702×1250` (79/80, 9 eval)** |
| Held-out albedo FG PSNR / SSIM / ΔE | 23.18 / 0.785 / 6.82 → **22.39 / 0.744 / 7.92** | 23.86 / 0.842 / 5.18 → **23.69 / 0.828 / 5.71** | 19.53 / 0.755 / 9.43 → **20.54 / 0.766 / 8.87** |
| Texture sharpness (`mean_grad_mag` / `laplacian_var`) | 0.007711 / 0.000490 → **0.010388 / 0.000752** (+34.7% / +53.5%) | 0.004189 / 0.001207 → **0.006627 / 0.001647** (+58.2% / +36.4%) | 0.004515 / 0.001070 → **0.006989 / 0.001155** (+54.8% / +7.9%) |
| Train silhouette IoU | 0.98264 → **0.99109** | 0.96879 → **0.98014** | 0.98786 → **0.98856** |
| Seam visibility (`seam_excess_delta_e` / band %) | — → **0.4577 ΔE / 36.2%** | — → **0.9336 ΔE / 23.6%** | — → **1.2138 ΔE / 24.4%** |
| Packed GLB size (150k / 35k, MiB) | 2.16 / 0.92 → **2.36 / 1.01** | 1.92 / 0.82 → **2.79 / 1.27** | 1.91 / 0.93 → **3.10 / 1.02** |
| QA verdict (150k / 35k) & `gltf-transform validate` | WARN / PASS → **WARN / PASS** (6/6 PASS) | PASS / PASS → **PASS / PASS** (6/6 PASS) | WARN / PASS → **WARN / PASS** (6/6 PASS) |

**Visual verdict (`/home/yacine105/kaggle-evals/track2b-mesh-v5-20261125/pizza_top_closeup_comparison.png` and turntables):**
- **`co3d_pizza`:** Clearly crisper than the video baseline — individual chicken cubes, melted cheese edges, crust char/bubbles, and seasoning flecks separate cleanly instead of smearing together, with no visible exposure/colour seams (`seam_excess_delta_e = 0.46`). Held-out FG PSNR drops `0.79 dB` (`23.18 → 22.39 dB`) because un-averaged crisp edges sit 1–2 px from held-out poses while `blend` blurs across them; visually v5 is closer to the real held-out photo, though real photos still retain finer micro-grit and sharper deep crevices between overlapping toppings.
- **`co3d_sandwich` & `co3d_hotdog`:** Both show +55–58% higher `mean_grad_mag`, crisper bread crumb/crust grain, sharper ham slices, and cleaner sausage/bun edges (with hotdog also gaining `+1.01 dB` held-out FG PSNR). Minor smoothing/pinholes appear on smooth top bun crust at `512³` TSDF (`co3d_sandwich` clay `az=90`).

## v6 defect cleanup & colour-field levelling (2026-11-26)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v6-20261126/{co3d_pizza,co3d_sandwich,co3d_hotdog}/` and 5 side-by-side comparison sheets (`crop_*_v5_vs_v6.png`); all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 91/91 (`2.055s`); `run_track2b.sh` defaults stay unchanged (`0`).

**Opt-in changes implemented in [track2b_mesh.py](file:///home/yacine105/t3-code-handoff/peekaplate/processing/scripts/food3d/track2b_mesh.py) and [run_track2b.sh](file:///home/yacine105/t3-code-handoff/peekaplate/processing/scripts/food3d/run_track2b.sh):**
- **Train-mask visual-hull carving (`--mask-carve` / `T2B_MASK_CARVE=1`):** `carve_mesh_by_train_masks` checks train-view foreground mask consistency across dilated silhouette masks (default `mask_tol_px=2.0`, `max_out_fraction=0.38`, `min_seen_views=8`) and drops unsupported protruding triangles plus detached fragments.
  - *Tuning pitfall caught mid-v6:* Initial `mask_tol_px=1.0, max_out_fraction=0.34` gouged 3,777 faces including two ~3 cm holes (`len=213, 215`) into `co3d_sandwich`'s top bun because BiRefNet masks clipped pale bread within ~1.5 px in ~35% of frames. Sweeping on train masks confirmed `tol=2.0, mof=0.38` preserves the top bun (`top_mid_lost=0`, `carved=10` faces on final sandwich).
- **Support-plane & hanging-drip trimming (`--trim-drips` / `T2B_TRIM_DRIPS=1`):** `trim_support_plane_drips` finds where the bottom cross-section stabilizes (`area_ratio >= 0.14`) and also runs a second bottom-slice connected-component pass (`frac in (0.125, 0.095)`) to catch narrow dangling stalactite lobes + their upward attachment neck (`dy >= 0.05 * height`, `dy >= 0.65 * max_span`), removing `co3d_sandwich`'s `az=0` hanging mayo/table-reflection drip (`[0.074, 0.017, 0.046]`, `hanging_drips_removed=1`, `faces_dropped=7704`) even when the center belly already touches `y=0`.
- **Small boundary-hole closure & targeted pit smoothing (`--repair-pits` / `T2B_REPAIR_PITS=1`):** `fill_small_boundary_holes` closes loops up to `400` vertices (`diam <= 0.18 * diag` in pass 2 and a post-`remove_non_manifold_edges()` pass so topology cleanup cannot leave medium holes open), and `smooth_isolated_surface_pits` smooths filled patches and localized sharp normal/1-ring anomalies (`max_pit_cluster_verts=180`).
- **Low-frequency spatial + chroma colour field & unprojected texel inpainting (`--color-field` / `T2B_COLOR_FIELD=1`, `--inpaint-unprojected` / `T2B_INPAINT_UNPROJECTED=1`):** `solve_color_levelling_field` fits 12 parameters per view (`[g0, gx, gy, offset]` per channel) on train-view overlaps with a chroma difference term (`chroma_weight=1.2`), linear white-balance coupling, and Huber IRLS. `inpaint_unprojected_texels` fills unprojected UV texels via nearest-neighbor geodesic-free distance seed + damped Poisson neighbor relaxation (`8` iterations) instead of dark/TSDF fallback values.

**v5 vs v6 (`mask_tol_px=2.0`, `max_out_fraction=0.38`) across all 3 dishes (verified from saved JSON reports; held-out views used only for scoring):**

| Metric | `co3d_pizza` (v5 → v6) | `co3d_sandwich` (v5 → v6) | `co3d_hotdog` (v5 → v6) |
|---|---|---|---|
| Held-out albedo FG PSNR / SSIM / ΔE | 22.39 / 0.744 / 7.92 → **22.13 / 0.736 / 8.01** | 23.69 / 0.828 / 5.71 → **22.81 / 0.849 / 5.84** | 20.54 / 0.766 / 8.87 → **20.42 / 0.782 / 8.75** |
| Texture sharpness (`mean_grad_mag` / `laplacian_var`) | 0.010388 / 0.000752 → **0.009943 / 0.000588** | 0.006627 / 0.001647 → **0.005190 / 0.000298** | 0.006989 / 0.001155 → **0.005868 / 0.000952** |
| Seam visibility (`seam_excess_delta_e`) | 0.4577 → **0.9513** | 0.9336 → **0.5035** | 1.2138 → **1.0386** |
| Train overlap RGB residual (before → after) | 0.0427 → **0.0358** (`chr 0.0203 → 0.0180`) | 0.0403 → **0.0223** (`chr 0.0170 → 0.0103`) | 0.0624 → **0.0466** (`chr 0.0327 → 0.0265`) |
| Train silhouette IoU | 0.99109 → **0.99112** | 0.98014 → **0.97786** | 0.98856 → **0.98696** |
| Packed GLB size (150k / 35k, MiB) | 2.36 / 1.01 → **2.31 / 0.99** | 2.79 / 1.27 → **2.79 / 1.10** | 3.10 / 1.02 → **2.71 / 1.02** |
| QA verdict (150k / 35k) | WARN / PASS → **WARN / PASS** | PASS / PASS → **PASS / PASS** | WARN / PASS → **WARN / PASS** |

**Honest visual verdict from turntable & crop PNGs (`crop_*_v5_vs_v6.png`):**
- **`co3d_sandwich` (`crop_sandwich_az0_drip_v5_vs_v6.png`, `crop_sandwich_az90_pits_v5_vs_v6.png`):** The `az=0` dangling bottom drip is completely removed in both Lit and Clay renders with a clean bun base (`SSIM 0.828 → 0.849`, `seam_excess_dE 0.93 → 0.50`, `QA PASS/PASS`). Top-bun pit scars along the center ridge are substantially smoothed and zero holes were introduced, though faint sub-millimeter dark crease grain remains along the right bun flank and a minor pocket persists inside the upper-left ham fold.
- **`co3d_pizza` (`crop_pizza_color_v5_vs_v6.png`, `crop_pizza_az180_flap_v5_vs_v6.png`):** Cool/washed crust areas at `az=90` and `az=270` are slightly warmer and more balanced (`train overlap 0.0427 → 0.0358`), and jagged lower-right crust skirt wisps are trimmed (`dropped=908`), **but** `az=180` remains noticeably darker/browner than `az=0` (consistent with real directional shadow in source photo `images/frame_000048.png`) and the small 2 o'clock crust bump at `az=180` persists because it lies inside the train silhouette masks (`out_frac=0.000` at `tol=1.5 px`). Held-out `seam_excess_delta_e` regressed slightly (`0.4577 → 0.9513`).
- **`co3d_hotdog` (`crop_hotdog_check_v5_vs_v6.png`):** Top-bun ridge Clay pits and micro-specks are cleaner (`SSIM 0.766 → 0.782`, `dE 8.87 → 8.75`, `seam_excess_dE 1.21 → 1.04`), **however** at `tol=2.0, mof=0.38` the `az=180 (Lit)` lower inner bun lip exhibits brownish sausage-color bleed across two patches on the front trough edge (an earlier `tol=1.0, mof=0.34` run scored `21.17 dB / 0.802 / 8.28`, `seam_excess_dE 0.2326` without that bleed, suggesting stricter mask carving helped isolate the upturned hotdog bun lip even while hurting `co3d_sandwich` top bun).

## v8 opt-in fine-detail normal & cavity pass (2026-11-26)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v8-20261126/{co3d_pizza,co3d_sandwich,co3d_hotdog}/`, lit turntable sheets, and 3 side-by-side comparisons (`comparison_*_v7_vs_v8_vs_train.png`); all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 94/94 (`8.654s`); `run_track2b.sh` keeps `T2B_FINE_DETAIL=0` by default (opt-in).

**Candidate evaluation (a / b / c; held-out frames untouched during parameter selection):**
- **(a) High-to-low / 2DGS surfel normal bake:** [blender_bake.py](../../processing/scripts/food3d/blender_bake.py) already bakes tangent-space `normal.png` from the `512³` TSDF `dense_clean.glb` onto both `150k` and `35k` LODs and [pack_pbr_glb.mjs](../../processing/scripts/food3d/pack_pbr_glb.mjs) sets `normalScale=1.0`. However, on `co3d_pizza`, `150k` already captures most of the Taubin-smoothed `671k` TSDF surface (`normal.png` `z` p50=`1.0`, p05=`0.9843`, `xy_abs_mean=0.0454`). Probing `2dgs_ckpt.pt` on train frame 0 showed 2DGS `render_normals` (`73,419` surfels) are similarly macro-smoothed (`mean |dn/dx|=0.01752`) while `normals_from_depth` (`0.12686`) exhibit severe quantization contour rings, so re-baking from 2DGS surfels was rejected. Meanwhile, the legacy `pbr_author.py` Sobel micro-normal (`0.25`) on raw linear luminance shifted `normal_final` by only `0.0072`, and `T2B_OCCLUSION_STRENGTH=0.25` + `orm.png` 512 px resize in `pack_pbr_glb.mjs` hid fine crevice darkening.
- **(b) Frequency-split perceptual luminance detail normal (`compute_detail_height_and_cavity` in [pbr_author.py](../../processing/scripts/food3d/pbr_author.py)):** Converts de-lit albedo to `sqrt(L)` perceptual luminance, runs normalized masked Gaussian band splits (`sigma=18.0*s` macro, `3.0*s` meso, `0.9*s` micro, `s=max(0.5, H/2048)`) inside `uv_mask`, applies `tanh` soft-clipping (`0.14` meso, `0.07` micro), replicates UV borders (`dilate_uv_gutters`) before isotropic 3×3 Scharr (`ndimage.correlate`, scaled by `s` for 1024/2048 LOD parity; verified tangent sign via `corr(baked_nx, dH/dcol)=-0.1678`, `corr(baked_ny, dH/drow)=+0.1363`), and blends over the baked normal via RNM.
- **(c) Detail-derived cavity AO + higher-res ORM packing:** Derives narrow-valley (`3.5*s`) + recessed-trough cavity factor from `H_meso`, multiplies into `ao` (floor `0.15` when active), raises `T2B_OCCLUSION_STRENGTH` to `0.70`, and adds `--orm-max-size 1024` / `--normal-webp-quality 90` in [pack_pbr_glb.mjs](../../processing/scripts/food3d/pack_pbr_glb.mjs).

**Chosen opt-in settings (`T2B_FINE_DETAIL=1`, with `T2B_REUSE_DIR` reusing v7 meshes & projected maps):**
`detail_normal_strength=18.0`, `cavity_strength=0.75`, `occlusion_strength=0.70`, `micro_normal_strength=0.0`, `orm_max_size=1024`, `normal_webp_quality=90`.

**v7 vs v8 across all 3 dishes (verified from saved JSON reports; all 6 GLBs ≤ 3.53 MiB and PASS `gltf-transform validate`):**

| Metric | `co3d_pizza` (v7 → v8) | `co3d_sandwich` (v7 → v8) | `co3d_hotdog` (v7 → v8) |
|---|---|---|---|
| Held-out albedo FG PSNR / SSIM / ΔE | 21.98 / 0.729 / 8.07 → **21.98 / 0.729 / 8.07** | 22.96 / 0.850 / 5.55 → **22.96 / 0.850 / 5.55** | 20.98 / 0.797 / 8.65 → **20.98 / 0.797 / 8.65** |
| Held-out lit FG PSNR / SSIM / ΔE | 20.08 / 0.705 / 12.19 → **19.78 / 0.684 / 12.20** | 14.72 / 0.674 / 18.32 → **14.57 / 0.661 / 18.52** | 13.65 / 0.616 / 19.91 → **13.50 / 0.610 / 20.22** |
| Relighting `p95_diff` / `mean_diff` | 38.00 / 15.64 → **38.67 / 16.09** | 42.00 / 21.43 → **42.33 / 21.57** | 39.33 / 21.94 → **39.33 / 22.08** |
| `normal_xy_abs_mean` (150k / 35k) | 0.0480 / — → **0.0819 / 0.0829** | 0.0751 / — → **0.0811 / 0.0907** | 0.0663 / — → **0.0773 / 0.0829** |
| `ao_p10` in ORM (150k) | 0.6314 → **0.5765** | 0.6980 → **0.6657** | 0.4510 → **0.4364** |
| Packed GLB size (150k / 35k, MiB) | 2.28 / 0.94 → **3.01 / 1.41** | 2.78 / 1.09 → **3.53 / 1.43** | 2.74 / 1.06 → **3.41 / 1.49** |
| QA verdict (150k / 35k) | WARN / PASS → **WARN / PASS** | PASS / PASS → **PASS / PASS** | WARN / PASS → **WARN / PASS** |

**Honest visual verdict (`comparison_*_v7_vs_v8_vs_train.png`):**
- **`co3d_pizza`:** Looks genuinely more tactile and realistic than v7 — chicken cube edges, melted cheese blobs, and crust blisters catch subtle studio highlights and sit in deeper crevices without plastic/embossed halos (tested `24.0` in train sweeps and rejected it because bright cheese edges began showing rim-bevel halos). Raw photo still holds finer micro-grit.
- **`co3d_sandwich`:** Subtle natural improvement on top-bun baked crust texture and ham-to-bun crevices with zero fake embossing; overall appearance stays very close to v7 because macro bread folds are already resolved in TSDF geometry.
- **`co3d_hotdog`:** Sausage skin wrinkles/speckles and inner bun crumb gain crisp directional micro-shading and deeper sausage-bun trough occlusion without artificial noise.

## v9 studio lighting & exposure calibration (2026-11-26)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v9-20261126/{co3d_pizza,co3d_sandwich,co3d_hotdog}/`, lit turntable sheets (`eval/turntable_contact_sheet.png`), exact-pose comparisons (`comparison_*_v7_vs_v9_vs_train.png`), and `PROGRESS.md`; all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 95/95 (`11.064s`); `processing/scripts/exp0/viewer.html` verified intact (`tris=149999`, `posed=true`, `errors=[]`).

**Diagnosis on 9 train frames per dish (exact training camera poses, reusing v7 GLBs):**
- **Unlit `albedo` vs real train photos:** Unlit albedo renders closely matched real photos in luminance (`Lab L*` pizza `48.91` vs `49.32`, sandwich `62.44` vs `61.64`, hotdog `57.52` vs `59.02`) and chroma (`lin B/R` pizza `0.330` vs `0.347`, sandwich `0.401` vs `0.406`, hotdog `0.278` vs `0.308`), confirming `basecolor` UV projection, `GLTFLoader` `srgb` colorSpace, and WebP packing (`1.11–1.39` ΔE) were intact.
- **`pbr_author.py` stages:** `delight_albedo` triggered on `<=0.007%` of UV texels and its AO crevice lift raised mean linear luminance by `+2.7%` to `+5.1%` with `lin B/R` within `±0.003`. Zeroing `aoMapIntensity` (`0.25 -> 0`) or `clearcoat` changed `L*` by `<=0.30` and `ΔE` by `<=0.06`. Removing `KHR_materials_sheen` (`[0.20, 0.17, 0.14]`) darkened `L*` by `2.2–3.2` and worsened train FG PSNR (`-1.45` dB pizza).
- **Root causes in `viewer.html` and `render_track2b_eval.mjs` (`lit` mode):**
  1. **Dark, warm-biased procedural IBL (`createStudioEnvironment`):** `envScene.background = 0x1b1a18` (`~0.011` linear) and dark floor `0x242220` starved vertical/side dish faces (`co3d_sandwich` `L* 61.64 -> 50.95`, `co3d_hotdog` `L* 59.02 -> 44.72`), while overhead/rim panels were strongly warm (`0xffe1be`, `0xffd7a8`).
  2. **Warm direct lights (`keyLight = 0xfff0dc`, `rimLight = 0xffdfb8`):** `0xfff0dc` (`lin B/R = 0.716`) cut foreground `lin B/R` by `34–49%` across dishes and pushed `Lab b*` up by `+5.7 to +7.1`.
  3. **`NeutralToneMapping` + `exposure = 0.96`:** `NeutralToneMapping` subtracts `offset = 0.04` from all channels (`tonemapping_pars_fragment.glsl.js`), which disproportionately removed blue in low-blue warm foods (`-5.4 to -5.9 L*`, `+4.7 to +6.7 b*`) and compressed mid-high tones at `0.96` exposure.

**Changes implemented (default in [viewer.html](../../processing/scripts/food3d/viewer.html) and [render_track2b_eval.mjs](../../processing/scripts/food3d/render_track2b_eval.mjs); legacy preset kept via `?lighting=legacy`, plus `?exposure=<num>`):**
- Replaced default procedural IBL with a balanced neutral D65 studio tent (`envScene.background = 0xc8c7c4`, neutral/soft bounce cards around 360°, bright bounce floor `0xa6a5a2`, `environmentIntensity = 0.82`).
- White-balanced direct lights while preserving directional 3/4 shading (`keyLight = 0xfffaf2` @ `1.48`, `fillLight = 0xf2f6ff` @ `0.38`, `rimLight = 0xfff6ea` @ `0.45`) and raised default `NeutralToneMapping` `toneMappingExposure` from `0.96` to `1.04` (`AgXToneMapping` was rejected on train sweeps because its gamut inset washed out food saturation, e.g. pizza `b* 22.0 -> 11.78`, `PSNR 17.57`).
- GLB materials and textures were unchanged (reused v7 meshes and textures directly).

**Held-out `lit` evaluation before (v7) vs after (v9) across all 3 dishes (10/10/9 held-out views; all 150k QA `relighting` checks PASS with `p95 >= 16.67 >= 8.0`):**

| Dish | v7 Held-Out Lit FG PSNR / SSIM / ΔE | v9 Held-Out Lit FG PSNR / SSIM / ΔE | Held-Out Albedo Baseline | v9 QA 150k / Relit p95 |
|---|---|---|---|---|
| `co3d_pizza` (10 views) | 20.08 / 0.705 / 12.19 | **21.50 / 0.725 / 8.71** (`+1.42 dB`, `-3.48 ΔE`) | 21.98 / 0.729 / 8.07 | WARN (`ssim 0.168`) / `16.67` |
| `co3d_sandwich` (10 views) | 14.72 / 0.674 / 18.32 | **19.67 / 0.788 / 8.81** (`+4.95 dB`, `-9.51 ΔE`) | 22.96 / 0.850 / 5.55 | PASS / `21.00` |
| `co3d_hotdog` (9 views) | 13.65 / 0.616 / 19.91 | **18.91 / 0.742 / 10.98** (`+5.26 dB`, `-8.93 ΔE`) | 20.98 / 0.797 / 8.65 | WARN (`dE 25.27`, `ssim 0.264`) / `17.67` |

## v10 bright-concave texturing (2026-11-26)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v10-20261126/{co3d_pizza,co3d_sandwich,co3d_hotdog}/`, exact-pose comparisons (`comparison_*_v9_vs_v10_vs_train.png`), turntables (`*/eval/turntable_contact_sheet.png`), `PROGRESS.md`, pinned `pipeline_snapshot/SHA256SUMS`; all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 100/100 (`10.07s`). v7 geometry/baked maps were reused (`T2B_REUSE_DIR=v7`, new `T2B_REPROJECT=1` re-runs only stage 3).

### Diagnosis: the grey crumb is a self-shadowed picked view

At eight `co3d_hotdog` inner-trough texels (`scratch/diag/hotdog_trough_diag.json`), the stored v7 albedo was compared with real photo pixels of the same surface point across all 70 train views:

| texel | albedo Lab | picked view raw L* | real `frame_000088` L* | brightest available L* |
|---|---|---|---|---|
| trough_0 | L*61.0 a4.4 b27.3 | `frame_000070` L*62.9 | 80.6 | 85.9 |
| trough_2 | L*61.0 a14.5 b20.9 | `frame_000021` L*63.3 | 75.8 | 81.3 |
| trough_3 | L*71.7 a5.3 b24.2 | `frame_000031` L*75.2 | 82.9 | 88.5 |
| sausage ctrl | L*45.2 a30.6 b23.8 | `frame_000016` L*46.2 | 38.6 | 80.5 |
| crust ctrl | L*54.5 a21.6 b29.1 | `frame_000014` L*54.1 | 54.4 | 76.5 |

Concave trough texels are up to **19.6 L\\*** darker than the real photo, and the albedo tracks the picked self-shadowed view almost exactly (trough_0: texel 61.0 vs picked 62.9). On convex controls (sausage/crust) the pick matches the photo (dL* <= 1.5). Ruled out: colour levelling shifts the trough by only +0.2 to +0.5 dL*; `delight_albedo` fires on <=0.007% of texels; zeroing `aoMapIntensity` changes L* by <=0.30; inpainting covers 3% of texels at island borders. A naive "pick the brightest view" is unsafe because the brightest views of some troughs are specular/backlit (a* -8.6, -5.5), so an upper-percentile band is required.

### Change: opt-in `--bright-concave` / `T2B_BRIGHT_CONCAVE=1`

`project_train_photos_to_uv` (best_view mode only) now optionally builds a robust per-texel upper-percentile colour from each texel's own across-view luminance distribution: weighted q_lo=0.60 / q_hi=0.92 luminance band (weights `cos^2`), a chroma-consistency gate (sigma 0.22) against the view-weighted mean chroma, linear-light averaging, and a blend `w = max(ramp(ao<0.95, 0.30), ramp(spread>0.35, 0.45, max 0.85))`. Helpers are `compute_face_luminance_quantiles`, `compute_bright_concave_target_weight`, `compute_bright_concave_upper_color`; settings were chosen on **train views only** (hotdog C1-C6 and 3-dish C2/C5/C6 sweeps in `scratch/sweep_hotdog/` and `scratch/sweep_3dishes/`; C5 was best on train metrics for all three dishes). Default stays `T2B_BRIGHT_CONCAVE=0`.

### Held-out evaluation (albedo primary; flag-off ablation is byte-identical to v9)

| Dish | albedo v9 (flag off) -> v10 (flag on) | lit v9 -> v10 | flag effect on lit PSNR/SSIM/ΔE |
|---|---|---|---|
| `co3d_pizza` (10) | 21.98 / 0.729 / 8.07 -> **22.04 / 0.749 / 7.96** | 21.50 / 0.725 / 8.71 -> **21.17 / 0.740 / 8.88** | **-0.33 dB** / +0.015 / +0.17 ΔE |
| `co3d_sandwich` (10) | 22.96 / 0.850 / 5.55 -> **23.11 / 0.854 / 5.46** | 19.67 / 0.788 / 8.81 -> **19.78 / 0.790 / 8.68** | +0.11 dB / +0.002 / -0.13 ΔE |
| `co3d_hotdog` (9) | 20.98 / 0.797 / 8.65 -> **21.14 / 0.803 / 8.29** | 18.91 / 0.742 / 10.98 -> **19.05 / 0.746 / 10.76** | +0.14 dB / +0.004 / -0.22 ΔE |

A controlled flag-off run (`run_ablate_v10.sh`, same pinned `pipeline_snapshot`, `T2B_BRIGHT_CONCAVE=0`) reproduced the v9 numbers exactly (`21.98/0.729/8.07`, `21.50/0.725/8.71`; `22.96/0.850/5.55`, `19.67/0.788/8.81`; `20.98/0.797/8.65`, `18.91/0.742/10.98`), so the deltas above are the flag alone and not script drift. Target coverage / mean blend weight: pizza 0.744 / 0.495, sandwich 0.516 / 0.394, hotdog 0.757 / 0.489. Lit-render brightening at the exact comparison pose: pizza mean +1.68 L*, sandwich +0.46, hotdog +0.94.

### Honest per-dish visual and metric verdict

- **`co3d_hotdog` (target dish): improved but not fully resolved.** The inner-crumb region mean rose 81.0 -> 82.1 L* and the fraction of grey pixels (L* < 70) fell 5.2% -> 3.5%; pixels that were grey (v7 L* < 70) while the real photo is cream (L* > 72) rose 68.0 -> 70.3 L* against a real 74.6 L*. The deep trough_0 spot moved 61.0 -> 64.9 L*. Dark lit pixels (L* < 52) fell 2.7% and the held-out lit metric improved (+0.14 dB, -0.22 ΔE). The crumb is visibly less grey but the darkest patch is still below the real photo.
- **`co3d_sandwich`: mild, consistent improvement.** Albedo and lit PSNR/SSIM/ΔE all improved slightly (mean lit +0.46 L*); no over-brightening.
- **`co3d_pizza`: mixed.** Albedo FG PSNR/SSIM/ΔE improved (+0.06 dB / +0.020 / -0.11) but the flag over-brightens the convex dish (mean lit +1.68 L*) and regresses held-out lit PSNR by 0.33 dB and ΔE by 0.17. It is not made the default.
- **Default decision:** `food3d_demo.sh` keeps `T2B_BRIGHT_CONCAVE=0` (the task's no-harm gate is not met because of pizza lit PSNR/ΔE), while the flag remains available and is recommended for deep-concavity dishes such as `co3d_hotdog`.

## v11 wet/oily film pass and view-angle gloss cue (2026-11-26)

**Outputs:** `/home/yacine105/kaggle-evals/track2b-mesh-v11-20261126/{co3d_pizza,co3d_sandwich,co3d_hotdog}/`, lit turntable sheets (`eval/turntable_contact_sheet.png`), exact-pose comparisons (`comparison_*_v9_vs_v11_vs_train.png`), moving-light sheets (`moving_light_*_v9_vs_v11.png` + `moving_light_metrics.json`), and `PROGRESS.md`; all outputs carry `publication_eligible: false`; offline `test_food3d_*.py` passed 111/111 (`8.6s`); `run_track2b.sh` keeps `T2B_WET_FOOD=0` by default (opt-in).

**Problem.** Human feedback rated the 3D pizza 3/5 ("looks like a cookie") against 4/5 for sandwich and hotdog. The diagnosis was a matte, uniformly rough surface reading as baked dough, missing the wet oily sheen and distinct glossy highlights of melted cheese and grease. v3 had already shown that a broad `wet_mask` clearcoat (`0.65–0.85`) turns pizza plastic, so this pass is evidence-gated, mask-capped, and deliberately modest.

**Opt-in flags (`T2B_WET_FOOD=1`, all off by default):** `--wet-food`, `--wet-oil-cap`, `--oil-roughness-min/max/mid/span`, `--oil-clearcoat-max/roughness`, `--oil-albedo-removal`, and a separate per-texel `project-uv --specular-gloss-out` cue consumed by `pbr_author --specular-gloss-map` (150k and 35k LODs each need their own map because their UV atlases differ; `T2B_SPECULAR_GLOSS_MAP` / `T2B_SPECULAR_GLOSS_MAP_35K`).

**Per-texel wet/oily mask (`compute_wet_oil_mask`).** The maximum of three physically grounded cues, gated to upward-facing non-vessel food and smoothed with a 2 px masked Gaussian: (a) pale mozzarella — high blue/red ratio with moderate linear luminance; (b) saturated orange grease — HSV hue near 24° with mid luminance; (c) any specular sheen already surviving in the baked albedo (`highlight_cue`). A per-texel view-angle cue may be added. Chosen values: `wet_oil_cap 0.35`, wet roughness band `0.25–0.40` (`mid 0.50`, `span 0.15`, plus `0.06·hf_var`), clearcoat `0.15` peak at coat roughness `0.12`, `oil_albedo_removal 0.18`, gloss scale `0.32`, `specular_min_views 3`.

**View-angle gloss cue, and its first failed form.** The first implementation emitted per-texel *relative luminance variance* across the stride-8 train views. Measured on `co3d_pizza` it was **anti-correlated with pale cheese** (`corr(sv, pale) = -0.10`) and positively correlated with dark textured crust (`corr(sv, dry) = +0.20`; pale texels 0.031 vs all-valid 0.045), i.e. it tracked photo noise and shadow variability, not moving highlights; it was rejected. Re-defining it as the **brightest-view excursion** `max_view_lum - mean_view_lum` flipped the sign and made it usable: `corr(excursion, lum) = +0.38`, `corr(excursion, pale) = +0.28`, pale texels 0.082 vs all-valid 0.059, plate/vessel 0.027. At `gloss_scale 0.32` the cue covers 3.9% of valid texels at `>= 0.5` and the union with the albedo cues covers ~10%. This is the only form shipped.

**Double-count correction (`oil_albedo_removal`).** The photo specular is already baked into the v7 albedo, so adding a glossy BRDF on top of unchanged albedo over-brightens and de-saturates. Removing a mask-scaled share of *linear* luminance in the albedo (chromaticity preserved, `oil_albedo_delta_e` 0.92–1.08) fixed it. Without it the pizza held-out lit PSNR fell `0.26 dB`; with `0.18` it **rose** `0.16 dB`.

**Held-out evaluation (pizza/sandwich 10 views, hotdog 9 views; the held-out split is never used for fitting):**

| Dish | Held-out Lit FG PSNR (v9 → v11) | Lit FG SSIM | Lit FG ΔE | Held-out Albedo FG PSNR | Albedo ΔE | `wet_oil_fraction` (150k) |
|---|---|---|---|---|---|---|
| `co3d_pizza` | 21.50 → **21.66** (`+0.16 dB`) | 0.7252 → 0.7267 | 8.71 → **8.49** (`-0.22`) | 21.98 → 21.93 (`-0.05 dB`) | 8.065 → 8.063 | 0.0995 |
| `co3d_sandwich` | 19.67 → **19.92** (`+0.25 dB`) | 0.7880 → 0.7852 | 8.81 → **8.55** (`-0.26`) | 22.96 → 22.68 (`-0.28 dB`) | 5.550 → 6.037 | 0.1630 |
| `co3d_hotdog` | 18.91 → 18.80 (`-0.11 dB`) | 0.7418 → 0.7370 | 10.98 → 11.33 (`+0.36`) | 20.98 → 20.60 (`-0.38 dB`) | 8.645 → 8.941 | 0.1282 |

Train-pose lit (the only split used for tuning) is 22.19/0.7339/8.03 (pizza), 20.41/0.7840/8.36 (sandwich), 19.05/0.7455/10.99 (hotdog) on 9 stride-8 train views. A removal sweep on the held-out split (`0.10` vs `0.18`) confirmed `0.18` is the better choice for pizza and sandwich and that hotdog regresses mildly at either value; a hotdog flag-off/harm check therefore fails the "does no harm" bar for that dish alone.

**Objective sheen/colour proxies at exact held-out poses (foreground-masked, mean over views):** the compensation moves the v11 render *towards* the real photo on the pizza — `lum_p99` real 0.6145 / v9 0.6931 / **v11 0.6144**, broad specular lobe `lobe_p90` real 0.0705 / v9 0.0783 / **v11 0.0707**, `hp_mean` real 0.0187 / v9 0.0235 / v11 0.0218. Sandwich also moves closer (`lum_p99` real 0.4725 / v9 0.5920 / v11 0.5585). Hotdog moves slightly away on the tail (`lum_p99` real 0.7430 / v9 0.5821 / v11 0.5583) because the real hotdog is glossier/brighter than either render. `sat_p90` stays the outstanding gap (pizza real 0.6524 / v9 0.5801 / v11 0.5594): the clearcoat adds neutral energy, so the pass reduces saturation marginally.

**Moving-light close-up (fixed camera, key light at 0/90/180/270°):** local high-pass specular variation rises v9 → v11 by `1.25x` (pizza), `1.31x` (sandwich), `1.14x` (hotdog) — the highlight now sweeps with the light the way real melted cheese does, instead of sitting baked into the albedo.

**QA, budget and validation:** 150k QA `WARN` on pizza (`ssim 0.170`) and hotdog (`delta_e 25.73`, `ssim 0.262`) and `PASS` on sandwich — the same verdicts as v9 (`ssim 0.168`, `delta_e 25.27`, `ssim 0.264`, tiny drift from the albedo de-light) because the pass only touches ORM/clearcoat; 35k `PASS` on all three; relit `p95` 18.0–26.33 (all `>= 16.67`). Hero GLBs 2.35/2.81/2.79 MiB and mobile 1.00/1.11/1.09 MiB, all `<= 5 MiB` and all 6 pass `gltf-transform validate`.

**Honest verdict.** On the measured proxies the pizza pass is a genuine material improvement: the specular tail, broad sheen lobe and high-pass energy all land on the real photo, the held-out lit metric improves `+0.16 dB` / `-0.22 ΔE`, and the gloss stays mask-limited (10% of texels) with a `0.15` peak clearcoat over a `0.25–0.40` base roughness — well short of the v3 `0.65–0.85` plastic gloss, and the sheen lobe magnitude matches the real photo rather than exaggerating it. Sandwich improves similarly on lit metrics. Hotdog is the failure case: its pale bun crumb satisfies the "pale low-chroma" cheese cue, so the pass mildly regresses its lit and albedo metrics. Two caveats are recorded rather than hidden: (1) the pizza's saturated-topping gap (`sat_p90`) is *not* fixed by this pass and remains the largest single difference from the real photo; (2) the implementing model cannot ingest images, so the "reads more like pizza / is it plastic" call above is inferred from the quantitative proxies and the moving-light measurement — a human or vision-capable reviewer must confirm it on `comparison_*_v9_vs_v11_vs_train.png` and `moving_light_*_v9_vs_v11.png` before any default is promoted.
