import unittest
import json
from unittest.mock import patch

from peekaplate_processing.workflow import DishBatch, ExtractedDish, PageSection, grounded_draft, run_menu_graph
from peekaplate_processing.menu_context import apply_sections
from test_workflow import FakeLLM


class MenuContextTests(unittest.TestCase):

    def dish(self, **updates):
        values=dict(page_number=8, name="THE ORIGINAL GRAND SLAM", description=None,
                    category=None, price_amount=None, price_currency=None, ingredients=None)
        return ExtractedDish(**{**values, **updates})

    def test_category_heading(self):
        text="# SIGNATURE\n# SLAMS\nTHE ORIGINAL\nGRAND SLAM\n345 / 545"
        dish,warnings=grounded_draft(self.dish(category="SIGNATURE SLAMS"), text)
        self.assertEqual(dish.category, "SIGNATURE SLAMS")
        self.assertEqual(warnings, [])

    def test_subcategory_role(self):
        text="HOT BEVERAGES\nSINGLE-SERVE BREWED COFFEE 85"
        for subcategory in ["SINGLE-SERVE BREWED COFFEE", "single-serve  brewed coffee", "HOT BEVERAGES"]:
            with self.subTest(subcategory=subcategory):
                candidate=self.dish(name="SINGLE-SERVE BREWED COFFEE", category="HOT BEVERAGES", subcategory=subcategory, price_amount="85")
                dish,warnings=grounded_draft(candidate, text)
                self.assertIsNone(dish.subcategory)
                self.assertEqual(dish.category, "HOT BEVERAGES")
                self.assertEqual(dish.price_amount, "85")
                self.assertTrue(any("subcategory" in warning for warning in warnings))

    def test_subcategory_group(self):
        text="COLD BEVERAGES\nFRUIT JUICES\nFRESH LEMONADE 180"
        candidate=self.dish(name="FRESH LEMONADE", category="COLD BEVERAGES", subcategory="FRUIT JUICES", price_amount="180")
        dish,warnings=grounded_draft(candidate, text)
        self.assertEqual(dish.subcategory, "FRUIT JUICES")
        self.assertEqual(warnings, [])

    def test_inline_entry(self):
        text="Soup 8.50 CAD\nSteak 8.50 / 12.50 CAD"
        dish,warnings=grounded_draft(self.dish(name="Soup", price_amount="8.50"), text, dish_names=["Soup"])
        self.assertEqual(dish.price_amount, "8.50")
        self.assertIsNone(dish.price_text)
        self.assertEqual(warnings, [])

    def test_currency_price(self):
        for amount in ["350", "0.00"]:
            for separator in [" ", "\n"]:
                with self.subTest(amount=amount, separator=separator):
                    printed=f"PHP {amount}"
                    dish,warnings=grounded_draft(self.dish(name="Soup", price_amount=amount, price_text=printed), f"Soup{separator}{printed}")
                    self.assertEqual((dish.price_amount, dish.price_text), (amount, printed))
                    self.assertEqual(warnings, [])

    def test_price_calorie_slash(self):
        for prefix in ["$", "PHP ", "P"]:
            with self.subTest(prefix=prefix):
                printed=f"{prefix}8.50"
                source=f"Soup {printed} / 200 kcal"
                dish,warnings=grounded_draft(self.dish(name="Soup", price_amount="8.50", price_text=printed), source)
                self.assertEqual((dish.price_amount, dish.price_text), ("8.50", printed))
                self.assertEqual(warnings, [])
                dish,warnings=grounded_draft(self.dish(name="Soup", price_amount="200", price_text="200"), source)
                self.assertIsNone(dish.price_amount)
                self.assertIsNone(dish.price_text)

    def test_price_text_requires_complete_numeric_group(self):
        cases=[("95.50", "95"), ("95.50", "50"), ("1,095.50", "095.50"),
               (".95", "95"), ("-95", "95"), ("+95", "95"),
               ("-$95", "95"), ("−95", "95"), ("$75 / $95", "95"),
               ("75 / CAD 95", "75"), ("95 CAD / 120", "95"),
               ("75 / 95 / 120", "95"), ("75 / 95 / 120", "75 / 95"),
               ("75 / 95 / 120", "95 / 120"),
               ("8.50 / 12.50 / 15.50", "8.50 / 12.50"),
               ("8.50 / 12.50 / 15.50", "12.50 / 15.50"),
               ("75 / -95 / 120", "75"), ("75 / 95.50", "75 / 95"),
               ("75 / 1,095", "75 / 1"),
               ("$75 / 95 / 120 kcal", "$75 / 95")]
        for source, supplied in cases:
            with self.subTest(source=source, supplied=supplied):
                dish,warnings=grounded_draft(self.dish(name="Soup", price_text=supplied), f"Soup\n{source}")
                self.assertIsNone(dish.price_text)
                self.assertIsNone(dish.price_amount)
                self.assertTrue(any("price_text" in warning for warning in warnings))

    def test_complete_price_literals_and_immediate_units(self):
        for printed in ["0.00", "PHP0.00", "75  /  95 / 120", "CAD 95", "95 CAD"]:
            with self.subTest(printed=printed):
                dish,_=grounded_draft(self.dish(name="Soup", price_text=printed), f"Soup ({printed})")
                self.assertEqual(dish.price_text, printed)
        for printed in ["$8.50", "PHP0.00"]:
            for separator in [" /200kcal", " / 200 kcal"]:
                with self.subTest(printed=printed, separator=separator):
                    amount="0.00" if printed.startswith("PHP") else "8.50"
                    dish,warnings=grounded_draft(self.dish(name="Soup", price_text=printed, price_amount=amount),
                                              f"Soup\n{printed}{separator}")
                    self.assertEqual((dish.price_text, dish.price_amount), (printed, amount))
                    self.assertEqual(warnings, [])

    def test_price_options_many(self):
        text="Soup\n8.50 / 12.50 / 15.50 CAD"
        for amount in ["8.50", "12.50", "15.50"]:
            with self.subTest(amount=amount):
                dish,warnings=grounded_draft(self.dish(name="Soup", price_amount=amount), text)
                self.assertIsNone(dish.price_amount)
                self.assertEqual(dish.price_text, "8.50 / 12.50 / 15.50 CAD")
                self.assertTrue(any("Multiple" in warning for warning in warnings))
        printed="8.50 / 12.50 / 15.50 CAD"
        dish,warnings=grounded_draft(self.dish(name="Soup", price_text=printed), text)
        self.assertEqual(dish.price_text, printed)
        self.assertIsNone(dish.price_amount)

    def test_currency_marked_options_never_keep_a_scalar(self):
        for printed in ["$8.50 / $12.50", "PHP 8.50 / PHP 12.50"]:
            for supplied in [printed,None]:
                with self.subTest(printed=printed,supplied=supplied):
                    cleaned,warnings=grounded_draft(self.dish(name="Soup",price_amount="8.50",price_text=supplied),f"Soup\n{printed}")
                    self.assertEqual(cleaned.price_text,printed)
                    self.assertIsNone(cleaned.price_amount)
                    self.assertIsNone(cleaned.price_currency)
                    self.assertTrue(any("Multiple" in warning for warning in warnings))

    def test_review_iso_options_keep_full_literal_and_never_a_scalar(self):
        for printed in ["8.50 CAD / 12.50 CAD", "CAD 8.50 / CAD 12.50"]:
            for supplied in [printed,None]:
                with self.subTest(printed=printed,supplied=supplied):
                    candidate=self.dish(name="Soup",price_amount="8.50",price_text=supplied,price_currency="CAD")
                    cleaned,warnings=grounded_draft(candidate,f"Soup\n{printed}")
                    self.assertEqual(cleaned.price_text,printed)
                    self.assertIsNone(cleaned.price_amount)
                    self.assertEqual(cleaned.price_currency,"CAD")
                    self.assertTrue(any("Multiple" in warning for warning in warnings))

    def test_review_omitted_three_letter_heading_cannot_be_a_currency(self):
        from test_menu_layout import layout,box
        metadata=layout(box("Soup",20,20),box("TEA 95",520,20,200))
        cleaned,warnings=grounded_draft(self.dish(name="Soup"),"Soup\nTEA 95",dish_names=["Soup"],ocr_metadata=metadata)
        self.assertIsNone(cleaned.price_amount)
        self.assertIsNone(cleaned.price_text)
        self.assertTrue(any("ambiguous" in warning.lower() for warning in warnings))
        for printed in ["CAD 95","PHP 95"]:
            with self.subTest(printed=printed):
                cleaned,_=grounded_draft(self.dish(name="Soup"),f"Soup\n{printed}",dish_names=["Soup"],
                    ocr_metadata=layout(box("Soup",20,20),box(printed,520,20,200)))
                self.assertEqual((cleaned.price_text,cleaned.price_amount),(printed,"95"))
                self.assertIsNone(cleaned.price_currency)

    def test_review_compact_currency_prefixes_cannot_hide_remaining_options(self):
        from test_menu_layout import layout,box
        for printed in ["CAD8.50 / CAD12.50", "CAD8.50 / CAD12.50 / CAD15.50"]:
            for clipped in ["CAD8.50","CAD8.50 / CAD12.50"]:
                if clipped==printed:continue
                with self.subTest(printed=printed,clipped=clipped):
                    cleaned,_=grounded_draft(self.dish(name="Soup",price_amount="8.50",price_text=clipped),
                        f"Soup\n{printed}",ocr_metadata=layout(box("Soup",20,20),box(clipped,220,20,300)))
                    self.assertIsNone(cleaned.price_amount)
                    self.assertIsNone(cleaned.price_text)
            cleaned,warnings=grounded_draft(self.dish(name="Soup",price_amount="8.50",price_text=printed),f"Soup\n{printed}")
            self.assertEqual(cleaned.price_text,printed)
            self.assertIsNone(cleaned.price_amount)
            self.assertTrue(any("Multiple" in warning for warning in warnings))
        cleaned,_=grounded_draft(self.dish(name="Soup",price_amount="8.50"),"Soup\n8.50 / XYZ12.50")
        self.assertIsNone(cleaned.price_amount)
        self.assertIsNone(cleaned.price_text)

    def signed_neighbor_cases(self):
        for marker in ["CAD", "$"]:
            clipped=f"{marker}8.50"
            for sign in ["+", "-", "−"]:
                for first,second in [(sign,marker),(marker,sign)]:
                    for gap,number_gap in [("",""),(" ",""),(""," "),(" "," "),("\t","\t")]:
                        neighbor=f"{first}{gap}{second}{number_gap}12.50"
                        for printed in [f"{clipped} / {neighbor}",f"{neighbor} / {clipped}"]:
                            yield printed,clipped

    def test_signed_slash_neighbors_cannot_ground_or_recover_clipped_prices(self):
        from test_menu_layout import layout,box
        for printed,clipped in self.signed_neighbor_cases():
            metadata=layout(box("Soup",20,20),box(clipped,220,20,300))
            for overlay in [None,metadata]:
                for supplied in [None,clipped]:
                    with self.subTest(printed=printed,overlay=overlay is not None,supplied=supplied):
                        cleaned,_=grounded_draft(self.dish(name="Soup",price_amount="8.50",price_text=supplied),
                            f"Soup\n{printed}",ocr_metadata=overlay)
                        self.assertIsNone(cleaned.price_amount)
                        self.assertIsNone(cleaned.price_text)
                        self.assertIsNone(cleaned.price_currency)

    def test_directly_labelled_units_still_allow_a_separate_monetary_price(self):
        from test_menu_layout import layout,box
        for unit in ["kcal","calories","cal","cals","pc","pcs","piece","pieces",
                     "serving","servings","gram","grams","kg","g","ml","oz"]:
            for printed in ["CAD8.50","$8.50"]:
                for source in [f"{printed} / 200 {unit}",f"200 {unit} / {printed}",f"{unit}: 200 / {printed}"]:
                    with self.subTest(source=source):
                        for overlay in [None,layout(box("Soup",20,20),box(printed,220,20))]:
                            cleaned,_=grounded_draft(self.dish(name="Soup",price_amount="8.50",price_text=printed),
                                f"Soup\n{source}",ocr_metadata=overlay)
                            self.assertEqual((cleaned.price_text,cleaned.price_amount),(printed,"8.50"))
                            self.assertIsNone(cleaned.price_currency)

    def test_review_prices_remain_conservative_through_pipeline_export(self):
        import tempfile,copy
        from pathlib import Path
        from fixture_factory import make_pdf
        from peekaplate_processing.extract_menus import extract_source
        from peekaplate_processing.run_pipeline import run_pipeline
        from peekaplate_processing.review_candidates import prepare_review_candidates
        from test_menu_layout import layout,box
        cases=[("TEA 95",None,None,"TEA 95"),("8.50 CAD / 12.50 CAD","8.50 CAD / 12.50 CAD","8.50",None),
               ("CAD 8.50 / CAD 12.50",None,"8.50",None),
               ("CAD8.50 / CAD12.50","CAD8.50","8.50","CAD8.50"),
               ("CAD8.50 / CAD12.50 / CAD15.50","CAD8.50 / CAD12.50","8.50","CAD8.50 / CAD12.50")]
        cases.extend((printed,clipped,"8.50",clipped) for printed,clipped in self.signed_neighbor_cases())
        for printed,supplied,amount,overlay in cases:
            with self.subTest(printed=printed),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/"synthetic.pdf";source.write_bytes(make_pdf([{"text":f"Menu prices\nSoup\n{printed}\nsynthetic fixture context for review only".replace("−","-")}]))
                acquired=extract_source(source)
                if overlay is not None:
                    acquired.segments[0].method="ocr_space_engine3"
                    # Synthetic OCR, independent of the ASCII-only PDF fixture font.
                    acquired.segments[0].text=f"Menu prices\nSoup\n{printed}\nsynthetic fixture context for review only"
                    acquired.segments[0].metadata=layout(box("Soup",20,20),box(overlay,520,20,300))
                before=copy.deepcopy(acquired.segments[0])
                candidate=self.dish(page_number=1,name="Soup",price_amount=amount,price_text=supplied)
                from types import SimpleNamespace
                class CaseLLM(FakeLLM):
                    def invoke(self,messages):
                        return {"raw":SimpleNamespace(content=DishBatch(dishes=[candidate],sections=[]).model_dump_json(),response_metadata={"finish_reason":"stop"})}
                llm=CaseLLM()
                with patch("peekaplate_processing.run_pipeline.extract_source",return_value=acquired):
                    report=run_pipeline(source,root/"run",llm=llm,input_mode="ocr",llm_cache_dir=None)
                exported=prepare_review_candidates(report)
                self.assertEqual(len(exported.candidates),1)
                original=exported.candidates[0].original
                self.assertIsNone(original.price_amount)
                self.assertEqual(original.price_text,None if overlay is not None else printed)
                self.assertEqual(original.status,"needs_review")
                self.assertEqual(report.segments[0],before)
                span=report.evidence[0].spans[0]
                self.assertEqual(report.segments[0].text[span.start:span.end],original.source_text)

    def test_calorie_options(self):
        for source in ["Soup\nCalories: 200 / 300 / 400\n8.50 CAD", "Soup\n200 / 300 / 400 kcal\n8.50 CAD"]:
            for value in ["200", "300", "400", "200 / 300", "300 / 400"]:
                with self.subTest(source=source, value=value):
                    amount=value if "/" not in value else None
                    dish,warnings=grounded_draft(self.dish(name="Soup", price_text=value, price_amount=amount), source)
                    self.assertIsNone(dish.price_text)
                    self.assertIsNone(dish.price_amount)
                    self.assertTrue(any("price_text" in warning for warning in warnings))
            dish,warnings=grounded_draft(self.dish(name="Soup", price_amount="8.50", price_text="8.50 CAD"), source)
            self.assertEqual((dish.price_amount, dish.price_text), ("8.50", "8.50 CAD"))

    def test_flattened_repeated_entries_do_not_borrow_the_last_price(self):
        source="Soup Seasonal vegetables    Soup 5"
        candidate=self.dish(name="Soup",price_amount="5",price_text="5")
        cleaned,warnings=grounded_draft(candidate,source,dish_names=["Soup"])
        self.assertIsNone(cleaned.price_amount)
        self.assertIsNone(cleaned.price_text)
        self.assertTrue(any("ambiguous" in warning.lower() for warning in warnings))

    def test_wrong_dish_price(self):
        text="ALL-AMERICAN SLAM\nEggs and bacon\n395 / 595\nTHE ORIGINAL GRAND SLAM\nPancakes and eggs\n345 / 545"
        dish,warnings=grounded_draft(self.dish(price_amount="395"), text,
                                     dish_names=["ALL-AMERICAN SLAM", "THE ORIGINAL GRAND SLAM"])
        self.assertIsNone(dish.price_amount)
        self.assertTrue(any("price_amount" in warning for warning in warnings))

    def test_price_options(self):
        text="THE ORIGINAL GRAND SLAM\nPancakes and eggs\n345 / 545"
        dish,warnings=grounded_draft(self.dish(price_amount="345"), text)
        self.assertIsNone(dish.price_amount)
        self.assertEqual(dish.price_text, "345 / 545")
        self.assertTrue(any("Multiple" in warning for warning in warnings))

    def test_named_numbers(self):
        text="24/7 FEAST PLATTER\nEggs and pancakes\n1595"
        dish,warnings=grounded_draft(self.dish(name="24/7 FEAST PLATTER", price_amount="1595", price_text="1595"), text)
        self.assertEqual((dish.price_amount, dish.price_text), ("1595", "1595"))
        dish,warnings=grounded_draft(self.dish(name="24/7 FEAST PLATTER", price_amount="24", price_text="24/7"), text)
        self.assertIsNone(dish.price_amount)
        self.assertIsNone(dish.price_text)

    def test_caption_duplicate(self):
        text="![Garden Bowl](photo)\n\nGARDEN BOWL\nFresh greens\n95"
        def box(label,x,y):
            return dict(text=label,left=x,top=y,width=len(label)*6,height=10)
        metadata=dict(ocr_region_status="available",ocr_coordinate_space="uploaded_image_pixels",
                      upload_width=400,upload_height=400,
                      ocr_regions=[box("Garden Bowl",10,10),box("GARDEN BOWL",10,200),
                                   box("Fresh greens",10,220),box("95",250,200)])
        class Captions(FakeLLM):
            def invoke(client,messages):
                answer=super().invoke(messages)
                dishes=[self.dish(page_number=1,name="Garden Bowl"),
                        self.dish(page_number=1,name="GARDEN BOWL",description="Fresh greens")]
                answer["raw"].content=DishBatch(dishes=dishes,sections=[PageSection(page_number=1,category=None,continues_previous=False)]).model_dump_json()
                return answer
        client=Captions()
        with patch("peekaplate_processing.workflow.asyncio.sleep"):
            result=run_menu_graph(client,[{"page_number":1,"text":text,"ocr_metadata":metadata}],cache_dir=None)
        self.assertEqual(len(result["dishes"]),1)
        self.assertEqual(result["dishes"][0]["name"],"GARDEN BOWL")
        self.assertEqual(result["dishes"][0]["description"],"Fresh greens")
        self.assertEqual(result["dishes"][0]["price_amount"],"95")
        self.assertTrue(any("duplicate" in w.lower() for w in result["dishes"][0]["review_warnings"]))
        self.assertEqual(client.calls,[[{"page_number":1,"text":text}]])

    def test_layout_card(self):
        text="Soup\nSeasonal vegetables\n8.50 / 12.50\nCake\nFruit filling\n15"
        def box(label, x, y):
            return dict(text=label, left=x, top=y, width=len(label)*6, height=10)
        metadata=dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                      upload_width=300, upload_height=300,
                      ocr_regions=[box("Soup",10,10),box("Seasonal vegetables",10,30),box("8.50 / 12.50",10,50),
                                   box("Cake",10,100),box("Fruit filling",10,120),box("15",10,140)])
        for supplied in [None,"8.50 / 12.50"]:
            with self.subTest(supplied=supplied):
                dish,warnings=grounded_draft(self.dish(name="Soup", price_text=supplied),text,
                    dish_names=["Soup","Cake"],ocr_metadata=metadata)
                self.assertEqual(dish.price_text,"8.50 / 12.50")
                self.assertIsNone(dish.price_amount)
        metadata["ocr_regions"][-1].update(top=70)
        dish,warnings=grounded_draft(self.dish(name="Soup", price_text="8.50 / 12.50"),text,
            dish_names=["Soup","Cake"],ocr_metadata=metadata)
        self.assertIsNone(dish.price_text)


    def test_duplicate_alt_target_caption_does_not_block_entry_price(self):
        from peekaplate_processing.menu_context import single_source_entry
        text = "![Mex It Up Nachos](Mex It Up Nachos)\n## MEX IT UP NACHOS\nTortilla chips\n375 / 695"
        def box(label, x, y, width=None):
            return dict(text=label, left=x, top=y, width=width or len(label) * 6, height=12)
        metadata = dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                        upload_width=600, upload_height=400,
                        ocr_regions=[box("Mex It Up Nachos", 20, 20),
                                     box("## MEX IT UP NACHOS", 20, 180),
                                     box("Tortilla chips", 20, 205),
                                     box("375 / 695", 320, 180)])
        self.assertTrue(single_source_entry("MEX IT UP NACHOS", text))
        dish, warnings = grounded_draft(
            self.dish(page_number=14, name="MEX IT UP NACHOS", price_text="375 / 695"),
            text, dish_names=["MEX IT UP NACHOS"], ocr_metadata=metadata,
        )
        self.assertEqual(dish.price_text, "375 / 695")
        self.assertIsNone(dish.price_amount)
        self.assertTrue(any("Multiple" in w for w in warnings))
        non_matching = "![Soup](Soup seasonal vegetables)\nSOUP\n5"
        self.assertFalse(single_source_entry("SOUP", non_matching))
        competing_meta = dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                              upload_width=600, upload_height=400,
                              ocr_regions=[box("Soup", 20, 20),
                                           box("SOUP", 20, 180),
                                           box("5", 320, 180)])
        dish_competing, _ = grounded_draft(
            self.dish(page_number=1, name="SOUP", price_amount="5", price_text="5"),
            non_matching, dish_names=["SOUP"], ocr_metadata=competing_meta,
        )
        self.assertIsNone(dish_competing.price_amount)
        self.assertIsNone(dish_competing.price_text)

    def test_centered_card_price_and_lowercase_wrapped_description(self):
        text = (
            "### BISCOFF ICE CREAM CRÈME BRÛLÉE\n"
            "Biscoff ice cream, cotton\n"
            "candy\n"
            "295\n"
            "### CARROT CAKE\n"
            "Cream cheese frosting\n"
            "225"
        )
        def box(label, x, y, w, h=12):
            return dict(text=label, left=x, top=y, width=w, height=h)
        metadata = dict(
            ocr_region_status="available",
            ocr_coordinate_space="uploaded_image_pixels",
            upload_width=600,
            upload_height=400,
            ocr_regions=[
                box("BISCOFF ICE CREAM CRÈME BRÛLÉE", 100, 20, 240),
                box("Biscoff ice cream, cotton", 110, 40, 200),
                box("candy", 190, 56, 50),
                box("295", 195, 76, 40),
                box("CARROT CAKE", 140, 140, 160),
                box("Cream cheese frosting", 130, 160, 180),
                box("225", 195, 180, 40),
            ],
        )
        names = ["BISCOFF ICE CREAM CRÈME BRÛLÉE", "CARROT CAKE"]
        dish, warnings = grounded_draft(
            self.dish(page_number=31, name="BISCOFF ICE CREAM CRÈME BRÛLÉE", price_amount="295", price_text="295"),
            text, dish_names=names, ocr_metadata=metadata,
        )
        self.assertEqual((dish.price_text, dish.price_amount), ("295", "295"))
        self.assertEqual(warnings, [])
        metadata["ocr_regions"].append(box("225", 200, 96, 40))
        dish_ambiguous, _ = grounded_draft(
            self.dish(page_number=31, name="BISCOFF ICE CREAM CRÈME BRÛLÉE", price_amount="295", price_text="295"),
            text, dish_names=names, ocr_metadata=metadata,
        )
        self.assertIsNone(dish_ambiguous.price_text)
        self.assertIsNone(dish_ambiguous.price_amount)
    def test_detached_prices(self):
        for amount,printed in [("460","460"),(None,"375 / 695")]:
            with self.subTest(printed=printed):
                text="Soup\nSeasonal broth\n"+("460\n445" if amount else "375 / 695\n495 / 795")
                dish,warnings=grounded_draft(self.dish(name="Soup", price_amount=amount, price_text=printed), text)
                self.assertIsNone(dish.price_amount)
                self.assertIsNone(dish.price_text)
                self.assertTrue(any("ambiguous" in warning.lower() for warning in warnings))

    def test_beef_pares_445_is_not_the_neighbor_460(self):
        text="Other Dish\nRoasted vegetables\nBeef Pares\nBraised beef\n460\n445"
        def box(label,x):
            return dict(text=label,left=x,top=20,width=100,height=20)
        metadata=dict(ocr_region_status="available",ocr_coordinate_space="uploaded_image_pixels",
                      upload_width=1000,upload_height=300,
                      ocr_regions=[box("Other Dish",20),box("460",220),box("Beef Pares",520),box("445",820)])
        cleaned,warnings=grounded_draft(self.dish(name="Beef Pares",price_amount="460",price_text="460"),text,
            dish_names=["Other Dish","Beef Pares"],ocr_metadata=metadata)
        self.assertEqual((cleaned.price_amount,cleaned.price_text),("445","445"))
        self.assertTrue(any("recovered" in warning for warning in warnings))

    def test_pair_identity(self):
        text="Nachos\nTortilla chips\nWings\nSpicy chicken\n375 / 695\n495 / 795"
        def box(label, x, y):
            return dict(text=label, left=x, top=y, width=len(label)*6, height=10)
        metadata=dict(ocr_region_status="available", ocr_coordinate_space="uploaded_image_pixels",
                      upload_width=500, upload_height=100,
                      ocr_regions=[box("Nachos",10,10),box("375 / 695",400,10),box("Wings",10,40),box("495 / 795",400,40)])
        dish,warnings=grounded_draft(self.dish(name="Wings", price_text="495 / 795"), text, dish_names=["Nachos", "Wings"], ocr_metadata=metadata)
        self.assertEqual(dish.price_text, "495 / 795")
        self.assertIsNone(dish.price_amount)

    def test_unsupported_pair(self):
        dish,warnings=grounded_draft(self.dish(name="Wings", price_text="495 / 795"), "Wings\nSpicy chicken\n375 / 695")
        self.assertIsNone(dish.price_text)
        self.assertTrue(any("price_text" in warning for warning in warnings))

    def test_pair_ambiguity(self):
        dish,warnings=grounded_draft(self.dish(name="Wings", price_amount="495"), "Wings\nSpicy chicken\n375 / 695\n495 / 795")
        self.assertIsNone(dish.price_amount)
        self.assertIsNone(dish.price_text)

    def test_reject_calories(self):
        for label in ["200 kcal", "Calories: 200", "200 grams", "200 pieces"]:
            with self.subTest(label=label):
                dish,warnings=grounded_draft(self.dish(price_amount="200"), f"THE ORIGINAL GRAND SLAM\n{label}\n345")
                self.assertIsNone(dish.price_amount)
                self.assertTrue(any("price_amount" in warning for warning in warnings))
        dish,warnings=grounded_draft(self.dish(price_amount="200", price_text="200 / 300 kcal"), "THE ORIGINAL GRAND SLAM\n200 / 300 kcal\n345")
        self.assertIsNone(dish.price_amount)
        self.assertIsNone(dish.price_text)

    def test_price_with_calories(self):
        dish,warnings=grounded_draft(self.dish(price_amount="8.50"), "THE ORIGINAL GRAND SLAM $8.50 (200 kcal)")
        self.assertEqual(dish.price_amount, "8.50")

    def test_reject_portion_price(self):
        for unit in ["grams", "pieces", "servings"]:
            dish,warnings=grounded_draft(self.dish(price_text=f"200 {unit}"), f"THE ORIGINAL GRAND SLAM\n200 {unit}\n8.50 CAD")
            self.assertIsNone(dish.price_text)

    def test_price_source_units(self):
        for source in ["THE ORIGINAL GRAND SLAM\n200 grams\n8.50 CAD", "THE ORIGINAL GRAND SLAM $8.50 (200 kcal)"]:
            dish,warnings=grounded_draft(self.dish(price_text="200"), source)
            self.assertIsNone(dish.price_text)
            dish,warnings=grounded_draft(self.dish(price_text="8.50"), source)
            self.assertEqual(dish.price_text, "8.50")

    def test_missing_dish(self):
        dish,warnings=grounded_draft(self.dish(name="Soup", price_amount="25"), "Soup\nSeasonal vegetables\nSteak\n25 CAD", dish_names=["Soup"])
        self.assertIsNone(dish.price_amount)

    def test_repeated_name(self):
        text="ORANGE JUICE 165\nMANGO SLAY 195\nMango puree,\norange juice, lemon lime soda"
        dish,warnings=grounded_draft(self.dish(name="ORANGE JUICE", price_amount="165"), text, dish_names=["ORANGE JUICE", "MANGO SLAY"])
        self.assertEqual(dish.price_amount, "165")

    def test_mixed_categories(self):
        pages=[{"page_number":1,"text":"FOOD\nSoup\nDRINKS\nTea"}, {"page_number":2,"text":"Coffee"}]
        sections=[{"page_number":1,"category":"FOOD","continues_previous":False}, {"page_number":2,"category":None,"continues_previous":True}]
        dishes=[{"page_number":1,"category":"FOOD"}, {"page_number":1,"category":"DRINKS"}, {"page_number":2,"category":None}]
        apply_sections(dishes, sections, pages)
        self.assertIsNone(dishes[-1]["category"])

    def test_section_roots(self):
        pages=[{"page_number":1,"text":"FOOD\nSoup\nDRINKS\nTea"}, {"page_number":2,"text":"Coffee"}]
        sections=[{"page_number":1,"category":"FOOD","continues_previous":False}, {"page_number":2,"category":None,"continues_previous":True}]
        dishes=[{"page_number":1,"category":"DRINKS"}, {"page_number":1,"category":None}, {"page_number":2,"category":None}]
        warnings=apply_sections(dishes, sections, pages)
        self.assertEqual(dishes[0]["category"], "DRINKS")
        self.assertIsNone(dishes[1]["category"])
        self.assertIsNone(dishes[2]["category"])
        self.assertTrue(any("multiple" in warning for warning in warnings))

    def test_inherited_subgroup(self):
        pages=[{"page_number":1,"text":"DRINKS\nTea 5"}, {"page_number":2,"text":"DRINKS continued\nCoffee 6"}]
        sections=[{"page_number":1,"category":"DRINKS","continues_previous":False}, {"page_number":2,"category":None,"continues_previous":True}]
        clean,warnings=grounded_draft(self.dish(page_number=2, name="Coffee", subcategory=" drinks ", price_amount="6"), pages[1]["text"])
        dishes=[{**clean.model_dump(), "review_warnings":warnings}]
        apply_sections(dishes, sections, pages)
        self.assertEqual((dishes[0]["category"], dishes[0]["category_page_number"]), ("DRINKS", 1))
        self.assertIsNone(dishes[0]["subcategory"])
        self.assertTrue(any("Subcategory" in warning for warning in dishes[0]["review_warnings"]))

    def test_category_continuation(self):
        pages=[{"page_number":6, "text":"# COLD\n# BEVERAGES\n### FRUIT JUICES\nFRESH LEMONADE 180"},
               {"page_number":8, "text":"# SIGNATURE\n# SLAMS\nTHE ORIGINAL GRAND SLAM\n345 / 545"},
               {"page_number":9, "text":"LUMBERJACK SLAM\n495 / 695"}]
        class Sections(FakeLLM):
            def invoke(client, messages):
                answer=super(Sections, client).invoke(messages)
                dishes=[]
                sections=[]
                for page in json.loads(messages[1][1])["pages"]:
                    number=page["page_number"]
                    if number == 6:
                        dish=self.dish(page_number=6, name="FRESH LEMONADE", category="COLD BEVERAGES", subcategory="FRUIT JUICES", price_amount="180")
                    elif number == 8:
                        dish=self.dish(category="SIGNATURE SLAMS", price_text="345 / 545")
                    else:
                        dish=self.dish(page_number=9, name="LUMBERJACK SLAM", price_text="495 / 695")
                    dishes.append(dish)
                    sections.append(PageSection(page_number=number, category=dish.category, continues_previous=number == 9))
                answer["raw"].content=DishBatch(dishes=dishes, sections=sections).model_dump_json()
                return answer
        client=Sections()
        with patch("peekaplate_processing.workflow.asyncio.sleep"):
            result=run_menu_graph(client, pages, batch_pages=1, concurrency=2)
        self.assertEqual(result["errors"], [])
        lemonade,original,lumberjack=result["dishes"]
        self.assertEqual((lemonade["category"], lemonade["subcategory"]), ("COLD BEVERAGES", "FRUIT JUICES"))
        self.assertEqual(original["category"], "SIGNATURE SLAMS")
        self.assertEqual(lumberjack["category"], "SIGNATURE SLAMS")
        self.assertEqual(lumberjack["category_page_number"], 8)
        self.assertTrue(any("inherited" in warning for warning in lumberjack["review_warnings"]))
        self.assertEqual(len(client.calls), 3)

    def test_reset_category(self):
        for kind in ["gap", "failed", "new section", "uncertain"]:
            with self.subTest(kind=kind):
                pages=[{"page_number":1,"text":"SIGNATURE SLAMS\nFirst Slam"},
                       {"page_number":2,"text":"Continuation dish"},
                       {"page_number":3,"text":"Another dish"}]
                sections=[{"page_number":1,"category":"SIGNATURE SLAMS","continues_previous":False},
                          {"page_number":2,"category":None,"continues_previous":True},
                          {"page_number":3,"category":None,"continues_previous":True}]
                if kind == "gap": pages.pop(1)
                elif kind == "failed": pages[1]["text"]=""
                elif kind == "uncertain": sections[1]["continues_previous"]=False
                else:
                    pages[1]["text"]="COLD BEVERAGES\nNew dish"
                    sections[1]["category"]="COLD BEVERAGES"
                dishes=[{"page_number":3,"category":None}]
                apply_sections(dishes, sections, pages)
                self.assertEqual(dishes[0]["category"], "COLD BEVERAGES" if kind == "new section" else None)


if __name__ == "__main__": unittest.main()
