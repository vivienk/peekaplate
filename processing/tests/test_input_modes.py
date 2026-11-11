"""Synthetic mode/evidence controls. No OCR or model network requests."""
import base64
import copy
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs

from PIL import Image
from fixture_factory import make_pdf
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import main as acquisition_main
from peekaplate_processing.review_candidates import prepare_review_candidates
from peekaplate_processing.run_pipeline import main, run_pipeline
from peekaplate_processing.workflow import DishBatch, ExtractedDish, PageSection, run_menu_graph


class RecordingLLM:
    model_name="synthetic"
    openai_api_base="https://example.test/v1"

    def __init__(self, name="Soup", price="8.50"):
        self.messages=[]
        self.name=name
        self.price=price

    def with_structured_output(self, schema, **kwargs):
        assert schema == DishBatch.model_json_schema()
        return self

    async def ainvoke(self, messages):
        self.messages.append(copy.deepcopy(messages))
        content=messages[1][1]
        request=json.loads(content if isinstance(content,str) else content[0]["text"])
        dishes=[ExtractedDish(page_number=page["page_number"],name=self.name,description=None,
            category=None,price_amount=self.price,price_currency=None,ingredients=None) for page in request["pages"]]
        sections=[PageSection(page_number=page["page_number"],category=None,continues_previous=False) for page in request["pages"]]
        return {"raw":SimpleNamespace(content=DishBatch(dishes=dishes,sections=sections).model_dump_json(),
                                     response_metadata={"finish_reason":"stop"})}


def photo(path, size=(48,32)):
    """Synthetic menu photo: dark text-like rows on white, so image preflight accepts it."""
    with Image.new("RGB",size,"white") as image:
        for top in range(4,size[1]-3,6):
            image.paste((0,0,0),(4,top,size[0]-4,top+2))
        image.save(path,format="PNG")


class InputModeTests(unittest.TestCase):
    def source(self, root):
        path=root/"menu.pdf"
        path.write_bytes(make_pdf([{"text":"Soup 8.50\nSeasonal vegetables and herbs"}]))
        return path

    def test_cli_default_and_explicit_modes(self):
        for flags,expected in [([],"ocr_image"),(["--input-mode","ocr"],"ocr"),
                               (["--input-mode","image"],"image")]:
            with self.subTest(mode=expected), patch("peekaplate_processing.run_pipeline.run_pipeline",
                    return_value=SimpleNamespace(drafts=[],status="complete",errors=[])) as pipeline, \
                    patch("peekaplate_processing.run_pipeline.load_dotenv"),patch("builtins.print"):
                self.assertEqual(main(["--input","menu.pdf","--run-dir","work/modes",*flags]),0)
                self.assertEqual(pipeline.call_args.kwargs["input_mode"],expected)

    def test_pipeline_cli_ocr_table_default_and_opt_out(self):
        for flags,expected in [([],True),(["--no-ocr-table"],False)]:
            with self.subTest(is_table=expected), patch("peekaplate_processing.run_pipeline.run_pipeline",
                    return_value=SimpleNamespace(drafts=[],status="complete",errors=[])) as pipeline, \
                    patch("peekaplate_processing.run_pipeline.load_dotenv"),patch("builtins.print"):
                self.assertEqual(main(["--input","menu.png","--run-dir","work/table",*flags]),0)
                self.assertIs(pipeline.call_args.kwargs["is_table"],expected)

    def test_acquisition_cli_ocr_table_default_and_opt_out(self):
        with tempfile.TemporaryDirectory() as folder:
            for flags,expected in [([],True),(["--no-ocr-table"],False)]:
                with self.subTest(is_table=expected), patch("peekaplate_processing.extract_menus.extract_source",
                        return_value=MagicMock(segments=[],status="complete",errors=[])) as acquisition, \
                        patch("peekaplate_processing.extract_menus.load_dotenv"), \
                        patch("peekaplate_processing.extract_menus.save_json"),patch("builtins.print"):
                    self.assertEqual(acquisition_main(["--input","menu.png","--output",str(Path(folder)/"pages.json"),*flags]),0)
                    self.assertIs(acquisition.call_args.kwargs["is_table"],expected)

    def test_real_pipeline_propagates_ocr_table_setting_to_transport_and_reports(self):
        for options,expected in [({},True),({"is_table":False},False)]:
            with self.subTest(is_table=expected),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/"menu.png";photo(source)
                response=MagicMock()
                response.read.return_value=json.dumps({"OCRExitCode":1,"IsErroredOnProcessing":False,
                    "ParsedResults":[{"FileParseExitCode":1,"ParsedText":"Soup 8.50"}]}).encode()
                opener=MagicMock()
                opener.open.return_value.__enter__.return_value=response
                with patch("peekaplate_processing.ocr_space.build_opener",return_value=opener):
                    report=run_pipeline(source,root/"run",llm=RecordingLLM(),ocr_api_key="synthetic-key",
                                        cache_dir=None,llm_cache_dir=None,**options)
                opener.open.assert_called_once()
                fields=parse_qs(opener.open.call_args.args[0].data.decode())
                self.assertEqual(fields["isTable"],[str(expected).lower()])
                self.assertEqual(fields["OCREngine"],["3"])
                self.assertEqual(fields["isOverlayRequired"],["true"])
                self.assertEqual(report.status,"complete")
                self.assertEqual(len(report.drafts),1)
                self.assertIs(report.configuration["ocr_is_table"],expected)
                self.assertIs(report.segments[0].metadata["ocr_settings"]["isTable"],expected)
                for name in ["pages.json","extraction.json"]:
                    saved=json.loads((root/"run"/name).read_text())
                    self.assertIs(saved["configuration"]["ocr_is_table"],expected)
                    self.assertIs(saved["segments"][0]["metadata"]["ocr_settings"]["isTable"],expected)

    def test_invalid_mode_and_saved_ocr_in_image_mode_fail_before_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for options in [{"input_mode":"invalid"},{"input_mode":"image","pages_json":"old.json"}]:
                with self.subTest(options=options),self.assertRaises(ExtractionError):
                    run_pipeline("missing",root/"run",llm=RecordingLLM(),**options)
                self.assertFalse((root/"run").exists())

    def test_ocr_mode_keeps_text_only_payload_and_exact_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);llm=RecordingLLM()
            result=run_pipeline(self.source(root),root/"run",llm=llm,input_mode="ocr",llm_cache_dir=None)
            self.assertIsInstance(llm.messages[0][1][1],str)
            self.assertEqual(len(result.drafts),1)
            self.assertEqual(prepare_review_candidates(result).candidates[0].original.status,"needs_review")
            span=result.evidence[0].spans[0]
            self.assertEqual(result.segments[0].text[span.start:span.end],result.drafts[0].source_text)

    def test_default_sends_source_image_and_keeps_unsupported_price_private(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);llm=RecordingLLM(price="99")
            result=run_pipeline(self.source(root),root/"run",llm=llm,llm_cache_dir=None)
            content=llm.messages[0][1][1]
            self.assertIsInstance(content,list)
            images=[part for part in content if part["type"] == "image_url"]
            self.assertEqual(len(images),1)
            body=base64.b64decode(images[0]["image_url"]["url"].split(",",1)[1])
            private=json.loads((root/"run/review-suggestions.json").read_text())
            self.assertEqual(private["input_mode"],"ocr_image")
            self.assertEqual(private["pages"][0]["image"]["sha256"],hashlib.sha256(body).hexdigest())
            self.assertIsNone(result.drafts[0].price_amount)
            suggestion=private["suggestions"][0]
            self.assertEqual(suggestion["original"]["price_amount"],"99")
            self.assertTrue(any(item["field"]=="price_amount" and item["disposition"]!="supported_by_source_text"
                                for item in suggestion["decisions"]))
            self.assertNotIn("suggestions",prepare_review_candidates(result).model_dump())

    def test_image_only_never_calls_ocr_or_native_text_and_does_not_invent_spans(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=self.source(root);llm=RecordingLLM()
            with patch("peekaplate_processing.run_pipeline.extract_source",side_effect=AssertionError("OCR forbidden")), \
                 patch("pymupdf.Page.get_text",side_effect=AssertionError("Native text forbidden")):
                result=run_pipeline(source,root/"run",llm=llm,input_mode="image",llm_cache_dir=None)
            content=llm.messages[0][1][1]
            request=json.loads(content[0]["text"])
            self.assertTrue(all("text" not in page for page in request["pages"]))
            self.assertEqual(result.drafts,[])
            self.assertEqual(result.evidence,[])
            self.assertEqual(result.segments,[])
            self.assertEqual(result.status,"incomplete")
            private=json.loads((root/"run/review-suggestions.json").read_text())
            self.assertEqual(private["status"],"complete")
            self.assertEqual(len(private["suggestions"]),1)
            region=private["pages"][0]["image"]["region"]
            self.assertEqual(region["scope"],"page")
            self.assertGreater(region["width"],0)
            self.assertNotIn("spans",private["suggestions"][0])
            self.assertEqual(prepare_review_candidates(result).candidates,[])

    def test_image_photo_retains_original_png_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/"menu.png";photo(source);llm=RecordingLLM()
            run_pipeline(source,root/"run",llm=llm,input_mode="image",llm_cache_dir=None)
            parts=llm.messages[0][1][1]
            data=next(part["image_url"]["url"] for part in parts if part["type"]=="image_url")
            self.assertEqual(base64.b64decode(data.split(",",1)[1]),source.read_bytes())

    def test_rejected_composed_name_survives_only_in_private_record(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);llm=RecordingLLM(name="Soup with invented bread")
            result=run_pipeline(self.source(root),root/"run",llm=llm,llm_cache_dir=None)
            self.assertEqual(result.drafts,[])
            private=json.loads((root/"run/review-suggestions.json").read_text())
            suggestion=private["suggestions"][0]
            self.assertEqual(suggestion["original"]["name"],"Soup with invented bread")
            self.assertEqual(suggestion["status"],"unvalidated")
            self.assertTrue(any(item["field"]=="name" and item["disposition"]=="rejected"
                                for item in suggestion["decisions"]))

    def test_vision_cache_isolated_by_actual_image_bytes_and_mode(self):
        def page(color):
            output=io.BytesIO()
            with Image.new("RGB",(20,20),color) as image:
                image.save(output,format="PNG")
            data=output.getvalue()
            return {"page_number":1,"text":"Soup 8.50","image_url":"data:image/png;base64,"+base64.b64encode(data).decode(),
                    "image_reference":{"sha256":hashlib.sha256(data).hexdigest()}}
        with tempfile.TemporaryDirectory() as folder:
            llm=RecordingLLM()
            for color,mode in [("red","ocr_image"),("red","ocr_image"),("blue","ocr_image"),("blue","image")]:
                run_menu_graph(llm,[page(color)],input_mode=mode,cache_dir=folder,source_sha256="a"*64)
            self.assertEqual(len(llm.messages),3)
            for cached in Path(folder).glob("*.json"):
                self.assertNotIn("base64",cached.read_text())
            tampered=page("red");tampered["image_reference"]["sha256"]="f"*64
            result=run_menu_graph(llm,[tampered],input_mode="ocr_image",cache_dir=folder,source_sha256="a"*64)
            self.assertTrue(result["errors"])
            self.assertEqual(len(llm.messages),3)

    def test_image_context_is_labelled_and_target_pages_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/"menu.pdf";llm=RecordingLLM()
            source.write_bytes(make_pdf([{"text":"Soup 8.50 and seasonal vegetables"}]*3))
            with patch("peekaplate_processing.workflow.asyncio.sleep"):
                run_pipeline(source,root/"run",llm=llm,input_mode="image",batch_pages=1,llm_cache_dir=None)
            self.assertEqual(len(llm.messages),3)
            for index,message in enumerate(llm.messages):
                content=message[1][1];request=json.loads(content[0]["text"])
                self.assertEqual(request["pages"],[{"page_number":index+1}])
                self.assertEqual(sum(part["type"]=="image_url" for part in content),1 if index==0 else 2)
                if index:
                    self.assertEqual(request["context_pages"],[{"page_number":index}])

    def test_empty_ocr_can_still_receive_vision_suggestions_without_false_evidence(self):
        from peekaplate_processing.extract_menus import extract_source
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=self.source(root);acquired=extract_source(source)
            acquired.segments[0].text=""
            llm=RecordingLLM()
            with patch("peekaplate_processing.run_pipeline.extract_source",return_value=acquired):
                result=run_pipeline(source,root/"run",llm=llm,llm_cache_dir=None)
            self.assertEqual(len(llm.messages),1)
            self.assertEqual(result.drafts,[])
            self.assertEqual(len(json.loads((root/"run/review-suggestions.json").read_text())["suggestions"]),1)

    def test_vision_groups_presplit_before_calls_without_resampling_or_page_loss(self):
        from PIL.PngImagePlugin import PngInfo
        def page(number):
            output=io.BytesIO();info=PngInfo();info.add_text("synthetic","x"*800)
            with Image.new("RGB",(20,20),"white") as image:
                image.save(output,format="PNG",pnginfo=info)
            data=output.getvalue()
            return {"page_number":number,"text":"Soup 8.50","image_url":"data:image/png;base64,"+base64.b64encode(data).decode(),
                    "image_reference":{"sha256":hashlib.sha256(data).hexdigest()}}
        pages=[page(n) for n in range(1,6)]
        before=copy.deepcopy(pages)
        for mode,expected in [("ocr_image",[2,2,1]),("image",[2,1,1,1])]:
            with self.subTest(mode=mode):
                llm=RecordingLLM()
                with patch("peekaplate_processing.workflow.MAX_VISION_BATCH_BYTES",2000,create=True),patch("peekaplate_processing.workflow.asyncio.sleep"):
                    result=run_menu_graph(llm,pages,input_mode=mode,batch_pages=10,concurrency=2)
                self.assertEqual(result["errors"],[])
                self.assertEqual([len(b["page_numbers"]) for b in result["batches"]],expected)
                self.assertEqual([n for b in result["batches"] for n in b["page_numbers"]],list(range(1,6)))
                self.assertEqual(len(llm.messages),len(expected))
                for messages in llm.messages:
                    content=messages[1][1];request=json.loads(content[0]["text"])
                    blobs=[base64.b64decode(item["image_url"]["url"].split(",",1)[1]) for item in content if item["type"]=="image_url"]
                    self.assertLessEqual(sum(map(len,blobs)),2000)
                    self.assertTrue(all(hashlib.sha256(blob).hexdigest()==pages[0]["image_reference"]["sha256"] for blob in blobs))
                    if mode=="image" and request["pages"][0]["page_number"]>1:
                        self.assertEqual(request["context_pages"][0]["page_number"],request["pages"][0]["page_number"]-1)
                self.assertEqual(pages,before)

    def test_image_only_model_failure_is_failed_not_a_successful_diagnostic(self):
        class Broken(RecordingLLM):
            async def ainvoke(self,messages):
                raise RuntimeError("private provider failure")
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            result=run_pipeline(self.source(root),root/"run",llm=Broken(),input_mode="image",llm_cache_dir=None)
            self.assertEqual(result.status,"failed")
            self.assertNotIn("private provider",str(result.errors))
            private=json.loads((root/"run/review-suggestions.json").read_text())
            self.assertEqual(private["status"],"failed")

    def test_real_sdk_serializes_images_with_strict_schema_and_safe_usage(self):
        import asyncio
        import httpx
        from langchain_openai import ChatOpenAI
        seen=[]
        def respond(request):
            payload=json.loads(request.content);seen.append(payload)
            self.assertTrue(payload["response_format"]["json_schema"]["strict"])
            self.assertEqual(json.loads(payload["messages"][0]["content"].split("REQUIRED JSON SCHEMA:\n",1)[1]),DishBatch.model_json_schema())
            content=payload["messages"][1]["content"]
            self.assertTrue(any(part["type"]=="image_url" for part in content))
            dish=ExtractedDish(page_number=1,name="Soup",description=None,category=None,price_amount="8.50",price_currency=None,ingredients=None)
            return httpx.Response(200,json={"id":"synthetic","object":"chat.completion","created":1,"model":"synthetic",
                "usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150},
                "choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":DishBatch(dishes=[dish]).model_dump_json()}}]})
        client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
        try:
            with tempfile.TemporaryDirectory() as folder,httpx.Client(transport=httpx.MockTransport(respond)) as sync:
                root=Path(folder)
                llm=ChatOpenAI(model="synthetic",api_key="synthetic",base_url="https://example.test/v1",max_retries=0,http_client=sync,http_async_client=client)
                report=run_pipeline(self.source(root),root/"run",llm=llm,llm_cache_dir=None)
                self.assertEqual(len(report.drafts),1)
                self.assertEqual(len(seen),1)
                self.assertEqual(report.configuration["llm_batches"][0]["usage"]["total_tokens"],150)
        finally:
            asyncio.run(client.aclose())

    def test_source_failures_do_not_fabricate_a_model_result(self):
        with tempfile.TemporaryDirectory() as folder:
            llm=RecordingLLM()
            with self.assertRaises(ExtractionError):
                run_pipeline("missing.pdf",Path(folder)/"run",llm=llm,input_mode="image",llm_cache_dir=None)
            self.assertEqual(llm.messages,[])


class VisionV4ProviderAndDeadlineTests(unittest.TestCase):
    def _image(self, folder):
        path=Path(folder)/"menu.png"
        photo(path,(200,120))
        return path

    def test_preflight_rejects_unreadable_images_before_any_request(self):
        for name,make in [("blank",lambda p:Image.new("RGB",(200,120),"white").save(p,format="PNG")),
                          ("sideways",lambda p:(photo(p,(200,120)),Image.open(p).rotate(90,expand=True).save(p,format="PNG"))),
                          ("skew20",lambda p:(photo(p,(200,120)),Image.open(p).rotate(20,expand=True,fillcolor="white").save(p,format="PNG")))]:
            with self.subTest(name), tempfile.TemporaryDirectory() as folder, \
                 patch("peekaplate_processing.run_pipeline.create_cascading_clients", side_effect=AssertionError("no model")), \
                 patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("no OCR")):
                path=Path(folder)/"menu.png"; make(path)
                report=run_pipeline(path, Path(folder)/"run", input_mode="vision_v4", llm_cache_dir=None)
                self.assertEqual(report.status,"failed")
                self.assertEqual(report.drafts,[])
                self.assertIn("preflight",report.configuration)
    def test_single_price_amount_only_for_one_plain_price(self):
        from peekaplate_processing.vision_extraction import single_price_amount
        from decimal import Decimal
        for text,amount,expected in [("25.99","25.99",Decimal("25.99")),("$12","12",Decimal("12")),
                                     ("1,200","1,200",None),("12,50 €","12,50",None),("12/15","12/15",None),
                                     ("10.00 / 12.00","10.00",None),("MP","MP",None),("9","8",None)]:
            with self.subTest(text):
                self.assertEqual(single_price_amount(text,amount),expected)

    def test_split_price_options_merge_but_distinct_items_stay(self):
        from peekaplate_processing.vision_extraction import V4Dish, merge_split_options
        dish=lambda name,price,box:V4Dish.model_validate({"page_number":1,"name":name,"price_text":price,"price_amount":price,"box":box})
        merged,warnings=merge_split_options([dish("Fettuccine","12.00",[88,331,99,668]),dish("Fettuccine","15.00",[120,315,131,650]),
                                             dish("Spaghetti","10.00",[388,55,402,222]),dish("Spaghetti","12.00",[388,55,402,222])])
        self.assertEqual([(d.name,d.price_text,d.price_amount) for d in merged],
                         [("Fettuccine","12.00","12.00"),("Fettuccine","15.00","15.00"),("Spaghetti","10.00 / 12.00",None)])
        self.assertEqual(len(warnings),1)

    def test_inverted_box_is_omitted_and_run_is_incomplete_on_loss(self):
        from datetime import datetime, timezone
        from peekaplate_processing.vision_extraction import V4Dish, build_v4_result
        from peekaplate_processing.schemas import SourceRecord
        data=b"x"; digest=hashlib.sha256(data).hexdigest()
        source=SourceRecord(source_id=f"sha256:{digest}",sha256=digest,kind="image",location="menu.png",retrieved_at=datetime.now(timezone.utc),size_bytes=1,snapshot_base64=base64.b64encode(data).decode())
        dish=V4Dish.model_validate({"page_number":1,"name":"Soup","box":[500,600,400,100]})
        report=build_v4_result(source,[{"page_number":1,"image_reference":{"width":100,"height":100}}],[dish],datetime.now(timezone.utc),errors=["Page 1: vision output hit the token limit; later dishes may be missing."])
        self.assertEqual(report.status,"incomplete")
        self.assertEqual(report.segments[0].metadata["vision_boxes"],{})
        self.assertTrue(any("inverted" in warning for warning in report.warnings))

    def test_vision_boxes_survive_candidate_export_with_candidate_identity(self):
        from datetime import datetime, timezone
        from peekaplate_processing.review_candidates import ReviewCandidateResult, export_review_candidates
        from peekaplate_processing.schemas import SourceRecord
        from peekaplate_processing.storage import save_json
        from peekaplate_processing.vision_extraction import V4Dish, build_v4_result

        now=datetime(2025,1,1,tzinfo=timezone.utc)
        data=b"synthetic image"; digest=hashlib.sha256(data).hexdigest()
        source=SourceRecord(source_id=f"sha256:{digest}",sha256=digest,kind="image",location="menu.png",
                            retrieved_at=now,size_bytes=len(data),snapshot_base64=base64.b64encode(data).decode())
        pages=[{"page_number":1,"image_reference":{"width":200,"height":100}},
               {"page_number":2,"image_reference":{"width":300,"height":200}}]
        dishes=[V4Dish.model_validate({"page_number":1,"name":"Soup","price_text":"8.50",
                                      "price_amount":"8.50","box":[100,200,300,600],
                                      "price_box":[400,700,500,900]}),
                V4Dish.model_validate({"page_number":2,"name":"Salad","box":[50,100,250,400]})]
        report=build_v4_result(source,pages,dishes,now)
        ids=[e.draft_id for e in report.evidence]
        expected=[{ids[0]:[
            {"page_number":1,"type":"title","text":"Soup","box":{"left":40,"top":10,"width":80,"height":20}},
            {"page_number":1,"type":"price","text":"8.50","box":{"left":140,"top":40,"width":40,"height":10}},
        ]},{ids[1]:[
            {"page_number":2,"type":"title","text":"Salad","box":{"left":30,"top":10,"width":90,"height":40}},
        ]}]
        self.assertEqual(len(set(ids)),2)
        self.assertEqual([s.metadata["vision_boxes"] for s in report.segments],expected)
        with tempfile.TemporaryDirectory() as folder:
            extraction=Path(folder)/"extraction.json"
            output=Path(folder)/"review.json"
            save_json(report.model_dump(mode="json"),extraction)
            exported=export_review_candidates(extraction,output)
            saved=json.loads(output.read_text())
            reloaded=ReviewCandidateResult.model_validate_json(output.read_text())
        self.assertEqual([c.candidate_id for c in exported.candidates],ids)
        self.assertEqual([s["metadata"]["vision_boxes"] for s in saved["segments"]],expected)
        self.assertEqual([s.metadata["vision_boxes"] for s in reloaded.segments],expected)
        self.assertTrue(all("candidate_box_evidence" not in s.metadata for s in reloaded.segments))


    def test_multi_page_vision_extraction_reuses_client_without_event_loop_closed(self):
        from peekaplate_processing.vision_extraction import extract_vision_v4
        calls=[]
        class MultiPageLLM:
            def bind(self, **kwargs): return self
            async def ainvoke(self, messages):
                calls.append(len(messages))
                return SimpleNamespace(content='{"dishes":[{"page_number":1,"name":"Dish","box":[1,2,3,4]}]}')
        dishes, errors = extract_vision_v4(MultiPageLLM(), [{"page_number":1,"image_url":"data:,"}, {"page_number":2,"image_url":"data:,"}], timeout=30)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(dishes), 2)
        self.assertEqual([d.page_number for d in dishes], [1, 2])
        self.assertEqual(errors, [])

    def test_private_attempts_capture_raw_before_parse_and_failures_without_secrets(self):
        from peekaplate_processing.vision_extraction import extract_vision_v4
        class Client:
            def __init__(self, values): self.values=iter(values)
            def bind(self, **kwargs): return self
            async def ainvoke(self, messages):
                value=next(self.values)
                if isinstance(value, Exception): raise value
                return SimpleNamespace(content=value)
        attempts=[]
        raw='{"dishes":[{"name":"Soup","box":[1,2,3,4]},{"name":"Soup","box":[1,2,3,4]}]}'
        dishes, _=extract_vision_v4(Client([raw]), [{"page_number":2,"image_url":"data:,"}], attempts=attempts, provider="first")
        self.assertEqual(len(dishes),2)
        self.assertEqual(attempts[0]["response"],raw)
        with self.assertRaises(ValueError):
            extract_vision_v4(Client(['not-json']), [{"page_number":3,"image_url":"data:,"}], attempts=attempts, provider="second")
        with self.assertRaises(RuntimeError):
            extract_vision_v4(Client([RuntimeError("private-secret")]), [{"page_number":4,"image_url":"data:,"}], attempts=attempts, provider="second")
        self.assertEqual([r["attempt"] for r in attempts],[1,2,3])
        self.assertEqual([r["page_number"] for r in attempts],[2,3,4])
        self.assertEqual(attempts[1]["response"],"not-json")
        self.assertEqual(attempts[1]["failure_class"],"parse_error")
        self.assertEqual(attempts[2]["failure_class"],"provider_error")
        self.assertNotIn("private-secret",json.dumps(attempts))
        blocks=[{"type":"text","text":"synthetic structured response"}]
        dishes, errors=extract_vision_v4(Client([blocks]), [{"page_number":1,"image_url":"data:,"}], attempts=attempts)
        self.assertEqual(dishes,[])
        self.assertTrue(errors)
        self.assertEqual(attempts[-1]["failure_class"],"invalid_response")
        self.assertEqual(json.loads(attempts[-1]["response"]),blocks)

    def test_vision_capture_bounds_preserve_utf8_prefix_with_explicit_diagnostic(self):
        from peekaplate_processing.vision_extraction import extract_vision_v4
        raw='{"dishes":[]}' + "é" * 600_000
        class Client:
            def bind(self, **kwargs): return self
            async def ainvoke(self, messages): return SimpleNamespace(content=raw)
        attempts=[]
        with self.assertRaises(ValueError):
            extract_vision_v4(Client(), [{"page_number":1,"image_url":"data:,"}], attempts=attempts)
        self.assertTrue(attempts[0]["truncated"])
        self.assertGreaterEqual(len(attempts[0]["response"].encode("utf-8")),999_999)
        self.assertLessEqual(len(attempts[0]["response"].encode("utf-8")),1_000_000)
        self.assertEqual(attempts[0]["failure_class"],"parse_error")

    def _dish(self):
        from peekaplate_processing.vision_extraction import V4Dish
        return V4Dish.model_validate({"page_number":1,"name":"Soup","price_text":"8.50","price_amount":"8.50","box":[10,10,20,40]})

    def _run(self, *, cascade, generic):
        used=[]
        def fake_extract(client, images, timeout=None, **kwargs):
            used.append(client)
            return [self._dish()], []
        with tempfile.TemporaryDirectory() as folder, \
             patch("peekaplate_processing.run_pipeline.create_cascading_clients", return_value=cascade), \
             patch("peekaplate_processing.run_pipeline.configured_llm", side_effect=generic), \
             patch("peekaplate_processing.run_pipeline.extract_vision_v4", side_effect=fake_extract), \
             patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("OCR must not run")):
            report=run_pipeline(self._image(folder), Path(folder)/"run", input_mode="vision_v4", llm_cache_dir=None)
        return report, used

    def test_generic_only_configuration_runs_vision_with_the_configured_client(self):
        generic=SimpleNamespace(model_name="generic-model")
        report, used=self._run(cascade=[], generic=lambda **kwargs: generic)
        self.assertEqual(used,[generic])
        self.assertTrue(report.configuration.get("v4_vision"))
        self.assertGreaterEqual(report.started_at.year,2025)

    def test_provider_only_configuration_runs_without_generic_settings(self):
        named=SimpleNamespace(model_name="models/gemini")
        report, used=self._run(cascade=[("google_studio",named)], generic=ExtractionError("Set MENU_AI_API_KEY"))
        self.assertEqual(used,[named])
        self.assertEqual(report.extraction_model,"models/gemini")

    def test_provider_failure_is_sanitized_in_logs_and_saved_report(self):
        from contextlib import redirect_stderr
        first=SimpleNamespace(model_name="first")
        second=SimpleNamespace(model_name="second")
        used=[]
        def extract(client, images, timeout=None, **kwargs):
            used.append(client)
            if client is first:
                raise RuntimeError("synthetic-provider-secret")
            return [self._dish()], []
        log=io.StringIO()
        with tempfile.TemporaryDirectory() as folder, \
             patch("peekaplate_processing.run_pipeline.create_cascading_clients", return_value=[("first",first),("second",second)]), \
             patch("peekaplate_processing.run_pipeline.extract_vision_v4", side_effect=extract), \
             patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("OCR must not run")), \
             redirect_stderr(log):
            report=run_pipeline(self._image(folder), Path(folder)/"run", input_mode="vision_v4", llm_cache_dir=None)
            saved=(Path(folder)/"run/extraction.json").read_text()
        self.assertEqual(used,[first,second])
        self.assertEqual(report.extraction_model,"second")
        for output in (str(report.warnings), saved, log.getvalue()):
            self.assertNotIn("synthetic-provider-secret",output)
            self.assertIn("first",output)
            self.assertIn("RuntimeError",output)

    def test_zero_dishes_reports_reason_and_tries_next_provider(self):
        first=SimpleNamespace(model_name="first")
        second=SimpleNamespace(model_name="second")
        def extract(client, images, timeout=None, **kwargs):
            return ([], []) if client is first else ([self._dish()], [])
        with tempfile.TemporaryDirectory() as folder, \
             patch("peekaplate_processing.run_pipeline.create_cascading_clients", return_value=[("first",first),("second",second)]), \
             patch("peekaplate_processing.run_pipeline.extract_vision_v4", side_effect=extract) as invoke, \
             patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("OCR must not run")):
            report=run_pipeline(self._image(folder), Path(folder)/"run", input_mode="vision_v4", llm_cache_dir=None)
            saved=(Path(folder)/"run/extraction.json").read_text()
        self.assertEqual(invoke.call_count,2)
        self.assertEqual(report.extraction_model,"second")
        self.assertTrue(any("first" in warning and "0 dishes" in warning for warning in report.warnings))
        self.assertIn("0 dishes",saved)

    def test_vision_parse_failure_is_retained_when_ocr_fallback_succeeds(self):
        from contextlib import redirect_stderr
        raw="synthetic malformed private vision response"
        class Vision:
            model_name="synthetic"
            def bind(self, **kwargs): return self
            async def ainvoke(self, messages): return SimpleNamespace(content=raw)
        log=io.StringIO()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/"menu.pdf"
            source.write_bytes(make_pdf([{"text":"Soup 8.50\nSeasonal vegetables and herbs"}]))
            with patch("peekaplate_processing.run_pipeline.create_cascading_clients",
                       return_value=[("first",Vision())]), \
                 patch("peekaplate_processing.run_pipeline.configured_llm", return_value=RecordingLLM()), \
                 redirect_stderr(log):
                report=run_pipeline(source,root/"run",input_mode="vision_v4",llm_cache_dir=None)
            attempts=json.loads((root/"run/vision-attempts.json").read_text())
            private=json.loads((root/"run/review-suggestions.json").read_text())
            public=(root/"run/extraction.json").read_text()
        self.assertEqual(report.configuration["input_mode"],"ocr_image")
        self.assertEqual(attempts["source_id"],report.source.source_id)
        self.assertEqual(attempts["attempts"][0]["response"],raw)
        self.assertEqual(attempts["attempts"][0]["failure_class"],"parse_error")
        self.assertEqual(attempts["attempts"][0]["page_number"],1)
        self.assertEqual(private["input_mode"],"ocr_image")
        self.assertNotIn(raw,public)
        self.assertNotIn(raw,log.getvalue())

    def test_failed_ocr_client_setup_retains_failed_vision_report_and_attempts(self):
        from contextlib import redirect_stderr
        raw="synthetic malformed vision response"
        class Vision:
            model_name="synthetic"
            def bind(self, **kwargs): return self
            async def ainvoke(self, messages): return SimpleNamespace(content=raw)
        log=io.StringIO()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/"menu.pdf"
            source.write_bytes(make_pdf([{"text":"Soup 8.50\nSeasonal vegetables and herbs"}]))
            with patch("peekaplate_processing.run_pipeline.create_cascading_clients",
                       return_value=[("first",Vision())]), \
                 patch("peekaplate_processing.run_pipeline.configured_llm",
                       side_effect=ExtractionError("synthetic credential secret")), \
                 patch("peekaplate_processing.run_pipeline.extract_source",
                       side_effect=AssertionError("OCR must not start")) as ocr, \
                 redirect_stderr(log):
                report=run_pipeline(source,root/"run",input_mode="vision_v4",llm_cache_dir=None)
            saved=(root/"run/extraction.json").read_text()
            attempts=json.loads((root/"run/vision-attempts.json").read_text())
            timings=json.loads((root/"run/timings.json").read_text())
            self.assertFalse((root/"run/review-suggestions.json").exists())
        ocr.assert_not_called()
        self.assertEqual(report.status,"failed")
        self.assertEqual(report.configuration["input_mode"],"vision_v4")
        self.assertEqual(timings["status"],"failed")
        self.assertEqual(timings["input_mode"],"vision_v4")
        self.assertEqual(attempts["source_id"],report.source.source_id)
        self.assertEqual(attempts["attempts"][0]["response"],raw)
        self.assertEqual(attempts["attempts"][0]["failure_class"],"parse_error")
        self.assertIn("OCR fallback could not be initialized",str(report.errors))
        for output in (saved,str(report.errors),str(report.warnings),log.getvalue()):
            self.assertNotIn("synthetic credential secret",output)
            self.assertNotIn(raw,output)

    def test_partial_page_image_failure_survives_vision_fallback(self):
        from peekaplate_processing.vision import page_images
        failure="Page 2: source image could not be prepared within the rendering limits."
        def partial_images(source, directory):
            images, errors=page_images(source,directory,page_numbers=[1])
            return images, [*errors,failure]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/"menu.pdf"
            source.write_bytes(make_pdf([{"text":"Soup 8.50\nSeasonal vegetables and herbs"},
                                         {"text":"Salad 9.50\nFresh vegetables and herbs"}]))
            ocr_llm=RecordingLLM()
            with patch("peekaplate_processing.run_pipeline.page_images", side_effect=partial_images) as prepare, \
                 patch("peekaplate_processing.run_pipeline.create_cascading_clients",
                       return_value=[("first",SimpleNamespace(model_name="first"))]), \
                 patch("peekaplate_processing.run_pipeline.extract_vision_v4", return_value=([],[])), \
                 patch("peekaplate_processing.run_pipeline.configured_llm", return_value=ocr_llm):
                report=run_pipeline(source,root/"run",input_mode="vision_v4",llm_cache_dir=None)
            saved=json.loads((root/"run/extraction.json").read_text())
            private=json.loads((root/"run/review-suggestions.json").read_text())
            self.assertEqual(prepare.call_count,1)
            self.assertEqual(len(ocr_llm.messages),1)
            self.assertEqual(len(report.drafts),1)
            self.assertEqual(report.status,"incomplete")
            self.assertEqual(report.errors.count(failure),1)
            self.assertEqual(saved["status"],"incomplete")
            self.assertEqual(saved["errors"].count(failure),1)
            self.assertEqual(private["errors"].count(failure),1)

    def test_provider_timeout_is_sanitized_and_starts_no_fallback(self):
        from contextlib import redirect_stderr
        first=SimpleNamespace(model_name="first")
        second=SimpleNamespace(model_name="second")
        log=io.StringIO()
        with tempfile.TemporaryDirectory() as folder, \
             patch("peekaplate_processing.run_pipeline.create_cascading_clients", return_value=[("first",first),("second",second)]), \
             patch("peekaplate_processing.run_pipeline.extract_vision_v4", side_effect=TimeoutError("synthetic-timeout-secret")) as extract, \
             patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("OCR must not run")), \
             redirect_stderr(log):
            report=run_pipeline(self._image(folder), Path(folder)/"run", input_mode="vision_v4", llm_cache_dir=None)
            saved=(Path(folder)/"run/extraction.json").read_text()
        self.assertEqual(extract.call_count,1)
        self.assertEqual(report.status,"failed")
        self.assertIn("No fallback request was started",report.errors[-1])
        self.assertIn("90s",report.errors[-1])
        self.assertIn("90s",saved)
        for output in (str(report.errors), saved, log.getvalue()):
            self.assertNotIn("synthetic-timeout-secret",output)
            self.assertIn("first",output)

    def test_deadline_cancels_request_and_starts_no_fallback(self):
        import asyncio
        cancelled=[]
        class Blocking:
            model_name="slow"
            def bind(self, **kwargs): return self
            async def ainvoke(self, messages):
                try:
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    cancelled.append(True); raise
        second=SimpleNamespace(model_name="second")
        with tempfile.TemporaryDirectory() as folder, \
             patch("peekaplate_processing.run_pipeline.create_cascading_clients", return_value=[("slow",Blocking()),("second",second)]), \
             patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("OCR must not run")):
            report=run_pipeline(self._image(folder), Path(folder)/"run", input_mode="vision_v4", llm_timeout=0.05, llm_cache_dir=None)
            attempts=json.loads((Path(folder)/"run/vision-attempts.json").read_text())
        self.assertEqual(cancelled,[True])
        self.assertEqual(report.status,"failed")
        self.assertIn("No fallback request was started", report.errors[-1])
        self.assertIn("0.05s",report.errors[-1])
        self.assertEqual(attempts["attempts"][0]["failure_class"],"timeout")
        self.assertEqual(attempts["attempts"][0]["page_number"],1)
        self.assertIsNone(attempts["attempts"][0]["response"])


if __name__ == "__main__": unittest.main()
