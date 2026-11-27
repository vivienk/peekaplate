# Sai's infra answers for S7-VIS-06, 2026-11-24

Source: Sai's message to the user, pasted into the parent thread on 2026-11-24. These answer the ClickUp questions logged in [clickup-s7-vis-06-ownership-2026-11-24](clickup-s7-vis-06-ownership-2026-11-24.md).

- **Process:** branch from develop and open focused PRs against develop. main and the Meta staging environment stay frozen. Start with mocked provider responses.
- **Internet:** the production portion Worker stays offline. Reuse the existing private Tripo flow in a **separate 3D job service**. Tripo goes first, and only its verified API and download hosts are allowed, through Cloudflare outbound intercepts.
- **Memory:** start with standard-1 (4 GiB RAM, ½ vCPU), one decode at a time, and the 2 GB child cap. Measure peak memory across the whole container and the decode time on the largest supported GLB before resizing.
- **Secrets:**
  - MODEL_PROVIDER is regular config.
  - Sai provisions the provider key in the isolated service once the call cap is agreed.
  - A Wrangler secret is visible to the Worker it is bound to, so only the dedicated provider-calling Worker gets the key.
- **Dockerfile:** add the locked `model3d` extra in a separate 3D image or build target. Keep the extraction and portion builds unchanged. Generated GLBs stay private for review.
- **Migration:** a new timestamped forward migration on develop is fine. Use app_private, tenant RLS and narrow grants. Test concurrent dedup on the venue/draft/photo/hash/provider key, cross-tenant denial, and upgrade from the current schema. A hosted migration needs separate release approval.
- **Review:** tag Sai on the PRs. He reviews access, egress, artifact handling and retries. The test fixture and call cap must be agreed before any live run.
- **Cloudflare:** PeekaPlate account → Workers & Pages → Worker → Settings → Variables and Secrets.
  - `peekaplate-api-production` serves api.peekaplate.app.
  - `peekaplate-portion-production` serves portions.peekaplate.app.
  - Values are hidden. Send Sai the binding names needed.

What this changes in [s7-vis-06-slice3-design-2026-11-24](s7-vis-06-slice3-design-2026-11-24.md), recorded 2026-11-24:
- That design proposed adding 3D routes to the existing extraction host. Sai instead wants a separate 3D job service and Worker that holds the only provider key, with an egress allowlist.
- Slice 3 should be redesigned around that after Dec 1. Vivien made the Dec 1 deliverable 2.5D only.

## Follow-up on 2026-11-24 (11:10 PM Discord reply)

Source: screenshot of Sai's Discord reply (`Hemu77`, 11:10 PM) pasted by the user on 2026-11-24.

- **Cloudflare read access:** Sai asked for the user's Gmail address to grant read access to the PeekaPlate Cloudflare account (`51eda1917fd22a9478808a82d2980741`).
- **2.5D QA environment:** Sai confirmed `https://peekaplate.app` can be used (with a test restaurant), and noted **"the code is bugged for 2.5d"**.
- **Logs / API status:** Sai noted errors usually appear under API status in his Supabase project and suggested teammates may be able to read them ("Try asking your agent on it. Ig i set it up while setting up for peekaplate"). Code verification against `origin/develop` (`5b87c8a4`) shows:
  - The teammate read API Sai set up is `GET /team/analytics/{events,summary}` (`docs/team-data-access.md`, `backend/src/index.ts:1479-1515`), which is **staging-only** (`APP_ENV` in `['local', 'staging']`, returning `404` in production) and reads PostHog-exported staging analytics rows rather than Worker/container runtime logs.
  - Supabase API logs only cover Supabase Auth/DB requests, not Worker-to-container calls between `peekaplate-api-production` and `peekaplate-portion-production` (`portions.peekaplate.app`).
  - On `origin/develop`, `backend/wrangler.extraction.production.jsonc` sets `"observability": { "enabled": false }`, and `POST /venues/:venueId/drafts/:draftId/photos/:photoId/portion` (`backend/src/owner-menu-routes.ts:300-318`) catches all errors silently and returns `503 { error: "portion_processing_unavailable" }`.
- **Post-Dec-1 3D plan:** Unchanged from earlier 2026-11-24 rules (separate 3D job service, Tripo-only egress, `standard-1`, separate Docker target, `app_private` migration with RLS). Open items deferred to after Dec 1: 3D Worker naming convention and approval of the proposed 1/5/20 call cap.

2026-11-25 updates (pasted by the user from Discord):
- **Sai:** read-only Cloudflare access was prepared for peekaplate-api-production and peekaplate-portion-production, for the user's mooml.intern@gmail.com. portions.peekaplate.app points to the portion Worker, and production has PORTION_SERVICE_URL/SECRET set.
- **Sai on the 2.5D symptoms seen earlier:**
  - S09 saved the dish and photo, then 2.5D generation returned 503.
  - In another run, the published diner fell back to the original photo.
  - Neither was reproduced on the current release.
  - Ask: run a fresh QA dish through save photo → generate → approve → S13 publish → diner View Portion, and capture the first failing step, the UTC time and the request ID. Open the fix PR against develop.
  - /team/analytics reads staging PostHog exports, not Worker logs. Related: PR #252 (hemu77, merged 2026-11-22), "Fix production owner refresh, Actions and private 2.5D processing".
- **Vivien:** use **Tripo** for the Nov 25 phone check, with Meshy possibly later against the same reference image. Staging allows **up to 2 provider submissions per approved photo revision** and a **180 s timeout per attempt**. After a post-submission timeout, check the existing job before retrying.
- **Dev channel:** develop moved 5b87c8a4 → c66b328f (40 commits, #257-#272). Pull develop before new PRs. The local S7-VIS-06 branches need rebasing.

## 2.5D production QA, 2026-11-25 (peekaplate.app)

Run by the orchestrator in the T3 browser, as the user's new owner account.
- Venue: QA Test Kitchen (Mohammad), 520244cf-893e-4100-a3ec-468cab3325d1
- Draft: 7a73f531-36aa-4409-a977-424235594aaa
- Photo: 153d0a66-a6cb-4536-8549-85b025ec7d93, sha256 02e0a659…; the NŌKA Ikari Steak Ramen image, 754×512

Results:
1. **Menu PDF upload** (noka-food-9p.pdf, 9 pages, because the upload limit is 10). The upload group and file returned 202. The job then stayed at "Queued for processing" from 10:23Z onward. Production OCR is still pending credentials, per Sai.
2. **Save photo and generate 2.5D** (first failing step), clicked at 10:25:52Z:
   - Draft PUT 200, photo POST 201.
   - `POST …/photos/153d0a66…/portion` was **aborted by the browser at about 120 s** (net::ERR_ABORTED, 10:28:00Z). The UI said "2.5D processing failed", and a later GET /portion returned 404.
   - A retry at 10:28:30Z failed the same way.
3. A direct POST with no client timeout, 10:31:04Z → 10:34:05Z (**181.7 s**), returned **200 with `{status:"failed", message:"Cutout unavailable; original photo retained."}`**.

Two defects, as of develop c66b328f:
- **(A) Client/server timeout mismatch.**
  - The console's `request()` gives upload calls 120 s (`frontend/console/src/owner-menu/api.ts:263`, `uploadTimeoutMs ?? 120_000`).
  - The Worker allows 220 s (`backend/src/owner-portion-preview.ts`: 30 s container start + 180 s segmentation + delivery).
  - A slow but successful generation is shown as a failure, and the client disconnect may cancel the Worker.
- **(B) Server cutout times out.**
  - `processing/src/peekaplate_processing/cutout.py:31` runs the u2netp cutout in a subprocess with `timeout=180`. The model is baked into the image (Dockerfile, `U2NET_HOME=/app/models`).
  - It is not yet known why it exceeds 180 s on standard-1 (½ vCPU). Hypotheses: cold imports or numba JIT of rembg/pymatting on ½ vCPU without a writable cache; single-thread ONNX; container cold start.
  - The failure also explains Sai's earlier "diner fell back to original photo" symptom: a failed cutout keeps the original photo.
  - Container logs are needed to confirm.

2026-11-25, the 2.5D fix is in progress on local branch `fix/2p5d-portion-timeouts` (worktree t3-537ef8c5…, from develop c66b328f). It is uncommitted at first, with a finisher dispatched.
- (A) The console uses a 240 s timeout for the portion POST.
- (A2) The Worker uses `waitUntil`, so the work survives a client abort.
- (B) The cutout subprocess runs with `NUMBA_DISABLE_JIT=1` and `OMP_NUM_THREADS=1`. Root cause, per the Gemini 4 Hydrogen builder's profiling: pymatting's numba kernels recompiled on every subprocess run in a read-only container at ½ vCPU.
- Lesson: the Hydrogen/Gemini builders often end their turn while tests are backgrounded. Every brief must say "foreground, don't stop until committed".

2026-11-25: the fix was committed locally as 90898b0f on `fix/2p5d-portion-timeouts`, by YACIINE105; it is not pushed. The finisher was Gemini 4 Hydrogen high on Antigravity-pro, because Antigravity 2 was out of quota and Pi was on the free tier.
- Checks: processing 683 OK; vitest 1760 passed with 5 pre-existing skips; scripts 122/122; lint, typecheck, context and docs all PASS.
- Container repro, 0.5 vCPU, 4 GB, read-only:
  - BEFORE with only /tmp writable: 3.5 s, fallback_retained. The numba cache RuntimeError makes the cutout unavailable immediately.
  - BEFORE with a writable home: 69 s, ready, all of it JIT time.
  - AFTER: 9.4 s, ready, with an identical mask asset id.
- Production took 181.7 s, which means a writable but slower path there. The fix covers both failure modes.
- rembg `remove(only_mask=True)` never runs alpha matting; only the import triggers pymatting's numba caching.

## 2.5D production re-QA, 2026-11-26 (peekaplate.app, after OCR went live)

Run by the orchestrator in the T3 browser, same owner account and venue (520244cf…). PR #274 was open and unmerged, so production did not yet have the fix.
- **OCR:** yesterday's queued `noka-food-9p.pdf` job (633a33e0…) had completed by 09:55Z with 7 extracted drafts: MATCHA ICED LATTE, STRAWBERRY ICED MATCHA, MATCHA TIRAMISU, ZARU RAMEN (no category) and three bogus `+ $1 Oat Milk` add-on lines extracted as dishes. Sai's Discord note "QA PDF produced 7 drafts before the two-attempt limit" likely refers to this job.
- **Dish:** ZARU RAMEN, draft 4a9b12ef-9ed9-4f9a-bd71-585dcc8c57d2, photo a625d994-4a55-4a19-8b7d-e6b43ef3aee5, sha256 c783b488… (986×850 JPEG, from the NŌKA extraction).
- **S09 "Save photo and generate 2.5D"**, clicked 09:57:58Z: photo POST 200 at 09:58:08Z; the portion POST was aborted by the console at exactly 120,000 ms (10:00:08Z). The UI showed "2.5D processing failed… original photo is retained". Defect (A) reproduced unchanged.
- **Direct POST without client timeout:**
  - 10:00:24Z returned **503 `portion_processing_unavailable` in 3.2 s**, while the aborted request was presumably still running server-side. A concurrent-request 503 is new evidence and is unexplained.
  - 10:02:37Z → 10:06:00Z (**203.1 s**) returned 200 `{status:"failed", message:"Cutout unavailable; original photo retained."}`. Defect (B) reproduced, about 21 s slower than on 11-25.
  - A GET /portion after the aborted click returned 404, so nothing was stored from the aborted request.
- First failing stage: S09 2.5D generation. Approve, S13 publish and diner View Portion were not reached with a 2.5D asset.
