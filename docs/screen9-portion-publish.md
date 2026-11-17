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
4. The Python process creates a bounded foreground WebP and background SVG.
   If segmentation fails, the console falls back to the stored original. The
   processor's temporary copies are removed after the request. The Worker validates
   `PublicPortionSchema`, the private draft/photo identity, each layer SHA-256
   and byte count. It stores the layers and review manifest in private R2.
5. S09 retrieves the foreground with authenticated
   `GET .../portion/image`. The preview cannot be accessed as an anonymous
   public URL. The owner may select **Approve 2.5D preview**, which writes a
   separate source/hash-bound private approval record. A visual approval is not
   dish verification, menu publication or public hosting.
6. Replacing a photo changes the preview key and invalidates the old photo's
   eligibility. The private routes reject removed drafts, rejected photos and
   photos from another venue.

When configured, the existing rejected-photo retention period and orphan grace
period apply to private R2 layers, manifests and approvals. The cleanup checks
the tenant, draft, photo ID, source hash and age of the artifact files. It removes
the approval and manifest before their layers. Files for verified or unverified
source photos are retained, including promoted photos and photos from removable
drafts that can still be restored. The staged-original retention setting applies
only to originals.

The current 2.5D preview shows the **actual generated cutout**, not a synthetic
2.5D fixture or 3D model. Diner camera/AR placement remains in PR #162.

## Private service configuration

The Worker reuses the existing server-side `EXTRACTION_SERVICE_URL` and
`EXTRACTION_SERVICE_SECRET` when neither dedicated portion setting exists.
An explicit `PORTION_SERVICE_URL` (bare HTTPS origin) and
`PORTION_SERVICE_SECRET` pair may override that destination; a partial pair
fails closed. Do not expose these values via `VITE_*`, HTML, assets, docs or logs.

The service is **disabled until configured and deployed**. The owner UI retains
the photo fallback and reports service unavailability. No provider credits,
Tripo or billable 3D calls are involved.

The existing extraction Worker forwards only the authenticated portion-upload
route to its existing container. It passes a private scratch root; the image
installs the locked `service` and `cutout` extras and includes the
checksum-verified U2NETP model, readable by its non-root runtime. Each request
removes its temporary directory. Input is bounded to 12 MB, the response to
300 KB, and the complete request/body deadline to 220 seconds. The existing
two-attempt paid extraction budget is unchanged; cutout generation is CPU-only.

A failed generation can be retried with the same saved photo. Only successful
review manifests are reused; ordinary field edits do not start another request.
Verify a real opaque-photo request on the deployed host before claiming hosted
generation acceptance.

## Approved publication handoff

Only after S10 verifies the dish and photo, and the approved `dish_current`
revision exists, does authenticated `GET .../portion/export` return the
exact private 2.5D layers. The endpoint rejects removed drafts, unverified
photos, absent owner artwork approval, and missing accepted revisions. The
exported photo must match the current revision's approved photo. A text-only
revision can reuse the artwork if it retains that photo. Replacing or clearing
the approved photo makes the old artwork ineligible for export.

S13 preparation reuses `exportApprovedPrivatePortion`, the approved-portion
validator and the existing bundle producer. It binds each approved visual to
the verified source photo and canonical dish revision. Missing approval leaves
the ordinary photo fallback; malformed approved artifacts block preparation.
No second producer or public upload store is introduced.

The existing prepared-menu asset route serves the hash-verified layers only
when the exact content/asset snapshot is published. Editing a draft or preparing
a later revision does not remove the previous publication's assets. Withdrawal,
revoked visual approval, corrupt bytes or a mismatched tenant fail closed.
New preparation still requires the current verified draft/photo/revision.

The existing operator CLI remains available for its separate explicit handoff:

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

**For the operator CLI path**, upload the generated asset files
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
- S13 prepares the approved portion, previews and publishes the admitted menu;
  the diner loads exactly the same approved layer bytes through the existing
  published asset route. The operator CLI has its own explicit hosting step.
- Missing assets fall back to the original photo. Revision changes and
  cross-dish or cross-venue requests cannot reuse another image.
- Test failing segmentation, corrupted hashes, revoked sessions, unavailable
  service, stale menu snapshots, browser Back and camera placement on a phone.
- CI quality, unit, database and browser checks must pass before merging.

Local evidence includes a real non-root Linux container request with networking
disabled: one opaque synthetic JPEG produced two validated layers in 41 seconds,
with no provider call and no scratch files remaining. Database regressions cover
preparation, corruption, revocation and preservation of the previous publication
while a draft is edited. This is local evidence, not hosted acceptance.

**Not yet claimed:** the new hosted processing-service rollout and authenticated
round trip, automatic background generation, physical-device AR calibration or
production release sign-off. This owner path publishes approximate 2.5D; serving
count alone never authorizes actual-size placement.
