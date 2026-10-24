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
      "summary": "Shared CSS custom-property design tokens imported first by the diner and console styles. Holds the Animation specification motion values with reduced-motion overrides, Design System text styles (H1-H5, paragraph, small, footer sizes/line heights in rem; four weights; Inter family without a loaded font file), the corner-radius scale (4-24px plus full), the spacing scale (0-80px), three shadow levels, and the color palette (orange, neutral, gray, info, success, error, warning, plus white and black). Color roles map existing palette colors for the Button (action, outline, disabled, focus ring) and Navigation (circular back/next states) controls. The ease-out curve is interim. Surface and text roles, Chips, Card, Input and remaining interaction states remain pending approved Figma values.",
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
      "sourceFingerprint": "94ebacea52b37b75ad4dd88008c4562e5e8c421814afd15d7b5ac38943f0d49b"
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
      "sourceFingerprint": "0f8777025be9ef1375b19fc580f5a200826465b2b8acfb44021d9f8156f1cc02"
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
      "sourceFingerprint": "f8c87694012c4d8b67d4947f635d6453235bb8fb2494448b2b5a487f1adca2f0"
    },
    {
      "id": "backend",
      "status": "foundation",
      "summary": "Hono Worker verifies configured staff JWTs and current restaurant membership, then executes atomic dish revisions under a restricted database role. Staging API uses the Supabase issuer and uncached Hyperdrive. Bounded hosted tests passed genuine login, authorized writes, retries/concurrency, cross-restaurant denial and membership revocation; remote probes verified transaction-context reset and rollback. JWT logout revocation is bounded by expiry, not immediate. No ingestion or publication endpoint. Added staging/local-only team analytics GET endpoints with individual GitHub tokens, live fixed-repository collaborator checks, fixed server project and strict seven-day/100-row bounds. No direct runtime analytics SELECT; safe response schemas remove visitor/person/IP fields. Hosted activation pending.",
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
      "summary": "Private Postgres venue/event/command/outbox, actor-scoped memberships and tenant-scoped dish projections. Runtime grants cannot modify membership; share locks serialize revocation. Tests cover prior-schema upgrade, RLS, atomic commands and direct connection reuse; hosted grants/context reset verified, physical pool reuse and restore pending. Private PostHog landing table and conflict-aware view are migration-tested and applied. Exporter is separate from app runtime. Restricted PostHog pooler authentication, two successful hosted exports, actual deduplicated view and effective grants verified. Eight raw copies yield four unique events; hourly schedule enabled. See docs/posthog-export.md for evidence limits. New forward migration defines operator-controlled staging project scope and fixed read function owned by a non-login reader; runtime only receives function execution. Hosted migration not applied.",
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
      "summary": "Main supplies staging and production under ADR 0012. Hosted staging Pages, Worker, restricted Supabase/Hyperdrive and staff-command evidence are recorded in operations. Hosted PostHog shell views and private export transfer, duplicate-safe repeat and permission checks passed; hourly staging export is enabled. Team analytics inspection is locally tested but not active: October 22 read-only SQL confirmed migration 20261021130000, its scope table and read function absent. Operator Wrangler OAuth works; the Worker has no secrets. GitHub environment secret names exist but their credentials remain unverified. Staging restricts deployments to main with no tags, required reviewers and prevent self-review; administrator bypass is allowed. The deployment flag remains unset. R2 is private and unbound; ingestion, login UI, pilot/load/recovery and production remain pending. Repository branch protection is separate.",
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
      "sourceFingerprint": "ca397bffce1cd22b37d94da3ac8a9dc3b48901a01b538195e094e355d2b7791a"
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
      "sourceFingerprint": "874d1071b705723d9f765e64d273ecc621c6454ae9d4c4437da4461f2c887f05"
    }
  ],
  "handoffs": [
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
      "summary": "Proposed ADR 0015 for S3-ARC-01, revised after Sai's review: owner metrics only from ADR 0003 canonical facts; POST /observations with a Bearer menu token and accepted/retry/rejected receipts (accepted = durable Queue acceptance), terminal rejected items, uncertain sends retried and in-batch duplicates defined; canonical app_private.observation_index/conflict; D1 ten sessions, D6 observation.v2, D7 session-based rates and D8 timing recorded; ingest limits agreed with Zhiliang (25 items/32 KiB, 24 h age, 5 min skew, per-jti 60/min burst 10, HTTP and reason codes, token claims); D3/D4 scope from matrix v0.1d; bounded 400/413 handling; remaining work split into the Save/UI acceptance decision and owned implementation/release prerequisites; owners Zhiliang (ingest), Teeyansh (consumer), Jeffin (migrations/views), Louis (reports). No contract, migration or collector code changed. Final technical review reconciled develop activation prerequisites; the ADR remains Proposed pending Save/UI confirmation.",
      "modules": [
        "contracts",
        "measurement",
        "analytics"
      ],
      "next": "Harshita confirms the Save/UI transitions, persistence, unsave/Undo, unavailable-storage behaviour and any Saved limit; Adam accepts, then record ADR acceptance. Owners deliver the listed contracts, ingest, consumer, migrations/views, report API, protected bindings, menu token, retention/consent and hosted validation through later PRs."
    },
    {
      "summary": "Reconciled main into the PR 27 release branch, preserving October 22 staging controls, verified PostHog export history, team analytics access documentation and both error-ledger histories. Runtime, contracts, migrations and deployment workflow are unchanged from the reviewed develop release. Corrected the team-access activation checklist so migration/history, token permissions and final review/CI are explicit prerequisites to enabling the flag.",
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
    },
    {
      "summary": "Corrected the design hyperlink in docs/team_guide.md to the owner-supplied Figma Make diner-menu V1 URL. No design or runtime behavior changed.",
      "modules": [
        "delivery"
      ],
      "next": "Use the linked Figma Make diner-menu V1 as the referenced design handoff."
    },
    {
      "summary": "PRs 14/15 released hosted PostHog consented shell capture at main 2a135fa, verified by live synthetic capture and provider readback. Added private export landing migration, conflict-aware deduplication view and least-privilege tests. pnpm check and test:db pass; technical/security review found no supported defect and guide review corrections are applied. Hosted migration applied with explicit access approval; tables and effective role boundaries verified. Export connection created; first run failed TLS verification and schedule is paused. User reported correction requires project Admin access. No rows transferred; no bypass attempted.",
      "modules": [
        "analytics",
        "database",
        "delivery"
      ],
      "next": "Vivien must correct the connection or grant project Admin access. Complete the connection with the official Supabase CA, verify a bounded export and duplicate-safe retry, then resume schedule. Do not claim transfer success from backfill wrapper completion alone."
    }
  ]
}
```
