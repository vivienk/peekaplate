"""Local PDF/image -> page text -> page-batch workers -> dish schema. No verification LLM."""
import argparse
import base64

import pymupdf
import hashlib
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from pydantic import ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.schemas import DishDraft, DraftEvidence, SourceSpan, MenuExtractionResult
from peekaplate_processing.storage import save_json
from peekaplate_processing.workflow import run_menu_graph
from peekaplate_processing.sources import read_file, detect_kind


def configured_llm():
    a2_names = ("a2agent_api_key", "a2agent_url", "a2agent_api_MODEL")
    nara_names = ("NARA_ROUTER_KEY", "NARA_ROUTER_URL", "NARA_ROUTER_MODEL")
    names = nara_names if any(os.environ.get(n) for n in nara_names) else ("MENU_AI_API_KEY", "MENU_AI_API_URL", "MENU_AI_MODEL")
    if any(os.environ.get(n) for n in a2_names):
        names = a2_names
    key, endpoint, model = (os.environ.get(n, "").strip() for n in names)
    if not all((key, endpoint, model)):
        raise ExtractionError(f"Set {', '.join(names)} in .env.")
    base_url = endpoint.removesuffix("/").removesuffix("/chat/completions")
    try:
        url = urlsplit(base_url)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment: raise ValueError
    except ValueError:
        raise ExtractionError("Use an HTTPS model endpoint without embedded credentials.") from None
    extra = {"reasoning": {"enabled": False}, "provider": {"require_parameters": True}} if url.hostname == "openrouter.ai" else {}
    reasoning = {"reasoning_effort": "none"} if url.hostname == "router.bynara.id" else {}
    return ChatOpenAI(**reasoning, model=model, api_key=key, base_url=base_url, timeout=120, max_retries=0, max_tokens=16384, extra_body=extra)


def saved_page_text(source, pages_json):
    try:
        with Path(pages_json).open("rb") as handle:
            data = handle.read(32_000_001)
        if len(data) > 32_000_000:
            raise ValueError
        saved = MenuExtractionResult.model_validate_json(data)
    except (OSError, ValueError):
        raise ExtractionError("Saved page report is invalid or exceeds 32 MB.") from None
    source_data = read_file(source)
    digest = hashlib.sha256(source_data).hexdigest()
    if not saved.source or saved.source.sha256 != digest or saved.source.source_id != f"sha256:{digest}":
        raise ExtractionError("Saved pages do not match the input file.")
    kind = detect_kind(source_data)
    try:
        if saved.source.kind != kind or saved.source.size_bytes != len(source_data) or base64.b64decode(saved.source.snapshot_base64, validate=True) != source_data:
            raise ValueError
    except ValueError:
        raise ExtractionError("Saved source snapshot does not match the input file.") from None
    page_count = 1
    if kind == "pdf":
        try:
            with pymupdf.open(stream=source_data, filetype="pdf") as document:
                if document.needs_pass:
                    raise ValueError
                page_count = len(document)
        except (RuntimeError, ValueError):
            raise ExtractionError("Unable to verify saved PDF page coverage.") from None
    numbers = [s.page_number for s in saved.segments]
    if set(numbers) != set(range(1, page_count + 1)):
        raise ExtractionError("Saved pages must include every source page, including failed/skipped pages.")
    if not 1 <= len(numbers) <= 40 or any(n is None or n > 40 for n in numbers) or len(set(numbers)) != len(numbers) or len({s.segment_id for s in saved.segments}) != len(numbers) or sum(len(s.text) for s in saved.segments) > 100_000:
        raise ExtractionError("Saved pages exceed page/text limits or have invalid page identities.")
    return MenuExtractionResult(
        source=saved.source, segments=saved.segments, started_at=datetime.now(timezone.utc),
        library_versions=saved.library_versions, configuration={"reused_page_text": True},
        warnings=["Reused saved page text; missing pages were not retried."],
        errors=[f"Page {s.page_number}: {s.error or 'Saved page acquisition failed.'}" for s in saved.segments if s.status == "failed"],
    )


def run_pipeline(source, run_dir, *, llm=None, ocr_api_key=None, cache_dir="work/ocr-cache", pages_json=None, llm_timeout=90, batch_pages=10, llm_concurrency=1, llm_cache_dir="work/llm-cache"):
    if type(llm_concurrency) is not int or llm_concurrency not in (1, 2):
        raise ExtractionError("LLM concurrency must be 1 or 2.")
    if type(batch_pages) is not int or not 1 <= batch_pages <= 10:
        raise ExtractionError("LLM batch pages must be an integer between 1 and 10.")
    if not math.isfinite(llm_timeout) or not 0 < llm_timeout <= 300:
        raise ExtractionError("LLM deadline must be greater than zero and at most 300 seconds.")
    directory = Path(run_dir)
    if directory.exists() or directory.is_symlink(): raise ExtractionError("Choose a new run directory.")
    if llm is None: llm = configured_llm()
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    acquisition_started = time.perf_counter()
    print("Acquiring page text (reusing cached OCR where available)...", file=sys.stderr, flush=True)
    report = saved_page_text(source, pages_json) if pages_json is not None else extract_source(source, ocr_api_key=ocr_api_key, cache_dir=cache_dir)
    acquisition_seconds = round(time.perf_counter() - acquisition_started, 3)
    report.configuration["timings_seconds"] = {"acquisition": acquisition_seconds}
    cache_hits = sum(s.metadata.get("cache_hit") is True for s in report.segments)
    print(f"Page text acquired in {acquisition_seconds:.1f}s; {cache_hits} OCR cache hits, {sum(s.status == 'failed' for s in report.segments)} failed pages.", file=sys.stderr, flush=True)
    save_json(report.model_dump(mode="json"), directory / "pages.json")
    report.configuration["llm_deadline_seconds"] = llm_timeout
    report.configuration["llm_batch_pages"] = batch_pages
    report.configuration["llm_concurrency"] = llm_concurrency
    report.extraction_mode = "ai"
    report.extraction_model = getattr(llm, "model_name", None)
    if report.source and any(s.status == "ready" and s.text.strip() for s in report.segments) and sum(len(s.text) for s in report.segments) <= 100_000:
        pages = [{"page_number": s.page_number, "text": s.text if s.status == "ready" else ""} for s in report.segments]
        output = run_menu_graph(llm, pages, request_timeout=llm_timeout, batch_pages=batch_pages, concurrency=llm_concurrency, cache_dir=llm_cache_dir, source_sha256=report.source.sha256)
        report.errors.extend(output["errors"])
        report.warnings.extend(output["warnings"])
        report.configuration["llm_batches"] = output["batches"]
        by_page = {s.page_number: s for s in report.segments}
        for item in output["dishes"]:
            segment = by_page[item["page_number"]]
            try:
                draft = DishDraft(**{k:v for k,v in item.items() if k not in {"page_number", "review_warnings"}}, source_id=report.source.source_id, source_text=segment.text.strip(), review_warnings=["Page-level evidence; dish/price association needs human verification.", *item.get("review_warnings", [])])
            except ValidationError:
                report.errors.append(f"Page {segment.page_number}: dish failed schema validation.")
                continue
            index = len(report.drafts)
            draft_id = "draft:" + hashlib.sha256(f"{report.source.sha256}:{index}:{draft.model_dump_json()}".encode()).hexdigest()[:32]
            start = segment.text.find(draft.source_text)
            report.drafts.append(draft)
            report.evidence.append(DraftEvidence(draft_id=draft_id, draft_index=index, spans=[SourceSpan(segment_id=segment.segment_id, start=start, end=start+len(draft.source_text))]))
    if not report.drafts: report.errors.append("No reviewable dishes were extracted.")
    report.status = "incomplete" if report.errors and report.drafts else "failed" if report.errors else "complete"
    report.finished_at = datetime.now(timezone.utc)
    report.warnings.append("LLM verification is not implemented; all dishes remain needs_review.")
    save_json(report.model_dump(mode="json"), directory / "extraction.json")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--pages-json", type=Path, help="Reuse a saved page report matching --input; no OCR calls.")
    parser.add_argument("--llm-timeout", type=float, default=90, help="Cancellable deadline per LLM batch in seconds (default: 90; maximum: 300).")
    parser.add_argument("--batch-pages", type=int, default=10, help="Pages per LLM request, from 1 to 10 (default: 10); smaller batches make more calls.")
    parser.add_argument("--llm-concurrency", type=int, default=1, help="Simultaneous LLM calls, 1 or 2 (default: 1); starts remain spaced apart.")
    parser.add_argument("--no-llm-cache", action="store_true", help="Make fresh model requests instead of reusing complete cached candidates.")
    args = parser.parse_args(argv)
    load_dotenv(override=False, interpolate=False)
    try:
        report = run_pipeline(args.input, args.run_dir, ocr_api_key=os.environ.get("OCR_SPACE_API_KEY"), pages_json=args.pages_json, llm_timeout=args.llm_timeout, batch_pages=args.batch_pages, llm_concurrency=args.llm_concurrency, llm_cache_dir=None if args.no_llm_cache else "work/llm-cache")
    except (ExtractionError, OSError) as error:
        parser.exit(1, f"Pipeline failed: {error if isinstance(error, ExtractionError) else 'Unable to write run files.'}\n")
    print(f"Saved {len(report.drafts)} drafts ({report.status}) to {args.run_dir / 'extraction.json'}.")
    for error in report.errors: print(error)
    return 0 if report.status == "complete" else 2 if report.status == "incomplete" else 1


if __name__ == "__main__": raise SystemExit(main())
