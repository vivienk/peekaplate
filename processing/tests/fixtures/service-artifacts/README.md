# Synthetic internal artifact bundle

`representative-bundle.json` reuses the existing synthetic three-page review
fixture, not a live menu or provider response. It contains the unchanged grounded
report, a separately labelled raw price suggestion of99, final synthetic timing
and real page-image metadata rendered locally from the embedded synthetic PDF.
No OCR or model calls generated it.

Python's negotiated service response and the TypeScript host consume the same
fixture. The public response remains the extraction report; private suggestions
and final timings are stored only in the private artifact bundle. The local image
path is not a hosted URL: immutable source bytes/hash and page are retained in the
report so an authorized reviewer can inspect the original page.
