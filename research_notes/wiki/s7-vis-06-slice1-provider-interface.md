# S7-VIS-06 slice 1: 3D model provider interface (2026-11-24)

The work is on local branch `feat/s7-vis-06-model-providers` in worktree `/home/yacine105/.t3/worktrees/peekaplate/t3-0d553f21-1f77f11ab5cf92be`, based on origin/develop 5b87c8a4. As of 2026-11-24 it has NOT been pushed.

Commits:
- c2595a07, rewritten as 6d7037c6 (Pi mistral/deepseek-v4-1-flash builder): the `processing/src/peekaplate_processing/model3d_providers/` package (base, tripo, meshy, trellis, registry). The pipeline became provider-neutral, selected through `MODEL_PROVIDER`.
- 690598f7, rewritten as 3f545f89 (Pi builder): fixed 8 Gemini 4 Neon review findings. Among them:
  - TRELLIS bearer auth applies to the exact configured origin only
  - readiness depends on the selected provider
  - CLI `--provider`
  - typed URL errors
  - Tripo balance auth regression
  - error_code sanitising
  - malformed keys
- 965bb47d, rewritten as f19c8370 (orchestrator): Neon re-review low finding. Port 0 is rejected, and `same_origin` is HTTPS only.

Review flow (see [[subagent-provider-routing]] in memory): Neon REQUEST_CHANGES (8), then fixes, then Neon APPROVE plus 1 low finding, then that fix. 724 processing tests pass, and context check is fresh.

Meshy endpoints confirmed against docs.meshy.ai on 2026-11-24: POST /openapi/v1/image-to-3d (data URI allowed), GET /openapi/v1/image-to-3d/:id, terminal states SUCCEEDED/FAILED/CANCELED, model_urls.glb. Still unverified: the field that carries the create-response task id, and the asset host.

Open before the PR:
- The commit author is `Codex <codex@localhost>`, because no git identity is configured. It needs the user's identity.
- The user's rule is to ask before publishing anything to GitHub.

Related: [clickup-s7-vis-06-ownership-2026-11-24](clickup-s7-vis-06-ownership-2026-11-24.md), [decision-2026-11-24-dec1-demo-direction](decision-2026-11-24-dec1-demo-direction.md).

2026-11-24 update:
- The user supplied their git identity (YACIINE105, mooml.intern@gmail.com). It was set in the repo-local git config, and the branch authors were rewritten (new SHAs above). 724 tests still pass.
- The user decided NOT to push until the provider API keys arrive from Vivien.

2026-11-24: the slice 2 builder (branch `feat/s7-vis-06-glb-postprocess`, stacked on slice 1) was killed by OOM partway through. The machine has 15 GB RAM shared with the desktop apps. It was re-dispatched to resume, with a rule that every python command runs under `ulimit -v` (3 GB for one-offs, 6 GB for the suite), and never loads the ~1M-face `*_hires.glb` files. Put that rule in every mesh-processing brief.

2026-11-24, slice 2 review round 2: Neon re-review of 49eee698 returned REQUEST_CHANGES. The denylist pre-decode guard was bypassed by:
- bufferless or sparse accessors (720 B → 320 MB)
- meshes outside the default scene
- indices hiding a large POSITION count
- byteStride=1
- EXT_mesh_gpu_instancing
- images in a second BIN chunk
- non-list JSON values that crashed the check

Orchestrator decision: replace the denylist with an ALLOWLIST "strict glTF profile", plus decoding in a child process with RLIMIT_AS and a timeout as defence in depth. Basis: on 2026-11-24 all real provider GLBs (TRELLIS.2, TripoSG, Hunyuan3D-2) had 1 scene, 1 mesh, mode 4, no sparse, no bufferless accessor, no byteStride, 1 buffer, 2 chunks, ≤2 images, and extensionsUsed ⊆ {EXT_texture_webp}. TRELLIS textures are WebP. Lesson: for untrusted binary formats, allowlist a profile instead of chasing loader internals.

2026-11-24 provider reliability: the slice 2 allowlist builder failed twice in a row on Pi Mistral. The first was `fetch failed` (deepseek-v4-1-flash). The second was a 429 `backend_out_of_capacity` (glm-5-2), after an uncommitted partial rewrite of model_postprocess.py. It was resumed on mistral/devstral-latest. The user approved Gemini 3.8 Flash (antigravity_2) as the fallback builder.

2026-11-24, slice 2 finished as ccd916c1 (local).
- How it was finished: the Gemini 3.8 Flash builder ended its turn while its test run was backgrounded and never committed. The orchestrator verified the work (787 tests OK in 36 s), shortened the processing summary in CONTEXT.md (the 1000-character limit had failed `context:check`), and committed.
- Real-file isolated postprocess at 240 mm: TRELLIS loco moco 33→1 shells, 290k→156k faces.
- Open question: TripoSG pizza went from 21,163 shells to 1, with 17% of its faces dropped. The suspected cause is unwelded seam vertices being treated as separate shells.
- Open question: the Hunyuan3D-2 pizza came out standing upright (bounds 0.24×0.24×0.016 m).
- Both questions went to Neon review 3.

2026-11-24, Neon review 3 of ccd916c1 returned REQUEST_CHANGES. It found 7 new profile/runner defects:
- a duplicate-bufferView stride bypass and O(N²) views.index
- an uncapped primitive walk
- isolated-runner crash and leak paths, plus an RLIMIT clamp
- undeclared extensions
- NaN and duplicate JSON keys
- bool/float accepted as ints
- unpinned PIL formats

Key real-data findings:
- TripoSG's 21,163 shells come from **non-manifold edges** (22,867 edges of degree ≥4), which trimesh `face_adjacency` ignores. The fix is all-shared-edge connected components. Neon measured 21,163→101 shells and 17%→1.4% faces removed.
- Hunyuan3D-2 pizzas stand upright. Decision: an advisory `orientation_suspect` check only. No auto-levelling, because of the 180° top/bottom ambiguity, and because it would knock genuinely tall dishes over.

The fixes went to Gemini 3.8 Flash (antigravity_2), told to run tests in the foreground and commit before ending its turn.

2026-11-24: slice 2 round 3 is 224d4b34, with 816 tests passing.
- Measured results: TripoSG 21,163→101 shells, 1.4% of faces removed. The Hunyuan pizza reports orientation_suspect=True.
- The Neon final check confirmed 5 of 9 items fully closed, and found 4 HIGH defects:
  - an unvalidated bufferView byteLength raising KeyError/TypeError
  - a RecursionError in the extensions walk on deeply nested JSON
  - `_child_entry` running uncapped when setrlimit fails
  - O(d²) memory in `M·Mᵀ` face adjacency on a high-degree shared edge (a 25k-face fan → 2.33 GiB)
- Those 4 went to the first Neon-medium builder run.
- Follow-up list (not fixed): the polarity of `checks.orientation_suspect` is inverted relative to the field.

2026-11-24: **slice 2 accepted** at 01d227b5.
- Verification: 822 tests OK. The Neon-medium builder fixed the 4 high findings, and the orchestrator read the rlimit code, which now fails closed.
- Deferred follow-ups:
  - the polarity of `checks.orientation_suspect`
  - `force_alloc`/`force_sleep` test hooks carried in the production child payload
- Before building slice 3, the orchestrator found an architecture issue. Production 2.5D is synchronous: Worker → extraction-host container → R2. The model service, by contrast, keeps its job state on local disk and polls in a background thread, which is not durable in an ephemeral Cloudflare Container. A design note was commissioned first: research_notes/wiki/s7-vis-06-slice3-design-2026-11-24.md.

2026-11-24 (evening):
- The TRELLIS max gallery was published as a private artifact: https://claude.ai/artifact/5SkEq9hgG9YsdcZXyveF2W. It shows 28 dishes as the 35k-face mobile GLBs, stored base64 in .txt files because the artifact host serves no .glb, rendered unlit in base colour.
- The HQ-photo Colab test (colab-trellis-hq-test, Drive id 1BNLaDilnowZozNp-ySuqM9e1yMJwbPXL) never produced output. The user stopped it.
- The user judged the TRELLIS results too poor to share. Nothing was shared, and the artifact stays private.
- Takeaways:
  - Single 554 px menu photo → TRELLIS is not demo-grade.
  - Dec 1 is 2.5D per Vivien.
- Process lesson: a Colab copy made from the .ipynb did not keep the L4 accelerator setting, so it got a T4. Set `metadata.colab.gpuType` / `accelerator` in generated notebooks.
