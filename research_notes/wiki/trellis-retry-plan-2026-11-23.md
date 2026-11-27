# TRELLIS skipped dishes: causes and retry plan, 2026-11-23

On 2026-11-23 the user asked for every TRELLIS-skipped dish to be retried.
- Dishes 01–04 were skipped in trellislast-version/32 for `missing_hf_token`, which has been fixed since ([kaggle-hf-token-via-dataset](kaggle-hf-token-via-dataset.md)). The running sweep-trellis-a (01–21) re-runs them, so no extra action is needed.
- Dish 18 (`18_choco_cake_ice_cream`) in hero-batch-b/6 failed a **deterministic guard**: worker_output says `"Skipped (plate_preserved is false or missing)."`. In the log, rembg found 6 plate boxes but none passed guards, so it fell back to a food-only cutout and TRELLIS was gated off. sweep-trellis-a runs the same code and the same photo, so it **will skip 18 again**, along with any other dish where plate detection fails.
- Plan, 2026-11-23:
  - (1) Change the generator so a failed plate detection no longer skips TRELLIS. Instead it runs on the food-only cutout and records `plate_preserved=false` / `plate_method` in the manifest and the report.
  - (2) After both TRELLIS sweeps are pulled, generate one small "trellis-retry" kernel for every dish whose TRELLIS status is skipped or failed, then merge.
  - Sequencing: Terra is editing `build_multi_model_notebooks.py` for Hunyuan3D-2.1/SPAR3D, so this change waits for it.
  - sweep-trellis-b may run before this lands; the retry kernel covers any of its dishes that skip.
Related: [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md), [trellis-run-profile](trellis-run-profile.md).
