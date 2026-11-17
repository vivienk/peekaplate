# Isolated owner backend acceptance

Source: `733c3346afe8b4cdc678e83ec2c098dd60e3fb64`, checked unchanged at the start
and end of the run. Actual console components, local Wrangler Worker HTTP,
disposable migrated PostgreSQL and local private R2; synthetic local signed
identity. No mocked business routes, hosted provider authentication or paid calls.

| Checkpoint | Desktop | Mobile | Observed result |
|---|---|---|---|
| S05 profile/logo | [1440](s05-details-photo-1440.png) | [390](s05-details-photo-390.png) | Upload 201, profile save/read 200; submitted/version 1/photo reference in SQL. |
| S06 source choice | [1440](s06-source-1440.png) | [390](s06-source-390.png) | Existing authored source controls open. |
| S07 PDF intake | [1440](s07-real-pdf-upload-1440.png) | [390](s07-real-pdf-upload-390.png) | Existing synthetic PDF sent through the real upload endpoint. |
| S08 processing | [1440](s08-real-queued-job-1440.png) | [390](s08-real-queued-job-390.png) | HTTP 202 and a queued PDF job in SQL; extraction not run. |
| S09 dish save | [1440](s09-manual-count-1440.png) | [390](s09-manual-count-390.png) | Private photo attached; serving text `1 bowl` and count `2` saved. |
| S09 reload | [1440](s09-reloaded-1440.png) | [390](s09-reloaded-390.png) | Saved fields/photo read back through API and UI. |
| S10 review | [1440](s10-review-1440.png) | [390](s10-review-390.png) | Real photo approval and version-bound draft verification. |
| S11 verified | [1440](s11-verified-1440.png) | [390](s11-verified-390.png) | SQL verified state and the authored success modal. |
| S12 setup | [1440](s12-persisted-1440.png) | [390](s12-persisted-390.png) | Submitted details, menu added/verified, unpublished. |

Outsider draft access returned 403; a valid stale verification version returned
409. Screenshots use the official entry's CSS order, light theme, language and
viewport. All eighteen were inspected. The tiny synthetic image tests persistence,
not photography quality. S09 desktop captures show the current inner scroll
position. The mobile review table starts horizontally cropped; separate table
scroll interaction was not exercised. S07 reports unavailable PDF preview honestly.

Cleanup passed: browser, Vite, Worker, local issuer, database container/network,
temporary configuration and R2 storage removed. Independent port checks found
5174, 8787 and the run's database port closed; no owned Docker resources remained.

NOT RUN: fresh Python OCR, AI/provider acceptance, real provider authentication,
S13 prepared publication/diner navigation or physical AR calibration. S13's
unchanged reader accepts only approved staging HTTPS bundle origins; this local
run did not bypass that policy. The separate workspace browser suite tests S13
using controlled HTTP fixtures. These are different evidence boundaries.
