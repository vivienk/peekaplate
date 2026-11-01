"""V4 Multimodal Vision Extraction with native normalized bounding boxes.

Extracts structured menu dishes and drinks directly from high-resolution page images.
Maps [ymin, xmin, ymax, xmax] normalized coordinates (0..1000) to physical pixel rectangles.
"""
import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any
from pydantic import BaseModel, ConfigDict, Field, model_validator
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.schemas import (
    BoxEvidence,
    DishDraft,
    DraftEvidence,
    MenuExtractionResult,
    SourceRecord,
    SourceSegment,
    SourceSpan,
)


class NormalizedBox(BaseModel):
    """Normalized bounding box coordinates (0 to 1000 scale)."""
    model_config = ConfigDict(extra="forbid")
    ymin: int = Field(ge=0, le=1000)
    xmin: int = Field(ge=0, le=1000)
    ymax: int = Field(ge=0, le=1000)
    xmax: int = Field(ge=0, le=1000)

    @model_validator(mode="before")
    @classmethod
    def from_any(cls, val):
        if isinstance(val, (list, tuple)) and len(val) == 4:
            return {
                "ymin": int(float(val[0])),
                "xmin": int(float(val[1])),
                "ymax": int(float(val[2])),
                "xmax": int(float(val[3])),
            }
        if isinstance(val, dict):
            return {
                k: int(float(v)) if isinstance(v, (int, float, str)) and str(v).replace(".", "", 1).isdigit() else v
                for k, v in val.items()
            }
        return val
class V4Dish(BaseModel):
    """Single dish extracted with native visual bounding coordinates."""
    model_config = ConfigDict(extra="forbid", strict=True)
    page_number: int = Field(ge=1)
    name: str = Field(min_length=1)
    category: str | None = None
    price_text: str | None = None
    price_amount: str | None = None
    price_currency: str | None = None
    box: NormalizedBox
    price_box: NormalizedBox | None = None

class V4Batch(BaseModel):
    """Batch of dishes extracted directly from visual pages."""
    model_config = ConfigDict(extra="forbid")
    dishes: list[V4Dish]


V4_VISION_PROMPT = """Detect all distinct food and drink items from this menu page image.
For each item, output:
- name: dish title
- category: section heading (e.g. STARTERS, SALADS, DESSERTS) or null
- price_text: verbatim price text (e.g. "25.99") or null
- price_amount: numeric price (e.g. "25.99") or null
- price_currency: 3-letter currency code (e.g. USD) or null
- box: [ymin, xmin, ymax, xmax] around item title in 0..1000 normalized coordinates
- price_box: [ymin, xmin, ymax, xmax] around printed price, or null
- page_number: page number"""


def scale_box(box: NormalizedBox, width: int, height: int) -> dict[str, int]:
    """Convert normalized 0..1000 coordinates to absolute pixel box."""
    left = max(0, min(width - 1, int((box.xmin / 1000.0) * width)))
    top = max(0, min(height - 1, int((box.ymin / 1000.0) * height)))
    right = max(left + 1, min(width, int((box.xmax / 1000.0) * width)))
    bottom = max(top + 1, min(height, int((box.ymax / 1000.0) * height)))
    return {
        "left": left,
        "top": top,
        "width": max(1, right - left),
        "height": max(1, bottom - top),
    }


def extract_vision_v4(llm: Any, page_images: list[dict], *, timeout: float = 90.0) -> list[V4Dish]:
    """Perform direct multimodal extraction on page images, returning dishes with native boxes."""
    # Set provider-appropriate token limits: OpenRouter caps free tier credit at ~13,332 tokens; Google AI Studio supports 16,384+
    base_url = str(getattr(llm, "openai_api_base", "") or "")
    if "openrouter.ai" in base_url:
        max_tok = 8192
    else:
        max_tok = getattr(llm, "max_tokens", 16384) or 16384
    vision_llm = llm.bind(max_tokens=max_tok)
    all_dishes: list[V4Dish] = []
    schema_json = json.dumps(V4Batch.model_json_schema())
    for page in page_images:
        page_num = page["page_number"]
        image_url = page["image_url"]
        prompt = f"{V4_VISION_PROMPT}\n\nREQUIRED JSON SCHEMA:\n{schema_json}"
        content = [
            {"type": "text", "text": f"Extract all menu items from Page {page_num}."},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
        response = vision_llm.invoke(
            [("system", prompt), ("human", content)]
        )
        raw_content = getattr(response, "content", None)
        if not raw_content:
            continue
        # Parse output
        if isinstance(raw_content, str):
            text = raw_content.strip()
            if text.startswith("<think>"):
                _, _, remainder = text.partition("</think>")
                text = remainder.strip()
            # Handle markdown fence if present
            if "```" in text:
                parts = text.split("```")
                for part in parts:
                    part_str = part.strip()
                    if part_str.startswith("json"):
                        part_str = part_str[4:].strip()
                    if part_str.startswith("{") and "dishes" in part_str:
                        text = part_str
                        break
            try:
                parsed = V4Batch.model_validate_json(text)
                all_dishes.extend(parsed.dishes)
            except Exception:
                # Find all complete dish JSON objects individually (including nested box dicts)
                dish_matches = re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\"name\"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", text, re.S)
                recovered = []
                for m in dish_matches:
                    try:
                        d_obj = json.loads(m.group())
                        if "name" not in d_obj or "box" not in d_obj:
                            continue
                        d_obj["box"] = NormalizedBox.model_validate(d_obj["box"]).model_dump()
                        if d_obj.get("price_box"):
                            d_obj["price_box"] = NormalizedBox.model_validate(d_obj["price_box"]).model_dump()
                        recovered.append(V4Dish.model_validate(d_obj))
                    except Exception:
                        continue
                if not recovered:
                    raise
                all_dishes.extend(recovered)
    return all_dishes


def build_v4_result(
    source: SourceRecord,
    page_images_list: list[dict],
    v4_dishes: list[V4Dish],
    started_at: datetime,
) -> MenuExtractionResult:
    """Construct a complete, contract-compliant MenuExtractionResult from V4 dishes."""
    segments: list[SourceSegment] = []
    by_page_img = {p["page_number"]: p for p in page_images_list}

    # Build image segments
    for page in page_images_list:
        p_num = page["page_number"]
        ref = page.get("image_reference", {})
        width = ref.get("width", 1000)
        height = ref.get("height", 1000)
        seg_id = f"{source.source_id}#page-{p_num}"
        # Native pseudo-text for span grounding
        lines = [d.name for d in v4_dishes if d.page_number == p_num]
        seg_text = "\n".join(lines) if lines else f"Page {p_num}"
        segments.append(
            SourceSegment(
                segment_id=seg_id,
                page_number=p_num,
                text=seg_text,
                method="text",
                status="ready",
                metadata={
                    "width": width,
                    "height": height,
                    "mime_type": ref.get("mime_type", "image/jpeg"),
                    "v4_vision": True,
                },
            )
        )

    drafts: list[DishDraft] = []
    evidence: list[DraftEvidence] = []
    now = datetime.now(timezone.utc)
    seg_by_num = {s.page_number: s for s in segments}

    for d in v4_dishes:
        p_num = d.page_number
        seg = seg_by_num.get(p_num)
        if not seg:
            continue
        ref = by_page_img.get(p_num, {}).get("image_reference", {})
        width = ref.get("width", 1000)
        height = ref.get("height", 1000)

        # Scale coordinates
        name_box = scale_box(d.box, width, height)
        price_box = scale_box(d.price_box, width, height) if d.price_box else None

        # Defensively sanitize fields for DishDraft schema
        clean_name = d.name.strip()[:160]
        clean_category = d.category.strip()[:160] if d.category and d.category.strip() else None
        clean_price_text = d.price_text.strip()[:160] if d.price_text and d.price_text.strip() else None

        clean_amount = None
        if d.price_amount:
            try:
                # Strip currency symbols and whitespace
                num_match = re.search(r"\d+(?:\.\d+)?", d.price_amount)
                if num_match:
                    clean_amount = Decimal(num_match.group(0))
            except (InvalidOperation, ValueError):
                clean_amount = None

        clean_currency = None
        if d.price_currency and re.fullmatch(r"^[A-Z]{3}$", d.price_currency.strip().upper()):
            clean_currency = d.price_currency.strip().upper()

        source_text = clean_name
        try:
            draft = DishDraft(
                name=clean_name,
                description=None,
                category=clean_category,
                category_page_number=p_num,
                price_text=clean_price_text,
                price_amount=clean_amount,
                price_currency=clean_currency,
                ingredients=None,
                source_id=source.source_id,
                source_text=source_text,
                review_warnings=["V4 direct vision extraction with native bounding boxes."],
            )
            idx = len(drafts)
            draft_id = f"draft:{hashlib.sha256(f'{source.sha256}:{idx}:{draft.model_dump_json()}'.encode()).hexdigest()[:32]}"
            start = seg.text.find(source_text)
            if start < 0:
                start = 0
            end = max(start + 1, start + len(source_text))

            evidence.append(
                DraftEvidence(
                    draft_id=draft_id,
                    draft_index=idx,
                    spans=[SourceSpan(segment_id=seg.segment_id, start=start, end=end)],
                    box_evidence=[],
                )
            )
            drafts.append(draft)
        except Exception:
            continue
    return MenuExtractionResult(
        schema_version=2,
        pipeline_version="3",
        status="complete",
        started_at=started_at,
        finished_at=now,
        extraction_mode="ai",
        source=source,
        segments=segments,
        drafts=drafts,
        evidence=evidence,
        configuration={"pipeline_version": "3", "v4_vision": True},
        warnings=[],
        errors=[],
    )
