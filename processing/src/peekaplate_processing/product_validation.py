"""Conservative product and price checks shared by text and vision extraction."""
import re

from .menu_context import PRICE_OPTION, nonprice_unit


MINIMUM_PRICE_WARNING = "Minimum or qualified price; exact price remains unknown and requires human review."
NON_FOOD_ERROR = "Non-food wrapping cloth is not a dish; excluded from dish drafts."
_WRAPPING_CLOTH = re.compile(r"(?:furoshiki(?: wrapping(?: cloth)?)?|wrapping cloth)", re.I)
_PLUS_PRICE = re.compile(rf"(?<![\w.,+\-]){PRICE_OPTION}[ \t]*\+(?!\d)", re.I)


def is_wrapping_cloth(name: str) -> bool:
    # Match an explicit product title, never a page/description mention or the
    # generic food word "wrap". This is not a general merchandise classifier.
    return _WRAPPING_CLOTH.fullmatch(" ".join(name.split())) is not None


def minimum_price_literals(text: str | None) -> list[str]:
    """Retain printed plus-qualified amounts without interpreting them as fixed prices."""
    return list(dict.fromkeys(
        match.group() for match in _PLUS_PRICE.finditer(text or "")
        if not nonprice_unit(text, match.start(), match.end())
    ))
