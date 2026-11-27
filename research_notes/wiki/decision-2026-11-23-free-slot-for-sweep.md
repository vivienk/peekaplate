# Decision 2026-11-23: free a GPU slot for the TRELLIS sweep

On 2026-11-23 both Kaggle batch GPU slots were held: `hero-batch-b/6` RUNNING (TRELLIS working) and `trellislast-version/33` QUEUED (4 hero dishes only). The user chose to cancel /33 because the 41-dish sweep re-covers those dishes.
The cancel could not be scripted ([kaggle-cancel-session-not-scriptable](kaggle-cancel-session-not-scriptable.md)), so it went to the user via the web UI. Deleting the kernel was rejected: it destroys trellislast-version history (V31/V32 COMPLETE).
Goal: [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md).

## Status check, 2026-11-23 12:11Z (scheduled sweep cycle)
`kaggle kernels status` still showed `trellislast-version` QUEUED (/33 not yet cancelled in the web UI) and `sweep-trellis-a` RUNNING, so both batch GPU slots were still held and sweep-trellis-b could not be pushed. The /33 cancel was still outstanding at that time.

## Status check, 2026-11-23 12:32Z (scheduled sweep cycle)
`trellislast-version` still QUEUED (/33 cancel still outstanding) and `sweep-trellis-a` RUNNING, so both slots held; sweep-trellis-b not pushed. `kernels logs -f` on sweep-trellis-a showed `HF token source: dataset:peekaplate-hf-token/hf_token.txt`, `DINOv3 preflight: ok=True`, MoGe-2 relief done for all 21 dishes, and 17 TRELLIS `6/6 export_glb` lines (faces ~279k–297k, mobile ~32–34k, tex=2048, ~4–6 min/dish). A `nvdiffrec_render` wheel build error appeared during setup but did not stop TRELLIS export.

## Status check, 2026-11-23 12:52Z (scheduled sweep cycle)
`trellislast-version` still QUEUED (/33 cancel still outstanding) and `sweep-trellis-a` RUNNING, so both slots held; sweep-trellis-b not pushed. `kernels logs -f` (60 s window) showed token source and `DINOv3 preflight: ok=True` again and 20 TRELLIS `6/6 export_glb` lines of 21 dishes (latest: faces 287,326, mobile 32,989, tex=2048). fast-41 has no READY file.
