"""Project V4 model proposals into review-only drafts and evidence."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Literal

from peekaplate_processing.product_validation import (
    MINIMUM_PRICE_WARNING,
    NON_FOOD_ERROR,
    is_wrapping_cloth,
    minimum_price_literals,
)
from peekaplate_processing.schemas import (
    DishDraft,
    DraftEvidence,
    MenuExtractionResult,
    SourceRecord,
    SourceSegment,
    SourceSpan,
)

if TYPE_CHECKING:
    from peekaplate_processing.vision_extraction import NormalizedBox, V4Dish


# Sidecar (ingredient-intelligence.v1) compatibility: at most 100 terms of at most 256
# characters each, counting the normalized form as well as the literal term.
MAX_V4_INGREDIENTS = 100
MAX_V4_INGREDIENT_CHARS = 256


VISION_REVIEW_WARNING = (
    "Transcribed by a vision model without OCR: name, price, description and ingredients are "
    "unverified, and boxes are approximate model proposals."
)


_SINGLE_PRICE = re.compile(r"\s*(?:[A-Za-z]{3}\s*|[$€£¥₱]\s*)?(\d{1,6}(?:\.\d{1,2})?)\s*(?:[A-Za-z]{3}|[$€£¥₱])?\s*")

def single_price_amount(price_text: str | None, price_amount: str | None) -> Decimal | None:
    """Return a decimal only when printed price_text and price_amount agree on one plain price."""
    if not price_text or not price_amount:
        return None
    match = _SINGLE_PRICE.fullmatch(price_amount)
    text_match = _SINGLE_PRICE.fullmatch(price_text)
    if not match or not text_match:
        return None
    amount = Decimal(match.group(1))
    if Decimal(text_match.group(1)) != amount:
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
                "ingredients": (
                    list(dict.fromkeys([*last.ingredients, *dish.ingredients]))
                    if last.ingredients and dish.ingredients
                    else last.ingredients or dish.ingredients
                ),
                "price_box": None,
            })
            warnings.append(f"Page {dish.page_number}: merged repeated entries of '{dish.name.strip()}' into one item with price options; option meanings require review.")
            continue
        merged.append(dish)
    return merged, warnings


def _clean_name(dish: V4Dish) -> str:
    return dish.name.strip()[:160].rstrip()


def _clean_description(dish: V4Dish) -> str | None:
    return (dish.description or "").strip()[:4000].rstrip() or None


def _ingredient_pattern(term: str) -> re.Pattern[str]:
    """Whole-word, whole-phrase match; words must be complete, not substrings of longer words."""
    return re.compile(
        r"(?<![\w-])" + r"\s+".join(re.escape(word) for word in term.split()) + r"(?![\w-])",
    )


# Commas and wrapped conjunctions can continue an exclusion list.
# End that scope at a clause boundary or an explicit contrast.
_INGREDIENT_CLAUSE = re.compile(
    r"[;.!?]|\n(?![^\S\n]*(?:and|or)\b)|\b(?:but|however|instead(?!\s+of\b))\b"
    r"|,\s*(?:served|topped)\s+with\b"
)
_INGREDIENT_EXCLUSION = re.compile(
    r"\b(?:no|without|exclude[sd]?|optional(?:ly)?|choice of|choose(?: from)?|"
    r"option(?:al)? (?:of|to add)|instead\s+of|substitut(?:e|ion)|alternatives?)\b"
)
_INGREDIENT_QUALIFIER = re.compile(
    r"\s*(?:[(–—-]\s*)?(?:optional|on request|upon request|available as an add-on|free)\b"
)
_INGREDIENT_PAID_ADD_ON = re.compile(
    r"(?:\badd[ \t]+|\+[ \t]*)(?=\w)"
    r"[^,;.!?\n+$€£¥₱]{1,256}(?:\+[ \t]*)?[$€£¥₱][ \t]*\d"
)


def _affirmative_ingredient(description: str, match: re.Match[str]) -> bool:
    start = 0
    for boundary in _INGREDIENT_CLAUSE.finditer(description, 0, match.start()):
        start = boundary.end()
    following_boundary = _INGREDIENT_CLAUSE.search(description, match.end())
    end = following_boundary.start() if following_boundary else len(description)
    return (
        _INGREDIENT_EXCLUSION.search(description, start, match.end()) is None
        and _INGREDIENT_QUALIFIER.match(description, match.end()) is None
        and re.search(r"\bor\b", description[start:end]) is None
    )


def grounded_ingredients(
    dish: V4Dish,
    description: str | None,
    page_number: int | None,
    warnings: list[str],
) -> list[str] | None:
    """Keep only proposed terms literally printed in this dish's own description.

    Ingredient proposals are optional model output, not OCR facts and not evidence of dish
    association. Terms from the title, another dish, an absent/truncated description or a
    substring of a longer word are dropped with a visible warning. A dish left with no
    supported term stays unknown (None) rather than exporting an empty or invented list.
    Explicit negation, optionality or a priced add-on cannot support a proposal. This is a
    conservative phrase check, not a semantic or allergen classifier.
    """
    proposed = dish.ingredients
    if not proposed:
        return None
    name = _clean_name(dish)
    if not isinstance(proposed, (list, tuple)):
        warnings.append(f"Page {page_number}: dish {name!r} proposed ingredients in an unsupported shape; omitted.")
        return None
    if description is None:
        warnings.append(
            f"Page {page_number}: dish {name!r} proposed ingredients without a printed description; "
            "no ingredients were retained."
        )
        return None
    haystack = unicodedata.normalize("NFKC", description).casefold()
    full_description = (dish.description or "").strip()
    full_haystack = (
        unicodedata.normalize("NFKC", full_description).casefold()
        if len(full_description) > len(description)
        else haystack
    )
    paid_add_ons = [match.span() for match in _INGREDIENT_PAID_ADD_ON.finditer(full_haystack)]
    retained: list[str] = []
    for raw in proposed:
        if not isinstance(raw, str):
            warnings.append(f"Page {page_number}: dish {name!r} proposed a non-text ingredient; omitted.")
            continue
        term = raw.strip()
        if not term:
            continue
        normalized = " ".join(unicodedata.normalize("NFKC", term).split())
        key = normalized.casefold()
        if not key:
            continue
        if len(term) > MAX_V4_INGREDIENT_CHARS or len(key) > MAX_V4_INGREDIENT_CHARS:
            warnings.append(
                f"Page {page_number}: dish {name!r} proposed an ingredient longer than "
                f"{MAX_V4_INGREDIENT_CHARS} characters; omitted."
            )
            continue
        if not any(
            match.end() <= len(haystack) and match[0] == haystack[match.start():match.end()]
            and _affirmative_ingredient(full_haystack, match)
            and not any(start < match.end() and match.start() < end for start, end in paid_add_ons)
            for match in _ingredient_pattern(key).finditer(full_haystack)
        ):
            warnings.append(
                f"Page {page_number}: dish {name!r} proposed ingredient {term!r} is not printed in its "
                "description as an affirmative ingredient; omitted."
            )
            continue
        if len(retained) >= MAX_V4_INGREDIENTS:
            warnings.append(
                f"Page {page_number}: dish {name!r} proposed more than {MAX_V4_INGREDIENTS} ingredients; "
                "additional terms omitted."
            )
            break
        retained.append(term)
    return retained or None


def scale_box(box: NormalizedBox, width: int, height: int) -> dict[str, int] | None:
    """Convert normalized 0..1000 coordinates to a pixel box; None when the box is empty or inverted."""
    if box.xmax <= box.xmin or box.ymax <= box.ymin:
        return None
    left = min(width - 1, int(box.xmin / 1000.0 * width))
    top = min(height - 1, int(box.ymin / 1000.0 * height))
    right = max(left + 1, min(width, int(box.xmax / 1000.0 * width)))
    bottom = max(top + 1, min(height, int(box.ymax / 1000.0 * height)))
    return {"left": left, "top": top, "width": right - left, "height": bottom - top}


def build_v4_result(
    source: SourceRecord,
    page_images_list: list[dict],
    v4_dishes: list[V4Dish],
    started_at: datetime,
    *,
    errors: list[str] | None = None,
    page_dispositions: Mapping[int, tuple[Literal["failed", "skipped"], str]] | None = None,
) -> MenuExtractionResult:
    """Construct a MenuExtractionResult from V4 dishes; any error makes it incomplete."""
    errors = list(errors or [])
    v4_dishes, warnings = merge_split_options(v4_dishes)
    segments: list[SourceSegment] = []
    by_page_img = {p["page_number"]: p for p in page_images_list}
    dispositions = page_dispositions or {}
    # Each dish owns a transcript block: its printed title, then its printed description.
    # Offsets are recorded while assembling the block, so repeated titles (or descriptions
    # that mention the title) cannot resolve to another dish's occurrence.
    block_spans: dict[int, tuple[int, int, int | None, int | None]] = {}
    page_text: dict[int, str] = {}
    for page in page_images_list:
        p_num = page["page_number"]
        if p_num in dispositions:
            continue
        chunks: list[str] = []
        cursor = 0
        for index, d in enumerate(v4_dishes):
            if d.page_number != p_num:
                continue
            name = _clean_name(d)
            if not name:
                continue
            description = _clean_description(d)
            if chunks:
                cursor += 1  # newline between transcript blocks
            name_start = cursor
            name_end = name_start + len(name)
            desc_start = desc_end = None
            if description is not None:
                desc_start = name_end + 1
                desc_end = desc_start + len(description)
            chunks.append(name if description is None else f"{name}\n{description}")
            block_spans[index] = (name_start, name_end, desc_start, desc_end)
            cursor = name_end if desc_end is None else desc_end
        page_text[p_num] = "\n".join(chunks) if chunks else f"Page {p_num}"

    page_numbers = sorted(by_page_img.keys() | dispositions.keys()) if dispositions else by_page_img
    for p_num in page_numbers:
        if p_num in dispositions:
            status, error = dispositions[p_num]
            segments.append(SourceSegment(
                segment_id=f"{source.source_id}#page-{p_num}",
                page_number=p_num,
                text="",
                method="text",
                status=status,
                error=error if status == "failed" else None,
                warnings=[error] if status == "skipped" else [],
            ))
            continue
        ref = by_page_img[p_num].get("image_reference", {})
        segments.append(
            SourceSegment(
                segment_id=f"{source.source_id}#page-{p_num}",
                page_number=p_num,
                # Model-transcribed dish titles and printed descriptions, not OCR text;
                # spans index into this transcript.
                text=page_text[p_num],
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

    for index, d in enumerate(v4_dishes):
        p_num = d.page_number
        if p_num in dispositions:
            continue
        seg = seg_by_num.get(p_num)
        if seg is None:
            errors.append(f"Page {p_num}: dish {d.name!r} cites a page without an image; rejected.")
            continue
        ref = by_page_img[p_num].get("image_reference", {})
        width, height = ref.get("width"), ref.get("height")
        clean_name = _clean_name(d)
        if not clean_name:
            errors.append(f"Page {p_num}: dish has a blank title; rejected.")
            continue
        if is_wrapping_cloth(clean_name):
            errors.append(f"Page {p_num}: {NON_FOOD_ERROR}")
            continue
        clean_description = _clean_description(d)
        clean_ingredients = grounded_ingredients(d, clean_description, p_num, warnings)
        clean_price_text = (d.price_text or "").strip() or None
        price_amount = d.price_amount
        review_warnings = [VISION_REVIEW_WARNING]
        if clean_price_text and len(clean_price_text) > 160:
            review_warnings.append("Printed price group exceeds the review field limit; verify the complete price on the source page.")
            clean_price_text = price_amount = None
        elif minimum_price_literals(clean_price_text):
            review_warnings.append(MINIMUM_PRICE_WARNING)
        name_start, name_end, desc_start, desc_end = block_spans[index]
        spans = [SourceSpan(segment_id=seg.segment_id, start=name_start, end=name_end)]
        source_text = seg.text[name_start:name_end]
        if desc_start is not None and desc_end is not None:
            # The printed description is transcription evidence for the proposed terms.
            spans.append(SourceSpan(segment_id=seg.segment_id, start=desc_start, end=desc_end))
            source_text += "\n" + seg.text[desc_start:desc_end]
        try:
            draft = DishDraft(
                name=clean_name,
                description=clean_description,
                category=d.category.strip()[:160] if d.category and d.category.strip() else None,
                category_page_number=p_num,
                price_text=clean_price_text,
                price_amount=single_price_amount(clean_price_text, price_amount),
                price_currency=None,  # The owner sets currency in review.
                ingredients=clean_ingredients,
                source_id=source.source_id,
                source_text=source_text,
                review_warnings=review_warnings,
            )
        except ValueError as exc:
            errors.append(f"Page {p_num}: dish {clean_name!r} rejected by the draft schema ({type(exc).__name__}).")
            continue
        idx = len(drafts)
        draft_id = f"draft:{hashlib.sha256(f'{source.sha256}:{idx}:{draft.model_dump_json()}'.encode()).hexdigest()[:32]}"

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
                spans=spans,
                box_evidence=[],
            )
        )
    return MenuExtractionResult(
        schema_version=2,
        pipeline_version="3",
        status=("incomplete" if drafts else "failed") if dispositions else ("incomplete" if errors else "complete"),
        started_at=started_at,
        finished_at=datetime.now(timezone.utc),
        extraction_mode="ai",
        source=source,
        segments=segments,
        drafts=drafts,
        evidence=evidence,
        configuration={"pipeline_version": "3", "v4_vision": True, "input_mode": "vision_v4"},
        warnings=warnings,
        errors=errors,
    )
