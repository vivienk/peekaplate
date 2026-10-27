import copy
import unittest

from peekaplate_processing.workflow import ExtractedDish, deduplicate_dishes, grounded_draft


def dish(name="Soup", **changes):
    return dict(page_number=1,name=name,description=None,category=None,subcategory=None,
                ingredients=None,price_amount=None,price_text=None,price_currency=None,**changes)


class MenuDuplicateTests(unittest.TestCase):
    def run_case(self,items,text,metadata=None,originals=None):
        before=copy.deepcopy(items)
        result,warnings=deduplicate_dishes(items,originals if originals is not None else items,
            {1:text,2:text},{1:metadata,2:metadata})
        self.assertEqual(items,before)
        return result,warnings

    def test_one_source_entry(self):
        first=dish("Soup");second=dish("SOUP")
        result,warnings=self.run_case([first,second],"SOUP\nBroth")
        self.assertEqual(len(result),1)
        self.assertTrue(warnings)
        self.assertTrue(any("duplicate" in w.lower() for w in result[0]["review_warnings"]))

    def test_unpriced_entry(self):
        result,_=self.run_case([dish(),dish()],"Soup\nSeasonal broth")
        self.assertEqual(len(result),1)
        self.assertIsNone(result[0]["price_amount"])

    def test_different_pages_and_variants(self):
        for second in [dict(dish(),page_number=2),dish("Soup with bread"),dish("Soup®")]:
            with self.subTest(second=second["name"]):
                result,_=self.run_case([dish(),second],"Soup\nSoup with bread\nSoup®")
                self.assertEqual(len(result),2)

    def test_distinct_source_entries(self):
        result,warnings=self.run_case([dish(),dish()],"Soup\nLunch portion\nSoup\nEvening portion")
        self.assertEqual(len(result),2)
        self.assertTrue(warnings)

    def test_conflicting_fields(self):
        for field,left,right in [("category","Lunch","Dinner"),("description","Red broth","Green broth"),
                                  ("price_amount","5","7"),("ingredients",["peas"],["beans"]),
                                  ("subcategory","Small plates","Main plates"),("price_currency","USD","CAD")]:
            with self.subTest(field=field):
                first=dish();first[field]=left
                second=dish();second[field]=right
                result,_=self.run_case([first,second],"Soup\nLunch Dinner Red broth Green broth")
                self.assertEqual(len(result),2)

    def test_conflict_cleared_by_grounding(self):
        first=dish();second=dish()
        originals=[dict(first,price_amount="5"),dict(second,price_amount="7")]
        result,_=self.run_case([first,second],"Soup\nBroth",originals=originals)
        self.assertEqual(len(result),2)

    def test_genuine_unpriced_entry_survives_grounding_and_dedup(self):
        for inline in [False,True]:
            with self.subTest(inline=inline):
                separator=" " if inline else "\n"
                text=f"Lunch\nSoup{separator}Seasonal vegetables\nDinner\nSoup\nSlow-cooked beef\n5"
                def box(label,x,y,width=100):
                    return dict(text=label,left=x,top=y,width=width,height=20)
                boxes=[box("Soup",20,60,40),box("Soup",520,160),box("5",820,160)]
                if inline:
                    boxes.append(box("Seasonal vegetables",65,60,170))
                metadata=dict(ocr_region_status="available",ocr_coordinate_space="uploaded_image_pixels",
                              upload_width=1000,upload_height=400,ocr_regions=boxes)
                originals=[dict(dish(),description="Seasonal vegetables"),dish()]
                items=[]
                for original in originals:
                    cleaned,warnings=grounded_draft(ExtractedDish(**original),text,dish_names=["Soup"],ocr_metadata=metadata)
                    items.append({**cleaned.model_dump(),"review_warnings":warnings})
                result,_=self.run_case(items,text,metadata=metadata,originals=originals)
                self.assertEqual(len(result),2)
                self.assertTrue(all(item["price_amount"] is None and item["price_text"] is None for item in result))
                self.assertEqual(result[0]["description"],"Seasonal vegetables")

    def test_same_line_columns_preserve_genuine_unpriced_entry(self):
        text="Soup Seasonal vegetables    Soup 5"
        def box(label,x,width):
            return dict(text=label,left=x,top=60,width=width,height=20)
        metadata=dict(ocr_region_status="available",ocr_coordinate_space="uploaded_image_pixels",
                      upload_width=1000,upload_height=400,
                      ocr_regions=[box("Soup",20,40),box("Seasonal vegetables",65,170),
                                   box("Soup",520,100),box("5",820,40)])
        originals=[dict(dish(),description="Seasonal vegetables"),dish()]
        for evidence in [metadata,None]:
            with self.subTest(layout=evidence is not None):
                items=[]
                for original in originals:
                    cleaned,warnings=grounded_draft(ExtractedDish(**original),text,dish_names=["Soup"],ocr_metadata=evidence)
                    items.append({**cleaned.model_dump(),"review_warnings":warnings})
                result,_=self.run_case(items,text,metadata=evidence,originals=originals)
                self.assertEqual(len(result),2)
                self.assertTrue(all(item["price_amount"] is None and item["price_text"] is None for item in result))
                self.assertEqual(result[0]["description"],"Seasonal vegetables")

    def test_caption_proof_only_excludes_the_actual_alt_span(self):
        text="![Soup](photo)\nSOUP\n5\nNotes    Soup seasonal vegetables"
        first=dish("Soup")
        second=dict(dish("SOUP"),price_amount="5")
        result,_=self.run_case([first,second],text)
        self.assertEqual(len(result),2)

    def test_null_original_does_not_bridge_conflicts(self):
        items=[dict(dish(),price_amount="5",price_text="5") for _ in range(3)]
        originals=[dict(dish(),price_amount=value) for value in ["5","7",None]]
        result,_=self.run_case(items,"Soup\n5",originals=originals)
        self.assertEqual(len(result),3)

    def test_do_not_combine_complementary_originals(self):
        first=dict(dish(),description="Red broth")
        second=dict(dish(),ingredients=["peas"])
        result,_=self.run_case([first,second],"Soup\nRed broth and peas")
        self.assertEqual(len(result),2)

    def test_sparse_caption_prefers_full_original(self):
        first=dict(dish(),review_warnings=["caption warning"])
        second=dict(dish("SOUP"),description="Broth",review_warnings=["entry warning"])
        result,_=self.run_case([first,second],"SOUP\nBroth")
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]["name"],"SOUP")
        self.assertEqual(result[0]["description"],"Broth")
        self.assertIn("caption warning",result[0]["review_warnings"])
        self.assertIn("entry warning",result[0]["review_warnings"])

    def test_invalid_layout_does_not_prove_same_entry(self):
        result,_=self.run_case([dish(),dish()],"Soup\nBroth",metadata={"ocr_region_status":"invalid"})
        self.assertEqual(len(result),2)


if __name__ == "__main__": unittest.main()
