import contextlib
import copy
import io
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import pymupdf

from peekaplate_processing.qa02_reference import digest, freeze, main, read_json, validate_manifest


class QA02ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.pdf"
        with pymupdf.open() as document:
            document.new_page().insert_text((30, 30), "Soup 8.50 / 12.50 CAD; Bread 0.00 CAD; Coffee")
            document.new_page()
            document.save(self.source)
        self.reference = self.root / "reference.json"
        self.ref = {
            "schema_version": "qa02.reference.v1", "reference_version": "synthetic-v1",
            "authored_by": "fixture-author", "annotation_method": "source_only",
            "review": {"status": "pending", "reviewer": None, "decision_reference": None},
            "entries": [self.entry("soup", "Soup", "8.50 / 12.50 CAD", None, ["8.50", "12.50"]),
                        self.entry("bread", "Bread", "0.00 CAD", "0.00", ["0.00"]),
                        self.entry("coffee", "Coffee", None, None, [])],
            "excluded_pages": [{"page": 2, "reason": "Intentionally blank synthetic page"}],
        }
        self.save_reference()
        source_hash = digest(self.source)
        self.manifest = {
            "schema_version": "qa02.manifest.v1", "dataset_version": "test-v1",
            "frozen_at": "2026-11-13T00:00:00+00:00", "cases": [{
                "case_id": "DEV-001", "split": "development", "source_path": "source.pdf",
                "source_sha256": source_hash, "original_source_sha256": source_hash,
                "page_count": 2, "previously_inspected": True,
                "source_permission": "Generated synthetic fixture",
                "reference_path": "reference.json", "reference_sha256": digest(self.reference),
                "reference_version": "synthetic-v1",
            }],
        }

    def entry(self, identity, name, text, amount, options):
        return {"entry_id": identity, "page": 1, "section": "Menu", "location": "top line",
                "role": "dish", "name": name, "description": None, "price_text": text,
                "price_amount": amount, "scalar_null_reason": "Multiple printed options" if len(options)>1 else "No price printed" if not options else None,
                "ordered_price_options": [{"label": None, "amount": value} for value in options],
                "currency": "CAD" if text else None}

    def save_reference(self):
        self.reference.write_text(json.dumps(self.ref), encoding="utf-8")
        if hasattr(self, "manifest"):
            self.manifest["cases"][0]["reference_sha256"] = digest(self.reference)

    def check(self, **kwargs):
        return validate_manifest(self.manifest, self.root, **kwargs)

    def test_valid_bytes_are_integrity_only_with_pending_review_and_no_holdouts(self):
        result = self.check()
        self.assertEqual(result["entries"], 3)
        self.assertEqual(result["splits"]["holdout"], 0)
        self.assertEqual(result["pending_review_cases"], ["DEV-001"])
        self.assertEqual(result["model_quality_evaluation"], "NOT RUN")
        self.assertEqual(result["release_acceptance"], "NOT ESTABLISHED")
        with self.assertRaisesRegex(ValueError, "review.*pending"):
            self.check(require_reviewed=True)

    def test_image_sources_are_one_page_and_keep_the_same_review_boundary(self):
        with pymupdf.open(self.source) as document:
            image = document[0].get_pixmap().tobytes("png")
        path = self.root / "source.png"
        path.write_bytes(image)
        self.manifest["cases"][0].update(source_path="source.png", source_sha256=digest(path), page_count=1)
        self.ref["excluded_pages"] = []
        self.save_reference()
        self.assertEqual(self.check()["entries"],3)

    def test_json_input_size_is_bounded_before_parsing(self):
        path = self.root / "oversized.json"
        path.write_bytes(b" " * 2_000_001)
        with self.assertRaisesRegex(ValueError,"2 MB"):
            read_json(path)

    def test_source_or_reference_byte_tampering_is_rejected(self):
        original = self.reference.read_bytes()
        self.reference.write_bytes(original + b" ")
        with self.assertRaisesRegex(ValueError, "reference hash"):
            self.check()
        self.reference.write_bytes(original)
        with self.source.open("ab") as handle:
            handle.write(b" ")
        with self.assertRaisesRegex(ValueError, "source hash"):
            self.check()

    def test_inspected_sources_cannot_be_holdouts(self):
        self.manifest["cases"][0]["split"] = "holdout"
        with self.assertRaisesRegex(ValueError, "inspected"):
            self.check()

    def test_original_source_family_prevents_variant_holdout_leakage(self):
        second = copy.deepcopy(self.manifest["cases"][0])
        second.update(case_id="HOLD-001", split="holdout", previously_inspected=False)
        other = self.root / "variant.pdf"
        other.write_bytes(self.source.read_bytes() + b" ")
        second.update(source_path="variant.pdf", source_sha256=digest(other))
        self.manifest["cases"].append(second)
        with self.assertRaisesRegex(ValueError, "leakage"):
            self.check()

    def test_invalid_split_and_duplicate_cases_are_rejected(self):
        self.manifest["cases"].append(copy.deepcopy(self.manifest["cases"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.check()
        self.manifest["cases"].pop()
        self.manifest["cases"][0]["split"] = "test"
        with self.assertRaises(ValueError):
            self.check()

    def test_real_source_page_count_and_all_page_dispositions_are_checked(self):
        self.manifest["cases"][0]["page_count"] = 1
        with self.assertRaisesRegex(ValueError, "page count"):
            self.check()
        self.manifest["cases"][0]["page_count"] = 2
        self.ref["excluded_pages"] = []
        self.save_reference()
        with self.assertRaisesRegex(ValueError, "every source page"):
            self.check()

    def test_invalid_occurrences_and_excluded_annotated_pages_reject(self):
        self.ref["entries"].append(copy.deepcopy(self.ref["entries"][0]))
        self.save_reference()
        with self.assertRaisesRegex(ValueError, "duplicate reference"):
            self.check()
        self.ref["entries"].pop()
        self.ref["excluded_pages"].append({"page": 1, "reason": "invalid exclusion"})
        self.save_reference()
        with self.assertRaisesRegex(ValueError, "annotated page"):
            self.check()

    def test_repeated_literal_names_keep_distinct_occurrence_ids(self):
        self.ref["entries"][1]["name"] = "Soup"
        self.save_reference()
        self.assertEqual(self.check()["entries"], 3)

    def test_multi_price_scalar_zero_and_unknown_are_not_interchangeable(self):
        self.ref["entries"][0]["price_amount"] = "8.50"
        self.save_reference()
        with self.assertRaisesRegex(ValueError, "multi-price"):
            self.check()
        self.ref["entries"][0]["price_amount"] = None
        self.ref["entries"][1]["price_amount"] = None
        self.save_reference()
        with self.assertRaisesRegex(ValueError, "explicit null reason"):
            self.check()

    def test_qualified_single_price_can_explicitly_abstain_from_a_dish_scalar(self):
        entry = self.ref["entries"][1]
        entry.update(price_text="8 EACH", price_amount=None,
                     ordered_price_options=[{"label":"EACH","amount":"8"}],
                     scalar_null_reason="Printed per-unit qualifier; no unambiguous dish-level scalar")
        self.save_reference()
        self.assertEqual(self.check()["entries"],3)

    def test_reference_replacement_after_source_validation_is_not_consumed(self):
        original_open = pymupdf.open
        def replace_reference(*args, **kwargs):
            altered = copy.deepcopy(self.ref)
            altered["entries"].append(self.entry("extra","Unsupported",None,None,[]))
            self.reference.write_text(json.dumps(altered),encoding="utf-8")
            return original_open(*args, **kwargs)
        with patch('peekaplate_processing.qa02_reference.pymupdf.open', side_effect=replace_reference):
            try:
                result = self.check()
            except ValueError:
                return  # Rejecting changed bytes is also safe.
        self.assertEqual(result["entries"],3, "Only the verified immutable reference bytes may be parsed")

    def test_reference_version_and_freeze_timezone_are_checked(self):
        self.manifest["cases"][0]["reference_version"] = "other"
        with self.assertRaisesRegex(ValueError, "version mismatch"):
            self.check()
        self.manifest["cases"][0]["reference_version"] = "synthetic-v1"
        self.manifest["frozen_at"] = "2026-11-13"
        with self.assertRaisesRegex(ValueError, "timezone"):
            self.check()

    def test_recorded_review_requires_other_reviewer_and_does_not_authenticate_identity(self):
        self.ref["review"] = {"status": "recorded", "reviewer": "fixture-author", "decision_reference": "review-1"}
        self.save_reference()
        with self.assertRaisesRegex(ValueError, "different reviewer"):
            self.check(require_reviewed=True)
        self.ref["review"]["reviewer"] = "fixture-reviewer"
        self.save_reference()
        self.assertFalse(self.check(require_reviewed=True)["review_identity_authenticated"])

    def test_freeze_is_create_only_and_does_not_repair_stale_hashes(self):
        template = self.root / "template.json"
        for key in ("source_sha256", "reference_sha256", "original_source_sha256"):
            self.manifest["cases"][0][key] = None
        template.write_text(json.dumps(self.manifest), encoding="utf-8")
        output = self.root / "frozen.json"
        freeze(template, output)
        self.assertEqual(validate_manifest(json.loads(output.read_text()), self.root)["integrity"], "PASS")
        with self.assertRaises(FileExistsError):
            freeze(template, output)
        self.manifest["cases"][0]["reference_sha256"] = "f" * 64
        template.write_text(json.dumps(self.manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "mismatched"):
            freeze(template, self.root / "new.json")

    def test_cli_failure_is_nonzero_and_does_not_print_private_contents(self):
        path = self.root / "manifest.json"
        self.manifest["cases"][0]["source_permission"] = "PRIVATE-CONTENT"
        self.manifest["cases"][0]["page_count"] = 0
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = main(["verify", str(path)])
        self.assertEqual(status, 1)
        self.assertNotIn("PRIVATE-CONTENT", out.getvalue())
        self.assertNotIn(str(self.root), out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["integrity"], "FAIL")

    def test_cli_pending_review_explains_the_next_action_without_raw_validation_details(self):
        path = self.root / "manifest.json"
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = main(["verify", str(path), "--require-reviewed"])
        self.assertEqual(status, 1)
        self.assertIn("review is still pending", json.loads(out.getvalue())["error"])


if __name__ == "__main__":
    unittest.main()
