"""Synthetic price-evidence safety and actual-pipeline regressions; no providers."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_input_modes import RecordingLLM, photo
from test_menu_layout import box, layout
from peekaplate_processing.workflow import ExtractedDish, grounded_draft
from peekaplate_processing.menu_layout import corroborate_box_price
from peekaplate_processing.review_candidates import export_review_candidates
from peekaplate_processing.run_pipeline import run_pipeline


def dish(**updates):
    values=dict(page_number=1,name="Soup",description=None,category=None,subcategory=None,
                price_text="8.50",price_amount="8.50",price_currency=None,ingredients=None)
    return ExtractedDish(**{**values,**updates})


class BoxGroundingSafetyTests(unittest.TestCase):
    def test_fallback_cannot_erase_negative_canonical_evidence(self):
        metadata=layout(box("Soup",20,20),box("8.50",220,20))
        texts=["Soup 9.50","Soup\n9.50","Soup\n-8.50","Soup\n8.50 kcal",
               "Soup\n18.50","Soup\n8.500","Soup\nPRICE\n8.50 / 12.50",
               "Soup\n−8.50","Soup\n+8.50","Soup\n8.50%","Soup\n1,850",
               "Soup\nSoup","Soup\n8.50\nSoup\n9.50"]
        for text in texts:
            with self.subTest(text=text):
                cleaned,_,evidence=grounded_draft(dish(),text,ocr_metadata=metadata,return_box_evidence=True)
                self.assertIsNone(cleaned.price_text)
                self.assertIsNone(cleaned.price_amount)
                self.assertEqual(evidence,[])

    def test_missing_price_recovers_without_inventing_text_or_currency(self):
        for left in (125,220):
            with self.subTest(left=left):
                metadata=layout(box("Soup",20,20),box("8.50",left,20))
                cleaned,warnings,evidence=grounded_draft(dish(),"Soup",ocr_metadata=metadata,return_box_evidence=True)
                self.assertEqual((cleaned.price_text,cleaned.price_amount),("8.50","8.50"))
                self.assertIsNone(cleaned.price_currency)
                self.assertEqual(evidence[0]["text"],"8.50")
                self.assertIn("Price grounded via OCR box evidence; verify row alignment.",warnings)

    def test_other_wrapped_numeric_names_never_become_prices(self):
        for name,first,last,price in [("Bowl 2","Bowl","2","2 / 90"),
                                      ("24/7 Platter","24/7","Platter","24/7")]:
            metadata=layout(box("Tea",20,45 if last.isdigit() else 20),
                            box(first,220,20),box(last,220,45),box("90",520,45))
            with self.subTest(name=name):
                result=corroborate_box_price("Tea",price,None,metadata,dish_names=("Tea",name))
                self.assertEqual(result,(None,None,[]))

    def test_percentages_are_not_prices_but_separate_explicit_money_survives(self):
        for metadata in (None,layout(box("Soup",20,20),box("8.50",220,20))):
            for text in ("Soup\n8.50%","Soup\n8.50％","Soup\n%: 8.50",
                         "Soup\n8.50 / 12.50%"):
                with self.subTest(text=text,overlay=metadata is not None):
                    cleaned,_,evidence=grounded_draft(dish(),text,ocr_metadata=metadata,return_box_evidence=True)
                    self.assertIsNone(cleaned.price_text)
                    self.assertIsNone(cleaned.price_amount)
                    self.assertEqual(evidence,[])
        cleaned,_=grounded_draft(dish(),"Soup $8.50 / 10%")
        self.assertEqual(cleaned.price_amount,"8.50")
        self.assertIsNone(cleaned.price_currency)

    def test_private_decisions_keep_exact_selected_boxes_and_honest_disposition(self):
        from peekaplate_processing.review_suggestions import suggestion_record
        metadata=layout(box("Soup",20,20),box("8.50",220,20))
        raw=dish();cleaned,warnings,evidence=grounded_draft(raw,"Soup",ocr_metadata=metadata,return_box_evidence=True)
        saved=suggestion_record(raw,1,1,{"page_number":1,"segment_id":"synthetic","text":"Soup"},
                                cleaned=cleaned,warnings=warnings,box_evidence=evidence)
        fields={d["field"]:d for d in saved["decisions"]}
        self.assertEqual(fields["price_text"]["disposition"],"supported_by_ocr_boxes")
        self.assertEqual(fields["price_amount"]["disposition"],"supported_by_ocr_boxes")
        self.assertEqual(saved["box_evidence"],evidence)
        self.assertEqual(saved["status"],"unvalidated")

    def test_actual_pipeline_saves_and_exports_exact_fractional_boxes(self):
        from peekaplate_processing.vision import image_source
        from peekaplate_processing.schemas import SourceSegment
        for price_text,price_amount,printed in [("8.50","8.50",["8.50"]),
                ("6.00 33.00",None,["6.00","33.00"])]:
            with self.subTest(printed=printed),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/"source.png";photo(source)
                llm=RecordingLLM(price=price_amount)
                original=llm.ainvoke
                async def response(messages):
                    result=await original(messages)
                    body=json.loads(result["raw"].content)
                    body["dishes"][0]["price_text"]=price_text
                    result["raw"].content=json.dumps(body)
                    return result
                llm.ainvoke=response
                pages=image_source(source)
                pages.segments=[SourceSegment(segment_id="synthetic:page:1",page_number=1,
                    method="ocr_space_engine3",text="Soup")]
                pages.errors=[]
                pages.status="complete"
                pages.segments[0].metadata=layout(box("Soup",1,1,10,5),
                    *[box(literal,15+i*12+0.25,1,10,5) for i,literal in enumerate(printed)])
                pages.segments[0].metadata.update(upload_width=48,upload_height=32)
                saved=root/"saved-pages.json";saved.write_text(pages.model_dump_json())
                with patch("peekaplate_processing.run_pipeline.extract_source",side_effect=AssertionError("No fresh OCR")):
                    report=run_pipeline(source,root/"run",llm=llm,pages_json=saved,cache_dir=None,llm_cache_dir=None)
                self.assertEqual(report.status,"complete")
                self.assertEqual(report.drafts[0].price_text," / ".join(printed))
                self.assertEqual(str(report.drafts[0].price_amount) if price_amount else report.drafts[0].price_amount,price_amount)
                records=report.evidence[0].box_evidence
                self.assertEqual(len(records),len(printed))
                self.assertEqual(records[0].page_number,1)
                self.assertEqual(records[0].box["left"],15.25)
                exported=export_review_candidates(root/"run/extraction.json",root/"review.json")
                candidate=exported.candidates[0]
                self.assertEqual(candidate.original.status,"needs_review")
                links=exported.segments[0].metadata["candidate_box_evidence"]
                self.assertEqual(links[candidate.candidate_id],[record.model_dump(mode="json") for record in records])
                self.assertNotIn("candidate_box_evidence",report.segments[0].metadata)
                self.assertEqual(report.segments[0].text,"Soup")
                private=json.loads((root/"run/review-suggestions.json").read_text())
                self.assertEqual(private["suggestions"][0]["box_evidence"][0]["text"],printed[0])
                self.assertTrue((root/"run/timings.json").exists())

    def test_invalid_evidence_never_appends_a_partial_draft(self):
        from peekaplate_processing.vision import image_source
        from peekaplate_processing.schemas import SourceSegment
        from peekaplate_processing.workflow import run_menu_graph
        mutations=[("missing_page",lambda b:b.pop("page_number")),
                   ("nonexistent_region",lambda b:b.update(saved_region_index=999)),
                   ("invented_literal",lambda b:b.update(text="invented"))]
        for label,mutate in mutations:
            with self.subTest(label=label),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/"source.png";photo(source)
                pages=image_source(source)
                metadata=layout(box("Soup",1,1,10,5),box("8.50",15.25,1,10,5))
                metadata.update(upload_width=48,upload_height=32)
                pages.segments=[SourceSegment(segment_id="synthetic:page:1",page_number=1,
                    method="ocr_space_engine3",text="Soup",metadata=metadata)]
                pages.status="complete";pages.errors=[]
                saved=root/"pages.json";saved.write_text(pages.model_dump_json())
                def corrupt_graph(*args,**kwargs):
                    result=run_menu_graph(*args,**kwargs)
                    mutate(result["dishes"][0]["box_evidence"][0])
                    return result
                with patch("peekaplate_processing.run_pipeline.run_menu_graph",side_effect=corrupt_graph):
                    report=run_pipeline(source,root/"run",llm=RecordingLLM(price="8.50"),
                        pages_json=saved,cache_dir=None,llm_cache_dir=None)
                self.assertEqual(report.status,"failed")
                self.assertEqual(report.drafts,[])
                self.assertEqual(report.evidence,[])
                self.assertTrue(any("dish or evidence failed" in e for e in report.errors))
                saved_report=json.loads((root/"run/extraction.json").read_text())
                self.assertEqual(saved_report["drafts"],[])
                self.assertEqual(saved_report["evidence"],[])
                self.assertTrue((root/"run/review-suggestions.json").exists())

if __name__=="__main__":unittest.main()
