# TRELLIS.2-4B run profile on Kaggle 2xT4

Measured 2026-11-23 from the live log of `yacine105/peekaplate-dish-3d-trellis2-hero-batch-b` v6 (`kaggle kernels logs -f`), 4 dishes:
- stages: dinov3_cond ~3.4 s; sparse_structure ~128 s; shape_slat 36–95 s; tex_slat 31–63 s; decode_latent 12–22 s; export_glb 39–78 s ⇒ ~5–6 min/dish.
- raw decode 0.23–2.2 M faces → exported 280k–296k faces, 178k–220k verts, mobile 31.7k–33.1k faces, remesh=True, texture 2048.
- peak RSS ~5.7 GiB.
Mesh quality (non-manifold edges, plate+food single object) NOT yet measured as of 2026-11-23; to be graded after pull ([goal-trellis-41-dish-page](goal-trellis-41-dish-page.md)).

## Measured mesh quality, 2026-11-23 (hero-batch-b/6, 14 dishes)
From the 12:49 `build_dish_model_report.py` run over t32, hb-5, ba-5 and hb-6 (`/tmp/report/build-console.txt`): TRELLIS.2-4B succeeded on 14 of 19 dishes and was skipped on 5 (01–04 and 18). Median 293k faces, **median 104k boundary edges, 11.5 shells, 0/14 watertight**. MoGe-2 reached 19/19 watertight with 1 shell, and Hunyuan3D-2 11/19 watertight. TRELLIS meshes are open and fragmented; this is the top output-quality gap as of 2026-11-23.

## Correction, 2026-11-23 (supersedes "open and fragmented" above)
`build_dish_model_report.py` (`_render_welded`, ~line 567) also measures **welded** topology. glTF splits vertices at UV seams, so the 104k index boundary edges overstate how open the mesh is. Welded, TRELLIS has a median of **2 boundary edges**, so it is near-closed. The remaining defect is the **median 11.5 disconnected shells**. The user had been told the meshes were "open"; that was corrected on 2026-11-23.

## sweep-trellis-a/1 progress, 2026-11-23 12:11Z
From `kaggle kernels logs -f` (90 s capture), running since 10:26Z: `HF token source: dataset:peekaplate-hf-token/hf_token.txt` and `DINOv3 preflight: ok=True`. 21 dishes staged. `18_choco_cake_ice_cream` again fell back to `food_only_fallback` (`plate_preserved: False`), so it will skip as [trellis-retry-plan-2026-11-23](trellis-retry-plan-2026-11-23.md) predicted. 13 TRELLIS `export_glb` stages done at ~5.5 min/dish, consistent with the hero-batch-b profile (279k–294k faces, ~33k mobile faces, tex 2048). `nvdiffrec_render` wheel build failed again; it is non-fatal (`nvdiffrec_available = False`).

## Sweep A, 2026-11-23 (sweep-trellis-a v1, dishes 01–21)
Graded by a DeepSeek V4.1 Flash subagent: `/tmp/report/sweep-trellis-a-1-summary.md` and verify-sweep-trellis-a-1.{json,md}.
- Verifier PASS: 21/21 dishes, 82/82 GLBs, 0 errors.
- TRELLIS: 20 success, 1 skipped (18, plate guard), 0 failed. MoGe-2: 21 success.
- TRELLIS raw faces: median 292,594 (range 279,346–298,084). Textures 2048² raw, 1024² mobile.
- TRELLIS welded topology (n=40 GLBs, raw and mobile): median welded boundary edges 1, median shells 7. For raw GLBs alone: 0 boundary edges, 13 shells.
- Plate/food separation is still the open quality issue.
