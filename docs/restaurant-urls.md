# Restaurant menu URLs

Prepared production layout, following the selected domain split:

| Address | Purpose |
| --- | --- |
| `peekaplate.io/` | Existing marketing homepage; untouched |
| `peekaplate.app/diner/noka_ramen` | Assigned restaurant's published menu |
| `peekaplate.app/diner/venues/{venueId}/menus/{menuId}` | Canonical menu link |
| `peekaplate.app/owner/` | Reserved for the owner console; not connected here |

`noka_ramen` is an example, not an enrolled restaurant. These are paths, not DNS
subdomains. This preparation changes no hosting, DNS, accounts or live resources.
The production domain is not connected yet. Netlify is not part of app hosting.

## Automatic link on publication

The existing owner-only publication command allocates a permanent restaurant
link in the same database transaction as the event, projection, command receipt
and outbox. No directory edit or diner rebuild is needed for each restaurant.
The first publish uses a URL-friendly seed from the server-owned venue name:
Noka Ramen becomes noka_ramen. A globally unique database constraint and bounded
collision suffix allocation handle duplicate names and concurrent publications.
Names without ASCII letters/digits use restaurant; reserved routing words get
a restaurant_ prefix. Links remain unchanged on retry, rename and republish and
are never recycled after withdrawal. Failed publication rolls allocation back.

The seed is routing metadata, not an approved restaurant fact. The diner still
displays only restaurant.name from the approved, byte-verified bundle. The
immutable relational link setting survives publication projection replay;
existing v1 publication events and command-receipt JSON stay unchanged.

POST /venues/:venueId/menus/:menuId/publications returns the existing v1 JSON,
plus a Location header containing the environment-specific full diner URL.
GET /venues/:venueId/menus/:menuId/diner-link requires a current owner session
and returns {path, url}. The new endpoint never accepts an owner-supplied slug,
origin, venue authority or menu token. An old pre-feature publication needs a
new publish command before it receives a link; old command retries stay effect-free.

The diner resolves /diner/:slug through GET /public/restaurants/:slug. A bounded
security-definer lookup returns only the published venue/menu IDs; the existing
public reader, token issuance, exact-byte hash and identity checks remain the
content authority. Missing/withdrawn links return 404. There is no list endpoint,
draft fallback, cross-tenant write or browser database credential.

The production URL origin is https://peekaplate.app. Staging explicitly uses the
isolated routing-staging Pages branch configured by DINER_PUBLIC_ORIGIN. Only
that exact extra staging origin receives public-read CORS; production does not.
The existing root-based staging site and .io marketing homepage stay separate.

The current console has no real publication HTTP caller. The owner-review screen
in PR #163 must use the existing publication API and show its returned Location
or diner-link URL. Its synthetic Preview button must not claim publication or
allocate a link. This backend feature does not merge that unfinished screen.

## Build the Cloudflare Pages artifact

Use the approved environment's API URL and `VITE_MENU_SOURCE=live` to build the
diner with `/diner/` as its Vite base:

```sh
pnpm --filter @peekaplate/diner exec vite build --base=/diner/ --outDir ../../work/diner-prefixed
pnpm prepare:app-site --diner work/diner-prefixed --output work/app-site
```

The output path must be new. The assembler refuses to overwrite an existing
homepage/output, rejects source/output overlap and artifact symlinks, then copies
the diner under `diner/`. It adds bounded Pages menu-path rules and a generic
404 page. JS/CSS are actual files under `/diner/assets/`; no external proxy,
gateway Worker or new runtime is needed.
Do not deploy a partial output after an assembly error.

The shell rewrite target is outside `/diner/` to avoid Pages clean-URL loop
detection. Rules match only menu-shaped paths, not every diner asset. The branded
URL stays in the address bar. Root and `/owner/` return 404 in this diner-only
preparation; no fake console or new production landing page is supplied.

Keep the existing root-based staging projects unchanged. First test this artifact
with the approved staging API and synthetic menus in a controlled Pages staging
candidate. A production artifact must use separately approved production
API/resources, never the staging database by default. No production resources
are provisioned here.

## Domain and owner handoff

Our existing Cloudflare account has Workers/Pages deployment access. Static
Pages hosting does not need a new Netlify subscription or another paid worker
just to serve these files. The Workers Paid base is account-wide; provider,
storage and usage charges remain separate.

Before connecting the bare `peekaplate.app` domain, add it as a Cloudflare zone,
verify/copy existing DNS records including Resend email records, then have its
registrar operator apply the **two nameservers actually assigned by Cloudflare**
in Porkbun. Keep registration at Porkbun. Do not guess nameservers or remove
SPF/DKIM/DMARC/MX records. Deployment OAuth access does not establish DNS/zone
permission; verify that independently. Leave DNS unchanged until the reviewed
staging candidate and cutover are approved.

Then associate the domain through the Pages project's Custom domains flow and
verify HTTPS. No `peekaplate.io` DNS or marketing configuration is needed.
The prepared API allowlist adds exactly `https://peekaplate.app` for diner reads
and observations. Existing token/venue/publication checks stay unchanged;
staff/report origins are not changed here.

`/owner/` is reserved only. After auth/dashboard readiness, align the console's
asset base, navigation, exact email confirmation/reset URLs and staff/report
CORS before including its output. Current auth/staging URLs are unchanged.
Record actual deployed SHAs, domain/TLS, valid/tampered/withdrawn menu results,
consent and both tracking destinations before production acceptance. Roll back
to the previous approved Pages/API versions if necessary.

## Verification boundary

```sh
pnpm exec vitest run frontend/diner/src/menu/route.test.ts backend/src/public-menu.test.ts frontend/diner/src/menu/published.test.ts
node --test scripts/prepare-app-site.test.mjs
pnpm exec playwright test --config playwright.restaurant-links.config.ts
pnpm check
pnpm verify build
```

The isolated browser lane builds the real diner artifact and runs it through
Wrangler's local Pages server. API/bundle responses are intercepted synthetic
fixtures. It checks assets, refresh, canonical and restaurant paths, unknown
links and tampered/withdrawn responses. It does not establish hosted publishing,
production DNS/TLS, real PostHog/Queue delivery or owner-console acceptance.
Owner-button integration and production domain activation remain separate handoffs.

Local preparation results: eight Pages/Chromium cases passed in 5.9 seconds;
38 existing diner state/integrity/refresh/tracking cases passed in 29.4 seconds.
The disposable database run passed 310 SQL assertions and 138 Worker/database
tests, plus the local command smoke. Workspace builds pass with the Worker in
dry-run mode. These results retain the hosted limitations above.

References: [Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[Pages routing](https://developers.cloudflare.com/pages/configuration/redirects/),
[Vite public base](https://vite.dev/config/shared-options.html#base),
[diner connection](diner-connection.md).
