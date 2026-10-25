"""Keep OCR.space word boxes as approximate evidence, never food facts."""

import math


def extract_regions(page):
    overlay = page.get("TextOverlay")
    if not isinstance(overlay, dict) or overlay.get("HasOverlay") is not True:
        return {"regions": [], "region_status": "unavailable"}
    lines = overlay.get("Lines")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 10_000:
        return {"regions": [], "region_status": "invalid"}
    regions = []
    for line in lines:
        words = line.get("Words") if isinstance(line, dict) else None
        if not isinstance(words, list):
            return {"regions": [], "region_status": "invalid"}
        for word in words:
            if not isinstance(word, dict):
                return {"regions": [], "region_status": "invalid"}
            text = word.get("WordText")
            box = [word.get(key) for key in ("Left", "Top", "Width", "Height")]
            if not isinstance(text, str) or not text.strip() or len(text) > 1000 or "\0" in text:
                return {"regions": [], "region_status": "invalid"}
            if any(type(value) not in (int, float) or value < 0 or value > 100_000 or not math.isfinite(value) for value in box) or not box[2] or not box[3]:
                return {"regions": [], "region_status": "invalid"}
            regions.append({"text": text, "left": box[0], "top": box[1], "width": box[2], "height": box[3]})
            if len(regions) > 10_000:
                return {"regions": [], "region_status": "invalid"}
    return {"regions": regions, "region_status": "available" if regions else "unavailable"}
