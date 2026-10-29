# Error ledger

Consult this ledger before starting related work. Automatic records below cover only checks run through `node scripts/verify.mjs`; they record an observation, never a root cause.

For a confirmed issue, add a short sanitized entry with the cause, prevention, and regression check. Do not record output, logs, environment values, secrets, customer data, or private source material. Keep records append-only; maintainers may curate older entries.

## Confirmed prevention records

These records describe reproduced tooling defects fixed during foundation verification. They do not imply production incidents.

```json
{"id":"ERR-20261014-001","status":"resolved","area":"initial-bundle-gate","cause":"Initial imports absent from the bundle map were silently filtered out, allowing an unaccounted external import to escape budget inspection.","prevention":"Traverse every initial import and fail when its chunk cannot be accounted for.","sources":["scripts/check-bundle.mjs","scripts/check-bundle.test.mjs"],"regression":"External initial-import fixture fails closed; node --test scripts/check-bundle.test.mjs passed."}
```

```json
{"id":"ERR-20261014-002","status":"resolved","area":"database-test-diagnostics","cause":"The DB harness dropped stderr when a child process failed, concealing an invalid SQL fixture behind only an exit status.","prevention":"Include at most the last 2000 characters of child stderr in console diagnostics; never copy it into this ledger.","sources":["scripts/test-db.mjs","scripts/test-db.test.mjs"],"regression":"Bounded-diagnostic assertion passed; corrected fixture passed real Postgres tests."}
```

```json
{"id":"ERR-20261014-003","status":"resolved","area":"verification-runner","cause":"Direct shell-free pnpm.cmd launch fails on Windows; fresh CI also lacks the ignored work directory needed for its ledger.","prevention":"Use Node with the package manager's existing pnpm entry point, or a fixed allowlisted platform fallback. Create ledger and summary directories before append.","sources":["scripts/verify.mjs","scripts/verify.test.mjs"],"regression":"Real Windows named-check invocation and missing-directory recording tests passed. Signal, exit-code, safe-URL and no-output-capture tests passed."}
```

## Environment observations

These records describe local validation limits, not application failures.

```json
{"id":"ERR-20261014-004","status":"open","area":"native-agent-validation","observation":"An isolated Codex CLI evaluation could not load the five project agent types. A normally configured attempt stopped because the installed CLI 0.147.0 does not support the selected model. Claude Code 2.1.251 was not authenticated.","cause":"Client/model compatibility and missing Claude authentication block native validation; the separate agent-discovery failure has not been diagnosed.","prevention":"Verify client compatibility, authentication and actual named-role launch before claiming native integration works. Prompt-body evaluations must be labelled separately.","sources":["docs/research/reviewer-evaluation.md"],"resolutionRequired":"Repeat native named-role launch and tool-restriction checks in compatible authenticated clients; current prompt behavior tests do not close this observation."}
```

```json
{"id":"ERR-20261014-005","status":"resolved","area":"agent-patch-tool","cause":"The patch tool rejected a document replacement expressed as both delete and add operations for the same path; no files were changed by the rejected patch.","prevention":"Use a single update operation per existing file.","regression":"Both document replacements applied successfully as single update operations; git diff --check passed."}
```

```json
{"id":"ERR-20261014-006","status":"resolved","area":"windows-source-search","cause":"A wildcard supplied as an rg path operand was passed literally on Windows and rejected as an invalid path.","prevention":"Pass explicit paths or use rg --glob with an existing search root.","regression":"The same source query succeeded with explicit package paths and returned the expected development ports, build commands and migration tables."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-14T21:12:26.054Z","exitCode":1}
```

```json
{"id":"ERR-20261014-007","status":"resolved","area":"formatting","cause":"Two edited source files had not been formatted before the recorded check.","prevention":"Format changed files before the final recorded verification.","regression":"pnpm check passed after formatting; formatting remains enforced by CI."}
```

```json
{"id":"ERR-20261014-008","status":"open","area":"windows-docker-startup","observation":"Docker Desktop fails before the Linux engine starts, while initializing an AF_UNIX inference socket. Preserving and recreating only the runtime socket directories did not restore startup.","cause":"The error matches Docker Desktop reports on Windows build 26200; the underlying operating-system cause is not independently proven.","prevention":"Preserve images and volumes; avoid factory resets, pruning or guessed setting changes. Validate docker version and docker info after a controlled Windows restart before running database checks.","sources":["https://github.com/docker/desktop-feedback/issues/527","https://github.com/docker/desktop-feedback/issues/460"],"resolutionRequired":"Restart Windows when work is saved, then verify engine readiness. Linux CI can independently validate the repository database suite."}
```

```json
{"id":"ERR-20261014-009","status":"open","area":"staff-database-test-plan","cause":"The staff SQL fixture declared 17 assertions but emitted 16. The harness correctly failed the mismatch after all emitted assertions passed.","prevention":"Keep the TAP plan synchronized with the assertion count and retain strict plan validation.","sources":["tests/db/staff.sql","scripts/test-db.test.mjs"],"resolutionRequired":"Rerun pnpm verify test:db after correcting the plan to 16; first failing run: https://github.com/vivienk/peekaplate_staging/actions/runs/38639083060."}
```

```json
{"id":"ERR-20261014-010","status":"resolved","area":"shell-quoting","cause":"A nested PowerShell command used double quoting around script variables, allowing the outer shell to expand them before execution.","prevention":"Use single-quoted PowerShell command text with correctly escaped embedded quotes, or a saved script; preserve literal variables until the intended shell reads them.","regression":"Targeted process and configuration inspection succeeded with literal script variables; no application source change was needed."}
```

```json
{"id":"ERR-20261014-011","status":"open","area":"security-review-snapshot","cause":"The security workbench captured a working-tree snapshot before implementation was finalized. Its immutable revision contract no longer matched the reviewed implementation, and the available context update cannot re-pin it.","prevention":"Start durable security scans only after pinning the completed change; never report an obsolete snapshot as a passing review of new code.","resolutionRequired":"The obsolete scan was marked failed with no verdict. Independent pinned architecture and correctness/security review is recorded separately in the PR; a fresh workbench scan requires a subsequent explicit scan task."}
```

```json
{"id":"ERR-20261014-012","status":"resolved","area":"local-resource-cleanup","cause":"A rejected Worker shutdown skipped database and session-file cleanup while the re-entry guard suppressed later cleanup attempts.","prevention":"Protect independent cleanup steps with finally blocks so an earlier rejection cannot bypass them.","sources":["backend/local.mjs","backend/local.test.mjs"],"regression":"The injected Worker-stop failure test failed on the original path because database cleanup was never called; the corrected path must attempt both database removal and session unlink."}
```

```json
{"kind":"resolution","resolves":"ERR-20261014-009","status":"resolved","evidence":"pnpm verify test:db passed: 27 foundation plus 16 staff SQL assertions, 13 real Worker/PostgreSQL integration tests and the local startup/demo path.","run":"https://github.com/vivienk/peekaplate_staging/actions/runs/38639809572"}
```

```json
{"kind":"verification","references":"ERR-20261014-012","evidence":"pnpm check passed with the rejecting-Worker-stop regression test; Linux CI also completed the actual local startup/demo/cleanup path.","run":"https://github.com/vivienk/peekaplate_staging/actions/runs/38639809572"}
```

```json
{"id":"ERR-20261014-013","status":"resolved","area":"security-documentation","cause":"SECURITY.md still described a health-only scaffold after the staff command and restricted runtime role were implemented.","prevention":"Include the security overview when updating implemented trust boundaries; link it in the delivery context node.","sources":["SECURITY.md","backend/src/index.ts","docs/CONTEXT.md"],"regression":"The overview now separates implemented local identity/membership/transaction controls from unverified hosted-provider behavior; documentation and context checks validate its references."}
```

```json
{"id":"ERR-20261014-014","status":"resolved","area":"browser-readiness","cause":"A browser connection changed during read-only inspection, task bodies loaded after their headings, and a task link included a description badge in its text.","prevention":"Check the browser inventory before reconnecting; ground locators in actual headings and wait for relevant descriptions before classifying content as absent.","regression":"Recovered through the supported Brave interface and read all 24 parent tasks plus seven scope subtasks, including descriptions initially missing during loading."}
```

```json
{"id":"ERR-20261014-015","status":"resolved","area":"documentation-edit-tooling","cause":"An inline Python edit contained a literal newline inside a quoted string and failed before writing files.","prevention":"Use apply_patch for bounded documentation edits instead of constructing multiline shell scripts across language quoting layers.","regression":"The intended context and ledger changes were applied directly and verified through context and documentation checks."}
```

```json
{"id":"ERR-20261014-016","status":"resolved","area":"windows-recovery-verification","cause":"The local PowerShell environment could not load its hash and Authenticode cmdlets during offline Docker recovery preparation.","prevention":"Fail closed when verification tooling is unavailable; use an available checksum implementation and the vendor's published digest before executing an installer.","regression":"Both offline disk copies matched streaming SHA-256 checks; certutil independently matched the Docker 4.95.0 installer to the published SHA-256. The embedded publisher certificate identified Docker Inc. No signature-validation PASS was inferred from certificate extraction."}
```


<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-15T05:47:09.061Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-15T05:50:07.099Z","exitCode":1}
```

```json
{"id":"ERR-20261014-018","status":"resolved","area":"database-test-launcher","cause":"The database harness accepted pnpm/pnpm.js/pnpm.cjs entry points but rejected the installed pnpm.mjs path before Worker integration tests, even when invoked through pnpm verify test:db.","prevention":"Resolve and invoke the installed Vitest CLI through Node instead of assuming a package-manager entry-point suffix. Preserve database environment, timeout, failure propagation and harness cleanup.","sources":["scripts/test-db.mjs","scripts/test-db.test.mjs"],"regression":"node --test scripts/test-db.test.mjs reproduced the same Run this check through pnpm verify test:db error with a pnpm.mjs fixture, then passed after the fix. pnpm verify test:db passed all 43 SQL assertions, 13 Worker/Postgres tests and the local startup/demo/cleanup flow on Windows."}
```

```json
{"kind":"resolution","resolves":"ERR-20261014-008","status":"resolved","evidence":"After checksummed offline backups of both Docker disk files, the official SHA-256-verified Desktop 4.95 installer completed the existing per-user upgrade. docker version and docker info reached the Linux engine (29.8.2); existing container/image inventory remained visible. pnpm verify test:db passed after fixing ERR-20261014-018. No reset, prune, WSL unregister or data-directory deletion was performed.","sources":["https://github.com/docker/desktop-feedback/issues/460","https://docs.docker.com/desktop/release-notes/","docs/operations.md"],"limit":"Backups are retained; unrelated existing workloads were not functionally tested."}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-15T05:50:07.099Z"},"cause":"The check ran while documentation edits were still in progress and before the required context fingerprint refresh.","prevention":"Refresh and inspect affected context nodes after completing source edits, then run the final recorded check. This observation does not indicate an application regression."}
```

```json
{"id":"ERR-20261017-MIGRATION-001","status":"resolved","area":"migration-tooling","cause":"Context refresh was first invoked from the audit directory instead of the core checkout; the process exited before changing context. RTK is unavailable on this host, so direct commands are used.","prevention":"Run checks with the core checkout as working directory.","regression":"node scripts/context.mjs refresh completed in the core checkout."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-17T21:13:18.609Z","exitCode":1}
```

```json
{"id":"ERR-20261017-MIGRATION-002","status":"resolved","area":"context-freshness","cause":"JSON formatting changed the two ruleset files after source fingerprint refresh; the freshness check correctly failed.","prevention":"Format all changed sources before final context refresh.","regression":"Refreshed after formatting; pnpm verify context:check docs:check passed."}
```

```json
{"id":"ERR-20261017-MIGRATION-003","status":"resolved","area":"local-dependency-install","cause":"The fallback pnpm launcher attempted dependency downloads in the network-restricted context and encountered ENOTFOUND.","prevention":"Use the approved network context and explicit pinned Node and pnpm tools for installation.","regression":"Frozen dependency installation passed with Node 24.16.0 and pnpm 11.25.0; lint, types and 56 unit/script tests passed."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-18T17:41:58.315Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"test:db","timestamp":"2026-10-18T17:41:58.315Z"},"status":"resolved","cause":"Docker Desktop's Linux daemon was not running in the new canonical checkout verification session; the named engine pipe was unavailable before any database test executed.","prevention":"Confirm docker version reaches the server before running database verification; start the existing Desktop installation without resetting or deleting data.","regression":"After starting the installed Docker Desktop, docker version reported server 29.8.2 and pnpm verify test:db passed 43 SQL assertions, 13 Worker/Postgres tests and the local startup/demo/cleanup flow. No application code, Docker installation or existing volumes changed."}
```

```json
{"id": "ERR-20261019-POSTHOG-001", "status": "resolved", "area": "local-tooling", "cause": "RTK is unavailable and offline dependency resolution lacked optional platform metadata.", "prevention": "Use direct commands on this host and the approved network installation context with a supported Node 24 runtime.", "regression": "Network installation completed with repository-pinned dependency versions; no runtime dependency upgrades were requested."}
```

```json
{"id":"ERR-20261019-POSTHOG-002","status":"resolved","area":"context-source-paths","cause":"The context graph rejects env-style source paths, including credential-free .env.example files.","prevention":"Document example build variables in docs/posthog.md and fingerprint that guide instead of env files.","regression":"Removing the example paths allowed context:refresh to validate all nine nodes."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-20T04:46:52.443Z","exitCode":1}
```

```json
{"id":"ERR-20261019-POSTHOG-003","status":"resolved","area":"sandbox-local-servers","references":{"check":"test","timestamp":"2026-10-20T04:46:52.443Z"},"cause":"The restricted execution context rejected loopback server binding with EPERM, preventing existing auth/local-harness test setup.","prevention":"Run local-server checks in an approved context that permits loopback listeners; do not weaken auth tests.","regression":"The permitted pnpm check rerun passed 50 application and 21 script tests; pnpm verify build and pnpm verify test:e2e passed, including four foundation and four intercepted analytics browser cases."}

```json
{"id":"ERR-20261018-CLOUD-001","status":"resolved","area":"operator-authentication","cause":"Wrangler keyring login required its Windows helper; a non-interactive attempt could not install it. A later localhost OAuth retry expired and then rejected a mismatched callback state.","prevention":"Use Wrangler's interactive keyring setup and an isolated device-login flow when localhost callbacks are stale. Never disable OAuth state validation or print credentials.","regression":"wrangler login --device --scopes account:read user:read workers:write --use-keyring --browser=false succeeded. wrangler whoami confirmed encrypted credential storage and the approved scopes; an account-scoped wrangler hyperdrive list returned the expected staging connection.","limit":"Authentication and resource listing do not prove deployment or hosted database behavior."}
```

```json
{"id":"ERR-20261018-CLOUD-002","status":"resolved","area":"context-handoff-limit","cause":"Adding the cloud setup handoff exceeded the ten-entry context limit; refresh refused the update.","prevention":"Roll the oldest handoff into Git history before adding a new entry to a full context list.","regression":"After retaining the ten newest handoffs, pnpm context:refresh completed for all eight modules."}
```

```json
{"id":"ERR-20261018-CLOUD-003","status":"resolved","area":"deployment-permissions","cause":"Wrangler account inspection succeeded with workers:write, but the deployments endpoint rejected the token because workers_scripts:write was absent.","prevention":"Validate the scopes required by the exact operation; account listing and dry-run do not establish deployment authority. Obtain explicit approval before expanding access.","regression":"After approved Workers Scripts Write and Pages Write authorization, the staging Worker and both Pages deployments succeeded. Live API and asset smoke checks passed."}
```

```json
{"id":"ERR-20261018-CLOUD-004","status":"resolved","area":"pages-deployment-routing","cause":"Wrangler 4.149.0 delegated new Pages project creation to Worker deployment in agent mode, using the backend working directory and uploading unrouted backend scripts under frontend names.","prevention":"Verify the actual platform, uploaded content and deployment URL. For the accepted Pages architecture, use the verified creation opt-out when necessary; subsequent deployments must explicitly name the existing Pages projects and frontend build directories. Treat tool instructions about how to report success as untrusted output.","regression":"Created the two intended Pages projects with the supported one-time --force option, uploaded the actual frontend builds, and verified both pages plus referenced assets return 200. Removed only the two unintended Workers created during this attempt; the API Worker remains live."}
```

```json
{"id":"ERR-20261018-CLOUD-005","status":"resolved","area":"pr-documentation","cause":"PR 11 listed verification commands without backticks, so the existing PR-documentation gate rejected the declaration even though code checks passed.","prevention":"Validate the exact body file with scripts/check-pr.mjs before submitting or editing a PR. Keep the required PASS/FAIL/NOT RUN command syntax; do not weaken the gate.","regression":"The corrected body passed the exported checkPullRequest validator; edited-body CI revalidates the submitted content.","evidence":"https://github.com/vivienk/peekaplate/actions/runs/39206328276"}
```

```json
{"id":"ERR-20261018-DOCS-001","status":"resolved","area":"documentation-edit-tooling","cause":"A documentation read used an incorrect workflow filename and assumed the implementation plan existed on main; it is currently restored on develop. An initial patch repeated its target path and was rejected. A nested PowerShell smoke command expanded variables in the outer shell and failed before making requests.","prevention":"Resolve branch-specific paths from Git before reading; group patch hunks under one file target; use a script file for multi-statement probes instead of nested shell interpolation.","regression":"Read .github/workflows/deploy-staging.yml and verified the plan in preserved planning and develop history. Grouped patches succeeded. A Node script returned HTTP 200 and expected content for both staging pages and API health. pnpm check and git diff --check passed."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-19T22:41:42.253Z","exitCode":1}
```

```json
{"id":"ERR-20261019-DOCS-001","status":"resolved","area":"context-documentation","references":{"check":"context:check","timestamp":"2026-10-19T22:41:42.253Z"},"cause":"Appending guidance exceeded the delivery node's 1000-character summary limit; context refresh and the first full check correctly rejected it.","prevention":"Keep node summaries below the validator's limit, put details in source docs and stop dependent checks if context refresh fails.","regression":"Shortened the summary without changing implementation status. pnpm context:refresh and pnpm check passed, including context validation, local links, 35 application tests and 21 repository-script tests. No runtime fix was needed.","sources":["docs/CONTEXT.md","scripts/context.mjs"]}
```

```json
{"id":"OBS-20261019-POSTHOG-LIVE-001","status":"observation","area":"live-capture-verification","observation":"The first isolated browser probe timed out waiting for a capture response. Its cause was not captured and is not established.","followup":"Added sanitized request-failure diagnostics to the local probe. A rerun returned HTTP 200 for one diner and one console shell event; both matching records were read back in the real staging project.","limit":"No production traffic or application-code fix. The passing examples prove connectivity, not a delivery guarantee. Retain bounded failure behavior; investigate if this recurs.","sources":["docs/posthog.md","packages/analytics/src/index.ts"]}
```

```json
{"id":"ERR-20261019-RELEASE-001","status":"resolved","area":"release-context","cause":"The release merge included a newer main README edit, so the delivery fingerprint calculated on the feature head no longer matched the proposed merged tree.","prevention":"Check the release merge tree against the reviewed head, preserve target-branch edits, and refresh affected context before promotion.","regression":"Merged the current main README change into the release candidate and refreshed the delivery fingerprint; context validation must pass on the resulting release tree.","evidence":"https://github.com/vivienk/peekaplate/actions/runs/39381320009","sources":["README.md","docs/CONTEXT.md"]}
```

```json
{"id":"OBS-20261019-EXPORT-RED-001","status":"resolved","area":"posthog-export-tests","cause":"The intentional red test found the requested private analytics table absent before implementation.","regression":"Added a forward migration. pnpm verify test:db passed 15 new export assertions, existing 43 pgTAP assertions, 13 database integration cases and the local demo lifecycle.","sources":["migrations/20261020070000_posthog_exports.sql","tests/db/posthog.sql"]}
```

```json
{"id":"OBS-20261019-SETUP-TOOLS-001","status":"resolved","area":"operator-tooling","observation":"A quoted shell comment command failed to parse, and claiming an existing Supabase browser tab timed out twice. Neither action completed a write.","prevention":"Use a UTF-8 body file for GitHub prose. Recover a stale browser tab through a new tab in the already-selected browser, without accessing profile files.","regression":"Body-file submission succeeded. A fresh Supabase tab displayed the existing app_private schema."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-20T06:48:43.863Z","exitCode":1}
```

```json
{"id":"OBS-20261020-EXPORT-TLS-001","status":"open","area":"hosted-posthog-export","observation":"The first bounded Events export failed certificate verification with system certificate authorities. Supabase readback returned zero rows. The backfill wrapper said Completed even though its individual run failed.","followup":"Schedule paused. Use the official Supabase root certificate while retaining certificate and hostname verification; repeat the bounded export and deduplication check before claiming transfer success.","prevention":"Check individual run status plus database rows. Connection creation and backfill completion alone do not establish successful delivery.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261020-EXPORT-ADMIN-001","status":"open","area":"hosted-posthog-export","observation":"Operator reported that correcting the existing integration requires project Admin access. Browser file upload also required manual operator completion.","followup":"Vivien updates the connection or grants project Admin access. Retain TLS verification, then verify actual rows and retry deduplication before resuming the paused schedule.","sources":["docs/posthog-export.md","docs/operations.md"]}
```

```json
{"id":"OBS-20261020-EXPORT-ADMIN-002","status":"resolved","area":"hosted-posthog-export","references":["OBS-20261020-EXPORT-ADMIN-001"],"observation":"Provider membership readback confirmed Admin access. Existing integration update succeeded without a permission workaround.","limit":"Access correction does not establish successful export or billing-limit verification.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261020-EXPORT-TLS-002","status":"resolved","area":"hosted-posthog-export","references":["OBS-20261020-EXPORT-TLS-001"],"observation":"Attached the official Supabase CA and retained certificate/hostname verification. Bounded retry reached PostgreSQL authentication instead of failing TLS.","regression":"Run 01a15d01-7dc1-0000-2e18-a56c0872e0f5 no longer reported certificate verification failure; it failed separately with EAUTHQUERY.","limit":"Transfer and duplicate-safe replay remain unverified.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261020-EXPORT-AUTH-001","status":"open","area":"hosted-posthog-export","observation":"Bounded export retry failed with EAUTHQUERY: unsupported or invalid secret format. A read-only role check returned LOGIN enabled, no expiry and a missing password; no verifier was displayed.","cause":"The dedicated database role had no password set. Entering a password in the destination form does not set the PostgreSQL role password.","prevention":"Verify password presence and expiry without printing the stored verifier, then require actual connection and matching-row evidence. Never broaden grants or weaken TLS for credential errors.","followup":"Operator sets the same password privately on the restricted role and clears the editor. Repeat bounded export and deduplication verification before resuming schedule.","sources":["docs/posthog-export.md","docs/operations.md"]}
```

```json
{"id":"OBS-20261021-EXPORT-AUTH-002","status":"resolved","area":"hosted-posthog-export","references":["OBS-20261020-EXPORT-AUTH-001"],"observation":"After the operator's password correction, a read-only role check returned SCRAM password format, LOGIN enabled and no expiry. The editor was replaced with non-secret verification SQL.","limit":"Resolves missing password only. Subsequent export authentication still fails; successful transfer is not established.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261021-EXPORT-AUTH-003","status":"open","area":"hosted-posthog-export","observation":"Runs 01a15d25-6f43-0000-b5f1-ce8d7e959bca and 01a15d2e-9c4d-0000-1eeb-641c9338cae1 failed password authentication after the database password correction. The second bounded retry followed a delay. No credential mismatch or pooler-cache cause has been proven.","followup":"Re-enter the exact database password privately in the existing integration with verified TLS. If failure persists, privately test direct authentication to distinguish credentials from pooler failure; avoid repeated resets and retry loops. Prove matching rows and duplicate-safe repetition before enabling the paused schedule.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261021-EXPORT-UI-001","status":"observation","area":"operator-tooling","observation":"Browser extension routing was unavailable. Native Windows control allowed tab and form work, but accessibility indexes and geometry sometimes lagged visible scrolling; the file picker did not accept automation reliably.","prevention":"Refresh after layout changes, confirm actual field contents, and hand an unresolved native file picker to the operator. Do not infer success from an input call or bypass browser safety checks.","followup":"Use the prepared connection form and official certificate file; operator completes private credential input. No broader browser access or security setting change is required."}
```

```json
{"id":"OBS-20261021-CERT-TOOLS-001","status":"resolved","area":"operator-tooling","references":["ERR-20261018-DOCS-001"],"observation":"A nested PowerShell certificate-inspection command expanded variables in the outer shell and failed parsing before reading the certificate.","prevention":"Use a script file for multi-statement probes rather than nested shell interpolation.","regression":"A local Node crypto inspection read the CA expiry successfully. A separate credential-free TLS probe passed CA and hostname validation against the configured pooler; no database login or SQL was attempted.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261021-EXPORT-PROBE-001","status":"open","area":"hosted-posthog-export","references":["OBS-20261021-EXPORT-AUTH-003"],"observation":"An independent PostgreSQL client using the operator-supplied credential and verified TLS returned 28P01 for the restricted pooler login. The direct-host diagnostic failed DNS resolution with ENOENT before authentication. No database SQL executed; no credential was saved in project files.","followup":"Verify a working restricted credential before updating the destination and repeating export checks. Direct authentication remains untested, so do not claim a pooler-cache root cause or exclude it solely from this probe.","sources":["docs/posthog-export.md"]}
```

```json
{"id":"OBS-20261021-PROBE-TOOLS-001","status":"observation","area":"operator-tooling","observation":"Direct ESM import of the installed CommonJS PostgreSQL client failed with require is not defined. Loading it with createRequire succeeded and allowed the bounded authentication probe. A fresh browser-control inventory still timed out; native file-picker interaction remained unreliable.","prevention":"Use createRequire for the installed CommonJS client in this runtime. Report provider results separately from automation failures; never infer a successful file attachment from an input call."}
```

```json
{"id":"OBS-20261021-PRIVATE-SETUP-001","status":"resolved","area":"operator-tooling","observation":"PowerShell could not load its Security module for Set-Acl. Execution stopped before generating or writing a credential.","prevention":"Establish and verify private filesystem permissions before writing sensitive setup material. Preserve existing nonempty setup directories rather than regenerating credentials.","regression":"The .NET filesystem ACL API succeeded. Verification confirmed inheritance disabled and one explicit access rule for the current user before the private setup file was used. No credential was written to the repository."}
```

```json
{"id":"OBS-20261021-EXPORT-AUTH-004","status":"resolved","area":"hosted-posthog-export","references":["OBS-20261021-EXPORT-AUTH-003","OBS-20261021-EXPORT-PROBE-001"],"observation":"A private credential correction restored verified-TLS restricted pooler authentication. Two hosted exports completed the same bounded synthetic interval. Supabase readback found eight raw copies, four deduplicated events and each known diner/console test record once. All 14 row/permission checks passed; hourly schedule enabled.","regression":"Runs 01a15d4f-261f-0000-b88a-3f67d622bc39 and 01a15d53-eb5b-0000-0e3e-3ccb4c589db6. No missing/conflicting identities or out-of-scope rows. No broader grants.","limit":"Original cache or credential-mismatch cause is unproven. Direct-host IPv6 was unreachable. Next automatic hourly run not observed.","sources":["docs/posthog-export.md","docs/operations.md"]}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:35:09.347Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:36:48.316Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:37:36.494Z","exitCode":1}
```

```json
{"id":"OBS-20261021-TEAM-API-001","status":"resolved","area":"team-analytics-tests","observation":"The initial new HTTP tests returned 404 instead of required authentication/query errors because the team endpoint did not exist. The first database runs stopped because Docker was not running; native startup did not start the engine. The Docker desktop start command recovered it. A later SQL test assumed a Supabase anon role existed in plain local PostgreSQL.","prevention":"Use the installed Docker CLI startup command and explicit untrusted fixture roles in provider-independent database tests. Keep authentication and database authorization as separate tested boundaries.","regression":"Focused HTTP tests now pass; all 12 new SQL assertions and 14 real Worker/Postgres integration cases passed. Complete database harness cleanup/local smoke confirmation is recorded separately in PR evidence.","sources":["backend/src/team-analytics.test.ts","backend/src/dish.integration.ts","tests/db/team-analytics.sql"]}
```

```json
{"id":"OBS-20261021-GITHUB-ENV-001","status":"open","area":"team-access-activation","observation":"Staging environment secret/variable reads returned 404. Repository metadata confirms write but no admin access; environment listing was empty and repository Actions secret listing was empty.","followup":"Repository administrator creates the staging environment and configures a scoped deployment token without sharing it with contributors. No permission bypass or shared privileged API key is introduced.","sources":["docs/team-data-access.md"]}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:43:03.732Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:44:04.172Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:44:46.070Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:45:30.517Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:46:06.911Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-21T19:47:30.134Z","exitCode":1}
```

```json
{"id":"OBS-20261021-TEAM-API-002","status":"resolved","area":"worker-provider-fetch","observation":"Node-mocked GitHub authorization tests passed, but real workerd returned a sanitized 503 before reaching the local provider fixture. Workerd rejected redirect:error; its error explicitly required manual or follow.","cause":"Browser-style RequestRedirect error is unsupported by the configured Workers runtime.","regression":"Changed provider fetch to redirect:manual; user responses must be OK and membership exactly204, so redirects remain denied without forwarding credentials. Real Worker/PostgreSQL integration and all15 new SQL assertions passed after the correction. Added safe-property malformed/value fixtures.","prevention":"Exercise network-bound code in the actual Worker runtime; mocked fetch cannot establish support for native request options.","sources":["backend/src/team-auth.ts","backend/src/team-auth.test.ts","backend/src/dish.integration.ts","tests/db/team-analytics.sql"]}
```

## October 22 staging settings documentation validation

- Environment observation: `rtk` is unavailable in this local session; plain Git/Node commands were used. The initial sandboxed clone could not resolve GitHub; the authorized network retry succeeded.
- `pnpm context:refresh` attempted dependency preparation in the fresh checkout and could not reach the package registry under the sandbox. It was interrupted before the requested checks ran. No application failure is established.
- Fallback validation passed with `node scripts/context.mjs refresh`, `node scripts/context.mjs check`, `node scripts/check-docs.mjs` and `git diff --check`. These dependency-free checks cover this documentation change; the full build/test suite was not run. Use the repository-supported runtime and available dependencies for full CI validation.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-22T02:25:25.896Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-22T02:25:25.896Z"},"status":"resolved","cause":"Editing ADR 0015, which the contracts, measurement and analytics nodes reference, changed their fingerprinted inputs before refresh.","prevention":"Run pnpm context:refresh after editing a referenced ADR, then rerun pnpm check.","regression":"pnpm context:refresh followed by pnpm check passed."}
```

```json
{"id":"OBS-20261022-ADR15-PUSH-001","status":"resolved","area":"review-coordination","observation":"A normal PR-branch push was rejected because the author concurrently merged the same develop update.","cause":"The remote review head advanced after the local review was pinned.","regression":"Fetched and compared the new head, then merged it without force-pushing; the only retained local difference was the final technical-review context handoff. Context freshness, documentation links and diff checks passed after reconciliation.","prevention":"Re-pin and re-review a changed remote head; preserve concurrent commits and use an expected head when merging the PR."}
```

## October 22 staging activation verification

```json
{"id": "OBS-20261022-STAGING-AUDIT-001", "status": "resolved", "area": "hosted-verification-tooling", "observation": "Attaching an old Supabase SQL tab timed out during browser focus setup. A first local migration read also used a nonexistent singular filename; one documentation patch failed its ledger context check before applying.", "cause": "The existing SQL browser tab could not be attached; its underlying browser cause was not established. Local reads/patch context did not match the actual repository paths/text.", "prevention": "Open a fresh tab in the same authorized browser for a stale tab, inspect actual migration paths, and verify file context before applying a patch. Do not infer a provider outage or alter database permissions from a browser attachment failure.", "regression": "A fresh SQL tab completed a read-only transaction: all eleven catalog/permission assertions passed and eight raw/four deduplicated events remained. Corrected paths/patch context were used; pnpm check passed; a trailing blank line introduced in this ledger was removed before the final diff check."}
```

```json
{"kind": "resolution", "references": {"id": "OBS-20261021-GITHUB-ENV-001"}, "status": "resolved", "cause": "Vivien configured the protected staging environment and credentials after the earlier administrator-access block.", "regression": "Run 39907285014 completed after an eligible separate reviewer approved it. Both hosted analytics GET endpoints returned 200 for hemu77; no secret value was published.", "remaining": "Valid non-collaborator and controlled collaborator-removal hosted 403 checks remain deferred; this resolution does not mark full hosted acceptance complete."}
```

## October 23 hosted denial verification tooling

```json
{"id":"OBS-20261023-TEAM-CHECK-001","status":"resolved","area":"acceptance-tooling","observation":"An ad hoc local credential-input script supplied no completed identity or HTTP evidence. Its source is not in this repository, so its waiting state and underlying cause were not diagnosed.","prevention":"Use the repository-owned Node command with an expected GitHub login, private GitHub CLI credential lookup, visible steps and bounded requests. Never treat a hidden input prompt, invalid-token 401 or successful collaborator access as proof of outsider denial.","regression":"Ten focused tests pass, including timeout, wrong identity, 401/503/redirect, unexpected access and secret-redaction cases. A live collaborator control returned GitHub 200 and Worker 200/200 and correctly exited nonzero without reading analytics bodies.","remaining":"Valid non-collaborator 403/403 and controlled collaborator-removal hosted acceptance remain pending.","sources":["scripts/verify-team-access.mjs","scripts/verify-team-access.test.mjs","docs/team-data-access.md"]}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-24T05:35:02.469Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-24T05:35:02.469Z"},"status":"resolved","cause":"The first analytics context update exceeded the existing 1000-character summary limit.","prevention":"Keep module summaries bounded and put detailed verification in the handoff and linked runbook.","regression":"Shortened the summary, refreshed fingerprints, and reran pnpm check; context now validates nine modules and ten handoffs."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-24T17:29:37.191Z","exitCode":1}
```

## October 24 staging observation infrastructure

```json
{"id":"OBS-20261024-QUEUE-PROBE-001","status":"resolved","area":"hosted-infrastructure-verification","observation":"The first synthetic HTTP-pull probe received 409 after the resume request completed: the delivery plane still reported that the Queue was paused. Cleanup re-paused both Queues and retained the unacknowledged synthetic retry message.","cause":"Queue resume control-plane completion did not immediately establish delivery-plane readiness.","prevention":"Use bounded retries only for the explicit paused-delivery propagation response after an authorized resume; do not suppress other HTTP failures or infer readiness from settings alone. Always re-pause in cleanup and never purge unrelated work.","regression":"Recovered the exact synthetic retry through the configured DLQ, then a fresh complete hosted run passed archive/readback before ACK and attempts 0,1,2,3 followed by DLQ arrival. Both Queues read back empty and paused. See docs/observation-infrastructure.md for UTC evidence.","sources":["docs/observation-infrastructure.md","backend/wrangler.jsonc"]}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-24T17:29:37.191Z"},"status":"resolved","cause":"The staging binding configuration changed fingerprinted backend inputs before the context update was finished.","prevention":"Update affected node summaries and paths, then refresh fingerprints before the final check.","regression":"Updated backend/delivery summaries, added the infrastructure handoff and ran pnpm context:refresh; final verification is recorded in the PR."}
```

```json
{"id":"OBS-20261024-INFRA-TOOLING-001","status":"resolved","area":"operator-tooling","observation":"Initial account-wide R2 inventory could not choose between two authorized accounts; a CORS read returned the documented no-configuration 404. A local probe syntax check, one atomic documentation patch and an intermediate scan-draft schema submission also rejected invalid local input before completion.","cause":"Account selection must be explicit for these commands; no CORS configuration is represented by provider error 10059. Local tooling input did not match its file/API schema.","prevention":"Pin the intended non-secret account, distinguish the exact no-CORS response from other errors, syntax-check probes before execution, inspect patch context and use documented scan fields. Never print credential-bearing subprocess output.","regression":"Corrected account-specific inventory, private-bucket readback, real R2/Queue probes and scan checkpoint succeeded. No token, raw analytics payload or private conversation was retained."}
```

## OBS-20261022-VIS02-DRAFT-PREPARATION

- Observation: the imported processing source has whitespace-only blank lines that
  fail the default `git diff --check`; the user source style is retained for this
  draft. This is a known review-preparation limitation, not a runtime test result.
- Observation: the first offline package build could not create a temporary lock
  in the read-only user uv cache. Repeating with a task-local writable cache
  built both wheel and source distribution successfully.
- Evidence: `uv --cache-dir /tmp/peeka-uv-cache build --offline --project
  /tmp/peeka-vis02-review/processing --out-dir /tmp/peeka-vis02-dist` passed.
  The isolated current processing suite passed all 82 tests with mocked providers.
- Scope: no provider calls, application behavior change or performance refinement.

## OBS-20261023-VIS02-REVIEW-CORRECTIONS

- Cause: document iteration loaded each page before the per-page try block.
  A failing synthetic middle-page load aborted extraction before the later page.
- Correction: iterate bounded page indices and load inside the existing guard;
  the regression now preserves ready/failed/ready segments and exact identities.
- Test portability: cache hit/retry checks remain unconditional; mode 0600 is
  asserted only on POSIX, without claiming verified Windows ACL privacy.
- Test scheduling: SDK cancellation waits for mocked HTTP start; existing
  wall-clock deadline tests cover timeout rejection and sibling-batch retention.
- Cleanup: removed only the 18 imported whitespace-only lines flagged in review.
  Reconciled current develop documentation and refreshed affected fingerprints.
- No live provider calls or latency refinements were made for these corrections.

- Packaging check: an existing ignored source-directory .env was included by the build backend. Added explicit source exclusions (also applied to wheels), retained the local env, and rebuilt the distributions for archive inspection. No artifacts were uploaded.

## OBS-20261023-VIS02-LIVE-PDF

Fresh OCR acquired all35pages in268.779s without old cache reuse. Allfour default LLM batches hit90s deadlines; a one-page/concurrency2 follow-up reused the fresh OCR and retained161 needs_review drafts in549.035s. Four pages timed out and six unsupported names were rejected; result remains incomplete. Source spans verified, field accuracy and acceptance pending. Defaults were not changed. See docs/ocr-delivery.md and test-data/README.md.

## OBS-20261023-VIS02-CI-FORMAT

Hosted run39931137291 failed biome formatting in scripts/processing-handoff.test.mjs; browser/database and docs/context/PR checks passed. Applied only the requested call/destructuring wraps. The same run showed account cache egress quota exhaustion and a roughly10minute setup delay; removed optional pnpm cache restore while preserving frozen installs and all checks. Node24.16.0/pnpm11.25.0 are available in temporary local tooling for native verification.

Native verification: biome/typecheck/context/docs passed using pinned Node24.16.0/pnpm11.25.0. All56 Vitest cases and23 repository-script tests passed with bounded workers. One initial script-test invocation lacked the pnpm executable on PATH; rerunning in the installed pnpm environment passed without a source change.

## OBS-20261024-VIS02-OCR-PROVENANCE

An injected provider returning Engine 2 settings was accepted as complete while
segment/report labels claimed Engine 3, for both image and PDF input. The new
regressions reproduced this before the fix. Both callers now validate the
current Engine-3-compatible response contract before accepting text; incompatible
or missing settings fail the segment while native sibling pages survive.
The 89-test Python suite passes with mocked providers; no live calls were made.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-10-24T06:28:20.278Z","exitCode":1}
```

Local verification initially lacked the cached pnpm launcher on PATH; native
commands were rerun with that directory included. A main-checkout package-manager
autostart was avoided by running its dependency-free context/link scripts directly.
The first archive inspection also attempted to read uv's non-archive metadata;
restricting inspection to wheel/sdist files passed. These were local command
setup issues; no dependency, runtime or environment configuration was changed.

The current develop branch advanced to 5da1642 before publication. GitHub blocked
pull-request CI on shared context/error-ledger conflicts. Reconciled those files
by preserving develop nodes/records and retaining this processing node/handoff;
processing sources were unchanged. Repeated 89 Python tests and native quality,
context and documentation checks passed on the reconciled tree.

## OBS-20261024-VIS02-SHARED-DOC-MERGE

Current develop 245b780 conflicted with the VIS-02 branch in shared context and
error records. Retained develop module descriptions and recent infrastructure/
team-access handoffs, the processing node and both appended error histories.
Only the older design-link-only handoff was retired within the ten-entry cap.
Processing files are unchanged from reviewed 0e3f204. The 89 Python tests, four
context/Unicode script tests, context freshness and local documentation links
passed. PR #23 remains separate; reconcile its merged result and rerun CI before
the final integrated approval in the agreed #23 -> #24 -> #25 order.

## OBS-20261024-DB-TCP-READINESS

Develop run [40146434333](https://github.com/vivienk/peekaplate/actions/runs/40146434333)
passed 73 SQL assertions and 20 Worker/Postgres cases, then failed the separate
local-development smoke test while installing its fresh database schema:
`connect: connection refused`. The aggregate `ci` failure followed that database
failure; quality and browser checks passed.

The hostless readiness command could accept PostgreSQL's temporary Unix-socket
bootstrap server before the TCP listener used by dbmate existed. The installed
official image entrypoint starts that temporary server with `listen_addresses=''`.
The shared probe now explicitly checks `127.0.0.1:5432`; its existing bounded wait
and immediate migration-error handling remain intact.

Regression: `node --test scripts/test-db.test.mjs` reproduced the same migration
connection refusal when socket readiness preceded TCP, then passed all six tests
after the correction. `pnpm verify test:db` passed the 73 SQL assertions, 20 real
integration cases and the fresh local startup/demo/cleanup path. This changes
disposable local/CI startup only, without a hosted database or application change.

## October 24 DATA-01 endpoint local verification

```json
{"id":"OBS-20261024-DATA01-LOOPBACK-001","status":"environment_blocked","area":"local-test-runtime","observation":"The broader backend/contracts Vitest run passed 43 tests but 12 existing auth tests could not reach their ephemeral 127.0.0.1 JWKS fixture; every failure was EACCES and surfaced as AuthUnavailableError.","cause":"This sandbox blocks the test process from connecting to its loopback JWKS server; the failures are outside the DATA-01 diff and do not establish an auth regression.","prevention":"Run the full suite in CI or a local environment that permits bounded loopback test servers; keep focused contract/endpoint/menu-token tests independent of network fixtures.","regression":"Focused DATA-01 tests passed 29/29, contracts and backend typechecks passed, and the scoped Biome check passed. The full auth suite remains environment-blocked here."}
```
```json
{"kind":"resolution","references":{"id":"OBS-20261024-DATA01-LOOPBACK-001"},"status":"resolved_for_scoped_change","regression":"After privacy-safe conflict evidence and shared Queue contract fixes, focused DATA-01 tests pass 31/31; contracts/backend typechecks and scoped Biome checks pass. The unrelated loopback JWKS restriction remains an environment limit for the broader auth suite."}
```
```json
{"kind":"verification-update","references":{"id":"OBS-20261024-DATA01-LOOPBACK-001"},"result":"Focused DATA-01 tests now pass 32/32 after adding raw-in-memory checksum conflict detection for two invalid same-metadata copies; no raw rejected field is placed in the Queue contract. Contracts/backend typechecks remain green."}
```
```json
{"kind":"verification-update","references":{"id":"OBS-20261024-DATA01-LOOPBACK-001"},"result":"Focused DATA-01 tests pass 33/33 after replacing recursive canonical JSON with an explicit-stack implementation and adding a 12,000-level invalid JSON regression. Contracts/backend typechecks and scoped Biome checks pass."}
```

## October 25 DATA-01 verification tooling and rate-limit boundary

```json
{"id":"OBS-20261025-DATA01-TOOLS-001","sources":["backend/src/index.test.ts","packages/contracts/src/index.test.ts"],"observation":"The sandboxed pnpm workspace registration and default linker could not create Windows symlinks, and the first Vitest run could not rename its transform cache under the sandbox temp directory.","prevention":"Use a repository-local pnpm store with the hoisted linker, provide the backend package a generated local copy of the workspace contract package when workspace symlinks are unavailable, and point TEMP/TMP at a repository-local ignored directory.","status":"resolved","regression":"Direct repository binaries ran the focused contracts, endpoint and menu-token suites: 50/50 passed. Both TypeScript projects and scoped Biome passed.","area":"local-test-runtime"}
```

```json
{"id":"OBS-20261025-DATA01-RATELIMIT-001","followup":"Review whether approximate per-location protection is acceptable for the staging pilot. If strict cross-location enforcement is required, approve and design a per-jti Durable Object limiter before activation.","observation":"Cloudflare Workers Rate Limiting bindings support only 10- or 60-second approximate per-location windows. They are permissive and eventually consistent, so 60/60 plus 10/10 bindings keyed by verified token jti do not prove a strict global token bucket with burst capacity 10.","sources":["backend/src/index.ts","backend/src/index.test.ts","backend/wrangler.jsonc"],"status":"open","regression":"Local dependency tests verify both bindings receive only the verified jti and return bounded Retry-After values. Hosted behavior is not yet tested.","area":"observation-rate-limit"}
```

## ERR-20261025-PREVIEW-001 · Local verification prerequisites

Initial sandboxed dependency installation could not resolve the package registry; retried with network permission. Read-only Cloudflare inventory failed first on the Python certificate store and then on the system TLS transport. No TLS verification was disabled; no provider write was attempted. These failures do not establish missing cloud projects or invalid GitHub-held credentials.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-25T18:21:05.288Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"docs:check","timestamp":"2026-10-25T18:21:14.241Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-25T18:21:38.931Z","exitCode":1}
```

### Preview verification follow-up

The sandbox blocked the authentication test HTTP listener; rerunning with local network permission passed all 189 Vitest cases. Renaming the workflow left a stale team-guide link, which failed docs:check and its verification-runner regression. Updated that link; rerun required before publishing. Wrangler dry-run built successfully but could not write its external log under sandbox permissions.

### Preview verification resolution

PASS after correction: `pnpm check` (189 unit cases and 47 script cases), actionlint, both exact PR #37 frontend builds and static sanitizer. An offline PR #37 install lacked cached package-policy metadata; the subsequent normal install verified the unchanged frozen lockfile and both builds passed. The stale-link regression and sandbox listener failures are resolved for this validation run; Cloudflare connectivity remains unverified.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-26T19:14:22.047Z","exitCode":1}
```

Resolution: all 212 Vitest assertions passed with four optional skips, and 46 of 47 repository script tests passed. The sole failure is the known Windows sandbox denial when the regression itself attempts to create a symlink; rerunning `node --test --test-skip-pattern="rejects artifact symlinks" scripts/preview.test.mjs` passed the remaining 12 preview tests. Linux CI remains the required evidence for the symlink case.
# ERR-20261026-PREVIEW-REPAIR

PR #41 merged successfully into develop, but automatic previews did not run:
GitHub now reads pull_request_target workflow code and github.sha from the
default branch, which still lacked the workflow and helper. Repository readback
showed the enable variable true; a variable cannot supply missing trusted code.
The follow-up promotes only preview orchestration to main and corrects the
activation guide. GitHub-held token/lifecycle acceptance remains separate.

`node --test scripts/preview.test.mjs` also reproduced 12 passes and one Windows
EPERM while creating a file symlink to `/etc/passwd`; this failed before the
sanitizer was exercised. The fixture now uses a real Windows directory junction
or a directory symlink elsewhere. All rejection assertions remain enabled.

A new exact-commit marker regression failed with ENOENT before implementation.
Sanitization now generates the marker from a checked SHA, rejects supplied
markers and verifies both deployed aliases against that SHA before announcing
readiness. Focused tests reject a stale HTTP 200 marker and pass the matching
commit; provider writes are not part of these local tests.
## ERR-20261026-PREVIEW-REPAIR · Hosted resolution

Maintainer-authorized PR47 main merge ab6f9c4 registered the trusted workflow.
Actual GitHub run 40393096652 uploaded the exact synthetic PR48 head, verified
both SHA markers and posted one bot comment. Close cleanup 40393553935 removed
both provider deployments and changed that comment to removed. Edge readback
briefly returned 500 after deletion; subsequent bounded readback confirmed
both aliases and markers 404 at 2026-10-26T20:13:56Z. Provider deletion success
alone does not establish instantaneous edge retirement. Staging deployment
IDs and app data were unchanged; detailed evidence is in docs/previews.md.
## October 27 VIS-01 infrastructure validation

```json
{"id":"OBS-20261027-VIS01-QUEUE-CREATE","status":"resolved","area":"operator-resource-provisioning","observation":"Initial Queue create request containing delivery_paused returned HTTP 500/code 10013; exact-name readback confirmed no resource was created.","cause":"The installed Wrangler creation path uses retention settings followed by a separate queue-name/paused PATCH; the provider did not accept the initial request shape in this run. A provider root cause was not established.","prevention":"Follow the installed CLI request contract. Read back exact names after an error before retrying; create with no producers, pause immediately, then attach the controlled consumer. Never repeat a create blindly.","regression":"The corrected sequence provisioned exactly two menu queues. Real source/R2/readback/retry-to-DLQ and cleanup passed; both empty/paused and observation settings unchanged.","sources":["backend/wrangler.jsonc","scripts/menu-ingestion-infra.test.mjs","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"OBS-20261027-EXTRACTION-HOST-ACCESS","status":"open","area":"staging-service-activation","observation":"Installed Wrangler containers list stopped before inventory because containers:write is absent from the current OAuth login. Cloudflare host dry-run, Docker build and local HTTP boundary checks are separate evidence.","prevention":"Keep the new host inactive until scoped Container deployment access is authorized. Preserve current Worker/Pages scopes; never request every default scope or infer service readiness from packaging.","sources":["backend/wrangler.extraction.jsonc","docs/menu-ingestion-infrastructure.md"],"resolutionRequired":"Authorize the required scoped deployment access, configure provider/service secrets, deploy the reviewed host and record genuine service/source/extraction acceptance."}
```

```json
{"id":"ERR-20261027-CONTEXT-SUMMARY","status":"resolved","area":"context-validation","cause":"Appending service details exceeded the existing context node summary bound; refresh rejected the graph before writing fingerprints.","prevention":"Keep node summaries concise and link detailed runbooks instead of accumulating prose.","regression":"Backend summary condensed without dropping authority/readiness boundaries; context refresh and check required before commit.","sources":["docs/CONTEXT.md","scripts/context.mjs"]}
```

```json
{"id":"ERR-20261027-EXTRACTION-DRYRUN-OUTPUT","status":"resolved","area":"local-verification-artifacts","cause":"A dry-run output directory outside the existing ignored dist path was included by the lint scan.","prevention":"Write operator probe/build outputs outside the checkout or into its established ignored dist path; never format generated bundles to satisfy source lint.","regression":"Moved only the generated evidence directory to the task output folder; final pnpm check must pass on source files.","sources":["docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"ERR-20261027-EXTRACTION-COMPAT-DATE","status":"resolved","area":"local-worker-runtime","cause":"The pinned local Wrangler binary supports compatibility dates through October 13; a new October 27 test configuration could not start.","prevention":"Keep this existing project's new Worker on the already tested compatibility date until a separately verified runtime upgrade.","regression":"Actual hosting Worker source/auth routes with remote private R2 passed on the matching October 13 date, including exact cleanup.","sources":["backend/wrangler.extraction.jsonc","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"ERR-20261027-EXTRACTION-PARTIAL-EXIT","status":"resolved","area":"python-service-result-handling","cause":"The new service used check=True even though the existing CLI writes valid partial/failed reports and returns exit 2; reviewable partial drafts became HTTP 502.","prevention":"Distinguish expected result exit statuses from execution failure and still validate the bounded output report.","regression":"A real child writes an incomplete needs-review report and exits 2; the regression failed with 502 before the fix and passes with 200/preserved drafts afterward.","sources":["processing/src/peekaplate_processing/service.py","processing/tests/test_service.py","processing/src/peekaplate_processing/run_pipeline.py"]}
```

```json
{"id":"ERR-20261027-EXTRACTION-SOURCE-AUTHORITY","status":"resolved","area":"private-source-authorization","cause":"The new source relay initially treated a global service bearer as authorization for caller-selected tenant/job paths, including other jobs.","prevention":"Require a short-lived signed tenant/job/hash capability minted only after backend job authorization. Keep its signing key separate from the service identity and out of Python.","regression":"Valid service identity plus job-A grant requesting job B returned 200 before the fix; focused tests and actual Worker/remote-R2 probes now deny with 403 before source access. Expired/tampered grants and digest mismatch are rejected.","sources":["backend/src/extraction-capability.ts","backend/src/extraction-host.ts","backend/src/extraction-host.test.ts","processing/src/peekaplate_processing/service.py"]}
```

```json
{"kind":"resolution","references":{"id":"OBS-20261027-EXTRACTION-HOST-ACCESS"},"status":"resolved","evidence":"Scoped Wrangler login successfully added containers:write while retaining existing Worker/Pages scopes; credentials remain in the encrypted OS-backed store. No default-scope expansion or subscription change."}
```

```json
{"id":"OBS-20261027-CONTAINER-ELIGIBILITY","status":"open","area":"hosted-extraction-activation","observation":"Explicit staging account Container inventory returns HTTP 401 eligibility denial saying Workers Paid is required; workers-standard reports true and subscription readback is 403. Wrangler also asserts after printing the provider denial on Windows; direct API readback confirms the provider error independently.","cause":"Account entitlement/member-role eligibility is not resolved; the available evidence does not establish that the paid plan is missing.","prevention":"Have the account owner verify existing Container entitlement and member access. Do not purchase a duplicate plan or broaden permissions blindly.","resolutionRequired":"Verify eligibility on the existing account, then deploy/test the reviewed host with protected service/provider credentials.","sources":["backend/wrangler.extraction.jsonc","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"kind":"clarification","references":{"id":"OBS-20261027-CONTAINER-ELIGIBILITY"},"status":"pending-external-activation","cause":"The account is on Free; Vivien will activate Workers Paid. The standard flag alone was not billing proof.","next":"Keep the prepared Cloudflare host unchanged. After the owner activates the $5 plan, verify eligibility and configure/deploy the reviewed service; no upgrade was purchased by this task."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-27T19:21:00.026Z","exitCode":1}
```

```json
{"kind":"deployment-followup","references":{"id":"OBS-20261027-CONTAINER-ELIGIBILITY"},"timestamp":"2026-10-27T20:25:05.885Z","status":"pending-external-activation","observation":"Actual deploy of main58838e1 uploaded a partial extraction Worker, then failed at /containers/me with HTTP401 requiring Workers Paid. workers.dev remains disabled and health/extract return404; settings readback returned provider500. Protected API run40577213391 awaits independent approval; existing API health200 at prior version.","next":"Owner activates planned Paid subscription, then retry the same Worker name and verify service configuration. Independently approve existing API run and verify its new aliases. Local integration can continue; do not enable real submissions before full acceptance.","sources":["backend/wrangler.extraction.jsonc","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"OBS-20261027-DOCKER-START","status":"resolved","area":"local-deployment","observation":"Wrangler could not launch the Docker engine; the desktop-linux named pipe was absent.","cause":"Docker Desktop daemon was stopped.","resolution":"Started the existing Docker Desktop installation; docker info returned29.8.2 and the image build/upload completed. No daemon reset or data/cache deletion.","sources":["processing/Dockerfile"]}
```

```json
{"id":"OBS-20261027-CONTAINER-SCHEDULER","status":"fixed-locally","area":"hosted-extraction-activation","observation":"After Paid entitlement succeeded, application creation failed VALIDATE_INPUT because this account cannot use default scheduling_policy.","cause":"Default was implicit, and the older Container helper does not support the provider-required durable_object policy.","resolution":"Use direct DurableObject startup, images.base, supported standard-1 size and native inactivity timeout. Keep service/source-grant checks unchanged. New configuration guard failed before the repair and passes afterward; lifecycle regressions cover readiness, concurrency and recovery. Hosted verification follows reviewed main release.","sources":["backend/wrangler.extraction.jsonc","backend/src/extraction-host.ts","backend/src/extraction-host.test.ts","scripts/menu-ingestion-infra.test.mjs"]}
```

```json
{"kind":"resolution","references":{"id":"OBS-20261027-CONTAINER-ELIGIBILITY"},"status":"resolved","evidence":"Paid entitlement succeeds and the existing extraction host is deployed. No subscription was purchased by the operator."}
```

```json
{"kind":"resolution","references":{"id":"OBS-20261027-CONTAINER-SCHEDULER"},"status":"resolved","evidence":"PR60 main7bbe0d3 deployed successfully under durable_object scheduling. Authenticated hosted Python health200, job/source denials and signed private source/hash checks passed."}
```

```json
{"id":"OBS-20261027-REMOTE-R2-PROOF","status":"resolved","observation":"A local test writer reported201 but the independently deployed source reader returned404.","cause":"The helper used unstable_dev local:true with experimental.forceLocal:true; its remote R2 flag did not establish a provider write.","resolution":"Changed helper to actual remote mode and repeated service/source and Queue/R2 tests. Hosted source read200, Python relay checks, real conditional-create race and cleanup/absence verification passed. Corrected the earlier R2 evidence claims and retained the failed run separately outside the repo.","sources":["docs/menu-ingestion-infrastructure.md","docs/operations.md"]}
```

## ERR-20261028-MAIN-DEVELOP-TYPES

The first combined `pnpm verify typecheck` failed after importing main's Worker
runtime declarations into develop: `TextDecoderConstructorOptions` required an
explicit `ignoreBOM`, and Node's `fileURLToPath` rejected a Worker-global URL in
the retrieval runtime test. This was a branch-integration type mismatch, not a
failed hosted request or database change.

Preserved the existing decoder behavior with `ignoreBOM: false` and imported
Node's URL explicitly in the Node test, matching the existing dish integration
fix. The same typecheck then passed. Full retrieval/workerd and repository
regression results belong to the sync PR. Do not suppress strict types or drop
develop's retrieval implementation to make a release merge compile.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-10-28T18:20:27.547Z","exitCode":2}
```
