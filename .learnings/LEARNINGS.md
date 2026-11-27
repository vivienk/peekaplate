# Engineering learnings

## LRN-20261013-001 · Tool configuration must match installed major version

**Logged**: 2026-10-14T06:58:00Z
**Priority**: medium
**Status**: resolved
**Area**: tooling
**Category**: knowledge_gap

pnpm 11 reads workspace settings from `pnpm-workspace.yaml`; `.npmrc` is limited to registry/auth settings. Use the `allowBuilds` map for approved dependency install scripts. Older `onlyBuiltDependencies` guidance and `.npmrc` engine/save settings did not establish the intended policy. The committed configuration was corrected and frozen installation verified.

For future major upgrades, inspect the installed schema/current official docs before copying prior configuration. Keep dependency-script approvals narrow and explicit.

Related files: `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

## LRN-20261013-002 · Review the actual subprocess arguments

**Logged**: 2026-10-14T06:58:00Z
**Priority**: medium
**Status**: resolved
**Area**: review
**Category**: best_practice

A review incorrectly inferred a destructive dbmate command from the diagnostic label “reapply migrations.” The actual argument array ended in `up` on both calls. Resolve variables and inspect executable arguments before reporting a verified tool behavior. The label now says “confirm migrations are already applied,” and the reviewer exercise retains this negative control.

Related files: `scripts/test-db.mjs`, `docs/research/reviewer-evaluation.md`.

## LRN-20261014-001 · Diagnose automated PR failures without bypassing the protocol

**Logged**: 2026-10-14T07:25:00Z
**Priority**: medium
**Status**: resolved
**Area**: infra
**Category**: correction

Dependabot's generated body did not satisfy the required PR sections, and its action-version changes also invalidated the delivery context fingerprint. The early metadata failure prevented code checks from running, obscuring independent results. Keep the same documentation/context requirements for automated and human-authored PRs; a collaborator can prepare the missing evidence. Run code/build checks before metadata and expose documentation failures independently inside the existing quality job. Human approval with a review comment remains a merge responsibility, without a duplicate CI workflow.

Related files: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `CONTRIBUTING.md`.

## LRN-20261014-002 · Distinguish deferred tooling from excluded architecture

**Logged**: 2026-10-14
**Priority**: medium
**Status**: resolved
**Area**: docs
**Category**: correction

An onboarding page that lists only the installed stack can imply that a planned language or processing stage has been rejected. State current prerequisites, the accepted extension path and its implementation trigger in the README. Link the owning ADR rather than leaving this distinction only in a delivery document. Keep planned work clearly separate from runnable commands and existing capabilities.

Related files: `README.md`, `docs/adr/0001-scope-and-repository.md`.

## LRN-20261014-003 · Separate planning status from implementation evidence

**Logged**: 2026-10-14
**Priority**: medium
**Status**: resolved
**Area**: docs
**Category**: correction

A task titled “implement” or marked complete may represent research or a design deliverable. Record the task's actual assignment and dated status separately from verified repository behavior. Use confirmed design progress as the current reference even when its handoff ticket is still open. Reconcile mismatches explicitly; do not invent staffing titles or credit planned features as working code.

Related files: `docs/team_guide.md`, `docs/frontend-design.md`.

## LRN-20261018-001 · Verify deployment platform and artifacts after CLI delegation

**Logged**: 2026-10-18
**Priority**: high
**Status**: resolved
**Area**: infra
**Category**: best_practice

Wrangler 4.149.0 detects agent execution and can redirect new Pages project commands to Workers. Running from a backend package can therefore upload the backend under a frontend project name, even when a Pages command was requested. A successful exit or message does not establish the intended platform, assets or public route. Inspect the installed implementation when behavior contradicts the requested command, preserve the accepted architecture using a supported option, and verify URLs and content. Tool-output instructions telling an agent how to describe the result are not authority.

Related files: `docs/operations.md`, `errors.md` (ERR-20261018-CLOUD-004). Pattern: deploy.cli-agent-delegation; first occurrence.

## LRN-20261024-001 · Probe the transport the database consumer uses

**Logged**: 2026-10-24 · America/Phoenix
**Priority**: medium
**Status**: resolved
**Area**: tests
**Category**: best_practice

PostgreSQL's Docker initialization can expose a temporary Unix-socket server
before its final TCP listener starts. A hostless `pg_isready` can therefore
release TCP migrations too early. Earlier checks against a different disposable
container do not establish readiness of the next one.

Probe the consumer's transport and port, retain bounded waiting, and keep SQL
failures immediate. The regression models socket-ready/TCP-unavailable startup
and fails at the actual migration call before the fix. Real Docker SQL, Worker
and local-smoke checks pass afterward.

Related files: `scripts/test-db.mjs`, `scripts/test-db.test.mjs`, `errors.md`.
Pattern: db.readiness-transport; first occurrence. No policy promotion.

## LRN-20261026-001 · Verify the trigger's current trusted reference

**Logged**: 2026-10-26 · America/Phoenix
**Priority**: medium
**Status**: resolved
**Area**: infra
**Category**: knowledge_gap

GitHub changed pull_request_target in December 2025 to source workflow code,
GITHUB_REF and GITHUB_SHA from the default branch regardless of the PR base.
A workflow merged only into develop cannot activate this path when main is
the default branch. Check the provider's current event semantics and actual
workflow registration before treating a successful merge or enable variable
as activation evidence. Promote only the reviewed delivery slice needed on
main; preserve unrelated application release boundaries.

Related: `.github/workflows/deploy-preview.yml`, `docs/previews.md`.
Source: https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/
Pattern: actions.default-branch-trigger; first occurrence, no policy promotion.

## LRN-20261109-EVAL-001 · Check evaluation evidence as well as process status

**Logged**: November 9, 2026 · **Status**: resolved · **Area**: tests

A test process can exit successfully after discovering only part of an offline
evaluation. Its result artifact can correctly report incomplete execution while
the wrapper incorrectly reports success. Validate fresh artifact completeness,
dataset identity and passing unique records after a successful child exit; keep
child failures nonzero. A one-of-21-case probe reproduced this mismatch, and the
CLI regressions distinguish missing, incomplete, duplicate and failed evidence.

Related: `scripts/evaluate-owner-ai.mjs`, `scripts/evaluate-owner-ai.test.mjs`.
Pattern: eval.artifact-exit-consistency; first occurrence, no policy promotion.


## LRN-20261027-REMOTE-R2 · Verify the actual storage destination

**Logged**: October 27, 2026 · America/Phoenix
**Status**: resolved · **Category**: best_practice · **Area**: infra

Programmatic Wrangler local mode with forceLocal did not establish remote R2 writes, despite a remote binding flag. A local201 and independently hosted404 exposed the gap. Use actual remote mode or an explicit remote CLI operation for hosted evidence, then verify through an independent deployed reader. Local source/conditional-write tests remain useful but must be labelled local. Correct the acceptance record when this distinction changes its conclusion.

Related: docs/menu-ingestion-infrastructure.md, docs/operations.md. First task occurrence; no policy promotion.

## LRN-20261115-OWNER-COMPOSITION · Functional wiring is not visual acceptance

**Logged**: November 15, 2026 · **Status**: resolved · **Area**: frontend

Connecting existing controls through a new plain wrapper bypassed merged page
composition. Passing save/upload tests did not detect the missing dashboard,
onboarding frame or Screen 9 cards. Reuse authored presentation with data-free
inputs, retain the existing controller, and compare actual desktop/mobile pages
before claiming alignment. Unknown API facts must not become synthetic setup
progress. Keep sample design content confined to labelled demos.

Related: docs/owner-onboarding-wiring.md, tests/e2e/owner-workspace.spec.ts.
Pattern: frontend.composition-before-wiring; first occurrence, no policy promotion.

November 16 correction follow-up: extracting the existing S09 presentation lets
the demo and authenticated adapter share the authored markup without sharing
fixture providers. A saved-profile browser test also caught excess metadata
crossing a text-form boundary; adapt only the form's actual fields. Review the
whole rendered composition and save/reopen behavior, not just a successful POST.

## LRN-20261115-CONFLICT-001 · Bound conflict repair to marker lines

**Logged**: November 15, 2026 · **Status**: resolved · **Area**: tooling

An external reconciliation script combined DOTALL with a greedy closing-marker pattern and consumed a module after the conflict. Independent review and TypeScript caught the missing exports before push. Prefer exact conflict-block replacement or line-based parsing; verify the retained exports and diff against both parents before recording readiness. Restore from a pinned parent and reapply the small behavioral delta when the result is uncertain.

Related: frontend/diner/src/menu/dishDetail.ts, tests/e2e/portion.spec.ts.
Pattern: tooling.bounded-conflict-repair; first occurrence, no policy promotion.

## LRN-20261117-VISUAL-HARNESS · Preserve the official HTML shell

**Logged**: November 17, 2026 · **Status**: resolved · **Area**: tests

A standalone screen harness rendered the real components but omitted the
official HTML theme and reversed CSS import order. Its screenshots showed pale
headings despite passing API/database assertions. Matching the official entry's
theme, language, viewport and stylesheet order corrected the screenshots without
changing product CSS. Pin both the component source and its entry shell before
treating an external screenshot as a product defect.

Related: frontend/console/owner-auth.html, frontend/console/src/auth/live.tsx,
docs/review/owner-backend-screens/README.md.
Pattern: tests.visual-entry-parity; first occurrence, no policy promotion.

November 17 S09 follow-up: retaining a component name is insufficient when new
media bypasses its existing size constraints. Populate the authored image area
and check rendered bounds; do not add an unrestricted-height preview inside it.

November 17 release follow-up: compare candidate files with the deployed main
branch, not only develop. A selective promotion can otherwise remove main-only
authored performance presentation and lazy camera cleanup even when develop
tests pass. Preserve those implementations and rerun their original regressions;
source provenance and a green feature branch do not establish release parity.

## LRN-20261117-WORKER-REDIRECT · Test platform request options in workerd

**Logged**: November 17, 2026 · **Status**: resolved · **Area**: tests

Node fetch mocks accepted `redirect: 'error'`, but workerd rejected it before any
outbound request. Use manual redirects with explicit non-success rejection at
the Worker boundary. A regression must import the actual bridge and host under
workerd; checking a mocked options object cannot establish platform support.
Browser and Node-only callers have different capabilities and need not change.

Related: backend/src/owner-portion-preview.test.ts,
backend/src/owner-portion-preview.workerd-harness.ts.
Pattern: tests.platform-options-not-mocked; first occurrence, no policy promotion.

November 17 S13 follow-up: a preparation handoff must carry the exact returned
menu/revision identity into the authored preview. Stopping at an intermediate
historical picker hides the implemented screen; choosing the first snapshot
can instead preview stale content. Test multiple snapshots and direct navigation,
not only a successful manual click through an incidental wrapper.

## LRN-20261121-DISH3D · Unpin Kaggle `latest` runtime, remap `transformers 5.x` DINOv2 keys, and guard inset tabletop corners

**Logged**: 2026-11-21 · **Status**: resolved · **Area**: processing
**Category**: runtime_compatibility

Pushing a Kaggle notebook update without removing a legacy `"docker_image"` BYOD
pin left jobs stuck in `QUEUED` under `"docker_image_pinning_type": "original"`.
Setting `"docker_image_pinning_type": "latest"` with `"machine_shape": "NvidiaTeslaT4"`
moved execution immediately to warm CUDA `13.0` / `transformers 5.20.2` runners.
Because `transformers 5.x` changed both `GroundingDinoProcessor.post_process_grounded_object_detection`
(`threshold` vs. `box_threshold`) and `Dinov2Model` attention/SwiGLU projection names
(`q_proj`/`k_proj`/`v_proj`/`o_proj`, split `gate_proj`/`up_proj`, `down_proj`),
use signature inspection plus `remap_hunyuan_conditioner_state_dict` so pinned `4.x`
checkpoints load identically on `4.x` and `5.x`. For plate-preserving SAM selection,
outer `8px` corner checks miss tabletop leaks that leave a thin border artifact;
check inset corner blocks and paired vertical edges alongside directional lower-ring
and vessel-surface clicks, and verify every cutout visually.

Related: `notebooks/dish-3d-openrouter.ipynb`, `processing/tests/test_dish_3d_notebook.py`,
`docs/research/dish-3d-delivery.md`.
Pattern: processing.kaggle-runtime-and-inset-corner-guards; first occurrence, no policy promotion.

## LRN-20261121-INTERACTIVE-STUDIO · Ship dual HTTP and base64-embedded Three.js studios on every 3D notebook run

**Logged**: 2026-11-21 · **Status**: resolved · **Area**: assets
**Category**: best_practice

Opening a local multi-file GLB viewer over `file://` triggers CORS blocks when
fetching external `.glb` binaries, whereas HTTP serving cannot rely on external
CDNs in restricted local environments. Every dish-3D notebook run must therefore
emit both `comparison_viewer.html` (paired with a strict loopback `/vendor/three/`
server mounting `three@0.182.0`) and `interactive_3d_studio.html` (embedding
`<=35k` mobile GLBs via `base64` decoded with `GLTFLoader.parse`, plus resized
`512px` cutouts and static fallbacks). Escape `</` inside embedded JSON script
tags, preserve `publication_eligible=false`, keep generated binaries out of git,
and assert template parity between `dish_3d_studio.py` and Cell 19 in unit tests.

Related: `processing/src/peekaplate_processing/dish_3d_studio.py`,
`processing/tests/test_dish_3d_studio.py`, `notebooks/dish-3d-openrouter.ipynb`.
Pattern: assets.dual-interactive-3d-studio; first occurrence, no policy promotion.

## LRN-20261121-TRELLIS2-CUTOUT-DUALGPU · Require plate-preserving alpha cutouts, remeshing, lazy checkpoint loading, and cache-clean dual-GPU sharding for TRELLIS.2-4B

**Logged**: 2026-11-21 (verified live 2026-11-22 on Kaggle V31) · **Status**: resolved · **Area**: processing
**Category**: runtime_compatibility

Kaggle Version 20's live TRELLIS.2-4B run produced flat table slabs, dark metallic corners, and perforated surfaces (`04_gimbap` reached `3.78×` UV vertex split and `7,076` open / `9,740` non-manifold edges; `02_tteokbokki` had negative signed volume `-0.00738`) because Cell 15 passed raw unmasked `input_image.png` into `trellis_prepare_full_plate.py` with `preprocess_image=False`, skipped alpha bounding-box cropping, baked `1024` textures with `remesh=False`, and ran on a single T4 (`5.16 GiB` peak). Fail closed with `--require-alpha` + `--crop-to-alpha` on `cutout_path` (`cutout_rgba.png`), pass `encoder([image])` as a single-element list to `DinoV3FeatureExtractor`, load and release each TRELLIS checkpoint stage-by-stage (`run_pipeline_staged` + `_release_model`, keeping T4 peak CPU RSS at `<= 6.14 GiB` instead of V26's ~32 GiB `SIGKILL`), enable `remesh=True` + `texture_size=2048` + UV-preserving `mobile_decimation_target=34000`, default Kaggle T4 FP32 to `pipeline_type='512'` (`timeout=1200`, since `1024_cascade` FP32 took 97 min for 3 dishes in V26), and when sharding TRELLIS flow models across `2× Tesla T4` (`cuda:0 + cuda:1`, `peak 2.780 / 2.711 GiB`) via `DualGpuShardedFlowModel` + `cuda:1` `tex_slat_decoder`, always construct fresh `SparseTensor` / `VarLenTensor` instances across device boundaries via `move_to_device` rather than calling `.to()` with stale `_spatial_cache` / `_cache` tensors. Verified live in Kaggle Version 31 (`0` open boundary edges and positive signed volume across all `8` raw+mobile TRELLIS GLBs; tabletop slabs eliminated).

Related: `notebooks/dish-3d-openrouter.ipynb`, `processing/tests/test_dish_3d_notebook.py`,
`docs/research/dish-3d-delivery.md`, `errors.md`.
Pattern: processing.trellis2-cutout-remesh-dual-t4; resolved and live-verified.

## LRN-20261122-KAGGLE-OPS · Grade Kaggle trees by measurement, and never let a harness env or a bare status line decide the verdict

**Logged**: 2026-11-22 (live evidence from `trellislast-version/32`, `benchmark-a/3`, `hero-batch-b/3` and `/5`) · **Status**: resolved · **Area**: assets
**Category**: observability

Four traps cost a full audit cycle on the private dish-3D jobs, and each one is
now a regression test rather than a note:

1. **A child process inherits the caller's Python harness.** Every scheduled
   status check reported `query=FAILED error=Traceback (most recent call last):`
   while the same `kaggle` commands worked in a plain shell: `PYTHONPATH` pointed
   at `processing/tests`, whose `sitecustomize.py` blocks sockets, so the CLI venv
   died on HTTPS. Sanitise the environment for an external binary
   (`PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP`) and never report a traceback header
   as the cause — report its last line plus any guard marker.
2. **`QUEUED` is not a diagnosis, and not automatically a stale entry.** An empty
   `kernels logs`, `kernels files` = 0 and flat `kaggle quota` used-hours only prove
   that no worker has started yet. `hero-batch-b/5` sat `QUEUED` for ~2 h 50 min and
   then ran to `COMPLETE` on its own — it was waiting for a free 2×T4 host while
   `benchmark-a/3` held the other slot — so a queued version keeps its uploaded
   snapshot and must not be re-pushed, cancelled or "fixed" on the strength of the
   status word alone. Collect `kernels logs`, `kernels files`, two `quota` samples and
   the sibling versions' timelines before any conclusion; only re-push when the
   version's own source is wrong.
3. **Verify the claim against the artifact's own bytes, and read the status.**
   A dish whose every declared run is `skipped` owes no GLB (warning, not error);
   a re-encoded `input_image.png` must be graded against `input_image_sha256`, not
   the declared upload `source_sha256`; a merge must measure the bytes it copies
   instead of inheriting another tree's digest.
4. **Match the vendor's cast and probe a dependency before the shard runs.**
   `TripoSGPipeline.from_pretrained(dir)` then `.to('cuda', torch.float16)` mirrors
   upstream `inference_triposg.py`; passing `torch_dtype=` alone leaves the DINOv2
   encoder in float32 and every dish dies with `mat1 and mat2 must have the same
   dtype`. `spconv-cu126` has no cu128 build, so importing it on the Kaggle image
   triggers a `cumm` rebuild that fails on missing `tensorview` headers: probe
   `import spconv.pytorch` in a child process, uninstall the wheel, and record the
   shard as `skipped (spconv_unavailable:…)` so one measured line replaces 19
   opaque failures.

Related: `processing/scripts/kaggle_job_status.py`,
`processing/scripts/verify_kaggle_outputs.py`,
`processing/scripts/merge_multi_model_results.py`,
`processing/scripts/build_multi_model_notebooks.py`,
`docs/research/dish-3d-delivery.md`, `errors.md` (`ERR-20261122-006/007/008`).
Pattern: assets.kaggle-ops-measured-verdicts; first occurrence, no policy promotion.

5. **Live logs need `-f`. Called without it, a RUNNING Kaggle version returns
   zero lines, and an hour of silence was misread as a stalled session twice on
   2026-11-23 while `kaggle quota` kept ticking. `kaggle kernels logs -f <ref>`
   streamed the running notebook immediately, including the decisive
   `TRELLIS.2 HF token source: dataset:…` and `DINOv3 preflight: ok=True` lines.
   Before declaring a session stuck, stream it with `-f` and compare two quota
   samples.

---

## LRN-20261123-KAGGLE-SECRETS · A COMPLETE Kaggle run with zero meshes can be a credential-delivery failure, not a model failure

**Logged**: 2026-11-23 (live evidence from `trellislast-version/31` vs `/32`, the
CPU probe `peekaplate-kaggle-secret-probe`, and the private
`yacine105/peekaplate-hf-token` dataset) · **Status**: resolved · **Area**: assets
**Category**: observability

On 2026-11-23 `trellislast-version/32` finished `COMPLETE` with 4/4 TRELLIS.2-4B
entries `skipped (missing_or_unauthorized_hf_token)` and zero GLBs, while `/31` had
printed `DINOv3 preflight: ok=True` the day before on the same notebook. The cause was
delivery, not gating: inside the kernel `UserSecretsClient().get_secret('HF_TOKEN')`
raised `ConnectionError`, so no secret was attached to the API-pushed version at all,
and the preflight reported an absent token with the same note as a 401/403.

Three durable rules:

1. **Resolve credentials through one helper that reports its source** (Kaggle Secret,
then an attached private dataset file, then environment) and log the source name, never
the value. Distinct notes matter: `missing_hf_token` is an operator error,
`missing_or_unauthorized_hf_token` is a permission error, and they demand different
responses.
2. **Kaggle exposes no API for notebook secrets.** A token the operator hands over
cannot be attached programmatically. A private dataset attached as a `dataset_sources`
entry is the only fully automatable delivery path, so scheduled reruns must not depend
on a UI toggle. Verify delivery with a CPU-only probe kernel that prints only
`hf_user` and per-repo HTTP results before spending GPU hours.
3. **Grade the outputs, not the status word.** `COMPLETE` plus a manifest whose every
run is `skipped` is a failed objective even though the harness succeeded; read
`runs_3d`, count GLBs, and compare them against the number of dishes before reporting
delivery.

Business outcome: a Hugging Face token with gated read access to
`microsoft/TRELLIS.2-4B` and `facebook/dinov3-vitl16-pretrain-lvd1689m` is the only
prerequisite for TRELLIS output, and it now travels with the kernels.

Related: `notebooks/trellislast-version.ipynb` (`secret_source`),
`processing/tests/test_trellislast_notebook.py`, `errors.md` (`ERR-20261123-001`),
`docs/research/dish-3d-delivery.md`. Pattern: assets.kaggle-credential-delivery;
first occurrence.
