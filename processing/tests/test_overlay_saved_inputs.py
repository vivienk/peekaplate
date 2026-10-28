"""Saved-artifact shape and ambiguous column controls; synthetic, no providers."""
import copy
import unittest

from test_overlay_review import fixture, region
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.overlay_review import prepare_overlay_review


class OverlaySavedInputTests(unittest.TestCase):
    def test_saved_error_array_and_whitespace_price_readings(self):
        report, suggestions = fixture(prices=("5.00", "29.00"), price_text="5.00 29.00")
        suggestions["errors"] = []
        before = copy.deepcopy(suggestions)
        result = prepare_overlay_review(report, suggestions)
        row = result["rows"][0]
        self.assertEqual(row["disposition"], "numeric_agreement")
        self.assertEqual([part["literal"] for part in row["proposed_price_parts"]], ["5.00", "29.00"])
        self.assertIsNone(row["proposed_price_amount"])
        self.assertEqual(suggestions, before)

    def test_saved_size_label_sequence_is_not_interpreted(self):
        report, suggestions = fixture(prices=("SM 13.00", "LG 32.00"), price_text="SM 13.00 LG 32.00")
        result = prepare_overlay_review(report, suggestions)
        row = result["rows"][0]
        self.assertEqual(row["disposition"], "numeric_agreement")
        self.assertEqual([part["literal"] for part in row["proposed_price_parts"]], ["SM 13.00", "LG 32.00"])
        self.assertIsNone(row["proposed_price_amount"])
        self.assertNotIn("size", row)
        self.assertNotIn("price_text", row)

    def test_whitespace_does_not_turn_possible_decimal_fragments_into_options(self):
        report, suggestions = fixture(prices=("3", "50"), price_text="3 50")
        row = prepare_overlay_review(report, suggestions)["rows"][0]
        self.assertEqual(row["disposition"], "abstained")
        self.assertEqual(row["proposed_price_parts"], [])

    def test_nonfinite_retained_suggestion_data_is_rejected(self):
        for value in (float("nan"), float("inf")):
            report, suggestions = fixture()
            suggestions["suggestions"][0]["decisions"].append({
                "field": "price_amount", "suggested_value": value,
                "disposition": "unvalidated", "reason": "Synthetic invalid saved value",
            })
            with self.subTest(value=value), self.assertRaises(ExtractionError):
                prepare_overlay_review(report, suggestions)

    def test_uncertain_vertical_price_overlap_cannot_be_ignored(self):
        report, suggestions = fixture(prices=("8.50",), price_text="8.50")
        # The second reading partly intersects the same heading/price row but
        # misses the same-row threshold. It cannot disappear from completeness.
        report["segments"][0]["metadata"]["ocr_regions"].append(region("12.50", 300, 20, 85, 12))
        row = prepare_overlay_review(report, suggestions)["rows"][0]
        self.assertEqual(row["disposition"], "abstained")
        self.assertEqual(row["proposed_price_parts"], [])


if __name__ == "__main__":
    unittest.main()
