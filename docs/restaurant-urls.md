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

## Assign a restaurant link

After review and publication, add its approved locator to
[restaurant-links.json](../frontend/diner/public/config/restaurant-links.json):

```json
{
  "schemaVersion": 1,
  "restaurants": [
    {
      "slug": "example_bistro",
      "venueId": "11111111-1111-4111-8111-111111111111",
      "menuId": "22222222-2222-4222-8222-222222222222"
    }
  ]
}
```

The IDs above are fictional; the shipped directory is empty. Never add tokens,
credentials, drafts or restaurant facts. Slugs are unique, lowercase, 1–64
characters, begin/end with a letter or digit and allow hyphens/underscores.
Routing names including `assets`, `venues`, `owner` and `diner` are reserved.
Invalid IDs, duplicate slugs and extra fields fail closed. The route unit tests
validate the actual committed directory.

For this pilot slice, assignment is a reviewed config update and diner rebuild.
Automatic slug allocation, owner Copy link/QR and private preview are not added
here. The owner publish screen must hand off its published menu ID for enrollment;
Preview alone must not activate a public link. Keep that integration with the
screen's current owner rather than modifying their unfinished branch.

The directory is a public locator, not publication or tenant authority. The
existing public API still requires an approved current publication; the diner
verifies exact bundle bytes and identity before displaying dishes or using the
in-memory observation token. Unknown/withdrawn menus remain unavailable;
malformed/tampered data never falls back to fixtures. Query parameters cannot
override menu IDs or supply a token. Revisions under the same venue/menu keep
the link; a new menu ID needs a config update. Old unprefixed UUID links remain
supported on existing diner hosting.

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
404 page. JS/CSS and directory JSON are actual files under `/diner/assets/` and
`/diner/config/`; no external proxy, gateway Worker or new runtime is needed.
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
Restaurant enrollment and owner-button integration remain separate handoffs.

References: [Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[Pages routing](https://developers.cloudflare.com/pages/configuration/redirects/),
[Vite public base](https://vite.dev/config/shared-options.html#base),
[diner connection](diner-connection.md).
