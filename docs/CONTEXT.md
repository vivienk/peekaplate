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
      "summary": "Strict health, staff dish-revision command/result and initial dish-intent schemas. HTTP command authority fields are rejected; ingest and broader diner events remain planned. Team analytics query/response schemas enforce bounded dates/results and allowlisted diagnostic fields.",
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
      "id": "tokens",
      "status": "foundation",
      "summary": "Shared CSS custom-property design tokens imported first by the diner and console styles. Holds the Animation specification motion values with reduced-motion overrides, Design System text styles (H1-H5, paragraph, small, footer sizes/line heights in rem; four weights; Inter family without a loaded font file) and the corner-radius scale (4-24px plus full). The ease-out curve is interim. Color, spacing, elevation, interaction states and Button/Card/Input/Typography/Navigation foundations remain pending approved Figma values.",
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
      "sourceFingerprint": "12e5c345df683ab4cd32227a7a676384e43b70f5d6fd8be9637942ff3d271b1f"
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
      "sourceFingerprint": "b94a28cf38b11a84ce82c4fe5ae7df9b29afde2efa893384c5d299fc92f055a8"
    },
    {
      "id": "console",
      "status": "foundation",
      "summary": "React/Vite staff shell with optional consent-gated PostHog technical shell views. S3-TOK-01 Input foundation scaffold: labelled text input with hint/error wiring built from shared tokens, shown on a development-only synthetic demo page that is not in the production build; visual roles await the Input design. Authentication, publication and restaurant-scoped owner reports remain planned; shell views do not establish owner identity or business activity.",
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
      "sourceFingerprint": "f9fca6ac80c8128e5feb739918534ef51ce620d564897b37cf47f512fec35868"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Hono Worker verifies staff JWTs and restaurant membership for atomic draft revisions. Existing hosted staff identity/isolation/retry/concurrency evidence remains valid within its dated scope. Staging/local-only team analytics GET endpoints verify individual GitHub identity and current collaboration on the fixed repository; server project, strict seven-day/100-row bounds and redacted responses remain enforced. Main afe45db deployed through protected run 39907285014; both hosted reads returned 200 for hemu77, invalid/missing credentials 401 and invalid queries 400. Full hosted acceptance awaits the two controlled 403 cases. No ingestion or publication endpoint; JWT logout revocation remains expiry-bounded.",
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
        "backend/src/team-auth.test.ts"
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
      "sourceFingerprint": "92f22213bceebd5fb3a213a5a135dc4ebc35532f191e73ffc157d646f0b8b551"
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
      "sourceFingerprint": "fccd1d02035493216fcb1fae4fb672e25ec554da17005a27354ae2a4f975f7f8"
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
      "summary": "Main supplies staging and later production under ADR 0012. Protected manual staging Worker run 39907285014 deployed exact main afe45db successfully after eligible hemu77 approved vivienk request without administrator bypass; flag is true, main-only controls remain and administrator bypass is allowed. Worker version 5922a293-6893-47fd-8bc5-a20f0afd8d0b; 14 hosted HTTP checks and eleven read-only database assertions passed. Existing uncached restricted Hyperdrive verified; hourly PostHog export continues. Token scope/January 20 2027 expiry are operator-confirmed, effective deployment/checker use passed. Two controlled hosted 403 cases deferred. Pages remain at their separate PostHog release. R2 is private/unbound; ingestion, product UI, pilot/load/recovery and production remain separate work.",
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
        "tests/e2e/posthog.spec.ts"
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
      "sourceFingerprint": "b1981372eb4039e6bc75faa3207a7650e01b080426bbf49c7d1d6628792ca066"
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
      "summary": "Consent-gated explicit PostHog capture: hosted diner/console shell views verified in staging. Dish adapter awaits real controls. Private export schema and duplicate/permission tests exist. Two hosted exports of one synthetic interval passed: eight raw copies, four deduplicated events, known diner/console records each matched once, no missing/conflicting/out-of-scope rows. Restricted grants verified; hourly schedule enabled. Next automatic run not observed. Hourly internal copy does not power live owner reports; validated evidence/projections and owner authorization remain planned. Internal inspection API returns safe deduplicated records/counts after live repo-collaborator authorization; no PostHog management token or owner-report endpoint.",
      "paths": [
        "packages/analytics/package.json",
        "packages/analytics/tsconfig.json",
        "packages/analytics/src/index.ts",
        "packages/analytics/src/consent.ts",
        "packages/analytics/src/index.test.ts",
        "docs/posthog.md",
        "docs/posthog-export.md",
        "docs/team-data-access.md"
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
      "sourceFingerprint": "f05d04b31c6356819de9070d794df58cff36d0cf0ccafdbc05a9d1bfce270581"
    }
  ],
  "handoffs": [
    {
      "summary": "Added the S3-TOK-01 Input foundation scaffold in the console: an Input component that names each field with a visible label and describes it with optional hint and error text (aria-describedby, aria-invalid, hidden Error prefix), 16px text and a 44px touch target. It uses only shared typography and radius tokens; colors stay browser defaults and focus keeps the browser outline. A development-only /foundations.html page shows synthetic states and saves nothing. Browser tests cover naming, descriptions, disabled focus order, visible focus, 320px fit and axe.",
      "modules": [
        "console"
      ],
      "next": "Apply Harshita's spacing tokens and the Input color roles once the Input design is approved and her token branch lands, then capture screenshots for Rania. Build the restaurant review form on this Input after Adam chooses OWN-07 or OWN-08 and its fields."
    },
    {
      "summary": "Started S3-TOK-01 with a shared @peekaplate/tokens CSS package imported by both apps. It encodes the Animation specification motion values with reduced-motion overrides, the Design System text-style scale and weights, and the corner-radius scale, with tests for values, token groups and both imports. No color or component token was invented; shells are not restyled.",
      "modules": [
        "tokens",
        "diner",
        "console"
      ],
      "next": "Confirm the custom ease-out curve, licensed brand font, H2/footer weight typos and semantic token names with Rania. Spacing and elevation are proposed for Harshita; then add approved color and interaction-state tokens and the Button/Card/Input/Typography/Navigation foundations."
    },
    {
      "summary": "October 22 staging activation is deployed: main afe45db, protected run 39907285014 and Worker 5922a293-6893-47fd-8bc5-a20f0afd8d0b. Fourteen live HTTP checks passed using the maintainer individual GitHub credential; eleven read-only database assertions passed, including migration history and restricted grants. Hyperdrive caching is disabled; recent hourly export runs completed with no new rows, existing eight raw/four unique records unchanged. README, team guide, access/export runbooks and operations now distinguish deployed diagnostics from planned owner reporting. No runtime, grant, schema or deployment change in this documentation handoff.",
      "modules": [
        "backend",
        "database",
        "delivery",
        "analytics"
      ],
      "next": "Obtain review and merge the documentation update. Contributors can continue local and bounded staging ticket work. Complete valid non-collaborator 403 and controlled collaborator-removal checks before closing full hosted acceptance; they are explicitly deferred. Canonical diner ingestion/owner reports and any production resources/release remain separate approved work."
    },
    {
      "summary": "Proposed ADR 0015 for S3-ARC-01, revised after Sai's review: owner metrics only from ADR 0003 canonical facts; POST /observations with a Bearer menu token and accepted/retry/rejected receipts (accepted = durable Queue acceptance), terminal rejected items, uncertain sends retried and in-batch duplicates defined; canonical app_private.observation_index/conflict; D1 ten sessions, D6 observation.v2, D7 session-based rates and D8 timing recorded; ingest limits agreed with Zhiliang (25 items/32 KiB, 24 h age, 5 min skew, per-jti 60/min burst 10, HTTP and reason codes, token claims); D3/D4 scope from matrix v0.1d; bounded 400/413 handling; remaining work split into the Save/UI acceptance decision and owned implementation/release prerequisites; owners Zhiliang (ingest), Teeyansh (consumer), Jeffin (migrations/views), Louis (reports). No contract, migration or collector code changed. Final technical review reconciled develop activation prerequisites; the ADR remains Proposed pending Save/UI confirmation.",
      "modules": [
        "contracts",
        "measurement",
        "analytics"
      ],
      "next": "Harshita confirms the Save/UI transitions, persistence, unsave/Undo, unavailable-storage behaviour and any Saved limit; Adam accepts, then record ADR acceptance. Owners deliver the listed contracts, ingest, consumer, migrations/views, report API, protected bindings, menu token, retention/consent and hosted validation through later PRs."
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
      "summary": "Aligned staging to application history through PR #5 and corrected manual deployment selection from develop to staging, including CI push coverage and release documentation. Provider inspection confirmed no Hyperdrive, Pages project or staging Worker; D1 resources do not replace PostgreSQL.",
      "modules": [
        "delivery"
      ],
      "next": "Configure the isolated staging Supabase/auth/Hyperdrive and frontend/API connections, supply scoped GitHub deployment credentials, then verify the deployed staging flow before activation or production promotion."
    },
    {
      "summary": "Prepared history-preserving core import, marketing split, develop CI, PR 13-derived ruleset proposals and disabled staging deployment gate. Reconciled all eight later source commits through b40e3ca, retaining their history and five updated planning links. Application runtime and backend bindings are unchanged. Owner chooses private GitHub Free; branch rules remain inactive and manual PR/CI gates apply.",
      "modules": [
        "delivery"
      ],
      "next": "Obtain independent human review; reconcile open source PRs and establish provider parity before release or archival. Apply manual PR/CI gates because private branch enforcement is unavailable on the selected free plan."
    },
    {
      "summary": "Recovered Windows Docker after checksummed offline disk backups and an official Desktop 4.95 upgrade. Real testing exposed a pnpm.mjs launcher rejection; the DB harness now invokes installed Vitest directly, with a failing-then-passing launcher regression. All 43 SQL assertions, 13 Worker/Postgres cases and local startup/demo/cleanup passed on Windows. Contributor Claude/Codex setup is independently owned.",
      "modules": [
        "database",
        "delivery"
      ],
      "next": "Finish exact-head review and CI for the local recovery PR. Keep the GitHub protection policy in a separate owner-action PR; stop before Cloudflare/Supabase integration until protected credentials are supplied."
    }
  ]
}
```
