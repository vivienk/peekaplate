"""HAR-01: Entry-scoped literal support for optional fields and currencies."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.review_candidates import export_review_candidates
from peekaplate_processing.schemas import SourceSegment
from peekaplate_processing.vision import image_source
from peekaplate_processing.workflow import ExtractedDish, apply_sections, grounded_draft
from test_input_modes import RecordingLLM, photo


def make_dish(**overrides):
    base = {
        "page_number": 1,
        "name": "Soup",
        "description": None,
        "category": None,
        "subcategory": None,
        "price_text": "USD 8.50",
        "price_amount": "8.50",
        "price_currency": "USD",
        "ingredients": None,
    }
    base.update(overrides)
    return ExtractedDish(**base)


class EntryFieldSupportTests(unittest.TestCase):
    def test_item_local_optional_fields(self):
        text = "Soup USD 8.50\nWarm tomato broth\nCoffee CAD 4.50\nRich roast with milk"
        soup = make_dish(
            name="Soup",
            description="Rich roast with milk",
            ingredients=["milk"],
            price_text="USD 8.50",
            price_amount="8.50",
            price_currency="CAD",
        )
        cleaned_soup, warnings_soup = grounded_draft(
            soup, text, dish_names=("Soup", "Coffee")
        )
        self.assertEqual(cleaned_soup.name, "Soup")
        self.assertIsNone(cleaned_soup.description)
        self.assertIsNone(cleaned_soup.ingredients)
        self.assertIsNone(cleaned_soup.price_currency)
        self.assertEqual(cleaned_soup.price_text, "USD 8.50")
        self.assertEqual(cleaned_soup.price_amount, "8.50")
        self.assertTrue(any("description cleared to null" in w for w in warnings_soup))
        self.assertTrue(any("ingredients cleared to null" in w for w in warnings_soup))
        self.assertTrue(any("price_currency cleared to null" in w for w in warnings_soup))

        # Positive control: Soup with its own entry-local fields and Coffee with its own fields
        valid_soup = make_dish(
            name="Soup",
            description="Warm tomato broth",
            ingredients=["tomato"],
            price_text="USD 8.50",
            price_amount="8.50",
            price_currency="USD",
        )
        cleaned_valid_soup, warnings_valid_soup = grounded_draft(
            valid_soup, text, dish_names=("Soup", "Coffee")
        )
        self.assertEqual(cleaned_valid_soup.description, "Warm tomato broth")
        self.assertEqual(cleaned_valid_soup.ingredients, ["tomato"])
        self.assertEqual(cleaned_valid_soup.price_currency, "USD")
        self.assertEqual(cleaned_valid_soup.price_amount, "8.50")
        self.assertEqual(warnings_valid_soup, [])

        coffee = make_dish(
            name="Coffee",
            description="Rich roast with milk",
            ingredients=["milk"],
            price_text="CAD 4.50",
            price_amount="4.50",
            price_currency="CAD",
        )
        cleaned_coffee, warnings_coffee = grounded_draft(
            coffee, text, dish_names=("Soup", "Coffee")
        )
        self.assertEqual(cleaned_coffee.description, "Rich roast with milk")
        self.assertEqual(cleaned_coffee.ingredients, ["milk"])
        self.assertEqual(cleaned_coffee.price_currency, "CAD")
        self.assertEqual(cleaned_coffee.price_amount, "4.50")
        self.assertEqual(warnings_coffee, [])

    def test_explicit_section_scope_is_preserved(self):
        # Page-level category heading above dishes + contiguous page continuation
        page1_text = "# BREAKFAST\n## HOT SOUPS\nSoup USD 8.50\nWarm tomato broth\nCoffee CAD 4.50\nRich roast with milk"
        page2_text = "Pancakes USD 9.50\nFluffy stack"
        soup = make_dish(
            page_number=1,
            name="Soup",
            category="BREAKFAST",
            subcategory="HOT SOUPS",
            description="Warm tomato broth",
        )
        cleaned_soup, warnings_soup = grounded_draft(
            soup, page1_text, dish_names=("Soup", "Coffee"), section_names=("BREAKFAST",)
        )
        self.assertEqual(cleaned_soup.category, "BREAKFAST")
        self.assertEqual(cleaned_soup.subcategory, "HOT SOUPS")
        self.assertEqual(cleaned_soup.description, "Warm tomato broth")
        self.assertEqual(warnings_soup, [])

        pancakes = make_dish(
            page_number=2,
            name="Pancakes",
            category=None,
            subcategory=None,
            description="Fluffy stack",
            price_text="USD 9.50",
            price_amount="9.50",
            price_currency="USD",
        )
        cleaned_pancakes, _ = grounded_draft(
            pancakes, page2_text, dish_names=("Pancakes",)
        )
        dishes = [cleaned_soup.model_dump(), cleaned_pancakes.model_dump()]
        sections = [
            {"page_number": 1, "category": "BREAKFAST", "continues_previous": False},
            {"page_number": 2, "category": None, "continues_previous": True},
        ]
        pages = [
            {"page_number": 1, "text": page1_text},
            {"page_number": 2, "text": page2_text},
        ]
        sec_warnings = apply_sections(dishes, sections, pages)
        self.assertEqual(sec_warnings, [])
        self.assertEqual(dishes[0]["category"], "BREAKFAST")
        self.assertEqual(dishes[0]["category_page_number"], 1)
        self.assertEqual(dishes[1]["category"], "BREAKFAST")
        self.assertEqual(dishes[1]["category_page_number"], 1)

    def test_pipeline_optional_fields_keep_private_rejections(self):
        class CrossEntryLLM(RecordingLLM):
            async def ainvoke(self, messages):
                answer = await super().ainvoke(messages)
                body = {
                    "dishes": [
                        {
                            "page_number": 1,
                            "name": "Soup",
                            "description": "Rich roast with milk",
                            "category": "DRINKS",
                            "subcategory": None,
                            "price_text": "USD 8.50",
                            "price_amount": "8.50",
                            "price_currency": "CAD",
                            "ingredients": ["milk"],
                        },
                        {
                            "page_number": 1,
                            "name": "Coffee",
                            "description": "Rich roast with milk",
                            "category": "DRINKS",
                            "subcategory": None,
                            "price_text": "CAD 4.50",
                            "price_amount": "4.50",
                            "price_currency": "CAD",
                            "ingredients": ["milk"],
                        },
                    ],
                    "sections": [
                        {"page_number": 1, "category": "DRINKS", "continues_previous": False}
                    ],
                }
                answer["raw"].content = json.dumps(body)
                return answer

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.png"
            photo(source)
            text = "# DRINKS\nSoup USD 8.50\nWarm tomato broth\nCoffee CAD 4.50\nRich roast with milk"
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
                    llm=CrossEntryLLM(),
                    pages_json=saved,
                    input_mode="ocr",
                    cache_dir=None,
                    llm_cache_dir=None,
                )
            self.assertEqual(len(report.drafts), 2)
            soup_draft, coffee_draft = report.drafts
            self.assertEqual(soup_draft.name, "Soup")
            self.assertIsNone(soup_draft.description)
            self.assertIsNone(soup_draft.ingredients)
            self.assertIsNone(soup_draft.price_currency)
            self.assertEqual(str(soup_draft.price_amount), "8.50")
            self.assertEqual(soup_draft.category, "DRINKS")

            self.assertEqual(coffee_draft.name, "Coffee")
            self.assertEqual(coffee_draft.description, "Rich roast with milk")
            self.assertEqual(coffee_draft.ingredients, ["milk"])
            self.assertEqual(coffee_draft.price_currency, "CAD")
            self.assertEqual(str(coffee_draft.price_amount), "4.50")

            exported = export_review_candidates(root / "run/extraction.json", root / "review.json")
            self.assertIsNone(exported.candidates[0].original.description)
            self.assertIsNone(exported.candidates[0].original.ingredients)
            self.assertIsNone(exported.candidates[0].original.price_currency)
            self.assertIn("description", exported.candidates[0].missing_fields)
            self.assertIn("ingredients", exported.candidates[0].missing_fields)
            self.assertIn("price_currency", exported.candidates[0].missing_fields)

            private = json.loads((root / "run/review-suggestions.json").read_text())
            soup_sug = private["suggestions"][0]
            self.assertEqual(soup_sug["original"]["description"], "Rich roast with milk")
            self.assertEqual(soup_sug["original"]["ingredients"], ["milk"])
            self.assertEqual(soup_sug["original"]["price_currency"], "CAD")
            dispositions = {d["field"]: d["disposition"] for d in soup_sug["decisions"]}
            self.assertEqual(dispositions["description"], "cleared")
            self.assertEqual(dispositions["ingredients"], "cleared")
            self.assertEqual(dispositions["price_currency"], "cleared")


if __name__ == "__main__":
    unittest.main()
