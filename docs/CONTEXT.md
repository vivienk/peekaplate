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
      "summary": "Strict health, staff dish-revision command/result, dish-intent, team analytics query/response schemas, and S3-VIS-04 bounded menu evidence retrieval schemas (SourceReference, EvidencePassage, BoundedRetrievalResult, RetrievalRequest). Offsets, rank sequences, and aggregate context limits strictly enforced. RES-01.1 adds strict review candidates for paired schema1/pipeline2 and schema2/pipeline3, preserving IDs, printed prices, hierarchy and code-point evidence with synthetic fixtures. Existing segment metadata preserves Python-validated candidate box links via a shared synthetic fixture; TypeScript does not independently verify OCR joins. This is an offline contract, not an accepted deployed review API. Ingest and broader diner events remain planned.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts",
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
      "sourceFingerprint": "0d75190a014cddd9f695d3f512afa2a52abb143dbc025be6f31e9525c6b205d4"
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
      "sourceFingerprint": "8378d1842aaa6b974b9c995eac00f291a5f985d4795ea5747e1bd740b3adc5e8"
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
      "summary": "Hono verifies staff JWT/membership for atomic draft revisions and collaborator staging analytics; logout revocation is expiry-bounded. Observation bindings remain separate/paused; VIS04 retrieval guards SSRF, Unicode spans and aggregate limits. The staging extraction host verifies a15-minute tenant/job/hash grant and relays only the derived private source; signing keys never reach Python. Its bounded internal bundle path now retains report, final timings and unvalidated suggestions under create-only tenant/job/attempt R2 keys before returning the usual report with a private reference. No new public request/review fields, source-reading endpoint or database/publication writes are added. PR60 direct-container scheduling/readiness is preserved; baseline hosted synthetic access passed per main handoff. This archive extension remains local. Paired release, VIS01 identity/lease/report acceptance, provider quality and end-to-end acceptance remain gates.",
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
      "sourceFingerprint": "0b164d7a95ba71a77ad1bfa9ee5ab7cbfa7ddae8c41c4fd44c9e686de4dc7649"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private Postgres venue/event/command/outbox, actor memberships and tenant projections use forced RLS. Docker tests cover upgrades, atomic commands, connection reuse and TCP-ready startup; hosted staff checks are separate. Private PostHog export is append-only: eight raw copies/four deduplicated synthetic events. The October 22 audit verifies migration 20261021130000/history, sole staging scope 675372, restricted security-definer ownership/execution and denied browser/runtime raw access. Runtime cannot read scope; exporter has no application-schema access. Hosted pool reuse/restore remain unverified. The standalone owner-metric oracle covers NULL-ID rejection, retries/conflicts and the ten-session fixture floor; canonical report integration remains separate. Canonical index/conflicts plus typed facts and tenant-restricted live-only owner views are defined; activity uses the greatest checkpoint. Report suppression/authorization and consumer integration remain separate.",
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
        "tests/db/observation-facts.sql"
      ],
      "adrs": [
        "docs/adr/0002-selective-event-sourcing.md",
        "docs/adr/0005-tenancy-and-privacy.md",
        "docs/adr/0013-posthog-export-boundary.md",
        "docs/adr/0014-team-analytics-access.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "107f87f6fa9137cdcd252696934b3c999aa54dd4c9040aed6f6f4286a9267a34"
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
      "sourceFingerprint": "66124cbd605ad9d6cfd8157b7ee3581b4d07343450d09a5e0884960cd3a24976"
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
      "sourceFingerprint": "34a7c85fb50db2bf5e5b82e9212a3c3bb3fb1da921451e1e4a1c13d53618e753"
    }
  ],
  "handoffs": [
    {
      "summary": "October 31 PR50 reconciliation: retained merged PR32 index/conflict schema and all current develop work while adding typed observation facts and owner views. Only shared context conflicted; migration/test bytes remain unchanged from the previously reviewed 15aedc4. Retargeted to develop after PR32. Local verification passed 237 unit tests, 57 script tests, 146 SQL assertions and 20 database integration tests.",
      "modules": [
        "database",
        "delivery"
      ],
      "next": "Require green exact-head CI before merging PR50. Reconcile the canonical producer and consumer against these tables/views; wire owner-report queries separately. Hosted migration and live reporting acceptance remain separate operator work."
    },
    {
      "summary": "October 31 PR32 reconciliation: preserved current develop owner-metric tests, PDF retrieval, Input and design-token work while adding canonical observation index/conflict schema and its 29 SQL assertions. Only the shared context conflicted; migration/test bytes remain unchanged from the previously reviewed c2a1331. Local verification passed 237 unit tests, 57 script tests, 113 SQL assertions and 20 database integration tests.",
      "modules": [
        "database",
        "delivery"
      ],
      "next": "Require green exact-head CI before merging PR32, then retarget/reconcile PR50. Hosted migrations and Queue consumer activation remain separate operator work."
    },
    {
      "summary": "October31 PR30 reconciliation: preserved current develop tokens, shared component CSS, PDF retrieval and owner-metric tests while retaining the accessible Input foundation and dev-only synthetic demo. Context and frontend-design conflicts retain both intents; no input behavior or owner-report schema changed.",
      "modules": [
        "console",
        "delivery"
      ],
      "next": "Run current repository/build/browser checks and exact-head CI, retarget PR30 to develop and merge it. Keep final Input visual approval and real review-form integration separate."
    },
    {
      "summary": "October31 PR29 reconciliation: retained bounded PDF retrieval and current develop tokens/UI, deployment foundations and PR22 owner-metric tests. The only merge conflict was the context graph; target responsibilities and the PDF source paths are both preserved.",
      "modules": [
        "backend",
        "delivery"
      ],
      "next": "Run actual Worker retrieval tests, builds, database checks and applicable CI on this reconciled head, then merge PR29. Representative menu relevance and hosted extraction/publication acceptance remain separate."
    },
    {
      "summary": "October31: cleaned PR22 owner-metric SQL whitespace and reconciled current develop without changing SQL behavior. The temporary oracle is indexed under database context; separate owner-report schema work is untouched.",
      "modules": [
        "database"
      ],
      "next": "Verify the reconciled head with real PostgreSQL and repository checks, then merge PR22. Canonical reports still depend on the observation index/fact-view work; this oracle does not implement the owner API."
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
    }
  ]
}
```
