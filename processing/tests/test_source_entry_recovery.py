"""Literal name/contact-boundary recovery, never model aliases or price guesses."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.workflow import grounded_draft
from peekaplate_processing.review_suggestions import suggestion_record
from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.review_candidates import export_review_candidates
from peekaplate_processing.schemas import SourceSegment
from peekaplate_processing.vision import image_source
from test_box_grounding_safety import dish
from test_input_modes import RecordingLLM, photo
from test_menu_layout import box, layout


class SourceEntryRecoveryTests(unittest.TestCase):
    def test_only_source_verified_trailing_trademarks_are_removed(self):
        for name in ('Soup®','Soup™','Soup ®™'):
            with self.subTest(name=name):
                raw=dish(name=name)
                before=raw.model_dump()
                cleaned,warnings=grounded_draft(raw,'Soup 8.50')
                self.assertEqual(cleaned.name,'Soup')
                self.assertEqual(cleaned.price_amount,'8.50')
                self.assertTrue(any('trademark' in warning.lower() for warning in warnings))
                self.assertEqual(raw.model_dump(),before)
        for name in ('Soup®','Soup™'):
            cleaned,_=grounded_draft(dish(name=name),f'{name} 8.50')
            self.assertEqual(cleaned.name,name)

    def test_source_present_spaced_markers_are_not_claimed_model_only(self):
        for source in ('Soup ™ 8.50','Soup ® 8.50','Soup\t® 8.50','Soup\n™ 8.50',
                       'Soup ®\nSoup 8.50'):
            marker='™' if '™' in source else '®'
            with self.subTest(source=source),self.assertRaises(ExtractionError):
                grounded_draft(dish(name='Soup'+marker),source)

    def test_name_handling_is_not_fuzzy_or_semantic_repair(self):
        for name in ('Soup Deluxe®','Soups®','S®oup','Soup® Special','Snappe®'):
            with self.subTest(name=name),self.assertRaises(ExtractionError):
                grounded_draft(dish(name=name),'Soup 8.50\nSnapple 3.50')

    def test_other_normalized_entry_names_still_bound_prices(self):
        cleaned,_=grounded_draft(dish(name='Soup®',price_amount='9.50',price_text='9.50'),
            'Soup\nTea 9.50',dish_names=('Soup®','Tea™'))
        self.assertEqual(cleaned.name,'Soup')
        self.assertIsNone(cleaned.price_amount)
        self.assertIsNone(cleaned.price_text)

    def test_private_name_replacement_preserves_original_and_reason(self):
        raw=dish(name='Soup®')
        cleaned,warnings=grounded_draft(raw,'Soup 8.50')
        record=suggestion_record(raw,1,1,{'page_number':1,'text':'Soup 8.50'},cleaned=cleaned,warnings=warnings)
        decision=next(value for value in record['decisions'] if value['field']=='name')
        self.assertEqual(record['original']['name'],'Soup®')
        self.assertEqual(record['status'],'unvalidated')
        self.assertEqual(decision['disposition'],'replaced_by_source_text')
        self.assertEqual(decision['grounded_value'],'Soup')

    def test_terminal_structured_contact_footer_does_not_block_missing_price(self):
        metadata=layout(box('Soup',20,20),box('8.50',220,20))
        before=copy.deepcopy(metadata)
        for footer in ('\n\n## 212-555-0123','\nPhone: (212) 555-0123',
                       '\n\n# Contact: +1 212-555-0123\n'):
            with self.subTest(footer=footer):
                cleaned,_,records=grounded_draft(dish(),'Soup'+footer,ocr_metadata=metadata,return_box_evidence=True)
                self.assertEqual(cleaned.price_amount,'8.50')
                self.assertEqual(cleaned.price_text,'8.50')
                self.assertEqual(records[0]['text'],'8.50')
        self.assertEqual(metadata,before)

    def test_footer_rule_never_hides_menu_conflicts_or_generic_numeric_headings(self):
        metadata=layout(box('Soup',20,20),box('8.50',220,20))
        texts=['Soup\nPRICE\n8.50 / 12.50\n\n## 212-555-0123',
               'Soup\n-8.50\n\n## 212-555-0123',
               'Soup\n9.50\n\n## 212-555-0123',
               'Soup\n8.50 kcal\nPhone: 212-555-0123',
               'Soup\n\n## 212-555-0123\n9.50',
               'Soup\n\n## 8.50 / 12.50',
               'Soup\n212-555-0123',
               'Soup\nPhone: 8.50 / 12.50',
               'Soup\n\n## 212-555-0123\nSoup']
        for text in texts:
            with self.subTest(text=text):
                cleaned,_,records=grounded_draft(dish(),text,ocr_metadata=metadata,return_box_evidence=True)
                self.assertIsNone(cleaned.price_amount)
                self.assertIsNone(cleaned.price_text)
                self.assertEqual(records,[])

    def test_valid_entry_geometry_is_not_replaced_by_a_lateral_section_label(self):
        text='# MAIN\nOther with Soup\n## SIDES\nSoup\n8.50\nToast\n6.50'
        metadata=layout(box('MAIN',20,0,80,10),box('SIDES',20,20,100,60),
            box('Soup',200,40,80),box('8.50',400,40,60),
            box('Toast',200,100,80),box('6.50',400,100,60))
        cleaned,_=grounded_draft(dish(category='SIDES'),text,dish_names=('Soup','Toast'),
            section_names=('MAIN','SIDES'),ocr_metadata=metadata)
        self.assertEqual(cleaned.price_text,'8.50')
        self.assertEqual(cleaned.price_amount,'8.50')

    def test_repeated_names_require_unique_explicit_text_and_geometry_section(self):
        metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
                        box('LUNCH',450,20,100),box('Soup',450,60,60),box('9.50',650,60,60))
        text='# BREAKFAST\nSoup\n# LUNCH\nSoup'
        before=copy.deepcopy(metadata)
        for category,price,index in [('BREAKFAST','8.50',2),('LUNCH','9.50',5)]:
            with self.subTest(category=category):
                cleaned,warnings,records=grounded_draft(dish(category=category,price_text=price,price_amount=price),
                    text,dish_names=('Soup',),section_names=('BREAKFAST','LUNCH'),ocr_metadata=metadata,return_box_evidence=True)
                self.assertEqual(cleaned.price_amount,price)
                self.assertEqual(records[0]['saved_region_index'],index)
                self.assertTrue(any('section' in w.lower() for w in warnings))
        self.assertEqual(metadata,before)
        cleaned,_,records=grounded_draft(dish(),text,ocr_metadata=metadata,return_box_evidence=True)
        self.assertIsNone(cleaned.price_amount)
        self.assertEqual(records,[])

    def test_ambiguous_missing_or_contradictory_section_context_abstains(self):
        base=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
                    box('LUNCH',450,20,100),box('Soup',450,60,60),box('9.50',650,60,60))
        for category,text,metadata in [
                ('DINNER','# BREAKFAST\nSoup\n# LUNCH\nSoup',base),
                ('BREAKFAST','BREAKFAST\nSoup\nLUNCH\nSoup',base),
                ('BREAKFAST','# BREAKFAST\nSoup\n# BREAKFAST\nSoup',base),
                ('BREAKFAST','# BREAKFAST\nSoup\n9.50\n# LUNCH\nSoup',base),
                ('BREAKFAST','# BREAKFAST\nSoup\n# PRICE\n8.50 / 12.50\n# LUNCH\nSoup',
                 layout(*base['ocr_regions'],box('PRICE',20,100,100))),
                ('BREAKFAST','# BREAKFAST\nSoup\n# LUNCH\nSoup',
                 layout(*[r for r in base['ocr_regions'] if r['text']!='LUNCH']))]:
            with self.subTest(category=category,text=text):
                cleaned,_,records=grounded_draft(dish(category=category),text,
                    section_names=('BREAKFAST','LUNCH','PRICE'),ocr_metadata=metadata,return_box_evidence=True)
                self.assertIsNone(cleaned.price_amount)
                self.assertEqual(records,[])

    def test_section_filter_never_drops_a_straddling_or_unassigned_price_option(self):
        text='# BREAKFAST\nSoup\n# LUNCH\nSoup'
        for left in (430,460):
            metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
                box('12.50',left,60,60),box('LUNCH',450,20,100),box('Soup',450,120,60),
                box('9.50',650,120,60))
            with self.subTest(left=left):
                cleaned,_,records=grounded_draft(dish(category='BREAKFAST'),text,
                    section_names=('BREAKFAST','LUNCH'),ocr_metadata=metadata,return_box_evidence=True)
                self.assertIsNone(cleaned.price_amount)
                self.assertIsNone(cleaned.price_text)
                self.assertEqual(records,[])

    def test_currency_and_percentage_headings_cannot_hide_canonical_numbers(self):
        for label in ('$','P','%','％','USD','kcal','PRICE','PRICE:','USD:','kcal:',
                      'kcal / oz','[USD]','(PRICE)','*PRICE*','PRICE™','ＵＳＤ：','ＰＲＩＣＥ：',
                      'price USD','kcal—oz','CaloriesPerServing','USD/oz','XYZ:','REGULAR:',
                      'Medium:','XL:','size/option','ml²','Volume㎖','°C','¥','₹ PRICE',
                      'Ala Carte','Combo Meals','Set','Single-Serve','Hot/Cold','Endless'):
            text=f'# BREAKFAST\nSoup\n# {label}\n9.50\nTea\n# LUNCH\nSoup'
            metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
                box(label,20,100,80),box('9.50',20,140,60),box('Tea',20,180,60),
                box('LUNCH',450,20,100),box('Soup',450,60,60),box('9.50',650,60,60))
            with self.subTest(label=label):
                cleaned,_,records=grounded_draft(dish(category='BREAKFAST'),text,dish_names=('Soup','Tea'),
                    section_names=('BREAKFAST',label,'LUNCH'),ocr_metadata=metadata,return_box_evidence=True)
                # Canonical explicit USD 9.50 may still be recovered by existing
                # text/geometry checks; the box-only conflicting 8.50 may not.
                self.assertIn(cleaned.price_amount,(None,'9.50'))
                self.assertEqual(records,[])

    def test_generic_model_named_rows_do_not_truncate_canonical_conflicts(self):
        for label in ('PRICE','USD','kcal','REGULAR','Ala Carte'):
            text=f'Soup\n# {label}\n9.50'
            metadata=layout(box('Soup',20,20,80),box('8.50',200,20,60),box(label,20,100,100))
            with self.subTest(label=label):
                cleaned,_,records=grounded_draft(dish(),text,dish_names=('Soup',label),
                    ocr_metadata=metadata,return_box_evidence=True)
                self.assertIsNone(cleaned.price_amount)
                self.assertEqual(records,[])

    def test_known_three_letter_and_numeric_names_still_bound_other_entries(self):
        for name in ('TEA','EGG','PIE','7UP'):
            text=f'Soup\n{name}\n6.50'
            metadata=layout(box('Soup',20,20,80),box('8.50',200,20,60),
                box(name,20,60,100),box('6.50',200,60,60))
            with self.subTest(name=name):
                cleaned,_,records=grounded_draft(dish(),text,dish_names=('Soup',name),
                    ocr_metadata=metadata,return_box_evidence=True)
                self.assertEqual(cleaned.price_amount,'8.50')
                self.assertEqual([r['saved_region_index'] for r in records],[1])

    def test_label_rejection_preserves_ordinary_source_menu_headers(self):
        from peekaplate_processing.menu_layout import _section_boundary_label
        for label in ('Breakfast','Lunch','Dinner','Small Plates','Large Plates',
                      'BBQ & GRILL','ALL DAY BREAKFAST',"Chef's Specials",'Breakfast™'):
            with self.subTest(label=label):
                self.assertTrue(_section_boundary_label(label))

    def test_section_context_cannot_hide_numbers_through_the_next_known_entry(self):
        for label in ('Blue Label','PRICE:','Medium Mode','Ala Carte','Foo'):
            for canonical_price in ('','\n8.50'):
                text=f'# BREAKFAST\nSoup{canonical_price}\n# {label}\n9.50\nTea\n# LUNCH\nSoup'
                metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
                    box(label,20,100,100),box('9.50',20,140,60),box('Tea',20,180,60),
                    box('LUNCH',450,20,100),box('Soup',450,60,60),box('9.50',650,60,60))
                with self.subTest(label=label,canonical_price=canonical_price):
                    cleaned,_,records=grounded_draft(dish(category='BREAKFAST'),text,dish_names=('Soup','Tea'),
                        section_names=('BREAKFAST',label,'LUNCH'),ocr_metadata=metadata,return_box_evidence=True)
                    if canonical_price:
                        self.assertIsNone(cleaned.price_text)
                        self.assertIsNone(cleaned.price_amount)
                    else:
                        # An explicitly canonical PRICE: 9.50 may replace the
                        # model reading; hidden-number box-only 8.50 may not.
                        self.assertIn(cleaned.price_amount,(None,'9.50'))
                    self.assertEqual(records,[])

    def test_section_view_does_not_turn_an_interior_contact_into_a_footer(self):
        metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
            box('LUNCH',450,20,100),box('Soup',450,60,60),box('9.50',650,60,60))
        for label in ('Tel','Phone'):
            text=f'# BREAKFAST\nSoup\n{label}: (212) 555-1212\n# LUNCH\nSoup'
            for names in ((),('Soup',label)):
                with self.subTest(label=label,names=names):
                    cleaned,_,records=grounded_draft(dish(category='BREAKFAST'),text,dish_names=names,
                        section_names=('BREAKFAST','LUNCH'),ocr_metadata=metadata,return_box_evidence=True)
                    self.assertIsNone(cleaned.price_amount)
                    self.assertEqual(records,[])

    def test_repeated_canonical_prices_need_complete_number_agreement(self):
        text='# BREAKFAST\nSoup\n8.50\n# LUNCH\nSoup\n9.50'
        metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
            box('LUNCH',450,20,100),box('Soup',450,60,60),box('9.50',650,60,60))
        for category,expected in (('BREAKFAST','8.50'),('LUNCH','9.50')):
            with self.subTest(category=category):
                cleaned,_,records=grounded_draft(dish(category=category,price_text=expected,price_amount=expected),text,
                    section_names=('BREAKFAST','LUNCH'),ocr_metadata=metadata,return_box_evidence=True)
                self.assertEqual(cleaned.price_amount,expected)
                self.assertEqual(records,[])

    def test_actual_pipeline_preserves_two_same_name_entries_in_distinct_sections(self):
        from PIL import Image
        class Sections(RecordingLLM):
            async def ainvoke(self,messages):
                answer=await super().ainvoke(messages)
                body=json.loads(answer['raw'].content)
                first=body['dishes'][0]
                body['dishes']=[{**first,'category':category,'price_text':price,'price_amount':price}
                    for category,price in [('BREAKFAST','8.50'),('LUNCH','9.50')]]
                answer['raw'].content=json.dumps(body)
                return answer
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.png'
            with Image.new('RGB',(800,240),'white') as image:image.save(source)
            text='# BREAKFAST\nSoup\n# LUNCH\nSoup'
            metadata=layout(box('BREAKFAST',20,20,120),box('Soup',20,60,60),box('8.50',200,60,60),
                box('LUNCH',20,140,100),box('Soup',20,180,60),box('9.50',200,180,60))
            metadata.update(upload_width=800,upload_height=240)
            pages=image_source(source);pages.status='complete';pages.errors=[]
            pages.segments=[SourceSegment(segment_id='synthetic:page:1',page_number=1,
                method='ocr_space_engine3',text=text,metadata=metadata)]
            saved=root/'pages.json';saved.write_text(pages.model_dump_json())
            report=run_pipeline(source,root/'run',llm=Sections(),pages_json=saved,cache_dir=None,llm_cache_dir=None)
            self.assertEqual(report.status,'complete')
            self.assertEqual(len(report.drafts),2)
            self.assertEqual([d.name for d in report.drafts],['Soup','Soup'])
            self.assertEqual([str(d.price_amount) for d in report.drafts],['8.50','9.50'])
            self.assertEqual([e.box_evidence[0].saved_region_index for e in report.evidence],[2,5])
            exported=export_review_candidates(root/'run/extraction.json',root/'review.json')
            self.assertEqual(len(exported.segments[0].metadata['candidate_box_evidence']),2)
            self.assertEqual(report.segments[0].text,text)

    def test_actual_pipeline_name_and_footer_recovery_retains_source_and_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.png';photo(source)
            text='Soup\n\n## 212-555-0123'
            pages=image_source(source);pages.status='complete';pages.errors=[]
            metadata=layout(box('Soup',1,1,10,5),box('8.50',15.25,1,10,5))
            metadata.update(upload_width=48,upload_height=32)
            pages.segments=[SourceSegment(segment_id='synthetic:page:1',page_number=1,
                method='ocr_space_engine3',text=text,metadata=metadata)]
            saved=root/'pages.json';saved.write_text(pages.model_dump_json())
            before=saved.read_bytes()
            with patch('peekaplate_processing.run_pipeline.extract_source',side_effect=AssertionError('No OCR calls')):
                report=run_pipeline(source,root/'run',llm=RecordingLLM(name='Soup®'),pages_json=saved,
                    cache_dir=None,llm_cache_dir=None)
            self.assertEqual(report.status,'complete')
            self.assertEqual(report.drafts[0].name,'Soup')
            self.assertEqual(str(report.drafts[0].price_amount),'8.50')
            self.assertEqual(report.segments[0].text,text)
            self.assertEqual(saved.read_bytes(),before)
            exported=export_review_candidates(root/'run/extraction.json',root/'review.json')
            candidate=exported.candidates[0]
            self.assertEqual(candidate.original.status,'needs_review')
            self.assertEqual(candidate.original.source_text,text)
            links=exported.segments[0].metadata['candidate_box_evidence'][candidate.candidate_id]
            self.assertEqual(links[0]['text'],'8.50')
            private=json.loads((root/'run/review-suggestions.json').read_text())
            record=private['suggestions'][0]
            self.assertEqual(record['original']['name'],'Soup®')
            decision=next(d for d in record['decisions'] if d['field']=='name')
            self.assertEqual(decision['grounded_value'],'Soup')

if __name__=='__main__':unittest.main()
