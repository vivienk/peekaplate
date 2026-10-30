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
      "summary": "Strict health, staff dish-revision command/result, dish-intent, team analytics query/response schemas, diner observation canonical schemas (ObservationV2 with 9 P0 events, canonicalJson, sha256), Queue message contracts (ObservationQueueMessageSchema, ObservationConflictQueueMessageSchema with multi-copy conflict schema), and S3-VIS-04 bounded menu evidence retrieval schemas (SourceReference, EvidencePassage, BoundedRetrievalResult, RetrievalRequest). Offsets, rank sequences, and aggregate context limits strictly enforced; HTTP command authority fields are rejected. Ingest and broader diner events remain planned.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "0d46192dca37bd0fd8229ffe31927d653c77353a928614975eea058dbc829197"
    },
    {
      "id": "tokens",
      "status": "foundation",
      "summary": "Shared CSS custom-property design tokens imported first by diner/console: motion, typography, radius, spacing, shadows, color palette, and color roles for Button/Navigation/surface/status/input. Chip roles added; WCAG contrast test covers active pairs. Light theme via :root[data-theme=\"light\"] remaps surface/on-surface/outline/input/button/nav roles to gray palette for Console; diner keeps dark :root defaults.",
      "paths": [
        "packages/tokens/package.json",
        "packages/tokens/src/tokens.css",
        "packages/tokens/src/tokens.test.ts"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0004-visual-tiers.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "657afec34a4f9c2da845e614be17fc732469c7d06154242955706c31d8c372b1"
    },
    {
      "id": "ui",
      "status": "foundation",
      "summary": "Shared framework-agnostic component CSS (Button, Card, Input, Typography, Nav) on @peekaplate/tokens. Text button uses --pp-role-on-surface for theme-safe contrast. Console wraps classes in React. Consumed via @peekaplate/ui/components.css.",
      "paths": [
        "packages/ui/package.json",
        "packages/ui/src/index.ts",
        "packages/ui/src/components.css"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md"
      ],
      "dependsOn": [
        "tokens"
      ],
      "sourceFingerprint": "94272a255e023b6b466f5576b38e24d75f0ba3b78db119f31b7217c01a5c6a88"
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
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "d08f53d1c49393f7eac8dc4e6060b73e005fb8503094ed776c6ddb0ee9e6978f"
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
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "78a1ac131ac431ba3657c64a8f8101e0b1ddfa52c1d3efa69ae85a90cfacbf39"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Hono Worker retains staff JWT/membership-checked draft commands and collaborator staging reads. Direct-DO extraction host, named image and idle timeout with signed tenant/job/hash source grants are configured; Python never gets signing or database credentials. Protected OCR key passed standalone verification. Staging configuration adds OBSERVATION_QUEUE, OBSERVATION_ARCHIVE_BUCKET, and queue consumer binding with DLQ. Queue consumer handler processes observation.v2 and multi-copy observation_conflict.v1 envelopes with canonical checksum validation, safe quarantine path for invalid conflict copies, microsecond-accurate time classification matching Postgres CHECK constraints, and tenant-isolated Postgres persistence. S3-VIS-04 menu evidence retrieval configured. Ingestion route and live publication remain planned.",
      "paths": [
        "backend/local.mjs",
        "backend/local.test.mjs",
        "backend/package.json",
        "backend/src/auth.test.ts",
        "backend/src/auth.ts",
        "backend/src/consumer/canonical-json.test.ts",
        "backend/src/consumer/canonical-json.ts",
        "backend/src/consumer/consumer.integration.ts",
        "backend/src/consumer/database.ts",
        "backend/src/consumer/index.test.ts",
        "backend/src/consumer/index.ts",
        "backend/src/consumer/queue-consumer.test.ts",
        "backend/src/consumer/queue-consumer.ts",
        "backend/src/consumer/r2-storage.test.ts",
        "backend/src/consumer/r2-storage.ts",
        "backend/src/consumer/types.ts",
        "backend/src/dish-command.test.ts",
        "backend/src/dish-command.ts",
        "backend/src/dish.integration.ts",
        "backend/src/extraction-capability.ts",
        "backend/src/extraction-host.test.ts",
        "backend/src/extraction-host.ts",
        "backend/src/index.test.ts",
        "backend/src/index.ts",
        "backend/src/retrieval/api.test.ts",
        "backend/src/retrieval/fetcher.ts",
        "backend/src/retrieval/fetcher.workerd-harness.ts",
        "backend/src/retrieval/fetcher.workerd.test.ts",
        "backend/src/retrieval/handoff.test.ts",
        "backend/src/retrieval/handoff.ts",
        "backend/src/retrieval/index.ts",
        "backend/src/retrieval/parser.ts",
        "backend/src/retrieval/ranker.ts",
        "backend/src/retrieval/retrieval.test.ts",
        "backend/src/retrieval/retriever.ts",
        "backend/src/retrieval/security.test.ts",
        "backend/src/retrieval/security.ts",
        "backend/src/team-analytics.test.ts",
        "backend/src/team-analytics.ts",
        "backend/src/team-auth.test.ts",
        "backend/src/team-auth.ts",
        "backend/tsconfig.json",
        "backend/wrangler.extraction.jsonc",
        "backend/wrangler.jsonc",
        "docs/menu-ingestion-infrastructure.md",
        "scripts/menu-ingestion-infra.test.mjs"
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
      "sourceFingerprint": "49abee1ab395be9db0612e12f65e3515d8c9a39cde462de6365adf488d99ad97"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private Postgres venue/event/command/outbox, actor-scoped memberships and tenant-scoped projections remain protected by forced RLS. Local tests cover schema upgrade, atomic commands and connection reuse; disposable Docker startup waits for TCP before migrations. Hosted staff checks are recorded separately. Private PostHog export remains append-only with eight raw copies/four deduplicated synthetic events. October 22 read-only audit confirms migration 20261021130000 and history, sole staging scope 675372, restricted security-definer ownership/execution and denied browser/runtime raw access. Runtime cannot read scope directly; exporter has no application-schema access. Physical hosted pool reuse and restore remain unverified.",
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
      "summary": "Main remains the staging/production release source under ADR0012. This sync reconciles main82f3876 release fixes with develop00856e1, preserving retrieval/contracts, preview lifecycle evidence and both error/learning histories. Direct-DO host runtime, OCR setup and current operations are shared with develop; this Git merge does not deploy or change credentials/data. Isolated previews retain trusted build/deploy separation and verified cleanup. Full hosted ingestion/reporting acceptance and production remain separate.",
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
      "sourceFingerprint": "0e24f1c1c7ac2ea398bb929da107b3d9080f9048b277e683d6e446bf894840d3"
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
      "summary": "Python PDF/image acquisition validates Engine3-compatible OCR, preserves later native pages after failures and retains evidence-linked needs_review drafts. Staging FastAPI/Uvicorn runs in the protected Cloudflare Container. October28 fresh operator-side OCR read three synthetic names/prices in4.654s without cache; key stored in GitHub staging and host bindings. This was not hosted full extraction or accuracy acceptance. Expected CLI exit2 preserves partial/failed reports. Full AI provider configuration and VIS01 feature acceptance remain pending. Python gets no source-signing/database credentials or publication permission.",
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
      "summary": "S3-DATA-02 hardened the observation queue consumer and resolved two reproducible P2 findings: invalid conflict copies now have a durable quarantine path in R2 and PostgreSQL observation_conflict without raw unvalidated field leakage or accepted-fact promotion, and timestamp classification now preserves microsecond precision to match PostgreSQL's timestamptz future_time CHECK constraint. Consumer strictly validates ObservationQueueMessage and multi-copy ObservationConflictQueueMessage envelopes, archives copies to deterministic R2 keys, enforces tenant-isolated Postgres transactions with app.tenant_id, and wires createQueueHandler into Worker index.ts with DLQ retry policy.",
      "modules": [
        "contracts",
        "backend"
      ],
      "next": "Re-review on feat/s3-data-02-queue-consumer. Await integration dependency order (#32 -> #50 -> #40 -> #31) and complete full archive-to-DB/ACK/recovery acceptance with migrated database before enabling collection on staging queue."
    },
    {
      "summary": "S3-TOK-01 ships shared @peekaplate/tokens imported by both apps, plus @peekaplate/ui CSS-only component library (Button, Card, Input, Typography, Nav) built only on tokens; console wraps these classes in React. Tokens encode Animation motion, Design System text styles, radius, spacing, shadows, palette and semantic roles, including nav hover icon and chip active/inactive roles from Figma. Surface-container is neutral-700 and needs a border; on-error/on-information use neutral-950 for WCAG AA. A WCAG contrast test covers active pairs; shells remain locally styled.",
      "modules": [
        "tokens",
        "ui",
        "diner",
        "console"
      ],
      "next": "Confirm remaining design details (ease-out curve, licensed brand font, H2/footer weights, Figma shadow styles) and console light-theme role mappings; chip hover/pressed states remain pending Figma. Review stacked PR base feat/s3-tok-01-button-roles before merge."
    },
    {
      "summary": "Reconciled main82f3876 into develop00856e1 through a dedicated sync branch. Kept develop retrieval routes/contracts/security tests, exports and hosted preview acceptance; imported main direct-DO runtime, worker types, OCR regression and current operations docs. Fixed the combined typecheck with an explicit default TextDecoder BOM option and Node URL import; no type weakening. Resolved context structurally and preserved both error/learning histories. No feature branch, cloud binding, key, migration or deployment changes.",
      "modules": [
        "backend",
        "contracts",
        "processing",
        "delivery"
      ],
      "next": "Record combined local/CI verification in the sync PR and merge after review. Teeyansh then updates his own feature branch from develop and reruns its checks; PR45 final review, approved AI configuration, migration/consumer release and full hosted ingestion acceptance remain separate. Keep menu delivery paused."
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
      "summary": "VIS-01 staging menu Queue/DLQ created and synthetic R2/archive-before-ACK/retry-to-DLQ checks passed; empty/paused, observations unchanged. Added producer/report aliases and optional bounded Python HTTP/container host. Independent review found and reproduced partial CLI-exit handling and global source-authority gaps; fixes preserve exit2 reports and require tenant/job/hash grants signed outside Python.111Python tests and actual Worker/privateR2 grant-denial probe pass. Scoped Containers login authorized, but account eligibility API still denies activation; no plan upgrade, service deployment, feature PR, database or production change.",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "next": "Release bindings via reviewed main and protected staging approval. Account owner must resolve Container entitlement/member access; do not infer a missing paid plan from the provider error. Deploy service with protected signing/service/OCR/LLM secrets. Teeyansh aligns PR45 source snapshots, claim-time capability minting, deadlines/leases/report storage, reviewed migrations and real consumer. Replace temporary pull consumer and pass full menu-to-draft/retry/DLQ/tenant acceptance before collection."
    },
    {
      "summary": "PR41 merge audit found staging healthy with unchanged deployments, default-main preview activation missing and a Windows link-fixture failure. Main-only repair PR #47 merged as ab6f9c4 with green CI. GitHub-held credentials passed synthetic PR #48 upload, exact-SHA aliases, browser rendering and one bot comment in run 40393096652. Closing PR #48 triggered cleanup 40393553935; both provider lists became empty and aliases/markers settled to 404. Portable link rejection and stale-marker regressions pass. Evidence is in docs/previews.md; staging, migrations and production are unchanged.",
      "modules": [
        "delivery"
      ],
      "next": "Finish the reviewed develop companion merge and recheck its final automatic cleanup. Review future PRs through their bot preview links; repeat lifecycle acceptance after workflow/provider changes. Application promotion and protected staging/production deployments remain separate."
    },
    {
      "summary": "Fixed the Docker database readiness race observed after PR #24 in develop run 40146434333: SQL assertions and Worker integration passed, but the fresh local-smoke database refused TCP migrations. The readiness probe now uses 127.0.0.1:5432 instead of accepting the socket-only bootstrap server. A deterministic regression failed with the same connection-refused error before the fix and passes afterward. Real Docker checks passed all 73 SQL assertions, 20 integration cases and local startup/demo/cleanup. No application, schema, credentials or deployment behavior changed.",
      "modules": [
        "database",
        "delivery"
      ],
      "next": "Require green CI on the fix and verify the resulting develop push. Preserve immediate migration failures and the bounded readiness loop; do not hide startup races with fixed sleeps or retries of arbitrary SQL."
    },
    {
      "summary": "Reconciled PR #24 with merged PR #23 at develop 138a4b7. Preserved the retrieval/contracts nodes, local Python processing node, staging Queue/R2/access handoffs and both append-only error histories. Processing sources remain identical to reviewed 0e3f204; the merge adds no extraction, authorization, deployment or publication behavior. Windows checks passed: 89 Python, 187 TypeScript and 33 script tests, lint/types/context/docs, application dry-run builds and Python wheel/sdist. Four optional workerd cases were not rerun here. Retired only the historical design-link-only handoff to retain the ten-entry cap.",
      "modules": [
        "processing",
        "backend",
        "contracts",
        "delivery"
      ],
      "next": "Keep shared-source adapter/application integration, representative OCR/LLM accuracy evidence, the verification layer and PM acceptance separate from package merge. PR #25 must rebase onto the merged extraction package rather than restore its old copy; follow #23 then #24 then #25."
    }
  ]
}
```
