"""HTTP bridge to the existing local extraction pipeline.

The authenticated Worker owns job authorization/leases; this process never writes
application records. URL/text inputs must be materialized by the Worker first.
"""
import hashlib
import base64
import hmac
import httpx
import json
import os
import secrets
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
MAX_BUNDLE_BYTES = 32_000_000



def read_result(path, limit):
    with path.open("rb") as handle:
        content=handle.read(limit+1)
    if len(content)>limit:
        raise ValueError("Extraction artifact exceeds limit.")
    return json.loads(content)


@dataclass(frozen=True)
class Settings:
    secret: str
    source_origin: str
    environment: str = "staging"

    @classmethod
    def from_env(cls):
        return cls(
            os.environ.get("EXTRACTION_SERVICE_SECRET", ""),
            os.environ.get("EXTRACTION_SOURCE_ORIGIN", ""),
            os.environ.get("EXTRACTION_ENVIRONMENT", "staging"),
        )

    def validate(self):
        origins = {
            "staging": "https://peekaplate-extraction-staging.vxkong.workers.dev",
            "production": "https://extraction.peekaplate.app",
        }
        origin = origins.get(self.environment)
        if (
            not origin
            or self.source_origin != origin
            or len(self.secret) < 48
            or not self.secret.isascii()
        ):
            raise ValueError("Valid extraction service configuration is required.")


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


class _BudgetProxyServer:
    """Loopback proxy forwarding child-process budget reservations with host credentials."""

    def __init__(self, settings, job, capability):
        self.token = secrets.token_hex(32)
        self._url_path = "/_internal/budget/reserve"
        target_url = f"{settings.source_origin}/budget/reserve"
        upstream_headers = {
            "Authorization": "Bearer " + settings.secret,
            "X-Source-Capability": capability,
            "X-Tenant-ID": str(job.tenant_id),
            "X-Job-ID": str(job.job_id),
            "X-Source-Hash": job.source_hash,
            "Content-Type": "application/json",
        }
        expected_auth = ("Bearer " + self.token).encode("ascii")

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self_req):
                if self_req.path != "/_internal/budget/reserve":
                    self_req.send_response(404)
                    self_req.end_headers()
                    return
                auth = self_req.headers.get("Authorization", "").encode("utf-8")
                if not hmac.compare_digest(auth, expected_auth):
                    payload = b'{"error":"unauthorized"}'
                    self_req.send_response(401)
                    self_req.send_header("Content-Type", "application/json")
                    self_req.send_header("Content-Length", str(len(payload)))
                    self_req.end_headers()
                    self_req.wfile.write(payload)
                    return
                try:
                    length = int(self_req.headers.get("Content-Length", "0"))
                except ValueError:
                    length = 0
                if not 0 < length <= 4096:
                    payload = b'{"error":"invalid_request"}'
                    self_req.send_response(400)
                    self_req.send_header("Content-Type", "application/json")
                    self_req.send_header("Content-Length", str(len(payload)))
                    self_req.end_headers()
                    self_req.wfile.write(payload)
                    return
                body = self_req.rfile.read(length)
                try:
                    upstream = httpx.post(
                        target_url,
                        content=body,
                        headers=upstream_headers,
                        timeout=5.0,
                        follow_redirects=False,
                    )
                    status = upstream.status_code
                    content = upstream.content
                except (httpx.HTTPError, OSError):
                    status = 503
                    content = b'{"granted":false,"error":"budget_service_unavailable"}'
                self_req.send_response(status)
                self_req.send_header("Content-Type", "application/json")
                self_req.send_header("Content-Length", str(len(content)))
                self_req.end_headers()
                self_req.wfile.write(content)

            def log_message(self_req, format, *args):
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        port = self._server.server_address[1]
        self.url = f"http://127.0.0.1:{port}{self._url_path}"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)


def run_extraction(data, kind, timeout, *, include_artifacts=False, budget_url=None, budget_token=None):
    # A child process gives the complete pipeline a killable wall-clock deadline.
    with tempfile.TemporaryDirectory(prefix="peekaplate-extract-") as directory:
        root = Path(directory)
        source = root / ("source.pdf" if kind == "pdf" else "source.img")
        source.write_bytes(data)
        source.chmod(0o600)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("R2_", "EXTRACTION_", "PEEK_BUDGET_"))}
        command = [
            sys.executable, "-m", "peekaplate_processing.run_pipeline",
            "--input", str(source), "--run-dir", str(root / "result"),
            "--input-mode", "vision_v4", "--batch-pages", "1", "--llm-concurrency", "2", "--no-llm-cache",
        ]
        if budget_url and budget_token:
            env["PEEK_BUDGET_URL"] = budget_url
            env["PEEK_BUDGET_TOKEN"] = budget_token
            command.append("--require-budget-gate")
        completed = subprocess.run(
            command,
            cwd=root, env=env, timeout=timeout, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if completed.returncode not in (0, 1, 2):
            raise subprocess.CalledProcessError(completed.returncode, "extraction")
        report=read_result(root/"result/extraction.json",MAX_REPORT_BYTES)
        if completed.returncode==1 and report.get("status")!="failed":
            raise subprocess.CalledProcessError(completed.returncode,"extraction")
        if not include_artifacts:
            return report
        mode = report.get("configuration", {}).get("input_mode")
        if mode == "vision_v4":
            source_id = report.get("source", {}).get("source_id", "")
            status = report.get("status", "failed")
            suggestions = {
                "schema_version": 1,
                "source_id": source_id,
                "input_mode": "ocr_image",
                "status": status,
                "suggestions": [],
            }
        else:
            suggestions = read_result(root / "result/review-suggestions.json", 8_000_000)
        return {"schema_version": 1, "report": report,
                "review_suggestions":suggestions,
                "timings":read_result(root/"result/timings.json",1_000_000)}


def create_app(settings=None, *, source_reader=None, runner=run_extraction):
    settings = settings or Settings.from_env()
    settings.validate()
    source_reader = source_reader or (lambda job, capability: read_source(job, settings, capability))
    slot = threading.Lock()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def reply(body, status=200, **headers):
        return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store", **headers})

    # The Worker retains the returned review layers. The extraction host uses
    # this directory only for per-request scratch files.
    portion_root = os.environ.get("PORTION_REVIEW_ROOT", "")
    if portion_root and Path(portion_root).is_absolute():
        from peekaplate_processing.portion_service import register_portion_routes
        register_portion_routes(
            app,
            authorized=lambda request: hmac.compare_digest(
                request.headers.get("authorization", "").encode("utf-8"),
                ("Bearer " + settings.secret).encode("ascii"),
            ),
            reply=reply,
            root=Path(portion_root),
            retain_artifacts=False,
        )

    @app.get("/health")
    def health():
        return reply({"status": "ok", "service": "menu-extraction", "environment": settings.environment})

    @app.post("/extract")
    async def extract(request: Request):
        credential = request.headers.get("authorization", "").encode("utf-8")
        expected = ("Bearer " + settings.secret).encode("ascii")
        if not hmac.compare_digest(credential, expected):
            return reply({"error": "unauthorized"}, 401)
        artifact_version=request.headers.get("x-extraction-artifact-bundle")
        if artifact_version not in (None,"1"):
            return reply({"error":"unsupported_artifact_version"},400)
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
            return await run_in_threadpool(process, job, capability, artifact_version)
        finally:
            slot.release()

    def process(job, capability, artifact_version):
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
            if runner is run_extraction:
                with _BudgetProxyServer(settings, job, capability) as proxy:
                    kwargs = {"include_artifacts": True} if artifact_version else {}
                    result = runner(
                        data,
                        kind,
                        JOB_TIMEOUT_SECONDS,
                        budget_url=proxy.url,
                        budget_token=proxy.token,
                        **kwargs,
                    )
            else:
                result = runner(data, kind, JOB_TIMEOUT_SECONDS)
            bundle=result if isinstance(result,dict) and "report" in result else None
            report = MenuExtractionResult.model_validate(bundle["report"] if bundle else result)
            if (not report.source or report.source.sha256 != job.source_hash
                    or report.source.source_id!="sha256:"+job.source_hash
                    or report.source.size_bytes!=len(data)
                    or base64.b64decode(report.source.snapshot_base64,validate=True)!=data):
                return reply({"error": "invalid_extraction_report"}, 502)
            encoded = report.model_dump(mode="json")
            if len(json.dumps(encoded).encode("utf-8")) > MAX_REPORT_BYTES:
                return reply({"error": "report_too_large"}, 502)
            if artifact_version:
                if not bundle or type(bundle.get("schema_version")) is not int or bundle["schema_version"] != 1:
                    raise ValueError("Missing or invalid private artifact bundle.")
                if set(bundle) != {"schema_version", "report", "review_suggestions", "timings"}:
                    raise ValueError("Invalid private artifact keys.")
                private, timings = bundle["review_suggestions"], bundle["timings"]
                if (not isinstance(timings, dict)
                        or type(timings.get("schema_version")) is not int
                        or timings["schema_version"] != 1
                        or timings.get("status") != report.status
                        or not isinstance(timings.get("timings_seconds"), dict)):
                    raise ValueError("Invalid timings.")
                config = encoded.setdefault("configuration", {})
                mode = config.get("input_mode")
                extraction_mode = config.get("extraction_mode")
                if mode == "vision_v4" or extraction_mode == "vision_v4":
                    if timings.get("input_mode") not in {"ocr_image", "vision_v4"}:
                        raise ValueError("Invalid direct vision timings input mode.")
                    timings["input_mode"] = "ocr_image"
                    if (not isinstance(private, dict)
                            or type(private.get("schema_version")) is not int
                            or private["schema_version"] != 1
                            or private.get("source_id") != report.source.source_id
                            or private.get("input_mode") not in {"ocr_image", "vision_v4"}
                            or private.get("status") not in {"complete", "incomplete", "failed"}
                            or private.get("status") != report.status
                            or not isinstance(private.get("suggestions"), list)
                            or len(private["suggestions"]) != 0):
                        raise ValueError("Invalid direct vision review suggestions.")
                    private["input_mode"] = "ocr_image"
                    config["extraction_mode"] = "vision_v4"
                    config["input_mode"] = "ocr_image"
                elif mode == "ocr_image":
                    if config.get("extraction_mode") == "vision_v4":
                        raise ValueError("OCR report cannot claim direct vision extraction_mode.")
                    if timings.get("input_mode") != "ocr_image":
                        raise ValueError("Invalid OCR timings input mode.")
                    if (not isinstance(private, dict)
                            or type(private.get("schema_version")) is not int
                            or private["schema_version"] != 1
                            or private.get("source_id") != report.source.source_id
                            or private.get("input_mode") != "ocr_image"
                            or private.get("status") not in {"complete", "incomplete", "failed"}
                            or not isinstance(private.get("suggestions"), list)
                            or any(not isinstance(item, dict) or item.get("status") != "unvalidated" for item in private["suggestions"])):
                        raise ValueError("Invalid OCR review suggestions.")
                else:
                    raise ValueError("Invalid input mode for private artifact bundle.")
                bundle = {
                    "schema_version": 1,
                    "report": encoded,
                    "review_suggestions": private,
                    "timings": timings,
                }
                if len(json.dumps(bundle).encode("utf-8")) > MAX_BUNDLE_BYTES:
                    return reply({"error": "bundle_too_large"}, 502)
                return reply(bundle, **{"X-Extraction-Artifact-Bundle": "1"})
            return reply(encoded)
        except subprocess.TimeoutExpired:
            return reply({"error": "extraction_timeout"}, 504)
        except Exception:
            # Provider exceptions can include credentials, source text or local paths.
            return reply({"error": "extraction_unavailable"}, 502)

    return app
