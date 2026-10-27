from decimal import Decimal
from datetime import datetime
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator



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


class DraftEvidence(BaseModel):

    model_config=ConfigDict(extra="forbid")

    draft_id:NonEmptyText
    draft_index:int=Field(ge=0)
    spans:list[SourceSpan]=Field(min_length=1)


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
        return self
