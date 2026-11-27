# S7-RES-09 — Owner Review Gate Acceptance Report

- **Date:** November 25, 2026
- **Ticket:** S7-RES-09
- **PR:** [#266](https://github.com/vivienk/peekaplate/pull/266) (`feat/s7-res-09-owner-review-gate`)
- **Reviewed commit:** `8f89bbab` (rebased cleanly onto `origin/develop` `c66b328f`, plus Playwright E2E spec)
- **Existing Artifact Reused:** `docs/s7-res-09-owner-review-gate.md` (PR #266)
- **Status on November 25:** **READY FOR REVIEW / HOSTED ACCEPTANCE PENDING**. The author recorded local, Playwright and CI checks. The listed PostgreSQL/pgTAP run used the pre-rebase commit. PR approval, merge and hosted verification remain pending.

---

## 1. Author's test record

- `node scripts/context.mjs check`: **PASS** (`13` modules, `10` handoffs).
- `node scripts/check-docs.mjs`: **PASS** (`104` Markdown files).
- `biome check` (`10` changed files including `tests/e2e/s7-res-09-review-gate.spec.ts`): **PASS**.
- `tsc -p packages/contracts/tsconfig.json && tsc -p backend/tsconfig.json --noEmit && tsc -p frontend/console/tsconfig.json --noEmit`: **PASS**.
- `vitest run backend/src/owner-prepare.test.ts backend/src/publication-command.test.ts frontend/console/src/onboarding/MenuProcessing.test.tsx frontend/console/src/owner/review/reviewDishes.test.tsx packages/contracts/src/owner-menu.test.ts`: **PASS** (`5` files, `47/47` tests).
- `playwright test tests/e2e/s7-res-09-review-gate.spec.ts`: **PASS** (`2/2` tests).
- `gh pr checks 266`: **PASS** (`9/9` successful, `1` skipped, `MERGEABLE` / `CLEAN` on `8f89bbab`).
- `node scripts/test-db.mjs` (Docker `28.3.3`, executed on `ec3e9f17` prior to `develop` rebase): **PASS** (`18` pgTAP suites, `22` integration files / `207/207` tests including `s7-res-09-owner-review-gate.integration.ts`).

---

## 2. Coverage Summary

- Automatic checks (`MenuProcessing.tsx`, `reviewDishes.ts`) never grant owner approval or publish.
- `verifyOwnerDish`, `approveDishDraftAtomic`, `prepareOwnerMenu`, `approveMenuRevision`, and `publishMenu` reject incomplete dishes, `proposed` allergens (`409 draft_incomplete`), stale approvals after edits/retries (`409 menu_not_verified`), spoofed `verification_status` (`400`), and cross-venue access (`403`).

---

## 3. Remaining External Dependencies

1. **PR #266** review approval and merge to `develop`.
2. **Hosted staging verification** remains pending while the [Meta freeze](production-release.md) is active. After the freeze is lifted and staging changes are authorized, promote the reviewed candidate to `main` and dispatch the staging Worker workflow for that exact `main` commit. Record the commit and deployment ID, then verify the owner flow with authorized staging console auth and publication under [ADR 0012](adr/0012-main-environment-promotion.md).
