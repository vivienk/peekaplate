import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "peekaplate_processing"))
from ocr_regions import extract_regions


class RegionTests(unittest.TestCase):
    def page(self, word):
        return {"TextOverlay": {"HasOverlay": True, "Lines": [{"Words": [word]}]}}

    def test_retains_literal_words_and_uploaded_pixel_coordinates(self):
        word = {"WordText": "Soup", "Left": 1.5, "Top": 20, "Width": 50, "Height": 12}
        self.assertEqual(extract_regions(self.page(word)), {"region_status": "available", "regions": [{"text": "Soup", "left": 1.5, "top": 20, "width": 50, "height": 12}]})

    def test_absent_boxes_stay_unavailable_instead_of_fabricated(self):
        for page in ({}, {"TextOverlay": {"HasOverlay": False}}, {"TextOverlay": {"HasOverlay": True, "Lines": [{"Words": []}]}}):
            self.assertEqual(extract_regions(page), {"regions": [], "region_status": "unavailable"})

    def test_malformed_boxes_are_marked_invalid_without_discarding_page_text(self):
        base = {"WordText": "Soup", "Left": 0, "Top": 0, "Width": 50, "Height": 12}
        for patch in ({"Left": -1}, {"Top": True}, {"Width": 0}, {"Height": float("nan")}, {"Left": "10"}, {"Left": 10**1000}, {"WordText": ""}):
            with self.subTest(patch=patch):
                self.assertEqual(extract_regions(self.page({**base, **patch})), {"regions": [], "region_status": "invalid"})

    def test_excessive_overlay_is_bounded(self):
        self.assertEqual(extract_regions({"TextOverlay": {"HasOverlay": True, "Lines": [{}] * 10_001}})["region_status"], "invalid")


if __name__ == "__main__":
    unittest.main()
