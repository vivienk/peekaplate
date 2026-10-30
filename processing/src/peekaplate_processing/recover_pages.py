"""Explicit, create-only failed-page OCR recovery. No model or cache calls.

The full saved source coverage is retained; only selected failed Engine 3 pages
are reacquired. A failed request stops the run, including HTTP 429. Historical
failures belong to the manifest, not to repaired segments' current error fields.
"""
import argparse
import base64
import hashlib
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import pymupdf
from dotenv import load_dotenv

from .errors import ExtractionError
from .images import extract_image, open_image
from .ocr_space import OCRSpaceClient
from .pdf import MAX_PDF_PAGES, MIN_NATIVE_TEXT_CHARS, extract_pdf
from .schemas import MenuExtractionResult
from .sources import detect_kind, read_file
from .storage import save_json
from .vision import normalize_page_selection

MAX_RECOVERY_REQUESTS = 4
MAX_REPORT_BYTES = 32_000_000


def _preflight(source, pages_json, selected):
    try:
        with Path(pages_json).open('rb') as handle:
            raw = handle.read(MAX_REPORT_BYTES + 1)
        if len(raw) > MAX_REPORT_BYTES:
            raise ValueError
        saved = MenuExtractionResult.model_validate_json(raw)
    except (OSError, ValueError):
        raise ExtractionError('Saved page report is invalid or exceeds 32 MB.') from None
    data = read_file(source)
    digest = hashlib.sha256(data).hexdigest()
    record = saved.source
    kind = detect_kind(data)
    try:
        if (record is None or record.sha256 != digest or record.source_id != f'sha256:{digest}'
                or record.size_bytes != len(data) or record.kind != kind
                or base64.b64decode(record.snapshot_base64, validate=True) != data):
            raise ValueError
    except ValueError:
        raise ExtractionError('Saved source snapshot, hash, size or kind does not match the input.') from None

    count = 1
    if kind == 'pdf':
        try:
            with pymupdf.open(stream=data, filetype='pdf') as doc:
                count = len(doc)
                if doc.needs_pass or not 1 <= count <= MAX_PDF_PAGES or any(n > count for n in selected):
                    raise ExtractionError('Selected PDF pages must exist in an unlocked, bounded source.')
                # Check only selected pages. Do not load/render/acquire other pages.
                for number in selected:
                    page = doc.load_page(number - 1)
                    text = page.get_text('text', sort=True).strip()
                    if len(''.join(text.split())) >= MIN_NATIVE_TEXT_CHARS:
                        raise ExtractionError('Native-text pages cannot use failed-OCR recovery.')
                    if not all(math.isfinite(v) and 0 < v <= 14_400 for v in (page.rect.width, page.rect.height)):
                        raise ExtractionError('Selected PDF page exceeds the rendering limit.')
        except (RuntimeError, ValueError):
            raise ExtractionError('Unable to verify selected PDF pages.') from None
    else:
        if selected != (1,):
            raise ExtractionError('An image source has only page 1.')
        with open_image(data):
            pass

    numbers = [s.page_number for s in saved.segments]
    suffix = 'page' if kind == 'pdf' else 'image'
    if (len(numbers) != count or set(numbers) != set(range(1, count + 1))
            or any(s.segment_id != f'{record.source_id}#{suffix}-{s.page_number}' for s in saved.segments)
            or sum(len(s.text) for s in saved.segments) > 100_000):
        raise ExtractionError('Saved pages must have complete, unique source page coverage within text limits.')
    by_number = {s.page_number: s for s in saved.segments}
    for number in selected:
        segment = by_number[number]
        if segment.status != 'failed' or segment.method != 'ocr_space_engine3' or not segment.error:
            raise ExtractionError('Select only failed Engine 3 OCR pages with a recorded failure.')
    return saved, data, raw


def recover_pages(source, pages_json, output_dir, *, page_numbers, max_requests,
                  ocr_api_key=None, timeout=90, is_table=None):
    """Recover <=4 explicitly selected failures, one HTTP attempt per page.

    All validation and output collision checks precede client construction.
    Output directory must not exist; pages.json is acquisition-only. The manifest
    retains prior failures/errors and exact report/source hashes for audit.
    """
    if type(max_requests) is not int or not 1 <= max_requests <= MAX_RECOVERY_REQUESTS:
        raise ExtractionError('max_requests must be an explicit integer between 1 and 4.')
    selected = normalize_page_selection(page_numbers, limit=max_requests)
    directory = Path(output_dir)
    if directory.exists() or directory.is_symlink():
        raise ExtractionError('Recovery output already exists; choose a new directory.')
    saved, data, raw = _preflight(source, pages_json, selected)
    if is_table is None:
        is_table = saved.configuration.get('ocr_is_table', True)
    if type(is_table) is not bool:
        raise ExtractionError('Recovery OCR table setting must be boolean.')
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 120:
        raise ExtractionError('OCR timeout must be greater than zero and at most 120 seconds.')
    # Reserve private, create-only output before a client can send anything.
    try:
        directory.mkdir(mode=0o700)
    except OSError:
        raise ExtractionError('Unable to create a new private recovery output directory.') from None
    client = OCRSpaceClient(ocr_api_key, cache_dir=None, timeout=timeout,
                            is_table=is_table, max_attempts=1)
    now = datetime.now(timezone.utc)
    segments = [s.model_copy(deep=True) for s in saved.segments]
    # Candidate links are downstream evidence, not acquisition metadata.
    for segment in segments:
        segment.metadata.pop('candidate_box_evidence', None)
    manifest = {
        'schema_version': 1, 'stage': 'failed_ocr_recovery',
        'input_report_sha256': hashlib.sha256(raw).hexdigest(),
        'source_sha256': saved.source.sha256, 'source_size_bytes': len(data),
        'previous_status': saved.status, 'previous_errors': list(saved.errors),
        'previous_failures': [s.model_dump(mode='json') for s in saved.segments if s.status == 'failed'],
        'max_requests': max_requests, 'max_attempts_per_page': 1, 'cache_bypassed': True,
        'ocr_is_table': is_table, 'requests_attempted': 0,
        'pages': [{'page_number': n, 'status': 'not_attempted'} for n in selected],
        'started_at': now.isoformat(),
    }
    for attempt in manifest['pages']:
        number = attempt['page_number']
        index = next(i for i, s in enumerate(segments) if s.page_number == number)
        try:
            if saved.source.kind == 'pdf':
                repaired = extract_pdf(data, saved.source.source_id, client, page_numbers=[number])[0]
            else:
                repaired = extract_image(data, saved.source.source_id, client)
                repaired.page_number = 1
            if repaired.status != 'ready' or repaired.error is not None or not repaired.text.strip():
                raise ExtractionError(repaired.error or 'Recovery returned no usable OCR text.')
            if repaired.method != 'ocr_space_engine3' or repaired.metadata.get('cache_hit') is not False:
                raise ExtractionError('Recovery requires fresh successful Engine 3 OCR.')
            if sum(len(s.text) for i, s in enumerate(segments) if i != index) + len(repaired.text) > 100_000:
                raise ExtractionError('Recovered combined text exceeds the 100,000-character limit.')
            segments[index] = repaired
            attempt['status'] = 'repaired'
        except (ExtractionError, RuntimeError, ValueError, OSError) as error:
            # Keep the old failed segment intact. The new failure has its own
            # manifest record, so neither old nor current evidence is erased.
            attempt['status'] = 'failed'
            attempt['error'] = str(error) if isinstance(error, ExtractionError) else 'Page recovery failed.'
            break
    manifest['requests_attempted'] = client.transport_attempts
    errors = [f'Page {s.page_number}: {s.error or "Page acquisition is not ready."}' for s in segments if s.status != 'ready']
    ready = any(s.status == 'ready' and s.text.strip() for s in segments)
    report = MenuExtractionResult(
        source=saved.source, started_at=now, finished_at=datetime.now(timezone.utc),
        segments=segments, library_versions=saved.library_versions,
        configuration={'stage': 'text_acquisition', 'ocr_is_table': is_table,
                       'failed_ocr_recovery': {'input_report_sha256': manifest['input_report_sha256'],
                                               'selected_pages': list(selected), 'max_requests': max_requests}},
        errors=errors, status='incomplete' if errors and ready else 'failed' if errors else 'complete',
        warnings=['Explicit failed-page OCR recovery; see manifest.json for prior failures and unattempted pages.'],
    )
    manifest['finished_at'] = report.finished_at.isoformat()
    save_json(report.model_dump(mode='json'), directory/'pages.json')
    save_json(manifest, directory/'manifest.json')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description='Explicit bounded failed-page OCR recovery; no model calls.')
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--pages-json', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--target-pages', required=True, nargs='+', type=int)
    parser.add_argument('--max-requests', required=True, type=int)
    parser.add_argument('--no-ocr-table', action='store_true', default=None)
    args = parser.parse_args(argv)
    load_dotenv(override=False, interpolate=False)
    try:
        report = recover_pages(args.input, args.pages_json, args.output_dir,
                               page_numbers=args.target_pages, max_requests=args.max_requests,
                               ocr_api_key=os.environ.get('OCR_SPACE_API_KEY'),
                               is_table=False if args.no_ocr_table else None)
    except ExtractionError as error:
        parser.exit(1, f'Recovery failed: {error}\n')
    print(f'Saved {len(report.segments)} source pages ({report.status}); inspect manifest.json.')
    return 0 if report.status == 'complete' else 2 if report.status == 'incomplete' else 1


if __name__ == '__main__':
    raise SystemExit(main())
