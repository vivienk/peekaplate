import fcntl
import io
import json
import struct
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from pathlib import Path
from urllib.error import URLError, HTTPError

from PIL import Image, ImageDraw

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.generate_model import OPTIONS, digest, prepare, run, validate_glb, main
from peekaplate_processing.tripo import TripoClient, TripoRejected


def triangle_glb(external=False):
    binary = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0)
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
           'nodes': [{'mesh': 0}], 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
           'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3',
                          'min': [0, 0, 0], 'max': [1, 1, 0]}],
           'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': len(binary)}],
           'buffers': [{'byteLength': len(binary)}]}
    if external:
        doc['images'] = [{'uri': 'https://unexpected.test/texture.png'}]
    raw = json.dumps(doc).encode()
    raw += b' ' * (-len(raw) % 4)
    chunks = struct.pack('<II', len(raw), 0x4E4F534A) + raw
    chunks += struct.pack('<II', len(binary), 0x004E4942) + binary
    return b'glTF' + struct.pack('<II', 2, 12 + len(chunks)) + chunks


class FakeClient:
    def __init__(self, states=('success',), model=None):
        self.states = list(states)
        self.model = triangle_glb() if model is None else model
        self.uploads = self.submissions = self.polls = 0

    def balance(self):
        return 100

    def upload(self, image):
        self.uploads += 1
        self.uploaded = image
        return 'file_test'

    def submit(self, token, options):
        self.submissions += 1
        self.options = options
        return 'task_test'

    def task(self, task_id, **kwargs):
        self.polls += 1
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        return {'task_id': task_id, 'type': 'image_to_model', 'status': state, 'progress': 80,
                'output': {'model_url': 'https://cdn.tripo3d.ai/model.glb'}}

    def download(self, url):
        return self.model


class ModelPipelineTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.review = self.root / 'review'
        self.review.mkdir()
        self.jobdir = self.root / 'job'
        image = Image.new('RGBA', (256, 256))
        ImageDraw.Draw(image).ellipse((16, 16, 240, 240), fill=(120, 80, 40, 255))
        for name in ['cutout.png', 'presentation.png']:
            image.save(self.review / name)
        image.convert('RGB').save(self.review / 'fallback.jpg')
        self.record = {'asset_id': 'review_synthetic', 'provenance': {'recipe': 'review-preview-v1'},
                       'dish': {'dish_id': '11111111-1111-4111-8111-111111111111',
                                'revision_id': '22222222-2222-4222-8222-222222222222'},
                       'review': {'status': 'needs_review'}, 'publication': {'eligible': False},
                       'files': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p.read_bytes())}
                                 for p in self.review.iterdir()}}
        (self.review / 'review-manifest.json').write_text(json.dumps(self.record))

    def prepare(self):
        return prepare(self.review, self.jobdir)

    def saved(self):
        return json.loads((self.jobdir / 'job.json').read_text())

    def test_exact_source_identity_and_private_outputs(self):
        job = self.prepare()
        self.assertEqual(job['dish'], self.record['dish'])
        client = FakeClient(['queued', 'running', 'success'])
        result = run(self.jobdir, client, sleep=lambda _: None)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(client.uploaded, (self.review / 'cutout.png').read_bytes())
        self.assertEqual(client.options, OPTIONS)
        self.assertFalse(client.options['enable_image_autofix'])
        self.assertEqual(result['output']['sha256'], digest(triangle_glb()))
        self.assertEqual(result['review']['status'], 'needs_review')
        self.assertFalse(result['publication']['eligible'])
        self.assertNotIn('model_url', json.dumps(result))
        run(self.jobdir, client)
        self.assertEqual(client.submissions, 1)
        self.assertEqual(client.polls, 3)

    def test_timeout_resumes_same_task_without_upload_or_submission(self):
        self.prepare()
        client = FakeClient(['unknown'])
        now = [0]
        result = run(self.jobdir, client, timeout=2, interval=1,
                     clock=lambda: now[0], sleep=lambda n: now.__setitem__(0, now[0] + n))
        self.assertEqual(result['status'], 'waiting')
        client.states = ['success']
        self.assertEqual(run(self.jobdir, client)['status'], 'ready')
        self.assertEqual((client.uploads, client.submissions), (1, 1))

    def test_cli_reports_zero_credit_rejection_as_failure(self):
        self.prepare()
        client = FakeClient()
        client.balance = lambda: 0
        output = io.StringIO()
        with patch('peekaplate_processing.generate_model.TripoClient', return_value=client), redirect_stdout(output):
            result = main(['run', '--job-dir', str(self.jobdir)])
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())['error_code'], 'insufficient_credits')
        self.assertEqual((client.uploads, client.submissions), (0, 0))

    def test_zero_balance_blocks_upload_and_can_resume_same_job(self):
        self.prepare()
        client = FakeClient()
        client.balance = lambda: 0
        result = run(self.jobdir, client)
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(result['error_code'], 'insufficient_credits')
        self.assertEqual((client.uploads, client.submissions), (0, 0))
        client.balance = lambda: 100
        self.assertEqual(run(self.jobdir, client)['status'], 'ready')
        self.assertNotIn('error_code', self.saved())
        self.assertEqual(client.submissions, 1)

    def test_credit_rejection_at_submit_is_not_ambiguous(self):
        self.prepare()
        client = FakeClient()
        def reject(*_):
            raise TripoRejected(2010)
        client.submit = reject
        result = run(self.jobdir, client)
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(result['error_code'], 'insufficient_credits')
        self.assertIsNone(result['task_id'])

    def test_ambiguous_submission_never_retries(self):
        self.prepare()
        client = FakeClient()
        def uncertain(*_):
            self.assertEqual(self.saved()['status'], 'submitting')
            raise TimeoutError('untrusted provider response')
        client.submit = uncertain
        with self.assertRaisesRegex(ExtractionError, 'unknown'):
            run(self.jobdir, client)
        self.assertEqual(self.saved()['status'], 'submission_unknown')
        with self.assertRaisesRegex(ExtractionError, 'unknown'):
            run(self.jobdir, client)
        self.assertEqual(client.uploads, 1)

    def test_terminal_failure_keeps_input_and_does_not_resubmit(self):
        self.prepare()
        client = FakeClient(['failed'])
        self.assertEqual(run(self.jobdir, client)['status'], 'failed')
        run(self.jobdir, client)
        self.assertEqual(client.submissions, 1)
        self.assertFalse((self.jobdir / 'model.glb').exists())
        self.assertTrue((self.jobdir / 'source.png').exists())
        self.assertTrue((self.jobdir / 'fallback.jpg').exists())

    def test_failed_download_requeries_original_task(self):
        self.prepare()
        client = FakeClient(model=b'invalid')
        with self.assertRaises(ExtractionError):
            run(self.jobdir, client)
        self.assertEqual(self.saved()['task_id'], 'task_test')
        client.model = triangle_glb()
        self.assertEqual(run(self.jobdir, client)['status'], 'ready')
        self.assertEqual(client.submissions, 1)

    def test_changed_source_blocks_provider(self):
        self.prepare()
        (self.jobdir / 'source.png').write_bytes(b'tampered')
        client = FakeClient()
        with self.assertRaisesRegex(ExtractionError, 'hash'):
            run(self.jobdir, client)
        self.assertEqual(client.uploads, 0)

    def test_tampered_review_asset_rejected_before_preparation(self):
        (self.review / 'cutout.png').write_bytes(b'tampered')
        with self.assertRaises(ExtractionError):
            self.prepare()
        self.assertFalse(self.jobdir.exists())

    def test_create_only_and_explicit_presentation(self):
        self.prepare()
        with self.assertRaises(FileExistsError):
            self.prepare()
        other = prepare(self.review, self.root / 'other', 'presentation')
        self.assertEqual(other['source']['variant'], 'presentation')

    def test_lock_prevents_concurrent_generation(self):
        self.prepare()
        with (self.jobdir / '.run.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ExtractionError, 'already running'):
                run(self.jobdir, FakeClient())

    def test_rejects_external_resources_and_truncated_glb(self):
        for data in [triangle_glb(external=True), triangle_glb()[:-1], b'glTF' + b'\0' * 40]:
            with self.subTest(length=len(data)), self.assertRaises(ExtractionError):
                validate_glb(data)

    def test_wrong_provider_task_cannot_bind_to_dish(self):
        self.prepare()
        client = FakeClient()
        client.task = lambda *a, **k: {'task_id': 'another', 'status': 'success'}
        with self.assertRaisesRegex(ExtractionError, 'identity'):
            run(self.jobdir, client)
        self.assertFalse((self.jobdir / 'model.glb').exists())

    def test_changed_completed_model_rejected(self):
        self.prepare()
        run(self.jobdir, FakeClient())
        (self.jobdir / 'model.glb').write_bytes(b'bad')
        with self.assertRaises(ExtractionError):
            run(self.jobdir, FakeClient())


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, **kwargs):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(response)


class TripoTransportTests(unittest.TestCase):
    def test_documented_v3_wire_format_and_cdn_has_no_credentials(self):
        responses = [json.dumps({'code': 0, 'data': data}).encode() for data in
                     [{'file_token': 'file_one'}, {'task_id': 'task_one'},
                      {'task_id': 'task_one', 'type': 'image_to_model', 'status': 'success'}]]
        opener = FakeOpener(responses + [triangle_glb()])
        client = TripoClient('synthetic-secret', opener=opener)
        token = client.upload(b'PNG bytes')
        task = client.submit(token, OPTIONS)
        client.task(task)
        client.download('https://cdn.tripo3d.ai/model.glb?signature=synthetic')
        self.assertEqual(opener.requests[0].full_url, 'https://openapi.tripo3d.ai/v3/files')
        self.assertIn(b'name="file"', opener.requests[0].data)
        self.assertIn(b'PNG bytes', opener.requests[0].data)
        self.assertEqual(json.loads(opener.requests[1].data), {'input': 'file_one', **OPTIONS})
        self.assertTrue(opener.requests[2].full_url.endswith('/tasks/task_one'))
        self.assertIsNone(opener.requests[3].get_header('Authorization'))

    def test_credit_rejection_preserves_safe_code_without_provider_text(self):
        error = HTTPError('https://openapi.tripo3d.ai/v3/generation/image-to-model', 403,
                          'private-message', {}, io.BytesIO(b'{"code":2010,"message":"synthetic-secret"}'))
        client = TripoClient('synthetic-secret', opener=FakeOpener([error]))
        with self.assertRaises(ExtractionError) as caught:
            client.submit('file_one', OPTIONS)
        self.assertEqual(getattr(caught.exception, 'reason', None), 'insufficient_credits')
        self.assertNotIn('synthetic-secret', str(caught.exception))
        self.assertNotIn('private-message', str(caught.exception))

    def test_ambiguous_server_error_stays_unknown_even_with_credit_code(self):
        error = HTTPError('https://openapi.tripo3d.ai/v3/generation/image-to-model', 500,
                          'private', {}, io.BytesIO(b'{"code":2010}'))
        client = TripoClient('synthetic', opener=FakeOpener([error]))
        with self.assertRaises(ExtractionError) as caught:
            client.submit('file_one', OPTIONS)
        self.assertNotIsInstance(caught.exception, TripoRejected)

    def test_balance_wire_format_and_invalid_balances(self):
        for value in [0, 30.5, -1, True, '100', None]:
            client = TripoClient('synthetic', opener=FakeOpener([
                json.dumps({'code': 0, 'data': {'balance': value}}).encode()]))
            if type(value) in (int, float) and value >= 0:
                self.assertEqual(client.balance(), value)
            else:
                with self.assertRaises(ExtractionError):
                    client.balance()

    def test_rejects_arbitrary_download_hosts_before_io(self):
        opener = FakeOpener([])
        client = TripoClient('synthetic', opener=opener)
        for url in ['http://cdn.tripo3d.ai/a', 'https://127.0.0.1/a', 'https://cdn.tripo3d.ai.evil/a',
                    'https://user:password@cdn.tripo3d.ai/a']:
            with self.subTest(url=url), self.assertRaises(ExtractionError):
                client.download(url)
        self.assertFalse(opener.requests)

    def test_missing_key_and_sanitized_error(self):
        with self.assertRaises(ExtractionError):
            TripoClient(None)
        client = TripoClient('synthetic-secret', opener=FakeOpener([URLError('synthetic-secret')]))
        with self.assertRaises(ExtractionError) as caught:
            client.task('task_one')
        self.assertNotIn('synthetic-secret', str(caught.exception))

    def test_invalid_api_response_and_path_injection(self):
        client = TripoClient('synthetic', opener=FakeOpener([b'{"code":1004,"data":{}}']))
        with self.assertRaises(ExtractionError):
            client.task('task_one')
        with self.assertRaises(ExtractionError):
            client.task('../account')


if __name__ == '__main__':
    unittest.main()
