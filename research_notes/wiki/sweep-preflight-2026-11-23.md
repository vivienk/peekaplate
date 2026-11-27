# Sweep kernels preflight audit, 2026-11-23

Source: read-only subagent audit on 2026-11-23 (chief-of-staff session), working tree on top of HEAD 195d50d9 (uncommitted).
- All three staged kernels `/tmp/push-peekaplate-dish-3d-sweep-{trellis-a,trellis-b,fast-41}` PASS: GPU T4, private, dataset_sources [peekaplate-dish-menu-41, peekaplate-hf-token]; notebooks byte-identical to `build_multi_model_notebooks.py` regenerated from the working tree.
- Ranges: trellis-a = TRELLIS+MoGe-2 dishes 01–21; trellis-b = 22–41; fast-41 = MoGe-2/TripoSG/Hunyuan3D-2/Hi3DGen all 41 (Hi3DGen one setup check per shard → per-dish `skipped`).
- trellislast-version (dishes 01–04) and hero-batch-b (05–19) are both subsets of trellis-a.
- Estimated wall time: trellis-a 2.6–3.1 h, trellis-b 2.5–3.0 h, fast-41 3.0–3.5 h (~2.8 GB output). GPU quota 2026-11-23: 13.87 h of 45 h used, resets 2026-11-28.
- Cosmetic: notebook intro markdown still names `peekaplate-dish-test-photos` as source; discovery scans all of /kaggle/input so behaviour is correct.
Related: [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md), [kaggle-gpu-session-cap](kaggle-gpu-session-cap.md), [trellis-run-profile](trellis-run-profile.md).
- Superseded 2026-11-23: Hi3DGen is no longer skipped by design in fast-41; see [hi3dgen-spconv-root-cause](hi3dgen-spconv-root-cause.md).
