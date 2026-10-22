import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate_menu import evaluate_dataset, evaluate_report, write_new_json


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.text = "Synthetic Soup 8.50 CAD"
        self.source_hash = hashlib.sha256(self.text.encode()).hexdigest()
        self.draft = {"name": "Synthetic Soup", "description": None, "category": None, "price_amount": "8.50", "price_currency": "CAD", "ingredients": None, "status": "needs_review", "source_text": self.text}
        self.report = {"schema_version": 1, "pipeline_version": "2", "status": "complete", "source": {"sha256": self.source_hash, "kind": "image", "snapshot_base64": base64.b64encode(self.text.encode()).decode()}, "drafts": [self.draft], "segments": [{"segment_id": "page-1", "text": self.text}], "evidence": [{"draft_id": "draft-1", "draft_index": 0, "spans": [{"segment_id": "page-1", "start": 0, "end": len(self.text)}]}]}
        self.labels = {"source_sha256": self.source_hash, "expected": [{"id": "dish-1", "match_draft_id": "draft-1", "fields": {key: self.draft[key] for key in ("name", "description", "category", "price_amount", "price_currency", "ingredients")}}]}

    def test_correct_fields_and_source_evidence_do_not_grant_acceptance(self):
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["field_errors"], [])
        self.assertEqual(result["provenance_errors"], [])
        self.assertTrue(result["acceptance"].startswith("not_assessed"))
        self.assertEqual(result["fields"]["price_amount"]["correct"], 1)

    def test_reports_each_missing_incorrect_unsupported_and_invalid_field(self):
        self.draft.update(name="Different Soup", price_amount=None, ingredients=["nuts"], category="")
        errors = {error["field"]: error["reason"] for error in evaluate_report(self.report, self.labels)["field_errors"]}
        self.assertEqual(errors, {"name": "incorrect", "price_amount": "missing", "ingredients": "unsupported", "category": "invalid"})

    def test_wrong_name_does_not_hide_the_prediction_by_matching_names(self):
        self.draft["name"] = "Misread Soup"
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["missed_dishes"], 0)
        self.assertEqual(result["field_errors"][0]["field"], "name")

    def test_missing_dish_is_counted_even_when_some_expected_fields_are_unknown(self):
        self.labels["expected"][0]["match_draft_id"] = None
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["missed_dishes"], 1)
        self.assertEqual(result["extra_draft_ids"], ["draft-1"])
        self.assertEqual(len(result["field_errors"]), 6)

    def test_duplicate_or_nonexistent_alignment_is_rejected(self):
        self.labels["expected"].append({**self.labels["expected"][0], "id": "dish-2"})
        with self.assertRaises(ValueError):
            evaluate_report(self.report, self.labels)
        self.labels["expected"] = [self.labels["expected"][0]]
        self.labels["expected"][0]["match_draft_id"] = "missing"
        with self.assertRaises(ValueError):
            evaluate_report(self.report, self.labels)

    def test_decimal_equality_and_unknown_empty_ingredients_are_distinct(self):
        self.draft["price_amount"] = "8.500"
        self.draft["ingredients"] = []
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["fields"]["price_amount"]["correct"], 1)
        self.assertEqual(result["fields"]["ingredients"]["invalid"], 1)

    def test_corrupt_snapshot_bad_regions_and_review_state_are_visible(self):
        self.report["source"]["snapshot_base64"] = "invalid"
        self.report["evidence"][0]["spans"][0]["end"] = 1000
        self.draft["status"] = "approved"
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["provenance_errors"], ["source_snapshot_mismatch", "draft_0_invalid_source_spans", "draft_0_invalid_review_state"])

    def test_incomplete_extraction_is_not_hidden_by_matching_fields(self):
        self.report["status"] = "incomplete"
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["extraction_status"], "incomplete")
        self.assertTrue(result["acceptance"].startswith("not_assessed"))

    def test_source_revision_mismatch_fails_before_scoring(self):
        self.labels["source_sha256"] = "a" * 64
        with self.assertRaises(ValueError):
            evaluate_report(self.report, self.labels)

    def test_failed_acquisition_remains_a_missing_dish_with_unverified_source(self):
        self.report.update(source=None, status="failed", drafts=[], evidence=[], segments=[])
        self.labels["expected"][0]["match_draft_id"] = None
        self.labels["source_kind"] = "image"
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["missed_dishes"], 1)
        self.assertEqual(result["provenance_errors"], ["source_unavailable"])
        self.assertFalse(result["source_identity_verified"])
        self.assertEqual(result["source_kind"], "image")
        self.assertEqual(result["extraction_status"], "failed")

    def test_followed_menu_snapshots_are_verified_separately_from_root_page(self):
        data = b"synthetic-linked-menu-pdf"
        self.report["segments"][0]["metadata"] = {"source_sha256": hashlib.sha256(data).hexdigest(), "source_snapshot_base64": base64.b64encode(data).decode()}
        self.assertEqual(evaluate_report(self.report, self.labels)["provenance_errors"], [])
        self.report["segments"][0]["metadata"]["source_snapshot_base64"] = base64.b64encode(b"changed").decode()
        errors = evaluate_report(self.report, self.labels)["provenance_errors"]
        self.assertIn("linked_source_snapshot_mismatch", errors)
        self.assertIn("linked_source_snapshot_unverified", errors)

    def test_result_preserves_extraction_mode_model_and_engine(self):
        self.report.update(extraction_mode="ai", extraction_model="synthetic-version", ocr_engine=3)
        result = evaluate_report(self.report, self.labels)
        self.assertEqual(result["extraction_mode"], "ai")
        self.assertEqual(result["extraction_model"], "synthetic-version")
        self.assertEqual(result["ocr_engine"], 3)

    def test_frozen_dataset_cli_groups_conditions_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report_path = root / "report.json"
            report_path.write_text(json.dumps(self.report))
            manifest = {"schema_version": 1, "dataset_version": "synthetic-v1", "environment": "fixture", "reviewer": "synthetic-test-labels-not-human-signoff", "reviewed_at": "2026-10-21T00:00:00Z", "cases": [{"id": "case-1", "conditions": ["rotated", "low_contrast"], "report_path": "report.json", "report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(), **self.labels}]}
            path = root / "dataset.json"
            path.write_text(json.dumps(manifest))
            result = evaluate_dataset(path)
            self.assertEqual(result["by_source_condition"]["image:rotated"]["cases"], 1)
            self.assertEqual(result["cases"][0]["report_sha256"], manifest["cases"][0]["report_sha256"])
            self.assertEqual(len(result["dataset_sha256"]), 64)
            self.assertEqual(result["by_source_condition"]["image:low_contrast"]["field_errors"], 0)
            command = [sys.executable, str(Path(__file__).resolve().parents[1] / "evaluate_menu.py"), "--dataset", str(path), "--output", str(root / "errors.json")]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            original = (root / "errors.json").read_bytes()
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
            self.assertEqual((root / "errors.json").read_bytes(), original)
            report_path.write_text("{}")
            with self.assertRaises(ValueError):
                evaluate_dataset(path)

    def test_private_output_preserves_existing_result(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            write_new_json({"result": "first"}, path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_new_json({"result": "second"}, path)
            self.assertEqual(json.loads(path.read_text()), {"result": "first"})


if __name__ == "__main__":
    unittest.main()
