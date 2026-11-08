import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from fixture_factory import make_pdf
from test_workflow import FakeLLM

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.review_candidates import ReviewCandidateResult, export_review_candidates, main, prepare_review_candidates
from peekaplate_processing.schemas import MenuExtractionResult
from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.workflow import DishBatch, ExtractedDish, PageSection


FIXTURES=Path(__file__).parent / "fixtures/review-candidates"


class ReviewCandidateTests(unittest.TestCase):

    def setUp(self):
        self.data=json.loads((FIXTURES / "representative-extraction.json").read_text())
        self.report=MenuExtractionResult.model_validate(self.data)

    def test_shared_examples_match_export_and_keep_three_distinct_cases(self):
        result=prepare_review_candidates(self.report)
        expected=json.loads((FIXTURES / "representative-candidates.json").read_text())
        self.assertEqual(result.model_dump(mode="json"), expected)
        for filename,candidate in zip(["priced-candidate.json", "missing-price-candidate.json", "zero-price-candidate.json"], result.candidates):
            self.assertEqual(candidate.model_dump(mode="json"), json.loads((FIXTURES / filename).read_text()))
        self.assertEqual(len(result.candidates), 3)
        soup,coffee,bread=result.candidates
        self.assertEqual(str(soup.original.price_amount), "8.50")
        self.assertIsNone(coffee.original.price_amount)
        self.assertIn("price_amount", coffee.missing_fields)
        self.assertEqual(str(bread.original.price_amount), "0.00")
        self.assertNotIn("price_amount", bread.missing_fields)
        self.assertTrue(all(candidate.original.status == "needs_review" for candidate in result.candidates))
        self.assertEqual(result.status, "incomplete")
        self.assertEqual([segment.status for segment in result.segments], ["ready", "failed", "skipped"])
        self.assertEqual(result.errors, self.report.errors)
        self.assertEqual(result.warnings, self.report.warnings)
        self.assertNotIn("snapshot_base64", expected["source"])

    def test_identity_and_originals_survive_reordering_and_serialization(self):
        original=prepare_review_candidates(self.report)
        reordered=copy.deepcopy(self.data)
        reordered["drafts"].reverse()
        for evidence in reordered["evidence"]:
            evidence["draft_index"]=2-evidence["draft_index"]
        result=prepare_review_candidates(MenuExtractionResult.model_validate(reordered))
        self.assertEqual(result.extraction_id, original.extraction_id)
        self.assertEqual(
            {candidate.candidate_id:candidate.original for candidate in result.candidates},
            {candidate.candidate_id:candidate.original for candidate in original.candidates},
        )
        restored=ReviewCandidateResult.model_validate_json(result.model_dump_json())
        self.assertEqual(restored, result)
        result.candidates[0].original.name="Reviewer edit outside original report"
        result.segments[0].metadata["example"]=True
        self.assertEqual(self.report.drafts[2].name, "Bread")
        self.assertNotIn("example", self.report.segments[0].metadata)

    def test_separate_runs_have_separate_extraction_identity(self):
        later=copy.deepcopy(self.data)
        later["started_at"]="2026-10-25T13:00:00Z"
        self.assertNotEqual(
            prepare_review_candidates(self.report).extraction_id,
            prepare_review_candidates(MenuExtractionResult.model_validate(later)).extraction_id,
        )

    def test_v2_fields(self):
        data=json.loads((FIXTURES / "representative-extraction-v2.json").read_text())
        result=prepare_review_candidates(MenuExtractionResult.model_validate(data))
        expected=json.loads((FIXTURES / "representative-candidates-v2.json").read_text())
        self.assertEqual(result.model_dump(mode="json"), expected)
        self.assertEqual((result.schema_version, result.pipeline_version), (2, "3"))
        soup,coffee,bread=result.candidates
        self.assertEqual((soup.original.category, soup.original.subcategory), ("FOOD", "SOUPS"))
        self.assertEqual(soup.original.category_page_number, 1)
        self.assertEqual(soup.original.price_text, "8.50 / 12.50 CAD")
        self.assertIsNone(soup.original.price_amount)
        self.assertNotIn("price_amount", soup.missing_fields)
        self.assertIn("price_amount", coffee.missing_fields)
        self.assertIsNone(coffee.original.subcategory)
        self.assertEqual(str(bread.original.price_amount), "0.00")
        self.assertEqual(result.candidates[0].candidate_id, data["evidence"][0]["draft_id"])
        self.assertEqual(ReviewCandidateResult.model_validate_json(result.model_dump_json()), result)

    def test_heading_page(self):
        for page in [999, 2, 3]:
            with self.subTest(page=page):
                data=json.loads((FIXTURES / "representative-extraction-v2.json").read_text())
                data["drafts"][0]["category_page_number"]=page
                with self.assertRaises(ValueError):
                    prepare_review_candidates(MenuExtractionResult.model_validate(data))
        for error in ["Unresolved heading-page error", None]:
            with self.subTest(error=error):
                data=json.loads((FIXTURES / "representative-extraction-v2.json").read_text())
                data["segments"][1].update(status="ready", error=error)
                data["drafts"][0]["category_page_number"]=2
                with self.assertRaises(ValueError):
                    prepare_review_candidates(MenuExtractionResult.model_validate(data))

    def test_pipeline_export(self):
        pages=["FOOD\nSOUPS\nGarden Soup 8.50 / 12.50 / 15.50 CAD",
               "Warm roasted coffee\nCoffee 2.00 CAD", "Bread\nFreshly baked bread 0.00 CAD"]
        class MenuLLM(FakeLLM):
            def invoke(client, messages):
                answer=super(MenuLLM, client).invoke(messages)
                dishes=[]
                sections=[]
                for page in json.loads(messages[1][1])["pages"]:
                    number=page["page_number"]
                    dishes.append(ExtractedDish(
                        page_number=number, name=["Garden Soup", "Coffee", "Bread"][number-1],
                        description=None, category="FOOD" if number == 1 else None,
                        subcategory="SOUPS" if number == 1 else None,
                        price_text="8.50 / 12.50 / 15.50 CAD" if number == 1 else None,
                        price_amount=[None, "2.00", "0.00"][number-1], price_currency="CAD", ingredients=None,
                    ))
                    sections.append(PageSection(page_number=number, category="FOOD" if number == 1 else None, continues_previous=number != 1))
                    if number == 2 and client.partial:
                        dishes.append(dishes[-1].model_copy(update={"name":"Invented dish"}))
                answer["raw"].content=DishBatch(dishes=dishes, sections=sections).model_dump_json()
                return answer
        for partial in [False, True]:
            with self.subTest(partial=partial), tempfile.TemporaryDirectory() as directory:
                path=Path(directory)
                source=path / "menu.pdf"
                source.write_bytes(make_pdf([{"text":text} for text in pages]))
                client=MenuLLM()
                client.partial=partial
                with patch("peekaplate_processing.workflow.asyncio.sleep"), patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract", side_effect=AssertionError("Unexpected OCR call")):
                    report=run_pipeline(source, path / "run", llm=client, cache_dir=None, llm_cache_dir=None, batch_pages=1,input_mode="ocr")
                result=export_review_candidates(path / "run/extraction.json", path / "review.json")
                self.assertEqual(result.status, "incomplete" if partial else "complete")
                self.assertEqual(len(client.calls), 3)
                self.assertEqual(len(result.candidates), 3)
                self.assertEqual(len(result.errors), 1 if partial else 0)
                for index,candidate in enumerate(result.candidates):
                    self.assertEqual(candidate.original, report.drafts[index])
                    self.assertEqual(candidate.candidate_id, report.evidence[index].draft_id)
                    self.assertEqual(candidate.evidence, report.evidence[index].spans)
                    self.assertEqual(candidate.original.status, "needs_review")
                    self.assertEqual(candidate.original.category_page_number, 1)
                soup,coffee,bread=result.candidates
                self.assertEqual(soup.original.price_text, "8.50 / 12.50 / 15.50 CAD")
                self.assertIsNone(soup.original.price_amount)
                self.assertNotIn("price_amount", soup.missing_fields)
                self.assertIsNone(coffee.original.subcategory)
                self.assertEqual(str(bread.original.price_amount), "0.00")
                self.assertEqual(ReviewCandidateResult.model_validate_json((path / "review.json").read_bytes()), result)

    def test_review_versions(self):
        data=json.loads((FIXTURES / "representative-candidates.json").read_text())
        for field,value in [("subcategory", "SOUPS"), ("category_page_number", 1), ("price_text", "8.50")]:
            invalid=copy.deepcopy(data)
            invalid["candidates"][0]["original"][field]=value
            with self.assertRaises(ValidationError): ReviewCandidateResult.model_validate(invalid)
        for schema,pipeline in [(1, "3"), (2, "2")]:
            invalid={**data, "schema_version":schema, "pipeline_version":pipeline}
            with self.assertRaises(ValidationError): ReviewCandidateResult.model_validate(invalid)

    def test_v2_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory) / "review.json"
            result=export_review_candidates(FIXTURES / "representative-extraction-v2.json", output)
            self.assertEqual(json.loads(output.read_text()), result.model_dump(mode="json"))
            with self.assertRaises(ExtractionError):
                export_review_candidates(FIXTURES / "representative-extraction-v2.json", output)

    def test_field_limits(self):
        for case in json.loads((FIXTURES / "field-limits.json").read_text()):
            with self.subTest(field=case["field"]):
                data=json.loads((FIXTURES / "representative-candidates-v2.json").read_text())
                candidate=data["candidates"][0]
                candidate["original"][case["field"]]=case["character"]*case["limit"]
                candidate["missing_fields"]=[field for field in candidate["missing_fields"] if field != case["field"]]
                ReviewCandidateResult.model_validate(data)
                candidate["original"][case["field"]]+=case["character"]
                with self.assertRaises(ValidationError): ReviewCandidateResult.model_validate(data)

    def test_decimal_wire_values_keep_precision_and_signed_zero(self):
        for amount in ["8.5000", "1E+8", "0E-8", "-0.00"]:
            with self.subTest(amount=amount):
                data=copy.deepcopy(self.data)
                data["drafts"][0]["price_amount"]=amount
                result=prepare_review_candidates(MenuExtractionResult.model_validate(data))
                self.assertEqual(result.model_dump(mode="json")["candidates"][0]["original"]["price_amount"], amount)

    def test_preserves_geometry_without_inventing_dish_boxes(self):
        self.report.segments[0].metadata.update({
            "upload_width":1368, "upload_height":1836,
            "ocr_coordinate_space":"uploaded_image_pixels",
            "ocr_regions":[{"text":"Coffee", "left":20, "top":30, "width":50, "height":15}],
        })
        result=prepare_review_candidates(self.report)
        self.assertEqual(result.segments[0].metadata, self.report.segments[0].metadata)
        self.assertEqual(result.segments[1].metadata, {})
        self.assertNotIn("box", result.candidates[0].model_dump())

    def test_unicode_offsets_preserve_nonzero_exact_source_slice(self):
        fixtures=json.loads((FIXTURES.parent / "source-spans.json").read_text())
        for fixture in fixtures:
            with self.subTest(text=fixture["text"]):
                report=copy.deepcopy(self.data)
                report["segments"][0]["text"]=fixture["text"]
                for draft in report["drafts"]:
                    draft["source_text"]=fixture["evidence_text"]
                for evidence in report["evidence"]:
                    evidence["spans"][0].update(fixture["code_point_span"])
                result=prepare_review_candidates(MenuExtractionResult.model_validate(report))
                self.assertEqual(result.candidates[0].original.source_text, fixture["evidence_text"])

    def test_invalid_evidence_and_source_are_rejected(self):
        def mutate(case, data):
            if case == "missing source": data["source"]=None
            elif case == "wrong snapshot": data["source"]["snapshot_base64"]="aW52YWxpZA=="
            elif case == "wrong source hash": data["source"]["sha256"]="a"*64
            elif case == "wrong source ID": data["source"]["source_id"]="another-source"
            elif case == "wrong draft source": data["drafts"][0]["source_id"]="another-source"
            elif case == "missing evidence": data["evidence"].pop()
            elif case == "duplicate draft index": data["evidence"][1]["draft_index"]=0
            elif case == "duplicate candidate ID": data["evidence"][1]["draft_id"]=data["evidence"][0]["draft_id"]
            elif case == "duplicate segment ID": data["segments"].append(data["segments"][0])
            elif case == "missing segment": data["evidence"][0]["spans"][0]["segment_id"]="missing"
            elif case == "failed evidence": data["segments"][0]["status"]="failed"
            elif case == "skipped evidence": data["segments"][0]["status"]="skipped"
            elif case == "ready with error": data["segments"][0]["error"]="Unresolved acquisition error"
            elif case == "out of range": data["evidence"][0]["spans"][0]["end"]=10000
            elif case == "reversed span": data["evidence"][0]["spans"][0].update(start=10, end=5)
            elif case == "mismatched source text": data["drafts"][0]["source_text"]="Invented evidence"
            elif case == "failed with candidates": data["status"]="failed"

        for case in ["missing source", "wrong snapshot", "wrong source hash", "wrong source ID", "wrong draft source", "missing evidence", "duplicate draft index", "duplicate candidate ID", "duplicate segment ID", "missing segment", "failed evidence", "skipped evidence", "ready with error", "out of range", "reversed span", "mismatched source text", "failed with candidates"]:
            with self.subTest(case=case):
                data=copy.deepcopy(self.data)
                mutate(case, data)
                with self.assertRaises(ValueError):
                    prepare_review_candidates(MenuExtractionResult.model_validate(data))

    def test_contract_rejects_invented_confidence_publication_and_wrong_missing_fields(self):
        result=prepare_review_candidates(self.report).model_dump(mode="json")
        for patch in [{"confidence":0.95}, {"published":True}, {"missing_fields":[]}]:
            with self.subTest(patch=patch):
                invalid=copy.deepcopy(result)
                invalid["candidates"][1].update(patch)
                with self.assertRaises(ValidationError):
                    ReviewCandidateResult.model_validate(invalid)

    def test_failed_report_retains_errors_without_creating_candidates(self):
        self.report.drafts=[]
        self.report.evidence=[]
        self.report.status="failed"
        result=prepare_review_candidates(self.report)
        self.assertEqual(result.candidates, [])
        self.assertEqual(result.errors, self.report.errors)

    def test_rejects_blank_references_and_timestamps_without_timezone(self):
        for case in ["location", "candidate_id", "segment_id", "started_at", "finished_at", "retrieved_at"]:
            with self.subTest(case=case):
                data=copy.deepcopy(self.data)
                if case == "location": data["source"]["location"]="   "
                elif case == "candidate_id": data["evidence"][0]["draft_id"]="   "
                elif case == "segment_id":
                    data["segments"][0]["segment_id"]="   "
                    for evidence in data["evidence"]: evidence["spans"][0]["segment_id"]="   "
                elif case == "retrieved_at": data["source"][case]="2026-10-25T12:00:00"
                else: data[case]="2026-10-25T12:00:00"
                with self.assertRaises(ValueError):
                    prepare_review_candidates(MenuExtractionResult.model_validate(data))

    def test_cli_exports_offline_and_refuses_overwrite_or_invalid_input(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder) / "review-candidates.json"
            self.assertEqual(main(["--input", str(FIXTURES / "representative-extraction.json"), "--output", str(output)]), 0)
            saved=output.read_bytes()
            self.assertEqual(len(ReviewCandidateResult.model_validate_json(saved).candidates), 3)
            with self.assertRaises(ExtractionError):
                export_review_candidates(FIXTURES / "representative-extraction.json", output)
            self.assertEqual(output.read_bytes(), saved)
            invalid_output=Path(folder) / "invalid.json"
            with self.assertRaises(ExtractionError):
                export_review_candidates(FIXTURES / "invalid-extraction.json", invalid_output)
            self.assertFalse(invalid_output.exists())
            invalid=copy.deepcopy(self.data)
            invalid["drafts"][0]["price_amount"]="-1.00"
            invalid_input=Path(folder) / "invalid-amount.json"
            invalid_input.write_text(json.dumps(invalid))
            with self.assertRaises(ExtractionError):
                export_review_candidates(invalid_input, invalid_output)
            self.assertFalse(invalid_output.exists())


if __name__ == "__main__": unittest.main()
