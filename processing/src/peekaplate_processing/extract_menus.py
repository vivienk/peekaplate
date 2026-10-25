"""PDF/image acquisition only. No LLM calls."""
import argparse
import base64
import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import extract_image
from peekaplate_processing.ocr import OCRProvider
from peekaplate_processing.ocr_space import OCRSpaceClient
from peekaplate_processing.pdf import MIN_NATIVE_TEXT_CHARS, extract_pdf
from peekaplate_processing.schemas import MenuExtractionResult, SourceRecord, SourceSegment
from peekaplate_processing.sources import detect_kind, read_file
from peekaplate_processing.storage import save_json


def extract_source(source: str | Path, *, ocr_api_key=None, cache_dir="work/ocr-cache", timeout=120, ocr_provider: OCRProvider | None = None) -> MenuExtractionResult:
    result = MenuExtractionResult(started_at=datetime.now(timezone.utc))
    result.configuration = {"stage": "text_acquisition", "pdf_engine": "pymupdf", "max_pdf_pages": 40, "min_pdf_native_text_chars": MIN_NATIVE_TEXT_CHARS}
    try:
        data = read_file(source)
        kind = detect_kind(data)
        digest = hashlib.sha256(data).hexdigest()
        source_id = f"sha256:{digest}"
        result.source = SourceRecord(source_id=source_id, sha256=digest, kind=kind, location=Path(source).name, retrieved_at=datetime.now(timezone.utc), size_bytes=len(data), snapshot_base64=base64.b64encode(data).decode())
        ocr = ocr_provider if ocr_provider is not None else OCRSpaceClient(ocr_api_key, cache_dir=cache_dir, timeout=timeout)

        if kind == "pdf":
            result.segments = extract_pdf(data, source_id, ocr)

        else:
            try:
                result.segments = [extract_image(data, source_id, ocr)]
            except ExtractionError as error:
                result.segments = [SourceSegment(segment_id=f"{source_id}#image-1", page_number=1, method="ocr_space_engine3", status="failed", error=str(error))]

        for index, segment in enumerate(result.segments, start=1):
            segment.page_number = segment.page_number or index
            if segment.status == "failed": result.errors.append(f"Page {segment.page_number}: {segment.error}")

        if sum(len(s.text) for s in result.segments) > 100_000:
            result.errors.append("Combined text exceeds the 100,000-character limit.")

        if not any(s.status == "ready" and s.text.strip() for s in result.segments):
            result.errors.append("No readable text was extracted.")

    except ExtractionError as error:
        result.errors.append(str(error))
    result.status = "incomplete" if result.errors and any(s.text for s in result.segments) else "failed" if result.errors else "complete"
    result.finished_at = datetime.now(timezone.utc)

    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Extract page text using PyMuPDF and OCR.space, without an LLM.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    load_dotenv(override=False, interpolate=False)

    try:
        if args.output.exists() or args.output.is_symlink(): raise ExtractionError("Choose a new output path.")
        result = extract_source(args.input, ocr_api_key=os.environ.get("OCR_SPACE_API_KEY"))
        save_json(result.model_dump(mode="json"), args.output)

    except ExtractionError as error: parser.exit(1, f"Extraction failed: {error}\n")
    print(f"Saved {len(result.segments)} pages ({result.status}) to {args.output}.")
    for error in result.errors: print(error)
    return 0 if result.status == "complete" else 2 if result.status == "incomplete" else 1


if __name__ == "__main__": raise SystemExit(main())
