# Our own PeekaPlate pipeline: what degraded the TRELLIS.2 dish results

All numbers below are my own measurements on local files (read-only, under `ulimit -v 3000000`, one GLB per process, only 3 `*_hires.glb` decoded for textures; others read by JSON header only), unless marked "wiki" (copied from project notes) or "unverified". Scratch scripts are in the session scratchpad `pk/` folder. Results folder: `/home/yacine105/kaggle-evals/studio-split-colab/results/<label>/`. 28 of 41 dishes have a `trellis2_4b_hires*.glb` (01-28).
No web sources were used; the "Cited Findings" below cite local files.

## 1. Input photos and cutouts

### Takeaway
Inputs are small, blurry web thumbnails (short side almost always 512 px, 04 has 415), mostly 3/4 eye-level or oblique views with baked drop shadows; the cutouts are generally well centred with plate included, but some include the shadow and a few are cropped by the frame. This is the weakest link and is entirely our choice of source material.

### Cited Findings
- Resolution of all 41 `input_image.png` (measured with PIL): 01 = 554x554; 02 = 800x560; 03 = 2000x1125; 04 = 739x415; 15 = 986x850; 16 = 967x1104; all other 05-41 have a short side of exactly 512 (e.g. 523x512, 690x512, 512x554), long side 512-902. So about 35 of 41 are ~512 px thumbnails. Visual check: soft, JPEG-compressed, little texture detail (view of 22/28/26/24 and 8-dish sheet). — measured, `.../results/*/input_image.png`
- Cutout alpha (`cutout_rgba.png`, same size as input): coverage 38-79% of the frame; bounding-box margins mostly 40-70 px on each side (well centred, centroid x 0.47-0.52). Frame-cropped (margin 0): 02 (L/R 0), 04 (L/R/T 0), 15 (L/R 0), 17 (L/R 0, B 2), 19 (R 0), 18 (T 0). Soft/semi-transparent alpha fraction 0.8-2% for 01-04, 15-19 and 3-7% for 07-14 and 20-41 (highest 12 and 11 at 6.7%). — measured
- Plate is INCLUDED in the cutouts of all dishes I viewed (pizza with its dark pan rim, lobster plate, loco moco pan, tempura bowl, karaage bowl, sprouts bowl, rice bowl, bento tray). Halo: pizza cutout keeps a ragged dark pan/background rim; 08 (lobster) and 12 (tempura) cutouts keep the soft grey drop shadow under the plate as opaque/semi-opaque foreground (visible as purple fringe on magenta backdrop). — measured/visual (sheet of 8 dishes)
- Camera angle (visual, 8+4 dishes): pizza (01) top-down; 28 edamame top-down-ish; all ramen/bowl dishes (05, 08, 12, 13, 20, 23, 31, 22, 26, 24) are 3/4 oblique at roughly 30-45 degrees elevation; 16 bento is a ~top-down angled flat-lay with a separate bowl. Mixed viewpoints across the set. — visual
- Settings: the generator calls `pipeline.run(rgba, pipeline_type='1024_cascade')` with no steps/CFG/seed/sampler override, then `mesh.simplify(16777216)`. The RGBA is built from the original-size photo plus the mask resized to the photo size (`.resize((w,h))`); there is no upscaling, padding or sharpening in our code. — `/home/yacine105/t3-code-handoff/peekaplate/processing/scripts/build_colab_notebooks.py` lines 697-713, 527-538
- Masks: for dishes without a reviewed mask the Colab run used Kaggle sweep-A cutout masks (originating from a Kaggle rembg/BiRefNet-type stage, wiki says masks were "derived from Kaggle sweep-A cutouts"), because CPU BiRefNet OOM-killed at 53 GB and the TRELLIS loader's RMBG-2.0 was stubbed out. — `research_notes/wiki/colab-trellis-hires-run-2026-11-23.md`

### Inferences
- TRELLIS.2 conditions on a ~512-class image (my recollection of the repo's DINOv3 conditioning, unverified locally), so our 512 px inputs are close to the model's native conditioning size; the loss is that the photos are already low-quality thumbnails, not that they were downscaled further. The problem is source detail, not resolution mismatch.
- Baked drop shadows kept as foreground plausibly cause the flat square "ground slab" shells (see section 4), because the generator must give the dark shadow area some geometry.
- Oblique 3/4 views hide the top of piled food and give the model almost no information about the back side: expected cause of flat/collapsed geometry on piled dishes.

### Gaps
- Defaults for TRELLIS.2 sampler steps/CFG/seed not verified: the TRELLIS.2 package is not installed locally and I did not fetch the README. Our code leaves them at library defaults.
- Whether TRELLIS.2's internal preprocess crops to the alpha bbox / resizes to a fixed size was not verified.

## 2. Export: full vs mobile

### Takeaway
Full export is ~0.93-1.0M faces with 4096 textures, mobile ~33-35k faces with 1024 textures (about 28x fewer faces, 16x fewer texels). The 4096 texture holds far less real detail than its size suggests, so the mobile texture loses less than the numbers imply, but it is still visibly softer, and the face decimation is where silhouette/fine geometry (grains, noodles, fried coating) is lost.

### Cited Findings
- Face/vertex/texture/size (GLB JSON header, measured). 01_pizza: hires 964,935 faces / 649,247 verts, two 4096x4096 WebP textures (base colour 3.65 MB, metallic-roughness 1.13 MB), file 37.1 MB; hires_mobile 34,565 faces / 24,754 verts, 1024x1024 WebP textures (236 KB + 77 KB), 1.52 MB; earlier Kaggle `trellis2_4b` 297,636 faces / 2048 textures / 11.5 MB; `trellis2_4b_mobile` 32,220 faces / 1024. 08_lobster: 956,030 -> 34,718 faces; 12_tempura: 983,953 -> 33,671; 23_sprouts: 989,758 -> 33,010. Across 28 dishes full faces are 928k-998k and mobile 32.4k-35.0k. Decimation ratio about 28x; 4096->1024 texture is 16x fewer texels. All single mesh, one material, `EXT_texture_webp`, vertex normals present. — measured
- The 4096 base colour texture is very smooth: mean absolute Laplacian over occupied texels is 12.3 (pizza), 4.0 (lobster), 3.9 (sprouts); downsampling the same texture to 1024 raises it to 52.4 / 18.5 / 21.2 and to 512 to 81.7 / 31.8 / 38.4. A genuinely 4K-detailed texture would not gain 4-5x sharpness on a 4x downsample. So effective colour detail is about 1024 or less: consistent with the `1024_cascade` voxel grid (1024^3 voxels baked into a 4096 atlas = about 4x oversampling). — measured (`tex.py`)
- Mobile 1024 textures are softer than a clean downsample of the full texture: Laplacian 27.4 / 9.7 / 6.9 vs 52.4 / 18.5 / 21.2. Caveat: the full and mobile have different UV atlases (occupied fraction 0.42 vs 0.41 pizza, 1.0 vs 1.0 lobster), so this is a statistics comparison, roughly 1.5-3x smoother, not a pixel diff. — measured
- Texture data is mostly empty: 01 base colour texture is only 3.65 MB at 4096 (about 0.9 bytes/texel after WebP) because 58% of the atlas is unoccupied (occupied 0.42). — measured
- Mobile export re-runs `o_voxel.postprocess.to_glb` with `decimation_target=35000, texture_size=1024, remesh=True, remesh_band=1, remesh_project=0.0` from the same latent, not a decimation of the full mesh. Raw export uses 1,000,000/4096 (`QUALITY='max'`) or 300,000/2048 ('standard'). — build_colab_notebooks.py lines 202-204, 515-538, 729-738
- Metallic-roughness map content: roughness mean 0.40 (01 pizza, 08 lobster) but 0.96-0.97 (12 tempura, 23 sprouts); metallic mean 0.01-0.14. Material factors are metallic=1.0, roughness=1.0 multiplying the map. — measured (`mr.py`)

### Inferences
- Decimating to 35k faces keeps the dish blob but removes small-scale relief; combined with a texture already limited to ~1024 effective detail, the visible loss is softer colour and lumpy silhouettes. The 4096/1M "max" run bought almost no extra visible detail over 2048/300k (colour detail is voxel-limited), at 4x the file size and ~20 credits.
- The mobile model is what the share page displayed, so the user saw the weakest variant.

### Gaps
- I did not render full vs mobile side by side (loading 1M faces + offscreen GL was out of the memory budget), so the "visual detail lost" is inferred from texture statistics and face counts, not a screenshot comparison.

## 3. Viewer (shared page)

### Takeaway
The share page replaced every material with unlit `MeshBasicMaterial` (base colour only) on the 35k-face mobile mesh, which removes shading, specular and normal-based depth cues. With a noisy low-poly surface and no lighting, food reads as a flat sticker-like blob; lit PBR would reveal form and sheen but also expose mesh noise.

### Cited Findings
- Template: `o.material = new THREE.MeshBasicMaterial({ map: src.map, color: src.color, vertexColors: ..., side: THREE.DoubleSide })`; no lights are added to the scene; only `renderer.outputEncoding = sRGBEncoding`, three.js r147 from CDN, camera 35 deg FOV at (0, 0.62s, 1.05s). The page text states "35k-face mobile model in base colour". — `/tmp/claude-1000/.../scratchpad/trellis-share/template.html` lines 60, 88-90, 112-155
- The GLB's metallic-roughness texture, normals and PBR factors are all discarded by that material swap. The mobile GLBs do contain per-vertex normals and a metallicRoughness map (measured above). — measured
- Prior diagnostic renders (Kaggle 512-run `trellis2_4b_hf_modes.png`, 08 and 12): the "Normal" mode shows speckled, high-frequency faceted normals, the "Clay" mode shows jagged, terraced shading, and in 12 a large square ground plane under the bowl. These are from the earlier 300k Kaggle meshes; they indicate noisy geometry that unlit rendering hides but a lit viewer would expose. — visual, `.../08_lobster_shio_ramen/trellis2_4b_hf_modes.png`, `.../12_tempura_ramen/trellis2_4b_hf_modes.png`

### Inferences
- Unlit rendering takes away shading, ambient occlusion (the AO/R channel in the MR map is ~0.0-0.01 anyway, so TRELLIS baked none), and specular highlights, so geometry carries no visible depth: the only cue left is the photo-derived base colour with the shadow/lighting of the original photo baked in. Baked-in photo lighting plus no real lighting looks flat, and any mis-projected colour (the back side was hallucinated) is not masked by shading.
- A lit PBR full model would show wet/glossy highlights on plates and sauces (roughness 0.4 on pizza/lobster), true normals, and real silhouette from 1M faces, but those same normals also show the geometric noise seen in the "Normal"/"Clay" modes. So a lit viewer improves perceived quality only if the mesh is also cleaned.
- Unlit rendering is a viewer choice we made, probably to avoid a black/shiny look under a missing environment map (metallic factor 1.0 with no env map renders dark in lit three.js). That is a tooling shortcut, not a model flaw.

### Gaps
- I did not render the same GLB lit vs unlit (no headless GL under the memory budget), so the size of the perceptual gap is not quantified.

## 4. Mesh defects measured on mobile GLBs

### Takeaway
Most dishes are a single clean shell after proper welding, but 5 of 28 have a large flat ground/plate slab or a lost major part, and the mesh has hundreds of non-manifold edges on several dishes. These defects are TRELLIS output interacting with our inputs (plate + shadow included, oblique views), not export artefacts.

### Cited Findings
- Method: trimesh load, `merge_vertices(merge_tex=True, merge_norm=True)` (needed, otherwise UV-seam splits inflate shells to 400-2600 per dish: 01 pizza 1,054 naive vs 24 welded), edge-connectivity components. Per dish below on the 35k mobile mesh. — measured (`slab.py`, `mesh.py`)
- Shell counts (welded, all-shared-edge): 1 shell for 02, 09, 11, 14; 2 for 04, 05, 06, 12, 19, 20, 23; 3 for 22, 28; most others under 16; outliers 26_chashu_pork_bun 88 shells (main shell 51.6%), 17_green_tea_tiramisu 49 shells (main 90.1%), 01_pizza 24 shells (main 96.0%), 03_kimchi 16, 10 13, 25 12, 21 11.
- Ground slab / plate-fused flat shells (flat shell extent y < 0.06 and footprint > 0.5 of the bounding box): 08_lobster_shio_ramen 24.4% of faces (plus a third near-zero-thickness shell, 5.7%, extent 0.97x0.00x0.97), 12_tempura_ramen 22.3% (1.0 x 0.02 x 1.0 square), 26_chashu_pork_bun 51.6%. The wiki already named 11_loco_moco and 12 for slabs in the earlier Kaggle run; in the hires mobile run 11 is a single clean shell (1 shell). 22 and 28 flagged 99% but there the whole mesh is a single flat shell (height/width 0.04), i.e. a collapsed shape not a slab. — measured; wiki `trellis-run-profile.md`
- Non-manifold edges (shared by >2 faces, mobile): 26 chashu bun 2,777; 07 pikachu burger 1,609; 12 tempura 646; 03 kimchi 642; 16 bento 458; 13 crabby 409; 08 lobster 350; 10 short rib 347; 25 gyoza 280; 17 tiramisu 227; 01 pizza 176. Others 2-60. Boundary edges (welded) are 0-99, i.e. near-closed. — measured
- Main-shell share below 80% (lost/fragmented structure): 18_choco_cake_ice_cream 59.7%, 16_mafia_bento_box 72.6% (but 2 big shells = bowl + tray, expected), 08 75.5%, 12 77.7%. Wiki (full max-detail run, 23 dishes): main shell <80% on 08 (62.9%), 12 (64.2%), 18 (61.0%). — measured; wiki `colab-trellis-hires-run-2026-11-23.md`
- Height/width ratio of the mesh bbox (Y extent over the larger of X/Z): 0.04 on 22_shishito_peppers and 28_chamame, 0.09 on 20_chicken_karaage, 0.11 on 23_brussels_sprouts, 0.12 on 01 pizza and 09 ramen (reasonable for pizza, too flat for a ramen bowl), 0.25-0.33 for several bowls (02, 06 0.44, 12 0.33, 24 0.83). Bowls and piled dishes (22 peppers in a deep bowl, 23 sprouts, 20 karaage) come out compressed, the top-down dishes come out flat. — measured; bowl proportions judged visually
- Earlier wiki measurements for comparison: TripoSG 22,867 edges of degree >= 4 (21,163 naive shells -> 101 with all-shared-edge components); Hunyuan3D-2 pizza stood upright (bounds 0.24x0.24x0.016 m, `orientation_suspect`); TRELLIS 2.5k-order shell counts were an artifact of UV seams (wiki correction 2026-11-23). — `research_notes/wiki/s7-vis-06-slice1-provider-interface.md`, `trellis-run-profile.md`
- TRELLIS orientation: all measured mobile TRELLIS GLBs have Y as the shortest axis (ext y 0.09-0.33 vs x/z about 1.0), so they stand correctly (no upright-pizza problem for TRELLIS, unlike the Hunyuan3D-2 pizza). — measured

### Inferences
- Slabs are present in dishes where the photo has a drop shadow (08, 12 both have 6% soft alpha containing shadow) or a plate flat on a surface (26), but not in every shadow dish (10, 11, 14 have 5.7-6.7% soft alpha and no slab), so the shadow is a contributing but not sufficient cause.
- Non-manifold edges are highest on structurally complex dishes (bun with greens, burger, kimchi, bento), so they follow food complexity rather than export settings.

### Gaps
- I did not measure the full 1M-face meshes' topology (memory budget); wiki figures for the full max-detail run are copied above, not mine (median 4 shells, median welded boundary 3).
- Fraction of dishes the user considered "bad" is not recorded, so no regression against user judgment.

## 5. Per-dish pattern

### Takeaway
Best-looking candidates (my structural ranking, not a user rating) are single-shell, near-closed bowls/plates with simple, whole contents: 02, 05, 09, 11, 14, 19, 20, 23. Worst are layered or piled dishes with fine parts, or with a plate slab: 26, 08, 12, 18, 07, 17, 16, 22, 28.

### Cited Findings
- Clean group (1-2 shells, main >= 99.9%, non-manifold <= 60): 02 tteokbokki, 04 gimbap, 05 ikari ramen, 06 shrimp, 09 kuroshio ramen, 11 loco moco, 14 chahan, 19 ice-cream sandwich, 20 karaage, 23 sprouts, 15 zaru ramen (7 shells but main 99.3%). — measured
- Problem group: 26 chashu bun (88 shells, 52% slab, 2,777 non-manifold), 08 lobster ramen (24% slab, main 75.5%), 12 tempura ramen (22% slab, 646 non-manifold), 18 choco cake (main 59.7%, cutout cropped at top, wiki: plate guard skipped it in the Kaggle run), 07 pikachu burger (1,609 non-manifold), 17 tiramisu (49 shells, cutout cropped L/R), 22 peppers and 28 edamame (collapsed to flat shell). — measured
- Dish-type correlation (my reading of 12 viewed inputs plus metrics): flat top-down plates (pizza 01, 28 edamame) give flat but well-formed meshes with small stray shells (01: 24 shells, 176 non-manifold); bowls seen obliquely (05, 09, 11, 14, 20, 23) are generally clean; piled foods with small repeated parts (karaage, sprouts, peppers, edamame, gyoza, fries) get compressed heights (0.04-0.11 height ratio on 22, 28, 20, 23) and a smoothed surface where individual items are lost; multi-component or garnish-heavy dishes (bun 26, burger 07, bento 16, kimchi 03) have the most shells and non-manifold edges. — measured/visual
- Texture is a separate issue from mesh quality: all dishes have the same 4096/1024 specification, but texture detail depends on the 512-px input, so apparent sharpness is bounded by the photo. — measured

### Inferences
- Poor results are concentrated in dishes that need genuine volume reasoning (piles, layers, garnish) and in photos with baked shadows; simple bowls do fine. This matches the intrinsic limit of single-view image-to-3D rather than a systematic pipeline fault.

### Gaps
- No user per-dish rating exists in the files I read, so "best/worst" is structural, not perceptual.

## 6. Ranked likely causes (our choices vs model limits)

### Takeaway
Ranking of what most plausibly degraded the shared result: (1) viewer choice (unlit base-colour, 35k mobile mesh), (2) low-quality 512-px thumbnail inputs with oblique angles and baked shadows, (3) 35k-face / 1024-texture mobile export, (4) cutout shadow/crop issues producing slabs and cropped plates, (5) no lighting/env/AO and no mesh clean-up post-process. Intrinsic model limits (collapsed piles, hallucinated back side, non-manifold noise) are real but are amplified by the first three.

### Cited Findings (ordered)
1. Viewer (our choice, certain): unlit `MeshBasicMaterial`, 35k mobile mesh, no lights, no normals/roughness (template lines 152-155). Largest direct cause of the "flat sticker" look; fully under our control. Evidence: code above.
2. Input quality (our choice, certain, high impact): about 35 of 41 photos are 512-px-short-side thumbnails with JPEG blur; baked lighting and shadows; oblique angles; mixed viewpoints. Evidence: measured resolutions, visual.
3. Export spec (our choice): mobile 33-35k faces and 1024 texture re-baked with `remesh=True`, 28x fewer faces than full; 4096 texture is oversampled (Laplacian 4x lower at 4096 than at its own 1024 downsample), so "max" quality was mostly wasted while mobile loses the fine structure. Evidence: measured.
4. Cutout/mask: shadow retained (08, 12), frame-cropped dishes (02, 04, 15, 17, 18, 19), plate included so food and plate fuse in one mesh (wiki: "plate/food separation is the open quality issue"); ground slabs on 08 (24%), 12 (22%), 26 (52%). Evidence: measured; partial correlation only (2 of 5 high-soft-alpha dishes, 08 and 12, show slabs; 10, 11, 14 do not).
5. Mesh clean-up not applied to the shown model: non-manifold edges (up to 2,777), stray shells (up to 88) and slabs were displayed as-is; the repo's own postprocess (slice 2) removes small shells/slabs but was not in the share path. Evidence: measured, wiki `s7-vis-06-slice1-provider-interface.md`.
6. Model limits (not our choice): single-view reconstruction hallucinates back/occluded parts, compresses piled food (height ratio 0.04-0.11 on peppers, edamame, karaage, sprouts), noisy normals ("Clay" mode), and generic TRELLIS default sampler settings. We did not tune steps/CFG/seed, so sampling quality could not be improved from our side without experimentation.

### Inferences
- If only two things could be fixed: (a) show a lit/PBR model with an environment map and cleaned geometry (and offer the 300k tier instead of 35k), and (b) re-source or re-shoot inputs at >= 1024 px with plain backgrounds, no drop shadows and a consistent ~45 degree angle, and mask without shadow.

### Gaps
- Sampler steps/CFG/seed and TRELLIS.2 preprocess behaviour were not verified from the repo README.
- No lit-vs-unlit or full-vs-mobile render comparison was produced; the effect size of causes 1 and 3 is inferred from code and texture/face statistics.
- No user rating of individual dishes was available to validate the structural ranking.
