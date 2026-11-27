# Gemini "Single-Image 3D Food Reconstruction" vs our quality-factors report (read 2026-11-24)

Source: the user-supplied Gemini deep-research PDF, "Turning a Single Dish Photo Into a Photorealistic 3D Object" (T3 attachment `7007fd05-…-db5d7a17-…-pdf.pdf`, 130 works cited). It was compared on 2026-11-24 with [Food photo to 3D quality factors](../../reports/Food%20photo%20to%203D%20quality%20factors.md) ("ours").

**Trust level:** nothing in this page was re-verified. Many claims are dated Sep–Nov 2026 and cite preprints, vendor blogs or aggregator pages. Before any spend depends on one of them, check it against its primary source. The flagged items below are the ones a plan would lean on.

## Where the two reports agree
- Inputs and capture are the biggest lever: a 35–45° view rather than top-down, soft diffuse light, at least 1024 px, a margin around the plate, no clutter.
- Multi-view capture is the only thing that adds real information. Single-photo backs are hallucinated.
- Cleanup is needed: floaters, a fused plate, slabs and the underside.
- Ramen, noodles, salads and glossy broth are the hardest category for single-photo meshes.
- Commercial single-photo APIs share the single-view ceiling.

## New in Gemini (not in ours)
1. **Food shading is the "anti-plastic" step.** Use glTF `KHR_materials_clearcoat` for wet oil and glaze over a rough base, and `KHR_materials_diffuse_transmission` plus `KHR_materials_volume` (IOR 1.3–1.33) for rice, cheese, fish and leaves. Set `metallicFactor = 0` on all food. The physics rationale is Jensen et al. 2001 (BSSRDF). USDZ Quick Look keeps clearcoat but drops diffuse transmission.
2. **De-lighting before texturing.** StableDelight, UnReflectAnything (Dec 2025, specular removal) and Colorful Diffuse Intrinsic (SIGGRAPH Asia 2024). Feed the original photo to geometry and the de-lit albedo to texture.
3. **Swap the AI plate for a template plate.** A clean CAD plate of known diameter fixes warped rims and sets metric scale. This matches our owner plate calibration in cm.
4. **Track B: one photo → generated 360° orbit video → 3DGS.** Pin the photo as the first and last frame (MiniMax H3 FL2V, WarpHammer-GEN3C), recover poses with analytical circular poses or VGGT, train Splatfacto/2DGS, then prune. The claim is that this is best for ramen, soup and gloss. Frontier: **VideoRNG** (claimed arXiv:2611.25338, 2026-11-19), relightable Gaussians from a turntable video, reported +4.79 dB PSNR over TRELLIS.2 on thin/fuzzy assets. *Unverified.*
5. **The splat delivery picture is more favourable than ours assumed.** It cites `KHR_gaussian_splatting` (Khronos, Feb 2026), .spz/.sog at 2.9–5.8 MB for 262k degree-3 splats, and WebGPU sorting in Safari 26 and three.js r186. Our earlier report rejected splats on payload and licence, but that applied specifically to Apple SHARP. *Re-check before relying on it.*
6. **Independent ranking: the Rapidata image-to-3D human-preference leaderboard** (claimed 357 inputs, 314k votes, as of Nov 24). Hi3D v3.0 #1 (1393), Meshy 7.x #2–3, Tripo #4, Hunyuan3D 3.1 Pro #5, Seed3D 2.0 #6, TRELLIS.2 #7 (1014), open Hunyuan3D 2.1 #12 (760). *Unverified; check benchmark.ai/image-to-3d before choosing an API.*
7. **SUPRA-Tex** (claimed arXiv:2610.22352): estimate → align → complete texturing, which keeps photo pixels locked to the surface. Reported +5 dB on the foreground. *Unverified.*
8. **TRELLIS.2 LoRA fine-tune recipe** (claimed HF blog, 2026-11-12). Train only the sparse-structure and shape DiTs and freeze texture. Estimated at about 25.6 A100-h on MetaFood3D (743 real scanned foods) plus OmniObject3D. *Unverified; also blocked by the dataset licences.*
9. **Sprint3D** (claimed): 85% of TRELLIS.2 latency is CPU post-processing (UV unwrap). Matches our trellis-run-profile timing.
10. **An automated QA gate.** Run a glTF validator and budgets, then 6–8 turntable views in textured, matte-clay and relit modes, then a VLM critic that compares the views with the source photo. Re-seed up to 2–3 times, then send to a human.
11. **Delivery budgets.** BeforeTable ≤22k tris / 512 px / <1 MB. Android ≤50k tris, 2–5 MB, Draco/Meshopt and KTX2. iOS 30–100k tris with 2048 maps.
12. **The appetite and "food uncanny valley" evidence.** Diel et al. 2025 (realism vs uncanniness is a cubic curve). Frontiers VR 2023 (lowering mesh or texture quality reduces desire to eat, with a ceiling). Disclosed-AI food lowers perceived value. Supports ADR 0004's caution.
13. **Photogrammetry tip:** cross-polarised light (CPL filter plus polarised LEDs) stops glossy sauce from breaking the reconstruction.
14. **Industry precedent:** BeforeTable and ART use 20–30-photo phone scans (25 at 45° plus 5 top-down), not single-photo AI. KIRI Engine (free) is used by ART.

## Where they disagree or Gemini overreaches
- Gemini says TRELLIS.2's O-Voxel "natively retains open thin surfaces (lettuce, basil, chips)". Our measurements and the paper (Appendix F) show sub-voxel aliasing and blended close parallel surfaces on noodles, herbs and sauce rims. Ours is measured; Gemini's is a marketing-style claim.
- Gemini puts single-photo firm dishes at "production-ready". ADR 0004 still forbids publishing invented edible surfaces, so that verdict does not transfer to PeekaPlate publication.
- Gemini's cost figures ($0.50–$1.01 per dish) are composites of vendor list prices with no measured runs.

Related: [goal-photoreal-food-3d-pipeline](goal-photoreal-food-3d-pipeline.md), [model-survey-2xt4-2026-11-23](model-survey-2xt4-2026-11-23.md).

## Primary-source verification status (checked 2026-11-24)
Web checks against primary project pages, Khronos/Three.js, arXiv, and official video API rate cards:

| Claim | Status (2026-11-24) | Primary evidence / discrepancy |
|---|---|---|
| **Rapidata image-to-3D leaderboard** (`benchmark.ai/image-to-3d`) | **Methodology & contenders verified; exact Elo snapshot unverified** | Crowdsourced blind pairwise turntable Elo across Overall, Geometry (untextured), and Appearance (textured) with Hi3D v3.0, Meshy 7.x, Tripo H3.1, and TRELLIS is confirmed. Exact point scores (1393 vs 1014) were not fetched live from the interactive leaderboard. |
| **`KHR_gaussian_splatting` & `.spz`/`.sog` in Three.js** | **Verified (directionally)** | Khronos Group released `KHR_gaussian_splatting` for glTF 2.0; Three.js has native Gaussian Splatting loading (`.ply/.splat/.ksplat/.spz/.gltf`) with WebGPU GPU counting sort and async sorting workers; `.spz` (Niantic) and `.sog` (PlayCanvas) shrink 3DGS payloads ~10–20×. Exact Safari 26 / r186 release versions remain to be tested on target devices. |
| **StableDelight / UnReflectAnything** | **Verified (papers & code exist)** | `Stable-X/StableDelight` (one-step diffusion specular/highlight removal) and `UnReflectAnything` (arXiv physics-rendered RGB highlight removal) exist as published methods. Neither is benchmarked on PeekaPlate food photos yet. |
| **VGGT / 2DGS / Brush** | **Verified** | `facebookresearch/vggt` (feed-forward multi-view camera + depth/point estimation), `hbb1/2d-gaussian-splatting` (SIGGRAPH 2024 planar surface splats with TSDF mesh extraction), and `ArthurBrussee/brush` (cross-platform WebGPU 3DGS) are real, open-source repositories. |
| **VideoRNG (`arXiv:2611.25338`) & SUPRA-Tex (`arXiv:2610.22352`)** | **Papers verified; exact food PSNR gains unverified** | Both arXiv IDs, author groups (NVIDIA/UCSD/Manchester for VideoRNG; Huawei/SJTU/HUST for SUPRA-Tex) and methods match. Neither paper's food-specific delta (+4.79 dB / +5 dB) has been independently reproduced locally. |
| **FL2V video API pricing (MiniMax H3, Kling, Wan)** | **Verified ballpark ($0.25–$0.55 per 5 s 720p/768p clip)** | MiniMax H3 (Hailuo) officially supports native First & Last Frame (FL2V) at $0.06–$0.08/s for 768p ($0.30–$0.40 per 5 s) and $0.13/s for 2K; Kling 1.6+/2.5 Turbo 720p runs ~$0.056–$0.08/s; Wan 2.2/3.0 720p runs ~$0.05–$0.11/s (480p $0.02–$0.054/s). |
