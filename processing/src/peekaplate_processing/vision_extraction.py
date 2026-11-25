"""V4 Multimodal Vision Extraction with native normalized bounding boxes.

Extracts structured menu dishes and drinks directly from page images; no OCR text is read.
Maps named ymin/xmin/ymax/xmax normalized coordinates (0..1000) to pixel rectangles.
Everything here is a vision-model transcription: names, prices, descriptions, ingredient
proposals and boxes are unverified proposals for human review, not OCR evidence.
"""
import asyncio
import json
import re
import sys
from typing import Any, Literal

import openai

from pydantic import BaseModel, ConfigDict, Field, model_validator

from peekaplate_processing._vision_projection import (
    MAX_V4_INGREDIENT_CHARS as MAX_V4_INGREDIENT_CHARS,
    MAX_V4_INGREDIENTS as MAX_V4_INGREDIENTS,
    VISION_REVIEW_WARNING as VISION_REVIEW_WARNING,
    build_v4_result as build_v4_result,
    grounded_ingredients as grounded_ingredients,
    merge_split_options as merge_split_options,
    scale_box as scale_box,
    single_price_amount as single_price_amount,
)
from peekaplate_processing.model_providers import supports_strict_vision_schema

MAX_VISION_RESPONSE_BYTES = 1_000_000
MAX_VISION_SERIALIZED_BYTES = 6_000_000
MAX_VISION_CAPTURE_BYTES = 4_000_000
MAX_VISION_ATTEMPTS = 400


class VisionCaptureLimitError(Exception):
    """The private attempt history cannot be represented safely."""


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
    ingredients: list[str] | None = Field(
        default=None,
        description="At most 100 printed ingredient phrases (each at most 256 characters) copied from this item's printed description; never inferred.",
    )
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
Copy text exactly as printed. Never invent descriptions, prices, currencies or ingredients; use null when absent.
Exclude non-food merchandise such as wrapping cloths. Preserve plus-qualified prices in price_text; they are not fixed prices.
For each item, output:
- name: dish title
- description: copy this item's printed description verbatim, or null if absent. Read wrapped lines as one block. Keep the original order, commas, dashes, conjunctions and wording; do not rewrite it into an ingredient list or borrow text from neighboring items.
- ingredients: after copying the description, identify the distinct food, drink or garnish components it explicitly says are included. Copy each as a separate contiguous phrase from that same description (at most 100 phrases, each at most 256 characters), or use null if none qualify.
  - Commas, semicolons, spaced dashes, em dashes and conjunctions can separate components, but are only clues. Split only when both parts independently name included components. Keep compounds and names intact, such as \"house-made cheese cream\", \"deep-fried tofu\" and \"sweet and sour sauce\".
  - Do not turn preparation adjectives, measurements, tasting notes, marketing copy or serving instructions into ingredients. If a printed fragment does not clearly name a component, omit it rather than expanding it from recipe knowledge. Do not infer from the title or another item.
  - Keep included accompaniments and garnishes (such as \"served with rice\" or \"topped with sesame\"), but omit exclusions, alternatives, selectable flavors, substitutions and optional or separately priced add-ons. Keep those words in description, not in ingredients.
  - Example: \"Fresh-cut fries — garlic truffle oil, served with herb aioli; optional bacon\" stays unchanged in description. Ingredients are [\"fries\", \"garlic truffle oil\", \"herb aioli\"], not \"Fresh-cut\" or \"bacon\".
- category: section heading (e.g. STARTERS, SALADS, DESSERTS) or null
- price_text: verbatim price text (e.g. "25.99", "12/15") or null. If one item prints several prices (sizes or options), output ONE entry with every price in price_text separated by " / "; never repeat the item once per price.
- price_amount: numeric price (e.g. "25.99") only when exactly one price is printed, else null
- price_currency: 3-letter currency code only if printed or unambiguous from a symbol, else null
- box: {"ymin": int, "xmin": int, "ymax": int, "xmax": int} around item title, each value 0..1000 normalized
- price_box: the same object shape around the printed price, or null"""

_COVERAGE_INSTRUCTION = (
    "GENERAL COVERAGE INSTRUCTION: Enumerate every separately priced menu entry visible on the page, "
    "not only the main dishes: every column, section, sidebar, special-offer panel, standalone priced "
    "item, and separately priced add-on. Do not drop an entry because the same food appears elsewhere; "
    "an offer printed under a different heading, size, or price is its own record. Record a separately "
    "priced add-on as its own candidate using the existing fields: keep its printed name/text exactly as "
    "printed (for example text that begins with a printed 'add'), and put the actual printed section "
    "heading in category when the page prints one, or null when it does not; never invent an 'Add-on' or "
    "any other category label the page does not print, and never add schema fields. Do not list a "
    "separately priced addition as an ingredient of the main dish. When one printed item carries several "
    "price groups (for example member and non-member, sizes, or variants), output one entry that keeps "
    "every printed price in price_text rather than only the first price; only separately listed priced "
    "items become separate records. Printed headings, section labels, qualifiers, and serving notes that "
    "carry no price are not standalone items: do not emit them as candidates. Before finishing, silently "
    "re-check the whole image and confirm every headed section, column, sidebar, and special-offer panel "
    "is represented by the records you emit, then output the JSON only."
)


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


V4_RESPONSE_FORMAT_NAME = "v4_batch"


def _provider_transport(llm: Any) -> tuple[str | None, dict[str, Any]]:
    """Best-effort base URL and request options through client wrappers."""
    pending = [llm]
    visited: set[int] = set()
    while pending and len(visited) < 8:
        current = pending.pop(0)
        if id(current) in visited:
            continue
        visited.add(id(current))
        for attribute in ("openai_api_base", "base_url"):
            value = getattr(current, attribute, None)
            if isinstance(value, str) and value:
                return value, getattr(current, "extra_body", None) or {}
        for attribute in ("client", "bound", "llm"):
            nested = getattr(current, attribute, None)
            if nested is not None and nested is not current and not isinstance(nested, (str, bytes)):
                pending.append(nested)
    return None, {}


def vision_response_format(base_url: str | None, schema: dict[str, Any]) -> dict[str, Any] | None:
    """API-level json_schema constraint for providers supporting strict vision output.

    The provider receives V4Batch.model_json_schema() unchanged. LangChain's
    with_structured_output/openai helpers rewrite the schema (every property becomes
    required and defaults are dropped), which would change the wire contract. We set
    strict ourselves while passing the original dictionary, and let a provider
    rejection surface as an error instead of retrying without the constraint.
    """
    if not supports_strict_vision_schema(base_url):
        return None
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ValueError("V4Batch.model_json_schema() did not produce a JSON-schema object.")
    if "dishes" not in (schema.get("properties") or {}):
        raise ValueError("V4Batch schema is missing its 'dishes' property; refusing an incompatible format.")
    return {
        "type": "json_schema",
        "json_schema": {"name": V4_RESPONSE_FORMAT_NAME, "schema": schema, "strict": True},
    }


class VisionProgress:
    """Parsed results and page dispositions for one provider attempt."""

    def __init__(self) -> None:
        self.dishes: list[V4Dish] = []
        self.errors: list[str] = []
        self.page_dispositions: dict[int, tuple[Literal["failed", "skipped"], str]] = {}
        self.active_page: int | None = None


def extract_vision_v4(llm: Any, page_images: list[dict], *, timeout: float | None = None,
                      attempts: list[dict] | None = None, provider: str = "default",
                      budget_gate: Any | None = None,
                      progress: VisionProgress | None = None,
                      rate_limit_retry_delay: float | None = None) -> tuple[list[V4Dish], list[str]]:
    """Run direct multimodal extraction per page.

    Returns dishes (page numbers forced to the page that was sent) and page-level errors
    describing possible dish loss. Supplied progress retains completed results if a
    subsequent page raises; the exception type is preserved for the caller. A configured
    retry delay allows one transient rate-limit retry without replaying completed pages.
    """
    if progress is None:
        progress = VisionProgress()
    max_tok = getattr(llm, "max_tokens", 16384) or 16384
    bind_kwargs: dict[str, Any] = {"max_tokens": max_tok}
    if timeout is not None:
        bind_kwargs["timeout"] = timeout
    schema = V4Batch.model_json_schema()
    base_url, extra_body = _provider_transport(llm)
    response_format = vision_response_format(base_url, schema)
    if response_format is not None:
        # extra_body keeps the SDK on its plain create path: binding response_format
        # directly makes langchain-openai use beta parse(), which raises on
        # finish_reason=length and would bypass the existing truncation evidence
        # and regex salvage.
        bind_kwargs["extra_body"] = {**extra_body, "response_format": response_format}
    vision_llm = llm.bind(**bind_kwargs)
    prompt = (
        f"{V4_VISION_PROMPT}\n\nREQUIRED JSON SCHEMA:\n{json.dumps(schema)}"
        f"\n\n{_COVERAGE_INSTRUCTION}"
    )

    async def _request_page(messages, page_num):
        record = None
        if attempts is not None:
            if len(attempts) >= MAX_VISION_ATTEMPTS:
                raise VisionCaptureLimitError("Vision attempt limit exceeded.")
            record = {"attempt": len(attempts) + 1, "provider": provider,
                      "page_number": page_num, "outcome": "error", "response": None,
                      "truncated": False, "failure_class": "provider_error"}
            attempts.append(record)
        try:
            if budget_gate is not None:
                await budget_gate.areserve(provider)
            if timeout is not None and timeout > 0:
                try:
                    response = await asyncio.wait_for(vision_llm.ainvoke(messages), timeout=timeout)
                except asyncio.TimeoutError:
                    raise TimeoutError(f"Vision request exceeded its {timeout:g}s deadline and was cancelled.") from None
            else:
                response = await vision_llm.ainvoke(messages)
        except Exception as error:
            if record is not None:
                record["failure_class"] = ("timeout" if isinstance(error, (TimeoutError, openai.APITimeoutError)) else
                                           "rate_limit" if isinstance(error, openai.RateLimitError) else
                                           "provider_error")
            raise
        return response, record

    async def _extract_all() -> tuple[list[V4Dish], list[str]]:
        all_dishes = progress.dishes
        errors = progress.errors
        retry_delay = rate_limit_retry_delay
        for page in page_images:
            page_num = page["page_number"]
            progress.active_page = page_num
            content = [
                {"type": "text", "text": f"Extract all menu items from Page {page_num}."},
                {"type": "image_url", "image_url": {"url": page["image_url"]}},
            ]
            messages = [("system", prompt), ("human", content)]
            try:
                response, record = await _request_page(messages, page_num)
            except openai.RateLimitError as error:
                error_text = str(error).lower()
                if retry_delay is None or "per day" in error_text or "perday" in error_text:
                    raise
                print(f"Rate limited; retrying once in {retry_delay:g}s...", file=sys.stderr, flush=True)
                await asyncio.sleep(retry_delay)
                retry_delay = None
                response, record = await _request_page(messages, page_num)
            raw_content = getattr(response, "content", None)
            capture_content = raw_content
            structured = not isinstance(raw_content, str)
            if structured and raw_content is not None:
                try:
                    capture_content = json.dumps(raw_content, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                except (TypeError, ValueError, OverflowError, RecursionError):
                    capture_content = None
            if record is not None and isinstance(capture_content, str):
                try:
                    raw_bytes = capture_content.encode("utf-8")
                except UnicodeEncodeError:
                    # JSON escaping preserves non-UTF-8 code points without pretending
                    # the serialized form is the original provider text.
                    capture_content = json.dumps(capture_content, ensure_ascii=True)
                    raw_bytes = capture_content.encode("utf-8")
                    structured = True
                used = sum(len(item["response"].encode("utf-8")) for item in attempts
                           if item["response"] is not None)
                serialized_used = sum(len(json.dumps(item["response"], ensure_ascii=False).encode("utf-8"))
                                      for item in attempts if item["response"] is not None)
                limit = min(MAX_VISION_RESPONSE_BYTES, MAX_VISION_CAPTURE_BYTES - used)
                captured = raw_bytes[:limit].decode("utf-8", errors="ignore")
                serialized_limit = MAX_VISION_SERIALIZED_BYTES - serialized_used
                if len(json.dumps(captured, ensure_ascii=False).encode("utf-8")) > serialized_limit:
                    low, high = 0, len(captured)
                    while low < high:
                        middle = (low + high + 1) // 2
                        if len(json.dumps(captured[:middle], ensure_ascii=False).encode("utf-8")) <= serialized_limit:
                            low = middle
                        else:
                            high = middle - 1
                    captured = captured[:low]
                record.update(outcome="response", response=captured,
                              truncated=len(raw_bytes) > len(captured.encode("utf-8")),
                              failure_class="invalid_response" if structured else
                                            None if raw_content.strip() else "empty_response")
                if record["truncated"]:
                    errors.append(f"Page {page_num}: private vision response capture was truncated.")
            elif record is not None:
                record["failure_class"] = "invalid_response"
            if structured or not raw_content.strip():
                message = "vision model returned no usable text content."
                progress.page_dispositions[page_num] = ("failed", message)
                errors.append(f"Page {page_num}: {message}")
                continue
            metadata = getattr(response, "response_metadata", None) or {}
            if metadata.get("finish_reason") == "length":
                errors.append(f"Page {page_num}: vision output hit the token limit; later dishes may be missing.")
            try:
                dishes = _parse_page(raw_content.strip(), page_num, errors)
            except ValueError:
                if record is not None and record["outcome"] == "response":
                    record["failure_class"] = "parse_error"
                progress.page_dispositions[page_num] = ("failed", "Vision model response could not be parsed.")
                raise
            all_dishes.extend(d.model_copy(update={"page_number": page_num}) for d in dishes)
        return all_dishes, errors

    return asyncio.run(_extract_all())
