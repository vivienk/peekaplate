"""Synthetic direct-vision ingredient controls; no provider requests or accuracy claims."""
import base64
import hashlib
import unittest
from datetime import datetime, timezone

from fixture_factory import menu_image
from peekaplate_processing.ingredient_intelligence import build_review_handoff
from peekaplate_processing.review_candidates import prepare_review_candidates
from peekaplate_processing.schemas import SourceRecord
from peekaplate_processing.vision_extraction import V4Dish, build_v4_result


def _report(dishes, *, page_images=None):
    raw = menu_image()
    digest = hashlib.sha256(raw).hexdigest()
    now = datetime.now(timezone.utc)
    source = SourceRecord(
        source_id=f"sha256:{digest}", sha256=digest, kind="image",
        location="synthetic-menu.jpg", retrieved_at=now, size_bytes=len(raw),
        snapshot_base64=base64.b64encode(raw).decode(),
    )
    pages = page_images or [{"page_number": 1, "image_reference": {"width": 800, "height": 500}}]
    return build_v4_result(source, pages, dishes, now)


class VisionIngredientTests(unittest.TestCase):
    def test_printed_ingredients_survive_evidenced_review_export(self):
        raw = menu_image()
        digest = hashlib.sha256(raw).hexdigest()
        now = datetime.now(timezone.utc)
        source = SourceRecord(
            source_id=f"sha256:{digest}", sha256=digest, kind="image",
            location="synthetic-menu.jpg", retrieved_at=now, size_bytes=len(raw),
            snapshot_base64=base64.b64encode(raw).decode(),
        )
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Garden Plate",
            "description": "tomato and mozzarella",
            "ingredients": ["tomato", "mozzarella"],
            "box": [100, 100, 200, 400],
        })
        report = build_v4_result(source, [{"page_number": 1,
            "image_reference": {"width": 800, "height": 500}}], [dish], now)
        exported = prepare_review_candidates(report)
        self.assertEqual(exported.candidates[0].original.ingredients, ["tomato", "mozzarella"])
        self.assertEqual(exported.candidates[0].original.status, "needs_review")
        self.assertIn("tomato and mozzarella", exported.candidates[0].original.source_text)
        segments = {s.segment_id: s for s in exported.segments}
        passages = [segments[s.segment_id].text[s.start:s.end] for s in exported.candidates[0].evidence]
        self.assertEqual("\n".join(passages), exported.candidates[0].original.source_text)
        self.assertEqual(report.evidence[0].box_evidence, [])

    def test_ingredients_without_a_printed_description_stay_unknown(self):
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Garden Plate", "ingredients": ["tomato"],
            "box": [100, 100, 200, 400],
        })
        report = _report([dish])
        self.assertIsNone(report.drafts[0].ingredients)
        self.assertTrue(any("without a printed description" in warning for warning in report.warnings))
        exported = prepare_review_candidates(report)
        self.assertIsNone(exported.candidates[0].original.ingredients)
        self.assertIn("ingredients", exported.candidates[0].missing_fields)

    def test_unsupported_and_title_only_proposals_are_dropped_with_warnings(self):
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Garden Plate",
            "description": "tomato and mozzarella",
            "ingredients": ["tomato", "tom", "truffle", "Garden", "mozzarella"],
            "box": [100, 100, 200, 400],
        })
        report = _report([dish])
        self.assertEqual(report.drafts[0].ingredients, ["tomato", "mozzarella"])
        rejected = "\n".join(report.warnings)
        for term in ("'tom'", "'truffle'", "'Garden'"):
            self.assertIn(f"proposed ingredient {term} is not printed in its description", rejected)
        exported = prepare_review_candidates(report)
        self.assertEqual(exported.candidates[0].original.ingredients, ["tomato", "mozzarella"])

    def test_multiword_and_unicode_terms_follow_literal_boundaries(self):
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Garden Plate",
            "description": "Cre\u0300me frai\u0302che, jalapeño and corn   tortilla",
            "ingredients": ["Crème fraîche", "jalapeño", "corn tortilla", "creme fraiche", "jalap"],
            "box": [100, 100, 200, 400],
        })
        report = _report([dish])
        self.assertEqual(report.drafts[0].ingredients, ["Crème fraîche", "jalapeño", "corn tortilla"])
        rejected = "\n".join(report.warnings)
        self.assertIn("'creme fraiche'", rejected)
        self.assertIn("'jalap'", rejected)

    def test_review_export_keeps_only_affirmatively_printed_ingredients(self):
        descriptions = (
            "Basil with tomato; without cheese or ham; optional bacon; choice of tofu or steak.",
            "Without cheese; topped with cheese. Onion (optional); mint on request.",
            "No almonds, cashews or walnuts; served with parsley.",
            "Tofu instead of chicken, served with basil.",
            "Without cheese\nor ham.",
        )
        dishes = [
            V4Dish.model_validate({
                "page_number": 1, "name": f"Tasting Plate {index}",
                "description": description,
                "ingredients": ingredients, "box": [80, 100, 120, 400],
            })
            for index, (description, ingredients) in enumerate(zip(descriptions, (
                ["Basıl", "Basil", "tomato", "cheese", "ham", "bacon", "tofu", "steak"],
                ["cheese", "onion", "mint"],
                ["almonds", "cashews", "walnuts", "parsley"],
                ["tofu", "chicken", "basil"],
                ["cheese", "ham"],
            )))
        ]
        candidates = prepare_review_candidates(_report(dishes)).candidates
        self.assertEqual([item.original.ingredients for item in candidates], [
            ["Basil", "tomato"], ["cheese"], ["parsley"], ["tofu", "basil"], None,
        ])
        self.assertEqual([item.original.description for item in candidates], list(descriptions))

    def test_bare_alternatives_are_not_affirmative_ingredients(self):
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Plate",
            "description": "Chicken or beef; served with basil.",
            "ingredients": ["chicken", "beef", "basil"],
            "box": [80, 100, 120, 400],
        })
        candidate = prepare_review_candidates(_report([dish])).candidates[0]
        self.assertEqual(candidate.original.ingredients, ["basil"])

    def test_repeated_titles_keep_their_own_description_spans(self):
        dishes = [
            V4Dish.model_validate({
                "page_number": 1, "name": "Tasting Plate", "description": "tomato salad",
                "ingredients": ["tomato"], "box": [80, 100, 120, 400],
            }),
            V4Dish.model_validate({
                "page_number": 1, "name": "Tasting Plate", "description": "mozzarella and basil",
                "ingredients": ["mozzarella", "tomato"], "box": [180, 100, 220, 400],
            }),
        ]
        report = _report(dishes)
        self.assertEqual([d.ingredients for d in report.drafts], [["tomato"], ["mozzarella"]])
        self.assertTrue(any("Tasting Plate" in warning and "'tomato'" in warning
                            for warning in report.warnings))
        exported = prepare_review_candidates(report)
        segments = {segment.segment_id: segment for segment in exported.segments}
        passages = []
        for candidate in exported.candidates:
            candidate_passages = [segments[span.segment_id].text[span.start:span.end]
                                  for span in candidate.evidence]
            self.assertEqual("\n".join(candidate_passages), candidate.original.source_text)
            passages.append(candidate_passages)
        self.assertEqual(passages, [["Tasting Plate", "tomato salad"],
                                    ["Tasting Plate", "mozzarella and basil"]])
        self.assertNotEqual(report.evidence[0].spans[0].start, report.evidence[1].spans[0].start)
        self.assertEqual(report.segments[0].metadata["text_origin"], "vision_model_transcription")
        self.assertEqual([record["text"] for record in
                          report.segments[0].metadata["vision_boxes"][report.evidence[0].draft_id]],
                         ["Tasting Plate"])

    def test_candidate_ingredients_do_not_upgrade_the_vision_sidecar(self):
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Garden Plate",
            "description": "tomato and mozzarella",
            "ingredients": ["tomato", "mozzarella"],
            "box": [100, 100, 200, 400],
        })
        handoff = build_review_handoff(_report([dish]))
        self.assertFalse(handoff.publishable)
        self.assertEqual(handoff.assessments[0].status, "unknown")
        self.assertEqual([item.status for item in handoff.assessments[0].ingredients],
                         ["unknown", "unknown"])
        self.assertEqual({item.reason for item in handoff.assessments[0].ingredients},
                         {"missing_evidence"})

    def test_ingredient_proposals_are_bounded_for_the_sidecar(self):
        terms = [f"herb{index}" for index in range(105)]
        dish = V4Dish.model_validate({
            "page_number": 1, "name": "Herb Plate", "description": " ".join(terms),
            "ingredients": terms, "box": [100, 100, 200, 400],
        })
        report = _report([dish])
        self.assertEqual(len(report.drafts[0].ingredients), 100)
        self.assertTrue(any("more than 100 ingredients" in warning for warning in report.warnings))
        self.assertFalse(build_review_handoff(report).publishable)

        long_term = "a" * 257
        long_dish = V4Dish.model_validate({
            "page_number": 1, "name": "Long Plate", "description": long_term,
            "ingredients": [long_term], "box": [100, 100, 200, 400],
        })
        long_report = _report([long_dish])
        self.assertIsNone(long_report.drafts[0].ingredients)
        self.assertTrue(any("longer than 256 characters" in warning for warning in long_report.warnings))

    def test_review_export_leaves_currency_for_owner_without_changing_printed_price(self):
        for price, proposed in (
            ("$8", "USD"),
            (None, "CAD"),
            ("AUD $8", "AUD"),
            ("€8", "EUR"),
            ("USD 8 / SEK 9", "USD"),
        ):
            with self.subTest(price=price, proposed=proposed):
                dish = V4Dish.model_validate({
                    "page_number": 1, "name": "Soup", "price_text": price,
                    "price_currency": proposed, "box": [100, 100, 200, 400],
                })
                (candidate,) = prepare_review_candidates(_report([dish])).candidates
                self.assertEqual(candidate.original.price_text, price)
                self.assertIsNone(candidate.original.price_currency)
                self.assertIn("price_currency", candidate.missing_fields)

    def test_review_export_drops_numeric_price_without_printed_price_text(self):
        for price_text in (None, "", "   "):
            with self.subTest(price_text=price_text):
                dish = V4Dish.model_validate({
                    "page_number": 1, "name": "Soup", "price_text": price_text,
                    "price_amount": "19.95", "box": [100, 100, 200, 400],
                })
                (candidate,) = prepare_review_candidates(_report([dish])).candidates
                self.assertIsNone(candidate.original.price_text)
                self.assertIsNone(candidate.original.price_amount)
                self.assertIn("price_amount", candidate.missing_fields)


if __name__ == "__main__":
    unittest.main()
