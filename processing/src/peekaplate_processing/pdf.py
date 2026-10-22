import io
import math
from itertools import islice

import pypdfium2 as pdfium
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import prepare_ocr_image
from peekaplate_processing.schemas import SourceSegment


MAX_PDF_PAGES=20
MAX_RENDER_PIXELS=6_000_000


def extract_pdf(data:bytes, source_id:str, ocr, *, force_ocr:bool=False)->list[SourceSegment]:
    try:
        document=pdfium.PdfDocument(data)
    except pdfium.PdfiumError:
        raise ExtractionError("Unable to open the PDF; corrupt or encrypted documents need an exported menu.") from None
    segments=[]
    try:
        if not 1<=len(document)<=MAX_PDF_PAGES:
            raise ExtractionError(f"PDF must contain between 1 and {MAX_PDF_PAGES} pages.")
        for index in range(len(document)):
            segment=SourceSegment(segment_id=f"{source_id}#page-{index+1}", page_number=index+1, method="pdf_native")
            page=None
            try:
                page=document[index]
                width,height=page.get_size()
                if not all(math.isfinite(value) and 0<value<=14_400 for value in [width, height]):
                    raise ExtractionError("PDF page dimensions exceed the rendering limit.")
                text_page=page.get_textpage()
                try:
                    if text_page.count_chars()>100_000:
                        raise ExtractionError("PDF page text exceeds the extraction limit.")
                    native=text_page.get_text_range()
                finally:
                    text_page.close()
                segment.native_text=native
                native=native.replace("\r\n", "\n").strip()
                if len(native)>100_000:
                    raise ExtractionError("PDF page text exceeds the extraction limit.")
                objects=list(islice(page.get_objects(max_depth=4), 10_001))
                if len(objects)>10_000:
                    raise ExtractionError("PDF page contains too many objects.")
                has_image=any(item.type==pdfium.raw.FPDF_PAGEOBJ_IMAGE for item in objects)
                has_form=any(item.type==pdfium.raw.FPDF_PAGEOBJ_FORM for item in objects)
                segment.metadata={"width_points":width, "height_points":height, "contains_images":has_image, "contains_forms":has_form}
                broken="\ufffd" in native or "\0" in native or (native and sum(character.isalnum() for character in native)<3)
                needs_ocr=force_ocr or has_image or has_form or not native or broken
                if not needs_ocr:
                    segment.text=native
                else:
                    scale=min(2, math.sqrt(MAX_RENDER_PIXELS/(width*height)))
                    bitmap=page.render(scale=scale, limit_image_cache=True)
                    image=None
                    try:
                        image=bitmap.to_pil().convert("RGB")
                        # Only visually uniform, textless pages are automatically skipped.
                        uniform=all(low==high and low>=250 for low,high in image.getextrema())
                        if not native and uniform:
                            segment.status="skipped"
                            segment.warnings.append("Visually blank page skipped.")
                        else:
                            output=io.BytesIO()
                            image.save(output, format="PNG")
                            prepared,metadata=prepare_ocr_image(output.getvalue())
                            segment.method="ocr_space_engine3"
                            response=ocr.extract(prepared)
                            segment.text=response["text"]
                            segment.metadata.update({**metadata, "ocr_settings":response["settings"], "cache_hit":response["cache_hit"], "ocr_image_sha256":response.get("image_sha256"), "ocr_regions":response.get("regions", []), "ocr_region_status":response.get("region_status", "unavailable"), "ocr_coordinate_space":"uploaded_image_pixels"})
                            segment.warnings.append("OCR replaces this page's native text to avoid duplicate extraction.")
                            if response.get("cache_warning"):segment.warnings.append(response["cache_warning"])
                            if has_image:segment.warnings.append("Image-bearing page OCRed conservatively, including possible logos.")
                    finally:
                        if image is not None:image.close()
                        bitmap.close()
                if segment.status=="ready":
                    segment.warnings.append("PDF reading order and dish/price associations require human review.")
            except (ExtractionError, pdfium.PdfiumError, OSError, ValueError) as error:
                segment.status="failed"
                segment.error=str(error) if isinstance(error, ExtractionError) else "PDF page extraction or rendering failed."
            finally:
                if page is not None:page.close()
            segments.append(segment)
    finally:
        document.close()
    return segments
