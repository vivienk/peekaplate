import hashlib
import json
import tempfile
import unittest
import unittest.mock
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

from fixture_factory import food_photo
from peekaplate_processing.assets import prepare_t0_bundle
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.prepare_assets import main
from peekaplate_processing.schemas import AssetManifest


DISH_ID=UUID("11111111-1111-4111-8111-111111111111")
REVISION_ID=UUID("22222222-2222-4222-8222-222222222222")
EVIDENCE="Synthetic fixture; not a real restaurant photo."


class AssetTests(unittest.TestCase):

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.root=Path(self.temporary.name)
        self.source=self.root/"source.jpg"
        self.source.write_bytes(food_photo())

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self, *, output_root=None, input_path=None, capture_evidence=EVIDENCE, captured_at=None, budget_bytes=None, dish_id=DISH_ID, revision_id=REVISION_ID):
        return prepare_t0_bundle(
            input_path=input_path or self.source, output_root=output_root or self.root/"t0",
            dish_id=dish_id, revision_id=revision_id, capture_evidence=capture_evidence,
            captured_at=captured_at, budget_bytes=budget_bytes,
        )

    def test_bundle_is_deterministic_and_hash_addressed(self):
        first=self.prepare(output_root=self.root/"first")
        second=self.prepare(output_root=self.root/"second")
        self.assertEqual(first.asset_id, second.asset_id)
        self.assertRegex(first.asset_id, r"^t0_[0-9a-f]{32}$")
        self.assertEqual([variant.sha256 for variant in first.manifest.variants], [variant.sha256 for variant in second.manifest.variants])
        self.assertEqual(
            sorted((variant.name, variant.format) for variant in first.manifest.variants),
            [("card-480", "jpeg"), ("card-480", "webp"), ("detail-1280", "jpeg"), ("detail-1280", "webp")],
        )
        for variant in first.manifest.variants:
            self.assertEqual(hashlib.sha256((first.directory/variant.path).read_bytes()).hexdigest(), variant.sha256)
            self.assertLessEqual(max(variant.width, variant.height), 480 if variant.name=="card-480" else 1280)
        manifest=AssetManifest.model_validate_json((first.directory/"manifest.json").read_text())
        self.assertEqual(manifest, first.manifest)
        self.assertEqual(manifest.source.sha256, hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual((manifest.source.width, manifest.source.height), (2000, 1500))
        self.assertEqual((first.directory/manifest.source.path).read_bytes(), self.source.read_bytes())

    def test_create_only_refuses_second_bundle(self):
        first=self.prepare()
        before=(first.directory/"manifest.json").read_bytes()
        with self.assertRaises(ExtractionError) as caught:
            self.prepare()
        self.assertIn("already exists", str(caught.exception))
        self.assertEqual((first.directory/"manifest.json").read_bytes(), before)
        self.assertEqual(sorted(path.name for path in (self.root/"t0").iterdir()), [first.asset_id])

    def test_orientation_and_alpha_are_normalized(self):
        oriented=self.root/"oriented.jpg"
        oriented.write_bytes(food_photo(1200, 900, orientation=6))
        prepared=self.prepare(output_root=self.root/"oriented", input_path=oriented)
        self.assertEqual((prepared.manifest.source.width, prepared.manifest.source.height), (900, 1200))
        for variant in prepared.manifest.variants:
            self.assertLessEqual(max(variant.width, variant.height), 1280)
            self.assertEqual(variant.format, "webp" if variant.path.endswith(".webp") else "jpeg")
        from PIL import Image
        alpha=self.root/"alpha.png"
        image=Image.new("RGBA", (600, 400), (0, 0, 0, 0))
        image.save(alpha, format="PNG")
        image.close()
        flattened=self.prepare(output_root=self.root/"alpha", input_path=alpha)
        with Image.open(flattened.directory/"card-480.jpg") as card:
            self.assertEqual(card.mode, "RGB")
            self.assertEqual(card.size, (480, 320))
            self.assertGreater(min(card.getpixel((0, 0))), 240)
        with Image.open(flattened.directory/"card-480.webp") as card:
            self.assertEqual(card.mode, "RGB")
        self.assertTrue(any("not upscaled" in warning for warning in flattened.manifest.review.warnings))

    def test_invalid_source_and_budget_fail_without_output(self):
        corrupt=self.root/"corrupt.jpg"
        corrupt.write_bytes(b"not-an-image"*64)
        cases=[
            ({"input_path":corrupt}, "Unsupported"),
            ({"budget_bytes":1}, "exceed the configured budget"),
            ({"capture_evidence":"   "}, "Capture evidence is required"),
            ({"captured_at":datetime.now(timezone.utc)+timedelta(days=1)}, "must not be in the future"),
            ({"captured_at":datetime(2026, 1, 1)}, "must include a timezone"),
        ]
        for index, (options, expected) in enumerate(cases):
            output_root=self.root/f"case-{index}"
            result=main([
                "--input", str(options.get("input_path", self.source)),
                "--dish-id", str(DISH_ID), "--revision-id", str(REVISION_ID),
                "--capture-evidence", options.get("capture_evidence", EVIDENCE),
                "--output-root", str(output_root),
                *(["--captured-at", options["captured_at"].isoformat()] if "captured_at" in options else []),
                *(["--budget-bytes", str(options["budget_bytes"])] if "budget_bytes" in options else []),
            ])
            self.assertEqual(result, 2, expected)
            self.assertFalse(output_root.exists(), expected)

    def test_failed_publish_removes_the_whole_temporary_bundle(self):
        output_root=self.root/"failed-publish"
        with unittest.mock.patch("peekaplate_processing.assets.os.rename", side_effect=OSError("publish refused")):
            with self.assertRaises(ExtractionError) as caught:
                self.prepare(output_root=output_root)
        self.assertIn("Unable to publish the asset bundle.", str(caught.exception))
        self.assertFalse(output_root.exists())

    def test_manifest_never_self_approves(self):
        prepared=self.prepare(budget_bytes=400_000, captured_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc))
        manifest=prepared.manifest
        self.assertEqual(manifest.review.status, "needs_review")
        self.assertTrue(manifest.review.warnings)
        self.assertIs(manifest.publication.eligible, False)
        self.assertTrue(manifest.publication.reason)
        self.assertEqual(manifest.measurements.budget_status, "within_budget")
        self.assertEqual(manifest.measurements.total_variant_bytes, sum(variant.size_bytes for variant in manifest.variants))
        self.assertEqual(manifest.processing.steps, ["decode", "orient", "resize", "encode_webp", "encode_jpeg", "hash"])
        self.assertEqual(manifest.processing.engine_version, manifest.processing.engine_version.strip())
        document=json.loads((prepared.directory/"manifest.json").read_text())
        self.assertIs(document["publication"]["eligible"], False)


if __name__=="__main__":
    unittest.main()
