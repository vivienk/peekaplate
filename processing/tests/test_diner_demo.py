import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

from PIL import Image, ImageDraw
from fixture_factory import food_photo
from peekaplate_processing.assets import prepare_t0_bundle
from peekaplate_processing.diner_demo import prepare_diner_demo
from peekaplate_processing.errors import ExtractionError


class DinerDemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = self.root / 'source.jpg'
        source.write_bytes(food_photo(640, 853))
        self.t0 = prepare_t0_bundle(input_path=source, output_root=self.root/'t0',
            dish_id=UUID('11111111-1111-4111-8111-111111111111'),
            revision_id=UUID('22222222-2222-4222-8222-222222222222'),
            capture_evidence='Synthetic test fixture.', captured_at=None, budget_bytes=None)
        self.mask = self.root/'mask.png'
        with Image.new('L', (640, 853)) as mask:
            ImageDraw.Draw(mask).ellipse((40, 80, 600, 800), fill=255)
            mask.save(self.mask)
        self.out = self.root/'demo'

    def prepare(self):
        return prepare_diner_demo(t0_manifest_path=self.t0.directory/'manifest.json',
            mask_path=self.mask, output_dir=self.out, capture_evidence='Synthetic test only.')

    def test_real_pr25_output_identity_fallback_and_delivery_hashes(self):
        record = self.prepare()
        self.assertEqual(json.loads((self.out/'demo.json').read_text()), record)
        review, portion = record['review_manifest'], record['portion']
        self.assertEqual(review['provenance']['recipe'], 'review-preview-v1')
        self.assertEqual(review['provenance']['mask_sha256'], hashlib.sha256(self.mask.read_bytes()).hexdigest())
        self.assertEqual(review['review']['status'], 'needs_review')
        self.assertFalse(review['publication']['eligible'])
        self.assertEqual(portion['dish_id'], str(self.t0.manifest.dish.dish_id))
        self.assertEqual(portion['dish_revision_id'], str(self.t0.manifest.dish.revision_id))
        self.assertEqual((self.out/'photo.jpg').read_bytes(), (self.t0.directory/'detail-1280.jpg').read_bytes())
        for layer in portion['layers']:
            path = self.out/layer['url'].rsplit('/', 1)[1]
            self.assertEqual(layer['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(layer['size_bytes'], path.stat().st_size)
            with Image.open(path) as image:
                self.assertEqual(image.size, (portion['width'], portion['height']))
        with Image.open(self.out/'dish.webp') as image:
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            self.assertEqual(image.getpixel((320, 400))[3], 255)

    def test_pr25_rejects_tampered_source_before_export(self):
        (self.t0.directory/'detail-1280.jpg').write_bytes(b'tampered')
        with self.assertRaisesRegex(ExtractionError, 'hash'):
            self.prepare()
        self.assertFalse(self.out.exists())

    def test_pr25_rejects_invalid_mask_before_export(self):
        Image.new('L', (2, 2)).save(self.mask)
        with self.assertRaises(ExtractionError):
            self.prepare()
        self.assertFalse(self.out.exists())

    def test_repeat_never_overwrites_existing_demo(self):
        self.prepare()
        before = (self.out/'demo.json').read_bytes()
        with self.assertRaisesRegex(ExtractionError, 'already exists'):
            self.prepare()
        self.assertEqual((self.out/'demo.json').read_bytes(), before)
