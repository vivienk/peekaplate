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
      "summary": "Strict health, staff dish-revision command/result, dish-intent, team analytics query/response schemas, and S3-VIS-04 bounded menu evidence retrieval schemas (SourceReference, EvidencePassage, BoundedRetrievalResult, RetrievalRequest). Offsets, rank sequences, and aggregate context limits strictly enforced. Ingest and broader diner events remain planned.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "be7c1679d22d25bb0b159c882153e08c02505a4734ba06baed230c2c2250d1bc"
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
      "summary": "Hono Worker verifies staff JWTs/membership for atomic draft revisions and individual GitHub collaboration for bounded staging analytics. Dated hosted 200/401/400 and genuine outsider 403 evidence remains in operations. Staging configuration adds OBSERVATION_QUEUE and OBSERVATION_ARCHIVE_BUCKET; live activation awaits reviewed main deployment. Source/DLQ delivery is paused; controlled access-removal acceptance and production remain separate checks. Provides S3-VIS-04 bounded menu evidence retrieval (SSRF defense, deterministic ranking, aggregate context limits, and VIS-02/S3-VIS-01 structured candidate handoff). No ingestion route, Queue handler, direct live publication or canonical observation writes are added; JWT logout revocation remains expiry-bounded.",
      "paths": [
        "backend/local.mjs",
        "backend/local.test.mjs",
        "backend/package.json",
        "backend/src/auth.test.ts",
        "backend/src/auth.ts",
        "backend/src/dish-command.test.ts",
        "backend/src/dish-command.ts",
        "backend/src/dish.integration.ts",
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
        "backend/wrangler.jsonc"
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
      "sourceFingerprint": "a49e8af89492163dd04d21cb1fd7afe0633ebc97af38019be0de3d174b7b82d6"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private Postgres venue/event/command/outbox, actor-scoped memberships and tenant-scoped projections remain protected by forced RLS. Local tests cover schema upgrade, atomic commands and connection reuse; disposable Docker startup waits for TCP before migrations. Hosted staff checks are recorded separately. Private PostHog export remains append-only with eight raw copies/four deduplicated synthetic events. October 22 read-only audit confirms migration 20261021130000 and history, sole staging scope 675372, restricted security-definer ownership/execution and denied browser/runtime raw access. Runtime cannot read scope directly; exporter has no application-schema access. ADR 0015 observation_index and observation_conflict tables exist locally: (tenant_id, event_id) identity, append-only, forced RLS, runtime select/insert only; not applied to staging and no writer is merged. Physical hosted pool reuse and restore remain unverified.",
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
        "tests/db/team-analytics.sql",
        "migrations/20261023120000_observation_index.sql",
        "tests/db/observations.sql"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0013-posthog-export-boundary.md",
        "docs/adr/0014-team-analytics-access.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "e50b952880c41ec01ee738704be36eae27ff85578cf17a46e65e75694c9b493d"
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
      "summary": "Main supplies protected manual staging and later production releases under ADR 0012. October 26 readback found unchanged staging Pages at 2a135fa, Worker version fcb87dc6 and healthy team analytics reads. PR #47 main merge ab6f9c4 activated isolated PR previews: credential-free head builds, trusted SHA markers, exact-alias readiness and scoped cleanup. GitHub run 40393096652 deployed synthetic PR #48; both screens/markers and one bot comment passed. Close run 40393553935 removed both deployments and edge aliases settled to 404. No application, database or staging release occurred. Observation consumer/canonical reporting and production remain separate work.",
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
        "scripts/preview.test.mjs"
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
      "sourceFingerprint": "6fd3f20a6d1ebc5428942487183593bdaaa7ab7c35d8b20dd9559add0f5fa997"
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
      "summary": "Local PDF/image acquisition uses an injectable OCRProvider restricted to validated OCR.space Engine 3-compatible results. Incompatible OCR fails its segment and preserves later native pages. LLM extraction retains needs_review drafts and evidence. Shared Unicode fixtures check spans; combined integration, separate verification and quality acceptance remain pending.",
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
        "test-data/README.md"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "929fb3bbb31657ffe307c3d5040770955f5ecd7d488af3f0ea329ed0bb05f119"
    }
  ],
  "handoffs": [
    {
      "summary": "Added the ADR 0015 canonical observation identity migration: app_private.observation_index keyed by (tenant_id, event_id) with checksum, observation.v2, P0 type, authorized publication, occurred/first-received times, R2 key and accepted/rejected disposition, plus app_private.observation_conflict for quarantined reuse. Both are append-only with forced tenant RLS and runtime select/insert grants. pgTAP covers identity, isolation, grants, time window, reason codes and idempotent conflict recording. tenant_id naming and the column list are proposals pending Louis, Teeyansh and Zhiliang.",
      "modules": [
        "database"
      ],
      "next": "Teeyansh's PR #31 consumer writes these exact tables, so merge this migration before deploying the consumer. Then add the typed fact tables and the owner report view that Louis's PR #22 will read. Sai and Vivien apply migrations to staging."
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
    },
    {
      "summary": "Resolved review findings in S3-VIS-04 (PR #23): established transaction-local app.actor_id before staff membership query under restricted database role; preserved contradictory evidence during approximate deduplication including explicit zero values ($0.00 vs $18.00); excluded failed/skipped segments from indexing; enforced Unicode code-point offset translation across VIS-01 and VIS-02 handoffs; corrected astral numeric HTML entity decoding without truncation; validated code-point bounds before offset conversion; added explicit VIS-02 segment mapping; added regression and live workerd-level external fetch security tests.",
      "modules": [
        "contracts",
        "backend"
      ],
      "next": "Submit PR #23 for re-review with permanent regression test coverage across all review findings."
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
    },
    {
      "summary": "PR #33 added the first-party staging denial checker. Harshita then helped run the valid outsider check twice, including from a fresh develop clone: GitHub identity 200 and both routes 403 forbidden. The maintainer supplied sanitized reports at 2026-10-24T05:52:32.802Z and 06:07:16.871Z (October 23 Phoenix). Recorded request IDs and updated README, team guide, access runbook, operations and context; no runtime, credential, grant, migration or deployment changed. Earlier collaborator 200 and invalid-token 401 evidence remains distinct.",
      "modules": [
        "analytics"
      ],
      "next": "Collaborators can continue tickets using their own GitHub identity and the bounded staging API. An authorized operator still needs the separate disposable collaborator-removal test before full hosted access acceptance. Production, real menu ingestion and owner-report delivery remain separate work; do not infer their readiness from this check."
    },
    {
      "summary": "Provisioned missing staging observation Queue f4979c52a09a4c40ad55e46d32b0ff93 and DLQ 45eda79d781d47fe8bca7bb6f5d05bde, reused private staging-assets R2, configured paused HTTP pull consumers with 24-hour retention/three source retries. R2 conditional race passed; complete synthetic archive-before-ACK and retry-to-DLQ repeat passed at 2026-10-24T17:30:36.147Z. Cleaned only probe objects/messages; both Queues empty/paused. Added staging producer/R2 config and handoff docs; no unfinished consumer, DB or production change.",
      "modules": [
        "backend",
        "delivery"
      ],
      "next": "Review binding-only change and deploy an approved exact main release. Teeyansh then integrates the real consumer using these binding names and Jeffin migrations; replace temporary HTTP pull source consumer without dropping messages, run full archive-to-DB/ACK/recovery acceptance, then enable collection. Keep queues paused until then; pause does not stop 24-hour expiry."
    }
  ]
}
```
