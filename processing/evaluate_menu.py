"""Evaluate frozen extraction reports against human-aligned, reviewed labels.

Standard library only: this command never calls an OCR/model API or publishes.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path


FIELDS = ("name", "description", "category", "price_amount", "price_currency", "ingredients")
MAX_JSON_BYTES = 32_000_000


def load_json(path):
    with Path(path).open('rb') as input_file:
        data = input_file.read(MAX_JSON_BYTES + 1)
    if len(data) > MAX_JSON_BYTES:
        raise ValueError("Evaluation input exceeds the 32 MB limit.")
    return json.loads(data, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite JSON number.")))


def write_new_json(value, path):
    """Publish one private file atomically, refusing an existing destination."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
        os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def normalized(value, field):
    if value is None:
        return None
    if field == "price_amount":
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise ValueError("Prices must be finite, nonnegative decimal values.")
        try:
            amount = Decimal(str(value))
            if not amount.is_finite() or amount < 0:
                raise ValueError("Prices must be finite and nonnegative.")
            return amount
        except InvalidOperation:
            raise ValueError("Invalid decimal price.") from None
    if field == "ingredients":
        if not isinstance(value, list) or not value:
            raise ValueError("Unknown ingredients must be null, not an empty list.")
        items = [normalized(item, "name") for item in value]
        if any(item is None for item in items) or len(set(items)) != len(items):
            raise ValueError("Ingredient labels must be nonempty and distinct.")
        return sorted(items)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Text fields must be nonempty strings or null.")
    return " ".join(unicodedata.normalize("NFC", value).split()).casefold()


def provenance_errors(report):
    errors = []
    source = report.get("source") or {}
    try:
        snapshot = base64.b64decode(source["snapshot_base64"], validate=True)
        if not snapshot or hashlib.sha256(snapshot).hexdigest() != source["sha256"]:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        errors.append("source_snapshot_mismatch" if source else "source_unavailable")
    segments = report.get("segments", [])
    by_segment = {segment.get("segment_id"): segment for segment in segments}
    if len(by_segment) != len(segments):
        errors.append("duplicate_segment_id")
    linked_hashes = set()
    verified_linked = set()
    for segment in segments:
        metadata = segment.get("metadata", {})
        if "source_sha256" in metadata:
            linked_hashes.add(metadata["source_sha256"])
        if "source_snapshot_base64" in metadata:
            try:
                snapshot = base64.b64decode(metadata["source_snapshot_base64"], validate=True)
                source_hash = metadata["source_sha256"]
                if not snapshot or hashlib.sha256(snapshot).hexdigest() != source_hash:
                    raise ValueError
                verified_linked.add(source_hash)
            except (KeyError, TypeError, ValueError):
                errors.append("linked_source_snapshot_mismatch")
    if linked_hashes - verified_linked:
        errors.append("linked_source_snapshot_unverified")
    evidence = report.get("evidence", [])
    by_index = {}
    seen_ids = set()
    for entry in evidence:
        index = entry.get("draft_index")
        identity = entry.get("draft_id")
        if type(index) is not int or index < 0 or index in by_index or not identity or identity in seen_ids:
            errors.append("invalid_or_duplicate_draft_identity")
            continue
        by_index[index] = entry
        seen_ids.add(identity)
    drafts = report.get("drafts", [])
    if any(index >= len(drafts) for index in by_index):
        errors.append("orphan_draft_evidence")
    for index, draft in enumerate(drafts):
        entry = by_index.get(index, {})
        fragments = []
        try:
            if not entry.get("spans"):
                raise ValueError
            for span in entry["spans"]:
                segment = by_segment[span["segment_id"]]
                first, last = span["start"], span["end"]
                text = segment["text"]
                if segment.get("status", "ready") != "ready" or type(first) is not int or type(last) is not int or not 0 <= first < last <= len(text):
                    raise ValueError
                if fragments:
                    fragments.append(segment.get("metadata", {}).get("join_before", ""))
                fragments.append(text[first:last])
            if "".join(fragments) != draft["source_text"]:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            errors.append(f"draft_{index}_invalid_source_spans")
        if draft.get("status") != "needs_review":
            errors.append(f"draft_{index}_invalid_review_state")
    return errors


def evaluate_report(report, labels):
    """Use explicit human alignment; never match by name or silently drop dishes."""
    if report.get("schema_version") != 1 or report.get("pipeline_version") != "2":
        raise ValueError("Expected the versioned ingestion report (schema 1 / pipeline 2).")
    source = report.get("source")
    if source is None and (report.get("status") != "failed" or report.get("drafts")):
        raise ValueError("Only a failed extraction without drafts may lack a source snapshot.")
    if source is not None and (not isinstance(source, dict) or source.get("sha256") != labels.get("source_sha256")):
        raise ValueError("Labels and report must reference the same source bytes.")
    if not re.fullmatch(r"[a-f0-9]{64}", labels.get("source_sha256", "")):
        raise ValueError("Reviewed source checksum is required.")
    expected = labels.get("expected")
    if not isinstance(expected, list) or not expected:
        raise ValueError("Reviewed expected dishes are required.")
    drafts = report.get("drafts", [])
    identities = [entry.get("draft_id") for entry in report.get("evidence", [])]
    by_id = {entry["draft_id"]: drafts[entry["draft_index"]] for entry in report.get("evidence", []) if type(entry.get("draft_index")) is int and 0 <= entry["draft_index"] < len(drafts)}
    if len(set(identities)) != len(identities) or len(by_id) != len(drafts):
        raise ValueError("Every prediction requires unique draft identity and evidence.")
    matched = set()
    expected_ids = set()
    counts = {field: Counter() for field in FIELDS}
    failures = []
    missed = 0
    for item in expected:
        identity = item.get("id")
        if not isinstance(identity, str) or not identity.strip() or identity in expected_ids:
            raise ValueError("Expected dish IDs must be nonempty and unique.")
        expected_ids.add(identity)
        fields = item.get("fields")
        if not isinstance(fields, dict) or set(fields) != set(FIELDS):
            raise ValueError("Each reviewed dish must label all six fields, using null for unknowns.")
        draft_id = item.get("match_draft_id")
        if draft_id is not None and (draft_id not in by_id or draft_id in matched):
            raise ValueError("Human alignment must be one-to-one and reference an existing draft.")
        predicted = by_id.get(draft_id)
        if predicted is None:
            missed += 1
        else:
            matched.add(draft_id)
        for field in FIELDS:
            truth = normalized(fields[field], field)
            counts[field]["total"] += 1
            if predicted is None:
                reason = "dish_missing"
            else:
                try:
                    actual = normalized(predicted.get(field), field)
                    reason = "correct" if actual == truth else "unsupported" if truth is None else "missing" if actual is None else "incorrect"
                except ValueError:
                    reason = "invalid"
            counts[field][reason] += 1
            if reason != "correct":
                failures.append({"expected_id": identity, "draft_id": draft_id, "field": field, "reason": reason, "expected": fields[field], "actual": predicted.get(field) if predicted else None})
    extras = sorted(set(by_id) - matched)
    return {
        "source_sha256": labels["source_sha256"],
        "source_kind": (source or {}).get("kind", labels.get("source_kind", "unknown")),
        "source_identity_verified": source is not None and not any(error in {"source_snapshot_mismatch", "source_unavailable"} for error in provenance_errors(report)),
        "extraction_status": report.get("status"),
        "extraction_mode": report.get("extraction_mode"),
        "extraction_model": report.get("extraction_model"),
        "ocr_engine": report.get("ocr_engine"),
        "pipeline_version": report["pipeline_version"],
        "configuration": {key: report.get("configuration", {}).get(key) for key in ("source_type", "force_ocr", "timeout", "ocr_timeout")},
        "library_versions": report.get("library_versions", {}),
        "expected_dishes": len(expected), "predicted_dishes": len(drafts),
        "missed_dishes": missed, "extra_draft_ids": extras,
        "fields": {field: dict(values) for field, values in counts.items()},
        "provenance_errors": provenance_errors(report), "field_errors": failures,
        "acceptance": "not_assessed_requires_approved_rubric_and_independent_review",
    }


def evaluate_dataset(manifest_path):
    manifest_path = Path(manifest_path)
    manifest = load_json(manifest_path)
    if manifest.get("schema_version") != 1 or manifest.get("environment") not in {"fixture", "local", "staging"}:
        raise ValueError("Dataset requires schema_version 1 and an explicit environment.")
    for key in ("dataset_version", "reviewer", "reviewed_at"):
        if not isinstance(manifest.get(key), str) or not manifest[key].strip():
            raise ValueError("Dataset version and human-review metadata are required.")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 1000:
        raise ValueError("Dataset must contain between 1 and 1000 cases.")
    results = []
    seen = set()
    for case in cases:
        identity = case.get("id")
        if not isinstance(identity, str) or not identity.strip() or identity in seen:
            raise ValueError("Case IDs must be nonempty and unique.")
        seen.add(identity)
        conditions = case.get("conditions")
        if not isinstance(conditions, list) or not conditions or any(not isinstance(value, str) or not value.strip() for value in conditions):
            raise ValueError("Each case requires explicit source-condition labels.")
        path = (manifest_path.parent / case["report_path"]).resolve()
        root = manifest_path.parent.resolve()
        if not path.is_relative_to(root):
            raise ValueError("Reports must stay inside the dataset directory.")
        if path.stat().st_size > MAX_JSON_BYTES:
            raise ValueError("Frozen report exceeds the 32 MB limit.")
        if not re.fullmatch(r"[a-f0-9]{64}", case.get("report_sha256", "")) or hashlib.sha256(path.read_bytes()).hexdigest() != case["report_sha256"]:
            raise ValueError("Frozen report checksum does not match the reviewed dataset.")
        result = evaluate_report(load_json(path), case)
        results.append({"case_id": identity, "conditions": conditions, "report_sha256": case["report_sha256"], **result})
    groups = {}
    for result in results:
        for condition in set(result["conditions"]):
            key = f"{result['source_kind']}:{condition}"
            group = groups.setdefault(key, {"cases": 0, "missed_dishes": 0, "extra_dishes": 0, "field_errors": 0, "provenance_errors": 0})
            group["cases"] += 1
            group["missed_dishes"] += result["missed_dishes"]
            group["extra_dishes"] += len(result["extra_draft_ids"])
            group["field_errors"] += len(result["field_errors"])
            group["provenance_errors"] += len(result["provenance_errors"])
    return {"schema_version": 1, "dataset_version": manifest["dataset_version"], "dataset_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(), "environment": manifest["environment"], "reviewer": manifest["reviewer"], "reviewed_at": manifest["reviewed_at"], "scoring": "NFC/casefold/whitespace text; decimal prices; unordered distinct ingredients; null remains unknown", "cases": results, "by_source_condition": groups, "acceptance": "not_assessed_requires_approved_rubric_and_independent_review"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = evaluate_dataset(args.dataset)
        write_new_json(result, args.output)
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        parser.exit(1, "Evaluation failed: check the versioned labels, source/report hashes, alignment and a new output path.\n")
    print(f"Saved evaluation for {len(result['cases'])} frozen cases; acceptance remains unassessed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
