"""HTTP boundary checks; no provider calls or paid extraction."""
import hashlib
import base64
import json
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from peekaplate_processing.service import Settings, create_app, run_extraction, read_source, ExtractRequest


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.data = b"%PDF-1.4 synthetic test only"
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.payload = {
            "job_id": "00000000-0000-4000-8000-000000000001",
            "tenant_id": "00000000-0000-4000-8000-000000000002",
            "source_type": "pdf", "source_url": None,
            "source_storage_key": "menu-ingestion/sources/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000001/source",
            "source_hash": self.digest, "idempotency_key": "synthetic-service-test",
        }
        self.headers = {
            "Authorization": "Bearer " + "synthetic-test-token-" * 3,
            "X-Job-ID": self.payload["job_id"], "X-Tenant-ID": self.payload["tenant_id"],
            "X-Source-Hash": self.digest, "X-Source-Capability": "synthetic-job-bound-capability",
        }
        self.settings = Settings(secret="synthetic-test-token-" * 3,
            source_origin="https://peekaplate-extraction-staging.vxkong.workers.dev")
        self.storage = Mock()
        self.storage.return_value = self.data
        self.report = {
            "started_at": "2026-10-27T00:00:00Z", "status": "failed",
            "source": {
                "source_id": "sha256:" + self.digest, "sha256": self.digest,
                "kind": "pdf", "location": "source.pdf", "size_bytes": len(self.data),
                "retrieved_at": "2026-10-27T00:00:00Z",
                "snapshot_base64": base64.b64encode(self.data).decode(),
            },
            "errors": ["Synthetic report; no provider called."],
        }
        self.runner = Mock(return_value=self.report)
        self.client = TestClient(create_app(self.settings, source_reader=self.storage, runner=self.runner))

    def send(self, **changes):
        return self.client.post("/extract", json={**self.payload, **changes}, headers=self.headers)

    def test_valid_request_uses_fixed_bucket_and_preserves_report(self):
        response = self.send()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["source"]["sha256"], self.digest)
        self.assertEqual(response.json()["status"], "failed")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.storage.assert_called_once()
        self.assertEqual(self.storage.call_args.args[0].expected_key(), self.payload["source_storage_key"])

    def test_invalid_token_has_no_storage_or_provider_side_effect(self):
        self.headers["Authorization"] = "Bearer invalid"
        self.assertEqual(self.send().status_code, 401)
        self.storage.assert_not_called()
        self.runner.assert_not_called()

    def test_headers_cannot_disagree_with_body(self):
        self.headers["X-Tenant-ID"] = "00000000-0000-4000-8000-000000000003"
        self.assertEqual(self.send().status_code, 403)
        self.storage.assert_not_called()

    def test_key_must_be_derived_from_tenant_and_job(self):
        self.assertEqual(self.send(source_storage_key="other-tenant/source").status_code, 403)
        self.storage.assert_not_called()

    def test_body_hash_must_match_host_signed_header(self):
        self.assertEqual(self.send(source_hash="b" * 64).status_code, 403)
        self.storage.assert_not_called()

    def test_source_grant_is_required_before_reading_input(self):
        self.headers.pop("X-Source-Capability")
        self.assertEqual(self.send().status_code, 403)
        self.storage.assert_not_called()

    def test_missing_hash_and_extra_authority_are_rejected(self):
        for change in ({"source_hash": None}, {"bucket": "production"}):
            with self.subTest(change=change):
                self.assertEqual(self.send(**change).status_code, 422)
        self.storage.assert_not_called()

    def test_arbitrary_urls_and_unsupported_sources_are_rejected(self):
        for change in ({"source_url": "http://169.254.169.254/"}, {"source_type": "url"}, {"source_type": "text"}):
            with self.subTest(change=change):
                self.assertEqual(self.send(**change).status_code, 422)
        self.storage.assert_not_called()

    def test_oversized_and_malformed_request(self):
        for body, status in ((b"x" * 8193, 413), (b"{", 422)):
            response = self.client.post("/extract", content=body, headers={**self.headers, "Content-Type": "application/json"})
            self.assertEqual(response.status_code, status)

    def test_hash_conflict_never_runs_extraction(self):
        self.headers["X-Source-Hash"] = "b" * 64
        self.assertEqual(self.send(source_hash="b" * 64).status_code, 409)
        self.runner.assert_not_called()

    def test_source_kind_must_match_job(self):
        self.assertEqual(self.send(source_type="photo").status_code, 422)
        self.runner.assert_not_called()

    def test_oversized_source_is_rejected(self):
        self.storage.return_value = b"x" * 12_000_001
        self.assertEqual(self.send().status_code, 413)
        self.runner.assert_not_called()

    def test_provider_and_storage_errors_do_not_echo_details(self):
        for target in (self.storage, self.runner):
            target.side_effect = RuntimeError("synthetic-sensitive-detail")
            response = self.send()
            self.assertEqual(response.status_code, 502)
            self.assertNotIn("synthetic-sensitive-detail", response.text)
            target.side_effect = None

    def test_timeout_is_distinct_and_slot_reusable(self):
        self.runner.side_effect = subprocess.TimeoutExpired("synthetic", 700)
        self.assertEqual(self.send().status_code, 504)
        self.runner.side_effect = None
        self.assertEqual(self.send().status_code, 200)

    def test_second_active_request_gets_retryable_response(self):
        def busy(*_):
            second = self.send()
            self.assertEqual(second.status_code, 429)
            self.assertEqual(second.headers["retry-after"], "10")
            return self.report
        self.runner.side_effect = busy
        self.assertEqual(self.send().status_code, 200)
        self.assertEqual(self.runner.call_count, 1)

    def test_invalid_report_and_wrong_source_are_rejected(self):
        for report in ({"invalid": True}, {**self.report, "source": {**self.report["source"], "sha256": "b" * 64}}):
            self.runner.return_value = report
            self.assertEqual(self.send().status_code, 502)

    def test_short_secret_and_nonstaging_source_fail_closed(self):
        for change in ({"secret": "short"}, {"source_origin": "https://other.example"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                create_app(Settings(**{**self.settings.__dict__, **change}), source_reader=self.storage, runner=self.runner)

    def test_subprocess_has_deadline_and_drops_service_credentials(self):
        def child(command, **kwargs):
            self.assertEqual(kwargs["timeout"], 700)
            self.assertNotIn("EXTRACTION_SERVICE_SECRET", kwargs["env"])
            self.assertNotIn("R2_SECRET_ACCESS_KEY", kwargs["env"])
            from pathlib import Path
            output = Path(command[command.index("--run-dir") + 1])
            output.mkdir()
            (output / "extraction.json").write_text(json.dumps(self.report), encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)
        with patch("peekaplate_processing.service.subprocess.run", side_effect=child):
            self.assertEqual(run_extraction(self.data, "pdf", 700), self.report)

    def test_source_reader_uses_only_fixed_https_origin_without_redirects(self):
        response = Mock(status_code=200, headers={"content-length": str(len(self.data))})
        response.iter_bytes.return_value = [self.data]
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        with patch("peekaplate_processing.service.httpx.stream", return_value=context) as stream:
            self.assertEqual(read_source(ExtractRequest(**self.payload), self.settings, "synthetic-capability"), self.data)
            args, kwargs = stream.call_args
            self.assertEqual(args[1], f"{self.settings.source_origin}/sources/{self.payload['tenant_id']}/{self.payload['job_id']}")
            self.assertFalse(kwargs["follow_redirects"])
            self.assertEqual(kwargs["timeout"], 20)
        context.__exit__.assert_called_once()

    def test_source_reader_rejects_redirect_and_inconsistent_or_excessive_bytes(self):
        for status, length, chunks, raises in (
                (302, "0", [], True), (200, "12000001", [], False),
                (200, "4", [b"abc"], False), (200, "1", [b"x" * 12_000_001], False)):
            response = Mock(status_code=status, headers={"content-length": length})
            response.iter_bytes.return_value = chunks
            context = Mock()
            context.__enter__ = Mock(return_value=response)
            context.__exit__ = Mock(return_value=False)
            with self.subTest(status=status, length=length), patch("peekaplate_processing.service.httpx.stream", return_value=context):
                if raises:
                    with self.assertRaises(ValueError):
                        read_source(ExtractRequest(**self.payload), self.settings, "synthetic-capability")
                else:
                    self.assertIsNone(read_source(ExtractRequest(**self.payload), self.settings, "synthetic-capability"))
            context.__exit__.assert_called_once()

    def test_temporary_source_is_removed_after_child_timeout(self):
        from pathlib import Path
        seen = []
        def timeout(command, **kwargs):
            seen.append(Path(kwargs["cwd"]))
            self.assertTrue(seen[0].is_dir())
            raise subprocess.TimeoutExpired("synthetic", 0.01)
        with patch("peekaplate_processing.service.subprocess.run", side_effect=timeout), self.assertRaises(subprocess.TimeoutExpired):
            run_extraction(self.data, "pdf", 0.01)
        self.assertFalse(seen[0].exists())

    def test_real_child_exit_two_preserves_incomplete_reviewable_report(self):
        partial = {**self.report, "status": "incomplete", "drafts": [{
            "name": "Synthetic Soup", "source_id": self.report["source"]["source_id"],
            "source_text": "Synthetic Soup", "status": "needs_review",
        }]}
        real_run = subprocess.run
        def partial_cli(command, **options):
            destination = command[command.index("--run-dir") + 1]
            script = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(); (p/'extraction.json').write_text(sys.argv[2],encoding='utf-8'); sys.exit(2)"
            return real_run([sys.executable, "-c", script, destination, json.dumps(partial)], **options)
        client = TestClient(create_app(self.settings, source_reader=self.storage, runner=run_extraction))
        with patch("peekaplate_processing.service.subprocess.run", side_effect=partial_cli):
            response = client.post("/extract", json=self.payload, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "incomplete")
        self.assertEqual(response.json()["drafts"][0]["name"], "Synthetic Soup")
        self.assertEqual(response.json()["drafts"][0]["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
