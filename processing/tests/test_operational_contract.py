"""Offline operational and quality-protocol contract checks (O1-O13).

These tests validate producer-side operational invariants, recovery budgets,
and test-local quality/manifest protocol rules without live network calls or
claiming external hosted/consumer/held-out quality gates passed.
"""
import base64
import copy
import hashlib
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch
from urllib.error import HTTPError

import httpx
from fastapi.testclient import TestClient

from fixture_factory import make_pdf
from test_input_modes import RecordingLLM
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.ocr_space import OCRSpaceClient
from peekaplate_processing.recover_pages import recover_pages
from peekaplate_processing.review_candidates import ReviewCandidateResult, prepare_review_candidates
from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.schemas import MenuExtractionResult, SourceSegment
from peekaplate_processing.service import (
    ExtractRequest,
    JOB_TIMEOUT_SECONDS,
    MAX_BUNDLE_BYTES,
    MAX_REPORT_BYTES,
    MAX_REQUEST_BYTES,
    MAX_SOURCE_BYTES,
    Settings,
    create_app,
    read_result,
    read_source,
    run_extraction,
)
from peekaplate_processing.vision import image_source

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class OperationalContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.data = b"%PDF-1.4 synthetic operational test"
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.payload = {
            "job_id": "00000000-0000-4000-8000-000000000001",
            "tenant_id": "00000000-0000-4000-8000-000000000002",
            "source_type": "pdf",
            "source_url": None,
            "source_storage_key": (
                "menu-ingestion/sources/00000000-0000-4000-8000-000000000002/"
                "00000000-0000-4000-8000-000000000001/source"
            ),
            "source_hash": self.digest,
            "idempotency_key": "synthetic-operational-test",
        }
        self.headers = {
            "Authorization": "Bearer " + "synthetic-test-token-" * 3,
            "X-Job-ID": self.payload["job_id"],
            "X-Tenant-ID": self.payload["tenant_id"],
            "X-Source-Hash": self.digest,
            "X-Source-Capability": "synthetic-job-bound-capability",
        }
        self.settings = Settings(
            secret="synthetic-test-token-" * 3,
            source_origin="https://peekaplate-extraction-staging.vxkong.workers.dev",
        )
        self.report = {
            "started_at": "2026-10-27T00:00:00Z",
            "status": "failed",
            "source": {
                "source_id": "sha256:" + self.digest,
                "sha256": self.digest,
                "kind": "pdf",
                "location": "source.pdf",
                "size_bytes": len(self.data),
                "retrieved_at": "2026-10-27T00:00:00Z",
                "snapshot_base64": base64.b64encode(self.data).decode(),
            },
            "errors": ["Synthetic report; no provider called."],
        }

    # O1
    def test_transfer_read_timeout_closes_stream_skips_runner_and_releases_slot(self) -> None:
        closed = []

        class TimeoutStreamContext:
            status_code = 200
            headers = {"content-length": str(len(self.data))}

            def __enter__(self_ctx):
                return self_ctx

            def __exit__(self_ctx, exc_type, exc, tb):
                closed.append(True)
                return False

            def iter_bytes(self_ctx):
                yield self.data[:8]
                raise httpx.ReadTimeout("simulated stream read timeout")

        runner = Mock(return_value=self.report)
        app = create_app(self.settings, runner=runner)
        client = TestClient(app)

        with patch("peekaplate_processing.service.httpx.stream", return_value=TimeoutStreamContext()):
            res1 = client.post("/extract", json=self.payload, headers=self.headers)
        self.assertEqual(res1.status_code, 502)
        self.assertEqual(res1.headers.get("cache-control"), "no-store")
        self.assertEqual(closed, [True])
        runner.assert_not_called()

        # Slot is released so a subsequent healthy request succeeds
        class HealthyStreamContext:
            status_code = 200
            headers = {"content-length": str(len(self.data))}

            def __enter__(self_ctx):
                return self_ctx

            def __exit__(self_ctx, exc_type, exc, tb):
                return False

            def iter_bytes(self_ctx):
                yield self.data

        with patch("peekaplate_processing.service.httpx.stream", return_value=HealthyStreamContext()):
            res2 = client.post("/extract", json=self.payload, headers=self.headers)
        self.assertEqual(res2.status_code, 200)
        runner.assert_called_once()

    # O2
    def test_transfer_phase_timeout_does_not_establish_elapsed_deadline(self) -> None:
        # Characterizes the current per-phase timeout=20 vs total elapsed transfer gap without sleep.
        simulated_elapsed = [0]
        observed_timeout = []

        class SlowTrickleStream:
            status_code = 200
            headers = {"content-length": str(len(self.data))}

            def __enter__(self_ctx):
                return self_ctx

            def __exit__(self_ctx, exc_type, exc, tb):
                return False

            def iter_bytes(self_ctx):
                simulated_elapsed[0] += 11
                yield self.data[:10]
                simulated_elapsed[0] += 11
                yield self.data[10:]

        def fake_stream(method, url, *, headers=None, timeout=None, follow_redirects=None):
            observed_timeout.append(timeout)
            return SlowTrickleStream()

        job = ExtractRequest.model_validate(self.payload)
        with patch("peekaplate_processing.service.httpx.stream", side_effect=fake_stream):
            out = read_source(job, self.settings, "cap")
        self.assertEqual(observed_timeout, [20])
        self.assertEqual(simulated_elapsed[0], 22)
        self.assertEqual(out, self.data)

    # O3
    def test_child_cleanup_on_success_invalid_exit_and_timeout(self) -> None:
        seen_dirs = []

        # 1) Success path (exit 0)
        def child_ok(cmd, **kwargs):
            self.assertEqual(kwargs.get("timeout"), 700)
            self.assertNotIn("EXTRACTION_SERVICE_SECRET", kwargs.get("env", {}))
            run_dir = Path(cmd[cmd.index("--run-dir") + 1])
            seen_dirs.append(run_dir.parent)
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / "extraction.json").write_text(json.dumps(self.report))
            return subprocess.CompletedProcess(cmd, 0)

        with patch("peekaplate_processing.service.subprocess.run", side_effect=child_ok):
            res = run_extraction(self.data, "pdf", 700)
        self.assertEqual(res["status"], "failed")
        self.assertFalse(seen_dirs[-1].exists())

        # 2) Invalid exit code (e.g. exit 9)
        def child_bad_exit(cmd, **kwargs):
            run_dir = Path(cmd[cmd.index("--run-dir") + 1])
            seen_dirs.append(run_dir.parent)
            return subprocess.CompletedProcess(cmd, 9)

        with patch("peekaplate_processing.service.subprocess.run", side_effect=child_bad_exit):
            with self.assertRaises(subprocess.CalledProcessError):
                run_extraction(self.data, "pdf", 700)
        self.assertFalse(seen_dirs[-1].exists())

        # 3) TimeoutExpired path
        def child_timeout(cmd, **kwargs):
            run_dir = Path(cmd[cmd.index("--run-dir") + 1])
            seen_dirs.append(run_dir.parent)
            raise subprocess.TimeoutExpired(cmd, timeout=700)

        with patch("peekaplate_processing.service.subprocess.run", side_effect=child_timeout):
            with self.assertRaises(subprocess.TimeoutExpired):
                run_extraction(self.data, "pdf", 700)
        self.assertFalse(seen_dirs[-1].exists())

    # O4
    def test_source_stream_length_and_byte_limit_boundaries(self) -> None:
        job = ExtractRequest.model_validate(self.payload)

        def run_stream(header_len: int, chunks: list[bytes]):
            class Ctx:
                status_code = 200
                headers = {"content-length": str(header_len)}

                def __enter__(self_ctx):
                    return self_ctx

                def __exit__(self_ctx, exc_type, exc, tb):
                    return False

                def iter_bytes(self_ctx):
                    yield from chunks

            with patch("peekaplate_processing.service.httpx.stream", return_value=Ctx()):
                return read_source(job, self.settings, "cap")

        # Zero length -> None
        self.assertIsNone(run_stream(0, [b""]))
        # Header > MAX_SOURCE_BYTES -> None
        self.assertIsNone(run_stream(MAX_SOURCE_BYTES + 1, [b"x"]))
        # Truncated body (< header) -> None
        self.assertIsNone(run_stream(10, [b"12345"]))
        # Overflow body (> header) -> None
        self.assertIsNone(run_stream(5, [b"123456"]))
        # Stream chunks exceeding MAX_SOURCE_BYTES despite header == MAX_SOURCE_BYTES -> None
        self.assertIsNone(run_stream(MAX_SOURCE_BYTES, [b"a" * MAX_SOURCE_BYTES, b"b"]))
        # Exact MAX_SOURCE_BYTES -> returns exact bytes
        exact = b"a" * MAX_SOURCE_BYTES
        self.assertEqual(len(run_stream(MAX_SOURCE_BYTES, [exact])), MAX_SOURCE_BYTES)

    # O5
    def test_artifact_file_read_limits_accept_exact_and_reject_plus_one(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, cap in [
                ("extraction.json", MAX_REPORT_BYTES),
                ("review-suggestions.json", 8_000_000),
                ("timings.json", 1_000_000),
            ]:
                with self.subTest(artifact=name, cap=cap):
                    
                    p = root / name
                    base = b'{"ok":true}'
                    exact_payload = base + b" " * (cap - len(base))
                    self.assertEqual(len(exact_payload), cap)
                    p.write_bytes(exact_payload)
                    self.assertEqual(read_result(p, cap), {"ok": True})

                    over_payload = exact_payload + b" "
                    self.assertEqual(len(over_payload), cap + 1)
                    p.write_bytes(over_payload)
                    with self.assertRaises(ValueError):
                        read_result(p, cap)

    # O6
    def test_report_and_negotiated_bundle_serialized_byte_boundaries(self) -> None:
        storage = Mock(return_value=self.data)
        # 1) Public report at exact MAX_REPORT_BYTES vs MAX_REPORT_BYTES + 1
        base_report = copy.deepcopy(self.report)
        base_report["warnings"] = [""]
        validated = MenuExtractionResult.model_validate(base_report).model_dump(mode="json")
        empty_len = len(json.dumps(validated).encode("utf-8"))
        pad_exact = MAX_REPORT_BYTES - empty_len
        exact_report = copy.deepcopy(base_report)
        exact_report["warnings"] = ["a" * pad_exact]
        self.assertEqual(
            len(json.dumps(MenuExtractionResult.model_validate(exact_report).model_dump(mode="json")).encode("utf-8")),
            MAX_REPORT_BYTES,
        )

        client = TestClient(create_app(self.settings, source_reader=storage, runner=Mock(return_value=exact_report)))
        res_ok = client.post("/extract", json=self.payload, headers=self.headers)
        self.assertEqual(res_ok.status_code, 200)

        over_report = copy.deepcopy(base_report)
        over_report["warnings"] = ["a" * (pad_exact + 1)]
        client_over = TestClient(create_app(self.settings, source_reader=storage, runner=Mock(return_value=over_report)))
        res_over = client_over.post("/extract", json=self.payload, headers=self.headers)
        self.assertEqual(res_over.status_code, 502)
        self.assertEqual(res_over.json(), {"error": "report_too_large"})

        # 2) Negotiated bundle at exact MAX_BUNDLE_BYTES vs MAX_BUNDLE_BYTES + 1
        bundle_headers = {**self.headers, "X-Extraction-Artifact-Bundle": "1"}
        base_bundle = {
            "schema_version": 1,
            "report": validated,
            "review_suggestions": {
                "schema_version": 1,
                "source_id": "sha256:" + self.digest,
                "input_mode": "ocr_image",
                "status": "failed",
                "suggestions": [],
                "warnings": [""],
            },
            "timings": {
                "schema_version": 1,
                "input_mode": "ocr_image",
                "status": "failed",
                "timings_seconds": {"total": 1.0},
            },
        }
        empty_bundle_len = len(json.dumps(base_bundle).encode("utf-8"))
        bundle_pad = MAX_BUNDLE_BYTES - empty_bundle_len
        exact_bundle = copy.deepcopy(base_bundle)
        exact_bundle["review_suggestions"]["warnings"] = ["b" * bundle_pad]
        self.assertEqual(len(json.dumps(exact_bundle).encode("utf-8")), MAX_BUNDLE_BYTES)

        client_b_ok = TestClient(create_app(self.settings, source_reader=storage, runner=Mock(return_value=exact_bundle)))
        res_b_ok = client_b_ok.post("/extract", json=self.payload, headers=bundle_headers)
        self.assertEqual(res_b_ok.status_code, 200)

        over_bundle = copy.deepcopy(base_bundle)
        over_bundle["review_suggestions"]["warnings"] = ["b" * (bundle_pad + 1)]
        client_b_over = TestClient(create_app(self.settings, source_reader=storage, runner=Mock(return_value=over_bundle)))
        res_b_over = client_b_over.post("/extract", json=self.payload, headers=bundle_headers)
        self.assertEqual(res_b_over.status_code, 502)
        self.assertEqual(res_b_over.json(), {"error": "bundle_too_large"})

    # O7
    def test_artifact_status_matrix_and_public_private_separation(self) -> None:
        fixture = json.loads((FIXTURES / "service-artifacts/representative-bundle.json").read_text())
        source_bytes = base64.b64decode(fixture["report"]["source"]["snapshot_base64"])
        digest = fixture["report"]["source"]["sha256"]
        payload = {**self.payload, "source_hash": digest}
        headers = {**self.headers, "X-Source-Hash": digest}
        storage = Mock(return_value=source_bytes)

        for status in ("complete", "incomplete", "failed"):
            with self.subTest(status=status):
                bundle = copy.deepcopy(fixture)
                bundle["report"]["status"] = status
                bundle["review_suggestions"]["status"] = status
                bundle["timings"]["status"] = status
                if status == "failed":
                    bundle["report"]["drafts"] = []
                    bundle["report"]["evidence"] = []

                # Negotiated request returns full bundle with matching status and unvalidated suggestions
                client = TestClient(create_app(self.settings, source_reader=storage, runner=Mock(return_value=bundle)))
                res_neg = client.post(
                    "/extract",
                    json=payload,
                    headers={**headers, "X-Extraction-Artifact-Bundle": "1"},
                )
                self.assertEqual(res_neg.status_code, 200)
                body_neg = res_neg.json()
                self.assertEqual(body_neg["report"]["status"], status)
                self.assertEqual(body_neg["timings"]["status"], status)
                for s in body_neg["review_suggestions"]["suggestions"]:
                    self.assertEqual(s["status"], "unvalidated")

                # Public request returns only the public report without private sidecars
                res_pub = client.post("/extract", json=payload, headers=headers)
                self.assertEqual(res_pub.status_code, 200)
                body_pub = res_pub.json()
                self.assertNotIn("review_suggestions", body_pub)
                self.assertNotIn("timings", body_pub)
                self.assertEqual(body_pub["status"], status)

        # Mutating scope/mode/status fails closed (502)
        for mutate in [
            lambda b: b["review_suggestions"].update(source_id="sha256:" + "0" * 64),
            lambda b: b["review_suggestions"].update(input_mode="image"),
            lambda b: b["timings"].update(status="failed"),
        ]:
            bad = copy.deepcopy(fixture)
            mutate(bad)
            client_bad = TestClient(create_app(self.settings, source_reader=storage, runner=Mock(return_value=bad)))
            res_bad = client_bad.post(
                "/extract",
                json=payload,
                headers={**headers, "X-Extraction-Artifact-Bundle": "1"},
            )
            self.assertEqual(res_bad.status_code, 502)

    # O8
    def test_ocr_recovery_caps_one_and_four_count_transport_attempts(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            source.write_bytes(make_pdf([{}, {}, {}, {}]))
            saved = image_source(source)
            saved.status = "failed"
            saved.segments = [
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-{i}",
                    page_number=i,
                    method="ocr_space_engine3",
                    status="failed",
                    text="",
                    error=f"Old failure {i}",
                )
                for i in range(1, 5)
            ]
            saved.errors = [f"Page {i}: Old failure {i}" for i in range(1, 5)]
            pages_file = root / "pages.json"
            pages_file.write_text(saved.model_dump_json())
            before_bytes = pages_file.read_bytes()

            # Invalid caps rejected before any client call
            for bad_cap in (0, 5, True):
                with self.assertRaises(ExtractionError):
                    recover_pages(source, pages_file, root / f"bad_{bad_cap}", page_numbers=[1], max_requests=bad_cap)

            def make_opener():
                opener = MagicMock()
                payload = json.dumps(
                    {
                        "OCRExitCode": 1,
                        "IsErroredOnProcessing": False,
                        "ParsedResults": [{"FileParseExitCode": 1, "ParsedText": "Soup 8.50"}],
                    }
                ).encode()
                opener.open.return_value.__enter__.return_value.read.return_value = payload
                return opener

            # Cap = 1
            opener1 = make_opener()
            with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener1):
                rep1 = recover_pages(
                    source, pages_file, root / "rec1", page_numbers=[1], max_requests=1, ocr_api_key="k"
                )
            self.assertEqual(opener1.open.call_count, 1)
            self.assertEqual(rep1.status, "incomplete")
            m1 = json.loads((root / "rec1/manifest.json").read_text())
            self.assertEqual(m1["requests_attempted"], 1)

            # Cap = 4
            opener4 = make_opener()
            with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener4):
                rep4 = recover_pages(
                    source, pages_file, root / "rec4", page_numbers=[1, 2, 3, 4], max_requests=4, ocr_api_key="k"
                )
            self.assertEqual(opener4.open.call_count, 4)
            self.assertEqual(rep4.status, "complete")
            m4 = json.loads((root / "rec4/manifest.json").read_text())
            self.assertEqual(m4["requests_attempted"], 4)

            # First 429 stops immediately leaving remaining pages not_attempted
            opener429 = MagicMock()
            opener429.open.side_effect = HTTPError("https://example.test", 429, "rate limit", {}, None)
            with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener429):
                rep429 = recover_pages(
                    source, pages_file, root / "rec429", page_numbers=[1, 2, 3], max_requests=3, ocr_api_key="k"
                )
            self.assertEqual(opener429.open.call_count, 1)
            self.assertEqual(rep429.status, "failed")
            m429 = json.loads((root / "rec429/manifest.json").read_text())
            self.assertEqual(m429["requests_attempted"], 1)
            self.assertEqual([p["status"] for p in m429["pages"]], ["failed", "not_attempted", "not_attempted"])
            self.assertEqual(pages_file.read_bytes(), before_bytes)

    # O9
    def test_model_recovery_budget_uses_planned_batches_not_page_count_only(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            source.write_bytes(make_pdf([{"text": "Soup 8.50"} for _ in range(4)]))
            saved = image_source(source)
            saved.status = "incomplete"
            saved.segments = [
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-{i}",
                    page_number=i,
                    method="pdf_native",
                    status="ready",
                    text="Soup 8.50",
                )
                for i in range(1, 5)
            ]
            pages_file = root / "pages.json"
            pages_file.write_text(saved.model_dump_json())

            # 4 pages with batch_pages=1 requires 4 planned batches -> max_model_requests=3 rejects before LLM call
            llm_overflow = RecordingLLM()
            with self.assertRaises(ExtractionError):
                run_pipeline(
                    source,
                    root / "run_overflow",
                    llm=llm_overflow,
                    pages_json=pages_file,
                    input_mode="ocr",
                    target_pages=[1, 2, 3, 4],
                    max_model_requests=3,
                    batch_pages=1,
                    llm_cache_dir=None,
                )
            self.assertEqual(len(llm_overflow.messages), 0)

            # 4 pages with batch_pages=1 and max_model_requests=4 succeeds in 4 calls
            llm_four = RecordingLLM()
            with patch("peekaplate_processing.workflow.asyncio.sleep"):
                rep_four = run_pipeline(
                    source,
                    root / "run_four",
                    llm=llm_four,
                    pages_json=pages_file,
                    input_mode="ocr",
                    target_pages=[1, 2, 3, 4],
                    max_model_requests=4,
                    batch_pages=1,
                    llm_cache_dir=None,
                )
            self.assertEqual(len(llm_four.messages), 4)
            self.assertEqual(rep_four.configuration["targeted_model_recovery"]["planned_batches"], 4)

            # 4 pages with batch_pages=4 and max_model_requests=1 succeeds in 1 call
            llm_one = RecordingLLM()
            rep_one = run_pipeline(
                source,
                root / "run_one",
                llm=llm_one,
                pages_json=pages_file,
                input_mode="ocr",
                target_pages=[1, 2, 3, 4],
                max_model_requests=1,
                batch_pages=4,
                llm_cache_dir=None,
            )
            self.assertEqual(len(llm_one.messages), 1)
            self.assertEqual(rep_one.configuration["targeted_model_recovery"]["planned_batches"], 1)

    # O10
    def test_strict_quality_scoring_rejects_aliases_partial_prices_and_duplicate_credit(self) -> None:
        # Test-local strict occurrence/group protocol scorer per QUAL-01.
        def norm_strict(text: str) -> str:
            return " ".join(text.casefold().split())

        def score_predictions(references: list[dict], predictions: list[dict], failed_pages: set[int]):
            matched_refs = set()
            outcomes = {
                "correct_complete_groups": 0,
                "partial_groups": 0,
                "wrong_assertions": 0,
                "unknown_prices": 0,
                "missing_entries": 0,
                "duplicate_predictions": 0,
                "failed_page_references": 0,
                "denominator": len(references),
            }
            for pred in predictions:
                ref_idx = next(
                    (
                        idx
                        for idx, ref in enumerate(references)
                        if (ref["page"], norm_strict(ref["section"]), norm_strict(ref["name"]))
                        == (pred["page"], norm_strict(pred["section"]), norm_strict(pred["name"]))
                    ),
                    None,
                )
                if ref_idx is None:
                    outcomes["wrong_assertions"] += 1
                    continue
                if ref_idx in matched_refs:
                    outcomes["duplicate_predictions"] += 1
                    continue
                matched_refs.add(ref_idx)
                ref = references[ref_idx]
                if pred["price_text"] is None and pred["price_amount"] is None:
                    outcomes["unknown_prices"] += 1
                elif pred["price_text"] == ref["price_text"] and pred["price_amount"] == ref["price_amount"]:
                    outcomes["correct_complete_groups"] += 1
                elif (
                    ref["price_text"]
                    and "/" in ref["price_text"]
                    and pred["price_text"] in [p.strip() for p in ref["price_text"].split("/")]
                ):
                    outcomes["partial_groups"] += 1
                else:
                    outcomes["wrong_assertions"] += 1

            for idx, ref in enumerate(references):
                if idx not in matched_refs:
                    if ref["page"] in failed_pages:
                        outcomes["failed_page_references"] += 1
                    outcomes["missing_entries"] += 1
            return outcomes

        refs = [
            {"page": 1, "section": "Soups", "name": "Soup", "price_text": "8.50 / 12.50", "price_amount": None},
            {"page": 1, "section": "Soups", "name": "Bread", "price_text": "0.00", "price_amount": "0.00"},
            {"page": 1, "section": "Soups", "name": "Salad", "price_text": "9.00", "price_amount": "9.00"},
            {"page": 2, "section": "Mains", "name": "Steak", "price_text": "24.00", "price_amount": "24.00"},
        ]
        preds = [
            # Partial price group (8.50 vs 8.50 / 12.50) -> partial_groups, not correct
            {"page": 1, "section": "Soups", "name": "Soup", "price_text": "8.50", "price_amount": "8.50"},
            # Known zero price -> correct
            {"page": 1, "section": "Soups", "name": "Bread", "price_text": "0.00", "price_amount": "0.00"},
            # Duplicate prediction of Bread -> duplicate_predictions, does not inflate recall
            {"page": 1, "section": "Soups", "name": "Bread", "price_text": "0.00", "price_amount": "0.00"},
            # Trademark/punctuation edit ("Salad™" vs "Salad") -> rejected by strict matcher
            {"page": 1, "section": "Soups", "name": "Salad™", "price_text": "9.00", "price_amount": "9.00"},
        ]
        scored = score_predictions(refs, preds, failed_pages={2})
        self.assertEqual(scored["denominator"], 4)
        self.assertEqual(scored["correct_complete_groups"], 1)
        self.assertEqual(scored["partial_groups"], 1)
        self.assertEqual(scored["duplicate_predictions"], 1)
        self.assertEqual(scored["wrong_assertions"], 1)
        self.assertEqual(scored["missing_entries"], 2)
        self.assertEqual(scored["failed_page_references"], 1)

    # O11
    def test_reference_manifest_rejects_tampering_and_heldout_leakage(self) -> None:
        # Test-local manifest validator per QUAL-01.
        def validate_manifest(entries: list[dict], blobs: dict[str, bytes]) -> None:
            dev_sources = set()
            heldout_sources = set()
            for item in entries:
                raw = blobs.get(item["id"])
                if raw is None or hashlib.sha256(raw).hexdigest() != item["reference_sha256"]:
                    raise ValueError("Reference hash mismatch or tampered bytes.")
                if item["split"] == "held_out":
                    if item.get("previously_inspected") or item.get("supplemental_trial"):
                        raise ValueError("Inspected or supplemental sources cannot be promoted to held_out.")
                    heldout_sources.add(item["source_sha256"])
                else:
                    dev_sources.add(item["source_sha256"])
            if dev_sources & heldout_sources:
                raise ValueError("Source hash leakage between development and held_out splits.")

        ref_bytes = b'{"dishes":[{"name":"Soup","price_text":"8.50"}]}'
        ref_hash = hashlib.sha256(ref_bytes).hexdigest()
        valid_entries = [
            {"id": "dev-1", "split": "development", "source_sha256": "a" * 64, "reference_sha256": ref_hash},
            {"id": "hold-1", "split": "held_out", "source_sha256": "b" * 64, "reference_sha256": ref_hash},
        ]
        validate_manifest(valid_entries, {"dev-1": ref_bytes, "hold-1": ref_bytes})

        # 1-byte reference tampering rejects
        with self.assertRaises(ValueError):
            validate_manifest(valid_entries, {"dev-1": ref_bytes, "hold-1": ref_bytes + b" "})

        # Shared source_sha256 between development and held_out rejects
        leaked = copy.deepcopy(valid_entries)
        leaked[1]["source_sha256"] = "a" * 64
        with self.assertRaises(ValueError):
            validate_manifest(leaked, {"dev-1": ref_bytes, "hold-1": ref_bytes})

        # Promoting a previously inspected source to held_out rejects
        promoted = copy.deepcopy(valid_entries)
        promoted[1]["previously_inspected"] = True
        with self.assertRaises(ValueError):
            validate_manifest(promoted, {"dev-1": ref_bytes, "hold-1": ref_bytes})

    # O12
    def test_producer_reload_preserves_candidate_identity_boxes_and_legacy_omission(self) -> None:
        v1_raw = (FIXTURES / "review-candidates/representative-candidates.json").read_text()
        v2_raw = (FIXTURES / "review-candidates/representative-candidates-v2.json").read_text()
        box_raw = (FIXTURES / "review-candidates/box-evidence-candidates.json").read_text()

        v1 = ReviewCandidateResult.model_validate_json(v1_raw)
        v2 = ReviewCandidateResult.model_validate_json(v2_raw)
        box = ReviewCandidateResult.model_validate_json(box_raw)

        # Pair-key identity and legacy field omission
        v1_dump = json.loads(v1.model_dump_json())
        self.assertEqual(v1_dump, json.loads(v1_raw))
        self.assertNotIn("subcategory", v1_dump["candidates"][0]["original"])
        self.assertNotIn("price_text", v1_dump["candidates"][0]["original"])

        v2_dump = json.loads(v2.model_dump_json())
        self.assertEqual(v2_dump, json.loads(v2_raw))
        self.assertEqual(
            {(v2.extraction_id, c.candidate_id) for c in v2.candidates},
            {(v2_dump["extraction_id"], c["candidate_id"]) for c in v2_dump["candidates"]},
        )

        # Fractional box coordinate 10.25 and span reconstruction preserved
        cid = box.candidates[0].candidate_id
        box_rec = box.segments[0].metadata["candidate_box_evidence"][cid][0]
        self.assertEqual(box_rec["box"]["left"], 10.25)
        span = box.candidates[0].evidence[0]
        self.assertEqual(box.segments[0].text[span.start : span.end], box.candidates[0].original.source_text)

        # Orphan or tampered box record rejects on reload
        tampered = json.loads(box_raw)
        tampered["segments"][0]["metadata"]["candidate_box_evidence"][cid][0]["box"]["left"] = 99.0
        with self.assertRaises(ValueError):
            ReviewCandidateResult.model_validate(tampered)

    # O13
    def test_budget_baseline_pins_component_limits_without_claiming_end_to_end_fit(self) -> None:
        # Verify Python constants
        self.assertEqual(JOB_TIMEOUT_SECONDS, 700)
        self.assertEqual(MAX_SOURCE_BYTES, 12_000_000)
        self.assertEqual(MAX_REPORT_BYTES, 24_000_000)
        self.assertEqual(MAX_BUNDLE_BYTES, 32_000_000)
        self.assertEqual(MAX_REQUEST_BYTES, 8192)

        # Read host source literals without executing TS
        host_ts = (Path(__file__).resolve().parents[2] / "backend/src/extraction-host.ts").read_text()
        for pattern, expected in [
            (r"setInactivityTimeout\((\d[\d_]*)\)", "60_000"),
            (r"Date\.now\(\)\s*\+\s*(\d[\d_]*)", "30_000"),
            (r"AbortSignal\.timeout\((\d[\d_]*)\)", "1_000"),
            (r"setTimeout\(resolve,\s*(\d[\d_]*)\)", "500"),
            (r"maxBundleBytes\s*=\s*(\d[\d_]*)", "32_000_000"),
            (r"Buffer\.byteLength\(publicReport,\s*'utf8'\)\s*>\s*(\d[\d_]*)", "24_000_000"),
        ]:
            matches = re.findall(pattern, host_ts)
            self.assertGreaterEqual(len(matches), 1, f"Expected literal for {pattern}")
            self.assertTrue(all(m == expected for m in matches), f"Mismatch for {pattern}: {matches}")

        readiness_sec = 30
        nominal_sum = readiness_sec + JOB_TIMEOUT_SECONDS
        self.assertEqual(nominal_sum, 730)
        self.assertGreater(nominal_sum, 720)


if __name__ == "__main__":
    unittest.main()
