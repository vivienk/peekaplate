# Colab TRELLIS max-detail resume, 2026-11-24

- The user started Run all at about 08:25Z with the correct RUN_ID, QUALITY='max' and DISH_LIMIT=None. Cell 5 (the build) finished in 17 min.
- Cell 6 then failed: `ImportError: cannot import name 'refresh_xet_connection_info' from 'huggingface_hub.utils'`. Cause: cell 3 (HF login) imports huggingface_hub, and cell 5's pip install then replaces it on disk, so the in-memory modules are stale.
- Purging sys.modules does NOT work, because safetensors' PyO3 extension can only initialise once per process.
- The fix that worked: restart the session, re-run cells 1–4, run a one-line cell that restores `TRELLIS_SRC` and `REVISIONS` (the only cell-5 names cell 6 uses), then run cells 6 and 7. This skips the 17-min rebuild.
- About 1 h of L4 time (≈2 units) was spent idle between the failure and the fix.
- Watcher lesson: the RAM-monitor daemon thread kept writing ram.log after cell 6 failed, so "ram.log advancing" is NOT proof the run is alive. Detect a stall from progress.jsonl (no new dish within 80 min) and from the cell state in the tab.
- Generator fix owed in `processing/scripts/build_colab_notebooks.py`: cell 3 must not import huggingface_hub before the install. Read the secret into the environment only, or move the login after cell 5.
Related: [colab-trellis-hires-run-2026-11-23](colab-trellis-hires-run-2026-11-23.md), [colab-notebooks](colab-notebooks.md).
