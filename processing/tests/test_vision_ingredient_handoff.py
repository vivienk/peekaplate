"""End-to-end direct-vision ingredient handoff controls.

A synthetic provider response is injected at the client seam only; no OCR, network,
credentials or accuracy claims are involved. The tests prove that transcribed
ingredients survive the persisted extraction, the review-candidate export, the
AI-02 sidecar (which stays unknown for vision transcription) and the V1 transport
envelope, while approximate vision boxes never become OCR box evidence.
"""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageDraw

from peekaplate_processing.ingredient_intelligence import build_review_handoff
from peekaplate_processing.review_candidates import (
    ReviewCandidateResult,
    export_review_candidates,
    prepare_review_candidates,
)
from peekaplate_processing.run_pipeline import run_pipeline
from peekaplate_processing.schemas import MenuExtractionResult


def _synthetic_menu(path: Path, size=(600, 400)) -> None:
    """Upright, high-contrast page so the Pillow-only preflight accepts it."""
    with Image.new("RGB", size, "white") as image:
        draw = ImageDraw.Draw(image)
        for top in range(24, size[1] - 12, 28):
            draw.rectangle((24, top, size[0] - 24, top + 3), fill="black")
        image.save(path, format="PNG")


class _SyntheticVisionLLM:
    """Stands in for the provider client; `bind`/`ainvoke` are the only seam."""

    model_name = "synthetic-vision"

    def __init__(self, payload: dict):
        self._payload = json.dumps(payload)

    def bind(self, **kwargs):
        return self

    async def ainvoke(self, messages):
        return SimpleNamespace(content=self._payload, response_metadata={"finish_reason": "stop"})


class _NoBudgetGate:
    """Keeps the test independent of ambient PEEK_BUDGET_* configuration."""

    async def areserve(self, provider):
        return None


SYNTHETIC_DISHES = {
    "dishes": [
        {
            "page_number": 1,
            "name": "Garden Plate",
            "description": "tomato, wheat and mozzarella",
            "ingredients": ["tomato", "wheat", "mozzarella"],
            "category": "SALADS",
            "price_text": "10.00",
            "price_amount": "10.00",
            "price_currency": "CAD",
            "box": [100, 100, 180, 500],
            "price_box": [190, 100, 220, 260],
        },
        {
            "page_number": 1,
            "name": "Herb Fries",
            "description": "potato with rosemary",
            "ingredients": ["potato", "rosemary"],
            "category": "SIDES",
            "price_text": "6.00",
            "price_amount": "6.00",
            "price_currency": "CAD",
            "box": [300, 100, 380, 500],
        },
    ]
}


class VisionIngredientHandoffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls._temporary.name)
        cls.image_path = cls.root / "menu.png"
        _synthetic_menu(cls.image_path)
        cls.image_bytes = cls.image_path.read_bytes()
        cls.run_dir = cls.root / "run"
        with patch(
            "peekaplate_processing.run_pipeline.create_cascading_clients",
            side_effect=AssertionError("no provider cascade may be configured"),
        ), patch(
            "peekaplate_processing.run_pipeline.configured_llm",
            side_effect=AssertionError("no configured client may be created"),
        ), patch(
            "peekaplate_processing.run_pipeline.extract_source",
            side_effect=AssertionError("no OCR may run"),
        ):
            cls.report = run_pipeline(
                cls.image_path,
                cls.run_dir,
                llm=_SyntheticVisionLLM(SYNTHETIC_DISHES),
                provider="synthetic",
                input_mode="vision_v4",
                budget_gate=_NoBudgetGate(),
                llm_timeout=10,
                llm_cache_dir=None,
            )
        cls.extraction_path = cls.run_dir / "extraction.json"
        cls.reloaded = MenuExtractionResult.model_validate_json(
            cls.extraction_path.read_text(encoding="utf-8")
        )

    @classmethod
    def tearDownClass(cls):
        cls._temporary.cleanup()

    def test_persisted_extraction_keeps_ingredients_and_traceable_descriptions(self):
        self.assertEqual(self.report.status, "complete", self.report.errors)
        self.assertTrue(self.report.configuration.get("v4_vision"))
        self.assertEqual(self.report.configuration.get("input_mode"), "vision_v4")
        self.assertEqual(
            [draft.ingredients for draft in self.reloaded.drafts],
            [["tomato", "wheat", "mozzarella"], ["potato", "rosemary"]],
        )
        segments = {segment.segment_id: segment for segment in self.reloaded.segments}
        for evidence in self.reloaded.evidence:
            self.assertEqual(evidence.box_evidence, [])
            passages = [
                segments[span.segment_id].text[span.start:span.end]
                for span in evidence.spans
            ]
            self.assertEqual(
                "\n".join(passages),
                self.reloaded.drafts[evidence.draft_index].source_text,
            )
        by_name = {draft.name: draft for draft in self.reloaded.drafts}
        self.assertIn("tomato, wheat and mozzarella", by_name["Garden Plate"].source_text)
        self.assertIn("potato with rosemary", by_name["Herb Fries"].source_text)
        page = self.reloaded.segments[0]
        self.assertEqual(page.metadata.get("text_origin"), "vision_model_transcription")
        self.assertTrue(page.metadata.get("vision_boxes"))
        recorded = [
            box for boxes in page.metadata["vision_boxes"].values() for box in boxes
        ]
        self.assertTrue(recorded)
        self.assertTrue(all(box["type"] in {"title", "price"} for box in recorded))
        self.assertNotIn("box_evidence", page.metadata)

    def test_saved_report_exports_needs_review_candidates_with_evidence(self):
        direct = prepare_review_candidates(self.reloaded)
        review_path = self.root / "review-candidates.json"
        export_review_candidates(self.extraction_path, review_path)
        exported = ReviewCandidateResult.model_validate_json(
            review_path.read_text(encoding="utf-8")
        )
        self.assertEqual(exported.model_dump(), direct.model_dump())
        self.assertEqual(len(exported.candidates), len(self.reloaded.drafts))
        segments = {segment.segment_id: segment for segment in exported.segments}
        by_name = {candidate.original.name: candidate for candidate in exported.candidates}
        self.assertEqual(
            by_name["Garden Plate"].original.ingredients,
            ["tomato", "wheat", "mozzarella"],
        )
        self.assertEqual(by_name["Herb Fries"].original.ingredients, ["potato", "rosemary"])
        for candidate in exported.candidates:
            self.assertEqual(candidate.original.status, "needs_review")
            self.assertNotIn("ingredients", candidate.missing_fields)
            self.assertTrue(candidate.evidence)
            passages = [
                segments[span.segment_id].text[span.start:span.end]
                for span in candidate.evidence
            ]
            self.assertEqual("\n".join(passages), candidate.original.source_text)
            self.assertIn(candidate.original.description, candidate.original.source_text)
            self.assertFalse(
                any("candidate_box_evidence" in segment.metadata for segment in segments.values())
            )

    def test_vision_ingredients_stay_unknown_in_ai02_and_its_sidecar(self):
        handoff = build_review_handoff(self.reloaded)
        self.assertEqual(len(handoff.assessments), 2)
        for assessment in handoff.assessments:
            self.assertEqual(assessment.status, "unknown")
            self.assertFalse(assessment.publishable)
            self.assertTrue(assessment.ingredients)
            for suggestion in assessment.ingredients:
                self.assertEqual(suggestion.status, "unknown")
                self.assertIsNone(suggestion.rule_id)
                self.assertEqual(suggestion.evidence, [])
            for group in (assessment.allergens, assessment.dietary):
                for classification in group.values():
                    self.assertEqual(classification.status, "unknown")
                    self.assertEqual(classification.ingredient_indices, [])
        sidecar = json.loads(
            (self.run_dir / "ingredient-review.json").read_text(encoding="utf-8")
        )
        self.assertFalse(sidecar["publishable"])
        self.assertEqual(len(sidecar["assessments"]), 2)
        self.assertTrue(
            all(assessment["status"] == "unknown" for assessment in sidecar["assessments"])
        )
        suggested = {
            item["original"]
            for assessment in sidecar["assessments"]
            for item in assessment["ingredients"]
        }
        self.assertEqual(
            suggested, {"tomato", "wheat", "mozzarella", "potato", "rosemary"}
        )

    def test_v1_artifact_envelope_preserves_ingredients_and_transport_marker(self):
        from fastapi.testclient import TestClient

        from peekaplate_processing.service import Settings, create_app

        digest = hashlib.sha256(self.image_bytes).hexdigest()
        report = json.loads(self.extraction_path.read_text(encoding="utf-8"))
        timings = json.loads((self.run_dir / "timings.json").read_text(encoding="utf-8"))
        self.assertEqual(report["status"], timings["status"])
        bundle = {
            "schema_version": 1,
            "report": report,
            "review_suggestions": {
                "schema_version": 1,
                "source_id": report["source"]["source_id"],
                "input_mode": "ocr_image",
                "status": report["status"],
                "suggestions": [],
            },
            "timings": timings,
        }
        secret = "synthetic-test-token-" * 3
        settings = Settings(
            secret=secret,
            source_origin="https://peekaplate-extraction-staging.vxkong.workers.dev",
        )
        client = TestClient(
            create_app(
                settings,
                source_reader=lambda job, capability: self.image_bytes,
                runner=lambda *args, **kwargs: bundle,
            )
        )
        job_id = "00000000-0000-4000-8000-000000000011"
        tenant_id = "00000000-0000-4000-8000-000000000012"
        response = client.post(
            "/extract",
            json={
                "job_id": job_id,
                "tenant_id": tenant_id,
                "source_type": "photo",
                "source_url": None,
                "source_storage_key": f"menu-ingestion/sources/{tenant_id}/{job_id}/source",
                "source_hash": digest,
                "idempotency_key": "synthetic-vision-ingredient-handoff",
            },
            headers={
                "Authorization": "Bearer " + secret,
                "X-Job-ID": job_id,
                "X-Tenant-ID": tenant_id,
                "X-Source-Hash": digest,
                "X-Source-Capability": "synthetic-job-bound-capability",
                "X-Extraction-Artifact-Bundle": "1",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["x-extraction-artifact-bundle"], "1")
        body = response.json()
        self.assertEqual(
            set(body), {"schema_version", "report", "review_suggestions", "timings"}
        )
        self.assertEqual(body["schema_version"], 1)
        self.assertEqual(
            body["report"]["drafts"][0]["ingredients"],
            ["tomato", "wheat", "mozzarella"],
        )
        self.assertEqual(body["report"]["configuration"]["input_mode"], "ocr_image")
        self.assertEqual(
            body["report"]["configuration"]["extraction_mode"], "vision_v4"
        )
        self.assertEqual(body["timings"]["input_mode"], "ocr_image")
        self.assertEqual(
            body["review_suggestions"],
            {
                "schema_version": 1,
                "source_id": report["source"]["source_id"],
                "input_mode": "ocr_image",
                "status": report["status"],
                "suggestions": [],
            },
        )
        self.assertTrue(body["report"]["segments"][0]["metadata"]["vision_boxes"])
        self.assertEqual(body["report"]["evidence"][0].get("box_evidence", []), [])


if __name__ == "__main__":
    unittest.main()