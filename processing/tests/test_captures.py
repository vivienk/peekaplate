import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fixture_factory import menu_image
from peekaplate_processing.extract_menus import extract_menus


class CaptureTests(unittest.TestCase):

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.directory=Path(self.temporary.name)
        (self.directory/"dish.jpg").write_bytes(menu_image())
        result=extract_menus("Soup  8.50 CAD",source_type="text")
        self.entry={
            "draft_id":result.evidence[0].draft_id,"restaurant_id":"synthetic-restaurant",
            "file":"dish.jpg","captured_at":datetime.now(timezone.utc).isoformat(),
            "capture_evidence":"Synthetic test declaration; no real restaurant image.",
            "rights_confirmed":True,"origin":"restaurant_capture",
        }

    def tearDown(self):
        self.temporary.cleanup()

    def run_manifest(self,entry,**options):
        path=self.directory/"captures.json"
        path.write_text(json.dumps([entry]))
        return extract_menus("Soup  8.50 CAD",source_type="text",capture_manifest=path,restaurant_id="synthetic-restaurant",**options)

    def test_candidate_does_not_claim_verified_food_or_publish_image(self):
        result=self.run_manifest(self.entry,capture_max_age_days=7)
        self.assertEqual(result.status,"complete",result.errors)
        self.assertEqual(result.capture_requests[0].status,"needs_review")
        asset=result.capture_requests[0].candidates[0]
        self.assertEqual(asset.review_status,"needs_review")
        self.assertIsNone(result.drafts[0].image_id)
        self.assertEqual(len(asset.asset_sha256),64)
        self.assertGreater(asset.width,0)

    def test_wrong_restaurant_or_draft_id_is_rejected_without_matching_by_name(self):
        for changes in [{"restaurant_id":"other-restaurant"},{"draft_id":"other-draft"}]:
            with self.subTest(changes=changes):
                result=self.run_manifest({**self.entry,**changes})
                self.assertEqual(result.status,"incomplete")
                self.assertEqual(result.capture_requests[0].status,"capture_missing")

    def test_unknown_date_is_preserved_and_not_replaced_by_upload_time(self):
        result=self.run_manifest({**self.entry,"captured_at":None})
        asset=result.capture_requests[0].candidates[0]
        self.assertIsNone(asset.captured_at)
        self.assertIsNotNone(asset.uploaded_at)
        self.assertTrue(any("unknown" in warning for warning in asset.warnings))

    def test_stale_future_and_timezone_free_dates_are_rejected(self):
        values=[(datetime.now(timezone.utc)-timedelta(days=8)).isoformat(),(datetime.now(timezone.utc)+timedelta(days=1)).isoformat(),"2026-10-01T12:00:00"]
        for value in values:
            with self.subTest(value=value):
                result=self.run_manifest({**self.entry,"captured_at":value},capture_max_age_days=7)
                self.assertEqual(result.status,"incomplete")
                self.assertEqual(result.capture_requests[0].candidates,[])

    def test_generated_origin_or_unconfirmed_rights_are_rejected(self):
        for changes in [{"origin":"generated"},{"rights_confirmed":False}]:
            with self.subTest(changes=changes):
                result=self.run_manifest({**self.entry,**changes})
                self.assertEqual(result.status,"incomplete")
                self.assertIsNone(result.drafts[0].image_id)


if __name__=="__main__":
    unittest.main()
