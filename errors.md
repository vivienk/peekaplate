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
```

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

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-22T00:13:01.752Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-10-22T00:13:01.752Z"},"status":"resolved","cause":"The new shared-token CSS imports used single quotes; the repository Biome formatter requires double quotes in CSS.","prevention":"Run pnpm format or biome check --write on new CSS before verification.","regression":"Formatted both app imports and updated the token test's import assertion; pnpm check passed afterward."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-22T00:13:19.319Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-22T00:13:19.319Z"},"status":"resolved","cause":"The token test was edited after the context fingerprints were refreshed, so the tokens node was correctly reported stale.","prevention":"Refresh context fingerprints after the last source edit, then rerun pnpm check.","regression":"pnpm context:refresh followed by pnpm check passed."}
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
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-26T01:20:35.736Z","exitCode":1}
```

```json
{"id":"OBS-20261025-RES02-DB-001","status":"open","area":"local-database-verification","observation":"The RES-02 disposable database lane did not start. Docker build first lacked access to its Buildx lock; after granting that narrow local permission, Docker Desktop exited without starting the Linux engine and the named pipe remained absent.","prevention":"Confirm docker version reaches the server before starting the recorded database lane. Do not weaken or replace the real PostgreSQL/Worker tests with mocks.","resolutionRequired":"Start the existing Docker Desktop Linux engine, then run pnpm verify test:db to exercise the migration, RLS, atomic commands, idempotency and concurrent publication cases. Current unit/type results do not establish database readiness."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-26T02:01:23.539Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"test:db","timestamp":"2026-10-26T02:01:23.539Z"},"status":"resolved","cause":"The first user-run verification launched pnpm by absolute JavaScript path, but the verification child expected pnpm.cmd on PATH and exited before database tests.","prevention":"For the bundled Windows runtime, prepend its fallback command and Node directories to the current PowerShell PATH before invoking pnpm verify.","regression":"With the bundled fallback and Node directories on PATH, pnpm verify test:db completed with exit code 0."}
```

```json
{"kind":"resolution","resolves":"OBS-20261025-RES02-DB-001","status":"resolved","evidence":"After the user started Docker Desktop and ran the repository verification outside the restricted named-pipe sandbox, pnpm verify test:db exited 0. It passed 92 pgTAP assertions, 25 real Worker/PostgreSQL integration tests, and the fresh local startup/demo/cleanup path.","limit":"This is disposable local evidence, not hosted deployment or upstream review-subject producer acceptance."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-26T02:19:34.003Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-26T02:19:51.505Z","exitCode":1}
```

## OBS-20261025-RES02-DEVELOP-MERGE-WINDOWS

The post-merge pnpm check passed Biome, every workspace TypeScript check and all 201 Vitest cases (four optional cases skipped). Its repository-script phase passed 46 tests and failed only while the newly merged preview regression tried to create a Windows symlink inside the sandbox (EPERM); the earlier temp-directory rename restriction was avoided by moving TEMP and TMP into the writable worktree. Running the preview suite with only that privilege-dependent case skipped passed its remaining 12 tests. Context freshness, the ten-handoff limit, documentation links and git diff --check pass. No RES-02 runtime, contract, migration or database file conflicted with develop. Linux CI must run the symlink regression before merge; this local limitation is not a passing result for that case.
<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-26T02:41:52.223Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-26T02:42:49.867Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-26T02:43:12.943Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-26T02:43:53.184Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-26T02:46:45.419Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-26T02:46:53.142Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-26T02:47:10.475Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-26T02:48:41.090Z","exitCode":1}
```

## OBS-20261025-RES02-PUBLIC-MENU-LOCAL

The PR B implementation checks initially recorded transient lint failures while the route and dependency object were still being patched. The completed working tree passes Biome and all workspace TypeScript checks. Redirecting TEMP and TMP into the writable worktree avoids the sandbox rename restriction; all 209 Vitest cases pass with four optional cases skipped. The repository script suite passes 46 cases and cannot run only its Windows symlink-creation regression under the sandbox; Linux CI remains the required evidence for that case.

The first PR B disposable-database attempts did not reach PostgreSQL. Docker Buildx first could not create its user-state lock, and after that narrow permission was granted the sandbox still denied the Docker Desktop Linux named pipe. This is an environment limitation, not a passing database result. Run `pnpm verify test:db` outside the restricted sandbox before publishing PR B; it must prove the new migration, four pgTAP privilege/RLS assertions, anonymous published read, token claims and withdrawal-to-404 integration.

The contracts/backend/database fingerprints were stale after the intentional source changes. Their summaries and paths were reviewed, `pnpm context:refresh` updated the fingerprints, and `pnpm verify context:check docs:check` passed.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-26T02:57:46.694Z","exitCode":1}
```

### PR B review correction

The first unrestricted Docker run on `5bcd86e` passed 96 pgTAP assertions in total (39 staff assertions) and all 26 Worker/PostgreSQL integration tests. That evidence proved the migration, restricted-role read, token claims and withdrawal behavior for the original signing implementation, but it became superseded when independent architecture review found that its HS256/fixed-issuer tokens were incompatible with DATA-01's remote-JWKS RS256/ES256 verifier.

The producer contract now uses a URL issuer, ES256 private JWK from protected configuration, a public-only JWKS endpoint, `kid`, the shared observations audience and the same 30-minute claims boundary. The integration test verifies an issued token through a remote JWKS with DATA-01's algorithm/issuer model. The corrected local unit suite passes 210 cases with four optional skips. A second unrestricted database run is required for the corrected head.

Correctness review also found two blank lines at the end of the forward migration. They were removed; `git diff --check` passes on the corrected working tree.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-10-26T02:59:35.504Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-26T02:59:44.456Z","exitCode":1}
```

The follow-up architecture review found that a URL issuer with a non-root path would make DATA-01 discover JWKS at a path the Worker did not expose. The signing configuration now accepts only an origin/root pathname, and the remote-JWKS integration fixture uses that root discovery path. This matches the documented production contract that `MENU_TOKEN_ISSUER` is the Worker origin.

The first ES256/JWKS database rerun reached all assertions: 96 pgTAP checks and 25 of 26 integration cases passed. The token case failed only because its expected issuer omitted the trailing slash produced when both RES-02 and DATA-01 normalize an origin through `URL.href`. The regression expectation now uses that same normalized origin; signature verification, JWKS discovery and the remaining database behavior did not fail.

Correctness follow-up required a direct regression for the origin-only issuer invariant. The unit suite now rejects `https://api.example.test/menu` explicitly, alongside the existing insecure-protocol and incompatible-key cases.

The final unrestricted Docker rerun on the corrected ES256/JWKS candidate passed all 96 pgTAP assertions (foundation 27, PostHog 15, staff 39 and team analytics 15) and all 26 Worker/PostgreSQL integration tests. This supersedes the earlier issuer-expectation failure and confirms the normalized trailing-slash issuer, remote JWKS verification, publication binding and withdrawal behavior together. The logged `command_failed` entry is the expected injected outbox-failure case whose assertions passed.

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

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-27T11:12:33.369Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-27T11:12:53.304Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-10-27T11:14:04.370Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-27T19:54:53.626Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-10-27T19:54:53.626Z"},"status":"resolved","cause":"Color-role palette test edits introduced a Biome formatting violation (misaligned array element).","prevention":"Run pnpm format (biome check --write) on changed files before verification.","regression":"Biome formatting check passes; pnpm lint exits 0."}
```

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
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-10-27T19:55:28.261Z","exitCode":2}
```

```json
{"kind":"resolution","references":{"check":"typecheck","timestamp":"2026-10-27T19:55:28.261Z"},"status":"resolved","cause":"The color-role palette test used unsafe regex match destructuring (`[, ref]`) whose captured groups could be undefined under noUncheckedIndexedAccess.","prevention":"Parse regex matches through a typed helper that validates each capture before use.","regression":"pnpm typecheck passes; tokens suite passes."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-27T20:04:00.236Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-27T20:04:00.236Z"},"status":"resolved","cause":"Token test edits landed after the module fingerprint was refreshed, so the tokens node was correctly reported stale.","prevention":"Refresh context fingerprints after the last source edit, then rerun pnpm check.","regression":"pnpm context:refresh followed by pnpm check passed."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-28T13:15:19.972Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-28T13:20:26.669Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-10-28T13:15:19.972Z"},"status":"resolved","cause":"Biome formatting in packages/tokens/src/tokens.test.ts after inserting the light-theme test-block extraction; two lines had insufficient indentation.","prevention":"Run biome format on edited files before verification.","regression":"pnpm check PASS (lint, typecheck, 14 files/202 tests + 4 skipped, context:check, docs:check)."}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-28T13:20:26.669Z"},"status":"resolved","cause":"Tokens module fingerprint stale after tokens.css and tokens.test.ts edits; refreshed context.","prevention":"Run pnpm context:refresh after source changes and review the diff.","regression":"pnpm context:check PASS (12 modules, 10 handoffs)."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-28T16:45:03.171Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-28T16:45:03.171Z"},"status":"resolved","cause":"Tokens module fingerprint stale after tokens.css and tokens.test.ts edits; refreshed context.","prevention":"Run pnpm context:refresh after source changes and review the diff.","regression":"pnpm context:check PASS (12 modules, 10 handoffs)."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-28T17:18:55.326Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-10-28T17:18:55.326Z"},"status":"resolved","cause":"Biome formatting in frontend/console/src/ui/Nav.tsx and components.test.tsx after adding aria-hidden and test file.","prevention":"Run biome format on edited files before verification.","regression":"pnpm check PASS (lint, typecheck, 15 files/216 tests + 4 skipped, context:check, docs:check)."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-27T19:21:00.026Z","exitCode":1}
```

## VIS-02 / RES-01.1 follow-up prevention records

These records summarize development regressions imported with the producer/export
follow-up. Historical private runs and their source data are not published here;
the PR records verification of the reconciled canonical tree separately.

```json
{"id":"OBS-VIS02-PRODUCER-GROUNDING-001","status":"resolved","area":"processing-grounding","observation":"Failing synthetic regressions reproduced cross-entry scalar/slash price borrowing, truncated options, calorie values treated as prices, numeric dish names used as prices, conflicting section inheritance and destructive duplicate collapse through unknown values.","correction":"Preserve source text and complete printed options; use bounded entry text or unique source-supported OCR geometry, exclude all heading/name spans and abstain on competing entries. Require exactly one source occurrence independently of price-eligible heading parsing, retain genuine unpriced repeats and require group-wide compatibility of raw non-null fields before deduplication.","regression":"test_menu_context.py, test_menu_layout.py, test_menu_duplicates.py and the pipeline-to-export geometry case cover the imported fail-first reproductions, including joined title/description boxes, explicit image-alt caption proof and three-way null bridges. These tests are not whole-menu accuracy acceptance.","sources":["processing/src/peekaplate_processing/menu_context.py","processing/src/peekaplate_processing/menu_layout.py","processing/src/peekaplate_processing/workflow.py","processing/tests/test_menu_context.py","processing/tests/test_menu_layout.py","processing/tests/test_menu_duplicates.py","processing/tests/test_pipeline_timing.py"]}
```

```json
{"id":"OBS-RES01-EXPORT-CONTRACT-001","status":"resolved","area":"review-candidate-contract","observation":"Development regressions exposed mixed schema/pipeline versions, populated hierarchy fields under the old version, invalid heading-page references, blank provenance references and timezone-free dates accepted by only one implementation.","correction":"Support only paired schema1/pipeline2 and schema2/pipeline3; preserve original IDs and fields, exact ordered code-point spans, known zero, printed options and partial failures. Require ready/error-free nonblank heading pages and reject invalid joins/snapshots before writing a new export.","regression":"Shared labeled synthetic v1/v2 fixtures and Python/TypeScript negative cases cover preservation, version rejection, missing/failed/skipped/error-bearing heading pages, Unicode offsets, invalid extraction and create-only export. Live adapter/save/reload and human acceptance remain separate.","sources":["processing/src/peekaplate_processing/review_candidates.py","processing/tests/test_review_candidates.py","packages/contracts/src/review-candidates.ts","packages/contracts/src/review-candidates.test.ts","processing/tests/fixtures/review-candidates/README.md"]}
```

```json
{"id":"OBS-VIS02-PR-DEFAULTS-001","status":"resolved","area":"processing-scope","observation":"During canonical reconciliation, three intentional fail-first assertions caught private experiment defaults and provider-specific reasoning tuning entering the candidate import: API/CLI batch settings were2/2 instead of develop's10/1 and the model effort waslow instead of unspecified.","correction":"Exclude the experimental provider tuning and preserve canonical API/CLI defaults and help. Retain smaller-batch/concurrency flags as explicit opt-ins and passive timing/no-cache controls without changing the default provider behavior.","regression":"Socket-blocked test_pipeline_timing.py failed in these three tests before reconciliation and passed all9 tests afterward with zero network attempts. API signature, CLI kwargs and configured model settings are asserted directly.","sources":["processing/src/peekaplate_processing/run_pipeline.py","processing/tests/test_pipeline_timing.py","processing/README.md","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-PR-PNPM-LAUNCHER-001","status":"resolved","area":"local-check-launcher","observation":"The temporary pnpm link pointed to a cached non-executable JavaScript entry, so dependency installation and context refresh could not launch; no project check had run through that launcher.","correction":"Use an external executable wrapper that invokes the existing pinned pnpm entry through pinned Node. No repository dependency, lockfile or executable permission was changed.","regression":"The corrected launcher reports pnpm11.25.0, resolves the existing lockfile from cache and successfully runs context:refresh. Final project gates are recorded independently in the PR.","sources":["package.json","scripts/context.mjs"]}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-27T20:19:13.726Z","exitCode":1}
```

```json
{"id":"OBS-VIS02-PR-VERIFICATION-SETUP-001","status":"resolved","area":"local-verification","observation":"The fresh base's optional service packages were absent from the offline cache, so the first frozen install stopped before testing. A private archive-audit prototype also tried to open uv's output-directory ignore marker as an archive. The initial quality check rejected the new export ordering.","correction":"Install only the existing frozen service extra, enumerate wheel/sdist extensions explicitly and sort the additive exports as Biome requires. No dependency/lockfile change, lint suppression or product workaround was added.","regression":"The existing service extra installed successfully; both archives passed the corrected path/module audit; pnpm check then passed208 application tests and56 tooling tests, with4 pre-existing optional workerd cases skipped. The complete210-test Python suite and8 shell/consent browser cases also passed before the later price/entry review corrections; final-tree verification is recorded separately in the PR.","sources":["packages/contracts/src/index.ts","processing/pyproject.toml","package.json"]}
```

```json
{"id":"OBS-VIS02-PR-REVIEW-GROUPS-001","status":"resolved","area":"processing-grounding-and-identity","observation":"Independent review found decimal fragments and partial slash lists treated as complete prices, and a genuine unpriced entry lost when two same-name columns shared one OCR line. Fail-first reproductions exported95 from95.50 or a middle option, retained a truncated list, and collapsed two entries to one. A text-only control also borrowed the final repeated entry's price.","correction":"Use price-specific complete numeric-group matching, preserving explicit money/unit controls. Count repeated titles within one flattened line before price eligibility without turning separate ingredient mentions into entries; abstain on repeated text-entry prices. Deduplication requires stronger unique-source proof, and only actual distinguishable alt-text spans may be excluded. A positive regression prevents currency-marker stripping from consuming ordinary heading suffixes.","regression":"Added socket-blocked decimal/option pipeline-to-export cases, geometry/unit/marker controls, same-line grounding-and-dedup with and without geometry, and caption-span identity checks. Existing positive price and SDK controls remain enabled; final full-suite counts belong to the PR, not to the historical run records above.","sources":["processing/src/peekaplate_processing/menu_context.py","processing/src/peekaplate_processing/menu_layout.py","processing/src/peekaplate_processing/workflow.py","processing/tests/test_menu_context.py","processing/tests/test_menu_layout.py","processing/tests/test_menu_duplicates.py","processing/tests/test_pipeline_timing.py","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-THREE-MODES-001","status":"resolved","area":"processing-input-and-evidence","observation":"The text-only implementation could not provide selected vision inputs or retain values lost through grounding. New fail-first tests found the missing mode/default, no private rejected-name record, and no true no-OCR diagnostic path. An added failure control also caught image-only provider failure incorrectly reported as merely incomplete.","correction":"Reuse the existing graph with explicit ocr/ocr_image/image input, actual bounded source images and mode/image-hash cache identities. Keep grounded originals and text spans unchanged; save schema-validated unvalidated originals, field decisions and actual page-image references privately. Distinguish model diagnostic status from grounding completeness and retain failed model status.","regression":"Socket-blocked synthetic mode, cache, context, original PNG bytes, real-SDK multimodal payload, privacy, empty-OCR and failure tests pass. Existing text-path tests now select ocr explicitly rather than bypass the new default; their assertions remain enabled. OCR+image default is an explicit user choice, not independent quality acceptance.","sources":["processing/src/peekaplate_processing/run_pipeline.py","processing/src/peekaplate_processing/workflow.py","processing/src/peekaplate_processing/vision.py","processing/src/peekaplate_processing/review_suggestions.py","processing/tests/test_input_modes.py"]}
```

```json
{"id":"OBS-VIS02-CURRENCY-OPTIONS-001","status":"resolved","area":"processing-price-options","observation":"Restored regressions reproduced four failures: currency-marked slash options retained an arbitrary scalar or lost the complete printed list when only a scalar was suggested. A prior preparation retry had discarded these unfinished controls; the earlier green suite did not cover them.","correction":"Recognize explicitly printed monetary prefixes within each slash option, compare actual numeric amounts without inferring currency, and preserve the complete literal group with null scalar. Keep explicit monetary/calorie controls intact. Add the named synthetic Beef Pares445 versus neighboring460 control requested by the reviewer.","regression":"All four currency-option subcases fail before correction and pass after it. No test was deleted or weakened; full deterministic suite234 passes with zero socket attempts.","sources":["processing/src/peekaplate_processing/workflow.py","processing/tests/test_menu_context.py"]}
```

```json
{"id":"OBS-VIS02-SERVICE-ARTIFACTS-001","status":"resolved","area":"private-service-artifact-retention","observation":"The existing HTTP wrapper removed its temporary final timing/suggestion files and returned only extraction.json. Fail-first Python/host tests reproduced missing artifact negotiation, cross-source acceptance and upstream success without any private retention.","correction":"Negotiate a bounded internal v1 report/suggestion/timing bundle before temporary cleanup. The existing authenticated host verifies source/version/mode and writes a create-only tenant/job/server-attempt object to the existing private R2 binding before returning the unchanged report shape with configuration metadata. Storage failures, collisions and invalid/old bundles cannot claim success. Valid failed exit1 reports are retained only after report/source validation; no result is fabricated for timeout or missing files.","regression":"Focused host tests19 pass and the Python suite243 passes before final Docker-rule hardening. Both languages consume one labelled synthetic bundle. Tests cover source/grant mismatches, raw-private exclusion from the public response, final sidecar capture, attempt separation and R2 failure. No hosted deployment, real provider storage test, UI fields or database write is claimed.","sources":["processing/src/peekaplate_processing/service.py","processing/tests/test_service_artifacts.py","backend/src/extraction-host.ts","backend/src/extraction-host.test.ts","processing/tests/fixtures/service-artifacts/representative-bundle.json"]}
```

```json
{"id":"OBS-VIS02-DOCKER-PRIVATE-SOURCE-001","status":"resolved","area":"container-build-privacy","observation":"PR55's inherited Docker allowlist re-included src/** after excluding everything, which could include nested local env/history files when built from a developer's dirty source tree. The fresh canonical checkout contained no such credentials, so earlier archive scans did not establish safety for that context.","correction":"Place explicit nested env, private local Markdown, JSONL and bytecode deny rules after the source allowlist. Do not copy credentials into a fixture or rely on Git ignore for Docker contexts.","regression":"Static rule-order regression failed before the fix and passes afterward. This is a file-policy check; an actual Docker image build remains unverified where the WSL Docker daemon is unavailable.","sources":["processing/.dockerignore","processing/tests/test_service_artifacts.py","docs/menu-ingestion-infrastructure.md"]}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-28T00:05:56.984Z","exitCode":1}
```

```json
{"id":"OBS-VIS02-REVIEW-PRICE-GRAMMAR-001","status":"resolved","area":"entry-price-recovery","observation":"Independent correctness review of1abc6d9 identified two reachable cases: an omitted TEA95 source heading was accepted as an arbitrary three-letter currency price box, and per-option CAD prefixes/suffixes could retain a scalar8.50 beside a full8.50/12.50 option group.","correction":"Share a bounded recognized monetary-option grammar between text and geometry recovery. Do not treat arbitrary alphabetic labels as currency markers. Require complete scalar evidence, clear multi-option scalars even when the supplied full literal uses labels, and preserve full source formatting/code suffixes when recovering a complete group. No currency or option meaning is inferred.","regression":"Three added tests (including subcases and pipeline-to-export controls) reproduced8 failures before correction;247 socket-blocked Python tests pass afterward with0 attempts. CAD/PHP positive recovery, known zero, calorie units, metadata and exact spans remain covered. The prior option test now requires the stronger full literal including its printed CAD suffix, rather than truncating that suffix.","sources":["processing/src/peekaplate_processing/menu_context.py","processing/src/peekaplate_processing/menu_layout.py","processing/src/peekaplate_processing/workflow.py","processing/tests/test_menu_context.py","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-LIVE-OCR-LIMIT-001","status":"open","area":"live-validation-provider-limit","observation":"The bounded six-run validation stopped on OCR HTTP429 at total request61. The first full-source OCR-only run used35 OCR requests and17 model starts, retained one HTTP500 page failure without retry, and took799.1s. The second source-acquisition arm stopped after26 OCR calls before any model call. No reset time or billing inference is established by HTTP429.","correction":"Preserve partial evidence; do not silently repeat failed acquisitions or call known-limited OCR again. The user chose waiting for confirmed provider availability and authorized up to37 additional OCR calls to finish the failed arm and two image-source OCR arms (98 total), while retaining the57 model-start cap. Fresh validation and PR publication remain blocked until completion; local timing does not prove the hosted700s chain.","regression":"Private protocol/source/environment/module hashes and HTTP counters retained. No real input, raw response, credential or private path is included in this record. No automatic polling/retries or cloud deployment was performed.","sources":["docs/processing-v3.md","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"OBS-VIS02-VISION-BATCH-BUDGET-001","status":"resolved","area":"vision-request-planning","observation":"Actual full-source rendering showed the default10-page groups exceeded the16 MB model-image limit: the first three target groups were23.2/24.6/28.8 MB, or up to31.4 MB with image-only context. Explicit two-page trials did not establish that the default worked.","correction":"After user approval, treat batch-pages as a maximum and greedily pre-split contiguous vision groups against the byte budget including actual preceding image-only context. Keep original prepared bytes, hashes, page identities,10/1 defaults, provider/model and authoritative worker image validation. No request is retried and no image is resampled to fit a group.","regression":"Synthetic pre-split controls first failed for both modes;248 socket-blocked Python tests pass afterward with0 attempts. Offline actual-image preflight covers all35 pages:6 combined groups (maximum15,291,597 bytes) and8 image-only groups (maximum15,746,455 bytes), all within16 MB with original bytes. This is input-budget proof, not additional provider/model/semantic or hosted runtime acceptance.","sources":["processing/src/peekaplate_processing/workflow.py","processing/src/peekaplate_processing/run_pipeline.py","processing/tests/test_input_modes.py","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-COMPACT-OPTION-COMPLETENESS-001","status":"resolved","area":"clipped-price-evidence","observation":"Final correctness re-review of19ba264 identified a grammar mismatch: full option recognition permitted CAD12.50 but neighboring-option completeness required a space. A clipped CAD8.50 box could therefore hide the remaining CAD12.50 option and recover an arbitrary scalar; a two-option prefix could hide a third option.","correction":"Use shared recognized markers, including compact forms, when checking neighboring options. Unknown uppercase three-letter markers may conservatively invalidate completeness, but remain ineligible for automatic price recovery. Retain existing sign, unit and literal/source bounds.","regression":"Expanded grounding/pipeline-export cases reproduced6 failures before correction.249 socket-blocked Python tests pass afterward with0 attempts, including full compact-list positives, clipped single/two-option negatives, unknown-prefix abstention and prior CAD/PHP/zero/unit controls. No provider calls or new fact/evidence fields were introduced.","sources":["processing/src/peekaplate_processing/menu_context.py","processing/tests/test_menu_context.py"]}
```

```json
{"id":"OBS-VIS02-DEPLOYED-HOST-RECONCILIATION-001","status":"resolved","area":"deployed-container-preservation","observation":"The feature clone targeted older develop while main had deployed PR60's direct Durable Object scheduler. The inherited helper/basic configuration would replace the working runtime if copied forward blindly. Four canonical lifecycle tests and the scheduling guard failed against the older wrapper/config.","correction":"Preserve main's direct class, named base image, standard-1 startup, native idle timeout, shared readiness and single extraction POST. Layer private bundle retention onto the authenticated outer host only. Keep the existing resource/binding/migration identities; no deploy or credential changes. Align the exact existing main worker-types dev dependency and type config, retaining develop's retrieval implementation/tests rather than copying unrelated main deletions.","regression":"All24 lifecycle/auth/archive host cases and4 infrastructure guards pass. New worker ambient types initially exposed Node URL and TextDecoder option mismatches; explicit Node URL imports and the unchanged false ignoreBOM default restore typechecking. The integration response assertion now parses the existing DishRevision schema, preserving all prior authorization tests. Offline package metadata was absent; ordinary registry download installed only the exact existing main tooling version and frozen lockfile was verified.","sources":["backend/src/extraction-host.ts","backend/src/extraction-host.test.ts","backend/wrangler.extraction.jsonc","backend/package.json","backend/tsconfig.json","pnpm-lock.yaml","backend/src/dish.integration.ts","backend/src/retrieval/fetcher.ts","backend/src/retrieval/fetcher.workerd.test.ts","scripts/menu-ingestion-infra.test.mjs","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"OBS-VIS02-SIGNED-MONETARY-NEIGHBORS-001","status":"resolved","area":"incomplete-option-evidence","observation":"Correctness review ofa21d238 found that sign-before-marker neighbors such as +CAD12.50 or -$12.50 were not detected after a clipped first option, even though marker-before-sign variants were rejected.","correction":"Conservatively detect either sign/marker order with OCR spaces/tabs and reject whitespace-hidden signs outside a supplied suffix. This is negative completeness evidence only: accepted recovery formats, unsigned price values, currency inference and unit guards are unchanged.","regression":"Expanded matrix reproduced274 failing subcases before the fix.251 socket-blocked Python tests pass afterward with0 attempts. Coverage includes120 signed-neighbor combinations through grounding and pipeline/export, all prior full-list/zero controls, and separately labelled calorie/portion monetary controls. No tests were removed or weakened.","sources":["processing/src/peekaplate_processing/menu_context.py","processing/tests/test_menu_context.py"]}
```

```json
{"id":"OBS-VIS02-CONTAINER-SMOKE-CONFIG-001","status":"resolved","area":"verification-harness-contract","observation":"Local image builds passed, but the smoke harness used an unapproved source origin and then incorrectly expected internal Python health to require authentication. The first container exited during strict configuration validation; an exec137 alone did not establish OOM. The corrected-origin run was healthy with0 cgroup OOM events and exposed the mistaken internal-health assertion.","correction":"Fix the harness, not the product guards: use the exact allowed staging origin, deployed standard-1 resource limits, network-none isolation and the actual internal liveness contract. Public host authentication remains independently enforced. Preserve failed diagnostics and never reinterpret a successful build as a running service.","regression":"Actual pinned-head Docker build and smoke pass with UID10001, read-only rootfs, synthetic nested env excluded, runtime imports, internal health200, missing extraction auth401, invalid request422 and disabled OpenAPI404. Container had no external network/provider access and was removed after the test. This is local packaging/liveness proof, not hosted extraction or provider quality.","sources":["processing/Dockerfile","processing/.dockerignore","processing/src/peekaplate_processing/service.py","backend/src/extraction-host.ts","backend/src/extraction-host.test.ts"]}
```

```json
{"id":"OBS-VIS02-LIVE-CONTINUATION-001","status":"resolved","resolves":"OBS-VIS02-LIVE-OCR-LIMIT-001","area":"bounded-validation-evidence","observation":"The original bounded attempt stopped on OCR HTTP429 before all six arms ran. The user subsequently authorized37 additional OCR calls, with the first actual page checking availability and an immediate stop on429 rather than automatic polling/retry.","correction":"The frozen five-arm continuation completed without reruns. Cumulative usage is98 OCR calls including the stopped26-call acquisition, and56 model starts. The original completed OCR arm remains old-head live evidence with an explicitly separate final-code grounding replay; other five arms ran fresh at0767409. No billing or provider reset-time inference is made.","regression":"All six exports equal TypeScript parsing;302 candidates remain needs_review. Image-only used no OCR/native-text calls and created no grounded spans/candidates. Source failures, timeouts, token-limit rejection and unsupported prices remain visible. Local35-page combined processing exceeded the service700s cap at different batch settings, so hosted budget/quality acceptance is not established. The private paginated report passed7 browser checks with0 errors/external requests. Raw menus, model outputs, credentials and private paths are excluded from this record.","sources":["docs/processing-v3.md","docs/review-candidates.md","docs/menu-ingestion-infrastructure.md"]}
```

```json
{"id":"OBS-VIS02-OCR-TABLE-TRIAL-001","status":"open","area":"column-menu-price-acquisition","observation":"A user-approved single-image Engine 3 trial changed only isTable from true to false, using the identical uploaded JPEG hash. One HTTP request succeeded in 6.149s with no retry or model call. Both responses contained identical 277-character ParsedText without decimal price tokens and identical 44 overlay regions, 25 price-bearing. Thus disabling table recognition did not restore source-text prices.","correction":"Retain the true default and strict source-text grounding. The explicit CLI/Python opt-out has separate cache identity but is not a missing-price fix. No overlay-only words were promoted, source offsets rewritten or further paid requests made. Any overlay-derived text capability still needs an accepted evidence-contract amendment.","regression":"257 socket-blocked Python tests pass with zero socket attempts, including default cache compatibility, setting isolation, both CLIs and pipeline-to-transport metadata. Offline replay of 14 saved suggestions produced identical grounded fields and zero price fields under either response; this is not fresh LLM or factual approval. All 27 baseline JSON hashes and original checkout status remain unchanged. Initial restored-venv service imports lacked optional FastAPI; frozen offline service dependencies restored the full test lane without weakening tests. An initial credential preflight used the empty template env and made no HTTP request; the existing prior-run env was then used without copying or disclosing credentials.","sources":["processing/src/peekaplate_processing/ocr_space.py","processing/src/peekaplate_processing/extract_menus.py","processing/src/peekaplate_processing/run_pipeline.py","processing/tests/test_ocr_space.py","processing/tests/test_input_modes.py","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-PRIVATE-OVERLAY-PROTOTYPE-001","status":"open","area":"private-box-evidence-boundary","observation":"After the negative table-setting trial, the user explicitly approved separately identified OCR-box text for a private offline prototype, not standard review export. Overlay/model agreement can retain wrong readings, so it cannot be factual approval or justify replacing original source text.","correction":"Add a standalone create-only artifact with exact saved-region literals/coordinates/indices, transcript-local Unicode spans and input hashes. Check source/upload/image provenance and complete ordered numeric agreement. Keep every row unvalidated and abstain on geometry/name ambiguity, extra options and conflicts. Do not mutate production drafts, IDs, metadata, RES schemas or service bundles; public overlay-backed candidates remain deferred.","regression":"297 socket-blocked processing tests pass with zero attempts. Fail-first controls cover saved-format errors/whitespace lists, partly aligned extra readings and nonfinite retained data, plus provenance, Unicode, strict numeric grammar and immutability. Frozen saved replay retains all14 suggestions/44 regions:10 numeric-agreement rows cover18 visually checked price cells;4 abstain, including extra-option and conflicting-reading controls. All14 standard candidates/IDs/null prices and27 baseline JSON hashes remain unchanged. JavaScript code-point checks reconstruct46 region and19 price-part slices across real and synthetic artifacts. Numeric checks do not certify names, option roles or whole-menu accuracy. No provider call, push, deployment or task closure occurred.","sources":["processing/src/peekaplate_processing/overlay_review.py","processing/tests/test_overlay_review.py","processing/tests/test_overlay_saved_inputs.py","docs/processing-v3.md","docs/review-candidates.md"]}
```

```json
{"id":"OBS-VIS02-OVERLAY-COMPETING-TITLE-001","status":"resolved","area":"private-prototype-title-ambiguity","observation":"Independent correctness review of16911b7 verified that a competing title split across adjacent/wrapped boxes, or using casefold expansion in an inline occurrence, escaped the prototype's individual-region phrase check and could select one reading despite a conflicting occurrence.","correction":"Use normalized casefold semantics for negative phrase checks and bounded adjacent/wrapped region paths. These checks only invalidate ambiguity: positive recovery remains exact single-region matching and no synthesized text/coordinates/spans enter evidence. Exhausting8-region or10,000-neighbor bounds abstains. Production grounding and public contracts are unchanged.","regression":"New synthetic controls first reproduced4 false numeric-agreement subcases, then passed. Full frozen offline suite passes300 tests with zero socket attempts;43 prototype-focused tests pass. Positive distant-token and bounded-search controls are retained. The post-fix saved replay is identical to the prior private artifact (10 agreements/4 abstentions,18 price cells);27 baseline hashes and original checkout status remain unchanged. No provider/model call occurred.","sources":["processing/src/peekaplate_processing/overlay_review.py","processing/tests/test_overlay_saved_inputs.py","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-OVERLAY-UNICODE-UNION-001","status":"resolved","area":"private-prototype-negative-title-matching","observation":"Re-review ofb019f31 verified that casefold-only negative matching lost original Unicode case-insensitive dotted-I matches. Thus the first duplicate-title fix could reopen a previously blocked competitor despite preserving German casefold expansion.","correction":"Retain the union of original case-insensitive and normalized casefold relations for direct negative checks and bounded run prefixes/completions. Positive title association remains exact normalized single-region matching. This restores earlier exclusions while adding only negative evidence; no transcript/evidence or public path changes.","regression":"Four new direct/split dotted-I subcases failed before correction; both directions, dotless-I controls and German expansion now pass. Prior numeric, Unicode-span, bounded-search and source-preservation controls are unchanged. No tests were weakened and no provider/model calls were made.","sources":["processing/src/peekaplate_processing/overlay_review.py","processing/tests/test_overlay_saved_inputs.py","docs/processing-v3.md"]}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-29T07:58:42.023Z","exitCode":1}
```

```json
{"id":"OBS-VIS02-BOX-PIPELINE-INTEGRATION-001","status":"resolved","area":"box-grounding-and-export","observation":"At7c961d8 graph-only recovery did not establish pipeline success: box records lacked pages, rejected valid fractional coordinates, bypassed canonical negative guards, admitted numeric components of wrapped titles, lost candidate links and changed the empty-field service wire shape. Provenance accepted invented records and private decisions mislabelled box-only support as text.","correction":"Require a unique canonical entry with no numeric evidence before fallback; exclude known competing title components. Attach authoritative pages and validate draft/evidence atomically. Strictly join finite exact records to cited ready saved OCR regions before save/export; preserve SourceSpan and shared TS schemas, deep-copy candidate-ID links into existing public segment metadata, omit empty fields and label private box support honestly. No private prototype artifact is exported.","regression":"New synthetic tests first reproduced assembly, conflict, numeric-name and disposition failures. Full discovery including unchanged optional-service fixtures passes324 tests with zero socket attempts. The eight original negative contrast cases now all abstain. Shared synthetic fixture and seven actual saved-response exports round-trip through unchanged TypeScript parsing. Exact provenance is not factual approval; consumer rendering/save-reload and human acceptance remain unverified. No fresh provider request, publication or deployment occurred.","sources":["processing/src/peekaplate_processing/menu_layout.py","processing/src/peekaplate_processing/workflow.py","processing/src/peekaplate_processing/run_pipeline.py","processing/src/peekaplate_processing/schemas.py","processing/src/peekaplate_processing/review_candidates.py","processing/src/peekaplate_processing/review_suggestions.py","processing/tests/test_box_grounding_safety.py","processing/tests/test_box_evidence.py","docs/review-candidates.md"]}
```

```json
{"id":"OBS-VIS02-PERCENTAGE-NONPRICE-001","status":"resolved","area":"canonical-unit-evidence","observation":"Expanded safety discovery failed on a synthetic8.50% value: canonical-text grounding accepted the numeric prefix before box fallback executed. Independent review confirmed this predates the box fix.","correction":"Recognize ASCII/fullwidth percentage symbols as nonprice units, including directly labelled and slash-propagated counts. Preserve the existing explicit-money boundary for separately labelled nonprice values; do not infer currency.","regression":"The failing full-suite case and added percentage controls pass in324-test discovery. Independent review passes18 further synthetic percentage, signed-neighbor, complete-option and unit cases. Existing money/count controls are unchanged.","sources":["processing/src/peekaplate_processing/menu_context.py","processing/tests/test_box_grounding_safety.py"]}
```

```json
{"id":"OBS-VIS02-BOX-FIXTURE-TOOLING-001","status":"resolved","area":"verification-tooling","observation":"Recorded lint failed because a generated synthetic JSON fixture used expanded arrays rather than repository formatting. A separate reviewer invocation under system Node18 could not load the installed TypeScript runner's styleText dependency; neither failure established an extraction defect.","correction":"Format only the new synthetic fixture with the repository formatter, review module summaries and refresh their fingerprints. Run workspace verification with the already available compatible Node24 toolchain rather than changing dependencies or weakening tests.","regression":"pnpm verify lint typecheck test context:check docs:check build passes. TEST_WORKERD=1 pnpm verify test passes228 TypeScript and56 script tests, with no skips. Context covers10 modules/10 handoffs and local links in46 Markdown files pass; builds include Worker dry-run only.","sources":["processing/tests/fixtures/review-candidates/box-evidence-candidates.json","packages/contracts/src/review-candidates.test.ts","docs/CONTEXT.md"]}
```

```json
{"id":"OBS-VIS02-LAYOUT-RECOVERY-REVIEW-001","status":"resolved","area":"source-entry-and-section-recovery","observation":"Fail-first and independent review found lost raw-Unicode competitor exclusions, source-present spaced trademark stripping, generic/currency/percentage headings hiding canonical numbers, and section views discarding crossing or wholly unclaimed same-row option cells. Initial saved comparison also exposed a lateral section label clearing an already supported price; passing the first full suite did not establish section-filter safety.","correction":"Retain the raw case-insensitive/casefold negative union; refuse trailing-marker replacement when canonical source has a marker after whitespace. Restrict section boundaries to known unique source/geometry headings, exclude generic monetary/unit labels, reject straddling regions and require an independent neighboring title to claim excluded row cells. Preserve valid full-entry grounding before applying a recovery view, and map approved cells to original saved indices. Source text, raw suggestions and public schemas stay unchanged.","regression":"Synthetic controls first reproduce each defect, then pass, including actual pipeline/save/export with repeated names in distinct sections. Final discovery passes381 tests with zero socket attempts. Seven saved-response exports round-trip through Python and unchanged TypeScript schemas; all prior asserted price rows remain unchanged. Quality gains are measured separately from export validity and are modest; most prices remain unknown. No paid provider call, deployment or publication occurred.","sources":["processing/src/peekaplate_processing/menu_layout.py","processing/src/peekaplate_processing/menu_context.py","processing/src/peekaplate_processing/workflow.py","processing/tests/test_layout_reconstruction.py","processing/tests/test_source_entry_recovery.py","docs/processing-v3.md"]}
```

```json
{"id":"OBS-VIS02-TARGETED-RECOVERY-BUDGET-001","status":"resolved","area":"explicit-provider-request-budget","observation":"A selected-page count does not bound paid transport attempts when the legacy OCR client internally retries. Failed-page recovery also must not silently reacquire the whole PDF, erase earlier failures or reuse old candidate links.","correction":"Add opt-in selective PDF acquisition and an explicit single-attempt OCR setting without changing ordinary defaults. Recovery validates source snapshot/hash/coverage and selected failed Engine3 pages before client construction, bypasses cache, enforces a small explicit cap, stops on first failure including429 and preserves unattempted pages/history in private create-only output. Model-only recovery separately preflights the exact selected-page batch plan and keeps unprocessed coverage incomplete without merging drafts.","regression":"Socket-blocked synthetic tests cover caps, exact source/coverage preflight, selection-only rendering/acquisition, cache bypass, one-attempt transport,429 stop, failed/unattempted manifest records, old-error preservation and model-budget rejection before invocation. Full381-test discovery passes with no socket attempts. Six independent write-mocked retry/budget controls pass. No recovery was invoked against a live provider; fresh reliability and hosted budgets remain unverified.","sources":["processing/src/peekaplate_processing/recover_pages.py","processing/src/peekaplate_processing/pdf.py","processing/src/peekaplate_processing/ocr_space.py","processing/src/peekaplate_processing/run_pipeline.py","processing/src/peekaplate_processing/vision.py","processing/tests/test_recover_pages.py","processing/tests/test_targeted_model_recovery.py","docs/processing-v3.md"]}
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
```json
{"id":"OBS-20261022-VIS03-ASSET-001","status":"observation","area":"local-processing-verification","observation":"The local Windows session cannot satisfy three pre-existing processing assertions that compare st_mode against the POSIX private mode 0o600: test_evaluation.test_private_output_preserves_existing_result, test_ingestion.test_private_report_cli_returns_incomplete_exit_code and test_ocr_space.test_valid_engine3_cache_avoids_another_request_even_without_key. NTFS does not store POSIX permission bits, so the comparison cannot hold locally; the same assertions pass in the Linux CI job. The failures exist on the untouched base commit and are not caused by this change.","prevention":"Run the processing suite in the hosted CI job for the authoritative result and treat the local Windows mode assertions as a known platform limit. Do not weaken the shared private-output assertions to satisfy a Windows-only run.","followup":"Confirm the three assertions pass in the hosted CI job before marking the pull request ready.","sources":["processing/tests/test_evaluation.py","processing/tests/test_ingestion.py","processing/tests/test_ocr_space.py"]}
```

```json
{"id":"OBS-20261022-VIS03-HARNESS-001","status":"resolved","area":"visual-asset-verification","observation":"The first harness implementation fetched every layer twice (once to decode and once to display), never initialized the parallax offsets before the first pointer move, and left the fallback image empty when the manifest itself failed to load.","prevention":"Decode and display each layer with a single image element, hold pointer state in one place that the transform reads, and load the fallback independently of the manifest so a manifest failure still shows the approved photo.","regression":"The harness was exercised in Chromium at a 390x844 viewport with device pixel ratio 3. Layers loaded, the fallback stayed visible, pointer and arrow-key movement stayed within 3 degrees, Home reset the movement, reduced motion applied no transform, a deleted layer produced layer_load_failed with the photo still visible, a missing manifest produced one retry, a missing fallback produced fallback_load_failed, and unsupported 3D CSS produced css_3d_unsupported.","limit":"Chromium device emulation is not a phone measurement. p75 startup, p95 frame time and assistive-technology checks remain manual gates.","sources":["processing/src/peekaplate_processing/harness.py","docs/asset-delivery.md"]}
```

```json
{"id":"OBS-20261022-VIS03-ASSET-002","status":"observation","area":"visual-asset-verification","observation":"A failed preparation left the newly created output root on disk after the temporary bundle directory was cleaned, so a rejected run left an empty directory behind instead of no output root at all.","prevention":"Record whether the output root existed before preparation and remove it again when the run fails and the caller did not supply an existing root.","regression":"The asset and spatial tests assert that a rejected corrupt source, an exceeded budget, blank capture evidence and a future capture date all leave no output root behind, and the create-only tests assert that an existing bundle manifest is byte-identical after a refused second run.","sources":["processing/src/peekaplate_processing/assets.py","processing/src/peekaplate_processing/spatial.py","processing/tests/test_assets.py","processing/tests/test_spatial.py"]}
```

```json
{"id":"OBS-20261022-VIS03-ASSET-003","status":"resolved","area":"visual-asset-verification","references":["OBS-20261022-VIS03-ASSET-002"],"observation":"Independent review found that the spatial fallback reader applied the 100,000-byte manifest bound to the T0 detail JPEG instead of the 12 MB image bound, so any realistic 1280px photo would have been rejected as an invalid T0 manifest. Synthetic fixtures masked it because flat geometry compresses below the manifest limit.","prevention":"Bound JSON manifests and image payloads separately. Read the fallback and layer images through the image bound, and require the T0 variant path to be a bare filename before joining it to the bundle directory.","regression":"test_spatial.test_fallback_larger_than_manifest_limit_is_accepted writes a detail variant above 100,000 bytes and asserts it is accepted and copied byte-identically; test_spatial.test_detail_path_traversal_is_rejected asserts a manifest pointing outside the bundle is refused. Both fail against the pre-fix code.","sources":["processing/src/peekaplate_processing/spatial.py","processing/tests/test_spatial.py"]}
```

```json
{"id":"OBS-20261022-VIS03-HARNESS-002","status":"resolved","area":"visual-asset-verification","observation":"Independent review found three harness defects: layers were appended in decode-completion order with no z-index, so a slower opaque background painted over the foreground layers; keyboard input changed rotation without moving the layers; and a later pointer move discarded the keyboard offset instead of combining with it.","prevention":"Derive paint order from layer depth rather than load order, and derive layer parallax from the combined rotation so pointer and keyboard both contribute and remain clamped to the manifest limits.","regression":"With background.png delayed by 1.2 s the DOM order becomes subject, accent, background while z-index stays 1, 401, 701, and the foreground pixels remain painted. Four ArrowRight presses move the subject layer 2.13 px at 2 degrees, a pointer move to the stage centre keeps that 2 degree offset, 30 presses clamp at 3 degrees, and Home resets to 0.","sources":["processing/src/peekaplate_processing/harness.py","docs/asset-delivery.md"]}
```

```json
{"id":"ERR-20261024-VIS03-001","status":"resolved","area":"spatial-asset-provenance","observation":"QA reproduced two spatial defects. D1: the asset id hashed only layer bytes, motion limits and recipe version, so changing a layer depth or name kept the same id and collided on the create-only directory; three different manifests produced the same synthetic id t1_3dc672d50cc06e4178260637a0b3c3b2. D2: the spatial manifest validated mandatory capture_evidence and rights_confirmed but persisted neither, unlike the T0 manifest. Separately, Windows-only Python tests assert 0o600 while os.chmod returns 0o666 on this NTFS volume; those tests belong to the stacked OCR change and remain unmodified.","cause":"The spatial id preimage omitted layer name and depth even though both affect the delivered path and paint order, and SpatialManifest lacked fields for the validated provenance.","prevention":"Address a spatial bundle by the T0 id, every layer name, depth and SHA-256, the motion limits and the recipe version, and persist capture_evidence and rights_confirmed in the spatial manifest. Treat POSIX permission assertions as non-portable on NTFS.","regression":"test_asset_id_tracks_layer_names_and_depths and test_manifest_records_capture_evidence_and_rights failed before the fix and pass after it; the spatial test module passes 10 tests.","sources":["processing/src/peekaplate_processing/spatial.py","processing/src/peekaplate_processing/schemas.py","processing/tests/test_spatial.py"]}
```

```json
{"id":"ERR-20261025-VIS03-002","status":"resolved","area":"spatial-asset-review-and-rebase","references":["OBS-20261022-VIS03-ASSET-001","ERR-20261024-VIS03-001"],"observation":"Rebasing S3-VIS-03 onto merged develop (5c0cb3f, after #23 and #24) removed the older stacked OCR commit and exposed that sources.check_size had been inlined into sources.read_file. Independently, PR review reproduced four P2 issues: (1) read_detail_bytes checked fallback SHA-256 without decoding the JPEG or verifying its dimensions; (2) harness.py clamped only the rendered rotation while keyboard.yaw and keyboard.pitch accumulated unbounded saturation; (3) read_bounded called Path.read_bytes() before applying MAX_MANIFEST_BYTES; and (4) spatial total_asset_bytes excluded the delivered harness.html and spatial-manifest.json overhead.","cause":"Fallback validation stopped at hash comparison, keyboard state was updated before clamping against the combined limits, manifest reads used unbounded read_bytes(), and budget accounting summed only image files.","prevention":"Decode fallback.jpg with Pillow and verify opaque JPEG format plus exact detail dimensions; clamp stored keyboard offsets against the combined pointer+keyboard limits on every keydown; read manifests with source.read(MAX_MANIFEST_BYTES + 1); and converge total_asset_bytes over layers, fallback, harness.html and spatial-manifest.json before checking budget_bytes.","regression":"All 109 Python tests (including 6 T0 and 14 spatial tests) pass on Windows after the rebase and fixes, covering corrupt/dimension-mismatched fallbacks with matching hashes, immediate keyboard reversal after 40-step saturation, bounded 100,001-byte manifest reads, and exact image-only vs delivered-bundle budget boundaries.","sources":["processing/src/peekaplate_processing/assets.py","processing/src/peekaplate_processing/spatial.py","processing/src/peekaplate_processing/harness.py","processing/tests/test_spatial.py"]}
```

```json
{"id":"ERR-20261025-VIS03-003","status":"resolved","area":"spatial-harness-review-fixes","references":["OBS-20261022-VIS03-HARNESS-002","ERR-20261025-VIS03-002"],"observation":"Follow-up PR review on 388f66d reproduced three viewer issues and one regression-test gap: (1) <img id=\"fallback\"> omitted a static src attribute, leaving naturalWidth=0 when JavaScript was disabled; (2) moving the pointer after saturating keyboard.yaw left excess keyboard offset until two reverse presses; (3) Math.round(layer.depth * 1000) + 1 gave z-index 1 to both 0 and 0.0001, allowing a delayed background to paint over the foreground; and (4) the Node harness test supplied window.CSS without globalThis.CSS, hitting the fallback catch before layers loaded.","cause":"The static img relied on script assignment, pointer updates did not reconcile stored keyboard offsets against combined limits, z-index rounded continuous depth values instead of ranking sorted layers, and the test environment lacked a bare CSS global.","prevention":"Include src=\"./fallback.jpg\" in static markup, reconcile keyboard.yaw and keyboard.pitch on both pointermove and render, assign 1..N z-index ranks from stable (depth, index) ordering, and expose globalThis.CSS in Node harness tests while asserting layersLoaded, spatialVisible, layer parallax and delayed close-depth z-index order.","regression":"All 110 Python tests (6 T0, 15 spatial, 89 OCR/workflow) and local Chromium checks pass, including JavaScript-disabled fallback rendering, Home -> 40x ArrowRight -> pointer right edge -> 1x ArrowLeft -> 2.5deg, and delayed background with depths 0 / 0.0001 / 0.0002.","sources":["processing/src/peekaplate_processing/harness.py","processing/tests/test_spatial.py"]}
```
<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-30T06:15:32.706Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-10-30T06:15:32.706Z"},"status":"environment-limited","cause":"The verification runner stopped before Biome because pnpm attempted to register the newly expanded eight-workspace checkout with a Windows project symlink that the Codex sandbox rejected with EPERM.","evidence":"The same pinned Biome executable was invoked directly against the merged tree and checked 102 files with no fixes required. Direct context refresh/check, documentation-link validation and git diff --check also passed.","limit":"The merged TypeScript and Vitest suites were not rerun in this sandbox because the current checkout cannot link the new workspace dependencies. Hosted Linux CI remains required after push."}
```

```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-29T14:41:51.693Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-02T12:28:12.431Z","exitCode":1}
{"kind":"automatic-check-observation","check":"docs:check","timestamp":"2026-10-30T22:29:37.257Z","exitCode":1}
```

## RES-02 October 31 local reconciliation checks

Initial context refresh rejected an overlong merged database summary; the summary was shortened while retaining both publication and canonical observation boundaries. A frozen dependency install stopped at pnpm project-registry symlink creation with Windows EPERM before tests ran; no application failure was established.

The project-local store avoided the registry-link step, but dependency linking still failed with EPERM. Direct script checks passed 54/57: the preview symlink fixture was denied, the database-launcher test could not resolve uninstalled Vitest, and the real pnpm invocation retried the denied registry link. Direct pinned Biome, context validation and documentation-link checks passed. Full TypeScript/application/database/browser verification is deferred to Linux CI; no tests or runtime protections were weakened.

## RES-02 public-menu integration response typing

At head 7299603, Linux CI run 41232592080 passed database and browser checks but typecheck reported TS18046 on approval, publication and public-menu response JSON in the public-menu integration case. The shared runtime declarations type Response.json() as unknown. Parse those three responses with MenuApprovalSchema, MenuPublicationSchema and PublicMenuResponseSchema, matching the existing command integration tests; keep real JWT, publication and withdrawal assertions. Scoped Biome, context/docs and whitespace checks pass locally. Exact-head Linux quality and database checks must verify the correction; no application contract changed.

## RES-02 November 1 context reconciliation

An initial merged backend summary exceeded the context validator's existing 1,000-character limit. The backend/database summaries were shortened while retaining develop's retrieval, extraction, canonical observation and new diner fixture/search boundaries. All develop nodes and their listed paths were preserved. The existing context validator, lint, typecheck, unit/script tests, builds and documentation checks subsequently passed; the real disposable PostgreSQL/workerd suite also passed. This supersedes the earlier local-install limitation for this reconciled tree and does not establish hosted publication acceptance.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-30T21:02:44.553Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-02T12:30:37.551Z","exitCode":2}
{"kind":"automatic-check-observation","check":"docs:check","timestamp":"2026-10-30T22:29:52.505Z","exitCode":1}

{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-01T08:27:17.219Z","exitCode":2}
```

```json
{"kind":"resolution","references":{"check":"typecheck","timestamp":"2026-11-01T08:27:17.219Z"},"status":"resolved","evidence":"MenuAuthority made trafficClass optional with server-side live default; all workspace packages passed typecheck and pnpm check."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-02T12:32:43.882Z","exitCode":2}
{"kind":"automatic-check-observation","check":"docs:check","timestamp":"2026-10-30T22:30:16.255Z","exitCode":1}
```

## ERR-20261031-CONSUMER-SANDBOX-PNPM

Automatic check runner `docs:check` invoked via `scripts/verify.mjs` recorded exit code 1 due to sandbox filesystem isolation restricting reading the user-level pnpm preference directory (`/Users/teeyanshshukla/Library/Preferences/pnpm/config.yaml`). Direct invocation via `node scripts/check-docs.mjs` confirmed all 44 documentation files checked with 0 broken links.

```json
{"kind":"resolution","references":{"id":"ERR-20261031-CONSUMER-SANDBOX-PNPM"},"status":"resolved","evidence":"Direct verification via node scripts/check-docs.mjs confirmed passing on 44 markdown files."}
```

```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-01T20:41:29.007Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-11-01T20:41:29.007Z"},"status":"resolved","evidence":"Formatted new unit tests in backend/src/index.test.ts and packages/contracts/src/index.test.ts with biome."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-02T12:43:21.030Z","exitCode":1}
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-01T20:43:37.549Z","exitCode":2}
```

```json
{"kind":"resolution","references":{"check":"typecheck","timestamp":"2026-11-01T20:43:37.549Z"},"status":"resolved","evidence":"Aligned ObservationIngestServices.now with exactOptionalPropertyTypes and spread into ingest call; typecheck passed."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-02T12:44:38.329Z","exitCode":1}
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-01T20:49:13.351Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"test:e2e","timestamp":"2026-11-01T20:49:13.351Z"},"status":"resolved","evidence":"Installed Playwright Chromium headless shell locally; pnpm verify test:e2e passed all 13 tests."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-02T12:56:41.943Z","exitCode":1}
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-01T21:42:36.464Z","exitCode":1}
```

```json
{"id":"ERR-20261030-MAIN-OWNER-REPORT-LOCATION","status":"pending-verification","area":"main-ci","cause":"An unused owner-report schema was committed outside packages/contracts/src on main; Biome rejects its formatting while exports and TypeScript exclude it.","resolution":"Remove only the misplaced root-level draft. Keep the reviewed owner-report implementation on its separate develop-based branch.","regression":"Before deletion, pnpm exec biome check packages/contracts/owner-report.ts reproduced the formatting failure. Full local and PR checks follow the deletion.","sources":["packages/contracts/package.json","packages/contracts/tsconfig.json","https://github.com/vivienk/peekaplate/actions/runs/41111328548"]}
```

```json
{"kind":"resolution","references":{"id":"ERR-20261030-MAIN-OWNER-REPORT-LOCATION"},"status":"resolved","evidence":"After deleting the unused draft, pnpm verify lint typecheck test build context:check docs:check passed in 20.143s: 69 Vitest tests and 57 script tests. Public exports, TypeScript source, runtime, migrations and deployment configuration are unchanged. Applicable GitHub PR checks remain a separate merge gate.","prevention":"Add reviewed shared contracts under packages/contracts/src and export them from src/index.ts through a PR into develop; verify formatting and contracts before promotion."}
```

## OBS-20261031-OBSERVATION-RELEASE-REHEARSAL

The first operator-only rehearsal could not identify its disposable container
using Docker's publish filter. A second attempt reused a second database in
the same cluster and collided with an existing export role: PostgreSQL roles
are cluster-wide. The corrected rehearsal used its own named disposable
container, then passed the exact four-migration upgrade, retry, preservation
and rollback-only runtime checks in 6.453 seconds. No shared database was
affected. Keep cluster-scoped role migrations in isolated rehearsal instances.
The local engine was initially stopped; starting the existing Desktop install
restored it without resetting or pruning data. `pnpm verify test:db` then passed.

## OBS-20261031-HOSTED-RUNTIME-ROLE-PROBE

The hosted metadata audit and both forward migrations passed, but a subsequent
rollback-only SQL Editor probe returned SQLSTATE 42501 when attempting
`SET LOCAL ROLE peekaplate_runtime`. Managed `postgres` is not an unrestricted
superuser. Use the real restricted runtime/Hyperdrive connection for behavioral
checks; do not expand editor role membership to bypass this boundary. Hosted
write acceptance remains unverified; the subsequent real read-only Hyperdrive
check passed without changing role membership. operations.md records the limit.

## OBS-20261031-CONTEXT-SUMMARY-BOUND

The initial release context update exceeded the existing bounded-summary limit. Context refresh/check failed before publication. The summary was rewritten within the schema limit rather than weakening validation; rerun context refresh/check and docs checks before committing. Retain existing error history byte-for-byte when appending new records.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-01T21:11:41.330Z","exitCode":1}
```

## RES-02 November 1 hosted configuration and interrupted acceptance

The first new staging signing JWK included `key_ops`, which the reviewed strict
configuration parser deliberately rejects. JWKS returned 503 without exposing
private key material. The operator generated the allowed EC/P-256/ES256 fields,
validated them with the same `menuJwks` implementation before upload, and the
hosted public-only JWKS returned 200. No backend validation was weakened and no
private key value was saved in Git or operator files.

The first authenticated acceptance run completed approval/publication and retry
checks, then its client aborted a public read after 20 seconds. An independent
read returned 200 in 747 ms. A resumed test used the original command IDs and
finished the bundle/hash/token, withdrawal and revoked-owner checks. Hosted
readback remained exactly three events, three command receipts and three outbox
rows. The original timeout is retained in the acceptance evidence; its cause is
not established and the completed functional checks do not certify latency/load.

## PR31 November 1 shared-contract reconciliation

The first direct Biome check caught a duplicate closing statement while joining
the two contract-test tails. Removed only that duplicated closure and retained
both branches' assertions. The corrected focused run passed 191 tests; full
verification passed 467 unit tests and 58 script tests, and the real migrated
PostgreSQL run passed 189 SQL assertions plus 40 integration tests, including
the new actual-producer/consumer retry and publication-conflict case. This was
an intermediate merge error caught before commit, not a deployed regression.

## PR31 November 2 collaborator smoke query

An additional authenticated team-read probe omitted the required `from`/`until`
window and correctly received 400. The probe was corrected to use the existing
bounded query contract; events and summary then both returned 200. No product
code, permissions or credentials changed. Reuse the shared query schema or a
known valid reporting window when checking authenticated read availability.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-02T07:27:05.785Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-02T13:06:00.751Z","exitCode":1}
```

```json
{"kind":"resolution","references":[{"check":"lint","timestamp":"2026-10-29T14:41:51.693Z"},{"check":"typecheck","timestamp":"2026-11-02T12:30:37.551Z"},{"check":"typecheck","timestamp":"2026-11-02T12:32:43.882Z"},{"check":"test:e2e","timestamp":"2026-11-02T12:44:38.329Z"},{"check":"test:e2e","timestamp":"2026-11-02T12:56:41.943Z"}],"status":"resolved","cause":"PR #69 review-fix iterations: unchecked indexed access in a new unit test failed typecheck, and new e2e locators matched dishes in categories that are now correctly hidden, plus an allergen label failed contrast once the detail CSS applied.","prevention":"Guard indexed access in tests and scope e2e locators to the visible category.","regression":"pnpm check and pnpm verify test:e2e pass after the fixes."}
```

```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-02T07:28:30.719Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-02T07:30:19.504Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-02T07:30:55.676Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-02T07:38:48.270Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-02T07:39:48.686Z","exitCode":1}
```

## November 2 typed-fact integration verification

The initial real-database regression proved the missing behavior: all nine
accepted observations produced index rows but no typed facts. The follow-up
writes index/event/detail in one transaction and fills historical accepted rows
under the same identity lock. Unrelated detail uniqueness failures now retry;
they cannot be hidden by the former generic unique-violation duplicate fallback.

Intermediate checks caught an internal legacy venue alias entering a strict
schema, Node/Worker URL type mismatches in a test, and a browser-test poll shorter
than local Queue batching. The alias is excluded at the fact boundary, fixture
paths use Node file paths, and bounded polling allows the actual Queue delivery.
The corrected real database/browser run passed 189 SQL assertions and 46 tests.
Shell quoting and two guessed test paths also failed during inspection; use
discovered paths and file-backed patches rather than nested shell interpolation.
These were local intermediate failures, not changes deployed to staging.

The documentation helper initially used Windows' default encoding and then an
incomplete context-handoff shape. The affected documents were restored from
their exact Git bytes, reapplied with UTF-8, and the handoff gained its required
module IDs. Context freshness and local documentation checks passed afterward.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-02T07:44:24.918Z","exitCode":1}
```

The subsequent context refresh/check passed after restoring required handoff
module IDs. Independent review also found a browser-launch failure could leave
the transport test's HTTP server open. Launch now occurs inside its cleanup
guard; the final database/browser regression passed all 46 tests in 44.147
seconds including lint, type and documentation checks.

Security-report finalization initially rejected invalid surface IDs/missing
labels. The same pinned scan was resumed with valid labelled surfaces, sealed
and read back successfully; no source-code or provider change was needed.
Validate the saved draft result before calling its finalization operation.

## November 2 hosted menu-token self-fetch

The first genuine Brave test loaded the published synthetic menu and exact-hash
bundle but received 503 at observation acceptance. Both source/DLQ remained
empty and paused; no event was falsely accepted. A bounded synthetic Worker
confirmed Cloudflare 1042 when fetching its own public route. Own-token
verification had fetched this API's own JWKS, unlike the separate JWKS server
used by the existing local tests.

The regression first failed with MenuTokenUnavailableError when self-fetch was
blocked, then passed using the configured public JWK locally, including denial
of wrong-audience and forged-signature tokens. Signature and claim checks stay
enabled; no broad fetch compatibility flag, new credentials or public debug
route is added. Fresh hosted acceptance must pass after the reviewed fix deploys.
Reference: https://developers.cloudflare.com/workers/observability/errors/

## November 2 hosted follow-up and interrupted verifier

The reviewed own-token fix deployed as main c6a47bd. Genuine Brave acceptance
now passes; the previous 503/self-fetch1042 failure is resolved within this
synthetic hosted scope. Six hosted checks verify typed facts/backfill, original
archive integrity, retries/conflicts and tenant/test exclusion.

A desktop freeze stopped the verifier after five saved PASS results, before
its cleanup/final readback completed. The source Queue was explicitly paused,
then a read-only continuation checked the same event IDs, archive metadata and
empty/paused Queues. No events were resubmitted. Preserve intermediate evidence
and verify provider state after client failure; a process finally block cannot
guarantee cleanup after its host exits. A nested PowerShell process query also
expanded dollar variables incorrectly; it was stopped and replaced with a
file-backed command. Keep shell scripts with variables out of nested strings.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-02T18:14:48.185Z","exitCode":1}
```

The final evidence JSON initially used Windows CRLF rather than the repository
formatter output. Formatting that single file fixed the lint failure; the
subsequent lint, context and documentation checks all passed.

The database context summary exceeded its 1,000-character limit during the
final handoff edit. It was shortened without dropping tenant/privacy boundaries;
context refresh passed. Hosted cleanup then restored viewer access, withdrew
the synthetic publication, ended its session and removed its temporary host.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-02T23:24:30.741Z","exitCode":1}
```

PR88 reconciliation resolution: the appended allergen note exceeded the diner
node's 1000-character summary limit. Moved the note to the bounded handoff,
preserving the current develop graph. `pnpm context:refresh` and `pnpm check`
pass. Keep node summaries within the existing limit when resolving conflicts.
## RES-02 November 1 context reconciliation

An initial merged backend summary exceeded the context validator's existing 1,000-character limit. The backend/database summaries were shortened while retaining develop's retrieval, extraction, canonical observation and new diner fixture/search boundaries. All develop nodes and their listed paths were preserved. The existing context validator, lint, typecheck, unit/script tests, builds and documentation checks subsequently passed; the real disposable PostgreSQL/workerd suite also passed. This supersedes the earlier local-install limitation for this reconciled tree and does not establish hosted publication acceptance.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-26T19:27:42.930Z","exitCode":1}
```

{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-30T19:38:40.134Z","exitCode":1}
```

## 2026-10-30 — AI-01 develop-sync verification environment limit

`pnpm verify context:check docs:check` could not start the checks in the fresh
Windows agent worktree: pnpm's automatic dependency installation failed with
EPERM while registering the project through a store symlink. No application
test failed in this attempt. Direct `node scripts/context.mjs check` and
`node scripts/check-docs.mjs` passed after context refresh; they do not replace
the complete CI run. Run frozen installation and `pnpm check` in a capable
environment, then verify the exact pushed merge revision in GitHub CI.

<!-- automatic observation; not root cause -->
```json

## 2026-10-31 — AI-01 reconciliation verification limits

The shell could not locate the repository-requested RTK wrapper; native commands were used. An initial context refresh was invoked from the workspace parent instead of the repository and did not run. The reconciled backend summary then exceeded the context length bound and was shortened without removing the AI integration boundary. Frozen dependency installation remains blocked by Windows symlink EPERM, before tests could start. Direct checks and CI must be reported separately; no protection or test was disabled.

Focused verification then reused the existing pinned Vitest 4.1.11/Zod 4.6.7 installation with explicit aliases to this worktree's source. Its first attempt failed before collection because the sandbox temporary-directory rename was denied. Redirecting TEMP/TMP into a disposable workspace folder allowed both AI suites to run: 25 tests passed. Focused TypeScript checking and the pinned Biome check also passed. These explicit-source checks are not a frozen installation or a full workspace/hosted test run.


<!-- automatic observation; not root cause -->
```json
<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-10-31T21:38:10.001Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"lint","timestamp":"2026-10-31T21:38:10.001Z"},"status":"resolved","cause":"The new scripts/console-preview-demos.test.mjs was not run through the Biome formatter before pnpm check (one over-long line).","prevention":"Run pnpm format (or biome check --write) on new files before pnpm check.","regression":"Formatted the file; pnpm check passes."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-31T15:15:48.512Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-31T15:15:48.512Z"},"status":"resolved","cause":"S3-DIN-02.2 changed tests/e2e/save.spec.ts, which the diner context node lists, without refreshing the node; the first rewrite of the diner summary then exceeded the 1000-character limit, so context:refresh rejected it.","prevention":"Run the full pnpm check (not only lint/typecheck/test) before pushing, and keep node summaries under 1000 characters.","regression":"Condensed the diner summary to 850 characters, added the DIN-02.2 files to the node and refreshed fingerprints; pnpm context:check reports the context valid and fresh."}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-10-31T21:38:51.084Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-10-31T21:38:51.084Z"},"status":"resolved","cause":"Formatting scripts/console-preview-demos.test.mjs after the context refresh changed a source listed in the delivery node, so its fingerprint was stale.","prevention":"Format first, then pnpm context:refresh, then pnpm check.","regression":"pnpm context:refresh followed by pnpm check passes."}
```

## November 4 Bundle context reconciliation

The develop merge conflicted only in the context handoff list. Preserve the
new tracking handoff and Bundle correction; retire the superseded pre-merge
PR43 handoff to retain the ten-entry bound. Context refresh/check and direct
documentation checks pass. A first refresh failed at eleven handoffs.
`pnpm verify context:check docs:check` could not start because the Windows
sandbox denied pnpm's project-store symlink. Source-pinned contract tests
initially hit a temporary-directory rename denial; using a writable workspace
TEMP/TMP passed all 58 cases. Biome does not process Markdown, so it is not
Markdown validation. A first direct context invocation used the parent working
directory; rerunning in the repository corrected that command-path mistake.
Full frozen-install workspace validation remains delegated to Linux CI.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-02T22:42:55.035Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"context:check","timestamp":"2026-11-02T22:42:55.035Z"},"status":"resolved","cause":"While merging develop into S3-DIN-02.2 after #68 merged, the combined diner summary came to 1140 characters, so the resolution script stopped before writing docs/CONTEXT.md, and the file was staged with its conflict markers still in it; pnpm check then failed context:check.","prevention":"Check that a conflicted file has no markers left and that the resolution script succeeded before staging it, and keep node summaries under 1000 characters.","regression":"Rewrote the diner summary to 987 characters without dropping any module facts, added the DIN-02.2 files, refreshed fingerprints; no conflict markers remain and pnpm check passes."}
```

## 2026-11-04 — AI stack reconciliation verification

Frozen installation in the Windows agent worktree failed before checks with
EPERM while pnpm registered its project symlink. A workspace-local store gave
the same result. Source-pinned Vitest, focused strict TypeScript and Biome,
plus direct context/docs checks passed. Full workspace, database and browser
checks require the pushed revision's Linux CI. RTK was unavailable.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-03T15:55:44.603Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-04T21:06:43.047Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-03T15:57:21.681Z","exitCode":2}
```

## November 3 PR45 menu-ingestion merge reconciliation

Merging `develop` into `feat/s3-vis-01-menu-ingestion` produced lint and typecheck observations:
1. `biome check` flagged import ordering and trailing formatting in `backend/src/index.test.ts` and `packages/contracts/src/index.test.ts`. Fixed via `biome check --write .`.
2. `tsc` flagged missing observation/public-menu handlers in `Dependencies` in `backend/src/index.ts` (`verifyMenu`, `consumeObservationRateLimit`, `enqueueObservation`, `now`, `readPublicMenu`, `issuePublicMenu`, `readMenuJwks`) that were temporarily dropped during merge conflict resolution. Restored the canonical `Dependencies` interface.
Full verification suite passed: all 33 Vitest suites (577 tests), 64 script tests, `tsc` across all 7 packages, Biome checks, context graph validation, and real PostgreSQL pgTAP + DB integration tests (60 assertions).

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-04T19:53:00.867Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-04T19:58:00.859Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T05:00:23.874Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-05T05:06:38.092Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T05:07:42.043Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T05:33:29.149Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T05:42:39.767Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T13:29:45.452Z","exitCode":1}
```

## November 5 R2 diagnostic persistence & retry safety fix

Fixed R2 diagnostic-write failure swallowing during unsupported-source job processing:
- Cause: In `backend/src/ingestion/orchestrator.ts`, failure diagnostic persistence in R2 was wrapped in `catch { resultStorageKey = null; }`, swallowing infrastructure errors and marking unsupported-source jobs as terminally failed without diagnostic records, causing premature queue message ACKs.
- Prevention: Propagate R2 persistence failures as `IngestionError('report_storage_failed')`, abort terminal failure transitions, requeue the job with lease cleanly released (`terminal: false`), and retry the queue message until diagnostic persistence succeeds.
- Regression: Added focused regression suite in `backend/src/ingestion/orchestrator.test.ts` (Test A, Test B, Test C, Test D) and database integration test in `backend/src/ingestion/ingestion.integration.ts`. All 17 orchestrator tests and 41 vitest suites (708 tests) pass.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-05T18:25:08.608Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-05T18:26:00.808Z","exitCode":1}
```

## November 5 grounding-budget harness correction

The offline Windows suite repeatedly timed out in the five-second child-process
guard because that guard also included workflow/dependency imports. An isolated
probe measured imports at 3.664 seconds and grounding at 0.008 seconds. The test
now starts its timer inside the child after imports, retaining the unchanged
five-second Windows / 3.5-second other-platform grounding assertions and a
30-second startup/hang watchdog. Product extraction code and budgets are unchanged.
The four focused budget tests pass, followed by all 434 offline Python tests
with the socket guard and no external provider calls. Keep dependency startup
cost separate from algorithm-runtime assertions; neither establishes hosted latency.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T20:18:04.489Z","exitCode":1}
```


## November 5 deterministic Undo regression clock

The browser suite observed an empty toast at the nominal 4.9-second assertion
because page.clock.install still lets wall time advance between manual runFor
steps. The test now pauses the clock before mounting its fixture, then advances
only the existing 2000/2900/200-ms steps. Toast assertions, expiry deadlines and
product code are unchanged. All 12 focused Save browser tests pass; retain the
original failure observation above rather than treating a rerun as its diagnosis.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-05T22:28:30.144Z","exitCode":1}
```
<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-11-05T23:56:16.390Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-11-06T08:18:01.285Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-06T11:38:32.645Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-06T11:38:52.513Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-06T11:39:56.081Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T11:40:53.389Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T12:31:49.201Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T12:32:48.778Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T12:35:56.806Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T12:41:36.877Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T12:42:02.683Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T12:42:33.755Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T14:23:03.544Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-06T14:23:31.076Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-06T17:52:39.440Z","exitCode":1}
{"kind":"automatic-check-observation","check":"test:e2e","timestamp":"2026-11-04T20:42:58.972Z","exitCode":1}
```

```json
{"kind":"resolution","references":{"check":"test:e2e","timestamp":"2026-11-04T20:42:58.972Z"},"status":"resolved","cause":"The S3-DIN-02.2 toast timing tests used page.clock.install(), whose fake clock keeps running in real time; under load (a 7.3 s run while merging develop into S3-DIN-02.5) real time alone expired the 5-second removed toast before the test checked it.","prevention":"Pause the installed clock (page.clock.pauseAt) in timing tests so time only moves through runFor.","regression":"Both toast timing tests now use installPausedClock; a probe that waited 6 s of real time failed with a running clock and passed with the paused one, and the tests passed 10/10 when repeated."}
```



## November 3 S3-RES-01.2 review persistence hardening

```json
{"id":"OBS-20261103-RES012-TRUST-001","status":"resolved","area":"review-persistence","observation":"PUT review-session on PR #73 at 4d2c7c2 stored a caller-supplied extraction payload as the immutable original. The private artifact reference was only prefix-checked; its SHA-256 was never compared and the object was never read, so an editor could register originals the producer never emitted.","cause":"Session registration trusted client input instead of the extraction host's stored attempt bundle.","prevention":"Outside local, require jobId and privateArtifactRef; read the bundle from INGESTION_REPORTS_BUCKET, check its SHA-256, stored tenant/job/attempt scope, source, versions, status and start time, and require every candidate original and evidence to equal the report drafts/evidence (report null equals an omitted exported field).","regression":"review-artifact.test.ts covers acceptance, required reference/job, fabricated original, added/removed candidates, altered spans, wrong hash, foreign venue/job/extra key segments, scope/source mismatch, missing object and missing binding. An offline round trip of 106 real menu items exported by the PR #58 exporter verified, and a single fabricated price or name was rejected.","sources":["backend/src/review-artifact.ts","backend/src/review-artifact.test.ts","backend/src/index.ts","docs/review-api.md"]}
```

```json
{"id":"OBS-20261103-RES012-IDEMP-001","status":"resolved","area":"review-persistence","observation":"Reusing a register commandId with a different extraction payload returned the first payload's cached response instead of a command conflict, and every register receipt stored the full session response (up to about twice the 512 KB payload).","cause":"The register request hash omitted the extraction payload, and receipts duplicated the stored session.","prevention":"Include the canonical payload SHA-256 in every command request hash; store compact receipts and rebuild identical retries from the append-only session.","regression":"review-command.test.ts: changed payload with the same commandId returns 409 command_conflict with no writes; an identical retry replays from the session with a compact receipt. Both failed before the change and pass after it.","sources":["backend/src/review-command.ts","backend/src/review-command.test.ts"]}
```

The first offline real-item round trip rejected genuine exporter output: the PR #58 exporter
omits optional fields that are null in the report (`subcategory`, `price_text`). The verifier now
treats a report null and an omitted exported field as equal while still rejecting any non-null
difference. PR #73's copies of the RES-01.1 docs were aligned byte-for-byte with PR #58 and its
endpoint documentation moved to `docs/review-api.md`, so the later #58 merge does not conflict there.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-03T17:06:05.492Z","exitCode":1}
```

```json
{"id":"ERR-20261029-VIS03-004","status":"resolved","area":"spatial-harness-review-fixes","references":["OBS-20261022-VIS03-HARNESS-002","ERR-20261025-VIS03-003"],"observation":"PR #25 review findings by @vivienk (commit 921b32d) identified two issues: [P2] prefers-reduced-motion was captured once on startup so live OS/browser media query changes had no effect on already active transforms or event listeners; and [P3] metrics.layerRetries and ranks used plain object literals ({}), so a layer named 'constructor' read the inherited Object.prototype function and produced string concatenation ('function Object() { [native code] }1') instead of an integer count.","cause":"One-time Boolean matchMedia capture without change listeners, and unconstrained object keys accessing prototype properties.","prevention":"Retain MediaQueryList, register live change listeners, call syncReducedMotion() in render/pointer/keyboard handlers to zero offsets and clear layer transforms immediately, and use Object.create(null) plus Object.prototype.hasOwnProperty for metric and rank maps.","regression":"test_spatial.test_harness_responds_to_live_reduced_motion_changes verifies that toggling reduced-motion live clears transforms immediately and blocks subsequent pointer/keyboard input; test_spatial.test_harness_counts_numeric_retry_for_constructor_named_layer verifies that a layer named 'constructor' records integer retry count 1 in metrics.layerRetries.constructor.","sources":["processing/src/peekaplate_processing/harness.py","processing/tests/test_spatial.py"]}
```

## November 3 S3-VIS-03 presentation identity

```json
{"id":"OBS-20261103-VIS03-PRES-ID-001","status":"resolved","area":"asset-delivery","observation":"Sai reproduced on PR #25 at 965abc7 that two different valid presentation candidates (512x512 and 768x768), or the same candidate from model-a and model-b, received the same pres_ asset id; in one output root the create-only check prevented retaining the second candidate under its own identity.","cause":"prepare_presentation_bundle derived the presentation asset id before generation from the T0 id, dish/revision ids, cutout/reference hashes and recipe version only, so the candidate SHA-256, effective model version, prompt version/hash and success-versus-fallback outcome were not part of the identity.","prevention":"Derive content-addressed ids after validation from every input that changes the delivered bytes or their provenance, and run the create-only check against that final id. A retained fallback carries its own identity, including the rejected candidate hash when one was returned.","regression":"test_asset_id_identifies_the_validated_candidate_and_its_provenance failed before the change and passes after it: different candidates, model versions, and success/fallback outcomes get distinct ids, also within one output root. test_identical_presentation_content_remains_create_only keeps identical content create-only with a byte-identical first manifest and no leftover temporary directory.","sources":["processing/src/peekaplate_processing/presentation.py","processing/tests/test_presentation.py","docs/asset-delivery.md","processing/README.md"]}
```



{"kind":"automatic-check-observation","check":"test","timestamp":"2026-11-04T07:51:53.059Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-04T07:52:52.132Z","exitCode":1}
```

## PR25 local review-preview packaging checks

- Initial repository tests could not bind the local authentication test server
  (`EPERM` on loopback). Re-running with local test networking permitted passed
  the unit/script suites; this was an execution restriction, not a product fix.
- The added processing context summary exceeded the 1000-character limit.
  Independent review identified the cause; shortened the summary and refreshed
  the context fingerprint. The required context check is the regression gate.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test","timestamp":"2026-11-07T17:44:26.682Z","exitCode":1}
```

## November 7 review-preview integration verification

The initial repository test run could not bind its loopback authentication test
server (EPERM). Re-running with local networking permitted passed 767 Vitest
tests (four optional skips) and 67 script tests. No application-code fix was
needed. The first install also correctly rejected Node 24.14.0; verification
uses the repository-required isolated Node 24.16.0 and pnpm 11.25.0.


## November 8 PR25 final review corrections

Four presentation regressions reproduced locally before correction: omitted rights
silently produced `rights_confirmed=true`; oversized candidate files were fully
read; oversized pixel buffers decoded before rejection; rejected PNGs discarded
the provider's actual model and fidelity disclosures. The minimal correction
requires explicit API/CLI confirmation, bounds file reads, checks image headers
before decoding, closes rejected image resources and captures returned provenance
before validating the image. `processing/tests/test_presentation.py` contains the
four regression cases; all twelve presentation tests and 476 offline Python tests
pass. No source captures, credentials or provider calls were used.

The existing hosted quality failure was PR metadata (`Complete PR section: Changes`),
not a Python failure. The rewritten PR description uses the repository's required
sections and records fresh evidence separately from historical results.

The first remote fetch used the upstream repository for a fork-owned feature
branch and failed without changing files; fetching `pull/25/head` pinned the
correct source. Future pushes target the verified head repository explicitly.

Final-head CI then caught a stale assets fingerprint because an unused test import
was removed after the last refresh. Database and browser jobs passed. Refreshed
context after that final source edit and reran `pnpm verify context:check docs:check`;
these checks pass. Keep fingerprint refresh after every final referenced-file edit.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-08T07:50:20.164Z","exitCode":1}
```


## November 8 PR73 re-review

Confirmed the earlier three corrections, then reproduced a source-provenance gap:
four valid-shaped requests changed kind/location/retrieval instant/size while
retaining the genuine bundle/hash and were accepted. The five-line verifier
guard now rejects them before persistence; four red/green unit cases plus one
real-JWT/route/Postgres integration case cover rejection with zero session writes,
honest registration and Worker reload. Equivalent timestamp representations are
accepted. No provider, hosted database or private source data was used.

An intermediate local DB run failed for test setup, not this guard: the added
in-process route lacked required dependency services (503), and the browser suite
occupied port5173 during the DB publication browser test (EADDRINUSE/timeout).
The fixture now supplies the actual verifier; browser/DB suites run separately.
Final serialized verification passed all213SQL assertions and76integration tests.
Preserve shared-port exclusivity when coordinating local suites.


## November 8 PR46 owner-output privacy correction

Re-review confirmed that recommendation rationale exposed exact eligible-session
counts although the existing owner-report contract keeps those counts internal.
The new regression compared otherwise identical requests with cohorts of 23 and 97:
it failed before the fix because the owner text changed, then passed after the
one-line template correction. The count still enforces the ten-session floor;
it is absent from the result. All 26 focused AI tests and 888 unit + 67 script tests pass.

Develop reconciliation preserved both context path sets and the current review
API/asset nodes; fingerprints are regenerated after final source/doc edits.
The dependent #82 evaluation still expects the earlier count-bearing rationale;
its branch must update that expectation when synchronized, then rerun evidence.
No live model, provider or production call was made.


## November 8 PR77 cached-page identity correction

Three new core.test.ts cases reproduced cached-page sequence reuse, resurrection of an expired visit and reuse after stored state disappeared. identity.ts now reconciles the persisted identity before saving on pageshow, preserves the maximum sequence for the same producer, adopts a newer visit and starts fresh when persistent state cannot be recovered. All 44 tracking tests and four Chromium lifecycle/fixture tests pass. The first context handoff exceeded the 1000-character summary cap; its guard prevented any write. The summary was shortened and fingerprints refreshed without dropping either side of the append-only merge ledger.


## November 8 PR80 withdrawal and atomic-store corrections

Four RED storage/public-dispatch regressions reproduced cold-page withdrawal replay, 25 delayed additions crossing withdrawal/re-opt-in, interleaved event loss and stale snapshots after receipt/clear. Atomic IndexedDB transactions and Web-Locked localStorage now update the latest record; pending reads are authoritative. Retiring a pipeline synchronously invalidates its queued additions and stops its batcher. Reopening waits for durable clearing, retries an unconfirmed clear and uses visit memory if it still fails. A further RED fault test proved failed clearing could otherwise replay old work; it now passes. Browser checks cover two genuine tabs, transaction abort after request success, memory fallback without Web Locks and the actual banner with both destinations. Shared consent injection preserves console behavior and removes the separate legacy diner capture path.

The first local merge helper stopped at the summary cap, but a missing exit guard allowed conflict markers into an unpublished merge commit. Recovery reconstructed both parent graphs and path sets, preserved both append-only ledger sides and amended only that unpublished merge. Legacy handoffs without date fields are retained without assuming a common date shape. Subsequent mutation steps stop at the first nonzero result; context:check and git diff --check verify the repaired result before push. A test-only LockGrantedCallback generic annotation was corrected after strict TypeScript rejected it.

## November 8 PR80 failed-clear recovery follow-up

Independent review identified two additional paths: failed clearing lost its pending state after a reload, and clearing a fallback memory store could incorrectly certify that a temporarily unavailable IndexedDB backend was empty. Both regressions replayed the old event before correction. Withdrawal now records deletion-work tokens in sessionStorage/localStorage and explicitly clears both durable backends; incomplete clearance keeps new work in memory and is retried on reopening. Completion records cannot erase a newer request. Eight withdrawal unit tests cover reload, fallback, overlap and unreadable markers; a real Chromium reload test seeds both backends, interrupts IndexedDB access and verifies that old records never reach delivery after recovery. All-storage-write failure remains an explicit documented limitation; no hosted acceptance is inferred.

Tooling corrections: a Windows rg path containing a wildcard was treated literally; use directory paths with rg's glob filter instead. A revised PR description initially omitted the repository's three required context labels; the exact body now passes scripts/check-pr.mjs before publishing.


## November 7 S5-DATA-07 order-outcome import verification

Implemented restricted CSV ingestion path (pilot_order_outcome.v1) for venue owners, tenant-scoped RLS persistence across order_outcome_import_batches, order_outcome_lines, order_outcome_quarantine, and order_outcome_conflicts with append-only triggers, immutable published menu bundle revision verification, and strict isolation from diner observations and owner reports. All 188 contracts tests, 61 backend service and HTTP tests, and 29 pgTAP database assertions pass.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-08T12:22:36.990Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-08T12:29:44.200Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-08T12:35:17.101Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"lint","timestamp":"2026-11-08T12:40:54.175Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"typecheck","timestamp":"2026-11-08T12:41:09.350Z","exitCode":2}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"context:check","timestamp":"2026-11-08T12:42:43.238Z","exitCode":1}
```

## November 8 S5-DATA-07 PR #120 Review Corrections & Verification

During review remediation verification:
1. `test:db`: Real PostgreSQL test probes in `order-ingestion.integration.ts` initially used a sparse bundle mock missing mandatory `PublicMenuContentBundleSchema` dish fields (`price`, `ingredients`, `images`), causing expected validation rejection during ingestion. Added conformant bundle structure. pgTAP test plan in `tests/db/order_outcomes.sql` updated to 68 assertions verifying reviewer UUID audit provenance retention after membership removal (`migrations/20261108120000_pos_mapping_reviewer_provenance.sql`). All 9 pgTAP test suites (260 assertions) and all 6 integration suites (77 tests) pass.
2. `lint`: Import sorting and line wraps in `order-ingestion.integration.ts` and `service.ts` resolved via Biome format.
3. `typecheck`: `noUncheckedIndexedAccess` required safe indexing for `publishedActive[0]` in `service.ts`, and test `createApp` stubs required `execute` dummy property. Resolved in `service.ts` and `order-ingestion.integration.ts`.
4. `context:check`: Context module fingerprints updated for new contracts handoff fixtures and integration paths via `pnpm context:refresh`. All checks pass clean.

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-08T20:09:59.298Z","exitCode":1}
```

<!-- automatic observation; not root cause -->
```json
{"kind":"automatic-check-observation","check":"test:db","timestamp":"2026-11-08T20:11:32.256Z","exitCode":1}
```

## November 9 PR #120 Four Review Findings Resolution & Verification

During integration test expansion for PR #120 review findings:
1. `test:db`: Draft integration probe for inverted publication timestamps initially attempted an `UPDATE` on `app_private.venue_tracking_activations`, which failed due to the immutable activation trigger `enforce_venue_tracking_activation` (`Modifying venue tracking activation timestamp is prohibited`). Resolved by deriving relative monotonic event timestamps forward from the initial activation timestamp (`actDate`) without mutating historical activation records. All 10 pgTAP suites (281 assertions) and all 6 integration suites (84 tests) pass cleanly.
