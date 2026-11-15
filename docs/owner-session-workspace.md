# Owner session to restaurant workspace

This connects merged Auth #143/#146, owner shell #125/#139 and report reader #128
to the existing staff JWT and restaurant-membership boundary. It adds no account,
restaurant, grant, migration or deployment. The synthetic dashboard stays separate.

## Connected flow

1. Open `/owner-auth.html`, create/confirm an account or sign in. The Supabase SDK
   owns persistence and refresh. Signup does not grant restaurant access.
2. The console obtains a freshly verified SDK token **bound to that actor** and
   calls `GET /staff/venues`, without actor/venue query parameters.
3. The Worker verifies the staff JWT, reads only that actor's owner/editor
   memberships under runtime RLS, then reads each permitted name under its
   transaction-local tenant context. Membership locks last through the read;
   commit/rollback clears the local context. Nothing is written.
4. One restaurant opens directly; multiple restaurants require selection.
   No memberships shows **No restaurant access yet**, with retry and sign-out.
   Selection is navigation: later APIs still check current membership.
5. The existing shell shows the returned name/role, Overview and owner-only Dish
   performance. It invents no setup, verification, publication or activity status.
6. The report reader receives an explicit live source, server-returned venue and
   actor-bound token. It never falls back to a saved fixture. The report API still
   permits only its approved synthetic staging venue and labels that data; other
   venues can receive unavailable. Real analytics/AI are not enabled by this slice.
7. Sign-out/account changes clear the old workspace before identity restoration.
   In-flight requests are aborted or ignored. Report 401 returns to sign-in; 403
   reloads memberships and clears the report. A new actor cannot inherit the old
   restaurant selection or a late response.

## Endpoint and configuration

`GET /staff/venues` returns the strict shared contract:

```json
{
  "actorId": "11111111-1111-4111-8111-111111111111",
  "venues": [{
    "venueId": "22222222-2222-4222-8222-222222222222",
    "name": "Synthetic restaurant",
    "permission": "owner"
  }]
}
```

Only current owner/editor memberships are included. Viewer/absent/revoked
membership yields an empty list, never an automatic grant. More than 100
memberships fails unavailable rather than silently choosing from a partial list.
Missing/invalid identity is 401; unavailable infrastructure 503; no access 200
with `[]`; query parameters 400. Outside local/staging the endpoint is 404.

GET/OPTIONS CORS permits Authorization from exactly `http://127.0.0.1:5174` and
`https://peekaplate-console-staging.pages.dev`; there are no cookie/wildcard
preview grants. Responses are no-store. Existing restricted grants from the
applied staff/restaurant-link migrations suffice; no new SQL is needed.

Alongside the public Auth config in [owner auth](owner-auth.md), set:

```dotenv
VITE_PUBLIC_API_URL=https://peekaplate-api-staging.vxkong.workers.dev
```

The other accepted base is `http://127.0.0.1:8787`. Other origins/paths fail closed
before sending a bearer token. PR previews still force provider Auth off.
Production `.app` hosting/callbacks and `/owner` base routing remain separate.
The `.io` homepage is untouched.

## Next wiring order

1. **Merged pieces first:** #143/#146 Auth → this bridge → #125/#139 shell → #128
   report reader and existing report API. Validate this small connection first.
2. Review #156 (Ehab's menu client), #171 (Nifemi's details/intake/processing) and
   #172 (Jeffin's Add/Edit). Reviews can proceed in parallel. Once merged, pass
   the same actor-bound token getter to the menu client per request.
3. Add persisted restaurant-details/setup and authorised new-restaurant
   onboarding. Membership cannot establish verification or let a signup claim an
   existing business; this slice does not implement restaurant registration.
4. Wire #163's real review/approval/publication path. Display the full returned
   diner URL only after successful publication, with copy/share. Preview/Save do
   not publish. See [automatic restaurant links](restaurant-urls.md).
5. Close one manual-dish journey, then upload/extraction, with actual draft/photo
   save/reload, stale-version and denial checks. Provider/Queue testing needs its
   separately approved staging window.
6. Diner: published URL → public locator → verified approved menu. Review
   #126 → #127 for comparison controls. Capture approved events at both PostHog
   and canonical storage, reconcile the owner report and finish DATA-12/QA.

On a future staging release owners will sign in, choose an authorised restaurant
and see connected workspace/report states. Menu setup remains unavailable until
the next screen/API connections are released. Diners open published menus without
signing in. This bridge activates no new diner controls or normal collection.

## Verification boundary

The initial HTTP regression reproduced the missing endpoint (404 instead of its
authenticated response). Local tests cover HTTP/contracts/token/client behavior,
restricted runtime RLS, real workerd with signed synthetic JWTs, and the real
browser SDK against synthetic provider/API HTTP. Browser cases include selection,
report access, no membership, editor limits, revocation, expiry, late responses,
cross-tab changes and accessibility. Additional cases exercise an expired SDK
session refreshing its token and a delayed identity response arriving after
another tab signs out. Exact counts/durations belong in the PR.

These checks do not establish a hosted release or complete onboarding/upload/
publish/report journey. Hosted acceptance must verify the released API/console,
genuine staff sessions, allowed/blocked origins and revocation. The local suite
changes no hosted permissions, accounts, provider settings or Queue state.
