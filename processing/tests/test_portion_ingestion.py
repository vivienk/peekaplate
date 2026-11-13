import io
import json
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from pathlib import Path
from uuid import UUID

from PIL import Image

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.portion_ingestion import digest, ingest_dish_photo, main
from peekaplate_processing.prepare_assets import main as prepare_photo

DISH = UUID('11111111-1111-4111-8111-111111111111')
REVISION = UUID('22222222-2222-4222-8222-222222222222')


class PortionIngestionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'dish.webp'
        with Image.new('RGBA', (80, 60), (0, 0, 0, 0)) as photo:
            for x in range(20, 60):
                for y in range(15, 45):
                    photo.putpixel((x, y), (120, 80, 40, 255))
            photo.save(self.source, format='WEBP', lossless=True)

    def tearDown(self):
        self.temp.cleanup()

    def ingest(self, **kwargs):
        return ingest_dish_photo(input_path=self.source, dish_id=DISH, revision_id=kwargs.pop('revision_id', REVISION),
            output_root=self.root / 'output', capture_evidence='Synthetic test photo', **kwargs)

    def test_transparent_source_is_automatic_exact_and_review_only(self):
        directory, result = self.ingest(expected_sha256=digest(self.source.read_bytes()))
        self.assertEqual(result['status'], 'ready')
        self.assertEqual((directory / 'dish.webp').read_bytes(), self.source.read_bytes())
        self.assertEqual(result['portion']['dish_id'], str(DISH))
        self.assertEqual(result['portion']['dish_revision_id'], str(REVISION))
        self.assertEqual(result['review']['status'], 'needs_review')
        self.assertFalse(result['publication']['eligible'])
        for layer in result['portion']['layers']:
            raw = (directory / layer['url'].rsplit('/', 1)[-1]).read_bytes()
            self.assertEqual(digest(raw), layer['sha256'])
            self.assertEqual(len(raw), layer['size_bytes'])

    def test_retry_reuses_verified_output_and_tampering_fails(self):
        directory, first = self.ingest()
        self.assertEqual(self.ingest(), (directory, first))
        (directory / 'dish.webp').write_bytes(b'changed')
        with self.assertRaises(ExtractionError):
            self.ingest()

    def test_new_revision_and_new_photo_have_distinct_artifacts(self):
        _, first = self.ingest()
        _, second = self.ingest(revision_id=DISH)
        self.assertNotEqual(first['asset_id'], second['asset_id'])
        with Image.open(self.source) as photo:
            altered = photo.copy()
        altered.putpixel((25, 25), (250, 0, 0, 255))
        altered.save(self.source, format='WEBP', lossless=True)
        altered.close()
        _, third = self.ingest()
        self.assertNotEqual(first['asset_id'], third['asset_id'])

    def test_owner_serving_width_tracks_visible_foreground_and_changes_identity(self):
        _, baseline = self.ingest()
        _, measured = self.ingest(serving_width_mm=280)
        self.assertNotEqual(baseline['asset_id'], measured['asset_id'])
        self.assertEqual(measured['portion']['physical_size'], {
            'width_mm': 280, 'foreground_width_fraction': 0.5, 'source': 'owner'})
        for invalid in (0, 1001, True, 28.5):
            with self.assertRaises(ExtractionError):
                self.ingest(serving_width_mm=invalid)

    def test_hash_conflict_writes_nothing(self):
        with self.assertRaises(ExtractionError):
            self.ingest(expected_sha256='0' * 64)
        self.assertFalse((self.root / 'output').exists())

    @patch('peekaplate_processing.cutout.automatic_mask', side_effect=ExtractionError('Unavailable'))
    def test_opaque_photo_retains_fallback_when_model_fails(self, _model):
        with Image.new('RGB', (80, 60), 'orange') as photo:
            photo.save(self.source, format='WEBP')
        directory, result = self.ingest()
        self.assertEqual(result['status'], 'fallback_retained')
        self.assertEqual(result['reason'], 'automatic_cutout_unavailable')
        self.assertIsNone(result['portion'])
        self.assertEqual((directory / result['fallback']).read_bytes(), self.source.read_bytes())
        mask = self.root / 'mask.png'
        with Image.new('L', (80, 60), 0) as image:
            image.paste(255, (20, 15, 60, 45))
            image.save(mask)
        directory, masked = self.ingest(mask_path=mask)
        self.assertEqual(masked['status'], 'ready')
        with Image.open(directory / 'dish.webp') as image:
            self.assertEqual(image.getchannel('A').getextrema(), (0, 255))

    def test_opaque_photo_automatically_segments_and_records_model(self):
        with Image.new('RGB', (80, 60), 'orange') as photo:
            photo.save(self.source, format='WEBP', lossless=True)
        mask_data = io.BytesIO()
        with Image.new('L', (80, 60), 0) as mask:
            mask.paste(255, (20, 15, 60, 45))
            mask.save(mask_data, format='PNG')
        metadata = {'engine': 'test', 'model_sha256': 'a' * 64}
        with patch('peekaplate_processing.cutout.automatic_mask', return_value=(mask_data.getvalue(), metadata)) as model:
            directory, result = self.ingest()
        model.assert_called_once()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['provenance']['segmentation'], metadata)
        self.assertEqual(result['provenance']['mask_sha256'], digest(mask_data.getvalue()))
        with Image.open(directory / 'dish.webp') as cutout:
            self.assertEqual(cutout.getchannel('A').getextrema(), (0, 255))
        self.assertEqual((directory / result['fallback']).read_bytes(), self.source.read_bytes())

    def test_fully_opaque_alpha_channel_also_runs_segmentation(self):
        with Image.new('RGBA', (80, 60), 'orange') as photo:
            photo.save(self.source, format='PNG')
        with patch('peekaplate_processing.cutout.automatic_mask', side_effect=ExtractionError('Unavailable')) as model:
            _, result = self.ingest()
        model.assert_called_once()
        self.assertEqual(result['reason'], 'automatic_cutout_unavailable')

    def test_mask_size_mismatch_and_budget_keep_photo(self):
        mask = self.root / 'mask.png'
        with Image.new('L', (2, 2), 0) as image:
            image.save(mask)
        _, result = self.ingest(mask_path=mask)
        self.assertEqual(result['reason'], 'invalid_mask')
        _, result = self.ingest(budget_bytes=1)
        self.assertEqual(result['reason'], 'delivery_budget_exceeded')
        self.assertIsNone(result['portion'])

    def test_corrupt_mask_retains_source_photo(self):
        mask = self.root / 'mask.png'
        mask.write_bytes(b'not an image')
        directory, result = self.ingest(mask_path=mask)
        self.assertEqual(result['reason'], 'invalid_mask')
        self.assertEqual((directory / result['fallback']).read_bytes(), self.source.read_bytes())

    def test_prepare_assets_entrypoint_automatically_ingests_portion(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = prepare_photo(['--input', str(self.source), '--dish-id', str(DISH),
                '--revision-id', str(REVISION), '--capture-evidence', 'Synthetic test photo',
                '--output-root', str(self.root / 'assets')])
        self.assertEqual(code, 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result['portion']['status'], 'ready')
        record = json.loads(Path(result['portion']['manifest']).read_text())
        self.assertEqual(record['portion']['dish_id'], str(DISH))
        self.assertFalse(record['publication']['eligible'])

    def test_direct_cli_preserves_and_validates_owner_width(self):
        arguments = ['--input', str(self.source), '--dish-id', str(DISH),
            '--revision-id', str(REVISION), '--capture-evidence', 'Synthetic photo',
            '--output-root', str(self.root / 'cli-width')]
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = main([*arguments, '--serving-width-mm', '280'])
        self.assertEqual(code, 0)
        record = json.loads(stdout.getvalue())
        self.assertEqual(record['portion']['physical_size']['width_mm'], 280)
        self.assertEqual(record['provenance']['serving_width_mm'], 280)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(main([*arguments, '--serving-width-mm', '1001']), 2)

    def test_batch_rejects_path_outside_source_root(self):
        batch = self.root / 'batch.json'
        batch.write_text(json.dumps({'jobs': [{'source': '../escape.webp'}]}))
        with redirect_stdout(io.StringIO()):
            code = main(['--batch', str(batch), '--source-root', str(self.root), '--output-root', str(self.root / 'out')])
        self.assertEqual(code, 2)
        self.assertFalse((self.root / 'out').exists())


if __name__ == '__main__':
    unittest.main()
