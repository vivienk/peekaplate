import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
from peekaplate_processing.cutout import automatic_mask
from peekaplate_processing.errors import ExtractionError

class AutomaticMaskTests(unittest.TestCase):
    def test_timeout_becomes_safe_fallback_error(self):
        with Image.new('RGB', (40, 30), 'orange') as photo:
            with patch('peekaplate_processing.cutout.subprocess.run', side_effect=subprocess.TimeoutExpired('model', 180)):
                with self.assertRaises(ExtractionError):
                    automatic_mask(photo)

    def test_degenerate_mask_rejected_and_valid_mask_restores_source_dimensions(self):
        for valid in (False, True):
            def model(command, **kwargs):
                root = Path(command[-1])
                with Image.new('L', (40, 30), 255) as mask:
                    if valid:
                        mask.paste(0, (0, 0, 40, 10))
                    mask.save(root / 'mask.png')
                (root / 'model.json').write_text(json.dumps({'model': 'test'}))
                return SimpleNamespace(returncode=0)
            with Image.new('RGB', (80, 60), 'orange') as photo:
                with patch('peekaplate_processing.cutout.subprocess.run', side_effect=model):
                    if not valid:
                        with self.assertRaises(ExtractionError):
                            automatic_mask(photo)
                    else:
                        import io
                        data, _ = automatic_mask(photo)
                        with Image.open(io.BytesIO(data)) as mask:
                            self.assertEqual(mask.size, photo.size)
                            self.assertEqual(mask.mode, 'L')
                            self.assertEqual(mask.getextrema(), (0, 255))
