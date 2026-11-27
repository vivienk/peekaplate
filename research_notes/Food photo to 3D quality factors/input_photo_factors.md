# Input photo factors for single-image-to-3D quality (food dishes): TRELLIS.2 main, TripoSG / Hunyuan3D-2 / 2.1 comparison

Research date: 2026-11-24. Primary sources = code, configs, papers, maintainer replies. Vendor blogs (Tripo, fal) are labelled as such. Some fetches were summarised by a small model; code facts below were quoted from the fetched raw files at the time of research and not independently re-run.

## 1. Resolution: what the TRELLIS.2 conditioning actually sees

### Takeaway
TRELLIS.2 downsizes anything above 1024 px (longest side), crops a square around the foreground, then resamples to 512 (sparse structure) and 1024 (shape/texture) for DINOv3-L. Photo pixels above roughly 1024 on the dish itself are discarded, and a 554 px photo is only upsampled, so it carries no extra detail. Texture is predicted by the model from DINOv3 tokens, not projected from photo pixels.

### Cited Findings
- `preprocess_image`: if the input has a non-opaque alpha, background removal is skipped. The image is downscaled so the longest side is at most 1024 (`scale = min(1, 1024 / max_size)`); smaller images are NOT upscaled. Without alpha, it runs `rembg_model`. Foreground = alpha > 0.8*255. The crop is a square centered on the foreground bbox with scale factor 1 (no extra margin). RGB is multiplied by alpha (background becomes black), output is RGB. If the square runs past the image edge, PIL crop fills with zeros — [trellis2_image_to_3d.py](https://raw.githubusercontent.com/microsoft/TRELLIS.2/main/trellis2/pipelines/trellis2_image_to_3d.py)
- The crop is not resized afterwards, so its side is the foreground's larger dimension in pixels (not fixed at 512/1024) — same file.
- Conditioning: `get_cond([image], 512)` always, and `get_cond([image], 1024)` unless pipeline type is `'512'`. Negative condition is a zero tensor. Default pipeline type `1024_cascade` (512 low-res shape, then 1024 HR; HR may drop in 128 steps down to 1024 if token count exceeds 49152) — same file; default type also in [pipeline.json](https://huggingface.co/microsoft/TRELLIS.2-4B/raw/main/pipeline.json)
- Encoder is `facebook/dinov3-vitl16-pretrain-lvd1689m`; background remover is `briaai/RMBG-2.0` (BiRefNet class) — [pipeline.json](https://huggingface.co/microsoft/TRELLIS.2-4B/raw/main/pipeline.json)
- DINOv3 extractor resizes PIL inputs to `image_size` with Lanczos, converts to RGB, scales to [0,1], applies ImageNet mean/std, takes the final-layer hidden states with a parameter-free layer norm — [image_feature_extractor.py](https://raw.githubusercontent.com/microsoft/TRELLIS.2/main/trellis2/modules/image_feature_extractor.py)
- Paper: sparse structure stage uses 512x512 conditioning images; geometry and material stages use 1024 for 1024^3 outputs; DINOv3-L features — [TRELLIS.2 paper, Sec 3.3](https://arxiv.org/abs/2512.14692) (HTML: https://arxiv.org/html/2512.14692)
- A community reproduction found that resizing the photo to max side 1024 BEFORE matting/cropping vs cropping at full resolution then resizing changed the predicted metallic value on a test subject (e.g. seed 42: 0.000 vs 0.84), and sub-pixel resampling differences alone flipped material on some seeds; model is sensitive to small input perturbations — [TRELLIS.2 issue #207](https://github.com/microsoft/TRELLIS.2/issues/207) (single user report, open)
- Maintainer reply on a "flat 2D plane" report: "You may try upscaling the image and adjusting its style to make it look more like 3D rendering ... the model is a base model without post-training, so it is influenced by the training data. Some planar 2D drawings in the training set may be causing this issue." — [TRELLIS.2 issue #45](https://github.com/microsoft/TRELLIS.2/issues/45)
- fal guide (vendor): min 512x512, 1024x1024 recommended; low-resolution or heavily compressed inputs give low-quality textures — [fal.ai guide](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide)
- Comparison models: Hunyuan3D-2 shape model uses DINOv2-Giant at 518x518; the object is background-removed, resized to a unified size, centered on white — [Hunyuan3D-2 paper](https://arxiv.org/html/2501.12202). Its `ImageProcessorV2` defaults to size 512 and border_ratio 0.15, rescales the object crop with INTER_AREA and the final image with INTER_CUBIC — [preprocessors.py](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2/main/hy3dgen/shapegen/preprocessors.py). Hunyuan3D-2.1 paper also states DINOv2-Giant at 518x518 — [Hunyuan3D-2.1 paper](https://arxiv.org/html/2506.15442). Hunyuan3D-2.1 paint pipeline resizes the style image to 512x512 and renders multiview at a caller-set resolution — [textureGenPipeline.py](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/hy3dpaint/textureGenPipeline.py)
- TripoSG: DINOv2-Large local features + CLIP-ViT-L/14 global features; training foreground resized to a fixed 90% ratio and the same detection/resizing at inference; no explicit pixel resolution stated in the paper — [TripoSG paper](https://arxiv.org/html/2502.06608). Pipeline code leaves the size to the HF `BitImageProcessor` config — [pipeline_triposg.py](https://raw.githubusercontent.com/VAST-AI-Research/TripoSG/main/triposg/pipelines/pipeline_triposg.py)

### Inferences
- ViT-L/16 has 16 px patches (model name `vitl16`), so 512 gives about a 32x32 token grid and 1024 about 64x64. Any detail finer than ~16 px (at the conditioning scale) is only represented implicitly inside tokens. (Patch size inferred from the model name; the code fetched did not state it.)
- 554 px vs 2048 px: after the 1024 cap and bbox crop, a 2048 photo is downscaled; the dish bbox only needs roughly 1024 px on its long side. A 554 px photo (dish bbox even smaller) is Lanczos-upsampled to 1024 for the 1024 conditioning, so no new information. Upsampling with plain interpolation cannot help; AI upscaling adds plausible but not true detail (hallucination risk) but may help the model by making the image look sharper/render-like (maintainer suggestion above, anecdotal). Untested for food.
- Texture: TRELLIS.2 decodes PBR attributes from structured latents (paper Eq. 3), so output texture sharpness is bounded by the 1024^3 voxel grid and the token features, not by photo resolution beyond ~1024. A 4096 GLB texture bake is upsampling of voxel attributes. (Inference from architecture; no source tests photo-resolution vs texture sharpness.)
- Because the crop side equals the foreground size, a small dish in a large frame loses effective resolution only if the photo is below 1024 on the dish itself; tightly cropping before the 1024 cap raises effective dish resolution for large originals (the cap is applied to the whole image first).

### Gaps
- No controlled ablation of 554 vs 2048 px inputs for TRELLIS.2, TripoSG or Hunyuan3D found.
- No evidence tested for AI upscaling on food photos.
- Patch size and DINOv3 token grid not confirmed in fetched code.

## 2. Camera angle: top-down vs 3/4 vs low-side, flat dishes

### Takeaway
No primary source tests top-down menu photos. Training renders use varied FoV (10-70 degrees) and, for Hunyuan3D/TripoSG, elevations roughly -20..+20 / -15..+30 degrees, so a strict overhead view is likely out-of-distribution. Vendor and community advice favours 3/4 views and low perspective distortion.

### Cited Findings
- TRELLIS.2 image prompts: assets rendered in Blender with FoV randomly sampled 10 to 70 degrees (robustness to unknown intrinsics) and randomised lighting; 16 views per asset — [TRELLIS.2 paper App. C / Sec 4](https://arxiv.org/html/2512.14692). Camera elevation distribution is not stated in the text I could read.
- TRELLIS (v1): 150 views per asset rendered, image-prompt augmentation with varied FoVs — [TRELLIS paper](https://arxiv.org/html/2412.01506)
- Hunyuan3D-2.0: texture reference rendered with random azimuth and elevation -20 to 20 degrees; inference uses 4 fixed orthogonal views then 8 to 12 heuristic viewpoints — [Hunyuan3D-2 paper](https://arxiv.org/html/2501.12202). Hunyuan3D-2.1 training renders 150 cameras on a sphere (Hammersley), FoV 10 to 70 — [Hunyuan3D-2.1 paper](https://arxiv.org/html/2506.15442). Hunyuan3D-2.1 paint bake cameras include azimuths 0/90/180/270 at elevation 0 plus 90 and -90, and 30-degree-step views at +/-20 elevation with weight 0.01 — [textureGenPipeline.py](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/hy3dpaint/textureGenPipeline.py)
- TripoSG training renders: 8 random frontal viewpoints, elevation [-15, 30] degrees, azimuth [0, 180]; focal length from a list incl. orthographic, 50/85/135 mm; ablation test used 50 mm and 10 degrees elevation — [TripoSG paper](https://arxiv.org/html/2502.06608). Note orthographic is in the training list, so a near-orthographic photo is not necessarily out-of-distribution for TripoSG.
- fal guide (vendor): minimal perspective distortion, avoid extreme or fisheye perspective; "Distorted meshes suggest perspective distortion in input" — [fal.ai guide](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide)
- Tripo (vendor): a clean three-quarter view is usually best for single images; strong filters, fisheye, exaggerated perspective destabilise geometry — via [Tripo blog results](https://www.tripo3d.ai/blog/best-images-for-image-to-3d) (found via search snippet; not fully fetched, camera-angle-bias page returned 403).
- TRELLIS.2 issue #45 "Generated meshes appear as flat 2D planes": reporters used 2D-style images; maintainers attribute to planar 2D drawings in training data and suggest rendering-like style; another user attributes it to background being treated as part of object — [issue #45](https://github.com/microsoft/TRELLIS.2/issues/45) (open, single image examples)
- TRELLIS.2 issue #35 reports poor results from certain views (details not read in full) — [issue #35](https://github.com/microsoft/TRELLIS.2/issues/35)

### Inferences
- A strict top-down (90 degree elevation) photo of a flat dish shows the top surface only and no height cues, so shape model must guess height from shading/prior; depth is an under-determined prior-driven output. Expect flat or slab-like outputs and a hallucinated underside. No source measured this for food.
- A 30-60 degree elevated 3/4 view sits inside every model's training elevation range and shows rim height, bowl wall and food height. Recommend for menu photography. (Recommendation derived from training ranges plus vendor advice; untested for food.)
- Low-side views (0-10 degrees) show height/profile but hide top-surface composition (toppings), which the texture stage then has to invent.

### Gaps
- No primary evidence that near-orthographic top-down photos cause flat or stretched geometry in TRELLIS.2; only the plausible mechanism and issue #45.
- TRELLIS.2 training elevation range not found.

## 3. Background removal, mask quality, plate, ground-plane slab

### Takeaway
TRELLIS.2 expects an RGBA cutout (alpha present skips its remover); it multiplies RGB by alpha and crops a tight square around alpha > 204. Mask errors (halos, wrong threshold behaviour) leak into geometry and a flat "ground slab/floor" appears in several reports, with causes unconfirmed by maintainers.

### Cited Findings
- Preprocessing details (RGBA skip, alpha*0.8 bbox, black compositing, tight square crop with no margin) — [trellis2_image_to_3d.py](https://raw.githubusercontent.com/microsoft/TRELLIS.2/main/trellis2/pipelines/trellis2_image_to_3d.py). Default matting model is RMBG-2.0 — [pipeline.json](https://huggingface.co/microsoft/TRELLIS.2-4B/raw/main/pipeline.json)
- README gives no input-image or background-removal guidance — [TRELLIS.2 README](https://github.com/microsoft/TRELLIS.2)
- TRELLIS v1 issue "There is a floor beneath the output mesh": the original image had no floor and the cutout showed one centered object, but the mesh had a square floor. User found the floor splats were transparent in a Gaussian viewer (so invisible in RGB renders). Fixes reported: random seeds until floor vanishes; switching to RMBG-2.0 solved it for that user; switching to InSPyReNet did not — [TRELLIS issue #76](https://github.com/microsoft/TRELLIS/issues/76) (closed; user reports, mechanism unverified)
- Issue #45 reply: the model "treats the background as part of the object"; give a transparent-background PNG — [issue #45](https://github.com/microsoft/TRELLIS.2/issues/45)
- Related TRELLIS.2 remesh artifact: a blog traced holes in a bird mesh to the extraction/remesh step wrapping comb-like shapes into a slab — [Cinevva blog](https://app.cinevva.com/id/blog/2026-09-24-where-the-holes-in-generated-meshes-come-from) (secondary blog, found via search snippet only)
- ComfyUI TRELLIS.2 workflow runs BiRefNet to remove background and crops the subject to a centered canvas, with a switch to skip removal — [ComfyUI docs](https://docs.comfy.org/tutorials/3d/trellis2) (search snippet)
- fal guide: missing geometry usually indicates poor background separation; multiple overlapping objects produce inconsistent geometry — [fal.ai guide](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide)
- Hunyuan3D-2 shape: needs background removed, object resized and centered on white; alpha used as mask — [paper](https://arxiv.org/html/2501.12202), [preprocessors.py](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2/main/hy3dgen/shapegen/preprocessors.py). Hunyuan3D-2.1 paint pipeline does NOT remove background itself; it composites RGBA onto white — [textureGenPipeline.py](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/hy3dpaint/textureGenPipeline.py)
- TripoSG: training foreground at 90% of the frame; inference detects and resizes foreground to the same ratio — [paper](https://arxiv.org/html/2502.06608)

### Inferences
- Because TRELLIS.2 composites onto black (RGB*alpha) rather than white, bright halos (white/gray fringe from a white background) become visible edge rings against black; use eroded/decontaminated alpha. Hunyuan uses white, so halos matter there too but with the reverse polarity. (Inference from code; no halo-specific source.)
- Semi-transparent alpha below 0.8 does not count for the bbox but still multiplies RGB, so soft sauce/steam edges darken to black.
- Plate: a cropped plate gives a non-closed rim; the model sees the cutout edge as object boundary. A missing plate (food floating) removes the support/contact cue and makes the model invent a base - plausible source of slabs, but not documented. Keep the full plate, centered, with margin.
- Ground slab: observed in TRELLIS v1 issue #76 and in the user's own TRELLIS.2 runs (see repo handoff notes: 2/14 meshes with detached ground slab); candidate causes: matte leakage, training-prior of objects standing on a base, and remeshing. Unconfirmed.

### Gaps
- No primary source defines the "ground slab" cause for TRELLIS.2; no TRELLIS.2 issue with the exact term was found (gh search for "ground", "floor" returned unrelated hits).
- No halo-specific ablation.

## 4. Lighting, speculars, baked shadows, DoF, blur, JPEG; de-lighting

### Takeaway
TRELLIS.2 was trained with randomised lighting and predicts PBR (base color, metallic, roughness, opacity), which in principle separates material from light, but maintainers admit the ambiguity; baked lighting and color shifts remain. Hunyuan3D-2 uses an explicit image de-lighting step; Hunyuan3D-2.1 replaces it with an illumination-invariant consistency loss. No TRELLIS.2 de-lighting step exists in the pipeline code.

### Cited Findings
- TRELLIS.2 renders image prompts with randomly placed/intensity-varied lights to help predict intrinsic PBR attributes separate from illumination — [paper App. C](https://arxiv.org/html/2512.14692)
- Maintainer on large colour differences: "PBR estimation has inherent ambiguity, as the rendering result is jointly determined by material attributes (e.g., base color) and the environment lighting"; TRELLIS-1 baked these ambiguities into Gaussians; improvements planned — [TRELLIS.2 issue #43](https://github.com/microsoft/TRELLIS.2/issues/43)
- TRELLIS v1: shadows baked into texture; a user advice: feed a fully evenly lit image; specularity info then lost; another says model only supports baked lighting — [TRELLIS #20](https://github.com/microsoft/TRELLIS/issues/20), [#199](https://github.com/microsoft/TRELLIS/issues/199)
- TRELLIS.2 issue #207: 1024 texture flow predicts metal on cloth and shifts colours on some seeds while 512 texture flow is fine — [issue #207](https://github.com/microsoft/TRELLIS.2/issues/207)
- Hunyuan3D-2.0 applies "a delighting procedure on the input image via an image-to-image approach" before multi-view generation, trained on renders under random HDRI paired with even white light, to keep lighting and shadows out of textures — [paper Sec 4.1](https://arxiv.org/html/2501.12202)
- Hunyuan3D-2.1: no "delighting" term; uses an illumination-invariant consistency loss across the same object under different lighting to produce light/shadow-free albedo; Disney Principled BRDF, albedo + metallic-roughness; the 2.1 paint pipeline code fetched has no delight module — [paper Sec 3.2](https://arxiv.org/html/2506.15442), [textureGenPipeline.py](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/hy3dpaint/textureGenPipeline.py)
- fal (vendor): use consistent lighting without harsh shadows or specular highlights; the model infers depth from shading and edges so tonal separation helps; transparent or highly reflective surfaces are failure modes — [fal.ai guide](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide)
- Tripo (vendor): diffuse light avoids hard shadows being read as geometry, but flat overcast light removes shape information; soft directional light is a compromise — [Tripo summary via search](https://www.tripo3d.ai/blog/best-images-for-image-to-3d)

### Inferences
- Food photography commonly has strong specular highlights on glossy sauces and soft window light; speculars may be read as geometry bumps or baked into albedo. Soft diffuse top light with a mild gradient is the safest option. (Reasoned; no food-specific test.)
- Depth of field and motion blur: not covered by any primary source. The extractor Lanczos-downsamples, so mild blur survives only as lower-frequency token content; strong background blur is good (hides clutter) but out-of-focus dish edges degrade matting. JPEG: blockiness at 16 px patch scale is small; heavy compression mostly harms matting and fine texture. Both unverified.
- Since TRELLIS.2 pipeline has no de-lighting, any de-lighting must be done upstream (image-to-image) if desired; Hunyuan3D-2's approach shows it can be done but adds hallucination risk.

### Gaps
- No primary source on DoF, motion blur, or JPEG quality thresholds for any of these models.
- No quantitative study of baked shadow strength vs input lighting for TRELLIS.2.

## 5. Food-specific materials

### Takeaway
No source tests food explicitly. TRELLIS.2's opacity channel and open-surface support help translucent items in principle, but the O-Voxel resolution limit, near-parallel-surface blending, and holes in the paper's limitations explain why thin, glossy, translucent or repeated small items are hard.

### Cited Findings
- TRELLIS.2 limitations: features smaller than a voxel alias; when two very close parallel surfaces fall in a voxel the dual vertex lands between them and material attributes blend (blurred appearance); small holes occur in generated results; no semantic/part structure — [TRELLIS.2 paper Sec F](https://arxiv.org/html/2512.14692)
- TRELLIS.2 materials include opacity, claimed to handle translucent surfaces and thin structures/open surfaces — [paper](https://arxiv.org/abs/2512.14692). README: exported GLB is OPAQUE by default; alpha is stored in the texture but not connected to material opacity until manually connected — [README](https://github.com/microsoft/TRELLIS.2)
- TRELLIS.2 voxel resolutions: 512, 1024, 1536 (cascade); at 1024^3 voxel size is 1/1024 of the bounding box — [pipeline code](https://raw.githubusercontent.com/microsoft/TRELLIS.2/main/trellis2/pipelines/trellis2_image_to_3d.py)
- TripoSG paper notes thin-shell structures can perform worse with the SDF VAE (ablation observation) — [TripoSG paper](https://arxiv.org/html/2502.06608)
- fal: transparent or highly reflective surfaces and multi-object scenes produce inconsistent geometry — [fal.ai guide](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide)
- Tripo: single-view occlusion is a general limit (guides on occlusion/single-view limitations exist; not read in full) — [Tripo search listing](https://www.tripo3d.ai/blog/explore/ai-3d-model-generator-and-occlusion-issues-from-single-photos)

### Inferences
- Broth/sauce: glossy, reflective, translucent; single-view cannot recover volume, a specular reflection looks like texture, depth beneath surface is invisible. Model likely builds an opaque surface or a flat-top volume.
- Herbs, noodles, rice grains, sesame: thin or sub-voxel structures, each a tiny part below 16 px token scale at 1024 and below voxel size; they alias, merge into blobs or get blurred into the texture.
- Steam: not a surface; mask models cut or keep it unpredictably, producing ghost geometry or holes (matting inference).
- Small repeated items (dumplings, sushi pieces): occlusion and token-level crowding; model has no part structure so counts/shapes drift.
- All of the above are reasoned from the stated limitations, not measured on food.

### Gaps
- No benchmark or case study of food dishes for TRELLIS.2, TripoSG or Hunyuan3D found.

## 6. Official / community guidance on ideal input images

### Takeaway
Official TRELLIS.2 and Hunyuan3D repos give almost no input guidance (code defaults are the only spec). Practical guidance comes from maintainer replies, GitHub issues and vendor blogs, all of which converge on: clean cutout, centered, tight but with margin, even soft light, minimal perspective, 3/4 angle, >= 1024 px.

### Cited Findings
- TRELLIS.2 README: no input-image, preprocessing or background-removal tips — [README](https://github.com/microsoft/TRELLIS.2)
- Hunyuan3D-2.1 README: no input guidance, no delighting mention, no known-issues list; VRAM 10 GB shape / 21 GB texture / 29 GB both — [README](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/README.md)
- Hunyuan3D papers: no explicit limitations section found in the portion read — [2.0](https://arxiv.org/html/2501.12202), [2.1](https://arxiv.org/html/2506.15442)
- Maintainer guidance (#45): upscale; stylise toward 3D-render look; remove background — [issue #45](https://github.com/microsoft/TRELLIS.2/issues/45)
- Community on matting: RMBG-2.0 recommended over earlier rembg for cleaner alpha — [TRELLIS #76](https://github.com/microsoft/TRELLIS/issues/76)
- Vendor guidance (fal, Tripo): >= 1024 px, centered, neutral background, even lighting, subject filling >= 70% of frame (Tripo), 3/4 view, minimal perspective — [fal.ai](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide), [Tripo](https://www.tripo3d.ai/blog/best-images-for-image-to-3d)
- Meshy best-practice page: not retrieved (guessed URL returned 404) — not cited.

### Inferences
Practical checklist for PeekaPlate menu photos (derived; untested on food):
1. Supply your own clean RGBA cutout (RMBG-2.0 or better, alpha decontaminated, no halo) so TRELLIS.2 skips its own remover and the mask is under your control; include the whole plate.
2. Elevated 3/4 view (about 30-60 degrees), moderate focal length, no wide-angle distortion; avoid pure overhead for dishes with height.
3. At least ~1024 px on the dish's long side; cropping or upscaling below that adds nothing for TRELLIS.2 (1024 conditioning cap).
4. Soft diffuse lighting, limited speculars; check output for baked shadows.
5. Test several seeds and compare; seed variance is large (#76, #207).

### Gaps
- No Meshy best-practice page retrieved; Tripo pages only seen via search snippets; fal and Tripo are vendor, not primary.
- Hunyuan3D official issue trackers and Hugging Face Space discussions were not searched.
- TRELLIS.2 repo issues were searched via `gh` keyword search with several failed API calls (api.github.com connection errors on some queries), so issue coverage is incomplete.
