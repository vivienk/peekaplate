# Interactive studio build, 2026-11-23

On 2026-11-23 a subagent merged `/tmp/out-t32`, `/tmp/out-b5`, `kaggle-evals/pull-ba5` and `/tmp/out-hb-6` into `/home/yacine105/kaggle-evals/studio-latest/results`, which holds 19 dishes. `interactive_3d_studio.html` is 123 MB, embeds base64 mobile GLBs and loads three@0.182.0 from jsdelivr. It covers MoGe-2, TripoSG and Hunyuan3D-2 on 19 dishes and TRELLIS on 14; Hi3DGen has 0 because it was skipped on all 19. In headless Firefox over file:// it showed 0 console errors and 0 failed requests.
Defects found (uncommitted working tree on 195d50d9, not yet fixed):
- After `--build`, `comparison_viewer.html` points at `/vendor/three` when a local copy exists, so it works only under `--serve`.
- The model-detail labels in `dish_3d_studio.py` read "TRELLIS Fast/Full" for every model.
- At 123 MB for 19 dishes, a single file for all 41 dishes will run to roughly 260 MB. The 41-dish page needs a lighter embedding strategy.
Related: [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md), [trellis-run-profile](trellis-run-profile.md).

## Split studio, 2026-11-23 (supersedes the single-file default above)
A Claude subagent changed `dish_3d_studio.py` and its tests (10/10 pass) in the uncommitted working tree.
- The index page (68 KB, no three.js) links to one page per dish. Each dish page embeds only that dish's mobile GLBs: median 6.0 MB, max 7.2 MB, against 123 MB for the old single file.
- `--menu-manifest` lists all 41 dishes, with `pending` for models that haven't run.
- Labels show the real model names, and `--build` pins the CDN. The legacy single file is written only with `--legacy-single-file`.
- Output is in `/home/yacine105/kaggle-evals/studio-split/`, with the manifest copy at `menu41-dishes_manifest.json`.
- Verified in headless Firefox over file:// with 0 errors.
- Still open: `merge_multi_model_results.py` still writes the heavy file; the docs/CONTEXT.md `assets` summary and the dish-3d-delivery.md studio section are stale (context:check FAIL); the legacy template and notebook Cell 19 label fix waits for the Kaggle runs to finish.
