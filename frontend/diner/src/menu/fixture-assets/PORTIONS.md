# PR147 photo-derived 2.5D previews

The six WebP files are byte-for-byte copies from PR147 commit `d8e186b450845f5f6035eb32ab1858d9c7a7a3ce`. They are 640 × 640 Figma design sample photos with existing transparent dish-and-plate cutouts. No generated food surfaces, recoloring, segmentation, or paid model call is used.

Run `node scripts/generate-fixture-portions.mjs` to regenerate `portion-fixtures.json`; add `--check` to verify reproducibility. Each manifest binds one source photo to its fixture dish/revision IDs, with a transparent background, exact byte counts, SHA256 hashes and PR25's three-degree tilt limits. Combined assets stay within 180 KB per dish.

These are preview-only design samples, not restaurant-approved publication assets. The internal previewPortion field is assigned only to fixture menus in development or explicitly enabled PR preview builds. Published bundle adaptation cannot supply it. The normal menu exposes five photos; Berry Pancake Stack remains in PR147's existing edge-cases menu. Missing photos retain the existing unavailable/photo fallback.

Only in local development, the dedicated `scenario=portion-demo` route retains the older single-image review and local 3D test harness. Hosted legacy links use the same dish-specific camera previews as the normal menu.
