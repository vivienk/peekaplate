# Pipeline 3: category context, printed prices and elapsed time

This processing change extends the merged VIS-02 foundation. It does not
deploy a service, approve a dish or implement RES review persistence.
The existing OCR provider, model, bounded Python/LangGraph flow and strict local
validation are reused. No extra verification model or new dependency is added.

## Input modes and private review artifacts

`run_pipeline.py` and its Python function accept three explicit `input_mode` values:

- `ocr_image` (default): source text plus original/bounded target-page images.
- `ocr`: the earlier source-text-only model input; native PDF text/OCR acquisition is unchanged.
- `image`: target-page images plus a labelled previous-page image, without OCR or native-text extraction.

The default input change is explicit follow-up scope, not independent quality or
PM acceptance. Batch size, concurrency, model/provider and reasoning defaults remain
unchanged. The graph's lower-level text default remains compatible with existing callers.
No mode silently falls back or makes an extra model request.

All modes save private `review-suggestions.json` beside `extraction.json` and final
`timings.json`. It retains schema-validated raw dish fields, changed/rejected field
values and reasons, original page references and model section suggestions. Hidden
reasoning/provider messages are not stored. Cleared prices and rejected composed
names remain unvalidated, separate from `candidates[].original`. Base-heading and
printed-option inspection uses the retained original page; no variant relationship
or new review field is invented.

Vision references contain actual image hashes, dimensions and whole-page regions,
not inferred dish rectangles. Their `path` is local-run-only; source hash and page
identify the immutable source snapshot retained in the full report. A source menu
page is not a verified dish photograph. Keep these artifacts private and deliver
them only to authorized reviewers.

Image-only has no source text, grounded drafts or text spans. A successful model
trial therefore leaves the standard grounding report `incomplete` (CLI exit 2),
while private suggestion status can be `complete`. A failed image-model request
remains failed. This distinction avoids declaring image-read values OCR-grounded
or treating diagnostic completion as publication approval.

Images are limited to8 MB each and16 MB per model request, including image-only
context. `--batch-pages` is a maximum, not a promise of exactly that many targets:
vision groups are greedily split into contiguous, byte-bounded groups before any
provider call. Original image bytes/quality and page numbers are unchanged; the
planner accounts for the actual preceding image-only context. No failed request
is retried or image silently downsampled to fit a group. Malformed images still
fail the worker's authoritative byte/hash checks, not a planning hint.
PDF rendering retains the existing 40-page/6-megapixel bounds; bounded image
preparation respects orientation and preserves original PNG/JPEG bytes when safe.
The model cache distinguishes input mode, prompt/schema, context and verified image
bytes; it never stores image data URLs. OCR geometry remains local validation data.

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline --input work/menu.pdf --run-dir work/combined --input-mode ocr_image --batch-pages 2 --llm-concurrency 2
uv run --frozen python -m peekaplate_processing.run_pipeline --input work/menu.pdf --run-dir work/text --input-mode ocr --batch-pages 2 --llm-concurrency 2
uv run --frozen python -m peekaplate_processing.run_pipeline --input work/menu.pdf --run-dir work/images --input-mode image --batch-pages 2 --llm-concurrency 2
```

Choose new output directories. `--pages-json` may reuse verified text in `ocr` and
`ocr_image`; image-only rejects it instead of secretly reading OCR. Vision modes
still need original source bytes. No image-backed RES schema is introduced here.

Both acquisition and pipeline CLIs accept `--no-ocr-table` (Python
`is_table=False`) to send OCR.space Engine 3 `isTable=false`. The default remains
true, and OCR cache identities separate the two settings without invalidating
existing default entries. Acquisition records the requested value in
`configuration.ocr_is_table`; each OCR segment retains the actual provider settings.
The flag does not reacquire saved `--pages-json` text and has no effect in image-only
mode. There is no automatic retry with a different setting or grounding change.
The bounded column-menu trial returned identical text with no price tokens for
both settings: this option is not a demonstrated missing-price fix. Overlay-only
values still cannot become source-text facts.

## Output and category handling

New reports use `schema_version: 2` and `pipeline_version: "3"`. The loader can
still read saved schema 1 / pipeline 2 page reports. This is a new output version,
not a relabeling of the earlier integration contract.

The same extraction LLM identifies a main `category`, optional `subcategory`, and
page section metadata. Wrapped OCR headings such as `# SIGNATURE` / `# SLAMS`
can support `SIGNATURE SLAMS` without changing the original source text or offsets.
OCR Markdown headings alone do not establish categories: dish names can be
headings too.

Workers receive at most 3,000 characters of the immediately preceding page as
context. Dishes must cite target pages, not context pages. Python then walks
results in page order, retaining an explicit supported main heading only across
contiguous readable pages whose extraction marks `continues_previous: true`.
Missing section metadata, failed/unreadable pages, gaps, uncertain continuation
and multiple supported main categories clear carry-over. Section headings and
explicit dish categories are considered together before filling unknown categories;
conflicting roots do not supply a default for that page or the next. No automatic
child-group inheritance is invented when a continuation page does not establish it.

For example, a synthetic page 9 dish may retain category `BREAKFAST` with
`category_page_number: 8`; its original dish text/evidence still cites page 9.
The earlier heading page and inherited-category warning remain available for
human review. Consumers must read this explicit provenance rather than require
every category heading to appear inside the dish's own page text.

A synthetic drink can retain `category: "COLD BEVERAGES"` and
`subcategory: "FRUIT JUICES"`. The model identifies the roles; literal checking
and continuity rules cannot independently prove semantic correctness.
Subcategories that repeat the dish name or main category are cleared with a
review warning. The main-category comparison also runs after section inheritance.
A flat item such as single-serve brewed coffee has no subgroup simply because its
name appears on its own line.

## Prices

`price_amount` remains a decimal string or null, with currency explicit or null.
`price_text` preserves printed options such as `345 / 545`, including all amounts
in longer slash-separated lists. When multiple prices are printed together, the
amount stays null and the draft carries a review
warning. No small/large, serving or other option meanings are invented.

A printed-price suggestion or OCR box must corroborate a complete numeric group,
not a decimal/thousands fragment or a subset of a slash-separated option list.
Clipped boxes and truncated suggestions are withheld rather than promoted to a
scalar price. Explicit money beside a separately labelled calorie/portion count
remains distinct; these checks do not turn units into prices.

Numbers are checked against the matched dish entry, bounded by other known or
possible entry headings, including omitted entries with inline prices, rather than
every number on the page. Photo captions are not preferred entry anchors.
Ambiguous boundaries can produce nulls and warnings. Calorie/portion units apply
across a slash-separated numeric list and cannot support a price; a genuine
monetary amount beside a separate calorie count remains eligible. Recognized
monetary prefixes are not entry names and stop unit propagation across a slash;
a unit attached directly to a number still invalidates that number. Automatic
recovery recognizes an explicit, bounded set of monetary codes/symbols, not every
uppercase three-letter word: an omitted `TEA 95` heading is not a currency price.
This recognition does not infer `price_currency` or limit which explicitly quoted
currency fields can be reviewed. Complete options with code prefixes/suffixes
retain their full literal text (for example `8.50 CAD / 12.50 CAD`) and no scalar.
A scalar embedded in an incomplete or unrecognized slash group cannot establish
a complete single-price assertion.

On OCR pages, existing uploaded-image word/line boxes also support local price
association. Valid source-supported headings, including wrapped names, bind only
to unique same-row prices in their column. A price below a description additionally
needs a bounded text entry and an unambiguous column interval before the next
known entry. A unique literal scalar or slash list can replace a wrong suggestion
or populate an unknown price, with a recovery warning; currency and option labels
are not inferred. Every known entry's heading parts and name spans are excluded
from other entries' price candidates, including wrapped numeric names and inline
price headings. These are approximate geometry checks, not factual approval.

An extra unpriced occurrence of the same name remains a competing entry. Missing
prices do not prove that it is a photo caption. Only distinguishable, explicit
image-alt text can exclude a caption occurrence; an unmarked or indistinguishable
repeat stays ambiguous, even when another occurrence has a valid price. Every
source entry occurrence must be reconciled: an entry whose boxes join its title
and description cannot disappear from the competing count merely because that
combined run is not a price-eligible heading. Repeated source phrases inside one
flattened OCR line also compete; line-start matching alone cannot prove one entry
across columns. Only a distinguishable occurrence inside actual image-alt syntax
can be excluded as a caption. Repeated mentions can therefore cause conservative
abstention even when a human could identify one entry. This can clear previously
retained prices rather than guess which entry they describe.

Malformed, excessive or competing geometry abstains rather than widening back
to the page's text. Missing/unavailable geometry uses the text checks, but several
standalone price groups in an entry remain ambiguous even if a suggested number
appears in that cluster. Overlay labels omitted from the OCR text can be image
logos or captions: they cannot supply facts and do not invalidate unrelated
entry associations. Original text, geometry and Unicode offsets are not rewritten.
The separately identified [private OCR-box prototype](#private-ocr-box-prototype)
may compare these readings offline; it does not relax this grounded-output rule.

Compatible same-name candidates collapse only when they resolve to one source
entry and one unchanged candidate contains the other's supported facts. Names
are compared by case/whitespace only, every field's non-null supplied values must
agree across the whole group even when grounding cleared them, and warnings are
retained. A candidate with null fields cannot bridge conflicting originals. Different pages, distinct
entries, semantic aliases, variants and complementary/conflicting records are not
silently merged. Ambiguous same-name records remain separate with review warnings.
This happens before IDs are created for a new run; existing reports and IDs are
never rewritten or deduplicated by the review exporter.

This reduces cross-dish mistakes but does not establish extraction accuracy.
All drafts still require human review. Original OCR text and page evidence are
retained so missing or wrongly grouped values can be corrected later.

## Private OCR-box prototype

`peekaplate_processing.overlay_review` is an explicitly separate, offline diagnostic,
not a graph step, verification model, source-text repair or RES evidence extension.
It reads a saved full `pages.json`/`extraction.json` and image-input
`review-suggestions.json`, and creates a new private `overlay-review.json`.
No environment file, image-reference path, provider or pipeline is invoked.
The service/host bundle does **not** retain this additional artifact automatically.

The artifact has its own `artifact_type: "private_overlay_review"`, schema1 and
`unvalidated` status on every row. It preserves every valid saved OCR region's
verbatim text, coordinates and **saved-region index**, not an invented provider ID.
Its transcript joins region texts in stored order with explicitly recorded newlines.
Zero-based Unicode code-point spans (exclusive end) identify this transcript only;
they are never ParsedText offsets or `SourceSpan` evidence. Source snapshot/upload
hashes and both input hashes bind the artifact. File export hashes exact input bytes;
the Python in-memory helper hashes deterministic JSON. Source consistency is **not**
proof that suggestions and OCR came from the same run; existing suggestion IDs omit
run identity and are not joined to final candidate IDs.

The initial scope is one ready Engine3 segment from an unchanged PNG/JPEG source
image, orientation1, at most6 megapixels/8 MB, with at most1,000 regions/500
suggestions. Snapshot size/hash, original image/page references, re-created OCR
upload hash/dimensions and complete geometry are checked before comparison.
Unsupported provenance fails without output; unavailable, malformed, overlapping
or duplicate geometry yields explicit abstentions without a transcript. No fallback
to page-wide text is permitted. Inputs and standard exports remain unchanged.

Association requires one exact case/whitespace-normalized, single-region title and
all eligible same-row price cells. Repeated phrases, intervening labels, partly
aligned cells and extra/conflicting readings abstain. Negative-only title checks
also search adjacent/wrapped region runs using both original case-insensitive
phrase matching and normalized casefold matching. These Unicode relations differ;
keeping their union prevents normalization from dropping an existing competitor.
They never create an evidence quote, box or span. Search is limited to8 regions and10,000 neighbor checks per
suggestion; exhausted bounds abstain rather than silently discard a possible
competitor. Positive recovery still requires a single exact title region: wrapped,
composed and inline titles are not recovered. Complete ordered numeric readings must match the saved
image-model suggestion; an unsupported scalar or convenient subset cannot establish
agreement. Bounded nonnegative integer/one- or two-decimal amounts and literal
SM/LG/recognized monetary forms are supported; signs, units, fragments and uncertain
bare-integer whitespace lists abstain. Model whitespace/slash separators are not
inserted into OCR evidence. Each proposed part retains its exact source-box literal
and transcript span. Multiple readings have no scalar; currency always stays null.
No column meanings, sizes, variants, qualifier relationships or dish rectangles are
inferred. Both model and OCR can agree on a wrong reading: numeric agreement is
**not factual approval**. Every original suggestion and abstention reason is kept.

From `processing`, after installing dependencies, choose a fresh private output:

```sh
uv run --frozen --offline --no-env-file python -m peekaplate_processing.overlay_review \
  --input work/saved-run/extraction.json \
  --suggestions work/saved-run/review-suggestions.json \
  --output work/overlay-prototype/overlay-review.json
```

Output is create-only with private file permissions. Exit0 means an artifact was
written, even when all rows abstain; invalid input/existing output exits1. Keep the
artifact beside its immutable inputs and restrict access. Do not stash it in segment
metadata: that metadata is exported and is not a private extension point. Public
box-backed candidates still require coordinated Python/TypeScript evidence schemas,
consumer acceptance and service/host retention changes; this prototype authorizes none.

The frozen single-image replay retained all14 suggestions/44 regions:10 rows had
numeric agreement covering18 visually checked price cells;4 abstained. The extra
veggie reading and imported-drink disagreement were withheld, as were header and
repeated-phrase ambiguities. A shared OCR/model spelling error was not corrected.
These selected numeric checks are not whole-menu/name/role accuracy. All14 standard
candidates, IDs and null prices remained unchanged. No additional paid call occurred.

## Timings on each started run

Each new run directory receives `timings.json`, including failed stages. Invalid
options, credentials or an existing output directory fail before a run starts.
The final timing file includes:

| Scope | Stages |
| --- | --- |
| Run | Acquisition, page-report write, source-image preparation, LLM wall time, draft assembly, private-suggestion write, extraction-report write and total. |
| PDF page | Native text, rendering, image preparation, OCR/cache lookup and page total, where applicable. |
| Image | Preparation, OCR/cache lookup and total; failed image input retains its measured total. |
| LLM batch | Cache lookup, start-spacing wait, model request, local parsing, cache write, grounding and worker elapsed time. |

Stage timers record time even when an operation fails. The console also prints
the run breakdown. `extraction.json` contains the timing snapshot available when
it was serialized; **`timings.json` is the final measurement**, including output
write time. The total ends before saving the small timing summary itself.

`acquisition_mode: "saved_pages"` marks reused OCR. Those page records have
`reused: true` and null current page timing/cache fields: old acquisition times
are not presented as work done by the new run. A genuine source acquisition
records actual current cache hits and per-page costs.

Batch wall times overlap at concurrency 2; do not add them to estimate elapsed
time. Compare the run's `llm_wall` and `total`. A cache-only model replay measures
local reuse/validation, not live model latency. Interrupted graphs retain overall
stage time but may not return completed per-batch graph results.

## Run and test

From `processing`, use a fresh run directory:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input work/menu.pdf --run-dir work/menu-v3-001 \
  --batch-pages 2 --llm-concurrency 2
```

Add `--pages-json work/previous-run/pages.json` to reuse verified saved OCR for
the same PDF. This still calls the extraction model for uncached batches. The
schema, prompt, model/settings and previous-page context participate in the new
candidate cache identity. Cached candidates and section metadata are revalidated.
OCR geometry stays local: it is not added to the model request or cache identity;
cached raw candidates pass through the current grounding and duplicate checks.
Deadlines and disabled SDK retries remain; no silent fallback model is introduced.

For a full fresh test, omit `--pages-json` and add both `--no-ocr-cache` and
`--no-llm-cache`. These flags bypass cache reads and writes; existing files are
preserved. This makes new OCR and model requests, so its elapsed time includes
OCR acquisition as well as extraction. Always choose a new run directory.

Application defaults remain a maximum of ten target pages per group and one
simultaneous model call. OCR text retains its existing fixed-page grouping; vision
may create more, smaller groups to honor the16 MB bound before calls. Consult
`configuration.llm_batches[].page_numbers` for actual groups and request counts.
The two-page/concurrency-two command above is an explicit opt-in, not a new default.
Provider/model selection and reasoning configuration are unchanged from develop;
separate private experiments do not authorize provider-specific tuning here. The
input-mode default is deliberately OCR plus image; it is independent of those settings.

Run deterministic checks without live provider calls:

```sh
uv run --frozen python -m unittest discover -s tests
uv build --no-sources
```

Speed is measured before setting an acceptance target. More concurrency or larger
batches are not automatically faster; retain actual failures and timeout counts
when reporting elapsed time. Cache acquisition and live model latency are separate.

## Integration boundary

The local RES-01.1 exporter and shared review contract accept schema 1 / pipeline 2
and schema 2 / pipeline 3. The latter preserves hierarchy, heading provenance and
printed prices without treating a null scalar amount as missing when printed
options exist. VIS-01 consumers still need to accept the new version before
integration. The source-page/draft evidence shape is preserved; the new fields
and schema version still require team review. No caller should silently discard them.

Price validation excludes numbers inside dish names and does not replace supplied
price text with a different source pair. It can retain a single printed pair when
it supports the supplied scalar amount; multiple candidate pairs remain unresolved
with a review warning. Flattened OCR still cannot establish every visual association.
