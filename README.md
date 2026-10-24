# PeekaPlate

Canonical application repository: `vivienk/peekaplate`. Marketing lives in `vivienk/peekaplate-marketing`. Application migration and the initial staging deployment are complete; see the [migration and release checklist](docs/repository-migration.md) and [staging evidence](docs/operations.md#staging-deployment-record).

**3D is the hook. The loop is the product.**

PeekaPlate is a restaurant menu and measurement platform designed to connect diner menu exposure with linked order outcomes and controlled menu experiments. The [PeekaPlate Orchestration + V1 Team Plan](https://claude.ai/artifact/HxpC9aET7geEwkEpyG6wrt) defines the product scope; [Architecture Decision Records](docs/adr/README.md) define the accepted technical decisions.

The [team guide](docs/team_guide.md) explains the system and each tracked file's purpose in plain language, distinguishes working features from plans, and gives the next steps.

Staging links: [diner](https://peekaplate-diner-staging.pages.dev/) · [owner/staff console](https://peekaplate-console-staging.pages.dev/) · [API health](https://peekaplate-api-staging.vxkong.workers.dev/health). Existing names are retained. Both pages are starter shells; production is not configured. Start with the guide's [setup walkthrough](docs/team_guide.md#where-to-open-staging), then the [next-ticket sequence](docs/delivery.md#next-tickets-from-the-deployed-foundation).

## Implementation status

Team analytics inspection is deployed in staging at release `afe45db`. Both read APIs returned 200 using an accepted repository collaborator's own GitHub token; missing/invalid tokens returned 401. On October 23, a valid non-collaborator received 403 from both endpoints in two reported checker runs. See [team data access](docs/team-data-access.md) for the URL, authentication, safe fields and dated evidence. All accepted repository collaborators are eligible; nobody receives a shared database or deployment credential. These delayed diagnostic counts are separate from owner business reports. The controlled collaborator-removal check remains pending; production is not configured.

The repository contains diner and staff-console shells and a staff-command slice: signed staff-token verification, restaurant membership checks, and atomic dish-revision writes with tenant isolation. Staging hosts both shells and the API. Hosted acceptance with a genuine Supabase session verified authorized writes through Hyperdrive, retries, concurrent updates, cross-restaurant denial and membership revocation. A separate remote probe verified rollback and transaction-context reset. These are bounded synthetic checks, not pilot or production certification. Console login UI, menu publication, intent ingestion, POS integration and visual rendering are not implemented. Feature and pilot acceptance criteria are tracked in the [verification map](docs/verification.md).

## Technology and architecture

Staging observation infrastructure is provisioned: the source Queue and DLQ are connected, the existing private R2 bucket is reused, and synthetic delivery/retry/DLQ and create-only archive checks pass. Delivery remains paused until the real consumer is reviewed and integrated. The staging producer/R2 binding configuration still needs its reviewed `main` deployment. See the [infrastructure handoff](docs/observation-infrastructure.md) for exact resources, retention, test evidence and Teeyansh's next steps.

| Component | Technology | Current scope |
| --- | --- | --- |
| Diner frontend | TypeScript, Vite | Static shell with content available without JavaScript |
| Staff console | React, TypeScript, Vite | Application shell |
| Backend | Hono, TypeScript, Cloudflare Workers | Health and authenticated dish-revision commands; staging issuer and Hyperdrive configured |
| Shared contracts | Zod, TypeScript | Health, dish revision and initial dish-intent schemas |
| Database | PostgreSQL, SQL, dbmate | Private venues, staff memberships, dish projections, events, receipts and outbox; restricted runtime role |
| Processing and analysis | Python, uv, Pydantic | [Local PDF/image acquisition and LLM dish drafts](processing/README.md); needs-review output, application integration and quality acceptance pending |
| Product analytics | PostHog, shared TypeScript capture module | Opt-in shell views and tested v1 dish adapter; hosted staging ingestion verified. Private Supabase export and duplicate-safe retry verified; hourly staging schedule enabled. |

Frontends and backend share contracts. Frontends do not import backend internals or hold database credentials. Authorization belongs to the backend; venue authority must derive from verified identity and membership. Database policies support this boundary; they do not authenticate callers.

The accepted architecture separates two event paths:

- **Domain events:** selected content, approval, publication, availability and experiment workflows use PostgreSQL event streams. Authorized commands commit events, current projections, retry results and outbox work atomically. Replay rebuilds projections without external effects.
- **Diner observations (planned):** a browser outbox sends stable event IDs to an ingest Worker. Queue acceptance precedes the client receipt; a consumer creates the R2 archive before indexing in PostgreSQL and acknowledging queue delivery. Exposure records identify the menu actually displayed. Unlinked order outcomes remain unknown.

Visual tiers are progressive enhancements: **T0** is the complete photo/text menu; **T1** adds shallow movement to reviewed photo cutouts; **T2** separates captured plating stages with limited viewpoints. Three.js is planned to load after an explicit tap. Menu access must survive analytics or viewer failure. The [frontend design reference](docs/frontend-design.md) records evolving design direction, not approved venue content or a completed visual specification.

Detailed boundaries, failure handling and deferred capabilities are documented in [architecture](docs/architecture.md) and the [ADRs](docs/adr/README.md).

### Python contributions

The backend can include both TypeScript and Python. The existing TypeScript/Hono API owns staff authentication, restaurant permissions and application commands. Python is an accepted option for a concrete processing or analysis job, such as checking supplied photos, validating an import or preparing an analytical result. Adding Python does not require rewriting the API or replacing Supabase.

Add the first Python component with its actual task, an isolated `uv` environment, a locked dependency set and `pytest` tests. A Python process cannot directly import the TypeScript/Zod contracts: define a versioned JSON request/result format and test both implementations against the same examples. Job requests must carry backend-authorized restaurant and input references; returned results must be checked against that job before any application change. Use the established command path for business changes rather than writing around permissions, event history or approval rules.

Choose its runtime after checking the task's packages and resource needs:

- **Cloudflare Python Worker:** an option for compatible, bounded work or calls to an external model service. It is a separate deployment, connected to the API through an authenticated interface or private service binding.
- **Container or specialist compute service:** evaluate only when required libraries or workload limits rule out Workers. Running a model ourselves may need GPU compute; calling a model API does not. Deployment and cost approval are separate from adding Python source code.

[Cloudflare's Python documentation](https://developers.cloudflare.com/workers/languages/python/) and [package compatibility guide](https://developers.cloudflare.com/workers/languages/python/packages/) describe the supported runtime. These are deployment options, not infrastructure already provisioned for this repository. Before staging integration, test timeout/failure handling, safe retries and duplicate results, tenant isolation and the TypeScript/Python data contract. Long processing must not block menu browsing. Existing `pnpm` commands do not install or run Python jobs; add scoped CI checks with the first implementation.

The current visual workflow remains manual and reviewed. A Python task does not authorize automatic publication, invented ingredients or generated edible surfaces. See [ADR 0004](docs/adr/0004-visual-tiers.md).

### PostHog and restaurant reports

PostHog provides optional internal product analytics. The shared `packages/analytics` module sends explicit capture requests without an SDK, automatic click tracking or session replay. After a visitor opts in, each existing shell can send `app_shell_viewed`. This means a placeholder screen was opened; it is not a menu visit, a signed-in owner or a sale. The tested v1 adapter supports `dish_open` and `portion_compare`, but real dish controls are not built or connected yet.

The existing US PostHog project is reserved for synthetic staging checks. Synthetic events from both hosted staging sites have been read back in PostHog after the reviewed release. Consent starts off, resets on reload and respects browser privacy signals. Missing or mismatched configuration disables capture. Read [setup, verification and remaining release gates](docs/posthog.md) before enabling it. Ingredient interactions, selections and comparisons must follow the agreed taxonomy when their actual controls ship.

PostgreSQL remains the application source of truth. [ADR 0003](docs/adr/0003-intent-evidence.md) governs the planned durable diner-evidence path. PostHog is a best-effort analytics copy; it does not replace that path. The [private Supabase export](docs/posthog-export.md) adds a separate analytics landing table and a duplicate-safe internal view; staging transfer and a repeated interval are verified: eight raw copies resolve to four unique observations. The hourly schedule is enabled. The planned owner dashboard reads validated Supabase projections through an authorized backend, without waiting for hourly PostHog exports. Its freshness target still needs implementation and measurement. Use one PostHog sending route per action, never both browser and server mirrors. Serving owner reports from PostHog would require a new reviewed ADR, verified formulas and backend-enforced restaurant access. A chart filter is not tenant isolation.

As checked on October 19, 2026, PostHog lists one million analytics events per month in its free allowance. For illustration, 300 menu visits/day × 40 events/visit × 30 days = 360,000 events; this is a planning example, not measured traffic. Track test traffic too. Check [current pricing and limits](https://posthog.com/pricing) before relying on the allowance. The organization's actual billing plan and spending limits require an administrator to confirm; this setup purchased no upgrade.

## Repository structure

```text
frontend/diner/      Public diner application
frontend/console/    Staff application
backend/             Worker API
packages/contracts/  Shared runtime schemas and types
migrations/          Ordered SQL migrations
tests/               Database and browser integration tests
scripts/             Repository checks and local test tools
processing/          Local Python OCR and LLM dish extraction
docs/                Architecture, decisions, delivery and context
```

## Local development

Prerequisites: Node **24.16.0** and pnpm **11.25.0**. The current applications require neither Python nor cloud credentials. Database tests additionally require Docker; browser tests require Playwright Chromium.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

| Service | Local address |
| --- | --- |
| Diner | http://127.0.0.1:5173 |
| Staff console | http://127.0.0.1:5174 |
| API health | http://127.0.0.1:8787/health |

For authenticated backend development, run the following instead of the unconfigured API process:

```sh
pnpm dev:backend
# In a second terminal:
pnpm local:demo
```

This starts a disposable Docker database, a loopback-only synthetic JWT issuer and the local Worker. The demo creates a dish revision through HTTP. Generated credentials stay in ignored `work/local-session.json` and expire after one hour; restart the local session to renew them. Ctrl+C removes the session database and credentials. No Supabase or Cloudflare account is required. See [operations](docs/operations.md) for the API contract and the cloud-integration checkpoint.

## Verification

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting/lint, strict types, application/contract and repository-script tests, context freshness and local documentation links |
| `pnpm verify build` | Frontend builds, initial diner JavaScript budget and Worker deployment dry-run |
| `pnpm verify test:e2e` | Chromium shell/API flows, no-JavaScript content, accessibility and narrow-screen overflow |
| `pnpm verify test:db` | Migration upgrade, pgTAP policies and real Worker/JWT/PostgreSQL concurrency, rollback, retry and replay checks |

Install the browser once with `pnpm exec playwright install chromium`. Verification records sanitized failure observations in [errors.md](errors.md) locally and step summaries in CI. Resolution requires a confirmed cause and regression evidence. [Contributing](CONTRIBUTING.md) defines the complete verification and PR protocol.

## Agent-assisted development

Five paired role profiles are maintained in `.claude/agents/` and `.codex/agents/`:

| Role | Responsibility |
| --- | --- |
| `repo-guide` | Map a task to source, ADRs, dependencies and acceptance criteria |
| `task-builder` | Implement one assigned scope with tests and an explicit handoff |
| `review-coordinator` | Consolidate review evidence for one pinned base/head |
| `architecture-reviewer` | Review boundaries, authority, event semantics and ADR compliance |
| `correctness-reviewer` | Review execution paths, failures, retries and regression coverage |

[AGENTS.md](AGENTS.md) defines the work protocol. [CONTEXT.md](docs/CONTEXT.md) provides a source-linked module index; `pnpm context:show -- <module-id>` retrieves one module. The [review skill](.agents/skills/peekaplate-review/SKILL.md) defines evidence requirements and structured findings. Reviewers remain read-only; implementation assignments specify owned paths and dependencies.

The [prompt evaluation record](docs/research/reviewer-evaluation.md) includes configuration checks, five behavioral cases and the builder correction they identified. Native-client role discovery and tool restrictions remain unverified because the evaluation environment could not complete those checks. Profiles guide behavior; client permissions enforce access. Automated review supports the required human review and does not replace it.

## CI and deployment

CI uses five jobs with distinct responsibilities: `changes` selects integration checks, `quality` validates code/builds/documentation, `database` and `browser` test their integrations, and `ci` aggregates all applicable results. Database and browser checks are path-selected. Browser traces are retained on failure.

Routine npm and GitHub Actions dependency updates are grouped monthly, with one open version-update PR per ecosystem. Major upgrades are manual; enabled security updates can arrive sooner. AI-written and dependency PRs follow the same documentation, verification and human approval-with-comment requirements.

Both deployment environments use an exact `main` commit: deploy it to staging, verify it, then promote the same commit to production after human approval. Each environment requires separate resources and credentials; the `staging` Git branch is not a deployment source. The initial staging deployment used the authorized operator route and passed bounded hosted staff-command checks. The Actions workflow remains gated, and production deployment is not configured. See [ADR 0012](docs/adr/0012-main-environment-promotion.md) and [operations](docs/operations.md) for URLs, deployed revision, session-revocation limits and release controls.

Each contributor installs and authenticates their own Claude or Codex client and verifies its role/tool support. Native-client setup is separate from repository and cloud readiness.

## Project documentation

- [Delivery plan](docs/delivery.md): next Cloudflare Workers/Supabase checkpoint, followed by ordered publication, tracking and reporting slices.
- [Verification map](docs/verification.md): existing evidence and feature acceptance requirements.
- [Contributing](CONTRIBUTING.md): complete PRs, dependency maintenance and context handoffs.
- [Research record](docs/research/README.md): the 65-repository pattern survey and adopted design choices.

## Optional product analytics

See [PostHog setup and evidence limits](docs/posthog.md) for consent, separate staging/production build variables, taxonomy mapping, validation and manual project setup. Tracking is disabled until configured; current shells do not publish menu or owner-report events.

Python processing uses `uv sync --project processing --frozen` and
`uv run --project processing --frozen python -m unittest discover -s processing/tests`.
The local package and review boundaries are described in the
[processing guide](processing/README.md) and [delivery handoff](docs/ocr-delivery.md).
Python tests and package builds run in CI alongside the repository checks.
