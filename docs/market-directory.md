# Night Market restaurant discovery

`GET /public/restaurants?after=<venue UUID>` returns schemaVersion 1, restaurants
with venueId/menuId, and nextCursor (nullable). Pages contain at most 64 venues;
65 rows are read to detect a next page. UUID keyset order is a discovery scan,
not an event-consumption cursor. Clients restart scans to discover new entries.
One currently published menu per venue is chosen deterministically by menu UUID.
Drafts, withdrawn publications and private venue fields are excluded. Names and
menus must come from the existing byte-verified published bundle API. The list
is a locator, not proof that a bundle is still available at time of display.

This intentionally adds public discovery to the existing public-link behavior.
The restricted SECURITY DEFINER function reads only publication scope/status,
pins search_path, returns no tokens, and grants no runtime table bypass.
Publication commands and original events are unchanged.

Apply migration 20261116010000 and deploy the Worker together before activating
the game. Set MARKET_PUBLIC_ORIGIN to the exact HTTPS game origin for public GET
CORS only. This does not enable staff or observation CORS. Bundle storage must
also permit reads from that origin. No wildcard Vercel domain is allowed.

The XR consumer polls every 60 seconds during exploration, revalidates content
on opening, preserves existing storefront positions and clears withdrawn menus.
Its initial capacity is 64 live restaurants across the three expandable districts.
Cuisine art is inferred presentation from approved text, not an approved fact.
No ordering, payment or generated dish models are added to live menus.

Local API and synthetic browser tests do not establish hosted acceptance.
Live activation requires the migration, Worker deployment, exact origin and
bundle CORS, and an actual approved publication. As of this implementation,
the deployed staging directory returns 404; no backend resources were changed.

Verification: focused API suite 17 tests passed; workspace typecheck and lint
passed. All SQL lanes passed, including eight directory assertions. The later
real-Worker/database integration stage timed out at the harness 120-second limit;
full database suite is therefore FAIL, not accepted. No hosted changes made.
Architecture and correctness reviews of 80e27743 found no supported defects.
