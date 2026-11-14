# Owner-report staging access

The report API and its CORS rule are a narrow staging release of the reviewed
owner-report implementation and [PR 130](https://github.com/vivienk/peekaplate/pull/130).
The extraction/upload release in PR 118 and frontend deployments are separate.

## Request flow

Console sign-in → Supabase staff access token →
`GET /api/v1/venues/:venueId/analytics/dishes?source=synthetic` → current owner
membership check → tenant-scoped, read-only PostgreSQL query → privacy-filtered report.

The browser may call from exactly:

- `https://peekaplate-console-staging.pages.dev`
- `http://127.0.0.1:5174`

GET and OPTIONS preflight allow the `Authorization` header. There are no wildcard,
preview-origin or cookie-credential grants. Other API routes retain their existing
origin rules. CORS grants browser readability; it never grants restaurant access.

This endpoint uses a Supabase application session, **not** a GitHub collaborator
token, database password or service-role key. Use normal owner sign-in; never
commit or share access tokens. The dashboard's sign-in/UI connection has its own
acceptance checks.

## Deliberate staging limits

The sole reportable venue is the labelled synthetic fixture
`00000000-0000-4000-8000-000000000123`, selected by the server's allowlist and
`SYNTHETIC_REPORT_VENUE_ID`. A query parameter cannot enable another venue.
The operator must verify that this venue contains only synthetic test evidence.
`source=synthetic` labels a report; it does not anonymize real events.

| Response | Meaning |
| --- | --- |
| 200 | Valid staff session, approved synthetic venue and current owner membership |
| 401 | Missing or invalid staff token |
| 403 | Valid identity lacks owner membership for the approved venue |
| 503 | Production, missing/duplicate/wrong source, unconfigured or nonallowlisted venue |

The query covers the previous 24 hours. Metrics retain ten-session privacy floors,
complementary suppression and internal cohort stripping. An empty fixture can
return an empty dish list. Freshness is not certified by a successful response.
Production reports remain disabled.

## Console report connection

PR 128 adds the report reader and validated screen states. With API/venue settings,
the caller must supply a genuine owner-session token; the default token getter is
still a sign-in integration seam and returns no token. PRs 143/146 remain separate.
Without those settings the preview uses a clearly labelled saved synthetic report.
Switching source, venue, API or token getter clears retained values before the next
screen commit; a late response cannot replace the currently selected report.
Browser tests intercept requests with a stand-in token. They verify rendering and
failure handling, not hosted authentication, provenance or DATA-12 acceptance.

## CSV export

`GET /api/v1/venues/:venueId/analytics/dishes/export?source=synthetic` exports the
same privacy-filtered owner aggregates. It retains the JSON route's current-owner,
exact-origin and approved-synthetic-venue checks. The response is a no-store CSV
attachment; it contains no raw observations or internal eligible-session counts.
Every metric has a value and a status column. `NORMAL` and `VALID_ZERO` values are
retained, including a literal `0`; suppressed, missing and unmeasurable values stay
blank with their original status. Dish names are CSV-quoted and direct formula
prefixes are escaped. Empty reports produce only the fixed header row.

The CSV path has local route/serializer coverage. It has not been deployed or
accepted on hosted staging by this PR; the existing hosted JSON report evidence
does not certify CSV downloads or spreadsheet application behavior.

## Release and verification

Deploy an exact reviewed main commit to the existing staging API Worker only,
following ADR 0012. Preserve resource bindings and existing secrets. Use
`wrangler deploy --env staging --keep-vars` for the documented operator route;
compare non-secret bindings and secret names before/after. Both observation and
menu queues must retain their paused state. This release needs no new migration,
resource, subscription or extraction-service deployment.

Local evidence includes signed-JWKS auth tests, exact-origin CORS tests, owner
report/contract tests, and disposable PostgreSQL/Worker checks for owner access,
nonowner/cross-tenant denial, revocation and privacy suppression. Hosted verification
must additionally check allowed/blocked origins, genuine staff-session access,
membership denial and unchanged provider bindings. Record the exact main SHA,
Worker version, measured checks and any gaps in the release PR before announcing
hosted readiness. The [release PR 135 deployment comment](https://github.com/vivienk/peekaplate/pull/135) is the current hosted evidence;
local checks alone do not establish it.
