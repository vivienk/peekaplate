"""V4 Multimodal Vision Extraction with native normalized bounding boxes.

Extracts structured menu dishes and drinks directly from page images; no OCR text is read.
Maps [ymin, xmin, ymax, xmax] normalized coordinates (0..1000) to pixel rectangles.
Everything here is a vision-model transcription: names, prices, descriptions and boxes
are unverified proposals for human review, not OCR evidence.
"""
import hashlib
import json
import asyncio
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from pydantic import BaseModel, ConfigDict, Field, model_validator
from peekaplate_processing.schemas import (
    DishDraft,
    DraftEvidence,
    MenuExtractionResult,
    SourceRecord,
    SourceSegment,
    SourceSpan,
)

VISION_REVIEW_WARNING = (
    "Transcribed by a vision model without OCR: name, price and description are unverified, "
    "and boxes are approximate model proposals."
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
    page_number: int | None = Field(default=None, ge=1)
    name: str = Field(min_length=1)
    description: str | None = None
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
Copy text exactly as printed. Never invent descriptions, prices or currencies; use null when absent.
For each item, output:
- name: dish title
- description: printed item description (e.g. ingredients, sides, details), or null if none
- category: section heading (e.g. STARTERS, SALADS, DESSERTS) or null
- price_text: verbatim price text (e.g. "25.99", "12/15") or null. If one item prints several prices (sizes or options), output ONE entry with every price in price_text separated by " / "; never repeat the item once per price.
- price_amount: numeric price (e.g. "25.99") only when exactly one price is printed, else null
- price_currency: 3-letter currency code only if printed or unambiguous from a symbol, else null
- box: [ymin, xmin, ymax, xmax] around item title in 0..1000 normalized coordinates
- price_box: [ymin, xmin, ymax, xmax] around printed price, or null"""

_SINGLE_PRICE = re.compile(r"\s*(?:[A-Za-z]{3}\s*|[$€£¥₱]\s*)?(\d{1,6}(?:\.\d{1,2})?)\s*(?:[A-Za-z]{3}|[$€£¥₱])?\s*")

def single_price_amount(price_text: str | None, price_amount: str | None) -> Decimal | None:
    """Return a decimal only for one unambiguous plain price; options, separators and mismatches give None."""
    if not price_amount:
        return None
    match = _SINGLE_PRICE.fullmatch(price_amount)
    if not match:
        return None
    amount = Decimal(match.group(1))
    if price_text:
        text_match = _SINGLE_PRICE.fullmatch(price_text)
        if not text_match or Decimal(text_match.group(1)) != amount:
            return None
    return amount


def _same_title(a: NormalizedBox, b: NormalizedBox) -> bool:
    """True when two title boxes cover the same printed title (intersection over union >= 0.8)."""
    width = min(a.xmax, b.xmax) - max(a.xmin, b.xmin)
    height = min(a.ymax, b.ymax) - max(a.ymin, b.ymin)
    if width <= 0 or height <= 0:
        return False
    overlap = width * height
    union = (a.xmax - a.xmin) * (a.ymax - a.ymin) + (b.xmax - b.xmin) * (b.ymax - b.ymin) - overlap
    return union > 0 and overlap / union >= 0.8


def merge_split_options(dishes: list[V4Dish]) -> tuple[list[V4Dish], list[str]]:
    """Rejoin price options the model split into repeated entries of one printed title.

    Entries merge only when they are adjacent, on the same page, have the same name and their
    title boxes cover the same printed title. Distinct items sharing a name (different title
    boxes) stay separate. The merged entry keeps every price in price_text and no single amount.
    """
    merged: list[V4Dish] = []
    warnings: list[str] = []
    for dish in dishes:
        last = merged[-1] if merged else None
        if (last is not None and last.page_number == dish.page_number
                and last.name.strip().casefold() == dish.name.strip().casefold()
                and last.price_text and dish.price_text and _same_title(last.box, dish.box)):
            merged[-1] = last.model_copy(update={
                "price_text": f"{last.price_text} / {dish.price_text}",
                "price_amount": None,
                "description": last.description or dish.description,
                "price_box": None,
            })
            warnings.append(f"Page {dish.page_number}: merged repeated entries of '{dish.name.strip()}' into one item with price options; option meanings require review.")
            continue
        merged.append(dish)
    return merged, warnings


def scale_box(box: NormalizedBox, width: int, height: int) -> dict[str, int] | None:
    """Convert normalized 0..1000 coordinates to a pixel box; None when the box is empty or inverted."""
    if box.xmax <= box.xmin or box.ymax <= box.ymin:
        return None
    left = min(width - 1, int(box.xmin / 1000.0 * width))
    top = min(height - 1, int(box.ymin / 1000.0 * height))
    right = max(left + 1, min(width, int(box.xmax / 1000.0 * width)))
    bottom = max(top + 1, min(height, int(box.ymax / 1000.0 * height)))
    return {"left": left, "top": top, "width": right - left, "height": bottom - top}


def _parse_page(text: str, page_num: int, errors: list[str]) -> list[V4Dish]:
    if text.startswith("<think>"):
        _, _, remainder = text.partition("</think>")
        text = remainder.strip()
    if "```" in text:
        for part in text.split("```"):
            part_str = part.strip()
            if part_str.startswith("json"):
                part_str = part_str[4:].strip()
            if part_str.startswith("{") and "dishes" in part_str:
                text = part_str
                break
    try:
        return V4Batch.model_validate_json(text).dishes
    except ValueError:
        # Keep every complete dish object (including nested box dicts) from malformed or truncated output.
        recovered = []
        for match in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\"name\"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", text, re.S):
            try:
                recovered.append(V4Dish.model_validate(json.loads(match.group()), strict=False))
            except ValueError:
                continue
        if not recovered:
            raise
        errors.append(f"Page {page_num}: model output was malformed; recovered {len(recovered)} complete dishes, later dishes may be missing.")
        return recovered


def extract_vision_v4(llm: Any, page_images: list[dict], *, timeout: float | None = None) -> tuple[list[V4Dish], list[str]]:
    """Run direct multimodal extraction per page.

    Returns dishes (page numbers forced to the page that was sent) and page-level errors
    describing possible dish loss.
    """
    max_tok = getattr(llm, "max_tokens", 16384) or 16384
    bind_kwargs: dict[str, Any] = {"max_tokens": max_tok}
    if timeout is not None:
        bind_kwargs["timeout"] = timeout
    vision_llm = llm.bind(**bind_kwargs)
    prompt = f"{V4_VISION_PROMPT}\n\nREQUIRED JSON SCHEMA:\n{json.dumps(V4Batch.model_json_schema())}"
    all_dishes: list[V4Dish] = []
    errors: list[str] = []
    for page in page_images:
        page_num = page["page_number"]
        content = [
            {"type": "text", "text": f"Extract all menu items from Page {page_num}."},
            {"type": "image_url", "image_url": {"url": page["image_url"]}},
        ]
        messages = [("system", prompt), ("human", content)]
        if timeout is not None and timeout > 0:
            # Same pattern as the OCR graph: cancel the awaited HTTP request when the deadline passes.
            async def _bounded():
                return await asyncio.wait_for(vision_llm.ainvoke(messages), timeout=timeout)
            try:
                response = asyncio.run(_bounded())
            except asyncio.TimeoutError:
                raise TimeoutError(f"Vision request exceeded its {timeout:g}s deadline and was cancelled.") from None
        else:
            response = vision_llm.invoke(messages)
        raw_content = getattr(response, "content", None)
        if not isinstance(raw_content, str) or not raw_content.strip():
            errors.append(f"Page {page_num}: vision model returned no content.")
            continue
        metadata = getattr(response, "response_metadata", None) or {}
        if metadata.get("finish_reason") == "length":
            errors.append(f"Page {page_num}: vision output hit the token limit; later dishes may be missing.")
        dishes = _parse_page(raw_content.strip(), page_num, errors)
        all_dishes.extend(d.model_copy(update={"page_number": page_num}) for d in dishes)
    return all_dishes, errors


def build_v4_result(
    source: SourceRecord,
    page_images_list: list[dict],
    v4_dishes: list[V4Dish],
    started_at: datetime,
    *,
    errors: list[str] | None = None,
) -> MenuExtractionResult:
    """Construct a MenuExtractionResult from V4 dishes; any error makes it incomplete."""
    errors = list(errors or [])
    v4_dishes, warnings = merge_split_options(v4_dishes)
    segments: list[SourceSegment] = []
    by_page_img = {p["page_number"]: p for p in page_images_list}

    for page in page_images_list:
        p_num = page["page_number"]
        ref = page.get("image_reference", {})
        lines = [d.name.strip()[:160] for d in v4_dishes if d.page_number == p_num]
        segments.append(
            SourceSegment(
                segment_id=f"{source.source_id}#page-{p_num}",
                page_number=p_num,
                # Model-transcribed dish names, not OCR text; spans index into this transcript.
                text="\n".join(lines) if lines else f"Page {p_num}",
                method="text",
                status="ready",
                warnings=[VISION_REVIEW_WARNING],
                metadata={
                    "width": ref.get("width"),
                    "height": ref.get("height"),
                    "mime_type": ref.get("mime_type", "image/jpeg"),
                    "v4_vision": True,
                    "text_origin": "vision_model_transcription",
                    "vision_boxes": {},
                },
            )
        )

    drafts: list[DishDraft] = []
    evidence: list[DraftEvidence] = []
    seg_by_num = {s.page_number: s for s in segments}
    cursor = {s.page_number: 0 for s in segments}

    for d in v4_dishes:
        p_num = d.page_number
        seg = seg_by_num.get(p_num)
        if seg is None:
            errors.append(f"Page {p_num}: dish {d.name!r} cites a page without an image; rejected.")
            continue
        ref = by_page_img[p_num].get("image_reference", {})
        width, height = ref.get("width"), ref.get("height")
        clean_name = d.name.strip()[:160]
        clean_price_text = d.price_text.strip()[:160] if d.price_text and d.price_text.strip() else None
        clean_currency = d.price_currency.strip().upper() if d.price_currency and re.fullmatch(r"[A-Za-z]{3}", d.price_currency.strip()) else None
        try:
            draft = DishDraft(
                name=clean_name,
                description=d.description.strip()[:4000] if d.description and d.description.strip() else None,
                category=d.category.strip()[:160] if d.category and d.category.strip() else None,
                category_page_number=p_num,
                price_text=clean_price_text,
                price_amount=single_price_amount(clean_price_text, d.price_amount),
                price_currency=clean_currency,
                ingredients=None,
                source_id=source.source_id,
                source_text=clean_name,
                review_warnings=[VISION_REVIEW_WARNING],
            )
        except ValueError as exc:
            errors.append(f"Page {p_num}: dish {clean_name!r} rejected by the draft schema ({type(exc).__name__}).")
            continue
        idx = len(drafts)
        draft_id = f"draft:{hashlib.sha256(f'{source.sha256}:{idx}:{draft.model_dump_json()}'.encode()).hexdigest()[:32]}"
        # Each dish owns its own transcript line, so repeated names get distinct spans.
        start = seg.text.index(clean_name, cursor[p_num])
        cursor[p_num] = start + len(clean_name)

        box_records = []
        if width and height:
            for kind, box, text in (("title", d.box, clean_name), ("price", d.price_box, clean_price_text)):
                if box is None or (kind == "price" and not text):
                    continue
                pixels = scale_box(box, width, height)
                if pixels is None:
                    warnings.append(f"Page {p_num}: dish {clean_name!r} {kind} box was empty or inverted; omitted.")
                    continue
                box_records.append({"page_number": p_num, "box": pixels, "text": text, "type": kind})
        if box_records:
            seg.metadata["vision_boxes"][draft_id] = box_records

        drafts.append(draft)
        evidence.append(
            DraftEvidence(
                draft_id=draft_id,
                draft_index=idx,
                spans=[SourceSpan(segment_id=seg.segment_id, start=start, end=cursor[p_num])],
                box_evidence=[],
            )
        )
    return MenuExtractionResult(
        schema_version=2,
        pipeline_version="3",
        status="incomplete" if errors else "complete",
        started_at=started_at,
        finished_at=datetime.now(timezone.utc),
        extraction_mode="ai",
        source=source,
        segments=segments,
        drafts=drafts,
        evidence=evidence,
        configuration={"pipeline_version": "3", "v4_vision": True},
        warnings=warnings,
        errors=errors,
    )
