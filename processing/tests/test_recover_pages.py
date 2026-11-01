"""Synthetic recovery controls: mocked transport only, never a provider call."""
import copy
import hashlib
import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

import pymupdf
from fixture_factory import make_pdf, menu_image
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.extract_menus import extract_source
from peekaplate_processing.ocr_space import OCRSpaceClient
from peekaplate_processing.pdf import extract_pdf
from peekaplate_processing.recover_pages import recover_pages


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root/'source.pdf'
        self.source.write_bytes(make_pdf([{}, {}, {'text': 'Native menu with sufficient visible characters'}]))
        ocr = MagicMock()
        ocr.extract.side_effect = ExtractionError('old quota failure')
        self.saved = extract_source(self.source, ocr_provider=ocr).model_dump(mode='json')
        self.input = self.root/'saved.json'
        self.output = self.root/'new'
        self.write_saved()

    def write_saved(self):
        self.input.write_text(json.dumps(self.saved))

    def run_recovery(self, **kwargs):
        return recover_pages(self.source, self.input, self.output, page_numbers=kwargs.pop('page_numbers', [1, 2]),
                             max_requests=kwargs.pop('max_requests', 2), ocr_api_key='synthetic', **kwargs)

    def transport(self):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = json.dumps({
            'OCRExitCode': 1, 'IsErroredOnProcessing': False,
            'ParsedResults': [{'FileParseExitCode': 1, 'ParsedText': 'Repaired soup 8.50'}]}).encode()
        return opener

    def test_success_merges_and_preserves_hash_failure_history_and_permissions(self):
        before = self.input.read_bytes()
        opener = self.transport()
        with patch('peekaplate_processing.ocr_space.build_opener', return_value=opener):
            report = self.run_recovery()
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(report.segments[2].model_dump(mode='json'), self.saved['segments'][2])
        self.assertEqual([s.status for s in report.segments], ['ready']*3)
        self.assertTrue(all(s.error is None for s in report.segments))
        self.assertEqual(report.drafts, [])
        self.assertEqual(report.evidence, [])
        manifest = json.loads((self.output/'manifest.json').read_text())
        self.assertEqual(manifest['input_report_sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(len(manifest['previous_failures']), 2)
        self.assertEqual(manifest['requests_attempted'], 2)
        self.assertEqual(self.input.read_bytes(), before)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        for name in ['pages.json', 'manifest.json']:
            self.assertEqual(stat.S_IMODE((self.output/name).stat().st_mode), 0o600)

    def test_first_failure_stops_without_retry_and_preserves_unattempted(self):
        for error in [HTTPError('https://example.test',429,'limited',{},None), URLError('timeout')]:
            with self.subTest(error=type(error).__name__):
                self.output = self.root/type(error).__name__
                opener = self.transport(); opener.open.side_effect = error
                with patch('peekaplate_processing.ocr_space.build_opener', return_value=opener), \
                     patch('peekaplate_processing.ocr_space.time.sleep') as sleep:
                    report = self.run_recovery()
                self.assertEqual(opener.open.call_count, 1)
                sleep.assert_not_called()
                self.assertEqual(report.segments[1].model_dump(mode='json'), self.saved['segments'][1])
                manifest = json.loads((self.output/'manifest.json').read_text())
                self.assertEqual([a['status'] for a in manifest['pages']], ['failed', 'not_attempted'])
                self.assertEqual(manifest['requests_attempted'], 1)

    def test_invalid_selection_and_existing_output_precede_client_and_output(self):
        for selection, budget in [([],2),([1,1],2),([0],2),([4],2),([3],2),([True],2),([1,2],1),([1],0),([1],5),([1],True)]:
            with self.subTest(selection=selection,budget=budget), patch('peekaplate_processing.recover_pages.OCRSpaceClient') as client:
                with self.assertRaises(ExtractionError): self.run_recovery(page_numbers=selection,max_requests=budget)
                client.assert_not_called()
                self.assertFalse(self.output.exists())
        self.output.mkdir()
        with patch('peekaplate_processing.recover_pages.OCRSpaceClient') as client:
            with self.assertRaises(ExtractionError): self.run_recovery()
            client.assert_not_called()

    def test_invalid_saved_provenance_coverage_and_status_precede_client(self):
        original = copy.deepcopy(self.saved)
        changes = [lambda r: r['source'].update(sha256='0'*64),
                   lambda r: r['source'].update(size_bytes=1),
                   lambda r: r['source'].update(snapshot_base64='!!!!'),
                   lambda r: r['segments'].pop(),
                   lambda r: r['segments'][0].update(segment_id='other#page-1'),
                   lambda r: r['segments'][0].update(status='ready'),
                   lambda r: r['segments'][0].update(method='pdf_native'),
                   lambda r: r['segments'][1].update(page_number=1)]
        for change in changes:
            self.saved=copy.deepcopy(original); change(self.saved); self.write_saved()
            with patch('peekaplate_processing.recover_pages.OCRSpaceClient') as client:
                with self.assertRaises(ExtractionError): self.run_recovery()
                client.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_forged_failed_native_page_rejected_before_client(self):
        self.saved['segments'][2].update(status='failed', method='ocr_space_engine3', error='fake')
        self.write_saved()
        with patch('peekaplate_processing.recover_pages.OCRSpaceClient') as client:
            with self.assertRaises(ExtractionError): self.run_recovery(page_numbers=[3])
            client.assert_not_called()

    def test_image_reuses_existing_preparation(self):
        self.source=self.root/'image.png'; self.source.write_bytes(menu_image())
        ocr=MagicMock(); ocr.extract.side_effect=ExtractionError('old')
        self.saved=extract_source(self.source,ocr_provider=ocr).model_dump(mode='json'); self.write_saved()
        opener=self.transport()
        with patch('peekaplate_processing.ocr_space.build_opener',return_value=opener):
            result=self.run_recovery(page_numbers=[1],max_requests=1)
        self.assertEqual(opener.open.call_count,1)
        self.assertEqual(result.segments[0].page_number,1)
        self.assertIn('upload_width',result.segments[0].metadata)

    def test_selective_pdf_never_loads_unselected_pages(self):
        loads=[]; original=pymupdf.Document.load_page
        def load(doc,index):
            loads.append(index); return original(doc,index)
        ocr=MagicMock(); ocr.extract.return_value={'text':'Soup','settings':{'OCREngine':3},'cache_hit':False}
        with patch.object(pymupdf.Document,'load_page',load):
            pages=extract_pdf(self.source.read_bytes(),'source',ocr,page_numbers=[2])
        self.assertEqual(loads,[1]); self.assertEqual(pages[0].page_number,2)
        self.assertEqual(pages[0].segment_id,'source#page-2')

    def test_single_attempt_setting_rejects_invalid_values(self):
        for value in [0,3,True,1.0,None]:
            with self.assertRaises(ExtractionError): OCRSpaceClient('key',max_attempts=value)

    def test_http_and_invalid_payload_failures_never_retry(self):
        for code in [429, 500, 502, 503, 504]:
            with self.subTest(code=code):
                self.output=self.root/f'http-{code}'
                opener=self.transport()
                opener.open.side_effect=HTTPError('https://example.test',code,'synthetic',{'Retry-After':'1'},None)
                with patch('peekaplate_processing.ocr_space.build_opener',return_value=opener), \
                     patch('peekaplate_processing.ocr_space.time.sleep') as sleep:
                    self.run_recovery()
                self.assertEqual(opener.open.call_count,1)
                sleep.assert_not_called()
        self.output=self.root/'invalid-payload'
        opener=self.transport()
        opener.open.return_value.__enter__.return_value.read.return_value=b'{}'
        with patch('peekaplate_processing.ocr_space.build_opener',return_value=opener):
            result=self.run_recovery()
        self.assertEqual(opener.open.call_count,1)
        self.assertEqual(result.segments[0].error,'old quota failure')

    def test_recovery_client_is_explicitly_uncached_and_single_attempt(self):
        real_client=OCRSpaceClient
        opener=self.transport()
        with patch('peekaplate_processing.recover_pages.OCRSpaceClient',wraps=real_client) as factory, \
             patch('peekaplate_processing.ocr_space.build_opener',return_value=opener):
            self.run_recovery()
        self.assertIsNone(factory.call_args.kwargs['cache_dir'])
        self.assertEqual(factory.call_args.kwargs['max_attempts'],1)
        self.assertEqual(opener.open.call_count,2)

    def test_selected_subset_preserves_all_other_failures_and_no_drafts(self):
        # Use a valid old local draft without evidence. It must not leak into a
        # new acquisition, even when its original source text remains available.
        self.saved['drafts']=[{'name':'Old native dish','source_id':self.saved['source']['source_id'],
                               'source_text':self.saved['segments'][2]['text']}]
        self.saved['capture_requests']=[{'draft_id':'old','dish_name':'Old native dish'}]
        self.write_saved()
        opener=self.transport()
        with patch('peekaplate_processing.ocr_space.build_opener',return_value=opener):
            report=self.run_recovery(page_numbers=[2],max_requests=1)
        self.assertEqual(opener.open.call_count,1)
        self.assertEqual(report.segments[0].model_dump(mode='json'),self.saved['segments'][0])
        self.assertEqual(report.status,'incomplete')
        self.assertEqual(report.drafts,[])
        self.assertEqual(report.capture_requests,[])
        self.assertEqual(report.evidence,[])

    def test_invalid_pdf_selection_precedes_page_load_and_ocr(self):
        for selection in [[],[1,1],[0],[4],[True],['1']]:
            with self.subTest(selection=selection), patch.object(pymupdf.Document,'load_page') as load:
                ocr=MagicMock()
                with self.assertRaises(ExtractionError):
                    extract_pdf(self.source.read_bytes(),'source',ocr,page_numbers=selection)
                load.assert_not_called(); ocr.extract.assert_not_called()

    def test_cli_requires_explicit_budget(self):
        from peekaplate_processing.recover_pages import main
        with patch('peekaplate_processing.recover_pages.recover_pages') as helper:
            with self.assertRaises(SystemExit) as exit:
                main(['--input','source.pdf','--pages-json','saved.json','--output-dir','new','--target-pages','1'])
            self.assertEqual(exit.exception.code,2)
            helper.assert_not_called()

    def test_unselected_skipped_page_cannot_become_complete(self):
        self.saved['segments'][2].update(status='skipped')
        self.write_saved()
        opener=self.transport()
        with patch('peekaplate_processing.ocr_space.build_opener',return_value=opener):
            report=self.run_recovery()
        self.assertEqual(report.status,'incomplete')
        self.assertEqual(report.segments[2].model_dump(mode='json'),self.saved['segments'][2])

    def test_missing_key_counts_zero_requests_and_stops(self):
        with patch('peekaplate_processing.ocr_space.build_opener') as opener:
            report=recover_pages(
                self.source,self.input,self.output,page_numbers=[1,2],max_requests=2,ocr_api_key=None)
        opener.assert_not_called()
        manifest=json.loads((self.output/'manifest.json').read_text())
        self.assertEqual(manifest['requests_attempted'],0)
        self.assertEqual([a['status'] for a in manifest['pages']],['failed','not_attempted'])
        self.assertEqual(report.status,'incomplete')
