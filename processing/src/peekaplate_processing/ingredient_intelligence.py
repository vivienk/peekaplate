"""AI-02: deterministic, evidence-bound suggestions; never approval or publication.

Only explicitly extracted ingredient phrases are considered. No recipe completion,
LLM calls, network requests, fuzzy matching or allergen-absence inference.
"""
import argparse
import hashlib
import json
import re
import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .errors import ExtractionError
from .schemas import MenuExtractionResult
from .storage import save_json

POLICY_VERSION = "ingredient-rules.1"
ALLERGENS = ("milk", "egg", "fish", "crustacean_shellfish", "tree_nut", "peanut", "wheat", "soy", "sesame")
FDA = "https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies"


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


# Small authored vocabulary, not a complete food database. Exact whole phrases only.
# Values: canonical name, possible allergen, vegan exclusion, vegetarian exclusion.
_GROUPS = (
    (("milk",), "milk", "milk", True, False),
    (("egg", "eggs"), "egg", "egg", True, False),
    (("shrimp", "shrimps", "prawn", "prawns"), "shrimp", "crustacean_shellfish", True, True),
    (("crab", "lobster"), None, "crustacean_shellfish", True, True),
    (("salmon", "tuna", "anchovy", "anchovies", "cod"), None, "fish", True, True),
    (("almond", "almonds", "walnut", "walnuts", "cashew", "cashews", "pecan", "pecans", "pistachio", "pistachios", "hazelnut", "hazelnuts"), None, "tree_nut", False, False),
    (("peanut", "peanuts", "groundnut", "groundnuts"), "peanut", "peanut", False, False),
    (("wheat", "wheat flour"), "wheat", "wheat", False, False),
    (("soybean", "soybeans", "soya", "soy"), "soybean", "soy", False, False),
    (("sesame", "sesame seeds"), "sesame", "sesame", False, False),
    (("beef", "pork", "chicken", "lamb"), None, None, True, True),
    (("honey",), "honey", None, True, False),
    (("tomato", "tomatoes"), "tomato", None, False, False),
    (("scallion", "scallions", "spring onion", "spring onions"), "spring onion", None, False, False),
    (("rice", "salt", "water", "garlic", "onion", "potato", "carrot", "spinach", "olive oil"), None, None, False, False),
)
RULES = {alias: (canonical or alias, allergen, vegan, vegetarian)
         for aliases, canonical, allergen, vegan, vegetarian in _GROUPS for alias in aliases}
# Conservatively abstain for qualifications anywhere in the cited context. Page-level
# extraction cannot safely associate a qualifier with one specific dish.
QUALIFIED = re.compile(r"\b(no|not|non|without|free|alternative|based|mock|optional|option|substitute|substitution|vegan|vegetarian|may|trace|traces|choice|choose|or|imitation|style|flavou?r(?:ed)?)\b", re.I)
COMPOUND_PREFIX = re.compile(r"\b(almond|oat|soy|soya|coconut|rice|pea|cashew|plant|peanut)\s+$", re.I)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class IngredientEvidence(StrictModel):
    source_id: str
    segment_id: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    text: str
    offset_unit: Literal["unicode_codepoint"] = "unicode_codepoint"
    association: Literal["unverified"] = "unverified"


class IngredientSuggestion(StrictModel):
    ingredient_index: int
    original: str
    normalized: str
    canonical: str | None
    status: Literal["needs_review", "unknown"]
    reason: Literal["exact_rule", "unrecognized_ingredient", "missing_evidence", "qualified_context"]
    rule_id: str | None
    evidence: list[IngredientEvidence]


class Classification(StrictModel):
    status: Literal["possible_presence", "possible_incompatible", "unknown"]
    ingredient_indices: list[int]
    rule_ids: list[str]


class IngredientAssessment(StrictModel):
    schema_version: Literal["ingredient-intelligence.v1"] = "ingredient-intelligence.v1"
    policy_version: Literal["ingredient-rules.1"] = POLICY_VERSION
    source_id: str | None
    source_sha256: str | None
    draft_id: str | None
    draft_index: int
    input_sha256: str
    status: Literal["needs_review", "unknown"]
    owner_confirmation_required: Literal[True] = True
    publishable: Literal[False] = False
    ingredients: list[IngredientSuggestion]
    allergens: dict[str, Classification]
    dietary: dict[str, Classification]
    warnings: list[str]
    references: list[str]


    @model_validator(mode="after")
    def validate_claims(self):
        if set(self.allergens) != set(ALLERGENS) or set(self.dietary) != {"vegan", "vegetarian", "gluten_free"}:
            raise ValueError("Unsupported classification vocabulary")
        for i, ingredient in enumerate(self.ingredients):
            matched = ingredient.reason == "exact_rule"
            if ingredient.ingredient_index != i or (ingredient.status == "needs_review") != matched:
                raise ValueError("Invalid ingredient status or index")
            if (ingredient.rule_id is not None) != matched or (matched and not ingredient.evidence):
                raise ValueError("Missing rule provenance")
            if (ingredient.reason == "missing_evidence") != (not ingredient.evidence):
                raise ValueError("Invalid evidence state")
            if any(e.source_id != self.source_id or e.end - e.start != len(e.text) for e in ingredient.evidence):
                raise ValueError("Invalid evidence span")
        if (self.status == "needs_review") != any(i.status == "needs_review" for i in self.ingredients):
            raise ValueError("Invalid assessment status")
        for group, positive in ((self.allergens, "possible_presence"), (self.dietary, "possible_incompatible")):
            for claim in group.values():
                if claim.status not in {positive, "unknown"} or (claim.status == "unknown") != (not claim.ingredient_indices):
                    raise ValueError("Invalid classification status")
                if len(claim.ingredient_indices) != len(claim.rule_ids) or len(set(claim.ingredient_indices)) != len(claim.ingredient_indices):
                    raise ValueError("Invalid classification references")
                for index, rule_id in zip(claim.ingredient_indices, claim.rule_ids):
                    if not 0 <= index < len(self.ingredients) or self.ingredients[index].rule_id != rule_id:
                        raise ValueError("Unsupported classification reference")
        return self


class IngredientReviewHandoff(StrictModel):
    schema_version: Literal["ingredient-review.v1"] = "ingredient-review.v1"
    policy_version: Literal["ingredient-rules.1"] = POLICY_VERSION
    owner_confirmation_required: Literal[True] = True
    publishable: Literal[False] = False
    assessments: list[IngredientAssessment]

    @model_validator(mode="after")
    def validate_order(self):
        if len(self.assessments) > 1000 or any(a.draft_index != i for i, a in enumerate(self.assessments)):
            raise ValueError("Invalid assessment ordering or count")
        return self


def _digest(report, index):
    # Bind all decision inputs, including absent, duplicate and invalid evidence.
    data = {"policy": POLICY_VERSION, "source": report.source.model_dump(mode="json", exclude={"snapshot_base64"}) if report.source else None,
            "draft_index": index, "draft": report.drafts[index].model_dump(mode="json"),
            "evidence": [e.model_dump(mode="json") for e in report.evidence],
            "segments": [s.model_dump(mode="json") for s in report.segments]}
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _context(report, index):
    draft = report.drafts[index]
    matches = [e for e in report.evidence if e.draft_index == index]
    if not report.source or report.source.source_id != draft.source_id or len(matches) != 1:
        return None, []
    evidence = matches[0]
    if sum(e.draft_id == evidence.draft_id for e in report.evidence) != 1:
        return None, []
    contexts = []
    for span in evidence.spans:
        segments = [s for s in report.segments if s.segment_id == span.segment_id]
        if len(segments) != 1:
            return evidence.draft_id, []
        segment = segments[0]
        if segment.status != "ready" or not 0 <= span.start < span.end <= len(segment.text):
            return evidence.draft_id, []
        text = segment.text[span.start:span.end]
        if text != draft.source_text:
            return evidence.draft_id, []
        contexts.append((span, text))
    return evidence.draft_id, contexts


def classify_draft(report: MenuExtractionResult, index: int) -> IngredientAssessment:
    draft = report.drafts[index]
    draft_id, contexts = _context(report, index)
    ingredients = []
    allergens = {name: Classification(status="unknown", ingredient_indices=[], rule_ids=[]) for name in ALLERGENS}
    dietary = {name: Classification(status="unknown", ingredient_indices=[], rule_ids=[]) for name in ("vegan", "vegetarian", "gluten_free")}
    for i, original in enumerate(draft.ingredients or []):
        normalized = normalize(original)
        rule = RULES.get(normalized)
        evidence = []
        qualified = False
        # Search original text, never normalized offsets (casefold/NFKC change lengths).
        pattern = re.compile(r"(?<![\w-])" + r"\s+".join(re.escape(w) for w in original.strip().split()) + r"(?![\w-])", re.I)
        for span, text in contexts:
            for match in pattern.finditer(text):
                if len(match.group()) > 256:
                    continue
                qualified |= bool(QUALIFIED.search(text) or COMPOUND_PREFIX.search(text[:match.start()]) or re.match(r"\s*[- ]free\b", text[match.end():], re.I))
                evidence.append(IngredientEvidence(source_id=draft.source_id, segment_id=span.segment_id,
                    start=span.start + match.start(), end=span.start + match.end(), text=match.group()))
                if len(evidence) == 8:
                    break
            if len(evidence) == 8:
                break
        reason = "missing_evidence" if not evidence else "qualified_context" if qualified else "unrecognized_ingredient" if rule is None else "exact_rule"
        rule_id = f"{POLICY_VERSION}:{rule[0]}" if reason == "exact_rule" else None
        ingredients.append(IngredientSuggestion(ingredient_index=i, original=original, normalized=normalized,
            canonical=rule[0] if rule else None, status="needs_review" if reason == "exact_rule" else "unknown",
            reason=reason, rule_id=rule_id, evidence=evidence))
        if reason != "exact_rule":
            continue
        canonical, allergen, vegan, vegetarian = rule
        targets = ([(allergens[allergen], "possible_presence")] if allergen else [])
        targets += [(dietary[key], "possible_incompatible") for key, excluded in (("vegan", vegan), ("vegetarian", vegetarian), ("gluten_free", allergen == "wheat")) if excluded]
        for target, status in targets:
            target.status = status
            target.ingredient_indices.append(i)
            target.rule_ids.append(rule_id)
    return IngredientAssessment(source_id=report.source.source_id if report.source else None,
        source_sha256=report.source.sha256 if report.source else None, draft_id=draft_id, draft_index=index,
        input_sha256=_digest(report, index), status="needs_review" if any(i.status == "needs_review" for i in ingredients) else "unknown",
        ingredients=ingredients, allergens=allergens, dietary=dietary,
        warnings=["Source presence does not verify dish association or recipe completeness.",
                  "Unknown does not mean absent, allergen-free or suitable for a diet.",
                  "Owner must confirm ingredients, substitutions, preparation and cross-contact before publication."],
        references=[FDA])


def build_review_handoff(report: MenuExtractionResult) -> IngredientReviewHandoff:
    # Revalidate mutable upstream models rather than trusting model_copy updates.
    report = MenuExtractionResult.model_validate(report.model_dump(mode="json"))
    if len(report.drafts) > 1000 or len(report.segments) > 1000 or sum(len(s.text) for s in report.segments) > 100_000:
        raise ExtractionError("Ingredient input exceeds processing limits.")
    ids = ([report.source.source_id] if report.source else []) + [s.segment_id for s in report.segments] + [e.draft_id for e in report.evidence]
    if any(len(identifier) > 256 for identifier in ids):
        raise ExtractionError("Ingredient identity exceeds contract limits.")
    if any(len(d.ingredients or []) > 100 or any(max(len(i), len(normalize(i))) > 256 for i in d.ingredients or []) for d in report.drafts):
        raise ExtractionError("Ingredient input exceeds processing limits.")
    return IngredientReviewHandoff(assessments=[classify_draft(report, i) for i in range(len(report.drafts))])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build review-only ingredient suggestions from saved VIS-02 extraction; offline, no model calls.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        with open(args.input, "rb") as handle:
            data = handle.read(20_000_001)
        if len(data) > 20_000_000:
            raise ExtractionError("Ingredient input exceeds file limit.")
        report = MenuExtractionResult.model_validate_json(data)
        save_json(build_review_handoff(report).model_dump(mode="json"), args.output)
    except (ValueError, OSError, ExtractionError):
        parser.exit(1, "Ingredient analysis failed; check input schema, limits and a new output path. No approval was created.\n")
    print("Saved review-only ingredient suggestions. Owner confirmation is required.")


if __name__ == "__main__":
    main()
