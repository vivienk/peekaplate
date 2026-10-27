import json
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fixture_factory import make_pdf
from peekaplate_processing.run_pipeline import configured_llm, run_pipeline
from peekaplate_processing.workflow import DishBatch, ExtractedDish
from peekaplate_processing.errors import ExtractionError


def run_sdk_test(awaitable):
    # Keep the restricted test event loop polling while SDK parser threads finish.
    # This does not change the SDK/transport or the production event loop.
    async def run():
        task = asyncio.create_task(awaitable)
        while not task.done():
            await asyncio.wait({task}, timeout=0.01)
        return await task
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(run())
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


class FakeLLM:
    def __init__(self, fail_batch=None): self.calls = []; self.fail_batch = fail_batch
    async def ainvoke(self, messages):
        return self.invoke(messages)
    def with_structured_output(self, schema, **kwargs):
        assert schema == DishBatch.model_json_schema() and kwargs == {"method":"json_schema", "strict":True, "include_raw":True}
        return self
    def invoke(self, messages):
        data = json.loads(messages[1][1]); assert set(data) in ({"pages"}, {"pages", "context_pages"})
        self.calls.append(data["pages"])
        if len(self.calls) == self.fail_batch: raise RuntimeError("private provider response and secret")
        dishes = []
        for page in data["pages"]:
            assert set(page) == {"page_number", "text"}
            if not page["text"].strip(): continue
            dishes.append(ExtractedDish(page_number=page["page_number"], name=f"Dish {page['page_number']}", description=None, category=None, price_amount="8.50", price_currency="CAD", ingredients=None))
        return {"parsed":DishBatch(dishes=dishes), "raw":SimpleNamespace(response_metadata={"finish_reason":"stop"}, content=DishBatch(dishes=dishes).model_dump_json()), "parsing_error":None}


class WorkflowTests(unittest.TestCase):
    def run_case(self, directory, count, llm):
        path = Path(directory)/"menu.pdf"
        path.write_bytes(make_pdf([{"text":f"Menu prices\nDish {i} 8.50 CAD"} for i in range(1, count+1)]))
        with patch("peekaplate_processing.workflow.asyncio.sleep"):
            return run_pipeline(path, Path(directory)/"run", llm=llm, batch_pages=10, llm_concurrency=1,input_mode="ocr")

    def test_35_pages_dispatch_10_10_10_5_and_keep_source_spans(self):
        with tempfile.TemporaryDirectory() as directory:
            llm = FakeLLM(); report = self.run_case(directory, 35, llm)
            self.assertEqual(report.status, "complete", report.errors)
            self.assertEqual([len(p) for p in llm.calls], [10,10,10,5])
            self.assertEqual(len(report.drafts), 35)
            self.assertTrue((Path(directory)/"run/pages.json").exists())
            self.assertFalse((Path(directory)/"run/review.json").exists())
            for index, evidence in enumerate(report.evidence):
                span = evidence.spans[0]; segment = report.segments[index]
                self.assertEqual(segment.segment_id, span.segment_id)
                self.assertEqual(segment.text[span.start:span.end], report.drafts[index].source_text)
                self.assertEqual(report.drafts[index].status, "needs_review")

    def test_failed_batch_keeps_other_batches_and_private_text_out_of_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 21, FakeLLM(fail_batch=2))
        self.assertEqual(report.status, "incomplete")
        self.assertEqual(len(report.drafts), 11)
        self.assertTrue(any("Batch 2" in e for e in report.errors))
        self.assertNotIn("secret", str(report.errors))

    def test_existing_output_directory_refuses_before_any_llm_call(self):
        with tempfile.TemporaryDirectory() as directory:
            llm = FakeLLM()
            with self.assertRaises(ExtractionError): run_pipeline("missing", directory, llm=llm)
            self.assertEqual(llm.calls, [])

    def test_truncated_schema_response_is_reported_as_token_limit(self):
        class Truncated(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer.update(parsed=None, parsing_error=ValueError("private"))
                answer["raw"].response_metadata["finish_reason"] = "length"
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, Truncated())
        self.assertEqual(report.status, "failed")
        self.assertTrue(any("token limit" in e for e in report.errors))
        self.assertEqual(report.drafts, [])

    def test_unsupported_field_rejects_the_batch(self):
        class Unsupported(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["parsed"].dishes[0].name = "Invented dish"
                answer["raw"].content = answer["parsed"].model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, Unsupported())
        self.assertEqual(report.status, "failed")
        self.assertEqual(report.drafts, [])

    def test_empty_ingredients_remain_unknown(self):
        class EmptyIngredients(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["parsed"].dishes[0].ingredients = []
                answer["raw"].content = answer["parsed"].model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, EmptyIngredients())
        self.assertEqual(report.status, "complete", report.errors)
        self.assertIsNone(report.drafts[0].ingredients)

    def test_configured_model_uses_existing_env_endpoint_without_retry(self):
        with patch.dict(os.environ, {"MENU_AI_API_KEY":"synthetic", "MENU_AI_API_URL":"https://openrouter.ai/api/v1/chat/completions", "MENU_AI_MODEL":"openrouter/free"}, clear=True):
            model = configured_llm()
        self.assertEqual(str(model.openai_api_base), "https://openrouter.ai/api/v1")
        self.assertEqual(model.max_retries, 0)
        self.assertEqual(model.extra_body["reasoning"], {"enabled": False})

    def test_nara_settings_take_precedence_without_openrouter_parameters(self):
        settings = {"MENU_AI_API_KEY":"old-synthetic", "MENU_AI_API_URL":"https://openrouter.ai/api/v1/chat/completions", "MENU_AI_MODEL":"old-model", "NARA_ROUTER_KEY":"synthetic", "NARA_ROUTER_URL":"https://router.bynara.id/v1", "NARA_ROUTER_MODEL":"minimax-m3.1-flash:free"}
        with patch.dict(os.environ, settings, clear=True):
            model = configured_llm()
        self.assertEqual(str(model.openai_api_base), "https://router.bynara.id/v1")
        self.assertEqual(model.model_name, "minimax-m3.1-flash:free")
        self.assertEqual(model.openai_api_key.get_secret_value(), "synthetic")
        self.assertEqual(model.extra_body, {})
        self.assertEqual(model.reasoning_effort, "none")
        self.assertEqual(model.max_retries, 0)

    def test_partial_nara_settings_fail_instead_of_using_old_provider(self):
        with patch.dict(os.environ, {"NARA_ROUTER_KEY":"synthetic", "MENU_AI_API_KEY":"old-synthetic", "MENU_AI_API_URL":"https://openrouter.ai/api/v1", "MENU_AI_MODEL":"old-model"}, clear=True):
            with self.assertRaisesRegex(ExtractionError, "NARA_ROUTER"):
                configured_llm()

    def test_report_records_model_used_by_injected_client(self):
        llm = FakeLLM()
        llm.model_name = "synthetic-nara-model"
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, llm)
        self.assertEqual(report.extraction_model, "synthetic-nara-model")

    def test_timeout_and_connection_failures_are_distinguished_without_private_details(self):
        from openai import APIConnectionError, APITimeoutError
        import httpx
        for error, expected in [(APITimeoutError(request=httpx.Request("POST", "https://example.test")), "timed out"), (APIConnectionError(message="private secret", request=httpx.Request("POST", "https://example.test")), "connection failed")]:
            class Broken(FakeLLM):
                def invoke(self, messages): raise error
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                report = self.run_case(directory, 1, Broken())
            self.assertIn(expected, str(report.errors))
            self.assertNotIn("private", str(report.errors))
            self.assertNotIn("secret", str(report.errors))

    def test_acquisition_and_batch_timings_are_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, FakeLLM())
        self.assertGreaterEqual(report.configuration["timings_seconds"]["acquisition"], 0)
        batch = report.configuration["llm_batches"][0]
        self.assertEqual(batch["worker_id"], 1)
        self.assertGreaterEqual(batch["elapsed_seconds"], 0)

    def test_provider_check_uses_one_synthetic_page_without_ocr(self):
        from peekaplate_processing.check_llm import main
        class CheckModel(FakeLLM):
            model_name = "synthetic"
            def invoke(self, messages):
                result = super().invoke(messages)
                result["parsed"].dishes[0].name = "Soup"
                result["raw"].content = result["parsed"].model_dump_json()
                return result
        llm = CheckModel()
        with patch("peekaplate_processing.check_llm.configured_llm", return_value=llm), patch("peekaplate_processing.check_llm.load_dotenv"), patch("builtins.print"), patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("OCR must not run")):
            self.assertEqual(main([]), 0)
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(llm.calls[0], [{"page_number": 1, "text": "Soup 8.50 CAD"}])

    def test_real_sdk_validation_reports_field_without_output_or_secrets(self):
        import httpx
        from langchain_openai import ChatOpenAI
        from peekaplate_processing.workflow import build_menu_graph
        # A provider may accept strict JSON schema but return an invalid field type.
        dish = {"page_number": 1, "name": "private source name", "description": None, "category": None, "price_amount": 8.5, "price_currency": "CAD", "ingredients": None}
        def respond(request):
            self.assertEqual(json.loads(request.content)["response_format"]["type"], "json_schema")
            return httpx.Response(200, json={"id": "synthetic", "object": "chat.completion", "created": 1, "model": "synthetic", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps({"dishes": [dish]})}}]})
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            llm = ChatOpenAI(model="synthetic", api_key="synthetic", base_url="https://example.test/v1", http_client=client, http_async_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)), max_retries=0)
            result = run_sdk_test(build_menu_graph(llm).ainvoke({"pages": [{"page_number": 1, "text": "Soup 8.50 CAD"}], "batches": [], "worker_findings": []}))["final_report"]
        self.assertIn("dishes[0].price_amount", str(result["errors"]))
        self.assertIn("string_type", str(result["errors"]))
        self.assertNotIn("private source name", str(result["errors"]))
        self.assertEqual(result["dishes"], [])

    def test_validation_error_hides_arbitrary_field_names_and_context(self):
        from pydantic import ValidationError
        from peekaplate_processing.workflow import request_failure
        error = ValidationError.from_exception_data("PrivateTitle", [{"type": "extra_forbidden", "loc": ("private-secret-field",), "input": "private-menu-text"}])
        message = request_failure(error)
        self.assertIn("extra_forbidden", message)
        self.assertNotIn("private", message.lower())

    def test_real_sdk_sends_exact_dish_schema_in_prompt_and_accepts_valid_response(self):
        import httpx
        from langchain_openai import ChatOpenAI
        from peekaplate_processing.workflow import build_menu_graph
        dish = {"page_number": 1, "name": "Soup", "description": None, "category": None, "price_amount": "8.50", "price_currency": "CAD", "ingredients": None}
        def respond(request):
            payload = json.loads(request.content)
            prompt = payload["messages"][0]["content"]
            schema = json.loads(prompt.split("REQUIRED JSON SCHEMA:\n", 1)[1])
            self.assertEqual(schema, DishBatch.model_json_schema())
            self.assertIn("Include every required field", prompt)
            example_input = json.loads(prompt.split("EXAMPLE INPUT:\n", 1)[1].split("\nEXAMPLE OUTPUT:\n", 1)[0])
            example_output = json.loads(prompt.split("EXAMPLE OUTPUT:\n", 1)[1].split("\n\nREQUIRED JSON SCHEMA:", 1)[0])
            self.assertEqual(example_input["pages"][0]["text"], "Tomato Soup 8.50 CAD")
            self.assertEqual(DishBatch.model_validate(example_output).dishes[0].price_amount, "8.50")
            self.assertIn("price_amount and price_currency", prompt)
            self.assertEqual(payload["response_format"]["json_schema"]["strict"], True)
            return httpx.Response(200, json={"id": "synthetic", "object": "chat.completion", "created": 1, "model": "synthetic", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps({"dishes": [dish]})}}]})
        with httpx.Client(transport=httpx.MockTransport(respond)) as client:
            llm = ChatOpenAI(model="synthetic", api_key="synthetic", base_url="https://example.test/v1", http_client=client, http_async_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)), max_retries=0)
            result = run_sdk_test(build_menu_graph(llm).ainvoke({"pages": [{"page_number": 1, "text": "Soup 8.50 CAD"}], "batches": [], "worker_findings": []}))["final_report"]
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["dishes"], [ExtractedDish.model_validate(dish).model_dump()])

    def test_price_alias_and_missing_required_keys_are_rejected(self):
        from pydantic import ValidationError
        from peekaplate_processing.workflow import request_failure
        dish = {"page_number": 1, "name": "Soup", "description": None, "category": None, "price": "8.50 CAD", "ingredients": None}
        try:
            DishBatch.model_validate({"dishes": [dish]})
        except ValidationError as error:
            message = request_failure(error)
        else:
            self.fail("Unexpected price field must not bypass the contract")
        self.assertIn("extra_forbidden", message)
        self.assertIn("price_amount (missing)", message)
        self.assertIn("price_currency (missing)", message)

    def test_wall_clock_deadline_cancels_slow_batch_without_retry(self):
        import time
        from peekaplate_processing.workflow import run_menu_graph
        class Slow(FakeLLM):
            cancelled = False
            attempts = 0
            async def ainvoke(self, messages):
                self.attempts += 1
                try:
                    await asyncio.Future()
                finally:
                    self.cancelled = True
        llm = Slow()
        started = time.perf_counter()
        result = run_menu_graph(llm, [{"page_number": 1, "text": "Soup 8.50 CAD"}], request_timeout=0.02)
        self.assertLess(time.perf_counter() - started, 1)
        self.assertTrue(llm.cancelled)
        self.assertEqual(llm.attempts, 1)
        self.assertIn("deadline", str(result["errors"]))
        self.assertEqual(result["dishes"], [])

    def test_reuse_saved_pages_skips_ocr_and_rejects_a_different_source(self):
        with tempfile.TemporaryDirectory() as directory:
            llm = FakeLLM()
            first = self.run_case(directory, 1, llm)
            saved = Path(directory)/"run/pages.json"
            with patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR when pages are reused")):
                second = run_pipeline(Path(directory)/"menu.pdf", Path(directory)/"second", llm=FakeLLM(), pages_json=saved,input_mode="ocr")
                self.assertEqual(second.status, "complete", second.errors)
                self.assertEqual(second.drafts, first.drafts)
                other = Path(directory)/"other.pdf"
                other.write_bytes(make_pdf([{"text": "Different source"}]))
                with self.assertRaisesRegex(ExtractionError, "match"):
                    run_pipeline(other, Path(directory)/"third", llm=FakeLLM(), pages_json=saved,input_mode="ocr")

    def test_reused_failed_page_stays_incomplete_without_repeating_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_case(directory, 2, FakeLLM())
            saved = Path(directory)/"run/pages.json"
            data = json.loads(saved.read_text())
            data["segments"][1].update(status="failed", text="", error="OCR unavailable")
            saved.write_text(json.dumps(data))
            with patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                report = run_pipeline(Path(directory)/"menu.pdf", Path(directory)/"second", llm=FakeLLM(), pages_json=saved,input_mode="ocr")
        self.assertEqual(report.status, "incomplete")
        self.assertEqual(len(report.drafts), 1)
        self.assertIn("Page 2: OCR unavailable", report.errors)
        self.assertTrue(report.configuration["reused_page_text"])

    def test_invalid_deadline_fails_before_acquisition(self):
        for value in [0, -1, float("nan"), float("inf"), 301]:
            with self.subTest(value=value), patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                with self.assertRaisesRegex(ExtractionError, "deadline"):
                    run_pipeline("missing", "unused", llm=FakeLLM(), llm_timeout=value)

    def test_timed_out_batch_preserves_other_batches(self):
        from peekaplate_processing.workflow import run_menu_graph
        class SecondStalls(FakeLLM):
            async def ainvoke(self, messages):
                if json.loads(messages[1][1])["pages"][0]["page_number"] == 11:
                    await asyncio.Future()
                return self.invoke(messages)
        pages = [{"page_number": i, "text": f"Dish {i} 8.50 CAD"} for i in range(1, 22)]
        with patch("peekaplate_processing.workflow.asyncio.sleep"):
            result = run_menu_graph(SecondStalls(), pages, request_timeout=0.02)
        self.assertEqual(len(result["dishes"]), 11)
        self.assertIn("Batch 2", str(result["errors"]))
        self.assertEqual([b["status"] for b in result["batches"]], ["complete", "failed", "complete"])

    def test_cancellation_reaches_real_sdk_http_request(self):
        import httpx
        from langchain_openai import ChatOpenAI
        from peekaplate_processing.workflow import build_menu_graph
        attempts = []
        cancelled = []
        async def check_cancellation():
            request_started = asyncio.Event()
            async def stall(request):
                attempts.append(1)
                request_started.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.append(True)
            client = httpx.AsyncClient(transport=httpx.MockTransport(stall))
            llm = ChatOpenAI(model="synthetic", api_key="synthetic", base_url="https://example.test/v1", http_async_client=client, max_retries=0)
            task = asyncio.create_task(build_menu_graph(llm, request_timeout=30).ainvoke({"pages": [{"page_number": 1, "text": "Soup 8.50 CAD"}], "batches": [], "worker_findings": []}))
            try:
                await asyncio.wait_for(request_started.wait(), timeout=5)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await client.aclose()
        run_sdk_test(check_cancellation())
        self.assertEqual(len(attempts), 1)
        self.assertEqual(cancelled, [True])

    def test_reuse_rejects_omitted_page_and_mismatching_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_case(directory, 2, FakeLLM())
            saved = Path(directory)/"run/pages.json"
            original = json.loads(saved.read_text())
            omitted = {**original, "segments": original["segments"][:1]}
            bad_snapshot = {**original, "source": {**original["source"], "snapshot_base64": "eA=="}}
            for index, invalid in enumerate([omitted, bad_snapshot]):
                saved.write_text(json.dumps(invalid))
                with self.subTest(index=index), patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                    with self.assertRaises(ExtractionError):
                        run_pipeline(Path(directory)/"menu.pdf", Path(directory)/f"bad{index}", llm=FakeLLM(), pages_json=saved,input_mode="ocr")

    def test_a2agent_settings_override_nara_and_generic_without_provider_extras(self):
        settings = {"a2agent_api_key": "synthetic-a2", "a2agent_url": "https://api.a2agent.me/v1/chat/completions", "a2agent_api_MODEL": "minimax-m3", "NARA_ROUTER_KEY": "synthetic-nara", "NARA_ROUTER_URL": "https://router.bynara.id/v1", "NARA_ROUTER_MODEL": "old-model", "MENU_AI_API_KEY": "synthetic-old", "MENU_AI_API_URL": "https://openrouter.ai/api/v1", "MENU_AI_MODEL": "old-model"}
        with patch.dict(os.environ, settings, clear=True):
            model = configured_llm()
        self.assertEqual(str(model.openai_api_base), "https://api.a2agent.me/v1")
        self.assertEqual(model.model_name, "minimax-m3")
        self.assertEqual(model.openai_api_key.get_secret_value(), "synthetic-a2")
        self.assertEqual(model.extra_body, {})
        self.assertIsNone(model.reasoning_effort)
        self.assertEqual(model.max_retries, 0)

    def test_partial_a2agent_configuration_fails_instead_of_using_nara(self):
        with patch.dict(os.environ, {"a2agent_api_key": "synthetic", "NARA_ROUTER_KEY": "synthetic-nara", "NARA_ROUTER_URL": "https://router.bynara.id/v1", "NARA_ROUTER_MODEL": "old-model"}, clear=True):
            with self.assertRaisesRegex(ExtractionError, "a2agent_url"):
                configured_llm()

    def test_real_sdk_accepts_only_complete_json_with_optional_outer_code_fence(self):
        import httpx
        from langchain_openai import ChatOpenAI
        from peekaplate_processing.workflow import build_menu_graph
        dish = {"page_number": 1, "name": "Soup", "description": None, "category": None, "price_amount": "8.50", "price_currency": "CAD", "ingredients": None}
        valid = json.dumps({"dishes": [dish]})
        cases = [("<think>synthetic notes</think>\n" + valid, None), ("```json\n" + valid + "\n```", None), ("", "empty"), ('{"dishes": [', "malformed JSON"), (valid[:-1], "malformed JSON"), ('{"dishes": [], "dishes": []}', "duplicate"), (valid + " private trailing prose", "malformed JSON")]
        for content, expected in cases:
            with self.subTest(expected=expected):
                def respond(request):
                    return httpx.Response(200, json={"id": "synthetic", "object": "chat.completion", "created": 1, "model": "synthetic", "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}]})
                client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
                llm = ChatOpenAI(model="synthetic", api_key="synthetic", base_url="https://example.test/v1", http_async_client=client, max_retries=0)
                try:
                    result = run_sdk_test(build_menu_graph(llm).ainvoke({"pages": [{"page_number": 1, "text": "Soup 8.50 CAD"}], "batches": [], "worker_findings": []}))["final_report"]
                finally:
                    asyncio.run(client.aclose())
                if expected is None:
                    self.assertEqual(result["errors"], [])
                    self.assertEqual(result["dishes"], [ExtractedDish.model_validate(dish).model_dump()])
                else:
                    self.assertIn(expected, str(result["errors"]))
                    self.assertEqual(result["dishes"], [])
                self.assertNotIn("private trailing prose", str(result["errors"]))

    def test_refusal_rejects_even_valid_raw_json(self):
        class Refused(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["raw"].additional_kwargs = {"refusal": "private refusal explanation"}
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, Refused())
        self.assertEqual(report.drafts, [])
        self.assertIn("refused", str(report.errors))
        self.assertNotIn("private", str(report.errors))

    def test_synthetic_response_preview_is_opt_in_redacted_and_one_request(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from pydantic import SecretStr
        from peekaplate_processing.check_llm import main
        class NonJson(FakeLLM):
            model_name = "synthetic"
            openai_api_key = SecretStr("synthetic-private-key")
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["raw"].content = "not-json synthetic-private-key \x1b[31m"
                return answer
        for argv in [[], ["--show-response"]]:
            with self.subTest(argv=argv):
                llm = NonJson()
                output = StringIO()
                with patch("peekaplate_processing.check_llm.configured_llm", return_value=llm), patch("peekaplate_processing.check_llm.load_dotenv"), redirect_stdout(output):
                    self.assertEqual(main(argv), 1)
                text = output.getvalue()
                self.assertEqual(len(llm.calls), 1)
                self.assertNotIn("synthetic-private-key", text)
                self.assertNotIn("\x1b", text)
                if argv:
                    self.assertIn("content_preview", text)
                    self.assertIn("[REDACTED]", text)
                    self.assertIn("not-json", text)
                else:
                    self.assertNotIn("not-json", text)

    def test_complete_leading_minimax_thinking_wrapper_is_removed_before_json_validation(self):
        from peekaplate_processing.workflow import parse_dish_content
        dish = {"page_number": 1, "name": "Soup", "description": None, "category": None, "price_amount": "8.50", "price_currency": "CAD", "ingredients": None}
        valid = json.dumps({"dishes": [dish]})
        for content in ["<think>synthetic notes</think>\n\n" + valid, "<think>ignore this JSON: {\"dishes\": []}</think>\n```json\n" + valid + "\n```"]:
            with self.subTest(content=content):
                self.assertEqual(parse_dish_content(content).model_dump(), DishBatch(dishes=[ExtractedDish.model_validate(dish)]).model_dump())
        for content in ["<think>unfinished " + valid, "<think>notes</think>", "<think>" + valid + "</think>", "<think>notes</think>" + valid[:-1], "<think>notes</think>" + valid + " extra prose"]:
            with self.subTest(content=content), self.assertRaises(ExtractionError):
                parse_dish_content(content)

    def test_two_page_batches_cover_all_pages_once_and_keep_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"menu.pdf"
            path.write_bytes(make_pdf([{"text": f"Menu prices\nDish {i} 8.50 CAD"} for i in range(1, 36)]))
            llm = FakeLLM()
            with patch("peekaplate_processing.workflow.asyncio.sleep"):
                report = run_pipeline(path, Path(directory)/"run", llm=llm, batch_pages=2,input_mode="ocr")
            self.assertEqual(report.status, "complete", report.errors)
            self.assertEqual([len(p) for p in llm.calls], [2]*17+[1])
            self.assertEqual([p["page_number"] for batch in llm.calls for p in batch], list(range(1,36)))
            self.assertEqual(len(report.drafts), 35)
            self.assertEqual(report.configuration["llm_batch_pages"], 2)
            for draft, evidence in zip(report.drafts, report.evidence):
                span = evidence.spans[0]
                segment = next(s for s in report.segments if s.segment_id == span.segment_id)
                self.assertEqual(segment.text[span.start:span.end], draft.source_text)

    def test_invalid_batch_size_is_rejected_before_acquisition(self):
        for value in [0, -1, 11, 1.5, True]:
            with self.subTest(value=value), patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                with self.assertRaisesRegex(ExtractionError, "batch"):
                    run_pipeline("missing", "unused", llm=FakeLLM(), batch_pages=value)

    def test_one_unsupported_dish_does_not_discard_supported_dishes(self):
        class OneBad(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["parsed"].dishes[0].name = "unsupported private attribute"
                answer["raw"].content = answer["parsed"].model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 3, OneBad())
        self.assertEqual(report.status, "incomplete", report.errors)
        self.assertEqual([d.name for d in report.drafts], ["Dish 2", "Dish 3"])
        self.assertIn("dish 1", str(report.errors))
        self.assertNotIn("private attribute", str(report.errors))
        self.assertEqual(report.configuration["llm_batches"][0]["status"], "incomplete")

    def test_explicit_peso_prefix_is_a_supported_amount_without_currency_inference(self):
        from peekaplate_processing.workflow import check_grounding
        for text, currency in [("Soup P350", None), ("Soup PHP350", "PHP"), ("Soup ₱350.00", None)]:
            with self.subTest(text=text):
                dish = ExtractedDish(page_number=1, name="Soup", description=None, category=None, price_amount="350", price_currency=currency, ingredients=None)
                check_grounding(dish, text)
        for text in ["Soup X350", "Soup SKU-P350", "Soup -350"]:
            with self.subTest(text=text), self.assertRaises(ExtractionError):
                check_grounding(dish.model_copy(update={"price_currency": None}), text)
        with self.assertRaises(ExtractionError):
            check_grounding(dish.model_copy(update={"price_currency": "PHP"}), "Soup P350")

    def test_two_concurrent_workers_are_bounded_and_results_keep_page_order(self):
        from peekaplate_processing.workflow import run_menu_graph
        class Overlap(FakeLLM):
            active = 0
            peak = 0
            gate = None
            async def ainvoke(self, messages):
                if self.gate is None: self.gate = asyncio.Event()
                self.active += 1
                self.peak = max(self.peak, self.active)
                if self.active == 2: self.gate.set()
                await self.gate.wait()
                try:
                    return self.invoke(messages)
                finally:
                    self.active -= 1
        llm = Overlap()
        pages = [{"page_number": i, "text": f"Dish {i} 8.50 CAD"} for i in range(1,6)]
        with patch("peekaplate_processing.workflow.asyncio.sleep"):
            result = run_menu_graph(llm, pages, batch_pages=1, concurrency=2, request_timeout=0.2)
        self.assertEqual(llm.peak, 2)
        self.assertEqual(len(llm.calls), 5)
        self.assertEqual(result["errors"], [])
        self.assertEqual([d["page_number"] for d in result["dishes"]], list(range(1,6)))

    def test_invalid_concurrency_is_rejected_before_acquisition(self):
        for value in [0, 3, True, 1.5]:
            with self.subTest(value=value), patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                with self.assertRaisesRegex(ExtractionError, "concurrency"):
                    run_pipeline("missing", "unused", llm=FakeLLM(), llm_concurrency=value)

    def test_full_document_retains_more_than_100_grounded_dishes(self):
        class Many(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                dishes = []
                for page in json.loads(messages[1][1])["pages"]:
                    for variant in range(5):
                        dishes.append(ExtractedDish(page_number=page["page_number"], name=f"Dish {page['page_number']} variant {variant}", description=None, category=None, price_amount="8.50", price_currency="CAD", ingredients=None))
                answer["raw"].content = DishBatch(dishes=dishes).model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"menu.pdf"
            path.write_bytes(make_pdf([{"text": "\n".join(f"Dish {i} variant {v} 8.50 CAD" for v in range(5))} for i in range(1,36)]))
            with patch("peekaplate_processing.workflow.asyncio.sleep"):
                report = run_pipeline(path, Path(directory)/"run", llm=Many(), batch_pages=2,input_mode="ocr")
        self.assertEqual(report.status, "complete", report.errors)
        self.assertEqual(len(report.drafts), 175)
        self.assertEqual(len(report.evidence), 175)

    def test_per_response_100_dish_limit_still_rejects_oversized_batch(self):
        class Oversized(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                dish = answer["parsed"].dishes[0]
                answer["raw"].content = DishBatch(dishes=[dish]*101).model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, Oversized())
        self.assertEqual(report.status, "failed")
        self.assertEqual(report.drafts, [])
        self.assertIn("100-dish limit", str(report.errors))

    def test_unsupported_optional_fields_are_cleared_with_review_warnings(self):
        class OptionalGuesses(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                dish = answer["parsed"].dishes[0]
                dish.category = "unsupported category"
                dish.description = "unsupported description"
                dish.ingredients = ["unsupported ingredient"]
                dish.price_amount = "9999"
                dish.price_currency = "USD"
                answer["raw"].content = answer["parsed"].model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, OptionalGuesses())
        self.assertEqual(report.status, "complete", report.errors)
        self.assertEqual(len(report.drafts), 1)
        dish = report.drafts[0]
        self.assertEqual(dish.name, "Dish 1")
        for field in ["category", "description", "ingredients", "price_amount", "price_currency"]:
            self.assertIsNone(getattr(dish, field))
            self.assertTrue(any(field in warning for warning in dish.review_warnings))
        self.assertEqual(dish.status, "needs_review")
        self.assertTrue(report.warnings)

    def test_optional_category_warning_preserves_grounded_name_and_price(self):
        class GuessedCategory(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["parsed"].dishes[0].category = "unsupported category"
                answer["raw"].content = answer["parsed"].model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, GuessedCategory())
        self.assertEqual(len(report.drafts), 1)
        self.assertIsNone(report.drafts[0].category)
        self.assertEqual(str(report.drafts[0].price_amount), "8.50")
        self.assertEqual(report.drafts[0].price_currency, "CAD")

    def test_invalid_optional_currency_is_cleared_instead_of_losing_dish(self):
        class InvalidCurrency(FakeLLM):
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["parsed"].dishes[0].price_currency = ""
                answer["raw"].content = answer["parsed"].model_dump_json()
                return answer
        with tempfile.TemporaryDirectory() as directory:
            report = self.run_case(directory, 1, InvalidCurrency())
        self.assertEqual(len(report.drafts), 1, report.errors)
        self.assertIsNone(report.drafts[0].price_currency)
        self.assertTrue(any("price_currency" in w for w in report.drafts[0].review_warnings))

    def test_candidate_cache_reuses_responses_and_rechecks_grounding(self):
        from peekaplate_processing.workflow import run_menu_graph
        class Cached(FakeLLM):
            model_name = "synthetic-model"
            openai_api_base = "https://example.test/v1"
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["parsed"].dishes[0].category = "unsupported category"
                answer["raw"].content = "<think>synthetic notes never stored</think>\n" + answer["parsed"].model_dump_json()
                return answer
        pages = [{"page_number": 1, "text": "Dish 1 8.50 CAD"}]
        with tempfile.TemporaryDirectory() as directory:
            llm = Cached()
            first = run_menu_graph(llm, pages, cache_dir=directory, source_sha256="0"*64)
            second = run_menu_graph(llm, pages, cache_dir=directory, source_sha256="0"*64)
            self.assertEqual(len(llm.calls), 1)
            self.assertEqual(first["dishes"], second["dishes"])
            self.assertFalse(first["batches"][0]["cache_hit"])
            self.assertTrue(second["batches"][0]["cache_hit"])
            path = next(Path(directory).glob("*.json"))
            content = json.loads(path.read_text())
            self.assertNotIn("synthetic notes never stored", path.read_text())
            self.assertEqual(content["dishes"][0]["category"], "unsupported category")
            self.assertIsNone(second["dishes"][0]["category"])
            self.assertTrue(second["dishes"][0]["review_warnings"])
            content["dishes"][0]["name"] = "unsupported cached name"
            path.write_text(json.dumps(content))
            third = run_menu_graph(llm, pages, cache_dir=directory, source_sha256="0"*64)
            self.assertEqual(third["dishes"], [])
            self.assertTrue(third["errors"])
            self.assertEqual(len(llm.calls), 1)

    def test_candidate_cache_is_scoped_to_source_model_and_page_text(self):
        from peekaplate_processing.workflow import run_menu_graph
        class Cached(FakeLLM):
            model_name = "synthetic-model"
            openai_api_base = "https://example.test/v1"
        with tempfile.TemporaryDirectory() as directory:
            llm = Cached()
            pages = [{"page_number": 1, "text": "Dish 1 8.50 CAD"}]
            for source in ["0"*64,"1"*64]:
                run_menu_graph(llm, pages, cache_dir=directory, source_sha256=source)
            llm.model_name = "another-model"
            run_menu_graph(llm, pages, cache_dir=directory, source_sha256="1"*64)
            pages[0]["text"] += " Changed source text"
            run_menu_graph(llm, pages, cache_dir=directory, source_sha256="1"*64)
            self.assertEqual(len(llm.calls), 4)

    def test_truncated_model_response_is_not_cached(self):
        from peekaplate_processing.workflow import run_menu_graph
        class Truncated(FakeLLM):
            model_name = "synthetic-model"
            openai_api_base = "https://example.test/v1"
            def invoke(self, messages):
                answer = super().invoke(messages)
                answer["raw"].response_metadata["finish_reason"] = "length"
                return answer
        with tempfile.TemporaryDirectory() as directory:
            llm = Truncated()
            for _ in range(2):
                result = run_menu_graph(llm, [{"page_number": 1, "text": "Dish 1 8.50 CAD"}], cache_dir=directory, source_sha256="0"*64)
                self.assertEqual(result["dishes"], [])
            self.assertEqual(len(llm.calls), 2)
            self.assertEqual(list(Path(directory).glob("*.json")), [])

    def test_invalid_candidate_cache_fails_without_an_extra_request(self):
        from peekaplate_processing.workflow import run_menu_graph
        class Cached(FakeLLM):
            model_name = "synthetic-model"
            openai_api_base = "https://example.test/v1"
        with tempfile.TemporaryDirectory() as directory:
            llm = Cached()
            pages = [{"page_number": 1, "text": "Dish 1 8.50 CAD"}]
            run_menu_graph(llm, pages, cache_dir=directory, source_sha256="0"*64)
            path = next(Path(directory).glob("*.json"))
            path.write_text("invalid cache json")
            result = run_menu_graph(llm, pages, cache_dir=directory, source_sha256="0"*64)
            self.assertEqual(len(llm.calls), 1)
            self.assertEqual(result["dishes"], [])
            self.assertIn("cache is invalid", str(result["errors"]))

    def test_cache_write_failure_keeps_successful_drafts(self):
        from peekaplate_processing.workflow import run_menu_graph
        class Cached(FakeLLM):
            model_name = "synthetic-model"
            openai_api_base = "https://example.test/v1"
        with tempfile.TemporaryDirectory() as directory, patch("peekaplate_processing.model_cache.save_json", side_effect=ExtractionError("private storage error")):
            result = run_menu_graph(Cached(), [{"page_number": 1, "text": "Dish 1 8.50 CAD"}], cache_dir=directory, source_sha256="0"*64)
        self.assertEqual(len(result["dishes"]), 1)
        self.assertEqual(result["errors"], [])
        self.assertTrue(any("could not be cached" in w for w in result["warnings"]))
        self.assertNotIn("private storage error", str(result))
