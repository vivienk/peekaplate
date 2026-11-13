"""Private ingredient artwork proposals. Never ingredient approval or publication.

Consumes the existing evidence-bound AI-02 producer; no OCR/model calls. The
local catalogue is operator-owned, not an authorization boundary for HTTP users.
"""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path
from typing import Literal

from PIL import Image
from pydantic import Field

from .errors import ExtractionError
from .ingredient_intelligence import StrictModel, build_review_handoff, normalize
from .review_candidates import prepare_review_candidates
from .schemas import MenuExtractionResult
from .storage import save_json

STYLE_VERSION = "figma-149-2169.v1"
MAPPING_VERSION = "ingredient-icons.2"
# Observed component variant names. These are artwork identities, not food rules.
LABELS = ("Ham", "Poached egg", "Hollandaise", "Chives", "Avocado", "Cherry tomato",
          "Chili flakes", "Microgreens", "Mixed greens", "Wild rice", "Grilled chicken",
          "Sweet potato", "Kale", "Brussels sprouts", "Feta", "Apple", "Toasted nuts",
          "Lemon dressing", "Cucumber", "Radish", "Blue cheese", "Pumpkin seeds",
          "Red onion", "Sushi rice", "Salmon", "Edamame", "Carrot", "Pickled ginger",
          "Nori", "Sesame", "House Sauce", "Muffin")
VOCABULARY = {normalize(label): normalize(label).replace(" ", "-") for label in LABELS}
# Deliberately small: no ingredient subtype, recipe or preparation inference.
ALIASES = {"sesame seeds": "sesame", "carrots": "carrot", "avocados": "avocado",
           "cherry tomatoes": "cherry tomato"}


def ingredient_identity(text):
    """Artwork identity only: unknown explicit names need not be food-rule entries."""
    term = ALIASES.get(normalize(text), normalize(text))
    if not term or len(term) > 120 or any(not (c.isalpha() or c in " '-") for c in term):
        return None
    return VOCABULARY.get(term, "ingredient-" + hashlib.sha256(term.encode()).hexdigest()[:32])


def valid_ingredient_id(value):
    return value in VOCABULARY.values() or bool(re.fullmatch(r"ingredient-[0-9a-f]{32}", value))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class IconAsset(StrictModel):
    schema_version: Literal["ingredient-icon-asset.v1"] = "ingredient-icon-asset.v1"
    ingredient_id: str
    style_version: Literal["figma-149-2169.v1"] = STYLE_VERSION
    asset_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(gt=0, le=1_000_000)
    width: int = Field(ge=16, le=2048)
    height: int = Field(ge=16, le=2048)
    origin: Literal["curated", "generated"]
    provenance: str = Field(min_length=1, max_length=1000)
    rights_confirmed: Literal[True]
    # Generated art must retain the exact provider/model/prompt provenance here.
    recipe: str = Field(min_length=1, max_length=4000)


class IconDecision(StrictModel):
    schema_version: Literal["ingredient-icon-decision.v1"] = "ingredient-icon-decision.v1"
    asset_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: Literal["approved", "rejected"]
    reviewer: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=1000)


class IconStore:
    """Create-only content-addressed files in a trusted private local directory.

    Decisions are final for an asset version; a changed recipe produces a new
    version. This offline store is not a hosted revocation/approval service.
    """
    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, kind, key):
        if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
            raise ValueError("Invalid content key")
        return self.root / kind / (key + ".json")

    def _read(self, kind, key):
        with self._path(kind, key).open("rb") as handle:
            raw = handle.read(1_500_001)
        if len(raw) > 1_500_000:
            raise ValueError("Oversized catalogue record")
        try:
            return json.loads(raw)
        except RecursionError:
            raise ValueError("Catalogue record is too deeply nested") from None

    def _put(self, kind, key, value):
        path = self._path(kind, key)
        try:
            save_json(value, path)
        except ExtractionError:
            # Concurrent identical writers may share a result; conflicts fail closed.
            if not path.exists() or self._read(kind, key) != value:
                raise

    def register(self, data: bytes, *, ingredient_id: str, origin: str,
                 provenance: str, recipe: str, rights_confirmed: bool) -> str:
        """Import curated exports or provider output; registration never approves."""
        import base64
        if not valid_ingredient_id(ingredient_id) or not 0 < len(data) <= 1_000_000:
            raise ValueError("Unsupported ingredient or asset size")
        with Image.open(io.BytesIO(data)) as picture:
            if (picture.format not in {"PNG", "WEBP"} or picture.width != picture.height
                    or not 16 <= picture.width <= 2048 or getattr(picture, "n_frames", 1) != 1):
                raise ValueError("Expected a bounded square PNG/WebP")
            picture.load()
            rgba = picture.convert("RGBA")
            alpha = rgba.getchannel("A")
            if alpha.getextrema()[0] != 0 or alpha.getextrema()[1] == 0:
                raise ValueError("Artwork must have transparency and visible content")
            if any(rgba.getpixel(point)[3] != 0 for point in
                   ((0, 0), (0, picture.height-1), (picture.width-1, 0), (picture.width-1, picture.height-1))):
                raise ValueError("Artwork corners must be transparent")
            asset = IconAsset(ingredient_id=ingredient_id, asset_sha256=hashlib.sha256(data).hexdigest(),
                              size_bytes=len(data), width=picture.width, height=picture.height,
                              origin=origin, provenance=provenance, recipe=recipe,
                              rights_confirmed=rights_confirmed)
        record = asset.model_dump(mode="json")
        key = digest(record)
        self._put("blobs", asset.asset_sha256, {"base64": base64.b64encode(data).decode("ascii")})
        self._put("assets", key, record)
        return key

    def asset(self, key):
        import base64
        raw = self._read("assets", key)
        asset = IconAsset.model_validate(raw)
        if digest(raw) != key or not valid_ingredient_id(asset.ingredient_id):
            raise ValueError("Asset identity mismatch")
        blob = self._read("blobs", asset.asset_sha256)
        data = base64.b64decode(blob["base64"], validate=True)
        if len(data) != asset.size_bytes or hashlib.sha256(data).hexdigest() != asset.asset_sha256:
            raise ValueError("Asset bytes mismatch")
        return asset

    def review(self, key, *, status, reviewer, reason):
        self.asset(key)
        decision = IconDecision(asset_id=key, status=status, reviewer=reviewer, reason=reason)
        if not reviewer.strip() or not reason.strip():
            raise ValueError("Reviewer and reason cannot be blank")
        self._put("decisions", key, decision.model_dump(mode="json"))

    def resolve(self, key, ingredient_id):
        """Only reviewed artwork can be proposed; missing/corrupt art becomes text."""
        try:
            asset = self.asset(key)
            decision = IconDecision.model_validate(self._read("decisions", key))
            if (decision.asset_id == key and decision.status == "approved"
                    and asset.ingredient_id == ingredient_id):
                return {"asset_id": key, "sha256": asset.asset_sha256,
                        "style_version": asset.style_version, "origin": asset.origin}
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None


def build_icon_handoff(report: MenuExtractionResult, *, store=None, selections=None):
    """Python API: reuse validated extraction and unchanged ingredient intelligence.

    Selections map canonical artwork IDs to exact immutable asset versions. Never
    select a file by directory order or treat asset approval as recipe approval.
    """
    report = MenuExtractionResult.model_validate(report.model_dump(mode="json"))
    # Enforces source snapshot hash and existing candidate/evidence reconstruction.
    prepare_review_candidates(report)
    review = build_review_handoff(report)
    selections = selections or {}
    if not isinstance(selections, dict) or len(selections) > 1000:
        raise ValueError("Invalid icon selections")
    if any(not valid_ingredient_id(k) or not isinstance(v, str) for k, v in selections.items()):
        raise ValueError("Unknown selected ingredient")
    dishes = []
    for assessment in review.assessments:
        entries = []
        for ingredient in assessment.ingredients:
            term = ALIASES.get(ingredient.normalized, ingredient.normalized)
            canonical = ingredient_identity(term)
            eligible = bool(canonical and ingredient.evidence and
                            ingredient.reason not in {"missing_evidence", "qualified_context"})
            art = store.resolve(selections[canonical], canonical) if (
                eligible and store is not None and canonical in selections) else None
            entries.append({"ingredient_index": ingredient.ingredient_index,
                            "original": ingredient.original, "normalized": ingredient.normalized,
                            "ingredient_id": canonical if eligible else None,
                            "evidence": [e.model_dump(mode="json") for e in ingredient.evidence],
                            "grounding_reason": ingredient.reason,
                            "status": "needs_review", "icon": art,
                            "fallback": "text" if art is None else None,
                            "reason": "reviewed_artwork" if art else "artwork_unavailable" if eligible else "unresolved_ingredient"})
        dishes.append({"draft_id": assessment.draft_id, "draft_index": assessment.draft_index,
                       "input_sha256": assessment.input_sha256, "ingredients": entries,
                       "ingredients_state": "unknown" if not entries else "needs_review"})
    result = {"schema_version": "ingredient-icons.v1", "mapping_version": MAPPING_VERSION,
              "style_version": STYLE_VERSION, "source_id": review.assessments[0].source_id if review.assessments else report.source.source_id,
              "source_sha256": report.source.sha256, "extraction_status": report.status,
              "status": "needs_review", "owner_confirmation_required": True,
              "publishable": False, "dishes": dishes}
    # Includes source/draft evidence digests and resolved asset versions. Rebuild on
    # every read; a cached file never supplies authority or masks a missing asset.
    return {**result, "cache_key": digest(result)}


def export_icons(input_path, output_path, *, store=None, selections=None):
    with Path(input_path).open("rb") as handle:
        raw = handle.read(20_000_001)
    if len(raw) > 20_000_000:
        raise ValueError("Input exceeds 20 MB")
    result = build_icon_handoff(MenuExtractionResult.model_validate_json(raw),
                                store=store, selections=selections)
    save_json(result, output_path)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--catalogue", type=Path)
    parser.add_argument("--selections", type=Path)
    args = parser.parse_args(argv)
    try:
        selections = None
        if args.selections:
            with args.selections.open("rb") as handle:
                raw = handle.read(16_001)
            if len(raw) > 16_000:
                raise ValueError("Oversized selections")
            selections = json.loads(raw)
        export_icons(args.input, args.output,
                     store=IconStore(args.catalogue) if args.catalogue else None,
                     selections=selections)
    except (ValueError, OSError, ExtractionError, TypeError, RecursionError):
        parser.exit(1, "Icon preparation failed; check input, catalogue and a new output path.\n")
    print("Saved private ingredient icon proposals; owner review is still required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
