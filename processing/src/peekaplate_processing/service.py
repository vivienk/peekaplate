"""Staging-only HTTP bridge to the existing local extraction pipeline.

The authenticated Worker owns job authorization/leases; this process never writes
application records. URL/text inputs must be materialized by the Worker first.
"""
import hashlib
import hmac
import httpx
import json
import os
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.schemas import MenuExtractionResult
from peekaplate_processing.sources import MAX_SOURCE_BYTES, detect_kind

MAX_REQUEST_BYTES = 8192
MAX_REPORT_BYTES = 24_000_000  # Includes the bounded source's base64 snapshot.
JOB_TIMEOUT_SECONDS = 700


@dataclass(frozen=True)
class Settings:
    secret: str
    source_origin: str

    @classmethod
    def from_env(cls):
        return cls(*(os.environ.get(name, "") for name in (
            "EXTRACTION_SERVICE_SECRET", "EXTRACTION_SOURCE_ORIGIN",
        )))

    def validate(self):
        if (len(self.secret) < 48 or not self.secret.isascii()
                or self.source_origin != "https://peekaplate-extraction-staging.vxkong.workers.dev"):
            raise ValueError("Valid staging service configuration is required.")


class ExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: UUID
    tenant_id: UUID
    source_type: Literal["pdf", "photo"]
    source_url: None = None
    source_storage_key: str = Field(min_length=1, max_length=1024)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=200)

    def expected_key(self):
        return f"menu-ingestion/sources/{self.tenant_id}/{self.job_id}/source"


def read_source(job, settings, capability):
    url = f"{settings.source_origin}/sources/{job.tenant_id}/{job.job_id}"
    with httpx.stream("GET", url, headers={"Authorization": "Bearer " + settings.secret,
                      "X-Source-Capability": capability, "X-Source-Hash": job.source_hash},
                      timeout=20, follow_redirects=False) as response:
        if response.status_code != 200:
            raise ValueError("Source unavailable.")
        length = int(response.headers.get("content-length", "0"))
        if not 0 < length <= MAX_SOURCE_BYTES:
            return None
        data = bytearray()
        for chunk in response.iter_bytes():
            data.extend(chunk)
            if len(data) > MAX_SOURCE_BYTES:
                return None
        return bytes(data) if len(data) == length else None


def run_extraction(data, kind, timeout):
    # A child process gives the complete pipeline a killable wall-clock deadline.
    with tempfile.TemporaryDirectory(prefix="peekaplate-extract-") as directory:
        root = Path(directory)
        source = root / ("source.pdf" if kind == "pdf" else "source.img")
        source.write_bytes(data)
        source.chmod(0o600)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("R2_", "EXTRACTION_"))}
        completed = subprocess.run(
            [sys.executable, "-m", "peekaplate_processing.run_pipeline",
             "--input", str(source), "--run-dir", str(root / "result"),
             "--batch-pages", "1", "--llm-concurrency", "2", "--no-llm-cache"],
            cwd=root, env=env, timeout=timeout, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        # The CLI writes usable incomplete/failed reports before its expected exit 2.
        if completed.returncode not in (0, 2):
            raise subprocess.CalledProcessError(completed.returncode, "extraction")
        with (root / "result" / "extraction.json").open("rb") as output:
            report = output.read(MAX_REPORT_BYTES + 1)
        if len(report) > MAX_REPORT_BYTES:
            raise ValueError("Extraction report exceeds limit.")
        return json.loads(report)


def create_app(settings=None, *, source_reader=None, runner=run_extraction):
    settings = settings or Settings.from_env()
    settings.validate()
    source_reader = source_reader or (lambda job, capability: read_source(job, settings, capability))
    slot = threading.Lock()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def reply(body, status=200, **headers):
        return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store", **headers})

    @app.get("/health")
    def health():
        return reply({"status": "ok", "service": "menu-extraction", "environment": "staging"})

    @app.post("/extract")
    async def extract(request: Request):
        credential = request.headers.get("authorization", "").encode("utf-8")
        expected = ("Bearer " + settings.secret).encode("ascii")
        if not hmac.compare_digest(credential, expected):
            return reply({"error": "unauthorized"}, 401)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_REQUEST_BYTES:
                return reply({"error": "request_too_large"}, 413)
        try:
            job = ExtractRequest.model_validate_json(body)
        except (ValidationError, ValueError):
            return reply({"error": "invalid_request"}, 422)
        if (request.headers.get("x-job-id") != str(job.job_id)
                or request.headers.get("x-tenant-id") != str(job.tenant_id)
                or request.headers.get("x-source-hash") != job.source_hash
                or job.source_storage_key != job.expected_key()):
            return reply({"error": "job_scope_mismatch"}, 403)
        capability = request.headers.get("x-source-capability", "")
        if not capability or len(capability) > 4096:
            return reply({"error": "missing_source_capability"}, 403)
        if not slot.acquire(blocking=False):
            return reply({"error": "busy"}, 429, **{"Retry-After": "10"})
        try:
            # Run blocking SDK/process work off the event loop so health stays responsive.
            from starlette.concurrency import run_in_threadpool
            return await run_in_threadpool(process, job, capability)
        finally:
            slot.release()

    def process(job, capability):
        try:
            data = source_reader(job, capability)
            if data is None or not 0 < len(data) <= MAX_SOURCE_BYTES:
                return reply({"error": "invalid_source_size"}, 413)
            if hashlib.sha256(data).hexdigest() != job.source_hash:
                return reply({"error": "source_hash_conflict"}, 409)
            try:
                kind = detect_kind(data)
            except ExtractionError:
                return reply({"error": "unsupported_source"}, 422)
            if kind != ("pdf" if job.source_type == "pdf" else "image"):
                return reply({"error": "source_kind_mismatch"}, 422)
            report = MenuExtractionResult.model_validate(runner(data, kind, JOB_TIMEOUT_SECONDS))
            if not report.source or report.source.sha256 != job.source_hash:
                return reply({"error": "invalid_extraction_report"}, 502)
            encoded = report.model_dump(mode="json")
            if len(json.dumps(encoded).encode("utf-8")) > MAX_REPORT_BYTES:
                return reply({"error": "report_too_large"}, 502)
            return reply(encoded)
        except subprocess.TimeoutExpired:
            return reply({"error": "extraction_timeout"}, 504)
        except Exception:
            # Provider exceptions can include credentials, source text or local paths.
            return reply({"error": "extraction_unavailable"}, 502)

    return app
