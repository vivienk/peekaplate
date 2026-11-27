# TRELLIS.2 (microsoft/TRELLIS.2-4B) model-side limits on single-image 3D quality (as of 2026-11-24)

Method note: about 14 tool calls. Fetches went through a summarizing model, so exact numbers should be spot-checked against the primary page. Sampler defaults come from the HF `pipeline.json`. Much of the competitor and leaderboard evidence is thin (see Gaps).

## 1. Architecture: where detail is lost

### Takeaway
TRELLIS.2 encodes a textured asset as an O-Voxel (sparse voxel with a dual-grid shape plus PBR attributes). A 16x-downsampling Sparse Compression VAE turns it into about 9.6K latent tokens at 1024^3. Detail is capped by voxel resolution (512, 1024, or a 1536 cascade), by the sparse decoder, and by the later remesh, decimation and UV baking in `to_glb`. The authors list sub-voxel aliasing, blending of close parallel surfaces, and small holes as limitations.

### Cited Findings
- The O-Voxel is a sparse "omni-voxel" structure with a Flexible Dual Grid for shape. Each active voxel stores PBR attributes (base color, metallic, roughness, opacity). It can represent open, non-manifold and enclosed surfaces. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- The Sparse Compression VAE downsamples 16x spatially. A fully textured 1024^3 asset becomes about 9.6K latent tokens. The ablation label "SC-VAE f16c32" suggests 32 channels, but the text does not state this. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- Each DiT has about 1.3B parameters (width 1536, 30 blocks), about 4B in total. Training used flow matching with a CFG drop rate of 0.1. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- Cascade: a 512^3 O-Voxel is downsampled to a 64^3 sparse structure to guide 1024^3 generation. For 1536^3, the 1024^3 result is max-pooled to a 96^3 structure and geometry is regenerated. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- The README lists 512^3, 1024^3 and 1536^3 modes, taking about 3 s, 17 s and 60 s on an H100. The pipeline needs at least 24 GB of VRAM. — [GitHub README](https://github.com/microsoft/TRELLIS.2), [HF model card](https://huggingface.co/microsoft/TRELLIS.2-4B)
- The default pipeline type is `1024_cascade`. — [HF pipeline.json](https://huggingface.co/microsoft/TRELLIS.2-4B/raw/main/pipeline.json)
- Export defaults in the README example: `to_glb(decimation_target=1000000, texture_size=4096, remesh=True, remesh_band=1, remesh_project=0)`, WebP textures, OPAQUE material mode. Alpha stays in the texture but is not wired to opacity. — [GitHub README](https://github.com/microsoft/TRELLIS.2)
- The ComfyUI workflow post-process is DC remesh, then QEM decimation, UV unwrap, and baking of base color, normal and AO maps. — [ComfyUI docs](https://docs.comfy.org/tutorials/3d/trellis2)
- Authors' stated limitations (Appendix F):
  - Features smaller than a voxel cause aliasing.
  - Close parallel surfaces sharing a voxel can get a dual vertex between them, and their material averages.
  - Small holes occur because the sparse decoder struggles to produce a closed manifold surface. Hole filling is usually enough to fix them.
  - There is no semantic or part structure.
  — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- The model card says raw meshes may have small holes or minor topological discontinuities. It also says the model is a pre-trained base model not aligned to human preference. — [HF model card](https://huggingface.co/microsoft/TRELLIS.2-4B)
- Paper reconstruction numbers (upper bound for the VAE, not for generation): 38.89 dB PSNR / 0.033 LPIPS on PBR attributes, and Toys4K shape PSNR 43.11 dB vs 30.29 dB for TRELLIS v1. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)

### Inferences
- Thin parts (herbs, noodles, sauce films) that are thinner than a voxel at the chosen resolution are the likeliest to alias or vanish. 1536 should help only if that mode is actually run.
- Texture detail is capped at the voxel grid. Voxel colors are baked to a UV atlas, so 4096 px textures cannot add detail beyond the voxel sampling density.
- Remesh and decimation (1M-face target) are post-hoc steps and can be tuned independently of the model.

### Gaps
- Exact latent channel count and the exact baking and remeshing algorithm parameters were not confirmed in the pages read.
- The paper's remaining sections (the last 42k characters were read only for limitations) were not fully reviewed.

## 2. Sampler settings

### Takeaway
Defaults are 12 Euler steps per stage. Guidance is 7.5 for sparse structure and shape, and 1.0 for texture (effectively no CFG). I found no controlled evidence that tuning them improves quality. The one concrete report (issue #207) shows seed variance in material prediction at 1024 and no maintainer answer.

### Cited Findings
- Sparse structure: 12 steps, guidance 7.5, rescale 0.7, interval [0.6, 1.0], rescale_t 5.0. Shape SLat: 12 steps, guidance 7.5, rescale 0.5, interval [0.6, 1.0], rescale_t 3.0. Texture SLat: 12 steps, guidance 1.0, rescale 0.0, interval [0.6, 0.9], rescale_t 3.0. All use `FlowEulerGuidanceIntervalSampler`. — [HF pipeline.json](https://huggingface.co/microsoft/TRELLIS.2-4B/raw/main/pipeline.json)
- For comparison, TRELLIS v1's README example shows 12 steps with CFG 7.5 for sparse structure and 3 for SLat. — [TRELLIS README](https://github.com/microsoft/TRELLIS)
- Issue #207: with `1024_cascade`, a navy wool suit (true metallic about 0) came out metallic on some seeds and gave a teal color shift. Mean suit metallic was 0.000 for seed 42 and 0.46 for seed 3 with one cut-out. The 512 pipeline stayed non-metallic (0.002). Small matte or resampling differences flipped the result. No maintainer response; the issue is open. — [issue #207](https://github.com/microsoft/TRELLIS.2/issues/207)
- Issue #162, "Black and reflective spots on light images", is open (title only, not read in full). — [issues list](https://github.com/microsoft/TRELLIS.2/issues)

### Inferences
- Seed variance in material is real at 1024. Best-of-N seeds is plausibly useful, especially on texture, but I found no published measurement of its benefit. This is untested.
- Raising texture guidance above 1.0 or changing the interval might stabilize materials (the #207 author asks the same), but nothing verified.

### Gaps
- No published ablation of steps or CFG on quality, and no maintainer guidance.

## 3. Training data and domain gap

### Takeaway
Training data is public 3D asset collections (Objaverse-XL, ABO, HSSD, TexVerse) filtered for PBR and aesthetics. Food or plated food is not documented anywhere I found, and no domain-gap study for food exists in what I read.

### Cited Findings
- Sources: TexVerse, Objaverse-XL (Sketchfab and GitHub), ABO, HSSD. 3D-FUTURE was excluded for lacking PBR. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- Scale: 976,736 shape assets in total, 737,962 with materials. The SC-VAE set is 473,349 shape and 354,966 material assets. The generative models use about 800K assets, augmented with TexVerse. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- Filters: only standard metallic-roughness PBR materials (about 350K assets for the material VAE), and an estimated aesthetic score below 4.5 was removed. Each asset has 16 views rendered with random FoV 10 to 70 degrees and random lighting. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- The model card gives no data details beyond "reflect the distribution of the training data". — [HF model card](https://huggingface.co/microsoft/TRELLIS.2-4B)
- Evaluation sets are Toys4K and a Sketchfab set. The user study used 100 AI-generated image prompts and about 40 participants. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)

### Inferences
- Objaverse-family data is dominated by props, characters and vehicles, with a minority of scanned or modeled food. Aesthetic and PBR filters further bias toward stylized assets. This is an inference from the dataset composition, not a measurement.
- Photographed food (translucent sauce, glossy surfaces, irregular piles) is probably out of distribution. Prediction only.

### Gaps
- No share of food assets in Objaverse-XL or TexVerse found. No published TRELLIS.2 evaluation on food.

## 4. Known failure modes and open issues

### Takeaway
Documented: small holes, non-manifold edges, an extremely high triangle count, and seed-dependent material errors. I found no GitHub issue on a ground slab or floating fragments. The slab seen in this repo's own TRELLIS output is therefore an unreported failure in my search (and my search was shallow).

### Cited Findings
- Issue #181: a census of 2,307 models across 23 generators reports TRELLIS.2-4B (n=101) at 91.1% non-watertight, 14.9% non-manifold, and 100% over 30k triangles. TRELLIS v1 (n=100) was 60.0%, 0.0% and 4.0%. This is self-reported by the issue author, with n of about 100 per model, and not independently verified. — [issue #181](https://github.com/microsoft/TRELLIS.2/issues/181)
- Issue #169: hard-thresholded logit decisions cause scattered surface holes on non-CUDA platforms (ROCm port analysis). Applies to non-CUDA runs. — [issues list](https://github.com/microsoft/TRELLIS.2/issues)
- Issue #145: "reconstructed polyhedron has a hollowed-out appearance". Issue #140: "duplicate inner mesh walls". Issue #127: "Staircase effect observed during Shape VAE reconstruction". Titles only, not read in detail. — [issues page 2](https://github.com/microsoft/TRELLIS.2/issues?page=2)
- Issue #207 (material and color error): see section 2.
- Transparency does not survive GLB export by default (OPAQUE mode). — [GitHub README](https://github.com/microsoft/TRELLIS.2)
- No issues found for: ground plane or slab, floating fragments, hallucinated backs, baked lighting, thin structures. I scanned two of about six pages of open issues and ran one web search for the slab. Treat as not confirmed absent.

### Inferences
- The slab is plausibly a data prior (assets on pedestals or ground planes in training) plus the object-on-surface framing of food photos, but no source confirms this. Post-processing, such as removing flat full-footprint shells, is the practical mitigation.
- Parallel close surfaces (plate rim against food, a thin sauce layer on a plate) fall into the limitation of blended dual vertices and averaged material.

### Gaps
- Issue pages 3 to 6 were not reviewed. No literature on baked lighting or hallucinated backs specific to TRELLIS.2.

## 5. Multi-image conditioning

### Takeaway
TRELLIS v1 has a tuning-free `run_multi_image` (stated by the authors to possibly be suboptimal). TRELLIS.2 has no official multi-image support in the README. PR #104 adds it but was not merged as far as I could tell. I found no measured benefit.

### Cited Findings
- TRELLIS v1 added multi-image on 2024-12-18 using a "tuning-free algorithm without training a specialized model", and the README warns it may not give the best results for every image. — [TRELLIS README](https://github.com/microsoft/TRELLIS)
- The TRELLIS.2 README example loads a single image and does not mention multi-image. — [GitHub README](https://github.com/microsoft/TRELLIS.2)
- PR #104 "Add multi image reference", opened 2026-02-04, adds `inject_sampler_multi_image()` with a stochastic mode (cycles through views) and a multidiffusion mode (averages views), plus `example_multi_image.py`. A commenter was working on confidence-weighted fusion. I read it via a mirror and the live status was not verified; the mirror host later failed to resolve on a retry. — [mirror of PR #104](https://gh.r-mj.com/microsoft/TRELLIS.2/pull/104) (found via search)
- The ComfyUI TRELLIS.2 workflow documented uses a single `LoadImage` input. The default model in that workflow is Pixal3D, a different model sharing most of its architecture. — [ComfyUI docs](https://docs.comfy.org/tutorials/3d/trellis2)

### Inferences
- Without training for it, multi-view fusion by averaging in sampling can produce blended or inconsistent geometry when views are not pose-registered. Food photos at differing angles may not benefit. This is an inference, not a measurement.

### Gaps
- No quantitative evaluation of multi-view input for TRELLIS or TRELLIS.2 found. The ComfyUI multi-image node claim was not verified.

## 6. Comparison with other open models

### Takeaway
In the TRELLIS.2 paper, it leads TRELLIS, Hunyuan3D-2.1, Step1X-3D, Direct3D-S2 and Hi3DGen on CLIP/ULIP/Uni3D scores and in the authors' user study. That is vendor-authored and uses 100 AI-generated prompts. I found no reliable independent leaderboard numbers.

### Cited Findings
- Paper Table 2 (CLIP / CLIP-N / ULIP-2 / Uni3D / user preference %): TRELLIS.2 0.894 / 0.758 / 0.477 / 0.436 / 66.5; Hunyuan3D 2.1 0.869 / 0.753 / 0.474 / 0.427 / 13.3; Step1X-3D 0.875 / 0.738 / 0.464 / 0.411 / 11.8; TRELLIS 0.876 / 0.748 / 0.470 / 0.414 / 6.40; Direct3D-S2 and Hi3DGen have normal-render columns only (Pref-N 12.2% and 6.57%). The authors' own tables, about 40 participants. — [arXiv 2512.14692](https://arxiv.org/html/2512.14692)
- 3D Arena (Hugging Face) is an open human-preference ELO platform for image-to-3D, with a launch paper. Fetched search results gave no current per-model ELO. — [3D Arena paper](https://arxiv.org/html/2506.18787)
- An undated post by the platform creator reportedly ranks TRELLIS second for render quality and Hunyuan3D-2 first for topology. Second-hand and not verified. — [HF post](https://huggingface.co/posts/dylanebert/577211626996199)
- Third-party sites (Pixazo, Sloyd) give 2026 scores. Pixazo itself says no public arena exists, and Sloyd is a vendor. I regard both as unreliable. — [Pixazo](https://www.pixazo.ai/leaderboard/ai-3d-model-generation), [Sloyd](https://www.sloyd.ai/blog/ai-3d-model-generator-rankings)
- Hunyuan3D 2.0 weights are open. Hunyuan3D 3.0 was launched as a hosted platform in Sept 2025. I could not confirm open weights for 2.5 or 3.0. — [Hunyuan3D 2.0 paper](https://arxiv.org/html/2501.12202v3), [Gizmochina](https://www.gizmochina.com/2025/09/17/tencent-hunyuan-3d-3-0-launched/)

### Inferences
- The paper's CLIP gaps are small (0.894 vs 0.869 to 0.876). The user-study margin is the main evidence of superiority.
- For this project, TRELLIS.2 is a reasonable top-tier open option, but TripoSG, SPAR3D, Hi3DGen (compared in paper only) and open Hunyuan3D 2.x variants have no independent food-specific comparison in my findings.

### Gaps
- No independent benchmark or current 3D Arena ELO numbers found. No data on TripoSG, SPAR3D, Hunyuan3D-2.5 or Step1X-3D beyond the paper's table. No food-specific comparison anywhere.
