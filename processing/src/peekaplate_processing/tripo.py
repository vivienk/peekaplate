"""Bounded Tripo v3 transport. Credentials never enter artifacts or browser code."""
import json
import math
import re
import socket
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from peekaplate_processing.errors import ExtractionError

API = 'https://openapi.tripo3d.ai/v3'
MODEL = 'v3.1-20260211'
MAX_GLB_BYTES = 50_000_000


# Only documented request rejections prove that no generation task was accepted.
REJECTIONS = {2: 'authentication_failed', 1002: 'authentication_failed',
              1003: 'invalid_parameters', 1004: 'invalid_parameters',
              1007: 'rate_limited', 2000: 'rate_limited',
              2002: 'invalid_parameters', 2003: 'invalid_parameters',
              2004: 'invalid_parameters', 2008: 'content_rejected',
              2010: 'insufficient_credits', 2015: 'unsupported_model',
              2018: 'invalid_parameters', 4001: 'invalid_endpoint'}


class TripoRejected(ExtractionError):
    def __init__(self, code):
        self.reason = REJECTIONS[code]
        super().__init__('Tripo rejected the request: ' + self.reason)


def rejection(raw):
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return
    code = payload.get('code') if isinstance(payload, dict) else None
    if type(code) is int and code in REJECTIONS:
        # Contradictory responses with a task ID remain uncertain.
        if payload.get('task_id') or (isinstance(payload.get('data'), dict) and payload['data'].get('task_id')):
            return
        raise TripoRejected(code) from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value):
        raise ExtractionError('Invalid Tripo identifier.')
    return value


class TripoClient:
    def __init__(self, api_key, *, opener=None):
        if not isinstance(api_key, str) or not api_key.strip() or '\n' in api_key or '\r' in api_key:
            raise ExtractionError('Set TRIPO_API_KEY in the local process environment.')
        self._key = api_key
        self._opener = opener or build_opener(NoRedirect())

    def _request(self, request, *, limit=1_000_000, timeout=30):
        try:
            with self._opener.open(request, timeout=timeout) as response:
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ExtractionError('Tripo response exceeds the configured byte limit.')
                return data
        except HTTPError as error:
            if request.full_url.startswith(API + '/') and error.code in (400, 401, 403, 404, 429):
                raw = error.read(limit + 1)
                if len(raw) <= limit:
                    rejection(raw)
            raise ExtractionError('Tripo request failed; inspect the saved job state before retrying.') from None
        except (URLError, TimeoutError, socket.timeout, OSError):
            # Never expose response bodies, signed URLs, request headers or provider messages.
            raise ExtractionError('Tripo request failed; inspect the saved job state before retrying.') from None

    def _api(self, path, data=None, content_type='application/json', timeout=30):
        request = Request(API + path, data=data, headers={
            'Authorization': 'Bearer ' + self._key, 'Content-Type': content_type,
            'Accept': 'application/json'}, method='POST' if data is not None else 'GET')
        raw = self._request(request, timeout=timeout)
        rejection(raw)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict) or payload.get('code') != 0 or not isinstance(payload.get('data'), dict):
                raise ValueError()
            return payload['data']
        except (ValueError, TypeError):
            raise ExtractionError('Tripo returned an invalid or unsuccessful API response.') from None

    def balance(self):
        value = self._api('/account/balance').get('balance')
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ExtractionError('Invalid Tripo balance response.')
        return value

    def upload(self, png):
        boundary = 'peekaplate-' + uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                'filename="cutout.png"\r\nContent-Type: image/png\r\n\r\n').encode()
        body += png + f'\r\n--{boundary}--\r\n'.encode()
        return identifier(self._api('/files', body, 'multipart/form-data; boundary=' + boundary).get('file_token'))

    def submit(self, file_token, options):
        data = {'input': identifier(file_token), **options}
        return identifier(self._api('/generation/image-to-model', json.dumps(data).encode()).get('task_id'))

    def task(self, task_id, *, timeout=30):
        return self._api('/tasks/' + identifier(task_id), timeout=timeout)

    def download(self, url):
        # Provider output only; no bearer token on CDN requests, no redirects or arbitrary hosts.
        parsed = urlsplit(url) if isinstance(url, str) else None
        if (not parsed or parsed.scheme != 'https' or parsed.hostname != 'cdn.tripo3d.ai'
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise ExtractionError('Unexpected Tripo output host; download requires provider review.')
        return self._request(Request(url, headers={'Accept': 'model/gltf-binary'}),
                             limit=MAX_GLB_BYTES, timeout=60)
