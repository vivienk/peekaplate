"""Source matching and ordered section context; never modify original OCR text."""
import re


_UNITS = r"(?:kcal|calories|cals?|pcs?|pieces?|servings?|grams?|kg|g|ml|oz)"
# Recognition for automatic recovery, not an exhaustive ISO registry or a way to
# infer currency. Unknown alphabetic labels must remain competing headings.
CURRENCY_CODES=frozenset("AED AUD BRL CAD CHF CNY EUR GBP HKD IDR INR JPY KRW MXN MYR NZD PHP SAR SGD THB USD VND ZAR".split())
CURRENCY_CODE="(?:"+"|".join(sorted(CURRENCY_CODES))+")"
MONEY_MARKER=rf"(?:[$€£₱]|{CURRENCY_CODE}|P)"
PRICE_NUMBER=r"\d+(?:\.\d+)?"
PRICE_OPTION=rf"(?:{MONEY_MARKER}[ \t]*)?{PRICE_NUMBER}(?:[ \t]+{CURRENCY_CODE})?"
PRICE_GROUP=rf"(?<![\w.,]){PRICE_OPTION}(?:[ \t]*/[ \t]*{PRICE_OPTION})+(?!\w|[.,]\d)"


def nonprice_unit(text, start, end):
    units=_UNITS
    before=text[text.rfind("\n", 0, start)+1:start]
    if re.match(rf"[ \t]*{units}\b", text[end:], re.I) or re.search(rf"\b{units}[ \t]*:?[ \t]*$", before, re.I):
        return True
    marker=rf"(?:[$€£₱]|\b{CURRENCY_CODE}|\bP)"
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


def complete_price_match(match, text):
    """Price evidence must not be a numeric fragment or part of a slash group."""
    before,after=text[:match.start()],text[match.end():]
    # Compact recognized codes use the same marker grammar as recovery. Unknown
    # uppercase codes can block completeness, but cannot bootstrap a price.
    currency=rf"(?:{MONEY_MARKER}|\b(?-i:[A-Z]{{3}}))"
    # A source marker outside the supplied literal must not hide a sign or slash.
    before=re.sub(rf"{currency}[ \t]*\Z", "", before, flags=re.I)
    if re.search(r"[\w.,+\-−]\Z|[+\-−][ \t]*\Z", before) or re.match(r"\w|[.,]\d", after):
        return False
    # Include malformed/signed neighbors when checking completeness, not as new
    # supported price formats. Never salvage a suffix of an unsupported group.
    number=r"[+\-−]?[ \t]*[.,]?\d+(?:[.,]\d+)*"
    prior=re.search(rf"({number})(?:[ \t]+[A-Z]{{3}})?\s*/\s*$", before, re.I)
    if prior and not nonprice_unit(text, prior.start(1), prior.end(1)):
        return False
    # Signs may precede or follow a marker, including OCR-separated tokens.
    following=re.match(rf"(?:[ \t]+[A-Z]{{3}})?\s*/\s*(?:[+\-−][ \t]*)?(?:{currency}[ \t]*)?({number})", after, re.I)
    if following:
        # Explicit money beside a directly labelled calorie/portion count is
        # separate evidence; an indirectly labelled option is still a partial list.
        end=match.end()+following.end(1)
        if not re.match(rf"[ \t]*{_UNITS}\b", text[end:], re.I):
            return False
    return True


def price_matches(value, text):
    """Match printed prices without the heading-markup rules used for names."""
    words=value.split()
    if not words:
        return []
    pattern=r"(?<!\w)"+r"\s+".join(re.escape(word) for word in words)+r"(?!\w)"
    return [match for match in re.finditer(pattern, text, re.I) if complete_price_match(match, text)]


def entry_matches(name, text):
    entries=[]
    for match in phrase_matches(name, text):
        line_start=text.rfind("\n", 0, match.start())+1
        prefix=text[line_start:match.start()]
        # Repeated titles can share one flattened column line. Mentions on a
        # separate description/ingredient line are not automatically new entries.
        same_line=bool(entries and entries[-1].start() >= line_start)
        if (re.fullmatch(r"[ \t#*▼►•-]*", prefix) or same_line) and not text[match.end():].lstrip(" \t").startswith(","):
            entries.append(match)
    return entries


def single_source_entry(name, text):
    """Repeated phrases compete even inside flattened column text."""
    entries=entry_matches(name, text)
    if len(entries) != 1:
        return False
    normalize=lambda value:" ".join(re.sub(r"^[ \t#*▼►•>-]*", "", value).split())
    entry=normalize(entries[0].group())
    captions=[match for match in re.finditer(r"!\[([^\]\n]+)\]\([^\n)]*\)", text)
              if normalize(match.group(1)) != entry]
    occurrences=[match for match in phrase_matches(name, text)
                 if not any(caption.start(1) <= match.start() and match.end() <= caption.end(1)
                            and normalize(match.group()) == normalize(caption.group(1))
                            for caption in captions)]
    return len(occurrences) == 1


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
        if re.sub(r"[\s\-−]+$", "", label).upper() in CURRENCY_CODES|{"P"}:
            label=""
        words=label.split()
        if label and (label.istitle() or label.isupper() or len(words) == 1):
            end=offset
            break
        offset+=len(line)
    return text[start:end]


def detached_prices(block):
    """Several standalone price lines do not identify the final entry's price."""
    price=rf"{PRICE_OPTION}(?:[ \t]*/[ \t]*{PRICE_OPTION})*"
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
