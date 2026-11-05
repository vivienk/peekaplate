"""Image preflight before any OCR or model request.

Agreed VIS-02 handling (Zhiliang): images skewed more than 15 degrees or with very low
contrast are rejected before extraction; 10-15 degrees is review-only. Estimates use Pillow
only and are approximate: they gate obviously unusable inputs, not certify good ones.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

from PIL import Image, ImageOps

MAX_SKEW_DEGREES = 15.0
REVIEW_SKEW_DEGREES = 10.0
MIN_CONTRAST_SPREAD = 60  # luminance gap between the 2nd and 98th percentile, 0-255 scale
_WORK_SIZE = 600
_SEARCH_DEGREES = 25


@dataclass
class Preflight:
    skew_degrees: float
    sideways: bool
    contrast_spread: int
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def rejected(self) -> bool:
        return bool(self.errors)

    def metadata(self) -> dict:
        return {"skew_degrees": self.skew_degrees, "sideways": self.sideways, "contrast_spread": self.contrast_spread}


def _percentile(histogram: list[int], fraction: float) -> int:
    target = sum(histogram) * fraction
    running = 0
    for value, count in enumerate(histogram):
        running += count
        if running >= target:
            return value
    return 255


def _line_score(ink: Image.Image, angle: float) -> float:
    """Sharpness of the horizontal ink profile after rotating by `angle`; text lines peak when level."""
    rotated = ink.rotate(angle, resample=Image.Resampling.BILINEAR, expand=True, fillcolor=0)
    rows = list(rotated.resize((1, rotated.height), Image.Resampling.BOX).getdata())
    return float(sum((rows[i + 1] - rows[i]) ** 2 for i in range(len(rows) - 1)))


def _best_angle(ink: Image.Image) -> tuple[float, float]:
    coarse = max(range(-_SEARCH_DEGREES, _SEARCH_DEGREES + 1, 2), key=lambda a: _line_score(ink, a))
    fine = [coarse + step / 2 for step in range(-4, 5)]
    best = max(fine, key=lambda a: _line_score(ink, a))
    return best, _line_score(ink, best)


def assess_image(data: bytes) -> Preflight:
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("L")
    image.thumbnail((_WORK_SIZE, _WORK_SIZE))
    histogram = image.histogram()
    low, high = _percentile(histogram, 0.02), _percentile(histogram, 0.98)
    spread = high - low
    threshold = (low + high) // 2
    ink = image.point(lambda value: 255 if value < threshold else 0)

    upright_angle, upright_score = _best_angle(ink)
    _, sideways_score = _best_angle(ink.rotate(90, expand=True))
    # Calibrated on upright menus (ratio <= 0.76) vs. 90-degree rotations (ratio >= 1.31).
    sideways = sideways_score > upright_score
    result = Preflight(skew_degrees=round(-upright_angle, 1) + 0.0, sideways=sideways, contrast_spread=spread)

    if spread < MIN_CONTRAST_SPREAD:
        result.errors.append(f"Image contrast is too low for reliable reading (spread {spread} < {MIN_CONTRAST_SPREAD}); provide a clearer photo.")
    if sideways:
        result.errors.append("Image appears rotated sideways; provide an upright photo.")
    elif abs(result.skew_degrees) > MAX_SKEW_DEGREES:
        result.errors.append(f"Image is skewed about {abs(result.skew_degrees):g} degrees (> {MAX_SKEW_DEGREES:g}); provide a straighter photo.")
    elif abs(result.skew_degrees) > REVIEW_SKEW_DEGREES:
        result.warnings.append(f"Image is skewed about {abs(result.skew_degrees):g} degrees; prices are review-only for 10-15 degrees.")
    return result
