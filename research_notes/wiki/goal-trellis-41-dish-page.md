# Goal: TRELLIS-first 41-dish results page

On 2026-11-23 the goal (from the scheduled task `fc957758…` prompt and the user's /chief-of-staff request) was:
one self-contained page (`processing/scripts/build_dish_model_report.py` output) covering all 41 dishes of the gmn9c8 menu, with TRELLIS.2-4B coverage stated for every dish, alongside MoGe-2 / TripoSG / Hunyuan3D-2 / Hi3DGen, plus measured TRELLIS mesh quality (faces, texture size, non-manifold edges, plate+food as one object) and the next quality gap documented.

Done-criteria (2026-11-23): page exists; per-dish TRELLIS status; per-model coverage table; schedule disabled after.

Path (2026-11-23): three staged kernels `/tmp/push-peekaplate-dish-3d-sweep-{trellis-a,trellis-b,fast-41}` pushed one at a time under [kaggle-gpu-session-cap](kaggle-gpu-session-cap.md), pulled, graded with `processing/scripts/verify_kaggle_outputs.py`, merged with `merge_multi_model_results.py`.

Known follow-up (handoff 2026-11-22/23 in docs/CONTEXT.md): merge drops `source_revisions` and `generated_at`.

See [decision-2026-11-23-free-slot-for-sweep](decision-2026-11-23-free-slot-for-sweep.md), [trellis-run-profile](trellis-run-profile.md), [kaggle-hf-token-via-dataset](kaggle-hf-token-via-dataset.md).
