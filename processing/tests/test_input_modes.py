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
from unittest.mock import patch

from PIL import Image
from fixture_factory import make_pdf
from peekaplate_processing.errors import ExtractionError
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


def photo(path):
    with Image.new("RGB",(48,32),"white") as image:
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


if __name__ == "__main__": unittest.main()
