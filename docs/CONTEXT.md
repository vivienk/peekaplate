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
        "docs/adr/0003-intent-evidence.md"
      ],
      "dependsOn": [],
      "sourceFingerprint": "fdf4978899a3bc17468a902d80cb8d0448f5d62681c482e02e8e76f018a3e922"
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
      "sourceFingerprint": "b24c5b988b1fff92dfb7e5f0853807b9fa70813b7fe21aeaa091e186695f62e7"
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
        "docs/adr/0006-orders-and-measurement.md"
      ],
      "dependsOn": [
        "backend"
      ],
      "sourceFingerprint": "0408b5208254ea544057b4dd17e070e1577666b1d2a5ebf064d5cca10c8f08b0"
    },
    {
      "id": "delivery",
      "status": "foundation",
      "summary": "Main supplies staging and production under ADR 0012. Staging Pages, Worker, restricted Supabase/Hyperdrive and staff-command checks are recorded in operations. PRs 14/15 merged under explicit delegated setup approval; hosted PostHog shell views verified at main 2a135fa. Public repository main/develop remain unprotected. Export transfer, duplicate-safe repeat and permission checks passed; hourly staging schedule enabled. Product tickets can start. Hourly analytics export is separate from planned prompt owner-report updates; no freshness benchmark exists.",
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
      "sourceFingerprint": "9a5bd75d4724890e7c236f01a85bbaf9fd71963c5e0b3416c31e05aeecbfb984"
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
        "docs/adr/0014-team-analytics-access.md"
      ],
      "dependsOn": [
        "contracts"
      ],
      "sourceFingerprint": "47351eb70296f29fd4328beeb09f5bae752148a2973a902ed7a7624dce27f918"
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
      "summary": "Updated the final team_guide plan from the dated Team Interests & Responsibilities document. Proposed bounded contributions and explicit handoffs, distinguished preferences from confirmed assignments, and kept reported capacity and unfilled engineering work visible. Existing delivery dependencies and runtime behavior are unchanged.",
      "modules": [
        "delivery"
      ],
      "next": "Confirm each selected task and current availability with its contributor, record the agreement in ClickUp, then follow the existing publication/exposure/linkage prerequisites and protected cloud-access checkpoint."
    },
    {
      "summary": "Rewrote team_guide around a plain-language dish example, two event types and a function/line-linked code walkthrough. File, task and test inventories are expandable references; the final artifact-aligned plan separates parallel preparation from integration prerequisites. Includes 24 ClickUp tasks, seven scope subtasks and current design progress, distinct from implemented code. PR 9 merged at 413be96 with successful main CI. No runtime or external board/chat changes.",
      "modules": [
        "delivery",
        "diner"
      ],
      "next": "Confirm the provider decision and sprint scope with linked deliverables, reconcile the completed approval ticket with missing approval/publication code, recover local Docker and stop at the protected cloud-credential checkpoint before hosted integration."
    },
    {
      "summary": "PRs 14/15 released hosted PostHog consented shell capture at main 2a135fa, verified by live synthetic capture and provider readback. Added private export landing migration, conflict-aware deduplication view and least-privilege tests. pnpm check and test:db pass; technical/security review found no supported defect and guide review corrections are applied. Hosted migration applied with explicit access approval; tables and effective role boundaries verified. Export connection created; first run failed TLS verification and schedule is paused. User reported correction requires project Admin access. No rows transferred; no bypass attempted.",
      "modules": [
        "analytics",
        "database",
        "delivery"
      ],
      "next": "Vivien must correct the connection or grant project Admin access. Complete the connection with the official Supabase CA, verify a bounded export and duplicate-safe retry, then resume schedule. Do not claim transfer success from backfill wrapper completion alone."
    },
    {
      "summary": "October 21, 2026: restricted pooler login and PostHog export recovered using a privately generated credential, official Supabase CA and hostname verification. Runs 01a15d4f-261f-0000-b88a-3f67d622bc39 and 01a15d53-eb5b-0000-0e3e-3ccb4c589db6 completed the October 20 06:00–07:00 UTC interval. Actual Supabase view: eight raw copies, four unique events, one matching diner/console record each. All 14 row/permission checks passed; hourly schedule enabled. No runtime, migration, grants or production change. Earlier failures remain in errors.md; original cache/mismatch cause unproven.",
      "modules": [
        "analytics",
        "database",
        "delivery"
      ],
      "next": "Review PR 18 and merge under the human-comment policy. Jeffin owns contract/collection decisions; Zhiliang wires approved real UI events with tests. Each adds a ticket comment with PR and evidence when done. Observe the next automatic export; confirm monitoring, retention/deletion and billing limits before real diner data. Owner evidence pipeline/projections/API remain product work. Handoff drafts are local and unsent."
    }
  ]
}
```
