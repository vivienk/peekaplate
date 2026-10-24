# OCR and LLM test input

`Dennys_Menu.pdf` is the exact 35-page menu used for the live extraction test on
23 October 2026. Included at the contributor's request for reviewer reproduction.

- Size: 7,187,184 bytes.
- SHA-256: `2430807aeb2556cd85186b1b0d4126a89cee066dea3ccf5ad18b5e23b5082275`.
- This input is entirely scanned under the current native-text threshold; it is
  not the mixed native/scanned PDF that remains an evaluation follow-up.
- It is an input, not a reviewed ground-truth dataset. Generated drafts and
  field accuracy have not been independently accepted.

From `processing`, with your own private OCR/model configuration:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input ../test-data/Dennys_Menu.pdf \
  --run-dir work/dennys-review \
  --batch-pages 1 --llm-concurrency 2 --no-llm-cache
```

This makes live provider requests and uses the existing OCR cache when available.
For an LLM-only retry with a new output directory and matching saved page report:

```sh
uv run --frozen python -m peekaplate_processing.run_pipeline \
  --input ../test-data/Dennys_Menu.pdf \
  --pages-json work/dennys-review/pages.json \
  --run-dir work/dennys-review-retry \
  --batch-pages 1 --llm-concurrency 2 --no-llm-cache
```

See [the test results and limits](../docs/ocr-delivery.md#fresh-live-pdf-test--23-october-2026).
Do not treat a source-linked draft or successful test request as approval to publish.
