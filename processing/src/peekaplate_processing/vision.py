"""Bounded source-page images. These are page evidence, never dish photographs."""
import base64
import hashlib
import io
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import pymupdf
from PIL import Image

from .errors import ExtractionError
from .images import open_image
from .pdf import MAX_PDF_PAGES, MAX_RENDER_PIXELS
from .schemas import MenuExtractionResult, SourceRecord
from .sources import detect_kind, read_file

MAX_IMAGE_BYTES=8_000_000


def image_source(source):
    """Create provenance without constructing an OCR client or reading native text."""
    data=read_file(source)
    kind=detect_kind(data)
    digest=hashlib.sha256(data).hexdigest()
    now=datetime.now(timezone.utc)
    return MenuExtractionResult(started_at=now,source=SourceRecord(
        source_id=f"sha256:{digest}",sha256=digest,kind=kind,location=Path(source).name,
        retrieved_at=now,size_bytes=len(data),snapshot_base64=base64.b64encode(data).decode()))


def normalize_page_selection(values, *, limit=MAX_PDF_PAGES):
    if (not isinstance(values, (list, tuple)) or not 1 <= len(values) <= limit
            or any(type(n) is not int or not 1 <= n <= MAX_PDF_PAGES for n in values)
            or len(set(values)) != len(values)):
        raise ExtractionError("Select distinct source page numbers within the recovery limit.")
    return tuple(sorted(values))


def page_images(source, directory, *, page_numbers=None):
    selected=None if page_numbers is None else normalize_page_selection(page_numbers)
    data=base64.b64decode(source.snapshot_base64,validate=True)
    if len(data)!=source.size_bytes or hashlib.sha256(data).hexdigest()!=source.sha256:
        raise ExtractionError("Image source snapshot does not match its hash and size.")
    folder=Path(directory)/"pages"
    folder.mkdir(mode=0o700)
    images=[]
    errors=[]

    def retain(number,content,mime,width,height):
        if not content or len(content)>MAX_IMAGE_BYTES:
            raise ExtractionError("Page image exceeds the 8 MB model-image limit.")
        suffix="png" if mime=="image/png" else "jpg"
        relative=f"pages/{number:02d}.{suffix}"
        with os.fdopen(os.open(Path(directory)/relative,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),"wb") as handle:
            handle.write(content)
        reference={"path":relative,"path_scope":"local_run","source_id":source.source_id,"source_page":number,
                   "sha256":hashlib.sha256(content).hexdigest(),"mime_type":mime,
                   "width":width,"height":height,"region":{"scope":"page","coordinate_space":"image_pixels",
                   "left":0,"top":0,"width":width,"height":height}}
        images.append({"page_number":number,"image_url":f"data:{mime};base64,"+base64.b64encode(content).decode(),
                       "image_reference":reference})

    if source.kind=="pdf":
        try:
            with pymupdf.open(stream=data,filetype="pdf") as document:
                if document.needs_pass or not 1<=len(document)<=MAX_PDF_PAGES:
                    raise ExtractionError("PDF must be unlocked and contain between 1 and 40 pages.")
                if selected is not None and any(number > len(document) for number in selected):
                    raise ExtractionError("Selected page is outside the source PDF.")
                for index in range(len(document)):
                    if selected is not None and index+1 not in selected:
                        continue
                    try:
                        page=document.load_page(index)
                        width,height=page.rect.width,page.rect.height
                        if not all(math.isfinite(v) and 0<v<=14_400 for v in (width,height)):
                            raise ExtractionError("PDF dimensions exceed the image rendering limit.")
                        scale=min(2,math.sqrt(MAX_RENDER_PIXELS/(width*height)))
                        pixels=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),colorspace=pymupdf.csRGB,alpha=False)
                        retain(index+1,pixels.tobytes("png"),"image/png",pixels.width,pixels.height)
                    except (ExtractionError,RuntimeError,ValueError,OSError):
                        errors.append(f"Page {index+1}: source image could not be prepared within the rendering limits.")
        except (RuntimeError,ValueError):
            raise ExtractionError("Unable to render the source PDF.") from None
    elif source.kind=="image":
        if selected is not None and selected != (1,):
            raise ExtractionError("A source photo has only page 1.")
        with open_image(data) as image:
            with Image.open(io.BytesIO(data)) as original:
                original_format=original.format
                orientation=original.getexif().get(274,1)
            if original_format in {"PNG","JPEG"} and orientation==1 and image.width*image.height<=MAX_RENDER_PIXELS and len(data)<=MAX_IMAGE_BYTES:
                retain(1,data,"image/png" if original_format=="PNG" else "image/jpeg",image.width,image.height)
            else:
                scale=min(1,math.sqrt(MAX_RENDER_PIXELS/(image.width*image.height)))
                image.thumbnail((max(1,int(image.width*scale)),max(1,int(image.height*scale))))
                output=io.BytesIO()
                image.save(output,format="JPEG",quality=95,optimize=True)
                retain(1,output.getvalue(),"image/jpeg",image.width,image.height)
    else:
        raise ExtractionError("Image input modes require a PDF or photo.")
    return images,errors
