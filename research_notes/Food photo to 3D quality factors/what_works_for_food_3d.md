# What works for convincing 3D food models (menus / AR), state as of November 2026

Scope note: about 20 tool calls. Search was shallow on several sub-questions. Many findings are vendor claims, vendor blogs or search-summary snippets and are labelled as such. Specific gaps are listed per section.

## 1. Commercial AR food menus (Kabaq / QReal, Restaurant AR, Arsome, etc.): method, cost, turnaround

### Takeaway
The best-documented commercial method is turntable photogrammetry with roughly 100 photos per dish (Kabaq, now QReal), with little post-production claimed. No vendor publishes per-dish prices or turnaround. The only per-dish numbers found are third-party estimates (India Rs 1,500-4,000; UK from £49), and old Kabaq monthly fees from 2017.

### Cited Findings
- Kabaq photographs each dish from many angles. One account says the food is turned every second and stopped for a capture, with cameras at varying heights, and images are processed at Kabaq's offices. Another says models are usually built from 96-114 pictures per item. These come from a search summary of press coverage (2017-era), not from a primary Kabaq page — [YourStory 2017](https://yourstory.com/2017/07/cant-decide-order-kabaq-makes-easy-putting-virtual-3d-food-table) (page returned 403 when fetched directly, so the figures are from the search snippet only), [Capturing Reality article](https://www.capturingreality.com/Article-KabaQ-Future-Of-Food-Ordering) (redirects to realityscan.com/news; not read).
- Kabaq is described as using photogrammetry (the Capturing Reality / RealityCapture article hosting suggests RealityCapture was used) — [Capturing Reality](https://www.capturingreality.com/Article-KabaQ-Future-Of-Food-Ordering). This is inferred from hosting and the search summary, not verified in text.
- Kabaq's hosting on Sketchfab is documented in a Sketchfab community blog. That post is a hotdog photogrammetry tutorial: 109 phone photos on a continuous turntable, 311 frames from video, 43 DSLR focus shots, or 211 DSLR turntable photos. It used an LED light tent, markers, Agisoft processing and Autodesk Remake for editing. The author calls lighting "the most important piece". It states no time per dish, cleanup budget or client pricing — [Sketchfab blog](https://sketchfab.com/blogs/community/using-real-life-objects-virtual-augmented-reality-kabaq)
- Kabaq pricing, reported around 2017: $99-$199 per month, or US$150-$199 per restaurant per month. These are subscription fees, not per-dish, and are old — search summary of [YourStory](https://yourstory.com/2017/07/cant-decide-order-kabaq-makes-easy-putting-virtual-3d-food-table) and [TU Delft thesis](https://repository.tudelft.nl/file/File_b0fd7a17-302a-4e21-9514-eec09dedc82f). A 2018 TU Delft thesis on startup SeeFood estimated about €150/month per restaurant including a scanner lease and app licence.
- QReal (described as formerly Kabaq) uses photogrammetry and built Denny's Grand Slam AR menu (2023), web-based on 8th Wall. Reporting says QReal "hardly uses post-production" and the models are photorealistic. The sources give no photo count, equipment or turnaround — [ARPost](https://arpost.co/2023/04/07/dennys-70th-anniversary-ar-food-menu/), [AR Insider](https://arinsider.co/2023/04/05/how-can-restaurants-use-ar/), [Yahoo Finance press release](https://finance.yahoo.com/news/qreal-partners-dennys-deliver-augmented-123000626.html)
- Petpooja (an Indian POS vendor selling a competing AR menu product, so a commercial interest): Rs 1,500-4,000 per 3D model, "one-time shoot per dish", from Indian vendor quotes as of early 2026. Example uses Rs 3,200 per model; a 40-item menu is Rs 60,000-160,000 for models alone; platform Rs 40,000-60,000 per year; most restaurants model only the top 10-15 high-margin items. It cites QReal case studies suggesting a 10-20% lift in average order value and says verified Indian data was limited as of June 2026. No turnaround stated — [Petpooja](https://blog.petpooja.com/glossary/ar-menu/)
- Other price points surfaced in search summaries: a UK service from £49 per dish, a SaaS starter tier at $99/month for up to 20 items, and AI-generated "upload photo" menu platforms that claim no manual modelling — see [search-result listings](https://blog.petpooja.com/?p=45518) and [Product Hunt RealMenu](https://www.producthunt.com/products/realmenu-ai). These were not individually verified.
- A Product Hunt commenter questioned the value and noted food photography cost as a barrier — [Product Hunt Kabaq](https://www.producthunt.com/posts/kabaq-ar-food)
- Other vendors seen: Menu3 (Kabaq competitor; [CB Insights comparison](https://www.cbinsights.com/compare/kabaq-vs-menu3)), Menu AR ([App Store](https://apps.apple.com/us/app/menu-ar/id1314878103)).

### Inferences
- The commercial incumbent method is capture-heavy (about 100 photos plus turntable plus studio lighting) and per-dish cost is therefore dominated by labour and travel. It is rational that vendors cap at 10-15 hero dishes.
- Per-dish prices in the low tens to low hundreds of USD seem plausible in 2026, but the only sources are an Indian vendor blog and an unverified UK snippet.

### Gaps
- No Arsome or Restaurant AR source found at all (searches returned nothing relevant). No Glimpse source found (the name may not be a QReal brand; unverified).
- No current Kabaq/QReal pricing, turnaround, manual-cleanup effort, or per-dish human-artist workflow found.
- The Kabaq 96-114 photo claim and "camera rig" detail are from a secondary summary; the primary article text was not read.

## 2. Photogrammetry / NeRF / Gaussian splatting from phone video for food

### Takeaway
Photogrammetry struggles with glossy and translucent surfaces (sauces, glazes, fresh produce), producing holes; NeRF/splat methods handle view-dependent appearance better. For a food-specific benchmark, 3DGS clearly beat Nerfacto in MetaFood3D. I found no food-specific tests of Polycam, Luma, Kiri, RealityScan or Scaniverse, and no verified splat-to-GLB workflow for food.

### Cited Findings
- General photogrammetry guidance: translucent and glossy objects are extremely difficult; matte coating is a workaround that does not suit food — [Univ. Melbourne scanning FAQ](https://ms-kb.msd.unimelb.edu.au/next-lab/3d-scanning/troubleshooting/faq-3d-scanning)
- A food-project case study reports complex light reflected from shiny and transparent surfaces confused the software and left holes — [Journalists immersive case study](https://journalists.org/resources/immersive-case-study-american-food-post-production)
- A game-art scanner found tomatoes and bell peppers among the trickiest subjects (reason not stated) — [80.lv](https://80.lv/articles/creating-hyperrealistic-kitchen-props-using-photogrammetry-modeling-software)
- A Japanese write-up says NeRF-type methods capture translucency and reflections in food better than photogrammetry, describing a chef's multi-course dinner scanned dish by dish with an iPhone (lower confidence, secondary) — [ASCII.jp](https://ascii.jp/elem/000/004/167/4167168/2/)
- MetaFood3D: on videos, 3DGS PSNR/SSIM/LPIPS 37.83/0.9897/0.0114 versus Nerfacto 22.74/0.9633/0.0712. Nerfacto sometimes failed to learn the foreground on video captures; the authors blame non-uniform sparse views and scale variation. Masked Nerfacto on video scored PSNR 9.10 — [MetaFood3D arXiv v2](https://arxiv.org/html/2409.01966v2)
- General splat capture advice: avoid reflective/transparent surfaces; 70-80% overlap between frames; clean floaters (cleaning can cut file size about 90%, per a LinkedIn post); Polycam and Luma outputs may not be at true scale — [SketchUp splat best practices](https://help.sketchup.com/es/gaussian-splats-best-practices), [LinkedIn comparison post](https://pl.linkedin.com/in/kamilmaziarka) (low confidence)
- A hobbyist note says Polycam export requires a paid subscription (low confidence, from a search summary).
- A user on the Revopoint forum asked in Jan 2026 for the best food scanning setup for AR menus (glossy sauces, USDZ/GLB). No answers were given — [forum thread](https://forum.revopoint3d.com/t/best-photogrammetry-setup-for-food-3d-scanning-ar-menus/41753). Related threads exist ("First successful food scan (w/retexturing)", 2021), content not shown.

### Inferences
- Splats look best for translucent and glossy food but are not directly usable as a lightweight GLB mesh. Mesh extraction from a splat re-introduces the glossy-geometry problem, so a baked mesh may lose the appeal.
- Phone-video capture of a plated dish with a rim, steam-free, static, under diffuse light is feasible; the main pitfalls are time-sensitive (food moves, sauce settles) rather than software.

### Gaps
- No direct food results for Polycam, Luma, Kiri Engine, RealityScan or Scaniverse. No verified splat-to-GLB export pipeline or file-size numbers for mobile AR. No time-per-scan data.

## 3. Multi-view generative models (Hunyuan3D-2mv, InstantMesh, Zero123++, SV3D, MV-Adapter, CAT3D)

### Takeaway
No food-specific evidence found. General evidence says multi-view diffusion is only weakly 3D-consistent and degrades on real photos; multi-view conditioning with real photos (Hunyuan3D-2mv, Tripo/Meshy multi-image) is said to improve geometry, but no benchmark proves this on food.

### Cited Findings
- Zero123++ initial views are not strictly 3D consistent, which caused failures; multiview diffusion consistency is enforced only data-driven — [MVEdit arXiv 2403.12032](https://arxiv.org/html/2403.12032v1)
- MVGBench (12 multiview generators): significant performance gap between synthetic and real images; most methods lack robustness to input perturbations and struggle with fine-grained details — [MVGBench](https://arxiv.org/html/2507.00006v1)
- One-2-3-45 notes Zero123-based pipelines give occasionally inconsistent results — [One-2-3-45](https://arxiv.org/pdf/2306.16928)
- Hunyuan3D-2mv is a variant trained to accept several viewpoints; a third-party wiki claims multi-view significantly improves geometric accuracy; ComfyUI workflow supports front-view-only input, texture generation not yet supported for 2mv there, and more memory is required — [DeepWiki](https://deepwiki.com/Tencent/Hunyuan3D-2/6.4-multi-view-generation), [ComfyUI docs](https://docs.comfy.org/tutorials/3d/hunyuan3D-2) (secondary sources, no benchmark).
- Tripo recommends 2-4 photos from different angles for multi-view; Meshy multi-view needs a paid plan and accepts 1-4 images in Meshy 7.1 — [Tripo blog](https://www.tripo3d.ai/blog/multiple-reference-images-3d-generation), [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d)

### Inferences
- Multi-view input likely helps occluded sides and hidden geometry, but a plated dish seen from 3-4 real photos still faces the same material problems. A proof for food needs the project's own A/B test.

### Gaps
- No evidence on CAT3D (closed model) or MV-Adapter failure modes; no food comparison of multi-view vs single-view; Hunyuan3D-2 technical report numbers not read.

## 4. Commercial single-image APIs (Tripo, Meshy, Rodin, Hunyuan3D cloud, CSM)

### Takeaway
No food-specific comparison exists in what I found. General benchmarks rank Tripo best on geometry and topology, Meshy best on single-view texture, Rodin often best for product-photo realism. All vendors advise a single clean object on a plain background.

### Cited Findings
- Vendor-authored benchmark (author is a Meshy technical artist), Meshy 6 vs Tripo v3.1 vs Rodin Gen-2.5, April-May 2026, no food inputs: Tripo ranked first on white-mesh geometry, then Rodin, then Meshy; Tripo beat Rodin 77.9% single-view and 62.7% multi-view; Meshy beat Rodin 83.9% on textured single-view. Median image-to-3D latency: Tripo 99 s, Rodin 190 s, Meshy 195 s. Per-call cost about $0.18 (Tripo), $0.20 (Meshy), $0.25 (Rodin) — [HackerNoon](https://hackernoon.com/lang/nl/how-i-stress-tested-3-ai-3d-generators-on-the-same-inputs-what-the-numbers-actually-show)
- 3D AI Studio roundup (Feb 2026, single test image): Rodin best quality for product photos, Tripo best budget; Tripo material quality lower — [3D AI Studio](https://www.3daistudio.com/3d-generator-ai-comparison-alternatives-guide/best-3d-generation-tools-2026/10-best-image-to-3d-tools-turn-photos-ready-models-2026)
- Input guidance: single subject, simple background, 512 px or larger (Meshy suggests above 1040 px); scenes with several objects get merged into one distorted mesh; Tripo recommends white/grey/black background, a three-quarter view, and even lighting without harsh shadows; hollow objects (baskets) may fail from a single image — [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d), [Tripo best images](https://www.tripo3d.ai/blog/best-images-for-image-to-3d), [Tripo tips](https://www.tripo3d.ai/blog/25-image-to-3d-prompt-tips-for-cleaner-ai-3d-models)
- Tripo's own "best tools" blog names Tripo its pick (vendor material) — [Tripo blog](https://www.tripo3d.ai/blog/best-image-to-3d-ai-tools)
- A Scenario "generative 3D comparator" lets users compare six providers on one reference image — [Scenario](https://scenario.com/apps/generative-3d-comparator)

### Inferences
- The "plated dish" case (multiple items on one plate, garnish, sauce, shallow relief) fits the "merges objects" and "texture-dense" failure modes. Plate-with-food is a flat, low-relief shape where geometric priors for objects fit poorly.

### Gaps
- Nothing found on CSM or the Hunyuan3D cloud service; Rodin Gen-2 vs Gen-2.5 naming not clarified; no food A/B anywhere.

## 5. Food-specific 3D research

### Takeaway
Food is a hard 3D target: even research datasets need dedicated scanners, turntables and flipping, and reconstruction from video lags scanned data. Nutrition5k and related work focus on volume and nutrition rather than visual fidelity.

### Cited Findings
- MetaFood3D (arXiv 2409.01966): v2 describes 743 objects in 131 categories; v1 637 objects in 108 categories. Capture: turntable, Revopoint POP 2 scanner, plus Record3D RGB-D video rotated twice in a spiral (720 degrees). Objects that could be flipped were recaptured underneath; a bowl of beef stew could not be flipped. Mesh reconstruction of rendered data failed on 5 of 131 objects. Authors highlight a gap between video captures and 3D scanned data; per-object effort was not reported — [MetaFood3D v2](https://arxiv.org/html/2409.01966v2)
- Nutrition5k: about 5,000 dishes with RGB video around the plate, overhead RealSense depth, weights and nutrition labels. Dishes built incrementally with a scan after each ingredient — [Nutrition5k arXiv](https://arxiv.org/pdf/2103.03375.pdf)
- MetaFood CVPR 2024 challenge on physically informed 3D food reconstruction exists (arXiv 2407.09285); the PDF was too large to fetch, so contents are unread — [arXiv](https://arxiv.org/pdf/2407.09285.pdf)
- VolE (point-cloud food reconstruction and volume from mobile video), VolTex, Size Matters (single-image real-scale reconstruction, 2026), and Food3D (text-driven 3DGS food generation) exist; their findings were not read in detail — [VolE](https://arxiv.org/html/2505.10205v1), [VolTex](https://arxiv.org/html/2506.02895v1), [Size Matters](https://arxiv.org/html/2601.20051), [Food3D](https://yudongjian.github.io/Food3D)
- A 2026 monocular multi-food benchmark built from MetaFood3D uses 10 curated scenes with 24 objects — [arXiv 2602.13041](https://arxiv.org/html/2602.13041)

### Inferences
- Research reconstructions target geometry (volume), not menu-grade appearance; no dataset establishes viewer-perceived realism for food.

### Gaps
- Details of the challenge results, VolE/VolTex numbers and Size Matters not extracted.

## 6. 2.5D / parallax approaches

### Takeaway
Layered-depth parallax (Facebook 3D Photos) needs only one image and avoids full reconstruction, but quality breaks at disocclusions when the viewpoint moves. I found no controlled perceived-quality study.

### Cited Findings
- One Shot 3D Photography (Facebook/Meta): monocular depth network optimised for mobile, converted to a layered representation with synthesised geometry in parallax regions — [Meta research PDF](https://research.facebook.com/file/2792199441071209/One-Shot-3D-Photography.pdf)
- Facebook 3D Photos use a layered depth image (LDI), compact and convertible to a light mesh; naive depth warping gives gaps or stretched content at disocclusions; Practical 3D Photography hallucinates occluded geometry and inpaints colour — [3D Photography using Context-aware Layered Depth Inpainting](https://arxiv.org/pdf/2004.04727.pdf), [Practical 3D Photography](https://johanneskopf.de/publications/photo3d_practical/Practical_3D_Photography.pdf)
- TechCrunch at launch (2018) was unimpressed: little better than a picture on butcher paper floating a few feet away. This is one journalist's impression — [TechCrunch](https://techcrunch.com/2018/06/07/how-facebooks-new-3d-photos-work/)

### Inferences
- For a food menu, small-angle parallax (a few degrees of tilt) hides disocclusion errors, so 2.5D is a plausible low-risk tier. It cannot support true AR placement or orbiting.

### Gaps
- No user study comparing 2.5D vs full 3D for food; no food-specific parallax results; depth-model quality on glossy food unknown.

## Cross-cutting confidence notes
- Highest confidence: MetaFood3D numbers (primary arXiv), capture advice from vendors' own docs (vendor claims, but about their own tools).
- Lower confidence: Kabaq photo counts and price (secondary, 2017), Petpooja prices (vendor with an interest), Meshy-author benchmark (conflict of interest, no food), LinkedIn and ASCII.jp items.
- Search-summary claims marked above were not verified against full page text.
