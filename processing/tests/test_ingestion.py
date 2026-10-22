import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from fixture_factory import make_pdf, menu_image
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import extract_menus
from peekaplate_processing.menu_text import extract_dishes


def ocr_result(text="Garden Salad - 10.00 CAD"):
    return {"text":text, "settings":{"OCREngine":3}, "cache_hit":False}


class IngestionTests(unittest.TestCase):

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.directory=Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def source(self, data, name="menu.bin"):
        path=self.directory/name
        path.write_bytes(data)
        return path

    def test_native_pdf_pages_produce_drafts_without_any_ocr(self):
        data=make_pdf([{"text":"Tomato Soup - 8.50 CAD"}, {"text":"Garden Salad - 10.00 CAD"}])
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract") as ocr:
            result=extract_menus(self.source(data))
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual([draft.name for draft in result.drafts], ["Tomato Soup", "Garden Salad"])
        self.assertEqual([segment.page_number for segment in result.segments], [1, 2])
        self.assertEqual([segment.method for segment in result.segments], ["pdf_native", "pdf_native"])
        self.assertEqual(base64.b64decode(result.source.snapshot_base64), data)
        self.assertTrue(all(evidence.spans for evidence in result.evidence))
        self.assertTrue(all(draft.image_id is None for draft in result.drafts))
        self.assertTrue(all(request.status=="capture_missing" for request in result.capture_requests))
        ocr.assert_not_called()

    def test_mixed_pdf_only_ocrs_image_page_and_preserves_native_heading(self):
        data=make_pdf([{"text":"Tomato Soup - 8.50 CAD"}, {"text":"MENU", "image":menu_image()}])
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract", return_value=ocr_result()) as ocr:
            result=extract_menus(self.source(data))
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(len(result.drafts), 2)
        self.assertEqual([segment.method for segment in result.segments], ["pdf_native", "ocr_space_engine3"])
        self.assertIn("MENU", result.segments[1].native_text)
        self.assertEqual(result.segments[1].metadata["ocr_settings"]["OCREngine"], 3)
        ocr.assert_called_once()

    def test_failed_ocr_page_produces_incomplete_report_and_retains_other_drafts(self):
        data=make_pdf([{"text":"Tomato Soup - 8.50 CAD"}, {"image":menu_image()}])
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract", side_effect=ExtractionError("OCR quota exhausted.")):
            result=extract_menus(self.source(data))
        self.assertEqual(result.status, "incomplete")
        self.assertEqual(result.drafts[0].name, "Tomato Soup")
        self.assertEqual(result.segments[1].status, "failed")
        self.assertIn("quota", result.errors[0])

    def test_continued_dish_preserves_both_page_references(self):
        data=make_pdf([{"text":"Name: Tomato Soup"}, {"text":"Price: 8.50 CAD\nIngredients: tomatoes, basil"}])
        result=extract_menus(self.source(data))
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(len(result.drafts), 1)
        self.assertEqual(len(result.evidence[0].spans), 2)
        self.assertEqual(result.drafts[0].ingredients, ["tomatoes", "basil"])

    def test_blank_pdf_page_is_recorded_without_ocr(self):
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract") as ocr:
            result=extract_menus(self.source(make_pdf([{}, {"text":"Soup - 8.50 CAD"}])))
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(result.segments[0].status, "skipped")
        ocr.assert_not_called()

    def test_corrupt_and_oversized_page_count_are_failed_results(self):
        for data in [b"%PDF-invalid", make_pdf([{}]*21)]:
            with self.subTest(size=len(data)):
                result=extract_menus(self.source(data))
                self.assertEqual(result.status, "failed")
                self.assertTrue(result.errors)

    def test_menu_photo_routes_to_engine3_and_records_image_preparation(self):
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract", return_value=ocr_result("Soup - 8.50 CAD")) as ocr:
            result=extract_menus(self.source(menu_image(), "photo.jpg"))
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(result.source.kind, "image")
        self.assertEqual(result.segments[0].method, "ocr_space_engine3")
        self.assertLess(len(ocr.call_args.args[0]), 950_001)
        self.assertEqual(result.segments[0].metadata["upload_format"], "JPEG")

    def test_missing_real_ocr_key_returns_failed_report_with_actionable_message(self):
        result=extract_menus(self.source(menu_image()))
        self.assertEqual(result.status, "failed")
        self.assertIn("OCR_SPACE_API_KEY", result.errors[0])

    def test_static_website_extracts_menu_scope_without_navigation(self):
        html=b'<html><body><nav>Ignore me 999.00</nav><section id="food-menu"><p>Soup  8.50 CAD</p><p>Salad  10.00 CAD</p></section><footer>Contact 1234</footer></body></html>'
        with patch("peekaplate_processing.extract_menus.fetch_public", return_value=(html, "text/html", "https://menu.example/food?secret=value")):
            result=extract_menus("https://menu.example/food?secret=value")
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual([draft.name for draft in result.drafts], ["Soup", "Salad"])
        self.assertEqual(result.source.location, "https://menu.example/food")
        self.assertNotIn("Ignore", result.segments[0].text)

    def test_website_direct_pdf_url_is_routed_by_content_not_url_suffix(self):
        data=make_pdf([{"text":"Soup - 8.50 CAD"}])
        with patch("peekaplate_processing.extract_menus.fetch_public", return_value=(data, "application/pdf", "https://menu.example/download?id=1")):
            result=extract_menus("https://menu.example/download?id=1")
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(result.source.kind, "pdf")

    def test_html_menu_link_is_followed_once_and_linked_snapshot_retained(self):
        html=b'<html><body><a href="/menu.pdf">Download menu</a></body></html>'
        pdf=make_pdf([{"text":"Soup - 8.50 CAD"}])
        with patch("peekaplate_processing.extract_menus.fetch_public", side_effect=[(html, "text/html", "https://menu.example/"), (pdf, "application/pdf", "https://menu.example/menu.pdf")]) as fetch:
            result=extract_menus("https://menu.example/")
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(base64.b64decode(result.segments[0].metadata["source_snapshot_base64"]), pdf)

    def test_structured_menu_uses_explicit_facts_without_inventing_images_or_ingredients(self):
        item={"@type":"MenuItem", "name":"Soup", "description":"Tomato soup", "offers":{"price":"8.50", "priceCurrency":"CAD"}, "image":"https://example.invalid/soup.jpg"}
        html=('<html><head><script type="application/ld+json">'+json.dumps(item)+'</script></head><body></body></html>').encode()
        result=extract_menus(self.source(html, "menu.html"))
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(result.drafts[0].description, "Tomato soup")
        self.assertIsNone(result.drafts[0].ingredients)
        self.assertIsNone(result.drafts[0].image_id)

    def test_javascript_only_page_is_not_reported_as_success(self):
        html=b'<html><body><div id="root"></div><script>renderMenu()</script></body></html>'
        result=extract_menus(self.source(html))
        self.assertEqual(result.status, "failed")
        self.assertIn("JavaScript", result.errors[0])

    def test_local_layout_supports_engine3_markdown_and_priced_rows(self):
        text="| Dish | Price | Ingredients |\n|---|---|---|\n| Soup | 8.50 CAD | tomatoes, basil |\n| Salad | $10.00 | |"
        result=extract_menus(text, source_type="text")
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(len(result.drafts), 2)
        self.assertIsNone(result.drafts[1].price_currency)
        self.assertEqual(result.drafts[0].ingredients, ["tomatoes", "basil"])
        self.assertEqual(len(extract_dishes("Soup  8.50 CAD\nSalad  10.00 CAD", "test", mode="layout")), 2)

    def test_ambiguous_layout_cannot_silently_drop_an_unpriced_item(self):
        result=extract_menus("Soup  8.50 CAD\nCHEF SPECIAL", source_type="text")
        self.assertEqual(result.status, "failed")
        self.assertIn("ambiguous", result.errors[0])

    def test_identical_names_with_different_prices_keep_distinct_capture_ids(self):
        result=extract_menus("Soup  8.50 CAD\nSoup  12.00 CAD", source_type="text")
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(len(result.drafts), 2)
        self.assertNotEqual(result.evidence[0].draft_id, result.evidence[1].draft_id)

    def test_content_type_override_mismatch_does_not_call_ocr(self):
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract") as ocr:
            result=extract_menus(self.source(b"Soup  8.50 CAD", "fake.pdf"), source_type="pdf")
        self.assertEqual(result.status, "failed")
        ocr.assert_not_called()

    def test_private_report_cli_returns_incomplete_exit_code(self):
        source=self.source(make_pdf([{"text":"Soup - 8.50 CAD"}, {"image":menu_image()}]), "mixed.pdf")
        output=self.directory/"result.json"
        completed=subprocess.run([sys.executable, "-m", "peekaplate_processing.extract_menus", "--input", str(source), "--output", str(output)], capture_output=True, text=True, timeout=15)
        self.assertEqual(completed.returncode, 2, completed.stderr)
        report=json.loads(output.read_text())
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(len(report["drafts"]), 1)
        self.assertEqual(output.stat().st_mode&0o777, 0o600)
        self.assertNotIn("Traceback", completed.stderr)

    def test_malformed_url_and_missing_file_return_failed_reports_without_tracebacks(self):
        for source in ["https://[bad-address/menu",self.directory/"missing.pdf"]:
            with self.subTest(source=str(source)):
                result=extract_menus(source)
                self.assertEqual(result.status,"failed")
                self.assertTrue(result.errors)

    def test_force_ocr_explicitly_overrides_native_page_detection(self):
        data=make_pdf([{"text":"Soup - 8.50 CAD"}])
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract",return_value=ocr_result("Soup - 8.50 CAD")) as ocr:
            result=extract_menus(self.source(data),force_ocr=True)
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual(result.segments[0].method,"ocr_space_engine3")
        ocr.assert_called_once()

    def test_ai_controller_retains_source_spans_and_model_identity(self):
        text="Soup - 8.50 CAD"
        response=json.dumps({"choices":[{"finish_reason":"stop","message":{"content":json.dumps({"dishes":[{"name":"Soup","price_amount":"8.50","source_text":text}]})}}]}).encode()
        from unittest.mock import MagicMock
        connection=MagicMock()
        connection.read.return_value=response
        with patch("peekaplate_processing.menu_text.build_opener") as factory:
            factory.return_value.open.return_value.__enter__.return_value=connection
            result=extract_menus(text,source_type="text",mode="ai",api_url="https://example.invalid/chat/completions",model="synthetic-model")
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual(result.extraction_model,"synthetic-model")
        span=result.evidence[0].spans[0]
        self.assertEqual(result.segments[0].text[span.start:span.end],result.drafts[0].source_text)

    def test_unrecognized_description_is_not_silently_treated_as_a_dish(self):
        result=extract_menus("Soup  8.50 CAD\nA long unlabelled description or another unpriced dish.",source_type="text")
        self.assertEqual(result.status,"failed")
        self.assertIn("--mode ai",result.errors[0])

    def test_failed_page_prevents_a_continuation_from_using_unrelated_page_context(self):
        data=make_pdf([{"text":"Name: Soup"},{"image":menu_image()},{"text":"Price: 8.50 CAD"}])
        with patch("peekaplate_processing.ocr_space.OCRSpaceClient.extract",side_effect=ExtractionError("OCR failed.")):
            result=extract_menus(self.source(data))
        self.assertEqual(result.status,"incomplete")
        self.assertEqual(len(result.drafts),1)
        self.assertIsNone(result.drafts[0].price_amount)

    def test_extraction_report_preserves_duplicate_variants_without_name_only_merging(self):
        data=make_pdf([{"text":"Soup - 8.50 CAD"},{"text":"Soup - 8.50 CAD"}])
        result=extract_menus(self.source(data))
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual(len(result.drafts),2)
        self.assertNotEqual(result.evidence[0].spans[0].segment_id,result.evidence[1].spans[0].segment_id)

    def test_html_inline_prices_and_separate_name_price_lines_are_supported(self):
        html=b'<html><body><section id="menu"><p><span>Soup</span><span>8.50 CAD</span></p><h3>Garden Salad</h3><p>10.00 CAD</p></section></body></html>'
        result=extract_menus(self.source(html))
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual([draft.name for draft in result.drafts],["Soup","Garden Salad"])

    def test_transparent_menu_is_composited_on_white_before_ocr(self):
        from peekaplate_processing.images import prepare_ocr_image
        image=Image.new("RGBA",(200,100),(0,0,0,0))
        output=io.BytesIO()
        image.save(output,format="PNG")
        image.close()
        prepared,_=prepare_ocr_image(output.getvalue())
        with Image.open(io.BytesIO(prepared)) as decoded:
            self.assertGreater(min(decoded.getpixel((0,0))),245)

    def test_every_jsonld_menu_block_is_extracted_with_its_own_source_span(self):
        scripts=[json.dumps({"@type":"MenuItem","name":name,"offers":{"price":price,"priceCurrency":"CAD"}}) for name,price in [("Soup","8.50"),("Salad","10.00")]]
        html=('<html><head>'+''.join('<script type="application/ld+json">'+script+'</script>' for script in scripts)+'</head><body></body></html>').encode()
        result=extract_menus(self.source(html))
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual([draft.name for draft in result.drafts],["Soup","Salad"])
        self.assertEqual(len(result.segments),2)
        self.assertNotEqual(result.evidence[0].spans[0].segment_id,result.evidence[1].spans[0].segment_id)

    def test_escaped_structured_facts_remain_traceable_to_original_json(self):
        item={"@type":"MenuItem","name":"Crème brûlée","description":'A "special" dessert.\nAsk staff.',"offers":{"price":"8.50","priceCurrency":"CAD"}}
        script=json.dumps(item)
        html=('<html><head><script type="application/ld+json">'+script+'</script></head><body></body></html>').encode()
        result=extract_menus(self.source(html))
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual(result.drafts[0].name,item['name'])
        self.assertEqual(result.drafts[0].description,item['description'])
        self.assertEqual(result.drafts[0].source_text,script)
        self.assertEqual(base64.b64decode(result.source.snapshot_base64),html)

    def test_source_identity_is_normalized_once_across_report_drafts_and_segments(self):
        result=extract_menus("Soup  8.50 CAD",source_id="  menu-1  ",source_type="text")
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual(result.source.source_id,"menu-1")
        self.assertEqual(result.drafts[0].source_id,"menu-1")
        self.assertTrue(result.segments[0].segment_id.startswith("menu-1#"))

    def test_bad_later_jsonld_block_marks_import_incomplete_instead_of_dropping_it(self):
        items=[{"@type":"MenuItem","name":"Soup","offers":{"price":"8.50","priceCurrency":"CAD"}},{"@type":"MenuItem","name":"Salad","offers":[{"price":"10.00"},{"price":"12.00"}]}]
        html=('<html><head>'+''.join('<script type="application/ld+json">'+json.dumps(item)+'</script>' for item in items)+'</head><body></body></html>').encode()
        result=extract_menus(self.source(html))
        self.assertEqual(result.status,"incomplete")
        self.assertEqual([draft.name for draft in result.drafts],["Soup"])
        self.assertEqual(len(result.segments),2)
        self.assertTrue(any("variant" in error for error in result.errors))

    def test_linked_html_preserves_separate_jsonld_block_groups(self):
        root=b'<html><body><a href="/menu">Menu</a></body></html>'
        items=[{"@type":"MenuItem","name":name,"offers":{"price":"8.50","priceCurrency":"CAD"}} for name in ['Soup','Salad']]
        html=('<html><head>'+''.join('<script type="application/ld+json">'+json.dumps(item)+'</script>' for item in items)+'</head><body></body></html>').encode()
        with patch("peekaplate_processing.extract_menus.fetch_public",side_effect=[(root,"text/html","https://menu.example/"),(html,"text/html","https://menu.example/menu")]):
            result=extract_menus("https://menu.example/")
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual([draft.name for draft in result.drafts],["Soup","Salad"])


if __name__=="__main__":
    unittest.main()
