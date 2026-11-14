"""Strict offline QA-02 scoring of saved outputs against frozen references.

This module is an offline measurement tool. It validates the existing PR169
manifest/reference bytes and a private run ledger, re-exports the supplied
candidate export from the saved extraction report, and counts complete emitted
literal price fields and names. It never calls a provider, edits a reference,
approves a dish or certifies release acceptance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, model_validator

from peekaplate_processing.qa02_reference import (
    Hash,
    Manifest,
    Record,
    Reference,
    Review,
    Text,
    digest,
    validate_manifest,
    verified_bytes,
)
from peekaplate_processing.review_candidates import ReviewCandidateResult, prepare_review_candidates
from peekaplate_processing.schemas import MenuExtractionResult, _typed_equal

SCHEMA_VERSION = "qa02.strict-score.v1"
JSON_LIMIT = 2_000_000
REPORT_LIMIT = 32_000_000
ERROR_STRING_LIMIT = 200
MAX_PAGE_ERRORS = 5

PAGE_COUNT_KEYS = (
    "expected_dishes",
    "expected_qualifiers",
    "primary_assertions",
    "wrong_page_assertions",
    "duplicate_assertions",
    "role_errors",
    "unassociated_candidates",
    "name_correct",
    "dish_correct",
    "dish_wrong",
    "dish_missing",
    "price_matched",
    "price_wrong",
    "price_missing",
    "unknown_correct",
    "unknown_unsupported",
    "unknown_missing",
)

CASE_COUNT_KEYS = PAGE_COUNT_KEYS + (
    "reference_entries",
    "reference_dishes",
    "reference_qualifiers",
    "asserted_candidates",
    "name_wrong",
    "known_price_groups",
    "unknown_price_groups",
    "pages_total",
    "pages_excluded",
    "report_errors",
    "report_warnings",
)

UNMEASURED_LANES = {
    "ingredients": "NOT MEASURED",
    "geometry_and_transforms": "NOT MEASURED",
    "confidence_and_illegibility": "NOT MEASURED",
    "allergen_and_food_safety": "NOT MEASURED",
    "recovery_and_hosted_corrections": "NOT MEASURED",
    "hosted_integration": "NOT MEASURED",
    "structured_price_options": "NOT MEASURED: the producer emits no structured actual option array",
}

MEASUREMENT_LABELS = {
    "name_equality": "literal lower() plus whitespace split/join; no casefold, accent, trademark, punctuation, alias or spelling normalization",
    "price_text_equality": "the same literal lower() and whitespace folding over the entire reviewed price_text",
    "price_amount_equality": "finite Decimal numeric value; null and zero are never equivalent",
    "currency_equality": "exact nullable currency code",
    "price_group_semantics": "complete emitted price_text, price_amount and price_currency fields; no actual structured option array exists, so option subsets/order are measured only through the literal",
    "ambiguous_price_text": "a non-null literal without options or scalar is reported as known_ambiguous_text; it stays a known literal group, not an unknown abstention",
    "candidate_consumption": "the first association in original candidate export order consumes a reference occurrence; later duplicates never improve recall or price",
    "reference_identity": "source annotation and reviewer identity are human declarations, not authenticated proof",
    "runtime_identity": "producer commit, command, model and extraction mode are declarations from the ledger/report, not authenticated execution proof",
    "unavailable_capture": "unavailable cases keep every reference denominator and never fabricate candidates; original diagnostics remain outside this scorer",
    "reference_null_reasons": "reference null/unknown reasons are human declarations, not authenticated source truth",
    "aggregation": "summed micro counts; per-page percentages are never averaged",
}


class StrictScoreError(ValueError):
    """Developer-authored, non-sensitive validation reason; CLI output stays sanitized."""


class _PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise StrictScoreError("invalid command arguments")


class RunBlob(Record):
    path: Text
    sha256: Hash


class Link(Record):
    candidate_id: Text
    entry_id: Text | None
    evidence_index: Annotated[int, Field(ge=0)] | None


class CaseRun(Record):
    case_id: Text
    input_route: Literal["image", "pdf", "url"]
    state: Literal["captured", "unavailable"]
    unavailable_reason: Literal[
        "not_attempted", "acquisition_failed", "provider_failed", "timeout", "invalid_artifact"
    ] | None
    report: RunBlob | None
    candidates: RunBlob | None
    producer_command: Text | None
    associations: list[Link]

    @model_validator(mode="after")
    def disposition_shape(self):
        if self.state == "captured":
            if self.report is None or self.candidates is None:
                raise StrictScoreError("a captured case needs report and candidate export blobs")
            if self.producer_command is None:
                raise StrictScoreError("a captured case needs its actual producer command")
            if self.unavailable_reason is not None:
                raise StrictScoreError("a captured case cannot carry an unavailable reason")
        else:
            if self.unavailable_reason is None:
                raise StrictScoreError("an unavailable case needs an explicit reason")
            if self.report is not None or self.candidates is not None:
                raise StrictScoreError("an unavailable case cannot carry report or candidate blobs")
            if self.associations:
                raise StrictScoreError("an unavailable case cannot carry candidate associations")
        return self


class RunLedger(Record):
    schema_version: Literal["qa02.runs.v1"]
    manifest_sha256: Hash
    condition: Text
    producer_commit: Annotated[str, Field(pattern=r"^[a-f0-9]{40}$")]
    prepared_by: Text
    association_review: Review
    cases: Annotated[list[CaseRun], Field(min_length=1)]

    @model_validator(mode="after")
    def unique_cases(self):
        identities = [case.case_id for case in self.cases]
        if len(set(identities)) != len(identities):
            raise StrictScoreError("run ledger cases must be unique")
        return self


def _read_runs(path: Path) -> tuple[bytes, str]:
    try:
        with path.open("rb") as handle:
            raw = handle.read(JSON_LIMIT + 1)
    except OSError:
        raise StrictScoreError("the run ledger cannot be read") from None
    if len(raw) > JSON_LIMIT:
        raise StrictScoreError("the run ledger exceeds the JSON size limit")
    return raw, hashlib.sha256(raw).hexdigest()


def _load_json(raw: bytes, label: str):
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise StrictScoreError(f"invalid {label} JSON") from None


def _normalized(value: str) -> str:
    return " ".join(value.lower().split())


def _literal_equal(expected: str | None, actual: str | None) -> bool:
    if expected is None or actual is None:
        return expected is None and actual is None
    return _normalized(expected) == _normalized(actual)


def _amounts_equal(expected: str | None, actual: Decimal | None) -> bool:
    if expected is None or actual is None:
        return expected is None and actual is None
    try:
        return Decimal(expected) == actual
    except InvalidOperation:
        raise StrictScoreError("the frozen reference amount is not decimal") from None


def _decimal_text(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _price_matches(entry, original) -> bool:
    return (
        _literal_equal(entry.price_text, original.price_text)
        and _amounts_equal(entry.price_amount, original.price_amount)
        and entry.currency == original.price_currency
    )


def _known_price_group(entry) -> bool:
    return entry.role == "dish" and (bool(entry.ordered_price_options) or entry.price_text is not None)


def _price_state(entry) -> str:
    if entry.role != "dish":
        return "not_applicable"
    if not _known_price_group(entry):
        return "unknown"
    if entry.price_text is not None and not entry.ordered_price_options and entry.price_amount is None:
        return "known_ambiguous_text"
    return "known_group"


def _abstained(original) -> bool:
    return original.price_text is None and original.price_amount is None and original.price_currency is None


def _reference_for(case, base: Path) -> Reference:
    raw = verified_bytes(base / case.reference_path, case.reference_sha256, JSON_LIMIT, "reference")
    try:
        return Reference.model_validate(_load_json(raw, "reference"))
    except ValueError:
        raise StrictScoreError("the reference does not match the frozen schema") from None


def _validate_association_review(ledger: RunLedger) -> None:
    review = ledger.association_review
    if review.status != "recorded":
        raise StrictScoreError("output association review is still pending")
    if not review.reviewer or not review.decision_reference:
        raise StrictScoreError("recorded association review needs a reviewer and decision reference")
    if review.reviewer == ledger.prepared_by:
        raise StrictScoreError("association reviewer must differ from the ledger preparer")


def _zero_page_counts() -> dict[str, int]:
    return {key: 0 for key in PAGE_COUNT_KEYS}


def _empty_page(page: int, exclusion_reason: str | None, entries) -> dict:
    return {
        "page": page,
        "excluded": exclusion_reason is not None,
        "exclusion_reason": exclusion_reason,
        "segment_status": "unavailable",
        "segment_errors": [],
        "expected_entry_ids": [entry.entry_id for entry in entries if entry.page == page],
        "actual_candidate_ids": [],
        "counts": _zero_page_counts(),
    }


def _bounded_error(value: str | None) -> str | None:
    if not value:
        return None
    text = " ".join(value.split())
    return text[:ERROR_STRING_LIMIT] or None


def _page_segments(page: dict, segments: list) -> None:
    if not segments:
        page["segment_status"] = "missing"
        page["segment_errors"] = []
        return
    if any(segment.status == "ready" and segment.error is None for segment in segments):
        page["segment_status"] = "ready"
    elif any(segment.status == "failed" for segment in segments):
        page["segment_status"] = "failed"
    elif any(segment.status == "skipped" for segment in segments):
        page["segment_status"] = "skipped"
    else:
        page["segment_status"] = "unknown"
    errors = []
    for segment in segments:
        bounded = _bounded_error(segment.error)
        if bounded is not None and bounded not in errors:
            errors.append(bounded)
    page["segment_errors"] = errors[:MAX_PAGE_ERRORS]


def _report_record(report: MenuExtractionResult | None) -> dict | None:
    if report is None:
        return None
    return {
        "status": report.status,
        "extraction_mode": report.extraction_mode,
        "extraction_model": report.extraction_model,
        "configuration": report.configuration,
        "library_versions": report.library_versions,
        "started_at": report.started_at.isoformat(),
        "finished_at": report.finished_at.isoformat() if report.finished_at is not None else None,
        "segment_count": len(report.segments),
        "errors": list(report.errors),
        "warnings": list(report.warnings),
        "source_matches_manifest": True,
    }


def _load_captured(case, run: CaseRun, runs_base: Path) -> tuple[MenuExtractionResult, ReviewCandidateResult]:
    report_bytes = verified_bytes(runs_base / run.report.path, run.report.sha256, REPORT_LIMIT, "report")
    export_bytes = verified_bytes(runs_base / run.candidates.path, run.candidates.sha256, REPORT_LIMIT, "candidate export")
    try:
        report = MenuExtractionResult.model_validate_json(report_bytes)
    except ValueError:
        raise StrictScoreError("the saved extraction report does not match its schema") from None
    if (
        report.source is None
        or report.source.sha256 != case.source_sha256
        or report.source.source_id != f"sha256:{case.source_sha256}"
    ):
        raise StrictScoreError("the saved report does not identify the frozen source hash")
    try:
        prepared = prepare_review_candidates(report)
    except (ValueError, RuntimeError):
        raise StrictScoreError("the saved report cannot be re-exported to candidate evidence") from None
    try:
        exported = ReviewCandidateResult.model_validate_json(export_bytes)
    except ValueError:
        raise StrictScoreError("the candidate export does not match its schema") from None
    if not _typed_equal(prepared.model_dump(mode="json"), exported.model_dump(mode="json")):
        raise StrictScoreError("the candidate export does not match the report re-export")
    return report, exported


def _score_case(case, run: CaseRun, reference: Reference, runs_base: Path) -> dict:
    entries = list(reference.entries)
    by_entry_id = {entry.entry_id: entry for entry in entries}
    if len(by_entry_id) != len(entries):
        raise StrictScoreError("duplicate reference entry identity")
    excluded = {item.page: item.reason for item in reference.excluded_pages}
    pages = [page for page in range(1, case.page_count + 1)]
    page_stats = {page: _empty_page(page, excluded.get(page), entries) for page in pages}

    report = None
    exported = None
    if run.state == "captured":
        report, exported = _load_captured(case, run, runs_base)

    candidate_order: list[str] = []
    by_candidate = {}
    span_pages: dict[str, list[int]] = {}
    if exported is not None:
        segments_by_page = {page: [] for page in pages}
        segment_pages = {}
        for segment in exported.segments:
            page = segment.page_number
            if page is None or page < 1 or page > case.page_count:
                raise StrictScoreError("candidate evidence segment page is unknown or outside the frozen source")
            segment_pages[segment.segment_id] = page
            segments_by_page[page].append(segment)
        for page in pages:
            _page_segments(page_stats[page], segments_by_page[page])
        candidate_order = [candidate.candidate_id for candidate in exported.candidates]
        by_candidate = {candidate.candidate_id: candidate for candidate in exported.candidates}
        for candidate_id in candidate_order:
            candidate = by_candidate[candidate_id]
            resolved = []
            for span in candidate.evidence:
                page = segment_pages.get(span.segment_id)
                if page is None:
                    raise StrictScoreError("candidate evidence cites an unknown segment")
                resolved.append(page)
            span_pages[candidate_id] = resolved

    link_by_candidate: dict[str, tuple | None] = {}
    for link in run.associations:
        if link.candidate_id in link_by_candidate:
            raise StrictScoreError("duplicate association row for one candidate")
        if link.candidate_id not in by_candidate:
            raise StrictScoreError("association cites an unknown candidate identity")
        if link.entry_id is None:
            if link.evidence_index is not None:
                raise StrictScoreError("an unassociated candidate cannot cite a span index")
            link_by_candidate[link.candidate_id] = None
            continue
        entry = by_entry_id.get(link.entry_id)
        if entry is None:
            raise StrictScoreError("association cites an unknown reference entry")
        if link.evidence_index is None:
            raise StrictScoreError("an associated candidate needs an actual evidence index")
        if link.evidence_index >= len(by_candidate[link.candidate_id].evidence):
            raise StrictScoreError("association evidence index is outside the candidate spans")
        link_by_candidate[link.candidate_id] = (entry, link.evidence_index)

    entry_links: dict[str, list[str]] = {entry.entry_id: [] for entry in entries}
    for candidate_id in candidate_order:
        pair = link_by_candidate.get(candidate_id)
        if pair is not None:
            entry_links[pair[0].entry_id].append(candidate_id)
    primary = {entry_id: linked[0] for entry_id, linked in entry_links.items() if linked}

    disposition: dict[str, str] = {}
    disposition_entry: dict[str, str | None] = {}
    candidate_pages: dict[str, int] = {}
    used_index: dict[str, int] = {}
    for candidate_id in candidate_order:
        pair = link_by_candidate.get(candidate_id)
        if pair is None:
            span_index = 0
            disposition[candidate_id] = "unassociated"
            disposition_entry[candidate_id] = None
        else:
            entry, span_index = pair
            disposition_entry[candidate_id] = entry.entry_id
            if primary[entry.entry_id] != candidate_id:
                disposition[candidate_id] = "duplicate"
            elif entry.role == "qualifier":
                disposition[candidate_id] = "role_error"
            elif span_pages[candidate_id][span_index] != entry.page:
                disposition[candidate_id] = "wrong_page"
            else:
                disposition[candidate_id] = "primary"
        used_index[candidate_id] = span_index
        candidate_pages[candidate_id] = span_pages[candidate_id][span_index]
        page_stat = page_stats[candidate_pages[candidate_id]]
        page_stat["actual_candidate_ids"].append(candidate_id)
        disposition_key = {
            "primary": "primary_assertions",
            "wrong_page": "wrong_page_assertions",
            "duplicate": "duplicate_assertions",
            "role_error": "role_errors",
            "unassociated": "unassociated_candidates",
        }[disposition[candidate_id]]
        page_stat["counts"][disposition_key] += 1

    rows = []
    for entry in entries:
        primary_id = primary.get(entry.entry_id)
        if primary_id is None:
            association = {
                "candidate_id": None,
                "disposition": "unassociated",
                "actual_page": None,
                "evidence_index": None,
            }
            actual = None
            name_correct = False
            recall_outcome = "missing"
        else:
            resolved = disposition[primary_id]
            association = {
                "candidate_id": primary_id,
                "disposition": resolved,
                "actual_page": candidate_pages[primary_id],
                "evidence_index": used_index[primary_id],
            }
            original = by_candidate[primary_id].original
            actual = {
                "candidate_id": primary_id,
                "name": original.name,
                "price_text": original.price_text,
                "price_amount": _decimal_text(original.price_amount),
                "price_currency": original.price_currency,
            }
            name_correct = (
                resolved == "primary"
                and entry.name is not None
                and _literal_equal(entry.name, original.name)
            )
            if resolved == "wrong_page":
                recall_outcome = "missing"
            else:
                recall_outcome = "correct" if name_correct else "wrong"

        price_outcome = None
        if entry.role != "dish":
            recall_outcome = "not_scored_role"
        elif _known_price_group(entry):
            if primary_id is None or disposition[primary_id] != "primary":
                price_outcome = "missing"
            else:
                price_outcome = "matched" if _price_matches(entry, by_candidate[primary_id].original) else "wrong"
        else:
            if primary_id is None or disposition[primary_id] != "primary":
                price_outcome = "missing"
            else:
                price_outcome = "abstain" if _abstained(by_candidate[primary_id].original) else "unsupported"

        entry_page = page_stats[entry.page]["counts"]
        if entry.role == "dish":
            entry_page["expected_dishes"] += 1
            if recall_outcome == "correct":
                entry_page["dish_correct"] += 1
            elif recall_outcome == "missing":
                entry_page["dish_missing"] += 1
            else:
                entry_page["dish_wrong"] += 1
            if _known_price_group(entry):
                entry_page["price_matched" if price_outcome == "matched" else "price_wrong" if price_outcome == "wrong" else "price_missing"] += 1
            else:
                entry_page["unknown_correct" if price_outcome == "abstain" else "unknown_unsupported" if price_outcome == "unsupported" else "unknown_missing"] += 1
        else:
            entry_page["expected_qualifiers"] += 1

        rows.append({
            "entry_id": entry.entry_id,
            "page": entry.page,
            "section": entry.section,
            "location": entry.location,
            "role": entry.role,
            "name": entry.name,
            "description": entry.description,
            "price_text": entry.price_text,
            "price_amount": entry.price_amount,
            "currency": entry.currency,
            "ordered_price_options": [
                {"label": option.label, "amount": option.amount} for option in entry.ordered_price_options
            ],
            "price_state": _price_state(entry),
            "association": association,
            "actual": actual,
            "name_correct": name_correct,
            "recall_outcome": recall_outcome,
            "price_outcome": price_outcome,
        })

    candidate_rows = []
    for candidate_id in candidate_order:
        candidate = by_candidate[candidate_id]
        original = candidate.original
        page = candidate_pages[candidate_id]
        name_correct = disposition[candidate_id] == "primary"
        if name_correct:
            entry = by_entry_id[disposition_entry[candidate_id]]
            name_correct = entry.name is not None and _literal_equal(entry.name, original.name)
        if name_correct:
            page_stats[page]["counts"]["name_correct"] += 1
        candidate_rows.append({
            "candidate_id": candidate_id,
            "assigned_page": page,
            "disposition": disposition[candidate_id],
            "associated_entry_id": disposition_entry[candidate_id],
            "evidence_index": used_index[candidate_id] if disposition[candidate_id] != "unassociated" else None,
            "evidence_index_used": used_index[candidate_id],
            "original": {
                "name": original.name,
                "description": original.description,
                "category": original.category,
                "subcategory": original.subcategory,
                "category_page_number": original.category_page_number,
                "price_text": original.price_text,
                "price_amount": _decimal_text(original.price_amount),
                "price_currency": original.price_currency,
                "ingredients": original.ingredients,
                "status": original.status,
            },
            "name_correct": name_correct,
        })

    counts = {key: sum(page_stats[page]["counts"][key] for page in pages) for key in PAGE_COUNT_KEYS}
    counts.update({
        "reference_entries": len(entries),
        "reference_dishes": sum(entry.role == "dish" for entry in entries),
        "reference_qualifiers": sum(entry.role == "qualifier" for entry in entries),
        "asserted_candidates": len(candidate_order),
        "name_wrong": len(candidate_order) - counts["name_correct"],
        "known_price_groups": counts["price_matched"] + counts["price_wrong"] + counts["price_missing"],
        "unknown_price_groups": counts["unknown_correct"] + counts["unknown_unsupported"] + counts["unknown_missing"],
        "pages_total": len(pages),
        "pages_excluded": sum(1 for page in pages if page_stats[page]["excluded"]),
        "report_errors": len(report.errors) if report is not None else 0,
        "report_warnings": len(report.warnings) if report is not None else 0,
    })

    return {
        "case_id": case.case_id,
        "split": case.split,
        "previously_inspected": case.previously_inspected,
        "input_route": run.input_route,
        "state": run.state,
        "unavailable_reason": run.unavailable_reason,
        "producer_command": run.producer_command,
        "page_count": case.page_count,
        "reference_version": case.reference_version,
        "hashes": {
            "source_sha256": case.source_sha256,
            "original_source_sha256": case.original_source_sha256,
            "reference_sha256": case.reference_sha256,
            "report_sha256": run.report.sha256 if run.report is not None else None,
            "candidates_sha256": run.candidates.sha256 if run.candidates is not None else None,
        },
        "reference": {
            "version": case.reference_version,
            "entries": len(entries),
            "dishes": counts["reference_dishes"],
            "qualifiers": counts["reference_qualifiers"],
        },
        "report": _report_record(report),
        "pages": [page_stats[page] for page in pages],
        "rows": rows,
        "candidates": candidate_rows,
        "counts": counts,
    }


def _rate(numerator: int, denominator: int) -> dict:
    measured = denominator > 0
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rate": numerator / denominator if measured else None,
        "status": "MEASURED" if measured else "N/A",
        "explanation": None if measured else "no eligible observations; rate is undefined, not 100%",
    }


def _aggregate(cases: list[dict]) -> dict:
    counts = {key: sum(case["counts"][key] for case in cases) for key in CASE_COUNT_KEYS}
    return {
        "counts": counts,
        "rates": {
            "name_precision": _rate(counts["name_correct"], counts["asserted_candidates"]),
            "dish_recall": _rate(counts["dish_correct"], counts["reference_dishes"]),
            "price_completeness": _rate(counts["price_matched"], counts["known_price_groups"]),
            "unknown_abstention": _rate(counts["unknown_correct"], counts["unknown_price_groups"]),
        },
        "aggregation": "summed micro counts",
    }


def _grouped(cases: list[dict], key) -> dict:
    groups: dict[str, list[dict]] = {}
    for case in cases:
        groups.setdefault(key(case), []).append(case)
    return {name: _aggregate(members) for name, members in sorted(groups.items())}


def _input_status(cases: list[dict]) -> str:
    for case in cases:
        if case["state"] != "captured" or case["report"] is None:
            return "incomplete"
        if case["report"]["status"] != "complete" or case["report"]["errors"]:
            return "incomplete"
        for page in case["pages"]:
            if not page["excluded"] and page["segment_status"] != "ready":
                return "incomplete"
    return "complete"


def _coverage(cases: list[dict]) -> dict:
    pages = [page for case in cases for page in case["pages"]]
    return {
        "cases_total": len(cases),
        "cases_captured": sum(case["state"] == "captured" for case in cases),
        "cases_unavailable": sum(case["state"] == "unavailable" for case in cases),
        "reports_complete": sum(
            case["report"] is not None and case["report"]["status"] == "complete" for case in cases
        ),
        "reports_incomplete": sum(
            case["report"] is not None and case["report"]["status"] != "complete" for case in cases
        ),
        "reports_with_errors": sum(
            case["report"] is not None and bool(case["report"]["errors"]) for case in cases
        ),
        "pages_total": len(pages),
        "pages_ready": sum(page["segment_status"] == "ready" for page in pages),
        "pages_failed": sum(page["segment_status"] == "failed" for page in pages),
        "pages_skipped": sum(page["segment_status"] == "skipped" for page in pages),
        "pages_missing": sum(page["segment_status"] == "missing" for page in pages),
        "pages_unavailable": sum(page["segment_status"] == "unavailable" for page in pages),
        "pages_excluded": sum(page["excluded"] for page in pages),
        "input_status": _input_status(cases),
    }


def _module_sha256() -> str:
    return digest(Path(__file__).resolve())


def score(manifest_path: Path, runs_path: Path) -> dict:
    """Measure saved actual outputs against a frozen reviewed manifest.

    Raises StrictScoreError (a ValueError) for invalid, incomplete or tampered
    inputs. A successful return is a measurement receipt only; it never
    certifies quality or release acceptance.
    """
    manifest_path = Path(manifest_path)
    runs_path = Path(runs_path)
    runs_raw, runs_sha256 = _read_runs(runs_path)
    try:
        ledger = RunLedger.model_validate(_load_json(runs_raw, "run ledger"))
    except StrictScoreError:
        raise
    except ValueError:
        raise StrictScoreError("the run ledger does not match the qa02.runs.v1 schema") from None
    _validate_association_review(ledger)

    manifest_bytes = verified_bytes(manifest_path, ledger.manifest_sha256, JSON_LIMIT, "manifest")
    raw_manifest = _load_json(manifest_bytes, "manifest")
    try:
        manifest = Manifest.model_validate(raw_manifest)
    except ValueError:
        raise StrictScoreError("the manifest does not match the frozen schema") from None
    integrity = validate_manifest(raw_manifest, manifest_path.parent, require_reviewed=True)

    manifest_ids = [case.case_id for case in manifest.cases]
    run_by_id = {case.case_id: case for case in ledger.cases}
    if len(manifest_ids) != len(set(manifest_ids)):
        raise StrictScoreError("duplicate manifest case identity")
    if set(manifest_ids) != set(run_by_id):
        raise StrictScoreError("the run ledger must cover every manifest case exactly once, without extras")

    cases = []
    for case in manifest.cases:
        reference = _reference_for(case, manifest_path.parent)
        cases.append(_score_case(case, run_by_id[case.case_id], reference, runs_path.parent))

    overall = _aggregate(cases)
    overall["pooled_across_splits"] = True
    overall["interpretation"] = "pooled counts are not held-out quality; use by_split"
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "SCORED",
        "reference_integrity": integrity,
        "acceptance": "NOT ESTABLISHED",
        "release_acceptance": "NOT ESTABLISHED",
        "quality_thresholds": "NOT APPLIED",
        "coverage": _coverage(cases),
        "inputs": {
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "declared_manifest_sha256": ledger.manifest_sha256,
            "runs_sha256": runs_sha256,
            "dataset_version": manifest.dataset_version,
            "condition": ledger.condition,
        },
        "provenance": {
            "condition": ledger.condition,
            "producer": {
                "commit": ledger.producer_commit,
                "commit_authenticated": False,
                "prepared_by": ledger.prepared_by,
                "prepared_by_authenticated": False,
            },
            "association_review": {
                "status": ledger.association_review.status,
                "reviewer": ledger.association_review.reviewer,
                "decision_reference": ledger.association_review.decision_reference,
                "reviewer_authenticated": False,
            },
            "scorer": {
                "module": "peekaplate_processing.qa02_strict_score",
                "module_sha256": _module_sha256(),
                "caller_supplied_commit_authenticated": False,
            },
        },
        "measurement_labels": MEASUREMENT_LABELS,
        "unmeasured_lanes": UNMEASURED_LANES,
        "cases": cases,
        "aggregates": {
            "overall": overall,
            "by_split": _grouped(cases, lambda case: case["split"]),
            "by_input_route": _grouped(cases, lambda case: case["input_route"]),
            "by_reported_mode": _grouped(
                cases,
                lambda case: case["report"]["extraction_mode"] if case["report"] is not None else "unavailable",
            ),
            "reported_mode_semantics": "declared by the saved report; not authenticated execution proof",
        },
    }


def write_receipt(result: dict, output: Path) -> None:
    """Create the private receipt exactly once with owner-only permissions."""
    content = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.chmod(output, 0o600)
    except BaseException:
        Path(output).unlink(missing_ok=True)
        raise


def _summary(result: dict) -> dict:
    overall = result["aggregates"]["overall"]["counts"]
    return {
        "status": result["status"],
        "cases_total": result["coverage"]["cases_total"],
        "cases_captured": result["coverage"]["cases_captured"],
        "cases_unavailable": result["coverage"]["cases_unavailable"],
        "input_status": result["coverage"]["input_status"],
        "reference_integrity": result["reference_integrity"]["integrity"],
        "reference_dishes": overall["reference_dishes"],
        "asserted_candidates": overall["asserted_candidates"],
        "name_correct": overall["name_correct"],
        "dish_correct": overall["dish_correct"],
        "known_price_groups": overall["known_price_groups"],
        "price_matched": overall["price_matched"],
        "acceptance": result["acceptance"],
        "release_acceptance": result["release_acceptance"],
        "quality_thresholds": result["quality_thresholds"],
        "human_association_review": "DECLARED, NOT AUTHENTICATED",
    }


def main(argv=None) -> int:
    parser = _PrivateArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="Frozen QA-02 manifest.")
    parser.add_argument("--runs", type=Path, required=True, help="Private qa02.runs.v1 run/association ledger.")
    parser.add_argument("--output", type=Path, required=True, help="New private strict-score receipt path.")
    try:
        args = parser.parse_args(argv)
        result = score(args.manifest, args.runs)
        write_receipt(result, args.output)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        # Validation errors may contain private annotations, paths or provider text.
        print(json.dumps({
            "status": "FAIL",
            "error": "invalid_input",
            "acceptance": "NOT ESTABLISHED",
            "release_acceptance": "NOT ESTABLISHED",
        }))
        return 1
    print(json.dumps(_summary(result)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())