import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.ingredient_icons import IconStore, build_icon_handoff, ingredient_identity
from peekaplate_processing.ingredient_intelligence import build_review_handoff
from peekaplate_processing.ingredient_icon_generation import (
    GeminiImageProvider, plan_generation, generate_missing, export_preview, generation_request, request_lock,
)
from peekaplate_processing.run_pipeline import main as pipeline_main
from test_ingredient_icons import report, png


class FakeImages:
    name = "test"
    model = "synthetic-v1"

    def __init__(self):
        self.calls = []

    def generate(self, request):
        self.calls.append(request)
        return png()


class IngredientGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = IconStore(self.root / "catalogue")
        self.provider = FakeImages()

    def generate(self, source, budget=2):
        return generate_missing(source, store=self.store, provider=self.provider,
                                max_requests=budget, rights_confirmed=True)

    def test_coconut_detects_generates_stores_preview_and_reuses_without_approval(self):
        source = report(["coconut", "COCONUT"])
        facts = build_review_handoff(source).model_dump()
        original = source.model_dump()
        result = self.generate(source)
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(result["jobs"][0]["state"], "generated")
        self.assertEqual(result["jobs"][0]["status"], "needs_review")
        asset = self.store.asset(result["jobs"][0]["asset_id"])
        self.assertEqual(asset.ingredient_id, ingredient_identity("coconut"))
        self.assertEqual(asset.origin, "generated")
        self.assertIn('"coconut"', self.provider.calls[0]["prompt"])
        export_preview(self.store, result, self.root / "review")
        self.assertEqual(len(list((self.root / "review").glob("*.png"))), 1)
        self.assertIn("coconut", (self.root / "review/index.html").read_text())
        second = self.generate(source, budget=0)
        self.assertEqual(second["provider_requests"], 0)
        self.assertEqual(second["jobs"][0]["state"], "cached")
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(build_review_handoff(source).model_dump(), facts)
        self.assertEqual(source.model_dump(), original)
        self.assertFalse(result["publishable"])
        proposal = build_icon_handoff(source, store=self.store, selections={asset.ingredient_id: result["jobs"][0]["asset_id"]})
        self.assertIsNone(proposal["dishes"][0]["ingredients"][0]["icon"])

    def test_unknown_names_are_distinct_not_recipe_or_preparation_inference(self):
        source = report(["coconut", "coconut milk", "dragon fruit", "rice", "sushi rice"])
        result = self.generate(source, budget=5)
        self.assertEqual(result["provider_requests"], 5)
        self.assertEqual(len({r["ingredient_id"] for r in self.provider.calls}), 5)
        self.assertNotEqual(ingredient_identity("coconut"), ingredient_identity("coconut milk"))

    def test_missing_qualified_and_invented_ingredients_do_not_generate(self):
        for source in [report(None), report([]), report(["coconut"], "No coconut"),
                       report(["coconut"], "Bowl of rice"), report(["egg"], "eggplant")]:
            self.assertEqual(self.generate(source)["provider_requests"], 0)

    def test_vision_candidates_can_get_private_art_without_grounding_or_approval(self):
        source = report(["coconut"])
        source.configuration["extraction_mode"] = "vision_v4"
        before = build_review_handoff(source).model_dump()
        result = self.generate(source)
        self.assertEqual(result["plan"]["grounding"], "vision_unverified")
        self.assertEqual(result["provider_requests"], 1)
        self.assertEqual(build_review_handoff(source).model_dump(), before)
        self.assertIsNone(build_icon_handoff(source)["dishes"][0]["ingredients"][0]["ingredient_id"])

    def test_budget_lock_and_bad_asset_do_not_fake_success(self):
        source = report(["coconut", "apple"])
        result = self.generate(source, budget=1)
        self.assertEqual([j["state"] for j in result["jobs"]], ["generated", "budget_exhausted"])
        request = generation_request("carrot", provider=self.provider.name, model=self.provider.model)
        with request_lock(self.store, request["request_id"]):
            result = self.generate(report(["carrot"]))
            self.assertEqual(result["jobs"][0]["state"], "failed")
        self.provider.generate = lambda request: b"not an image"
        result = self.generate(report(["carrot"]))
        self.assertEqual(result["jobs"][0]["state"], "failed")
        self.assertFalse(self.store._path("generation", request["request_id"]).exists())

    def test_provider_exception_is_sanitized_and_prompt_contains_only_label(self):
        def broken(request):
            raise ExtractionError("secret=do-not-print")
        self.provider.generate = broken
        result = self.generate(report(["coconut"], "Private restaurant description with coconut"))
        self.assertNotIn("do-not-print", json.dumps(result))
        self.assertNotIn("Private restaurant", json.dumps(result))
        self.assertEqual(result["jobs"][0]["state"], "failed")

    def test_model_changes_cache_and_corruption_fails_closed(self):
        source = report(["coconut"])
        result = self.generate(source)
        key = result["jobs"][0]["request_id"]
        self.store._path("generation", key).write_text('{}')
        self.assertEqual(self.generate(source)["jobs"][0]["state"], "failed")
        self.assertEqual(len(self.provider.calls), 1)
        self.provider.model = "new-model"
        self.assertEqual(self.generate(source)["jobs"][0]["state"], "generated")

    def test_gemini_request_header_and_actual_response_parser(self):
        provider = GeminiImageProvider("synthetic-key")
        request = generation_request("coconut", provider=provider.name, model=provider.model)
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"candidates": [{"finishReason": "STOP", "content": {
            "parts": [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(png()).decode()}}]}}]}).encode()
        opener = MagicMock()
        opener.open.return_value = response
        with patch("peekaplate_processing.ingredient_icon_generation.build_opener", return_value=opener):
            self.assertEqual(provider.generate(request), png())
        actual = opener.open.call_args.args[0]
        self.assertNotIn("synthetic-key", actual.full_url)
        self.assertEqual(actual.get_header("X-goog-api-key"), "synthetic-key")
        self.assertEqual(json.loads(actual.data)["generationConfig"]["responseModalities"], ["TEXT", "IMAGE"])

    def test_full_pipeline_cli_invokes_generation_and_writes_review(self):
        source = report(["coconut"])
        run = self.root / "run"
        run.mkdir()
        (run / "extraction.json").write_text(source.model_dump_json())
        with patch("peekaplate_processing.run_pipeline.run_pipeline", return_value=source), patch(
                "peekaplate_processing.ingredient_icon_generation.GeminiImageProvider", return_value=self.provider):
            code = pipeline_main(["--input", "synthetic.pdf", "--run-dir", str(run),
                                  "--generate-ingredient-icons", "--icon-rights-confirmed", "--max-icon-requests", "1",
                                  "--icon-catalogue", str(self.root / "catalogue")])
        self.assertEqual(code, 0)
        self.assertTrue((run / "ingredient-artwork/index.html").exists())
        self.assertEqual(len(self.provider.calls), 1)

    def test_malformed_provider_shapes_become_failed_jobs_and_continue(self):
        provider = GeminiImageProvider("synthetic-key")
        malformed = [[], {"candidates": None}, {"candidates": [None]},
                     {"candidates": [{"finishReason": "STOP", "content": []}]},
                     {"candidates": [{"finishReason": "STOP", "content": {"parts": [None]}}]},
                     {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": []}]}}]}]
        for payload in malformed:
            with self.subTest(payload=payload):
                response = MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps(payload).encode()
                opener = MagicMock()
                opener.open.return_value = response
                with patch("peekaplate_processing.ingredient_icon_generation.build_opener", return_value=opener):
                    result = generate_missing(report(["coconut", "apple"]), store=self.store, provider=provider,
                                              max_requests=2, rights_confirmed=True)
                self.assertEqual([j["state"] for j in result["jobs"]], ["failed", "failed"])
                self.assertEqual(result["provider_requests"], 2)
                self.assertNotIn("synthetic-key", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
