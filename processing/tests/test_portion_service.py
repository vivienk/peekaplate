import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from PIL import Image
from peekaplate_processing.model_service import Settings, create_app

DISH = '11111111-1111-4111-8111-111111111111'
REV = '22222222-2222-4222-8222-222222222222'

class PortionServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = TestClient(create_app(Settings('x' * 48, DISH, Path(self.temp.name))))
        self.path = f'/v1/portion-uploads/{DISH}/{REV}'
        self.headers = {'Authorization': 'Bearer ' + 'x' * 48}

    def tearDown(self):
        self.temp.cleanup()

    def test_upload_is_private_and_rejects_invalid_photos(self):
        self.assertEqual(self.client.post(self.path, content=b'photo').status_code, 401)
        self.assertEqual(self.client.post(self.path, content=b'invalid', headers=self.headers).status_code, 422)
        self.assertEqual(self.client.post(self.path, content=b'x' * 12_000_001, headers=self.headers).status_code, 413)

    def test_uploaded_opaque_photo_returns_matching_review_portion(self):
        photo, mask = io.BytesIO(), io.BytesIO()
        with Image.new('RGB', (80, 60), 'orange') as image:
            image.save(photo, format='JPEG')
        with Image.new('L', (80, 60), 0) as image:
            image.paste(255, (20, 15, 60, 45))
            image.save(mask, format='PNG')
        with patch('peekaplate_processing.cutout.automatic_mask', return_value=(mask.getvalue(), {'model': 'test'})):
            response = self.client.post(self.path, content=photo.getvalue(), headers=self.headers)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['portion']['dish_id'], DISH)
        self.assertEqual(result['portion']['dish_revision_id'], REV)
        self.assertEqual(len(result['layers']), 2)
        self.assertFalse(result['publication_eligible'])
        self.assertNotIn(str(self.temp.name), response.text)

    def test_failed_model_returns_fallback_without_losing_photo(self):
        from peekaplate_processing.errors import ExtractionError
        photo = io.BytesIO()
        with Image.new('RGB', (80, 60), 'orange') as image:
            image.save(photo, format='JPEG')
        with patch('peekaplate_processing.cutout.automatic_mask', side_effect=ExtractionError('unavailable')):
            response = self.client.post(self.path, content=photo.getvalue(), headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'fallback_retained')
        self.assertEqual(response.json()['layers'], {})
        self.assertEqual(next(Path(self.temp.name).rglob('photo.jpg')).read_bytes(), photo.getvalue())
