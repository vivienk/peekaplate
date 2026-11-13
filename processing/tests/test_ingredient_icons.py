import base64
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.ingredient_icons import IconStore, build_icon_handoff, export_icons, main
from peekaplate_processing.ingredient_intelligence import build_review_handoff
from peekaplate_processing.run_pipeline import main as pipeline_main
from test_ingredient_intelligence import report_for


def report(ingredients, text=None):
    if not ingredients and text is None:
        text = "Dish with ingredients unspecified"
    result = report_for(ingredients, text)
    result.status = "complete"
    raw = result.segments[0].text.encode()
    checksum = hashlib.sha256(raw).hexdigest()
    result.source.sha256 = checksum
    result.source.source_id = "sha256:" + checksum
    result.source.snapshot_base64 = base64.b64encode(raw).decode()
    result.source.size_bytes = len(raw)
    result.drafts[0].source_id = result.source.source_id
    return result


def png():
    # Synthetic shape tests transport/validation only; not reference artwork.
    picture = Image.new("RGBA", (32, 32))
    picture.putpixel((16, 16), (255, 120, 80, 255))
    output = io.BytesIO()
    picture.save(output, format="PNG")
    return output.getvalue()


class IngredientIconTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = IconStore(self.root / "catalogue")

    def register(self, **kwargs):
        return self.store.register(png(), ingredient_id="salmon", origin="curated",
                                   provenance="Synthetic test", recipe="test.v1", rights_confirmed=True, **kwargs)

    def test_reviewed_art_mapping_is_still_unpublishable_and_preserves_gate(self):
        source = report(["salmon", "sesame seeds", "grilled chicken"])
        before = source.model_dump(mode="json")
        classification = build_review_handoff(source).model_dump(mode="json")
        key = self.register()
        self.store.review(key, status="approved", reviewer="test reviewer", reason="synthetic approval")
        result = build_icon_handoff(source, store=self.store, selections={"salmon": key})
        entries = result["dishes"][0]["ingredients"]
        self.assertEqual(entries[0]["icon"]["asset_id"], key)
        self.assertEqual(entries[1]["ingredient_id"], "sesame")
        self.assertEqual(entries[2]["ingredient_id"], "grilled-chicken")
        self.assertTrue(all(e["status"] == "needs_review" for e in entries))
        self.assertFalse(result["publishable"])
        self.assertTrue(result["owner_confirmation_required"])
        self.assertEqual(source.model_dump(mode="json"), before)
        self.assertEqual(build_review_handoff(source).model_dump(mode="json"), classification)

    def test_missing_pending_rejected_and_wrong_ingredient_are_text(self):
        key = self.register()
        self.assertIsNone(self.store.resolve(key, "salmon"))
        self.store.review(key, status="rejected", reviewer="test", reason="wrong style")
        self.assertIsNone(self.store.resolve(key, "salmon"))
        with self.assertRaises(ExtractionError):
            self.store.review(key, status="approved", reviewer="test", reason="overwrite")
        result = build_icon_handoff(report(["salmon"]), store=self.store, selections={"salmon": key})
        self.assertEqual(result["dishes"][0]["ingredients"][0]["fallback"], "text")
        self.assertIsNone(self.store.resolve("a" * 64, "salmon"))
        self.assertIsNone(self.store.resolve("../../private", "salmon"))

    def test_corruption_and_missing_bytes_never_reuse_approved_art(self):
        key = self.register()
        self.store.review(key, status="approved", reviewer="test", reason="ok")
        self.assertIsNone(self.store.resolve(key, "carrot"))
        asset = self.store.asset(key)
        self.store._path("blobs", asset.asset_sha256).write_text('{"base64":"eA=="}')
        self.assertIsNone(self.store.resolve(key, "salmon"))

    def test_no_recipe_completion_or_qualified_vision_inference(self):
        for source in [report(["salmon"], "Dish without salmon"),
                       report(["salmon"], "Dish may contain salmon"),
                       report(["salmon"], "Dish with carrot"),
                       report(["house sauce"]), report(["chicken"]), report(["rice"])]:
            result = build_icon_handoff(source)
            entry = result["dishes"][0]["ingredients"][0]
            self.assertEqual(entry["fallback"], "text")
            self.assertIsNone(entry["icon"])
        vision = report(["salmon"])
        vision.configuration["extraction_mode"] = "vision_v4"
        self.assertIsNone(build_icon_handoff(vision)["dishes"][0]["ingredients"][0]["ingredient_id"])
        for missing in [None, []]:
            self.assertEqual(build_icon_handoff(report(missing))["dishes"][0]["ingredients_state"], "unknown")

    def test_deeply_nested_corrupt_catalogue_falls_back_to_text(self):
        key = self.register()
        self.store._path("assets", key).write_text("[" * 2000 + "0" + "]" * 2000)
        result = build_icon_handoff(report(["salmon"]), store=self.store, selections={"salmon": key})
        self.assertEqual(result["dishes"][0]["ingredients"][0]["fallback"], "text")

    def test_cache_identity_is_stable_and_changes_with_evidence_and_review(self):
        source = report(["salmon"])
        first = build_icon_handoff(source)
        self.assertEqual(first, build_icon_handoff(source))
        self.assertNotEqual(first["cache_key"], build_icon_handoff(report(["salmon"], "New dish salmon"))["cache_key"])
        key = self.register()
        self.assertEqual(key, self.register())
        self.store.review(key, status="approved", reviewer="test", reason="ok")
        approved = build_icon_handoff(source, store=self.store, selections={"salmon": key})
        self.assertNotEqual(first["cache_key"], approved["cache_key"])

    def test_bad_source_and_offsets_rejected(self):
        for mutate in [lambda r: setattr(r.source, "sha256", "b" * 64),
                       lambda r: setattr(r.evidence[0].spans[0], "end", 99999)]:
            source = report(["salmon"])
            mutate(source)
            with self.assertRaises(ValueError):
                build_icon_handoff(source)

    def test_import_rejects_non_images_opaque_and_unconfirmed_rights(self):
        for data, rights in [(b"<svg onload='x'/>", True), (png(), False)]:
            with self.assertRaises((ValueError, OSError)):
                self.store.register(data, ingredient_id="salmon", origin="generated",
                                    provenance="test", recipe="model/prompt.v1", rights_confirmed=rights)
        opaque = io.BytesIO()
        Image.new("RGB", (32, 32)).save(opaque, format="PNG")
        with self.assertRaises(ValueError):
            self.store.register(opaque.getvalue(), ingredient_id="salmon", origin="curated",
                                provenance="test", recipe="test", rights_confirmed=True)

    def test_cli_and_existing_pipeline_opt_in_preserve_output(self):
        source = report(["salmon"])
        input_path, output_path = self.root / "extraction.json", self.root / "icons.json"
        input_path.write_text(source.model_dump_json(), encoding="utf-8")
        self.assertEqual(main(["--input", str(input_path), "--output", str(output_path)]), 0)
        self.assertEqual(json.loads(output_path.read_text()), build_icon_handoff(source))
        with self.assertRaises(ExtractionError):
            export_icons(input_path, output_path)
        with patch("peekaplate_processing.run_pipeline.run_pipeline", return_value=source):
            self.assertEqual(pipeline_main(["--input", "unused.pdf", "--run-dir", str(self.root), "--ingredient-icons"]), 0)
        self.assertEqual(json.loads((self.root / "ingredient-icons.json").read_text()), build_icon_handoff(source))


if __name__ == "__main__":
    unittest.main()
