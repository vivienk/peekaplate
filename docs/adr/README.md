# Architecture decisions

Accepted decisions express intent, not proof of completed implementation. Review acceptance tests and source before claiming a decision is realized. New decisions use `NNNN-short-title.md` with Status, Context, Decision, Consequences and Verification; supersede rather than erase accepted history.

| ADR | Decision |
| --- | --- |
| [0001](0001-scope-and-repository.md) | One venue, pnpm monorepo and explicit module boundaries |
| [0002](0002-selective-event-sourcing.md) | Selective Postgres event sourcing and safe replay |
| [0003](0003-intent-evidence.md) | Queue/archive/database evidence and pinned exposure |
| [0004](0004-visual-tiers.md) | T0 first; one lazy Three.js viewer for T1/T2 |
| [0005](0005-tenancy-and-privacy.md) | Server-owned authority, private data and retention |
| [0006](0006-orders-and-measurement.md) | POS linkage and honest metrics |
| [0007](0007-delivery-and-recovery.md) | Staging, migration, rollout and recovery gates |
| [0008](0008-agent-context-and-review.md) | Small grounded context and evidence-led review |
| [0013](0013-posthog-export-boundary.md) | Private PostHog export copy; duplicate-safe internal analysis |
| [0014](0014-team-analytics-access.md) | Individual staging team access through bounded, redacted analytics APIs |

- [0010 — Canonical repository and release branches](0010-canonical-repository-and-release-branches.md) — Proposed; migration review required.

- [0011 — Deploy staging from the staging branch](0011-staging-environment-branch.md) — Accepted; supersedes ADR 0010 branch selection.
- [0012 — Promote a main commit through staging and production](0012-main-environment-promotion.md) — Accepted; supersedes deployment branch selection in ADRs 0010 and 0011.
- [0015 — Integration contracts and owner-evidence boundary](0015-integration-contracts-and-owner-evidence.md) — Proposed; S3-ARC-01 approval required.
