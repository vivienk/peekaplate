# Diner portion preview evidence

Local development review on Node 24.16.0 / pnpm 11.25.0, Chromium at 390 × 844.
Screenshots exercise the generated PR25 photo/mask fixture through the actual preview UI.

| Loading | Ready |
| --- | --- |
| ![Loading](loading.png) | ![Ready](ready.png) |
| Photo fallback | Failed |
| ![Photo fallback](fallback.png) | ![Failed](failed.png) |

## Verification

- PASS: focused Python processing tests — 34 tests (actual T0, review, spatial and new diner export).
- PASS: `pnpm verify lint typecheck context:check docs:check`.
- PASS: `pnpm verify test build` — 1,214 Vitest tests passed, 4 skipped; all 74 script tests passed. All app builds passed; Worker build was dry-run only.
- PASS: `pnpm exec playwright test --config playwright.portion.config.ts --workers=2` — all 45 browser tests passed on the processor-integrated code.
- PASS: `pnpm exec playwright test --config playwright.portion.config.ts tests/e2e/portion.spec.ts --grep 'Figma|local captured' --workers=2` — all 5 passed again after the backdrop-color correction; screenshots above are from this final run.
- PASS: `PYTHONPATH=processing/src:processing/tests python -m unittest processing/tests/test_diner_demo.py processing/tests/test_review_preview.py processing/tests/test_assets.py processing/tests/test_spatial.py` — 34 passed, rerun after the backdrop correction (existing focused Python environment with Pillow/Pydantic).
- PASS: inspected production output: no demo host, review identity, demo module or photo assets.
- PASS: `git diff --check`.
- Initial JS: 52,657 gzip bytes / 150,000 limit. T1 budget: 372,771 / 400,000 bytes including 48,116 font bytes and the 200,000-byte layer/manifest allowance.
- NOT RUN: full default browser suite, database suite (no database changes), physical phone performance, manual VoiceOver/TalkBack, hosted approved-asset publication.

The final suite supersedes earlier setup failures recorded in errors.md: restricted
local listeners, a missing report link, widened JSON literal typing and a browser
run disrupted while source files were changing. The stable browser run passed.

## Scope and remaining limits

PR25's existing `prepare_review_preview` now actually generates the demo. Its T0
photo validation, supplied mask, cutout and unchanged fallback feed the diner through
`diner_demo.py`; generated `demo.json` retains processor identity and needs_review /
publication-ineligible provenance. This is not optional generated-candidate support
or an approved production publication pipeline. Demo menu facts are placeholders.

Automated architecture/correctness reviews of the processor integration found no
blocking issues. The create-only CLI can leave a partial output directory on a disk
write failure; rerun into a new destination after addressing the disk error.

Figma frames: loading 846:7146, ready 258:6000, photo fallback 221:260, failed 165:2413
in file l7A9n8tACJic0FIhY49Zjw. Exact exported artwork is included. The web preview uses
safe-area insets instead of a simulated native status bar.

No merge or deployment. Local evidence is not hosted publication acceptance.

## Interactive cutout fallback correction — November 10

`previewState=fallback` now selects the PR25 CSS interactive cutout, not a forced
asset failure. `previewState=photo` exercises the original-photo state. The same
CSS path is used when WebGL cannot initialize or its context is lost; it retains
900px perspective, bounded rotation, depth-ranked parallax and the existing inputs.
Both renderers share bounded fetch, SHA-256 verification and retry behavior. CSS
images additionally validate decoded dimensions and release object URLs on Back.

- PASS: `pnpm exec playwright test --config playwright.portion.config.ts --workers=2` — 49 tests; new interactive-fallback regression failed before the correction and passed afterward.
- PASS: `pnpm verify lint typecheck test build` — 1,214 unit tests passed / 4 skipped; 74 script tests passed; app builds and Worker dry-run passed.
- PASS: `pnpm verify context:check docs:check` and `git diff --check`.
- PASS: inspected production JS excludes DEV fixture host/identity.
- T1 delivery budget including fonts and asset allowance: 373,379 / 400,000 bytes.
- NOT RUN: physical phones, manual screen readers or hosted publication acceptance.

This correction is local only. No PR, workflow setting change or deployment.
