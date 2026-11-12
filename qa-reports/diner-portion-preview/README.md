# PR25 viewer inside View Portion — November 11, 2026

Local development evidence on Node24.16.0 / pnpm11.25.0. The latest user direction
selects PR25 review_preview_html.py appearance and behavior within the existing
View Portion shell. Four state categories and Back/retry navigation are preserved.

| Ready | Loading |
| --- | --- |
| ![Ready](ready.png) | ![Loading](loading.png) |
| Original-photo fallback | Failed / retry |
| ![Photo fallback](fallback.png) | ![Failed](failed.png) |

## Implemented behavior

- Warm full-width square stage, rounded corners, radial gradient and contained cutout
  with PR25 drop shadow; controls sit directly above the stage.
- CSS900px perspective, up to±3° rotation,5px/3px translation. Pointer replaces the
  shared position; keys step1/6. Pointer tracking55ms linear, reset/keys300ms ease-out.
- Show original photo / Show review candidate, aria-pressed, Reset view, Home,
  horizontal touch tilt, vertical scrolling and live reduced-motion support.
- No WebGL/Three.js dependency. The spatial backdrop is validated but visually replaced
  by the review gradient; foreground cutout layers move together.
- Original photo must decode before interaction. Missing/invalid cutouts retain the photo;
  missing photo shows failed/retry. Back/Escape/browser history preserve detail state/focus.
- PR25 processing output identity/provenance remains needs_review and publication-ineligible
  in the DEV fixture. No production approval/hosting path was added.

## Verification

- PASS: `pnpm exec playwright test --config playwright.portion.config.ts --workers=2` —51/51 in one clean run. Includes compare/reset, exact motion/timing, original-photo failure, integrity, reduced motion, cancellation, navigation and four screenshots.
- PASS: `pnpm verify lint typecheck test build` —1,214 Vitest tests passed,4 skipped;74 script tests passed; app builds and Worker dry-run passed.
- PASS: final `pnpm verify lint typecheck build context:check docs:check` after layout corrections.
- PASS: `git diff --check`; production JS excludes DEV fixture host and WebGL renderer.
- Initial JS53,014 gzip bytes /150,000 limit. T1 delivery201,297 /400,000 bytes including200,000-byte asset/manifest allowance.
- Inspected all four390×844 screenshots. Read-only architecture/correctness review found no blocking issues on implementation7909e9c.
- NOT RUN: full default browser suite, database suite(no database changes), physical phones,
  manual VoiceOver/TalkBack, hosted approved-asset publication. Python processing unchanged
  in this correction; prior34-test processing evidence remains historical, not rerun here.

Earlier setup/test observations and corrections are recorded in errors.md. The new
appearance/control regression failed against the previous viewer before implementation.

## Local viewing

Open `http://127.0.0.1:5173/?scenario=portion-demo`, select the dish, then View Portion.
`previewState=loading` delays loading; `previewState=photo` forces original-photo fallback;
`previewState=failed` forces failure/retry. Legacy `previewState=fallback` still opens the
interactive cutout. The four categories originate from Figma846:7146,258:6000,221:260,
165:2413; the latest requested PR25 presentation supersedes the prior dark ready layout.

Local branch only. No PR, merge, workflow setting change or deployment.
