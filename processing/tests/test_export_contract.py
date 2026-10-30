import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.review_candidates import (
    ReviewCandidateResult,
    export_review_candidates,
    prepare_review_candidates,
)
from peekaplate_processing.schemas import MenuExtractionResult

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "review-candidates"
SPANS = json.loads((Path(__file__).resolve().parent / "fixtures" / "source-spans.json").read_text())


class ExportContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.raw_v1 = json.loads((FIXTURES / "representative-extraction.json").read_text())
        self.expected_v1 = json.loads((FIXTURES / "representative-candidates.json").read_text())
        self.raw_v2 = json.loads((FIXTURES / "representative-extraction-v2.json").read_text())
        self.expected_v2 = json.loads((FIXTURES / "representative-candidates-v2.json").read_text())
        self.box_candidates = json.loads((FIXTURES / "box-evidence-candidates.json").read_text())

    def test_version_unicode_identity_roundtrip(self) -> None:
        # 1) Legacy (1, "2") and current (2, "3") round-trip identically
        for raw, expected in [(self.raw_v1, self.expected_v1), (self.raw_v2, self.expected_v2)]:
            report = MenuExtractionResult.model_validate(raw)
            exported = prepare_review_candidates(report)
            dumped = json.loads(exported.model_dump_json())
            self.assertEqual(dumped, expected)
            reloaded = ReviewCandidateResult.model_validate_json(json.dumps(dumped))
            self.assertEqual(reloaded, exported)

        # 2) Decimal strings, zero, and null prices preserved
        amounts = [c.original.price_amount for c in ReviewCandidateResult.model_validate(self.expected_v2).candidates]
        self.assertEqual([str(a) if a is not None else None for a in amounts], [None, None, "0.00"])
        v1_amounts = [c.original.price_amount for c in ReviewCandidateResult.model_validate(self.expected_v1).candidates]
        self.assertEqual([str(a) if a is not None else None for a in v1_amounts], ["8.50", None, "0.00"])

        # 3) Non-BMP Unicode spans round-trip by code-point indexing and reject UTF-16 indexing
        for span in SPANS:
            data = copy.deepcopy(self.raw_v2)
            data["segments"][0]["text"] = span["text"]
            for draft in data["drafts"]:
                draft["source_text"] = span["evidence_text"]
            for ev in data["evidence"]:
                ev["spans"][0].update(span["code_point_span"])
            valid_result = prepare_review_candidates(MenuExtractionResult.model_validate(data))
            self.assertEqual(valid_result.candidates[0].original.source_text, span["evidence_text"])

            bad = copy.deepcopy(data)
            for ev in bad["evidence"]:
                ev["spans"][0].update(span["utf16_span"])
            with self.assertRaises(ValueError):
                prepare_review_candidates(MenuExtractionResult.model_validate(bad))

        # 4) Candidate reordering preserves stable extraction_id and candidate_id -> original identity
        reordered = copy.deepcopy(self.raw_v2)
        reordered["drafts"].reverse()
        reordered["evidence"].reverse()
        for idx, ev in enumerate(reordered["evidence"]):
            ev["draft_index"] = idx
        base_res = prepare_review_candidates(MenuExtractionResult.model_validate(self.raw_v2))
        reordered_res = prepare_review_candidates(MenuExtractionResult.model_validate(reordered))
        self.assertEqual(reordered_res.extraction_id, base_res.extraction_id)
        self.assertEqual(
            {c.candidate_id: c.original for c in reordered_res.candidates},
            {c.candidate_id: c.original for c in base_res.candidates},
        )

    def test_invalid_evidence_matrix(self) -> None:
        mutations = [
            # Invalid mixed version pairs
            lambda r: r.update(schema_version=1, pipeline_version="3"),
            lambda r: r.update(schema_version=2, pipeline_version="2"),
            # Legacy v1 carrying v2 fields
            lambda r: (r.update(schema_version=1, pipeline_version="2"), r["drafts"][0].update(subcategory="SOUPS")),
            # Missing, duplicate, and orphan evidence joins
            lambda r: r["evidence"].pop(),
            lambda r: r["evidence"].append(copy.deepcopy(r["evidence"][0])),
            lambda r: r["evidence"][0].update(draft_index=99),
            lambda r: r["evidence"][1].update(draft_id=r["evidence"][0]["draft_id"]),
            # Reversed, out-of-range spans and source-text mismatches
            lambda r: r["evidence"][0]["spans"][0].update(start=10, end=5),
            lambda r: r["evidence"][0]["spans"][0].update(start=0, end=99999),
            lambda r: r["drafts"][0].update(source_text="Tampered dish text not in segment"),
            # Failed or skipped evidence references or ready segment carrying error
            lambda r: r["evidence"][0]["spans"][0].update(segment_id=r["segments"][1]["segment_id"]),
            lambda r: r["evidence"][0]["spans"][0].update(segment_id=r["segments"][2]["segment_id"]),
            lambda r: r["segments"][0].update(error="Unresolved OCR error on ready segment"),
            # Snapshot hash / size mismatch
            lambda r: r["source"].update(size_bytes=r["source"]["size_bytes"] + 1),
            lambda r: r["source"].update(sha256="0" * 64, source_id="sha256:" + "0" * 64),
        ]
        for idx, mutate in enumerate(mutations):
            with self.subTest(mutation_index=idx):
                sample = copy.deepcopy(self.raw_v2)
                mutate(sample)
                with self.assertRaises(ValueError):
                    prepare_review_candidates(MenuExtractionResult.model_validate(sample))

    def test_box_provenance_validating_boundary(self) -> None:
        # Build a valid extraction report with box evidence
        valid_box_report = copy.deepcopy(self.raw_v2)
        valid_box_report["drafts"] = [valid_box_report["drafts"][0]]
        valid_box_report["drafts"][0]["price_text"] = "8.50"
        valid_box_report["drafts"][0]["price_amount"] = "8.50"
        valid_box_report["drafts"][0]["price_currency"] = None
        valid_box_report["evidence"] = [valid_box_report["evidence"][0]]
        valid_box_report["segments"][0]["method"] = "ocr_space_engine3"
        valid_box_report["segments"][0]["metadata"] = {
            "width": 600,
            "height": 800,
            "coordinate_space": "page_points",
            "ocr_coordinate_space": "uploaded_image_pixels",
            "ocr_region_status": "available",
            "upload_width": 600,
            "upload_height": 800,
            "ocr_regions": [
                {"text": "8.50", "left": 10.25, "top": 20, "width": 30.5, "height": 12},
            ],
        }
        valid_box_report["evidence"][0]["box_evidence"] = [
            {
                "page_number": 1,
                "saved_region_index": 0,
                "text": "8.50",
                "box": {"left": 10.25, "top": 20, "width": 30.5, "height": 12},
            }
        ]
        prepared = prepare_review_candidates(MenuExtractionResult.model_validate(valid_box_report))
        reloaded = ReviewCandidateResult.model_validate_json(prepared.model_dump_json())
        cid = reloaded.candidates[0].candidate_id
        self.assertEqual(
            reloaded.segments[0].metadata["candidate_box_evidence"][cid][0]["box"],
            {"left": 10.25, "top": 20, "width": 30.5, "height": 12},
        )

        # Boundary check: Python ReviewCandidateResult and prepare_review_candidates MUST reject
        # tampered box literal, fractional coordinate, saved_region_index, and candidate mapping.
        tamperings = [
            lambda d: d["segments"][0]["metadata"]["candidate_box_evidence"][cid][0].update(text="9.50"),
            lambda d: d["segments"][0]["metadata"]["candidate_box_evidence"][cid][0]["box"].update(left=11.25),
            lambda d: d["segments"][0]["metadata"]["candidate_box_evidence"][cid][0].update(saved_region_index=1),
            lambda d: d["segments"][0]["metadata"].update(
                candidate_box_evidence={"draft:nonexistent": d["segments"][0]["metadata"]["candidate_box_evidence"][cid]}
            ),
        ]
        base_exported = json.loads(prepared.model_dump_json())
        for idx, tamper in enumerate(tamperings):
            with self.subTest(tamper_index=idx):
                mutated = copy.deepcopy(base_exported)
                tamper(mutated)
                with self.assertRaises(ValueError):
                    ReviewCandidateResult.model_validate(mutated)

    def test_immutability_and_create_only(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            in_path = root / "extraction.json"
            out_path = root / "review-candidates.json"
            in_path.write_text(json.dumps(self.raw_v2))
            before_bytes = in_path.read_bytes()
            in_memory = MenuExtractionResult.model_validate(self.raw_v2)
            in_memory_snapshot = in_memory.model_dump(mode="json")

            # Exporter makes zero OCR or LLM calls and does not mutate input report or file
            with patch("peekaplate_processing.ocr_space.build_opener", side_effect=AssertionError("No OCR")):
                exported = export_review_candidates(in_path, out_path)
            self.assertEqual(in_path.read_bytes(), before_bytes)
            _ = prepare_review_candidates(in_memory)
            self.assertEqual(in_memory.model_dump(mode="json"), in_memory_snapshot)

            # Create-only output: second write to existing path fails without overwriting
            first_out_bytes = out_path.read_bytes()
            with self.assertRaises(ExtractionError):
                export_review_candidates(in_path, out_path)
            self.assertEqual(out_path.read_bytes(), first_out_bytes)
            self.assertEqual(exported.status, "incomplete")


if __name__ == "__main__":
    unittest.main()
