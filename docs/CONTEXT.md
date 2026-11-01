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
      "summary": "Strict health, staff dish-revision command/result, dish-intent, team analytics query/response schemas, and S3-VIS-04 bounded menu evidence retrieval schemas (SourceReference, EvidencePassage, BoundedRetrievalResult, RetrievalRequest). Offsets, rank sequences, and aggregate context limits strictly enforced. Ingest and broader diner events remain planned. RES-02 adds strict owner approval/publication/withdrawal contracts. Commands identify immutable menu revision and independent content/asset approvals; hashes come from the trusted canonical review subject. Client authority and client hashes are rejected. Public read/token and strict Bundle v1 schemas bind venue/menu/revision/publication, reject duplicate IDs and draft fields, and preserve allergen null/empty knowledge states.",
      "paths": [
        "packages/contracts/src/index.ts",
        "packages/contracts/src/index.test.ts"
      ],
      "adrs": [
        "docs/adr/0003-intent-evidence.md",
        "docs/adr/0015-integration-contracts-and-owner-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "c719972d6a90fd33e3847afc9f626a6835e30743c79b3f8a6a09a36a22a93c87"
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
      "summary": "Hono Worker: staff JWT/current membership draft commands, bounded GitHub collaborator staging reads, and VIS-04 retrieval with SSRF, Unicode/provenance, linked PDF/native page evidence and context limits. The deployed direct-DO Python host uses a named image, idle timeout and tenant/job/hash source grants; Python gets no signing/DB credentials. Protected OCR key and standalone OCR are verified; full AI ingestion/report acceptance remains pending and queues paused. RES-02 adds owner-only approve/publish/withdraw with current membership checks, expected versions, server-derived hashes from immutable same-tenant/menu review subjects, idempotent receipts, atomic events/projections/outbox and pure replay. Public reads join active publication to exact immutable approval/bundle and issue 30-minute ES256 observation tokens; public JWKS excludes the private key. Privileged subject/bundle admission and canonical observation writes remain separate. JWT logout revocation is expiry-bounded.",
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
        "backend/wrangler.jsonc",
        "docs/menu-ingestion-infrastructure.md",
        "scripts/menu-ingestion-infra.test.mjs",
        "backend/src/extraction-host.ts",
        "backend/src/extraction-host.test.ts",
        "backend/wrangler.extraction.jsonc",
        "backend/src/extraction-capability.ts",
        "backend/tsconfig.json",
        "backend/src/publication-command.test.ts",
        "backend/src/publication-command.ts",
        "backend/src/public-menu.test.ts",
        "backend/src/public-menu.ts",
        "docs/public-menu.md"
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
      "sourceFingerprint": "aeba09069ea89e75beaf2150f9027956d5b80d37d834e4c938006c9170c67433"
    },
    {
      "id": "database",
      "status": "foundation",
      "summary": "Private Postgres venue/events/commands/outbox, memberships and projections use forced RLS. Docker tests cover upgrades, atomic commands, connection reuse and TCP startup; hosted staff checks are separate and restore unverified. PostHog append-only export: eight raw/four unique synthetic events; October22 audit verifies migration20261021130000, scope675372, restricted definer ownership/execution and browser/runtime raw-access denial. Runtime cannot read scope; exporter cannot access app schema. Owner oracle covers NULL IDs, retries/conflicts and ten-session floor. Canonical index/conflicts, typed facts and tenant live-only views exist; activity uses greatest checkpoint. Report suppression/authorization and consumer integration remain separate. RES-02 adds immutable subjects, append-only exact approvals, review/publication projections and tenant/menu/hash foreign keys; runtime cannot create subjects. Append-only forced-RLS public bundles are runtime-read-only. Hosted acceptance pending.",
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
      "sourceFingerprint": "7e9cb5242e464158522987d0f94665a94f4198bea6d66fd45b3c9021e8301b10"
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
    }
  ]
}
```
