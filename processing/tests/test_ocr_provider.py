import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fixture_factory import make_pdf, menu_image
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.ocr import OCRProvider
from peekaplate_processing.ocr_space import OCRSpaceClient


class OCRProviderTests(unittest.TestCase):
    def test_provider_requires_an_extract_implementation(self):
        with self.assertRaises(TypeError):
            OCRProvider()
        self.assertIsInstance(OCRSpaceClient(None), OCRProvider)

    def test_acquisition_uses_injected_provider_only_for_ocr_pages(self):
        class FixtureOCR(OCRProvider):
            def __init__(self):
                self.images = []
            def extract(self, image:bytes)->dict:
                self.images.append(image)
                return {"text": "Soup 8.50 CAD", "settings": {"OCREngine": 3}, "cache_hit": False}
        provider = FixtureOCR()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "menu.pdf"
            path.write_bytes(make_pdf([{"image": menu_image()}, {"text": "Menu prices\nDish 2 9.00 CAD"}]))
            with patch("peekaplate_processing.extract_menus.OCRSpaceClient", side_effect=AssertionError("Use the injected provider")):
                result = extract_source(path, ocr_provider=provider)
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(len(provider.images), 1)
        self.assertTrue(provider.images[0].startswith(b"\xff\xd8"))
        self.assertEqual(result.segments[0].text, "Soup 8.50 CAD")
        self.assertIn("Dish 2", result.segments[1].text)

    def test_incompatible_provider_is_rejected_for_images_and_pdfs(self):
        inputs = {"menu.png": menu_image(), "menu.pdf": make_pdf([{"image": menu_image()}])}
        with tempfile.TemporaryDirectory() as directory:
            for filename, data in inputs.items():
                path = Path(directory) / filename
                path.write_bytes(data)
                for settings in [{"OCREngine": 2}, {}, {"OCREngine": "3"}, None]:
                    with self.subTest(filename=filename, settings=settings):
                        provider = Mock(spec=OCRProvider)
                        provider.extract.return_value = {"text": "Soup 8.50 CAD", "settings": settings, "cache_hit": False}
                        result = extract_source(path, ocr_provider=provider)
                        self.assertEqual(result.status, "failed")
                        self.assertEqual(result.segments[0].status, "failed")
                        self.assertEqual(result.segments[0].text, "")
                        self.assertIn("OCR.space Engine 3", result.segments[0].error)
                        provider.extract.assert_called_once()

    def test_incompatible_ocr_keeps_later_native_pdf_page(self):
        provider = Mock(spec=OCRProvider)
        provider.extract.return_value = {"text": "Soup 8.50 CAD", "settings": {"OCREngine": 2}, "cache_hit": False}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "menu.pdf"
            path.write_bytes(make_pdf([{"image": menu_image()}, {"text": "Menu prices\nDish 2 9.00 CAD"}]))
            result = extract_source(path, ocr_provider=provider)
        self.assertEqual(result.status, "incomplete")
        self.assertEqual([segment.status for segment in result.segments], ["failed", "ready"])
        self.assertEqual(result.segments[0].text, "")
        self.assertIn("Dish 2", result.segments[1].text)
        self.assertEqual(result.segments[1].method, "pdf_native")
        provider.extract.assert_called_once()

    def test_compatible_provider_keeps_image_provenance(self):
        provider = Mock(spec=OCRProvider)
        provider.extract.return_value = {"text": "Soup 8.50 CAD", "settings": {"OCREngine": 3}, "cache_hit": False}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "menu.png"
            path.write_bytes(menu_image())
            result = extract_source(path, ocr_provider=provider)
        self.assertEqual(result.status, "complete", result.errors)
        self.assertEqual(result.segments[0].text, "Soup 8.50 CAD")
        self.assertEqual(result.segments[0].method, "ocr_space_engine3")
        self.assertEqual(result.segments[0].metadata["ocr_settings"]["OCREngine"], result.ocr_engine)
