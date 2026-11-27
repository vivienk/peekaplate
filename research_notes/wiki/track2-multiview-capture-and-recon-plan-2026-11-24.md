# Track 2 Plan (2026-11-24): Multi-View Food Capture & Reconstruction

Purpose: reach true "all-sides AAA hero prop" fidelity where back faces and side relief are measured from real photography rather than invented from one view. Every single-photo asset remains `publication_eligible: false` under [ADR 0004](../../docs/adr/0004-visual-tiers.md); multi-view real captures (with held-out view checks) are the path toward real menu assets.

## 1. Free Phone Capture Protocol (E1 — $0 GPU/API)

To test true all-sides reconstruction locally (with `multiview_prep.py` + VGGT / COLMAP / 2DGS), capture one real dish on a table using these steps (~5 minutes):

1. **Lighting (most important factor):** Place the dish near a large overcast/shaded window or under soft diffused light. Avoid harsh ceiling spotlights, flash, or strong direct sunlight. If photographing a glossy broth/glaze and a clip-on CPL filter is available, use it.
2. **Background & framing:** Use a plain, matte, contrasting surface (avoid dark shadow-casting clutter or shiny black marble close to the rim). Keep the entire plate plus **at least 10–15% margin** inside every frame — never clip the rim.
3. **Lock phone camera settings:** Tap and hold AE/AF lock (or Pro mode) so exposure and white balance do not shift as you move around the plate. Disable flash and heavy beauty/HDR smoothing if possible.
4. **Shot plan (pick one):**
   - **Minimal 4-photo test (for Track 2A / AI video bridge):** 1 hero shot at ~45–60° elevation + 3 shots at ~25–35° elevation spaced ~120° around the plate (front, left-rear, right-rear), plus optional 1 top-down (75–85°) view.
   - **Full photogrammetry / 2DGS capture (E1):** Either a slow **30-second smooth orbit video** at ~40° elevation (followed by 5s sweeping up to ~70°), OR **25–30 still photos** (~20–25 around 35–45° every 15° + 5 top-down at ~75°).
5. **Plate measurement (optional physical scale):** Measure outer plate diameter in **cm** (e.g. `24.0 cm`) so the pipeline can normalize real-world dimensions separately from serving count (`--diameter-cm` + `--calibrated`).

Run local preparation immediately (no paid GPU):
```bash
processing/.venv/bin/python processing/scripts/food3d/multiview_prep.py \
  <capture_dir_or_video> ~/kaggle-evals/track2-capture-test --target-frames 24 --diameter-cm <cm>
```

## 2. Two Reconstruction Paths After Capture (Needs User OK Before Any Spend)

| Track | Inputs | Pipeline | Verified Unit Cost (2026-11-24) | ADR 0004 Eligibility | Best For |
|---|---|---|---|---|---|
| **E1: Direct Multi-View 2DGS / Splat** | 20–30 real photos or 30 s orbit video | `multiview_prep.py` → `VGGT` (`facebookresearch/vggt`) or `COLMAP` poses → `hbb1/2d-gaussian-splatting` (mesh via TSDF) or `ArthurBrussee/brush` (`.spz` splat) → `blender_bake.py` + `pbr_author.py` | **$0** (local RTX 3060 6 GB or Kaggle 2×T4 / Colab L4 free tier) | Eligible for real observed surfaces with held-out view validation | Firm dishes AND glossy soups/noodles when 20+ real views are captured |
| **E3b: 2–4 Real Photos → FL2V Video Bridge → 2DGS/3DGS** | 2–4 real photos from different sides | Pair adjacent real photos `(img_i, img_{i+1})` with First/Last Frame Video (FL2V) interpolation (`MiniMax H3` 768p or `Kling` 720p) → extract frames → `VGGT` + `2DGS` → `blender_bake.py` + `pbr_author.py` | **~$0.30–$0.40 per 5 s 768p clip** (`MiniMax H3` $0.06–$0.08/s; `Kling` ~$0.056–$0.08/s; `Wan` $0.05–$0.11/s); ~$1.20–$1.60 for 4 bridged arcs | **`publication_eligible: false`** (synthesized bridge frames remain unverified priors) | Fast merchant capture when only 2–4 real angles exist and full 360° orbit is desired |
| **E2: Commercial Single/Multi-View API Bake-Off** | Clean Stage-1 cutouts (`cutout_clean.py`) of 6 benchmark dishes | Run `Tripo v3.1` (already wired in `tripo.py`, $0.30 std / $0.50 ultra), `Rodin Gen-2` ($0.40 via Fal/Replicate), `Meshy 7.1` ($0.375–$0.70) through Food3D V1 `pbr_author` + `qa_gate` | **~$5–$8 total** across 6 dishes | **`publication_eligible: false`** | Benchmarking commercial single/4-view ceiling against Food3D V1 TRELLIS.2 |

## 3. Why Food3D V1 Post-Processing Transfers Directly to Track 2

Regardless of whether the upstream geometry comes from `TRELLIS.2`, `Tripo v3.1`, `2DGS` TSDF mesh extraction, or bridged video reconstruction:
1. **`input_qa.py` + `cutout_clean.py`** catches frame-clipped bowls and strips shadow discs/background clutter before reconstruction.
2. **`blender_bake.py`** isolates the primary dish, enforces metric diameter (`--diameter-cm`), seats the underside (`z = 0`), applies crease-free `WeightedNormal` decimation (`150k` hero + `35k` mobile), and bakes clean UV islands without circular dependencies.
3. **`pbr_author.py` + `pack_pbr_glb.mjs`** performs specular de-lighting, separates ceramic/wet/dry masks, builds ORM + `KHR_materials_clearcoat` + `KHR_materials_sheen` + RNM micro-normals (`metallic = 0`), and packs Meshopt WebP GLBs under the ≤5 MB budget.
4. **`qa_gate.py` + `viewer.html`** enforces glTF validation, relighting highlight movement (`p95 >= 8/255`), PBR variance, and 360° photo-view SSIM/IoU/ΔE before any human rating.

Related: [goal-photoreal-food-3d-pipeline](goal-photoreal-food-3d-pipeline.md), [gemini-food-3d-report-vs-ours-2026-11-24](gemini-food-3d-report-vs-ours-2026-11-24.md), [Dish 3D model alternatives](../../reports/Dish%203D%20model%20alternatives.md).
