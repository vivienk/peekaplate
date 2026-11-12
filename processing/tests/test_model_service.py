"""Private HTTP API acceptance with synthetic inputs and no Tripo calls."""
import json
import shutil
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

import test_generate_model as fixtures
from peekaplate_processing.generate_model import run
from peekaplate_processing.model_service import Settings, create_app


class ModelServiceTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.ModelPipelineTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root = fixture.root / 'api'
        self.tenant = '11111111-1111-4111-8111-111111111111'
        self.asset = 'review_' + 'a' * 32
        fixture.record['asset_id'] = self.asset
        (fixture.review / 'review-manifest.json').write_text(json.dumps(fixture.record))
        self.source = self.root / self.tenant / 'reviews' / self.asset
        shutil.copytree(fixture.review, self.source)
        self.settings = Settings('synthetic-service-token-' * 3, self.tenant, self.root)
        self.headers = {'Authorization': 'Bearer ' + self.settings.token}
        self.provider = fixtures.FakeClient()
        self.client = TestClient(create_app(self.settings, client_factory=lambda: self.provider))
        self.payload = {'job_id': '22222222-2222-4222-8222-222222222222', 'review_asset_id': self.asset}
        self.path = '/v1/model-jobs/' + self.payload['job_id']
        self.jobdir = self.root / self.tenant / 'jobs' / self.payload['job_id']

    def post(self, **changes):
        return self.client.post('/v1/model-jobs', json={**self.payload, **changes}, headers=self.headers)

    def test_create_status_and_download_actual_pipeline(self):
        response = self.post()
        self.assertEqual(response.status_code, 202)
        result = self.client.get(self.path, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['status'], 'ready')
        self.assertEqual(result.json()['attempt_status'], 'finished')
        self.assertFalse(result.json()['publication_eligible'])
        self.assertEqual(result.headers['cache-control'], 'no-store')
        for name, mime in [('source.png', 'image/png'), ('fallback.jpg', 'image/jpeg'), ('model.glb', 'model/gltf-binary')]:
            download = self.client.get(self.path + '/artifacts/' + name, headers=self.headers)
            self.assertEqual(download.status_code, 200)
            self.assertEqual(download.headers['content-type'], mime)
            self.assertEqual(download.content, (self.jobdir / name).read_bytes())
        self.assertNotIn('task_id', result.json())
        self.assertNotIn(str(self.root), result.text)

    def test_idempotent_create_and_conflicting_input(self):
        self.post()
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.post(source='presentation').status_code, 409)
        self.assertEqual(self.provider.submissions, 1)
        self.assertEqual(self.client.post(self.path + '/resume', headers=self.headers).status_code, 200)
        self.assertEqual(self.provider.submissions, 1)

    def test_authentication_precedes_disk_and_generation(self):
        self.headers = {'Authorization': 'Bearer wrong'}
        self.assertEqual(self.post().status_code, 401)
        for path in [self.path, self.path + '/artifacts/source.png']:
            self.assertEqual(self.client.get(path, headers=self.headers).status_code, 401)
        self.assertEqual(self.client.post(self.path + '/resume', headers=self.headers).status_code, 401)
        self.assertEqual(self.provider.uploads, 0)
        self.assertFalse(self.jobdir.exists())

    def test_no_arbitrary_paths_urls_or_tenant_authority(self):
        for change in [{'review_asset_id': '../other'}, {'source_url': 'http://localhost/'},
                       {'tenant_id': self.tenant}, {'source': 'arbitrary.png'}]:
            self.assertEqual(self.post(**change).status_code, 422)
        self.assertEqual(self.provider.uploads, 0)

    def test_cross_tenant_lookup_and_source_registration_are_isolated(self):
        self.post()
        other = Settings('other-synthetic-token-' * 3, '33333333-3333-4333-8333-333333333333', self.root)
        client = TestClient(create_app(other, client_factory=lambda: self.provider))
        headers = {'Authorization': 'Bearer ' + other.token}
        self.assertEqual(client.get(self.path, headers=headers).status_code, 404)
        self.assertEqual(client.get(self.path + '/artifacts/model.glb', headers=headers).status_code, 404)
        self.assertEqual(client.post('/v1/model-jobs', json=self.payload, headers=headers).status_code, 404)
        self.assertEqual(client.get(self.path, headers=self.headers).status_code, 401)

    def test_missing_provider_key_fails_without_preparing_or_submitting(self):
        client = TestClient(create_app(self.settings))
        result = client.post('/v1/model-jobs', json=self.payload, headers=self.headers)
        self.assertEqual(result.status_code, 503)
        self.assertFalse(self.jobdir.exists())

    def test_bounded_and_malformed_body(self):
        for body, status in [(b'x' * 8193, 413), (b'{', 422)]:
            self.assertEqual(self.client.post('/v1/model-jobs', content=body, headers=self.headers).status_code, status)

    def test_source_hash_and_registry_identity_checked_before_provider(self):
        (self.source / 'cutout.png').write_bytes(b'tampered')
        self.assertEqual(self.post().status_code, 422)
        self.assertEqual(self.provider.uploads, 0)

    def test_artifact_hash_conflict_and_filename_allowlist(self):
        self.post()
        (self.jobdir / 'model.glb').write_bytes(b'tampered')
        self.assertEqual(self.client.get(self.path + '/artifacts/model.glb', headers=self.headers).status_code, 409)
        self.assertEqual(self.client.get(self.path + '/artifacts/job.json', headers=self.headers).status_code, 422)

    def test_ambiguous_submission_stays_blocked_and_errors_sanitized(self):
        def fail(*args):
            raise RuntimeError('synthetic-secret-should-not-leak')
        self.provider.submit = fail
        self.assertEqual(self.post().status_code, 202)
        result = self.client.get(self.path, headers=self.headers)
        self.assertEqual(result.json()['status'], 'submission_unknown')
        self.assertEqual(result.json()['attempt_status'], 'incomplete')
        self.assertNotIn('synthetic-secret', result.text)
        self.assertEqual(self.client.post(self.path + '/resume', headers=self.headers).status_code, 409)

    def test_pending_job_resumes_without_new_generation(self):
        self.provider.states = ['running']
        def bounded(path, provider, **kwargs):
            now = [0]
            return run(path, provider, timeout=1, interval=1, clock=lambda: now[0],
                       sleep=lambda n: now.__setitem__(0, now[0] + n))
        self.client = TestClient(create_app(self.settings, client_factory=lambda: self.provider, runner=bounded))
        self.post()
        self.assertEqual(self.client.get(self.path, headers=self.headers).json()['status'], 'waiting')
        self.assertEqual(self.client.get(self.path + '/artifacts/model.glb', headers=self.headers).status_code, 409)
        self.provider.states = ['success']
        self.assertEqual(self.client.post(self.path + '/resume', headers=self.headers).status_code, 202)
        self.assertEqual(self.provider.submissions, 1)

    def test_health_remains_responsive_and_resume_cannot_duplicate_active_work(self):
        started, finish = threading.Event(), threading.Event()
        def blocked(path, provider, **kwargs):
            started.set()
            if not finish.wait(5):
                raise RuntimeError('test timeout')
            return run(path, provider)
        self.client = TestClient(create_app(self.settings, client_factory=lambda: self.provider, runner=blocked))
        with ThreadPoolExecutor() as pool:
            future = pool.submit(self.post)
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(self.client.get('/health').status_code, 200)
                self.assertEqual(self.client.post(self.path + '/resume', headers=self.headers).status_code, 409)
            finally:
                finish.set()
            self.assertEqual(future.result().status_code, 202)
        self.assertEqual(self.provider.submissions, 1)

    def test_registry_symlink_is_not_followed(self):
        shutil.rmtree(self.source)
        self.source.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(self.post().status_code, 404)
        self.assertEqual(self.provider.uploads, 0)


if __name__ == '__main__':
    unittest.main()
