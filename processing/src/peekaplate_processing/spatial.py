import hashlib
import io
import json
import os
import shutil
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.harness import HARNESS_HTML
from peekaplate_processing.images import MAX_IMAGE_PIXELS
from peekaplate_processing.schemas import (
    AssetManifest,
    LayersInput,
    ProcessingState,
    PublicationState,
    ReviewState,
    SpatialFallback,
    SpatialLayer,
    SpatialManifest,
    SpatialMeasurements,
)
from peekaplate_processing.sources import MAX_SOURCE_BYTES


RECIPE_VERSION="t1-v1"
HARNESS_FILENAME="harness.html"
LAYER_FORMATS={"PNG": "png", "WEBP": "webp", "JPEG": "jpg"}
MAX_MANIFEST_BYTES=100_000
FALLBACK_FILENAME="fallback.jpg"


@dataclass(frozen=True)
class PreparedSpatial:
    asset_id:str
    directory:Path
    manifest:SpatialManifest


class LayerImage:
    def __init__(self, image:Image.Image, image_format:str, has_alpha:bool):
        self.image=image
        self.format=image_format
        self.has_alpha=has_alpha

    @property
    def size(self):
        return self.image.size

    def close(self):
        self.image.close()


def prepare_spatial_bundle(*, t0_manifest_path:Path, layers_manifest_path:Path, output_root:Path, budget_bytes:int)->PreparedSpatial:
    if budget_bytes<=0:
        raise ExtractionError("Spatial asset budget must be greater than zero.")
    started_at=datetime.now(timezone.utc)
    t0_manifest_bytes, t0=read_t0_manifest(t0_manifest_path)
    layers_input=read_layers_manifest(layers_manifest_path)
    if layers_input.dish.dish_id!=t0.dish.dish_id or layers_input.dish.revision_id!=t0.dish.revision_id:
        raise ExtractionError("T0 manifest dish revision does not match the layers manifest.")
    detail=detail_variant(t0)
    layers=validate_layers(layers_input, layers_manifest_path.parent, detail)
    fallback_bytes=read_detail_bytes(t0_manifest_path, t0, detail)
    motion_json=json.dumps(layers_input.motion.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    layer_signature=json.dumps(
        [{"name":layer.name, "depth":layer.depth, "sha256":layer.sha256} for layer in layers],
        sort_keys=True, separators=(",", ":"),
    )
    asset_id="t1_"+hashlib.sha256(f"{t0.asset_id}:{layer_signature}:{motion_json}:{RECIPE_VERSION}".encode()).hexdigest()[:32]
    harness_bytes=HARNESS_HTML.encode("utf-8")
    image_bytes=sum(layer.size_bytes for layer in layers)+len(fallback_bytes)
    completed_at=datetime.now(timezone.utc)
    total_asset_bytes=image_bytes+len(harness_bytes)
    manifest=None
    manifest_bytes=b""
    for _ in range(3):
        manifest=SpatialManifest(
            asset_id=asset_id,
            source_t0=t0.asset_id,
            source_t0_manifest_sha256=hashlib.sha256(t0_manifest_bytes).hexdigest(),
            source_sha256=t0.source.sha256,
            dish=t0.dish,
            capture_evidence=layers_input.capture_evidence,
            rights_confirmed=layers_input.rights_confirmed,
            motion=layers_input.motion,
            layers=[SpatialLayer(
                name=layer.name, path=layer.path, sha256=layer.sha256, size_bytes=layer.size_bytes,
                width=layer.width, height=layer.height, format=layer.format, depth=layer.depth,
            ) for layer in layers],
            fallback=SpatialFallback(
                sha256=hashlib.sha256(fallback_bytes).hexdigest(), size_bytes=len(fallback_bytes),
                width=detail.width, height=detail.height,
            ),
            processing=ProcessingState(
                status="ready", engine="pillow", engine_version=Image.__version__,
                started_at=started_at, completed_at=completed_at,
                steps=["read_manifests", "decode_layers", "verify_dimensions", "copy_layers", "copy_fallback", "hash"],
            ),
            review=ReviewState(warnings=[
                "Human review must verify that every layer depicts the same captured dish; processing cannot detect fabricated food.",
                "Dish and revision IDs are caller-supplied and are not verified against the backend.",
            ]),
            publication=PublicationState(),
            measurements=SpatialMeasurements(
                total_asset_bytes=total_asset_bytes, budget_bytes=budget_bytes, budget_status="within_budget",
            ),
        )
        manifest_bytes=(json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False, indent=2, allow_nan=False)+"\n").encode("utf-8")
        next_total=image_bytes+len(harness_bytes)+len(manifest_bytes)
        if next_total==total_asset_bytes:
            break
        total_asset_bytes=next_total
    if total_asset_bytes>budget_bytes:
        raise ExtractionError(f"Spatial asset bytes {total_asset_bytes} exceed the configured budget {budget_bytes}.")
    final_directory=output_root/asset_id
    if final_directory.exists():
        raise ExtractionError(f"Output bundle already exists: {final_directory}. Choose a new output root to preserve the previous bundle.")
    output_root_existed=output_root.exists()
    output_root.mkdir(parents=True, exist_ok=True)
    temporary_directory=output_root/f".tmp-{uuid4().hex}"
    try:
        temporary_directory.mkdir()
        layers_directory=temporary_directory/LAYERS_DIRECTORY_NAME
        layers_directory.mkdir()
        for layer in layers:
            (temporary_directory/layer.path).write_bytes(layer.data)
        (temporary_directory/FALLBACK_FILENAME).write_bytes(fallback_bytes)
        (temporary_directory/HARNESS_FILENAME).write_bytes(harness_bytes)
        (temporary_directory/"spatial-manifest.json").write_bytes(manifest_bytes)
        publish_directory(temporary_directory, final_directory)
    except BaseException:
        remove_directory(temporary_directory)
        if not output_root_existed:
            remove_created_root(output_root)
        raise
    return PreparedSpatial(asset_id=asset_id, directory=final_directory, manifest=manifest)


def read_t0_manifest(path:Path)->tuple[bytes, AssetManifest]:
    data=read_bounded(path, "Invalid T0 asset manifest.")
    try:
        manifest=AssetManifest.model_validate_json(data)
    except ValidationError:
        raise ExtractionError("Invalid T0 asset manifest.") from None
    if manifest.recipe_version!="t0-v1":
        raise ExtractionError("Invalid T0 asset manifest.")
    if manifest.processing.status!="ready":
        raise ExtractionError("Invalid T0 asset manifest.")
    return data, manifest


def read_layers_manifest(path:Path)->LayersInput:
    data=read_bounded(path, "Invalid spatial layers manifest.")
    try:
        return LayersInput.model_validate_json(data)
    except ValidationError:
        raise ExtractionError("Invalid spatial layers manifest.") from None


def read_bounded(path:Path, message:str)->bytes:
    try:
        with Path(path).open("rb") as source:
            data=source.read(MAX_MANIFEST_BYTES+1)
    except (OSError, ValueError):
        raise ExtractionError(message) from None
    if not data or len(data)>MAX_MANIFEST_BYTES:
        raise ExtractionError(message)
    return data


def detail_variant(manifest:AssetManifest):
    for variant in manifest.variants:
        if variant.name=="detail-1280" and variant.format=="jpeg":
            return variant
    raise ExtractionError("Invalid T0 asset manifest.")


def read_detail_bytes(t0_manifest_path:Path, manifest:AssetManifest, detail)->bytes:
    if Path(detail.path).name!=detail.path:
        raise ExtractionError("Invalid T0 asset manifest.")
    data=read_layer_bytes(t0_manifest_path.parent/detail.path, "Invalid T0 asset manifest.")
    if len(data)!=detail.size_bytes or hashlib.sha256(data).hexdigest()!=detail.sha256:
        raise ExtractionError("T0 detail variant does not match its manifest hash.")
    try:
        image_format, has_alpha, oriented=open_layer_image(data)
    except ExtractionError:
        raise ExtractionError("Unable to decode a valid T0 fallback JPEG.") from None
    try:
        if image_format!="JPEG" or has_alpha:
            raise ExtractionError("Unable to decode a valid T0 fallback JPEG.")
        if oriented.size!=(detail.width, detail.height):
            raise ExtractionError("T0 detail variant dimensions do not match the manifest.")
    finally:
        oriented.close()
    return data


def validate_layers(layers_input:LayersInput, layers_directory:Path, detail)->list["ValidatedLayer"]:
    names=[layer.name for layer in layers_input.layers]
    if len(set(names))!=len(names):
        raise ExtractionError("Spatial layer names must be unique.")
    backgrounds=[layer for layer in layers_input.layers if layer.depth==0]
    if len(backgrounds)!=1:
        raise ExtractionError("Spatial layers require exactly one background layer with depth 0.")
    if not any(layer.depth>0 for layer in layers_input.layers):
        raise ExtractionError("Spatial layers require at least one layer above the background.")
    validated=[]
    for layer in layers_input.layers:
        if Path(layer.file).name!=layer.file:
            raise ExtractionError("Layer files must be bare filenames inside the layers manifest directory.")
        path=layers_directory/layer.file
        data=read_layer_bytes(path)
        image_format, has_alpha, oriented=open_layer_image(data)
        if image_format not in LAYER_FORMATS:
            raise ExtractionError("Unsupported layer image format.")
        if oriented.size!=(detail.width, detail.height):
            raise ExtractionError("Layers must share the T0 detail dimensions.")
        if layer.depth==0 and has_alpha:
            raise ExtractionError("Background layer must be opaque.")
        if layer.depth>0 and not has_alpha:
            raise ExtractionError("Each non-background layer must include an alpha channel.")
        validated.append(ValidatedLayer(
            name=layer.name, path=f"layers/{layer.name}.{LAYER_FORMATS[image_format]}",
            sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data),
            width=oriented.width, height=oriented.height, format=image_format, depth=layer.depth, data=data,
        ))
        oriented.close()
    return validated


LAYERS_DIRECTORY_NAME="layers"


def read_layer_bytes(path:Path, message:str="Unable to read the spatial layer file.")->bytes:
    try:
        with path.open("rb") as source:
            data=source.read(MAX_SOURCE_BYTES+1)
    except (OSError, ValueError):
        raise ExtractionError(message) from None
    if not data or len(data)>MAX_SOURCE_BYTES:
        raise ExtractionError(message)
    return data


def open_layer_image(data:bytes)->tuple[str, bool, Image.Image]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                image_format=original.format
                if image_format not in LAYER_FORMATS:
                    raise ExtractionError("Unsupported layer image format.")
                if original.width*original.height>MAX_IMAGE_PIXELS:
                    raise ExtractionError("Image exceeds the 24-megapixel processing limit.")
                if getattr(original, "n_frames", 1)!=1:
                    raise ExtractionError("Multi-frame images require separate page images.")
                original.load()
                oriented=ImageOps.exif_transpose(original)
                has_alpha="A" in oriented.getbands() or "transparency" in oriented.info
                return image_format, has_alpha, oriented
    except ExtractionError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ExtractionError("Unable to decode a supported, bounded layer image.") from None


@dataclass(frozen=True)
class ValidatedLayer:
    name:str
    path:str
    sha256:str
    size_bytes:int
    width:int
    height:int
    format:str
    depth:float
    data:bytes


def publish_directory(temporary_directory:Path, final_directory:Path)->None:
    try:
        os.rename(temporary_directory, final_directory)
    except FileExistsError:
        raise ExtractionError(f"Output bundle already exists: {final_directory}. Choose a new output root to preserve the previous bundle.") from None
    except OSError:
        raise ExtractionError("Unable to publish the spatial asset bundle.") from None


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
