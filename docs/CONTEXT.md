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
      "summary": "Strict staff/publication/public-menu, analytics and retrieval contracts plus nine canonical observation types, receipts, canonical JSON and microsecond time helpers. Queue contracts retain server-derived traffic_class with live default and normalize payloads through ObservationV2 before hashing; compatibility aliases remain. Mixed valid/bounded-invalid conflict copies are supported. Contracts reject client authority and private/unknown payload fields; canonical reconstruction retains normalized values. Menu-token claims allow signed optional traffic_class for compatibility; issuance selects it on the server. S3-RES-03 owner_report.v1: metric values null unless NORMAL/VALID_ZERO (zero only), rates 0-1, mean active seconds 0-300, nothing shown unless active sessions are NORMAL and at least ten. InternalOwnerDishReportSchema adds per-metric eligible_sessions (floor ten, zero denominator NOT_MEASURABLE); toOwnerReport() strips them. RES-01.1 review candidates.",
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
        "packages/contracts/src/review-persistence.test.ts"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md",
        "docs/adr/0016-unified-menu-ingestion-orchestration.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "801389392a40af22398443538130ef28b1a07fcd814d296a0cad9ea7b1552a31"
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
      "summary": "Static diner shell stays readable without JavaScript. Consent-gated shell views exist; published screens remain pending. A replaceable menu source and one known-field adapter provide labelled synthetic fixtures. Screen-free search returns complete-dish IDs and the staff allergy line. Compare helpers pick two different complete dishes, replace either side keeping comparison_id, and build an unsent payload. Save state stores per-restaurant dish IDs newest first, rechecks withdrawn dishes, handles stale-tab writes and falls back to memory. Save UI mounts hearts, badge and toasts (latest-removal Undo, 5s/3s), sending Save events only for committed writes; renderSavedScreen lists saved dishes (no shortlist_viewed in session-only mode). track() and its triggers are console-only; consented PostHog/canonical delivery needs integration (docs/posthog.md). Icon lookups map approved allergen/dietary values and ingredients to Figma assets; not wired to screens.",
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
        "frontend/diner/src/save/saved-screen.css"
      ],
      "adrs": [
        "docs/adr/0004-visual-tiers.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "2689203387d1429b2fc77435cb9ab5c63729240885434a50be1900171bab9ea0"
    },
    {
      "id": "console",
      "status": "foundation",
      "summary": "React/Vite staff shell with optional consent-gated PostHog technical shell views. Authentication, publication and restaurant-scoped owner reports remain planned; shell views do not establish owner identity or business activity. An app-local accessible Input foundation adds label/hint/error wiring and a synthetic development-only demo excluded from production output; final visual integration remains separately reviewed. PR previews include the labelled synthetic foundations demo only when PEEKAPLATE_PREVIEW_DEMOS=true; normal builds exclude it.",
      "paths": [
        "frontend/console/src/main.tsx",
        "frontend/console/src/style.css",
        "frontend/console/index.html",
        "frontend/console/package.json",
        "frontend/console/foundations.html",
        "frontend/console/src/foundations/Input.tsx",
        "frontend/console/src/foundations/input.css",
        "frontend/console/src/foundations/demo.tsx",
        "tests/e2e/input.spec.ts",
        "frontend/console/vite.config.ts"
      ],
      "adrs": [
        "docs/adr/0001-scope-and-repository.md",
        "docs/adr/0005-tenancy-and-privacy.md"
      ],
      "dependsOn": [
        "contracts",
        "tokens"
      ],
      "sourceFingerprint": "5f72f3482ea81d6a14a73bf3458bda39bd06acac9c7037ab7363443602d3392c"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Observations are archived create-only in R2 before tenant-scoped canonical index/event/detail/fact persistence. Historical hosted baseline c6a47bd: six synthetic hosted checks passed, three earlier facts were backfilled, and genuine Brave menu/token/bundle requests reached Queue/R2/PostgreSQL. Retries store one fact; changed reuse is quarantined. Own tokens use the configured public JWK locally after hosted self-fetch1042, retaining ES256/claim checks. S4-DATA-04 adds synthetic coverage for cumulative checkpoint ordering, missing/corrupt archive recovery, archive-to-facts restoration, retry/redelivery, duplicate replay, and a two-session ingestion-to-canonical-facts flow with owner-view exclusion. These fixtures do not establish live staging acceptance, full DLQ/crash recovery, or end-to-end cross-tenant archive/replay isolation. Normal collection remains paused pending real controls/outbox/privacy and report acceptance.",
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
        "backend/src/consumer/backfill.test.ts",
        "pnpm-lock.yaml",
        "processing/tests/fixtures/service-artifacts/representative-bundle.json",
        "processing/tests/fixtures/service-artifacts/README.md",
        "backend/src/consumer/owner-synthetic.integration.ts",
        "backend/src/review-command.ts",
        "backend/src/review-command.test.ts",
        "backend/src/review-artifact.ts",
        "backend/src/review-artifact.test.ts",
        "docs/review-api.md"
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
      "sourceFingerprint": "b8c45b435551fc6ba64fa6406e1433ec23424644c755db10b361c3c8f577a877"
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
      "sourceFingerprint": "940c02a23b6b08a141350ba97eb97e42de9ef72fe10b90be2e29c05169bc0200"
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
      "summary": "Consented synthetic staging shell capture and restricted hourly PostHog export are verified; dish controls remain unconnected. Repeated exports retained eight raw copies/four deduplicated events. The collaborator-authorized API returns redacted diagnostics, not owner reports. The Node/GitHub CLI checker has progress, timeouts and no token prompt. Two user-run October 23 checks verified a valid outsider identity (200) and both endpoint denials (403 forbidden), including a fresh-clone repeat; sanitized evidence is in operations.md. Controlled collaborator-removal acceptance and production remain untested. @peekaplate/analytics/posthog adds the P0 capturePostHog adapter (lazy, same consent/privacy/live gate as canonical, property allowlist, separate visit ID, event_id as SDK uuid, no browser storage, withdrawal stops SDK retries; real-SDK browser checks); event-names.ts is the shared P0 allowlist. Unwired until TRK-01 connectPostHog. Canonical owner facts and reporting remain planned.",
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
      "sourceFingerprint": "b03cbc12dc1c2055a85f48276b3a53970385ebab8441c1224c28324bcd30be3b"
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
      "sourceFingerprint": "e1f5dd6026943495b4f53235515dad797a4727285dc1c5267ede6d1c329deb2e"
    }
  ],
  "handoffs": [
    {
      "date": "2026-11-06",
      "summary": "S3-RES-01.2 PR #73 rebased linearly onto develop d6e5a16 after #58 merged (net change of the c005b0f merge plus d341c86 replayed as one commit). INGESTION_REPORTS_BUCKET is one binding type: put() for ingestion reports and an optional get() returning ReviewArtifactObject | null for the review verifier. Staff review sessions stay bound to the producer's private attempt artifact; command receipts store a compact reference; originals stay append-only under forced RLS; nothing is approved or published.",
      "modules": [
        "contracts",
        "backend",
        "database"
      ],
      "next": "Fix Sai's and Teeyansh's three P2 findings (segment/diagnostic binding, omitted-vs-null command hash, mark_incomplete pruning) with regression tests, then Sai/Teeyansh re-review. RES-01.3 UI and RES-01.4 integration consume docs/review-api.md; staging save/reload must pass jobId plus private_review_artifact."
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
    },
    {
      "summary": "November 5: extraction implementation review preserves the current develop graph and proposed ADR0016 alongside VIS02/RES01.1 producer contracts and private attempt artifacts. Grounded originals remain needs_review; no cloud deployment, provider call or Queue activation is part of this merge.",
      "modules": [
        "contracts",
        "backend",
        "processing"
      ],
      "next": "Verify the reconciled head and independent tests before merge. Complete #73 artifact/command integrity corrections and #45 retry-exhaustion recovery before hosted upload-to-review acceptance."
    },
    {
      "summary": "PR109 adds Figma-derived allergen, dietary, ingredient and UI SVG assets, exact normalized-name lookups and a synthetic fixture restaurant logo. Unknown icons return null; labels remain authoritative. No screen, network or event dispatch is added. Current develop Compare, tracking, preview and QA work is preserved.",
      "modules": [
        "diner"
      ],
      "next": "Use decorative icons with retained text labels in the menu/detail integration. Keep unsupported ingredient names text-only; confirm final Figma rendering there. The fixture logo is synthetic, not an approved real-restaurant asset."
    },
    {
      "summary": "S3-DIN-02.4 compare logic: frontend/diner/src/compare/comparison.ts. startComparison(menu, kept, picked, newId) needs two different complete dishes and takes the ID maker as input until the TRK-01 newComparisonId() helper lands. replaceSide swaps either side, keeps comparison_id and ignores shown or incomplete dishes; replaceExclusions feeds the picker. dishComparedPayload builds the matrix v0.1h fields plus publication_revision_id for the TRK-01 layer (start/replace) or null for a failed comparison, e.g. a withdrawn dish; the screen sends it via track(). 8 Vitest cases.",
      "modules": [
        "diner"
      ],
      "next": "Build the result screen on the shared dish card; emit only after a pair is actually displayed through the shared track() boundary. Preserve comparison_id across Replace, use the TRK-01 ID helper when available, and read save_available from existing DIN-02.1 state. Keep approved consent, independent PostHog/canonical delivery and fixture-mode restrictions in the tracking integration; this helper sends nothing."
    },
    {
      "summary": "Proposed Bundle v1 correction uses separate nuts and peanut codes. Approved bytes are immutable and strict validation rejects tree nut.",
      "modules": [
        "contracts"
      ],
      "next": "After environment confirmation, reconcile develop and require current-head CI before review. Preserve approved bytes; any future legacy bundle requires an explicit compatibility decision."
    },
    {
      "summary": "S3-DIN-01 event triggers: track(eventName, payload) in frontend/diner/src/tracking/index.ts (the S3-TRK-01 module folder, owned by Nifemi) is the shared console-only placeholder that TRK-01 replaces in place (fire-and-forget, never throws; Nifemi's Save events import the same file). menu/events.ts adds createMenuViewedTrigger (publication_revision_id + entry_source qr/direct_link/unknown, once per publication revision per page) and trackDishDetailOpened (dish ids, new opening_id, source menu_card/compare_view/direct/saved_screen, optional from_exposure_id/nav_relation, save_available; nothing for incomplete dishes). No envelope, consent or delivery; no screen calls them yet.",
      "modules": [
        "diner"
      ],
      "next": "Harshita's menu and detail screens call the triggers when content is readable (not on tap or loading). save_available comes from DIN-02 saveState?.isSaveAvailable() ?? false. Confirm how a QR link sets entry_source. S3-TRK-01 replaces the console body without changing callers."
    },
    {
      "summary": "S3-DIN-02.1 shared Save state: createSaveState({ venueId }) with isSaved, savedDishIds (newest first), savedCount, isSaveAvailable, mode, save, unsave, reconcile and subscribe, as agreed in the S3-DIN-02 thread. Saves are dish IDs in localStorage under peekaplate:saved:v1:<venueId>. A change writes, updates state, notifies and returns { changed, persisted, savedCount }, so Save events can fire only on committed writes. Blocked or full storage switches to in-memory session-only with no backfill; damaged data starts empty. reconcile runs only after a successful load, removes withdrawn dishes without an unsave and keeps incomplete ones. Per Adam (30 Oct) there is no live tab sync in P0, but each change re-reads storage and applies only its own change, so a stale tab cannot wipe another tab's saves. 50 Vitest and 6 Playwright cases pass on fixtures.",
      "modules": [
        "diner"
      ],
      "next": "Wire the heart and badge (S3-DIN-02.2) once Harshita confirms mountSaveHeart/mountSaveBadge, then the Save events through track() and the Saved screen (.5) with the session-only notice. Two tabs saving in the same instant can still race (no cross-tab locking); accepted for P0. Live tab sync is P1."
    },
    {
      "summary": "November 1 PR70 reconciliation preserves current develop and RES-02 hosted evidence. Prior timestamp and unauthorized-publication conflict fixes are retained; exact diner POST CORS and trusted traffic_class remain. Staging issuer keeps its deployed root URL and both rate bindings. Canonical migrations are already applied; no hosted deployment, credentials or Queue activation changes in this merge.",
      "modules": [
        "contracts",
        "backend",
        "delivery"
      ],
      "next": "Verify the reconciled producer, then merge into develop after current-head approval. PR31 reconciliation must preserve traffic_class plus its payload normalization and run the actual combined consumer. Typed fact writes, public-read DIN-03 CORS/renewal and hosted browser-to-destination acceptance remain release gates; keep queues paused until reviewed activation."
    }
  ]
}
```
