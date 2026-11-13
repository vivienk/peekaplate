# Pipeline-generated PR147 2.5D previews

The six WebP sources are byte-for-byte copies from PR147 commit `d8e186b450845f5f6035eb32ab1858d9c7a7a3ce`. They are 640 × 640 Figma design sample photos with transparent dish-and-plate cutouts. No invented food surfaces or paid model call is used.

`portion-ingestion-input.json` is the input job set: source photo, exact SHA256, dish/revision IDs and capture evidence. Run `pnpm ingest:portion-fixtures` with the processing Python environment (select its executable with `PEEKAPLATE_PROCESSING_PYTHON`). This invokes `peekaplate_processing.portion_ingestion`, then exports its actual output into `portion-fixtures.json`. The exporter does not implement a separate generation recipe. Diner builds run `--check` and reject stale source, processor or provenance bindings.

The reusable processor also runs automatically from the existing `python -m peekaplate_processing.prepare_assets` photo-preparation command. Transparent photos are reused when within budget; otherwise they are resized/encoded into bounded WebP layers. Opaque photos automatically run local U2NetP segmentation; a supplied grayscale mask is an optional override. Missing/invalid cutouts or delivery-budget failure retain the original photo. Outputs are immutable, content-addressed, hash-verified on retry, review-required and publication-ineligible.

The normal menu exposes five photos; Berry Pancake Stack remains in PR147's existing edge-cases menu. Internal previewPortion is assigned only to fixture menus in development or explicitly enabled PR builds. Published bundles cannot supply it. Backend approval/publication is a separate boundary; this PR does not add a public upload route or automatically publish generated assets.

Only local development's explicit portion-demo route retains the older single-image/local-3D review harness. Hosted legacy links use the dish-specific photo previews.
