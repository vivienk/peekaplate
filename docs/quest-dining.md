# Quest restaurant discovery and order requests

## Entry and sources

On an enabled build, Quest visits to `/` open the restaurant directory. Other browsers use `/?experience=quest` to review it; `?experience=menu` preserves the original fixture menu. Direct published-menu URLs and normal phone home are unchanged. Production requires explicit `VITE_DINING_ENABLED=true`; it is not enabled by this change.

Eleven locations across the three user-named brands are sourced from their official site JSON-LD on November 14, 2026: [Noka](https://nokaramen.com/), [Son & Garden](https://sonandgarden.com/), [Farmhouse Kitchen](https://farmhousethai.com/). The user-supplied [Noka QR menu](https://qr.codes/GMn9C8) resolves to a fourteen-page PDF. It is source material, not an approved PeekaPlate publication. Source addresses and coordinates live in `frontend/diner/src/dining/locations.json`; no invented owner ID, menu ID, dish photo or price is bound to them.

The self-hosted regional map uses seven western US state outlines from [Natural Earth admin-1](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_1_states_provinces.geojson), public-domain geographic data, filtered to the western states. It is an overview, not street navigation. Leaflet is pinned at stable 1.9.4. No geolocation, API key, external tiles or precise user location is requested. Map and restaurant list work in the Quest browser panel; immersive table viewing remains View Portion. This is not a fully immersive 3D restaurant-map scene.

## Receiving API

`VITE_DINING_API_BASE` is the complete trusted API prefix (for example an approved API origin plus `/public/dining`). When omitted the browser tries the same-origin `/public/dining` path. Static Pages has no such API and retains source-menu links and an explicit unavailable state. No fake successful submission is offered.

Backend routes under `/public/dining`:
- `GET /locations/:locationId/menu`: exact reviewed catalog for current published menu.
- `POST /locations/:locationId/orders`: bounded pickup request, no payment, return committed receipt.
- `GET /venues/:venueId/orders`: staff bearer authentication and tenant membership required; newest 100 requests. This is an inbox API, not a finished staff console UI.

Backend requires `DINING_ORDERING_ENABLED=true`, a native `DINING_RATE_LIMITER` binding and the normal database/auth configuration. Missing bindings fail closed. POST uses the trusted Cloudflare connecting IP for rate limiting; direct local requests need a trusted local adapter rather than exposing a spoofable forwarding-header service publicly. No real orders were sent during development.

Apply migration `20261114120000_dining_orders.sql` through the existing migration workflow. Onboard each location with its actual tenant/menu IDs in `dining_location`, disabled initially. Load a reviewed `DiningMenuSchema` catalog matching the currently published menu and its availability version and bind the exact publication UUID in `dining_catalog`. The catalog is private operator-managed configuration: never expose an unauthenticated catalog-write API. Validate the menu against the approved bundle, dish identities, prices, allowed pickup items and portion provenance. Only enable a location once staff can receive its inbox. No seed rows or fabricated memberships are included.

Submissions contain command UUID, publication UUID, availability version, dish/revision identities and quantities (1–20 per line, at most 20 unique lines). Server-owned catalog supplies prices. A retry of the unchanged command returns its original committed receipt; a changed payload with the same key conflicts. Receipt is unpaid/submitted and contains an order UUID for pickup, not restaurant acceptance. The cart remains on failure; retries reuse the command. Editing or switching restaurants creates a new command and restaurant switching clears the prior cart. Subtotal excludes unconfigured taxes/fees; no money is collected.

## Validation and remaining gates

Unit tests: `pnpm exec vitest run frontend/diner/src/dining/dining.test.ts backend/src/dining.test.ts`.
Browser flow: run the diner on 5175, then `pnpm exec playwright test --config playwright.quest.config.ts --workers=1`.
Browser ordering uses explicitly synthetic intercepted API responses. DB transaction tests use a query double; these do not establish PostgreSQL permissions, durability or concurrent locking. `pnpm verify test:db` needs Docker/PostgreSQL, unavailable on this host. Real venue/menu bindings, reviewed catalogs, staff receiving UI/integration, backend deployment and physical Quest/iPhone tests remain necessary before real service.

No production deployment, no restaurant submission and no payment were performed. Existing PR162 2.5D/Tripo/camera paths remain available; real dishes only get their own validated portion assets, never another restaurant's fixture photos.
