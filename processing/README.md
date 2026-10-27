# Menu extraction

The optional staging HTTP service wraps this same pipeline; it does not replace
the CLI. See [VIS-01 infrastructure and service handoff](../docs/menu-ingestion-infrastructure.md)
for the request contract, Docker commands, secrets, limits and activation gates.
Install `uv sync --project processing --extra service --frozen` before running
the complete test suite, including HTTP boundary tests. CLI-only use does not
need the service extra. No hosted service is implied by this package.

Local PDF/image acquisition plus your LangGraph orchestrator/worker pattern.
OCR.space code and the existing dish/source schema are retained. The old custom
LLM client, review/evaluation layer, website reader and pipeline were removed.
The previous implementation is recoverable from the local branch
`archive/processing-before-pymupdf`. Private `.env`, inputs and saved results
under `work/` remain outside Git.

## Flow

1. **PDF:** PyMuPDF extracts every page's native text. Keep it when the page
   has at least 20 non-whitespace characters, even if it also contains images.
   Pages below that cutoff, including empty pages and pages with only a page
   number, are rendered and sent to the existing OCR.space adapter. This also
   handles short-text/vector-only pages without embedded raster images.
   Keep the original native text and its character count in the page report.
2. **Image:** validate/rotate/resize, then call the same OCR.space adapter.
3. **Orchestrator:** split page-number/text pairs into batches of ten by default;
   `--batch-pages` accepts 1–10 pages per request.
4. **Workers:** `ChatOpenAI` requests the generated dish JSON schema; complete
   response content is parsed locally and validated with `DishBatch`.
   LangGraph `Send` dispatches batches. The CLI defaults to one request at a time;
   `--llm-concurrency 2` allows two overlapping calls, with dispatches spaced
   at least 3.1 seconds apart.
5. **Synthesizer:** combine worker results in page order using Python. Carry an
   explicit category into a supported continuation page and retain the heading's
   source page. Missing/failed pages, unclear continuation and mixed main sections
   clear this context. No additional LLM call.

The LLM sees target `pages`, plus up to 3,000 characters of previous-page
`context_pages` when available, its schema and extraction instructions. Context
pages cannot produce dishes. The prompt includes the exact generated JSON schema
and a complete synthetic input/output example, showing separate `price_amount`
and `price_currency` keys and required unknown fields set to null. This reinforces
provider-side schema requests; local strict validation remains mandatory. It does not receive OCR overlays or source images.
Names/attributes are matched against their cited page while tolerating wrapped
OCR headings. Price evidence is limited to the associated entry; ambiguous entry
boundaries and explicit calorie/portion units cannot support a numeric price. Original
page text is attached by code as evidence, avoiding model-generated source quotes.
This is page-level evidence, not proof of correct dish/price associations.
Unknown facts stay null and every dish remains `needs_review`.

New results use **schema 2 / pipeline 3**, with `subcategory`, `price_text` for
printed price options and `category_page_number` for heading provenance. Never
pick a single price or invent option labels for `345 / 545`. The final run timing
breakdown is in `timings.json`; see [pipeline changes and timing](../docs/processing-v3.md).

The RES-01.1 exporter supports both earlier **schema 1 / pipeline 2** and current
**schema 2 / pipeline 3** reports. Preparing saved results for the review API/UI
needs no provider calls:

```sh
uv run --frozen python -m peekaplate_processing.review_candidates \
  --input work/my-run/extraction.json --output work/my-run/review-candidates.json
```

This keeps original dishes, stable IDs, source/page evidence, processing failures
and warnings. It checks the handoff data; human review still decides correctness.
See [the review handoff guide](../docs/review-candidates.md) for the flow, schema,
synthetic examples and manual tests.

The matching shared review schema preserves hierarchy, heading provenance and
printed price options. VIS-01 and review API consumers still need explicit
version-2 integration; mixed version pairs are rejected rather than relabeled.

**LLM verification is yours to add.** No verification/review agent is included.
Add your verification node after `synthesizer` in `workflow.py` when ready.

## Run

OCR calls use the `OCRProvider` interface in `ocr.py`. `OCRSpaceClient` inherits
from it and remains the default provider. Python callers can pass an existing
provider with `extract_source(path, ocr_provider=provider)`; PDF and image
acquisition depend on the interface's `extract(image)` method. This boundary is
currently OCR.space Engine 3-compatible only: returned `settings` must contain
the integer `OCREngine=3`. Both input paths reject incompatible settings before
accepting text, so another engine cannot silently produce Engine 3 evidence.
Supporting a different provider requires an explicit evidence-contract update.
The default provider, CLI flags and environment names are unchanged.

From `processing`, configure your private `.env` using `.env.example`:

```sh
uv sync --frozen
uv run --frozen python -m peekaplate_processing.extract_menus \
  --input work/test-menus/Dennys_Menu.pdf --output work/dennys-pages-v2.json
```

The command above extracts page text without calling any LLM. For the full graph:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input work/test-menus/Dennys_Menu.pdf --run-dir work/dennys-redesign-001
```

A2Agent takes precedence when any of `a2agent_api_key`, `a2agent_url` or
`a2agent_api_MODEL` is configured; all three are then required. These names are
case sensitive and match the existing private `.env`. For MiniMax M3 use
`https://api.a2agent.me/v1` and `minimax-m3`, as documented in the
[A2Agent quickstart](https://docs.a2agent.me/quickstart) and
[MiniMax catalog](https://a2agent.me/models/minimax-m3). Nara-only/OpenRouter-only
parameters are not sent to A2Agent. Availability and strict-schema support still
need the one-request live check below. Leave all A2Agent fields blank to select
the existing providers.

Otherwise, the graph uses `NARA_ROUTER_KEY`, `NARA_ROUTER_URL` and `NARA_ROUTER_MODEL`
when any Nara setting is present; all three must then be supplied. Use
`https://router.bynara.id/v1` as the Nara chat base URL. Otherwise it uses
`MENU_AI_API_KEY`, `MENU_AI_API_URL` and `MENU_AI_MODEL` from `.env`.
Nara requests do not include OpenRouter-specific routing parameters. They send
`reasoning_effort="none"` to request direct extraction, as described in the
[Nara reasoning documentation](https://router.bynara.id/docs). Provider support
for that control may vary.
The configured provider/model is retained; the research example's hard-coded
`gpt-4o` is not used. The full chat endpoint URL is normalized to the SDK base URL.
Each uncached nonempty batch makes one extraction request; no planner,
synthesis or verification request is made. Automatic SDK retries are disabled.
An unsupported name or wrong page rejects that dish. Unsupported optional
descriptions, categories, ingredients, prices and currencies are cleared to null
with field-specific review warnings, preserving the supported name and other
supported fields. The generated unsupported values are not accepted as facts.
Malformed or schema-invalid output still
rejects the batch. Prices attached to explicit `P`/`PHP` prefixes are recognized;
a peso symbol/prefix alone does not establish a three-letter currency code.
OpenRouter requests strict-parameter support and optional reasoning disabled;
actual provider support must be tested live.

To diagnose the provider before another PDF run, make one small request with the
same dish schema, without OCR or writing a run directory:

```sh
uv run --frozen python -m peekaplate_processing.check_llm
```

For response-format diagnosis only, the fixed synthetic check can print a preview:

```sh
uv run --frozen python -m peekaplate_processing.check_llm --show-response
```

This still makes one synthetic request and writes no files. The preview is opt-in,
limited to 4,000 characters, key-redacted and JSON-escaped for terminal display.
It is not available as a PDF pipeline flag.

The pipeline prints acquisition/cache totals and elapsed time for each LLM batch.
`extraction.json` stores acquisition timing and per-batch durations under
`configuration`. Batch progress prints retained dish counts and errors immediately.
Partially accepted batches are marked `incomplete`. Errors distinguish timeouts, connection failures, HTTP failures
and unusable schema output. Validation failures show up to three known field
paths and validation rules (for example, `dishes[0].price_amount (string_type)`),
including errors raised inside the SDK before raw output is returned. These
examples are diagnostic categories, not established causes of a live failure.
Normal extraction errors do not log provider messages, response values or page text.
The SDK receives a JSON-schema dictionary so eager Pydantic parsing does not
hide raw response content. Code validates the actual content, rather than using
the SDK parser's possibly repaired result. A single complete outer Markdown
JSON fence is removed. A complete leading MiniMax `<think>...</think>` wrapper
is discarded before parsing the final JSON; reasoning-only or unfinished wrappers
are rejected. Empty content, malformed/truncated JSON, duplicate keys,
nonstandard numeric constants and unsupported fields are rejected. No model
repair request is made.
The SDK HTTP timeout is supplemented by a cancellable 90-second deadline for
each LLM batch using async invocation. `--llm-timeout` changes this deadline
(up to 300 seconds). An expired request is cancelled and its batch rejected;
other batches can still succeed. Calls are sequential by default;
`--llm-concurrency 2` overlaps at most two with no automatic LLM retries.
This preserves the call count and may reduce total waiting time. It does not
shorten a single generation or guarantee router reliability. This bounds waiting; it does not guarantee provider speed.

To retry the LLM using saved acquisition output, bypass all PDF rendering/OCR:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input work/test-menus/Dennys_Menu.pdf \
  --pages-json work/dennys-nara-0080/pages.json \
  --run-dir work/dennys-nara-0090 \
  --llm-timeout 90
```

For an explicitly selected smaller-batch trial, add `--batch-pages 2` and choose
a fresh run directory. A 35-page document then produces up to 18 requests
(17 pairs and one final page), compared with four at the default size of ten.
Add `--llm-concurrency 2` only when two overlapping calls are intended.
This reduces work per request but may increase total calls and pacing overhead;
live performance must be measured. Deadlines, strict validation and page-level
evidence are unchanged. Invalid batch sizes are rejected before acquisition.

Complete, schema-valid model candidates are cached privately in `work/llm-cache`
before grounding checks. Matching source bytes, exact page text, provider/model,
request settings, prompt and schema reuse those candidates without another model
call. Schema and grounding checks run again on every reuse, including nulling
unsupported optional fields. Batch metrics record `cache_hit`. Failed, truncated,
refused or malformed responses are not cached. No raw response, reasoning or API
key is stored in this cache. Use `--no-llm-cache` to disable reading and writing it.

POSIX cache files are checked for mode `0600`. Windows permissions depend on
the containing directory's ACLs; POSIX mode bits do not verify Windows privacy.
Windows ACL enforcement has not been validated by this suite.
Build configuration also excludes local environment files and the private
project handoff from source distributions and wheels; Git ignore rules alone
do not control package contents.
The synthetic `check_llm` command always makes a fresh request.

Existing runs predate this cache: their discarded model candidates cannot be
recovered from saved drafts. The first new request populates its cache entry;
later matching runs can reuse it, including after other batches fail. This
reduces repeated work, without making the first generation faster.

The saved report is bounded to 32 MB, validated against the page/text limits,
and its source hash, stored snapshot and actual page coverage must match
`--input`. PDF coverage is checked from metadata without rendering. Omitted
segments are rejected. Missing/failed pages stay explicit:
this option never retries them or carries over old dish drafts. Omit
`--pages-json` when you want normal acquisition and its one OCR retry.

Each new private run directory contains `pages.json` (acquired source/page data)
and `extraction.json` (dish drafts, evidence and explicit errors). Do not reuse
an existing output filename or directory. A failed batch does not erase other
successful batches. `complete` describes processing, not approved facts.

Limits: 40 PDF pages, 12 MB source, 24 MP input image, 950,000-byte OCR upload,
100,000 acquired characters, 100 dishes per LLM response. The full document
can retain more than 100 supported dishes across batches. OCR retries once for eligible
transport/server errors and retains its existing cache. A changed PDF renderer
can produce different image bytes and therefore new OCR requests rather than
cache hits. The supplied Denny file was rechecked with PyMuPDF: all 35 pages
contain displayed images, with zero native text characters or words. OCR is
required for that copy; text-bearing PDFs skip it. Its SHA-256 is
`2430807aeb2556cd85186b1b0d4126a89cee066dea3ccf5ad18b5e23b5082275`.
Provider quotas and quality remain external. The 20-character cutoff is a
simple fallback rule, not a completeness/quality check; a short legitimate page
will also use OCR. Saved `--pages-json` reports bypass acquisition, so omit that
option when testing the new PDF routing.

For a public menu with extractable text, try the 12-page
[Sen Restaurant dinner menu](https://anlam.com/wp-content/uploads/2019/03/Sen-dinner-feb-2019.pdf).
Download it as `work/test-menus/Sen_Dinner_Menu.pdf`, then test acquisition alone:

```sh
uv run --frozen python -m peekaplate_processing.extract_menus \
  --input work/test-menus/Sen_Dinner_Menu.pdf --output work/sen-pages-001.json
```

Inspect each segment's `method` (`pdf_native` or `ocr_space_engine3`) and
`metadata.native_text_chars` to see which route was used. This command makes
no model requests. The PDF's text is readable through the web reader; local
PyMuPDF verification of that external file is pending a download because the
agent terminal cannot resolve its host.

Run the focused suite:

```sh
uv run --frozen python -m unittest discover -s tests
```

The inherited schema remains a Python draft contract; final TypeScript/backend
integration and the ClickUp ground-truth evaluation are still separate work.
Menu imagery is text evidence, not approved photographs of plated dishes.
