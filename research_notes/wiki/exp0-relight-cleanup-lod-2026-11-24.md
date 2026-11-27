# Experiment 0, 2026-11-24: re-light, clean and re-LOD existing TRELLIS.2 meshes (no paid GPU)

What was run: on 6 dishes from `~/kaggle-evals/colab-run-trellis-maxdetail-20261123-155010`, the ~1M-face, 4K TRELLIS.2 hi-res GLBs went through:
1. weld
2. drop shells
3. collapse-decimate to 150k and 35k faces
4. smart-UV unwrap
5. Cycles selected-to-active bake of base colour, roughness and tangent normals (2048 and 1024 px)
6. metallic set to 0

Each result was then rendered in a three.js 0.182 viewer: RoomEnvironment IBL, a key light with soft shadow, Neutral tone mapping, 4 azimuths at 35° elevation, in headless Chromium.

Outputs are in `~/kaggle-evals/exp0-20261124/`:
- per-dish `exp0_report.json`, frames and `sheet_labelled.png`
- the `blind_*.png` sheets
- `blind_key.json`

All outputs are `publication_eligible: false`. Code is in `processing/scripts/exp0/` (`food_lod_bake.py`, `viewer.html`, `render_turntables.mjs`, `contact_sheet.py`). Tools: Blender 4.5.17 LTS portable in `~/tools`, checksum-verified; Chromium headless shell 1243 from the Playwright cache.

## Measured
| Dish | Shells | Faces kept | Dropped | LOD 150k / 35k GLB | CPU time |
|---|---|---|---|---|---|
| 05 steak | 2 | 970,274 / 970,420 | 1 tiny | 7.41 / 1.95 MB | 57 s |
| 09 ramen | 1 | 975,491 / 975,500 | none | 6.18 / 1.54 MB | 67 s |
| 20 karaage | 3 | 948,527 / 948,705 | 2 tiny | 7.72 / 1.98 MB | 68 s |
| 08 lobster | 33 | 844,982 / 956,027 | 1 slab (109k faces, h/w 0.0024) and 30 tiny | 9.75 / 3.02 MB | 43 s |
| 12 tempura | 3 | 631,629 / 983,947 | 1 table slab (352k faces, h/w 0.0214, 4 of 4 corners) and 1 tiny | 8.64 / 2.54 MB | 35 s |
| 18 choco cake | 5 | 975,272 / 976,644 | 3 tiny | 6.06 / 1.50 MB | 57 s |

- The 35k mobile LODs fit the ≤5 MB budget. The 150k hero LODs are 6–10 MB, over a mobile budget; they would need KTX2 + meshopt.
- Source textures: metallic was already ~0.004 on average. Roughness was nearly flat at 0.40–0.57, so a metallic clamp changes little. Roughness variation has to be authored.

## Observed (Claude, from the renders; the user's blind rating is pending)
- At 512 px, the 150k LOD with a baked normal map looks almost identical to the 1M source, and the 35k LOD is close. So LOD and baking are not the bottleneck.
- Lighting matters a lot. The first pass with ACES tone mapping washed out the colour. Neutral tone mapping, a lower IBL level and a stronger key light kept the photo's colour while adding shape.
- The 12 tempura "ground slab" is the photo's black marble table, rebuilt as a square slab under the bowl. It escaped the first flatness rule (<0.02). A square-corner rule (≥3 of 4 bbox corners filled, h/w <0.05) catches it, and round plates leave the corners empty.
- 08's wide grey outer disc is the cutout's drop shadow turned into geometry. It is round, so the slab rule correctly keeps it, because it could be a real charger plate. The fix belongs in the cutout (exclude cast shadows), not in mesh cleanup.
- 18 reconstructs a background glass dessert stand as a second object next to the cake. That is input clutter. A "keep the main object cluster" rule, or a better cutout, is needed.
- Clay renders show the model's own limit: steak slices and tempura batter come out as soft beaded lumps, not crisp. No cleanup fixes that.
- The clearcoat variant (D) adds wet highlights, but because it is applied globally it also glazes plates and dry batter. Clearcoat needs ingredient masks.
- The smart-UV atlas breaks into thousands of tiny islands on noisy food geometry, which wastes texels. A better unwrap is a follow-up.
- **Structural "clean" ≠ faithful.** Dish 20 (karaage) was in the "clean" group by shell metrics (one main shell). Yet its round bowl of fried chicken came out as a square tray of flat crumbs. Shell and non-manifold metrics cannot judge fidelity; the QA gate needs a comparison against the photo (side-by-side rating, LPIPS at the photo view, or a VLM critic).

## Follow-up, same day (no paid GPU)
- **Main-object rule (opt-in):** `--main-object-only` drops kept shells whose xy footprint does not touch the largest kept shell. On 18 it removed the 379k-face dessert stand and kept the cake plate (596k faces). It is opt-in because detached side bowls can belong to the dish; the proper fix is subject selection at the cutout stage.
- **meshopt compression** (gltf-transform 4.5.1, `meshopt --level medium`):

  | Dish | Hero 150k (MB) | Mobile 35k (MB) |
  |---|---|---|
  | 05 | 7.41 → 3.60 | 1.95 → 1.15 |
  | 09 | 6.18 → 2.55 | 1.54 → 0.81 |
  | 20 | 7.72 → 3.90 | 1.98 → 1.14 |
  | 08 | 9.75 → 4.78 | 3.02 → 1.71 |
  | 12 | 8.64 → 4.35 | 2.54 → 1.44 |
  | 18 (main only) | 5.68 → 2.23 | 1.31 → 0.69 |

  All are now within the ≤5 MB budget. Rendered PSNR against the uncompressed versions was 42–50 dB (05, 08, 12; 4 views each), so the compression is visually lossless. The viewer needs `GLTFLoader.setMeshoptDecoder`.
- **Memory cap quirk:** gltf-transform (WebAssembly) fails under `ulimit -v` because it reserves a lot of address space, and CUDA does the same. For those tools, use `systemd-run --user --scope -p MemoryMax=4G` as the RAM cap. Blender CPU work runs fine under `ulimit -v 12000000`.
- **Fidelity screen** (`fidelity_renders.mjs` + `fidelity.py`): renders the mesh unlit over a pose grid, normalises it and the photo cutout to their alpha bounding boxes, then scores silhouette IoU, mean CIE76 ΔE and gradient correlation. The first run searched only ±60° azimuth, and best poses landed on the range edge. TRELLIS.2 does not place the photo's view at az=0, so the search is now the full 360°. Pose selection uses a combined score, because silhouettes alone cannot separate a round bowl from a square tray (20 scored IoU 0.86).
- The side-by-side check showed another fidelity failure: **05's photo is a deep bowl seen from a low angle, but the mesh is a shallow oval plate.**
- Driver: `processing/scripts/exp0/run_dish.sh <exp0_dir> <dish> [--main-object-only]` runs bake → meshopt → turntables/contact sheet → fidelity.

## 360° fidelity readout & root causes confirmed (2026-11-24 follow-up)
All 13 fidelity results (`fidelity/<dish>/{raw,clean,clean_main}.json` and `fidelity/best_poses_summary.png`) were persisted from the 216-pose 360° grid:

| Dish | Variant | Best Pose (az, el) | Silhouette IoU | Mean ΔE | Detail Corr | Match |
|---|---|---|---|---|---|---|
| 05 steak | raw / clean | 15°, 70° | 0.9025 / 0.9025 | 34.25 / 34.35 | 0.2287 / 0.2299 | 0.3672 / 0.3664 |
| 09 ramen | raw / clean | -90°, 30° | 0.7165 / 0.7168 | 30.23 / 30.97 | 0.0561 / 0.0625 | 0.1782 / 0.1727 |
| 20 karaage | raw / clean | -150°, 80° | 0.8513 / 0.8512 | 32.32 / 32.33 | 0.0515 / 0.0450 | 0.2909 / 0.2892 |
| 08 lobster | raw / clean | 165° / -180°, 30° | 0.8621 / 0.8630 | 36.62 / 37.08 | 0.0991 / 0.0894 | 0.2707 / 0.2645 |
| 12 tempura | raw | -45°, 40° | 0.8654 | 45.25 | -0.0154 | 0.1590 |
| 12 tempura | clean | 135°, 30° | 0.8800 | 26.88 | 0.1285 | 0.3934 |
| 18 choco cake | raw / clean / clean_main | 165°, 10° | 0.8177 / 0.8187 / 0.8081 | 36.58 / 36.80 / 35.13 | 0.0851 / 0.0870 / 0.0888 | 0.2232 / 0.2225 / 0.2290 |

Three concrete V1 fixes identified from these logs and renders:
1. **Pre-padded frame-clipped inputs (`05`, `09`)**: both bowls were clipped at the left/right edges of the original photo and later padded into square inputs, leaving straight vertical alpha edges that TRELLIS.2 reconstructed as shallow rectangular/saddle plates instead of round bowls.
2. **Cycles circular dependency & UV/creasing in `food_lod_bake.py`**: target bake image nodes were wired to `Principled BSDF` before `bpy.ops.object.bake`, causing `Circular dependency` log warnings on all 3 maps; collapse-decimation without sharp-edge splitting/weighted normals also pinched flat shells such as `08`'s outer shadow disc (`rank 1`, `243,540` faces, `h/w = 0.0261`).
3. **Cutout-vs-mesh mismatch (`18`)**: scoring `18b_main_only` against the dirty cutout (which still contains the glass dessert stand) depresses IoU and ΔE; fidelity must compare against a clean main-dish cutout.
