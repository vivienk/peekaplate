import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pymupdf
from PIL import Image

from fixture_factory import make_pdf, menu_image
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.images import extract_image, prepare_ocr_image
from peekaplate_processing.pdf import MIN_NATIVE_TEXT_CHARS, extract_pdf


def ocr_result():
    return {"text": "Dish 1 8.50 CAD", "settings": {"OCREngine": 3}, "cache_hit": False, "regions": []}


class PDFImageTests(unittest.TestCase):
    def test_native_text_with_and_without_images_avoids_ocr(self):
        ocr = Mock()
        pages = extract_pdf(make_pdf([{"text": "Menu prices\nDish 1 8.50 CAD"}, {"text": "Menu prices\nDish 2 9.00 CAD", "image": menu_image()}]), "source", ocr)
        self.assertEqual([p.method for p in pages], ["pdf_native", "pdf_native"])
        self.assertIn("Dish 2", pages[1].text)
        self.assertTrue(pages[1].metadata["contains_images"])
        ocr.extract.assert_not_called()

    def test_image_only_page_uses_ocr_and_keeps_page_evidence(self):
        ocr = Mock(); ocr.extract.return_value = ocr_result()
        pages = extract_pdf(make_pdf([{"image": menu_image()}]), "source", ocr)
        self.assertEqual(pages[0].method, "ocr_space_engine3")
        self.assertEqual(pages[0].segment_id, "source#page-1")
        self.assertEqual(pages[0].text, ocr_result()["text"])
        self.assertLessEqual(len(ocr.extract.call_args.args[0]), 950_000)
        self.assertEqual(pages[0].metadata["ocr_coordinate_space"], "uploaded_image_pixels")

    def test_empty_and_vector_only_pages_also_try_ocr(self):
        doc = pymupdf.open(); doc.new_page(); page = doc.new_page(); page.draw_line((10, 10), (100, 100))
        data = doc.tobytes(); doc.close(); ocr = Mock(); ocr.extract.return_value = ocr_result()
        pages = extract_pdf(data, "source", ocr)
        self.assertEqual([p.method for p in pages], ["ocr_space_engine3", "ocr_space_engine3"])
        self.assertEqual(ocr.extract.call_count, 2)

    def test_short_text_uses_ocr_with_or_without_embedded_images(self):
        ocr = Mock(); ocr.extract.return_value = ocr_result()
        pages = extract_pdf(make_pdf([{"text": "Page 1"}, {"text": "Page 2", "image": menu_image()}]), "source", ocr)
        self.assertEqual([p.method for p in pages], ["ocr_space_engine3", "ocr_space_engine3"])
        self.assertEqual([p.native_text for p in pages], ["Page 1", "Page 2"])
        self.assertTrue(all(p.text == ocr_result()["text"] for p in pages))
        self.assertEqual(ocr.extract.call_count, 2)

    def test_native_text_cutoff_ignores_whitespace_and_checks_each_page(self):
        ocr = Mock(); ocr.extract.return_value = ocr_result()
        sparse = "\n".join(["A"] * (MIN_NATIVE_TEXT_CHARS - 1))
        sufficient = "B" * MIN_NATIVE_TEXT_CHARS
        pages = extract_pdf(make_pdf([{"text": sparse}, {"text": sufficient}]), "source", ocr)
        self.assertEqual([p.method for p in pages], ["ocr_space_engine3", "pdf_native"])
        self.assertEqual([p.metadata["native_text_chars"] for p in pages], [MIN_NATIVE_TEXT_CHARS - 1, MIN_NATIVE_TEXT_CHARS])
        self.assertEqual(pages[1].text, sufficient)
        ocr.extract.assert_called_once()

    def test_ocr_failure_keeps_later_native_page(self):
        ocr = Mock(); ocr.extract.side_effect = ExtractionError("OCR unavailable")
        pages = extract_pdf(make_pdf([{"image": menu_image()}, {"text": "Menu prices\nDish 2 9.00 CAD"}]), "source", ocr)
        self.assertEqual(pages[0].status, "failed")
        self.assertEqual(pages[0].method, "ocr_space_engine3")
        self.assertEqual(pages[1].status, "ready")
        self.assertEqual(pages[1].page_number, 2)

    def test_page_load_failure_keeps_earlier_and_later_native_pages(self):
        data = make_pdf([{"text": f"Menu prices\nDish {number} 8.50 CAD"} for number in range(1, 4)])
        load_page = pymupdf.Document.load_page
        attempts = []
        def fail_second_page(document, page_number):
            attempts.append(page_number)
            if page_number == 1:
                raise RuntimeError("synthetic page load failure")
            return load_page(document, page_number)
        ocr = Mock()
        with patch.object(pymupdf.Document, "load_page", fail_second_page):
            pages = extract_pdf(data, "source", ocr)
        self.assertEqual(attempts, [0, 1, 2])
        self.assertEqual([page.status for page in pages], ["ready", "failed", "ready"])
        self.assertEqual([page.segment_id for page in pages], ["source#page-1", "source#page-2", "source#page-3"])
        self.assertIn("Dish 1", pages[0].text)
        self.assertEqual(pages[1].error, "PDF page extraction failed.")
        self.assertIn("Dish 3", pages[2].text)
        ocr.extract.assert_not_called()

    def test_40_pages_accepted_and_41_rejected_before_ocr(self):
        ocr = Mock()
        self.assertEqual(len(extract_pdf(make_pdf([{"text": "Menu prices\nDish 1 8.50 CAD"}]*40), "source", ocr)), 40)
        with self.assertRaises(ExtractionError): extract_pdf(make_pdf([{"text": "Menu prices\nDish 1 8.50 CAD"}]*41), "source", ocr)
        ocr.extract.assert_not_called()

    def test_corrupt_and_encrypted_pdf_fail_cleanly(self):
        with self.assertRaises(ExtractionError): extract_pdf(b"%PDF-broken", "source", Mock())
        doc = pymupdf.open(); doc.new_page()
        data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="password"); doc.close()
        with self.assertRaises(ExtractionError): extract_pdf(data, "source", Mock())

    def test_uploaded_image_uses_same_ocr_adapter(self):
        ocr = Mock(); ocr.extract.return_value = ocr_result()
        result = extract_image(menu_image(), "source", ocr)
        self.assertEqual(result.method, "ocr_space_engine3")
        self.assertEqual(result.text, ocr_result()["text"])
        ocr.extract.assert_called_once()

    def test_corrupt_and_multiframe_image_are_rejected(self):
        for data in [b"invalid", b"\xff\xd8\xffbad"]:
            with self.assertRaises(ExtractionError): prepare_ocr_image(data)
        output = io.BytesIO()
        Image.new("RGB", (20, 20), "white").save(output, format="GIF", save_all=True, append_images=[Image.new("RGB", (20, 20), "black")])
        with self.assertRaises(ExtractionError): prepare_ocr_image(output.getvalue())

    def test_image_orientation_is_applied_before_ocr(self):
        image = Image.new("RGB", (100, 50), "white")
        exif = image.getexif(); exif[274] = 6
        output = io.BytesIO(); image.save(output, format="JPEG", exif=exif)
        prepared, metadata = prepare_ocr_image(output.getvalue())
        with Image.open(io.BytesIO(prepared)) as upload:
            self.assertEqual(upload.size, (50, 100))
        self.assertEqual((metadata["upload_width"], metadata["upload_height"]), (50, 100))

    def test_text_acquisition_cli_contract_has_no_model_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"menu.pdf"; path.write_bytes(make_pdf([{"text": "Menu prices\nDish 1 8.50 CAD"}]))
            result = extract_source(path)
        self.assertEqual(result.status, "complete")
        self.assertEqual(result.drafts, [])
        self.assertEqual(result.configuration["stage"], "text_acquisition")
