"""Internal private-artifact negotiation; existing public request/report stays intact."""
import copy
import base64
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import test_service
from peekaplate_processing.service import run_extraction


class ServiceArtifactTests(unittest.TestCase):
    def setUp(self):
        self.case=test_service.ServiceTests()
        self.case.setUp()
        self.case.report["configuration"]={"input_mode":"ocr_image"}
        self.private={"schema_version":1,"source_id":"sha256:"+self.case.digest,"input_mode":"ocr_image",
                      "status":"failed","pages":[],"suggestions":[],"batches":[],"sections":[],"warnings":[],"errors":[]}
        self.timings={"schema_version":1,"input_mode":"ocr_image","status":"failed","timings_seconds":{"total":42.5},"pages":[],"batches":[]}
        self.bundle={"schema_version":1,"report":copy.deepcopy(self.case.report),"review_suggestions":self.private,"timings":self.timings}

    def test_negotiated_bundle_preserves_final_sidecars_and_existing_report(self):
        self.case.headers["X-Extraction-Artifact-Bundle"]="1"
        self.case.runner.return_value=self.bundle
        response=self.case.send()
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers["x-extraction-artifact-bundle"],"1")
        body=response.json()
        self.assertEqual(body["report"]["source"]["sha256"],self.case.digest)
        self.assertEqual(body["timings"]["timings_seconds"]["total"],42.5)
        self.assertEqual(body["review_suggestions"],self.private)

    def test_negotiation_rejects_missing_or_cross_source_artifacts(self):
        self.case.headers["X-Extraction-Artifact-Bundle"]="1"
        for field in ["timings","review_suggestions","report"]:
            bundle=copy.deepcopy(self.bundle);bundle.pop(field)
            self.case.runner.return_value=bundle
            self.assertEqual(self.case.send().status_code,502)
        bundle=copy.deepcopy(self.bundle);bundle["review_suggestions"]["source_id"]="sha256:"+"b"*64
        self.case.runner.return_value=bundle
        self.assertEqual(self.case.send().status_code,502)
        bundle=copy.deepcopy(self.bundle);bundle["schema_version"]=2
        self.case.runner.return_value=bundle
        self.assertEqual(self.case.send().status_code,502)
        bundle=copy.deepcopy(self.bundle);bundle["vision_attempts"]={}
        self.case.runner.return_value=bundle
        self.assertEqual(self.case.send().status_code,502)

    def test_direct_vision_bundle_converts_at_v1_boundary_with_transport_marker_and_empty_suggestions(self):
        self.case.headers["X-Extraction-Artifact-Bundle"]="1"
        self.bundle["report"]["configuration"]={"input_mode":"vision_v4","v4_vision":True}
        self.bundle["report"]["segments"]=[{
            "segment_id":"sha256:"+self.case.digest+"#page-1",
            "page_number":1,
            "method":"text",
            "status":"ready",
            "text":"SYNTHETIC VISION DISH\n10.00 CAD\n",
            "native_text":None,
            "error":None,
            "warnings":[],
            "metadata":{"vision_boxes":{"page":1,"boxes":[]}}
        }]
        self.bundle["timings"]["input_mode"]="vision_v4"
        self.bundle["review_suggestions"]={
            "schema_version":1,
            "source_id":"sha256:"+self.case.digest,
            "input_mode":"vision_v4",
            "status":"failed",
            "suggestions":[],
        }
        self.case.runner.return_value=self.bundle
        response=self.case.send()
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers["x-extraction-artifact-bundle"],"1")
        body=response.json()
        self.assertEqual(set(body),{"schema_version","report","review_suggestions","timings"})
        self.assertEqual(body["schema_version"],1)
        self.assertEqual(body["report"]["configuration"]["input_mode"],"ocr_image")
        self.assertEqual(body["report"]["configuration"]["extraction_mode"],"vision_v4")
        self.assertEqual(body["report"]["segments"][0]["metadata"]["vision_boxes"],{"page":1,"boxes":[]})
        self.assertEqual(body["timings"]["input_mode"],"ocr_image")
        self.assertEqual(body["review_suggestions"],{
            "schema_version":1,
            "source_id":"sha256:"+self.case.digest,
            "input_mode":"ocr_image",
            "status":"failed",
            "suggestions":[],
        })
        self.assertNotIn("vision_attempts",body)
        null_vision=copy.deepcopy(self.bundle)
        null_vision["review_suggestions"]=None
        self.case.runner.return_value=null_vision
        self.assertEqual(self.case.send().status_code,502)


        fake_suggestions=copy.deepcopy(self.bundle)
        fake_suggestions["review_suggestions"]={
            "schema_version":1,
            "source_id":"sha256:"+self.case.digest,
            "input_mode":"ocr_image",
            "status":"failed",
            "suggestions":[{"status":"unvalidated","name":"Fake"}]
        }
        self.case.runner.return_value=fake_suggestions
        self.assertEqual(self.case.send().status_code,502)

        mismatched_source=copy.deepcopy(self.bundle)
        mismatched_source["review_suggestions"]={
            "schema_version":1,
            "source_id":"sha256:"+"c"*64,
            "input_mode":"ocr_image",
            "status":"failed",
            "suggestions":[]
        }
        self.case.runner.return_value=mismatched_source
        self.assertEqual(self.case.send().status_code,502)

        mismatched_status=copy.deepcopy(self.bundle)
        mismatched_status["review_suggestions"]={
            "schema_version":1,
            "source_id":"sha256:"+self.case.digest,
            "input_mode":"ocr_image",
            "status":"complete",
            "suggestions":[]
        }
        self.case.runner.return_value=mismatched_status
        self.assertEqual(self.case.send().status_code,502)

        bad_timings=copy.deepcopy(self.bundle)
        bad_timings["timings"]["input_mode"]="image"
        self.case.runner.return_value=bad_timings
        self.assertEqual(self.case.send().status_code,502)

    def test_ocr_fallback_retains_true_suggestions_and_rejects_invalid_bundle(self):
        self.case.headers["X-Extraction-Artifact-Bundle"]="1"
        self.bundle["report"]["configuration"]={"input_mode":"ocr_image","fallback_occurred":True}
        self.bundle["report"]["segments"]=[{
            "segment_id":"sha256:"+self.case.digest+"#page-1",
            "page_number":1,
            "method":"ocr_space_engine3",
            "status":"ready",
            "text":"SYNTHETIC OCR TEXT\n10.00 CAD\n",
            "native_text":None,
            "error":None,
            "warnings":[],
            "metadata":{"vision_boxes":{"attempted":True,"provider":"google_studio"}}
        }]
        self.bundle["timings"]["input_mode"]="ocr_image"
        self.private["suggestions"]=[{"status":"unvalidated","name":"Dish"}]
        self.bundle["review_suggestions"]=self.private
        self.case.runner.return_value=self.bundle
        result=self.case.send()
        self.assertEqual(result.status_code,200)
        body=result.json()
        self.assertEqual(set(body),{"schema_version","report","review_suggestions","timings"})
        self.assertEqual(body["schema_version"],1)
        self.assertEqual(body["report"]["configuration"]["input_mode"],"ocr_image")
        self.assertNotEqual(body["report"]["configuration"].get("extraction_mode"),"vision_v4")
        self.assertEqual(body["report"]["segments"][0]["metadata"]["vision_boxes"],
                         {"attempted":True,"provider":"google_studio"})
        self.assertEqual(body["review_suggestions"],self.private)
        self.assertEqual(body["timings"]["input_mode"],"ocr_image")
        self.assertNotIn("vision_attempts",body)

        null_suggestions=copy.deepcopy(self.bundle)
        null_suggestions["review_suggestions"]=None
        self.case.runner.return_value=null_suggestions
        self.assertEqual(self.case.send().status_code,502)

        false_mode=copy.deepcopy(self.bundle)
        false_mode["report"]["configuration"]["extraction_mode"]="vision_v4"
        self.case.runner.return_value=false_mode
        self.assertEqual(self.case.send().status_code,502)

        approved_suggestion=copy.deepcopy(self.bundle)
        approved_suggestion["review_suggestions"]["suggestions"]=[{"status":"approved"}]
        self.case.runner.return_value=approved_suggestion
        self.assertEqual(self.case.send().status_code,502)

        bad_timings=copy.deepcopy(self.bundle)
        bad_timings["timings"]["input_mode"]="vision_v4"
        self.case.runner.return_value=bad_timings
        self.assertEqual(self.case.send().status_code,502)

    def test_unknown_internal_version_fails_before_reading_source(self):
        for version in ["2", "other", "v1"]:
            self.case.headers["X-Extraction-Artifact-Bundle"]=version
            self.assertEqual(self.case.send().status_code,400)
            self.case.storage.assert_not_called()
            self.case.runner.assert_not_called()

    def test_negotiated_bundle_handles_busy_and_timeout(self):
        self.case.headers["X-Extraction-Artifact-Bundle"]="1"
        self.case.runner.side_effect=subprocess.TimeoutExpired("synthetic",700)
        timeout_res=self.case.send()
        self.assertEqual(timeout_res.status_code,504)
        self.assertEqual(timeout_res.json(),{"error":"extraction_timeout"})
        self.case.runner.side_effect=None

        def busy(*_):
            second=self.case.send()
            self.assertEqual(second.status_code,429)
            self.assertEqual(second.headers["retry-after"],"10")
            self.assertEqual(second.json(),{"error":"busy"})
            return self.bundle
        self.case.runner.side_effect=busy
        res=self.case.send()
        self.assertEqual(res.status_code,200)

    def test_public_request_is_unchanged_and_does_not_expose_private_fields(self):
        self.case.runner.return_value=self.bundle
        response=self.case.send()
        self.assertEqual(response.status_code,200)
        self.assertNotIn("review_suggestions",response.json())
        self.assertNotIn("timings",response.json())
        self.assertEqual(response.json()["source"]["sha256"],self.case.digest)
        self.assertEqual(self.case.send(input_mode="image").status_code,422)

    def test_subprocess_captures_sidecars_before_cleanup_and_selects_combined_mode(self):
        seen=[]
        def child(command,**options):
            root=Path(command[command.index("--run-dir")+1]);root.mkdir();seen.append(root)
            for name,value in [("extraction.json",self.case.report),("review-suggestions.json",self.private),("timings.json",self.timings)]:
                (root/name).write_text(json.dumps(value))
            (root/"vision-attempts.json").write_text(json.dumps({"schema_version":1,"source_id":"sha256:"+self.case.digest,"attempts":[]}))
            return subprocess.CompletedProcess(command,2)
        with patch("peekaplate_processing.service.subprocess.run",side_effect=child):
            result=run_extraction(self.case.data,"pdf",700,include_artifacts=True)
        self.assertEqual(result["timings"],self.timings)
        self.assertEqual(result["review_suggestions"],self.private)
        self.assertNotIn("vision_attempts",result)
        self.assertFalse(seen[0].exists())

    def test_shared_bundle_survives_actual_service_serialization(self):
        fixture=json.loads((Path(__file__).parent/"fixtures/service-artifacts/representative-bundle.json").read_text())
        source=fixture["report"]["source"]
        self.case.data=base64.b64decode(source["snapshot_base64"])
        self.case.digest=source["sha256"]
        self.case.storage.return_value=self.case.data
        self.case.payload["source_hash"]=self.case.digest
        self.case.headers.update({"X-Source-Hash":self.case.digest,"X-Extraction-Artifact-Bundle":"1"})
        self.case.runner.return_value=fixture
        response=self.case.send()
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(),fixture)

    def test_failed_result_exit_one_still_retains_the_valid_diagnostics(self):
        def child(command,**options):
            root=Path(command[command.index("--run-dir")+1]);root.mkdir()
            for name,value in [("extraction.json",self.case.report),("review-suggestions.json",self.private),("timings.json",self.timings)]:
                (root/name).write_text(json.dumps(value))
            (root/"vision-attempts.json").write_text(json.dumps({"schema_version":1,"source_id":"sha256:"+self.case.digest,"attempts":[]}))
            return subprocess.CompletedProcess(command,1)
        with patch("peekaplate_processing.service.subprocess.run",side_effect=child):
            bundle=run_extraction(self.case.data,"pdf",700,include_artifacts=True)
        self.assertEqual(bundle["report"]["status"],"failed")
        self.assertEqual(bundle["timings"],self.timings)
        self.assertNotIn("vision_attempts",bundle)

    def test_direct_vision_subprocess_run_extraction_captures_without_review_suggestions_file(self):
        vision_report=copy.deepcopy(self.case.report)
        vision_report["configuration"]={"input_mode":"vision_v4","v4_vision":True}
        vision_timings=copy.deepcopy(self.timings)
        vision_timings["input_mode"]="vision_v4"
        def child(command,**options):
            root=Path(command[command.index("--run-dir")+1]);root.mkdir()
            (root/"extraction.json").write_text(json.dumps(vision_report))
            (root/"timings.json").write_text(json.dumps(vision_timings))
            return subprocess.CompletedProcess(command,0)
        with patch("peekaplate_processing.service.subprocess.run",side_effect=child):
            bundle=run_extraction(self.case.data,"pdf",700,include_artifacts=True)
        self.assertEqual(bundle["schema_version"],1)
        self.assertEqual(bundle["report"]["configuration"]["input_mode"],"vision_v4")
        self.assertEqual(bundle["timings"]["input_mode"],"vision_v4")
        self.assertEqual(bundle["review_suggestions"],{
            "schema_version":1,
            "source_id":"sha256:"+self.case.digest,
            "input_mode":"ocr_image",
            "status":"failed",
            "suggestions":[],
        })
        self.assertNotIn("vision_attempts",bundle)

    def test_private_values_cannot_claim_approval_or_another_input_mode(self):
        self.case.headers["X-Extraction-Artifact-Bundle"]="1"
        for patch_value in [{"input_mode":"image"},{"suggestions":[{"status":"approved"}]}]:
            value=copy.deepcopy(self.bundle)
            value["review_suggestions"].update(patch_value)
            self.case.runner.return_value=value
            self.assertEqual(self.case.send().status_code,502)

    def test_docker_source_allowlist_cannot_reinclude_nested_private_files(self):
        rules=(Path(__file__).parents[1]/".dockerignore").read_text().splitlines()
        allow=rules.index("!src/**")
        for denied in ["**/.env","**/.env.*","**/*.local.md","**/*.jsonl","**/__pycache__"]:
            self.assertIn(denied,rules)
            self.assertGreater(rules.index(denied),allow)
        self.assertFalse(any(rule.startswith("!") for rule in rules[allow+1:]))

    def test_missing_sidecar_is_not_silently_replaced(self):
        def child(command,**options):
            root=Path(command[command.index("--run-dir")+1]);root.mkdir()
            (root/"extraction.json").write_text(json.dumps(self.case.report))
            return subprocess.CompletedProcess(command,0)
        with patch("peekaplate_processing.service.subprocess.run",side_effect=child),self.assertRaises((OSError,ValueError)):
            run_extraction(self.case.data,"pdf",700,include_artifacts=True)


if __name__=="__main__": unittest.main()
