"""Synthetic exact-region reconstruction; never private menu fixtures."""
import copy
import unittest

from peekaplate_processing.menu_layout import corroborate_box_price
from test_menu_layout import box, layout

UNKNOWN = (None, None, [])


class LayoutReconstructionTests(unittest.TestCase):
    def recover(self, regions, name="Garden Bowl", text="8.50", amount="8.50", names=()):
        metadata = layout(*regions)
        before = copy.deepcopy(metadata)
        result = corroborate_box_price(name, text, amount, metadata, dish_names=names)
        self.assertEqual(metadata, before)
        for record in result[2]:
            raw = regions[record["saved_region_index"]]
            self.assertEqual(record["text"], raw["text"])
            self.assertEqual(record["box"], {k: raw[k] for k in ("left", "top", "width", "height")})
        return result

    def test_wrapped_title_price_on_either_line_has_only_raw_price_evidence(self):
        for y in (20, 45):
            regions = [box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                       box(" 8.50 ", 220.25, y, 60)]
            with self.subTest(y=y):
                result = self.recover(regions)
                self.assertEqual(result[:2], (" 8.50 ", "8.50"))
                self.assertEqual([r["saved_region_index"] for r in result[2]], [2])

    def test_raw_unicode_competing_titles_keep_preexisting_exclusions(self):
        for title,other in (("İskender","ISKENDER"),("ISKENDER","İskender"),
                            ("Isparta","ısparta"),("ısparta","Isparta"),
                            ("Weißwurst","WEISSWURST")):
            with self.subTest(title=title,other=other):
                regions=[box(title,20,20,150),box("8.50",250,20,60),
                         box(other+" 9.50",20,150,220)]
                self.assertEqual(self.recover(regions,title),UNKNOWN)

    def test_raw_unicode_split_mentions_never_disappear_after_casefold(self):
        for title,first in (("İskender Soup","ISKENDER"),("ISKENDER Soup","İskender"),
                            ("Weißwurst Soup","WEISSWURST")):
            with self.subTest(title=title):
                regions=[box(title,20,20,200),box("8.50",300,20,60),
                         box(first,20,150,100),box("Soup 9.50",130,150,120)]
                self.assertEqual(self.recover(regions,title),UNKNOWN)

    def test_adjacent_title_does_not_merge_price_into_title(self):
        regions = [box("Garden", 20, 20, 70), box("Bowl", 96, 20, 45), box("8.50", 150, 20, 40)]
        self.assertEqual(self.recover(regions)[:2], ("8.50", "8.50"))
        self.assertEqual(self.recover(list(reversed(regions)))[:2], ("8.50", "8.50"))

    def test_separate_known_columns_bind_only_their_complete_groups(self):
        regions = [box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                   box("8.50", 220, 45, 60), box("Bean", 520, 20, 60),
                   box("Stew", 520, 45, 60), box("9.50", 820, 45, 60)]
        names = ("Garden Bowl", "Bean Stew")
        for name, price, index in [(names[0], "8.50", 2), (names[1], "9.50", 5)]:
            with self.subTest(name=name):
                result = self.recover(regions, name, price, price, names)
                self.assertEqual(result[:2], (price, price))
                self.assertEqual(result[2][0]["saved_region_index"], index)

    def test_other_wrapped_numeric_title_components_are_never_prices(self):
        for parts, name in [(("Bowl", "2"), "Bowl 2"), (("24/7", "Platter"), "24/7 Platter"),
                            (("Bowl", "2", "Special"), "Bowl 2 Special")]:
            regions = [box("Tea", 20, 45, 50)] + [box(p, 220, 20 + 25*i, 70) for i, p in enumerate(parts)]
            regions.append(box("90", 520, 45, 60))
            self.assertEqual(self.recover(regions, "Tea", "2 / 90", None, ("Tea", name)), UNKNOWN)

    def test_unresolved_other_numeric_title_still_excludes_all_components(self):
        regions = [box("Tea", 20, 55, 50), box("Bowl", 220, 20, 70),
                   box("or", 220, 42, 40, 5), box("2", 220, 55, 50)]
        self.assertEqual(self.recover(regions, "Tea", "2", "2", ("Tea", "Bowl 2")), UNKNOWN)

    def test_workflow_wrapped_recovery_keeps_canonical_numeric_conflicts_authoritative(self):
        from peekaplate_processing.workflow import ExtractedDish, grounded_draft
        dish = ExtractedDish(page_number=1, name="Garden Bowl", price_text="8.50", price_amount="8.50",
                             description=None, category=None, price_currency=None, ingredients=None)
        metadata = layout(box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50), box("8.50", 220, 45, 60))
        cleaned, _, evidence = grounded_draft(dish, "Garden Bowl", ocr_metadata=metadata, return_box_evidence=True)
        self.assertEqual((cleaned.price_text, cleaned.price_amount), ("8.50", "8.50"))
        self.assertEqual(evidence[0]["saved_region_index"], 2)
        for suffix in ("9.50", "−8.50", "8.50%", "8.50 kcal", "8.50 / 12.50"):
            cleaned, _, evidence = grounded_draft(dish, "Garden Bowl\n" + suffix,
                                                  ocr_metadata=metadata, return_box_evidence=True)
            self.assertIsNone(cleaned.price_text)
            self.assertIsNone(cleaned.price_amount)
            self.assertEqual(evidence, [])

    def test_duplicate_exact_or_wrapped_titles_abstain(self):
        base = [box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50), box("8.50", 220, 45, 60)]
        for extra in ([box("Garden Bowl", 520, 20, 150)],
                      [box("Garden", 520, 20, 80), box("Bowl", 520, 45, 50)]):
            self.assertEqual(self.recover(base + extra), UNKNOWN)

    def test_other_known_name_embedded_in_another_title_does_not_block_unrelated_row(self):
        regions = [box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50), box("8.50", 220, 45, 60),
                   box("Stew", 20, 100, 80), box("Bean Stew", 20, 150, 120)]
        self.assertEqual(self.recover(regions, names=("Garden Bowl", "Stew", "Bean Stew"))[:2], ("8.50", "8.50"))

    def test_shorter_known_name_inside_complete_target_region_is_not_a_conflict(self):
        regions = [box("Garden Bowl", 20, 20, 130), box("8.50", 220, 20, 60), box("Bowl", 20, 100, 80)]
        self.assertEqual(self.recover(regions, names=("Garden Bowl", "Bowl"))[:2], ("8.50", "8.50"))

    def test_wrapped_competing_phrase_with_description_still_abstains(self):
        regions = [box("Garden Bowl", 20, 20, 130), box("8.50", 220, 20, 60),
                   box("Garden", 520, 100, 80), box("Bowl deluxe", 520, 125, 120)]
        self.assertEqual(self.recover(regions), UNKNOWN)

    def test_intervening_words_cannot_be_skipped_to_reconstruct_title(self):
        for regions in ([box("Garden", 20, 20, 70), box("or", 94, 20, 10),
                         box("Bowl", 110, 20, 45), box("8.50", 220, 20, 60)],
                        [box("Garden", 20, 20, 80), box("or", 20, 42, 40, 5),
                         box("Bowl", 20, 55, 50), box("8.50", 220, 55, 60)]):
            self.assertEqual(self.recover(regions), UNKNOWN)

    def test_two_possible_wraps_abstain(self):
        self.assertEqual(self.recover([box("Garden", 20, 20, 80), box("Bowl", 20, 45, 40),
                                      box("Bowl", 65, 45, 40), box("8.50", 220, 45, 60)]), UNKNOWN)

    def test_unknown_column_or_intervening_label_is_not_guessed(self):
        for label in ("Bean Stew", "kcal", "％", "−"):
            self.assertEqual(self.recover([box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                                          box(label, 160, 45, 50), box("8.50", 320, 45, 60)]), UNKNOWN)

    def test_unknown_left_column_does_not_authorize_relaxing_row_guards(self):
        regions = [box("Unresolved label", 20, 45, 130), box("Garden", 520, 20, 80),
                   box("Bowl", 520, 45, 50), box("8.50", 820, 45, 60)]
        self.assertEqual(self.recover(regions), UNKNOWN)

    def test_heading_search_is_bounded_and_does_not_accept_aliases(self):
        words = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"]
        regions = [box(word, 20, 20 + 25*i, 80) for i, word in enumerate(words)]
        regions.append(box("8.50", 220, 220, 60))
        self.assertEqual(self.recover(regions, name=" ".join(words)), UNKNOWN)
        self.assertEqual(self.recover([box("Garden and Bowl", 20, 20, 150), box("8.50", 220, 20, 60)],
                                     name="Garden & Bowl"), UNKNOWN)

    def test_foreign_column_price_is_not_borrowed(self):
        self.assertEqual(self.recover([box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                                      box("Bean Stew", 520, 45, 150), box("8.50", 820, 45, 60)],
                                     names=("Garden Bowl", "Bean Stew")), UNKNOWN)

    def test_whole_group_must_agree_and_options_never_become_scalar(self):
        regions = [box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                   box("8.50", 220, 45, 60), box("12.50", 320, 45, 60)]
        for text, amount in [("8.50", "8.50"), ("8.50 13.50", None), ("8.50 12.50", "8.50")]:
            self.assertEqual(self.recover(regions, text=text, amount=amount), UNKNOWN)
        self.assertEqual(self.recover(regions, text="8.50 12.50", amount=None)[:2], ("8.50 / 12.50", None))

    def test_overlapping_clipped_and_tall_price_groups_abstain(self):
        base = [box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50)]
        for prices in ([box("8.50", 990, 45, 60)],
                       [box("8.50", 220, 45, 60), box("8.50", 230, 45, 60)],
                       [box("8.50", 220, 20, 60, 65), box("Bean Stew", 20, 75, 120)]):
            self.assertEqual(self.recover(base + prices), UNKNOWN)

    def test_price_groups_on_different_wrap_rows_abstain(self):
        self.assertEqual(self.recover([box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                                      box("8.50", 220, 20, 60), box("12.50", 320, 45, 60)],
                                     text="8.50 12.50", amount=None), UNKNOWN)

    def test_signed_unit_percent_unicode_and_partial_option_guards(self):
        for literal in ("-8.50", "+8.50", "−8.50", "８.５０", "8.50%", "8.50％", "8.50 kcal",
                        "8.50 /", "/ 8.50", "8.50 / -12.50"):
            self.assertEqual(self.recover([box("Garden", 20, 20, 80), box("Bowl", 20, 45, 50),
                                          box(literal, 220, 45, 160)]), UNKNOWN)


    def test_wrapped_heading_with_inline_price_on_second_line(self):
        from peekaplate_processing.workflow import ExtractedDish, grounded_draft
        dish = ExtractedDish(page_number=17, name="BACON RICE", price_text="195", price_amount="195",
                             description=None, category=None, price_currency=None, ingredients=None)
        metadata = layout(box("BACON", 20, 20, 80), box("RICE 195", 20, 45, 110))
        cleaned, warnings = grounded_draft(dish, "BACON\nRICE 195", dish_names=["BACON RICE"], ocr_metadata=metadata)
        self.assertEqual((cleaned.price_text, cleaned.price_amount), ("195", "195"))
        self.assertEqual(warnings, [])
        bad_meta = layout(box("BACON", 20, 20, 80), box("RICE 195 kcal", 20, 45, 150))
        cleaned_bad, _ = grounded_draft(dish, "BACON\nRICE 195 kcal", dish_names=["BACON RICE"], ocr_metadata=bad_meta)
        self.assertIsNone(cleaned_bad.price_text)
        self.assertIsNone(cleaned_bad.price_amount)

if __name__ == "__main__":
    unittest.main()
