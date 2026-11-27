# Food3D V1, 2026-11-24: local PBR post-processing and QA

Food3D V1 followed [Experiment 0](exp0-relight-cleanup-lod-2026-11-24.md) on the [photoreal food-3D goal](goal-photoreal-food-3d-pipeline.md). The local run processed eight existing single-photo reconstructions. All eight passed the technical checks below. Photo-view fidelity returned five WARN and three FAIL results. Under [ADR 0004](../../docs/adr/0004-visual-tiers.md), every R&D output stays `"publication_eligible": false`.

## Pipeline

Code lives in [processing/scripts/food3d](../../processing/scripts/food3d/).

0. **Input QA** (`input_qa.py`). Grades resolution and measures foreground Laplacian sharpness. Checks straight alpha-bbox edges for clipping in both unpadded and pre-padded inputs, connected components for clutter, the foreground perimeter for cast-shadow halos, and highlights for glare or flame blowout. Emits one of the four triage states below.
1. **Cutout and capture prep** (`cutout_clean.py`, `multiview_prep.py`). Runs local ONNX Runtime CPU segmentation with `birefnet-general-lite` or `isnet-general-use` under `MemoryMax=4G`. The `--existing-cutout` path validates alpha before fusion, rejecting missing alpha, masks that are >99% opaque, or masks that are <0.5% non-empty. Applies lower-confidence adaptive cast-shadow stripping and EDT edge color decontamination, then frames symmetrically in a square with ≥10% safe padding. Video and multi-view prep use `/usr/bin/ffmpeg` and sharp-bucket selection in temporary scratch directories.
2. **Geometry and bake** (`blender_bake.py`). Runs Blender 4.5.17 headless on CPU sequentially under `ulimit -v 12000000` with `--python-exit-code 1`. Welds vertices and classifies shells using `BMFace` objects as keys. Drops tiny shells and slab/table shells, with opt-in `--drop-shadow-disc` and `--main-object-only`. Scales to a default 24 cm, uncalibrated unless `--calibrated`, and flattens the underside to `z_min_m = 0`. Uses 65° sharp edges, weighted normals and `smart_project` UVs. Cycles bakes six selected-to-active passes with the targets unlinked: `basecolor`, `roughness`, `normal`, `ao`, `geom_features` and `uv_mask`. Temporarily zeroes and restores `Metallic`, `Transmission` and `Coat` during the basecolor bake so metallic platters retain their albedo. The bake had zero circular dependencies. Exports Y-up `_geom.glb` with tangents and `publication_eligible: false`.
3. **PBR authoring and packing** (`pbr_author.py`, `pack_pbr_glb.mjs`). Uses EDT UV gutter dilation, chromaticity-preserving specular de-lighting and AO crevice lift. Classifies surfaces at texture resolution scale as `vessel`, `dry`, `wet`, `liquid` or `moist`. Combines normals through Reoriented Normal Mapping (`combine_normals_rnm`) with grazing-angle attenuation. Authors clearcoat and ORM with `metallic = 0`, and writes the 2×2 `pbr_masks_debug.png`. Packs `basecolor_delit` as WebP at q=86 and `normal_final` at q=88. Uses 512 px lossless WebP for ORM and clearcoat to eliminate YUV 4:2:0 chroma bleed into metallic B. Sets `KHR_materials_clearcoat`, `KHR_materials_sheen`, `EXT_texture_webp` and `asset.extras.publication_eligible = false`, then runs `gltf-transform meshopt --level high` and `validate`.
4. **Render** (`viewer.html`, `render_ab.mjs`). Three.js 0.182.0 uses a procedural softbox studio with `NeutralToneMapping`, synchronized key and environment `lightAz` rotation, `?shadows=0` and transparent background support. Headless Chromium with SwiftShader captures `A_unlit_mobile`, `C_exp0_150k`, `E_v1_150k`, `Em_v1_35k`, `E_relit_120`, `E_clay_150k`, `E_roughness_150k`, `E_clearcoat_150k`, the dish-only `relit_0` and `relit_120` pair, and the 216-pose 150k grid with SHA-256 provenance.
5. **QA and comparison** (`qa_gate.py`, `build_studio.py`, `run_pipeline.sh`). The gate checks (1) budget, extras flag and glTF validation under `MemoryMax=4G`, (2) welded `trimesh` shell geometry, (3) strict `metallic = 0` and UV-masked PBR variance, (4) 216-pose fidelity search with SHA-256 and completeness verification, IoU, ΔE, windowed SSIM and `detail_corr`, and (5) dish-only relighting on shared foreground pixels, `p95 >= 8.0`. The pipeline writes the escaped, DOM-built `studio.html` comparison studio and per-dish `comparison_sheet.png`.

## Stage 0 batch triage

`input_qa_all28.json` covers 31 items (29 Colab dishes and two HQ Wikimedia images).

| Triage state | Count | Examples |
|---|---:|---|
| `ready_single_photo` | 6 | `03_kimchi` (2000×1125, `issues=[]`), `16_mafia_bento_box` (967×1104) |
| `needs_clean_cutout` | 6 | `08_lobster_shio_ramen`, `10_short_rib_mazesoba` and `12_tempura_ramen` flagged `shadow_contamination` |
| `needs_reshoot_clipped` | 11 | `05_ikari_steak_ramen` and `09_kuroshio_no_koki_ramen` had pre-padded vertical border clips `['left', 'right']` |
| `needs_multiview_or_reshoot` | 8 | |

## Eight-dish run

Run artifacts are in `/home/yacine105/kaggle-evals/food3d-v1-20261124/`. Across all eight dishes, both packed `150k` and `35k` LODs met the 5,242,880 B (5.0 MiB) budget, passed `gltf-transform validate` and carried `asset.extras.publication_eligible === false`. Each dish had `circ_deps = 0`, geometry PASS with `seated = True`, PBR material PASS with `metallic_channel_max = 0.0`, `poses_evaluated = 216/216` for the 150k hero, and relighting PASS with dish-only transparent foreground `p95 >= 39.0`. A/C/E studio variants were populated for each dish.

| Dish | 150k GLB | 35k GLB | UV coverage | Shells (dropped) | Roughness / coat std | Relit p95 (shared foreground) |
|---|---:|---:|---:|---|---|---|
| `12_tempura_ramen` | 3,453,880 B (3.29 MiB) | 1,726,400 B (1.65 MiB) | 0.32406 | 45 (tiny=1, slab=1) | 0.1973 / 0.1362 | 43.0 (86,143 px) |
| `05_ikari_steak_ramen` | 2,711,160 B (2.59 MiB) | 1,230,656 B (1.17 MiB) | 0.48745 | 43 (tiny=1) | 0.1737 / 0.2384 | 67.0 (96,280 px) |
| `08_lobster_shio_ramen` | 4,019,296 B (3.83 MiB) | 1,742,448 B (1.66 MiB) | 0.34965 | 182 (tiny=30, slab=1, shadow_disc=1) | 0.2332 / 0.2313 | 60.0 (105,787 px) |
| `09_kuroshio_no_koki_ramen` | 1,881,132 B (1.79 MiB) | 774,672 B (0.74 MiB) | 0.4499 | 16 | 0.1692 / 0.2728 | 44.333 (77,595 px) |
| `18_choco_cake_ice_cream` | 1,855,604 B (1.77 MiB) | 788,056 B (0.75 MiB) | 0.40215 | 15 (tiny=3, detached=1) | 0.1578 / 0.2399 | 80.0 (110,591 px) |
| `20_chicken_karaage` | 2,822,180 B (2.69 MiB) | 1,258,412 B (1.20 MiB) | 0.98511 | 72 (tiny=2) | 0.2194 / 0.2665 | 44.333 (114,410 px) |
| `03_kimchi` | 5,195,008 B (4.95 MiB) | 2,695,928 B (2.57 MiB) | 0.14546 | 1798 (tiny=117) | 0.2364 / 0.1965 | 39.333 (96,785 px) |
| `10_short_rib_mazesoba` | 4,424,920 B (4.22 MiB) | 1,933,808 B (1.84 MiB) | 0.26699 | 506 (tiny=170) | 0.2468 / 0.2745 | 39.0 (111,897 px) |

| Dish | Fidelity | V1 IoU | V1 ΔE | V1 SSIM | V1 detail corr | Exp0 comparison |
|---|---|---:|---:|---:|---:|---|
| `12_tempura_ramen` | WARN | 0.8933 | 25.93 | 0.2533 | 0.1541 | Clean IoU 0.88, ΔE 26.88, corr 0.1285 (raw ΔE 45.25) |
| `05_ikari_steak_ramen` | WARN | 0.9204 | 34.51 | 0.2859 | 0.2115 | Clean IoU 0.9025, ΔE 34.35, corr 0.2299 |
| `08_lobster_shio_ramen` | FAIL (ΔE > 35.0, SSIM warned below 0.45) | 0.8646 | 37.79 | 0.2488 | 0.0768 | Clean IoU 0.863, ΔE 37.08 |
| `09_kuroshio_no_koki_ramen` | WARN (IoU < 0.75) | 0.6985 | 33.12 | 0.4024 | 0.0637 | Clean IoU 0.7168, ΔE 30.97 |
| `18_choco_cake_ice_cream` | FAIL (ΔE > 35.0, SSIM < 0.15) | 0.8094 | 35.90 | 0.1213 | 0.0819 | `clean_main` IoU 0.8081, ΔE 35.13 |
| `20_chicken_karaage` | WARN | 0.8323 | 33.29 | 0.1994 | 0.0327 | Clean IoU 0.8512, ΔE 32.33 |
| `03_kimchi` | FAIL (SSIM < 0.15, ΔE warned above 18.0) | 0.937 | 28.79 | 0.096 | 0.1038 | |
| `10_short_rib_mazesoba` | WARN | 0.9892 | 19.91 | 0.3855 | 0.3556 | |

- **Lobster shio ramen.** Stage 1 preserved the full white plate and stripped 135 px of cast shadow. Stage 2 removed one slab and one shadow disc with `--drop-shadow-disc`. TRELLIS.2 had fused the large grey outer tray into the main shell (rank 0), so the next GPU reconstruction pass needs the cleaned cutout as input.
- **Chocolate cake and ice cream.** `--main-object-only` removed the detached crystal glass stand from `E_v1_150k`. The 2D cutout still included part of the overlapping stand, contributing to the ΔE and SSIM mismatch against the dish-only render.
- **Chicken karaage.** Upstream TRELLIS reconstructed a square tray where the source showed a round bowl.
- **Kimchi.** Zeroing `Metallic` during Cycles `DIFFUSE` baking restored the stainless platter albedo and removed the brown-black artifact (ΔE went from 40.57 to 28.79). The 65° sharp-edge threshold and `meshopt --level high` brought the 150k GLB under budget, from 7.48 MB to 4.95 MiB. Thin cabbage ribs shifted in the single-photo reconstruction, lowering pixel SSIM.
- **Short rib mazesoba.** Best photo-view agreement in the batch by IoU, ΔE and detail correlation.

## Review and fixes

The Codex `gpt-6.2-sol high` review and lanes A/B/C covered the bake, packing, QA and local workflow fixes. The 512 px lossless ORM and clearcoat maps brought metallic channel bleed from 0.302 to 0.0. The bake reset and edge/compression changes addressed albedo and size. QA gained SHA-256-backed 216-pose hero renders, shadow-free transparent dish-only relighting with a shared-foreground check, welded shell counts and verification of the publication flag on the final packed GLBs.

`run_pipeline.sh` replaced `_raw` and `_exp0` symlink mounts with copied inputs. `build_studio.py` uses JSON escaping and DOM construction. Cutout prep validates supplied alpha and strips lower-confidence shadows. `multiview_prep.py` isolates cutout work under `MemoryMax=4G` and cleans its scratch directories through `ExitStack`. The recorded offline `test_food3d_*.py` suite passed 28/28 tests.

## Readiness and next steps

The run verifies local post-processing and automated QA on these eight dishes, with no paid GPU or external API credits spent. Single-photo reconstruction can be useful from the photographed side. Hidden surfaces remain inferred, and the observed tray, bowl and fine-detail errors can persist after post-processing. Photo-view scores and light response cover only their measured checks. Human visual quality and all-sides fidelity remain open. Every R&D asset stays `"publication_eligible": false`.

1. Serve the comparison studio locally and record human 1–5 visual quality ratings in `studio.html`.

   ```sh
   python3 -m http.server -d /home/yacine105/kaggle-evals/food3d-v1-20261124 8765
   ```

   Open `http://localhost:8765/studio.html`.

2. Supply 2–4 real phone photos from different angles or a 15-second turntable orbit video of a real dish for Track 2 multi-view reconstruction (`multiview_prep.py` and E1/E3b/E2).
3. Get explicit user approval before any paid cloud GPU or external API credits are used, or before any git commit or push.
