"""Public-interface tests for the strict QA-02 scorer.

Only this synthetic fixture contains invented menu content. The tests cover
the acceptance families published before implementation; they never call a
provider, read a real menu or authenticate a human identity.
"""
import base64
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pymupdf

from peekaplate_processing import qa02_strict_score
from peekaplate_processing.qa02_reference import digest
from peekaplate_processing.qa02_strict_score import score
from peekaplate_processing.review_candidates import prepare_review_candidates
from peekaplate_processing.schemas import MenuExtractionResult

AUTHORED_BY = "fixture-author"
REFERENCE_REVIEWER = "fixture-reference-reviewer"
PREPARED_BY = "fixture-preparer"
ASSOCIATION_REVIEWER = "fixture-output-reviewer"
PRODUCER_COMMIT = "a" * 40
MARKER = "PRIVATE-MENU-MARKER"


class StrictScoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.page_texts = {
            1: f"{MARKER} SOUPS Garden Soup 8.50 / 12.50 CAD HOT DRINKS Coffee BAKERY Bread 0.00 CAD ADD-ONS Add Cheese 1.00 CAD",
            2: "SALADS Garden Salad 10.00 CAD",
        }
        self.entries = [
            self.entry("p1-soup", "Garden Soup", page=1, price_text="8.50 / 12.50 CAD",
                       options=("8.50", "12.50"), currency="CAD", description="vegetables"),
            self.entry("p1-coffee", "Coffee", page=1),
            self.entry("p1-bread", "Bread", page=1, price_text="0.00 CAD", amount="0.00",
                       options=("0.00",), currency="CAD"),
            self.entry("p1-addon", "Add Cheese", page=1, role="qualifier", price_text="1.00 CAD",
                       amount="1.00", options=("1.00",), currency="CAD"),
            self.entry("p2-salad", "Garden Salad", page=2, price_text="10.00 CAD", amount="10.00",
                       options=("10.00",), currency="CAD"),
        ]
        self.cases = [self.make_case("DEV-001", self.entries, self.page_texts, split="development")]
        self.manifest = {
            "schema_version": "qa02.manifest.v1",
            "dataset_version": "strict-fixture-v1",
            "frozen_at": "2026-11-13T00:00:00+00:00",
            "cases": self.cases,
        }
        self.write_manifest()
        self.candidates = [
            {"id": "cand-soup", "name": "Garden Soup", "page": 1,
             "price_text": "8.50 / 12.50 CAD", "price_currency": "CAD"},
            {"id": "cand-coffee", "name": "Coffee", "page": 1},
            {"id": "cand-bread", "name": "Bread", "page": 1,
             "price_text": "0.00 CAD", "price_amount": "0.00", "price_currency": "CAD"},
            {"id": "cand-salad", "name": "Garden Salad", "page": 2,
             "price_text": "10.00 CAD", "price_amount": "10.00", "price_currency": "CAD"},
        ]

    # ---------------------------------------------------------------- fixtures
    def entry(self, entry_id, name, *, page=1, role="dish", price_text=None, amount=None,
              options=(), currency=None, description=None, labels=None, section="MENU"):
        if not options and price_text is None:
            reason = None
        elif len(options) > 1:
            reason = "Multiple printed amounts; no single unambiguous dish price."
        elif len(options) == 1 and amount is None:
            reason = "Printed qualifier; no unambiguous dish-level scalar."
        else:
            reason = None
        return {
            "entry_id": entry_id,
            "page": page,
            "section": section,
            "location": f"Page {page}, synthetic fixture location",
            "role": role,
            "name": name,
            "description": description,
            "price_text": price_text,
            "price_amount": amount,
            "scalar_null_reason": reason,
            "ordered_price_options": [
                {"label": labels[index] if labels else None, "amount": value}
                for index, value in enumerate(options)
            ],
            "currency": currency,
        }

    def make_case(self, case_id, entries, page_texts, *, split="development", review=None):
        source = self.root / f"{case_id}.pdf"
        if not source.exists():
            with pymupdf.open() as document:
                for page in sorted(page_texts):
                    document.new_page().insert_text((30, 30), page_texts[page])
                document.save(source)
        reference = self.root / f"{case_id}.reference.json"
        payload = {
            "schema_version": "qa02.reference.v1",
            "reference_version": f"{case_id}-v1",
            "authored_by": AUTHORED_BY,
            "annotation_method": "source_only",
            "review": review or {
                "status": "recorded",
                "reviewer": REFERENCE_REVIEWER,
                "decision_reference": "fixture-reference-review-1",
            },
            "entries": entries,
            "excluded_pages": [],
        }
        reference.write_text(json.dumps(payload), encoding="utf-8")
        return {
            "case_id": case_id,
            "split": split,
            "source_path": source.name,
            "source_sha256": digest(source),
            "original_source_sha256": digest(source),
            "page_count": len(page_texts),
            "previously_inspected": split != "holdout",
            "source_permission": "Generated synthetic fixture",
            "reference_path": reference.name,
            "reference_sha256": digest(reference),
            "reference_version": payload["reference_version"],
        }

    def write_manifest(self):
        self.manifest["cases"] = self.cases
        self.manifest_path = self.root / "manifest.json"
        self.manifest_path.write_text(json.dumps(self.manifest, ensure_ascii=False), encoding="utf-8")

    def add_case(self, case_id, entries, page_texts, *, split):
        case = self.make_case(case_id, entries, page_texts, split=split)
        self.cases.append(case)
        self.write_manifest()
        return case

    def rewrite_reference(self, entries, *, case_id="DEV-001", review=None, excluded_pages=None):
        case = next(item for item in self.cases if item["case_id"] == case_id)
        path = self.root / case["reference_path"]
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["entries"] = entries
        if review is not None:
            payload["review"] = review
        if excluded_pages is not None:
            payload["excluded_pages"] = excluded_pages
        path.write_text(json.dumps(payload), encoding="utf-8")
        case["reference_sha256"] = digest(path)
        self.write_manifest()

    def capture(self, case_id="DEV-001", candidates=None, *, page_texts=None,
                segment_status=None, report_status="complete", report_errors=None,
                report_warnings=None, extraction_mode="layout"):
        case = next(item for item in self.cases if item["case_id"] == case_id)
        source_bytes = (self.root / case["source_path"]).read_bytes()
        pages = page_texts if page_texts is not None else self.page_texts
        statuses = segment_status or {}
        segment_text = {}
        segments = []
        for page in sorted(pages):
            status = statuses.get(page, "ready")
            text = pages[page] if status == "ready" else ""
            segment_text[page] = text
            segments.append({
                "segment_id": f"sha256:{case['source_sha256']}#page-{page}",
                "page_number": page,
                "method": "pdf_native",
                "status": status,
                "text": text,
                "native_text": text or None,
                "error": "Synthetic page failure." if status == "failed" else None,
                "warnings": ["Synthetic skipped page."] if status == "skipped" else [],
                "metadata": {},
            })
        drafts = []
        evidence = []
        for index, spec in enumerate(candidates if candidates is not None else self.candidates):
            if "spans" in spec:
                spans = spec["spans"]
            else:
                spans = [(spec["page"], 0, len(segment_text[spec["page"]]))]
            passages = [segment_text[page][start:end] for page, start, end in spans]
            drafts.append({
                "name": spec["name"],
                "description": spec.get("description"),
                "category": spec.get("category"),
                "price_text": spec.get("price_text"),
                "price_amount": spec.get("price_amount"),
                "price_currency": spec.get("price_currency"),
                "ingredients": spec.get("ingredients"),
                "source_id": f"sha256:{case['source_sha256']}",
                "source_text": "\n".join(passages),
                "image_id": None,
                "review_warnings": [],
                "status": "needs_review",
            })
            evidence.append({
                "draft_id": spec["id"],
                "draft_index": index,
                "spans": [
                    {"segment_id": f"sha256:{case['source_sha256']}#page-{page}",
                     "start": start, "end": end}
                    for page, start, end in spans
                ],
            })
        report = {
            "schema_version": 2,
            "pipeline_version": "3",
            "status": report_status,
            "source": {
                "source_id": f"sha256:{case['source_sha256']}",
                "sha256": case["source_sha256"],
                "kind": "pdf",
                "location": "synthetic-fixture-local",
                "retrieved_at": "2026-10-25T12:00:00Z",
                "size_bytes": len(source_bytes),
                "snapshot_base64": base64.b64encode(source_bytes).decode("ascii"),
            },
            "started_at": "2026-10-25T12:00:00Z",
            "finished_at": "2026-10-25T12:01:00Z",
            "extraction_mode": extraction_mode,
            "extraction_model": "fixture-model-v1",
            "ocr_engine": 3,
            "library_versions": {"fixture": "1"},
            "configuration": {"fixture_label": extraction_mode},
            "segments": segments,
            "drafts": drafts,
            "evidence": evidence,
            "capture_requests": [],
            "warnings": list(report_warnings or []),
            "errors": list(report_errors or []),
        }
        try:
            parsed = MenuExtractionResult.model_validate(report)
            exported = prepare_review_candidates(parsed)
        except Exception as error:  # noqa: BLE001 - surface an invalid synthetic fixture
            self.fail(f"synthetic report fixture is invalid: {error}")
        report_path = self.root / f"{case_id}.report.json"
        export_path = self.root / f"{case_id}.candidates.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        export_path.write_text(
            json.dumps(exported.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return {
            "report": report_path,
            "candidates": export_path,
            "report_sha256": digest(report_path),
            "candidates_sha256": digest(export_path),
        }

    def default_links(self):
        return [
            {"candidate_id": "cand-soup", "entry_id": "p1-soup", "evidence_index": 0},
            {"candidate_id": "cand-coffee", "entry_id": "p1-coffee", "evidence_index": 0},
            {"candidate_id": "cand-bread", "entry_id": "p1-bread", "evidence_index": 0},
            {"candidate_id": "cand-salad", "entry_id": "p2-salad", "evidence_index": 0},
        ]

    def captured(self, case_id, capture, associations, *, route="pdf", command="python -m fixture_producer"):
        return {
            "case_id": case_id,
            "input_route": route,
            "state": "captured",
            "unavailable_reason": None,
            "report": {"path": capture["report"].name, "sha256": capture["report_sha256"]},
            "candidates": {"path": capture["candidates"].name,
                           "sha256": capture["candidates_sha256"]},
            "producer_command": command,
            "associations": associations,
        }

    def unavailable(self, case_id, *, reason="not_attempted", route="pdf", command=None):
        return {
            "case_id": case_id,
            "input_route": route,
            "state": "unavailable",
            "unavailable_reason": reason,
            "report": None,
            "candidates": None,
            "producer_command": command,
            "associations": [],
        }

    def write_runs(self, cases, *, manifest_sha=None, review=None, prepared_by=PREPARED_BY,
                   condition="fixture-condition", producer_commit=PRODUCER_COMMIT):
        payload = {
            "schema_version": "qa02.runs.v1",
            "manifest_sha256": manifest_sha or digest(self.manifest_path),
            "condition": condition,
            "producer_commit": producer_commit,
            "prepared_by": prepared_by,
            "association_review": review or {
                "status": "recorded",
                "reviewer": ASSOCIATION_REVIEWER,
                "decision_reference": "fixture-output-review-1",
            },
            "cases": cases,
        }
        path = self.root / "runs.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def evaluate(self, cases, **kwargs):
        return score(self.manifest_path, self.write_runs(cases, **kwargs))

    def row(self, case, entry_id):
        return next(item for item in case["rows"] if item["entry_id"] == entry_id)

    def baseline(self):
        capture = self.capture()
        return self.evaluate([self.captured("DEV-001", capture, self.default_links())])

    # ------------------------------------------------------------- acceptance
    def test_baseline_counts_rows_and_sums(self):
        result = self.baseline()
        case = result["cases"][0]
        counts = case["counts"]
        self.assertEqual(result["status"], "SCORED")
        self.assertEqual(result["acceptance"], "NOT ESTABLISHED")
        self.assertEqual(result["release_acceptance"], "NOT ESTABLISHED")
        self.assertEqual(result["reference_integrity"]["integrity"], "PASS")
        self.assertEqual(result["coverage"]["input_status"], "complete")
        self.assertEqual(len(result["provenance"]["scorer"]["module_sha256"]), 64)
        self.assertFalse(result["provenance"]["producer"]["commit_authenticated"])
        self.assertFalse(result["provenance"]["association_review"]["reviewer_authenticated"])
        self.assertTrue(all(value.startswith("NOT MEASURED") for value in result["unmeasured_lanes"].values()))

        self.assertEqual(counts["reference_dishes"], 4)
        self.assertEqual(counts["reference_qualifiers"], 1)
        self.assertEqual(counts["asserted_candidates"], 4)
        self.assertEqual(counts["name_correct"], 4)
        self.assertEqual(counts["name_wrong"], 0)
        self.assertEqual(counts["dish_correct"], 4)
        self.assertEqual(counts["dish_wrong"], 0)
        self.assertEqual(counts["dish_missing"], 0)
        self.assertEqual(counts["known_price_groups"], 3)
        self.assertEqual(counts["price_matched"], 3)
        self.assertEqual(counts["price_wrong"], 0)
        self.assertEqual(counts["price_missing"], 0)
        self.assertEqual(counts["unknown_price_groups"], 1)
        self.assertEqual(counts["unknown_correct"], 1)
        self.assertEqual(counts["unknown_unsupported"], 0)
        self.assertEqual(counts["unknown_missing"], 0)
        self.assertEqual(counts["pages_total"], 2)
        self.assertEqual(counts["pages_excluded"], 0)

        for key in ("expected_dishes", "expected_qualifiers", "primary_assertions",
                    "wrong_page_assertions", "duplicate_assertions", "role_errors",
                    "unassociated_candidates", "name_correct", "dish_correct",
                    "dish_wrong", "dish_missing", "price_matched", "price_wrong",
                    "price_missing", "unknown_correct", "unknown_unsupported",
                    "unknown_missing"):
            self.assertEqual(sum(page["counts"][key] for page in case["pages"]), counts[key], key)

        actual_pages = [candidate for page in case["pages"] for candidate in page["actual_candidate_ids"]]
        self.assertEqual(len(actual_pages), 4)
        self.assertEqual(len(set(actual_pages)), 4)

        soup = self.row(case, "p1-soup")
        self.assertEqual(soup["price_state"], "known_group")
        self.assertTrue(soup["name_correct"])
        self.assertEqual(soup["price_outcome"], "matched")
        self.assertEqual(soup["actual"]["name"], "Garden Soup")
        self.assertEqual(soup["association"]["disposition"], "primary")
        self.assertEqual(soup["ordered_price_options"],
                         [{"label": None, "amount": "8.50"}, {"label": None, "amount": "12.50"}])
        addon = self.row(case, "p1-addon")
        self.assertEqual(addon["role"], "qualifier")
        self.assertEqual(addon["recall_outcome"], "not_scored_role")
        self.assertIsNone(addon["price_outcome"])
        coffee = self.row(case, "p1-coffee")
        self.assertEqual(coffee["price_state"], "unknown")
        self.assertEqual(coffee["price_outcome"], "abstain")

    def test_name_equality_is_literal_not_fuzzy(self):
        variants = [
            ("GARDEN   SOUP", 4),
            ("Garden-Soup", 3),
            ("Garden Soup\u2122", 3),
            ("Garden So\u00fap", 3),
            ("Garden Soop", 3),
            ("Garden Soup!", 3),
        ]
        for name, expected in variants:
            with self.subTest(name=name):
                specs = copy.deepcopy(self.candidates)
                next(spec for spec in specs if spec["id"] == "cand-soup")["name"] = name
                capture = self.capture(candidates=specs)
                case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
                self.assertEqual(case["counts"]["name_correct"], expected)
                self.assertEqual(case["counts"]["asserted_candidates"], 4)

        entries = copy.deepcopy(self.entries)
        next(entry for entry in entries if entry["entry_id"] == "p1-soup")["name"] = "Stra\u00dfe"
        self.rewrite_reference(entries)
        specs = copy.deepcopy(self.candidates)
        next(spec for spec in specs if spec["id"] == "cand-soup")["name"] = "STRASSE"
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
        self.assertEqual(case["counts"]["name_correct"], 3,
                         "casefold expansion must not match lower()+whitespace-fold equality")

    def test_whole_price_group_requires_literal_scalar_and_currency(self):
        mutations = [
            {"price_text": "8.50 CAD"},
            {"price_text": "12.50 / 8.50 CAD"},
            {"price_text": "8.50 / 12.50 USD"},
            {"price_text": "8.50 / 12.50 CAD", "price_currency": "USD"},
            {"price_text": "8.50 / 12.50 CAD", "price_amount": "8.50"},
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                specs = copy.deepcopy(self.candidates)
                next(spec for spec in specs if spec["id"] == "cand-soup").update(mutation)
                capture = self.capture(candidates=specs)
                case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
                self.assertEqual(case["counts"]["price_matched"], 2)
                self.assertEqual(case["counts"]["price_wrong"], 1)
                self.assertEqual(case["counts"]["name_correct"], 4,
                                 "price failures are independent of the name assertion")
                self.assertEqual(self.row(case, "p1-soup")["price_outcome"], "wrong")

        entries = copy.deepcopy(self.entries)
        next(entry for entry in entries if entry["entry_id"] == "p1-soup").update(
            price_text="SMALL 8.50 / LARGE 12.50 CAD",
            ordered_price_options=[
                {"label": "SMALL", "amount": "8.50"},
                {"label": "LARGE", "amount": "12.50"},
            ],
        )
        self.rewrite_reference(entries)
        for literal, expected in (
            ("SMALL 8.50 / LARGE 12.50 CAD", 3),
            ("LARGE 12.50 / SMALL 8.50 CAD", 2),
            ("8.50 / 12.50 CAD", 2),
        ):
            with self.subTest(literal=literal):
                specs = copy.deepcopy(self.candidates)
                next(spec for spec in specs if spec["id"] == "cand-soup")["price_text"] = literal
                capture = self.capture(candidates=specs)
                case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
                self.assertEqual(case["counts"]["price_matched"], expected)

    def test_null_zero_and_full_group_null_scalar_stay_distinct(self):
        specs = copy.deepcopy(self.candidates)
        next(spec for spec in specs if spec["id"] == "cand-bread").update(
            price_text=None, price_amount=None, price_currency=None)
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
        self.assertEqual(case["counts"]["price_wrong"], 1)
        self.assertEqual(case["counts"]["unknown_correct"], 1,
                         "a known zero group cannot become an unknown abstention")
        self.assertEqual(self.row(case, "p1-bread")["price_outcome"], "wrong")

        specs = copy.deepcopy(self.candidates)
        next(spec for spec in specs if spec["id"] == "cand-soup")["price_amount"] = "0.00"
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
        self.assertEqual(case["counts"]["price_wrong"], 1)
        self.assertEqual(case["counts"]["price_matched"], 2)

        specs = copy.deepcopy(self.candidates)
        next(spec for spec in specs if spec["id"] == "cand-bread")["price_amount"] = "0.0"
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
        self.assertEqual(case["counts"]["price_matched"], 3,
                         "decimal-equivalent zero scalar representations still match")

        specs = copy.deepcopy(self.candidates)
        next(spec for spec in specs if spec["id"] == "cand-bread").update(
            price_text="0.0 CAD", price_amount="0.0")
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
        self.assertEqual(case["counts"]["price_wrong"], 1,
                         "the entire literal must match even when the scalar is equivalent")

    def test_unknown_price_abstention_and_unsupported_assertions(self):
        for invented in (
            {"price_text": "3.00", "price_amount": "3.00", "price_currency": "CAD"},
            {"price_text": "MP"},
        ):
            with self.subTest(invented=invented):
                specs = copy.deepcopy(self.candidates)
                next(spec for spec in specs if spec["id"] == "cand-coffee").update(invented)
                capture = self.capture(candidates=specs)
                case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
                self.assertEqual(case["counts"]["unknown_price_groups"], 1)
                self.assertEqual(case["counts"]["unknown_unsupported"], 1)
                self.assertEqual(case["counts"]["unknown_correct"], 0)
                self.assertEqual(self.row(case, "p1-coffee")["price_outcome"], "unsupported")

        capture = self.capture()
        omitted = [link for link in self.default_links() if link["candidate_id"] != "cand-coffee"]
        case = self.evaluate([self.captured("DEV-001", capture, omitted)])["cases"][0]
        self.assertEqual(case["counts"]["unassociated_candidates"], 1)
        self.assertEqual(case["counts"]["asserted_candidates"], 4)
        self.assertEqual(case["counts"]["name_correct"], 3)
        self.assertEqual(case["counts"]["unknown_missing"], 1)
        self.assertEqual(case["counts"]["unknown_correct"], 0)

        explicit = omitted + [
            {"candidate_id": "cand-coffee", "entry_id": None, "evidence_index": None},
        ]
        case = self.evaluate([self.captured("DEV-001", capture, explicit)])["cases"][0]
        self.assertEqual(case["counts"]["unassociated_candidates"], 1)
        self.assertEqual(case["counts"]["asserted_candidates"], 4)
        self.assertEqual(self.row(case, "p1-coffee")["price_outcome"], "missing")

    def test_zero_price_denominator_is_null_not_hundred_percent(self):
        entries = [
            self.entry("p1-coffee", "Coffee", page=1),
            self.entry("p2-note", "Note", page=2, role="qualifier", price_text="Ask staff"),
        ]
        self.rewrite_reference(entries)
        specs = [{"id": "cand-coffee", "name": "Coffee", "page": 1}]
        capture = self.capture(candidates=specs)
        links = [{"candidate_id": "cand-coffee", "entry_id": "p1-coffee", "evidence_index": 0}]
        result = self.evaluate([self.captured("DEV-001", capture, links)])
        case = result["cases"][0]
        self.assertEqual(case["counts"]["known_price_groups"], 0)
        self.assertEqual(case["counts"]["price_matched"], 0)
        rate = result["aggregates"]["overall"]["rates"]["price_completeness"]
        self.assertIsNone(rate["rate"])
        self.assertEqual(rate["status"], "N/A")
        self.assertEqual(rate["denominator"], 0)
        self.assertEqual(case["counts"]["unknown_price_groups"], 1)
        self.assertEqual(case["counts"]["unknown_correct"], 1)
        self.assertEqual(case["counts"]["reference_dishes"], 1)
        self.assertEqual(case["counts"]["reference_qualifiers"], 1)

    def test_first_candidate_consumes_entry_and_duplicate_never_improves(self):
        specs = copy.deepcopy(self.candidates) + [
            {"id": "cand-coffee-first", "name": "Not Coffee", "page": 1,
             "price_text": "9.99 CAD", "price_amount": "9.99", "price_currency": "CAD"},
            {"id": "cand-coffee-second", "name": "Coffee", "page": 1},
        ]
        links = [link for link in self.default_links() if link["candidate_id"] != "cand-coffee"]
        links.append({"candidate_id": "cand-coffee-first", "entry_id": "p1-coffee", "evidence_index": 0})
        links.append({"candidate_id": "cand-coffee-second", "entry_id": "p1-coffee", "evidence_index": 0})
        capture = self.capture(candidates=specs)
        first = self.evaluate([self.captured("DEV-001", capture, links)])["cases"][0]
        reversed_links = list(reversed(links))
        second = self.evaluate([self.captured("DEV-001", capture, reversed_links)])["cases"][0]

        for case in (first, second):
            self.assertEqual(case["counts"]["asserted_candidates"], 6)
            self.assertEqual(case["counts"]["unassociated_candidates"], 1)
            self.assertEqual(case["counts"]["duplicate_assertions"], 1)
            self.assertEqual(case["counts"]["name_correct"], 3,
                             "the later correct duplicate never becomes the scoreable assertion")
            self.assertEqual(case["counts"]["dish_correct"], 3)
            self.assertEqual(case["counts"]["dish_wrong"], 1)
            self.assertEqual(case["counts"]["unknown_unsupported"], 1)
            self.assertEqual(case["counts"]["unknown_correct"], 0)
        coffee = self.row(first, "p1-coffee")
        self.assertEqual(coffee["association"]["candidate_id"], "cand-coffee-first")
        self.assertEqual(coffee["association"]["disposition"], "primary")
        self.assertFalse(coffee["name_correct"])

    def test_repeated_names_keep_distinct_occurrence_identities(self):
        entries = copy.deepcopy(self.entries) + [self.entry("p1-coffee-2", "Coffee", page=1)]
        self.rewrite_reference(entries)
        specs = copy.deepcopy(self.candidates) + [
            {"id": "cand-coffee-two", "name": "Coffee", "page": 1},
        ]
        links = self.default_links() + [
            {"candidate_id": "cand-coffee-two", "entry_id": "p1-coffee-2", "evidence_index": 0},
        ]
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, links)])["cases"][0]
        self.assertEqual(case["counts"]["reference_dishes"], 5)
        self.assertEqual(case["counts"]["asserted_candidates"], 5)
        self.assertEqual(case["counts"]["name_correct"], 5)
        self.assertEqual(case["counts"]["dish_correct"], 5)
        self.assertNotEqual(self.row(case, "p1-coffee")["association"]["candidate_id"],
                            self.row(case, "p1-coffee-2")["association"]["candidate_id"])

    def test_selected_span_assigns_candidate_to_one_page(self):
        specs = copy.deepcopy(self.candidates)
        salad = next(spec for spec in specs if spec["id"] == "cand-salad")
        salad["spans"] = [
            (1, 0, len(self.page_texts[1])),
            (2, 0, len(self.page_texts[2])),
        ]
        links = self.default_links()
        next(link for link in links if link["candidate_id"] == "cand-salad")["evidence_index"] = 1
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, links)])["cases"][0]
        page_one = next(page for page in case["pages"] if page["page"] == 1)
        page_two = next(page for page in case["pages"] if page["page"] == 2)
        self.assertNotIn("cand-salad", page_one["actual_candidate_ids"])
        self.assertIn("cand-salad", page_two["actual_candidate_ids"])
        self.assertEqual(len(page_one["actual_candidate_ids"]), 3)
        self.assertEqual(len(page_two["actual_candidate_ids"]), 1)
        self.assertEqual(case["counts"]["name_correct"], 4)
        self.assertEqual(case["counts"]["price_matched"], 3)
        self.assertEqual(case["counts"]["wrong_page_assertions"], 0)
        self.assertEqual(self.row(case, "p2-salad")["association"]["evidence_index"], 1)

    def test_excluded_pages_are_enumerated_with_reason(self):
        entries = [entry for entry in self.entries if entry["page"] == 1]
        self.rewrite_reference(
            entries,
            excluded_pages=[{"page": 2, "reason": "Blank synthetic page."}],
        )
        capture = self.capture(candidates=self.candidates[:3])
        links = [link for link in self.default_links() if link["candidate_id"] != "cand-salad"]
        case = self.evaluate([self.captured("DEV-001", capture, links)])["cases"][0]
        page_two = next(page for page in case["pages"] if page["page"] == 2)
        self.assertTrue(page_two["excluded"])
        self.assertEqual(page_two["exclusion_reason"], "Blank synthetic page.")
        self.assertEqual(case["counts"]["pages_excluded"], 1)
        self.assertEqual(case["counts"]["reference_dishes"], 3)
        self.assertEqual(case["counts"]["reference_qualifiers"], 1)
        self.assertEqual(case["counts"]["asserted_candidates"], 3)

    def test_wrong_page_and_qualifier_links_are_visible_but_do_not_score(self):
        specs = copy.deepcopy(self.candidates)
        next(spec for spec in specs if spec["id"] == "cand-soup")["page"] = 2
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, self.default_links())])["cases"][0]
        self.assertEqual(case["counts"]["wrong_page_assertions"], 1)
        self.assertEqual(case["counts"]["name_correct"], 3)
        self.assertEqual(case["counts"]["dish_missing"], 1)
        self.assertEqual(case["counts"]["dish_wrong"], 0)
        self.assertEqual(case["counts"]["price_missing"], 1)
        self.assertEqual(case["counts"]["price_matched"], 2)
        soup = self.row(case, "p1-soup")
        self.assertEqual(soup["association"]["disposition"], "wrong_page")
        self.assertEqual(soup["association"]["actual_page"], 2)
        self.assertEqual(soup["recall_outcome"], "missing")
        page_two = next(page for page in case["pages"] if page["page"] == 2)
        self.assertEqual(page_two["counts"]["wrong_page_assertions"], 1)

        specs = copy.deepcopy(self.candidates) + [
            {"id": "cand-addon", "name": "Add Cheese", "page": 1,
             "price_text": "1.00 CAD", "price_amount": "1.00", "price_currency": "CAD"},
        ]
        links = self.default_links() + [
            {"candidate_id": "cand-addon", "entry_id": "p1-addon", "evidence_index": 0},
        ]
        capture = self.capture(candidates=specs)
        case = self.evaluate([self.captured("DEV-001", capture, links)])["cases"][0]
        self.assertEqual(case["counts"]["role_errors"], 1)
        self.assertEqual(case["counts"]["reference_dishes"], 4)
        self.assertEqual(case["counts"]["reference_qualifiers"], 1)
        self.assertEqual(case["counts"]["asserted_candidates"], 5)
        self.assertEqual(case["counts"]["name_correct"], 4)
        self.assertEqual(case["counts"]["name_wrong"], 1)
        addon = self.row(case, "p1-addon")
        self.assertEqual(addon["association"]["disposition"], "role_error")
        self.assertEqual(addon["recall_outcome"], "not_scored_role")

    def test_failed_skipped_and_missing_pages_keep_denominators(self):
        for status in ("failed", "skipped"):
            with self.subTest(status=status):
                capture = self.capture(candidates=self.candidates[:3], segment_status={2: status})
                links = [link for link in self.default_links() if link["candidate_id"] != "cand-salad"]
                result = self.evaluate([self.captured("DEV-001", capture, links)])
                case = result["cases"][0]
                page_two = next(page for page in case["pages"] if page["page"] == 2)
                self.assertEqual(page_two["segment_status"], status)
                if status == "failed":
                    self.assertTrue(page_two["segment_errors"])
                self.assertEqual(case["counts"]["asserted_candidates"], 3)
                self.assertEqual(case["counts"]["dish_missing"], 1)
                self.assertEqual(case["counts"]["price_missing"], 1)
                self.assertEqual(result["coverage"]["input_status"], "incomplete")

        capture = self.capture(candidates=self.candidates[:3],
                               page_texts={1: self.page_texts[1]})
        links = [link for link in self.default_links() if link["candidate_id"] != "cand-salad"]
        result = self.evaluate([self.captured("DEV-001", capture, links)])
        case = result["cases"][0]
        page_two = next(page for page in case["pages"] if page["page"] == 2)
        self.assertEqual(page_two["segment_status"], "missing")
        self.assertEqual(case["counts"]["dish_missing"], 1)
        self.assertEqual(case["counts"]["price_missing"], 1)
        self.assertEqual(result["coverage"]["pages_missing"], 1)

        capture = self.capture(report_errors=["Synthetic report error."])
        result = self.evaluate([self.captured("DEV-001", capture, self.default_links())])
        case = result["cases"][0]
        self.assertEqual(case["report"]["errors"], ["Synthetic report error."])
        self.assertEqual(case["counts"]["report_errors"], 1)
        self.assertEqual(result["coverage"]["reports_with_errors"], 1)
        self.assertEqual(result["coverage"]["input_status"], "incomplete")

    def test_unavailable_capture_retains_all_denominators(self):
        result = self.evaluate([self.unavailable("DEV-001", reason="not_attempted")])
        case = result["cases"][0]
        counts = case["counts"]
        self.assertEqual(case["state"], "unavailable")
        self.assertEqual(case["unavailable_reason"], "not_attempted")
        self.assertIsNone(case["report"])
        self.assertEqual(counts["asserted_candidates"], 0)
        self.assertEqual(counts["reference_dishes"], 4)
        self.assertEqual(counts["reference_qualifiers"], 1)
        self.assertEqual(counts["dish_missing"], 4)
        self.assertEqual(counts["known_price_groups"], 3)
        self.assertEqual(counts["price_missing"], 3)
        self.assertEqual(counts["unknown_price_groups"], 1)
        self.assertEqual(counts["unknown_missing"], 1)
        self.assertEqual(counts["name_correct"], 0)
        self.assertTrue(all(page["segment_status"] == "unavailable" for page in case["pages"]))
        self.assertEqual(result["coverage"]["cases_unavailable"], 1)
        self.assertEqual(result["coverage"]["input_status"], "incomplete")

    def test_empty_or_failed_capture_keeps_denominators_and_na_rates(self):
        capture = self.capture(candidates=[])
        result = self.evaluate([self.captured("DEV-001", capture, [])])
        case = result["cases"][0]
        self.assertEqual(case["counts"]["asserted_candidates"], 0)
        self.assertEqual(case["counts"]["reference_dishes"], 4)
        self.assertEqual(case["counts"]["dish_missing"], 4)
        self.assertEqual(case["counts"]["known_price_groups"], 3)
        self.assertEqual(case["counts"]["price_missing"], 3)
        self.assertEqual(case["counts"]["unknown_missing"], 1)
        precision = result["aggregates"]["overall"]["rates"]["name_precision"]
        self.assertIsNone(precision["rate"])
        self.assertEqual(precision["status"], "N/A")
        self.assertEqual(result["coverage"]["input_status"], "complete")

        capture = self.capture(candidates=[], report_status="failed",
                               report_errors=["Synthetic report failure."])
        result = self.evaluate([self.captured("DEV-001", capture, [])])
        case = result["cases"][0]
        self.assertEqual(case["report"]["status"], "failed")
        self.assertEqual(case["counts"]["report_errors"], 1)
        self.assertEqual(case["counts"]["dish_missing"], 4)
        self.assertEqual(case["counts"]["price_missing"], 3)
        self.assertEqual(result["coverage"]["input_status"], "incomplete")

    def test_hash_substitution_and_export_injection_fail_closed(self):
        capture = self.capture()
        valid = self.captured("DEV-001", capture, self.default_links())
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([valid], manifest_sha="0" * 64))

        reference_path = self.root / "DEV-001.reference.json"
        original_reference = reference_path.read_bytes()
        try:
            reference_path.write_bytes(original_reference + b" ")
            path = self.write_runs([valid])
            with self.assertRaises(ValueError):
                score(self.manifest_path, path)
        finally:
            reference_path.write_bytes(original_reference)

        source_path = self.root / "DEV-001.pdf"
        original_source = source_path.read_bytes()
        try:
            source_path.write_bytes(original_source + b" ")
            path = self.write_runs([valid])
            with self.assertRaises(ValueError):
                score(self.manifest_path, path)
        finally:
            source_path.write_bytes(original_source)

        tampered = copy.deepcopy(valid)
        tampered["report"] = {"path": capture["report"].name, "sha256": "0" * 64}
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([tampered]))

        tampered = copy.deepcopy(valid)
        tampered["candidates"] = {"path": capture["candidates"].name, "sha256": "0" * 64}
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([tampered]))

        export_path = capture["candidates"]
        original_export = export_path.read_bytes()
        try:
            payload = json.loads(original_export)
            payload["candidates"][0]["original"]["name"] = "Injected Name"
            export_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tampered = copy.deepcopy(valid)
            tampered["candidates"]["sha256"] = digest(export_path)
            with self.assertRaises(ValueError):
                score(self.manifest_path, self.write_runs([tampered]))
        finally:
            export_path.write_bytes(original_export)

        report_path = capture["report"]
        original_report = report_path.read_bytes()
        try:
            report_path.write_text(
                original_report.decode("utf-8").replace("Garden Soup", "Garden Stew"),
                encoding="utf-8",
            )
            tampered = copy.deepcopy(valid)
            tampered["report"]["sha256"] = digest(report_path)
            with self.assertRaises(ValueError):
                score(self.manifest_path, self.write_runs([tampered]))
        finally:
            report_path.write_bytes(original_report)

    def test_ledger_identity_duplicates_and_unknown_rows_fail_closed(self):
        capture = self.capture()
        valid_links = self.default_links()
        mutations = [
            valid_links + [{"candidate_id": "cand-soup", "entry_id": "p1-soup", "evidence_index": 0}],
            valid_links[:1] + [{"candidate_id": "missing-candidate", "entry_id": "p1-coffee",
                                "evidence_index": 0}],
            valid_links[:1] + [{"candidate_id": "cand-coffee", "entry_id": "missing-entry",
                                "evidence_index": 0}],
            valid_links[:1] + [{"candidate_id": "cand-coffee", "entry_id": "p1-coffee",
                                "evidence_index": None}],
            valid_links[:1] + [{"candidate_id": "cand-coffee", "entry_id": None,
                                "evidence_index": 0}],
            valid_links[:1] + [{"candidate_id": "cand-coffee", "entry_id": "p1-coffee",
                                "evidence_index": 9}],
        ]
        for links in mutations:
            with self.subTest(links=links):
                with self.assertRaises(ValueError):
                    score(self.manifest_path,
                          self.write_runs([self.captured("DEV-001", capture, links)]))

        for case in (
            self.unavailable("DEV-001", reason=None),
            self.unavailable("DEV-001", reason="not_attempted",
                             command=None) | {"report": {"path": "x", "sha256": "0" * 64}},
        ):
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    score(self.manifest_path, self.write_runs([case]))

        for field, value in (
            ("case_id", "unexpected"),
            ("input_route", "unexpected"),
            ("state", "unexpected"),
            ("unavailable_reason", "unexpected"),
            ("report", "unexpected"),
            ("candidates", "unexpected"),
            ("producer_command", None),
            ("associations", "unexpected"),
        ):
            with self.subTest(field=field):
                tampered = self.captured("DEV-001", capture, self.default_links())
                tampered[field] = value
                with self.assertRaises(ValueError):
                    score(self.manifest_path, self.write_runs([tampered]))

        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([], manifest_sha=None))

    def test_pending_reviews_never_produce_a_score(self):
        pending_reference = {"status": "pending", "reviewer": None, "decision_reference": None}
        self.rewrite_reference(self.entries, review=pending_reference)
        capture = self.capture()
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs(
                [self.captured("DEV-001", capture, self.default_links())]))

        self.rewrite_reference(self.entries, review={
            "status": "recorded",
            "reviewer": REFERENCE_REVIEWER,
            "decision_reference": "fixture-reference-review-1",
        })
        capture = self.capture()
        pending_association = {"status": "pending", "reviewer": None, "decision_reference": None}
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs(
                [self.captured("DEV-001", capture, self.default_links())],
                review=pending_association))

        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs(
                [self.captured("DEV-001", capture, self.default_links())],
                review={"status": "recorded", "reviewer": PREPARED_BY,
                        "decision_reference": "same-person"}))

        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs(
                [self.captured("DEV-001", capture, self.default_links())],
                review={"status": "recorded", "reviewer": ASSOCIATION_REVIEWER,
                        "decision_reference": None}))

    def test_missing_extra_and_duplicate_cases_fail_closed(self):
        holdout_pages = {1: "HOLD SOUP 4.00 CAD"}
        holdout_entries = [self.entry("h1-soup", "Soup", page=1, price_text="4.00 CAD",
                                      amount="4.00", options=("4.00",), currency="CAD")]
        self.add_case("HOLD-002", holdout_entries, holdout_pages, split="holdout")
        capture = self.capture()
        dev_run = self.captured("DEV-001", capture, self.default_links())
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([dev_run]))

        extra = self.unavailable("OTHER-999")
        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([dev_run, extra]))

        with self.assertRaises(ValueError):
            score(self.manifest_path, self.write_runs([dev_run, dev_run]))

    def test_split_and_route_aggregates_are_summed_not_averaged(self):
        dev_pages = {1: "DEV SOUP 8.50 CAD"}
        dev_entries = [self.entry("a1-soup", "Garden Soup", page=1, price_text="8.50 CAD",
                                  amount="8.50", options=("8.50",), currency="CAD")]
        hold_pages = {1: "HOLD SOUP A SOUP B"}
        hold_entries = [self.entry("b1-soup", "Soup A", page=1),
                        self.entry("b2-soup", "Soup B", page=1)]
        self.cases.clear()
        self.add_case("AGG-DEV", dev_entries, dev_pages, split="development")
        self.add_case("AGG-HOLD", hold_entries, hold_pages, split="holdout")

        dev_capture = self.capture("AGG-DEV",
                                   [{"id": "a1-cand", "name": "Garden Soup", "page": 1,
                                     "price_text": "8.50 CAD", "price_amount": "8.50",
                                     "price_currency": "CAD"}],
                                   page_texts=dev_pages)
        dev_run = self.captured(
            "AGG-DEV", dev_capture,
            [{"candidate_id": "a1-cand", "entry_id": "a1-soup", "evidence_index": 0}],
            route="pdf")

        hold_capture = self.capture(
            "AGG-HOLD",
            [{"id": "b1-cand", "name": "Soup A", "page": 1},
             {"id": "b2-cand", "name": "Not Soup B", "page": 1}],
            page_texts=hold_pages)
        hold_run = self.captured(
            "AGG-HOLD", hold_capture,
            [{"candidate_id": "b1-cand", "entry_id": "b1-soup", "evidence_index": 0},
             {"candidate_id": "b2-cand", "entry_id": "b2-soup", "evidence_index": 0}],
            route="image")

        result = score(self.manifest_path, self.write_runs([dev_run, hold_run]))
        aggregates = result["aggregates"]
        self.assertEqual(set(aggregates["by_split"]), {"development", "holdout"})
        self.assertEqual(set(aggregates["by_input_route"]), {"pdf", "image"})
        dev = aggregates["by_split"]["development"]["counts"]
        hold = aggregates["by_split"]["holdout"]["counts"]
        overall = aggregates["overall"]["counts"]
        self.assertEqual(dev["name_correct"], 1)
        self.assertEqual(dev["asserted_candidates"], 1)
        self.assertEqual(hold["name_correct"], 1)
        self.assertEqual(hold["asserted_candidates"], 2)
        self.assertEqual(overall["name_correct"], 2)
        self.assertEqual(overall["asserted_candidates"], 3)
        self.assertAlmostEqual(aggregates["overall"]["rates"]["name_precision"]["rate"], 2 / 3)
        self.assertAlmostEqual(hold["name_correct"] / hold["asserted_candidates"], 0.5)
        self.assertTrue(aggregates["overall"]["pooled_across_splits"])
        self.assertEqual(overall["name_correct"],
                         sum(case["counts"]["name_correct"] for case in result["cases"]))

    # -------------------------------------------------------------------- CLI
    def test_module_cli_writes_private_create_only_receipt_and_sanitizes_failures(self):
        capture = self.capture()
        runs_path = self.write_runs([self.captured("DEV-001", capture, self.default_links())])
        output = self.root / "receipt.json"
        source_dir = Path(qa02_strict_score.__file__).resolve().parents[1]
        tests_dir = Path(__file__).resolve().parent
        env = os.environ.copy()
        parts = [str(source_dir), str(tests_dir)]
        parts.extend(part for part in env.get("PYTHONPATH", "").split(os.pathsep) if part)
        env["PYTHONPATH"] = os.pathsep.join(parts)
        audit = self.root / "attempts.log"
        env["SOCKET_GUARD_AUDIT_FILE"] = str(audit)

        def invoke(target):
            return subprocess.run(
                [sys.executable, "-m", "peekaplate_processing.qa02_strict_score",
                 "--manifest", str(self.manifest_path), "--runs", str(runs_path),
                 "--output", str(target)],
                capture_output=True, text=True, cwd=str(self.root), env=env,
            )

        completed = invoke(output)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for leaked in (MARKER, "Garden Soup", str(self.root)):
            self.assertNotIn(leaked, completed.stdout + completed.stderr)
        summary = json.loads(completed.stdout)
        self.assertEqual(summary["status"], "SCORED")
        self.assertEqual(summary["acceptance"], "NOT ESTABLISHED")
        self.assertEqual(summary["release_acceptance"], "NOT ESTABLISHED")
        self.assertTrue(output.exists())
        if sys.platform.startswith("linux"):
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        receipt = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(receipt["provenance"]["scorer"]["module_sha256"],
                         digest(Path(qa02_strict_score.__file__)))
        self.assertEqual(receipt["inputs"]["manifest_sha256"], digest(self.manifest_path))
        self.assertEqual(receipt["inputs"]["runs_sha256"], digest(runs_path))
        self.assertFalse(audit.exists() and audit.read_text(encoding="utf-8").strip())

        before = output.read_bytes()
        again = invoke(output)
        self.assertNotEqual(again.returncode, 0)
        self.assertEqual(output.read_bytes(), before)
        for leaked in (MARKER, str(self.root)):
            self.assertNotIn(leaked, again.stdout + again.stderr)

        bad_runs = self.root / "bad-runs.json"
        bad_runs.write_text(json.dumps({
            "schema_version": "qa02.runs.v1",
            "manifest_sha256": MARKER,
        }), encoding="utf-8")
        missing_output = self.root / "missing.json"
        env["SOCKET_GUARD_AUDIT_FILE"] = str(audit)
        completed = subprocess.run(
            [sys.executable, "-m", "peekaplate_processing.qa02_strict_score",
             "--manifest", str(self.manifest_path), "--runs", str(bad_runs),
             "--output", str(missing_output)],
            capture_output=True, text=True, cwd=str(self.root), env=env,
        )
        self.assertEqual(completed.returncode, 1)
        self.assertFalse(missing_output.exists())
        for leaked in (MARKER, str(self.root)):
            self.assertNotIn(leaked, completed.stdout + completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["status"], "FAIL")

        protected = self.root / "protected.json"
        protected.write_text("do not replace", encoding="utf-8")
        os.chmod(protected, 0o644)
        completed = invoke(protected)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(protected.read_text(encoding="utf-8"), "do not replace")

        # Argument errors must not bypass the same private-input diagnostics.
        complete_args = [
            "--manifest", str(self.manifest_path), "--runs", str(runs_path),
            "--output", str(self.root / "argument-error.json"),
        ]
        for arguments in (complete_args + ["--unexpected", MARKER], ["--manifest", MARKER]):
            with self.subTest(arguments="invalid CLI shape"):
                completed = subprocess.run(
                    [sys.executable, "-m", "peekaplate_processing.qa02_strict_score", *arguments],
                    capture_output=True, text=True, cwd=str(self.root), env=env,
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(completed.stderr, "")
                self.assertNotIn(MARKER, completed.stdout + completed.stderr)
                self.assertEqual(json.loads(completed.stdout)["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()