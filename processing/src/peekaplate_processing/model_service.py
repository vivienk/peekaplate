"""Private, single-tenant HTTP adapter for the cutout-to-Tripo review pipeline.

The trusted calling backend owns end-user authorization. Never expose this token
to a browser. No production publication or diner routes are registered here.
"""
import fcntl
import hmac
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from peekaplate_processing.generate_model import (
    MAX_IMAGE_BYTES, MAX_JSON_BYTES, TERMINAL, atomic, digest, prepare, read, run, validate_glb,
)
from peekaplate_processing.tripo import MAX_GLB_BYTES, TripoClient


@dataclass(frozen=True)
class Settings:
    token: str
    tenant_id: str
    root: Path
    api_key: str = ''

    @classmethod
    def from_env(cls):
        root = os.environ.get('TRIPO_REVIEW_ROOT')
        if not root:
            raise ValueError('TRIPO_REVIEW_ROOT must be configured explicitly.')
        return cls(os.environ.get('TRIPO_SERVICE_TOKEN', ''),
                   os.environ.get('TRIPO_TENANT_ID', ''), Path(root),
                   os.environ.get('TRIPO_API_KEY', ''))

    def validate(self):
        if len(self.token) < 48 or not self.token.isascii() or any(c.isspace() for c in self.token):
            raise ValueError('A private service token of at least 48 characters is required.')
        if str(UUID(self.tenant_id)) != self.tenant_id or not self.root.is_absolute():
            raise ValueError('Configure a canonical tenant UUID and an absolute private review root.')


class CreateJob(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: UUID
    review_asset_id: str = Field(pattern=r'^review_[a-f0-9]{32}$')
    source: Literal['cutout', 'presentation'] = 'cutout'


def create_app(settings=None, *, client_factory=None, runner=run):
    settings = settings or Settings.from_env()
    settings.validate()
    factory = client_factory or (lambda: TripoClient(settings.api_key))
    configured = bool(settings.api_key) or client_factory is not None
    base = settings.root.resolve() / settings.tenant_id
    reviews, jobs = base / 'reviews', base / 'jobs'
    reviews.mkdir(parents=True, exist_ok=True)
    jobs.mkdir(parents=True, exist_ok=True)
    slots = threading.BoundedSemaphore(2)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def reply(body, status=200, **headers):
        return JSONResponse(body, status_code=status, headers={'Cache-Control': 'no-store', **headers})

    def authorized(request):
        return hmac.compare_digest(request.headers.get('authorization', '').encode(),
                                   ('Bearer ' + settings.token).encode())

    def job_path(job_id):
        path = jobs / str(job_id)
        if path.is_symlink() or path.resolve().parent != jobs.resolve():
            raise ValueError('Invalid job location.')
        return path

    def load(path):
        job = json.loads(read(path / 'job.json', MAX_JSON_BYTES))
        if job.get('recipe') != 'tripo-review-v1' or job.get('publication') != {'eligible': False}:
            raise ValueError('Invalid private job.')
        return job

    def summary(path, job):
        attempt = None
        if (path / 'attempt.json').exists():
            attempt = json.loads(read(path / 'attempt.json', 4096)).get('status')
        return {'job_id': path.name, 'status': job['status'], 'attempt_status': attempt,
                'dish': job['dish'], 'source': job['source'],
                'error_code': job.get('error_code') if job.get('error_code') in ('insufficient_credits', 'authentication_failed', 'invalid_parameters', 'rate_limited', 'content_rejected', 'unsupported_model', 'invalid_endpoint') else None,
                'progress': job.get('progress'), 'review_status': 'needs_review',
                'publication_eligible': False,
                'artifacts': {'source': f'/v1/model-jobs/{path.name}/artifacts/source.png',
                              'original': f'/v1/model-jobs/{path.name}/artifacts/fallback.jpg',
                              'model': f'/v1/model-jobs/{path.name}/artifacts/model.glb'
                              if job['status'] == 'ready' else None}}

    def attempt_status(path, status):
        atomic(path / 'attempt.json', json.dumps({'status': status}).encode())

    def work(path, handle):
        try:
            attempt_status(path, 'running')
            runner(path, factory(), timeout=600)
            attempt_status(path, 'finished')
        except Exception:
            # The pipeline preserves resumable/ambiguous state. No raw provider exception is exposed.
            attempt_status(path, 'incomplete')
        finally:
            handle.close()
            slots.release()

    def schedule(path, background):
        if not slots.acquire(blocking=False):
            return reply({'error': 'busy'}, 429, **{'Retry-After': '10'})
        handle = None
        try:
            handle = (path / '.service.lock').open('a')
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            attempt_status(path, 'scheduled')
            background.add_task(work, path, handle)
        except BlockingIOError:
            if handle:
                handle.close()
            slots.release()
            return reply({'error': 'job_already_running'}, 409)
        except Exception:
            if handle:
                handle.close()
            slots.release()
            raise
        return reply(summary(path, load(path)), 202)

    @app.get('/health')
    def health():
        return reply({'status': 'ok', 'service': 'private-model-review', 'generation_configured': configured})

    @app.post('/v1/model-jobs')
    async def create(request: Request, background: BackgroundTasks):
        if not authorized(request):
            return reply({'error': 'unauthorized'}, 401)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 8192:
                return reply({'error': 'request_too_large'}, 413)
        try:
            payload = CreateJob.model_validate_json(body)
        except (ValidationError, ValueError):
            return reply({'error': 'invalid_request'}, 422)
        if not configured:
            return reply({'error': 'generation_not_configured'}, 503)
        return await run_in_threadpool(create_job, payload, background)

    def create_job(payload, background):
        try:
            # Serialize create-only preparation across all local service processes.
            with (jobs / '.create.lock').open('a') as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                path = job_path(payload.job_id)
                if path.exists():
                    job = load(path)
                    if (job['source']['review_asset_id'] != payload.review_asset_id
                            or job['source']['variant'] != payload.source):
                        return reply({'error': 'idempotency_conflict'}, 409)
                    # Repeated create is read-only. Use the explicit resume action after interruptions.
                    return reply(summary(path, job))
                source = reviews / payload.review_asset_id
                if source.is_symlink() or source.resolve().parent != reviews.resolve():
                    return reply({'error': 'source_unavailable'}, 404)
                if not (source / 'review-manifest.json').is_file():
                    return reply({'error': 'source_unavailable'}, 404)
                manifest = json.loads(read(source / 'review-manifest.json', MAX_JSON_BYTES))
                if manifest.get('asset_id') != payload.review_asset_id:
                    return reply({'error': 'source_identity_mismatch'}, 409)
                prepare(source, path, payload.source)
            return schedule(path, background)
        except BlockingIOError:
            return reply({'error': 'busy'}, 429, **{'Retry-After': '1'})
        except Exception:
            return reply({'error': 'invalid_source_or_job'}, 422)

    @app.get('/v1/model-jobs/{job_id}')
    def status(job_id: UUID, request: Request):
        if not authorized(request):
            return reply({'error': 'unauthorized'}, 401)
        try:
            path = job_path(job_id)
            return reply(summary(path, load(path)))
        except Exception:
            return reply({'error': 'job_unavailable'}, 404)

    @app.post('/v1/model-jobs/{job_id}/resume')
    def resume(job_id: UUID, request: Request, background: BackgroundTasks):
        if not authorized(request):
            return reply({'error': 'unauthorized'}, 401)
        if not configured:
            return reply({'error': 'generation_not_configured'}, 503)
        try:
            path = job_path(job_id)
            job = load(path)
            if job['status'] == 'ready' or job['status'] in TERMINAL:
                return reply(summary(path, job))
            if job['status'] in ('submitting', 'submission_unknown'):
                return reply({'error': 'submission_requires_reconciliation'}, 409)
            return schedule(path, background)
        except Exception:
            return reply({'error': 'job_unavailable'}, 404)

    @app.get('/v1/model-jobs/{job_id}/artifacts/{filename}')
    def artifact(job_id: UUID, filename: Literal['source.png', 'fallback.jpg', 'model.glb'], request: Request):
        if not authorized(request):
            return reply({'error': 'unauthorized'}, 401)
        try:
            path = job_path(job_id)
            job = load(path)
            if filename == 'model.glb' and job['status'] != 'ready':
                return reply({'error': 'model_not_ready'}, 409)
            data = read(path / filename, MAX_GLB_BYTES if filename == 'model.glb' else MAX_IMAGE_BYTES)
            expected = job['output'] if filename == 'model.glb' else job['source'] if filename == 'source.png' else job['fallback']
            if len(data) != expected['bytes'] or digest(data) != expected['sha256']:
                return reply({'error': 'artifact_integrity_failure'}, 409)
            if filename == 'model.glb':
                validate_glb(data)
            media = {'source.png': 'image/png', 'fallback.jpg': 'image/jpeg', 'model.glb': 'model/gltf-binary'}[filename]
            return Response(data, media_type=media, headers={'Cache-Control': 'no-store',
                            'X-Content-Type-Options': 'nosniff',
                            'Content-Disposition': f'attachment; filename="{filename}"'})
        except Exception:
            return reply({'error': 'artifact_unavailable'}, 404)

    return app
