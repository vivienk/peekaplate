# PR162 plate calibration verification — 2026-11-13

Implementation reviewed at `3b52ee2407091099ebcf03741f45ae5cfff5ed26` by separate automated architecture and correctness reviewers: no supported findings in the inspected change. Review does not authorize merge or establish device accuracy.

- PASS: `pnpm verify lint typecheck test build` (authorized local networking): 1,225 unit tests, four skipped; 81 script tests. Full command also requested context/docs; context initially exceeded ten handoffs, then was corrected.
- PASS: `pnpm verify context:check docs:check` after keeping ten bounded handoffs.
- PASS: `PYTHONPATH=processing/src:processing/tests <focused-venv>/bin/python -m unittest test_portion_ingestion test_portion_service test_cutout`: 18 tests.
- PASS: `pnpm exec playwright test --config playwright.landscape-local.config.ts --output /private/tmp/plate-landscape-results`: three portrait/landscape/orientation checks including exact-source Original photo and Return to AR.
- PASS: `PEEKAPLATE_LIVE_CUTOUT=1 pnpm exec playwright test --config playwright.cutout-local.config.ts`: three real local U2NetP uploads covering normal, missing-photo and legacy-demo dishes. The final isolated-output rerun additionally verifies that editing a boundary clears owner confirmation.
- The retained landscape screenshot uses a simulated camera background. Upload segmentation uses the actual local model; camera, orientation and table tracking are not physical-device acceptance evidence.

Verified boundaries: original source SHA/dimensions, foreground SHA, bounded plate measurement and source boundary, explicit confirmation, legacy width-only remains approximate, exact original photo retained, unchanged View Portion/Compare row and back navigation. The plate footprint uses world metres only with tracked placement. The flat cutout and uncalibrated 3D mesh remain approximate; no physical accuracy guarantee is made.

NOT RUN: real-phone metric footprint/table tracking validation. Hosted owner photo upload is not provided by static Pages; the editor/private bridge remains local DEV-only. PR147 fixture plates have no invented measurements. No merge or staging/production deployment.
