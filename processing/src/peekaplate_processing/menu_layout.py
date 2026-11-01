"""Conservative, source-preserving price binding in uploaded-image coordinates.

None means no layout was available; a null result means layout cannot prove a
unique association. Anchors are (left, top, width, height) unions of supplied
heading boxes, including an inline price when its box cannot be subdivided.
No character coordinates, source offsets, currencies or option labels are inferred.
"""
from decimal import Decimal
import math
import re
import unicodedata
from typing import NamedTuple

from .menu_context import MONEY_MARKER, CURRENCY_CODE, PRICE_OPTION, detached_prices, dish_block, entry_matches, is_unpriced_callout, nonprice_unit, phrase_matches, price_matches, single_source_entry

_NUMBER = r"\d+(?:\.\d+)?"
_PRICE = re.compile(rf"{PRICE_OPTION}(?:[ \t]*/[ \t]*{PRICE_OPTION})*", re.I)
_MARKUP = re.compile(r"[ \t#*▼►•>-]*")
_UNIT = re.compile(r"(?:kcal|calories|cals?|pcs?|pieces?|servings?|grams?|kg|g|ml|oz)", re.I)

_BOX_NUMBER = r"(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?"
_BOX_OPTION = rf"(?:(?:SM|LG)[ \t]*)?(?:{MONEY_MARKER}[ \t]*)?({_BOX_NUMBER})(?:[ \t]+{CURRENCY_CODE})?"
_BOX_PRICE = re.compile(rf"{_BOX_OPTION}(?:[ \t]*/[ \t]*{_BOX_OPTION})*", re.I)
_BOX_MODEL_SEQUENCE = re.compile(rf"{_BOX_OPTION}(?:[ \t]+{_BOX_OPTION})+", re.I)
_BOX_OPTION_PATTERN = re.compile(_BOX_OPTION, re.I)
_BOX_DIGITS = re.compile(_BOX_NUMBER)


def _numbers(literal):
    value = literal.strip()
    if len(value) > 160 or not _BOX_PRICE.fullmatch(value):
        return None
    return tuple(Decimal(match.group()) for match in _BOX_DIGITS.finditer(value))


def _model_numbers(literal):
    if "\n" in literal:
        slashed = " / ".join(line.strip() for line in literal.splitlines() if line.strip())
        vals = _numbers(slashed)
        if vals is not None:
            return vals
    values = _numbers(literal)
    if values is not None:
        return values
    # Saved vision readings can separate complete options by whitespace. Bare
    # integer fragments ("3 50") cannot establish such a sequence. This parses
    # only the model reading; no separator is ever added to OCR evidence.
    value = literal.strip()
    if len(value) > 160 or not _BOX_MODEL_SEQUENCE.fullmatch(value):
        return None
    for option in _BOX_OPTION_PATTERN.finditer(value):
        number_match = _BOX_DIGITS.search(option.group())
        if not number_match:
            return None
        number = number_match.group()
        if "." not in number and option.group().strip() == number:
            return None
    return tuple(Decimal(match.group()) for match in _BOX_DIGITS.finditer(value))


def _scalar(literal):
    if literal is None or not re.fullmatch(_BOX_NUMBER, str(literal)):
        return None
    return (Decimal(str(literal)),)


def _title_paths(name, boxes, *, mentions=False):
    """Exact bounded heading runs, retaining only original region indices.

    None means an unresolved/exhausted search, not absence. These paths are
    membership constraints only: they never become bounding evidence or quotes.
    """
    normalized = " ".join(name.casefold().split())
    raw_name=" ".join(name.split())
    labels = [" ".join(box.text.split()) for box in boxes]

    def matches(value):
        normalized_value=" ".join(value.casefold().split())
        if mentions:
            return phrase_matches(raw_name,value) or phrase_matches(normalized,normalized_value)
        return normalized_value==normalized

    def is_prefix(value):
        return (normalized.startswith(" ".join(value.casefold().split())+" ")
                or mentions and re.match(re.escape(value)+r"\s+",raw_name,re.I))

    paths = []
    budget = 10_000
    for first, label in enumerate(labels):
        if matches(label):
            paths.append((first,))
            continue
        if not is_prefix(label):
            continue
        pending = [((first,), label)]
        while pending:
            path, prefix = pending.pop()
            if len(path) >= 8:
                return None
            previous = boxes[path[-1]]
            for i, box in enumerate(boxes):
                budget -= 1
                if budget < 0:
                    return None
                if i in path:
                    continue
                gap = box.left - previous.right
                adjacent = _same_row(previous, box) and 0 <= gap <= 1.5 * min(previous.height, box.height)
                wrapped = (box.top >= previous.bottom and box.top - previous.bottom <= previous.height
                           and abs(box.left - boxes[first].left) <= 2 * min(previous.height, box.height))
                if not (adjacent or wrapped):
                    continue
                if not mentions and any(
                    j not in path and j != i and (
                        (adjacent and previous.right <= other.left and other.right <= box.left
                         and _overlap(previous, other) > 0 and _overlap(box, other) > 0)
                        or (wrapped and previous.bottom <= other.top and other.bottom <= box.top
                            and min(previous.right, other.right) > max(previous.left, other.left)))
                    for j, other in enumerate(boxes)
                ):
                    continue
                joined = prefix + " " + labels[i]
                if matches(joined):
                    paths.append((*path, i))
                elif is_prefix(joined):
                    pending.append(((*path, i), joined))
    return paths


def box_price_text_is_missing(name, text, dish_names=()):
    """Only a unique, completely number-free canonical entry permits fallback."""
    if not single_source_entry(name, text):
        return False
    start=entry_matches(name, text)[0].end()
    end=min((match.start() for other in dish_names
             if other.casefold() != name.casefold() and _section_boundary_label(other,food_entry=True)
             for match in entry_matches(other, text) if match.start() >= start), default=len(text))
    body = text[start:end]
    body = re.sub(r"(?is)\n\+[ \t]*add[ \t]*on\b.*", "", body)
    body = re.sub(r"(?is)\nprices are vat inclusive.*", "", body)
    body = re.sub(r"(?i)\b\d+(?:\.\d+)?\s*(?:oz|ounces?)\b", "", body)
    return re.search(r"\d", body) is None


_NON_SECTION_WORDS=frozenset(('price prices pricing cost costs amount amounts rate rates size sizes '
    'option options choice choices percent percentage count counts quantity qty portion portions weight volume '
    'energy nutrition nutritional temperature temp currency dollar dollars peso pesos euro euros '
    'yen pound pounds rupee rupees phone tel telephone call contact fax mobile whatsapp '
    'address website web email').split())
_GENERIC_SECTION_WORDS=frozenset(('small medium large sm med md lg xl xxl regular reg extra single double standard mini jumbo '
    'serve serves per list a ala la carte solo combo combos meal meals set sets add addon on with w '
    'of incl including includes inclusive upgrade endless unlimited refill refills hot cold warm iced').split())
_COMPACT_WORD_SET=frozenset(word.casefold() for word in (_NON_SECTION_WORDS|_GENERIC_SECTION_WORDS))
_COMPACT_MAX_WORD=max(len(word) for word in _COMPACT_WORD_SET)
_MONEY_PREFIX=re.compile(MONEY_MARKER,re.I)


def _compact_non_section_work(value: str) -> tuple[bool, int]:
    """Deterministic O(L) segmentation check without exponential regex backtracking."""
    n = len(value)
    if n == 0 or n > 256:
        return False, 1
    folded = value.casefold()
    reachable = [False] * (n + 1)
    reachable[0] = True
    steps = 0
    for i in range(n):
        if not reachable[i]:
            continue
        steps += 1
        for pat in (_MONEY_PREFIX, _UNIT):
            match = pat.match(value, i)
            if match and match.end() > i:
                reachable[match.end()] = True
        upper = min(n, i + _COMPACT_MAX_WORD)
        for j in range(i + 1, upper + 1):
            steps += 1
            if folded[i:j] in _COMPACT_WORD_SET:
                reachable[j] = True
    return reachable[n], steps


def _section_boundary_label(label, *, food_entry=False):
    """Negative role checks only; never normalize stored names/text/geometry."""
    if len(label)>256 or not any(c.isalpha() for c in label):
        return False
    # Separate compatibility unit symbols before folding (e.g. ㎖ -> ml),
    # while not letting a trademark's compatibility spelling hide PRICE™.
    label=label.replace('®','').replace('™','')
    label=''.join(' '+unicodedata.normalize('NFKC',c)+' ' if unicodedata.category(c)=='So'
                  else c for c in label)
    label=unicodedata.normalize('NFKC',label)
    if any((c.isdigit() and not food_entry) or unicodedata.category(c)=='Sc' or c in '%％°' for c in label):
        return False
    words=re.findall(r'[^\W\d_]+',label)
    if (not words or (not food_entry and all(re.fullmatch(r'[A-Z]{3}',word) for word in words))
            or any(word.casefold() in _NON_SECTION_WORDS or _UNIT.fullmatch(word)
                   or re.fullmatch(MONEY_MARKER,word,re.I) for word in words)):
        return False
    matched, _ = _compact_non_section_work(''.join(words))
    return not matched


def section_price_context(name, category, text, metadata, *, section_names=(), dish_names=()):
    """Resolve repeats only with one explicit textual and geometric section.

    The returned view is never saved. Original indices/coordinates are retained
    separately so selected price evidence can be joined back without fabrication.
    """
    normalize=lambda value:" ".join(value.casefold().split())
    if (not category or normalize(category)==normalize(name) or len(text)>100_000
            or single_source_entry(name,text) or not isinstance(metadata,dict)
            or metadata.get("ocr_region_status")!="available"):
        return None
    headers=[(match,len(match.group(1)),match.group(2).strip()) for match in
             re.finditer(r"(?m)^[ \t]*(#{1,6})[ \t]+([^\n]+)",text)]
    if len(headers)>256:
        return None
    allowed={normalize(value) for value in section_names}
    headers=[h for h in headers if normalize(h[2]) in allowed and _section_boundary_label(h[2])]
    matches=[h for h in headers if normalize(h[2])==normalize(category)]
    if len(matches)!=1:
        return None
    match,level,label=matches[0]
    stop=min((h[0].start() for h in headers if h[0].start()>match.start() and h[1]<=level),default=len(text))
    scoped=text[match.end():stop]
    if not single_source_entry(name,scoped):
        return None
    entry=entry_matches(name,scoped)[0]
    entry_start,entry_end=match.end()+entry.start(),match.end()+entry.end()
    # A selected section never hides canonical numbers through the next known
    # food entry. Headings (even unrecognized ones) cannot truncate this guard.
    entry_stop=min((other.start() for title in {*dish_names,name}
                    if _section_boundary_label(title,food_entry=True)
                    for other in entry_matches(title,text) if other.start()>=entry_end),default=len(text))
    boxes=_regions(metadata)
    if not boxes:
        return None
    roots=[]
    root_indices=set()
    target=None
    for header,depth,heading in headers:
        if depth>level:
            continue
        paths=_title_paths(heading,boxes)
        if paths is None or len(paths)!=1:
            return None
        parts=[boxes[i] for i in paths[0]]
        bounds=_union(parts,heading)
        if any(_collides(part,boxes) for part in parts):
            return None
        roots.append(bounds)
        root_indices.update(paths[0])
        if header.start()==match.start():
            target=bounds
    if target is None:
        return None
    right=min((other.left for other in roots if other!=target and other.left>=target.right
               and _same_row(target,other)),default=math.inf)
    bottom=min((other.top for other in roots if other!=target and other.top>=target.bottom
                and abs(other.left-target.left)<=2*target.height),default=math.inf)
    def inside(b):
        return b.left>=target.left and b.right<=right and b.top>=target.bottom and b.bottom<=bottom
    if any(b.right>target.left and b.left<right and b.bottom>target.bottom and b.top<bottom
           and not inside(b) for b in boxes):
        return None
    indices=[i for i,b in enumerate(boxes) if inside(b)]
    paths=_title_paths(name,boxes)
    if not indices or paths is None:
        return None
    local=[path for path in paths if all(inside(boxes[i]) for i in path)]
    if len(local)!=1:
        return None
    title=_union([boxes[i] for i in local[0]],name)
    neighbors=[path for path in paths if not root_indices.intersection(path)
               and all(not inside(boxes[i]) for i in path)]
    if any(_collides(boxes[i],boxes) for path in neighbors for i in path):
        return None
    neighbor_parts={i for path in neighbors for i in path}
    neighbor_titles=[_union([boxes[i] for i in path],name) for path in neighbors]
    # A column boundary alone cannot erase an option/unit on this title's row.
    # Omitted row cells need a separate exact same-name title to own their row.
    if any(not inside(b) and _same_row(title,b) and i not in neighbor_parts
           and not any(other.right<=b.left and _same_row(other,b) for other in neighbor_titles)
           for i,b in enumerate(boxes)):
        return None
    return {"text":scoped,"metadata":{**metadata,"ocr_regions":[metadata["ocr_regions"][i] for i in indices]},
            "region_indices":indices,"canonical_entry_start":entry_start,
            "canonical_name_end":entry_end,"canonical_entry_stop":entry_stop}


def corroborate_box_price(name: str, model_price_text: str | None, model_price_amount: str | None,
                          metadata: dict | None, *, dish_names: tuple[str, ...] = ()):
    """Corroborate prices from OCR TextOverlay bounding boxes when ParsedText lacks them.

    Returns:
        tuple: (corroborated_price_text, corroborated_price_amount, box_evidence_list)
        or (None, None, []) if not corroborated.
    """
    if metadata is None or metadata == {}:
        return None, None, []
    if not isinstance(metadata, dict):
        return None, None, []
    if metadata.get("ocr_coordinate_space") != "uploaded_image_pixels" or metadata.get("ocr_region_status") != "available":
        return None, None, []
    raw_regions = metadata.get("ocr_regions")
    if not isinstance(raw_regions, list) or not raw_regions:
        return None, None, []
    for raw in raw_regions:
        if not isinstance(raw, dict) or set(raw) != {"text", "left", "top", "width", "height"}:
            return None, None, []

    boxes = _regions(metadata)
    if not boxes or len(boxes) != len(raw_regions):
        return None, None, []
    # Reject exact duplicates in the overlay
    for index, box in enumerate(boxes):
        if any(box == other for other in boxes[:index]):
            return None, None, []

    normalized_name = " ".join(name.casefold().split())
    all_names = {*dish_names, name}
    if sum(" ".join(other.casefold().split()) == normalized_name for other in all_names) != 1:
        return None, None, []
    titles = {other: _title_paths(other, boxes) for other in all_names}
    if any(paths is None for paths in titles.values()):
        return None, None, []
    mentions = _title_paths(name, boxes, mentions=True)
    clean_mentions = [path for path in mentions if not any(boxes[i].text.rstrip().endswith(',') for i in path)]
    if clean_mentions != titles[name]:
        return None, None, []

    def _has_same_row_number(path):
        parts = [boxes[i] for i in path]
        return any(i not in path and _numbers(boxes[i].text) and any(_same_row(p, boxes[i]) for p in parts)
                   for i in range(len(boxes)))

    def _has_numeric_row_or_stack(path):
        if _has_same_row_number(path):
            return True
        parts = [boxes[i] for i in path]
        top_y = max(p.bottom for p in parts)
        stack = [boxes[i] for i in range(len(boxes)) if i not in path and _numbers(boxes[i].text)
                 and top_y <= boxes[i].top <= top_y + 150
                 and min(boxes[i].right, max(p.right for p in parts) + 400) > max(boxes[i].left, min(p.left for p in parts))]
        return len(stack) > 0

    for other in all_names:
        if len(titles[other]) > 1:
            same_row = [p for p in titles[other] if _has_same_row_number(p)]
            if len(same_row) == 1:
                titles[other] = same_row
                if other == name:
                    clean_mentions = same_row
            elif not same_row:
                priced = [p for p in titles[other] if _has_numeric_row_or_stack(p)]
                if len(priced) == 1:
                    titles[other] = priced
                    if other == name:
                        clean_mentions = priced
    if len(titles[name]) != 1:
        return None, None, []
    heading_indices = set(titles[name][0])
    parts = [boxes[i] for i in heading_indices]
    left = min(part.left for part in parts)
    right_edge = max(part.right for part in parts)
    excluded_indices = set()
    for other, paths in titles.items():
        if other == name:
            continue
        # Negative searches deliberately tolerate skipped/embedded text. If
        # those mentions cannot be reconstructed exactly, do not let any of
        # their numeric components masquerade as this entry's price.
        other_mentions = _title_paths(other, boxes, mentions=True)
        if other_mentions is None or (other_mentions and not paths):
            return None, None, []
        excluded_indices.update(i for path in paths for i in path)
    if heading_indices & excluded_indices:
        return None, None, []

    # Only known exact headings establish a neighboring column. Unknown labels
    # remain blockers, never guessed boundaries that could hide units/options.
    boundary = math.inf
    known_left = []
    for other, paths in titles.items():
        if other == name:
            continue
        for path in paths:
            other_parts = [boxes[i] for i in path]
            if not any(_overlap(a, b) > 0 for a in parts for b in other_parts):
                continue
            other_left = min(b.left for b in other_parts)
            other_right = max(b.right for b in other_parts)
            if len(paths) != 1:
                return None, None, []
            if other_right <= left:
                known_left.append(other_left)
                continue
            if other_left < right_edge:
                return None, None, []
            boundary = min(boundary, other_left)

    if boundary == math.inf:
        other_column_lefts = [min(boxes[i].left for i in path)
                              for other, paths in titles.items() if other != name
                              for path in paths if min(boxes[i].left for i in path) > right_edge]
        if other_column_lefts:
            boundary = min(other_column_lefts)
    if not known_left:
        all_left_column_starts = [min(boxes[i].left for i in path)
                                  for other, paths in titles.items() if other != name
                                  for path in paths if max(boxes[i].right for i in path) <= left]
        if all_left_column_starts:
            known_left.extend(all_left_column_starts)

    if any(b.right <= left and any(_same_row(part, b) for part in parts)
           and not any(start <= b.left for start in known_left) for b in boxes):
        return None, None, []
    row_indices = [i for i, b in enumerate(boxes) if i not in heading_indices
                   and b.left < boundary and b.right > left
                   and any(_same_row(part, b) for part in parts)]
    if any(boxes[i].left < right_edge for i in row_indices):
        return None, None, []
    right = sorted(row_indices, key=lambda i: boxes[i].left)
    is_stack = False
    if not right and model_price_text is not None and len(_model_numbers(model_price_text) or ()) > 1:
        top_limit = max(p.bottom for p in parts)
        next_top = math.inf
        for other, paths in titles.items():
            if other == name:
                continue
            for path in paths:
                other_parts = [boxes[i] for i in path]
                otop = min(b.top for b in other_parts)
                if otop >= top_limit and any(min(b.right, boundary) > max(b.left, left) for b in other_parts):
                    next_top = min(next_top, otop)
        stack_indices = [i for i, b in enumerate(boxes) if i not in heading_indices
                         and b.left < boundary and b.right > left
                         and top_limit <= b.top < next_top
                         and _numbers(b.text)]
        stack_sorted = sorted(stack_indices, key=lambda i: boxes[i].top)
        if stack_sorted:
            right = stack_sorted
            is_stack = True

    if not right or (not is_stack and any(boxes[i].right > boundary for i in right)):
        return None, None, []
    if not is_stack and any(not _same_row(boxes[i], boxes[j]) for i in right for j in right):
        return None, None, []
    if is_stack and any(abs(boxes[i].left - boxes[j].left) > 50 for i in right for j in right):
        return None, None, []
    end = max(boxes[i].right for i in right)
    if not is_stack and any(i not in heading_indices and i not in right and b.left < end and b.right > left
           and any(_overlap(b, a) > 4 for a in [*parts, *(boxes[j] for j in right)])
           for i, b in enumerate(boxes)):
        return None, None, []
    numbers = []
    box_records = []
    for i in right:
        price_box = boxes[i]
        vals = _numbers(price_box.text)
        if vals is None or i in excluded_indices:
            return None, None, []
        numbers.extend(vals)
        raw = raw_regions[i]
        box_records.append({
            "saved_region_index": i,
            "text": raw["text"],
            "box": {"left": raw["left"], "top": raw["top"], "width": raw["width"], "height": raw["height"]},
        })

    if model_price_text is None and model_price_amount is None:
        return None, None, []
    clean_text = re.split(r"(?i)\n(?:add|\+)", model_price_text)[0].strip() if model_price_text is not None else None
    expected = _model_numbers(clean_text) if clean_text is not None else _scalar(model_price_amount)
    if expected is None or tuple(numbers) != expected:
        return None, None, []
    if model_price_amount is not None and clean_text == model_price_text:
        if len(numbers) != 1 or _scalar(model_price_amount) != (numbers[0],):
            return None, None, []

    corroborated_text = " / ".join(record["text"] for record in box_records)
    corroborated_amount = str(numbers[0]) if len(numbers) == 1 else None
    return corroborated_text, corroborated_amount, box_records


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
    for match in price_matches(value, text):
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


def _matches_remaining(text, remaining):
    bt = " ".join(text.casefold().split())
    if bt == remaining or remaining.startswith(bt + " "):
        return True
    tail = re.sub(r"^[.\s…·•–—]+", "", bt[len(remaining):]).strip()
    return bt.startswith(remaining + " ") and bool(_PRICE.fullmatch(tail))

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
                clean_tail = re.sub(r"^[.\s…·•–—]+", "", tail).strip()
                # No trailing commas, descriptions, or digits from inside the name.
                if not clean_tail:
                    yield parts, _union(parts, joined[:match.end()].strip()), ""
                elif _PRICE.fullmatch(clean_tail):
                    yield parts, _union(parts, joined[:match.end()].strip()), clean_tail
                break
            prefix = " ".join(_MARKUP.sub("", joined, count=1).casefold().split())
            if not prefix or not normalized.startswith(prefix + " "):
                break
            last = parts[-1]
            remaining = normalized[len(prefix):].strip()
            below = [b for b in runs if b not in parts and b.top >= last.bottom
                     and b.top - last.bottom <= last.height
                     and abs(b.left - first.left) <= 2 * min(first.height, b.height)
                     and _matches_remaining(b.text, remaining)]
            if len(below) != 1:
                break
            parts.append(below[0])


def _collides(box, runs):
    return any(other != box and _overlap(box, other) > 0
               and min(box.right, other.right) > max(box.left, other.left) for other in runs)


def _is_caption(name, label, text):
    """Only distinguishable explicit image-alt text or callout proves a caption/callout role."""
    normalize=lambda value:" ".join(_MARKUP.sub("", value, count=1).split())
    label=normalize(label)
    captions=list(re.finditer(r"!\[([^\]\n]+)\]\(([^\n)]*)\)", text))
    if captions and label in {normalize(caption.group(1)) for caption in captions}:
        def in_caption(match, caption):
            if caption.start(1) <= match.start() and match.end() <= caption.end(1):
                return True
            return (caption.start(2) <= match.start() and match.end() <= caption.end(2)
                    and normalize(caption.group(2)).casefold() == normalize(caption.group(1)).casefold())
        if not any(normalize(match.group()) == label
                   and not any(in_caption(match, caption) for caption in captions)
                   for match in phrase_matches(name, text)):
            return True
    all_pm = phrase_matches(name, text)
    if len(all_pm) > 1:
        callout_matches = [m for m in all_pm if is_unpriced_callout(m, text)]
        real_matches = [m for m in all_pm if not is_unpriced_callout(m, text)]
        callout_labels = {normalize(m.group()) for m in callout_matches}
        real_labels = {normalize(m.group()) for m in real_matches}
        if label in callout_labels and label not in real_labels:
            return True
    return False

def _in_card_column(box, heading, scale):
    return (abs(box.left - heading.left) <= 2 * scale
            or (box.left >= heading.left and box.right <= heading.right))


def _card_price(name, text, dish_names, parts, heading, runs, prices):
    """A below-description price needs both a bounded text entry and column."""
    block=dish_block(name, text, dish_names)
    if not block or detached_prices(block):
        return None
    scale=max(part.height for part in parts)
    all_names = {*dish_names, name}
    boundaries=[other.top for other_name in all_names
                for _,other,_ in _headings(other_name, runs)
                if other.top >= heading.bottom
                and (_in_card_column(other, heading, scale)
                     or min(other.right, heading.right) > max(other.left, heading.left))]
    end=min(boundaries, default=math.inf)
    all_headings = {other: list(_headings(other, runs)) for other in all_names}
    heading_parts = {part for headings in all_headings.values() for p_parts, _, _ in headings for part in p_parts}
    all_below = [box for box in runs
                 if box not in heading_parts
                 and not _has_unit(box, runs)
                 and heading.bottom <= box.top < end
                 and _in_card_column(box, heading, scale)
                 and _source_price(box.text, text, ()) is not None]
    if len(all_below) != 1:
        return None
    box = all_below[0]
    matching_literals = [lit for b, lit in prices if b == box and lit is not None]
    if not matching_literals:
        return None
    literal = matching_literals[0]
    if _collides(box, runs) or not price_matches(literal, block):
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
    other_blocks=[dish_block(other, text, all_names) for other in all_names if other.casefold() != name.casefold()]
    own_block=dish_block(name, text, all_names)
    def _entry_source_price(raw_val):
        if len(all_names) > 1 and any(b and re.search(r"\d", b) for b in other_blocks) and re.search(r"\d", own_block):
            return _source_price(raw_val, own_block, ())
        return _source_price(raw_val, text, names)
    all_headings={other:list(_headings(other, runs)) for other in all_names}
    heading_parts={part for headings in all_headings.values() for parts,_,_ in headings for part in parts}
    prices = [(b, None if b in heading_parts or _has_unit(b, runs) else _entry_source_price(b.text)) for b in runs]
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
            literal = _entry_source_price(inline)
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
