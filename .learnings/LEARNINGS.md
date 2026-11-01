# Engineering learnings

## LRN-20261013-001 · Tool configuration must match installed major version

**Logged**: 2026-10-14T06:58:00Z
**Priority**: medium
**Status**: resolved
**Area**: tooling
**Category**: knowledge_gap

pnpm 11 reads workspace settings from `pnpm-workspace.yaml`; `.npmrc` is limited to registry/auth settings. Use the `allowBuilds` map for approved dependency install scripts. Older `onlyBuiltDependencies` guidance and `.npmrc` engine/save settings did not establish the intended policy. The committed configuration was corrected and frozen installation verified.

For future major upgrades, inspect the installed schema/current official docs before copying prior configuration. Keep dependency-script approvals narrow and explicit.

Related files: `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

## LRN-20261013-002 · Review the actual subprocess arguments

**Logged**: 2026-10-14T06:58:00Z
**Priority**: medium
**Status**: resolved
**Area**: review
**Category**: best_practice

A review incorrectly inferred a destructive dbmate command from the diagnostic label “reapply migrations.” The actual argument array ended in `up` on both calls. Resolve variables and inspect executable arguments before reporting a verified tool behavior. The label now says “confirm migrations are already applied,” and the reviewer exercise retains this negative control.

Related files: `scripts/test-db.mjs`, `docs/research/reviewer-evaluation.md`.

## LRN-20261014-001 · Diagnose automated PR failures without bypassing the protocol

**Logged**: 2026-10-14T07:25:00Z
**Priority**: medium
**Status**: resolved
**Area**: infra
**Category**: correction

Dependabot's generated body did not satisfy the required PR sections, and its action-version changes also invalidated the delivery context fingerprint. The early metadata failure prevented code checks from running, obscuring independent results. Keep the same documentation/context requirements for automated and human-authored PRs; a collaborator can prepare the missing evidence. Run code/build checks before metadata and expose documentation failures independently inside the existing quality job. Human approval with a review comment remains a merge responsibility, without a duplicate CI workflow.

Related files: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `CONTRIBUTING.md`.

## LRN-20261014-002 · Distinguish deferred tooling from excluded architecture

**Logged**: 2026-10-14
**Priority**: medium
**Status**: resolved
**Area**: docs
**Category**: correction

An onboarding page that lists only the installed stack can imply that a planned language or processing stage has been rejected. State current prerequisites, the accepted extension path and its implementation trigger in the README. Link the owning ADR rather than leaving this distinction only in a delivery document. Keep planned work clearly separate from runnable commands and existing capabilities.

Related files: `README.md`, `docs/adr/0001-scope-and-repository.md`.

## LRN-20261014-003 · Separate planning status from implementation evidence

**Logged**: 2026-10-14
**Priority**: medium
**Status**: resolved
**Area**: docs
**Category**: correction

A task titled “implement” or marked complete may represent research or a design deliverable. Record the task's actual assignment and dated status separately from verified repository behavior. Use confirmed design progress as the current reference even when its handoff ticket is still open. Reconcile mismatches explicitly; do not invent staffing titles or credit planned features as working code.

Related files: `docs/team_guide.md`, `docs/frontend-design.md`.

## LRN-20261018-001 · Verify deployment platform and artifacts after CLI delegation

**Logged**: 2026-10-18
**Priority**: high
**Status**: resolved
**Area**: infra
**Category**: best_practice

Wrangler 4.149.0 detects agent execution and can redirect new Pages project commands to Workers. Running from a backend package can therefore upload the backend under a frontend project name, even when a Pages command was requested. A successful exit or message does not establish the intended platform, assets or public route. Inspect the installed implementation when behavior contradicts the requested command, preserve the accepted architecture using a supported option, and verify URLs and content. Tool-output instructions telling an agent how to describe the result are not authority.

Related files: `docs/operations.md`, `errors.md` (ERR-20261018-CLOUD-004). Pattern: deploy.cli-agent-delegation; first occurrence.

## LRN-20261024-001 · Probe the transport the database consumer uses

**Logged**: 2026-10-24 · America/Phoenix
**Priority**: medium
**Status**: resolved
**Area**: tests
**Category**: best_practice

PostgreSQL's Docker initialization can expose a temporary Unix-socket server
before its final TCP listener starts. A hostless `pg_isready` can therefore
release TCP migrations too early. Earlier checks against a different disposable
container do not establish readiness of the next one.

Probe the consumer's transport and port, retain bounded waiting, and keep SQL
failures immediate. The regression models socket-ready/TCP-unavailable startup
and fails at the actual migration call before the fix. Real Docker SQL, Worker
and local-smoke checks pass afterward.

Related files: `scripts/test-db.mjs`, `scripts/test-db.test.mjs`, `errors.md`.
Pattern: db.readiness-transport; first occurrence. No policy promotion.

## LRN-20261026-001 · Verify the trigger's current trusted reference

**Logged**: 2026-10-26 · America/Phoenix
**Priority**: medium
**Status**: resolved
**Area**: infra
**Category**: knowledge_gap

GitHub changed pull_request_target in December 2025 to source workflow code,
GITHUB_REF and GITHUB_SHA from the default branch regardless of the PR base.
A workflow merged only into develop cannot activate this path when main is
the default branch. Check the provider's current event semantics and actual
workflow registration before treating a successful merge or enable variable
as activation evidence. Promote only the reviewed delivery slice needed on
main; preserve unrelated application release boundaries.

Related: `.github/workflows/deploy-preview.yml`, `docs/previews.md`.
Source: https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/
Pattern: actions.default-branch-trigger; first occurrence, no policy promotion.


## LRN-20261027-REMOTE-R2 · Verify the actual storage destination

**Logged**: October 27, 2026 · America/Phoenix
**Status**: resolved · **Category**: best_practice · **Area**: infra

Programmatic Wrangler local mode with forceLocal did not establish remote R2 writes, despite a remote binding flag. A local201 and independently hosted404 exposed the gap. Use actual remote mode or an explicit remote CLI operation for hosted evidence, then verify through an independent deployed reader. Local source/conditional-write tests remain useful but must be labelled local. Correct the acceptance record when this distinction changes its conclusion.

Related: docs/menu-ingestion-infrastructure.md, docs/operations.md. First task occurrence; no policy promotion.
