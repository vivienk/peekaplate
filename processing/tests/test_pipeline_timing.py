import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from fixture_factory import make_pdf
from test_workflow import FakeLLM
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.run_pipeline import configured_llm, main, run_pipeline
from peekaplate_processing.timing import measure
from peekaplate_processing.schemas import MenuExtractionResult
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.review_candidates import prepare_review_candidates
from peekaplate_processing.workflow import DishBatch, ExtractedDish, PageSection


class PipelineTimingTests(unittest.TestCase):

    def test_layout_prices(self):
        text="NUTS\nRoasted nuts\nWINGS\nCrispy chicken\n375 / 695\n495 / 795\nPIE\nBaked fruit\nFRIES\nCrispy potatoes\n345\n295\nTEA\nBrewed leaves\nNOODLES\nBroth and noodles\n460\n445"
        def box(label, x, y):
            return dict(text=label, left=x, top=y, width=len(label)*6, height=10)
        regions=[box("NUTS",20,100), box("375 / 695",250,100),
                 box("WINGS",20,150), box("495 / 795",250,150),
                 box("PIE",450,100), box("345",700,100),
                 box("FRIES",450,150), box("295",700,150),
                 box("TEA",20,220), box("460",250,220),
                 box("NOODLES",450,220), box("445",700,220)]
        metadata=dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                      upload_width=800, upload_height=400, ocr_regions=regions)
        for missing in [False, True]:
            class LayoutLLM(FakeLLM):
                def invoke(client, messages):
                    answer=super().invoke(messages)
                    dishes=[]
                    for name,amount,printed in [("WINGS",None,"375 / 695"), ("FRIES","345","345"), ("NOODLES","460","460")]:
                        dishes.append(ExtractedDish(page_number=1, name=name, description=None, category=None,
                            price_amount=None if missing else amount, price_text=None if missing else printed,
                            price_currency=None, ingredients=None))
                    answer["raw"].content=DishBatch(dishes=dishes, sections=[PageSection(page_number=1, category=None, continues_previous=False)]).model_dump_json()
                    return answer
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/"menu.pdf"
                path.write_bytes(make_pdf([{"text":text}]))
                acquired=extract_source(path)
                acquired.segments[0].text=text
                acquired.segments[0].method="ocr_space_engine3"
                acquired.segments[0].metadata=metadata.copy()
                before=json.dumps(acquired.segments[0].metadata, sort_keys=True)
                client=LayoutLLM()
                with patch("peekaplate_processing.run_pipeline.extract_source", return_value=acquired):
                    report=run_pipeline(path, Path(folder)/"run", llm=client, cache_dir=None, llm_cache_dir=None)
                self.assertEqual([(d.name,d.model_dump(mode="json")["price_amount"],d.price_text) for d in report.drafts],
                    [("WINGS",None,"495 / 795"),("FRIES","295","295"),("NOODLES","445","445")])
                self.assertEqual(report.segments[0].text, text)
                self.assertEqual(json.dumps(report.segments[0].metadata, sort_keys=True), before)
                self.assertEqual(client.calls, [[{"page_number":1,"text":text}]])
                exported=prepare_review_candidates(report)
                self.assertEqual(len(exported.candidates), 3)
                self.assertTrue(all(c.original.status == "needs_review" for c in exported.candidates))
                for candidate in exported.candidates:
                    span=candidate.evidence[0]
                    self.assertEqual(text[span.start:span.end], candidate.original.source_text)

    def test_partial_price_groups_abstain_through_export(self):
        cases=[("decimal_overlay", "95.50", "95", None),
               ("middle_option_overlay", "75 / 95 / 120", "95", None),
               ("truncated_text_list", "8.50 / 12.50 / 15.50", None, "8.50 / 12.50")]
        for label, source_price, overlay, supplied in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as folder:
                text=f"Soup\nSeasonal vegetables and fresh herbs\n{source_price}"
                path=Path(folder)/"menu.pdf"
                path.write_bytes(make_pdf([{"text":text}]))
                acquired=extract_source(path)
                segment=acquired.segments[0]
                segment.text=text
                if overlay is not None:
                    segment.method="ocr_space_engine3"
                    segment.metadata=dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                        upload_width=800, upload_height=400, ocr_regions=[
                            dict(text="Soup",left=20,top=20,width=100,height=10),
                            dict(text=overlay,left=250,top=20,width=100,height=10)])
                before=copy.deepcopy(segment)
                class PartialPriceLLM(FakeLLM):
                    def invoke(client, messages):
                        answer=super().invoke(messages)
                        dish=ExtractedDish(page_number=1,name="Soup",description=None,category=None,
                            price_amount=None,price_text=supplied,price_currency=None,ingredients=None)
                        answer["raw"].content=DishBatch(dishes=[dish],sections=[
                            PageSection(page_number=1,category=None,continues_previous=False)]).model_dump_json()
                        return answer
                client=PartialPriceLLM()
                with patch("peekaplate_processing.run_pipeline.extract_source", return_value=acquired):
                    report=run_pipeline(path, Path(folder)/"run", llm=client, cache_dir=None, llm_cache_dir=None)
                self.assertEqual(report.segments[0].text, before.text)
                self.assertEqual(report.segments[0].metadata, before.metadata)
                self.assertEqual(client.calls, [[{"page_number":1,"text":text}]])
                exported=prepare_review_candidates(report)
                self.assertEqual(len(exported.candidates), 1)
                candidate=exported.candidates[0]
                self.assertIsNone(candidate.original.price_amount)
                self.assertIsNone(candidate.original.price_text)
                self.assertEqual(candidate.original.status, "needs_review")
                self.assertTrue(candidate.original.review_warnings)
                self.assertEqual(exported.segments[0].text, before.text)
                self.assertEqual(exported.segments[0].metadata, before.metadata)
                self.assertEqual(candidate.original.source_text, report.drafts[0].source_text)
                self.assertEqual(candidate.evidence, report.evidence[0].spans)
                span=candidate.evidence[0]
                self.assertEqual(text[span.start:span.end], candidate.original.source_text)

    def test_cache_flags(self):
        for flags,cache_dir in [([], "work/ocr-cache"), (["--no-ocr-cache"], None)]:
            report=SimpleNamespace(drafts=[], status="complete", errors=[])
            with patch("peekaplate_processing.run_pipeline.run_pipeline", return_value=report) as pipeline, patch("peekaplate_processing.run_pipeline.load_dotenv"), patch("builtins.print"):
                self.assertEqual(main(["--input", "menu.pdf", "--run-dir", "work/test", "--no-llm-cache", *flags]), 0)
            self.assertEqual(pipeline.call_args.kwargs["cache_dir"], cache_dir)
            self.assertIsNone(pipeline.call_args.kwargs["llm_cache_dir"])
            self.assertEqual(pipeline.call_args.kwargs["batch_pages"], 10)
            self.assertEqual(pipeline.call_args.kwargs["llm_concurrency"], 1)

    def test_api_defaults_preserve_develop_settings(self):
        from inspect import signature
        defaults=signature(run_pipeline).parameters
        self.assertEqual(defaults["batch_pages"].default, 10)
        self.assertEqual(defaults["llm_concurrency"].default, 1)

    def test_schema_version(self):
        fixture=Path(__file__).parent/"fixtures/review-candidates/representative-extraction.json"
        data=json.loads(fixture.read_text())
        data["drafts"][0]["subcategory"]="New field in an old contract"
        with self.assertRaises(ValueError):
            MenuExtractionResult.model_validate(data)
        data=json.loads(fixture.read_text())
        data["schema_version"]=2
        with self.assertRaises(ValueError):
            MenuExtractionResult.model_validate(data)

    def test_model_settings(self):
        settings={"a2agent_api_key":"synthetic", "a2agent_url":"https://api.a2agent.me/v1", "a2agent_api_MODEL":"minimax-m3.1-flash"}
        with patch.dict(os.environ, settings, clear=True):
            model=configured_llm()
        self.assertIsNone(model.reasoning_effort)
        self.assertEqual(model.max_retries, 0)

    def test_run_timings(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"menu.pdf"
            path.write_bytes(make_pdf([{"text":"Dish 1 8.50 CAD - synthetic menu"}]))
            run=Path(folder)/"run"
            result=run_pipeline(path, run, llm=FakeLLM(), llm_cache_dir=None)
            timing=json.loads((run/"timings.json").read_text())
            self.assertEqual(result.schema_version, 2)
            self.assertEqual(result.pipeline_version, "3")
            self.assertEqual(timing["status"], "complete")
            for stage in ["acquisition", "pages_write", "llm_wall", "draft_assembly", "extraction_write", "total"]:
                self.assertGreaterEqual(timing["timings_seconds"][stage], 0)
            self.assertGreaterEqual(timing["timings_seconds"]["total"], timing["timings_seconds"]["llm_wall"])
            self.assertFalse(timing["pages"][0]["reused"])
            self.assertIn("native_text", timing["pages"][0]["timings_seconds"])
            self.assertIn("model_request", timing["batches"][0]["timings_seconds"])
            self.assertEqual(timing["batches"][0]["page_numbers"], [1])

    def test_saved_page_timings(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"menu.pdf"
            path.write_bytes(make_pdf([{"text":"Dish 1 8.50 CAD - synthetic menu"}]))
            first=Path(folder)/"first"
            run_pipeline(path, first, llm=FakeLLM(), llm_cache_dir=None)
            second=Path(folder)/"second"
            with patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                run_pipeline(path, second, llm=FakeLLM(), pages_json=first/"pages.json", llm_cache_dir=None)
            timing=json.loads((second/"timings.json").read_text())
            self.assertEqual(timing["acquisition_mode"], "saved_pages")
            self.assertTrue(timing["pages"][0]["reused"])
            self.assertIsNone(timing["pages"][0]["timings_seconds"])

    def test_failure_timings(self):
        timings={}
        with self.assertRaises(ValueError), measure(timings, "failed"):
            raise ValueError("synthetic")
        self.assertGreaterEqual(timings["failed"], 0)
        with tempfile.TemporaryDirectory() as folder:
            run=Path(folder)/"failed"
            with self.assertRaises(ExtractionError):
                run_pipeline("missing.pdf", run, llm=FakeLLM(), pages_json="missing.json")
            timing=json.loads((run/"timings.json").read_text())
            self.assertEqual(timing["status"], "failed")
            self.assertIn("acquisition", timing["timings_seconds"])
            self.assertIn("total", timing["timings_seconds"])

    def test_model_failure_timings(self):
        class Broken(FakeLLM):
            def with_structured_output(self, *args, **kwargs):
                raise RuntimeError("synthetic setup failure")
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"menu.pdf"
            path.write_bytes(make_pdf([{"text":"Dish 1 8.50 CAD - synthetic menu"}]))
            run=Path(folder)/"failed"
            with self.assertRaises(RuntimeError):
                run_pipeline(path, run, llm=Broken())
            timing=json.loads((run/"timings.json").read_text())
            self.assertEqual(timing["status"], "failed")
            self.assertIn("llm_wall", timing["timings_seconds"])


if __name__ == "__main__": unittest.main()
