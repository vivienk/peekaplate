# PeekaPlate Menu Ingestion & Extraction Guide (PR #58 / V4)

This guide explains how to set up, configure, and test the current menu extraction pipeline delivered in **PR #58** (`feat/vis-02-res-01-evidence-handoff`), covering both **S3-VIS-02** (menu extraction & bounding boxes) and **S3-RES-01.1** (candidate data & source evidence export).

---

## 1. Quick Overview: What the Current Version Does

The pipeline ingests real restaurant menus (PDFs, smartphone photos, digital images) and extracts structured dish candidates conforming to `@peekaplate/contracts` (`ReviewCandidateResultSchema`, Schema 2 / Pipeline 3):

- **Direct Vision Mode (`--input-mode vision_v4`)**:
  - Uses multimodal visual understanding directly on page images.
  - Generates dish titles, descriptions, categories, and printed prices.
  - Emits scaled **physical pixel bounding boxes** for titles and prices inside `segments[0].metadata.vision_boxes`.
  - Automatically merges repeated dish entries caused by multiple printed prices (e.g. `10.00 / 12.00` becomes a single item with `price_amount: null`).
  - Automatically falls back to OCR mode if all vision providers fail.
- **Grounded OCR Mode (`--input-mode ocr_image`)**:
  - Uses OCR.space Engine 3 (`isTable=True`) or PyMuPDF native text + LLM.
  - Enforces strict grounding: names and prices must appear in the OCR text or they are safely cleared to `null` with a warning.
- **Preflight Quality Guards (`preflight.py`)**:
  - Runs automatically on all input images before any OCR or model calls.
  - Safely rejects images that are rotated sideways, skewed $> 15^\circ$, or have very low contrast (saving API quotas).
  - Flags $10^\circ$–$15^\circ$ skew with a review-only warning.
- **Offline Review Candidates Exporter (`review_candidates.py`)**:
  - Transforms `extraction.json` into `review-candidates.json` for the downstream reviewer UI without making network calls.

---

## 2. Environment Configuration (`.env`)

In the `processing/` directory, create or update your `.env` file (`processing/.env`).

### Option A: Google AI Studio (Recommended Primary)
Google AI Studio offers fast inference, native high-resolution image support, and low latency for multi-page PDFs.

```ini
# Primary: Google AI Studio
GEMINI_API_KEY=your_google_ai_studio_api_key_here
GEMINI_MODEL=models/gemini-3-flash-preview
GEMINI_API_URL=https://generativelanguage.googleapis.com/v1beta/openai
```

*(Note: `reasoning_effort="low"` is preconfigured in `model_providers.py` so internal thinking tokens do not consume output token headroom on dense 80+ dish menus).*

### Option B: OpenRouter (Secondary / Fallback)
OpenRouter provides unified access to open vision models (such as Qwen 3.8 Flash).

```ini
# Secondary: OpenRouter
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

*(Note: The pipeline automatically defaults `max_tokens` to 16,384, providing sufficient headroom for large multi-column menus without output truncation).*

### Optional: OCR Provider (Required for `ocr_image` mode only)
```ini
# OCR.space Engine 3 (Only required if running --input-mode ocr_image or fallback)
OCR_SPACE_API_KEY=your_ocr_space_api_key_here
```

---

## 3. How to Run the Pipeline

Run commands from the `processing/` folder using `uv`:

```bash
cd processing
```

### Command 1: Direct Multimodal Vision Mode (`vision_v4`)
*Recommended for most physical photos, multi-column layouts, and multi-page PDFs.*

```bash
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input "/path/to/your/menu.pdf" \
  --run-dir "work/my-test-run" \
  --input-mode vision_v4 \
  --provider google_studio \
  --llm-timeout 120
```

*(To use OpenRouter instead of Google, pass `--provider qwen`).*

### Command 2: Grounded OCR Mode (`ocr_image`)
*Runs OCR.space Engine 3 text extraction followed by strict text-span grounding.*

```bash
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input "/path/to/your/menu.pdf" \
  --run-dir "work/my-ocr-run" \
  --input-mode ocr_image \
  --provider google_studio \
  --batch-pages 2 \
  --llm-concurrency 1
```

---

## 4. How to Export & Validate Review Candidates

Once extraction finishes, export the results to the versioned review envelope:

```bash
uv run --frozen python -m peekaplate_processing.review_candidates \
  --input "work/my-test-run/extraction.json" \
  --output "work/my-test-run/review-candidates.json"
```

### How to Inspect the Generated Data

You can inspect the results using a Python one-liner:

```bash
python3 -c "
import json
d = json.load(open('work/my-test-run/review-candidates.json'))
print(f'Status: {d[\"status\"]} | Total Candidates: {len(d[\"candidates\"])}')
v_boxes = d['segments'][0]['metadata'].get('vision_boxes', {})
print(f'Candidates with Bounding Boxes: {len(v_boxes)}')

print('\nFirst 3 Candidates:')
for c in d['candidates'][:3]:
    orig = c['original']
    cid = c['candidate_id']
    boxes = v_boxes.get(cid, [])
    print(f\"- {orig['name']} [{orig.get('category')}] | Price: '{orig.get('price_text')}' (amount: {orig.get('price_amount')})\")
    for b in boxes:
        box = b['box']
        print(f\"    Box [{b['type']}]: left={box['left']}, top={box['top']}, width={box['width']}, height={box['height']} px\")
"
```

---

## 5. Output Files Explained

Every run directory (`work/<your-run-dir>/`) contains:
1. `extraction.json`: Full machine-readable extraction report with source provenance, segments, drafts, evidence joins, and library configurations.
2. `review-candidates.json`: Downstream contract payload conforming to `@peekaplate/contracts` `ReviewCandidateResultSchema`, containing candidates, metadata, and pixel bounding boxes.
3. `timings.json`: Accurate wall-clock latency breakdown per pipeline stage (`preflight`, `acquisition`, `source_images`, `llm_wall`, `extraction_write`).

---

## 6. How to Run the Offline Verification Suite

To verify tests locally without making any paid network calls:

### Python Offline Suite (434 tests under socket guard):
```bash
uv run --frozen --offline --no-env-file python tests/run_offline.py
```
*(Windows Note: `tests/run_offline.py` automatically detects Windows and re-executes with `-X utf8` and permits loopback socketpairs for asyncio).*

### Repository-wide TypeScript & Lint Checks:
From the repository root:
```bash
pnpm check
```
*(Runs Biome linter, typecheck on all workspace packages, Vitest tests, context validation, and documentation link checks).*
