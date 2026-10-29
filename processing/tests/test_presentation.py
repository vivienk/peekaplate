import hashlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from uuid import UUID

from PIL import Image, ImageDraw
from fixture_factory import cutout_photo, food_photo, presentation_photo
from peekaplate_processing.assets import prepare_t0_bundle
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.prepare_presentation import main as prepare_presentation_main
from peekaplate_processing.presentation import (
    PRESENTATION_FILENAME,
    PRESENTATION_PROMPT,
    PRESENTATION_PROMPT_VERSION,
    FilePresentationProvider,
    PresentationManifest,
    PresentationRequest,
    build_multimodal_messages,
    prepare_presentation_bundle,
    validate_presentation_png,
)

DISH_ID = UUID("11111111-1111-4111-8111-111111111111")
REVISION_ID = UUID("22222222-2222-4222-8222-222222222222")
DRAFT_ID = "draft-menu-item-42"


class PresentationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.jpg"
        self.source.write_bytes(food_photo(2400, 1800))
        self.t0 = prepare_t0_bundle(
            input_path=self.source,
            output_root=self.root / "t0",
            dish_id=DISH_ID,
            revision_id=REVISION_ID,
            capture_evidence="Permitted source capture; see the private log.",
            captured_at=None,
            budget_bytes=None,
        )
        self.t0_manifest_path = self.t0.directory / "manifest.json"
        self.detail_variant = next(
            v for v in self.t0.manifest.variants if v.name == "detail-1280" and v.format == "jpeg"
        )
        self.detail_bytes = (self.t0.directory / self.detail_variant.path).read_bytes()

        self.cutout_path = self.root / "cutout.png"
        self.cutout_bytes = cutout_photo(1280, 960)
        self.cutout_path.write_bytes(self.cutout_bytes)

        self.ref_path = self.root / "reference.jpg"
        self.ref_bytes = food_photo(1200, 1200)
        self.ref_path.write_bytes(self.ref_bytes)

        self.valid_png_bytes = presentation_photo(2048, 2048, transparent_corners=True, has_alpha=True)
        self.valid_candidate = self.root / "candidate.png"
        self.valid_candidate.write_bytes(self.valid_png_bytes)

    def tearDown(self):
        self.temporary.cleanup()

    def test_valid_2048_transparent_presentation_bundle_links_provenance_and_stays_needs_review(self):
        provider = FilePresentationProvider(
            candidate_bytes=self.valid_png_bytes,
            model_version="test-model-v1",
        )
        prepared = prepare_presentation_bundle(
            t0_manifest_path=self.t0_manifest_path,
            cutout_path=self.cutout_path,
            reference_path=self.ref_path,
            output_root=self.root / "pres",
            capture_evidence="Permitted studio capture for dish 11111111-1111-4111-8111-111111111111.",
            rights_confirmed=True,
            draft_id=DRAFT_ID,
            budget_bytes=None,
            provider=provider,
            model_version="test-model-v1",
        )
        self.assertRegex(prepared.asset_id, r"^pres_[0-9a-f]{32}$")
        manifest_file = prepared.directory / "presentation-manifest.json"
        self.assertTrue(manifest_file.exists())
        manifest = PresentationManifest.model_validate_json(manifest_file.read_text(encoding="utf-8"))

        self.assertEqual(manifest.source_t0, self.t0.manifest.asset_id)
        self.assertEqual(manifest.source_sha256, self.t0.manifest.source.sha256)
        self.assertEqual(manifest.cutout.sha256, hashlib.sha256(self.cutout_bytes).hexdigest())
        self.assertEqual(manifest.reference.sha256, hashlib.sha256(self.ref_bytes).hexdigest())
        self.assertEqual(manifest.prompt.prompt_version, PRESENTATION_PROMPT_VERSION)
        self.assertEqual(manifest.prompt.model_version, "test-model-v1")
        self.assertEqual(manifest.dish.dish_id, DISH_ID)
        self.assertEqual(manifest.dish.revision_id, REVISION_ID)
        self.assertEqual(manifest.draft_id, DRAFT_ID)

        self.assertEqual(manifest.review.status, "needs_review")
        self.assertFalse(manifest.publication.eligible)
        self.assertEqual(manifest.active_display_path, "fallback.jpg")
        self.assertFalse(manifest.fallback_retained)
        self.assertEqual(manifest.processing.status, "ready")
        self.assertIsNotNone(manifest.presentation)
        self.assertEqual(manifest.presentation.width, 2048)
        self.assertEqual(manifest.presentation.height, 2048)

        fallback_file = prepared.directory / "fallback.jpg"
        self.assertEqual(fallback_file.read_bytes(), self.detail_bytes)
        pres_file = prepared.directory / PRESENTATION_FILENAME
        self.assertEqual(pres_file.read_bytes(), self.valid_png_bytes)

    def test_multimodal_request_embeds_cutout_and_reference_image_bytes_with_exact_prompt(self):
        req = PresentationRequest(
            cutout_path=self.cutout_path,
            cutout_bytes=self.cutout_bytes,
            reference_path=self.ref_path,
            reference_bytes=self.ref_bytes,
            model_version="test-model-v1",
        )
        messages = build_multimodal_messages(req)
        self.assertEqual(len(messages), 1)
        user_message = messages[0]
        self.assertEqual(user_message["role"], "user")
        content = user_message["content"]
        self.assertEqual(len(content), 3)

        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[0]["text"], PRESENTATION_PROMPT)

        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

        self.assertEqual(content[2]["type"], "image_url")
        self.assertTrue(content[2]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

        # Rejects directory path
        with self.assertRaises(ExtractionError):
            build_multimodal_messages(
                PresentationRequest(
                    cutout_path=self.cutout_path,
                    cutout_bytes=self.cutout_bytes,
                    reference_path=self.root,  # Directory!
                    reference_bytes=self.ref_bytes,
                    model_version="test-model-v1",
                )
            )

    def test_opaque_non_square_or_over_budget_candidate_retains_t0_fallback(self):
        # 1. Non-square PNG candidate
        non_square_bytes = presentation_photo(1280, 960, transparent_corners=True, has_alpha=True)
        provider = FilePresentationProvider(candidate_bytes=non_square_bytes)
        prepared = prepare_presentation_bundle(
            t0_manifest_path=self.t0_manifest_path,
            cutout_path=self.cutout_path,
            reference_path=self.ref_path,
            output_root=self.root / "pres-nonsquare",
            capture_evidence="Permitted studio capture.",
            provider=provider,
        )
        self.assertEqual(prepared.manifest.processing.status, "fallback_retained")
        self.assertTrue(prepared.manifest.fallback_retained)
        self.assertIsNone(prepared.manifest.presentation)
        self.assertEqual(prepared.manifest.active_display_path, "fallback.jpg")
        self.assertFalse(prepared.manifest.publication.eligible)
        self.assertTrue((prepared.directory / "fallback.jpg").exists())
        self.assertFalse((prepared.directory / PRESENTATION_FILENAME).exists())
        self.assertEqual((prepared.directory / "fallback.jpg").read_bytes(), self.detail_bytes)

        # 2. Opaque corners PNG candidate
        # Candidate with transparent areas but opaque corners (e.g. baked-in border or watermark at corner)
        corner_img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
        draw = ImageDraw.Draw(corner_img)
        draw.ellipse((200, 200, 800, 800), fill=(192, 57, 43, 255))
        corner_img.putpixel((0, 0), (200, 200, 200, 255))
        out_buf = io.BytesIO()
        corner_img.save(out_buf, format="PNG")
        opaque_corners_bytes = out_buf.getvalue()

        provider_opaque = FilePresentationProvider(candidate_bytes=opaque_corners_bytes)
        prepared_opaque = prepare_presentation_bundle(
            t0_manifest_path=self.t0_manifest_path,
            cutout_path=self.cutout_path,
            reference_path=self.ref_path,
            output_root=self.root / "pres-opaque",
            capture_evidence="Permitted studio capture.",
            provider=provider_opaque,
        )
        self.assertEqual(prepared_opaque.manifest.processing.status, "fallback_retained")
        self.assertTrue(prepared_opaque.manifest.fallback_retained)
        self.assertIsNone(prepared_opaque.manifest.presentation)
        self.assertTrue(any("transparent corners" in e for e in prepared_opaque.manifest.processing.validation_errors))

        # 3. Over-budget candidate
        provider_valid = FilePresentationProvider(candidate_bytes=self.valid_png_bytes)
        prepared_budget = prepare_presentation_bundle(
            t0_manifest_path=self.t0_manifest_path,
            cutout_path=self.cutout_path,
            reference_path=self.ref_path,
            output_root=self.root / "pres-budget",
            capture_evidence="Permitted studio capture.",
            budget_bytes=10,  # 10 bytes budget is exceeded
            provider=provider_valid,
        )
        self.assertEqual(prepared_budget.manifest.processing.status, "fallback_retained")
        self.assertTrue(prepared_budget.manifest.fallback_retained)
        self.assertEqual(prepared_budget.manifest.measurements.budget_status, "exceeded_fallback_retained")

    def test_reconstructed_details_and_viewpoint_limitations_are_recorded_in_warnings(self):
        provider = FilePresentationProvider(
            candidate_bytes=self.valid_png_bytes,
            reconstructed_details_flagged=True,
            preserved_original_viewpoint=True,
            fidelity_notes=["Bottom right edge was cropped in source photograph."],
        )
        prepared = prepare_presentation_bundle(
            t0_manifest_path=self.t0_manifest_path,
            cutout_path=self.cutout_path,
            reference_path=self.ref_path,
            output_root=self.root / "pres-fidelity",
            capture_evidence="Permitted studio capture.",
            provider=provider,
        )
        self.assertTrue(prepared.manifest.prompt.reconstructed_details_flagged)
        self.assertTrue(prepared.manifest.prompt.preserved_original_viewpoint)
        self.assertEqual(
            prepared.manifest.prompt.fidelity_notes,
            ["Bottom right edge was cropped in source photograph."],
        )
        warnings_text = " ".join(prepared.manifest.review.warnings)
        self.assertIn("Reconstructed details flagged", warnings_text)
        self.assertIn("Preserved original viewpoint", warnings_text)
        self.assertIn("Bottom right edge was cropped", warnings_text)

    def test_opaque_cutout_or_directory_reference_fails_before_output(self):
        opaque_cutout = self.root / "opaque_cutout.png"
        opaque_cutout.write_bytes(presentation_photo(1280, 960, transparent_corners=False, has_alpha=False))
        provider = FilePresentationProvider(candidate_bytes=self.valid_png_bytes)

        output_root = self.root / "failed-cutout-root"
        with self.assertRaises(ExtractionError):
            prepare_presentation_bundle(
                t0_manifest_path=self.t0_manifest_path,
                cutout_path=opaque_cutout,
                reference_path=self.ref_path,
                output_root=output_root,
                capture_evidence="Permitted studio capture.",
                provider=provider,
            )
        self.assertFalse(output_root.exists())

        output_root_dir = self.root / "failed-ref-root"
        with self.assertRaises(ExtractionError):
            prepare_presentation_bundle(
                t0_manifest_path=self.t0_manifest_path,
                cutout_path=self.cutout_path,
                reference_path=self.root,  # Directory reference!
                output_root=output_root_dir,
                capture_evidence="Permitted studio capture.",
                provider=provider,
            )
        self.assertFalse(output_root_dir.exists())

    def test_prepare_presentation_cli_smoke(self):
        output_root = self.root / "cli-output"
        # 1. Valid execution returns code 0
        code = prepare_presentation_main(
            [
                "--t0-manifest",
                str(self.t0_manifest_path),
                "--cutout",
                str(self.cutout_path),
                "--reference",
                str(self.ref_path),
                "--candidate-png",
                str(self.valid_candidate),
                "--output-root",
                str(output_root),
                "--capture-evidence",
                "Permitted studio capture for CLI test.",
                "--reconstructed-details-flagged",
                "--fidelity-note",
                "Cropped plate edge.",
            ]
        )
        self.assertEqual(code, 0)

        # 2. Re-run against same root returns code 2 (create-only guard)
        code_rerun = prepare_presentation_main(
            [
                "--t0-manifest",
                str(self.t0_manifest_path),
                "--cutout",
                str(self.cutout_path),
                "--reference",
                str(self.ref_path),
                "--candidate-png",
                str(self.valid_candidate),
                "--output-root",
                str(output_root),
                "--capture-evidence",
                "Permitted studio capture for CLI test.",
            ]
        )
        self.assertEqual(code_rerun, 2)

        # 3. Invalid candidate (opaque corners) returns code 2 and retains fallback
        opaque_candidate = self.root / "opaque_candidate.png"
        opaque_candidate.write_bytes(presentation_photo(1024, 1024, transparent_corners=False, has_alpha=True))
        code_fallback = prepare_presentation_main(
            [
                "--t0-manifest",
                str(self.t0_manifest_path),
                "--cutout",
                str(self.cutout_path),
                "--reference",
                str(self.ref_path),
                "--candidate-png",
                str(opaque_candidate),
                "--output-root",
                str(self.root / "cli-fallback"),
                "--capture-evidence",
                "Permitted studio capture for fallback test.",
            ]
        )
        self.assertEqual(code_fallback, 2)


if __name__ == "__main__":
    unittest.main()
