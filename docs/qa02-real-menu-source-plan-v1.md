# QA-02 real-menu source plan v1

**Version `qa02-real-menu-source-plan/1.0.0-proposed` — PROPOSED, NOT APPROVED.**
Prepared 2026-11-14. Machine-readable counterpart:
[`processing/eval/qa02/source-plan-v1.json`](../processing/eval/qa02/source-plan-v1.json)
(schema `qa02.source-plan.v1`). Scorer half of the handoff:
[`processing/eval/qa02/STRICT_SCORER.md`](../processing/eval/qa02/STRICT_SCORER.md).

This plan selects sources and pages and records their provenance, exposure, rights status and
proposed split. It is **not** a `qa02.manifest.v1` manifest, **not** a frozen reference, **not**
gold answers and **not** an accuracy result. The authoritative acceptance semantics are the
published strict-scorer specification:
[`docs/qa02-strict-scorer-spec.md`](qa02-strict-scorer-spec.md) (ClickUp page
[2114](https://app.clickup.com/90141746115/docs/2kydvry3-3554/2kydvry3-2114)).
Native work packages under VIS-04 are
[source preparation](https://app.clickup.com/t/86bd3h93x) and
[scorer preparation](https://app.clickup.com/t/86bd3h93z); both are preparation only.
Every numerical quality threshold, source minimum and release decision remains Vivien's
separate sign-off.

## 1. What is fixed and what is not

| Item | State |
| --- | --- |
| Development source selection, filenames, pages, SHA-256 | Proposed here; byte evidence exists; human review pending |
| Candidate held-out PDFs | Metadata-only proposal; **not certified** unseen holdouts |
| Source-only reference answers | **Not authored, not reviewed, not frozen** |
| Scorer CLI and run-ledger shape | Implemented offline field scorer; see PR181 for the exact code pin and observed verification, not quality acceptance |
| Menu-specific threshold mapping / sample sufficiency | Pending Vivien and independent reviewers; existing rubric v0.4 criteria remain unchanged |
| Rights / retention permission | **BLOCKED** — public availability is not an evaluation licence |
| Hosted intake routes | **NOT RUN** — no authenticated venue, deployment, queue or approval |

SHA-256 values prove byte identity and container format only. They do not prove source truth,
transcription completeness, rights, reviewer independence or that a source was never seen.

## 2. Pilot shape and coverage limits

| Split | Sources | Selected pages | Input routes |
| --- | --- | --- | --- |
| Development initial set | 4 | 5 | image (photo), PDF |
| Development stress | 1 | 35 | PDF (over hosted page limit) |
| Candidate held-out | 2 | 4 | PDF upload, direct-PDF URL |
| **Overall proposed pilot** | **6** | **9** | **image (photo), PDF, URL** |

The overall pilot spans photo, PDF and URL routes and meets the earlier proposed file-level
three-source/three-route minimum. The candidate held-out portion is narrower: two PDF families,
one uploaded and one acquired by URL, with **no unseen photo coverage**. Reviewers must decide
whether its population and eligible-fact counts meet the agreed rubric; this proposal makes no
statistical-power or held-out acceptance claim. Never pool development results as held-out quality.

## 3. Initial development set

All four are previously inspected, collected or exposed. None may be promoted to holdout.

| ID | Source / family | File | Pages | SHA-256 | Bytes | Dimensions |
| --- | --- | --- | --- | --- | --- | --- |
| `dev-galaxie-photo-p1` | Galaxie Diner — original camera photo (user-supplied) | `img1_galaxie_diner_phone.jpg` | 1 of 1 (single frame) | `922858bf17dfbc9b5b330eec23c4a59cf48c47e83de9ddae3b01d0e2f9586f7b` | 3,573,722 | 2448×3264 px, JPEG |
| `dev-casa-photo-p1` | Casa D'Angelo — single WebP menu image (user-supplied) | `casaDangello-all.webp` | 1 of 1 (static frame) | `470b24a54044ec460cdf7cc5b82034386aeb75dc95337c08f6d268b869543960` | 172,488 | 765×1020 px, WebP |
| `dev-panania-pdf-all-2-pages` | Siding Bistro, Panania Diggers — first-party PDF | `panania.pdf` | 1–2 of 2 (all) | `bf42cf066aaf24ee41a20498abe0bbda9bf834f71953ef239e63081c01008896` | 3,339,944 | A2 (1683.75×1190.25 pt) each page |
| `dev-twin-city-pdf-all-1-page` | Twin City Hotel — first-party PDF | `twin-city.pdf` | 1 of 1 (all) | `3693c0ba9e3ed8b760d0eaf34528a7223f462bfc899f0fdba9d41e1d3bac92ea` | 678,722 | A3 (1190.16×842.16 pt) |

Public acquisition provenance (dates only; header captures stay in private artifacts):

- Panania: `https://pananiadiggers.com.au/wp-content/uploads/2026/07/Updated-Menu-2026.pdf`, first retrieved 2026-11-14T14:13:38Z.
- Twin City: `https://twincityhotel.com.au/wp-content/uploads/2026/09/Twin-City-Main-Menu-26.pdf`, first retrieved 2026-11-14T14:13:40Z.
- Galaxie and Casa originals are user-supplied; their original acquisition URLs/dates are not recorded in the existing source inventory.

Exposure that makes these development: Galaxie and Casa were previously rendered/inspected and
included in historical extraction runs (Galaxie17/Casa78 saved candidates; 95 combined
Galaxie/Casa candidates). Panania page 1 was rendered/inspected and its text extraction checked
at collection. Twin City page 1 was rendered/inspected at collection; its PDF has no text layer,
so prices are visible only in the render. That absent text layer is a source property, not a
metadata-only inference.

Casa note: the WebP is a single static frame and is treated as the complete source, not a
truncated page. WebP is **not** an accepted hosted upload type. Any JPEG/PNG derivative needs its
own SHA-256, its own derivative source-family declaration and separate review approval before
use. It cannot inherit the original hash or identity and must remain in the same development source family/split.

## 4. Development stress and reserve

**Denny's** (`Dennys_Menu.pdf`) is separate development stress, not a truncated success:
35 of 35 pages, 7,187,184 bytes, SHA-256
`2430807aeb2556cd85186b1b0d4126a89cee066dea3ccf5ad18b5e23b5082275`, 684×918 pt. Its 35 pages
exceed the hosted 1–10 page PDF limit, so a full-file local evaluation is **not** hosted
full-PDF acceptance.

Reserve is development material only and is **never** holdout. Batch A/B holds ten old PDFs in
total; two are the selected development cases above and eight remain reserve:

| File | Family | SHA-256 | Pages | Bytes |
| --- | --- | --- | --- | --- |
| `fiftysix.pdf` | Fiftysix, The Shellharbour Club | `c833802e57fbe4b45ce97fb4595e1bbfa51f1c2c556091aa75ecc1eb0aaa4f74` | 2 | 709,947 |
| `pastoral.pdf` | Pastoral Hotel | `8e3a82d7c317cf03bbef56e591001832a023c0360a3741783d200799ded06825` | 2 | 806,774 |
| `whitebull.pdf` | Whitebull Hotel | `45901f1e7e1635685b65e18c98c967008a43a19dc81168a4d5e783ff93a9b54f` | 6 | 1,156,329 |
| `schooners-burgers-and-beer.pdf` | Schooners Burgers & Beer (duplicate copy in batch B) | `791fd1c545ef8e9f0433612ba341f0966a5e178639cdcf0c977d4c0a8d92ec9e` | 2 | 1,596,470 |
| `the-waters-on-50th.pdf` | The Waters on 50th (duplicate copy in batch B) | `7c832bf44ae1a83d43e572b4876d11a51577544729911e0aeb11ee2efa17ecf4` | 3 | 282,027 |
| `casa-bella.pdf` | Casa Bella | `94eabaebb7ccde0bed654418667b035920e0e0dc073e949ebfb5692083600461` | 7 | 909,292 |
| `old-man-raffertys.pdf` | Old Man Rafferty's | `1e09e85117eb20c6b296a02bcf97ae06d1f04c43bcc4757fa84f041721a4dc16` | 2 | 763,258 |
| `restaurant-26.pdf` | Restaurant 26 | `d40b209b42186ce652760a40ca83f2b8b5f2f5f42409abc424b0c51f96e3516d` | 14 | 264,746 |

`restaurant-26.pdf` also exceeds the hosted 10-page limit; it stays intact and makes no hosted
full-PDF claim. Reserve images: `patis.webp`
(`14e2795b63efdf874df9362f2f6b1b89a21c4c4488e1ced14671649f58c58414`, 1 page, 557,864 bytes)
and `virginia-menu.jpg`
(`b511ce4a2089f059e33e4c1ac1c57e52e5a2e91355a0ddaf2b11544ff1d0985b`, 1 page, 870×1650,
453,164 bytes). The existing private source folder also lists `img2_currans_family_diner.jpg`,
`img3_inn_between_diner.jpg`, `pdf1_homeslice_austin.pdf`, `pdf2_mapleberry_diner.pdf`,
`pdf3_carmines_nyc.pdf`, `unnamed.webp` and an unidentified permitted QR-URL candidate; those
are unhashed locally and remain reserve, not tested URL sources.

## 5. Candidate held-outs (metadata-only, not certified)

Exactly two new PDF binaries were acquired, from distinct first-party restaurant/domain
families, complete at two pages and below 12,000,000 bytes. Both were discovered from official
page HTML **hrefs only**. No page text, pixels, transcriptions, OCR, renders or model calls were
performed by the collector; only PDF page/dimension and title/creator/producer metadata were
parsed.

### Candidate A — PDF upload route

| Field | Value |
| --- | --- |
| Source / family | Di Paolo's Italian Ristorante — `dipaolosrestaurant.com` first-party Canva PDF |
| File | `candidate-a-dipaolos-77.pdf` |
| Pages | 1–2 of 2 (all) |
| SHA-256 | `653094a1ed49d593053064e983994a3adbc280ee330572b5323ce2c22e241d8b` |
| Bytes | 4,625,755 |
| Dimensions | 612×792 pt (letter) both pages |
| Official download URL | `https://dipaolosrestaurant.com/wp-content/uploads/2026/10/Untitled-design-77.pdf` |
| Official discovery page | `https://dipaolosrestaurant.com/` |
| First retrieved | 2026-11-14T20:37:32Z |
| Declared route | PDF upload (`upload-groups` + file PUT), not URL intake |
| Reference status | Not gold; no reference authored, reviewed or frozen |

The homepage exposes two same-family PDF hrefs; only the first (`Untitled-design-77.pdf`) is
used. The site also links an affiliate domain; no bytes from that domain were fetched. Because
the homepage exposes multiple PDF links, HTML-page URL intake is ambiguous, so the declared route
is PDF upload of the exact original bytes.

### Candidate B — supported direct-PDF URL intake route

| Field | Value |
| --- | --- |
| Source / family | Bluestone — `bluestoneonline.net` first-party Adobe Illustrator PDF |
| File | `candidate-b-bluestone-dinner-2026-11-02.pdf` |
| Pages | 1–2 of 2 (all) |
| SHA-256 | `65787a601bc3d62059e6fc86df0ff79e2a824ac362dc1e1f7c0a45ae39500450` |
| Bytes | 1,158,087 |
| Dimensions | 792×1224 pt both pages |
| Official download URL | `https://bluestoneonline.net/wp-content/uploads/2025/07/dinner-menu-11-2-26.pdf` |
| Official discovery page | `https://bluestoneonline.net/menus/` |
| First retrieved | 2026-11-14T20:37:39Z |
| Byte re-verification | Fresh HTTPS GET at 2026-11-14T20:38:01Z returned the identical SHA-256 — pre-run evidence only, not app-side execution |
| Declared route | True server-side URL intake of the official href, not upload of the downloaded file |
| Reference status | Not gold; no reference authored, reviewed or frozen |

The menus index exposes twelve PDF hrefs; this candidate is the single href whose filename and
PDF title identify the current dinner menu dated 2026-11-02. Selection used href filename and PDF
metadata only. Uploading the downloaded local file and describing it as URL intake is prohibited;
the server must fetch the official URL and retain `originalUrl`/`finalUrl`/`retrievedAt` plus the
actual byte hash.

### Candidate status

These are **candidate-heldouts**, not certified unseen sources. Reviewers must confirm prior
history/access, rights, source-family independence and their own independence. Public URL
availability cannot rule out third-party exposure. Neither candidate has been uploaded or shared:
the official download URLs and full SHA-256 values above let independent reviewers fetch and hash
the exact bytes themselves. Candidate A shares an Italian-cuisine
category with Casa D'Angelo/Casa Bella but has a different owner/domain/URL and no shared hashes;
reviewers must confirm it is a distinct family and check the affiliate-domain link. Neither
candidate is a frozen reference.

Domain discovery also involved search-result snippets. Possible excerpt exposure belongs in the
custodian-history review; metadata-only PDF handling does not erase it. No snippet contents were
handed to the scorer implementer or used as reference answers. Candidate status remains provisional.

## 6. Routes (declared, not executed)

Hosted routes require an authenticated actor, an authorized venue and a deployed queue; none
exists in this preparation. No upload, URL intake, permission or sharing change was performed.

- **Candidate A — PDF upload.** Preflight the custody bytes against the declared SHA-256 and size;
  create an upload group for one PDF; upload the original bytes as `application/pdf`; verify the
  job's `source_hash` and `source_uploaded` before extraction.
- **Candidate B — direct-PDF URL intake.** Fresh preflight GET hashed against the declared
  SHA-256; create the URL intake with the official href; the server re-downloads, enforces public
  destination, size, page and redirect rules, and records provenance. Any hash or final-URL drift
  means STOP, re-version and renewed approval, not scoring.

## 7. Custody, privacy and hash identity

Public artifacts — this document and the JSON — publish only names, IDs, public URLs, SHA-256
values, sizes, page counts, dimensions, routes and status. Exact custody locations, private
filesystem paths, header captures, raw source bytes, annotations, run ledgers and receipts stay
in private artifacts outside Git and are deliberately **not** reproduced here. The original
user-supplied sources already have an existing private Drive source folder; this task neither
opened it nor changed its permissions.

The private provenance artifact this plan derives from has SHA-256
`c42d02f31967e10ef58a924d388792acada423f32bb89601b8ef9c93fac24649`. Reproducing that hash does
not publish its private contents. A candidate re-hash immediately before any run is mandatory.

## 8. Reference handoff

Reference answers are human, **source-only** annotations using PR169's unchanged
`qa02.reference.v1` schema. No references exist yet for any source in this plan, and none may be
inferred from metadata, filenames, page counts or prior extraction output.

- One stable occurrence ID per printed entry, including repeated names; record page, literal
  section/location and dish-or-qualifier role. Qualifier rows never become dish denominators.
- Record literal name/description, complete printed price text, **every printed option in source
  order** (labels and amounts), a nullable scalar and nullable currency.
- Preserve the unknown-currency assumption: the `$` printed-currency note in prior collection
  notes is not AUD and is not currency verification. Record only what the source prints; use null
  when the printed currency is not established.
- Known printed zero is distinct from missing/null. An unknown price stays null, never zero; a
  multi-price group keeps a null scalar with an explicit reason.
- After authoring, a **different** reviewer checks the actual source and records a decision
  reference; the PR169 freeze and `--require-reviewed` verify commands produce the immutable
  manifest. Until then the case is pending and cannot be scored as reviewed.
- This plan and its JSON are **not** frozen references. Do not convert metadata into reference
  answers, and do not call the plan a manifest.

Uneeza confirmed the three fictional example readings in
[PR169's source-review comment](https://github.com/vivienk/peekaplate/pull/169#issuecomment-6875165425).
The committed example manifest's review record remains pending; this handoff does not alter it or turn the synthetic review into real-menu approval.

## 9. Rights, exposure and gates

Everything here is private evaluation material. Public first-party availability grants no
redistribution or evaluation licence, and user-supplied originals have no recorded licence. No
publication, upload, share or permission change is authorized.

| Gate | Status |
| --- | --- |
| Development split selected with exact bytes/pages | PASS (local byte evidence only) |
| Candidate acquisition bounds (2 PDFs, 2 pages, <12 MB, first-party hrefs) | PASS (metadata evidence only) |
| Candidate B official-URL byte/hash pre-run re-verification | PASS (pre-run only) |
| Rights / retention permission | BLOCKED |
| Reviewer independence and prior-exposure declarations | BLOCKED |
| Source-only reference authoring, independent review and freeze | NOT RUN |
| Unseen photo coverage | BLOCKED / UNESTABLISHED |
| Held-out representativeness and sample sufficiency | Pending Vivien/independent-reviewer agreement; unseen photo coverage is absent |
| Hosted PDF-upload and URL-intake execution | NOT RUN |
| Held-out gate overall | BLOCKED |

## 10. Change control and next actions

Any change to a selected source, page extent, SHA-256, route, split or source-family declaration
requires a new plan version and renewed human approval before predictions. Candidates must be
re-hashed and re-verified immediately before any run. Scorer commit, commands, thresholds,
evaluation results and release acceptance are separate and are owned by the parent, Vivien and
independent reviewers; see [`STRICT_SCORER.md`](../processing/eval/qa02/STRICT_SCORER.md).

Next actions, in order: reviewers confirm candidate history/rights/independence; source-only
annotations are authored and independently reviewed/frozen; the parent pins the scorer module,
commit and command; an authorized executor runs the two declared routes under the frozen hashes;
only then can a fresh evaluated extraction be considered, with its own bounded authorization.