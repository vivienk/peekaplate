import hashlib
import io
import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from PIL import Image, UnidentifiedImageError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import open_image
from peekaplate_processing.schemas import (
    AssetManifest,
    AssetMeasurements,
    AssetSource,
    AssetVariant,
    DishRef,
    ProcessingState,
    PublicationState,
    ReviewState,
)
from peekaplate_processing.sources import MAX_SOURCE_BYTES


RECIPE_VERSION="t0-v1"
CARD_EDGE=480
DETAIL_EDGE=1280
WEBP_QUALITY=82
JPEG_QUALITY=85
FORMAT_EXTENSIONS={"JPEG":"jpg", "PNG":"png", "WEBP":"webp", "TIFF":"tiff", "BMP":"bmp", "GIF":"gif"}
VARIANTS=("card-480", "detail-1280")
STEPS=["decode", "orient", "resize", "encode_webp", "encode_jpeg", "hash"]
PUBLICATION_REASON="Human approval and backend publication are required."


@dataclass(frozen=True)
class PreparedAsset:
    asset_id:str
    directory:Path
    manifest:AssetManifest


def prepare_t0_bundle(*, input_path:Path, output_root:Path, dish_id:UUID, revision_id:UUID, capture_evidence:str, captured_at:datetime|None, budget_bytes:int|None)->PreparedAsset:
    if not capture_evidence or not capture_evidence.strip():
        raise ExtractionError("Capture evidence is required; it must identify the source capture.")
    if captured_at is not None and (captured_at.tzinfo is None or captured_at.utcoffset() is None or captured_at>datetime.now(timezone.utc)):
        raise ExtractionError("Capture date must include a timezone and must not be in the future.")
    if budget_bytes is not None and budget_bytes<=0:
        raise ExtractionError("Asset budget must be greater than zero when configured.")
    started_at=datetime.now(timezone.utc)
    data=read_source(input_path)
    source_format=probe_format(data)
    image=open_image(data)
    try:
        pixel_width, pixel_height=image.size
        source_sha256=hashlib.sha256(data).hexdigest()
        asset_id="t0_"+hashlib.sha256(f"{source_sha256}:{dish_id}:{revision_id}:{RECIPE_VERSION}".encode()).hexdigest()[:32]
        final_directory=output_root/asset_id
        if final_directory.exists():
            raise ExtractionError(f"Output bundle already exists: {final_directory}. Choose a new output root to preserve the previous bundle.")
        output_root_existed=output_root.exists()
        output_root.mkdir(parents=True, exist_ok=True)
        temporary_directory=output_root/f".tmp-{uuid4().hex}"
        try:
            temporary_directory.mkdir()
            source_name=f"source.{FORMAT_EXTENSIONS[source_format]}"
            (temporary_directory/source_name).write_bytes(data)
            variants=[variant for name in VARIANTS for variant in encode_variants(image, name, temporary_directory)]
            total_variant_bytes=sum(variant.size_bytes for variant in variants)
            if budget_bytes is not None and total_variant_bytes>budget_bytes:
                raise ExtractionError(f"Variant bytes {total_variant_bytes} exceed the configured budget {budget_bytes}.")
            warnings=[
                "Asset preparation does not verify rights, dish facts, or publication eligibility; human review is required.",
                "Dish and revision IDs are caller-supplied and are not verified against the backend.",
            ]
            if max(image.width, image.height)<DETAIL_EDGE:
                warnings.append("Source is smaller than the detail variant; variants were not upscaled.")
            manifest=AssetManifest(
                asset_id=asset_id,
                source=AssetSource(
                    sha256=source_sha256, size_bytes=len(data), format=source_format,
                    width=pixel_width, height=pixel_height, path=source_name,
                    captured_at=captured_at, capture_evidence=capture_evidence,
                ),
                dish=DishRef(dish_id=dish_id, revision_id=revision_id),
                variants=variants,
                processing=ProcessingState(
                    status="ready", engine="pillow", engine_version=Image.__version__,
                    started_at=started_at, completed_at=datetime.now(timezone.utc), steps=list(STEPS),
                ),
                review=ReviewState(warnings=warnings),
                publication=PublicationState(reason=PUBLICATION_REASON),
                measurements=AssetMeasurements(
                    total_variant_bytes=total_variant_bytes, budget_bytes=budget_bytes,
                    budget_status="within_budget" if budget_bytes is not None else "not_configured",
                ),
            )
            (temporary_directory/"manifest.json").write_text(manifest_json(manifest), encoding="utf-8")
            publish_directory(temporary_directory, final_directory)
        except BaseException:
            remove_directory(temporary_directory)
            if not output_root_existed:
                remove_created_root(output_root)
            raise
    finally:
        image.close()
    return PreparedAsset(asset_id=asset_id, directory=final_directory, manifest=manifest)


def read_source(path:Path)->bytes:
    try:
        with Path(path).open("rb") as source:
            data=source.read(MAX_SOURCE_BYTES+1)
    except (OSError, ValueError):
        raise ExtractionError("Unable to read the source image file.") from None
    if not data or len(data)>MAX_SOURCE_BYTES:
        raise ExtractionError("Source must be nonempty and at most 12 MB.")
    return data


def probe_format(data:bytes)->str:
    try:
        with Image.open(io.BytesIO(data)) as probe:
            image_format=probe.format
    except (UnidentifiedImageError, OSError, ValueError):
        raise ExtractionError("Unsupported source image format.") from None
    if image_format not in FORMAT_EXTENSIONS:
        raise ExtractionError("Unsupported source image format.")
    return image_format


def encode_variants(image:Image.Image, name:str, directory:Path)->list[AssetVariant]:
    edge=CARD_EDGE if name=="card-480" else DETAIL_EDGE
    resized=image.copy()
    try:
        resized.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        webp_name=f"{name}.webp"
        resized.save(directory/webp_name, format="WEBP", quality=WEBP_QUALITY, method=6)
        jpeg_name=f"{name}.jpg"
        rgb=resized.convert("RGB")
        try:
            rgb.save(directory/jpeg_name, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        finally:
            rgb.close()
        width, height=resized.size
    finally:
        resized.close()
    return [
        describe_variant(name, "webp", webp_name, directory, width, height, WEBP_QUALITY),
        describe_variant(name, "jpeg", jpeg_name, directory, width, height, JPEG_QUALITY),
    ]


def describe_variant(name:str, image_format:Literal["webp", "jpeg"], file_name:str, directory:Path, width:int, height:int, quality:int)->AssetVariant:
    data=(directory/file_name).read_bytes()
    return AssetVariant(
        name=name, format=image_format, path=file_name, sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data), width=width, height=height, quality=quality,
    )


def manifest_json(manifest)->str:
    return json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False, indent=2, allow_nan=False)+"\n"


def publish_directory(temporary_directory:Path, final_directory:Path)->None:
    try:
        os.rename(temporary_directory, final_directory)
    except FileExistsError:
        raise ExtractionError(f"Output bundle already exists: {final_directory}. Choose a new output root to preserve the previous bundle.") from None
    except OSError:
        raise ExtractionError("Unable to publish the asset bundle.") from None


def remove_directory(path:Path)->None:
    if not path.exists():
        return
    shutil.rmtree(path, ignore_errors=True)


def remove_created_root(path:Path)->None:
    # Only discard the root this run created, and only while no other bundle has appeared in it.
    try:
        if not any(path.iterdir()):
            path.rmdir()
    except OSError:
        pass
