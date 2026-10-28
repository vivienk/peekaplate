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

    def test_split_and_wrapped_competing_titles_abstain(self):
        competing = [
            [region("Tomato", 10, 100, 70), region("Soup", 90, 100, 55)],
            [region("Tomato", 10, 100, 70), region("Soup", 10, 118, 55)],
            [region("Tomato", 10, 100, 70), region("Soup 9.50", 90, 100, 110)],
        ]
        for boxes in competing:
            report, suggestions = fixture(title="Tomato Soup")
            report["segments"][0]["metadata"]["ocr_regions"].extend(boxes)
            row = prepare_overlay_review(report, suggestions)["rows"][0]
            with self.subTest(boxes=boxes):
                self.assertEqual(row["disposition"], "abstained")
                self.assertEqual(row["reason"], "repeated_or_competing_title")
                self.assertEqual(row["proposed_price_parts"], [])

    def test_negative_title_run_search_is_bounded_without_broadening_recovery(self):
        report, suggestions = fixture(title="Tomato Soup")
        report["segments"][0]["metadata"]["ocr_regions"].extend([
            region("Tomato", 10, 100, 70), region("Soup", 350, 100, 55),
        ])
        self.assertEqual(prepare_overlay_review(report, suggestions)["rows"][0]["disposition"], "numeric_agreement")

        title = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota"
        report, suggestions = fixture(title=title)
        report["segments"][0]["metadata"]["ocr_regions"].extend([
            region(word, 10 + i * 30, 100, 25) for i, word in enumerate(title.split()[:8])
        ])
        self.assertEqual(prepare_overlay_review(report, suggestions)["rows"][0]["disposition"], "abstained")

        report, suggestions = fixture(title="Alpha Beta")
        report["segments"][0]["metadata"]["ocr_regions"].extend([
            region("Alpha", 10 + (i % 16) * 30, 100 + (i // 16) * 20, 25) for i in range(100)
        ])
        self.assertEqual(prepare_overlay_review(report, suggestions)["rows"][0]["disposition"], "abstained")

    def test_casefold_expanded_inline_competing_title_abstains(self):
        report, suggestions = fixture(title="Weißwurst")
        report["segments"][0]["metadata"]["ocr_regions"].append(region("WEISSWURST 9.50", 10, 100, 210))
        row = prepare_overlay_review(report, suggestions)["rows"][0]
        self.assertEqual(row["disposition"], "abstained")
        self.assertEqual(row["reason"], "repeated_or_competing_title")
        self.assertEqual(row["proposed_price_parts"], [])

    def test_raw_unicode_case_insensitive_competitors_are_not_lost(self):
        for title, inline in (("İskender", "ISKENDER"), ("ISKENDER", "İskender"),
                              ("Isparta", "ısparta"), ("ısparta", "Isparta")):
            report, suggestions = fixture(title=title)
            report["segments"][0]["metadata"]["ocr_regions"].append(region(inline + " 9.50", 10, 100, 210))
            row = prepare_overlay_review(report, suggestions)["rows"][0]
            with self.subTest(title=title, inline=inline):
                self.assertEqual(row["disposition"], "abstained")
                self.assertEqual(row["reason"], "repeated_or_competing_title")

    def test_raw_and_casefold_split_competitors_use_both_semantics(self):
        for title, first, last in (("İskender Soup", "ISKENDER", "Soup"),
                                   ("ISKENDER Soup", "İskender", "Soup"),
                                   ("Weißwurst Soup", "WEISSWURST", "Soup")):
            report, suggestions = fixture(title=title)
            report["segments"][0]["metadata"]["ocr_regions"].extend([
                region(first, 10, 100, 90), region(last + " 9.50", 110, 100, 120),
            ])
            row = prepare_overlay_review(report, suggestions)["rows"][0]
            with self.subTest(title=title, first=first):
                self.assertEqual(row["disposition"], "abstained")
                self.assertEqual(row["reason"], "repeated_or_competing_title")

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
