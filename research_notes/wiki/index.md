# PeekaPlate dish-3D wiki — index

Historical record kept by the chief-of-staff session. Every claim is dated; nothing here describes "now". Sources are cited, never copied.

## Start here
- [next-session-2026-11-23](next-session-2026-11-23.md) — state and ordered next steps at the 2026-11-23 restart.
- [colab-trellis-hires-run-2026-11-23](colab-trellis-hires-run-2026-11-23.md) — live Colab L4 fixes, measurements, max-detail run in progress.
- [colab-trellis-hires-run-2026-11-24-resume](colab-trellis-hires-run-2026-11-24-resume.md): resumed run, stale huggingface_hub ImportError and its restart fix

## Goal
- [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md) — the outcome being pursued and its done-criteria.
- [goal-photoreal-food-3d-pipeline](goal-photoreal-food-3d-pipeline.md): 2026-11-24 goal, photoreal (game-quality) 3D food pipeline, own thread; proposed bar, staged plan, Experiment 0
- [exp0-relight-cleanup-lod-2026-11-24](exp0-relight-cleanup-lod-2026-11-24.md): no-GPU re-light/cleanup/LOD of 6 TRELLIS.2 dishes; LODs fine, slab rule fixed, blind rating pending
- [food3d-v1-pbr-qa-pipeline-2026-11-24](food3d-v1-pbr-qa-pipeline-2026-11-24.md) — local PBR and QA run on eight dishes, photo-view limits, and review and capture gates.
- [track2-multiview-e1-brush-results-2026-11-25](track2-multiview-e1-brush-results-2026-11-25.md) — $0 local Brush run on three CO3D food orbits, held-out scores, video ingestion and open mesh/PBR gates.
- [track2b-mesh-pbr-2026-11-25](track2b-mesh-pbr-2026-11-25.md) — $0 local 2DGS + Open3D TSDF + multi-view UV PBR mesh pipeline on three CO3D food orbits, QA verdicts and held-out scores vs Brush 3DGS.
- [gemini-food-3d-report-vs-ours-2026-11-24](gemini-food-3d-report-vs-ours-2026-11-24.md): what the Gemini food-3D PDF adds (food shaders, de-lighting, orbit-video 3DGS, QA gate); unverified claims flagged

## Decisions
- [decision-2026-11-23-free-slot-for-sweep](decision-2026-11-23-free-slot-for-sweep.md) — cancel queued trellislast-version/33 so the TRELLIS sweep can run.
- [decision-2026-11-23-wiki-location](decision-2026-11-23-wiki-location.md) — why the wiki lives here.
- [decision-2026-11-23-subagent-providers](decision-2026-11-23-subagent-providers.md) — subagents on Codex Terra / DeepSeek V4.1 Flash, not Claude.
- [decision-2026-11-23-colab-hybrid](decision-2026-11-23-colab-hybrid.md) — Kaggle for routine sweeps, Colab credits for TRELLIS hi-res and full Hunyuan3D-2.1.
- [decision-2026-11-24-dec1-demo-direction](decision-2026-11-24-dec1-demo-direction.md): Dec 1 demo, Screen 9 GLB path vs Blender/LLM or fine-tuning
- [clickup-s7-vis-06-ownership-2026-11-24](clickup-s7-vis-06-ownership-2026-11-24.md): S7-VIS-06 owners, deadlines, PRD constraints on 3D provider/contract/approval
- [decision-2026-11-24-sai-3d-infra](decision-2026-11-24-sai-3d-infra.md): Sai: separate 3D job service, Tripo-only egress allowlist, separate Docker target, migration rules, review; 2.5D prod QA 11-25 and re-QA 11-26 (both defects reproduced pre-#274)
- [s7-vis-06-slice1-provider-interface](s7-vis-06-slice1-provider-interface.md): provider interface branch, commits, review outcome, open items
- [s7-vis-06-slice3-design-2026-11-24](s7-vis-06-slice3-design-2026-11-24.md): async 3D job design (Worker/container/R2), pending
- Report (2026-11-24): [Food photo to 3D quality factors](../../reports/Food%20photo%20to%203D%20quality%20factors.md): what limits TRELLIS.2 dish quality; ours (viewer, 512 px inputs, cutouts, no cleanup) vs model limits

## Recurring problems / platform quirks
- [kaggle-gpu-session-cap](kaggle-gpu-session-cap.md) — two batch GPU sessions max; queued sessions count.
- [kaggle-cancel-session-not-scriptable](kaggle-cancel-session-not-scriptable.md) — the CLI cannot cancel a queued version.
- [kaggle-hf-token-via-dataset](kaggle-hf-token-via-dataset.md) — notebook secrets don't work for API-pushed kernels; token travels as a private dataset.
- [kaggle-dataset-mount-flake](kaggle-dataset-mount-flake.md) — identical metadata, token dataset missing at runtime on sweep-b v1.
- [tmp-ramdisk-full](tmp-ramdisk-full.md) — /tmp is 7.6 GB RAM; pull Kaggle outputs to /home/yacine105/kaggle-evals.

## Subsystems
- [Dish 3D models for Kaggle 2xT4](../../reports/Dish%203D%20models%20for%20Kaggle%202xT4.md) — 2026-11-23: partial primary-source feasibility survey and experiment priorities.
- [trellis-run-profile](trellis-run-profile.md) — measured per-dish TRELLIS.2-4B stage timings and mesh sizes on 2xT4.
- [sweep-preflight-2026-11-23](sweep-preflight-2026-11-23.md) — staged sweep kernels audited PASS; ranges, runtimes, quota.
- [studio-build-2026-11-23](studio-build-2026-11-23.md) — 19-dish interactive studio built; size and label/vendor defects.
- [model-survey-2xt4-2026-11-23](model-survey-2xt4-2026-11-23.md) — nothing proven better than TRELLIS.2 on 2xT4; SPAR3D + Hunyuan3D-2.1 A/B next.
- [hi3dgen-spconv-root-cause](hi3dgen-spconv-root-cause.md) — Hi3DGen skip was a pccm JIT false-positive, not GPU/CUDA; fixed with JIT-disable switches.
- [trellis-retry-plan-2026-11-23](trellis-retry-plan-2026-11-23.md) — why TRELLIS skipped dishes 01–04 and 18, and the retry plan.
- [hunyuan3d-21-feasibility](hunyuan3d-21-feasibility.md) — 2.1 shape fits a T4 in fp16; 2.1 PBR paint (21 GB) does not, as of 2026-11-23.
- [colab-mcp-setup](colab-mcp-setup.md) — 2026-11-23: official Google Colab MCP server installed for Claude Code; tools, user flow, and GPU runtime limits.
- [colab-notebooks](colab-notebooks.md) — 2026-11-23: L4 TRELLIS.2 hi-res (1024_cascade) and A100 Hunyuan3D-2.1 PBR Colab notebooks with Drive streaming and credit guards.
