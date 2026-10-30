import subprocess
import sys
import time
import unittest

from peekaplate_processing.menu_layout import (
    _section_boundary_label,
    corroborate_box_price,
    entry_price,
    section_price_context,
)
from peekaplate_processing.workflow import ExtractedDish, grounded_draft


class GroundingBudgetTest(unittest.TestCase):
    def test_addon_grounding_is_bounded(self) -> None:
        code = (
            "from peekaplate_processing.workflow import ExtractedDish, grounded_draft; "
            "adversarial = 'addon' * 28 + 'z'; "
            "text = f'# Menu\\nSoup\\n{adversarial} $9.00'; "
            "meta = {'ocr_region_status': 'available', 'ocr_coordinate_space': 'uploaded_image_pixels', "
            "'upload_width': 600, 'upload_height': 600, "
            "'ocr_regions': [{'text': 'Soup', 'left': 10, 'top': 10, 'width': 60, 'height': 20}, "
            "{'text': '8.50', 'left': 120, 'top': 10, 'width': 60, 'height': 20}, "
            "{'text': adversarial, 'left': 10, 'top': 60, 'width': 200, 'height': 20}]}; "
            "soup = ExtractedDish(page_number=1, name='Soup', description=None, category='Menu', "
            "subcategory=None, price_text='8.50', price_amount='8.50', price_currency=None, ingredients=None); "
            "grounded, warnings = grounded_draft(soup, text, dish_names=['Soup', adversarial], "
            "section_names=['Menu', adversarial], ocr_metadata=meta); "
            "assert grounded.price_amount == '8.50', grounded"
        )
        started = time.perf_counter()
        try:
            proc = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            self.fail(f"grounded_draft timed out after 5s on repeated 'addon' label: {exc}")
        elapsed = time.perf_counter() - started
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertLess(elapsed, 3.5)

    def test_label_work_budget_and_boundaries(self) -> None:
        import peekaplate_processing.menu_layout as menu_layout

        work_fn = getattr(menu_layout, "_compact_non_section_work", None)
        self.assertIsNotNone(
            work_fn,
            "menu_layout must expose deterministic _compact_non_section_work(text) for linear work verification",
        )
        for rep in (1, 10, 28, 45):
            sample = "addon" * rep + "z"
            matched, steps = work_fn(sample)
            self.assertFalse(matched)
            self.assertLessEqual(steps, len(sample) * 32 + 32)

        # Boundary lengths: 0, 1, 128, 256, 257, 10_000, 100_000
        self.assertFalse(_section_boundary_label(""))
        self.assertTrue(_section_boundary_label("Z"))
        self.assertTrue(_section_boundary_label("D" * 128))
        self.assertTrue(_section_boundary_label("D" * 256))
        self.assertFalse(_section_boundary_label("D" * 257))
        self.assertTrue(_section_boundary_label("addon" * 51 + "z"))  # 256 chars ending in non-matching suffix
        self.assertFalse(_section_boundary_label("D" * 10_000))
        self.assertFalse(_section_boundary_label("D" * 100_000))

        # Page text boundary around 100,000 code points
        meta = {
            "ocr_region_status": "available",
            "ocr_page_width": 200,
            "ocr_page_height": 200,
            "ocr_regions": [
                {"text": "Dinner", "bbox": [10, 10, 80, 24]},
                {"text": "Soup", "bbox": [10, 40, 60, 54]},
                {"text": "8.50", "bbox": [120, 40, 160, 54]},
            ],
        }
        over_limit_text = "# Dinner\nSoup\n# Lunch\nSoup\n" + ("x" * 100_001)
        self.assertIsNone(
            section_price_context(
                "Soup",
                "Dinner",
                over_limit_text,
                meta,
                section_names=["Dinner", "Lunch"],
                dish_names=["Soup"],
            )
        )

    def test_exhausted_search_abstains(self) -> None:
        # 1) Geometry > 1000 regions abstains safely
        huge_meta = {
            "ocr_region_status": "available",
            "ocr_page_width": 500,
            "ocr_page_height": 500,
            "ocr_regions": [
                {"text": "Soup" if i == 0 else "8.50", "bbox": [10, 10 + i, 50, 20 + i]}
                for i in range(1001)
            ],
        }
        self.assertEqual(
            entry_price("Soup", "Soup\n8.50", huge_meta, dish_names=["Soup"]),
            {"price_text": None, "anchor": None, "label": None},
        )
        self.assertEqual(
            corroborate_box_price("Soup", "8.50", "8.50", huge_meta, dish_names=("Soup",)),
            (None, None, []),
        )

        # 2) Title path > 8 boxes abstains safely
        nine_word_name = " ".join(f"Word{i}" for i in range(9))
        nine_box_meta = {
            "ocr_region_status": "available",
            "ocr_page_width": 500,
            "ocr_page_height": 200,
            "ocr_regions": [
                {"text": f"Word{i}", "bbox": [10 + i * 25, 20, 30 + i * 25, 34]}
                for i in range(9)
            ] + [{"text": "8.50", "bbox": [300, 20, 340, 34]}],
        }
        self.assertEqual(
            entry_price(nine_word_name, f"{nine_word_name}\n8.50", nine_box_meta, dish_names=[nine_word_name]),
            {"price_text": None, "anchor": None, "label": None},
        )
        self.assertEqual(
            corroborate_box_price(nine_word_name, "8.50", "8.50", nine_box_meta, dish_names=(nine_word_name,)),
            (None, None, []),
        )

    def test_valid_section_labels_unchanged(self) -> None:
        for valid in ("Desserts", "STARTERS & SALADS", "Chef Specials", "Hot Drinks", "Boissons Chaudes"):
            self.assertTrue(_section_boundary_label(valid), valid)
        self.assertTrue(_section_boundary_label("Soup 1", food_entry=True))
        for invalid in ("Price", "Small / Large", "addon", "add on", "USD", "kcal", "100ml", "$", "Price™"):
            self.assertFalse(_section_boundary_label(invalid), invalid)
        self.assertFalse(_section_boundary_label("addon", food_entry=True))
        self.assertFalse(_section_boundary_label("SmallMediumLarge", food_entry=True))


if __name__ == "__main__":
    unittest.main()
