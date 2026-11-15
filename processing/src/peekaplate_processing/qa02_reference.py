"""Offline integrity checks for QA-02 references; never a model-quality scorer."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import pymupdf
from pydantic import BaseModel, ConfigDict, Field, model_validator

Text = Annotated[str, Field(min_length=1)]
Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Amount = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$")]


class ReferenceValidationError(ValueError):
    """Only developer-authored, non-sensitive validation reasons."""


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class PriceOption(Record):
    label: Text | None
    amount: Amount


class Entry(Record):
    entry_id: Text
    page: Annotated[int, Field(ge=1)]
    section: Text
    location: Text
    role: Literal["dish", "qualifier"]
    name: Text | None
    description: Text | None
    price_text: Text | None
    price_amount: Amount | None
    scalar_null_reason: Text | None
    ordered_price_options: list[PriceOption]
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")] | None

    @model_validator(mode="after")
    def price_shape(self):
        options = self.ordered_price_options
        if len(options) > 1 and self.price_amount is not None:
            raise ReferenceValidationError("multi-price reference must retain a null scalar")
        if len(options) == 1 and self.price_amount is None and not self.scalar_null_reason:
            raise ReferenceValidationError("one printed price needs a scalar or an explicit null reason")
        if self.price_amount is not None and [option.amount for option in options] != [self.price_amount]:
            raise ReferenceValidationError("single scalar must match its printed option")
        if self.price_text is None and (options or self.price_amount is not None):
            raise ReferenceValidationError("numeric price requires literal source price text")
        return self


class PageExclusion(Record):
    page: Annotated[int, Field(ge=1)]
    reason: Text


class Review(Record):
    status: Literal["pending", "recorded"]
    reviewer: Text | None
    decision_reference: Text | None


class Reference(Record):
    schema_version: Literal["qa02.reference.v1"]
    reference_version: Text
    authored_by: Text
    annotation_method: Literal["source_only"]
    review: Review
    entries: Annotated[list[Entry], Field(min_length=1)]
    excluded_pages: list[PageExclusion]


class Case(Record):
    case_id: Text
    split: Literal["development", "supplemental", "holdout"]
    source_path: Text
    source_sha256: Hash
    original_source_sha256: Hash
    page_count: Annotated[int, Field(ge=1)]
    previously_inspected: bool
    source_permission: Text
    reference_path: Text
    reference_sha256: Hash
    reference_version: Text


class Manifest(Record):
    schema_version: Literal["qa02.manifest.v1"]
    dataset_version: Text
    frozen_at: Text
    cases: Annotated[list[Case], Field(min_length=1)]


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def read_json(path: Path):
    with path.open("rb") as handle:
        raw = handle.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ReferenceValidationError("QA-02 JSON exceeds the 2 MB limit")
    return json.loads(raw)


def verified_bytes(path: Path, expected: str, limit: int, label: str) -> bytes:
    with path.open("rb") as handle:
        raw = handle.read(limit + 1)
    if len(raw) > limit:
        raise ReferenceValidationError(f"{label} exceeds the input size limit")
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ReferenceValidationError(f"{label} hash mismatch")
    return raw


def validate_manifest(raw: dict, base: Path, *, require_reviewed=False) -> dict:
    manifest = Manifest.model_validate(raw)
    if datetime.fromisoformat(manifest.frozen_at.replace("Z", "+00:00")).tzinfo is None:
        raise ReferenceValidationError("freeze time must include a timezone")
    identities = set()
    families: dict[str, set[str]] = {}
    pending = []
    entry_count = 0
    for case in manifest.cases:
        if case.case_id in identities:
            raise ReferenceValidationError("duplicate QA-02 case identity")
        identities.add(case.case_id)
        if case.split == "holdout" and case.previously_inspected:
            raise ReferenceValidationError("inspected menus cannot be holdouts")
        for source_hash in {case.source_sha256, case.original_source_sha256}:
            families.setdefault(source_hash, set()).add(case.split)
        source = (base / case.source_path).resolve()
        reference_path = (base / case.reference_path).resolve()
        source_bytes = verified_bytes(source, case.source_sha256, 64_000_000, "source")
        reference_bytes = verified_bytes(reference_path, case.reference_sha256, 2_000_000, "reference")
        with pymupdf.open(stream=source_bytes) as document:
            if document.page_count != case.page_count:
                raise ReferenceValidationError("source page count mismatch")
        ref = Reference.model_validate(json.loads(reference_bytes))
        if ref.reference_version != case.reference_version:
            raise ReferenceValidationError("reference version mismatch")
        review = ref.review
        if review.status == "recorded":
            if not review.reviewer or not review.decision_reference or review.reviewer == ref.authored_by:
                raise ReferenceValidationError("recorded review needs a different reviewer and decision reference")
        else:
            pending.append(case.case_id)
        occurrences = set()
        entry_pages = set()
        for entry in ref.entries:
            if entry.page > case.page_count or entry.entry_id in occurrences:
                raise ReferenceValidationError("invalid page or duplicate reference occurrence")
            occurrences.add(entry.entry_id)
            entry_pages.add(entry.page)
        exclusions = [page.page for page in ref.excluded_pages]
        if len(set(exclusions)) != len(exclusions) or entry_pages.intersection(exclusions):
            raise ReferenceValidationError("duplicate exclusion or an annotated page is excluded")
        if entry_pages.union(exclusions) != set(range(1, case.page_count + 1)):
            raise ReferenceValidationError("every source page needs entries or an explicit exclusion")
        entry_count += len(ref.entries)
    if any("holdout" in splits and len(splits) > 1 for splits in families.values()):
        raise ReferenceValidationError("source-family leakage between holdout and development/supplemental")
    if require_reviewed and pending:
        raise ReferenceValidationError("independent reference review is still pending")
    return {
        "integrity": "PASS", "dataset_version": manifest.dataset_version,
        "cases": len(manifest.cases), "entries": entry_count,
        "splits": {split: sum(case.split == split for case in manifest.cases)
                   for split in ("development", "supplemental", "holdout")},
        "pending_review_cases": pending,
        "review_identity_authenticated": False,
        "model_quality_evaluation": "NOT RUN",
        "release_acceptance": "NOT ESTABLISHED",
    }


def freeze(template: Path, output: Path) -> dict:
    raw = read_json(template)
    raw["frozen_at"] = datetime.now(timezone.utc).isoformat()
    for case in raw["cases"]:
        for field, hash_field in (("source_path", "source_sha256"), ("reference_path", "reference_sha256")):
            path = (template.parent / case[field]).resolve()
            actual = digest(path)
            if case.get(hash_field) not in (None, actual):
                raise ReferenceValidationError("freeze cannot replace a mismatched recorded hash")
            case[hash_field] = actual
            case[field] = str(path)
        case["original_source_sha256"] = case.get("original_source_sha256") or case["source_sha256"]
    result = validate_manifest(raw, template.parent)
    with output.open("x", encoding="utf-8") as handle:
        json.dump(raw, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    output.chmod(0o600)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("freeze", help="hash reviewed source/reference bytes; create a new private manifest")
    prepare.add_argument("template", type=Path)
    prepare.add_argument("--output", type=Path, required=True)
    verify = sub.add_parser("verify", help="verify bytes/schema; not source truth or quality acceptance")
    verify.add_argument("manifest", type=Path)
    verify.add_argument("--require-reviewed", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = freeze(args.template, args.output) if args.command == "freeze" else validate_manifest(
            read_json(args.manifest), args.manifest.parent, require_reviewed=args.require_reviewed)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        # Validation errors can contain private source annotations or file paths.
        print(json.dumps({"integrity": "FAIL", "error": str(error) if isinstance(error, ReferenceValidationError) else "invalid_input", "acceptance": "NOT ESTABLISHED"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
