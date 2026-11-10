# OCR and LLM draft extraction review handoff

Task: [S3-VIS-02 — Evaluate OCR and extract evidence-linked dish fields](https://app.clickup.com/t/86bcnfw5g).
Mohammad owns OCR; Teeyansh owns ingestion integration, Zhiliang criteria,
Uneeza evaluation preparation and Sai independent validation.

## Included implementation

Use `processing/`. PyMuPDF reads each PDF page; 20 or more non-whitespace
characters retain native text, while shorter pages render through OCR.space,
including pages without embedded raster images. Images use the same bounded,
oriented preparation. Reports retain original source bytes/hash, page identities,
native text, extraction method, available word regions, warnings and failures.

LangGraph dispatches numbered page batches with the selected input mode to ChatOpenAI for strict dish-schema
extraction. Python merges results and attaches source spans. Unsupported names
or page citations reject the dish; unsupported optional fields become null with
review warnings. Candidate-cache hits are revalidated. All dishes remain
`needs_review`; the separate LLM verification node is pending.

The follow-up [pipeline 3 contract](processing-v3.md) adds category/subcategory,
heading-page provenance, printed price options, conservative local OCR-geometry
association and a final `timings.json` sidecar. New output is schema 2 / pipeline 3;
saved schema 1 / pipeline 2 remains readable. The [RES-01.1 exporter and shared
review schema](review-candidates.md) preserve both version pairs, source evidence,
original candidate IDs, null/zero distinctions and partial failures. This is an
offline producer/consumer foundation, not an accepted deployed handoff.

Batch/concurrency defaults remain ten pages and one simultaneous call;
provider/model/reasoning settings are unchanged. The explicit follow-up default
is now OCR plus image, with OCR-only and true image-only available through
`--input-mode`. Private raw/cleared suggestions remain separate from grounded
originals; image-only never invents text spans. See [mode and evidence behavior](processing-v3.md#input-modes-and-private-review-artifacts).
Neither local code nor a complete processing status proves facts correct or a
hosted rollout accepted. No deployment is performed by this follow-up.

`python -m peekaplate_processing.extract_menus` acquires page text without LLM
calls. `python -m peekaplate_processing.run_pipeline` performs extraction.
The merged foundation's handoff recorded 89 fixture/mocked-provider tests.
Follow-up regressions cover context/geometry, duplicate safety and review-export
contracts. CI runs frozen dependencies, the complete suite and wheel/sdist build.
Check the PR for exact final-tree commands and current execution results.

## Integration review requested

The mapping below follows Teeyansh's [PR #23 adapter at e0b1a93](https://github.com/vivienk/peekaplate/blob/e0b1a938d0e585100927fe38b49ca8fc8df579ba/backend/src/retrieval/handoff.ts).
It is a proposed integration handoff for review, not a claim that the combined
application has been integrated or accepted.

| Boundary | Mapping and ownership |
| --- | --- |
| Source identity | Mohammad retains the source hash, bytes and stable source/segment IDs. Teeyansh's VIS-01 owns persistent source registry/snapshot integration; IDs must remain unchanged across retrieval and extraction. |
| Kind and method | Python accepts `pdf`, `image`, `website`, `text` and `text`, `html`, `pdf_native`, `ocr_space_engine3` methods. VIS-01 normalizes retrieval-only kind/method aliases before constructing a Python report. |
| Evidence | Keep separate `drafts[]` and `evidence[]`; retain `draft_id`, `draft_index`, segment ID, zero-based start and exclusive end. Original segment text is authoritative. |
| Offsets | Python wire spans use Unicode code points. PR #23 owns conversion from JavaScript UTF-16 before emitting VIS-02 spans; nonzero passage offsets require original segment text. |
| Prices and unknowns | Preserve decimal strings and explicit nulls. Retrieval's price placeholders remain unknown until grounded extraction; symbols do not establish currency. |
| Partial pages | Retain failed/skipped segments, errors, warnings and coordinate metadata. A usable later page cannot conceal an incomplete source. |
| Nullable errors | Python may emit `error: null`. VIS-01 owns mapping null to an omitted field for VIS-04's current schema, with regression coverage for both null and omitted inputs. |

Mohammad owns the Python schemas/extraction and their regressions; Teeyansh owns
the PR #23 adapter and VIS-01 integration tests; Jeffin reviews the shared
contract and Sai independently validates it. Reviewer confirmation of this
mapping and the integrated handoff remains outstanding.

The shared [Unicode fixture](../processing/tests/fixtures/source-spans.json)
contains an emoji within a passage and another before a nonzero passage offset.
Python `tests/test_handoff.py` and the existing Node test runner's
`scripts/processing-handoff.test.mjs` load the same fixture and assert exact
source-slice equality in both offset units. PR #23 already tests its adapter
with the same strings; consuming this shared fixture in that adapter's tests is
Teeyansh's follow-up when the branches are combined. These tests establish span
semantics, not end-to-end ingestion or correct dish/price association.

Teeyansh reported three passing isolated integration tests on October 24 using
serialized Python output and the Node adapter, with mocked OCR/LLM. Test links
and the exact tested commits are still requested in the
[integration discussion](https://app.clickup.com/t/90141746115/86bcnfw5g?comment=90140272857390).
That reported coverage does not establish live extraction accuracy or acceptance.

Route future application changes through existing backend authority and human
review. This package has no Worker endpoint, database writes, content approval
or publication integration. Coordinate merge order #23, #24, then #25; the asset
PR must rebase onto the reviewed package rather than restore the older OCR copy.

## Review corrections

`OCRProvider` declares the OCR extraction interface. The existing
`OCRSpaceClient` implements it; callers can inject a provider into
`extract_source` while OCR.space remains the default. No provider registry,
factory, new dependency or extra OCR/LLM call is introduced.

Injected results must be OCR.space Engine 3-compatible, with integer
`settings.OCREngine=3`. PDF and image acquisition validate this before accepting
OCR text. Incompatible/missing settings fail the segment; later native PDF
pages remain readable. Regressions cover both rejection paths and compatible
providers. Other providers require a deliberate evidence-contract update.

PDF page loading now happens inside the per-page error boundary. A synthetic
three-page regression injects a middle-page load failure and expects ready,
failed, ready, preserving earlier and later text without OCR calls.

Cache behavior is tested on every platform; only POSIX systems assert mode
`0600`. Windows ACL privacy is not established by that assertion. The real SDK
cancellation test waits for its mocked transport to start before cancellation;
the separate wall-clock deadline and partial-batch tests remain in place.

These corrections and the interface refactor were included in merged PR #24;
the pipeline 3 and RES-01.1 work above is a separate follow-up.

## Fresh live PDF test — 23 October 2026

Input: [the tested Denny's PDF](../test-data/Dennys_Menu.pdf), 35 pages,
SHA-256 `2430807aeb2556cd85186b1b0d4126a89cee066dea3ccf5ad18b5e23b5082275`.
The exact test input is included at the user's request; credentials, private
conversation notes and generated reports remain excluded.

| Stage | Settings and observed result |
| --- | --- |
| Fresh OCR | All 35 pages required OCR and succeeded; 268.779 seconds, no old cache reuse. |
| Initial LLM run | `minimax-m3.1-flash`, 10-page batches, concurrency 1, 90-second deadline. All four batches timed out; zero drafts. Full run: 629.327 seconds. |
| Smaller-batch follow-up | Reused only the fresh OCR text, one page per request, concurrency 2, same model/deadline, no LLM cache. Retained 161 drafts in 549.035 seconds; no additional OCR calls. |

The follow-up is **incomplete**: pages 19, 27, 33 and 35 timed out. Six generated
names were rejected by grounding checks: two on page 12, three on page 20 and one
on page 21. Pages 12 and 20 retained supported siblings; page 21 retained none.
Every retained draft remains `needs_review`; all 161 evidence spans reconstructed
the saved OCR text exactly. This checks provenance, not correct dish/price
association or representative field accuracy. Forty drafts have additional
field warnings. Eighty-seven retain a price; no currency was inferred from a symbol.

The smaller batches were test settings only; application defaults were not
changed. The local reports contain full source snapshots and are kept out of Git.
[Test input notes](../test-data/README.md) record the exact input and reproduction
commands. Thresholds, reviewed ground truth and PM acceptance remain outstanding.

## Acceptance still required

The earlier private Denny's run produced 113 drafts from 34 usable pages out of
35, with page 10 failed. The fresh results above supersede that operational
snapshot; neither run is a reviewed field-accuracy benchmark. The exact tested
PDF is included, while saved OCR, conversations, `.env`, installed dependencies
and generated run artifacts remain excluded from this PR.

Before acceptance, provide permitted representative inputs and reviewed ground
truth for rotation, blur, low contrast, missing fields and multi-column layouts;
agree field-level thresholds with Zhiliang; export reproducible expected/actual
results and errors to Uneeza; obtain Sai's independent validation and Vivien's
PM acceptance. A naturally mixed native/scanned menu is still to be verified.
Existing deterministic tests exercise native, image-only and fallback routing.

The follow-up records passive timings without changing provider/default tuning.
Further live retries and the representative evaluation matrix remain separate.
Implementation and integration review, including the shared schema handoff, do not
satisfy the task's quality acceptance criteria or PM sign-off.
