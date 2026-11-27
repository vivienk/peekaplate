# Goal (set 2026-11-24): a photoreal 3D food dish pipeline

On 2026-11-24 the user set this goal: "make a pipeline that produces high quality 3D food dishes ... real objects that look like the real food, something like GTA 6 food". It runs in its own T3 thread and is separate from the Dec 1 demo, which is 2.5D per Vivien ([clickup-s7-vis-06-ownership-2026-11-24](clickup-s7-vis-06-ownership-2026-11-24.md)).

The bar, interpreted on 2026-11-24 and to be confirmed with the user: game-quality hero props. That means:
- believable geometry from all sides
- PBR materials (roughness, normal, subsurface look) with no baked photo lighting
- clean topology, plus LODs that run on phones

Starting evidence, all dated 2026-11-24:
- [Food photo to 3D quality factors](../../reports/Food%20photo%20to%203D%20quality%20factors.md). Single-photo TRELLIS.2 output was judged "too bad to share". The causes, in order of impact: the viewer (unlit, mobile mesh), 512 px thumbnail inputs, cutouts, no clean-up, and finally the model's own limits. AAA-style food is usually photogrammetry or hand-authored, not single-image generation.
- The user-supplied Gemini research PDF "Single-Image 3D Food Reconstruction" (T3 attachment; path in the goal thread's first message).
- Earlier research: [Dish 3D model alternatives](../../reports/Dish%203D%20model%20alternatives.md).
- The local single-photo run, 28 dishes: [colab-trellis-hires-run-2026-11-23](colab-trellis-hires-run-2026-11-23.md).
- Provider and clean-up code on local branches: [s7-vis-06-slice1-provider-interface](s7-vis-06-slice1-provider-interface.md).

Constraints that carry over:
- Never push to GitHub without asking the user ([[ask-before-github-publish]] in memory).
- The staging/main freeze applies.
- Generated assets stay `publication_eligible: false` (ADR 0004).
- The machine has 15 GB RAM, so cap processes with `ulimit -v`.

## Proposal, 2026-11-24 (Claude; awaiting the user's OK)

**Quality bar ("GTA-6-like food prop"), proposed as measurable checks:**
1. Lit with a studio HDRI in a standard PBR viewer (three.js `MeshPhysicalMaterial`, ACES tone mapping), viewed in a full orbit at 0–70° elevation. There are no visible holes, ground slabs, floaters, or melted/blank backs.
2. The view at the photo's own camera angle is recognisably the same dish. Measured by side-by-side rating plus LPIPS against the photo.
3. Materials:
   - food `metallic = 0`
   - spatially varying roughness (wet vs dry)
   - micro-relief carried by a normal map
   - no baked highlights or cast shadows in the albedo (rotating the light moves the highlights)
   - clearcoat on wet areas
4. A separate, true-round plate at its calibrated size in cm. The food is its own shell resting flush on the plate.
5. LODs:
   - hero ≤150k tris with 2048 maps, its normals baked from the ~1M source
   - mobile ≤35–50k tris with 1024 maps, ≤5 MB GLB (meshopt + KTX2)
6. Human verdict: the user rates a blind turntable 1–5 for "looks like real food". Target ≥4 on hero dishes. A matte-clay render must not reveal lumps hidden by the texture.

**Honest ceiling.** AAA food is scanned or hand-authored. From one menu photo, the back is invented, so the best case is "good from the front hemisphere", and ADR 0004 keeps it unpublishable. Reaching the bar from all sides needs a capture of the real dish: 20–30 photos or a 30 s orbit video.

**Staged plan:**
1. Capture:
   - (a) existing photos, re-sourced at ≥1024 px and 30–60° elevation
   - (b) guided phone capture: a 30 s orbit or 25 photos at 45° plus 5 top-down, in soft light with locked exposure; cross-polarised for glossy dishes
2. Reconstruction:
   - single photo: TRELLIS.2 (open), with Hi3D v3 / Meshy 7 / Tripo as an API reference
   - multi-view: VGGT or COLMAP poses → 2DGS/NeuS2 mesh, or a splat (Splatfacto/Brush)
   - single photo → orbit video → 3DGS as an R&D track for soups and noodles
3. Material/PBR:
   - de-light (StableDelight / UnReflectAnything)
   - clamp metallic
   - roughness/normal maps
   - clearcoat and diffuse transmission by ingredient mask (SAM 3)
4. Cleanup/LOD:
   - split food from plate
   - drop slabs and floaters
   - swap in a template plate scaled to the calibration
   - flatten the underside
   - remesh and decimate with a normal bake (headless Blender `bpy`)
   - LOD0/1/2, meshopt + KTX2
5. Viewer/QA:
   - an HDRI PBR viewer with a contact shadow
   - automated textured, clay and relit turntables
   - optionally a VLM critic against the source photo

**Experiment 0 (no paid GPU; CPU plus the local RTX 3060):**
- Inputs: 6 existing hi-res TRELLIS.2 GLBs (~1M faces, 4K), clean 05/09/20 and bad 08/12/18, from `~/kaggle-evals/colab-run-trellis-maxdetail-20261123-155010`.
- Four conditions per dish:
  - A: as shared (mobile, unlit)
  - B: full mesh lit with an HDRI
  - C: B plus cleanup, metallic clamp, and 150k/35k LODs with baked normals
  - D: C plus food clearcoat
- Output: turntable contact sheets plus a local side-by-side viewer for a blind 1–5 rating.
- Decision rule:
  - C ≥3.5 on the clean dishes → keep a single-photo tier and spend next on inputs and an API bake-off
  - C <3 → single photo is capped, so move to capture (E1)
- Next experiments, each needing an OK:
  - E1: the user films one real dish → local reconstruction (free, needs ~5 min of the user's time; the real AAA test)
  - E2: Hi3D/Meshy/Tripo bake-off on the same 6 dishes (~$5)
  - E3: single photo → orbit video → 3DGS on one ramen (~$0.50)

Gemini comparison filed: [gemini-food-3d-report-vs-ours-2026-11-24](gemini-food-3d-report-vs-ours-2026-11-24.md).

## User answers, 2026-11-24
- Bar: **both tiers, tracked separately.** These are (1) single photo, which is good from the front hemisphere, and (2) all sides, built from extra views.
- Experiment 0: the user was unsure what it meant. Claude explained it and started it, because it costs no paid GPU (local CPU plus the RTX 3060 only).
- Capture: instead of filming, the user suggested **an AI video made from a couple of real photos**. Claude's view: 2–4 real photos taken from different sides, joined by first/last-frame video generation and then reconstructed (VGGT poses → 3DGS/2DGS), invents far less than a single photo does, because the generated frames only fill the gaps between real views. Generated frames still drift, and any invented in-between view stays `publication_eligible: false`. The video API needs credits (~$0.30–0.40 per 5 s segment, unverified), so it waits for the user's OK and for real multi-angle photos of one dish.

## Food3D V1 results, 2026-11-24

[Food3D V1 PBR and QA pipeline](food3d-v1-pbr-qa-pipeline-2026-11-24.md) records the local post-processing run on eight existing single-photo meshes. All eight met the 5.0 MiB budget at both 150k and 35k, passed glTF validation, geometry, PBR and relighting checks, and completed the 216-pose hero search. Photo-view fidelity returned five WARN and three FAIL results. Fused geometry and inferred hidden surfaces still limit the single-photo tier. Every R&D output stays `"publication_eligible": false` under ADR 0004.

Human 1–5 visual quality ratings in `studio.html` are pending. The V1 page gives the local preview command. Track 2 needs 2–4 real dish photos or a 15-second turntable orbit video for multi-view reconstruction. Paid GPU or API credits and any git commit or push require explicit user approval.

## Track 2 E1 results, 2026-11-25

Brush reconstructed three real CO3D food orbits on the local RTX 3060 at $0 paid GPU and API spend. Each dish scored against 13/13 held-out camera views at step 10,000, with mean foreground SSIM of 0.914–0.948. The orbit ingestion check produced four RGBA cutouts per video. Surface mesh and PBR extraction remain open, and all R&D outputs stay `"publication_eligible": false` under ADR 0004. [Track 2 E1 Brush results](track2-multiview-e1-brush-results-2026-11-25.md)

## Track 2B started, 2026-11-25
The orchestrator (Opus) delegated Track 2B to a Gemini 4 Neon (medium) builder on Antigravity-pro. The task: turn the three real CO3D multi-view orbits into a textured PBR mesh, locally at $0, and render that mesh at the 13 held-out camera views to compare it against the Brush splat scores. The planned route is 2DGS or expected-depth → mask-restricted TSDF → cleanup → reuse of the Food3D Blender bake, PBR and QA stages. After the builder finishes, a Gemini 4 Neon (high) reviewer will check it before results enter this page. Still waiting on the user: 1–5 ratings for Track 1 and Exp 0, an optional phone orbit of a real dish, and approval for any paid video-API or cloud spend.

## Track 2B v1 result and review, 2026-11-25
- **v1 build:** meshes from all three CO3D orbits passed the 5 MiB, validation and metallic-0 checks. Held-out mesh-albedo FG PSNR was 17.8–22.0 dB, against 30.0–32.7 dB for the splats. The sandwich reads correctly from every side, but it had a dark far side and a lumpy surface, and the hotdog stood upright.
- **Review** (Gemini 4 Hydrogen high on antigravity_3; the antigravity_2 attempt hit its quota): there is no train/held-out leakage, and the cameras are correct (IoU 0.996 against an independent raycast). The 2DGS checkpoint itself scored 29.96–32.25 dB on the held-out views, so the gap is real and comes from meshing and texturing:
  - a tensor-shape bug silently disabled the 2DGS normal-consistency loss
  - no smoothing was applied (mean dihedral 15–17°)
  - smart-UV produced 13,026 islands with 22% coverage
  - premultiplied black edges bled into the texture
  - a fixed key light darkened the far side in the turntable
  - the TSDF shrank the silhouette by 2–3 px
  - the hotdog up-axis was wrong on its portrait orbit
- **Lit-vs-photo:** the reviewer judged this comparison an unfair protocol, so it is now a diagnostic only.
- **Fix pass** delegated to Gemini 4 Hydrogen high on antigravity_4. Targets:
  - albedo FG PSNR ≥26 dB on sandwich and pizza
  - mean dihedral <10°
  - flat hotdog
  - even far side

## Track 2B v2, 2026-11-25
The fix pass made the real-capture meshes look like convincing food props from every side: smooth surfaces, even texture and correct orientation, all within 2 MB at the hero LOD. Held-out SSIM rose to 0.76–0.82, but FG PSNR is 20–21 dB against the 26 dB target. Details: [track2b-mesh-pbr-2026-11-25](track2b-mesh-pbr-2026-11-25.md). Still pending:
- independent review (Hydrogen quota)
- a texture-sharpness pass
- the user's 1–5 visual rating
- 2026-11-25 evening (orchestrator, $0, local):
  - 4096 textures gave no gain (21.17 vs 21.16 dB).
  - An outward silhouette offset gave no gain; the best offset was 0 mm on train-view IoU.
  - Error split: the sandwich is outline-dominated (input pose noise of 12.8 px); pizza and hotdog are interior-dominated.
  - The 26 dB held-out target is likely bounded by CO3D pose noise for any single-surface mesh, so the human visual rating is now the deciding gate.

## User verdict, 2026-11-25 evening
The user reviewed the Track 2B v2 turntables (sandwich and hot dog) and said: "they look so real, that is what I want". This is the human visual judgement that the quality bar named as the deciding check; it meets the bar for the multi-view (all-sides) tier. The 26 dB held-out PSNR stays a diagnostic, not a gate. The user also allowed Colab or free GPUs for the demo (no other paid spend). Subagents now run on Gemini 4 Hydrogen high on Antigravity-pro, or Codex; not Pi. Next steps:
- an independent review of v2
- packaging the multi-view pipeline as a repeatable demo path
- User rating, 2026-11-25: **pizza v2 = 3/5 ("not good")**. Sandwich and hot dog were judged real-looking.
- The independent v2 review (Hydrogen high, Antigravity-pro) verified fixes 1 and 3–9; fix 2 (Taubin smoothing) is partial. It found:
  - P1: run_track2b.sh is not portable to non-CO3D datasets.
  - P2: zero-length tangents on hotdog's intermediate 150k GLB.
  - P2: Taubin raised crease share, and pizza's dihedral rose from 5.81° to 6.74°.
  - P2: the pizza wet_fraction rose from 5% to 18%, causing a plastic sheen.
  
  These explain the pizza rating. A v3 fix pass was delegated to Hydrogen high on Antigravity-pro. A phone-video → poses builder runs in parallel.
- **Track 2B v3, 2026-11-25** (Hydrogen high, Antigravity-pro), output in `/home/yacine105/kaggle-evals/track2b-mesh-v3-20261125/`:
  - Pizza wet_fraction went from 0.178 to 0.001, so the plastic gloss is gone.
  - Pizza crease share went from 1.76% to 0.54%.
  - All 12 GLBs pass validate.
  - 75/75 tests pass.
  - Held-out scores are flat compared with v2.
  - Orchestrator visual check: the pizza now reads matte and baked, but the toppings and texture are still soft. Awaiting the user's re-rating.
- **Phone-video path working, 2026-11-25** (Hydrogen high, Antigravity-pro). `processing/scripts/food3d/video_to_dataset.py` turns a plain orbit MP4 into a Track 2B dataset with no ground-truth poses:
  - 80 sharp frames
  - batched BiRefNet masks
  - pycolmap SfM: 80/80 frames registered, mean reprojection error 0.44–0.57 px
  - a frozen every-8th held-out split

  End to end through run_track2b.sh:
  - **sandwich** held-out albedo improved from 21.16 / 0.821 / 6.58 (CO3D GT poses) to **23.86 / 0.842 / 5.18** (video poses)
  - **hotdog** went from 19.97 to 19.53 dB

  The held-out sets and masks differ (10 BiRefNet views vs 13 CO3D views), so the comparison is indicative only. Orchestrator visual check: the video-pose sandwich shows crisper, distinct ham slices. COLMAP's own poses appear more accurate than CO3D's recorded poses. Pizza via the video path has not been run yet. BiRefNet ran on CPU (~13 min per video) because it does not fit in 6 GB VRAM.
- **Pizza via the phone-video path, 2026-11-25** (orchestrator ran the existing scripts at $0):
  - `video_to_dataset.py` on co3d_pizza_orbit.mp4: 80/80 frames registered, 0.66 px reprojection error, ~15 min on CPU.
  - `run_track2b.sh` (v3 code): held-out albedo FG PSNR / SSIM / ΔE is **23.19 / 0.785 / 6.82**, against 21.88 / 0.762 / 7.94 for the v3 CO3D-GT poses. This is indicative only, because the held-out sets differ.
  - Visual check: the topping chunks are more distinct and the crust rim is cleaner than in v3.
  - Output: `/home/yacine105/kaggle-evals/track2b-video-20261125/co3d_pizza/`. Awaiting the user's rating.
- **Demo command, 2026-11-25:** `processing/scripts/food3d/food3d_demo.sh <video.mp4> <dish> <diameter_cm> [out_root]` chains video_to_dataset.py with run_track2b.sh and prints the GLB and turntable paths. Its header carries the capture tips. It is the same chain that produced the video-built sandwich, hotdog and pizza.
- **Track 2B v4 pose refinement, 2026-11-25** (opt-in `--pose-refine`, default off; Hydrogen high, Antigravity-pro; 80/80 tests pass). Results:
  - Pizza: no gain (aligned FG PSNR 21.67 → 21.44, sharpness lower, visually the same or slightly softer).
  - Sandwich: flat.
  - Hotdog: improved (aligned 20.30 → 21.50 dB), as expected since its CO3D poses are the noisiest (23 px).
  
  Decision (orchestrator): keep pose refinement off by default. For the pizza, the video-pose path (COLMAP, 0.66 px) remains the best result at 23.19 dB. The remaining pizza softness is attributed to multi-view blending over 1–2 mm geometry error, not to pose noise.
- **Demo verified end to end, 2026-11-25:** `food3d_demo.sh co3d_sandwich_orbit.mp4 demo_sandwich 22.0` exited 0.
  - Hero GLB 1.98 MB, mobile 0.97 MB.
  - Held-out albedo FG 23.93 / 0.844 / 5.15.
  - Reproduces the earlier video-path sandwich (23.86 / 0.842 / 5.18).
  
  Output: `/home/yacine105/kaggle-evals/food3d-demo-test-20261125/demo_sandwich/`.

## 2026-11-26 — Track 2B v5 pizza and sandwich results (hotdog still running)
- v5 changes: `--texture-mode best_view` (best view per chart, Potts smoothing, colour levelling, narrow seam blend), native-resolution video frames, TSDF 512³, 9k steps. Parameters were chosen on train views only.
- **Pizza:** held-out albedo FG 22.39 dB / 0.744 / ΔE 7.92, versus the video baseline's 23.18 / 0.785 / 6.82. Texture sharpness: grad +34.7%, Laplacian variance +53.5%. Seam excess ΔE 0.46. GLB 2.4 / 1.1 MiB.
- **Sandwich:** 23.69 / 0.828 / 5.71, versus the baseline's 23.86 / 0.842 / 5.18. Gradient sharpness +58%.
- Opus visual read: in `pizza_top_closeup_comparison.png` the v5 toppings, speckles and crust are clearly crisper and closer to the real photo. Seams are not visible. The pixel metrics drop slightly because sharp detail misaligned by about 1 px scores worse than blur. That is a known limit of PSNR and SSIM, so the user's visual rating decides.
- Remaining defects: the colour is slightly uneven between turntable views (one side is more orange), there is a thin flap on the crust edge at az 180, and the geometry is still soft compared with the real topping relief.
- Awaiting the user's 1–5 rating of the v5 pizza.
- Hotdog v5 (later on 2026-11-26): 20.54 / 0.766 / 8.87, up from the baseline's 19.53 / 0.755 / 9.43. Sharpness +55%. 84/84 food3d tests pass. The builder made `T2B_TEXTURE_MODE=best_view` the demo default; `blend` is still available. Opus visual read: the hotdog crust and sausage are crisper. The sandwich bread grain is sharper, but there is a small drip below the bun at az 0 and a few dark specks on the top bun. The default stays best_view only if the user rates the v5 pizza at least as high as the baseline (3).

## 2026-11-26 — Track 2B v6 defect fixes: Opus verdict
- New opt-in flags (91/91 tests pass; outputs in kaggle-evals/track2b-mesh-v6-20261126): `--mask-carve`, `--trim-drips`, `--repair-pits`, `--color-field`, `--inpaint-unprojected`.
- **Sandwich: v6 wins.** The drip under the bun is gone, the top-bun pits are smoother, SSIM 0.828→0.849 and seam ΔE 0.93→0.50. The geometry flags are worth keeping for this dish.
- **Hotdog: v6 is a regression.** At az 180, sausage-coloured patches bleed onto the inner bun lip, and the bun looks duller. Keep v5.
- **Pizza: mixed.** The colour is more even across sides but darker and muddier, sharpness dropped (Laplacian variance −22%), seam ΔE rose 0.46→0.95, and the az-180 shading matches a real shadow in the source frames. Keep v5's texture. Trimming the crust skirt is a small win.
- Likely cause: `--color-field` is too strong (it dulls and darkens), and a 2 px mask-carve tolerance mis-assigns texels on concave lips. Next step is to keep the geometry flags (`trim-drips`, `repair-pits`) on by default, leave `color-field` off, and keep `mask-carve` per dish or off. No default changed yet.

## 2026-11-26 — v7 = v6 geometry fixes without color-field and mask-carve (run by Opus; outputs in kaggle-evals/track2b-mesh-v7-20261126)
- Sandwich 22.96 / 0.850 / 5.55, seam 0.50. The drip is gone and the geometry is clean: the best sandwich so far.
- Hotdog 20.98 / 0.797 / 8.65, seam 0.31. This is the best hotdog on every metric, and the v6 bun-lip bleed is gone.
- Pizza 21.98 / 0.729 / 8.07, seam 1.05. Visually the same as v5 (sharp); the side-to-side tone follows the real lighting.
- `food3d_demo.sh` now defaults to the v7 recipe: 1920 px frames, 512³, 9k steps, best_view, trim-drips, repair-pits and inpaint. color-field and mask-carve stay off. Every value can be overridden from the environment. 91/91 food3d tests pass.
- Open: the user's pizza rating, now a choice between v5 and v7. The pizza's ceiling is likely the soft geometry of the topping relief, not the texture.

## 2026-11-26 — v8 fine-detail normals and cavity AO (opt-in `T2B_FINE_DETAIL=1`; 94/94 tests pass)
- Albedo scores are unchanged (only the material changed). Lit PSNR is 0.15–0.30 dB lower. GLBs are 3.0–3.5 MiB.
- Opus visual read on the pizza comparison: v8 is only marginally different from v7 (slightly more crevice contrast), not a step change. It stays opt-in and is not on by default.
- A bigger gap is visible: compared with the real photo, the lit render is darker, warmer and lower-contrast, and the cheese reads beige-brown instead of white. That points at the viewer's lighting and tone mapping, or at albedo de-lighting, not at the geometry. Next lever: tune the viewer and IBL exposure against the albedo and real frames, and check that the lit render matches the photo at the same pose.

## 2026-11-26 — v9 viewer lighting calibration (default `lighting=studio`; `legacy` is still available; 95/95 tests pass)
- Root cause of "dark and brown": the viewer, not the asset. It used a near-black warm IBL, warm key and rim lights, and NeutralToneMapping's 0.04 offset at exposure 0.96. v9 uses a neutral D65 tent IBL, white-balanced lights, and exposure 1.04, calibrated on train frames only.
- Held-out lit FG: pizza 20.08→21.50 dB (ΔE 12.2→8.7), sandwich 14.72→19.67 (ΔE 18.3→8.8), hotdog 13.65→18.91 (ΔE 19.9→11.0). The GLBs are unchanged (v7).
- Opus visual read: in the exact-pose comparisons the colour now matches the real photo closely, and the pizza cheese reads white. Remaining issues: the hotdog's inner bun is slightly grey-olive against a real cream colour, and the pizza micro-grit is still softer than the real food.
- This is now the best state on all three dishes: v7 assets with the v9 viewer.

## 2026-11-26 — User ratings of the v7 assets under the v9 lighting
- **Sandwich 4/5** ("the previous one were good and the current is good too").
- **Hotdog 4/5** ("it is the better than the previous one so far").
- **Pizza 3/5** ("i feel like it look like a cookie, i dont know if its quality problem or what").
- Opus read of the "cookie" look: a matte, uniformly brown, lumpy domed disc. It lacks the cues that read as pizza: the glossy, oily sheen of melted cheese, a distinct raised crust rim against a flatter cheese field, and saturated, separated toppings. The CO3D source is a small, thick pan pizza that is fairly cookie-like even in the photo, so part of this is the capture. Next steps: a gloss/roughness map for the cheese and oil (low roughness and clearcoat on bright, saturated cheese areas), and a flatter-top, crisper-rim geometry check; or a better pizza capture.

## 2026-11-26 — v10 `--bright-concave` (DeepSeek builder; 100/100 tests pass)
- Cause of the grey hotdog trough: best_view picks self-shadowed views for concave texels (trough L* 61 vs 80.6 in the real photo).
- Fix: a per-texel q60–q92 luminance band over concave texels.
  - Hotdog lit +0.14 dB; sandwich +0.11 dB; pizza lit −0.33 dB because the pizza over-brightens.
  - The flag stays opt-in and the demo default stays off.
- Opus visual read on the hotdog exact-pose comparison: only marginally less grey. The trough is still visibly greener and greyer than the real cream crumb. Not a solve.
- The builder reported that the pipeline files are being edited concurrently (the v11 gloss work), so it ran from a pinned snapshot.

## 2026-11-26 — v11 `T2B_WET_FOOD` (DeepSeek builder; 111/111 tests pass; opt-in)
- Pizza lit +0.16 dB / ΔE 8.71→8.49; sandwich +0.25 dB; hotdog −0.11 dB (its pale bun is mistaken for cheese). Not made a default.
- The builder could not view images. Opus visual read of the exact-pose comparison: v11 is nearly indistinguishable from v9 at normal size. In the 2x crop the cheese has a faint extra sheen, and it is not plastic. The moving-light sheet renders in greyscale, which looks like a renderer mode quirk worth fixing in the tool. It shows highlights moving slightly more on v11.
- Conclusion: the gloss is a correct but small lever and does not remove the "cookie" read. The remaining pizza gap is (a) the source pizza itself (a thick, very baked pan pizza), (b) under-saturated toppings (sat_p90 0.56 vs real 0.65) and (c) soft relief. The next levers are the Colab higher-resolution reconstruction (new thread) and a better pizza capture from the user.

## 2026-11-26 — v12 chroma diagnosis (Codex): colour is NOT the pizza's problem
- On 9 train poses, Lab C* median/p90 for the pizza topping proxy: real 33.2/37.9, unlit render 33.2/38.5, lit v9 render 31.7/37.3. The texture already matches the real chroma, and the v9 lighting loses only ~1.5 C*. That loss is largest on the hotdog (35.6→32.5).
- The earlier "sat_p90 0.56 vs 0.65" claim came from a different crop and measure. It does not hold at exact poses.
- Decision: no v12 saturation fix (too small to explain "cookie"). The colour-correct moving-light sheets are in track2b-mesh-v12-20261126.
- The remaining pizza levers need the user: (1) the Colab high-res reconstruction for crisper relief, which is blocked on the user's OK in that thread; (2) a better pizza capture, since this CO3D pizza is a thick, heavily baked pan pizza.

## 2026-11-26 — Colab high-res reconstruction stage (built, run on pizza)

- **Built:** `processing/scripts/food3d/colab_track2b.sh`, plus `colab_budget.py`, `colab_job.py`, `colab_remote_recon.py` and its launch/poll helpers. The shared v7 defaults moved to `t2b_v7_recipe.sh`. 130/130 food3d tests pass, including 17 Colab tests: cap arithmetic, train-only packing, GPU fallback, and teardown on failure, timeout and lost connection.
  - Packing: only the train split is uploaded; held-out images never leave the machine.
  - Remote job: starts detached and is polled every 60 s, so a dropped `colab exec` connection does not kill it.
  - Spend cap: enforced as a wall-clock limit. The rate used is the highest of reported, measured and a 4/h floor.
  - Teardown: the runtime is always stopped, and spend is logged to `<out>/colab_spend.jsonl`.
- **Problems hit and fixed during real runs:**
  - L4 "Service Unavailable" (retries, then T4 fallback).
  - Upload into a missing directory.
  - Incomplete code bundle.
  - `exec` connection loss.
  - A 1024³ TSDF was OOM-killed on the 53 GiB L4 VM; the planner now picks 768³.
- **Pizza run** (L4, 30k steps, 136k splats vs 73k, TSDF 768³ giving 1.54M raw faces): 53 min remote, 2.13 units. Total spend 4.46 of the 25 units the user approved.
- **Result:** no improvement.
  - Held-out albedo fgPSNR 21.70 vs 21.98 (v9), lit 21.25 vs 21.50.
  - Turntable (`kaggle-evals/track2b-colab-hires-20261126/co3d_pizza/eval/turntable_contact_sheet.png`): visually almost identical. Toppings are marginally crisper; the soft, rounded relief that reads as a "cookie" is unchanged.
- **Conclusion:** reconstruction compute is not the pizza bottleneck. The limits are the source capture (CO3D frames ~1016×1806, 70 train views) and the 2DGS surface regularisation, which rounds sharp topping edges. Sandwich and hotdog Colab runs were cancelled before any GPU was assigned. The remaining lever is a better capture (or a thinner, more textured pizza), not more GPU. The Colab stage stays available for user-captured high-res video.

### 2026-11-26 — v13 sharp-geometry ablation (local, $0)
- **Change:** pizza with Taubin smoothing off (`T2B_SMOOTH_ITERS=0`) and TSDF truncation 3 voxels instead of 5; everything else is the v7 recipe (`kaggle-evals/track2b-mesh-v13-sharp-20261126/`).
- **Relief:** raw-mesh mean dihedral 5.05° (v7 after smoothing: 4.14°). The crust rim is slightly more raised.
- **Held-out:** albedo fgPSNR 21.43 vs 21.98 (v9), lit 21.09 vs 21.50.
- **By eye:** close to v9, toppings still rounded. No win, so the defaults are unchanged.
- **Conclusion:** neither more compute (Colab) nor less smoothing moves the pizza. The bottleneck is the CO3D source capture.

### 2026-11-26 — Next experiment: photos → Veo orbit video → 3D (user's idea)
- The user has no pizza on hand to film. They proposed using their Google Flow credits (Veo 3.1 Ingredients-to-Video) to turn 1–3 photos into an orbit video, then running that video through `food3d_demo.sh`.
- Plan: the user generates 2–3 clips manually in the Flow web UI. Don't use `gflow-cli`: it is unofficial and drives their Google account. The prompt and three cropped CO3D reference frames are in `kaggle-evals/flow-video-test-20261126/`.
- Expected risks:
  - Generated orbits drift (toppings move or morph), which breaks pycolmap registration and blurs 2DGS.
  - Flow outputs are 720p–1080p and compressed.
  - The unseen side is hallucinated.
- If it works, it unlocks photo-only menus, which is the actual product case.
- Success checks: pycolmap registers ≥80% of frames; the turntable shows no morphing; the user rates it.
