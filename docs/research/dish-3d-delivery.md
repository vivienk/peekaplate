# Dish photo to published portion preview

Research baseline: `research/3d-dish-delivery` at `c54e2fad2a7748ce180fd7b72af268be2db20486`. This proposal covers the owner-to-diner handoff, evidence checks and mobile presentation. The proposal includes a private TRELLIS comparison, a capture-based publication path and a Beam pilot.

## What to deliver first

Exercise the existing **2.5D portion preview** on staging and label it accordingly in the diner and demo notes. The current ticket permits this outcome if the approved cutout tilts and its hash and revision can be traced from a real owner upload to the returned diner link on desktop and a physical phone. The task record is Open and had no comments, checklists or subtasks when read. [Complete and accurately label the photo-to-portion 3D flow](https://app.clickup.com/t/86bd5m6q0)

For captured 3D, start with one authorized multi-view capture and prove an approved GLB can pass through the same publication lifecycle. Use a deterministic GLB fixture to test wiring before requiring a reconstruction run. Chargeable single-image generation can produce a private candidate, but human approval alone cannot establish evidence for unseen food surfaces. [ADR 0004](../adr/0004-visual-tiers.md)

## Your Kaggle pipeline

**Notebook references (2026-11-22).** The kernel previously published as `yacine105/notebooke3207ed4f5` was renamed to `yacine105/trellislast-version`, and Kaggle preserved its version numbers, so the historical `/20`, `/31` and `/32` references in this page resolve against the renamed kernel (`/31` re-checked `KernelWorkerStatus.COMPLETE` on 2026-11-22). The multi-model benchmarks are separate private kernels: `yacine105/peekaplate-dish-3d-multi-model-benchmark-a` (MoGe-2, TripoSG, Hunyuan3D-2, Hi3DGen) and `yacine105/peekaplate-dish-3d-trellis2-hero-batch-b` (TRELLIS.2-4B hero batch).

I inspected the public notebook source on November 20, 2026. Cells 7 and 9 pass **one** full-plate photo through margin padding (8%, with an optional reviewed plate-and-food mask) to the 512-resolution Microsoft TRELLIS.2-4B runner. The runner targets one plate-and-food mesh. Cells 11 and 13 render the resulting mesh in six lighting/material modes at eight angles and re-export GLB variants from saved mesh and material data. Those 48 images come **after** generation. There is no novel-view image generator feeding the mesh. The default export targets 100,000 faces and a 1024-pixel texture. [Public notebook](https://www.kaggle.com/code/yacine105/trellislast-version) · [Kaggle source export](https://api.kaggle.com/v1/kernels/pull/yacine105/trellislast-version)

**Port the input and export contract first.** Keep the full rim, optional reviewed alpha, explicit seed/settings, raw GLB and separate optimized exports. Compare the raw and optimized model side by side against the source. Extract a worker taking one immutable input manifest and returning output sizes and hashes. Prebuild native dependencies and pin weight revisions. Start the serverless pilot on a supported single-GPU configuration and measure the complete export. The notebook's experimental two-T4 setup puts generation/export on GPU 0 and feature extraction on GPU 1, with CPU offloading and compatibility kernels. Keep that implementation only if it wins a measured comparison. An upstream single-GPU worker needs an explicit decision about masking and dependency loading. [Notebook](https://www.kaggle.com/code/yacine105/trellislast-version) · [Pinned upstream source used by the notebook](https://github.com/microsoft/TRELLIS.2/tree/75fbf0183001ed9876c8dbb35de6b68552ee08bd)

The retrieved notebook contains no saved cell outputs. Its verification notes report CPU checks and leave full GPU inference, peak VRAM, GLB export and preview rendering unverified. A reproducible first milestone is one rights-cleared full-plate input, a successful run record, the source and GLB hashes, a mesh that loads on a phone, and an explicit private-experiment label. [Notebook verification notes](https://www.kaggle.com/code/yacine105/trellislast-version)

## What exists at the pinned commit

| Stage | Evidence in the branch |
| --- | --- |
| S09 upload and process | The authenticated [owner portion POST](../../backend/src/owner-menu-routes.ts#L300) awaits `processPrivateDishPhoto`. The Worker reads the exact saved private photo, verifies bytes, sends them to the [portion processor](../../processing/src/peekaplate_processing/portion_service.py) and validates the returned foreground/background layers. Visual approval binds the source and portion manifest hashes separately from dish verification. [Owner preview implementation](../../backend/src/owner-portion-preview.ts) |
| S10 verified dish → S13 preparation | [`approvedOwnerPortion`](../../backend/src/owner-prepare.ts#L115) exports the approved private portion by venue, draft, photo and source hash. The [producer validator](../../backend/src/bundle-producer/approved-portions.ts) verifies the approval and payloads and binds URLs and manifests to the published dish/revision. The prepared asset path reads the published snapshot, preserving the earlier approved portion while a replacement is edited. [S09–S13 handoff](../screen9-portion-publish.md) |
| Published View Portion | [`PublicPortionSchema`](../../packages/contracts/src/portion.ts#L84) carries reviewed image layers and optional photo-bound plate evidence. The [published menu mapper](../../frontend/diner/src/menu/published.ts) passes the image portion to the diner. [`portionAssets.ts`](../../frontend/diner/src/menu/portionAssets.ts) verifies layer bytes; [`portionRenderer.ts`](../../frontend/diner/src/menu/portionRenderer.ts) renders CSS movement. [`portionPreview.ts`](../../frontend/diner/src/menu/portionPreview.ts#L391) handles drag, touch and keyboard input. |
| Camera and local model demo | [`portionAR.ts`](../../frontend/diner/src/menu/portionAR.ts#L2) uses Three.js and GLTFLoader behind the camera action. [The diner pins Three.js 0.182.0](../../frontend/diner/package.json), whereas ADR 0004 specifies 0.183.x for the planned shared viewer. The [DEV-only model viewer](../../frontend/diner/src/menu/portion3d.ts#L17) imports Google model-viewer 4.4.0 and supplies the camera portal's model URL through `local3d?.getModelUrl()`. The public path supplies the cutout. |
| Private model generation | [`generate_model.py`](../../processing/src/peekaplate_processing/generate_model.py), [`tripo.py`](../../processing/src/peekaplate_processing/tripo.py) and [`model_service.py`](../../processing/src/peekaplate_processing/model_service.py) implement Tripo preparation, polling, bounded download and private review from a registered review bundle. This lane has its own job API and disk state. It ends before owner publication. The tracked-tree search at the pinned HEAD found no TRELLIS or Babylon source/config/dependency references in the inspected tree. [Tripo handoff](../tripo-cutout-to-3d.md) |

### First missing stage for 3D

The first missing connection is **authenticated saved photo → private model job and approved artifact**. S09's route at [`owner-menu-routes.ts:300`](../../backend/src/owner-menu-routes.ts#L300) calls the 2.5D processor and returns a layer review. It has no model job initiation or approval. The private Tripo service expects a pre-registered review bundle. Further downstream S13 exports layers only, and the production diner has no approved GLB reference to render. Changing browser engines cannot supply this handoff.

Start the implementation with a failing owner-route regression beside [`owner-portion-preview.test.ts`](../../backend/src/owner-portion-preview.test.ts), exercising the real authenticated route with a deterministic worker double. An authorized request for the exact saved photo should return a persistent job ID and queued status. Repeating it with the same command identity should return the same ID. Complete it with a known GLB hash, then replace the photo before approval and assert that approval fails and S13 cannot select the stale output. Add the positive path and forgery cases beside [`owner-prepare.test.ts`](../../backend/src/owner-prepare.test.ts) and the [existing exact-revision producer test](../../backend/src/bundle-producer/produce.test.ts#L675). This is a source-level gap, not an observed first failure in the current hosted 2.5D path. During staging acceptance, record the first actual failed request or view state before changing code.

## Proposed owner and publication flow

1. **Enqueue from the saved photo or capture set.** Reuse owner authorization and the existing draft/photo scope. Resolve tenant, photo object and source hash on the server. For a multi-view set, record an ordered manifest of verified member hashes and the selected menu photo. Keep originals and generated candidates private. In a transaction, bind the job to the source identities and expected revision/version and store durable pending work with its command identity. Return 202 and a status endpoint that performs reads only. Reused command IDs with a different payload conflict. [ADR 0002](../adr/0002-selective-event-sourcing.md) · [ADR 0005](../adr/0005-tenancy-and-privacy.md)
2. **Process outside the HTTP request.** Lease pending jobs, claim with a lease token and persist attempts and any external task ID before resuming polling. Use provider idempotency where supported. If a submission outcome is unknown and cannot be reconciled, stop for review before spending on another submission. Bound retry count, processing time, input pixels, decoded geometry/texture sizes and output bytes. Recheck source eligibility at completion. Store the private object under a create-only identity, verify it by readback, then commit the terminal state with the lease token or expected version. Recover expired leases and garbage-collect orphan objects after a grace period. Replay produces no jobs. [ADR 0002](../adr/0002-selective-event-sourcing.md)
3. **Review evidence and approve exact bytes.** Record tenant, dish/draft, photo or capture-set identity and member hashes, method/version/settings, output SHA-256 and size, allowed view range, rights and reviewer decision. Validate self-contained GLB structure, declared sizes, supported extensions and finite bounded geometry. Require captured texture provenance and inspect the proposed view range against source frames. Preserve gaps or restrict rotation when coverage is inadequate. Require explicit visual approval plus S10 dish/photo verification. A stale, cross-tenant, superseded, rejected or corrupt candidate cannot advance. [ADR 0004](../adr/0004-visual-tiers.md) · [ADR 0005](../adr/0005-tenancy-and-privacy.md)
4. **Prepare and publish on S13.** Add an optional, versioned model descriptor alongside the existing T1 portion. Include exact dish/revision, HTTPS URL, SHA-256, byte count, format and view constraints. Keep provenance and reviewer identity private. Reuse the established producer and content/asset approval path. Atomically check current revision, rights and approvals when publishing. Serve verified immutable bytes through the published asset path with sufficient MIME and CORS headers. Check snapshot membership and withdrawal before serving new requests. A draft replacement leaves the previous approved snapshot readable until superseded or withdrawn. Preserve actual exposure revision references. [Approved portion producer](../../backend/src/bundle-producer/approved-portions.ts) · [ADR 0002](../adr/0002-selective-event-sourcing.md)

## Capture and reconstruction baseline

Capture the same undisturbed dish from overlapping angles at two elevations, under even light, with a fixed lens/zoom and a measured plate reference if physical placement is required. Record a sharp hero frame for T0/T1. Keep hands and utensils out of the frame and capture sides that diners will be allowed to inspect. Start with a textured, matte dish and repeat on a glossy or low-texture dish to expose coverage failures. Store only authorized captures and strip incidental metadata from public renditions.

Use COLMAP as a baseline for feature matching and registered cameras via structure from motion, then dense multi-view stereo, fusion and meshing. Crop to the observed dish and plate, simplify the mesh, bake textures from the registered photos and export a self-contained GLB plus the existing approved cutout. Review with held-out source angles and record registration/coverage, missing surfaces and reviewer disposition. Prefer restricted orbit or 2.5D when coverage cannot support a faithful mesh. A serving count sets the label. Only separate approved, capture-bound calibration can authorize measured tracked placement. [COLMAP tutorial](https://colmap.github.io/tutorial.html) · [Plate calibration contract](../../packages/contracts/src/portion.ts)

## Mobile delivery and renderer choice

Keep the existing Three.js boundary for a first captured-mesh slice. Use one lazy viewer behind the ADR's `mount / update / dispose` interface. Parse only verified bytes after deliberate activation. Show usable photo/text immediately, keep the approved 2.5D view during loading, and retain it on hash mismatch, timeout, decoder failure, loss of graphics context or unavailable WebGL. Keep one active canvas, cap backing resolution, pause when offscreen, and release render resources, object URLs and camera streams on exit or dish changes. Support keyboard, touch gestures that preserve page scrolling, reduced motion and reset. Camera permission follows its own deliberate action and denial returns to the usable preview. [ADR 0004](../adr/0004-visual-tiers.md) · [Diner frontend design](../frontend-design.md)

Babylon.js can load GLB through its glTF plugin, provides an orbit camera and has documented context-loss handling. If a measured renderer evaluation is requested, try a lazy Babylon engine and glTF loader on the same verified GLB and bounded orbit, compare with Three.js on the same phones, and document any departure from ADR 0004 before adoption. Standard GLB with embedded textures is the simplest first payload. Compare optional KTX2 compression with actual decoder overhead and use pinned, controlled decoder assets if adopted. Benchmark compressed and decoded bytes, texture memory, p75 tap-to-first-render and p95 frame time. Enforce the existing 150 KB gzip initial JS and 400 KB incremental T1 limits and set a measured 3D-specific budget before enabling it. Expand the [bundle guard](../../scripts/check-bundle.mjs) if Babylon is chosen, since it currently patterns for other renderer packages. [Babylon glTF loader](https://doc.babylonjs.com/features/featuresDeepDive/importers/glTF/) · [Babylon ES modules and orbit camera](https://doc.babylonjs.com/setup/frameworkPackages/es6Support/treeShaking/usingPureImports/) · [Babylon scene optimization](https://doc.babylonjs.com/features/featuresDeepDive/scene/optimize_your_scene/)

## Acceptance evidence to collect

| Check | Evidence |
| --- | --- |
| Real upload and approval | Record photo SHA-256, private review asset SHA-256 and verified dish revision. Reload S09 to verify the approved preview persists. Save the published bundle identity, returned diner route, target dish/revision and exact served asset size and SHA-256. For 2.5D compare foreground and background bytes. For a model additionally compare the served GLB and orbit it. |
| Desktop and physical phone | Open the returned S13 link independently on both through a secure reachable origin. Capture browser/OS/device, menu revision, visible state, served hash, and a successful bounded drag or keyboard tilt. For the 2.5D path verify the UI and demo notes name it **2.5D portion preview** and the photo-based view visibly tilts. Emulation and mocked routes cover wiring only. |
| Replacement | Approve A, publish it, replace it with B and confirm A's private review cannot be applied to B. Verify the published A snapshot still reads correctly while B is pending. Approve, verify and republish B, then verify its new revision and hash from the returned link. Try stale completion or approval against the replacement. |
| Camera, count and scale | Deny camera and return to the same preview. Verify the approximate label for ordinary camera placement and the absence of camera requests before the explicit camera action. Test `Serves 2 people` and unknown count. Two people on a 28 cm plate keeps the same footprint. Validate measured tracked AR separately on supported hardware if claiming it. |
| Failure and regression | Record first failing stage, response/UI state and exact revision, and use a targeted regression test. Exercise failed processing and wrong-hash delivery, and verify the original photo or approved 2.5D remains usable. The existing [published camera browser spec](../../tests/e2e/portion-published.spec.ts) intercepts assets and camera behavior. Extend it for truthful labeling and visible tilt, and keep a staging run for the actual owner-to-diner chain. |

## Which generation stages to keep

| Release | Verified input and output | Where it fits |
| --- | --- | --- |
| Microsoft TRELLIS-image-large | One image, or several image conditions via `run_multi_image`. Upstream shows textured GLB export and documents a 16 GB NVIDIA GPU minimum. | Compare one captured view with several real views of the same plating. Its sampler combines image conditions without camera calibration. The result is still synthesized. [Weights](https://huggingface.co/microsoft/TRELLIS-image-large) · [Multi-image example](https://github.com/microsoft/TRELLIS/blob/main/example_multi_image.py) · [Requirements and export](https://github.com/microsoft/TRELLIS) |
| Microsoft TRELLIS.2-4B | The released image pipeline accepts one image and produces a textured mesh with PBR materials. The model card specifies at least 24 GB of NVIDIA GPU memory. | Run privately on the same reviewed cutout as Tripo. Microsoft's H100 timings cover inference. Include model loading, mesh export, validation and upload when measuring a restaurant job. [Model card](https://huggingface.co/microsoft/TRELLIS.2-4B) · [GLB example](https://github.com/microsoft/TRELLIS.2/blob/main/example.py) |

**Image-stage recommendation.** Remove generated viewpoints from the diner workflow. For one photo, segment or manually mask it, preserve the captured foreground pixels and review the mask edges. For a model, capture the same stationary plate from overlapping angles at more than one elevation, in diffuse, consistent light. Reserve real photos for comparison after reconstruction. Shiny sauces, steam and translucent food are good rejection tests. If the reviewer cannot verify the visible sides, restrict the view to supported coverage or keep the photo and cutout. [COLMAP capture and reconstruction guidance](https://colmap.github.io/tutorial.html) · [Visual tiers](../adr/0004-visual-tiers.md)

Before running TRELLIS.2 commercially, inspect the actual worker image. Microsoft's MIT checkpoint references gated Meta DINOv3 and BRIA RMBG-2.0 with separate terms. Supplying an RGBA cutout can bypass masking during preprocessing while the default pipeline still initializes the background remover. Resolve licensing or explicitly remove that dependency from initialization and test it. Record the notebook revision, checkpoint revision and worker image alongside the source and output hashes in each private comparison. [Released config](https://huggingface.co/microsoft/TRELLIS.2-4B/blob/main/pipeline.json) · [Loader](https://github.com/microsoft/TRELLIS.2/blob/main/trellis2/pipelines/trellis2_image_to_3d.py) · [BRIA terms](https://huggingface.co/briaai/RMBG-2.0) · [DINOv3 terms](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m)

## Free image generation in Google AI Studio

Checked November 20, 2026. **For a free manual experiment, use Nano Banana 2 in the Gemini app.** Google explicitly includes image generation for eligible accounts without a Google AI plan. Sign in, ask it to create a fictional plated dish, and download the image for a private TRELLIS test. Usage limits can change. [Gemini app feature availability](https://support.google.com/gemini/answer/16275805) · [Generate and download images](https://support.google.com/gemini/answer/14286560)

| Where you run it | What Google documents |
| --- | --- |
| AI Studio Playground | Free accounts get basic model access. I found no documented free image-generation entitlement for the Playground. Google explicitly requires a paid API key for Nano Banana 2 in Studio and lists Nano Banana 2.1 under its Pro plan. Selecting a paid key makes requests on that key billable. [Studio plans](https://aistudio.google.com/docs/google-ai-plans) · [Nano Banana 2 developer announcement](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-nano-banana-2/) · [Studio billing FAQ](https://aistudio.google.com/docs/billing#is-AI-Studio-free) |
| Kaggle or Beam calling the Gemini Developer API | Google lists no free API tier for the Nano Banana image models, including 2 Lite. For a paid experiment, Nano Banana 2 Lite lists approximately $0.0336 per standard 1K output image plus input. Google retired the Imagen 4 API endpoints in August 2026. [API pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite-image) · [Imagen deprecations](https://aistudio.google.com/docs/deprecations#imagen-deprecated-models) |
| Your own Hugging Face checkpoint | I found no documented way to upload arbitrary diffusion weights to the free Studio Playground. To test a downloadable model, run it in your Kaggle GPU notebook subject to its GPU quota and the model license. Google documents custom-weight deployment separately in Model Garden. [Studio model catalog](https://ai.google.dev/gemini-api/docs/models) · [Custom-weight deployment](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/open-models/deploy-model-garden) |

For PeekaPlate, a fictional dish is enough to check whether the notebook generates a GLB that opens on a phone. To assess a real dish’s fidelity, keep the owner's original photo and compare the model against additional captured views. A generated side view cannot verify ingredients or portion size. This access check used public documentation. No account quota, billing configuration or live generation was tested. [Visual tiers](../adr/0004-visual-tiers.md)

## Serverless GPU decision

**Pilot Beam first.** Run a scale-to-zero task queue with one job per GPU and a capped worker count. Submit a private capture-manifest reference. Treat a signed callback as a wake-up signal, then reconcile job status and verify project-owned output bytes. Set an explicit timeout, retry policy and queue TTL. Beam's queue can expire pending work, and its output URLs expire. Store durable jobs and published assets in PeekaPlate. Confirm card availability and storage charges in the intended workspace. [Beam task queues](https://docs.beam.cloud/v2/task-queue/running-tasks) · [Retry behavior](https://docs.beam.cloud/v2/topics/timeouts-and-retries) · [Outputs](https://docs.beam.cloud/v2/data/output) · [GPU availability](https://docs.beam.cloud/v2/environment/gpu)

**Compare Runpod Flex** using the same container, captures and quality gate. Its asynchronous API returns a job ID and retains successful async results for 30 minutes. Persist artifacts before acknowledging success. Flex scales down and bills initialization and idle tail. Test a 48 GB card if the full reconstruction or TRELLIS export exceeds a 24 GB card. [Runpod operations](https://docs.runpod.io/serverless/endpoints/operation-reference) · [Billing](https://docs.runpod.io/serverless/pricing)

Illustrative USD compute per accepted asset, using 600 seconds of work and 80 accepted results per 100 attempts. Beam's RTX 4090 example with two physical CPU cores and 16 GiB RAM totals $0.000490/s. At 610 billed seconds that yields **$0.37** per accepted asset. Runpod Flex RTX 4090 at $1.34/hr and 625 billed seconds yields **$0.29**. The extra seconds are assumed startup or idle time. These estimates exclude transfer, storage and human review. A different acceptance rate can reverse the ranking. [Beam serverless rates](https://www.beam.cloud/pricing) · [Runpod serverless rates](https://www.runpod.io/product/serverless)

Use a paired pilot of 12 rights-cleared capture sets, including shiny, low-texture and richly textured dishes. Repeat cold, warm and burst runs on both providers, record peak VRAM, queue-to-candidate p50/p95, export failures, bytes served and accepted count. Score against held-out real views before revealing the provider. Include retries, rejected jobs, storage, transfer and review in total cost divided by distinct approved revisions. Select the cheapest provider that meets fidelity, phone performance and turnaround targets agreed before the pilot.

## Live Kaggle T4 ×2 Multi-Model Comparison (2026-11-21)

Updated private experiment artifact: [`dish-3d-openrouter.ipynb`](../../notebooks/dish-3d-openrouter.ipynb) with offline verification suite [`test_dish_3d_notebook.py`](../../processing/tests/test_dish_3d_notebook.py) on [Public notebook `yacine105/trellislast-version`](https://www.kaggle.com/code/yacine105/trellislast-version).

### Architecture & Provenance Design
- **Image stage (2 distinct models per run):**
  - Primary (`image_source: "openrouter"`): Calls OpenRouter `/api/v1/chat/completions` (`modalities: ["image", "text"]`) with `google/gemini-3.1-flash-lite-image` and `google/gemini-3.1-flash-image` and bounded `429` retry handling. Live probing against the local key (`$0` OpenRouter balance, free-tier Google AI Studio BYOK `limit: 0`) returned HTTP `429` on all 3 attempts per model, and zero `:free` image models exist on OpenRouter.
  - Open-weights fallback (`image_source: "kaggle-open-weights-fallback"`): When `OPENROUTER_API_KEY` is missing or quota-blocked, Cell 5 launches two isolated `StableDiffusionPipeline` `fp16` subprocesses in parallel across `2× Tesla T4` using pinned, ungated checkpoints (`stabilityai/sd-turbo` @ `b261bac6fd2cf515557d5d0707481eafa0485ec2` on GPU 0; `Lykon/dreamshaper-8` @ `a7e52b98680b1ba8ff7bce97c7f9f2e2e5337917` on GPU 1; `safety_checker=None`, without `upcast_vae()`). Fallback results never masquerade as OpenRouter/Google images.
- **Dual-backend `T4 ×2` 3D stage:**
  - **Ungated parallel backends (always run):** `TripoSR` (`VAST-AI-Research/TripoSR` @ `107cefdc244c39106fa830359024f6a2f1c78871`, `stabilityai/TripoSR` @ `5b521936b01fbe1890f6f9baed0254ab6351c04a`, `facebook/dino-vitb16` @ `f205d5d8e640a89a2b8ef0369670dfc37cc07fc2`) produces **vertex-colored** GLBs (`appearance: "vertex_color"`) via CPU marching cubes (`skimage.measure.marching_cubes`) and a strict 1:1 `transformers` 4.x/5.x `ViTModel` `state_dict` key remap; `Hunyuan3D-2mini` (`Tencent/Hunyuan3D-2` @ `f8db63096c8282cb27354314d896feba5ba6ff8a`, `tencent/Hunyuan3D-2mini` @ `f90a0f7df7d5e6f71109cf333f6a95a0ae3194a6`, subfolder `hunyuan3d-dit-v2-mini-fast`) produces **geometry-only** GLBs (`appearance: "geometry_only"`) via `mc_algo="mc"` with zero custom `diso` build.
  - **Gated `TRELLIS.2-4B` (`microsoft/TRELLIS.2` @ `75fbf0183001ed9876c8dbb35de6b68552ee08bd`, `microsoft/TRELLIS.2-4B` @ `af44b45f2e35a493886929c6d786e563ec68364d`):** Preflight-checks `HF_TOKEN` authorization on `facebook/dinov3-vitl16-pretrain-lvd1689m` (`ea8dc2863c51be0a264bab82070e3e8836b02d51`) `config.json` **before** any ~20-minute CUDA build or downloads. Removes the broken `flex_gemm` Python fallback, treats optional `nvdiffrec_render` as non-fatal, uses `points.trunc().long()` for nearest voxel sampling in `trellis_native_compat.py`, seeds pinned `model_revision` + `DINOV3_REVISION`, and bounds preparation/runner execution with process-group timeouts. Live `TRELLIS.2-4B` inference on Kaggle remains unverified without an approved `HF_TOKEN`.

### Measured Kaggle `T4 ×2` Results (Version 6 `COMPLETE` in ~364s container run)

Environment: `2× Tesla T4 (14.56 GiB, cc=[7, 5])`, Python `3.13.15`, PyTorch `2.11.0+cu128`, CUDA `12.8`, runtime package pinning via `kaggle_constraints.txt`, and subprocess-isolated `rembg[cpu]==2.0.67` (`u2net`).

- **Fallback dish inputs generated (zero CLIP `> 77` truncation warnings):**
  - `sd-turbo/input_image.png`: `512×512`, `30.43s` (`Tesla T4`), `510,051` B, `sha256` `30a3b6adcddb36699938e6ea7b28d0365148f257b9a11c505059d4a08cef6d0f` (`cutout_rgba.png` `395,068` B, `sha256` `d435cfc3b90fccb03bab99ecb6372fc01083ce84e2e17c1123ef94b76354d0a6`).
  - `dreamshaper-8/input_image.png`: `512×512`, `34.56s` (`Tesla T4`), `410,776` B, `sha256` `3a2c0852cb1a176e7baa9aba713afd564bb5d424ebbfba41a285f9ad76c13759` (`cutout_rgba.png` `200,972` B, `sha256` `54deb17750898f5798183a6ee08cf76ebbf3659d2a764c1f9518356a35c96068`).

| Output Path | Backend | Appearance | Vertices | Faces | Bytes | Elapsed / Peak VRAM | Verified SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sd-turbo/triposr.glb` | `TripoSR` (`cuda:0`) | `vertex_color` | `33,414` | `66,802` | `1,337,236` | `9.02s` / `2.075 GiB` | `837667ac5309a6bd2bb92fe2bac2057f76b0cb556fed54446ade808fc40c67ce` |
| `dreamshaper-8/triposr.glb` | `TripoSR` (`cuda:1`) | `vertex_color` | `30,019` | `60,010` | `1,201,416` | `9.00s` / `2.075 GiB` | `995a62fc7f57294142ac5012d1d6e4194aab6eb4a96845351e3f0f343d2491f0` |
| `sd-turbo/hunyuan3d_2mini.glb` | `Hunyuan3D-2mini` (`cuda:0`) | `geometry_only` | `302,832` | `605,518` | `10,900,988` | `72.27s` / `4.08 GiB` | `2abfff0c1bbae13bcdeb6db9a2d6f066c1b9d005650368b68b4f2bd80c996b7b` |
| `dreamshaper-8/hunyuan3d_2mini.glb` | `Hunyuan3D-2mini` (`cuda:1`) | `geometry_only` | `559,137` | `1,119,764` | `20,147,604` | `72.06s` / `4.08 GiB` | `f38ad8bd8992f9160ecfe75fe2b510a376d807cda71dd588f5a5d89d12616ec0` |

- **Empirical foreground-cutout finding:** Visual inspection confirmed `sd-turbo/cutout_rgba.png` preserved the entire matte ivory plate and food, whereas `rembg` (`u2net`) feathered out the outer white rim of `dreamshaper-8/input_image.png` to isolate only the food/parsley ring. This empirically reinforces why [`trellis_prepare_full_plate.py`](../../notebooks/dish-3d-openrouter.ipynb) (`automatic_background_removal: False`) and [ADR 0004](../adr/0004-visual-tiers.md) forbid unreviewed automatic cutout cropping in production.
- **Post-review update (Version 7):** Applied independent Antigravity review P2/P3 fixes (seeded `TRELLIS_MODEL_REVISION` + `DINOV3_REVISION`, bounded process-group timeouts, explicit `publication_eligible: False` in `manifest.json`), verified by all offline unit checks (`test_dish_3d_notebook.py`); Version 7 was pushed to Kaggle (`QUEUED` at handoff).
- **Private-experiment boundary ([ADR 0004](../adr/0004-visual-tiers.md)):** Fictional dish comparisons (`publication_eligible: false`) remain strictly private experiments and must never enter PeekaPlate menu publication or captured-food evidence.

## 4-Dish Real-Photo Benchmark & Notebook Upgrades (2026-11-21)

Upgraded [`dish-3d-openrouter.ipynb`](../../notebooks/dish-3d-openrouter.ipynb) and [`test_dish_3d_notebook.py`](../../processing/tests/test_dish_3d_notebook.py) to benchmark 4 user-supplied dish photos end-to-end in a private Kaggle run ([`yacine105/trellislast-version`](https://www.kaggle.com/code/yacine105/trellislast-version), `is_private: true`) backed by a private dataset (`yacine105/peekaplate-dish-test-photos`). Neither the photos nor any benchmark GLBs are committed to this repository.

### Kaggle Queue Resolution & Pipeline Upgrades
- **Queue resolution:** Cancelled stalled Version 7 and queued Version 8 (`NvidiaTeslaT4` queue), removed the hardcoded BYOD `docker_image` SHA pin from submission metadata, and pushed private Version 9 with `"machine_shape": "NvidiaTeslaP100"`. Kaggle emitted `'NvidiaTeslaP100' is retired. Sessions run on the default GPU (NvidiaTeslaT4) instead.` and scheduled Version 9 (`GPU T4 ×2`) immediately (`RUNNING` -> `COMPLETE` in `442.8s` runtime log).
- **Stage 0 & GPU flexibility:** Added `discover_user_dish_images` (`MAX_USER_DISHES = 4`) before OpenRouter/open-weights generation, flexible `GPU_COUNT`/`MAX_GPU_WORKERS` pooling with `queue.Queue` per-GPU mutual exclusion (safe for 1 or 2 GPUs), and dynamic `TORCH_CUDA_ARCH_LIST`.
- **Segmentation upgrade:** Switched `run_rembg_cutout.py` from `u2net` to ordered `birefnet-general-lite` -> `isnet-general-use` -> `u2net` fallback on CPU with `scipy.ndimage.binary_fill_holes`, `<0.5%` component crumb pruning, transparent-RGB zeroing, and coverage/bounding-box/edge-touch diagnostics.
- **Mesh & preview fixes:** Upgraded `TripoSR` to `resolution=256` (`192` OOM fallback), rotated canonical vertices (`[:, [1, 2, 0]]`) into glTF `+Y` up / `+Z` front (preserving `+1` determinant / outward winding), and pruned tiny floaters via `mesh.split`. Added `FloaterRemover`, `DegenerateFaceRemover`, and `FaceReducer(max_facenum=80000)` to `Hunyuan3D-2mini`. Added linear->sRGB (`1.0 / 2.2`) gamma correction and balanced two-light shading on `COLOR_0` renders, a `Cutout (RGBA)` checkerboard column in `comparison_sheet.png`, and dish-grouped sections in `comparison_viewer.html`.

### Verified Cutout Diagnostics (Version 9, `birefnet-general-lite`)

| Dish Label | Input Size | Model | FG Coverage | BBox Aspect | Edge Touch | Components | Elapsed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `01_pizza` | `554×554` | `birefnet-general-lite` | `57.52%` | `1.021` | `[]` | `1 -> 1` | `20.34s` |
| `02_tteokbokki` | `800×560` | `birefnet-general-lite` | `43.72%` | `1.51` | `[]` | `1 -> 1` | `13.33s` |
| `03_kimchi` | `2000×1125` | `birefnet-general-lite` | `32.66%` | `1.345` | `[]` | `1 -> 1` | `12.04s` |
| `04_gimbap` | `739×415` | `birefnet-general-lite` | `42.77%` | `1.518` | `['top']` | `1 -> 1` | `11.77s` |

### Verified 8-GLB Output Audit (Version 9, `GPU T4 ×2`)

`TRELLIS.2-4B` stayed cleanly `skipped` (`missing_or_unauthorized_hf_token`) across all 4 dishes. All 26 archived artifacts + `manifest.json` inside `dish-3d-comparison.zip` matched exact SHA-256 digests (`publication_eligible: false`), with zero secret markers in `manifest.json`, `comparison_viewer.html`, or the kernel log.

| Output Path | Backend (Device) | Appearance | Vertices | Faces (Raw -> Out) | Bytes | Elapsed / VRAM | Signed Vol | Extent `[X, Y, Z]` | SHA-256 (12 chars) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `01_pizza/triposr.glb` | `TripoSR` (`cuda:0`) | `vertex_color` | `58,560` | `117,120` | `2,343,376` | `10.67s` / `2.323 GiB` | `+0.050022` | `[1.006, 0.987, 0.367]` | `a1543fb2bd2d` |
| `01_pizza/hunyuan3d_2mini.glb` | `Hunyuan3D-2mini` (`cuda:0`) | `geometry_only` | `39,994` | `227,928 -> 80,000` | `1,440,724` | `75.3s` / `4.08 GiB` | `+0.039862` | `[1.991, 1.991, 0.049]` | `adfb48cb722a` |
| `02_tteokbokki/triposr.glb` | `TripoSR` (`cuda:1`) | `vertex_color` | `55,659` | `111,326` | `2,227,432` | `10.66s` / `2.323 GiB` | `+0.12824` | `[0.910, 0.538, 0.703]` | `93f2f4e7bf9c` |
| `02_tteokbokki/hunyuan3d_2mini.glb` | `Hunyuan3D-2mini` (`cuda:1`) | `geometry_only` | `39,966` | `577,932 -> 80,000` | `1,440,384` | `83.13s` / `4.08 GiB` | `+1.031179` | `[1.950, 0.942, 1.992]` | `ab6101b65b5c` |
| `03_kimchi/triposr.glb` | `TripoSR` (`cuda:1`) | `vertex_color` | `73,206` | `146,496` | `2,930,224` | `9.78s` / `2.323 GiB` | `+0.122733` | `[1.095, 0.815, 0.437]` | `e0f89bfedb1b` |
| `03_kimchi/hunyuan3d_2mini.glb` | `Hunyuan3D-2mini` (`cuda:0`) | `geometry_only` | `40,000` | `200,692 -> 80,000` | `1,440,788` | `68.6s` / `4.08 GiB` | `+0.178133` | `[1.994, 1.412, 0.176]` | `83cee9498923` |
| `04_gimbap/triposr.glb` | `TripoSR` (`cuda:0`) | `vertex_color` | `50,545` | `101,090` | `2,022,776` | `9.67s` / `2.323 GiB` | `+0.086465` | `[1.027, 0.706, 0.586]` | `b091963b7d4f` |
| `04_gimbap/hunyuan3d_2mini.glb` | `Hunyuan3D-2mini` (`cuda:1`) | `geometry_only` | `39,994` | `387,412 -> 80,000` | `1,440,720` | `72.25s` / `4.08 GiB` | `+0.71537` | `[1.303, 0.780, 1.991]` | `08c577bac5b8` |

### Per-Dish Visual Inspection Findings
- **`01_pizza`:** `birefnet-general-lite` isolated the whole sliced pizza while dropping corner basil and the pizza cutter (a narrow dark pan-rim sliver remains along two arcs). Because the source is a top-down view, `Hunyuan3D-2mini` collapses into a very thin slice-gapped wafer (`Z=0.049`), while `TripoSR` correctly orients the sRGB-corrected pizza face forward (`Z=0.367`) with a synthesized thicker underside bulge.
- **`02_tteokbokki`:** Strongest 3D reconstruction overall. The cutout separated both thin wooden skewers cleanly from the textured dark bowl; `Hunyuan3D-2mini` preserved crisp rice-cake cylinders and both skewers (`577,932 -> 80,000` faces), and `TripoSR` recovered recognizable orange glaze colors (with softer vertex-color detail; source carries a faint stock watermark so it stays strictly private/off-repo).
- **`03_kimchi`:** Cutout preserved serrated cabbage margins plus the scalloped chili cup off the metal tray; `TripoSR` pruned `22 -> 1` floating fragments cleanly and kept readable chili-paste vs. green-leaf coloring, while `Hunyuan3D-2mini` yielded a relatively thin relief (`Z=0.176`) from the high camera angle.
- **`04_gimbap`:** Isolated all 8 rolled pieces off the wood board (top carrot/green garnishes touch the upper image boundary `edges=['top']`); `Hunyuan3D-2mini` produced clean separated roll cylinders (`387,412 -> 80,000` faces) and `TripoSR` preserved legible filling rings (`5 -> 1` floaters pruned) with smooth synthesized nori backsides.

## Research checks

- **PASS (Kaggle Version 9 live 4-dish `T4 ×2` run + local 8-GLB/ZIP/visual audit)** — Executed end-to-end on private `yacine105/trellislast-version` (`COMPLETE`, `442.8s` log) with private `yacine105/peekaplate-dish-test-photos` (`4` photos); verified `birefnet-general-lite` cutouts, `8/8` valid GLBs (positive signed volume, `has_vertex_color=True` on all `4` `TripoSR` meshes, `80,000` decimated faces on all `4` `Hunyuan3D-2mini` meshes), exact SHA-256 + ZIP integrity across `26` archived files + `manifest.json` (`publication_eligible: false`), zero leaked secrets, and direct visual inspection of all 4 cutouts and `comparison_sheet.png`.

- **PASS (Kaggle Version 6 live `T4 ×2` run + local byte/GLB audit)** — Executed end-to-end on `yacine105/trellislast-version` (`COMPLETE`, 355.7s notebook execution); downloaded `dish-3d-comparison.zip` and `manifest.json`, verified exact SHA-256 + byte matches across all 14 packaged artifacts, passed `validate_glb()` on all 4 `.glb` files, verified 6/6 `FullPlateTest` + 12/12 `NativeAdaptersTest`/`SpaceToolsMeshContractTest` CUDA checks in the Kaggle log, visually inspected generated PNGs and `comparison_sheet.png`, and confirmed zero leaked secrets or CLIP truncation warnings.
- **PASS** — `PYTHONPATH=processing/src:processing/tests processing/.venv/bin/python -m unittest -v test_dish_3d_notebook test_model_service test_generate_model test_portion_service`.
- **PASS** — `PATH="$HOME/.local/bin:$PATH" corepack pnpm context:show -- diner`.
- **PASS** — `PATH="$HOME/.local/bin:$PATH" corepack pnpm exec vitest run backend/src/owner-portion-preview.test.ts backend/src/owner-prepare.test.ts backend/src/bundle-producer/approved-portions.test.ts frontend/diner/src/menu/portionAssets.test.ts frontend/diner/src/menu/portionMotion.test.ts packages/contracts/src/serving-size.test.ts` (78 tests).
- **PASS** — ClickUp task and comments read for `86bd5m6q0` with explicit workspace selection. The first lookup without workspace selection was rejected. Babylon and COLMAP upstream docs were also read.
- **PASS (absence check)** — `git grep -inE 'trellis|babylon' HEAD -- pnpm-lock.yaml processing frontend backend packages` returned no matches (exit 1).
- **PASS** — `PYTHONPATH=processing/src:processing/tests processing/.venv/bin/python -m unittest -q test_model_service test_generate_model test_portion_service` (39 tests).
- **Earlier attempt failed to start** — `PYTHONPATH=processing/src processing/.venv/bin/python -m pytest -q processing/tests/test_model_service.py processing/tests/test_generate_model.py processing/tests/test_portion_service.py` (pytest absent from the local environment).
- **NOT RUN** — Hosted owner upload/publication, desktop and phone acceptance, live provider calls and physical tracked AR. This research verifies branch wiring and identifies acceptance work.
- **PASS** — `PATH="$HOME/.local/bin:$PATH" corepack pnpm context:check` and targeted local Markdown link validation using `checkLocalLinks` from `scripts/check-docs.mjs`.
- **FAIL** — `pnpm verify context:check docs:check` passed the context check, then reported missing targets in existing skill documentation. The report passed its targeted local link check.

---

## Verified Plate-Preserving Upgrade & Docker Worker Blueprint (Version 15, 2026-11-21)

Updated [notebooks/dish-3d-openrouter.ipynb](../../notebooks/dish-3d-openrouter.ipynb) for ticket `86bd5m6q0` as a private, plate-preserving single-photo demo (`publication_eligible: false`) and reproducible GPU Docker worker blueprint, verified live on Kaggle `NvidiaTeslaT4` (`T4 ×2`).

### Queue Resolution, `transformers 5.x` Compatibility & Hardening Fixes

1. **Kaggle BYOD Queue Fix:** Removing stale `"docker_image"` pinning and pushing with `"docker_image_pinning_type": "latest"` + `"machine_shape": "NvidiaTeslaT4"` switched the private kernel onto Kaggle's warm CUDA `13.0` image (`Python 3.13.16`, `PyTorch 2.11.0+cu130`, `transformers 5.20.2`, `trimesh 5.2.1`, `pymeshlab 2025.7.post1`, `rembg 2.0.67`), resolving the earlier BYOD `QUEUED` stall.
2. **GroundingDINO & Hunyuan3D-2mini under `transformers 5.20.2`:**
   - Used `inspect.signature(dino_proc.post_process_grounded_object_detection)` to adapt `threshold` / `box_threshold` and `text_labels`.
   - Added `remap_hunyuan_conditioner_state_dict` on `SingleImageEncoder` / `DualImageEncoder` in `hy_worker_code` to map `transformers 4.x` DINOv2 keys (`attention.attention.{query,key,value}`, `attention.output.dense`, `mlp.weights_out`, and chunk-split `mlp.weights_in` -> `gate_proj` + `up_proj`) to `transformers 5.x` (no-op on `4.x`).
   - Hardened Cell 11/15 `TRELLIS.2-4B` gating so even when `DINOV3_OK=True` on CUDA `13.0`, it records a clean `skipped` reason (`requires_cuda_12_toolchain`) without downgrading `transformers` or aborting Cell 19 outputs.
3. **Plate-Preserving Segmentation (`preserve_plate`):** Combines `birefnet-general-lite` food extraction with pinned Apache-2.0 `IDEA-Research/grounding-dino-tiny@a2bb814dd30d776dcf7e30523b00659f4f141c71` + `facebook/sam-vit-base@70c1a07f894ebb5b307fd9eaaee97b9dfc16068f` using two-pass vessel prompts (`PLATE_PROMPT_PASSES`), lower/lateral directional `sam_ring_points`, direct `sam_vessel_points`, solid hole-filled Pattern-A/Pattern-B scoring (`ring_contact`, `bbox_fill`), outer + inset corner checks (`count_non_food_corners`, `count_top_non_food_corners`), and paired vertical-edge tabletop guards.

### Verified Plate-Preserving Cutouts (Version 15)

| Dish Label | Input Size | Method | Food % | +Plate % | Total FG % | Corners Hit | Edge Touch | Elapsed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `01_pizza` | `554×554` | `grounding_dino_sam` | `57.52%` | `+4.61%` | `62.13%` | `0` | `[]` | `52.43s` |
| `02_tteokbokki` | `800×560` | `sam_vessel_points` | `43.72%` | `+34.93%` | `78.65%` | `0` | `['left', 'right']` | `24.46s` |
| `03_kimchi` | `2000×1125` | `grounding_dino_sam` | `32.66%` | `+11.25%` | `43.91%` | `0` | `[]` | `26.49s` |
| `04_gimbap` | `739×415` | `sam_ring_points` | `42.77%` | `+35.00%` | `77.77%` | `0` | `['left', 'right', 'top']` | `17.42s` |

### Verified 16-GLB Export Benchmark (`Raw` + `Mobile <=35k`, Version 15)

All 16 GLBs passed binary `glTF` v2 validation, finite-vertex checks, positive signed volume, `<=35,500` mobile face limits (`34,000` faces across all 8 mobile GLBs), exact disk/`manifest.json`/`worker_output.json`/`dish-3d-comparison.zip` SHA-256 parity (`publication_eligible: false`), `COLOR_0` vertex colors on all 8 `TripoSR` exports, and clean zero-secret scans. `TRELLIS.2-4B` stayed `skipped` (`missing_or_unauthorized_hf_token`).

| Output Path | Device | Appearance | Vertices | Faces | Bytes | Signed Vol | Extent `[X, Y, Z]` | SHA-256 (12 chars) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `01_pizza/triposr.glb` | `cuda:0` | `vertex_color` | `60,419` | `120,842` | `2,417,784` | `+0.07947` | `[1.005, 0.985, 0.428]` | `e910f3a023a0` |
| `01_pizza/triposr_mobile.glb` | `cuda:0` | `vertex_color` | `16,998` | `34,000` | `680,940` | `+0.07943` | `[1.005, 0.985, 0.427]` | `a9ec28fc5041` |
| `01_pizza/hunyuan3d_2mini.glb` | `cuda:0` | `geometry_only` | `39,982` | `228,962 -> 80,000` | `1,440,580` | `+0.04829` | `[1.989, 1.988, 0.049]` | `f63826287b36` |
| `01_pizza/hunyuan3d_2mini_mobile.glb` | `cuda:0` | `geometry_only` | `16,982` | `34,000` | `612,580` | `+0.04826` | `[1.989, 1.988, 0.049]` | `e9064c259cda` |
| `02_tteokbokki/triposr.glb` | `cuda:1` | `vertex_color` | `66,152` | `132,328` | `2,647,344` | `+0.09929` | `[1.076, 0.741, 0.433]` | `35d8ecb3e124` |
| `02_tteokbokki/triposr_mobile.glb` | `cuda:1` | `vertex_color` | `16,989` | `34,000` | `680,796` | `+0.09926` | `[1.076, 0.741, 0.433]` | `b59821cfa333` |
| `02_tteokbokki/hunyuan3d_2mini.glb` | `cuda:1` | `geometry_only` | `39,682` | `488,882 -> 80,000` | `1,436,976` | `+0.41760` | `[1.993, 0.561, 1.989]` | `95907cbd03aa` |
| `02_tteokbokki/hunyuan3d_2mini_mobile.glb` | `cuda:1` | `geometry_only` | `16,682` | `34,000` | `608,976` | `+0.41744` | `[1.994, 0.561, 1.989]` | `f24b745f338f` |
| `03_kimchi/triposr.glb` | `cuda:0` | `vertex_color` | `81,526` | `163,136` | `3,263,020` | `+0.14800` | `[1.058, 0.817, 0.555]` | `1c757a53a570` |
| `03_kimchi/triposr_mobile.glb` | `cuda:0` | `vertex_color` | `16,965` | `34,000` | `680,408` | `+0.14792` | `[1.058, 0.817, 0.554]` | `abc29bbb55c0` |
| `03_kimchi/hunyuan3d_2mini.glb` | `cuda:0` | `geometry_only` | `39,994` | `407,268 -> 80,000` | `1,440,716` | `+0.34658` | `[1.992, 1.547, 0.661]` | `83b5d88f42c8` |
| `03_kimchi/hunyuan3d_2mini_mobile.glb` | `cuda:0` | `geometry_only` | `16,994` | `34,000` | `612,716` | `+0.34652` | `[1.992, 1.547, 0.661]` | `42b861f09f9a` |
| `04_gimbap/triposr.glb` | `cuda:1` | `vertex_color` | `44,733` | `89,494` | `1,790,636` | `+0.02760` | `[0.954, 0.501, 0.544]` | `b994344a8069` |
| `04_gimbap/triposr_mobile.glb` | `cuda:1` | `vertex_color` | `16,987` | `34,000` | `680,768` | `+0.02759` | `[0.954, 0.501, 0.544]` | `c7cdf5357240` |
| `04_gimbap/hunyuan3d_2mini.glb` | `cuda:1` | `geometry_only` | `39,986` | `298,982 -> 80,000` | `1,440,624` | `+0.36627` | `[1.722, 0.518, 1.992]` | `44a331bb263f` |
| `04_gimbap/hunyuan3d_2mini_mobile.glb` | `cuda:1` | `geometry_only` | `16,986` | `34,000` | `612,624` | `+0.36623` | `[1.722, 0.518, 1.992]` | `57eacadb286f` |

### HF TRELLIS Studio Inspection & Docker Worker Blueprint

- **Visual Outputs:** Generates `hf_modes_sheet.png` (`Normal`, `Clay`, `Base Color`, `Studio HDRI` per dish/backend), `comparison_sheet.png`, and `comparison_viewer.html` (`@google/model-viewer@4.0.0`, dish tabs, raw-vs-mobile GLB switch, auto-rotate/reset/exposure controls, and truthful `Private single-photo 3D demo` badge).
- **Docker Worker Blueprint (`results/docker_blueprint/` inside `dish-3d-comparison.zip`):**
  - `Dockerfile.worker.template`: non-root `worker` user (`nvidia/cuda:13.0.0-runtime-ubuntu24.04`), mounts `/var/cache/peekaplate` and `/work`, installs `requirements.lock.txt` with `--extra-index-url https://download.pytorch.org/whl/cu130`, bakes zero secrets or photos.
  - `worker_entrypoint.py`: fails closed unless `job_manifest.json` has `publication_eligible === false` and a valid 64-char lowercase hex `source_sha256` matching the input file on disk, then emits `worker_output.json`.
  - Next-stage Docker build/dry-run commands (after unpacking `results/docker_blueprint/`):

```bash
docker build -f Dockerfile.worker.template -t peekaplate-dish3d-worker:demo .
docker run --rm --gpus all -v "$PWD/dish_dir:/work" peekaplate-dish3d-worker:demo \
  --manifest /work/job_manifest.json --input-dir /work --out /work/out --dry-run
```

- **Readiness Boundary (V15 Checks):**
  - **PASS** — Offline unit suite (`48` tests in `test_dish_3d_notebook`, `test_model_service`, `test_generate_model`, `test_portion_service`), Kaggle Version 15 live `T4 ×2` execution (`4/4` preserved plates visually verified, `16/16` valid GLBs, `0` leaked secrets), downloaded V15 `worker_entrypoint.py --dry-run` + fail-closed missing-`source_sha256` test, `pnpm context:check`, `checkLocalLinks`, and `git diff --check`.
  - **NOT RUN** — Full `docker build` / `--gpus all` container execution against a local NVIDIA daemon (verified via generated template + downloaded V15 `worker_entrypoint.py --dry-run` contract tests only), authorized `TRELLIS.2-4B` PBR run, multi-view capture, and hosted production publication (`publication_eligible` stays `false`).

### Interactive Three.js 3D Dish Studio Standard (Required for Every Notebook Version)

Added [dish_3d_studio.py](../../processing/src/peekaplate_processing/dish_3d_studio.py) and [test_dish_3d_studio.py](../../processing/tests/test_dish_3d_studio.py), and updated Cell 19 of [notebooks/dish-3d-openrouter.ipynb](../../notebooks/dish-3d-openrouter.ipynb) (`STUDIO_HTML_TEMPLATE`, synced byte-for-byte via `test_dish_3d_notebook.py`) so **every future notebook version** must emit, bundle into `dish-3d-comparison.zip`, test, and verify BOTH interactive WebGL studios:

1. **`comparison_viewer.html`:** Multi-file interactive Three.js `0.182.0` studio supporting `Raw Full` and `Mobile <=35k` GLBs across `TripoSR (Color)`, `Hunyuan3D-2mini (Mesh)`, and synced **Side-by-Side Compare**, live shading modes (`Studio PBR`, `Base Color`, `Clay`, `Normal`, `Wireframe`), camera presets (`Front 3/4`, `Top`, `Side`, `Low Rim`), auto-rotate, exposure, studio backgrounds (`Dark`/`Slate`/`Light`), plate-preserving Source vs. Cutout reference, GLB downloads, and graceful no-WebGL static fallbacks (`publication_eligible=false` banner).
2. **`interactive_3d_studio.html` *(superseded 2026-11-23: legacy single-file default replaced by split studio below; retained only behind `--legacy-single-file`)*:** Self-contained single-file HTML embedding the `Mobile <=35k` GLBs (`base64` decoded via `GLTFLoader.parse` — zero `file://` CORS failures in Firefox/Chrome) and resized `512px` source/cutout/fallback thumbnails (~`10.4 MiB` for Version 15).

**Split Studio Standard (2026-11-23, supersedes single-file default above):** When scaling beyond small 4-dish runs to the 19-dish and 41-dish sweeps, the monolithic single file grew to 123 MB (and would reach ~260 MB for 41 dishes). Both `dish_3d_studio.py` and `merge_multi_model_results.py` now default to `build_split_studio(...)`. This writes a lightweight index (`index.html`, ~68 KB, no Three.js or embedded GLBs) linking to individual per-dish pages (`dishes/<label>.html`) that embed only that dish's mobile GLBs (median ~6.0 MB, max ~7.2 MB) for zero-CORS `file://` inspection. Full-resolution raw GLBs remain downloadable via relative disk links. Built pages pin the jsDelivr `three@0.182.0` CDN import map, and `--serve` swaps in the vendored `/vendor/three` copy dynamically when running the loopback server. An optional `--menu-manifest` lists all canonical dishes (marking unrun models as pending), and `--legacy-single-file` gates the monolithic `interactive_3d_studio.html` behind an explicit flag.
3. **Local Build & Loopback Server CLI:**

```bash
PYTHONPATH=processing/src processing/.venv/bin/python -m peekaplate_processing.dish_3d_studio \
  --results-dir /path/to/results --build --serve --port 8765
```

- **Interactive Studio Verification Status:**
  - **PASS** — `51` unit tests (`test_dish_3d_studio`, `test_dish_3d_notebook`, `test_model_service`, `test_generate_model`, `test_portion_service`), including `STUDIO_HTML_TEMPLATE == _STUDIO_HTML_TEMPLATE` parity, `</script>` XSS escaping, and traversal rejection.
  - **PASS (Live Browser WebGL)** — Generated and served Version 15 studios via local `/vendor/three/` (`three@0.182.0`) on `127.0.0.1:8765`, verified live `WebGL2` rendering in Chromium (`comparison_viewer.html`) for `01_pizza` and `02_tteokbokki` (`Side-by-Side Sync` + `Clay`/`Studio PBR`, `0` console errors, `0` failed requests).
  - **NOT RUN** — A new Kaggle Version 16 run pushing the embedded Cell 19 `three@0.182.0` studio template to Kaggle (the template is verified offline in `test_dish_3d_notebook.py` and rendered live locally against Version 15 artifacts).

---

## Kaggle Version 20 TRELLIS.2-4B Forensic Audit & Version 21 Dual-T4 Fixes (2026-11-21)

### Observed V20 TRELLIS.2-4B Root Causes (Live Run `yacine105/trellislast-version/20`)

Live Kaggle Version 20 executed genuine textured **TRELLIS.2-4B** (`COMPLETE`, 4/4 valid WebP PBR `.glb` binaries on `T4 ×2` using CUDA `12.8`, `5.16 GiB` peak `cuda:0` VRAM, `169–218s` generation per dish). Forensic inspection of the downloaded `.glb` meshes, PBR textures, and Cell 13/15 code established why visual quality was poor:

1. **Unmasked background passed as conditioning input:** Cell 15 passed raw opaque `in_entry['image_path']` (`input_image.png`) into `trellis_prepare_full_plate.py` while `trellis_native_runner.py` ran `pipeline.run(..., preprocess_image=False)`. Because TRELLIS.2 expects a background-removed black-premultiplied subject, all 4 meshes baked the tabletop/slate/concrete background into thin flat slabs (`01_pizza` thickness `Y=0.051` with `p95` metallic `0.85`; `03_kimchi` tablet `0.669×0.119×1.000`; `02_tteokbokki` bowl welded onto a brown wood rectangle). Furthermore, `trellis_prepare_full_plate.py` did not crop to the alpha bounding box, wasting conditioning resolution on wide photos (`03_kimchi` foreground was `43.91%`).
2. **Shattered mesh topology & UVs (`remesh=False`, `texture_size=1024`):** Skipping Dual Contouring remeshing left `8,722` (`01_pizza`), `13,127` (`02_tteokbokki`, negative signed volume `-0.0074`), `23,026` (`03_kimchi`), and `9,746` non-manifold / `133,967` unwelded seam+boundary edges (`04_gimbap`, `144,717` glTF verts vs. `38,235` spatial verts = `3.78×` split ratio), producing perforated surfaces and speckled `1024` UV atlases.
3. **Coarse `512` resolution & photo-angle limits:** Running only `pipeline_type='512'` omitted `1024_cascade` detail refinement, and the 90° top-down (`01_pizza`, `03_kimchi`), rim-clipped (`02_tteokbokki`, `04_gimbap`), and blurred (`04_gimbap`) inputs remain hard single-view geometry limits.
4. **No image generator inside V20 or TRELLIS.2:** Stage 0 discovered the 4 user photos so OpenRouter (`google/gemini-3.1-flash-lite-image`, `google/gemini-3.1-flash-image`) and local `fp16` fallbacks (`stabilityai/sd-turbo`, `Lykon/dreamshaper-8`) did not execute; TRELLIS.2 itself uses `facebook/dinov3-vitl16-pretrain-lvd1689m` conditioning plus flow-matching 3D diffusion directly (`publication_eligible: false` per [ADR 0004](../adr/0004-visual-tiers.md)).

### Implemented Fixes & Verified Live Kaggle Version 31 Results (2026-11-22)

- **Plate-preserving alpha conditioning + fail-closed guard (`Cell 13` & `Cell 15`):** Switched Cell 15 from `in_entry['image_path']` to `in_entry['cutout_path']` (`cutout_rgba.png`), added `--crop-to-alpha` (using `alpha > 0` so translucent rims survive) and `--require-alpha` (rejecting opaque RGB inputs) to `trellis_prepare_full_plate.py`, and fixed Stage 1 `DinoV3FeatureExtractor` invocation (`encoder([image])`, `ERR-20261122-003`).
- **Stage-by-stage lazy checkpoint loading + dual-T4 sharding (`Cell 13` & `Cell 15`):** Rewrote `trellis_native_runner.py` (`run_pipeline_staged` + `_release_model`) to load and release each TRELLIS checkpoint on demand, preventing V26's `~32 GiB` CPU RAM `SIGKILL` (`-9`) on `01_pizza` and keeping peak CPU RSS at **`6.14 GiB`** across all 4 dishes (`4.71 / 6.14 / 4.20 / 4.27 GiB`). `DualGpuShardedFlowModel` + cache-clean `move_to_device` shard flow transformer blocks 50/50 across `cuda:0 + cuda:1`, with `tex_slat_decoder` on `cuda:1` and adaptive `sparse_attention` query chunking (`256..1024`). Because `1024_cascade` in FP32 on T4 exceeded per-dish latency (`97m` across 3 dishes in V26), Kaggle T4 defaults to `pipeline_type='512'` (`timeout=1200`) with `1024_cascade` -> `512` OOM fallback retained for faster GPUs (`A100`/`L40S`).
- **Watertight boundary closure, 2048px PBR baking & `<=35k` mobile GLBs:** Enabled `remesh=True` (`remesh_band=1`, `remesh_project=0.9`), `decimation_target=150000`, `texture_size=2048` (`0` fallbacks), and `mobile_decimation_target=34000` (`trellis2_4b_mobile.glb`, `1024px`) embedded alongside `TripoSR` and `Hunyuan3D-2mini` in [`interactive_3d_studio.html`](../../notebooks/dish-3d-openrouter.ipynb) (`21,201,142` B, `publication_eligible: false`).

| Dish (`V31`, `512` Dual-T4) | Total Time | Raw Verts / Faces (`Split`) | Boundary / NonMan Edges | Signed Vol (`V20 -> V31`) | Extent `[X, Y, Z]` | PBR Tex | Mobile Faces / Bytes (`SHA-12`) | Raw `SHA-12` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `01_pizza` | `362.70s` | `117,913` / `149,052` (`1.60×`) | `0` (was `8,721`) / `1,068` | `+0.01165 -> +0.00151` | `[0.999, 0.088, 0.997]` | `2048×2048` | `32,488` / `1,707,332` (`57b16f797bb2`) | `73859d2d1f6e` |
| `02_tteokbokki` | `323.08s` | `154,309` / `144,504` (`2.31×`) | `0` (was `13,127`) / `5,211` | `-0.00738 -> +0.00246` | `[0.997, 0.301, 0.879]` | `2048×2048` | `33,092` / `2,214,828` (`fde435a21f27`) | `4770e2dc4a7b` |
| `03_kimchi` | `369.79s` | `196,969` / `149,525` (`3.01×`) | `0` (was `23,024`) / `11,059` | `+0.01066 -> +0.00462` | `[0.999, 0.316, 0.873]` | `2048×2048` | `32,597` / `2,314,564` (`67eb06a320dc`) | `f5b573ecb462` |
| `04_gimbap` | `277.47s` | `104,243` / `147,427` (`1.42×`) | `0` (was `7,076`) / `143` (was `9,740`) | `+0.00969 -> +0.00044` | `[1.000, 0.149, 0.597]` | `2048×2048` | `31,941` / `1,382,012` (`7cf775638f7c`) | `dbb85d743fad` |

- **Observed Visual & Topology Audit (`V20` vs `V31`):**
  - All 4 tabletop slabs and perforated surfaces are eliminated; `8/8` raw and mobile GLBs have `0` open boundary edges and positive signed volume (`peak_gpu0_gib=2.780`, `peak_gpu1_gib=2.711`, `dual_gpu_sharded=True`, `remesh_used=True`). `02_tteokbokki` gained a closed ceramic bowl (`-0.00738 -> +0.00246`), `03_kimchi` closed into a solid white plate (`23,024 -> 0` open edges), and `04_gimbap` dropped non-manifold edges from `9,740` to `143` (`split=3.78× -> 1.42×`).
### Remaining Limits, HF Space Settings Alignment & TRELLIS-Only Simplification (2026-11-22)

- **Why `03_kimchi` (and single-photo undersides) degraded between V31 and HF Space `1536` (`app.py`):**
  1. **`pipeline_type='512'` vs `1536_cascade` + `bf16`:** Kaggle `2× Tesla T4` (`sm_75`) lacks hardware `bfloat16` Tensor Cores, so V31 ran FP32 at `pipeline_type='512'` (`3,755` latent tokens on `03_kimchi`) rather than the HF ZeroGPU H200/A100 Space's native `bfloat16` `1536_cascade` (`~30k–49k` sparse tokens + `1024px` DINOv3 conditioning).
  2. **Post-processing & crop mismatch (`remesh_project=0.9`, `MARGIN=0.08`, `decimation_target=150000`):** In `app.py` (`microsoft/TRELLIS.2` Space), export runs `mesh.simplify(16777216)` followed by `o_voxel.postprocess.to_glb(..., decimation_target=300000, texture_size=2048, remesh=True, remesh_band=1, remesh_project=0)` after a tight `margin=0` alpha crop (`size * 1`). V31's `remesh_project=0.9` + `150000` decimation snapped Dual Contouring vertices onto thin curled cabbage folds and caused `11,059` non-manifold pinch edges on `03_kimchi` (`5,211` on `02_tteokbokki`).
- **Notebook & Studio Simplification Applied Offline:** Removed `TripoSR` and `Hunyuan3D-2mini` from [dish-3d-openrouter.ipynb](../../notebooks/dish-3d-openrouter.ipynb) (compacted to 16 cells `0..15`) and [dish_3d_studio.py](../../processing/src/peekaplate_processing/dish_3d_studio.py) (excluding legacy non-TRELLIS runs when rebuilding historical manifests), aligned `MARGIN = 0.0`, `decimation_target = 300000`, `remesh_project = 0.0`, and `mesh.simplify(16777216)` with `app.py`, and added `use_bf16` + `_default_trellis_pipeline_type()` (`1536_cascade` on `sm_80+` with `1536_cascade -> 1024_cascade -> 512` OOM fallback, retaining `float32` + `512` on T4 `sm_75`).
- **HF Space `1536` Reproduction & Intrinsic Single-View Paradigm Limit (2026-11-22):** Repeating `03_kimchi` on the official `microsoft/TRELLIS.2` Hugging Face Space (`1536_cascade`, `bfloat16`, `remesh_project=0`, `decimation_target=300000`) reproduced the same degraded geometry limitation observed on Kaggle—confirming the bottleneck is intrinsic to single-image overhead 3D diffusion (`90°` vertical depth underdetermination, `16×` VAE + `xatlas` loss across curled chili cabbage, and specular highlight entanglement) rather than T4 FP32/`512` settings alone. See [Dish 3D model alternatives](../../reports/Dish%203D%20model%20alternatives.md) for the full 5-paradigm comparison (`MoGe-2` MIT projective 2.5D relief + parametric plate, commercial `Tripo3D v3.1` / `Rodin Gen-2`, `Hi3DGen` + `MV-Adapter`/`TEXGen` vs `Hunyuan3D-2.1` EU/UK/KR territorial exclusions, non-commercial 3DGS blockers, and 4-photo `VGGT`/`MASt3R` + `2DGS` production capture under [ADR 0004](../adr/0004-visual-tiers.md)).
- **Readiness Boundary:**
  - **PASS (Live Kaggle V31 + Offline Post-Simplification Checks)** — Kaggle Version 31 (`yacine105/trellislast-version/31`, `COMPLETE`, `CUDA 12.8`, `2× Tesla T4`), `test_trellis_full_plate.py` (`8/8 OK`), `test_trellis_native_compat.py` (`14/14 OK`), `4/4` TRELLIS PBR raw/mobile GLBs, and local `test_dish_3d_notebook` + `test_dish_3d_studio` (`16` tests) + rebuilt TRELLIS-only V31 `interactive_3d_studio.html` (`13,957,908` B) + `pnpm context:check`.
  - **NOT RUN** — Re-running the updated 16-cell TRELLIS-only notebook on Kaggle T4 (with `MARGIN=0.0`, `remesh_project=0.0`, `decimation_target=300000`) or running native `bf16` `1536_cascade` on an `sm_80+` GPU (`L4`/`RTX 4090`/`A100`/`H100`), `MoGe-2` 2.5D relief export, live `Tripo3D v3.1` / `Rodin Gen-2` / `Hi3DGen` comparisons, 4-photo multi-view capture, Docker GPU execution, and production diner publication (`publication_eligible` stays `false`).

### Operating the private Kaggle jobs (2026-11-22)

Credentials and CLI: `~/.kaggle/access_token` (mode `600`) holds the API token used by the Kaggle CLI 2.2.5 venv at `/tmp/dish-kaggle-cli`. That venv lives under `/tmp`; recreate it with `python3 -m venv /tmp/dish-kaggle-cli && /tmp/dish-kaggle-cli/bin/pip install kaggle` after a reboot. Unauthenticated `curl` of `kaggle.com` pages returns `404` even for public notebooks, so a `404` is never evidence that a kernel is missing — use `kaggle kernels status`.

```bash
K=/tmp/dish-kaggle-cli/bin/kaggle
$K quota >/dev/null && echo auth-ok   # any authenticated call works; `auth print-access-token` answers "You must log in" for a stored token file and is not an auth signal
$K quota                                                   # GPU/TPU hours remaining
$K kernels list --user yacine105 --page-size 30
$K kernels status yacine105/trellislast-version/32
$K kernels logs   yacine105/trellislast-version/32           # empty output for cancelled versions
$K kernels output yacine105/trellislast-version/32 -p /tmp/pull-t32
# push: stage the notebook + kernel-metadata.json in one directory, then
$K kernels push -p /tmp/push-t
```

Kaggle allows at most **two concurrent batch GPU sessions**: a third push fails with `Maximum batch GPU session count of 2 reached` and the job is not queued — push it again once a session finishes.

Observed on 2026-11-22: `benchmark-a/1`, `benchmark-a/2`, `hero-batch-b/4` and `trellislast-version/5` ended `CANCEL_ACKNOWLEDGED` with no outputs and empty logs, i.e. queued sessions were cancelled rather than failing in code; `hero-batch-b/3` and `trellislast-version/4` are `COMPLETE`. The current local notebook sources had never run at that point, so completed outputs from `/3` and `/4` are evidence for the previous revisions only.

---

## Kaggle Job Audit, Output Verification & Four Repairs (2026-11-22, second pass)

### Job state measured across 18:21Z–21:24Z

| Kernel / version | Status | Evidence |
| --- | --- | --- |
| `trellislast-version/32` | `COMPLETE` | 26 output files, 4/4 dishes with `TRELLIS.2-4B` = `skipped (missing_or_unauthorized_hf_token)`, zero GLBs |
| `peekaplate-dish-3d-multi-model-benchmark-a/3` | `COMPLETE` | 19 dishes, 76/76 GLBs valid, `MoGe-2` + `Hunyuan3D-2` = `success`, `TripoSG` + `Hi3DGen` = `failed` (19/19 each) |
| `peekaplate-dish-3d-multi-model-benchmark-a/4` | `COMPLETE` (19:43Z–22:02Z) | 19 dishes: `MoGe-2` + `Hunyuan3D-2` + `TripoSG` `success` ×19, `Hi3DGen` `skipped` ×19; 22/114 GLBs exceed the 50 MB cap (all TripoSG) |
| `peekaplate-dish-3d-multi-model-benchmark-a/5` | `COMPLETE` (23:33Z–01:27Z) | **PASS**: 19 dishes, 114/114 GLBs valid and digest-exact, 19/19 cutout pairs, 0 errors, 103 warnings; TripoSG raw `<=299,508` faces and mobile `<=34,960` faces |
| `peekaplate-dish-3d-trellis2-hero-batch-b/5` | `COMPLETE` (started after ~2 h `QUEUED`) | 15 dishes, 30/30 GLBs valid, 0 errors, 26 warnings; `TRELLIS.2-4B` skipped ×15 (HF token) |
| `peekaplate-dish-3d-trellis2-hero-batch-b/3` | `COMPLETE` | **150 verifier errors**: 15 dishes shipped NaN/`inf` POSITION + NORMAL GLBs — the live evidence for `ERR-20261122-005` (`/5` carries the fix) |

### Verified output trees

Local trees pulled with `kaggle kernels output` and graded by `processing/scripts/verify_kaggle_outputs.py` (read-only):

| Tree | Dishes | GLBs | Digest | Image pairs | Errors | Warnings | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/tmp/pull-t32` (`trellislast-version/32`) | 4 | 0 | 0 missing / 0 mismatch | 4/4 | 0 | 8 (4 skipped runs + 4 absent GLBs) | PASS — no mesh owed, token blocked |
| `/tmp/pull-ba3` (`benchmark-a/3`) | 19 | 76/76 structural pass, 76/76 digest match | 0 missing / 0 mismatch | 19/19 | 38 (`run_status_failed` ×2 models ×19) | 46 (`27` non-watertight, `8` degenerate faces, `11` bbox-claim deltas) | FAIL — two model runtimes |
| `/tmp/pull-hb3` (`hero-batch-b/3`) | 15 | 30 | declared for the successful runs only | 15 | 150 | 26 | FAIL — pre-`ERR-20261122-005` NaN geometry |
| `/tmp/pull-hb5` (`hero-batch-b/5`) | 15 | 30/30 structural pass, 30/30 digest match | 0 missing / 0 mismatch | 15/15 | 0 | 26 (15 skipped runs + 11 bbox-claim deltas) | PASS — `ERR-20261122-005` fix proven live |
| `/home/yacine105/kaggle-evals/pull-ba4` (`benchmark-a/4`) | 19 | 92/114 structural pass | 0 missing / 0 mismatch | 19/19 | 23 (22 `glb_oversized` + 1 dropped download) | 81 (`19` skipped runs, `43` non-watertight, `8` degenerate faces, `11` bbox-claim deltas) | FAIL — TripoSG density (fixed in `/5`) |
| `/home/yacine105/kaggle-evals/pull-ba5` (`benchmark-a/5`) | 19 | 114/114 structural pass, 114/114 digest match | 0 missing / 0 mismatch | 19/19 | 0 | 103 (`19` skipped runs, `65` non-watertight, `8` degenerate faces, `11` bbox-claim deltas) | PASS |
| `/tmp/peekaplate-all-models-studio/results` (merged) | 19 | 114/114 structural pass, 114/114 digest match | 0 missing / 0 mismatch | 19/19 | 0 | 118 | PASS — 5 model slugs, `publication_eligible: false` |

`benchmark-a/5` measured detail per backend (19 dishes): `moge2_relief` 19 raw (`53,108,072` B, watertight 19/19) + 19 mobile (`12,933,660` B, `<=34,088` faces, watertight 19/19); `hunyuan3d2` 19 raw (`254,831,000` B, watertight 11/19, `<=800,134` faces) + 19 mobile (`15,976,172` B, `<=34,646` faces); `triposg` 19 raw (`313,297,388` B, `<=299,508` faces after the `MAX_RAW_FACES` cap, watertight 0/19 as expected for dense marching cubes) + 19 mobile (`29,870,496` B, `<=34,960` faces); every one of the 114 GLBs embeds a valid PNG atlas and holds `0` non-finite POSITION values. `Hi3DGen` `skipped` ×19 and `TRELLIS.2-4B` absent from this shard.

Merged five-model studio: `merged_source_count: 2` (`hero-batch-b/5` then `benchmark-a/5`), `19` dishes, model slugs `moge2-relief` / `triposg` / `hunyuan3d2` / `trellis2-4b` / `hi3dgen`, `MoGe-2` 19 `success`, `TripoSG` 19 `success`, `Hunyuan3D-2` 19 `success`, `TRELLIS.2-4B` 15 `skipped`, `Hi3DGen` 19 `skipped`, `publication_eligible: false`, `input_image_sha256` measured for all 19 inputs, `interactive_3d_studio.html` `93,941,631` B, `comparison_viewer.html` `122,827` B, tree `802,436,923` B.

`hero-batch-b/5` measured detail (15 GMn9C8 Hero dishes, `05`…`19`): `MoGe-2 Relief + Ceramic Plate` `success` ×15 with `mobile_status=available` ×15, `15/15` textured PNG atlases, `15/15` watertight raw and mobile, `0` non-finite POSITION values, mobile face ceiling `26,100`, raw bytes `39,699,272` + mobile `9,862,112`. This is the live proof for `ERR-20261122-005`: the same shard on `/3` shipped NaN/`inf` geometry (150 errors) and `/5` ships none.

`benchmark-a/3` measured detail (per backend, 19 dishes): `moge2_relief` 19 raw + 19 mobile, `19/19` textured PNG atlas and watertight; `hunyuan3d2` 19 raw + 19 mobile, `19/19` textured, `11/19` watertight raw and `0/19` watertight mobile; mobile face ceiling `34,916 <= 35,000` across all `38` mobile GLBs; `0` non-finite POSITION values; total `336,704,520` B.

**Provenance measured (pre-staging-fix trees):** `benchmark-a/3` and `trellislast-version/32` declare `source_sha256` = the **re-encoded** stage bytes (`01_pizza` `116694fe…` vs the dataset photo `8cdf837f…`; `07_pikachu_burger` `f758d192…` vs `e4596b1e…`) and carry no `input_image_sha256`. Those trees therefore prove the re-encode defect the staging fix removes; `/4` and later declare both digests.

### Two live model failures and their fixes

1. **`TripoSG + Photo PBR` — 19/19 `RuntimeError: mat1 and mat2 must have the same dtype, but got Float and Half`.** The cell built the pipeline with `TripoSGPipeline.from_pretrained(weights, torch_dtype=torch.float16).to('cuda')`, which leaves the DINOv2 image encoder in float32 so its features hit FP16 DiT linears. Upstream `scripts/inference_triposg.py` casts the whole pipeline (`.to(device, dtype)`); the generated cells now do the same and assert the resulting parameter dtype before running.
2. **`Hi3DGen Normal-Bridge` — 19/19 `CalledProcessError: ['ninja'] exit 1`.** `spconv-cu126` installs, but on the cu128 Kaggle image importing it triggers a `cumm` C++ rebuild that dies on missing vendored `tensorview` headers (`fatal error: tensorview/pybind_utils.h`). No `spconv` build matches cu128, so the cell now probes `import spconv.pytorch` in a child process, uninstalls the unusable wheel, and records `hi3dgen` as `skipped (spconv_unavailable:…)` for the whole shard instead of 19 opaque failures. A genuine Hi3DGen error still reports `failed`.

### Repairs to the verification/monitoring tooling (all with regressions)

1. `processing/scripts/kaggle_job_status.py` (**ERR-20261122-006**): the CLI child process inherited `PYTHONPATH`, so `processing/tests/sitecustomize.py`'s socket guard aborted every HTTPS call and the report showed only `Traceback (most recent call last):`. The child env now drops `PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP`, and a traceback reports its last line plus an explicit socket-guard hint.
2. `processing/scripts/verify_kaggle_outputs.py` (**ERR-20261122-007**): a dish whose every declared run is `skipped` owes no mesh, so the empty directory is now `glb_artifact_absent_for_skipped_runs` (warning) instead of `glb_artifact_missing` (error); a failed or undeclared run stays an error.
3. `verify_kaggle_outputs.py` (**ERR-20261122-008**): `input_image.png` is verified against `input_image_sha256` (the staged bytes) with `source_sha256` only as the legacy fallback, so an honest re-encode is not a digest conflict.
4. `processing/scripts/merge_multi_model_results.py` (**ERR-20261122-008**): the merged studio now measures `input_image_sha256` from the copied `input_image.png` and never inherits a per-source digest that describes another tree.

### Blocker and user action items

- **`HF_TOKEN` is still not available to the Kaggle kernels**, so `TRELLIS.2-4B` cannot run in either notebook (`trellislast-version/32` skipped 4/4; `benchmark-a` prints `DINOv3 preflight ok=False`; `benchmark-b` needs it for its primary model). Action: Kaggle notebook UI → **Add-ons → Secrets → attach `HF_TOKEN`** to `trellislast-version`, `peekaplate-dish-3d-multi-model-benchmark-a` and `peekaplate-dish-3d-trellis2-hero-batch-b` (a re-push is not a substitute).
- **`benchmark-a/4` proved the two model fixes and exposed a third defect.** Live log: `[triposg] Setup failed: TypeError: 'dict' object is not callable` — the new component dtype probe raised after the casts had already succeeded, and because the pipeline had been assigned before the probe, **all 19 TripoSG dishes still generated** (`success` ×19, 1.36M–7.12M faces). `[hi3dgen] spconv-cu126 unusable on this CUDA image; last line: ninja: build stopped: subcommand failed.` followed by `skipped` ×19 — the fail-closed preflight worked exactly as designed.
- **TripoSG's decoder is unsimplified and the mobile fallback lied (`ERR-20261122-009/010`).** Raw GLBs were 107–354 MB (7.1M faces on `02_tteokbokki`), above the 50 MB production cap, and three "mobile" GLBs (`01_pizza`, `02_tteokbokki`, `04_gimbap`) were byte-for-byte the raw mesh (5,445,228 / 7,120,832 / 4,704,304 faces) because `_decimate_vertex_cluster` fell through to `return vertices, faces` while the record still said `mobile_status=available`. The fix returns the smallest reachable mesh, has the baker omit a mobile GLB it cannot ceiling (`mobile_error`), caps the raw TripoSG mesh at `MAX_RAW_FACES=300000`, and keeps every dtype diagnostic non-fatal (`torch.nn.Module.parameters(module).__next__().dtype`, pipeline assigned only after the checks).

### Queue behaviour measured (corrects the earlier "stale entry" reading)

`hero-batch-b/5` was `QUEUED` from 18:22Z and **started on its own at ~20:1xZ without any re-push**, completing at ~21:20Z while `benchmark-a/4` was running. The 2 h 50 min wait was Kaggle host capacity for the 2×T4 shape, not a dead queue entry: `benchmark-a/3` was granted the slot that `trellislast-version/32` released at 18:25Z, the GPU-hours meter stayed flat only while nothing was scheduled, and the queued version still ran with its uploaded source snapshot intact. A queued version is therefore not evidence of a defect and must not be cancelled or re-pushed without measuring `kernels logs`, `kernels files` and two `quota` samples first — the pattern that *is* actionable is a version stuck with `log=empty`, `outputs=0` and a *moving* quota belonging to another session.

### Operating notes added to this pass

- Run the status tool without the offline harness path: `PYTHONPATH=processing/src processing/.venv/bin/python processing/scripts/kaggle_job_status.py --log-tail 6` (including `processing/tests` used to break the CLI child process — fixed, but the path is still unnecessary).
- `kernels status` alone cannot distinguish "queued waiting for a host" from "stale entry": also check `kernels logs` (empty ⇒ no worker ever started), `kernels files` (count `0`), and two `kaggle quota` samples minutes apart (a flat used-hours total with a queued version means nothing is consuming the GPU).

---

## Independent Re-pull and Verification Pass (2026-11-23, 01:46Z–04:20Z)

No version changed and nothing was running: `kaggle kernels status` reported `COMPLETE` for `peekaplate-dish-3d-multi-model-benchmark-a` v5 (333 output files), `peekaplate-dish-3d-trellis2-hero-batch-b` v5 (130) and `trellislast-version` v32 (26), each with `log=present` in `kaggle_job_status.py`. `kaggle quota` read `12.11h used / 32.89h remaining of 45.00h` both before and after the pass, so this pass consumed **0 GPU-hours**, pushed no notebook and queued no session. `kaggle auth print-access-token` answers "You must log in to Kaggle" for the stored `~/.kaggle/access_token` while `kernels status/files/logs/output` and `quota` all authenticate: that probe is not an auth signal (operating note above corrected).

### Fresh pulls and verifier verdicts

Every tree was re-downloaded with `kaggle kernels output <ref>/<version>` into `/home/yacine105/kaggle-evals/repull-20261123/{ba5,hb5,t32}` and graded read-only by `processing/scripts/verify_kaggle_outputs.py` (exit code captured without a pipe):

| Tree | Dishes | GLB pass/total | Digest missing/mismatch | Image pairs | Errors | Warnings | Verdict | `rc` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `t32` = `trellislast-version/32` | 4 | 0/0 | 0 / 0 | 4/4 | 0 | 8 | PASS | 0 |
| `hb5` = `hero-batch-b/5` | 15 | 30/30 | 0 / 0 | 15/15 | 0 | 26 | PASS | 0 |
| `ba5` = `benchmark-a/5` | 19 | 114/114 | 0 / 0 | 19/19 | 0 | 103 | PASS | 0 |

Warning composition is the documented benign set: `ba5` = 65 `glb_mesh_not_watertight` + 19 `run_status_skipped` + 11 `image_bbox_claim_mismatch` + 8 `glb_degenerate_faces`; `hb5` = 15 `run_status_skipped` + 11 `image_bbox_claim_mismatch`; `t32` = 4 `run_status_skipped` + 4 `glb_artifact_absent_for_skipped_runs` (a dish whose every declared run is skipped owes no mesh). No `error`-severity finding was recorded anywhere, and no failed or undeclared run exists in any tree.

### Reproducibility against the 2026-11-22 trees

`sha256` of every GLB and PNG in the fresh pulls is **identical** to the trees graded on 2026-11-22 — 114 GLB + 154 PNG on `ba5`, 92 artifacts on `hb5`, 10 artifacts on `t32`. The fresh `ba5` tree holds 20 files the earlier pull did not fetch (19 `hunyuan3d2_mesh.npz` Hunyuan3D intermediates plus `dish-3d-comparison.zip`), which is why it measures 1,351,043,060 B against the earlier 808,997,625 B; no graded artifact changed.

### Provenance, textures and geometry measured

- **Input provenance is exact for all 19 benchmark inputs**: `input_image_sha256 == source_sha256` 19/19, `input_byte_identical: true` 19/19, `input_transformation: "none"` — the cutout/`input_image.png` comparison in the verifier therefore runs against the dataset photo bytes, not a re-encode.
- **Cutout evidence**: every dish's measured `alpha>=128` coverage equals its declared claim (no invented pixel, `maxRGB delta = 0`, `invented px = 0`); the only image finding is the known `image_bbox_claim_mismatch` warning on 11 reviewed-mask dishes (`5–23 px`), unchanged.
- **Textures**: all 57 successful benchmark runs and all 15 successful hero runs declare `has_texture: true` with an embedded PNG atlas that the verifier decoded; `0` non-finite POSITION/NORMAL/TEXCOORD_0 values in all 144 GLBs across the three trees.
- **Per-backend geometry (19 dishes each, from the re-merged manifest)**: MoGe-2 relief `53,108,072` B raw, `<=117,256` faces, watertight 19/19, mobile `12,933,660` B `<=34,088` faces; Hunyuan3D-2 `254,831,000` B raw, `<=800,134` faces, watertight 11/19, mobile `15,976,172` B `<=34,646` faces; TripoSG `313,297,388` B raw, `<=299,508` faces (the `MAX_RAW_FACES` cap held), watertight 0/19 as expected for dense marching cubes, mobile `29,870,496` B `<=34,960` faces. Every mobile GLB stays under the `35,000`-face ceiling and the `50 MB` byte cap.

### Re-merged five-model studio

`merge_multi_model_results.py --source hb5/results --source ba5/results --output-dir /home/yacine105/kaggle-evals/studio-20261123/results` (earliest-first) rebuilt the studio deterministically: tree `802,436,923` B, `interactive_3d_studio.html` `93,941,631` B, `comparison_viewer.html` `122,827` B — byte-identical to the 2026-11-22 merge. `verify_kaggle_outputs.py` on the merged tree returns **PASS**, 19 dishes, 114/114 GLBs, digest 0 missing / 0 mismatch, 19/19 image pairs, `0` errors, 118 warnings, `publication_eligible: false`, `merged_source_count: 2`, five slugs: `moge2-relief` 19 `success`, `hunyuan3d2` 19 `success`, `triposg` 19 `success`, `trellis2-4b` 15 `skipped`, `hi3dgen` 19 `skipped`, and `input_image_sha256` measured for all 19 inputs.

### Tooling checks run in this pass

- **PASS** — `PYTHONPATH=processing/src:processing/tests processing/.venv/bin/python -m unittest -q test_verify_kaggle_outputs test_kaggle_job_status test_merge_multi_model_results` (`Ran 45 tests`, `OK`, `rc=0`).
- **NOT RUN** — `pnpm check` (repository-wide gate); this pass changed documentation only.
- **NOT RUN** — any Kaggle push, rerun or provider API call; no code defect was found, so nothing needed a fix, a regression test or a rerun.

### Blocker unchanged

`TRELLIS.2-4B` still cannot run: `trellislast-version/32` skipped 4/4 and `hero-batch-b/5` skipped 15/15 with `missing_or_unauthorized_hf_token`, and `Hi3DGen` remains `skipped` because no `spconv` build matches cu128. Neither is a running job and a re-push is not a substitute for the secret. **User action:** Kaggle notebook UI → *Add-ons → Secrets → attach `HF_TOKEN`* to `trellislast-version`, `peekaplate-dish-3d-multi-model-benchmark-a` and `peekaplate-dish-3d-trellis2-hero-batch-b`, then re-run those kernels once.

## First live TRELLIS.2-4B meshes and the 41-dish sweep (2026-11-23, 08:36Z–10:52Z)

The token blocker above is resolved (`ERR-20261123-001`): kernels attach the private `yacine105/peekaplate-hf-token` dataset, and `hero-batch-b/6` printed `TRELLIS.2 HF token source: dataset:peekaplate-hf-token/hf_token.txt` and `TRELLIS.2 DINOv3 preflight: ok=True (ok)`. `sweep-trellis-a/1` (dishes `0:21`) printed the same two lines when it started.

### Kaggle state at 10:52Z

| Kernel / version | Status | Notes |
| --- | --- | --- |
| `peekaplate-dish-3d-trellis2-hero-batch-b/6` | `COMPLETE` (≈08:36Z–10:40Z) | `TRELLIS.2-4B` 14 `success` + 1 `skipped`, `MoGe-2` 15 `success` |
| `peekaplate-dish-3d-sweep-trellis-a/1` | `RUNNING` (pushed ≈10:41Z) | `ENABLED_MODELS=['trellis2-4b','moge2-relief']`, 21 dishes `01_pizza`…`21_corn_ribs` |
| `trellislast-version/33` | `QUEUED` since ≈08:29Z | holds the second batch-GPU slot; its 4 dishes (`01`–`04`) are also covered by `sweep-trellis-a` |
| `sweep-trellis-b`, `sweep-fast-41` | not pushed | blocked by the two-session cap |

GPU quota at 10:20Z: `13.87h` used of `45.00h` (refresh 2026-11-28).

### `hero-batch-b/6` verified (`/tmp/out-hb-6`)

`verify_kaggle_outputs.py`: **PASS**, 15 dishes, 58/58 GLBs structurally valid and digest-exact, 15/15 image pairs, 0 errors, 40 warnings (`glb_mesh_not_watertight` ×28, `image_bbox_claim_mismatch` ×11, `run_status_skipped` ×1). The single TRELLIS skip is `18_choco_cake_ice_cream`, which records `Skipped (plate_preserved is false or missing).`: its cutout fell back to `food_only_fallback`, so no plate-preserving input existed. This is a cutout gate, not a model failure.

TRELLIS settings recorded in the manifest: `pipeline_type 512`, `seed 42`, 12 sampling steps per stage, `decimation_target 300000`, `remesh true`, `texture_size 2048`, `mobile_decimation_target 34000`, `mobile_texture_size 1024`. Each dish took about 4–5 min of TRELLIS time on 2×T4 (sparse structure ≈128 s, shape ≈46 s, texture ≈36 s, decode ≈15 s, export 46–78 s).

Measured TRELLIS mesh quality (14 raw GLBs, 150,490,848 B; 14 mobile GLBs, 21,501,604 B):

| Metric | min | median | max |
| --- | --- | --- | --- |
| raw faces | 279,296 | 293,010.5 | 298,493 |
| mobile faces | 31,680 | 32,969 | 33,994 |
| index boundary edges (unwelded) | 40,032 | 104,130.5 | 151,909 |
| **welded** boundary edges | 0 | 2 | 27 |
| **welded** non-manifold edges | 52 | 337.5 | 4,704 |
| shells (welded components) | 5 | 11.5 | 109 |
| largest shell, % of faces | 53.84 | 98.59 | 99.91 |
| shells holding ≥ 1 % of faces | 1 | 1 | 3 |

Every raw GLB has two 2048×2048 textures and every mobile GLB has two 1024×1024 textures. Raw GLBs hold at most 5 degenerate triangles; the median is 37.08 B/face raw and 46.51 B/face mobile. The mesh is welded-watertight in 0 of 14 dishes, because each has at least 52 non-manifold edges.

**Plate and food as one object (measured):** in 11/14 dishes the largest welded shell holds ≥ 88 % of the faces, so the plate and food are one fused surface. Three dishes split into two large shells:

- `11_loco_moco`: shells of 155,620 and 133,214 faces.
- `12_tempura_ramen`: shells of 208,437 and 85,864 faces.
- `16_mafia_bento_box`: shells of 204,304 and 89,822 faces.

For `11_loco_moco` and `12_tempura_ramen` the second shell is a closed **square ground slab**:

- It is 1.003 × 0.004 × 1.003 and 0.995 × 0.003 × 0.995 respectively, filling the whole normalised footprint.
- Its projected area divided by its bounding-box area is 2.0 (a closed square; a closed disc would give 1.57), and 20 % of its vertices lie outside the inscribed circle.
- It sits under the food shell, with a 0.004 gap in `11_loco_moco`.

It is a reconstructed background plane, not the plate. In `16_mafia_bento_box` the second shell is 0.54 × 0.28 × 0.53, consistent with a second container in the bento.

### Verifier repair: welded topology

Index topology overstated TRELLIS open edges by about 50,000× (median 104,130.5 unwelded vs 2 welded). UV-atlased exports split every seam into separate glTF vertices, so the page showed TRELLIS as `0/14 watertight` with ~100k open edges, which read as a thin sheet. `verify_kaggle_outputs._mesh_quality` now also reports:

- `welded_vertices`, `welded_boundary_edges`, `welded_nonmanifold_edges` and `welded_watertight`, computed after exact position welding (−0.0 folds into 0.0; null for non-finite positions);
- `shell_count`, `main_shell_triangle_pct`, `shells_ge_1pct` and `shell_triangle_sizes_top5`.

The original index fields are unchanged. `build_dish_model_report.py` renders the new fields per GLB and adds four summary columns. Regressions: `test_seam_split_closed_cube_is_open_by_index_but_watertight_once_welded`, `test_two_disjoint_cubes_are_two_shells_of_equal_size`, `test_negative_zero_welds_with_positive_zero`, `test_non_finite_positions_leave_welded_topology_unmeasured`, plus summary and page assertions. **PASS:** `processing/.venv/bin/python -m unittest discover -s tests`, 778 tests, `OK`.

### Rebuilt page and merged studio

The merge used `--source /tmp/out-t32/results --source /tmp/out-b5/results --source ~/kaggle-evals/pull-ba5/results --source /tmp/out-hb-6/results`, earliest first. Use `pull-ba5`, not `/tmp/out-a3`: that tree is `benchmark-a/3`, with 19/19 TripoSG and Hi3DGen failures. Merging it by mistake turned the studio verify into `FAIL` (38 missing digests, 152 errors).

- `/tmp/peekaplate-all-models-studio/results`: **PASS**, 19 dishes, 142/142 GLBs, 0 missing / 0 mismatched digests, 19/19 image pairs, 0 errors, 136 warnings. `interactive_3d_studio.html` is 123,141,543 B; the tree is 1,005,049,592 B.
- `/tmp/report/dish-3d-model-report.html`: 77,698 B, 4 sources, 19 dishes, 5 models, `publication_eligible: false`.

| Model | success | skipped | failed | median welded boundary | median shells |
| --- | --- | --- | --- | --- | --- |
| MoGe-2 relief | 19 | 0 | 0 | 0 | 1 |
| TRELLIS.2-4B | 14 | 5 (4 old token skips from `trellislast-version/32` for `01`–`04`, 1 `plate_preserved` gate) | 0 | 2 | 11.5 |
| TripoSG | 19 | 0 | 0 | 0 | 8 |
| Hunyuan3D-2 | 19 | 0 | 0 | 0 | 14 |
| Hi3DGen | 0 | 19 (`spconv_unavailable`, cu128) | 0 | – | – |

The page still covers the 19-dish GMn9C8 set, not 41. Dishes `20`–`41` arrive with `sweep-trellis-a`, `sweep-trellis-b` and `sweep-fast-41`.

### Next quality lever (measured)

The largest remaining defect is the detached square ground slab, which takes 29–46 % of the faces in 2 of 14 dishes. Next to it are the 52–4,704 non-manifold edges that keep every TRELLIS mesh from welded watertightness. Two options:

- Drop welded shells that are flat (thickness/footprint < 0.01) and span the full footprint, then re-run the measurement.
- Or tighten the cutout so no background margin reaches TRELLIS.

Both are measurable with the new `shells_ge_1pct` and `main_shell_triangle_pct` fields.

### Sweep results (2026-11-23, 10:41Z–13:18Z)

- **`sweep-trellis-a/1`: COMPLETE, PASS.** Pulled to `/tmp/out-peekaplate-dish-3d-sweep-trellis-a-1`. 21 dishes (`01`–`21`), 82/82 GLBs valid and digest-exact, 0 errors, 54 warnings.
  - `TRELLIS.2-4B`: 20 `success` and 1 `skipped` (`18_choco_cake_ice_cream`, the `plate_preserved` gate). `MoGe-2`: 21 `success`.
  - Raw TRELLIS: 279,346–298,084 faces (median 292,594.5), two 2048 px textures each, at most 5 degenerate triangles; 220,371,444 B in total.
  - Mobile TRELLIS: 31,446–33,983 faces, two 1024 px textures each; 31,281,644 B in total.
  - Welded boundary edges 0 / 0 / 24 (min / median / max); welded non-manifold edges 53 / 413 / 4,653; welded-watertight 0/20.
  - The largest shell holds 53.82–99.97 % of faces (median 99.43). Five dishes have their largest shell below 90 % with two or more shells at ≥ 1 % of faces: `03_kimchi`, `11_loco_moco`, `12_tempura_ramen`, `16_mafia_bento_box`, `17_green_tea_tiramisu`.
  - The `seed 42` reruns of `05`–`19` reproduce the `hero-batch-b/6` shell split within ±1 % (`11_loco_moco` 156,106 / 133,696 faces vs 155,620 / 133,214).
- **`sweep-trellis-b/1`: COMPLETE, but TRELLIS did not run (blocker).** Pulled to `/tmp/out-peekaplate-dish-3d-sweep-trellis-b-1`; 20 dishes (`22`–`41`), 40/40 MoGe-2 GLBs, verifier PASS. The kernel printed `TRELLIS.2 HF token source: missing` and `DINOv3 preflight: ok=False (missing_hf_token)`, so all 20 TRELLIS runs are `skipped`.
  - Pulled `kernel-metadata.json` lists the same `dataset_sources` as `trellis-a`, and the notebook code differs only in the dish slice.
  - The token dataset still holds `hf_token.txt` (37 B, created 08:25Z).
  - `secret_source()` globs `/kaggle/input/*/*hf_token*` at a fixed depth, while dish discovery uses `rglob`. A deeper mount, or a dataset mount that failed for that session, therefore yields `missing`. The log prints no mount path, so the cause is unconfirmed (see `ERR-20261123-004`).
- **Page `/tmp/report/dish-3d-model-report.html`:** 131,602 B, 6 sources, **41 dishes**, `publication_eligible: false`.
  - `MoGe-2`: 41 `success`.
  - `TRELLIS.2-4B`: 20 `success`, 21 `skipped` (1 `plate_preserved` gate, 20 `missing_hf_token` for `22`–`41`).
  - `TripoSG` and `Hunyuan3D-2`: 19 `success` and 22 `not_run` each.
  - `Hi3DGen`: 19 `skipped` (cu128 spconv) and 22 `not_run`.
  - A sixth column, `hunyuan3d21`, shows 41 `not_run`; it was added to the builder by another concurrent writer.
- **Merged studio:** PASS, 41 dishes, 198/198 GLBs, 0 errors. `interactive_3d_studio.html` was not rewritten by this merge and still has its 10:40Z timestamp, so it predates the 41-dish data.
- **Not pushed:** `sweep-fast-41`. Its notebook was regenerated at 12:10Z by another writer outside this thread, so it was left for that writer.
