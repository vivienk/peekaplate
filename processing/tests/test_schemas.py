import unittest
from decimal import Decimal

from pydantic import ValidationError

from peekaplate_processing import DishDraft


class DishDraftTests(unittest.TestCase):

    def setUp(self):
        self.source={
            "name":"Tomato Soup",
            "source_id":"synthetic-menu-1",
            "source_text":"Tomato Soup — tomatoes, onion, basil — 8.50 CAD",
        }

    def test_minimal_draft_preserves_unknown_fields(self):
        draft=DishDraft(**self.source)

        self.assertIsNone(draft.description)
        self.assertIsNone(draft.category)
        self.assertIsNone(draft.price_amount)
        self.assertIsNone(draft.price_currency)
        self.assertIsNone(draft.ingredients)
        self.assertIsNone(draft.image_id)
        self.assertEqual(draft.review_warnings, [])
        self.assertEqual(draft.status, "needs_review")

    def test_complete_draft_round_trips_json_without_losing_price_precision(self):
        draft=DishDraft(
            **self.source,
            description="Soup with tomatoes, onion and basil.",
            category="Starters",
            price_amount="8.50",
            price_currency="CAD",
            ingredients=["tomatoes", "onion", "basil"],
            image_id="synthetic-image-1",
            review_warnings=["Confirm the image match."],
        )

        restored=DishDraft.model_validate_json(draft.model_dump_json())

        self.assertEqual(restored, draft)
        self.assertIsInstance(restored.price_amount, Decimal)
        self.assertEqual(str(restored.price_amount), "8.50")
        self.assertEqual(restored.source_id, self.source["source_id"])
        self.assertEqual(restored.source_text, self.source["source_text"])

    def test_required_fields_reject_missing_or_blank_values(self):
        for field in ["name", "source_id", "source_text"]:
            with self.subTest(field=field, value="missing"):
                values=self.source.copy()
                del values[field]
                with self.assertRaises(ValidationError):
                    DishDraft(**values)

            for value in [None, "", "   "]:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(ValidationError):
                        DishDraft(**{**self.source, field:value})

    def test_text_is_trimmed_and_list_items_cannot_be_blank(self):
        draft=DishDraft(
            **{**self.source, "name":"  Tomato Soup  "},
            ingredients=[" tomatoes ", " onion "],
            review_warnings=[" Confirm the image match. "],
        )

        self.assertEqual(draft.name, "Tomato Soup")
        self.assertEqual(draft.ingredients, ["tomatoes", "onion"])
        self.assertEqual(draft.review_warnings, ["Confirm the image match."])

        for field in ["ingredients", "review_warnings"]:
            with self.subTest(field=field):
                with self.assertRaises(ValidationError):
                    DishDraft(**self.source, **{field:["   "]})

    def test_invalid_optional_values_and_oversized_text_are_rejected(self):
        invalid_values=[
            ("name", "x"*161),
            ("description", "x"*4001),
            ("description", "   "),
            ("category", "   "),
            ("image_id", "   "),
            ("ingredients", "tomatoes, onion"),
            ("ingredients", [123]),
        ]

        for field,value in invalid_values:
            with self.subTest(field=field, value_type=type(value).__name__):
                with self.assertRaises(ValidationError):
                    DishDraft(**{**self.source, field:value})

    def test_price_rejects_negative_nonfinite_and_nonnumeric_values(self):
        for value in ["-0.01", "NaN", "Infinity", "-Infinity", "unknown", True]:
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    DishDraft(**self.source, price_amount=value)

        draft=DishDraft(**self.source, price_amount="0")
        self.assertEqual(draft.price_amount, Decimal("0"))

    def test_currency_requires_three_uppercase_letters(self):
        for value in ["cad", "$", "CA", "CADD", "123"]:
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    DishDraft(**self.source, price_currency=value)

    def test_known_price_does_not_invent_unknown_currency(self):
        draft=DishDraft(
            **self.source,
            price_amount="8.50",
            review_warnings=["Currency is unknown."],
        )

        self.assertIsNone(draft.price_currency)
        self.assertEqual(draft.review_warnings, ["Currency is unknown."])

    def test_extra_fields_and_approval_states_are_rejected(self):
        for field,value in [("unexpected", "value"), ("status", "approved"), ("status", "published")]:
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValidationError):
                    DishDraft(**self.source, **{field:value})

    def test_assignment_is_validated_and_warning_lists_are_independent(self):
        first=DishDraft(**self.source)
        second=DishDraft(**self.source)

        first.review_warnings.append("Confirm the image match.")
        self.assertEqual(second.review_warnings, [])

        with self.assertRaises(ValidationError):
            first.status="approved"
        with self.assertRaises(ValidationError):
            first.price_amount=Decimal("-1")

        self.assertEqual(first.status, "needs_review")
        self.assertIsNone(first.price_amount)


if __name__=="__main__":
    unittest.main()
