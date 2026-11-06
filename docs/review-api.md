# Review API and correction persistence (S3-RES-01.2)

Candidate schema, fixtures and export semantics are documented in [review-candidates.md](review-candidates.md); this page covers the staff review endpoints built on them.

The review persistence service exposes tenant-scoped endpoints in `@peekaplate/backend` for registering extraction sessions, reading candidate review projections, and saving reviewer corrections.

All endpoints require a valid staff JWT Bearer token with `owner` or `editor` permissions on `:venueId`. Requests from viewers, non-members, or actors belonging to another venue are rejected with `403 {"error":"forbidden"}`. PostgreSQL enforces `FORCE ROW LEVEL SECURITY` across `app_private.extraction_review_session` and `app_private.candidate_review_current`.

### 1. Register Review Session (`PUT /venues/:venueId/extractions/:extractionId/review-session`)

Registers or idempotently loads an immutable S3-RES-01.1 extraction snapshot. Accepts up to 512 KB payload size.

**Originals are bound to the producer's stored attempt.** Outside `APP_ENV=local`, the request must
carry `jobId` and `privateArtifactRef` (the `private_review_artifact` the extraction host returned).
The server reads `menu-ingestion/review-artifacts/{venueId}/{jobId}/{attempt}/bundle.json` from the
private `INGESTION_REPORTS_BUCKET`, checks its SHA-256 and stored scope, and requires the source,
versions, status, start time and every candidate's `original` and `evidence` to equal the bundle
report's `drafts`/`evidence` (a report `null` equals an omitted exported field). Page coverage and
diagnostics are bound too: every report segment in order (status, error, text, metadata), and the
report's `warnings` and `errors`. The only permitted difference is the exporter-added
`metadata.candidate_box_evidence`, which must equal the links the exporter derives from the report's
evidence box records. A reviewer therefore cannot register originals the producer never emitted or
hide failed and skipped pages. Locally the reference stays optional for
fixture journeys; a supplied reference is still verified.

The command identity includes the canonical extraction SHA-256, so reusing a `commandId` with a
different extraction returns `409 command_conflict`. Command receipts store a compact reference
(`extractionId`, `payloadSha256`); an identical retry is rebuilt from the stored append-only session.

```bash
curl -X PUT "$API_ORIGIN/venues/f47ac10b-58cc-4372-a567-0e02b2c3d479/extractions/extraction:e1bb4c9c059eb377dc7e92f340e78416/review-session" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "commandId": "c11ac10b-58cc-4372-a567-0e02b2c3d479",
    "extractionResult": { ... }
  }'
```

Response (`200 OK`):
```json
{
  "schemaVersion": 1,
  "venueId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "extractionResult": { ... },
  "items": [
    {
      "candidate": { ... },
      "review": {
        "extractionId": "extraction:e1bb4c9c059eb377dc7e92f340e78416",
        "candidateId": "draft:0bbe00087c6841623c76d7b6f9da5ebf",
        "revisionId": null,
        "version": 0,
        "reviewStatus": "pending",
        "corrected": {},
        "editedFields": [],
        "incompleteFields": [],
        "reviewNote": null,
        "reviewedBy": null,
        "reviewedAt": null,
        "publishable": false
      },
      "effective": {
        "name": "Garden Soup",
        "description": null,
        "category": "FOOD",
        "subcategory": "SOUPS",
        "category_page_number": 1,
        "price_text": "8.50 / 12.50 CAD",
        "price_amount": null,
        "price_currency": "CAD",
        "ingredients": null
      }
    }
  ],
  "privateArtifactRef": null,
  "published": false
}
```

### 2. Get Candidates and Review State (`GET /venues/:venueId/extractions/:extractionId/candidates`)

Fetches the extraction result along with each candidate's immutable original, current review status, and resolved effective values.

```bash
curl -X GET "$API_ORIGIN/venues/f47ac10b-58cc-4372-a567-0e02b2c3d479/extractions/extraction:e1bb4c9c059eb377dc7e92f340e78416/candidates" \
  -H "Authorization: Bearer <jwt>"
```

Response (`200 OK`): Returns `ExtractionReviewSessionResponse` as shown above.

### 3. Save Candidate Review (`POST /venues/:venueId/extractions/:extractionId/candidates/:candidateId/review`)

Applies reviewer actions (`correct`, `reject`, or `mark_incomplete`) with optimistic concurrency (`expectedVersion`) and idempotency (`commandId`). Maximum request size is 16 KB.

Omitting an optional field keeps its previous value; an explicit value replaces it, and `"reviewNote": null` clears the note. The command identity is a canonical hash that records whether each of `corrected`, `incompleteFields` and `reviewNote` was supplied. Reusing a `commandId` with different field presence (for example, omitted note vs. `null`) therefore returns `409 command_conflict`; only an identical retry replays the stored receipt.

#### Example A: Correction Command
```bash
curl -X POST "$API_ORIGIN/venues/f47ac10b-58cc-4372-a567-0e02b2c3d479/extractions/extraction:e1bb4c9c059eb377dc7e92f340e78416/candidates/draft:0bbe00087c6841623c76d7b6f9da5ebf/review" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "commandId": "e11ac10b-58cc-4372-a567-0e02b2c3d479",
    "expectedVersion": 0,
    "action": "correct",
    "corrected": {
      "name": "Organic Garden Soup",
      "price_amount": "9.50"
    },
    "reviewNote": "Verified portion price with chef"
  }'
```

Response (`200 OK`):
```json
{
  "candidate": {
    "candidate_id": "draft:0bbe00087c6841623c76d7b6f9da5ebf",
    "original": {
      "name": "Garden Soup",
      "price_amount": null
    }
  },
  "review": {
    "extractionId": "extraction:e1bb4c9c059eb377dc7e92f340e78416",
    "candidateId": "draft:0bbe00087c6841623c76d7b6f9da5ebf",
    "revisionId": "b11ac10b-58cc-4372-a567-0e02b2c3d479",
    "version": 1,
    "reviewStatus": "corrected",
    "corrected": {
      "name": "Organic Garden Soup",
      "price_amount": "9.50"
    },
    "editedFields": ["name", "price_amount"],
    "incompleteFields": [],
    "reviewNote": "Verified portion price with chef",
    "reviewedBy": "a11ac10b-58cc-4372-a567-0e02b2c3d479",
    "reviewedAt": "2026-10-30T12:00:00.000Z",
    "publishable": false
  },
  "effective": {
    "name": "Organic Garden Soup",
    "price_amount": "9.50"
  }
}
```

#### Example B: Mark Incomplete Command
```bash
curl -X POST ".../candidates/draft:0ff0863ef48b2db591694fcc3c35fbb0/review" \
  -d '{
    "commandId": "e12ac10b-58cc-4372-a567-0e02b2c3d479",
    "expectedVersion": 0,
    "action": "mark_incomplete",
    "incompleteFields": ["price_amount", "description"],
    "reviewNote": "Confirm espresso cup vs mug pricing"
  }'
```

#### Example C: Reject Command
```bash
curl -X POST ".../candidates/draft:6dbe8d78dae3c41e819deed5267f8149/review" \
  -d '{
    "commandId": "e13ac10b-58cc-4372-a567-0e02b2c3d479",
    "expectedVersion": 0,
    "action": "reject",
    "reviewNote": "Complimentary bread basket, not a dish"
  }'
```

## Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` / `invalid_json` | Body or path fails the contract, or `extraction_id` differs from the path. |
| 400 | `artifact_required` | Outside local, `jobId` and `privateArtifactRef` are missing. |
| 400 | `invalid_candidate` | Artifact key outside `{venueId}/{jobId}`, a v1 session corrected with v2-only fields, or one review request listing a field in both `corrected` and `incompleteFields`. |
| 401 / 403 | `unauthorized` / `forbidden` | No valid staff token, or not an `owner`/`editor` of the venue. |
| 404 | `not_found` / `artifact_not_found` | Unknown session or candidate; or no stored bundle under the key. |
| 409 | `artifact_mismatch` | Stored bundle hash, scope, source, any candidate original/evidence, any segment (count, order, status, error, text, metadata, box links) or the warnings/errors differ. |
| 409 | `version_conflict` / `command_conflict` / `extraction_conflict` | Stale `expectedVersion`; reused `commandId` with a different request; same extraction id with different content. |
| 413 / 415 | `body_too_large` / `unsupported_media_type` | Over 512 KB (session) or 16 KB (review); non-JSON body. |
| 503 | `artifact_unavailable` / `service_unavailable` | Bucket binding or database configuration missing. |

## Notes

- `GET …/candidates` is limited to `owner` and `editor`; viewers are denied by design.
- Corrections merge into earlier corrections; a field cannot be cleared back to its original in this
  version. Re-correct it to the original value if needed.
- A field is never both corrected and incomplete. Marking a previously corrected field incomplete
  (`correct` or `mark_incomplete` with `incompleteFields`) withdraws that correction, so its
  effective value falls back to the original; `editedFields` always equals the sorted keys of
  `corrected`.
- `streamId` is a deterministic UUID-shaped id derived from SHA-256 of the tenant, extraction and
  candidate (version and variant nibbles set), not an RFC 4122 v5 UUID.
- Saving or reloading review state never approves or publishes; publication remains RES-02.
- Measured offline: 83 real Patis menu items exported by the RES-01.1 exporter produce an 86,427-byte
  candidates document (≈1.04 KB per candidate without box evidence), well inside the 512 KB cap.
