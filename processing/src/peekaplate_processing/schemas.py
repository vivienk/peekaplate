from decimal import Decimal
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

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

    schema_version:Literal[1]=1
    pipeline_version:Literal["2"]="2"
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


class DishRef(BaseModel):

    model_config=ConfigDict(extra="forbid")

    dish_id:UUID
    revision_id:UUID


class AssetVariant(BaseModel):

    model_config=ConfigDict(extra="forbid")

    name:Literal["card-480", "detail-1280"]
    format:Literal["webp", "jpeg"]
    path:NonEmptyText
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes:int=Field(gt=0)
    width:int=Field(gt=0)
    height:int=Field(gt=0)
    quality:int=Field(ge=1, le=100)


class AssetSource(BaseModel):

    model_config=ConfigDict(extra="forbid")

    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes:int=Field(ge=1, le=12_000_000)
    format:Literal["JPEG", "PNG", "WEBP", "TIFF", "BMP", "GIF"]
    width:int=Field(gt=0)
    height:int=Field(gt=0)
    path:NonEmptyText
    captured_at:datetime|None=None
    capture_evidence:NonEmptyText


class ProcessingState(BaseModel):

    model_config=ConfigDict(extra="forbid")

    status:Literal["ready"]
    engine:Literal["pillow"]
    engine_version:NonEmptyText
    started_at:datetime
    completed_at:datetime
    steps:list[NonEmptyText]=Field(min_length=1)


class ReviewState(BaseModel):

    model_config=ConfigDict(extra="forbid")

    status:Literal["needs_review"]="needs_review"
    warnings:list[NonEmptyText]=Field(default_factory=list)


class PublicationState(BaseModel):

    model_config=ConfigDict(extra="forbid")

    eligible:Literal[False]=False
    reason:NonEmptyText="Human approval and backend publication are required."


class AssetMeasurements(BaseModel):

    model_config=ConfigDict(extra="forbid")

    total_variant_bytes:int=Field(gt=0)
    budget_bytes:int|None=Field(default=None, gt=0)
    budget_status:Literal["within_budget", "not_configured"]


class AssetManifest(BaseModel):

    model_config=ConfigDict(extra="forbid")

    schema_version:Literal[1]=1
    asset_id:str=Field(pattern=r"^t0_[0-9a-f]{32}$")
    recipe_version:Literal["t0-v1"]="t0-v1"
    tier:Literal["T0"]="T0"
    source:AssetSource
    dish:DishRef
    variants:list[AssetVariant]=Field(min_length=4, max_length=4)
    processing:ProcessingState
    review:ReviewState
    publication:PublicationState
    measurements:AssetMeasurements


class MotionLimits(BaseModel):

    model_config=ConfigDict(extra="forbid")

    max_yaw_degrees:float=Field(ge=0, le=3)
    max_pitch_degrees:float=Field(ge=0, le=3)

    @model_validator(mode="after")
    def require_motion(self):
        if max(self.max_yaw_degrees, self.max_pitch_degrees)<=0:
            raise ValueError("At least one motion limit must be greater than zero.")
        return self


class LayerInput(BaseModel):

    model_config=ConfigDict(extra="forbid")

    name:str=Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    file:NonEmptyText
    depth:float=Field(ge=0, le=1)


class LayersInput(BaseModel):

    model_config=ConfigDict(extra="forbid")

    schema_version:Literal[1]=1
    tier:Literal["T1"]="T1"
    dish:DishRef
    motion:MotionLimits
    layers:list[LayerInput]=Field(min_length=2, max_length=6)
    capture_evidence:NonEmptyText
    rights_confirmed:Literal[True]


class SpatialLayer(BaseModel):

    model_config=ConfigDict(extra="forbid")

    name:NonEmptyText
    path:NonEmptyText
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes:int=Field(gt=0)
    width:int=Field(gt=0)
    height:int=Field(gt=0)
    format:Literal["PNG", "WEBP", "JPEG"]
    depth:float=Field(ge=0, le=1)


class SpatialFallback(BaseModel):

    model_config=ConfigDict(extra="forbid")

    tier:Literal["T0"]="T0"
    path:Literal["fallback.jpg"]="fallback.jpg"
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes:int=Field(gt=0)
    width:int=Field(gt=0)
    height:int=Field(gt=0)


class SpatialMeasurements(BaseModel):

    model_config=ConfigDict(extra="forbid")

    total_asset_bytes:int=Field(gt=0)
    budget_bytes:int=Field(gt=0)
    budget_status:Literal["within_budget"]


class SpatialManifest(BaseModel):

    model_config=ConfigDict(extra="forbid")

    schema_version:Literal[1]=1
    asset_id:str=Field(pattern=r"^t1_[0-9a-f]{32}$")
    recipe_version:Literal["t1-v1"]="t1-v1"
    tier:Literal["T1"]="T1"
    source_t0:NonEmptyText
    source_t0_manifest_sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    source_sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    dish:DishRef
    capture_evidence:NonEmptyText
    rights_confirmed:Literal[True]
    motion:MotionLimits
    layers:list[SpatialLayer]
    fallback:SpatialFallback
    processing:ProcessingState
    review:ReviewState
    publication:PublicationState
    measurements:SpatialMeasurements
    harness:Literal["harness.html"]="harness.html"


class PresentationInputAsset(BaseModel):

    model_config=ConfigDict(extra="forbid")

    role:Literal["cutout", "reference"]
    path:NonEmptyText
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes:int=Field(ge=1, le=12_000_000)
    width:int=Field(gt=0)
    height:int=Field(gt=0)
    format:Literal["PNG", "WEBP", "JPEG"]
    has_alpha:bool


class PresentationAsset(BaseModel):

    model_config=ConfigDict(extra="forbid")

    path:Literal["presentation.png"]="presentation.png"
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes:int=Field(gt=0)
    width:int=Field(ge=512)
    height:int=Field(ge=512)
    format:Literal["PNG"]="PNG"
    has_alpha:Literal[True]=True
    transparent_corners:Literal[True]=True

    @model_validator(mode="after")
    def require_square(self):
        if self.width!=self.height:
            raise ValueError("Presentation asset must be square.")
        return self


class PresentationPromptSpec(BaseModel):

    model_config=ConfigDict(extra="forbid")

    prompt_version:Literal["presentation-prompt-v1"]="presentation-prompt-v1"
    prompt_sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    model_version:NonEmptyText
    preserved_original_viewpoint:bool=False
    reconstructed_details_flagged:bool=False
    fidelity_notes:list[NonEmptyText]=Field(default_factory=list)


class PresentationProcessingState(BaseModel):

    model_config=ConfigDict(extra="forbid")

    status:Literal["ready", "fallback_retained"]
    engine:Literal["pillow"]="pillow"
    engine_version:NonEmptyText
    started_at:datetime
    completed_at:datetime
    steps:list[NonEmptyText]=Field(min_length=1)
    validation_errors:list[NonEmptyText]=Field(default_factory=list)


class PresentationMeasurements(BaseModel):

    model_config=ConfigDict(extra="forbid")

    presentation_bytes:int=Field(ge=0)
    fallback_bytes:int=Field(gt=0)
    total_bundle_bytes:int=Field(gt=0)
    budget_bytes:int|None=Field(default=None, gt=0)
    budget_status:Literal["within_budget", "exceeded_fallback_retained", "not_configured"]


class PresentationManifest(BaseModel):

    model_config=ConfigDict(extra="forbid")

    schema_version:Literal[1]=1
    asset_id:str=Field(pattern=r"^pres_[0-9a-f]{32}$")
    recipe_version:Literal["presentation-v1"]="presentation-v1"
    tier:Literal["T0-presentation"]="T0-presentation"
    source_t0:NonEmptyText
    source_t0_manifest_sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    source_sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    dish:DishRef
    draft_id:NonEmptyText|None=None
    capture_evidence:NonEmptyText
    rights_confirmed:Literal[True]
    cutout:PresentationInputAsset
    reference:PresentationInputAsset
    prompt:PresentationPromptSpec
    presentation:PresentationAsset|None=None
    fallback:SpatialFallback
    fallback_retained:bool
    active_display_path:Literal["presentation.png", "fallback.jpg"]="fallback.jpg"
    processing:PresentationProcessingState
    review:ReviewState
    publication:PublicationState
    measurements:PresentationMeasurements
