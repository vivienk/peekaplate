import hashlib
import io
import json
import subprocess
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
from peekaplate_processing.spatial import MAX_MANIFEST_BYTES, prepare_spatial_bundle, read_bounded


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
        delivered_bytes=sum(path.stat().st_size for path in prepared.directory.rglob("*") if path.is_file())
        self.assertEqual(prepared.manifest.measurements.total_asset_bytes, delivered_bytes)
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

    def test_asset_id_tracks_layer_names_and_depths(self):
        first=self.prepare(output_root=self.root/"spatial-a")
        repeat=self.prepare(output_root=self.root/"spatial-a2")
        self.assertEqual(first.asset_id, repeat.asset_id)
        self.write_layers(layer_document(depths={"background":0.0, "subject":0.55, "accent":0.7}))
        deeper=self.prepare(output_root=self.root/"spatial-b")
        self.assertNotEqual(first.asset_id, deeper.asset_id)
        self.write_layers(layer_document(
            files={"background":"background.png", "subject":"subject.png", "garnish":"accent.png"},
            depths={"background":0.0, "subject":0.4, "garnish":0.7},
        ))
        renamed=self.prepare(output_root=self.root/"spatial-c")
        self.assertNotEqual(first.asset_id, renamed.asset_id)
        self.assertNotEqual(deeper.asset_id, renamed.asset_id)

    def test_manifest_records_capture_evidence_and_rights(self):
        prepared=self.prepare()
        self.assertEqual(prepared.manifest.capture_evidence, "Synthetic layered fixture; not a real dish.")
        self.assertIs(prepared.manifest.rights_confirmed, True)
        stored=SpatialManifest.model_validate_json((prepared.directory/"spatial-manifest.json").read_text())
        self.assertEqual(stored.capture_evidence, prepared.manifest.capture_evidence)
        self.assertIs(stored.rights_confirmed, True)

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

    def test_corrupt_or_mismatched_fallback_is_rejected_even_when_hash_matches(self):
        corrupt_bytes=b"not-a-jpeg"*20
        corrupt_bundle=self.root/"t0-corrupt"
        corrupt_bundle.mkdir()
        (corrupt_bundle/"detail-1280.jpg").write_bytes(corrupt_bytes)
        corrupt_doc=json.loads((self.t0.directory/"manifest.json").read_text())
        corrupt_doc["variants"]=[dict(variant) for variant in corrupt_doc["variants"]]
        for variant in corrupt_doc["variants"]:
            if variant["name"]=="detail-1280" and variant["format"]=="jpeg":
                variant["path"]="detail-1280.jpg"
                variant["sha256"]=hashlib.sha256(corrupt_bytes).hexdigest()
                variant["size_bytes"]=len(corrupt_bytes)
        (corrupt_bundle/"manifest.json").write_text(json.dumps(corrupt_doc, indent=2)+"\n")
        self.write_layers()
        with self.assertRaises(ExtractionError) as caught:
            prepare_spatial_bundle(
                t0_manifest_path=corrupt_bundle/"manifest.json", layers_manifest_path=self.layers_path,
                output_root=self.root/"spatial-corrupt", budget_bytes=400_000,
            )
        self.assertIn("fallback", str(caught.exception).lower())
        self.assertFalse((self.root/"spatial-corrupt").exists())
        resized_buf=io.BytesIO()
        with Image.open(self.t0.directory/"detail-1280.jpg") as image:
            image.resize((self.detail.width//2, self.detail.height//2)).save(resized_buf, format="JPEG")
        resized_bytes=resized_buf.getvalue()
        mismatch_bundle=self.root/"t0-mismatch"
        mismatch_bundle.mkdir()
        (mismatch_bundle/"detail-1280.jpg").write_bytes(resized_bytes)
        mismatch_doc=json.loads((self.t0.directory/"manifest.json").read_text())
        mismatch_doc["variants"]=[dict(variant) for variant in mismatch_doc["variants"]]
        for variant in mismatch_doc["variants"]:
            if variant["name"]=="detail-1280" and variant["format"]=="jpeg":
                variant["path"]="detail-1280.jpg"
                variant["sha256"]=hashlib.sha256(resized_bytes).hexdigest()
                variant["size_bytes"]=len(resized_bytes)
        (mismatch_bundle/"manifest.json").write_text(json.dumps(mismatch_doc, indent=2)+"\n")
        with self.assertRaises(ExtractionError) as caught:
            prepare_spatial_bundle(
                t0_manifest_path=mismatch_bundle/"manifest.json", layers_manifest_path=self.layers_path,
                output_root=self.root/"spatial-mismatch", budget_bytes=400_000,
            )
        self.assertIn("dimensions", str(caught.exception).lower())
        self.assertFalse((self.root/"spatial-mismatch").exists())

    def test_manifest_reads_are_bounded_before_allocation(self):
        read_sizes=[]
        real_open=Path.open
        class BoundedSpy:
            def __init__(self, handle):
                self._handle=handle
            def read(self, size=-1):
                read_sizes.append(size)
                return self._handle.read(size)
            def __enter__(self):
                self._handle.__enter__()
                return self
            def __exit__(self, *args):
                return self._handle.__exit__(*args)
        with unittest.mock.patch.object(Path, "open", autospec=True, side_effect=lambda path, *a, **kw: BoundedSpy(real_open(path, *a, **kw))):
            data=read_bounded(self.t0.directory/"manifest.json", "Invalid T0 asset manifest.")
        self.assertGreater(len(data), 0)
        self.assertEqual(read_sizes, [MAX_MANIFEST_BYTES+1])
        oversized=self.root/"oversized-manifest.json"
        oversized.write_bytes(b"{"+b" "*(MAX_MANIFEST_BYTES+50)+b"}")
        read_sizes.clear()
        with unittest.mock.patch.object(Path, "open", autospec=True, side_effect=lambda path, *a, **kw: BoundedSpy(real_open(path, *a, **kw))):
            with self.assertRaises(ExtractionError):
                read_bounded(oversized, "Invalid spatial layers manifest.")
        self.assertEqual(read_sizes, [MAX_MANIFEST_BYTES+1])

    def test_budget_accounts_for_delivered_bundle_overhead_at_exact_boundaries(self):
        prepared=self.prepare(output_root=self.root/"spatial-measured", budget_bytes=90_000)
        image_only_bytes=sum(layer.size_bytes for layer in prepared.manifest.layers)+prepared.manifest.fallback.size_bytes
        delivered_bytes=sum(path.stat().st_size for path in prepared.directory.rglob("*") if path.is_file())
        self.assertEqual(prepared.manifest.measurements.total_asset_bytes, delivered_bytes)
        self.assertGreater(delivered_bytes, image_only_bytes)
        with self.assertRaises(ExtractionError) as caught:
            self.prepare(output_root=self.root/"spatial-image-only-budget", budget_bytes=image_only_bytes)
        self.assertIn("exceed the configured budget", str(caught.exception))
        self.assertFalse((self.root/"spatial-image-only-budget").exists())
        with self.assertRaises(ExtractionError):
            self.prepare(output_root=self.root/"spatial-one-byte-short", budget_bytes=delivered_bytes-1)
        self.assertFalse((self.root/"spatial-one-byte-short").exists())
        exact=self.prepare(output_root=self.root/"spatial-exact-budget", budget_bytes=delivered_bytes)
        self.assertEqual(exact.manifest.measurements.total_asset_bytes, delivered_bytes)
        self.assertEqual(exact.manifest.measurements.budget_bytes, delivered_bytes)

    def test_harness_clamps_stored_keyboard_state_and_reverses_immediately(self):
        prepared=self.prepare(output_root=self.root/"spatial-harness")
        harness_html=(prepared.directory/"harness.html").read_text(encoding="utf-8")
        self.assertIn('<img id="fallback" src="./fallback.jpg" alt="Approved dish photo">', harness_html)
        script=harness_html.split("<script>", 1)[1].split("</script>", 1)[0]
        manifest_text=(prepared.directory/"spatial-manifest.json").read_text(encoding="utf-8")
        driver=f"""
const manifestData = {manifest_text};
const listeners = {{}};
const layerImgs = [];
function makeNode(id) {{
  return {{
    id,
    style: {{}},
    dataset: {{}},
    className: "",
    textContent: "",
    classList: {{ add() {{}} }},
    addEventListener(type, fn) {{ (listeners[type] = listeners[type] || []).push(fn); }},
    appendChild(child) {{ layerImgs.push(child); }},
    querySelector(sel) {{
      const m = sel.match(/data-layer="([^"]+)"/);
      return m ? layerImgs.find(img => img.dataset.layer === m[1]) || null : null;
    }},
    querySelectorAll() {{ return layerImgs; }},
    getBoundingClientRect() {{ return {{ left: 0, top: 0, width: 390, height: 292.5 }}; }}
  }};
}}
const nodes = {{
  stage: makeNode("stage"),
  fallback: makeNode("fallback"),
  layers: makeNode("layers"),
  status: makeNode("status"),
  metrics: makeNode("metrics"),
  "copy-metrics": makeNode("copy-metrics"),
  "copy-state": makeNode("copy-state"),
}};
globalThis.window = {{
  innerWidth: 390,
  innerHeight: 844,
  devicePixelRatio: 3,
  matchMedia: () => ({{ matches: false }}),
  CSS: {{ supports: () => true }},
}};
globalThis.CSS = globalThis.window.CSS;
globalThis.document = {{ getElementById: (id) => nodes[id] }};
globalThis.performance = {{ now: () => 10 }};
globalThis.requestAnimationFrame = () => {{}};
globalThis.navigator = {{}};
globalThis.Image = class {{
  constructor() {{ this.style = {{}}; this.dataset = {{}}; this.classList = {{ add() {{}} }}; }}
  set src(v) {{ Promise.resolve().then(() => this.onload && this.onload()); }}
}};
globalThis.fetch = () => Promise.resolve({{ ok: true, json: () => Promise.resolve(manifestData) }});
{script}
(async () => {{
  await new Promise(r => setTimeout(r, 30));
  const key = (k) => listeners.keydown.forEach(fn => fn({{ key: k, preventDefault() {{}} }}));
  const move = (clientX, clientY) => listeners.pointermove.forEach(fn => fn({{ clientX, clientY }}));
  const subject = () => layerImgs.find(img => img.dataset.layer === "subject");
  key("Home");
  for (let i = 0; i < 40; i++) key("ArrowRight");
  const saturatedYaw = nodes.layers.style.transform;
  const saturatedSubjectParallax = subject() ? subject().style.transform : null;
  key("ArrowLeft");
  const reversedYaw = nodes.layers.style.transform;
  const reversedSubjectParallax = subject() ? subject().style.transform : null;
  for (let i = 0; i < 40; i++) key("ArrowUp");
  const saturatedPitch = nodes.layers.style.transform;
  key("ArrowDown");
  const reversedPitch = nodes.layers.style.transform;
  key("Home");
  for (let i = 0; i < 40; i++) key("ArrowRight");
  move(390, 146.25);
  key("ArrowLeft");
  const mixedReversedYaw = nodes.layers.style.transform;
  const mixedSubjectParallax = subject() ? subject().style.transform : null;
  key("Home");
  for (let i = 0; i < 40; i++) key("ArrowUp");
  move(195, 0);
  key("ArrowDown");
  const mixedReversedPitch = nodes.layers.style.transform;
  key("Home");
  const resetTransform = nodes.layers.style.transform;
  const resetSubjectParallax = subject() ? subject().style.transform : null;
  console.log(JSON.stringify({{
    layersLoaded: window.__peekaplateSpatialMetrics.layersLoaded,
    spatialVisible: window.__peekaplateSpatialMetrics.spatialVisible,
    saturatedYaw,
    saturatedSubjectParallax,
    reversedYaw,
    reversedSubjectParallax,
    saturatedPitch,
    reversedPitch,
    mixedReversedYaw,
    mixedSubjectParallax,
    mixedReversedPitch,
    resetTransform,
    resetSubjectParallax,
  }}));
}})();
"""
        completed=subprocess.run(["node", "-e", driver], capture_output=True, text=True, check=True)
        result=json.loads(completed.stdout.strip())
        self.assertEqual(result["layersLoaded"], 3)
        self.assertIs(result["spatialVisible"], True)
        self.assertEqual(result["saturatedYaw"], "perspective(900px) rotateX(0deg) rotateY(3deg)")
        self.assertEqual(result["saturatedSubjectParallax"], "translate(3.2px,0px)")
        self.assertEqual(result["reversedYaw"], "perspective(900px) rotateX(0deg) rotateY(2.5deg)")
        self.assertEqual(result["reversedSubjectParallax"], "translate(2.666666666666667px,0px)")
        self.assertEqual(result["saturatedPitch"], "perspective(900px) rotateX(3deg) rotateY(2.5deg)")
        self.assertEqual(result["reversedPitch"], "perspective(900px) rotateX(2.5deg) rotateY(2.5deg)")
        self.assertEqual(result["mixedReversedYaw"], "perspective(900px) rotateX(0deg) rotateY(2.5deg)")
        self.assertEqual(result["mixedSubjectParallax"], "translate(2.666666666666667px,0px)")
        self.assertEqual(result["mixedReversedPitch"], "perspective(900px) rotateX(2.5deg) rotateY(0deg)")
        self.assertEqual(result["resetTransform"], "perspective(900px) rotateX(0deg) rotateY(0deg)")
        self.assertEqual(result["resetSubjectParallax"], "translate(0px,0px)")

    def test_harness_preserves_depth_order_for_closely_spaced_delayed_layers(self):
        self.write_layers(layer_document(depths={"background":0.0, "subject":0.0001, "accent":0.0002}))
        prepared=self.prepare(output_root=self.root/"spatial-close-depths")
        harness_html=(prepared.directory/"harness.html").read_text(encoding="utf-8")
        script=harness_html.split("<script>", 1)[1].split("</script>", 1)[0]
        manifest_text=(prepared.directory/"spatial-manifest.json").read_text(encoding="utf-8")
        driver=f"""
const manifestData = {manifest_text};
const listeners = {{}};
const layerImgs = [];
function makeNode(id) {{
  return {{
    id,
    style: {{}},
    dataset: {{}},
    className: "",
    textContent: "",
    classList: {{ add() {{}} }},
    addEventListener(type, fn) {{ (listeners[type] = listeners[type] || []).push(fn); }},
    appendChild(child) {{ layerImgs.push(child); }},
    querySelector(sel) {{
      const m = sel.match(/data-layer="([^"]+)"/);
      return m ? layerImgs.find(img => img.dataset.layer === m[1]) || null : null;
    }},
    querySelectorAll() {{ return layerImgs; }},
    getBoundingClientRect() {{ return {{ left: 0, top: 0, width: 390, height: 292.5 }}; }}
  }};
}}
const nodes = {{
  stage: makeNode("stage"),
  fallback: makeNode("fallback"),
  layers: makeNode("layers"),
  status: makeNode("status"),
  metrics: makeNode("metrics"),
  "copy-metrics": makeNode("copy-metrics"),
  "copy-state": makeNode("copy-state"),
}};
globalThis.window = {{
  innerWidth: 390,
  innerHeight: 844,
  devicePixelRatio: 3,
  matchMedia: () => ({{ matches: false }}),
  CSS: {{ supports: () => true }},
}};
globalThis.CSS = globalThis.window.CSS;
globalThis.document = {{ getElementById: (id) => nodes[id] }};
globalThis.performance = {{ now: () => 10 }};
globalThis.requestAnimationFrame = () => {{}};
globalThis.navigator = {{}};
globalThis.Image = class {{
  constructor() {{ this.style = {{}}; this.dataset = {{}}; this.classList = {{ add() {{}} }}; }}
  set src(v) {{
    const delay = String(v).includes("background") ? 40 : 1;
    setTimeout(() => this.onload && this.onload(), delay);
  }}
}};
globalThis.fetch = () => Promise.resolve({{ ok: true, json: () => Promise.resolve(manifestData) }});
{script}
(async () => {{
  await new Promise(r => setTimeout(r, 90));
  const domOrder = layerImgs.map(img => img.dataset.layer);
  const zIndices = Object.fromEntries(layerImgs.map(img => [img.dataset.layer, Number(img.style.zIndex)]));
  console.log(JSON.stringify({{
    layersLoaded: window.__peekaplateSpatialMetrics.layersLoaded,
    spatialVisible: window.__peekaplateSpatialMetrics.spatialVisible,
    domOrder,
    zIndices,
  }}));
}})();
"""
        completed=subprocess.run(["node", "-e", driver], capture_output=True, text=True, check=True)
        result=json.loads(completed.stdout.strip())
        self.assertEqual(result["layersLoaded"], 3)
        self.assertIs(result["spatialVisible"], True)
        self.assertEqual(result["domOrder"], ["subject", "accent", "background"])
        self.assertLess(result["zIndices"]["background"], result["zIndices"]["subject"])
        self.assertLess(result["zIndices"]["subject"], result["zIndices"]["accent"])

    def test_harness_responds_to_live_reduced_motion_changes(self):
        prepared=self.prepare()
        harness_html=(prepared.directory/"harness.html").read_text(encoding="utf-8")
        script=harness_html.split("<script>", 1)[1].split("</script>", 1)[0]
        manifest_text=(prepared.directory/"spatial-manifest.json").read_text(encoding="utf-8")
        driver=f"""
const manifestData = {manifest_text};
const listeners = {{}};
const layerImgs = [];
function makeNode(id) {{
  return {{
    id,
    style: {{}},
    dataset: {{}},
    className: "",
    textContent: "",
    classList: {{ add() {{}} }},
    addEventListener(type, fn) {{ (listeners[type] = listeners[type] || []).push(fn); }},
    appendChild(child) {{ layerImgs.push(child); }},
    querySelector(sel) {{
      const m = sel.match(/data-layer="([^"]+)"/);
      return m ? layerImgs.find(img => img.dataset.layer === m[1]) || null : null;
    }},
    querySelectorAll() {{ return layerImgs; }},
    getBoundingClientRect() {{ return {{ left: 0, top: 0, width: 390, height: 292.5 }}; }}
  }};
}}
const nodes = {{
  stage: makeNode("stage"),
  fallback: makeNode("fallback"),
  layers: makeNode("layers"),
  status: makeNode("status"),
  metrics: makeNode("metrics"),
  "copy-metrics": makeNode("copy-metrics"),
  "copy-state": makeNode("copy-state"),
}};
let motionMatches = false;
const changeListeners = [];
const motionQuery = {{
  get matches() {{ return motionMatches; }},
  addEventListener: (type, fn) => {{ if (type === "change") changeListeners.push(fn); }},
  removeEventListener: () => {{}},
}};
globalThis.window = {{
  innerWidth: 390,
  innerHeight: 844,
  devicePixelRatio: 3,
  matchMedia: (q) => q.includes("prefers-reduced-motion") ? motionQuery : ({{ matches: false }}),
  CSS: {{ supports: () => true }},
}};
globalThis.CSS = globalThis.window.CSS;
globalThis.document = {{ getElementById: (id) => nodes[id] }};
globalThis.performance = {{ now: () => 10 }};
globalThis.requestAnimationFrame = () => {{}};
globalThis.navigator = {{}};
globalThis.Image = class {{
  constructor() {{ this.style = {{}}; this.dataset = {{}}; this.classList = {{ add() {{}} }}; }}
  set src(v) {{
    setTimeout(() => this.onload && this.onload(), 5);
  }}
}};
globalThis.fetch = () => Promise.resolve({{ ok: true, json: () => Promise.resolve(manifestData) }});
{script}
(async () => {{
  await new Promise(r => setTimeout(r, 40));
  const initialReducedMotion = window.__peekaplateSpatialMetrics.reducedMotion;
  // Step 1: Send ArrowRight with reduced-motion false
  (listeners["keydown"] || []).forEach(fn => fn({{ key: "ArrowRight", preventDefault() {{}} }}));
  const initialLayersTransform = nodes.layers.style.transform;
  const subjectImg = layerImgs.find(img => img.dataset.layer === "subject");
  const initialSubjectTransform = subjectImg ? subjectImg.style.transform : "";
  // Step 2: Toggle reduced-motion to true live
  motionMatches = true;
  changeListeners.forEach(fn => fn({{ matches: true }}));
  const toggledReducedMotion = window.__peekaplateSpatialMetrics.reducedMotion;
  const clearedLayersTransform = nodes.layers.style.transform;
  const clearedSubjectTransform = subjectImg ? subjectImg.style.transform : "";
  // Step 3: Send ArrowRight and pointermove while reduced-motion is true
  (listeners["keydown"] || []).forEach(fn => fn({{ key: "ArrowRight", preventDefault() {{}} }}));
  (listeners["pointermove"] || []).forEach(fn => fn({{ clientX: 390, clientY: 146 }}));
  const subsequentLayersTransform = nodes.layers.style.transform;
  const subsequentSubjectTransform = subjectImg ? subjectImg.style.transform : "";
  console.log(JSON.stringify({{
    initialReducedMotion,
    initialLayersTransform,
    initialSubjectTransform,
    toggledReducedMotion,
    clearedLayersTransform,
    clearedSubjectTransform,
    subsequentLayersTransform,
    subsequentSubjectTransform,
  }}));
}})();
"""
        completed=subprocess.run(["node", "-e", driver], capture_output=True, text=True, check=True)
        result=json.loads(completed.stdout.strip())
        self.assertIs(result["initialReducedMotion"], False)
        self.assertEqual(result["initialLayersTransform"], "perspective(900px) rotateX(0deg) rotateY(0.5deg)")
        self.assertEqual(result["initialSubjectTransform"], "translate(0.5333333333333333px,0px)")
        self.assertIs(result["toggledReducedMotion"], True)
        self.assertEqual(result["clearedLayersTransform"], "")
        self.assertEqual(result["clearedSubjectTransform"], "")
        self.assertEqual(result["subsequentLayersTransform"], "")
        self.assertEqual(result["subsequentSubjectTransform"], "")

    def test_harness_counts_numeric_retry_for_constructor_named_layer(self):
        (self.layer_directory/"constructor.png").write_bytes(
            (self.layer_directory/"subject.png").read_bytes()
        )
        self.write_layers(layer_document(
            files={"background":"background.png", "constructor":"constructor.png", "accent":"accent.png"},
            depths={"background":0.0, "constructor":0.4, "accent":0.7},
        ))
        prepared=self.prepare()
        harness_html=(prepared.directory/"harness.html").read_text(encoding="utf-8")
        script=harness_html.split("<script>", 1)[1].split("</script>", 1)[0]
        manifest_text=(prepared.directory/"spatial-manifest.json").read_text(encoding="utf-8")
        driver=f"""
const manifestData = {manifest_text};
const listeners = {{}};
const layerImgs = [];
function makeNode(id) {{
  return {{
    id,
    style: {{}},
    dataset: {{}},
    className: "",
    textContent: "",
    classList: {{ add() {{}} }},
    addEventListener(type, fn) {{ (listeners[type] = listeners[type] || []).push(fn); }},
    appendChild(child) {{ layerImgs.push(child); }},
    querySelector(sel) {{
      const m = sel.match(/data-layer="([^"]+)"/);
      return m ? layerImgs.find(img => img.dataset.layer === m[1]) || null : null;
    }},
    querySelectorAll() {{ return layerImgs; }},
    getBoundingClientRect() {{ return {{ left: 0, top: 0, width: 390, height: 292.5 }}; }}
  }};
}}
const nodes = {{
  stage: makeNode("stage"),
  fallback: makeNode("fallback"),
  layers: makeNode("layers"),
  status: makeNode("status"),
  metrics: makeNode("metrics"),
  "copy-metrics": makeNode("copy-metrics"),
  "copy-state": makeNode("copy-state"),
}};
globalThis.window = {{
  innerWidth: 390,
  innerHeight: 844,
  devicePixelRatio: 3,
  matchMedia: () => ({{ matches: false }}),
  CSS: {{ supports: () => true }},
}};
globalThis.CSS = globalThis.window.CSS;
globalThis.document = {{ getElementById: (id) => nodes[id] }};
globalThis.performance = {{ now: () => 10 }};
globalThis.requestAnimationFrame = () => {{}};
globalThis.navigator = {{}};
globalThis.Image = class {{
  constructor() {{ this.style = {{}}; this.dataset = {{}}; this.classList = {{ add() {{}} }}; }}
  set src(v) {{
    const url = String(v);
    if (url.includes("constructor") && !url.includes("retry=1")) {{
      setTimeout(() => this.onerror && this.onerror(new Error("simulated first attempt failure")), 5);
      return;
    }}
    setTimeout(() => this.onload && this.onload(), 5);
  }}
}};
globalThis.fetch = () => Promise.resolve({{ ok: true, json: () => Promise.resolve(manifestData) }});
{script}
(async () => {{
  await new Promise(r => setTimeout(r, 350));
  const metrics = window.__peekaplateSpatialMetrics;
  console.log(JSON.stringify({{
    layersLoaded: metrics.layersLoaded,
    spatialVisible: metrics.spatialVisible,
    layerRetries: metrics.layerRetries,
    constructorRetryType: typeof metrics.layerRetries.constructor,
  }}));
}})();
"""
        completed=subprocess.run(["node", "-e", driver], capture_output=True, text=True, check=True)
        result=json.loads(completed.stdout.strip())
        self.assertEqual(result["layersLoaded"], 3)
        self.assertIs(result["spatialVisible"], True)
        self.assertEqual(result["layerRetries"], {"constructor": 1})
        self.assertEqual(result["constructorRetryType"], "number")
if __name__=="__main__":
    unittest.main()
