"""PRIVATE offline overlay experiment; never standard drafts or factual approval.

Only saved, original PNG/JPEG image pages with an Engine3 overlay are supported.
No image-reference path is opened. Source consistency cannot establish run identity.
"""
import argparse
import base64
import copy
import hashlib
import io
import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from .errors import ExtractionError
from .images import prepare_ocr_image
from .menu_context import MONEY_MARKER, CURRENCY_CODE, phrase_matches
from .menu_layout import _overlap, _regions, _same_row
from .schemas import MenuExtractionResult
from .storage import save_json

MAX_REPORT_BYTES=32_000_000
MAX_SUGGESTIONS_BYTES=8_000_000
MAX_ROWS=500
_INVALID="Invalid saved overlay inputs; no overlay review was written."
_NUMBER=r"(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?"
_OPTION=rf"(?:(?:SM|LG)[ \t]*)?(?:{MONEY_MARKER}[ \t]*)?({_NUMBER})(?:[ \t]+{CURRENCY_CODE})?"
_PRICE=re.compile(rf"{_OPTION}(?:[ \t]*/[ \t]*{_OPTION})*", re.I)
_MODEL_SEQUENCE=re.compile(rf"{_OPTION}(?:[ \t]+{_OPTION})+", re.I)
_OPTION_PATTERN=re.compile(_OPTION,re.I)
_DIGITS=re.compile(_NUMBER)


class _Strict(BaseModel):
    model_config=ConfigDict(extra="forbid", strict=True)


class _Original(_Strict):
    # Mirror the saved raw ExtractedDish contract, not the grounded DishDraft.
    page_number:int
    name:str=Field(min_length=1, max_length=4000)
    description:str|None
    category:str|None
    subcategory:str|None=None
    price_text:str|None=None
    price_amount:str|None
    price_currency:str|None
    ingredients:list[str]|None


class _PageRegion(_Strict):
    scope:Literal["page"]
    coordinate_space:Literal["image_pixels"]
    left:int=Field(ge=0, le=0)
    top:int=Field(ge=0, le=0)
    width:int=Field(gt=0)
    height:int=Field(gt=0)


class _ImageReference(_Strict):
    path:str
    path_scope:Literal["local_run"]
    source_id:str
    source_page:int
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    mime_type:Literal["image/png", "image/jpeg"]
    width:int=Field(gt=0)
    height:int=Field(gt=0)
    region:_PageRegion


class _Page(_Strict):
    page_number:int
    segment_id:str|None
    image:_ImageReference


class _Decision(_Strict):
    field:str
    suggested_value:Any
    disposition:str
    reason:str


class _Suggestion(_Strict):
    worker_id:int=Field(ge=1)
    suggestion_index:int=Field(ge=0)
    cited_page_number:int
    status:Literal["unvalidated"]
    original:_Original
    decisions:list[_Decision]
    grounding_warnings:list[str]
    source_reference:_Page
    suggestion_id:str


class _Suggestions(_Strict):
    schema_version:Literal[1]
    source_id:str
    input_mode:Literal["ocr_image", "image"]
    status:Literal["complete", "incomplete", "failed"]
    pages:list[_Page]=Field(min_length=1, max_length=1)
    suggestions:list[_Suggestion]=Field(max_length=MAX_ROWS)
    sections:list[dict]=Field(max_length=MAX_ROWS)
    batches:list[dict]=Field(max_length=MAX_ROWS)
    warnings:list[str]
    errors:list[str]=Field(default_factory=list)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _encoded(value):
    # In-memory malformed geometry (including NaN) still gets an input identity,
    # then fails closed below. Non-JSON constants in saved files are rejected.
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _require(condition):
    if not condition:
        raise ValueError(_INVALID)


def _normalize(value):
    return " ".join(value.casefold().split())


def _numbers(literal):
    value=literal.strip()
    if len(value)>160 or not _PRICE.fullmatch(value):
        return None
    return tuple(Decimal(match.group()) for match in _DIGITS.finditer(value))


def _model_numbers(literal):
    values=_numbers(literal)
    if values is not None:
        return values
    # Saved vision readings can separate complete options by whitespace. Bare
    # integer fragments ("3 50") cannot establish such a sequence. This parses
    # only the model reading; no separator is ever added to OCR evidence.
    value=literal.strip()
    if len(value)>160 or not _MODEL_SEQUENCE.fullmatch(value):
        return None
    for option in _OPTION_PATTERN.finditer(value):
        number=_DIGITS.search(option.group()).group()
        if "." not in number and option.group().strip()==number:
            return None
    return tuple(Decimal(match.group()) for match in _DIGITS.finditer(value))


def _scalar(literal):
    if literal is None or not re.fullmatch(_NUMBER,literal):
        return None
    return (Decimal(literal),)


def _provenance(report, suggestions):
    source=report.source
    _require(source is not None and source.kind=="image" and source.source_id==f"sha256:{source.sha256}")
    snapshot=base64.b64decode(source.snapshot_base64, validate=True)
    _require(len(snapshot)==source.size_bytes and _sha(snapshot)==source.sha256)
    _require(len(report.segments)==1 and report.ocr_engine==3)
    segment=report.segments[0]
    _require(segment.method=="ocr_space_engine3" and segment.status=="ready" and segment.error is None
             and segment.page_number in (None, 1))
    metadata=segment.metadata
    settings=metadata.get("ocr_settings")
    _require(isinstance(settings,dict) and type(settings.get("OCREngine")) is int and settings["OCREngine"]==3)
    upload,prepared=prepare_ocr_image(snapshot)
    _require(metadata.get("ocr_image_sha256")==_sha(upload))
    for key,value in prepared.items():
        _require(type(metadata.get(key)) is type(value) and metadata[key]==value)
    # The initial prototype only supports vision's unchanged original-byte path.
    # Re-encoded/oriented/rescaled page images need a separate identity contract.
    with Image.open(io.BytesIO(snapshot)) as image:
        _require(image.format in {"PNG","JPEG"} and image.getexif().get(274,1)==1
                 and image.width*image.height<=6_000_000 and len(snapshot)<=8_000_000)
        width,height=image.size
        mime="image/png" if image.format=="PNG" else "image/jpeg"
    _require(suggestions.source_id==source.source_id)
    for page in [*suggestions.pages, *(row.source_reference for row in suggestions.suggestions)]:
        reference=page.image
        _require(page.page_number==1 and reference.source_page==1 and reference.source_id==source.source_id
                 and reference.sha256==source.sha256 and reference.mime_type==mime
                 and reference.width==width and reference.height==height
                 and reference.region.width==width and reference.region.height==height)
        # Segment references are optional in image-only suggestions, but never
        # join them (or suggestion IDs/indices) to production candidates.
        _require(page.segment_id is None or page.segment_id==segment.segment_id)
    for row in suggestions.suggestions:
        _require(row.cited_page_number==1 and row.original.page_number==1)
    return source,segment


def _geometry(metadata):
    if metadata.get("ocr_region_status")!="available":
        return None
    boxes=_regions(metadata)
    if not boxes:
        return None
    for raw in metadata["ocr_regions"]:
        if set(raw)!={"text","left","top","width","height"}:
            return None
    # Reject duplicates and every positive-area collision in the full overlay,
    # including cells not eventually associated with a suggestion.
    for index,box in enumerate(boxes):
        if any(_overlap(box,other)>0 and min(box.right,other.right)>max(box.left,other.left)
               for other in boxes[:index]):
            return None
    return boxes


def _transcript(source, segment, inputs):
    regions=segment.metadata["ocr_regions"]
    identity={"source_id":source.source_id, "source_sha256":source.sha256,
              "upload_sha256":segment.metadata["ocr_image_sha256"],
              "original_text_sha256":_sha(segment.text.encode("utf-8")), "raw_regions":regions, "inputs":inputs}
    transcript_id="overlay-transcript:"+_sha(_encoded(identity))
    records=[]
    offset=0
    for index,raw in enumerate(regions):
        end=offset+len(raw["text"])
        records.append({"saved_region_index":index, "text":raw["text"],
                        "box":{key:raw[key] for key in ("left","top","width","height")},
                        "span":{"start":offset,"end":end}})
        offset=end+1
    return {"transcript_id":transcript_id, "status":"unvalidated", "separator":"\n",
            "order_policy":"stored_region_order", "offset_unit":"zero_based_unicode_codepoints_half_open",
            "source_id":source.source_id, "source_sha256":source.sha256,
            "upload_sha256":identity["upload_sha256"], "original_text_sha256":identity["original_text_sha256"],
            "text":"\n".join(raw["text"] for raw in regions), "regions":records}


def _associate(index, originals, boxes, transcript):
    original=originals[index]
    name=_normalize(original.name)
    headings=[i for i,box in enumerate(boxes) if _normalize(box.text)==name]
    if not headings:
        return "unsupported_or_unmatched_title", [], None, None
    if (len(headings)!=1 or sum(_normalize(other.name)==name for other in originals)!=1
            or any(i not in headings and phrase_matches(original.name,box.text) for i,box in enumerate(boxes))):
        return "repeated_or_competing_title", [], None, None
    heading_index=headings[0]
    heading=boxes[heading_index]
    title_evidence=copy.deepcopy(transcript["regions"][heading_index])
    title_evidence["transcript_id"]=transcript["transcript_id"]
    other_indices=[i for i,box in enumerate(boxes) if i!=heading_index and _same_row(heading,box)]
    if any(boxes[i].right<=heading.left for i in other_indices):
        return "nearby_same_row_left_cell", [], None, title_evidence
    right=[i for i in other_indices if boxes[i].left>=heading.right]
    right.sort(key=lambda i:boxes[i].left)
    # Failing the same-row threshold is uncertainty, not permission to discard
    # a partly intersecting reading from the completeness check.
    if any(i!=heading_index and i not in other_indices
           and (_overlap(heading,box)>0 or any(_overlap(boxes[j],box)>0 for j in right))
           for i,box in enumerate(boxes)):
        return "uncertain_vertical_row_cell", [], None, title_evidence
    if not right:
        return "no_same_row_price_reading", [], None, title_evidence
    numbers=[]
    parts=[]
    for i in right:
        price=boxes[i]
        values=_numbers(price.text)
        if values is None:
            return "malformed_or_nonprice_row_cell", [], None, title_evidence
        # A partial vertical overlap is enough to block crossing another title
        # or unknown label, even if it misses the stricter same-row threshold.
        if any(j not in {heading_index,i} and _numbers(other.text) is None
               and _overlap(other,price)>0 and heading.left<other.right
               for j,other in enumerate(boxes)):
            return "intervening_label_or_title", [], None, title_evidence
        names={_normalize(other.name) for other in originals}
        if any(j!=heading_index and _normalize(other.text) in names and _same_row(other,price)
               for j,other in enumerate(boxes)):
            return "competing_price_row", [], None, title_evidence
        numbers.extend(values)
        record=transcript["regions"][i]
        parts.append({"literal":record["text"], "saved_region_index":i,
                      "box":copy.deepcopy(record["box"]), "transcript_id":transcript["transcript_id"],
                      "span":copy.deepcopy(record["span"])})
    if original.price_text is None and original.price_amount is None:
        return "missing_model_price_reading", [], None, title_evidence
    expected=_model_numbers(original.price_text) if original.price_text is not None else _scalar(original.price_amount)
    if expected is None:
        return "invalid_model_price_reading", [], None, title_evidence
    if tuple(numbers)!=expected:
        return "numeric_disagreement", [], None, title_evidence
    if original.price_amount is not None:
        if len(numbers)!=1 or _scalar(original.price_amount)!=(numbers[0],):
            return "contradictory_model_scalar", [], None, title_evidence
    return "complete_numeric_sequence_agrees_not_factual_approval", parts, str(numbers[0]) if len(numbers)==1 else None, title_evidence


def _prepare(raw_report, raw_suggestions, inputs):
    report=MenuExtractionResult.model_validate(raw_report)
    # Retained opaque fields must also be representable as strict JSON.
    json.dumps(raw_suggestions, allow_nan=False)
    suggestions=_Suggestions.model_validate(raw_suggestions)
    source,segment=_provenance(report,suggestions)
    boxes=_geometry(segment.metadata)
    transcript=_transcript(source,segment,inputs) if boxes else None
    rows=[]
    originals=[row.original for row in suggestions.suggestions]
    for index,suggestion in enumerate(raw_suggestions["suggestions"]):
        reason,parts,amount,title=("invalid_overlay_geometry", [], None, None) if boxes is None else _associate(index,originals,boxes,transcript)
        rows.append({"row_index":index, "status":"unvalidated", "suggestion":copy.deepcopy(suggestion),
                     "disposition":"numeric_agreement" if parts else "abstained", "reason":reason,
                     "title_evidence":title, "proposed_price_parts":parts,
                     "proposed_price_amount":amount, "proposed_price_currency":None})
    return {"artifact_type":"private_overlay_review", "schema_version":1, "status":"unvalidated",
            "overlay_id":"overlay-review:"+_sha(_encoded(inputs)), "inputs":inputs,
            "source_id":source.source_id, "page_number":1,
            "geometry_disposition":"valid" if boxes else "invalid_overlay_geometry", "transcript":transcript, "rows":rows,
            "warnings":["Private prototype: numeric agreement is not factual approval; every row remains unvalidated.",
                        "Source consistency is not proof of the same run; saved suggestion IDs omit run identity.",
                        "Association uses exact normalized single-region titles, not candidate IDs or indices.",
                        "No wrapped/composed/inline title recovery, column/variant/currency inference or dish rectangles.",
                        "Image references describe the original whole page, not actual crops; their paths were not opened."]}


def prepare_overlay_review(report:MenuExtractionResult|dict, suggestions:dict)->dict:
    """Build a separate unvalidated artifact without mutating either input.

    In-memory identities hash canonical JSON; file exports hash exact input bytes.
    Malformed geometry yields explicit abstentions, never a source-text fallback.
    """
    try:
        raw=report.model_dump(mode="json", warnings=False) if isinstance(report,MenuExtractionResult) else copy.deepcopy(report)
        saved=copy.deepcopy(suggestions)
        report_bytes,suggestion_bytes=_encoded(raw),_encoded(saved)
        _require(len(report_bytes)<=MAX_REPORT_BYTES and len(suggestion_bytes)<=MAX_SUGGESTIONS_BYTES)
        return _prepare(raw,saved,{"report_sha256":_sha(report_bytes), "suggestions_sha256":_sha(suggestion_bytes),
                                   "hash_policy":"canonical_json_for_in_memory_inputs"})
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError, OSError, ExtractionError):
        raise ExtractionError(_INVALID) from None


def _unique_object(pairs):
    value={}
    for key,item in pairs:
        _require(key not in value)
        value[key]=item
    return value


def _load(path, limit):
    with Path(path).open("rb") as handle:
        content=handle.read(limit+1)
    _require(len(content)<=limit)
    def invalid_constant(_):
        raise ValueError(_INVALID)
    return json.loads(content, object_pairs_hook=_unique_object, parse_constant=invalid_constant),_sha(content)


def export_overlay_review(input_path:Path, suggestions_path:Path, output_path:Path)->dict:
    """Read two bounded saved JSON files, then create-only publish a 0600 artifact."""
    try:
        report,report_hash=_load(input_path,MAX_REPORT_BYTES)
        suggestions,suggestions_hash=_load(suggestions_path,MAX_SUGGESTIONS_BYTES)
        result=_prepare(report,suggestions,{"report_sha256":report_hash, "suggestions_sha256":suggestions_hash,
                                             "hash_policy":"exact_input_file_bytes"})
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError, OSError, ExtractionError):
        raise ExtractionError(_INVALID) from None
    save_json(result,output_path)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Saved full pages.json or extraction.json.")
    parser.add_argument("--suggestions", required=True, type=Path, help="Saved review-suggestions.json.")
    parser.add_argument("--output", required=True, type=Path, help="New private overlay-review.json.")
    args=parser.parse_args(argv)
    try:
        result=export_overlay_review(args.input,args.suggestions,args.output)
    except ExtractionError:
        parser.exit(1,"Overlay review failed; inputs must be valid and output must be a new writable path.\n")
    print(f"Saved private overlay review: {len(result['rows'])} unvalidated rows. No providers or publication.")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
