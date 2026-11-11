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
      "summary": "Strict staff/publication/public-menu, analytics, retrieval and nine-observation contracts with receipts, canonical JSON and microsecond time helpers. Public-menu integrity hashes exact fetched UTF-8 bytes before fatal decode/parse, then validates shared delivery identity; tamper vectors cover reformatted and wrong-revision data. Queue traffic_class is server-derived; normalized observation.v2 payloads reject client authority/private fields. Owner-report v1 enforces per-metric ten-session cohorts and complementary suppression, stripping internal counts. Review candidate/persistence and owner-AI evidence contracts remain bounded. DIN-03 uses the shared verifier; hosted release acceptance remains separately recorded. AI-02 has separate strict review-only ingredient/source/digest contracts, never approval.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts",
        "packages/contracts/fixtures/observation.v2/fixtures.json",
        "packages/contracts/fixtures/observation.v2/README.md",
        "packages/contracts/src/owner-report.ts",
        "packages/contracts/src/owner-report.test.ts",
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
        "processing/tests/fixtures/review-candidates/zero-price-candidate.json",
        "packages/contracts/src/review-persistence.ts",
        "packages/contracts/src/review-persistence.test.ts",
        "packages/contracts/src/owner-ai.ts",
        "packages/contracts/src/owner-ai.test.ts",
        "packages/contracts/src/public-menu-integrity.test.ts",
        "packages/contracts/fixtures/public-menu-bundle.v1/README.md",
        "packages/contracts/fixtures/public-menu-bundle.v1/bundle.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/expected.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/tampered.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/README.txt",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/bundle.original.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/bundle.same-value-pretty.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/bundle.tampered-name.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/bundle.wrong-revision.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/local-validation.json",
        "packages/contracts/fixtures/public-menu-bundle.v1/res02-review-vectors/manifest.json",
        "packages/contracts/src/ingredient-intelligence.ts",
        "packages/contracts/src/ingredient-intelligence.test.ts",
        "processing/tests/fixtures/ingredient-review.json",
        "processing/tests/fixtures/ingredient-review-unicode.json"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md",
        "docs/adr/0016-unified-menu-ingestion-orchestration.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "79ddc051d3df66e79150462353757ef4b2db6aacdb2878fefdae00c1d68c70f7"
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
      "sourceFingerprint": "62b6629cc0f9e8d2c9e20abf8a4600001e0a2a3f2ecd45f1276647d167136390"
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
      "sourceFingerprint": "1479570f1b3584333e12b22847767167494f78c9d12d7a5aa58ff3863310c895"
    },
    {
      "id": "diner",
      "status": "foundation",
      "summary": "Save, Unsave, Undo, badge and Saved routing are connected to real menu/detail screens. Saved refreshes current dish revisions without a new shortlist view, and keyboard removal retains focus. Verified publication loading, cancellation, expiry and withdrawal tracking suspension remain enforced. Compare and remaining real UI tracking acceptance are separate.",
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
        "frontend/diner/src/menu/menuScreen.ts",
        "frontend/diner/src/menu/menuScreen.test.ts",
        "frontend/diner/src/menu/dishDetail.ts",
        "frontend/diner/src/menu/published.ts",
        "frontend/diner/src/menu/published.test.ts",
        "frontend/diner/src/menu/config.ts",
        "frontend/diner/src/menu/config.test.ts",
        "frontend/diner/src/menu/dishDetail.test.ts",
        "frontend/diner/src/menu/search.ts",
        "frontend/diner/src/menu/search.test.ts",
        "frontend/diner/src/menu/route.ts",
        "frontend/diner/src/menu/route.test.ts",
        "frontend/diner/src/menu/refresh.ts",
        "frontend/diner/src/menu/refresh.test.ts",
        "tests/e2e/menu-states.spec.ts",
        "tests/e2e/published-states.spec.ts",
        "vitest.config.ts",
        "frontend/diner/src/save/saved-list.ts",
        "frontend/diner/src/save/storage.ts",
        "frontend/diner/src/save/storage.test.ts",
        "frontend/diner/src/save/save-state.ts",
        "frontend/diner/src/save/save-state.test.ts",
        "frontend/diner/src/save/fake-storage.ts",
        "tests/e2e/save.spec.ts",
        "frontend/diner/src/compare/picker.ts",
        "frontend/diner/src/compare/picker.test.ts",
        "frontend/diner/src/menu/price.ts",
        "frontend/diner/src/menu/price.test.ts",
        "frontend/diner/src/tracking/index.ts",
        "frontend/diner/src/tracking/index.test.ts",
        "frontend/diner/src/menu/events.ts",
        "frontend/diner/src/menu/events.test.ts",
        "frontend/diner/src/compare/comparison.ts",
        "frontend/diner/src/compare/comparison.test.ts",
        "frontend/diner/src/menu/icons.ts",
        "frontend/diner/src/menu/icons.test.ts",
        "frontend/diner/src/save/events.ts",
        "frontend/diner/src/save/feedback.ts",
        "frontend/diner/src/save/feedback.test.ts",
        "frontend/diner/src/save/mount.ts",
        "frontend/diner/src/save/saved-screen.ts",
        "frontend/diner/src/save/saved-screen-model.ts",
        "frontend/diner/src/save/saved-screen-model.test.ts",
        "frontend/diner/src/save/saved-screen.css",
        "frontend/diner/src/tracking/ids.ts",
        "frontend/diner/src/tracking/identity.ts",
        "frontend/diner/src/tracking/envelope.ts",
        "frontend/diner/src/tracking/core.test.ts",
        "tests/e2e/tracking.spec.ts",
        "frontend/diner/src/tracking/activity-clock.ts",
        "frontend/diner/src/tracking/activity-clock.test.ts",
        "frontend/diner/src/tracking/validate.ts",
        "frontend/diner/src/tracking/validate.test.ts",
        "frontend/diner/src/tracking/consent.ts",
        "frontend/diner/src/tracking/outbox.ts",
        "frontend/diner/src/tracking/outbox.test.ts",
        "frontend/diner/src/tracking/batcher.ts",
        "frontend/diner/src/tracking/batcher.test.ts",
        "tests/e2e/tracking-outbox.spec.ts",
        "frontend/diner/src/tracking/dispatch.test.ts",
        "frontend/diner/src/tracking/withdrawal.test.ts",
        "tests/e2e/tracking-storage.spec.ts",
        "frontend/diner/src/tracking/withdrawal.ts",
        "frontend/diner/src/menu/searchView.ts",
        "frontend/diner/src/menu/searchView.test.ts",
        "tests/e2e/search.spec.ts",
        "frontend/diner/src/tracking/delivery.ts",
        "frontend/diner/src/tracking/delivery.test.ts",
        "frontend/diner/src/tracking/delivery.fixtures.test.ts",
        "tests/e2e/tracking-delivery.spec.ts",
        "tests/e2e/published-refresh.spec.ts",
        "tests/e2e/published-integrity.spec.ts",
        "docs/diner-connection.md",
        "frontend/diner/src/save/screens.ts",
        "frontend/diner/src/save/save.css",
        "tests/e2e/save-screens.spec.ts"
      ],
      "adrs": [
        "docs/adr/0004-visual-tiers.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "eeaf24948b1da79d6308dde121b2064c9388f79bbea2af33968849a0102fcf56"
    },
    {
      "id": "console",
      "status": "foundation",
      "summary": "React/Vite staff shell with optional consent-gated PostHog technical shell views. Authentication, publication and restaurant-scoped owner reports remain planned; shell views do not establish owner identity or business activity. An app-local accessible TextField foundation wraps the design-system ui/Input (from @peekaplate/ui) with label/hint/error wiring and a synthetic development-only demo excluded from production output; final visual integration remains separately reviewed. PR previews include the labelled synthetic foundations demo only when PEEKAPLATE_PREVIEW_DEMOS=true; normal builds exclude it. Invalid fields preserve error styling and gain a distinct keyboard-focus outline.",
      "paths": [
        "frontend/console/src/main.tsx",
        "frontend/console/src/style.css",
        "frontend/console/index.html",
        "frontend/console/package.json",
        "frontend/console/foundations.html",
        "frontend/console/src/foundations/demo.tsx",
        "tests/e2e/input.spec.ts",
        "frontend/console/vite.config.ts",
        "frontend/console/src/foundations/TextField.tsx",
        "frontend/console/src/foundations/field.css"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "c1af4f0e5ecec13375e3e01ebd7f7d7614fdaf64f0597cd841168a7754d6da36"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Staging/local authenticated PDF/PNG/JPEG upload verifies current membership before bytes and locks membership through idempotent job creation. Server derives source hash/key; private storage succeeds before dispatch. Existing review/publication/report APIs remain. Extraction V1 transport preserves vision metadata and bounded private review artifacts; hosted release acceptance is separate.",
      "paths": [
        "backend/backfill-observations.mjs",
        "backend/local.mjs",
        "backend/local.test.mjs",
        "backend/package.json",
        "backend/src/auth.test.ts",
        "backend/src/auth.ts",
        "backend/src/consumer/backfill.test.ts",
        "backend/src/consumer/backfill.ts",
        "backend/src/consumer/canonical-json.test.ts",
        "backend/src/consumer/canonical-json.ts",
        "backend/src/consumer/consumer.integration.ts",
        "backend/src/consumer/database.ts",
        "backend/src/consumer/facts.integration.ts",
        "backend/src/consumer/facts.ts",
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
        "backend/src/owner-report.test.ts",
        "backend/src/owner-report.ts",
        "backend/src/extraction-capability.ts",
        "backend/src/extraction-host.test.ts",
        "backend/src/extraction-host.ts",
        "backend/src/index.test.ts",
        "backend/src/index.ts",
        "backend/src/ingestion/adapter.test.ts",
        "backend/src/ingestion/adapter.ts",
        "backend/src/ingestion/contract.test.ts",
        "backend/src/ingestion/ingestion.integration.ts",
        "backend/src/ingestion/orchestrator.test.ts",
        "backend/src/ingestion/orchestrator.ts",
        "backend/src/ingestion/repository.test.ts",
        "backend/src/ingestion/repository.ts",
        "backend/src/ingestion/transport.ts",
        "backend/src/ingestion/workflow.integration.test.ts",
        "backend/src/menu-token.test.ts",
        "backend/src/menu-token.ts",
        "backend/src/observation-fixtures.test.ts",
        "backend/src/observation-ingest.ts",
        "backend/src/public-menu.test.ts",
        "backend/src/public-menu.ts",
        "backend/src/publication-command.test.ts",
        "backend/src/publication-command.ts",
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
        "docs/public-menu.md",
        "scripts/menu-ingestion-infra.test.mjs",
        "pnpm-lock.yaml",
        "processing/tests/fixtures/service-artifacts/representative-bundle.json",
        "processing/tests/fixtures/service-artifacts/README.md",
        "backend/src/consumer/owner-synthetic.integration.ts",
        "backend/src/review-command.ts",
        "backend/src/review-command.test.ts",
        "backend/src/review-artifact.ts",
        "backend/src/review-artifact.test.ts",
        "docs/review-api.md",
        "backend/src/owner-ai/index.ts",
        "backend/src/owner-ai/recommendation.ts",
        "backend/src/owner-ai/recommendation.test.ts",
        "docs/owner-ai.md",
        "backend/src/owner-ai/evaluation.test.ts",
        "scripts/evaluate-owner-ai.mjs",
        "scripts/evaluate-owner-ai.test.mjs",
        "backend/src/bundle-producer/ids.ts",
        "backend/src/bundle-producer/price.ts",
        "backend/src/bundle-producer/produce.ts",
        "backend/src/bundle-producer/produce.test.ts",
        "backend/src/bundle-producer/repository.ts",
        "backend/src/bundle-producer/request.ts",
        "backend/src/bundle-producer/bundle-producer.integration.ts",
        "backend/scripts/produce-menu-bundle.ts",
        "docs/s4-res-bundle-producer.md",
        "docs/owner-report-staging.md",
        "backend/src/ingestion/upload.ts",
        "backend/src/ingestion/upload.test.ts"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0014-team-analytics-access.md",
        "docs/adr/0016-unified-menu-ingestion-orchestration.md"
      ],
      "dependsOn": [
        "contracts",
        "database"
      ],
      "sourceFingerprint": "c2c4a71024b7bfe705a7e4f570181470487fe7a7e21510c2d17af18fee264906"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private venues, commands/events/outbox, memberships and projections force tenant RLS. Local tests cover upgrades, atomic commands, connection reuse and TCP startup; restore remains unverified. Isolated PostHog export has eight raw/four unique synthetic events, protected project675372 scope and denied browser/runtime raw reads. Exporter cannot access app schema. Owner oracle tests NULL IDs, retries/conflicts and ten-session floor. Canonical index/conflicts, nine typed fact families and live-only tenant views exist; activity uses greatest checkpoint. Transactional facts/backfill pass synthetic hosted checks; report authorization/suppression remains separate. RES-02 has immutable approval subjects, tenant/menu/hash keys and runtime-read-only public bundles. Eight migration entries are applied; synthetic hosted approval/publication/withdrawal passed. Production is unaccepted.",
      "paths": [
        "migrations/202610130001_foundation.sql",
        "migrations/20261014210000_staff_commands.sql",
        "migrations/20261020070000_posthog_exports.sql",
        "migrations/20261021130000_team_analytics.sql",
        "migrations/20261023120000_observation_index.sql",
        "migrations/20261025120000_menu_publication.sql",
        "migrations/20261025130000_public_menu_bundle.sql",
        "migrations/20261026120000_observation_facts.sql",
        "migrations/20261026220000_menu_ingestion_drafts.sql",
        "scripts/test-db.mjs",
        "scripts/test-db.test.mjs",
        "tests/db/Dockerfile",
        "tests/db/foundation.sql",
        "tests/db/menu_ingestion.sql",
        "tests/db/observation-facts.sql",
        "tests/db/observations.sql",
        "tests/db/owner_metrics.sql",
        "tests/db/posthog.sql",
        "tests/db/staff.sql",
        "tests/db/team-analytics.sql",
        "migrations/20261030120000_review_candidate_persistence.sql",
        "tests/db/review_persistence.sql"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0013-posthog-export-boundary.md",
        "docs/adr/0014-team-analytics-access.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md",
        "docs/adr/0016-unified-menu-ingestion-orchestration.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "76a55138ba95d21291f384366121fbf0b2c41794e96288b0c4268822a51c4188"
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
      "summary": "Reviewed main release is deployed to staging only with exact SHA checks. A manual extraction workflow deploys the paired private host/container; menu consumer is single-message/concurrency with three retries and DLQ. Existing diner connection, owner report release, protected credentials and observation settings remain. Migration, controlled menu activation and owner upload-to-draft evidence are pending.",
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
        "docs/observation-staging-acceptance.json",
        "docs/observation-facts-staging-acceptance.json",
        "scripts/console-preview-demos.test.mjs",
        "scripts/node-ts-hooks.mjs",
        ".github/workflows/deploy-extraction-staging.yml",
        "docs/staging-ingestion-release.md"
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
      "sourceFingerprint": "4c1a462327b649fa6cadf9044003985a87a217d5b08cc50dc6fc2c56ea8a1253"
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
      "summary": "Consented synthetic staging shell capture and restricted hourly PostHog export are verified; dish controls remain unconnected. Repeated exports retained eight raw copies/four deduplicated events. The collaborator-authorized API returns redacted diagnostics, not owner reports. The Node/GitHub CLI checker has progress, timeouts and no token prompt. Two user-run October 23 checks verified a valid outsider identity (200) and both endpoint denials (403 forbidden), including a fresh-clone repeat; sanitized evidence is in operations.md. Controlled collaborator-removal acceptance and production remain untested. @peekaplate/analytics/posthog adds the P0 capturePostHog adapter (lazy, same consent/privacy/live gate as canonical, property allowlist, separate visit ID, event_id as SDK uuid, no browser storage, withdrawal stops SDK retries; real-SDK browser checks); event-names.ts is the shared P0 allowlist. Diner uses TRK-01's gate. Canonical owner facts and reporting remain planned.",
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
        "scripts/verify-team-access.test.mjs",
        "packages/analytics/src/posthog.ts",
        "packages/analytics/src/posthog.test.ts",
        "packages/analytics/src/event-names.ts",
        "packages/analytics/src/event-names.test.ts",
        "tests/e2e/posthog-adapter.spec.ts"
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
      "sourceFingerprint": "ea8d828a39fd80d003c97b6e306ee6072bba4bdeb240bcebe6e8ffdae51ee574"
    },
    {
      "id": "processing",
      "status": "foundation",
      "summary": "Menu extraction retains source-linked needs_review drafts. Vision-first processing preserves private bounded attempts locally, sanitizes provider failures, isolates cascade credentials, rejects wrapping-cloth products and retains plus-qualified prices as unknown fixed amounts. Hosted V1 carries actual extraction_mode separately from compatibility input_mode and excludes raw vision attempts. Existing T0/spatial/presentation modules remain. Hosted release acceptance is separate. AI-02 emits bounded local review-only sidecars with explicit unavailability and vision abstention.",
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
        "processing/.dockerignore",
        "processing/src/peekaplate_processing/overlay_review.py",
        "processing/src/peekaplate_processing/recover_pages.py",
        "processing/tests/test_overlay_review.py",
        "processing/tests/test_overlay_saved_inputs.py",
        "processing/tests/test_box_evidence.py",
        "processing/tests/test_box_grounding_safety.py",
        "processing/tests/fixtures/review-candidates/box-evidence-candidates.json",
        "processing/tests/test_service_artifacts.py",
        "processing/tests/fixtures/service-artifacts/representative-bundle.json",
        "processing/tests/fixtures/service-artifacts/README.md",
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
        "processing/tests/fixtures/review-candidates/zero-price-candidate.json",
        "processing/src/peekaplate_processing/product_validation.py",
        "processing/tests/test_product_validation.py",
        "processing/src/peekaplate_processing/ingredient_intelligence.py",
        "processing/tests/test_ingredient_intelligence.py",
        "processing/tests/fixtures/ingredient-review.json",
        "docs/ingredient-intelligence.md",
        "processing/tests/fixtures/ingredient-review-unicode.json"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "60216b87932a13fdf733bb4982bceac50ac1e4b689034bcb0f6ec5adaf92d160"
    },
    {
      "id": "assets",
      "status": "foundation",
      "summary": "Offline T0 variants preserve source bytes and revision references; spatial and supplied-mask review previews retain photo fallbacks, bounded motion and reduced-motion controls. Presentation requires explicit rights confirmation, bounded candidate reads and pre-decode pixel checks. Rejected candidates retain returned model/fidelity metadata and distinct fallback identities. Bundles are create-only, needs_review and publication.eligible=false. No automatic segmentation, image-provider calls, backend signing or diner integration; captured-food fidelity, rights and real-device acceptance remain manual.",
      "paths": [
        "processing/src/peekaplate_processing/assets.py",
        "processing/src/peekaplate_processing/harness.py",
        "processing/src/peekaplate_processing/prepare_assets.py",
        "processing/src/peekaplate_processing/prepare_spatial.py",
        "processing/src/peekaplate_processing/spatial.py",
        "processing/tests/test_assets.py",
        "processing/tests/test_spatial.py",
        "docs/asset-delivery.md",
        "processing/src/peekaplate_processing/prepare_presentation.py",
        "processing/src/peekaplate_processing/presentation.py",
        "processing/tests/test_presentation.py",
        "processing/src/peekaplate_processing/review_preview.py",
        "processing/src/peekaplate_processing/review_preview_html.py",
        "processing/tests/test_review_preview.py",
        "playwright.review-preview.config.ts",
        "tests/review-preview/review-preview.spec.ts"
      ],
      "adrs": [
        "docs/adr/0004-visual-tiers.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "processing"
      ],
      "sourceFingerprint": "cb75092bc3c9bd83c2a463f6c050694aecb4cf4613a507f4698d5d90fbbe27a2"
    }
  ],
  "handoffs": [
    {
      "date": "2026-11-09",
      "summary": "PR84 reconciles delivery with current develop and retains atomic outbox/withdrawal behavior. Shared-schema receipt checks retain malformed responses; every split rechecks token and consent, including withdrawal/re-opt-in. Ten-second request/body abort permits same-ID retry. A transient result stops remaining splits and honors numeric/date Retry-After. Requests omit cookies/refuse redirects. Chromium uses intercepted synthetic receipts, not hosted ingestion.",
      "modules": [
        "diner"
      ],
      "paths": [
        "frontend/diner/src/tracking/delivery.ts"
      ],
      "next": "DIN-03 must connect the current in-memory publication token and approved endpoint. Verify real controls reach PostHog and canonical facts independently; collection stays gated pending release acceptance."
    },
    {
      "date": "2026-11-08",
      "summary": "S3-DIN-01.4 search screen: frontend/diner/src/menu/searchView.ts. searchViewState(menu, query, categoryId) is the pure view model (matches, per-tab count, no-results, staff line, live announcement). bindMenuSearch wires the header icon, the bar under the header, close, Escape, Enter (no submit) and the Figma \"No Result Found\" state with Clear search. It hides non-matching cards in place, so results are the same menu cards; a new search starts on All and a tab narrows it; the query survives dish detail and back. No request, no track() call, query never logged or put in the URL. Alternating cards use nth-child(even of :not([hidden])).",
      "modules": [
        "diner"
      ],
      "paths": [
        "frontend/diner/src/menu/searchView.ts",
        "frontend/diner/src/menu/menuScreen.ts",
        "tests/e2e/search.spec.ts"
      ],
      "next": "The Compare picker (DIN-02.3) reuses searchMenu with its own bar. The no-results icon is a placeholder ring until a plate/cutlery asset is exported from Figma. Save hearts from DIN-02.2 sit on the same cards and need no search changes."
    },
    {
      "date": "2026-11-08",
      "summary": "PR74 reconciles current develop, preserving TextField over shared ui/Input, self-hosted Latin Inter 400/500/600 and input-token refinements. Both documentation/error histories are retained. A browser regression reproduced identical focused/blurred invalid fields; a shared token-based outline now preserves the red error edge while exposing keyboard focus. All 14 focused Chromium cases pass, including narrow-screen accessibility and local font loading; the 390px focused-error rendering was inspected.",
      "modules": [
        "console",
        "tokens"
      ],
      "next": "Use TextField for console forms without duplicating input styling or description wiring. Complete final design acceptance, real-device and manual screen-reader checks separately."
    },
    {
      "date": "2026-11-08",
      "summary": "PR80 incorporates corrected PR77/current develop. Atomic shared stores prevent stale-tab loss; retirement stops delayed additions. The diner reuses the existing consent UI with one shared gate for canonical/PostHog, preserving console behavior. Pending deletion markers survive reload; withdrawal explicitly clears IDB and locked localStorage, never treating fallback memory as durable clearance. Failed or unreadable clearance keeps new work in memory. Total storage-write failure and already-started requests remain documented limits.",
      "modules": [
        "diner",
        "analytics"
      ],
      "next": "Review the final PR80 commit after PR77; update PR84 against the corrected outbox while preserving Deliver and retry-pause APIs. Run genuine published-menu/token to canonical/PostHog acceptance before enabling pilot collection; local browser sinks are not hosted acceptance."
    },
    {
      "date": "2026-11-08",
      "summary": "PR77 reconciled with current develop without dropping shared context or append-only failure history. Cached-page restore now reads the latest same-tab identity, preserves the higher sequence for the same producer and adopts a newer visit. Missing persistent state starts fresh. Three regressions failed before correction and pass with the existing identity, validation and clock suite. No destination delivery is added.",
      "modules": [
        "diner"
      ],
      "next": "Review the pinned PR77 correction, then update PR80 from it. Consent, durable outbox and dispatch remain in PR80; HTTP delivery is PR84. Real publication/provider acceptance remains separate."
    },
    {
      "date": "2026-11-10",
      "modules": [
        "backend",
        "processing",
        "delivery"
      ],
      "summary": "Reconciled current release foundations; regression and release verification are in progress.",
      "next": "Record final check evidence and exact reviewed commit before merge; hosted activation remains separate."
    },
    {
      "date": "2026-11-10",
      "modules": [
        "diner"
      ],
      "summary": "PR122 preserves current verified menu cancellation/expiry and shared consent/delivery gates. Two browser regressions reproduced stale Saved revisions and lost keyboard focus; both fixed. pnpm check passed 1200 unit tests (four optional skips) and 72 scripts; build passed. Full Chromium rerun passed 127 cases with two workers after one eight-worker outbox-capacity timeout; SDK browser suite passed nine cases. Independent review and final CI remain separate.",
      "next": "Review final commit and merge to develop, then include it in the reviewed staging release. Complete picker/Compare and remaining UI triggers separately; real dual-destination acceptance and normal collection stay gated."
    },
    {
      "date": "2026-11-10",
      "modules": [
        "backend",
        "delivery"
      ],
      "summary": "PR115 and PR122 merged into develop; PR118 merged into main 86ba7a0. Both branch CI runs passed. Staging API cdbb7ea6, extraction host 60b99488 and diner b6d0d097 deployed. Two staging migrations applied (ten history entries); RLS and browser-role denial verified. Genuine upload auth/idempotency and hosted Save/Unsave/Undo/reload passed. Queue extraction stopped before the provider on same-account Worker fetch error1042; both Queues are paused. Added staging-only public-fetch routing flag and a regression that failed before the fix. No production deployment.",
      "next": "Review the routing correction, obtain final-commit release approval, deploy exact main API and rerun the bounded synthetic job. Verify private artifacts/drafts, withdraw the menu, restore viewer and end the staff session. Provider output and Queue ACK remain unverified."
    },
    {
      "summary": "AI-02 P0 adds deterministic evidence-bound ingredient candidates to the local VIS-02 pipeline and a separate strict RES-01 review contract. No model training, external fallback, recipe completion or inferred absence/suitability. All output requires owner confirmation and cannot represent approval/publication. Initial PR51 head e67a574 passed full Linux CI40461046251, including frozen Python/package, browser and DB checks; Intel Mac native dependency limits are documented in errors.md. Independent automated review found no supported defect after disproving an assumed Zod Unicode mismatch; a boundary regression was added. See ingredient-intelligence.md for remaining authenticated RES-01 integration.",
      "modules": [
        "processing",
        "contracts"
      ],
      "next": "Complete independent review and hosted pipeline checks, then integrate trusted imports, authenticated owner corrections/confirmation and publication enforcement through RES-01/RES-02."
    },
    {
      "date": "2026-11-11",
      "modules": [
        "contracts",
        "processing"
      ],
      "summary": "PR51 aligned with current develop after the vision-first release. Local review-only ingredient sidecars are generated through common finalization for schema1/pipeline2 and schema2/pipeline3; unsupported bounded input records unavailability without failing valid extraction. Vision-model text never becomes independent ingredient grounding. Private hosted bundle format and owner correction/publication authority are unchanged. Unicode tests use explicit UTF-8 on Windows.",
      "next": "Complete final review/CI and merge into develop. Ingredient-specific owner UI/import, recomputation from effective corrections, confirmation and representative food-domain acceptance remain separate; do not copy this sidecar into public food claims."
    }
  ]
}
```
