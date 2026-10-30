"""Synthetic geometry only: no menu fixtures or provider calls."""
import copy
import math
import unittest

from peekaplate_processing.menu_layout import entry_price


def box(text, left, top, width=100, height=20):
    return dict(text=text, left=left, top=top, width=width, height=height)


def layout(*regions):
    return dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                upload_width=1000, upload_height=1000, ocr_regions=list(regions))


UNKNOWN = dict(price_text=None, anchor=None, label=None)


class MenuLayoutTests(unittest.TestCase):
    def assert_price(self, name, text, metadata, price, label=None):
        before = copy.deepcopy(metadata)
        result = entry_price(name, text, metadata)
        self.assertEqual(result["price_text"], price)
        self.assertEqual(result["label"], label or name)
        self.assertIsInstance(result["anchor"], tuple)
        self.assertEqual(len(result["anchor"]), 4)
        self.assertTrue(all(type(n) in (int, float) and math.isfinite(n) for n in result["anchor"]))
        self.assertEqual(metadata, before)
        self.assertIn(price, text)
        return result

    def test_detached_two_column_text_order_does_not_bind_neighbors(self):
        text = "Garden Bowl\nBean Stew\n210\n75 / 95 / 120"
        meta = layout(box("Garden Bowl", 20, 20), box("Bean Stew", 520, 20),
                      box("210", 820, 20, 60), box("75 / 95 / 120", 220, 20, 160))
        self.assert_price("Garden Bowl", text, meta, "75 / 95 / 120")
        self.assert_price("Bean Stew", text, meta, "210")
        self.assertNotEqual(entry_price("Garden Bowl", text, meta)["anchor"],
                            entry_price("Bean Stew", text, meta)["anchor"])

    def test_unknown_recovers_scalar_and_zero_without_inferred_currency(self):
        for value in ("0", "42.50", "PHP 42", "₱0"):
            with self.subTest(value=value):
                self.assert_price("Garden Bowl", f"{value}\nGarden Bowl",
                                  layout(box("Garden Bowl", 20, 20), box(value, 220, 20)), value)

    def test_inline_source_heading_is_not_stripped_as_currency(self):
        self.assert_price("Garden Bowl", "Garden Bowl 95",
            layout(box("Garden Bowl",20,20),box("95",220,20)), "95")

    def test_literal_slash_spacing_is_not_rewritten(self):
        self.assert_price("Garden Bowl", "Garden Bowl\n75  /  95 / 120",
                          layout(box("Garden Bowl", 20, 20), box("75", 220, 20, 25),
                                 box("/", 250, 20, 8), box("95", 262, 20, 25),
                                 box("/", 290, 20, 8), box("120", 302, 20, 35)),
                          "75  /  95 / 120")

    def test_source_heading_markup_cannot_become_a_price_separator(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n75 /\n# 95",
            layout(box("Garden Bowl", 20, 20), box("75", 220, 20, 25),
                   box("/", 250, 20, 8), box("95", 262, 20, 25))), UNKNOWN)

    def test_no_invented_slash_or_joined_price(self):
        meta = layout(box("Garden Bowl", 20, 20), box("75", 220, 20, 30),
                      box("95", 255, 20, 30))
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n75\n95", meta), UNKNOWN)

    def test_overlapping_inline_price_is_unknown(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl 95\n120",
            layout(box("Garden Bowl 95",20,20,250),box("120",100,20,40))), UNKNOWN)

    def test_inline_line_and_number_in_name(self):
        self.assert_price("Bowl 2 / 3", "Bowl 2 / 3  90",
                          layout(box("Bowl 2 / 3  90", 20, 20, 250)), "90")
        self.assertEqual(entry_price("Bowl 2 / 3", "Bowl 2 / 3",
                                    layout(box("Bowl 2 / 3", 20, 20))), UNKNOWN)

    def test_split_words_and_wrapped_heading_keep_full_label(self):
        text = "# Garden\nBowl\n95"
        self.assert_price("Garden Bowl", text,
                          layout(box("Garden", 20, 20, 80), box("Bowl", 20, 45, 55),
                                 box("95", 220, 45)), "95", "Garden Bowl")
        text = "Garden Bowl\n95"
        a = self.assert_price("Garden Bowl", text,
                              layout(box("Garden", 20, 20, 70), box("Bowl", 96, 20, 45),
                                     box("95", 220, 20)), "95")
        b = entry_price("Garden Bowl", text, layout(box("95", 220, 20),
                        box("Bowl", 96, 20, 45), box("Garden", 20, 20, 70)))
        self.assertEqual(a, b)

    def test_wrapped_heading_ignores_description_as_next_word(self):
        text="Garden\nBowl\n95\nFresh greens"
        self.assert_price("Garden Bowl", text,
            layout(box("Garden",20,20,80),box("Bowl",45,45,60),box("95",220,20),box("Fresh greens",20,65)),
            "95", "Garden Bowl")

    def test_unrelated_overlapping_captions_do_not_invalidate_entry(self):
        self.assert_price("Garden Bowl", "Garden Bowl\n95",
            layout(box("Garden Bowl",20,400),box("95",220,400),
                   box("Image label",20,20),box("Another label",30,25)),"95")

    def test_explicit_currency_text(self):
        for printed in ["95 CAD","CAD 95","PHP 95"]:
            with self.subTest(printed=printed):
                self.assert_price("Garden Bowl",f"Garden Bowl\n{printed}",
                    layout(box("Garden Bowl",20,20),box(printed,220,20)),printed)

    def test_label_preserves_physical_heading_case_and_wrapping(self):
        self.assert_price("the garden bowl", "The Garden\nBOWL\n95",
            layout(box("The Garden", 20, 20), box("BOWL", 20, 45), box("95", 220, 45)),
            "95", "The Garden BOWL")

    def test_caption_is_not_preferred_over_priced_entry(self):
        for caption_top in (10, 200):
            with self.subTest(caption_top=caption_top):
                meta = layout(box("Garden Bowl", 20, caption_top), box("GARDEN BOWL", 520, 80),
                              box("95", 820, 80))
                result = self.assert_price("Garden Bowl", "![Garden Bowl](photo)\nGARDEN BOWL\n95", meta, "95", "GARDEN BOWL")
                self.assertEqual(result["anchor"][:2], (520, 80))

    def test_indistinguishable_image_caption_stays_ambiguous(self):
        self.assertEqual(entry_price("Garden Bowl","![Garden Bowl](photo)\nGarden Bowl\n95",
            layout(box("Garden Bowl",20,20),box("Garden Bowl",520,80),box("95",820,80))),UNKNOWN)

    def test_unpriced_repeated_entry_is_not_a_proven_caption(self):
        text="Lunch\nGarden Bowl\nSeasonal greens\nDinner\nGarden Bowl\nRoasted beans\n95"
        meta=layout(box("Garden Bowl",20,40),box("Garden Bowl",520,140),box("95",820,140))
        self.assertEqual(entry_price("Garden Bowl",text,meta),UNKNOWN)

    def test_another_heading_is_not_a_currency_price(self):
        for heading in ["Tea 95","TEA 95"]:
            with self.subTest(heading=heading):
                meta=layout(box("Soup",20,20),box(heading,520,20,200))
                self.assertEqual(entry_price("Soup",f"Soup\n{heading}",meta,dish_names=["Soup","Tea"]),UNKNOWN)

    def test_wrapped_number_in_other_name_is_not_a_price(self):
        for name in ["Bowl 2","24/7 Platter"]:
            with self.subTest(name=name):
                first,last=name.split()
                meta=layout(box("Tea",20,45 if last.isdigit() else 20),box(first,220,20),box(last,220,45),box("90",520,45))
                self.assertEqual(entry_price("Tea",f"Tea\n{name}\n90",meta,dish_names=["Tea",name]),UNKNOWN)

    def test_two_priced_occurrences_are_ambiguous_even_when_equal(self):
        for second in ("95", "120"):
            with self.subTest(second=second):
                meta = layout(box("Garden Bowl", 20, 20), box("95", 220, 20),
                              box("Garden Bowl", 20, 80), box(second, 220, 80))
                self.assertEqual(entry_price("Garden Bowl", f"Garden Bowl\n95\nGarden Bowl\n{second}", meta), UNKNOWN)

    def test_foreign_column_label_blocks_price_borrowing(self):
        text = "Garden Bowl\nBean Stew\n210"
        meta = layout(box("Garden Bowl", 20, 20), box("Bean Stew", 520, 20), box("210", 820, 20))
        self.assertEqual(entry_price("Garden Bowl", text, meta), UNKNOWN)
        self.assert_price("Bean Stew", text, meta, "210")

    def test_description_mentions_and_trailing_commas_are_not_entries(self):
        for heading in ("Try our Garden Bowl", "Garden Bowl, bright greens", "Garden Bowl,", "Garden Bowl with greens"):
            with self.subTest(heading=heading):
                self.assertEqual(entry_price("Garden Bowl", f"{heading}\n95",
                    layout(box(heading, 20, 20, 250), box("95", 420, 20))), UNKNOWN)

    def test_split_description_words_cannot_turn_into_heading(self):
        for text in ("Try our Garden Bowl\n95", "Garden Bowl, bright greens\n95"):
            with self.subTest(text=text):
                self.assertEqual(entry_price("Garden Bowl", text,
                    layout(box("Garden", 20, 20, 70), box("Bowl", 96, 20, 45),
                           box("95", 220, 20))), UNKNOWN)

    def test_digit_present_only_inside_name_cannot_be_reused_as_price(self):
        self.assertEqual(entry_price("Bowl 2", "Bowl 2",
            layout(box("Bowl 2", 20, 20), box("2", 220, 20))), UNKNOWN)

    def test_tall_price_box_spanning_two_heading_rows_is_unknown(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\nBean Stew\n95",
            layout(box("Garden Bowl", 20, 20), box("Bean Stew", 20, 60),
                   box("95", 220, 20, 60, 70))), UNKNOWN)

    def test_detached_vertical_option_rows_are_unknown(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n75 / 95",
            layout(box("Garden Bowl", 20, 20), box("75 / 95", 220, 60))), UNKNOWN)

    def test_price_must_be_to_right_not_left(self):
        self.assertEqual(entry_price("Garden Bowl", "95\nGarden Bowl",
            layout(box("Garden Bowl", 220, 20), box("95", 20, 20))), UNKNOWN)

    def test_competing_prices_and_overlapping_rows_are_unknown(self):
        for y in (20, 28, 32):
            with self.subTest(y=y):
                meta = layout(box("Garden Bowl", 20, 20), box("95", 220, 20), box("120", 225, y))
                self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n95\n120", meta), UNKNOWN)
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n95\n120",
            layout(box("Garden Bowl", 20, 20), box("95", 220, 20), box("120", 420, 20))), UNKNOWN)

    def test_units_cannot_become_prices(self):
        for value in ("100 kcal", "100 / 200 kcal", "2 pcs", "250 ml", "grams 100", "100 g", "cal: 100 / 200"):
            with self.subTest(value=value):
                self.assertEqual(entry_price("Garden Bowl", f"Garden Bowl\n{value}",
                    layout(box("Garden Bowl", 20, 20), box(value, 220, 20, 180))), UNKNOWN)
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n100 kcal",
            layout(box("Garden Bowl", 20, 20), box("100", 220, 20, 30), box("kcal", 254, 20, 40))), UNKNOWN)

    def test_detached_source_order_does_not_hide_adjacent_geometry_units(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n100\nkcal",
            layout(box("Garden Bowl", 20, 20), box("100", 220, 20, 30),
                   box("kcal", 300, 20, 40))), UNKNOWN)

    def test_separate_explicit_money_and_calories(self):
        self.assert_price("Garden Bowl", "Garden Bowl\nPHP 95\n250 kcal",
            layout(box("Garden Bowl", 20, 20), box("PHP 95", 220, 20), box("250 kcal", 520, 20)), "PHP 95")

    def test_missing_or_unavailable_layout_is_legacy_signal(self):
        for meta in (None, {}, {"ocr_provider": "synthetic", "ocr_cache_hit": True},
                     {"ocr_region_status": "unavailable"},
                     {"ocr_region_status": "unavailable", "ocr_regions": []}):
            with self.subTest(meta=meta):
                self.assertIsNone(entry_price("Garden Bowl", "Garden Bowl 95", meta))

    def test_available_but_missing_or_invalid_layout_never_falls_back(self):
        valid = layout(box("Garden Bowl", 20, 20), box("95", 220, 20))
        changes = ({"ocr_regions": []}, {"ocr_regions": None}, {"ocr_region_status": "invalid"},
                   {"ocr_coordinate_space": "source_pixels"}, {"upload_width": True},
                   {"upload_height": float("nan")}, {"upload_height": 0}, {"upload_width": "1000"},
                   {"upload_width": 10 ** 1000})
        for change in changes:
            with self.subTest(change=change):
                self.assertEqual(entry_price("Garden Bowl", "Garden Bowl 95", valid | change), UNKNOWN)
        for key in ("ocr_regions", "upload_height", "ocr_coordinate_space"):
            meta = valid.copy()
            del meta[key]
            self.assertEqual(entry_price("Garden Bowl", "Garden Bowl 95", meta), UNKNOWN)
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl 95", {"ocr_region_status": "available"}), UNKNOWN)

    def test_invalid_regions_fail_closed_including_unrelated_region(self):
        for change in ({"left": True}, {"left": float("nan")}, {"top": -1}, {"height": 0},
                       {"width": float("inf")}, {"left": 990}, {"text": "not in source"},
                       {"width": "100"}, {"text": ""}, {"text": "95\x00"}):
            with self.subTest(change=change):
                meta = layout(box("Garden Bowl", 20, 20), box("95", 220, 20) | change)
                self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n95", meta), UNKNOWN)
        self.assert_price("Garden Bowl", "Garden Bowl\n95",
            layout(box("Garden Bowl", 20, 20), box("95", 220, 20), box("Unlisted Brand", 500, 400)), "95")
        self.assertEqual(entry_price("Unlisted Brand", "Garden Bowl\n95",
            layout(box("Garden Bowl", 20, 20), box("95", 220, 20), box("Unlisted Brand", 500, 400))), UNKNOWN)

    def test_source_mismatch_and_substring_digits_are_not_evidence(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n950",
            layout(box("Garden Bowl", 20, 20), box("95", 220, 20))), UNKNOWN)
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n95",
            layout(box("Other Bowl", 20, 20), box("95", 220, 20))), UNKNOWN)

    def test_partial_source_numeric_group_is_not_overlay_evidence(self):
        cases=[("95.50", "95"), ("95.50", "50"), ("1,095.50", "095.50"),
               (".95", "95"), ("-95", "95"), ("+95", "95"),
               ("-$95", "95"), ("−95", "95"), ("$75 / $95", "95"),
               ("75 / CAD 95", "75"), ("95 CAD / 120", "95"),
               ("75 / 95 / 120", "95"), ("75 / 95 / 120", "75 / 95"),
               ("75 / 95 / 120", "95 / 120"), ("75 / -95 / 120", "75"),
               ("75 / 95.50", "75 / 95"), ("75 / 1,095", "75 / 1")]
        for source, overlay in cases:
            with self.subTest(source=source, overlay=overlay):
                metadata=layout(box("Soup",20,20),box(overlay,220,20,180))
                before=copy.deepcopy(metadata)
                self.assertEqual(entry_price("Soup", f"Soup\n{source}", metadata), UNKNOWN)
                self.assertEqual(metadata, before)

    def test_complete_money_literal_beside_immediate_calorie_unit(self):
        for printed in ["$8.50", "PHP0.00"]:
            with self.subTest(printed=printed):
                self.assert_price("Soup", f"Soup\n{printed} /200kcal",
                    layout(box("Soup",20,20),box(printed,220,20)), printed)

    def test_bounded_layout_and_price_length(self):
        self.assertEqual(entry_price("Garden Bowl", "Garden Bowl\n95",
            layout(*[box("95", 20, 20)] * 10001)), UNKNOWN)
        long_price = " / ".join(["123"] * 50)
        self.assertEqual(entry_price("Garden Bowl", f"Garden Bowl\n{long_price}",
            layout(box("Garden Bowl", 20, 20), box(long_price, 220, 20, 700))), UNKNOWN)

    def test_corroborate_box_price_recovers_multi_column_price(self):
        from peekaplate_processing.menu_layout import corroborate_box_price
        # Dish title on left, prices on right in separate OCR boxes (e.g. multi-column layout)
        metadata = layout(
            box("PLAIN CHEESE", 50, 100, 200, 30),
            box("6.00", 600, 100, 70, 30),
            box("33.00", 700, 100, 70, 30),
            box("FRESH MOZZARELLA", 50, 200, 250, 30),
            box("7.00", 600, 200, 70, 30),
            box("37.00", 700, 200, 70, 30),
        )
        # PLAIN CHEESE dish text lacks the price tokens
        price_text, price_amount, boxes = corroborate_box_price("PLAIN CHEESE", "6.00 33.00", None, metadata)
        self.assertEqual(price_text, "6.00 / 33.00")
        self.assertIsNone(price_amount)
        self.assertEqual(len(boxes), 2)
        self.assertEqual(boxes[0]["text"], "6.00")
        self.assertEqual(boxes[1]["text"], "33.00")

    def test_corroborate_box_price_single_amount(self):
        from peekaplate_processing.menu_layout import corroborate_box_price
        metadata = layout(
            box("WATER", 50, 800, 100, 20),
            box("3.50", 800, 800, 60, 20),
        )
        price_text, price_amount, boxes = corroborate_box_price("WATER", "3.50", "3.50", metadata)
        self.assertEqual(price_text, "3.50")
        self.assertEqual(price_amount, "3.50")
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["text"], "3.50")

    def test_corroborate_box_price_abstains_on_competing_titles(self):
        from peekaplate_processing.menu_layout import corroborate_box_price
        # Two titles at same vertical level with price in between
        metadata = layout(
            box("CHEESE SLICE", 50, 100, 150, 30),
            box("PEPPERONI SLICE", 250, 100, 150, 30),
            box("6.00", 500, 100, 80, 30),
        )
        # Should abstain due to competing title PEPPERONI SLICE between CHEESE SLICE and price
        price_text, price_amount, boxes = corroborate_box_price(
            "CHEESE SLICE", "6.00", "6.00", metadata, dish_names=("CHEESE SLICE", "PEPPERONI SLICE")
        )
        self.assertIsNone(price_text)
        self.assertIsNone(price_amount)
        self.assertEqual(boxes, [])

    def test_corroborate_box_price_abstains_on_number_mismatch(self):
        from peekaplate_processing.menu_layout import corroborate_box_price
        metadata = layout(
            box("PLAIN CHEESE", 50, 100, 200, 30),
            box("6.00", 600, 100, 70, 30),
            box("33.00", 700, 100, 70, 30),
        )
        # Vision suggestion says 6.00 35.00 but OCR boxes have 6.00 33.00
        price_text, price_amount, boxes = corroborate_box_price("PLAIN CHEESE", "6.00 35.00", None, metadata)
        self.assertIsNone(price_text)
        self.assertIsNone(price_amount)
        self.assertEqual(boxes, [])


if __name__ == "__main__":
    unittest.main()
