# 2xT4 model survey outcome, 2026-11-23

Source: `reports/Dish 3D models for Kaggle 2xT4.md`, written by two GPT-6.1 Terra (high) research runs on 2026-11-23.
- Verdict (2026-11-23): no open model is demonstrated to match or beat TRELLIS.2 on dish photos while producing a textured GLB on 2xT4.
- Next steps recommended: (1) a single-dish SPAR3D probe on GPU; (2) a Hunyuan3D-2.1 shape + photo-projection A/B, about 1.5–3 GPU-h for 41 dishes ([hunyuan3d-21-feasibility](hunyuan3d-21-feasibility.md)).
- Still unverified: whether SPAR3D builds on CUDA 12.8/sm_75, Step1X-3D's per-stage VRAM and texture fit in 16 GB, and the per-candidate comparison for TRELLIS v1, Direct3D-S2, Sparc3D, UniLat3D and the others.
- Recurring problem: both Terra research runs stopped with coverage self-reported as incomplete. Published benchmarks don't use food photos anyway, so the decision moved to an empirical A/B on our own dishes instead of a third paper pass.
Related: [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md), [decision-2026-11-23-subagent-providers](decision-2026-11-23-subagent-providers.md).
