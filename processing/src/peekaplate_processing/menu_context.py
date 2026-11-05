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
PRICE_SEPARATOR=r"(?:[ \t]*/[ \t]*|[ \t]+or[ \t]+)"
PRICE_GROUP=rf"(?<![\w.,]){PRICE_OPTION}(?:{PRICE_SEPARATOR}{PRICE_OPTION})+(?!\w|[.,]\d)"


def nonprice_unit(text, start, end):
    units=rf"(?:{_UNITS}\b|[%％])"
    preceding=rf"(?:\b{_UNITS}|[%％])"
    before=text[text.rfind("\n", 0, start)+1:start]
    if re.match(rf"[ \t]*{units}", text[end:], re.I) or re.search(rf"{preceding}[ \t]*:?[ \t]*$", before, re.I):
        return True
    marker=rf"(?:[$€£₱]|\b{CURRENCY_CODE}|\bP)"
    if re.search(rf"{marker}[ \t]*$", before, re.I) or re.match(rf"[ \t]*{marker}[ \t]*\d", text[start:end], re.I):
        return False
    after=r"[ \t]*(?:/[ \t]*\d+(?:\.\d+)?[ \t]*)*"
    prior=r"(?:\d+(?:\.\d+)?[ \t]*/[ \t]*)*"
    return bool(re.match(rf"{after}{units}", text[end:], re.I) or re.search(rf"{preceding}[ \t]*:?[ \t]*{prior}$", before, re.I))


TRAILING_TRADEMARK_WARNING="Trailing model trademark marker removed after literal source-name verification."


def verified_source_name(name, text):
    """Only remove a model-only trailing trademark from a literal source entry."""
    if phrase_matches(name, text):
        return name
    trimmed=name.rstrip()
    candidate=re.sub(r"(?:[ \t]*[®™])+$", "", trimmed)
    if candidate != trimmed and candidate:
        entries=entry_matches(candidate,text)
        if entries and not any(text[match.end():].lstrip().startswith(("®","™")) for match in entries):
            return candidate
    return name


def without_terminal_contact_footer(text):
    """Local boundary view only; never rewrite saved source text or offsets."""
    lines=[match for match in re.finditer(r"(?m)^[^\n]*(?:\n|$)", text) if match.group().strip()]
    if not lines:
        return text
    last=lines[-1]
    value=last.group().strip()
    heading=re.match(r"#{1,6}[ \t]+", value)
    if heading:
        value=value[heading.end():]
    label=re.match(r"(?:tel(?:ephone)?|phone|call|contact)(?:[ \t]*:)?[ \t]+", value, re.I)
    if label:
        value=value[label.end():]
    phone=r"(?:\+?1[ \t.-]+)?(?:\([0-9]{3}\)|[0-9]{3})[ \t.-]+[0-9]{3}[ \t.-]+[0-9]{4}"
    separated=bool(re.search(r"\n[ \t]*\n[ \t]*$", text[:last.start()]))
    if re.fullmatch(phone, value) and (label or heading and separated):
        return text[:last.start()]
    return text


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
    sep=r"(?:\s*/\s*|\s+or\s+)"
    prior=re.search(rf"({number})(?:[ \t]+[A-Z]{{3}})?{sep}$", before, re.I)
    if prior and not nonprice_unit(text, prior.start(1), prior.end(1)):
        return False
    # Signs may precede or follow a marker, including OCR-separated tokens.
    following=re.match(rf"(?:[ \t]+[A-Z]{{3}})?{sep}(?:[+\-−][ \t]*)?(?:{currency}[ \t]*)?({number})", after, re.I)
    if following:
        # Explicit money beside a directly labelled calorie/portion count is
        # separate evidence; an indirectly labelled option is still a partial list.
        end=match.end()+following.end(1)
        if not re.match(rf"[ \t]*(?:{_UNITS}\b|[%％])", text[end:], re.I):
            return False
    return True


def price_matches(value, text):
    """Match printed prices without the heading-markup rules used for names."""
    words=value.split()
    if not words:
        return []
    pattern=r"(?<!\w)"+r"\s+".join(re.escape(word) for word in words)+r"(?!\w)"
    return [match for match in re.finditer(pattern, text, re.I) if complete_price_match(match, text)]


def is_unpriced_callout(match, text):
    line_start = text.rfind("\n", 0, match.start()) + 1
    line_end = text.find("\n", match.end())
    if line_end == -1:
        line_end = len(text)
    if "![" in text[line_start:line_end]:
        return False
    rem = text[match.end():line_end].strip(" #*▼►•-")
    minor = {"with", "w/", "and", "or", "in", "of", "the", "a", "an", "is", "to", "for", "on", "at", "by", "from"}
    if rem:
        if any(c.isdigit() for c in rem) or "," in rem or any(w.islower() for w in rem.split() if w.lower() not in minor):
            return False
    lines = [line.strip() for line in text[line_end:].splitlines() if line.strip()]
    if not lines:
        return True
    first = lines[0]
    if first.startswith("#"):
        return True
    if "," in first or any(c.isdigit() for c in first):
        return False
    words = [w.strip(".,;:'\"") for w in first.split() if w.strip(".,;:'\"")]
    has_desc = any(w.islower() for w in words if w.lower() not in minor)
    if has_desc:
        return False
    return True


def entry_matches(name, text):
    captions = [m.span() for m in re.finditer(r"!\[[^\]\n]+\]\([^\n)]*\)", text)]
    entries=[]
    for match in phrase_matches(name, text):
        if any(start <= match.start() and match.end() <= end for start, end in captions):
            continue
        line_start=text.rfind("\n", 0, match.start())+1
        prefix=text[line_start:match.start()]
        # Repeated titles can share one flattened column line. Mentions on a
        # separate description/ingredient line are not automatically new entries.
        same_line=bool(entries and entries[-1].start() >= line_start)
        if (re.fullmatch(r"[ \t#*▼►•-]*", prefix) or same_line) and not text[match.end():].lstrip(" \t").startswith(","):
            entries.append(match)
    if len(entries) > 1:
        non_callouts = [m for m in entries if not is_unpriced_callout(m, text)]
        if len(non_callouts) == 1:
            return non_callouts
    return entries


def single_source_entry(name, text):
    """Repeated phrases compete even inside flattened column text."""
    entries=entry_matches(name, text)
    if len(entries) != 1:
        return False
    normalize=lambda value:" ".join(re.sub(r"^[ \t#*▼►•>-]*", "", value).split())
    entry=normalize(entries[0].group())
    captions=[match for match in re.finditer(r"!\[([^\]\n]+)\]\(([^\n)]*)\)", text)
              if normalize(match.group(1)) != entry]
    def in_caption(match, caption):
        if (caption.start(1) <= match.start() and match.end() <= caption.end(1)
                and normalize(match.group()) == normalize(caption.group(1))):
            return True
        return (caption.start(2) <= match.start() and match.end() <= caption.end(2)
                and normalize(caption.group(2)).casefold() == normalize(caption.group(1)).casefold()
                and normalize(match.group()) == normalize(caption.group(2)))
    occurrences=[match for match in phrase_matches(name, text)
                 if not any(in_caption(match, caption) for caption in captions)]
    if len(occurrences) > 1:
        non_callouts = [m for m in occurrences if not is_unpriced_callout(m, text)]
        if len(non_callouts) == 1:
            return True
    return len(occurrences) == 1

def dish_block(name, text, dish_names):
    entries=entry_matches(name, text)
    if not entries:
        return ""
    all_other_starts = []
    for other in dish_names:
        if other.casefold() == name.casefold():
            continue
        for match in entry_matches(other, text):
            all_other_starts.append(match.start())
    blocks = []
    for i, m in enumerate(entries):
        start = m.end()
        end = entries[i+1].start() if i + 1 < len(entries) else len(text)
        for ost in all_other_starts:
            if ost > start and ost < end:
                end = ost
        offset = start
        for line in text[start:end].splitlines(keepends=True):
            label = line.strip().strip("#*▼►•- ")
            heading = re.fullmatch(r"([A-Za-z][A-Za-z '&’\-]*?)(?:[ \t]+(?:[$€£₱]|PHP[ \t]*|P)?\d.*)?", label, re.I)
            lbl = heading.group(1) if heading else ""
            if re.sub(r"[\s\-−]+$", "", lbl).upper() in CURRENCY_CODES|{"P"}:
                lbl = ""
            words = lbl.split()
            if lbl and (lbl.istitle() or lbl.isupper() or (len(words) == 1 and lbl[0].isupper())):
                if not (lbl.lower().startswith("with ") or lbl in {"Grilled Chicken Breast", "Shrimp"} or lbl.lower().startswith("best paired with")):
                    end = offset
                    break
            offset += len(line)
        blocks.append(text[start:end])
    return "\n".join(b for b in blocks if b)


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
