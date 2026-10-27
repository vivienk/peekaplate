import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.ingredient_intelligence import (
    ALLERGENS, IngredientReviewHandoff, build_review_handoff, main, normalize,
)
from peekaplate_processing.schemas import (
    DishDraft, DraftEvidence, MenuExtractionResult, SourceRecord, SourceSegment, SourceSpan,
)


def report_for(ingredients, text=None):
    text = text if text is not None else '🥣 Dish\nIngredients: ' + ', '.join(ingredients or [])
    return MenuExtractionResult(
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        source=SourceRecord(source_id='source:synthetic', sha256='a' * 64, kind='text',
                            location='synthetic.txt', retrieved_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                            size_bytes=1, snapshot_base64='eA=='),
        segments=[SourceSegment(segment_id='page:1', method='text', text='  ' + text)],
        drafts=[DishDraft(name='Dish', ingredients=ingredients, source_id='source:synthetic', source_text=text)],
        evidence=[DraftEvidence(draft_id='draft:synthetic', draft_index=0,
            spans=[SourceSpan(segment_id='page:1', start=2, end=2 + len(text))])],
    )


class IngredientIntelligenceTests(unittest.TestCase):
    def assess(self, ingredients, text=None):
        return build_review_handoff(report_for(ingredients, text)).assessments[0]

    def test_all_nine_allergen_categories_and_diet_exclusions(self):
        result = self.assess(['milk', 'eggs', 'salmon', 'prawns', 'almonds', 'peanuts', 'wheat flour', 'soya', 'sesame seeds'])
        self.assertEqual(set(result.allergens), set(ALLERGENS))
        self.assertTrue(all(c.status == 'possible_presence' for c in result.allergens.values()))
        self.assertTrue(all(c.status == 'possible_incompatible' for c in result.dietary.values()))
        self.assertEqual(result.ingredients[3].canonical, 'shrimp')
        self.assertEqual(result.ingredients[7].canonical, 'soybean')
        self.assertEqual(result.allergens['soy'].ingredient_indices, [7])
        self.assertEqual(result.allergens['soy'].rule_ids, ['ingredient-rules.1:soybean'])

    def test_missing_empty_and_plant_only_never_infer_absence_or_suitability(self):
        for ingredients in (None, [], ['tomato', 'rice'], ['salt', 'water']):
            with self.subTest(ingredients=ingredients):
                result = self.assess(ingredients)
                self.assertTrue(all(c.status == 'unknown' for c in result.allergens.values()))
                self.assertTrue(all(c.status == 'unknown' for c in result.dietary.values()))
                self.assertFalse(result.publishable)
                self.assertTrue(result.owner_confirmation_required)

    def test_dairy_and_honey_exclude_vegan_not_vegetarian(self):
        for ingredient in ['milk', 'egg', 'honey']:
            result = self.assess([ingredient])
            self.assertEqual(result.dietary['vegan'].status, 'possible_incompatible')
            self.assertEqual(result.dietary['vegetarian'].status, 'unknown')

    def test_unknown_and_composite_ingredients_are_not_expanded(self):
        result = self.assess(['pesto', 'house sauce', 'gelatin', 'cheese', 'almond milk', 'chicken stock', 'mystery powder'])
        self.assertEqual(result.status, 'unknown')
        self.assertTrue(all(i.reason == 'unrecognized_ingredient' for i in result.ingredients))
        self.assertTrue(all(c.status == 'unknown' for c in result.allergens.values()))

    def test_negation_alternatives_cross_contact_and_compounds_abstain(self):
        for text in ['Dish: no milk', 'Dish: milk-free', 'Dish: milk free', 'Dish: without milk',
                     'Dish: may contain milk', 'Dish: traces of milk', 'Dish: milk optional',
                     'Dish: milk or oat drink', 'Dish: almond milk', 'Dish: vegan milk',
                     'Dish: milk flavour', 'Dish: rice milk', 'Dish: non dairy milk', 'Dish: milk alternative']:
            with self.subTest(text=text):
                result = self.assess(['milk'], text)
                self.assertEqual(result.allergens['milk'].status, 'unknown')
                self.assertEqual(result.dietary['vegan'].status, 'unknown')

    def test_no_dish_name_recipe_inference_and_no_substrings(self):
        result = self.assess(None, 'Peanut butter chicken with milk')
        self.assertEqual(result.ingredients, [])
        for ingredient, text in [('egg', 'eggplant'), ('milk', 'buttermilk'), ('soy', 'soybean')]:
            result = self.assess([ingredient], text)
            self.assertEqual(result.ingredients[0].reason, 'missing_evidence')

    def test_unicode_offsets_select_original_text_and_normalization_retains_original(self):
        report = report_for(['  MILK  ', 'spring   onions'], '🥣 Dish\nIngredients: MILK, spring   onions')
        # DishDraft trims outer strings, so preserve the validated extractor phrase.
        result = build_review_handoff(report).assessments[0]
        self.assertEqual(result.ingredients[0].normalized, 'milk')
        self.assertEqual(result.ingredients[1].canonical, 'spring onion')
        self.assertEqual(normalize('ＳＯＹ'), 'soy')
        for ingredient in result.ingredients:
            for evidence in ingredient.evidence:
                self.assertEqual(report.segments[0].text[evidence.start:evidence.end], evidence.text)
                self.assertEqual(evidence.association, 'unverified')

    def test_missing_failed_mismatched_and_duplicate_evidence_fail_closed(self):
        base = report_for(['milk'])
        mutations = [lambda r: r.evidence.clear(), lambda r: setattr(r, 'source', None),
                     lambda r: setattr(r.segments[0], 'status', 'failed'),
                     lambda r: setattr(r.segments[0], 'text', 'different text'),
                     lambda r: setattr(r.drafts[0], 'source_id', 'other'),
                     lambda r: r.evidence.append(copy.deepcopy(r.evidence[0])),
                     lambda r: r.segments.append(copy.deepcopy(r.segments[0])),
                     lambda r: setattr(r.evidence[0].spans[0], 'end', 10000),
                     lambda r: setattr(r.evidence[0].spans[0], 'start', 9)]
        for mutation in mutations:
            report = copy.deepcopy(base)
            mutation(report)
            result = build_review_handoff(report).assessments[0]
            self.assertEqual(result.status, 'unknown')
            self.assertEqual(result.allergens['milk'].status, 'unknown')

    def test_digest_changes_for_corrections_and_source_changes_without_mutating_input(self):
        report = report_for(['milk'])
        before = report.model_dump_json()
        old = build_review_handoff(report).assessments[0].input_sha256
        self.assertEqual(before, report.model_dump_json())
        self.assertEqual(old, build_review_handoff(report).assessments[0].input_sha256)
        report.drafts[0].ingredients = ['rice']
        self.assertNotEqual(old, build_review_handoff(report).assessments[0].input_sha256)
        report = report_for(['milk'])
        report.source.sha256 = 'b' * 64
        self.assertNotEqual(old, build_review_handoff(report).assessments[0].input_sha256)

    def test_contract_rejects_approval_and_publication_fields(self):
        original = build_review_handoff(report_for(['milk'])).model_dump(mode='json')
        for changes in ({'publishable': True}, {'owner_confirmation_required': False}, {'approved_by': 'owner'}):
            data = copy.deepcopy(original)
            data.update(changes)
            with self.assertRaises(ValidationError):
                IngredientReviewHandoff.model_validate(data)

    def test_bounded_ingredients(self):
        for ingredients in (['milk'] * 101, ['x' * 257]):
            with self.assertRaises(ExtractionError):
                build_review_handoff(report_for(ingredients))

    def test_offline_cli_round_trip_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'extraction.json', Path(directory) / 'review.json'
            source.write_text(report_for(['milk']).model_dump_json())
            main(['--input', str(source), '--output', str(target)])
            saved = IngredientReviewHandoff.model_validate_json(target.read_text())
            self.assertEqual(saved.assessments[0].allergens['milk'].status, 'possible_presence')
            old = target.read_bytes()
            with self.assertRaises(SystemExit):
                main(['--input', str(source), '--output', str(target)])
            self.assertEqual(old, target.read_bytes())

    def test_shared_fixture_matches_python_output(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/ingredient-review.json').read_text())
        self.assertEqual(fixture, build_review_handoff(report_for(['milk', 'house sauce'])).model_dump(mode='json'))
