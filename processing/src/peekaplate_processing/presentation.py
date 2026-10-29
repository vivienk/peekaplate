import base64
import hashlib
import io
import json
import os
import shutil
import warnings
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import MAX_IMAGE_PIXELS
from peekaplate_processing.schemas import (
    AssetManifest,
    DishRef,
    PresentationAsset,
    PresentationInputAsset,
    PresentationManifest,
    PresentationMeasurements,
    PresentationProcessingState,
    PresentationPromptSpec,
    PublicationState,
    ReviewState,
    SpatialFallback,
)
from peekaplate_processing.sources import MAX_SOURCE_BYTES
from peekaplate_processing.spatial import (
    FALLBACK_FILENAME,
    MAX_MANIFEST_BYTES,
    detail_variant,
    open_layer_image,
    read_bounded,
    read_detail_bytes,
)

PRESENTATION_PROMPT = """Create a standalone dish-image asset matching the presentation of the attached reference.

Inputs:

Image 1: the source dish; use this for the food’s identity and appearance.
Image 2: reference for framing, camera angle, lighting and presentation only. Do not copy its ingredients.

Presentation:

Photorealistic food photography, not a cartoon or stylized 3D render.
Elevated three-quarter view, approximately 45–55° above the tabletop, showing both the top of the food and its height.
Center the dish and plate together as one complete object.
Keep the entire plate visible, with approximately 8–10% clear space around it.
Use natural proportions and restrained perspective, without wide-angle distortion.
Soft studio lighting, realistic texture and gentle shadows between the food and plate.
Remove the restaurant background, table, hands, jug, utensils and unrelated props.
Preserve the source dish’s visible ingredients, portions, colors and arrangement. Do not add garnishes or make the serving larger.

Output:

One square PNG, preferably 2048 × 2048.
Genuine transparent background with clean, antialiased edges.
No baked-in checkerboard, gray rectangle, text, labels or watermark.
A single cohesive dish-and-plate asset, not separated floating ingredients or a layered restaurant scene.

Fidelity requirement:
If the requested viewpoint or complete plate would require inventing unseen food or reconstructing cropped details, preserve the original viewpoint and identify that limitation instead."""

PRESENTATION_PROMPT_VERSION = "presentation-prompt-v1"
RECIPE_VERSION = "presentation-v1"
PREFERRED_EDGE = 2048
MIN_EDGE = 512
MANIFEST_FILENAME = "presentation-manifest.json"
PRESENTATION_FILENAME = "presentation.png"
INPUT_FORMAT_EXTENSIONS = {"PNG": "png", "WEBP": "webp", "JPEG": "jpg"}


@dataclass(frozen=True)
class PresentationRequest:
    cutout_path: Path
    cutout_bytes: bytes
    reference_path: Path
    reference_bytes: bytes
    model_version: str
    budget_bytes: int | None = None


@dataclass(frozen=True)
class PresentationResult:
    png_bytes: bytes
    model_version: str
    preserved_original_viewpoint: bool = False
    reconstructed_details_flagged: bool = False
    fidelity_notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PreparedPresentation:
    asset_id: str
    directory: Path
    manifest: PresentationManifest


class PresentationProvider(ABC):
    @abstractmethod
    def generate(self, request: PresentationRequest) -> PresentationResult:
        """Generate a square transparent dish presentation image."""


class FilePresentationProvider(PresentationProvider):
    """File-backed presentation provider for offline validation and evaluation."""

    def __init__(
        self,
        candidate_path: Path | None = None,
        candidate_bytes: bytes | None = None,
        model_version: str = "offline-candidate-v1",
        preserved_original_viewpoint: bool = False,
        reconstructed_details_flagged: bool = False,
        fidelity_notes: Sequence[str] | None = None,
    ):
        if candidate_bytes is not None:
            self.bytes = candidate_bytes
        elif candidate_path is not None:
            path = Path(candidate_path)
            if path.is_dir():
                raise ExtractionError("Supply an actual candidate PNG image file, not a directory path.")
            try:
                self.bytes = path.read_bytes()
            except OSError as err:
                raise ExtractionError(f"Unable to read candidate PNG: {err}") from None
        else:
            raise ExtractionError("Either candidate_path or candidate_bytes must be supplied.")
        self.model_version = model_version
        self.preserved_original_viewpoint = preserved_original_viewpoint
        self.reconstructed_details_flagged = reconstructed_details_flagged
        self.fidelity_notes = list(fidelity_notes or [])

    def generate(self, request: PresentationRequest) -> PresentationResult:
        return PresentationResult(
            png_bytes=self.bytes,
            model_version=self.model_version or request.model_version,
            preserved_original_viewpoint=self.preserved_original_viewpoint,
            reconstructed_details_flagged=self.reconstructed_details_flagged,
            fidelity_notes=list(self.fidelity_notes),
        )


def _image_mime(image_format: str) -> str:
    fmt = image_format.upper()
    if fmt == "PNG":
        return "image/png"
    if fmt == "WEBP":
        return "image/webp"
    if fmt in ("JPEG", "JPG"):
        return "image/jpeg"
    return "application/octet-stream"


def build_multimodal_messages(request: PresentationRequest) -> list[dict]:
    """Build standard OpenAI/Anthropic multimodal payload with prompt and both images."""
    if Path(request.cutout_path).is_dir():
        raise ExtractionError("Cutout path must be an image file, not a directory.")
    if Path(request.reference_path).is_dir():
        raise ExtractionError("Supply an actual presentation reference image file from the reference folder, not a directory path.")

    cutout_fmt, _, cutout_img = open_layer_image(request.cutout_bytes)
    cutout_img.close()
    ref_fmt, _, ref_img = open_layer_image(request.reference_bytes)
    ref_img.close()

    cutout_mime = _image_mime(cutout_fmt)
    ref_mime = _image_mime(ref_fmt)

    cutout_b64 = base64.b64encode(request.cutout_bytes).decode("ascii")
    ref_b64 = base64.b64encode(request.reference_bytes).decode("ascii")

    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": PRESENTATION_PROMPT},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{cutout_mime};base64,{cutout_b64}",
                        "detail": "high",
                    },
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{ref_mime};base64,{ref_b64}",
                        "detail": "high",
                    },
                },
            ],
        }
    ]


def validate_cutout_image(path: Path) -> tuple[PresentationInputAsset, bytes]:
    p = Path(path)
    if p.is_dir():
        raise ExtractionError("Cutout path must be an image file, not a directory.")
    try:
        with p.open("rb") as f:
            data = f.read(MAX_SOURCE_BYTES + 1)
    except OSError:
        raise ExtractionError("Unable to read cutout image file.") from None
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise ExtractionError("Cutout image exceeds size limit.")

    image_format, has_alpha, oriented = open_layer_image(data)
    try:
        if image_format not in ("PNG", "WEBP"):
            raise ExtractionError("Cutout image must be a PNG or WEBP.")
        if not has_alpha:
            raise ExtractionError("Cutout image must include a transparent background.")

        rgba = oriented.convert("RGBA")
        alpha_channel = rgba.getchannel("A")
        min_a, max_a = alpha_channel.getextrema()
        if not (min_a == 0 and max_a > 0):
            raise ExtractionError("Cutout image must include a transparent background.")

        ext = INPUT_FORMAT_EXTENSIONS[image_format]
        sha256 = hashlib.sha256(data).hexdigest()
        asset = PresentationInputAsset(
            role="cutout",
            path=f"cutout.{ext}",
            sha256=sha256,
            size_bytes=len(data),
            width=oriented.width,
            height=oriented.height,
            format=image_format,
            has_alpha=True,
        )
        return asset, data
    finally:
        oriented.close()


def validate_reference_image(path: Path) -> tuple[PresentationInputAsset, bytes]:
    p = Path(path)
    if p.is_dir():
        raise ExtractionError("Supply an actual presentation reference image file from the reference folder, not a directory path.")
    try:
        with p.open("rb") as f:
            data = f.read(MAX_SOURCE_BYTES + 1)
    except OSError:
        raise ExtractionError("Unable to read reference image file.") from None
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise ExtractionError("Reference image exceeds size limit.")

    image_format, has_alpha, oriented = open_layer_image(data)
    try:
        if image_format not in INPUT_FORMAT_EXTENSIONS:
            raise ExtractionError("Reference image must be a PNG, WEBP, or JPEG.")

        ext = INPUT_FORMAT_EXTENSIONS[image_format]
        sha256 = hashlib.sha256(data).hexdigest()
        asset = PresentationInputAsset(
            role="reference",
            path=f"reference.{ext}",
            sha256=sha256,
            size_bytes=len(data),
            width=oriented.width,
            height=oriented.height,
            format=image_format,
            has_alpha=has_alpha,
        )
        return asset, data
    finally:
        oriented.close()


def validate_presentation_png(data: bytes, budget_bytes: int | None = None) -> PresentationAsset:
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise ExtractionError("Presentation image payload is empty or exceeds maximum size.")
    if budget_bytes is not None and len(data) > budget_bytes:
        raise ExtractionError(f"Presentation PNG size {len(data)} exceeds configured budget {budget_bytes}.")

    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except (UnidentifiedImageError, OSError, ValueError):
            raise ExtractionError("Presentation image is not a valid image.") from None

    if image.format != "PNG":
        raise ExtractionError("Presentation image must be a PNG.")
    if getattr(image, "n_frames", 1) > 1:
        raise ExtractionError("Multi-frame images are not supported.")
    if (image.width * image.height) > MAX_IMAGE_PIXELS:
        raise ExtractionError("Presentation image exceeds maximum pixel bounds.")
    if image.width < MIN_EDGE or image.height < MIN_EDGE:
        raise ExtractionError(f"Presentation image dimensions must be at least {MIN_EDGE}x{MIN_EDGE}.")
    if image.width != image.height:
        raise ExtractionError(f"Presentation image must be square, got {image.width}x{image.height}.")

    oriented = ImageOps.exif_transpose(image)
    if oriented is None:
        oriented = image

    try:
        has_alpha = oriented.mode in ("RGBA", "LA") or (
            oriented.mode == "P" and "transparency" in oriented.info
        )
        if not has_alpha:
            raise ExtractionError("Presentation image must have a genuine alpha channel.")

        rgba = oriented.convert("RGBA")
        alpha = rgba.getchannel("A")
        min_a, max_a = alpha.getextrema()
        if not (min_a == 0 and max_a > 0):
            raise ExtractionError("Presentation image must have transparent background areas.")

        w, h = rgba.size
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        for cx, cy in corners:
            pixel = rgba.getpixel((cx, cy))
            if pixel[3] != 0:
                raise ExtractionError(
                    "Presentation image must have transparent corners; baked-in background or non-transparent edge detected."
                )

        sha256 = hashlib.sha256(data).hexdigest()
        return PresentationAsset(
            path=PRESENTATION_FILENAME,
            sha256=sha256,
            size_bytes=len(data),
            width=w,
            height=h,
            format="PNG",
            has_alpha=True,
            transparent_corners=True,
        )
    finally:
        oriented.close()
        image.close()


def read_t0_manifest(path: Path) -> tuple[AssetManifest, bytes]:
    data = read_bounded(path, "Invalid T0 asset manifest.")
    try:
        return AssetManifest.model_validate_json(data), data
    except ValidationError:
        raise ExtractionError("Invalid T0 asset manifest.") from None


def prepare_presentation_bundle(
    *,
    t0_manifest_path: Path,
    cutout_path: Path,
    reference_path: Path,
    output_root: Path,
    capture_evidence: str,
    rights_confirmed: bool = True,
    draft_id: str | None = None,
    budget_bytes: int | None = None,
    provider: PresentationProvider,
    model_version: str = "offline-candidate-v1",
    reconstructed_details_flagged: bool = False,
    preserved_original_viewpoint: bool = False,
    fidelity_notes: Sequence[str] | None = None,
) -> PreparedPresentation:
    started_at = datetime.now(timezone.utc)
    if not capture_evidence or not capture_evidence.strip():
        raise ExtractionError("Capture evidence is required; it must identify the source capture.")
    if rights_confirmed is not True:
        raise ExtractionError("Rights must be explicitly confirmed for presentation asset preparation.")
    if budget_bytes is not None and budget_bytes <= 0:
        raise ExtractionError("Presentation asset budget must be greater than zero when configured.")

    cutout_asset, cutout_bytes = validate_cutout_image(cutout_path)
    ref_asset, ref_bytes = validate_reference_image(reference_path)

    t0_manifest, t0_manifest_bytes = read_t0_manifest(t0_manifest_path)
    detail = detail_variant(t0_manifest)
    detail_bytes = read_detail_bytes(t0_manifest_path, t0_manifest, detail)
    detail_sha = hashlib.sha256(detail_bytes).hexdigest()

    dish_ref = DishRef(
        dish_id=t0_manifest.dish.dish_id,
        revision_id=t0_manifest.dish.revision_id,
    )
    prompt_sha256 = hashlib.sha256(PRESENTATION_PROMPT.encode("utf-8")).hexdigest()

    identity_preimage = (
        f"{t0_manifest.asset_id}:{dish_ref.dish_id}:{dish_ref.revision_id}:"
        f"{cutout_asset.sha256}:{ref_asset.sha256}:{RECIPE_VERSION}"
    )
    asset_id = "pres_" + hashlib.sha256(identity_preimage.encode("utf-8")).hexdigest()[:32]

    output_root_path = Path(output_root)
    final_directory = output_root_path / asset_id
    if final_directory.exists():
        raise ExtractionError(
            f"Output bundle already exists: {final_directory}. Choose a new output root to preserve the previous bundle."
        )

    output_root_existed = output_root_path.exists()
    output_root_path.mkdir(parents=True, exist_ok=True)
    temporary_directory = output_root_path / f".tmp-{uuid4().hex}"

    presentation_asset: PresentationAsset | None = None
    presentation_png_bytes: bytes | None = None
    validation_errors: list[str] = []
    status: str = "ready"
    fallback_retained: bool = False

    try:
        temporary_directory.mkdir()
        request = PresentationRequest(
            cutout_path=cutout_path,
            cutout_bytes=cutout_bytes,
            reference_path=reference_path,
            reference_bytes=ref_bytes,
            model_version=model_version,
            budget_bytes=budget_bytes,
        )

        try:
            result = provider.generate(request)
            presentation_asset = validate_presentation_png(result.png_bytes, budget_bytes)
            presentation_png_bytes = result.png_bytes
            effective_model_version = result.model_version or model_version
            effective_preserved_vp = result.preserved_original_viewpoint or preserved_original_viewpoint
            effective_reconstructed = result.reconstructed_details_flagged or reconstructed_details_flagged
            effective_notes = list(result.fidelity_notes) + list(fidelity_notes or [])
        except ExtractionError as err:
            status = "fallback_retained"
            fallback_retained = True
            validation_errors.append(str(err))
            effective_model_version = model_version
            effective_preserved_vp = preserved_original_viewpoint
            effective_reconstructed = reconstructed_details_flagged
            effective_notes = list(fidelity_notes or [])
        except Exception as err:
            status = "fallback_retained"
            fallback_retained = True
            validation_errors.append(f"Provider generation failed: {err}")
            effective_model_version = model_version
            effective_preserved_vp = preserved_original_viewpoint
            effective_reconstructed = reconstructed_details_flagged
            effective_notes = list(fidelity_notes or [])

        # Write common assets
        (temporary_directory / cutout_asset.path).write_bytes(cutout_bytes)
        (temporary_directory / ref_asset.path).write_bytes(ref_bytes)
        (temporary_directory / FALLBACK_FILENAME).write_bytes(detail_bytes)

        if status == "ready" and presentation_png_bytes is not None:
            (temporary_directory / PRESENTATION_FILENAME).write_bytes(presentation_png_bytes)

        # Measurements
        pres_bytes = len(presentation_png_bytes) if presentation_png_bytes is not None else 0
        fb_bytes = len(detail_bytes)
        total_bundle_bytes = pres_bytes + fb_bytes + len(cutout_bytes) + len(ref_bytes)

        if budget_bytes is not None:
            if fallback_retained and any("budget" in e.lower() for e in validation_errors):
                budget_status = "exceeded_fallback_retained"
            else:
                budget_status = "within_budget"
        else:
            budget_status = "not_configured"

        measurements = PresentationMeasurements(
            presentation_bytes=pres_bytes,
            fallback_bytes=fb_bytes,
            total_bundle_bytes=total_bundle_bytes,
            budget_bytes=budget_bytes,
            budget_status=budget_status,
        )

        steps = [
            "Validated source T0 manifest and fallback detail variant.",
            "Validated cutout transparent PNG/WEBP and reference framing image.",
            "Prepared multimodal prompt spec and executed presentation generation.",
        ]
        if status == "ready":
            steps.append("Validated square 2048/512+ PNG, alpha transparency and clean corners.")
        else:
            steps.append("Presentation generation/validation failed; retained T0 fallback photo.")

        processing_state = PresentationProcessingState(
            status=status,  # type: ignore
            engine="pillow",
            engine_version=getattr(Image, "__version__", "11.0.0"),
            started_at=started_at,
            completed_at=datetime.now(timezone.utc),
            steps=steps,
            validation_errors=validation_errors,
        )

        review_warnings = [
            "Presentation asset preparation requires human review before publication; manifests never self-approve.",
            "Dish and revision IDs are caller-supplied and are not verified against the backend.",
        ]
        if effective_reconstructed:
            review_warnings.append("Reconstructed details flagged: dish was cropped or required inventing unseen food.")
        if effective_preserved_vp:
            review_warnings.append("Preserved original viewpoint: dish was not rotated to requested viewpoint.")
        for note in effective_notes:
            review_warnings.append(f"Fidelity limitation: {note}")

        review = ReviewState(
            status="needs_review",
            warnings=review_warnings,
        )
        publication_reason = (
            "Presentation generation or validation failed; T0 fallback is retained."
            if fallback_retained
            else "Human approval and backend publication are required."
        )
        publication = PublicationState(
            eligible=False,
            reason=publication_reason,
        )

        prompt_spec = PresentationPromptSpec(
            prompt_version=PRESENTATION_PROMPT_VERSION,
            prompt_sha256=prompt_sha256,
            model_version=effective_model_version,
            preserved_original_viewpoint=effective_preserved_vp,
            reconstructed_details_flagged=effective_reconstructed,
            fidelity_notes=effective_notes,
        )

        fallback_spec = SpatialFallback(
            tier="T0",
            path=FALLBACK_FILENAME,
            sha256=detail_sha,
            size_bytes=len(detail_bytes),
            width=detail.width,
            height=detail.height,
        )

        manifest = PresentationManifest(
            schema_version=1,
            asset_id=asset_id,
            recipe_version=RECIPE_VERSION,
            tier="T0-presentation",
            source_t0=t0_manifest.asset_id,
            source_t0_manifest_sha256=hashlib.sha256(t0_manifest_bytes).hexdigest(),
            source_sha256=t0_manifest.source.sha256,
            dish=dish_ref,
            draft_id=draft_id,
            capture_evidence=capture_evidence,
            rights_confirmed=True,
            cutout=cutout_asset,
            reference=ref_asset,
            prompt=prompt_spec,
            presentation=presentation_asset,
            fallback=fallback_spec,
            fallback_retained=fallback_retained,
            active_display_path="fallback.jpg",
            processing=processing_state,
            review=review,
            publication=publication,
            measurements=measurements,
        )

        manifest_json = manifest.model_dump_json(indent=2) + "\n"
        (temporary_directory / MANIFEST_FILENAME).write_text(manifest_json, encoding="utf-8")

        # Atomic directory rename
        os.rename(temporary_directory, final_directory)
        return PreparedPresentation(asset_id=asset_id, directory=final_directory, manifest=manifest)
    except Exception:
        if temporary_directory.exists():
            shutil.rmtree(temporary_directory, ignore_errors=True)
        if not output_root_existed and output_root_path.exists() and not any(output_root_path.iterdir()):
            output_root_path.rmdir()
        raise
