import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from peekaplate_processing.errors import ExtractionError


MAX_IMAGE_PIXELS=24_000_000
MAX_OCR_BYTES=950_000
MAX_UPLOAD_EDGE=2400


def open_image(data:bytes)->Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                if original.format not in {"PNG", "JPEG", "WEBP", "TIFF", "BMP", "GIF"}:
                    raise ExtractionError("Unsupported menu-image format.")
                if original.width*original.height>MAX_IMAGE_PIXELS:
                    raise ExtractionError("Image exceeds the 24-megapixel processing limit.")
                if getattr(original, "n_frames", 1)!=1:
                    raise ExtractionError("Multi-frame images require separate page images.")
                original.load()
                oriented=ImageOps.exif_transpose(original)
                if "A" in oriented.getbands() or "transparency" in oriented.info:
                    rgba=oriented.convert("RGBA")
                    background=Image.new("RGB", rgba.size, "white")
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    rgba.close()
                    return background
                return oriented.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ExtractionError("Unable to decode a supported, bounded menu image.") from None


def prepare_ocr_image(data:bytes)->tuple[bytes,dict]:
    image=open_image(data)
    try:
        original_size=image.size
        image.thumbnail((MAX_UPLOAD_EDGE, MAX_UPLOAD_EDGE))
        # Keep a minimum useful resolution; do not repeatedly shrink unreadable text.
        for quality in [90, 80, 70]:
            output=io.BytesIO()
            image.save(output, format="JPEG", quality=quality, optimize=True)
            if output.tell()<=MAX_OCR_BYTES:
                return output.getvalue(),{
                    "original_width":original_size[0], "original_height":original_size[1],
                    "upload_width":image.width, "upload_height":image.height,
                    "upload_format":"JPEG", "jpeg_quality":quality,
                }
        raise ExtractionError("Image remains above the free OCR upload limit; provide a clearer cropped menu.")
    finally:
        image.close()


def extract_image(data:bytes, source_id:str, ocr):
    from peekaplate_processing.schemas import SourceSegment

    prepared,metadata=prepare_ocr_image(data)
    response=ocr.extract(prepared)
    return SourceSegment(
        segment_id=f"{source_id}#image-1", method="ocr_space_engine3", text=response["text"],
        metadata={**metadata, "ocr_settings":response["settings"], "cache_hit":response["cache_hit"], "ocr_image_sha256":response.get("image_sha256"), "ocr_regions":response.get("regions", []), "ocr_region_status":response.get("region_status", "unavailable"), "ocr_coordinate_space":"uploaded_image_pixels"},
        warnings=["This image is menu-text evidence, not a verified photograph of a dish."]+([response["cache_warning"]] if response.get("cache_warning") else []),
    )
