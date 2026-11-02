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
      "summary": "Strict staff/publication/public-menu, analytics and retrieval contracts plus nine canonical observation types, receipts, canonical JSON and microsecond time helpers. Queue contracts retain server-derived traffic_class with live default and normalize payloads through ObservationV2 before hashing; compatibility aliases remain. Contracts reject client authority and private/unknown payload fields. RES-01.1 adds strict review candidates for paired schema1/pipeline2 and schema2/pipeline3, preserving IDs, printed prices, hierarchy and code-point evidence with synthetic fixtures; segment metadata preserves Python-validated candidate box links (TypeScript does not verify OCR joins). Offline contract, not a deployed review API.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts",
        "packages/contracts/fixtures/observation.v2/fixtures.json",
        "packages/contracts/fixtures/observation.v2/README.md",
        "packages/contracts/src/review-candidates.ts",
        "packages/contracts/src/review-candidates.test.ts",
        "processing/tests/fixtures/review-candidates/box-evidence-candidates.json",
        "docs/review-candidates.md",
        "processing/tests/fixtures/source-spans.json",
        "processing/tests/fixtures/review-candidates/README.md",
        "processing/tests/fixtures/review-candidates/field-limits.json",
        "processing/tests/fixtures/review-candidates/invalid-extraction.json",
        "processing/tests/fixtures/review-candidates/missing-price-candidate.json",
        "processing/tests/fixtures/review-candidates/priced-candidate.json",
        "processing/tests/fixtures/review-candidates/representative-candidates.json",
        "processing/tests/fixtures/review-candidates/representative-candidates-v2.json",
        "processing/tests/fixtures/review-candidates/representative-extraction.json",
        "processing/tests/fixtures/review-candidates/representative-extraction-v2.json",
        "processing/tests/fixtures/review-candidates/zero-price-candidate.json"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "d2d8867bf3829ef2e26b7a4891875170d53c5f17669ec9058e4cab15401b8e07"
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
      "summary": "Static TypeScript/Vite foundation shell remains readable without JavaScript. Optional consent-gated PostHog shell views are wired; no published menu or dish controls exist. Dish intent adapter is tested but awaits real controls. S3-DIN-01.1 adds a replaceable menu source, the only wire-to-diner adapter (copies known fields only) and \"Fixture data\"-labelled synthetic fixtures (demo, edge cases, withdrawal, 20-dish layout, empty/unavailable/error/offline); screens do not use them yet. S3-DIN-01.4 adds searchMenu(menu, query), a plain local function returning matching complete-dish IDs and whether to show the staff allergy line; the search view is not wired yet. See docs/posthog.md for activation and evidence limits.",
      "paths": [
        "frontend/diner/index.html",
        "frontend/diner/src/main.ts",
        "frontend/diner/src/style.css",
        "frontend/diner/vite.config.ts",
        "scripts/check-bundle.mjs",
        "scripts/check-bundle.test.mjs",
        "docs/frontend-design.md",
        "frontend/diner/package.json",
        "frontend/diner/src/menu/types.ts",
        "frontend/diner/src/menu/wire.ts",
        "frontend/diner/src/menu/adapter.ts",
        "frontend/diner/src/menu/fixtures.ts",
        "frontend/diner/src/menu/fixtures.test.ts",
        "frontend/diner/src/menu/search.ts",
        "frontend/diner/src/menu/search.test.ts",
        "vitest.config.ts"
      ],
      "adrs": [
        "docs/adr/0004-visual-tiers.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "bd34d8c1a4660f6aae9970e7ae5790465c19d969e9af25f03930bed24f2ab90b"
    },
    {
      "id": "console",
      "status": "foundation",
      "summary": "React/Vite staff shell with optional consent-gated PostHog technical shell views. Authentication, publication and restaurant-scoped owner reports remain planned; shell views do not establish owner identity or business activity. An app-local accessible Input foundation adds label/hint/error wiring and a synthetic development-only demo excluded from production output; final visual integration remains separately reviewed.",
      "paths": [
        "frontend/console/src/main.tsx",
        "frontend/console/src/style.css",
        "frontend/console/index.html",
        "frontend/console/package.json",
        "frontend/console/foundations.html",
        "frontend/console/src/foundations/Input.tsx",
        "frontend/console/src/foundations/input.css",
        "frontend/console/src/foundations/demo.tsx",
        "tests/e2e/input.spec.ts"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "edd7eb2813fac4cbfc7fbcfbce673d741cd830b924dbbfb324d365f114abdc38"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Hono retains staff/publication/JWKS, collaborator reads and bounded retrieval. Observations use server-derived token authority and Queue receipts; consumer archives create-only R2 evidence before one tenant-scoped transaction writes index + event + typed detail. Public menu GET uses the exact diner CORS allowlist. The staging extraction host verifies a 15-minute tenant/job/hash grant, relays only the derived private source and retains report, timings and unvalidated suggestions under create-only tenant/job/attempt R2 keys; signing keys never reach Python. No new public review fields or publication writes. Hosted follow-up verification, VIS01 acceptance and provider quality remain gates.",
      "paths": [
        "backend/local.mjs",
        "backend/local.test.mjs",
        "backend/package.json",
        "backend/tsconfig.json",
        "pnpm-lock.yaml",
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
        "backend/wrangler.jsonc",
        "docs/menu-ingestion-infrastructure.md",
        "scripts/menu-ingestion-infra.test.mjs",
        "backend/src/extraction-host.ts",
        "backend/src/extraction-host.test.ts",
        "processing/tests/fixtures/service-artifacts/representative-bundle.json",
        "processing/tests/fixtures/service-artifacts/README.md",
        "backend/wrangler.extraction.jsonc",
        "backend/src/extraction-capability.ts",
        "backend/tsconfig.json",
        "backend/src/publication-command.test.ts",
        "backend/src/publication-command.ts",
        "backend/src/public-menu.test.ts",
        "backend/src/public-menu.ts",
        "docs/public-menu.md",
        "backend/src/menu-token.ts",
        "backend/src/menu-token.test.ts",
        "backend/src/observation-fixtures.test.ts",
        "backend/src/observation-ingest.ts",
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
        "backend/backfill-observations.mjs",
        "backend/src/consumer/facts.ts",
        "backend/src/consumer/facts.integration.ts",
        "backend/src/consumer/backfill.ts",
        "backend/src/consumer/backfill.test.ts"
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
      "sourceFingerprint": "a6916e6ddfb41af32fcf8be9da71e874b9be167ed39c8b1d9cd5761baec11555"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private Postgres venues, event/command/outbox, memberships and projections force tenant RLS. Local tests cover upgrades, atomic commands, connection reuse and TCP startup; restore remains unverified. Isolated append-only PostHog export has eight raw/four unique synthetic events; its October22 audit verifies history20261021130000, scope675372, restricted definer execution and denied browser/runtime raw reads. Runtime cannot read scope; exporter cannot access app schema. The owner oracle covers NULL IDs, retries/conflicts and the ten-session floor. Canonical index/conflicts, typed facts and live-only tenant views exist; activity uses the greatest checkpoint. Consumer/report authorization and suppression integration remain separate. RES-02 adds immutable subjects/approvals, tenant/menu/hash foreign keys and runtime-read-only public bundles. Its migrations and synthetic hosted approval/publication/withdrawal checks pass; production remains unaccepted.",
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
        "tests/db/owner_metrics.sql",
        "migrations/20261023120000_observation_index.sql",
        "tests/db/observations.sql",
        "migrations/20261026120000_observation_facts.sql",
        "tests/db/observation-facts.sql",
        "migrations/20261025120000_menu_publication.sql",
        "migrations/20261025130000_public_menu_bundle.sql"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0013-posthog-export-boundary.md",
        "docs/adr/0014-team-analytics-access.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "b2d0900b635afcccb785528b413805279b7076d0776364fb9886189584d83475"
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
      "summary": "ADR0012 promotes reviewed main through staging and production separately. PR31 consumer merged into develop; release94 main35e989d deployed via approved Wrangler operator route as version3db23304-c53a-4fee-b0ba-260c3afe4060. Existing secrets/resources retained and only the source HTTP consumer replaced. Ten bounded hosted checks and15 public smoke checks passed; both Queues ended empty/paused and the remote probe stopped. Facts/backfill, diner-token/browser/owner acceptance, load/recovery and production remain gated. Isolated PR previews retain their separate build/deploy/cleanup controls. Later evidence-doc commits do not change deployed code.",
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
        "pnpm-lock.yaml",
        "docs/res02-staging-acceptance.json",
        "docs/observation-staging-acceptance.json"
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
      "sourceFingerprint": "187e126ccb8cfd16d2f497fe52aa8262d2d988d802e542bfbdbf4c717aca635e"
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
      "summary": "PDF/photo modes keep ocr, default ocr_image and ungrounded image-only; pipeline3/schema2 and legacy1/2 remain compatible. Bounded wrapped titles/columns and corroborated text/geometry sections permit only complete price groups; conflicts, crossing/unclaimed cells and unresolved repeats abstain. Whole-entry guards and narrow name/footer views never rewrite source. Atomic assembly preserves exact fractional page/index/literal joins in existing candidate-ID segment metadata; SourceSpan/TS schemas and legacy empty-field omission stay unchanged. Originals stay unvalidated. Opt-in OCR recovery validates failed Engine3 pages and caps1–4 single attempts, stopping on failure. Selected-page model recovery preflights1–4 requests, retains history/incomplete coverage and never merges old candidates. Defaults/queues stay unchanged. Measured gains are modest; broad layout recall, fresh-provider, consumer and human acceptance remain unverified.",
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
        "processing/src/peekaplate_processing/overlay_review.py",
        "processing/src/peekaplate_processing/recover_pages.py",
        "processing/src/peekaplate_processing/pdf.py",
        "processing/src/peekaplate_processing/run_pipeline.py",
        "processing/src/peekaplate_processing/schemas.py",
        "processing/src/peekaplate_processing/sources.py",
        "processing/src/peekaplate_processing/storage.py",
        "processing/src/peekaplate_processing/workflow.py",
        "processing/tests/fixture_factory.py",
        "processing/tests/test_ocr_regions.py",
        "processing/tests/test_ocr_space.py",
        "processing/tests/test_overlay_review.py",
        "processing/tests/test_overlay_saved_inputs.py",
        "processing/tests/test_pdf_images.py",
        "processing/tests/test_box_evidence.py",
        "processing/tests/test_box_grounding_safety.py",
        "processing/tests/fixtures/review-candidates/box-evidence-candidates.json",
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
        "processing/tests/test_service_artifacts.py",
        "processing/tests/fixtures/service-artifacts/representative-bundle.json",
        "processing/tests/fixtures/service-artifacts/README.md",
        "processing/Dockerfile",
        "processing/.dockerignore",
        "processing/src/peekaplate_processing/menu_context.py",
        "processing/src/peekaplate_processing/menu_layout.py",
        "processing/src/peekaplate_processing/vision.py",
        "processing/src/peekaplate_processing/review_suggestions.py",
        "processing/src/peekaplate_processing/review_candidates.py",
        "processing/src/peekaplate_processing/timing.py",
        "processing/tests/test_menu_context.py",
        "processing/tests/test_menu_layout.py",
        "processing/tests/test_layout_reconstruction.py",
        "processing/tests/test_source_entry_recovery.py",
        "processing/tests/test_recover_pages.py",
        "processing/tests/test_targeted_model_recovery.py",
        "processing/tests/test_menu_duplicates.py",
        "processing/tests/test_input_modes.py",
        "processing/tests/test_pipeline_timing.py",
        "processing/tests/test_review_candidates.py",
        "docs/processing-v3.md",
        "docs/review-candidates.md",
        "processing/tests/fixtures/review-candidates/README.md",
        "processing/tests/fixtures/review-candidates/field-limits.json",
        "processing/tests/fixtures/review-candidates/invalid-extraction.json",
        "processing/tests/fixtures/review-candidates/missing-price-candidate.json",
        "processing/tests/fixtures/review-candidates/priced-candidate.json",
        "processing/tests/fixtures/review-candidates/representative-candidates.json",
        "processing/tests/fixtures/review-candidates/representative-candidates-v2.json",
        "processing/tests/fixtures/review-candidates/representative-extraction.json",
        "processing/tests/fixtures/review-candidates/representative-extraction-v2.json",
        "processing/tests/fixtures/review-candidates/zero-price-candidate.json"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "2de8cb64710dbe84d299af0a81c6ac1d45d1a6239dd2e058d97447553f763948"
    }
  ],
  "handoffs": [
    {
      "summary": "Recorded November1 hosted observation acceptance: reviewed PR70/31 reached main35e989d and staging version3db23304. Real Queue/R2/index/conflict/ACK/DLQ synthetic flow passed, alongside controlled remote storage/database retry recovery and15 public smoke checks. Final3 index rows/3 conflicts/6 archives remain labelled; another tenant and owner views expose0 run rows. Both Queues empty/paused, proxy stopped; production unchanged.",
      "modules": [
        "contracts",
        "backend",
        "database",
        "delivery"
      ],
      "next": "Implement transactional typed facts and idempotent archive/index backfill preserving archived traffic_class, excluding these synthetic test records. Integrate genuine diner-token HTTP delivery, real controls and owner metrics/security. Keep normal collection paused until the complete browser-to-owner path is accepted; preserve checksum metadata for archive recovery. See operations and observation-staging-acceptance.json."
    },
    {
      "summary": "November 1 PR31 reconciliation retains merged PR70 producer/publication contracts, trusted traffic_class, payload normalization and every develop module/history. The fractional timestamp fix now classifies in PostgreSQL. Consumer scope is append-only canonical index/conflict persistence; R2 checksum metadata is required when restoring sanitized conflict archives. No hosted activation is implied by local tests.",
      "modules": [
        "contracts",
        "backend",
        "database",
        "delivery"
      ],
      "next": "Verify the combined producer/consumer with real migrated PostgreSQL, approve and merge the final head, then promote reviewed code through main to staging for bounded synthetic Queue/R2/index/ACK/DLQ checks. Keep normal delivery paused and preserve existing resources. Typed-fact writes/backfill, owner reports and browser screen integration remain separate."
    },
    {
      "summary": "November 1 PR70 reconciliation preserves current develop and RES-02 hosted evidence. Prior timestamp and unauthorized-publication conflict fixes are retained; exact diner POST CORS and trusted traffic_class remain. Staging issuer keeps its deployed root URL and both rate bindings. Canonical migrations are already applied; no hosted deployment, credentials or Queue activation changes in this merge.",
      "modules": [
        "contracts",
        "backend",
        "delivery"
      ],
      "next": "Verify the reconciled producer, then merge into develop after current-head approval. PR31 reconciliation must preserve traffic_class plus its payload normalization and run the actual combined consumer. Typed fact writes, public-read DIN-03 CORS/renewal and hosted browser-to-destination acceptance remain release gates; keep queues paused until reviewed activation."
    },
    {
      "summary": "November 1 RES-02 hosted acceptance: PR42/43 merged, reviewed main2eee264 deployed, publication migrations and private ES256 configuration verified. Genuine Supabase staff HTTP commands, idempotency/conflict/tenant checks, immutable fixture hash and remote JWKS token verification, withdrawal and revoked-owner retry passed. Final synthetic counts are3 events/3 receipts/3 outbox rows; publication withdrawn, owner reduced to viewer, session ended and temporary host/verifier removed. Preserved the first client timeout; no latency guarantee.",
      "modules": [
        "contracts",
        "backend",
        "database",
        "delivery"
      ],
      "next": "Use the public-menu/JWKS contract for DIN-03 and ingestion integration. Finish trusted real-content admission, screen wiring, hash-input agreement, exact deployed CORS and original-publication token renewal. Keep queues paused until consumer acceptance; production/load/recovery and dashboard acceptance remain separate. See operations.md and res02-staging-acceptance.json."
    },
    {
      "summary": "November 1 RES-02 staging release preparation follows merged PR42 and PR43. Main observation-schema/cleanup history and all develop modules are retained. The existing staging Supabase project now records publication migrations20261025120000/20261025130000; application release and hosted runtime acceptance are not yet recorded. Staging token issuer is the existing Worker origin; signing key remains protected operator configuration.",
      "modules": [
        "contracts",
        "backend",
        "database",
        "delivery"
      ],
      "next": "Verify and review this exact main promotion, deploy the approved main commit to staging, set its private ES256 key without exposing it, and run scoped synthetic publication/token/withdrawal and tenant tests. Record actual version/evidence. Keep production, paused queues, bundle producer and DIN-03 work outside this release acceptance."
    },
    {
      "summary": "November 1 PR43 reconciliation retains PR42 command transactions and all develop diner fixture/search updates. Public reads return only an active exact approved bundle plus publication-scoped ES256 token; unknown/draft/unbundled/withdrawn menus share404. Existing code and migrations are preserved during context/error-ledger reconciliation.",
      "modules": [
        "contracts",
        "backend",
        "database",
        "delivery"
      ],
      "next": "After PR42 merges, retarget PR43 to develop and verify the resulting head. Hosted release needs the reviewed main candidate, both publication migrations, signing configuration and synthetic approval/read/withdrawal evidence. Privileged bundle admission, DIN-03 integrity/CORS integration and old-publication token renewal remain separate."
    },
    {
      "summary": "November 1 PR42 reconciliation preserves all develop module updates, including DIN-01.1 fixtures/adapter and DIN-01.4 local search, while retaining the reviewed RES-02 command core. Only shared context required conflict resolution; application and migration behavior is unchanged.",
      "modules": [
        "contracts",
        "backend",
        "database",
        "diner"
      ],
      "next": "Verify this exact reconciled head, merge PR42, then retarget and recheck PR43 against develop. Promote an approved main candidate before hosted migration, signing configuration and synthetic publication acceptance."
    },
    {
      "summary": "S3-DIN-01.4 search: searchMenu(menu, query) in frontend/diner/src/menu/search.ts returns { dishIds, allergyNotice } over the loaded menu. Name, category and ingredient names match partially ignoring case; allergen and dietary values match the whole chip via the adapter's chipKey, and an approved P0 allergen matches its code, label or alias (egg/Eggs, soya/Soy, sesame seeds/Sesame; nuts also finds Peanuts, old tree nut names kept), so \"gluten\" never finds Gluten-free. allergyNotice is true for any P0 allergen, dietary value, menu allergen or common allergy term (shellfish, gluten, mustard...), even with no results, so no results never reads as free from. Description never searched; incomplete dishes excluded; no API call, events or logging. 20 Vitest cases pass.",
      "modules": [
        "diner"
      ],
      "next": "Adam to confirm whether \"gluten\" should also find Wheat dishes (today it only shows the staff line). Jeffin re-reviews PR #64 after #59; Sai reviews before merge. DIN-02.3 picker imports searchMenu and removes kept dishes from dishIds. Wire the search view to the DIN-01.2 menu screen and dish card with keyboard, result-count announcement and axe tests once they exist."
    },
    {
      "summary": "S3-DIN-01.1 fixtures: a MenuSource interface and the only adapter that reads the draft RES-02 bundle shape (PR #43 plus fixture-only allergens, kept in wire.ts). It copies known fields only, so draft-like fields never reach screens, labels fixture menus \"Fixture data\", makes a dish without ingredients an incomplete placeholder, keeps closed-list dietary values, maps approved P0 allergen codes to display labels from one ALLERGENS list in types.ts (unlisted values stay as text-only chips, never dropped), suppresses Gluten-free when Wheat or Gluten is listed. Fixtures cover five demo dishes, every ticket edge case, a withdrawal between loads, a 20-dish layout set, a dish with no allergen or dietary data and empty/unavailable/error/offline/slow states. 24 Vitest cases pass; Menu carries venueId and menuId so DIN-02 can scope Saved dishes per restaurant.",
      "modules": [
        "diner"
      ],
      "next": "Harshita and Ehab build screens and search on createFixtureMenuSource and the ./types model only; DIN-03 adds a published source behind the same interface and swaps wire.ts for @peekaplate/contracts once RES-02 merges. Search and screens show ALLERGENS labels (Eggs, Tree nuts, Peanuts); Amr confirms the Vegan/Vegetarian leaf icons. Zhiliang/Shirley to confirm restaurant logo, availability and incomplete dishes in the bundle."
    },
    {
      "date": "2026-11-02",
      "summary": "Implemented transactional typed observations and bounded private archive backfill, trusted staging test classification and exact-origin public menu CORS. Genuine issued-token browser transport now exercises actual local workerd, Queue, R2 and migrated PostgreSQL. Existing frontend/owner PR work is preserved. Hosted follow-up remains pending.",
      "paths": [
        "backend/src/consumer/facts.ts",
        "backend/src/consumer/backfill.ts",
        "backend/src/dish.integration.ts",
        "docs/observation-infrastructure.md"
      ],
      "next": "Finish independent review and exact-main staging acceptance; preserve paused normal delivery. Reconcile frontend tracking/outbox/delivery and report API before pilot activation.",
      "modules": [
        "backend",
        "contracts",
        "delivery"
      ]
    }
  ]
}
```
