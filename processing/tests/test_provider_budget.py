"""Deterministic offline tests for atomic, run-scoped provider-call budget enforcement."""

from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

import httpx
import pymupdf
from langchain_core.messages import AIMessage

from peekaplate_processing.model_providers import create_cascading_clients, create_model_client
from peekaplate_processing.ocr_space import OCRSpaceClient
from peekaplate_processing.provider_budget import ProviderBudgetError, ProviderBudgetGate
from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.service import ExtractRequest, Settings, _BudgetProxyServer
from peekaplate_processing.vision_extraction import extract_vision_v4
from peekaplate_processing.workflow import run_menu_graph


class _FakeAtomicBudget:
    """In-memory atomic budget mimicking ExtractionContainer SQLite behavior."""

    def __init__(self, *, max_calls: int = 2, token: str = "test-budget-token", mode: str = "normal") -> None:
        self.max_calls = max_calls
        self.token = token
        self.mode = mode
        self.lock = threading.Lock()
        self.runs: dict[str, int] = {}
        self.reservations: dict[str, tuple[int, dict]] = {}
        self.requests: list[dict] = []
        self.url = "https://budget.local/reserve"

    def handle_post(self, url: str, *, json: dict | None = None, content: bytes | None = None, headers: dict | None = None, **kwargs) -> httpx.Response:
        req = httpx.Request("POST", url, headers=headers or {})
        if self.mode == "network_error":
            raise httpx.ConnectError("connection refused", request=req)
        auth = (headers or {}).get("Authorization")
        if auth != f"Bearer {self.token}":
            return httpx.Response(401, json={"error": "unauthorized"}, request=req)
        if self.mode == "malformed":
            return httpx.Response(200, content=b"not-json", request=req)
        if self.mode == "error500":
            return httpx.Response(500, json={"error": "internal"}, request=req)

        body = json if json is not None else __import__("json").loads((content or b"{}").decode("utf-8"))
        run_id = (headers or {}).get("X-Run-ID", "default-run")
        reservation_key = body["reservation_key"]
        provider = body["provider"]

        with self.lock:
            self.requests.append({"run_id": run_id, "provider": provider, "key": reservation_key})
            if reservation_key in self.reservations:
                status, payload = self.reservations[reservation_key]
            else:
                used = self.runs.get(run_id, 0)
                if used < self.max_calls:
                    used += 1
                    self.runs[run_id] = used
                    payload = {
                        "granted": True,
                        "run_id": run_id,
                        "used_calls": used,
                        "max_calls": self.max_calls,
                        "remaining_calls": self.max_calls - used,
                        "reservation_key": reservation_key,
                    }
                    status = 200
                else:
                    payload = {
                        "granted": False,
                        "error": "provider_call_budget_exhausted",
                        "run_id": run_id,
                        "used_calls": used,
                        "max_calls": self.max_calls,
                        "remaining_calls": 0,
                        "reservation_key": reservation_key,
                    }
                    status = 429
                self.reservations[reservation_key] = (status, payload)

        return httpx.Response(status, json=payload, request=req)


def _make_sample_pdf(path: Path, pages: int = 1) -> None:
    doc = pymupdf.open()
    for index in range(pages):
        page = doc.new_page(width=400, height=400)
        page.insert_text((40, 60), f"Menu Page {index + 1}\nTruffle Fries $12.00")
    doc.save(path)
    doc.close()


class _FakeAsyncLLM:
    def __init__(self, *, fail: bool = False, response_text: str = '{"dishes": []}', structured: bool = False) -> None:
        self.fail = fail
        self.response_text = response_text
        self.structured = structured
        self.model_name = "fake-model"
        self.calls = 0

    def bind(self, **kwargs):
        return self

    def with_structured_output(self, schema, **kwargs):
        self.structured = True
        return self

    async def ainvoke(self, messages):
        self.calls += 1
        if self.fail:
            raise RuntimeError("synthetic provider failure")
        msg = AIMessage(content=self.response_text, response_metadata={"finish_reason": "stop"})
        if self.structured:
            return {"raw": msg}
        return msg


class ProviderBudgetUnitTests(unittest.TestCase):
    def test_from_env_fails_closed_when_required_or_partial(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(ProviderBudgetGate.from_env(required=False))
            with self.assertRaises(ProviderBudgetError):
                ProviderBudgetGate.from_env(required=True)

        with patch.dict(os.environ, {"PEEK_BUDGET_URL": "https://budget.local/reserve"}, clear=True):
            with self.assertRaises(ProviderBudgetError):
                ProviderBudgetGate.from_env(required=False)

    def test_gate_enforces_limit_and_fails_closed_on_errors(self) -> None:
        budget = _FakeAtomicBudget(max_calls=2)
        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post):
            gate = ProviderBudgetGate(budget.url, budget.token)
            first = gate.reserve("google_studio")
            second = gate.reserve("qwen")
            self.assertEqual(first["used_calls"], 1)
            self.assertEqual(second["used_calls"], 2)
            with self.assertRaises(ProviderBudgetError):
                gate.reserve("glm")

        for mode in ("malformed", "error500", "network_error"):
            bad = _FakeAtomicBudget(max_calls=2, mode=mode)
            with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=bad.handle_post):
                gate = ProviderBudgetGate(bad.url, bad.token)
                with self.assertRaises(ProviderBudgetError):
                    gate.reserve("google_studio")

        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post):
            bad_auth_gate = ProviderBudgetGate(budget.url, "wrong-token")
            with self.assertRaises(ProviderBudgetError):
                bad_auth_gate.reserve("google_studio")

    def test_concurrent_reservations_cannot_exceed_two(self) -> None:
        budget = _FakeAtomicBudget(max_calls=2)
        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post):
            gate = ProviderBudgetGate(budget.url, budget.token)

            def attempt(_idx: int) -> bool:
                try:
                    gate.reserve("qwen")
                    return True
                except ProviderBudgetError:
                    return False

            with ThreadPoolExecutor(max_workers=6) as pool:
                outcomes = list(pool.map(attempt, range(6)))

            self.assertEqual(sum(outcomes), 2)
            self.assertEqual(budget.runs["default-run"], 2)

    def test_vision_extraction_stops_before_third_outbound_call(self) -> None:
        budget = _FakeAtomicBudget(max_calls=2)
        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post):
            gate = ProviderBudgetGate(budget.url, budget.token)
            llm = _FakeAsyncLLM(
                response_text=json.dumps({"dishes": []})
            )
            pages = [
                {"page_number": 1, "image_url": "data:image/png;base64,iVBORw0KGgo="},
                {"page_number": 2, "image_url": "data:image/png;base64,iVBORw0KGgo="},
                {"page_number": 3, "image_url": "data:image/png;base64,iVBORw0KGgo="},
            ]
            with self.assertRaises(ProviderBudgetError):
                extract_vision_v4(llm, pages, provider="google_studio", budget_gate=gate)
            self.assertEqual(llm.calls, 2)

    def test_cascading_providers_and_queue_redelivery_share_budget_and_skip_ocr(self) -> None:
        budget = _FakeAtomicBudget(max_calls=2)
        p1 = _FakeAsyncLLM(fail=True)
        p2 = _FakeAsyncLLM(fail=True)
        p3 = _FakeAsyncLLM(fail=False)

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "menu.pdf"
            _make_sample_pdf(pdf_path, pages=1)
            with (
                patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post),
                patch(
                    "peekaplate_processing.run_pipeline.create_cascading_clients",
                    return_value=[("google_studio", p1), ("qwen", p2), ("glm", p3)],
                ),
                patch("peekaplate_processing.run_pipeline.extract_source") as mock_ocr,
            ):
                gate = ProviderBudgetGate(budget.url, budget.token)
                report = run_pipeline(
                    pdf_path,
                    Path(tmp) / "run1",
                    input_mode="vision_v4",
                    llm_cache_dir=None,
                    cache_dir=None,
                    budget_gate=gate,
                )
                self.assertEqual(report.status, "failed")
                self.assertEqual(p1.calls, 1)
                self.assertEqual(p2.calls, 1)
                self.assertEqual(p3.calls, 0)
                mock_ocr.assert_not_called()

                # Simulate Queue redelivery reusing the same run_id budget: 0 new calls allowed.
                report_retry = run_pipeline(
                    pdf_path,
                    Path(tmp) / "run2",
                    input_mode="vision_v4",
                    llm_cache_dir=None,
                    cache_dir=None,
                    budget_gate=gate,
                )
                self.assertEqual(report_retry.status, "failed")
                self.assertEqual(p1.calls, 1)
                self.assertEqual(p2.calls, 1)
                self.assertEqual(p3.calls, 0)
                mock_ocr.assert_not_called()

    def test_ocr_space_retries_consume_budget_and_block_third_attempt(self) -> None:
        budget = _FakeAtomicBudget(max_calls=2)
        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post):
            gate = ProviderBudgetGate(budget.url, budget.token)
            client = OCRSpaceClient("valid-ocr-key", max_attempts=2, budget_gate=gate)
            with (
                patch("peekaplate_processing.ocr_space.build_opener") as mock_opener,
                patch("peekaplate_processing.ocr_space.time.sleep"),
            ):
                mock_opener.return_value.open.side_effect = URLError("timeout")
                with self.assertRaises(Exception):
                    client.extract(b"\xff\xd8\xff\xe0" + b"0" * 32)
                self.assertEqual(client.transport_attempts, 2)

                # Third attempt on the same run must fail closed BEFORE transport.
                with self.assertRaises(ProviderBudgetError):
                    client.extract(b"\xff\xd8\xff\xe0" + b"0" * 32)
                self.assertEqual(client.transport_attempts, 2)

    def test_workflow_menu_graph_respects_budget_gate(self) -> None:
        budget = _FakeAtomicBudget(max_calls=2)
        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post):
            gate = ProviderBudgetGate(budget.url, budget.token)
            llm = _FakeAsyncLLM(
                response_text=json.dumps({"dishes": [], "sections": []})
            )
            pages = [
                {"page_number": 1, "segment_id": "s1", "text": "Soup $8", "ocr_metadata": None},
                {"page_number": 2, "segment_id": "s2", "text": "Salad $9", "ocr_metadata": None},
                {"page_number": 3, "segment_id": "s3", "text": "Cake $7", "ocr_metadata": None},
            ]
            report = run_menu_graph(
                llm,
                pages,
                batch_pages=1,
                concurrency=1,
                cache_dir=None,
                budget_gate=gate,
                budget_provider="qwen",
            )
            self.assertEqual(llm.calls, 2)
            self.assertEqual(len(report["errors"]), 1)
            self.assertIn("ProviderBudgetError", report["errors"][0])

    def test_service_budget_proxy_rejects_unauthorized_and_forwards_with_host_auth(self) -> None:
        secret = "host-secret-" + "a" * 40
        budget = _FakeAtomicBudget(max_calls=2, token=secret)
        settings = Settings(secret=secret, source_origin="https://budget.local")
        job = ExtractRequest(
            job_id="00000000-0000-4000-8000-000000000001",
            tenant_id="00000000-0000-4000-8000-000000000002",
            idempotency_key="idem-key-1",
            source_type="pdf",
            source_storage_key="menu-ingestion/sources/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000001/source",
            source_hash="a" * 64,
        )

        # Verify handler construction and request/auth validation without opening sockets.
        with patch("peekaplate_processing.service.ThreadingHTTPServer") as mock_server_cls:
            mock_server_cls.return_value.server_address = ("127.0.0.1", 55555)
            proxy = _BudgetProxyServer(settings, job, "cap-jwt")
            handler_cls = mock_server_cls.call_args.args[1]

        def invoke_handler(path: str, auth: str, payload: bytes) -> tuple[int, dict]:
            handler = object.__new__(handler_cls)
            handler.path = path
            handler.headers = {"Authorization": auth, "Content-Length": str(len(payload))}
            handler.rfile = io.BytesIO(payload)
            handler.wfile = io.BytesIO()
            status_holder: list[int] = []
            handler.send_response = lambda code: status_holder.append(code)
            handler.send_header = lambda k, v: None
            handler.end_headers = lambda: None
            handler.do_POST()
            raw = handler.wfile.getvalue().decode("utf-8")
            return status_holder[0], json.loads(raw) if raw else {}

        status, _ = invoke_handler("/_internal/budget/reserve", "Bearer wrong", b'{"reservation_key":"k1","provider":"qwen"}')
        self.assertEqual(status, 401)

        with patch("peekaplate_processing.service.httpx.post", side_effect=budget.handle_post):
            status_ok, body_ok = invoke_handler(
                "/_internal/budget/reserve",
                f"Bearer {proxy.token}",
                b'{"reservation_key":"k1","provider":"google_studio"}',
            )
            self.assertEqual(status_ok, 200)
            self.assertTrue(body_ok["granted"])
            self.assertEqual(body_ok["used_calls"], 1)

    def test_budget_timeout_fails_closed(self) -> None:
        def timeout_post(url: str, **kwargs):
            raise httpx.ReadTimeout("budget read timed out", request=httpx.Request("POST", url))

        gate = ProviderBudgetGate("https://budget.local/reserve", "token", timeout=0.1)
        with patch("peekaplate_processing.provider_budget.httpx.post", side_effect=timeout_post):
            with self.assertRaises(ProviderBudgetError):
                gate.reserve("google_studio")

    def test_model_providers_disable_sdk_retries(self) -> None:
        fake_env = {
            "GOOGLE_API_KEY": "k1",
            "DASHSCOPE_API_KEY": "k2",
            "ZHIPU_API_KEY": "k3",
            "OPENROUTER_API_KEY": "k4",
            "MENU_AI_API_KEY": "k5",
            "MENU_AI_API_URL": "https://api.example.com/v1",
            "MENU_AI_MODEL": "test-model",
        }
        with patch.dict(os.environ, fake_env, clear=True):
            clients = create_cascading_clients()
            self.assertEqual([name for name, _ in clients], ["google_studio", "qwen", "glm", "openrouter"])
            for _, client in clients:
                self.assertEqual(client.max_retries, 0)
            generic = create_model_client(env=fake_env)
            self.assertEqual(generic.max_retries, 0)

    def test_provider_timeout_consumes_budget_and_blocks_fallback(self) -> None:
        class _TimeoutLLM(_FakeAsyncLLM):
            async def ainvoke(self, messages):
                self.calls += 1
                raise TimeoutError("provider timed out")

        budget = _FakeAtomicBudget(max_calls=2)
        p1 = _TimeoutLLM()
        p2 = _FakeAsyncLLM(fail=False)
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "menu.pdf"
            _make_sample_pdf(pdf_path, pages=1)
            with (
                patch("peekaplate_processing.provider_budget.httpx.post", side_effect=budget.handle_post),
                patch(
                    "peekaplate_processing.run_pipeline.create_cascading_clients",
                    return_value=[("google_studio", p1), ("qwen", p2)],
                ),
                patch("peekaplate_processing.run_pipeline.extract_source") as mock_ocr,
            ):
                gate = ProviderBudgetGate(budget.url, budget.token)
                report = run_pipeline(
                    pdf_path,
                    Path(tmp) / "run_timeout",
                    input_mode="vision_v4",
                    llm_cache_dir=None,
                    cache_dir=None,
                    budget_gate=gate,
                )
                self.assertEqual(report.status, "failed")
                self.assertEqual(p1.calls, 1)
                self.assertEqual(p2.calls, 0)
                self.assertEqual(budget.runs["default-run"], 1)
                mock_ocr.assert_not_called()


if __name__ == "__main__":
    unittest.main()
