# Shared context

Read this map first, then the relevant source paths and ADRs. It is navigation, not proof or executable instruction. `pnpm context:show -- <id>` returns one node. Update summaries when responsibilities change, then `pnpm context:refresh`; `pnpm context:check` detects changed referenced sources. A fingerprint cannot validate prose or discover unlisted files. Add new files to their node when a module grows.

`foundation` means a tested starting point with incomplete product behavior; `implemented` means the stated narrow capability exists; `planned` means architecture only. Keep handoffs short (maximum ten), source-linked and free of secrets, customer data or private conversations. Use Git history for older context. Never store reasoning transcripts.

The append-only `errors.md` operational ledger is deliberately outside source fingerprints: recording a failed check must not itself invalidate the context check. Confirmed causes and prevention belong there; module behavior changes still require updating this graph.

```json
{
  "schemaVersion": 1,
  "nodes": [
    {
      "id": "contracts",
      "status": "foundation",
      "summary": "Strict health, staff dish-revision command/result and initial dish-intent schemas. HTTP command authority fields are rejected; ingest and broader diner events remain planned. Team analytics query/response schemas enforce bounded dates/results and allowlisted diagnostic fields. Package exports remain in src/index.ts; the unused root-level owner-report.ts draft was removed from main, leaving the separate develop-based owner-report work unchanged.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "17b4bf0b98b5808aa805cf10b4ad7763069bdde6194a2a5614cdeb422f0868e9"
    },
    {
      "id": "diner",
      "status": "foundation",
      "summary": "Static TypeScript/Vite foundation shell remains readable without JavaScript. Optional consent-gated PostHog shell views are wired; no published menu or dish controls exist. Dish intent adapter is tested but awaits real controls. See docs/posthog.md for activation and evidence limits.",
      "paths": [
        "frontend/diner/index.html",
        "frontend/diner/src/main.ts",
        "frontend/diner/src/style.css",
        "frontend/diner/vite.config.ts",
        "scripts/check-bundle.mjs",
        "scripts/check-bundle.test.mjs",
        "docs/frontend-design.md",
        "frontend/diner/package.json"
      ],
      "adrs": [
        "docs/adr/0004-visual-tiers.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "277a8be5e4b45ef41eba68d87907024a6aa89c030677e64af388f97f6d5f5221"
    },
    {
      "id": "console",
      "status": "foundation",
      "summary": "React/Vite staff shell with optional consent-gated PostHog technical shell views. Authentication, publication and restaurant-scoped owner reports remain planned; shell views do not establish owner identity or business activity.",
      "paths": [
        "frontend/console/src/main.tsx",
        "frontend/console/src/style.css",
        "frontend/console/index.html",
        "frontend/console/package.json"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "76fee1388a2aa45d7ffaf13527a727816305f7038d4f48e0d17cb00181145893"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Staging API Queue/R2 aliases and separate Python host are deployed with protected service/signing configuration. Hosted authorization and signed source checks passed. OCR_SPACE_API_KEY is now in the protected GitHub staging environment and extraction Worker; a focused test verifies Python forwarding without its signing key. Fresh standalone provider OCR passed, not hosted extraction. Full AI configuration, feature consumer/migration and upload-to-drafts/ACK acceptance remain pending; queues stay paused.",
      "paths": [
        "backend/src/index.ts",
        "backend/src/index.test.ts",
        "backend/wrangler.jsonc",
        "backend/src/auth.ts",
        "backend/src/auth.test.ts",
        "backend/src/dish-command.ts",
        "backend/src/dish-command.test.ts",
        "backend/src/dish.integration.ts",
        "backend/local.mjs",
        "backend/local.test.mjs",
        "backend/package.json",
        "backend/src/team-analytics.ts",
        "backend/src/team-analytics.test.ts",
        "backend/src/team-auth.ts",
        "backend/src/team-auth.test.ts",
        "backend/src/extraction-capability.ts",
        "backend/src/extraction-host.ts",
        "backend/src/extraction-host.test.ts",
        "backend/wrangler.extraction.jsonc",
        "docs/menu-ingestion-infrastructure.md",
        "scripts/menu-ingestion-infra.test.mjs",
        "backend/tsconfig.json"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0014-team-analytics-access.md"
      ],
      "dependsOn": [
        "contracts",
        "database"
      ],
      "sourceFingerprint": "71e3eec5fb2d2d0bc4709fc012b3a25326ef5207af614f485e35e60155c7ef57"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private Postgres venue/event/command/outbox, actor-scoped memberships and tenant-scoped projections remain protected by forced RLS. Local tests cover schema upgrade, atomic commands and connection reuse; hosted staff checks are recorded separately. Private PostHog export remains append-only with eight raw copies/four deduplicated synthetic events. October 22 read-only audit confirms migration 20261021130000 and history, sole staging scope 675372, restricted security-definer ownership/execution and denied browser/runtime raw access. Runtime cannot read scope directly; exporter has no application-schema access. Physical hosted pool reuse and restore remain unverified.",
      "paths": [
        "migrations/202610130001_foundation.sql",
        "tests/db/foundation.sql",
        "tests/db/Dockerfile",
        "scripts/test-db.mjs",
        "scripts/test-db.test.mjs",
        "migrations/20261014210000_staff_commands.sql",
        "tests/db/staff.sql",
        "migrations/20261020070000_posthog_exports.sql",
        "tests/db/posthog.sql",
        "migrations/20261021130000_team_analytics.sql",
        "tests/db/team-analytics.sql"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0013-posthog-export-boundary.md",
        "docs/adr/0014-team-analytics-access.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "5c576f557201a6d1af09e9c2c860bb1e5cd0430a3af8fdc6b3e8f1ee4528c0e6"
    },
    {
      "id": "measurement",
      "status": "planned",
      "summary": "Venue-bound redeem codes will link sessions to POS tickets. Unknown linkage stays unknown. Planned owner readout reports coverage and suppresses cells under ten sessions; frozen blocked-switchback assignment precedes causal claims. No POS or experiment implementation exists.",
      "paths": [
        "docs/delivery.md",
        "docs/implementation_plan.md"
      ],
      "adrs": [
        "docs/adr/0006-orders-and-measurement.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [
        "backend"
      ],
      "sourceFingerprint": "5fc2bb2fddca8d87f6d03aab9cf8e1922e1d921d9c66d2eee027e5cba8fdf853"
    },
    {
      "id": "delivery",
      "status": "foundation",
      "summary": "PR60 scheduler repair is deployed; hosted authorization and genuine remote Queue/R2/ACK/retry/DLQ tests passed. October28 OCR key stored in GitHub staging and extraction Worker; other bindings preserved and fresh standalone OCR passed4.654s. Runtime code, image, API, database and production unchanged. Updated handoff distinguishes credential setup from AI configuration and complete feature acceptance. Queues remain paused; PR45 verifier zero-check result needs correction before reliance.",
      "paths": [
        "README.md",
        "SECURITY.md",
        "docs/team_guide.md",
        "package.json",
        "pnpm-workspace.yaml",
        ".github/dependabot.yml",
        "CONTRIBUTING.md",
        ".github/workflows/ci.yml",
        ".github/workflows/deploy-staging.yml",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "scripts/check-pr.mjs",
        "scripts/check-pr.test.mjs",
        "scripts/check-docs.mjs",
        "scripts/check-docs.test.mjs",
        "playwright.config.ts",
        "tests/e2e/foundation.spec.ts",
        "docs/operations.md",
        "scripts/verify.mjs",
        "scripts/verify.test.mjs",
        "docs/verification.md",
        "vitest.db.config.ts",
        ".github/main-ruleset.json",
        ".github/develop-ruleset.json",
        "docs/repository-migration.md",
        "docs/adr/0010-canonical-repository-and-release-branches.md",
        "docs/adr/README.md",
        "docs/adr/0011-staging-environment-branch.md",
        "docs/adr/0012-main-environment-promotion.md",
        "docs/implementation_plan.md",
        "docs/delivery.md",
        "playwright.posthog.config.ts",
        "tests/e2e/posthog.spec.ts",
        "docs/observation-infrastructure.md",
        ".github/workflows/deploy-preview.yml",
        "docs/previews.md",
        "scripts/preview.mjs",
        "scripts/preview.test.mjs",
        "docs/menu-ingestion-infrastructure.md",
        "scripts/menu-ingestion-infra.test.mjs",
        "pnpm-lock.yaml"
      ],
      "adrs": [
        "docs/adr/0007-delivery-and-recovery.md",
        "docs/adr/0012-main-environment-promotion.md"
      ],
      "dependsOn": [
        "diner",
        "console",
        "backend"
      ],
      "sourceFingerprint": "04171ae7a656107ffe1ed2ad2d71abb97223e4becfd7f4e574fe3746c7f10811"
    },
    {
      "id": "agents",
      "status": "implemented",
      "summary": "Paired Claude/Codex review roles share an evidence/JSON review contract; repo-guide returns task briefs and task-builder returns implementation handoffs. Five bounded behavior cases met expectations after correcting and retesting builder ownership/verification instructions. Native role discovery and tool enforcement remain unverified due to client/environment limits. Builders hand off dependencies outside ownership and source fingerprint updates. Prompt parity and these cases do not prove general model accuracy.",
      "paths": [
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/skills/peekaplate-review/SKILL.md",
        ".claude/agents/review-coordinator.md",
        ".claude/agents/architecture-reviewer.md",
        ".claude/agents/correctness-reviewer.md",
        ".claude/agents/repo-guide.md",
        ".claude/agents/task-builder.md",
        ".codex/agents/review-coordinator.toml",
        ".codex/agents/architecture-reviewer.toml",
        ".codex/agents/correctness-reviewer.toml",
        ".codex/agents/repo-guide.toml",
        ".codex/agents/task-builder.toml",
        "scripts/context.mjs",
        "scripts/context.test.mjs",
        "docs/research/reviewer-evaluation.md"
      ],
      "adrs": [
        "docs/adr/0008-agent-context-and-review.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "6de26962de2dbd484415e39cd6bfbd2b73a4eaef589faa60ed34e2c70e4d3ead"
    },
    {
      "id": "analytics",
      "status": "foundation",
      "summary": "Consented synthetic staging shell capture and restricted hourly PostHog export are verified; dish controls remain unconnected. Repeated exports retained eight raw copies/four deduplicated events. The collaborator-authorized API returns redacted diagnostics, not owner reports. The Node/GitHub CLI checker has progress, timeouts and no token prompt. Two user-run October 23 checks verified a valid outsider identity (200) and both endpoint denials (403 forbidden), including a fresh-clone repeat; sanitized evidence is in operations.md. Controlled collaborator-removal acceptance and production remain untested. Canonical owner facts and reporting remain planned.",
      "paths": [
        "packages/analytics/package.json",
        "packages/analytics/tsconfig.json",
        "packages/analytics/src/index.ts",
        "packages/analytics/src/consent.ts",
        "packages/analytics/src/index.test.ts",
        "docs/posthog.md",
        "docs/posthog-export.md",
        "docs/team-data-access.md",
        "scripts/verify-team-access.mjs",
        "scripts/verify-team-access.test.mjs"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0006-orders-and-measurement.md",
        "docs/adr/0013-posthog-export-boundary.md",
        "docs/adr/0014-team-analytics-access.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "1dd5e77257b699965de953a06b67cae41efa432a18b804d92f6e69d68988d8e0"
    },
    {
      "id": "processing",
      "status": "foundation",
      "summary": "Python PDF/image OCR and AI package plus deployed staging FastAPI/Uvicorn container. October28 fresh OCR.space Engine3 adapter call read three synthetic dishes/prices in4.654s without cache. OCR key is protected in GitHub staging and host secret bindings. This was operator-side OCR, not hosted full extraction or quality acceptance. Full AI provider configuration and VIS01 integration remain pending. Python gets no source-signing or database credentials; no automatic 2.5D/3D generation or publication.",
      "paths": [
        "processing/.gitignore",
        "processing/.python-version",
        "processing/README.md",
        "processing/pyproject.toml",
        "processing/src/peekaplate_processing/__init__.py",
        "processing/src/peekaplate_processing/check_llm.py",
        "processing/src/peekaplate_processing/errors.py",
        "processing/src/peekaplate_processing/extract_menus.py",
        "processing/src/peekaplate_processing/images.py",
        "processing/src/peekaplate_processing/model_cache.py",
        "processing/src/peekaplate_processing/ocr_regions.py",
        "processing/src/peekaplate_processing/ocr_space.py",
        "processing/src/peekaplate_processing/pdf.py",
        "processing/src/peekaplate_processing/run_pipeline.py",
        "processing/src/peekaplate_processing/schemas.py",
        "processing/src/peekaplate_processing/sources.py",
        "processing/src/peekaplate_processing/storage.py",
        "processing/src/peekaplate_processing/workflow.py",
        "processing/tests/fixture_factory.py",
        "processing/tests/test_ocr_regions.py",
        "processing/tests/test_ocr_space.py",
        "processing/tests/test_pdf_images.py",
        "processing/tests/test_schemas.py",
        "processing/tests/test_workflow.py",
        "processing/uv.lock",
        "docs/ocr-delivery.md",
        "processing/tests/fixtures/source-spans.json",
        "processing/tests/test_handoff.py",
        "scripts/processing-handoff.test.mjs",
        "processing/src/peekaplate_processing/ocr.py",
        "processing/tests/test_ocr_provider.py",
        "test-data/README.md",
        "processing/src/peekaplate_processing/service.py",
        "processing/tests/test_service.py",
        "processing/Dockerfile",
        "processing/.dockerignore"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "9a915eb9ef0fd34234e116710436f4798e0be3ecc84e9b06cc034b0dfb4c88d1"
    }
  ],
  "handoffs": [
    {
      "summary": "October30 main cleanup: removed packages/contracts/owner-report.ts, an unexported draft outside the TypeScript source tree that broke Biome on main682ab7f. Local lint, typecheck, 69 Vitest and 57 script tests, builds and context/docs checks passed in 20.143s. No caller, runtime, migration or deployment changes; separate develop schema work is untouched.",
      "modules": [
        "contracts"
      ],
      "next": "Merge only this cleanup into main after applicable PR CI passes. Louis continues the owner-report contract separately through a develop-based PR; no main-to-develop sync or feature-branch changes belong in this cleanup."
    },
    {
      "summary": "October28: stored OCR_SPACE_API_KEY in protected GitHub staging environment and existing extraction Worker. Host version7b505396 retains main7bbe0d3 code/image and other bindings. Fresh OCR-only provider call read all three synthetic names/prices in4.654s with no cache; local output stays outside Git. Focused host regression checks OCR forwarding and signing-key exclusion. No production, migration or consumer activation.",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "next": "Teeyansh fixes PR45 verifier zero-check success, finalizes reviewed consumer/deadline settings and prepares controlled E2E cases. Operators configure the approved AI provider and verify/apply the reviewed migration/release before replacing the temporary pull consumer. Run full upload-to-drafts/ACK and failure/tenant checks before enabling real submissions. Hosted full extraction remains NOT RUN."
    },
    {
      "summary": "Completed VIS-01 host activation after Paid upgrade and PR60 directDO repair. Deployed main7bbe0d3 using existing image; set matched internal secrets privately. Hosted health/auth/job/source/hash checks and genuine remote Queue/R2/ACK/retry/DLQ probes passed with exact cleanup and queues paused. Existing team reads200/anonymous401. Corrected previous local-R2 evidence claim after independent hosted read exposed forceLocal helper behavior.",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "next": "Teeyansh can use staging runtime bindings without receiving internal secret values. Configure approved existing OCR/AI provider credentials when ready, finish/review PR45 and its migrations/report adapter, align600s transport with700s processing plus cold start, then run controlled authorized upload→Queue→service→private report→database drafts→ACK and failure/tenant tests before unpausing. No production or restaurant-data tests were performed."
    },
    {
      "summary": "Paid activation resolved Container eligibility. Existing protected API run succeeded and menu aliases are live. Actual container registration then rejected default scheduling; prepared directDO runtime repair with RED/GREEN config guard and startup/readiness/concurrency/failure-recovery tests. Dev-only official Worker types are pinned to mature October26 release; latest October28 was blocked by dependency maturity policy, which remains unchanged.",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "next": "Review and merge runtime repair, deploy its exact main commit, configure matched service/signing secrets through protected provider stores and test real hosted container/R2 authorization. OCR/AI provider credentials are absent; real menu extraction and complete Queue-to-draft acceptance remain separate. Teeyansh can continue local integration, keeping the queue paused."
    },
    {
      "summary": "VIS-01 infrastructure released in PRs54/55: Queue/DLQ and private R2 tested, local service and job-bound relay reviewed, main58838e1 CI green. Actual protected API run40577213391 is waiting for independent approval. Actual container deploy failed at /containers/me with Workers Paid eligibility denial; partial host route stays disabled. Existing API health200 and prior bindings unchanged.",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "next": "Jeffin/Teeyansh approves the existing staging run; verify aliases after success. Vivien activates Workers Paid, then retry the same extraction host and set protected secrets/provider configuration. Teeyansh continues local PR45 admission/hash, claim-time grants, report adapter, deadline and migration/consumer work now. Complete hosted menu-to-draft and recovery/tenant tests before unpausing submissions."
    },
    {
      "summary": "Prepared scoped main promotion of PR54: staging menu Queue/DLQ provisioned/tested and paused, existing private R2 reused. Included the already reviewed PR24 processing package because the new service calls that CLI, plus job-bound source grants and partial-result handling. Excluded unrelated retrieval API/module changes and unfinished feature PRs. Both independent reviews and final feature checks passed; main promotion needs its own CI before protected staging deployment.",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "next": "Merge reviewed main promotion, run its protected staging API deployment and verify actual bindings plus existing access routes. Vivien activates Workers Paid; operator then sets protected signing/service/provider secrets and deploys the standalone host from reviewed main. Teeyansh integrates PR45 admission, claim-time grants, report adapter, migrations and consumer before full synthetic menu-to-draft/recovery/tenant acceptance. Do not enable real collection while queues are paused."
    },
    {
      "summary": "Investigated accidental PR41 develop merge aa7c717: merged CI passed; read-only staging health, frontend and team reads remain HTTP200 with unchanged provider versions. Found default-main workflow activation prerequisite and a Windows EPERM symlink fixture failure. Preview-only main repair carries trusted orchestration/helpers without unreleased app changes, uses a real portable directory link test and exact-SHA alias markers. Local focused tests pass; hosted writes, credentials, staging deployment and migrations are unchanged.",
      "modules": [
        "delivery"
      ],
      "next": "Review the narrow main PR and exact-head CI. After human merge approval, verify an eligible PR upload/comment/render and close cleanup through GitHub Actions, then synchronize preview repairs into develop. Keep application promotion and protected staging deployment separate."
    },
    {
      "summary": "Reconciled main into the PR 27 release branch, preserving October 22 staging controls, verified PostHog export history, team analytics access documentation and both error-ledger histories. Runtime, contracts, migrations and deployment workflow are unchanged from the reviewed develop release. Corrected the team-access activation checklist so migration/history, token permissions and final review/CI are explicit prerequisites to enabling the flag. Final guide cleanup distinguishes the enabled hourly export from the pending team inspection API and links its activation checklist; PR verification metadata is refreshed for the final candidate.",
      "modules": [
        "delivery",
        "analytics"
      ],
      "next": "Review the reconciled PR 27 release after local checks. Read-only hosted audit confirmed migration 20261021130000 is absent; apply and record its forward migration through the database procedure before deployment. Operator OAuth is valid but does not verify GitHub-held tokens. Keep the activation flag off until protected credential/release checks, then deploy reviewed main and run hosted access acceptance."
    },
    {
      "summary": "Recorded the October 22 staging environment settings: exact main branch restriction saved, required reviewers and prevent self-review enabled, administrator bypass allowed, and expected variable/secret names present. Updated stale environment-availability guidance. No secret values, activation flag, workflow code or deployment changed.",
      "modules": [
        "delivery"
      ],
      "next": "Review this documentation PR. Before Actions activation, verify credential permissions, intended staging bindings and the independent approval process; the settings observation is not a successful workflow or deployment test."
    },
    {
      "summary": "Updated deployment selection to main for both environments per the maintainer's explicit instruction. Configured verified non-secret staging account, issuer and Hyperdrive bindings. Provider audit found existing Supabase migrations, forced RLS, restricted staging login, an ES256 public key and uncached Hyperdrive; no duplicate database branch was created. Hosted request behavior remains unverified.",
      "modules": [
        "delivery",
        "backend"
      ],
      "next": "Review and test the staging configuration, run hosted identity and tenant-isolation checks, and record deployment evidence. Production requires separate resources and human release approval for the same tested main SHA."
    }
  ]
}
```
