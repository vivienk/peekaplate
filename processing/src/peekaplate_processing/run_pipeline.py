import copy
"""PDF/photo -> selected model input -> grounded drafts and private suggestions."""
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

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.schemas import DishDraft, DraftEvidence, SourceSpan, MenuExtractionResult, validate_box_evidence
from peekaplate_processing.storage import save_json
from peekaplate_processing.workflow import INPUT_MODES, page_batches, run_menu_graph
from peekaplate_processing.sources import read_file, detect_kind
from peekaplate_processing.timing import measure
from peekaplate_processing.vision import image_source, normalize_page_selection, page_images
from peekaplate_processing.review_suggestions import private_result

from peekaplate_processing.vision_extraction import extract_vision_v4, build_v4_result

from peekaplate_processing.model_providers import create_model_client, create_cascading_clients, PROVIDER_REGISTRY


def configured_llm(timeout=120, provider=None):
    return create_model_client(provider_name=provider, timeout=timeout)


def saved_page_text(source, pages_json, *, recovery=False):
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
    configuration={"reused_page_text": True}
    if "failed_ocr_recovery" in saved.configuration:
        configuration["failed_ocr_recovery"]=copy.deepcopy(saved.configuration["failed_ocr_recovery"])
    if recovery:
        configuration["targeted_model_recovery"]={
            "input_report_sha256":hashlib.sha256(data).hexdigest(),
            "previous_status":saved.status, "previous_errors":list(saved.errors),
            "previous_model_batches":saved.configuration.get("llm_batches",[]),
        }
    elif saved.errors or saved.configuration.get("llm_batches"):
        configuration["superseded_model_history"]={
            "input_report_sha256":hashlib.sha256(data).hexdigest(),
            "previous_status":saved.status, "previous_errors":list(saved.errors),
            "previous_model_batches":saved.configuration.get("llm_batches",[]),
        }
    errors=[]
    for s in saved.segments:
        if s.status == "failed":
            errors.append(f"Page {s.page_number}: {s.error or 'Saved page acquisition failed.'}")
        elif s.status == "skipped":
            errors.append(f"Page {s.page_number}: {s.error or 'Saved page acquisition was skipped.'}")
        elif s.error is not None:
            errors.append(f"Page {s.page_number}: {s.error}")
    return MenuExtractionResult(
        source=saved.source, segments=saved.segments, started_at=datetime.now(timezone.utc),
        library_versions=saved.library_versions, configuration=configuration,
        warnings=["Reused saved page text; missing pages were not retried."],
        errors=errors,
    )


def run_pipeline(source, run_dir, *, llm=None, ocr_api_key=None, cache_dir="work/ocr-cache", pages_json=None, llm_timeout=90, batch_pages=10, llm_concurrency=1, llm_cache_dir="work/llm-cache", input_mode="ocr_image", is_table=True, target_pages=None, max_model_requests=None, provider=None):
    if target_pages is not None:
        target_pages=normalize_page_selection(target_pages,limit=4)
        if pages_json is None or input_mode=="image" or type(max_model_requests) is not int or not 1 <= max_model_requests <= 4:
            raise ExtractionError("Targeted recovery requires saved pages, OCR input mode and an explicit model-request budget between 1 and 4.")
    elif max_model_requests is not None:
        raise ExtractionError("A model-request budget requires an explicit target-page selection.")
    if input_mode not in INPUT_MODES:
        raise ExtractionError("Input mode must be ocr, ocr_image or image.")
    if input_mode=="image" and pages_json is not None:
        raise ExtractionError("Image-only mode cannot use --pages-json; no OCR text is read.")
    if type(llm_concurrency) is not int or llm_concurrency not in (1, 2):
        raise ExtractionError("LLM concurrency must be 1 or 2.")
    if type(batch_pages) is not int or not 1 <= batch_pages <= 10:
        raise ExtractionError("LLM batch pages must be an integer between 1 and 10.")
    if not math.isfinite(llm_timeout) or not 0 < llm_timeout <= 300:
        raise ExtractionError("LLM deadline must be greater than zero and at most 300 seconds.")
    directory = Path(run_dir)
    if directory.exists() or directory.is_symlink(): raise ExtractionError("Choose a new run directory.")
    if llm is None: llm = configured_llm(timeout=max(120, int(llm_timeout)), provider=provider)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    started=time.perf_counter()
    timings={}
    report=None
    completed=False
    try:
        fallback_warnings = []
        prepared_images = []
        if input_mode == "vision_v4":
            print("Running V4 direct multimodal extraction with native bounding boxes...", file=sys.stderr, flush=True)
            with measure(timings, "acquisition"):
                report = image_source(source)
            with measure(timings, "source_images"):
                images, image_errors = page_images(report.source, directory)
                prepared_images = images
            report.errors.extend(image_errors)

            # Provider cascade: explicit provider or cascade: google_studio -> openrouter -> a2agent
            client_candidates = [(provider, llm)] if provider else create_cascading_clients(timeout=llm_timeout)
            if not client_candidates:
                client_candidates = [("default", llm)]

            v4_success = False
            for p_name, p_client in client_candidates:
                try:
                    print(f"Trying V4 vision extraction with provider '{p_name}' ({getattr(p_client, 'model_name', 'unknown')})...", file=sys.stderr, flush=True)
                    with measure(timings, "llm_wall"):
                        v4_dishes = extract_vision_v4(p_client, images, timeout=llm_timeout)
                    if not v4_dishes:
                        raise ExtractionError("Vision extraction produced 0 dishes.")
                    v4_report = build_v4_result(report.source, images, v4_dishes, datetime.fromtimestamp(started, tz=timezone.utc))
                    v4_report.extraction_model = getattr(p_client, "model_name", None)
                    with measure(timings, "extraction_write"):
                        save_json(v4_report.model_dump(mode="json"), directory / "extraction.json")
                    report = v4_report
                    completed = True
                    v4_success = True
                    return report
                except Exception as prov_err:
                    print(f"Provider '{p_name}' failed ({prov_err}); trying next provider in cascade...", file=sys.stderr, flush=True)
                    fallback_warnings.append(f"Provider '{p_name}' failed: {prov_err}")

            if not v4_success:
                print("All vision providers failed; cleanly falling back to OCR mode...", file=sys.stderr, flush=True)
                input_mode = "ocr_image"
        print("Preparing image-only source (no OCR or native text)..." if input_mode=="image" else "Acquiring page text (reusing cached OCR where available)...", file=sys.stderr, flush=True)
        with measure(timings, "acquisition"):
            report = image_source(source) if input_mode=="image" else saved_page_text(source, pages_json, recovery=True) if target_pages is not None else saved_page_text(source, pages_json) if pages_json is not None else extract_source(source, ocr_api_key=ocr_api_key, cache_dir=cache_dir, is_table=is_table)
        report.warnings.extend(fallback_warnings)
        if target_pages is not None:
            by_number={segment.page_number:segment for segment in report.segments}
            if any(number not in by_number or by_number[number].status!="ready" or by_number[number].error is not None or not by_number[number].text.strip() for number in target_pages):
                raise ExtractionError("Targeted model recovery requires ready saved source text for every selected page; recover failed OCR first.")
            omitted=sorted(set(by_number)-set(target_pages))
            report.configuration["targeted_model_recovery"].update(
                selected_pages=list(target_pages),max_model_requests=max_model_requests,unprocessed_pages=omitted)
            if omitted:
                report.errors.append("Targeted extraction: unselected pages were not processed or merged from previous attempts.")
        report.configuration.update(input_mode=input_mode,ocr_enabled=input_mode!="image")
        report.configuration["timings_seconds"]=timings
        report.configuration.update(llm_deadline_seconds=llm_timeout, llm_batch_pages=batch_pages, llm_concurrency=llm_concurrency)
        cache_hits=0 if pages_json is not None else sum(segment.metadata.get("cache_hit") is True for segment in report.segments)
        print("Image-only source prepared without OCR." if input_mode=="image" else f"Page text acquired in {timings['acquisition']:.1f}s; {cache_hits} OCR cache hits, {sum(s.status == 'failed' for s in report.segments)} failed pages.", file=sys.stderr, flush=True)
        with measure(timings, "pages_write"):
            save_json(report.model_dump(mode="json"), directory / "pages.json")
        report.extraction_mode="ai"
        report.extraction_model=getattr(llm, "model_name", None)
        images = prepared_images
        if input_mode != "ocr" and report.source and not images:
            with measure(timings, "source_images"):
                images, image_errors = page_images(report.source, directory) if target_pages is None else page_images(report.source, directory, page_numbers=target_pages)
            report.errors.extend(image_errors)
        pages=[{"page_number":segment.page_number,"segment_id":segment.segment_id,
                "text":segment.text if segment.status=="ready" and segment.error is None else "",
                "ocr_metadata":segment.metadata if segment.method=="ocr_space_engine3" and segment.status=="ready" and segment.error is None else None}
               for segment in report.segments if target_pages is None or segment.page_number in target_pages]
        if input_mode=="image":
            pages=images
        elif input_mode=="ocr_image":
            by_number={page["page_number"]:page for page in images}
            pages=[{**page,**by_number[page["page_number"]]} for page in pages if page["page_number"] in by_number]
        if target_pages is not None:
            planned=len(page_batches(pages,batch_pages,input_mode))
            if planned > max_model_requests:
                raise ExtractionError("Selected recovery batches exceed the explicit model-request budget; no model call was made.")
            report.configuration["targeted_model_recovery"]["planned_batches"]=planned
        output={"suggestions":[],"batches":[],"raw_sections":[]}
        if report.source and (any(page.get("text", "").strip() for page in pages) or input_mode!="ocr" and pages) and sum(len(segment.text) for segment in report.segments) <= 100_000:
            with measure(timings, "llm_wall"):
                output=run_menu_graph(llm, pages, request_timeout=llm_timeout, batch_pages=batch_pages, concurrency=llm_concurrency, cache_dir=llm_cache_dir, source_sha256=report.source.sha256,input_mode=input_mode)
            report.errors.extend(output["errors"])
            report.warnings.extend(output["warnings"])
            report.configuration["llm_batches"]=output["batches"]
            report.configuration["page_sections"]=output["sections"]
            report.configuration["synthesis_seconds"]=output["synthesis_seconds"]
            by_page={segment.page_number:segment for segment in report.segments}
            with measure(timings, "draft_assembly"):
                for item in output["dishes"]:
                    segment=by_page[item["page_number"]]
                    try:
                        draft_fields = {key:value for key,value in item.items() if key not in {"page_number", "review_warnings", "box_evidence"}}
                        draft=DishDraft(**draft_fields, source_id=report.source.source_id, source_text=segment.text.strip(), review_warnings=["Page-level evidence; dish/price association needs human verification.", *item.get("review_warnings", [])])
                        index=len(report.drafts)
                        draft_id="draft:"+hashlib.sha256(f"{report.source.sha256}:{index}:{draft.model_dump_json()}".encode()).hexdigest()[:32]
                        start=segment.text.find(draft.source_text)
                        evidence=DraftEvidence(
                            draft_id=draft_id, draft_index=index,
                            spans=[SourceSpan(segment_id=segment.segment_id, start=start, end=start+len(draft.source_text))],
                            box_evidence=item.get("box_evidence", []),
                        )
                        validate_box_evidence(report.model_copy(update={
                            "drafts":[*report.drafts,draft], "evidence":[*report.evidence,evidence],
                        }))
                    except ValueError:
                        report.errors.append(f"Page {segment.page_number}: dish or evidence failed schema validation.")
                        continue
                    report.drafts.append(draft)
                    report.evidence.append(evidence)
        validate_box_evidence(report)
        if input_mode=="image":
            report.warnings.append("Image-only suggestions are private and unvalidated; no OCR-grounded candidates or text spans were created.")
            report.status="incomplete"
        else:
            if not report.drafts: report.errors.append("No reviewable dishes were extracted.")
            report.status="incomplete" if report.errors and report.drafts else "failed" if report.errors else "complete"
        if report.source:
            suggestions=private_result(report.source,input_mode,pages,output)
            if input_mode=="image" and suggestions["status"]=="failed":
                report.status="failed"
                report.errors.append("No usable image-only model response was obtained.")
            suggestions["errors"]=list(report.errors)
            with measure(timings,"suggestions_write"):
                save_json(suggestions,directory/"review-suggestions.json")
            report.configuration["private_suggestions_file"]="review-suggestions.json"
        report.finished_at=datetime.now(timezone.utc)
        report.warnings.append("LLM verification is not implemented; all dishes remain needs_review.")
        with measure(timings, "extraction_write"):
            save_json(report.model_dump(mode="json"), directory / "extraction.json")
        completed=True
        return report
    finally:
        timings["total"]=round(time.perf_counter()-started, 6)
        summary={"schema_version":1, "status":report.status if completed else "failed", "input_mode":input_mode, "acquisition_mode":"images_without_ocr" if input_mode=="image" else "saved_pages" if pages_json is not None else "source", "timings_seconds":timings, "pages":[], "batches":[]}
        if report is not None:
            summary["batches"]=report.configuration.get("llm_batches", [])
            summary["pages"]=[{"page_number":segment.page_number, "method":segment.method, "status":segment.status, "reused":pages_json is not None, "cache_hit":segment.metadata.get("cache_hit") if pages_json is None else None, "timings_seconds":segment.metadata.get("timings_seconds") if pages_json is None else None} for segment in report.segments]
        try:
            save_json(summary, directory / "timings.json")
        except ExtractionError:
            print("Unable to save timing details; check output permissions.", file=sys.stderr, flush=True)
        print("Timing (seconds): "+", ".join(f"{stage}={seconds:.3f}" for stage,seconds in timings.items()), file=sys.stderr, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--input-mode",choices=INPUT_MODES,default="ocr_image",help="Model input: ocr text, ocr_image (default), or image (no OCR; private suggestions only).")
    parser.add_argument("--pages-json", type=Path, help="Reuse a saved page report matching --input; no OCR calls.")
    parser.add_argument("--target-pages",type=int,nargs="+",help="Explicitly recover only 1 to 4 saved ready pages; no merging with old drafts or automatic retry.")
    parser.add_argument("--max-model-requests",type=int,help="Required with --target-pages: explicit maximum batch requests, 1 to 4; preflighted before calls.")
    parser.add_argument("--llm-timeout", type=float, default=90, help="Cancellable deadline per LLM batch in seconds (default: 90; maximum: 300).")
    parser.add_argument("--batch-pages", type=int, default=10, help="Maximum pages per LLM request, 1 to 10 (default: 10); vision groups split before the 16 MB limit. Smaller groups make more calls.")
    parser.add_argument("--llm-concurrency", type=int, default=1, help="Simultaneous LLM calls, 1 or 2 (default: 1); starts remain spaced apart.")
    parser.add_argument("--no-llm-cache", action="store_true", help="Make fresh model requests instead of reusing complete cached candidates.")
    parser.add_argument("--no-ocr-cache", action="store_true", help="Skip OCR cache reads and writes for fresh OCR requests.")
    parser.add_argument("--no-ocr-table", action="store_true", help="Disable OCR.space table recognition (isTable); enabled by default.")
    parser.add_argument("--provider", choices=list(sorted(PROVIDER_REGISTRY.keys())), default=None, help="Explicit model provider (e.g. google_studio, openrouter, a2agent, openai, nara).")
    args = parser.parse_args(argv)
    load_dotenv(override=False, interpolate=False)
    recovery={} if args.target_pages is None and args.max_model_requests is None else {
        "target_pages":args.target_pages,"max_model_requests":args.max_model_requests}
    try:
        report = run_pipeline(args.input, args.run_dir, ocr_api_key=os.environ.get("OCR_SPACE_API_KEY"), cache_dir=None if args.no_ocr_cache else "work/ocr-cache", pages_json=args.pages_json, llm_timeout=args.llm_timeout, batch_pages=args.batch_pages, llm_concurrency=args.llm_concurrency, llm_cache_dir=None if args.no_llm_cache else "work/llm-cache",input_mode=args.input_mode,is_table=not args.no_ocr_table,provider=args.provider,**recovery)
    except (ExtractionError, OSError) as error:
        parser.exit(1, f"Pipeline failed: {error if isinstance(error, ExtractionError) else 'Unable to write run files.'}\n")
    print(f"Saved {len(report.drafts)} drafts ({report.status}) to {args.run_dir / 'extraction.json'}.")
    if args.input_mode=="image":
        print("Image-only results are private unvalidated suggestions in review-suggestions.json; no OCR-grounded candidates were created.")
    for error in report.errors: print(error)
    return 0 if report.status == "complete" else 2 if report.status == "incomplete" else 1


if __name__ == "__main__": raise SystemExit(main())
