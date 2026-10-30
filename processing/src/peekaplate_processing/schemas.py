import math
import unicodedata
from decimal import Decimal
from datetime import datetime
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator



NonEmptyText = Annotated[str, Field(min_length=1)]


class DishDraft(BaseModel):

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
    )

    name:str=Field(min_length=1, max_length=160)
    description:str|None=Field(default=None, min_length=1, max_length=4000)
    category:NonEmptyText|None=None
    subcategory:NonEmptyText|None=Field(default=None, exclude_if=lambda value:value is None)
    category_page_number:int|None=Field(default=None, ge=1, exclude_if=lambda value:value is None)
    price_text:NonEmptyText|None=Field(default=None, max_length=160, exclude_if=lambda value:value is None)

    price_amount:Decimal|None=Field(
        default=None,
        ge=0,
        allow_inf_nan=False,
    )
    price_currency:str|None=Field(
        default=None,
        pattern=r"^[A-Z]{3}$",
    )

    ingredients:list[NonEmptyText]|None=None

    source_id:NonEmptyText
    source_text:NonEmptyText
    image_id:NonEmptyText|None=None

    review_warnings:list[NonEmptyText]=Field(default_factory=list)
    status:Literal["needs_review"]="needs_review"


class SourceRecord(BaseModel):

    model_config=ConfigDict(extra="forbid")

    source_id:NonEmptyText
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    kind:Literal["pdf", "image", "website", "text"]
    location:NonEmptyText
    retrieved_at:datetime
    size_bytes:int=Field(ge=1, le=12_000_000)
    snapshot_base64:NonEmptyText


class SourceSegment(BaseModel):

    model_config=ConfigDict(extra="forbid")

    segment_id:NonEmptyText
    page_number:int|None=Field(default=None, ge=1)
    method:Literal["text", "html", "pdf_native", "ocr_space_engine3"]
    status:Literal["ready", "skipped", "failed"]="ready"
    text:str=""
    native_text:str|None=None
    error:str|None=None
    warnings:list[str]=Field(default_factory=list)
    metadata:dict=Field(default_factory=dict)


class SourceSpan(BaseModel):

    model_config=ConfigDict(extra="forbid")

    segment_id:NonEmptyText
    start:int=Field(ge=0)
    end:int=Field(gt=0)


class BoxEvidence(BaseModel):

    model_config=ConfigDict(extra="forbid")

    page_number:int=Field(ge=1, strict=True)
    box:dict[str, int|float]
    text:str=Field(strict=True)
    saved_region_index:int=Field(ge=0, strict=True)

    @field_validator("text")
    @classmethod
    def validate_literal(cls, value):
        if not value.strip() or any(unicodedata.category(c) == "Cc" for c in value):
            raise ValueError("Box text must be a nonblank literal without control characters.")
        return value

    @field_validator("box", mode="before")
    @classmethod
    def validate_coordinates(cls, value):
        if not isinstance(value, dict) or set(value) != {"left", "top", "width", "height"}:
            raise ValueError("Box coordinates must contain exactly left/top/width/height.")
        for key, number in value.items():
            if (type(number) not in (int, float) or (type(number) is float and not math.isfinite(number))
                    or number < 0 or (key in {"width", "height"} and number == 0)):
                raise ValueError("Box coordinates must be finite nonnegative numbers with positive size.")
        return value


class DraftEvidence(BaseModel):

    model_config=ConfigDict(extra="forbid")

    draft_id:NonEmptyText
    draft_index:int=Field(ge=0)
    spans:list[SourceSpan]=Field(min_length=1)
    box_evidence:list[BoxEvidence]=Field(default_factory=list, exclude_if=lambda value:not value)


class CaptureCandidate(BaseModel):

    model_config=ConfigDict(extra="forbid")

    asset_sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    filename:NonEmptyText
    restaurant_id:NonEmptyText
    captured_at:datetime|None=None
    uploaded_at:datetime
    capture_evidence:NonEmptyText
    rights_confirmed:Literal[True]
    origin:Literal["restaurant_capture"]
    width:int=Field(gt=0)
    height:int=Field(gt=0)
    review_status:Literal["needs_review"]="needs_review"
    warnings:list[str]=Field(default_factory=list)


class CaptureRequest(BaseModel):

    model_config=ConfigDict(extra="forbid")

    draft_id:NonEmptyText
    dish_name:NonEmptyText
    status:Literal["capture_missing", "needs_review"]="capture_missing"
    candidates:list[CaptureCandidate]=Field(default_factory=list)


class MenuExtractionResult(BaseModel):

    model_config=ConfigDict(extra="forbid")

    schema_version:Literal[1, 2]=2
    pipeline_version:Literal["2", "3"]="3"
    status:Literal["complete", "incomplete", "failed"]="failed"
    source:SourceRecord|None=None
    started_at:datetime
    finished_at:datetime|None=None
    extraction_mode:Literal["local", "layout", "ai"]="layout"
    extraction_model:str|None=None
    ocr_engine:Literal[3]=3
    library_versions:dict[str,str]=Field(default_factory=dict)
    configuration:dict=Field(default_factory=dict)
    segments:list[SourceSegment]=Field(default_factory=list)
    drafts:list[DishDraft]=Field(default_factory=list)
    evidence:list[DraftEvidence]=Field(default_factory=list)
    capture_requests:list[CaptureRequest]=Field(default_factory=list)
    warnings:list[str]=Field(default_factory=list)
    errors:list[str]=Field(default_factory=list)

    @model_validator(mode="after")
    def validate_version(self):
        if (self.schema_version, self.pipeline_version) not in {(1, "2"), (2, "3")}:
            raise ValueError("Extraction schema and pipeline versions do not match.")
        if self.schema_version == 1 and any(
            draft.subcategory is not None or draft.category_page_number is not None or draft.price_text is not None
            for draft in self.drafts
        ):
            raise ValueError("Category hierarchy and printed price fields require extraction schema 2.")
        validate_box_evidence(self)
        return self


def _typed_equal(left, right):
    """Python equality alone permits bool/int and int/float provenance tampering."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_typed_equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_typed_equal(a, b) for a, b in zip(left, right))
    return left == right


def _box_evidence_links(source, segments, records):
    """Validate exact saved OCR facts and joins, not semantic dish/price association.

    records contains (candidate ID, original draft, source spans, box records).
    Returns public maps by segment ID. No inputs are changed.
    """
    expected = {}
    if not any(boxes for _, _, _, boxes in records) and not any(
        "candidate_box_evidence" in segment.metadata for segment in segments
    ):
        return expected
    if source is None or source.source_id != f"sha256:{source.sha256}":
        raise ValueError("Box evidence requires a valid source join.")
    by_id = {segment.segment_id: segment for segment in segments}
    if len(by_id) != len(segments) or len({key for key, _, _, _ in records}) != len(records):
        raise ValueError("Box evidence requires unique segment and candidate identifiers.")
    for key, draft, spans, boxes in records:
        if not isinstance(key, str) or not key.strip() or draft.source_id != source.source_id:
            raise ValueError("Box candidate source/identifier does not match the extraction.")
        cited = {}
        passages = []
        for raw_span in spans:
            span = SourceSpan.model_validate(raw_span.model_dump() if isinstance(raw_span, SourceSpan) else raw_span)
            segment = by_id.get(span.segment_id)
            if (segment is None or segment.status != "ready" or segment.error is not None
                    or not 0 <= span.start < span.end <= len(segment.text)):
                raise ValueError("Box evidence must cite valid ready source spans.")
            cited[segment.segment_id] = segment
            passages.append(segment.text[span.start:span.end])
        if not spans or "\n".join(passages) != draft.source_text:
            raise ValueError("Box candidate spans must reconstruct the original source text.")
        seen_indices, seen_regions = set(), set()
        for raw in boxes:
            # Revalidate dumps: Pydantic otherwise trusts existing instances,
            # including model_copy/model_construct and nested mutations.
            box = BoxEvidence.model_validate(raw.model_dump() if isinstance(raw, BoxEvidence) else raw)
            matches = [segment for segment in cited.values() if segment.page_number == box.page_number
                       and type(segment.page_number) is int and segment.method == "ocr_space_engine3"
                       and segment.status == "ready" and segment.error is None]
            if len(matches) != 1:
                raise ValueError("Each box must resolve to exactly one cited ready OCR segment of its page.")
            segment = matches[0]
            metadata = segment.metadata
            if (metadata.get("ocr_coordinate_space") != "uploaded_image_pixels"
                    or metadata.get("ocr_region_status") != "available"):
                raise ValueError("Box evidence requires available uploaded-image geometry.")
            width, height = metadata.get("upload_width"), metadata.get("upload_height")
            if any(type(n) not in (int, float) or (type(n) is float and not math.isfinite(n)) or n <= 0 for n in (width, height)):
                raise ValueError("Box evidence requires actual upload dimensions.")
            coords = box.box
            if coords["left"] + coords["width"] > width or coords["top"] + coords["height"] > height:
                raise ValueError("Box evidence exceeds the upload dimensions.")
            regions = metadata.get("ocr_regions")
            if not isinstance(regions, list) or box.saved_region_index >= len(regions):
                raise ValueError("Box evidence has no saved region at its index.")
            if not _typed_equal(regions[box.saved_region_index], {"text": box.text, **coords}):
                raise ValueError("Box evidence must exactly match its saved region literal and typed coordinates.")
            index_identity = (segment.segment_id, box.saved_region_index)
            region_identity = (segment.segment_id, *(coords[k] for k in ("left", "top", "width", "height")))
            if index_identity in seen_indices or region_identity in seen_regions:
                raise ValueError("Duplicate box indices or regions within a candidate are not allowed.")
            seen_indices.add(index_identity)
            seen_regions.add(region_identity)
            expected.setdefault(segment.segment_id, {}).setdefault(key, []).append(box.model_dump(mode="json"))
    for segment in segments:
        if "candidate_box_evidence" in segment.metadata:
            actual = segment.metadata["candidate_box_evidence"]
            if (not isinstance(actual, dict) or not actual
                    or not _typed_equal(actual, expected.get(segment.segment_id, {}))):
                raise ValueError("Existing public candidate box links do not match the exact evidence joins.")
    return expected


def validate_box_evidence(report:MenuExtractionResult):
    """Revalidate provenance even on existing models; return maps by segment ID.

    Call before report save or export. Proves source/region joins, not that OCR
    is correct or semantically belongs to a dish/price. Does not mutate inputs.
    Legacy reports without boxes or public maps are unchanged.
    """
    if any(not isinstance(e.box_evidence, list) for e in report.evidence):
        raise ValueError("Box evidence must be a list of exact records.")
    if not any(e.box_evidence for e in report.evidence) and not any(
        "candidate_box_evidence" in segment.metadata for segment in report.segments
    ):
        return {}
    by_index = {e.draft_index: e for e in report.evidence}
    if (len(by_index) != len(report.evidence) or set(by_index) != set(range(len(report.drafts)))
            or any(type(e.draft_index) is not int for e in report.evidence)):
        raise ValueError("Every box-backed draft must have exactly one evidence record.")
    return _box_evidence_links(report.source, report.segments, [
        (by_index[i].draft_id, draft, by_index[i].spans, by_index[i].box_evidence)
        for i, draft in enumerate(report.drafts)
    ])
