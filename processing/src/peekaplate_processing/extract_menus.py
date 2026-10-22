import argparse
import base64
import hashlib
import math
import os
import re
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

from peekaplate_processing.captures import add_capture_candidates
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import extract_image
from peekaplate_processing.menu_text import MAX_DISHES, MAX_MENU_CHARACTERS, extract_dishes
from peekaplate_processing.ocr_space import OCRSpaceClient
from peekaplate_processing.pdf import extract_pdf
from peekaplate_processing.schemas import CaptureRequest, DraftEvidence, MenuExtractionResult, SourceRecord, SourceSegment, SourceSpan
from peekaplate_processing.sources import check_size, detect_kind, fetch_public, read_file, safe_location
from peekaplate_processing.storage import save_drafts, save_json
from peekaplate_processing.website import extract_website


def _acquire_segments(data:bytes, kind:str, source_id:str, location:str, ocr, *, force_ocr:bool, follow_links:bool, timeout:float)->list[SourceSegment]:
    if kind=="pdf":
        return extract_pdf(data, source_id, ocr, force_ocr=force_ocr)
    if kind=="image":
        return [extract_image(data, source_id, ocr)]
    if kind=="text":
        try:
            text=data.decode("utf-8-sig")
        except UnicodeError:
            raise ExtractionError("Menu text must use UTF-8 encoding.") from None
        return [SourceSegment(segment_id=f"{source_id}#text-1", method="text", text=text)]

    website=extract_website(data, location)
    if website["structured"]:
        return [SourceSegment(
            segment_id=f"{source_id}#jsonld-{index}", method="html", text=script,
            metadata={"structured_menu":True, "jsonld_block_index":index, "document_id":f"{source_id}#jsonld-{index}"},
            warnings=["JSON-LD fields are decoded for validation; the original structured block and page snapshot are retained."],
        ) for index,script in enumerate(website["structured_texts"], start=1)]
    has_items=website["structured"] or bool(re.search(r"Name:|\d[.,]\d{2}|[$€£]\s*\d", website["text"]))
    if follow_links and website["links"] and not has_items:
        segments=[]
        size=len(data)
        for index,url in enumerate(website["links"], start=1):
            link_id=f"{source_id}#link-{index}"
            try:
                linked,media_type,final_url=fetch_public(url, timeout=timeout)
                size+=len(linked)
                if size>12_000_000:
                    raise ExtractionError("Combined menu sources exceed the 12 MB job limit.")
                linked_kind=detect_kind(linked, media_type)
                children=_acquire_segments(linked, linked_kind, link_id, final_url, ocr, force_ocr=force_ocr, follow_links=False, timeout=timeout)
                for child in children:
                    child.metadata.update({
                        "document_id":child.metadata.get("document_id", link_id), "location":safe_location(final_url),
                        "source_sha256":hashlib.sha256(linked).hexdigest(),
                    })
                if children:
                    children[0].metadata["source_snapshot_base64"]=base64.b64encode(linked).decode()
                segments.extend(children)
            except ExtractionError as error:
                segments.append(SourceSegment(segment_id=link_id, method="html", status="failed", error=str(error)))
        return segments
    if not website["text"].strip():
        raise ExtractionError("Website has no readable menu; JavaScript-only menus need an HTML/PDF/image export.")
    return [SourceSegment(
        segment_id=f"{source_id}#html-1", method="html", text=website["text"],
        metadata={"structured_menu":website["structured"], "menu_links":len(website["links"])},
        warnings=["Website text snapshot retained; JavaScript execution and full-site crawling are not performed."],
    )]


def _extract_groups(result:MenuExtractionResult, *, mode:str, api_url, model, api_key, timeout:float)->None:
    groups=[]
    current=[]
    total=0
    document_id=None
    for segment in result.segments:
        total+=len(segment.text)
        if total>MAX_MENU_CHARACTERS:
            result.errors.append("Combined extracted text exceeds the 100,000-character job limit.")
            return
        next_document=segment.metadata.get("document_id", "root")
        if segment.status=="failed" or next_document!=document_id:
            if current:groups.append(current)
            current=[]
        document_id=next_document
        if segment.status=="failed":
            result.errors.append(f"Segment {segment.segment_id.rsplit('#', 1)[-1]}: {segment.error}")
        elif segment.status=="ready":
            current.append(segment)
    if current:groups.append(current)

    for group in groups:
        text=""
        locations=[]
        for segment in group:
            continuation=bool(re.match(r"\s*(?:Description|Category|Ingredients|Price):", segment.text, re.IGNORECASE))
            separator=("\n" if continuation else "\n\n") if text else ""
            segment.metadata["join_before"]=separator
            text+=separator
            start=len(text)
            text+=segment.text
            locations.append((segment, start, len(text)))
        try:
            drafts=extract_dishes(text, result.source.source_id, mode=mode, api_url=api_url, model=model, api_key=api_key, timeout=timeout)
            if len(result.drafts)+len(drafts)>MAX_DISHES:
                raise ExtractionError("Combined menu contains more than 100 dishes.")
        except ExtractionError as error:
            result.errors.append(str(error))
            continue
        offsets={}
        for draft in drafts:
            index=len(result.drafts)
            start=text.find(draft.source_text, offsets.get(draft.source_text, 0))
            if start<0:start=text.find(draft.source_text)
            end=start+len(draft.source_text)
            offsets[draft.source_text]=end
            spans=[SourceSpan(segment_id=segment.segment_id, start=max(start, first)-first, end=min(end, last)-first) for segment,first,last in locations if first<end and last>start]
            draft_id="draft:"+hashlib.sha256(f"{result.source.sha256}:{index}:{draft.model_dump_json()}".encode()).hexdigest()[:32]
            draft.review_warnings.append("Actual dish photograph and revision mapping are pending staff/backend verification.")
            result.drafts.append(draft)
            result.evidence.append(DraftEvidence(draft_id=draft_id, draft_index=index, spans=spans))
            result.capture_requests.append(CaptureRequest(draft_id=draft_id, dish_name=draft.name))


def extract_menus(
    source:str|Path,
    source_id:str|None=None,
    *,
    source_type:str="auto",
    mode:str="layout",
    api_url:str|None=None,
    model:str|None=None,
    api_key:str|None=None,
    ocr_api_key:str|None=None,
    cache_dir:str|Path|None=None,
    timeout:float=30,
    ocr_timeout:float=90,
    force_ocr:bool=False,
    follow_menu_links:bool=True,
    capture_manifest:str|Path|None=None,
    restaurant_id:str|None=None,
    capture_max_age_days:int|None=None,
)->MenuExtractionResult:
    if mode not in {"local", "layout", "ai"} or source_type not in {"auto", "pdf", "image", "website", "text"}:
        raise ExtractionError("Unsupported extraction mode or source type.")
    if not all(math.isfinite(value) and 0<value<=120 for value in [timeout, ocr_timeout]):
        raise ExtractionError("Timeouts must be finite, greater than zero and at most 120 seconds.")
    result=MenuExtractionResult(started_at=datetime.now(timezone.utc), extraction_mode=mode, extraction_model=model if mode=="ai" else None)
    result.warnings.append("Processing completion is not staff approval or a guarantee of full menu-item recall.")
    result.configuration={"source_type":source_type, "force_ocr":force_ocr, "follow_menu_links":follow_menu_links, "timeout":timeout, "ocr_timeout":ocr_timeout, "capture_max_age_days":capture_max_age_days, "restaurant_id":restaurant_id}
    for package in ["processing", "pydantic", "pypdfium2", "pillow"]:
        try:result.library_versions[package]=version(package)
        except PackageNotFoundError:result.library_versions[package]="uninstalled-source"
    try:
        if source_id is not None and not source_id.strip():
            raise ExtractionError("Explicit source ID must not be blank.")
        if source_id is not None:source_id=source_id.strip()
        is_url=isinstance(source, str) and source.lower().startswith(("https://", "http://"))
        media_type=""
        if is_url:
            data,media_type,final_url=fetch_public(source, timeout=timeout)
            location=safe_location(final_url)
        elif source_type=="text" and isinstance(source, str):
            data=source.encode("utf-8")
            check_size(data)
            location="inline-text"
        else:
            data=read_file(source)
            location=Path(source).name
        kind=detect_kind(data, media_type)
        if source_type!="auto" and source_type!=kind:
            raise ExtractionError("Declared source type does not match the source contents.")
        digest=hashlib.sha256(data).hexdigest()
        identity=source_id or f"sha256:{digest}"
        result.source=SourceRecord(source_id=identity, sha256=digest, kind=kind, location=location, retrieved_at=datetime.now(timezone.utc), size_bytes=len(data), snapshot_base64=base64.b64encode(data).decode())
        ocr=OCRSpaceClient(ocr_api_key, cache_dir=cache_dir, timeout=ocr_timeout)
        result.segments=_acquire_segments(data, kind, identity, final_url if is_url else location, ocr, force_ocr=force_ocr, follow_links=follow_menu_links, timeout=timeout)
        _extract_groups(result, mode=mode, api_url=api_url, model=model, api_key=api_key, timeout=timeout)
        if not result.drafts and not result.errors:
            result.errors.append("No reviewable dishes were extracted; verify the source and extraction mode.")
        if capture_manifest is not None:
            add_capture_candidates(result, capture_manifest, restaurant_id, max_age_days=capture_max_age_days)
    except ExtractionError as error:
        result.errors.append(str(error))
    result.status="incomplete" if result.errors and result.drafts else "failed" if result.errors else "complete"
    result.finished_at=datetime.now(timezone.utc)
    return result


def main(argv:list[str]|None=None)->int:
    parser=argparse.ArgumentParser(description="Import PDF, menu-photo, website or text sources into private review drafts.")
    sources=parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--input", type=Path, help="Local menu file")
    sources.add_argument("--url", help="Public menu URL, PDF or image")
    parser.add_argument("--output", required=True, type=Path, help="New private JSON report containing drafts and evidence")
    parser.add_argument("--source-id")
    parser.add_argument("--source-type", choices=["auto", "pdf", "image", "website", "text"], default="auto")
    parser.add_argument("--mode", choices=["layout", "local", "ai"], default="layout")
    parser.add_argument("--api-url")
    parser.add_argument("--model")
    parser.add_argument("--env-file", type=Path, default=Path(".env"), help="Private dotenv file; existing shell variables take precedence")
    parser.add_argument("--cache-dir", type=Path, default=Path("work/ocr-cache"))
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--ocr-timeout", type=float, default=90)
    parser.add_argument("--force-ocr", action="store_true")
    parser.add_argument("--no-follow-menu-links", action="store_true")
    parser.add_argument("--capture-manifest", type=Path)
    parser.add_argument("--restaurant-id")
    parser.add_argument("--capture-max-age-days", type=int)
    arguments=parser.parse_args(argv)
    try:
        if arguments.output.exists() or arguments.output.is_symlink():
            raise ExtractionError("Output already exists; choose a new path to preserve the previous result.")
        try:
            load_dotenv(arguments.env_file, override=False, interpolate=False, encoding="utf-8")
        except (OSError, UnicodeError):
            raise ExtractionError("The .env file must be readable UTF-8.") from None
        result=extract_menus(
            arguments.input if arguments.input is not None else arguments.url,
            arguments.source_id, source_type=arguments.source_type, mode=arguments.mode,
            api_url=arguments.api_url or os.environ.get("MENU_AI_API_URL"),
            model=arguments.model or os.environ.get("MENU_AI_MODEL"), api_key=os.environ.get("MENU_AI_API_KEY"),
            ocr_api_key=os.environ.get("OCR_SPACE_API_KEY"), cache_dir=arguments.cache_dir,
            timeout=arguments.timeout, ocr_timeout=arguments.ocr_timeout,
            force_ocr=arguments.force_ocr, follow_menu_links=not arguments.no_follow_menu_links,
            capture_manifest=arguments.capture_manifest, restaurant_id=arguments.restaurant_id,
            capture_max_age_days=arguments.capture_max_age_days,
        )
        save_json(result.model_dump(mode="json"), arguments.output)
    except ExtractionError as error:
        parser.exit(1, f"Extraction failed: {error}\n")
    print(f"Saved {len(result.drafts)} drafts ({result.status}) and evidence to {arguments.output}.")
    if result.errors:
        parser._print_message("; ".join(result.errors[:3])+"\n")
    return 0 if result.status=="complete" else 2 if result.status=="incomplete" else 1


if __name__=="__main__":
    raise SystemExit(main())
