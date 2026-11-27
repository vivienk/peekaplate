# Colab TRELLIS hi-res run, 2026-11-23

Account: Colab authuser=4, which is the same Google account as the Drive used by rclone. colab-mcp v1.0.2 opens `empty.ipynb#mcpProxyToken=…` **without authuser**. Fix: insert `?authuser=4` before the `#` in the opened tab.

Runtime: NVIDIA L4 (23 GB), 52 GB RAM, Python 3.13.16, torch 2.14.1+cu130, CUDA 13.0. High-RAM was not needed.

## Live fixes (applied in-tab, ported to the generator afterwards)
1. torch 2.14 needs C++20, but flex_gemm/cumesh/o-voxel setup.py pin c++17. Rewrite to c++20; the native build then takes 12.7 min.
2. `Trellis2ImageTo3DPipeline.from_pretrained(path)` takes no revision/token/dtype. Use snapshot_download at the pinned revision, then from_pretrained(local path) and `.to(device)`.
3. The TRELLIS loader pulls gated, non-commercial briaai/RMBG-2.0. Stubbed out, since the inputs are RGBA.
4. rembg's default model is now bria-rmbg-2.0 (non-commercial), and CPU BiRefNet caused a **53 GB OOM kill** (dmesg: anon-rss 53,330,444 kB). Colab now uses masks derived from Kaggle sweep-A cutouts for the 8 unmasked dishes: `gdrive:peekaplate/kaggle-cutout-masks/` + PROVENANCE.json.
5. `pipeline(...)` → `pipeline.run(...)` + `mesh.simplify(16777216)`.
6. transformers must be pinned to 4.57.3 (newer: `DINOv3ViTModel has no attribute 'layer'`).
7. No flash_attn/xformers wheels for torch 2.14. Use dense `ATTN_BACKEND=sdpa` + sparse `xformers` served by an SDPA shim that returns a **tensor**. The Kaggle Hi3DGen shim returns a tuple (suspected bug, handed to a builder).

## Measurements
- Test dish 01_pizza (standard 300k/2048): **240.85 s**, 295,363 / 34,864 faces, welded boundary 1, 22 shells, main shell 97.17%, RAM ~24 GB. Verifier: GLBs valid; only `manifest_missing`.
- The max-detail run `run-trellis-maxdetail-20261123-155010` (1M faces / 4096 tex, 41 dishes) started 15:50 UTC. RAM plateaus at ~36 GB. The first 5 dishes took 242–589 s (~5.9 min average). Expected about 4 h and about 20 credits. The runtime auto-releases in a finally block.
- The colab-mcp `run_code_cell` call times out after 1800 s, but the cell keeps running. Monitor the Drive progress.jsonl with rclone instead.
Related: [decision-2026-11-23-colab-hybrid](decision-2026-11-23-colab-hybrid.md), [colab-notebooks](colab-notebooks.md), [trellis-run-profile](trellis-run-profile.md).
- 2026-11-23: scheduled task `scheduled-task:031fd05d…` ("Watch Colab TRELLIS max-detail run") checks every 30 min. It finds stalls and confirms release from ram.log on Drive. A scheduled session cannot attach colab-mcp to the existing tab, so it cannot release the runtime itself. At completion it pulls, grades, merges and rebuilds the studio, then disables itself.

## Measurement, 2026-11-23 20:05–20:50 UTC (scheduled monitor)
- The max-detail run **stopped at 23/41**: 23 success, 0 failed, 0 skipped. Dishes 24–41 were not run; `24_truffle_fries/` holds only its input and cutout PNGs. The last progress line (23_brussels_sprouts) was written about 19:34:58 UTC. The last ram.log line is `19:35:17 rss=36.1G used=36.2G avail=16.1G`, about 20 s later. The stop came 3 h 45 min after the 15:50 start, and no error line was written. Drive cannot show the cause or whether the `finally` unassign ran.
- Median 351.2 s/dish. 22_shishito_peppers took 4068 s, a 68 min outlier whose mesh is normal (945,722 faces, 4 shells).
- Pulled 892 MB to `/home/yacine105/kaggle-evals/colab-run-trellis-maxdetail-20261123-155010`. The verifier gave **FAIL** with 2 errors, both `manifest_malformed`: the run-level `manifest.json` has no `inputs`/`runs_3d` maps. GLBs 46/46 ok, digests 0 missing/0 mismatch, image pairs 23/23.
- Main GLBs (23): median 970,589 faces, every texture 4096², median welded boundary 3, median 4 shells. Main shell under 80% on 08_lobster_shio_ramen (62.94%), 12_tempura_ramen (64.19%) and 18_choco_cake_ice_cream (61.03%).
- Not merged. `merge_multi_model_results.py` needs `inputs`/`runs_3d`, which the Colab tree lacks, so merging it would add nothing. A merge-format manifest or adapter is needed. The studio and report were not rebuilt.
- The repo notebooks match `build_colab_notebooks.py` output byte for byte and were uploaded to `gdrive:peekaplate/notebooks/` (md5 verified).
- A resume was requested. `open_colab_browser_connection` returned false, then timed out after 1829 s with no tab attached.
- 2026-11-23 20:51 UTC monitor check: Drive unchanged (23/41, last ram.log line still 19:35:17). Schedule `scheduled-task:031fd05d…` disabled (enabled=false). The merge/studio rebuild stays blocked on the Colab manifest format.

## Merged into studio, 2026-11-24
- An adapter (session scratchpad `colab_to_merge.py`) rewrote the run tree's `manifest.json` into merge format with `inputs`/`runs_3d` and the run key `<label>/trellis2-4b-hires`. The original is kept as `manifest.colab-original.json`.
- `dish_3d_studio.py` MODELS gained `trellis2-4b-hires` ("TRELLIS.2-4B Max detail (L4, 1024 cascade, 4K texture)"). Tests updated; 18/18 pass.
- Studio: `/home/yacine105/kaggle-evals/studio-split-colab/results/studio/index.html`. Max detail 23/41 (18 pending); full meshes ~930k–990k faces vs ~295k for Kaggle TRELLIS.
- Resume: the notebook skips dishes whose worker_output.json says success. Set RUN_ID to 'run-trellis-maxdetail-20261123-155010', QUALITY to 'max', DISH_LIMIT to None. Dish 24 has only its inputs, so it reruns.
