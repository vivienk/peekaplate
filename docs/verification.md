# Verification tied to the V1 plan

Reviewed baseline: [PeekaPlate Orchestration + V1 Team Plan](https://claude.ai/artifact/HxpC9aET7geEwkEpyG6wrt), inspected October 14, 2026. The external artifact can change. The requirements below, accepted ADRs and delivery gates are the repository-local review baseline; changes require explicit review. This is a trace of requirements, not a copy of the full artifact or a claim of completed product behavior.

| Requirement and source | Evidence now | Evidence required when implemented |
| --- | --- | --- |
| Artifact §5 / ADR 0004: T0 ≤150 KB gzip JS; no initial renderer | Vite build walks initial chunks; unit fixtures test graph/budget rejection | Real published menu and assets; LCP ≤2.5 s on 4 Mbps / 150 ms profile |
| Artifact L3 / ADR 0004: accessible photo-first menu | Browser job: no-JS shell; axe A/AA scans and 320px overflow checks for both shells | Real interactions, loading/error states; keyboard/reduced motion; manual VoiceOver/TalkBack |
| Artifact §5: T1 ≤400 KB incremental including code, manifest and textures | Deliberately absent: no viewer or capture assets yet | Per-part build accounting; mount/update/dispose, context-loss fallback; p75 tap-to-interactive ≤2.5 s; p95 frame ≤33.3 ms over 10 seconds on two named real phones |
| Artifact §4 / ADR 0002: expected-version, idempotent atomic domain commands | Local integration cases exercise concurrent first/existing revisions, identical/conflicting retries, revoked membership and late-write rollback against the real Worker and PostgreSQL; execution results belong to the PR | Repeat against deployed Supabase/Hyperdrive; add publication/approval invariants in their feature slice |
| Artifact §4 / ADR 0005: tenant isolation with restricted roles | SQL policy assertions, cryptographic JWT tests and local Worker/DB cases cover current membership, denied cross-venue writes and context reset after commit/rollback on a reused connection | Real Supabase login/session revocation, migration/runtime role compatibility and actual Hyperdrive pool reuse; local fixtures cannot establish these |
| Artifact §4: replay equals live projections; old versions upcast; replay has no effects | Pure dish reducer rejects mixed/gapped/unsupported streams; local integration compares stored events with the live projection and checks unchanged row counts | Snapshot-safe operational rebuild tooling and explicit upcasters when another event schema version is introduced; publication/other streams remain future work |
| Artifact §6–7 / ADR 0003: receipt after Queue acceptance; archive before database/ACK; exact exposure | Strict exposure contract rejects client authority fields | Offline reload/retry, partial receipts, Queue/DB failure, conflicting IDs, create-only archive, DLQ repair and deletion |
| Artifact §8 / ADR 0006: linked outcomes, unknown unlinked, frozen switchbacks | Documented contract only | POS import/link reconciliation, expiry/venue checks, suppression below ten sessions, assignment and analysis-plan tests |
| Artifact G3 / ADR 0007: recover accepted evidence | Isolated local migration checks only | Outage/restore drill, IDs/checksums, deletion reapplied, measured RPO ≤24 h and RTO ≤4 h; load bursts around 50 events/s |

## Purpose and latency of existing CI jobs

`quality` always checks formatting, strict types, unit and script tests, builds, context and PR documentation. `changes` selects the database and three parallel browser jobs for their relevant paths. Dependency and CI changes exercise them all. `ci` is the only aggregate check to require. Locally, `pnpm verify test:e2e` runs the same three browser scripts in sequence. CI also runs the offline dish review preview once.

The database lane applies the previous schema, preserves a synthetic row through the forward migration, checks SQL policies, exercises the actual local Worker against PostgreSQL and runs the local startup/demo/cleanup path. These use disposable Docker databases and local signing keys; no provider credentials are required.

Use deterministic checks on each PR. Run field performance, cloud failure injection, manual accessibility and restoration when their feature exists and before its release gate; a passing shell cannot substitute for those results. Add Lighthouse CI to the real T0 delivery slice, where there is a menu worth measuring. Keep heavy load/restore checks separate from routine PR CI.

Record actual run URLs/durations in the PR. The warm PR target is under five minutes; it is not an SLA. The current viewer and ingestion latency are unmeasured because those features do not exist. Dependency groups, frozen installations, path selection and cancellation of superseded runs keep recurring work bounded.
