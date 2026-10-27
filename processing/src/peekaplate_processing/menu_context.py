"""Source matching and ordered section context; never modify original OCR text."""
import re


def nonprice_unit(text, start, end):
    units=r"(?:kcal|calories|cals?|pcs?|pieces?|servings?|grams?|kg|g|ml|oz)"
    before=text[text.rfind("\n", 0, start)+1:start]
    if re.match(rf"[ \t]*{units}\b", text[end:], re.I) or re.search(rf"\b{units}[ \t]*:?[ \t]*$", before, re.I):
        return True
    marker=r"(?:[$€£₱]|\bPHP|\bP)"
    if re.search(rf"{marker}[ \t]*$", before, re.I) or re.match(rf"[ \t]*{marker}[ \t]*\d", text[start:end], re.I):
        return False
    after=r"[ \t]*(?:/[ \t]*\d+(?:\.\d+)?[ \t]*)*"
    prior=r"(?:\d+(?:\.\d+)?[ \t]*/[ \t]*)*"
    return bool(re.match(rf"{after}{units}\b", text[end:], re.I) or re.search(rf"\b{units}[ \t]*:?[ \t]*{prior}$", before, re.I))


def phrase_matches(value, text):
    words=value.split()
    if not words:
        return []
    separator=r"(?:\s|(?m:^[ \t]*[#>*▼►•]+[ \t]*))+"
    pattern=r"(?<!\w)"+separator.join(re.escape(word) for word in words)+r"(?!\w)"
    return list(re.finditer(pattern, text, re.I))


def entry_matches(name, text):
    entries=[]
    for match in phrase_matches(name, text):
        prefix=text[text.rfind("\n", 0, match.start())+1:match.start()]
        # A repeated name in an ingredient list is not a new menu entry.
        if re.fullmatch(r"[ \t#*▼►•-]*", prefix) and not text[match.end():].lstrip(" \t").startswith(","):
            entries.append(match)
    return entries


def dish_block(name, text, dish_names):
    entries=entry_matches(name, text)
    if not entries:
        return ""
    # Numbers in the dish name are not price evidence.
    start=entries[-1].end()
    end=len(text)
    for other in dish_names:
        if other.casefold() == name.casefold():
            continue
        for match in entry_matches(other, text):
            if match.start() > start:
                end=min(end, match.start())
    # Stop at a possible entry omitted by the model; ambiguous blocks stay unknown.
    offset=entries[-1].end()
    for line in text[offset:end].splitlines(keepends=True):
        label=line.strip().strip("#*▼►•- ")
        heading=re.fullmatch(r"([A-Za-z][A-Za-z '&’\-]*?)(?:[ \t]+(?:[$€£₱]|PHP[ \t]*|P)?\d.*)?", label, re.I)
        label=heading.group(1) if heading else ""
        if label.upper() in {"PHP", "P"}:
            label=""
        words=label.split()
        if label and (label.istitle() or label.isupper() or len(words) == 1):
            end=offset
            break
        offset+=len(line)
    return text[start:end]


def detached_prices(block):
    """Several standalone price lines do not identify the final entry's price."""
    price=r"(?:[$€£₱]|PHP[ \t]*|P)?[ \t]*\d+(?:\.\d+)?(?:[ \t]*/[ \t]*\d+(?:\.\d+)?)*(?:[ \t]+[A-Z]{3})?"
    groups=[]
    for line in block.splitlines():
        value=line.strip()
        if re.fullmatch(price, value, re.I):
            numbers=list(re.finditer(r"\d+(?:\.\d+)?", value))
            if all(not nonprice_unit(value, match.start(), match.end()) for match in numbers):
                groups.append(value)
    return len(groups) > 1


def apply_sections(dishes, sections, pages):
    """Inherit only when the extraction explicitly marks a contiguous continuation."""
    by_page={section["page_number"]:section for section in sections}
    active=None
    previous_page=None
    warnings=[]
    for page in sorted(pages, key=lambda value:value["page_number"]):
        number=page["page_number"]
        if previous_page is None or number != previous_page+1 or not page["text"].strip():
            active=None
        previous_page=number
        section=by_page.get(number)
        if not page["text"].strip() or section is None:
            active=None
            continue
        category=section["category"]
        if category is not None:
            if phrase_matches(category, page["text"]):
                active=(category, number)
            else:
                active=None
                warnings.append(f"Page {number}: unsupported section category; continuation context cleared.")
        elif not section["continues_previous"]:
            active=None
        page_dishes=[dish for dish in dishes if dish["page_number"] == number]
        roots={" ".join(dish["category"].casefold().split()) for dish in page_dishes if dish["category"] is not None}
        if active is not None:
            roots.add(" ".join(active[0].casefold().split()))
        if len(roots) > 1:
            active=None
            warnings.append(f"Page {number}: multiple main categories; automatic continuation cleared.")
        for dish in page_dishes:
            if dish["category"] is not None:
                dish["category_page_number"]=number
            elif active is not None:
                dish["category"],dish["category_page_number"]=active
                if active[1] != number:
                    dish.setdefault("review_warnings", []).append(
                        f"Category inherited from page {active[1]}; verify section continuation."
                    )
            if dish.get("subcategory") and " ".join(dish["subcategory"].casefold().split()) == " ".join((dish["category"] or "").casefold().split()):
                dish["subcategory"]=None
                dish.setdefault("review_warnings", []).append("Subcategory repeats the main category after section context; cleared to null.")
            if dish.get("subcategory") and dish["category"] is None:
                dish.setdefault("review_warnings", []).append("Subcategory has no supported parent; review hierarchy.")
    return warnings
