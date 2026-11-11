"""Synthetic regressions for non-food titles and qualified menu prices."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from fixture_factory import make_pdf
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.review_candidates import prepare_review_candidates
from peekaplate_processing.vision_extraction import V4Dish, build_v4_result
from peekaplate_processing.workflow import ExtractedDish, grounded_draft


def candidate(name="Custom Bowl", price_text="$25.00+", price_amount="25.00"):
    return ExtractedDish(page_number=1, name=name, description=None, category=None,
                         price_text=price_text, price_amount=price_amount,
                         price_currency=None, ingredients=None)


class ProductValidationTests(unittest.TestCase):
    def test_wrapping_cloth_rejected_by_grounding(self):
        for name in ("Furoshiki Wrapping", "Wrapping Cloth", "  FUROSHIKI   WRAPPING  "):
            with self.subTest(name=name), self.assertRaisesRegex(ExtractionError, "Non-food"):
                grounded_draft(candidate(name, "$14.95", "14.95"), f"{name} $14.95")

    def test_food_wraps_and_cloth_mentions_are_not_rejected(self):
        for name in ("Chicken Wrap", "Lettuce Wraps", "Furoshiki Ramen"):
            with self.subTest(name=name):
                clean, _ = grounded_draft(candidate(name, "$14.95", "14.95"),
                                          f"{name} $14.95\nServed with a wrapping cloth.")
                self.assertEqual(clean.name, name)
                self.assertEqual(clean.price_amount, "14.95")

    def test_plus_price_is_preserved_with_unknown_scalar_and_warning(self):
        for supplied in ("$25.00+", "$25.00", None):
            with self.subTest(supplied=supplied):
                clean, warnings = grounded_draft(candidate(price_text=supplied), "Custom Bowl $25.00+")
                self.assertEqual(clean.price_text, "$25.00+")
                self.assertIsNone(clean.price_amount)
                self.assertTrue(any("minimum" in w.lower() for w in warnings))

    def test_neighbor_minimum_price_does_not_change_fixed_price(self):
        clean, warnings = grounded_draft(candidate("Soup", "$8.00", "8.00"),
            "Soup $8.00\nCustom Bowl $25.00+", dish_names=["Soup", "Custom Bowl"])
        self.assertEqual(clean.price_amount, "8.00")
        self.assertFalse(any("minimum" in w.lower() for w in warnings))

    def test_portion_plus_does_not_become_price(self):
        clean, _ = grounded_draft(candidate("Soup", "$8.00", "8.00"), "Soup $8.00\n2+ pieces")
        self.assertNotEqual(clean.price_text, "2+")

    def test_add_on_minimum_does_not_replace_an_unknown_base_price(self):
        clean, _ = grounded_draft(candidate("Soup", "$8.00", "8.00"),
                                  "Soup $8.00\nAdd topping $5.00+")
        self.assertNotEqual(clean.price_text, "$5.00+")

    def test_fixed_zero_and_option_prices_keep_existing_behavior(self):
        for printed, amount in (("$0.00", "0.00"), ("$8.00", "8.00"), ("$8.00 / $12.00", None)):
            with self.subTest(printed=printed):
                clean, warnings = grounded_draft(candidate("Soup",printed,amount),f"Soup {printed}")
                self.assertEqual(clean.price_amount, amount)
                self.assertEqual(clean.price_text, printed)
                self.assertFalse(any("minimum" in w.lower() for w in warnings))

    def test_same_value_add_on_qualifier_does_not_replace_fixed_base_price(self):
        clean, warnings = grounded_draft(candidate("Soup", "$8.00", "8.00"),
                                         "Soup $8.00, add topping $8.00+")
        self.assertEqual(clean.price_text, "$8.00")
        self.assertEqual(clean.price_amount, "8.00")
        self.assertFalse(any("minimum" in w.lower() for w in warnings))

    def test_vision_rejects_merchandise_and_warns_for_minimum_price(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"menu.pdf"
            path.write_bytes(make_pdf([{"text":"Furoshiki Wrapping $14.95\nCustom Bowl $25.00+"}]))
            source=extract_source(path).source
            dishes=[V4Dish(page_number=1, box=[10,10,20,40], name="Furoshiki Wrapping", price_text="$14.95", price_amount="14.95"),
                    V4Dish(page_number=1, box=[10,10,20,40], name="Custom Bowl", price_text="$25.00+", price_amount="25.00")]
            result=build_v4_result(source,[{"page_number":1,"image_reference":{"width":100,"height":100}}],dishes,datetime.now(timezone.utc))
        self.assertEqual([d.name for d in result.drafts], ["Custom Bowl"])
        self.assertEqual(result.status,"incomplete")
        self.assertTrue(any("Non-food" in err for err in result.errors))
        draft=result.drafts[0]
        self.assertEqual(draft.price_text,"$25.00+")
        self.assertIsNone(draft.price_amount)
        self.assertTrue(any("minimum" in w.lower() for w in draft.review_warnings))
        self.assertEqual(draft.status,"needs_review")
        review = prepare_review_candidates(result)
        self.assertEqual(len(review.candidates), 1)
        self.assertEqual(review.candidates[0].original.price_text, "$25.00+")
        self.assertIsNone(review.candidates[0].original.price_amount)
        self.assertEqual(review.candidates[0].original.status, "needs_review")
        span=result.evidence[0].spans[0]
        self.assertEqual(result.segments[0].text[span.start:span.end], draft.name)

    def test_pipeline_saves_only_review_required_food_and_keeps_rejection(self):
        dishes=[candidate("Furoshiki Wrapping","$14.95","14.95"), candidate()]
        class FakeModel:
            def with_structured_output(self, *args, **kwargs): return self
            async def ainvoke(self, messages):
                return {"raw":SimpleNamespace(content=json.dumps({"dishes":[d.model_dump() for d in dishes]}),
                    response_metadata={"finish_reason":"stop"}, additional_kwargs={})}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"menu.pdf"
            path.write_bytes(make_pdf([{"text":"Furoshiki Wrapping $14.95\nCustom Bowl $25.00+"}]))
            report=run_pipeline(path,Path(directory)/"run",llm=FakeModel(),input_mode="ocr",llm_cache_dir=None)
            saved=json.loads((Path(directory)/"run/extraction.json").read_text())
        self.assertEqual([d.name for d in report.drafts],["Custom Bowl"])
        self.assertEqual(saved['drafts'][0]['status'],"needs_review")
        self.assertIsNone(saved['drafts'][0]['price_amount'])
        self.assertEqual(saved['drafts'][0]['price_text'],"$25.00+")
        self.assertTrue(any("Non-food" in err for err in saved['errors']))
        review = prepare_review_candidates(report)
        self.assertEqual(len(review.candidates), 1)
        self.assertIsNone(review.candidates[0].original.price_amount)
        self.assertEqual(review.candidates[0].original.price_text, "$25.00+")


if __name__ == "__main__": unittest.main()
