"""Extract native PDF text; OCR pages with fewer than 20 visible characters."""
import math
import pymupdf

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import prepare_ocr_image
from peekaplate_processing.ocr import OCRProvider, validate_ocr_settings
from peekaplate_processing.schemas import SourceSegment

MAX_PDF_PAGES = 40
MAX_RENDER_PIXELS = 6_000_000
MIN_NATIVE_TEXT_CHARS = 20


def extract_pdf(data: bytes, source_id: str, ocr: OCRProvider) -> list[SourceSegment]:
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except (RuntimeError, ValueError):
        raise ExtractionError("Unable to open this PDF.") from None
    with document:
        if document.needs_pass:
            raise ExtractionError("Password-protected PDFs need an unlocked export.")
        if not 1 <= len(document) <= MAX_PDF_PAGES:
            raise ExtractionError("PDF must contain between 1 and 40 pages.")
        pages = []
        for index in range(len(document)):
            segment = SourceSegment(segment_id=f"{source_id}#page-{index+1}", page_number=index+1, method="pdf_native")
            try:
                page = document.load_page(index)
                text = page.get_text("text", sort=True).strip()
                if len(text) > 100_000:
                    raise ExtractionError("PDF page text exceeds the extraction limit.")
                has_images = bool(page.get_image_info())
                native_chars = len("".join(text.split()))
                segment.native_text = text
                segment.metadata = {"contains_images": has_images, "native_text_chars": native_chars, "width_points": page.rect.width, "height_points": page.rect.height}
                if native_chars >= MIN_NATIVE_TEXT_CHARS:
                    segment.text = text
                    segment.metadata["native_words"] = page.get_text("words", sort=True)
                    segment.metadata["native_word_coordinate_space"] = "page_points"
                    if has_images:
                        segment.warnings.append("Native text retained; embedded image text was not OCRed.")
                else:
                    segment.method = "ocr_space_engine3"
                    segment.warnings.append(f"Native text has fewer than {MIN_NATIVE_TEXT_CHARS} non-whitespace characters; OCR attempted.")
                    width, height = page.rect.width, page.rect.height
                    if not all(math.isfinite(v) and 0 < v <= 14_400 for v in (width, height)):
                        raise ExtractionError("PDF page dimensions exceed the rendering limit.")
                    scale = min(2, math.sqrt(MAX_RENDER_PIXELS / (width * height)))
                    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
                    prepared, metadata = prepare_ocr_image(pixmap.tobytes("png"))
                    response = ocr.extract(prepared)
                    validate_ocr_settings(response)
                    segment.text = response["text"]
                    segment.metadata.update({**metadata, "ocr_settings": response["settings"], "cache_hit": response["cache_hit"], "ocr_image_sha256": response.get("image_sha256"), "ocr_regions": response.get("regions", []), "ocr_region_status": response.get("region_status", "unavailable"), "ocr_coordinate_space": "uploaded_image_pixels"})
                    if response.get("cache_warning"):
                        segment.warnings.append(response["cache_warning"])
            except (ExtractionError, RuntimeError, ValueError, OSError) as error:
                segment.status = "failed"
                segment.error = str(error) if isinstance(error, ExtractionError) else "PDF page extraction failed."
            pages.append(segment)
        return pages
