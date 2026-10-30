"""HAR-02 & HAR-03: Entry-scoped price corroboration and price-field coherence."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.review_candidates import export_review_candidates
from peekaplate_processing.schemas import SourceSegment
from peekaplate_processing.vision import image_source
from peekaplate_processing.workflow import ExtractedDish, grounded_draft
from test_input_modes import RecordingLLM, photo
from test_menu_layout import box, layout


def make_dish(**overrides):
    base = {
        "page_number": 1,
        "name": "Soup",
        "description": None,
        "category": None,
        "subcategory": None,
        "price_text": "8.50",
        "price_amount": "8.50",
        "price_currency": None,
        "ingredients": None,
    }
    base.update(overrides)
    return ExtractedDish(**base)


class PriceDecisionTests(unittest.TestCase):
    def test_cross_entry_corroboration(self):
        # Soup geometry contains only "8.50"; Tea independently contains a valid "8.50".
        # Soup canonical text is "8.50 / 12.50", "8.50 kcal", or "-8.50".
        metadata = layout(
            box("Soup", 20, 20, 80),
            box("8.50", 200, 20, 60),
            box("Tea", 20, 80, 60),
            box("8.50", 200, 80, 60),
        )
        before_meta = copy.deepcopy(metadata)
        for soup_canonical in ("8.50 / 12.50", "8.50 kcal", "-8.50"):
            text = f"Soup {soup_canonical}\nTea 8.50"
            with self.subTest(soup_canonical=soup_canonical):
                soup_dish = make_dish(name="Soup", price_text="8.50", price_amount="8.50")
                cleaned_soup, warnings_soup, boxes_soup = grounded_draft(
                    soup_dish,
                    text,
                    dish_names=("Soup", "Tea"),
                    ocr_metadata=metadata,
                    return_box_evidence=True,
                )
                # Tea's number cannot validate Soup's clipped, unit-bearing or signed value
                self.assertIsNone(cleaned_soup.price_amount)
                self.assertEqual(boxes_soup, [])
                if soup_canonical == "8.50 / 12.50":
                    # Complete printed options are not silently reduced to one option
                    self.assertIn(cleaned_soup.price_text, (None, "8.50 / 12.50"))
                else:
                    self.assertIsNone(cleaned_soup.price_text)

                # Unrelated neighboring entry Tea remains unchanged
                tea_dish = make_dish(name="Tea", price_text="8.50", price_amount="8.50")
                cleaned_tea, _, _ = grounded_draft(
                    tea_dish,
                    text,
                    dish_names=("Soup", "Tea"),
                    ocr_metadata=metadata,
                    return_box_evidence=True,
                )
                self.assertEqual(cleaned_tea.price_text, "8.50")
                self.assertEqual(cleaned_tea.price_amount, "8.50")
        self.assertEqual(metadata, before_meta)
        # Also verify box-only fallback when canonical entry has no digits on Soup's line
        # but has digits on a second line before Tea, or when Soup's box is clipped
        for extra_line in ("8.50 / 12.50", "8.50 kcal", "-8.50"):
            text_multiline = f"Soup\n{extra_line}\nTea 8.50"
            with self.subTest(multiline=extra_line):
                soup_dish = make_dish(name="Soup", price_text="8.50", price_amount="8.50")
                cleaned_soup, _, boxes_soup = grounded_draft(
                    soup_dish,
                    text_multiline,
                    dish_names=("Soup", "Tea"),
                    ocr_metadata=metadata,
                    return_box_evidence=True,
                )
                self.assertIsNone(cleaned_soup.price_amount)
                self.assertEqual(boxes_soup, [])

    def test_complete_group_and_single_controls(self):
        # Positive controls:
        # 1. Uniquely supported single price remains valid
        # 2. Complete supported option group retains its literal text and null scalar
        # 3. Known zero price survives
        # 4. Unrelated neighboring entries remain unchanged
        text = "Soup\n8.50 / 12.50\nTea\n8.50\nWater\n0.00"
        metadata = layout(
            box("Soup", 20, 20, 80),
            box("8.50 / 12.50", 200, 20, 120),
            box("Tea", 20, 70, 60),
            box("8.50", 200, 70, 60),
            box("Water", 20, 120, 80),
            box("0.00", 200, 120, 60),
        )
        names = ("Soup", "Tea", "Water")

        soup = make_dish(name="Soup", price_text="8.50 / 12.50", price_amount="8.50")
        c_soup, w_soup = grounded_draft(soup, text, dish_names=names, ocr_metadata=metadata)
        self.assertEqual(c_soup.price_text, "8.50 / 12.50")
        self.assertIsNone(c_soup.price_amount)
        self.assertTrue(any("Multiple printed prices" in w for w in w_soup))

        tea = make_dish(name="Tea", price_text="8.50", price_amount="8.50")
        c_tea, w_tea = grounded_draft(tea, text, dish_names=names, ocr_metadata=metadata)
        self.assertEqual(c_tea.price_text, "8.50")
        self.assertEqual(c_tea.price_amount, "8.50")
        self.assertEqual(w_tea, [])

        water = make_dish(name="Water", price_text="0.00", price_amount="0.00")
        c_water, w_water = grounded_draft(water, text, dish_names=names, ocr_metadata=metadata)
        self.assertEqual(c_water.price_text, "0.00")
        self.assertEqual(c_water.price_amount, "0.00")
        self.assertEqual(w_water, [])

    def test_pipeline_cross_entry_corroboration(self):
        class ClippedSoupLLM(RecordingLLM):
            async def ainvoke(self, messages):
                answer = await super().ainvoke(messages)
                body = {
                    "dishes": [
                        {
                            "page_number": 1,
                            "name": "Soup",
                            "description": None,
                            "category": None,
                            "subcategory": None,
                            "price_text": "8.50",
                            "price_amount": "8.50",
                            "price_currency": None,
                            "ingredients": None,
                        },
                        {
                            "page_number": 1,
                            "name": "Tea",
                            "description": None,
                            "category": None,
                            "subcategory": None,
                            "price_text": "8.50",
                            "price_amount": "8.50",
                            "price_currency": None,
                            "ingredients": None,
                        },
                    ],
                    "sections": [
                        {"page_number": 1, "category": None, "continues_previous": False}
                    ],
                }
                answer["raw"].content = json.dumps(body)
                return answer

        for idx, soup_canonical in enumerate(("8.50 / 12.50", "8.50 kcal", "-8.50")):
            with self.subTest(soup_canonical=soup_canonical), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                source = root / "source.png"
                photo(source)
                text = f"Soup {soup_canonical}\nTea 8.50"
                metadata = layout(
                    box("Soup", 2, 2, 10, 5),
                    box("8.50", 20, 2, 10, 5),
                    box("Tea", 2, 12, 10, 5),
                    box("8.50", 20, 12, 10, 5),
                )
                metadata.update(upload_width=48, upload_height=32)
                pages = image_source(source)
                pages.status = "complete"
                pages.errors = []
                pages.segments = [
                    SourceSegment(
                        segment_id="synthetic:page:1",
                        page_number=1,
                        method="ocr_space_engine3",
                        text=text,
                        metadata=metadata,
                    )
                ]
                saved = root / "pages.json"
                saved.write_text(pages.model_dump_json())
                with patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                    report = run_pipeline(
                        source,
                        root / f"run-{idx}",
                        llm=ClippedSoupLLM(),
                        pages_json=saved,
                        input_mode="ocr",
                        cache_dir=None,
                        llm_cache_dir=None,
                    )
                self.assertEqual(len(report.drafts), 2)
                soup_draft, tea_draft = report.drafts
                self.assertIsNone(soup_draft.price_amount)
                self.assertIsNone(soup_draft.price_text)
                self.assertEqual(str(tea_draft.price_amount), "8.50")
                self.assertEqual(tea_draft.price_text, "8.50")

                exported = export_review_candidates(
                    root / f"run-{idx}/extraction.json", root / f"review-{idx}.json"
                )
                self.assertIsNone(exported.candidates[0].original.price_amount)
                self.assertIsNone(exported.candidates[0].original.price_text)
                self.assertIn("price_amount", exported.candidates[0].missing_fields)
                self.assertEqual(str(exported.candidates[1].original.price_amount), "8.50")

                private = json.loads((root / f"run-{idx}/review-suggestions.json").read_text())
                soup_sug = private["suggestions"][0]
                self.assertEqual(soup_sug["original"]["price_text"], "8.50")
                self.assertEqual(soup_sug["original"]["price_amount"], "8.50")
                dispositions = {d["field"]: d["disposition"] for d in soup_sug["decisions"]}
                self.assertEqual(dispositions["price_text"], "cleared")
                self.assertEqual(dispositions["price_amount"], "cleared")

    def test_price_field_coherence(self):
        # 1. price_text="8.50", price_amount="12.50" in an entry that has both numbers independently
        text = "Soup\nregular 8.50 with side 12.50"
        dish = make_dish(name="Soup", price_text="8.50", price_amount="12.50")
        cleaned, warnings = grounded_draft(dish, text, dish_names=("Soup",))
        # Text and amount cannot contradict one another
        self.assertIsNone(cleaned.price_amount)
        self.assertTrue(any("price_amount" in w or "ambiguous" in w.lower() or "contradict" in w.lower() for w in warnings))

        # 2. Currency contradicting literal price_text ("USD 8.50" vs price_currency="CAD")
        text_curr = "Soup USD 8.50\nTax in CAD"
        dish_curr = make_dish(
            name="Soup", price_text="USD 8.50", price_amount="8.50", price_currency="CAD"
        )
        cleaned_curr, warnings_curr = grounded_draft(dish_curr, text_curr, dish_names=("Soup",))
        self.assertEqual(cleaned_curr.price_text, "USD 8.50")
        self.assertEqual(cleaned_curr.price_amount, "8.50")
        self.assertIsNone(cleaned_curr.price_currency)
        self.assertTrue(any("price_currency cleared to null" in w for w in warnings_curr))

    def test_non_slash_alternatives_and_numeric_clusters(self):
        # Non-slash alternatives such as "$8.50 or $12.50"
        for text_body, supplied_text in [
            ("Soup $8.50 or $12.50", "$8.50 or $12.50"),
            ("Soup $8.50 or $12.50", "$8.50"),
            ("Soup 8.50 / 12.50", "8.50"),
            ("Soup 8.50 12.50", "8.50"),
            ("Soup -8.50", "8.50"),
        ]:
            with self.subTest(text_body=text_body, supplied_text=supplied_text):
                dish = make_dish(name="Soup", price_text=supplied_text, price_amount="8.50")
                cleaned, warnings = grounded_draft(dish, text_body, dish_names=("Soup",))
                # Unresolved alternatives cannot silently become a single scalar
                self.assertIsNone(cleaned.price_amount)
                # No fabricated slash or option labels
                if supplied_text == "$8.50 or $12.50":
                    self.assertIn(cleaned.price_text, (None, "$8.50 or $12.50"))
                else:
                    self.assertIsNone(cleaned.price_text)

    def test_money_unit_and_zero_controls(self):
        # Explicit money beside separately labelled calorie/portion counts survives
        for text, p_text, p_amount in [
            ("Soup $8.50 250 kcal", "$8.50", "8.50"),
            ("Soup USD 8.50 (2 pcs)", "USD 8.50", "8.50"),
            ("Soup $0.00 100 kcal", "$0.00", "0.00"),
        ]:
            with self.subTest(text=text):
                dish = make_dish(name="Soup", price_text=p_text, price_amount=p_amount)
                cleaned, warnings = grounded_draft(dish, text, dish_names=("Soup",))
                self.assertEqual(cleaned.price_text, p_text)
                self.assertEqual(cleaned.price_amount, p_amount)
                self.assertEqual(warnings, [])

    def test_pipeline_price_coherence(self):
        class IncoherentLLM(RecordingLLM):
            async def ainvoke(self, messages):
                answer = await super().ainvoke(messages)
                body = {
                    "dishes": [
                        {
                            "page_number": 1,
                            "name": "Soup",
                            "description": None,
                            "category": None,
                            "subcategory": None,
                            "price_text": "$8.50 or $12.50",
                            "price_amount": "8.50",
                            "price_currency": None,
                            "ingredients": None,
                        },
                        {
                            "page_number": 1,
                            "name": "Salad",
                            "description": None,
                            "category": None,
                            "subcategory": None,
                            "price_text": "$9.50",
                            "price_amount": "9.50",
                            "price_currency": None,
                            "ingredients": None,
                        },
                        {
                            "page_number": 1,
                            "name": "Water",
                            "description": None,
                            "category": None,
                            "subcategory": None,
                            "price_text": "0.00",
                            "price_amount": "0.00",
                            "price_currency": None,
                            "ingredients": None,
                        },
                    ],
                    "sections": [
                        {"page_number": 1, "category": None, "continues_previous": False}
                    ],
                }
                answer["raw"].content = json.dumps(body)
                return answer

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.png"
            photo(source)
            text = "Soup $8.50 or $12.50\nSalad $9.50 320 kcal\nWater 0.00"
            pages = image_source(source)
            pages.status = "complete"
            pages.errors = []
            pages.segments = [
                SourceSegment(
                    segment_id="synthetic:page:1",
                    page_number=1,
                    method="ocr_space_engine3",
                    text=text,
                    metadata={"ocr_region_status": "unavailable"},
                )
            ]
            saved = root / "pages.json"
            saved.write_text(pages.model_dump_json())
            with patch("peekaplate_processing.run_pipeline.extract_source", side_effect=AssertionError("No OCR")):
                report = run_pipeline(
                    source,
                    root / "run",
                    llm=IncoherentLLM(),
                    pages_json=saved,
                    input_mode="ocr",
                    cache_dir=None,
                    llm_cache_dir=None,
                )
            exported = export_review_candidates(root / "run/extraction.json", root / "review.json")
            soup_c, salad_c, water_c = exported.candidates
            self.assertIsNone(soup_c.original.price_amount)
            self.assertEqual(soup_c.original.price_text, "$8.50 or $12.50")
            self.assertNotIn("price_amount", soup_c.missing_fields)

            self.assertEqual(str(salad_c.original.price_amount), "9.50")
            self.assertEqual(salad_c.original.price_text, "$9.50")

            self.assertEqual(str(water_c.original.price_amount), "0.00")
            self.assertNotIn("price_amount", water_c.missing_fields)


if __name__ == "__main__":
    unittest.main()
