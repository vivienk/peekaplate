"""Conservative, source-preserving price binding in uploaded-image coordinates.

None means no layout was available; a null result means layout cannot prove a
unique association. Anchors are (left, top, width, height) unions of supplied
heading boxes, including an inline price when its box cannot be subdivided.
No character coordinates, source offsets, currencies or option labels are inferred.
"""
import math
import re
from typing import NamedTuple

from .menu_context import detached_prices, dish_block, entry_matches, nonprice_unit, phrase_matches

_NUMBER = r"\d+(?:\.\d+)?"
_AMOUNT = rf"(?:(?:[$€£₱]|PHP|P)[ \t]*)?{_NUMBER}"
_PRICE = re.compile(rf"(?:(?-i:[A-Z]{{3}})[ \t]+)?{_AMOUNT}(?:[ \t]*/[ \t]*{_AMOUNT})*(?:[ \t]+(?-i:[A-Z]{{3}}))?", re.I)
_MARKUP = re.compile(r"[ \t#*▼►•>-]*")
_UNIT = re.compile(r"(?:kcal|calories|cals?|pcs?|pieces?|servings?|grams?|kg|g|ml|oz)", re.I)


class _Box(NamedTuple):
    text: str
    left: float
    top: float
    right: float
    bottom: float

    @property
    def height(self):
        return self.bottom - self.top


def _overlap(a, b):
    return min(a.bottom, b.bottom) - max(a.top, b.top)


def _same_row(a, b):
    return _overlap(a, b) >= 0.6 * min(a.height, b.height)


def _union(boxes, text):
    return _Box(text, min(b.left for b in boxes), min(b.top for b in boxes),
                max(b.right for b in boxes), max(b.bottom for b in boxes))


def _number(value, positive=False):
    return (type(value) in (int, float) and (0 < value if positive else 0 <= value)
            and value <= 100_000 and math.isfinite(value))


def _regions(metadata):
    if metadata.get("ocr_coordinate_space") != "uploaded_image_pixels":
        return None
    width, height = metadata.get("upload_width"), metadata.get("upload_height")
    values = metadata.get("ocr_regions")
    # Deliberately narrower than the provider's limit: excessive layouts abstain.
    if not (_number(width, True) and _number(height, True)
            and isinstance(values, list) and 1 <= len(values) <= 1000):
        return None
    boxes = []
    for value in values:
        if not isinstance(value, dict):
            return None
        label = value.get("text")
        coords = [value.get(key) for key in ("left", "top", "width", "height")]
        if (not isinstance(label, str) or not label.strip() or len(label) > 1000
                or any(c in label for c in "\0\r\n")
                or not all(_number(n, i >= 2) for i, n in enumerate(coords))):
            return None
        label = label.strip()
        # Overlay labels can include logos omitted from ParsedText. Only names
        # and prices used below must be source-supported; extra labels block jumps.
        x, y, w, h = coords
        if x + w > width or y + h > height:
            return None
        boxes.append(_Box(label, x, y, x + w, y + h))
    return boxes


def _runs(boxes):
    """Join adjacent same-row words without estimating character coordinates."""
    parents = list(range(len(boxes)))

    def root(i):
        while parents[i] != i:
            i = parents[i]
        return i

    for i, a in enumerate(boxes):
        for j in range(i):
            b = boxes[j]
            gap = max(a.left, b.left) - min(a.right, b.right)
            if _same_row(a, b) and 0 <= gap <= 1.5 * min(a.height, b.height):
                parents[root(i)] = root(j)
    groups = {}
    for i, b in enumerate(boxes):
        groups.setdefault(root(i), []).append(b)
    runs = []
    for group in groups.values():
        if any(not _same_row(a, b) for a in group for b in group):
            runs.extend(group)
            continue
        ordered = sorted(group, key=lambda b: b.left)
        runs.append(_union(ordered, " ".join(b.text for b in ordered)))
    return sorted(runs, key=lambda b: (b.top, b.left, b.text))


def _source_price(value, text, names):
    if not _PRICE.fullmatch(value):
        return None
    literals = set()
    for match in phrase_matches(value, text):
        if any(match.start() < n.end() and match.end() > n.start() for n in names):
            continue
        if len(match.group()) > 160 or not _PRICE.fullmatch(match.group()):
            continue
        numbers = list(re.finditer(_NUMBER, match.group()))
        if not any(nonprice_unit(text, match.start() + n.start(), match.start() + n.end())
                   for n in numbers):
            literals.add(match.group())
    # Different source spellings/spacing cannot be resolved to one physical span.
    return next(iter(literals)) if len(literals) == 1 else None


def _has_unit(box, runs):
    # A detached word in flattened text can still label this physical numeric row.
    return any(b != box and _same_row(box, b) and _UNIT.fullmatch(b.text.strip(" :"))
               for b in runs)


def _headings(name, runs):
    normalized = " ".join(name.casefold().split())
    for first in runs:
        parts = [first]
        for _ in range(8):
            joined = " ".join(p.text for p in parts)
            matches = phrase_matches(name, joined)
            match = matches[0] if matches else None
            if match and _MARKUP.fullmatch(joined[:match.start()]):
                tail = joined[match.end():].strip()
                # No trailing commas, descriptions, or digits from inside the name.
                if not tail or _PRICE.fullmatch(tail):
                    yield parts, _union(parts, joined[:match.end()].strip()), tail
                break
            prefix = " ".join(_MARKUP.sub("", joined, count=1).casefold().split())
            if not prefix or not normalized.startswith(prefix + " "):
                break
            last = parts[-1]
            remaining=normalized[len(prefix):].strip()
            below = [b for b in runs if b not in parts and b.top >= last.bottom
                     and b.top - last.bottom <= last.height
                     and abs(b.left - first.left) <= 2 * min(first.height, b.height)
                     and (remaining == b.text.casefold() or remaining.startswith(b.text.casefold()+" "))]
            if len(below) != 1:
                break
            parts.append(below[0])


def _collides(box, runs):
    return any(other != box and _overlap(box, other) > 0
               and min(box.right, other.right) > max(box.left, other.left) for other in runs)


def _is_caption(name, label, text):
    """Only distinguishable explicit image-alt text proves a caption role."""
    normalize=lambda value:" ".join(_MARKUP.sub("", value, count=1).split())
    label=normalize(label)
    captions={normalize(value) for value in re.findall(r"!\[([^\]\n]+)\]\([^\n)]*\)", text)}
    entries={normalize(match.group()) for match in entry_matches(name, text)}
    return label in captions and label not in entries


def _card_price(name, text, dish_names, parts, heading, runs, prices):
    """A below-description price needs both a bounded text entry and column."""
    block=dish_block(name, text, dish_names)
    if not block or detached_prices(block):
        return None
    scale=max(part.height for part in parts)
    boundaries=[other.top for other_name in {*dish_names, name}
                for _,other,_ in _headings(other_name, runs)
                if other.top >= heading.bottom and abs(other.left-heading.left) <= 2*scale]
    end=min(boundaries, default=math.inf)
    below=[(box,literal) for box,literal in prices if literal is not None
           and heading.bottom <= box.top < end and abs(box.left-heading.left) <= 2*scale]
    if len(below) != 1:
        return None
    box,literal=below[0]
    if _collides(box, runs) or not phrase_matches(literal, block):
        return None
    return literal


def entry_price(name: str, text: str, metadata: dict | None, *, dish_names=()):
    """Return one geometry-proven literal price/heading, or conservatively abstain.

    A missing/unavailable layout returns None for the caller's legacy text path.
    Every other failure returns all-null fields and must NOT widen text acceptance.
    Geometry is validated in full. Unused overlay text is never a food fact.
    """
    unknown = {"price_text": None, "anchor": None, "label": None}
    if metadata is None or metadata == {}:
        return None
    if not isinstance(metadata, dict):
        return unknown
    status = metadata.get("ocr_region_status")
    if status == "unavailable":
        return None
    if status is None and not any(k in metadata for k in ("ocr_regions", "ocr_coordinate_space")):
        return None
    if status != "available" or not isinstance(text, str) or not isinstance(name, str) or not name.strip():
        return unknown
    boxes = _regions(metadata)
    runs = _runs(boxes) if boxes else None
    if not runs:
        return unknown
    # Source entries compete even if joined description boxes hide their headings.
    if len(entry_matches(name, text)) != 1:
        return unknown
    all_names={*dish_names, name}
    names=[match for other in all_names for match in phrase_matches(other, text)]
    all_headings={other:list(_headings(other, runs)) for other in all_names}
    heading_parts={part for headings in all_headings.values() for parts,_,_ in headings for part in parts}
    prices = [(b, None if b in heading_parts or _has_unit(b, runs) else _source_price(b.text, text, names)) for b in runs]
    headings=[value for value in all_headings[name] if not _is_caption(name, value[1].text, text)]
    # A genuinely unpriced entry must still compete with a priced occurrence.
    if len(headings) != 1:
        return unknown
    entries = []
    for parts, heading, inline in headings:
        candidates = []
        if inline:
            if any(_collides(part, runs) for part in parts):
                return unknown
            literal = _source_price(inline, text, names)
            if literal is None or any(_has_unit(p, runs) for p in parts):
                return unknown
            candidates.append(literal)
        for price_box, literal in prices:
            if literal is None or price_box in parts or price_box.left < heading.right:
                continue
            if not any(_same_row(p, price_box) for p in parts):
                continue
            if _collides(price_box, runs):
                return unknown
            # Do not jump over another column's label, even if its price is closer.
            blocked = any(b not in parts and b != price_box and (b in heading_parts or not _PRICE.fullmatch(b.text))
                          and b.left < price_box.left and b.right > heading.left
                          and _overlap(b, price_box) > 0 for b in runs)
            if not blocked:
                candidates.append(literal)
        if len(candidates) > 1:
            return unknown
        if not candidates:
            card=_card_price(name, text, dish_names, parts, heading, runs, prices)
            if card is not None:
                candidates.append(card)
        if candidates:
            anchor = (heading.left, heading.top, heading.right - heading.left, heading.height)
            entries.append({"price_text": candidates[0], "anchor": anchor, "label": heading.text})
    # Entry identity is established before price selection, not by price presence.
    return entries[0] if len(entries) == 1 else unknown
