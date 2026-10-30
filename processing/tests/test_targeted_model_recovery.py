"""Explicit small model-page recovery; all provider/image inputs synthetic."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fixture_factory import make_pdf
from test_input_modes import RecordingLLM
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.schemas import SourceSegment
from peekaplate_processing.vision import image_source
from peekaplate_processing.run_pipeline import main, run_pipeline


def saved_source(root):
    source=root/'source.pdf'
    source.write_bytes(make_pdf([{'text':'Soup 8.50'} for _ in range(3)]))
    pages=image_source(source);pages.status='incomplete'
    pages.segments=[SourceSegment(segment_id=f'synthetic:page:{n}',page_number=n,
        method='pdf_native',text='Soup 8.50') for n in (1,2,3)]
    pages.errors=['Page 2: previous model attempt failed.']
    pages.configuration['llm_batches']=[{'page_numbers':[2],'model_status':'failed'}]
    saved=root/'pages.json';saved.write_text(pages.model_dump_json())
    return source,saved,pages


class TargetedModelRecoveryTests(unittest.TestCase):
    def test_only_selected_pages_are_sent_without_mutating_or_merging_prior_results(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source,saved,_=saved_source(root);before=saved.read_bytes();llm=RecordingLLM()
            with patch('peekaplate_processing.run_pipeline.extract_source',side_effect=AssertionError('No OCR')):
                report=run_pipeline(source,root/'run',llm=llm,pages_json=saved,input_mode='ocr',
                    target_pages=[2],max_model_requests=1,llm_cache_dir=None)
            self.assertEqual(len(llm.messages),1)
            request=json.loads(llm.messages[0][1][1])
            self.assertEqual([p['page_number'] for p in request['pages']],[2])
            self.assertEqual(len(report.drafts),1)
            self.assertEqual(report.evidence[0].spans[0].segment_id,'synthetic:page:2')
            self.assertEqual(len(report.segments),3)
            self.assertEqual(report.status,'incomplete')
            recovery=report.configuration['targeted_model_recovery']
            self.assertEqual(recovery['selected_pages'],[2])
            self.assertEqual(recovery['max_model_requests'],1)
            self.assertEqual(recovery['planned_batches'],1)
            self.assertEqual(recovery['input_report_sha256'],hashlib.sha256(before).hexdigest())
            self.assertEqual(recovery['previous_errors'],['Page 2: previous model attempt failed.'])
            self.assertEqual(recovery['previous_model_batches'][0]['model_status'],'failed')
            self.assertEqual(saved.read_bytes(),before)

    def test_budget_overflow_rejects_before_model_or_ocr_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source,saved,_=saved_source(root);llm=RecordingLLM()
            with patch('peekaplate_processing.run_pipeline.extract_source',side_effect=AssertionError('No OCR')),self.assertRaises(ExtractionError):
                run_pipeline(source,root/'run',llm=llm,pages_json=saved,input_mode='ocr',
                    target_pages=[1,3],max_model_requests=1,batch_pages=1,llm_cache_dir=None)
            self.assertEqual(llm.messages,[])

    def test_invalid_selection_and_failed_ocr_are_not_silently_retried(self):
        for selected,budget,have_saved in [([2,2],1,True),([],1,True),([4],1,True),
                ([True],1,True),([2],None,True),([2],0,True),([2],True,True),([2],1,False)]:
            with self.subTest(selected=selected,budget=budget),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source,saved,_=saved_source(root);llm=RecordingLLM()
                with patch('peekaplate_processing.run_pipeline.extract_source',side_effect=AssertionError('No OCR')),self.assertRaises(ExtractionError):
                    run_pipeline(source,root/'run',llm=llm,pages_json=saved if have_saved else None,
                        input_mode='ocr',target_pages=selected,max_model_requests=budget)
                self.assertEqual(llm.messages,[])
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source,saved,pages=saved_source(root)
            pages.segments[1].status='failed';pages.segments[1].error='Saved OCR failed';pages.segments[1].text=''
            saved.write_text(pages.model_dump_json());llm=RecordingLLM()
            with self.assertRaises(ExtractionError):
                run_pipeline(source,root/'run',llm=llm,pages_json=saved,input_mode='ocr_image',
                    target_pages=[2],max_model_requests=1)
            self.assertEqual(llm.messages,[])

    def test_vision_only_renders_and_sends_selected_pages(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source,saved,_=saved_source(root);llm=RecordingLLM()
            report=run_pipeline(source,root/'run',llm=llm,pages_json=saved,input_mode='ocr_image',
                target_pages=[2],max_model_requests=1,llm_cache_dir=None)
            self.assertEqual([p.name for p in (root/'run/pages').iterdir()],['02.png'])
            request=json.loads(llm.messages[0][1][1][0]['text'])
            self.assertEqual([p['page_number'] for p in request['pages']],[2])
            self.assertEqual(report.configuration['targeted_model_recovery']['planned_batches'],1)

    def test_model_failure_is_one_attempt_and_output_remains_explicitly_failed(self):
        class Failing(RecordingLLM):
            async def ainvoke(self,messages):
                self.messages.append(messages)
                raise RuntimeError('synthetic failed response')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source,saved,_=saved_source(root);llm=Failing()
            report=run_pipeline(source,root/'run',llm=llm,pages_json=saved,input_mode='ocr',
                target_pages=[2],max_model_requests=1,llm_cache_dir=None)
            self.assertEqual(len(llm.messages),1)
            self.assertEqual(report.status,'failed')
            self.assertEqual(report.drafts,[])
            self.assertEqual(report.configuration['llm_batches'][0]['model_status'],'failed')
            self.assertTrue((root/'run/review-suggestions.json').exists())

    def test_cli_requires_explicit_selection_and_budget(self):
        with patch('peekaplate_processing.run_pipeline.run_pipeline',return_value=SimpleNamespace(
                drafts=[],status='incomplete',errors=[])) as pipeline,patch('peekaplate_processing.run_pipeline.load_dotenv'),patch('builtins.print'):
            self.assertEqual(main(['--input','source.pdf','--pages-json','saved.json','--run-dir','run',
                '--target-pages','2','--max-model-requests','1']),2)
            self.assertEqual(pipeline.call_args.kwargs['target_pages'],[2])
            self.assertEqual(pipeline.call_args.kwargs['max_model_requests'],1)

if __name__=='__main__':unittest.main()
