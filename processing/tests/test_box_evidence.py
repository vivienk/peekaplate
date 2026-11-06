"""Synthetic-only public box evidence contract regressions."""
import copy
import json
from pathlib import Path
import unittest

from peekaplate_processing.schemas import BoxEvidence, MenuExtractionResult, validate_box_evidence
from peekaplate_processing.review_candidates import prepare_review_candidates, ReviewCandidateResult

FIXTURES = Path(__file__).parent / 'fixtures'


def data():
    value = json.loads((FIXTURES / 'review-candidates/representative-extraction.json').read_text())
    segment = value['segments'][0]
    segment['method'] = 'ocr_space_engine3'
    segment['metadata'].update(ocr_coordinate_space='uploaded_image_pixels', ocr_region_status='available',
                               upload_width=600, upload_height=800,
                               ocr_regions=[dict(text='8.50', left=10.25, top=20, width=30.5, height=12)])
    value['evidence'][0]['box_evidence'] = [dict(page_number=1, saved_region_index=0, text='8.50',
                                              box=dict(left=10.25, top=20, width=30.5, height=12))]
    return value


class BoxEvidenceTests(unittest.TestCase):
    def test_fractional_exact_roundtrip_links_and_immutability(self):
        value = data()
        report = MenuExtractionResult.model_validate(value)
        before = report.model_dump(mode='json')
        exported = prepare_review_candidates(report)
        candidate = exported.candidates[0]
        shared = json.loads((FIXTURES / 'review-candidates/box-evidence-candidates.json').read_text())
        self.assertEqual(exported.model_dump(mode='json'), shared)
        expected = value['evidence'][0]['box_evidence']
        self.assertEqual(exported.segments[0].metadata['candidate_box_evidence'], {candidate.candidate_id: expected})
        self.assertEqual(expected[0]['box']['left'], 10.25)
        self.assertEqual(candidate.evidence, report.evidence[0].spans)
        self.assertEqual(candidate.original, report.drafts[0])
        self.assertEqual(ReviewCandidateResult.model_validate_json(exported.model_dump_json()), exported)
        self.assertEqual(report.model_dump(mode='json'), before)
        exported.segments[0].metadata['ocr_regions'][0]['text'] = 'changed'
        self.assertEqual(report.model_dump(mode='json'), before)

    def test_absent_empty_field_shared_bundle(self):
        bundle = json.loads((FIXTURES / 'service-artifacts/representative-bundle.json').read_text())
        # Compare the shared report shape, not a newly generated fixture.
        report = bundle['report']
        self.assertEqual(MenuExtractionResult.model_validate(report).model_dump(mode='json'), report)

    def test_strict_box_records(self):
        original = data()['evidence'][0]['box_evidence'][0]
        original['box'].update(left=10, width=30)
        variants = []
        for key, values in {'page_number': [True, 0, 1.0], 'saved_region_index': [True, -1, 0.0],
                            'text': ['', ' ', None, '8\n50', '8\x7f50']}.items():
            for value in values:
                changed = copy.deepcopy(original); changed[key] = value; variants.append(changed)
        for key in original['box']:
            for value in [True, float('nan'), float('inf'), -1, '2'] + ([0] if key in ('width', 'height') else []):
                changed = copy.deepcopy(original); changed['box'][key] = value; variants.append(changed)
            changed = copy.deepcopy(original); del changed['box'][key]; variants.append(changed)
        changed = copy.deepcopy(original); changed['box']['extra'] = 1; variants.append(changed)
        for changed in variants:
            with self.subTest(record=changed), self.assertRaises(ValueError):
                BoxEvidence.model_validate(changed)

    def test_tampered_existing_models_rejected_at_export(self):
        mutations = [
            lambda r: setattr(r.evidence[0].box_evidence[0], 'page_number', 2),
            lambda r: setattr(r.evidence[0].box_evidence[0], 'saved_region_index', 1),
            lambda r: setattr(r.evidence[0].box_evidence[0], 'text', '9.50'),
            lambda r: r.evidence[0].box_evidence[0].box.update(left=11),
            lambda r: r.evidence[0].box_evidence[0].box.update(top=True),
            lambda r: r.evidence[0].box_evidence.append(r.evidence[0].box_evidence[0]),
            lambda r: setattr(r.segments[0], 'error', 'bad'),
            lambda r: setattr(r.segments[0], 'method', 'pdf_native'),
            lambda r: r.segments[0].metadata.update(upload_width=20),
            lambda r: r.segments[0].metadata.update(ocr_region_status='unavailable'),
            lambda r: r.segments[0].metadata.update(candidate_box_evidence={'orphan': []}),
            lambda r: r.segments[1].metadata.update(candidate_box_evidence={r.evidence[0].draft_id: []}),
            lambda r: setattr(r.drafts[0], 'source_id', 'other'),
            lambda r: setattr(r.evidence[0].spans[0], 'start', 999),
        ]
        for mutate in mutations:
            report = MenuExtractionResult.model_validate(data())
            mutate(report)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                prepare_review_candidates(report)

    def test_injected_map_and_construct_rejected(self):
        value = data()
        value['segments'][0]['metadata']['candidate_box_evidence'] = {'orphan': value['evidence'][0]['box_evidence']}
        with self.assertRaises(ValueError):
            MenuExtractionResult.model_validate(value)
        report = MenuExtractionResult.model_validate(data())
        broken = report.model_copy(update={'evidence': [report.evidence[0].model_copy(update={'box_evidence': [BoxEvidence.model_construct(page_number=True, box={}, text=None, saved_region_index=-1)]}), *report.evidence[1:]]})
        with self.assertRaises(ValueError):
            prepare_review_candidates(broken)

    def test_valid_existing_links_preserved_and_invalid_review_links_rejected(self):
        value = data()
        key = value['evidence'][0]['draft_id']
        value['segments'][0]['metadata']['candidate_box_evidence'] = {key: value['evidence'][0]['box_evidence']}
        exported = prepare_review_candidates(MenuExtractionResult.model_validate(value))
        raw = exported.model_dump(mode='json')
        raw['segments'][1]['metadata']['candidate_box_evidence'] = {key: value['evidence'][0]['box_evidence']}
        with self.assertRaises(ValueError):
            ReviewCandidateResult.model_validate(raw)

    def test_pre_save_helper_exact_typed_maps_and_geometry_tamper(self):
        value = data()
        key = value['evidence'][0]['draft_id']
        report = MenuExtractionResult.model_validate(value)
        links = validate_box_evidence(report)
        self.assertEqual(links[report.segments[0].segment_id][key], value['evidence'][0]['box_evidence'])
        mutations = [
            lambda r: r['segments'][0]['metadata']['ocr_regions'][0].update(top=20.0),
            lambda r: r['segments'][0]['metadata']['ocr_regions'][0].update(text=' 8.50'),
            lambda r: r['segments'][0]['metadata'].update(ocr_coordinate_space='page_points'),
            lambda r: r['segments'][0]['metadata'].update(upload_height=float('nan')),
            lambda r: r['evidence'][0]['box_evidence'][0].update(private_suggestion='not public'),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(value)
            mutate(changed)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                MenuExtractionResult.model_validate(changed)
        for mutate in [
            lambda m: m[key][0]['box'].update(top=20.0),
            lambda m: m[key][0].update(text='wrong'),
            lambda m: m[key][0].update(transcript='private'),
            lambda m: m.update(orphan=m[key]),
            lambda m: m.update({key: []}),
        ]:
            changed = copy.deepcopy(value)
            mapping = {key: copy.deepcopy(value['evidence'][0]['box_evidence'])}
            mutate(mapping)
            changed['segments'][0]['metadata']['candidate_box_evidence'] = mapping
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                MenuExtractionResult.model_validate(changed)

    def test_same_page_ambiguous_citations_and_duplicate_regions_rejected(self):
        value = data()
        extra = copy.deepcopy(value['segments'][0])
        extra['segment_id'] += '-duplicate'
        value['segments'].append(extra)
        value['evidence'][0]['spans'].append(dict(segment_id=extra['segment_id'], start=0, end=4))
        value['drafts'][0]['source_text'] += '\n' + extra['text'][:4]
        with self.assertRaises(ValueError):
            MenuExtractionResult.model_validate(value)
        value = data()
        value['segments'][0]['metadata']['ocr_regions'] *= 2
        other = copy.deepcopy(value['evidence'][0]['box_evidence'][0])
        other['saved_region_index'] = 1
        value['evidence'][0]['box_evidence'].append(other)
        with self.assertRaises(ValueError):
            MenuExtractionResult.model_validate(value)

    def test_legacy_no_boxes_unchanged_and_orphan_mapping_rejected(self):
        value = json.loads((FIXTURES / 'review-candidates/representative-extraction.json').read_text())
        expected = json.loads((FIXTURES / 'review-candidates/representative-candidates.json').read_text())
        self.assertEqual(prepare_review_candidates(MenuExtractionResult.model_validate(value)).model_dump(mode='json'), expected)
        value['segments'][0]['metadata']['candidate_box_evidence'] = {value['evidence'][0]['draft_id']: []}
        with self.assertRaises(ValueError):
            MenuExtractionResult.model_validate(value)

    def test_multiple_pages_link_only_the_corresponding_cited_segments(self):
        value = data()
        second = value['segments'][1]
        second.update(status='ready', error=None, text='Second page')
        second['metadata'] = copy.deepcopy(value['segments'][0]['metadata'])
        other = copy.deepcopy(value['evidence'][0]['box_evidence'][0])
        other['page_number'] = 2
        value['evidence'][0]['box_evidence'].append(other)
        value['evidence'][0]['spans'].append(dict(segment_id=second['segment_id'], start=0, end=len(second['text'])))
        value['drafts'][0]['source_text'] += '\n' + second['text']
        report = MenuExtractionResult.model_validate(value)
        exported = prepare_review_candidates(report)
        key = value['evidence'][0]['draft_id']
        self.assertEqual(exported.segments[0].metadata['candidate_box_evidence'][key], [value['evidence'][0]['box_evidence'][0]])
        self.assertEqual(exported.segments[1].metadata['candidate_box_evidence'][key], [other])
        self.assertNotIn('candidate_box_evidence', exported.segments[2].metadata)
        self.assertEqual(ReviewCandidateResult.model_validate_json(exported.model_dump_json()), exported)
