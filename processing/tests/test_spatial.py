import hashlib
import io
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from uuid import UUID

from fixture_factory import food_photo, layered_photo
from PIL import Image
from peekaplate_processing.assets import prepare_t0_bundle
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.prepare_spatial import main
from peekaplate_processing.schemas import SpatialManifest
from peekaplate_processing.spatial import prepare_spatial_bundle


DISH_ID=UUID("11111111-1111-4111-8111-111111111111")
REVISION_ID=UUID("22222222-2222-4222-8222-222222222222")
OTHER_REVISION_ID=UUID("33333333-3333-4333-8333-333333333333")


def layer_document(*, revision_id=REVISION_ID, depths=None, files=None):
    files=files or {"background":"background.png", "subject":"subject.png", "accent":"accent.png"}
    depths=depths or {"background":0.0, "subject":0.4, "accent":0.7}
    return {
        "schema_version":1, "tier":"T1",
        "dish":{"dish_id":str(DISH_ID), "revision_id":str(revision_id)},
        "motion":{"max_yaw_degrees":3, "max_pitch_degrees":3},
        "layers":[{"name":name, "file":files[name], "depth":depths[name]} for name in files],
        "capture_evidence":"Synthetic layered fixture; not a real dish.",
        "rights_confirmed":True,
    }


class SpatialTests(unittest.TestCase):

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.root=Path(self.temporary.name)
        self.source=self.root/"source.jpg"
        self.source.write_bytes(food_photo(2400, 1800))
        self.t0=prepare_t0_bundle(
            input_path=self.source, output_root=self.root/"t0", dish_id=DISH_ID, revision_id=REVISION_ID,
            capture_evidence="Synthetic fixture; not a real restaurant photo.", captured_at=None, budget_bytes=None,
        )
        self.detail=next(variant for variant in self.t0.manifest.variants if variant.name=="detail-1280" and variant.format=="jpeg")
        self.layer_directory=self.root/"layers"
        self.layer_directory.mkdir()
        for name, data in layered_photo(self.detail.width, self.detail.height).items():
            (self.layer_directory/f"{name}.png").write_bytes(data)
        self.layers_path=self.layer_directory/"layers.json"
        self.write_layers()

    def tearDown(self):
        self.temporary.cleanup()

    def write_layers(self, document=None):
        self.layers_path.write_text(json.dumps(document or layer_document(), indent=2)+"\n")
        return self.layers_path

    def prepare(self, *, layers_path=None, output_root=None, budget_bytes=400_000):
        return prepare_spatial_bundle(
            t0_manifest_path=self.t0.directory/"manifest.json",
            layers_manifest_path=layers_path or self.layers_path,
            output_root=output_root or self.root/"spatial", budget_bytes=budget_bytes,
        )

    def test_spatial_bundle_copies_layers_and_fallback(self):
        prepared=self.prepare()
        self.assertRegex(prepared.asset_id, r"^t1_[0-9a-f]{32}$")
        self.assertEqual(prepared.manifest.source_t0, self.t0.asset_id)
        self.assertEqual(prepared.manifest.source_sha256, self.t0.manifest.source.sha256)
        self.assertEqual(prepared.manifest.dish.revision_id, REVISION_ID)
        self.assertEqual(prepared.manifest.fallback.path, "fallback.jpg")
        self.assertEqual(prepared.manifest.fallback.sha256, self.detail.sha256)
        self.assertEqual((prepared.directory/"fallback.jpg").read_bytes(), (self.t0.directory/"detail-1280.jpg").read_bytes())
        for layer in prepared.manifest.layers:
            data=(prepared.directory/layer.path).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), layer.sha256)
            self.assertEqual(len(data), layer.size_bytes)
            self.assertEqual((layer.width, layer.height), (self.detail.width, self.detail.height))
        self.assertEqual(prepared.manifest.review.status, "needs_review")
        self.assertIs(prepared.manifest.publication.eligible, False)
        self.assertEqual(prepared.manifest.measurements.budget_status, "within_budget")
        self.assertEqual(
            prepared.manifest.measurements.total_asset_bytes,
            sum(layer.size_bytes for layer in prepared.manifest.layers)+prepared.manifest.fallback.size_bytes,
        )
        harness=(prepared.directory/"harness.html").read_text(encoding="utf-8")
        self.assertIn("__peekaplateSpatialMetrics", harness)
        self.assertIn("Feasibility harness — not the diner viewer.", harness)
        manifest=SpatialManifest.model_validate_json((prepared.directory/"spatial-manifest.json").read_text())
        self.assertEqual(manifest, prepared.manifest)

    def test_revision_mismatch_is_rejected(self):
        self.write_layers(layer_document(revision_id=OTHER_REVISION_ID))
        with self.assertRaises(ExtractionError) as caught:
            self.prepare()
        self.assertIn("does not match the layers manifest", str(caught.exception))
        self.assertFalse((self.root/"spatial").exists())

    def test_layer_dimensions_alpha_and_background_rules(self):
        self.write_layers()
        wrong=self.layer_directory/"wrong.png"
        with Image.open(self.layer_directory/"subject.png") as image:
            image.resize((self.detail.width//2, self.detail.height//2)).save(wrong, format="PNG")
        self.write_layers(layer_document(files={"background":"background.png", "subject":"wrong.png", "accent":"accent.png"}))
        with self.assertRaises(ExtractionError) as caught:
            self.prepare()
        self.assertIn("Layers must share the T0 detail dimensions.", str(caught.exception))
        opaque=self.layer_directory/"opaque.png"
        with Image.open(self.layer_directory/"subject.png") as image:
            image.convert("RGB").save(opaque, format="PNG")
        self.write_layers(layer_document(files={"background":"background.png", "subject":"opaque.png", "accent":"accent.png"}))
        with self.assertRaises(ExtractionError) as caught:
            self.prepare()
        self.assertIn("Each non-background layer must include an alpha channel.", str(caught.exception))
        transparent=self.layer_directory/"transparent.png"
        image=Image.new("RGBA", (self.detail.width, self.detail.height), (0, 0, 0, 0))
        image.save(transparent, format="PNG")
        image.close()
        self.write_layers(layer_document(files={"background":"transparent.png", "subject":"subject.png", "accent":"accent.png"}))
        with self.assertRaises(ExtractionError) as caught:
            self.prepare()
        self.assertIn("Background layer must be opaque.", str(caught.exception))

    def test_motion_limits_and_budget_are_enforced(self):
        document=layer_document()
        document["motion"]={"max_yaw_degrees":3.1, "max_pitch_degrees":3}
        self.write_layers(document)
        result=main([
            "--t0-manifest", str(self.t0.directory/"manifest.json"),
            "--layers", str(self.layers_path),
            "--output-root", str(self.root/"invalid-motion"),
            "--budget-bytes", "400000",
        ])
        self.assertEqual(result, 2)
        self.assertFalse((self.root/"invalid-motion").exists())
        self.write_layers(layer_document())
        with self.assertRaises(ExtractionError) as caught:
            self.prepare(output_root=self.root/"over-budget", budget_bytes=1_000)
        self.assertIn("exceed the configured budget", str(caught.exception))
        self.assertFalse((self.root/"over-budget").exists())

    def test_create_only_refuses_second_spatial_bundle(self):
        first=self.prepare()
        before=(first.directory/"spatial-manifest.json").read_bytes()
        with self.assertRaises(ExtractionError) as caught:
            self.prepare()
        self.assertIn("already exists", str(caught.exception))
        self.assertEqual((first.directory/"spatial-manifest.json").read_bytes(), before)
        self.assertEqual(sorted(path.name for path in (self.root/"spatial").iterdir()), [first.asset_id])

    def test_fallback_larger_than_manifest_limit_is_accepted(self):
        payload=(self.t0.directory/"detail-1280.jpg").read_bytes()
        padded=payload+b"\x00"*120_000
        bundle=self.root/"t0-large"
        bundle.mkdir()
        (bundle/"detail-1280.jpg").write_bytes(padded)
        document=json.loads((self.t0.directory/"manifest.json").read_text())
        document["variants"]=[dict(variant) for variant in document["variants"]]
        for variant in document["variants"]:
            if variant["name"]=="detail-1280" and variant["format"]=="jpeg":
                variant["path"]="detail-1280.jpg"
                variant["sha256"]=hashlib.sha256(padded).hexdigest()
                variant["size_bytes"]=len(padded)
        (bundle/"manifest.json").write_text(json.dumps(document, indent=2)+"\n")
        self.assertGreater(len(padded), 100_000)
        self.write_layers()
        prepared=prepare_spatial_bundle(
            t0_manifest_path=bundle/"manifest.json", layers_manifest_path=self.layers_path,
            output_root=self.root/"spatial-large", budget_bytes=400_000,
        )
        self.assertEqual(prepared.manifest.fallback.size_bytes, len(padded))
        self.assertEqual(prepared.manifest.fallback.sha256, hashlib.sha256(padded).hexdigest())
        self.assertEqual((prepared.directory/"fallback.jpg").read_bytes(), padded)

    def test_detail_path_traversal_is_rejected(self):
        secret=self.root/"secret.jpg"
        secret.write_bytes((self.t0.directory/"detail-1280.jpg").read_bytes())
        document=json.loads((self.t0.directory/"manifest.json").read_text())
        document["variants"]=[dict(variant) for variant in document["variants"]]
        for variant in document["variants"]:
            if variant["name"]=="detail-1280" and variant["format"]=="jpeg":
                variant["path"]="../secret.jpg"
        tampered=self.root/"tampered"
        tampered.mkdir()
        (tampered/"manifest.json").write_text(json.dumps(document, indent=2)+"\n")
        self.write_layers()
        with self.assertRaises(ExtractionError) as caught:
            prepare_spatial_bundle(
                t0_manifest_path=tampered/"manifest.json", layers_manifest_path=self.layers_path,
                output_root=self.root/"traversal", budget_bytes=400_000,
            )
        self.assertIn("Invalid T0 asset manifest.", str(caught.exception))
        self.assertFalse((self.root/"traversal").exists())

    def test_failed_publish_removes_the_whole_temporary_bundle(self):
        output_root=self.root/"failed-publish"
        with unittest.mock.patch("peekaplate_processing.spatial.os.rename", side_effect=OSError("publish refused")):
            with self.assertRaises(ExtractionError) as caught:
                self.prepare(output_root=output_root)
        self.assertIn("Unable to publish the spatial asset bundle.", str(caught.exception))
        self.assertFalse(output_root.exists())
        self.assertEqual(list(output_root.rglob("*")) if output_root.exists() else [], [])


if __name__=="__main__":
    unittest.main()
