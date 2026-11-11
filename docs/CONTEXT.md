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
      "summary": "Strict staff, publication, public-menu, analytics, retrieval and observation contracts; receipts, canonical JSON and microsecond time helpers. Queue contracts retain server-derived traffic_class and normalize ObservationV2 before hashing. S3-RES-03 owner_report.v1 withholds metrics unless NORMAL/VALID_ZERO and active sessions meet the ten-session floor; internal eligible_sessions are stripped from public reports. RES-01.1 review candidates and AI-01 scoped evidence. S5-DATA-10 adds versioned owner-action create/update/list contracts; insightKey remains opaque pending durable owner-report identity.",
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
        "packages/contracts/src/owner-actions.ts",
        "packages/contracts/src/owner-actions.test.ts",
        "docs/owner-insight-actions.md"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md",
        "docs/adr/0016-unified-menu-ingestion-orchestration.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "7f2b086c44aea8f53a0550683fa5c2f43f5d98289b123acbf6c8be5351c3950c"
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
      "summary": "Diner fixture menu, detail, search helpers, Save and Compare use shared contracts/tokens. Tracking validates observation.v2 before sequence allocation. Cached restores reconcile tab identity. One off-by-default consent control gates canonical and PostHog paths, including DNT/GPC; console keeps its existing control. Withdrawal retires queued work; persistent deletion markers retry both storage backends before reopening. Canonical outbox uses atomic IndexedDB updates or Web-Locked localStorage; unavailable coordination falls back to visit memory. Batches retain immutable IDs, limits and receipt-driven removal; pending reads are authoritative and stopped senders cannot restart. Fixture mode sends neither destination. PostHog uses its SDK adapter independently; retries are canonical only. Live menu/token delivery, hosted funnels and privacy-text/design acceptance remain integration gates.",
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
        "frontend/diner/src/menu/dishDetail.test.ts",
        "frontend/diner/src/menu/search.ts",
        "frontend/diner/src/menu/search.test.ts",
        "tests/e2e/menu-states.spec.ts",
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
        "frontend/diner/src/tracking/withdrawal.ts"
      ],
      "adrs": [
        "docs/adr/0004-visual-tiers.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "870fe0fba2eaad666945c79cabf89660579ff75a4b17435a7b6549a29a050095"
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
      "summary": "Create-only R2 precedes tenant-scoped canonical index/event/detail/fact persistence. Hosted baseline c6a47bd passed six synthetic checks and backfilled three facts; issued browser requests reached Queue/R2/Postgres. Retries deduplicate; conflicting reuse is quarantined. Own-token verification uses the configured public JWK after hosted self-fetch1042, retaining ES256/claim checks. S4-DATA-04 locally tests checkpoint ordering, missing/corrupt archives, archive-to-facts restoration, retry/redelivery, duplicate replay and two-session facts with owner-view exclusion. Hosted end-to-end, DLQ/crash and cross-tenant replay acceptance remain pending; normal collection stays paused. AI-01 returns scoped drafts or abstention. S5-DATA-10 adds owner-only insight-action routes and transactional persistence with menu-revision linkage, idempotent receipts, optimistic version checks and tenant RLS.",
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
        "backend/src/owner-insight-actions.ts",
        "backend/src/owner-insight-actions.test.ts",
        "migrations/20261109120000_owner_insight_actions.sql",
        "tests/db/owner_insight_actions.sql",
        "docs/owner-insight-actions.md"
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
      "sourceFingerprint": "f93c8492fcc3617036ea6446df2a303237ae669f26a82d5c2eb183812810b5bf"
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
      "summary": "ADR0012 promotes reviewed main through staging and production separately. Main c6a47bd deployed as staging version60ac184a-a348-4e2c-843d-e380861771cc; CI and six genuine-token transport/facts/backfill checks pass. Three historical test records plus one new browser menu-view are preserved; Queues end empty/paused. Desktop freeze required explicit re-pause and a read-only continuation, without event resubmission. Existing resources/secrets retained; no migration or production deploy. Real controls/outbox/report, load/recovery and production remain gated. Merged PRs keep their last successfully deployed preview; closed unmerged PRs are still cleaned up. Earlier acceptance records remain historical.",
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
        "scripts/console-preview-demos.test.mjs"
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
      "sourceFingerprint": "337e24b3be3aab6a71d6fe0259ab10dab4720b9f15a2a531e1b7cdb5b1bea704"
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
      "sourceFingerprint": "4e68c26c4a071754c151ccb2d6e4539801050c0361716178627499c5b0d41c73"
    },
    {
      "id": "processing",
      "status": "foundation",
      "summary": "PDF/photo modes keep ocr, default ocr_image and ungrounded image-only; pipeline3/schema2 and legacy1/2 remain compatible. Bounded wrapped titles/columns and corroborated text/geometry sections permit only complete price groups; conflicts, crossing/unclaimed cells and unresolved repeats abstain. Whole-entry guards and narrow name/footer views never rewrite source. Atomic assembly preserves exact fractional page/index/literal joins in existing candidate-ID segment metadata; SourceSpan/TS schemas and legacy empty-field omission stay unchanged. Originals stay unvalidated. Opt-in OCR recovery validates failed Engine3 pages and caps1Ã¢â‚¬â€œ4 single attempts, stopping on failure. Selected-page model recovery preflights1Ã¢â‚¬â€œ4 requests, retains history/incomplete coverage and never merges old candidates. Defaults/queues stay unchanged. Measured gains are modest; broad layout recall, fresh-provider, consumer and human acceptance remain unverified.",
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
        "processing/tests/fixtures/review-candidates/zero-price-candidate.json"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "afa65c7c4e5294a5ed18c6b93b782ae654cff17a5bdf1ccfd5cab2db55efc288"
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
      "date": "2026-11-10",
      "summary": "S5-DATA-10 adds versioned owner insight-action contracts, owner-only authenticated create/update/list routes, transactional persistence, exact tenant/menu/revision linkage, forced tenant RLS, idempotent command receipts and optimistic version checks. Contract, service, HTTP and repository checks pass. The owner-action pgTAP suite passes all 17 assertions; all 81 PostgreSQL integration tests pass. The final local Worker demo smoke step timed out after the Worker reported ready. insightKey remains an opaque venue-scoped key: owner_report.v1 currently has no durable insight identifier, so semantic linkage is not yet verified. Owner-only authorization is the conservative implementation pending product alignment on editor access.",
      "modules": [
        "contracts",
        "backend",
        "database"
      ],
      "next": "Open the feature PR with local Worker demo smoke timeout disclosed; request architecture and security review. Before UI integration, align durable report identity and the owner/editor/viewer/revoked authorization matrix. No hosted migration or deployment is claimed."
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
      "date": "2026-11-08",
      "summary": "PR46 safe recommendation core reconciled with develop e725b24, preserving PR25 assets and PR73 review/provenance behavior. Deterministic rules consume bounded, same-venue/report/window evidence and abstain on withheld input; no HTTP/model/effect execution. Re-review found internal eligible-session counts in owner rationale. A red/green regression proves output no longer changes for cohorts23vs97 while the ten-session input floor remains.26 focusedAI,888unit+67script,213SQL+76integration and build pass; timings and downstream handoff in docs/owner-ai.md. No deployment/provider calls.",
      "modules": [
        "contracts",
        "backend"
      ],
      "next": "After merge synchronize #82 and update its evaluation.test.ts expected rationale to omit cohort counts, regenerate evidence, then review #112. Exact ISO-string window identity, real report provenance/privacy, API membership, production policy, model/UI and hosted acceptance remain integration gates."
    },
    {
      "date": "2026-11-08",
      "summary": "PR73 reconciled with develop95fbe1a without dropping PR25 assets, diner/menu or synthetic-data changes. Prior segment/diagnostic binding, presence-aware idempotency and incomplete-field pruning verified. Re-review additionally binds source kind/location/size/retrieval instant to the retained producer artifact: four mutation regressions failed before the five-line guard and pass after it. Local real-JWT route/real-Postgres check rejects each altered source before writes and reloads honest data. See qa-reports/S3-RES-01.2-test-report.md for fresh counts/timings; no hosted migration or deployment.",
      "modules": [
        "contracts",
        "backend",
        "database"
      ],
      "next": "RES-01.3/01.4 integrate the staff review UI with docs/review-api.md. Hosted staging must apply the reviewed forward migration and verify genuine extraction-host jobId/private_review_artifact save/reload before release; review commands never approve or publish."
    },
    {
      "date": "2026-11-08",
      "summary": "PR25 reconciliation preserves develop 5bfaa94, including diner menu/detail and the synthetic comparison correction. Fixed implicit presentation rights, unbounded candidate reads, decode-before-pixel-limit and lost rejected-candidate metadata with four red/green regressions. Frozen offline Python:476 PASS; pnpm check:796 unit+67 script PASS; build/package PASS;6 review-preview and12 local spatial browser checks PASS. Detailed commands/timings:qa-reports/S3-VIS-03-test-report.md. No deployment or provider calls.",
      "modules": [
        "assets",
        "processing",
        "delivery"
      ],
      "next": "Use the offline assets foundation for reviewed captures. Production manifest/asset publication wiring, captured-food fidelity, real-phone performance and VoiceOver/TalkBack require separate acceptance."
    },
    {
      "date": "2026-11-06",
      "summary": "S3-VIS-03 PR #25 rebased linearly onto develop d6e5a16 (was c005b0f merge). schemas.py keeps develop's box-evidence validator and adds the asset/spatial/presentation models; asset files moved to their own assets context node because the processing summary is at its cap. Presentation asset ids derive after candidate validation from the candidate PNG hash and effective model version. Rebase QA: 465 Python tests, pnpm verify, 7 CLI and 6 Chromium harness cases passed on synthetic data (qa-reports/S3-VIS-03-test-report.md).",
      "modules": [
        "processing",
        "assets",
        "delivery"
      ],
      "next": "Sai re-review of the presentation id fix and Vivien merge. T0 priority 1: three permitted real dish photos with approved variants handed to the Bundle v1 producer. Presentation and 2.5D stay optional, needs_review and publication.eligible=false until S3-ARC-01 freeze; real-phone and VoiceOver/TalkBack checks remain manual gates."
    },
    {
      "summary": "November 5 PR45 menu ingestion stabilization (Teeyansh): Unified S3-VIS-01 menu ingestion orchestration layer for URL, PDF, and photo intake. Reconciled with PR #44 (ADR 0016) and PR #58 (artifact bundle). Strict intake validation rejects unmaterialized URLs (HTTP 400 unsupported_source_type); queued URL jobs fail deterministically with persisted diagnostics and retry safely without premature ACK if R2 storage fails. Added ExtractionBoxEvidenceSchema for fractional OCR boxes. Enforced atomic lease fencing in failIngestionJob and durable failure diagnostic persistence in reportStorage before terminal ACK. 192 pgTAP assertions and 64 real PostgreSQL integration tests pass.",
      "modules": [
        "contracts",
        "backend",
        "database"
      ],
      "next": "Await PR #44 and PR #58 merges to develop; keep staging menu queues paused until controlled staging acceptance."
    },
    {
      "summary": "November 5: S4-DATA-04 adds local checkpoint/archive/backfill/replay and synthetic owner-exclusion coverage. Context reconciliation preserves existing diner, console, delivery and release entries; test coverage does not establish hosted recovery or normal collection acceptance.",
      "modules": [
        "backend",
        "delivery"
      ],
      "next": "Run the reconciled checks and real disposable-database suites. Keep collection paused for remaining screen, consent, reporting, native recovery and hosted acceptance gates."
    }
  ]
}
```
