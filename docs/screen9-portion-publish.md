# Screen 9 photo → reviewed 2.5D → published View Portion

Implementation: PR #219, based on #162 processing/rendering and the existing verified-dish
and operator-controlled prepared-menu pipeline. **No 3D generation is introduced.**

## Owner / authenticated flow

1. Upload a JPEG or PNG on S09. The original bytes are saved through the existing
   owner draft-photo API and remain private.
2. Select **Save photo and generate 2.5D**. The existing draft save preserves the
   selected photo ID and stays on S09. The console requests
   `POST /venues/:venueId/drafts/:draftId/photos/:photoId/portion`.
3. The Worker re-authorizes the signed-in staff actor, restaurant, active photo
   and draft, reads exact private R2 photo bytes and verifies SHA-256 and size.
   It then calls the server-only Python
   `/v1/portion-uploads/:draftId/:photoId` endpoint.
4. The Python process creates a bounded foreground WebP and background SVG,
   or retains the photo when segmentation fails. The Worker validates
   `PublicPortionSchema`, the private draft/photo identity, each layer SHA-256
   and byte count. It stores the layers and review manifest in private R2.
5. S09 retrieves the foreground with authenticated
   `GET .../portion/image`. The preview cannot be accessed as an anonymous
   public URL. The owner may select **Approve 2.5D preview**, which writes a
   separate source/hash-bound private approval record. A visual approval is not
   dish verification, menu publication or public hosting.
6. Replacing a photo changes the preview key and invalidates the old photo's
   eligibility. Removed drafts and another venue's photos fail authorization.

The current 2.5D preview shows the **actual generated cutout**, not a synthetic
2.5D fixture or 3D model. Diner camera/AR placement remains in PR #162.

## Private service configuration

The Worker requires server-side `PORTION_SERVICE_URL` (bare HTTPS origin)
and `PORTION_SERVICE_SECRET` (the extraction host's service bearer token).
The extraction host must be deployed with an absolute `PORTION_REVIEW_ROOT`
to mount the private portion endpoint. Its host already uses
`EXTRACTION_SERVICE_SECRET`; configure the Worker portion token to match the
host's secret. Do not expose these values via `VITE_*`, HTML, assets, docs or logs.

The service is **disabled until configured and deployed**. The owner UI retains
the photo fallback and reports service unavailability. No provider credits,
Tripo or billable 3D calls are involved.

## Approved publication handoff

Only after S10 verifies the dish and photo, and the approved `dish_current`
revision exists, does authenticated `GET .../portion/export` return the
exact private 2.5D layers. The endpoint rejects removed drafts, unverified
photos, absent owner artwork approval, and missing accepted revisions. The
exported photo must match the current revision's approved photo. A text-only
revision can reuse the artwork if it retains that photo. Replacing or clearing
the approved photo makes the old artwork ineligible for export.

The existing privileged producer now accepts optional arguments:

```bash
PEEKAPLATE_OWNER_TOKEN='<private staff token>' pnpm produce:bundle \
  --request /private/menu-request.json \
  --t0-root /private/verified-t0 \
  --owner-portion-api https://<staging-api-origin>/ \
  --portion-map /private/portion-map.json \
  --out work/menu-bundles
```

`portion-map.json` is an operator-provided JSON object with the exact venue
ID and entries like `{"dish_id":"<approved dish UUID>","draft_id":"<source draft UUID>","photo_id":"<approved photo UUID>"}`.

The producer checks that the authenticated export's dish/revision matches the
current database-approved source; validates human-approval evidence and the
original layer hashes; and rewrites the portion record to the **published dish
and revision UUIDs**. It writes immutable files under
`--out/assets/portions/<dish>/<revision>/<hash>/background.svg` and
`dish.webp`, plus the resulting bundle and handoff JSON.

**Operator hosting is still a required step:** upload the generated asset files
at the exact `asset_base_url/portions/...` HTTPS paths, with suitable MIME/CORS
headers, before running the same command with `--admit`. When the portion
mapping is used, admission checks every hosted public portion layer's exact
byte length and SHA-256 before registering the bundle. Do not bypass the
normal content/asset approvals, prepared-menu confirmation, or diner URL
publication. The newly prepared menu is not automatically published just
because the owner approved an image.

The published bundle already carries the revision-bound `portion` field;
`frontend/diner/src/menu/published.ts` maps it into the existing View Portion
and AR camera preview, with original-photo fallback for missing or invalid
portion assets.

## Acceptance and release gates

Required before claiming full staging readiness:

- An actual uploaded dish photo produces both private 2.5D layers; Screen 9
  previews the correct image, and the result survives refresh.
- The owner approves the visual; S10 independently verifies dish/photo facts.
- A trusted operator prepares/hosts/adopts the approved portion and publishes
  the admitted menu; the diner loads exactly the same approved layer bytes.
- Missing assets fall back to the original photo. Revision changes and
  cross-dish or cross-venue requests cannot reuse another image.
- Test failing segmentation, corrupted hashes, revoked sessions, unavailable
  service, stale menu snapshots, browser Back and camera placement on a phone.
- CI quality, unit, database and browser checks must pass before merging.

**Not yet claimed:** hosted processing-service rollout, an automatically
background-scheduled generation queue, entirely automated private-to-public
promotion, an actual authenticated staging round trip, physical-device AR
calibration or production release sign-off.
