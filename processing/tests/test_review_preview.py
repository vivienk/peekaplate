import io
import json
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

from PIL import Image, ImageDraw
from fixture_factory import food_photo, presentation_photo
from peekaplate_processing.assets import prepare_t0_bundle
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.review_preview import prepare_review_preview, main


class ReviewPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        source = self.root / 'source.jpg'
        source.write_bytes(food_photo(640, 853))
        self.t0 = prepare_t0_bundle(input_path=source, output_root=self.root/'t0',
            dish_id=UUID('11111111-1111-4111-8111-111111111111'),
            revision_id=UUID('22222222-2222-4222-8222-222222222222'),
            capture_evidence='Synthetic test fixture.', captured_at=None, budget_bytes=None)
        self.mask = self.root/'mask.png'
        mask = Image.new('L', (640,853))
        ImageDraw.Draw(mask).ellipse((40,80,600,800), fill=255)
        mask.save(self.mask)
        self.candidate = self.root/'candidate.png'
        self.candidate.write_bytes(presentation_photo(512,512,transparent_corners=True,has_alpha=True))
        self.prompt = self.root/'prompt.txt'; self.prompt.write_text('Synthetic candidate test prompt.')

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, **kwargs):
        args=dict(t0_manifest_path=self.t0.directory/'manifest.json',mask_path=self.mask,
                  output_root=self.root/'reviews',capture_evidence='Synthetic fixture only.')
        args.update(kwargs)
        return prepare_review_preview(**args)

    def generated(self, **kwargs):
        return self.prepare(candidate_path=self.candidate,model_version='synthetic-v1',prompt_path=self.prompt,**kwargs)

    def test_cutout_preserves_pixels_and_verified_original(self):
        directory, record = self.prepare()
        original = (self.t0.directory/'detail-1280.jpg').read_bytes()
        self.assertEqual((directory/'fallback.jpg').read_bytes(),original)
        with Image.open(io.BytesIO(original)) as image, Image.open(directory/'cutout.png') as cutout:
            self.assertEqual(image.convert('RGB').getpixel((320,400)),cutout.getpixel((320,400))[:3])
            self.assertEqual(cutout.getpixel((0,0))[3],0)
        self.assertEqual(record['review']['status'],'needs_review')
        self.assertFalse(record['publication']['eligible'])
        self.assertEqual(record['total_bytes'],sum(p.stat().st_size for p in directory.iterdir()))

    def test_candidate_download_is_byte_identical_and_provenance_affects_identity(self):
        first, record = self.generated()
        self.assertEqual((first/'presentation.png').read_bytes(),self.candidate.read_bytes())
        self.assertEqual(record['preview_mode'],'generated')
        self.prompt.write_text('Changed prompt')
        second, _ = self.generated()
        self.assertNotEqual(first,second)

    def test_repeat_is_refused_without_changing_previous_output(self):
        directory, _ = self.generated()
        before=(directory/'review-manifest.json').read_bytes()
        with self.assertRaisesRegex(ExtractionError,'already exists'): self.generated()
        self.assertEqual(before,(directory/'review-manifest.json').read_bytes())
        self.assertEqual(len(list((self.root/'reviews').iterdir())),1)

    def test_invalid_candidate_keeps_original_and_returns_cli_nonzero(self):
        self.candidate.write_bytes(b'not a png')
        directory, record = self.generated()
        self.assertEqual(record['preview_mode'],'fallback')
        self.assertFalse((directory/'presentation.png').exists())
        self.assertIn("'fallback'==='fallback'",(directory/'index.html').read_text())
        self.assertEqual(main(['--t0-manifest',str(self.t0.directory/'manifest.json'),'--mask',str(self.mask),
            '--output-root',str(self.root/'cli'),'--capture-evidence','Synthetic test','--candidate',str(self.candidate),
            '--model-version','test','--prompt',str(self.prompt)]),2)

    def test_invalid_mask_dimensions_empty_and_opaque_are_rejected(self):
        for size,value in [((10,10),0),((640,853),0),((640,853),255)]:
            Image.new('L',size,value).save(self.mask)
            with self.assertRaises(ExtractionError): self.prepare()
        self.assertFalse((self.root/'reviews').exists())

    def test_missing_provenance_budget_and_tampered_fallback_rejected(self):
        with self.assertRaises(ExtractionError): self.prepare(candidate_path=self.candidate)
        with self.assertRaises(ExtractionError): self.prepare(budget_bytes=1)
        self.assertFalse((self.root/'reviews').exists())
        (self.t0.directory/'detail-1280.jpg').write_bytes(b'tampered')
        with self.assertRaisesRegex(ExtractionError,'hash'): self.prepare()

    def test_user_text_is_never_inserted_into_html(self):
        directory, _ = self.prepare(capture_evidence='<script>alert(1)</script>')
        self.assertNotIn('<script>alert(1)</script>',(directory/'index.html').read_text())
        self.assertNotIn(str(self.root),(directory/'review-manifest.json').read_text())


if __name__ == '__main__': unittest.main()
