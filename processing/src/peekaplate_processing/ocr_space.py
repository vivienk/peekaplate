import base64
import hashlib
import json
import math
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
from http.client import HTTPException

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import MAX_OCR_BYTES
from peekaplate_processing.ocr import OCRProvider
from peekaplate_processing.storage import save_json
from peekaplate_processing.ocr_regions import extract_regions


OCR_ENDPOINT="https://api.ocr.space/parse/image"
MAX_OCR_RESPONSE=2_000_000


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class OCRSpaceClient(OCRProvider):

    def __init__(self, api_key:str|None, *, cache_dir:str|Path|None=None, timeout:float=90):
        if not math.isfinite(timeout) or not 0<timeout<=120:
            raise ExtractionError("OCR timeout must be greater than zero and at most 120 seconds.")
        self.api_key=api_key
        self.cache_dir=Path(cache_dir) if cache_dir is not None else None
        self.timeout=timeout

    def extract(self, image:bytes)->dict:
        if not image or len(image)>MAX_OCR_BYTES:
            raise ExtractionError("OCR image exceeds the configured free upload limit.")
        image_hash=hashlib.sha256(image).hexdigest()
        settings={"OCREngine":3, "language":"auto", "isTable":True, "isOverlayRequired":True}
        cache_key=hashlib.sha256(json.dumps({"image":image_hash, "settings":settings}, sort_keys=True).encode()).hexdigest()
        cache_path=self.cache_dir/f"{cache_key}.json" if self.cache_dir else None
        if cache_path and cache_path.is_file():
            try:
                if cache_path.stat().st_size>MAX_OCR_RESPONSE:
                    raise ValueError
                cached=json.loads(cache_path.read_text(encoding="utf-8"))
                if cached["image_sha256"]!=image_hash or cached["settings"]!=settings:
                    raise ValueError
                self._check_text(cached["text"])
                return {**cached, "cache_hit":True}
            except (OSError, ValueError, TypeError, KeyError, RecursionError):
                raise ExtractionError("OCR cache entry is invalid; remove that entry and retry.") from None
        if not self.api_key or self.api_key.strip().lower()=="helloworld":
            raise ExtractionError("Set your own free OCR_SPACE_API_KEY to use OCR.space Engine 3.")
        if "\r" in self.api_key or "\n" in self.api_key:
            raise ExtractionError("OCR API key must not contain line breaks.")

        payload={**settings, "base64Image":"data:image/jpeg;base64,"+base64.b64encode(image).decode()}
        data=urlencode({key:str(value).lower() if isinstance(value, bool) else value for key,value in payload.items()}).encode()
        request=Request(OCR_ENDPOINT, data=data, headers={"apikey":self.api_key, "Content-Type":"application/x-www-form-urlencoded"}, method="POST")
        for attempt in range(2):
            try:
                with build_opener(NoRedirects()).open(request, timeout=self.timeout) as response:
                    body=response.read(MAX_OCR_RESPONSE+1)
                break
            except HTTPError as error:
                if error.code in {429, 500, 502, 503, 504} and attempt==0:
                    delay=error.headers.get("Retry-After", "1") if error.headers else "1"
                    if delay.isdigit() and int(delay)<=3:
                        time.sleep(max(1, int(delay)))
                        continue
                if error.code==429:
                    raise ExtractionError("OCR.space returned HTTP 429 (rate/quota limit); wait for the provider reset before retrying.") from None
                raise ExtractionError(f"OCR.space returned HTTP {error.code}; the request failed, and quota exhaustion is not established.") from None
            except (URLError, OSError, HTTPException):
                if attempt==0:
                    # A timeout may already have consumed quota. Retry only once.
                    time.sleep(1)
                    continue
                raise ExtractionError("OCR.space request failed or timed out after two attempts.") from None
            except ValueError:
                raise ExtractionError("OCR.space request configuration is invalid.") from None
        if len(body)>MAX_OCR_RESPONSE:
            raise ExtractionError("OCR.space response exceeded the size limit.")
        try:
            result=json.loads(body)
            pages=result["ParsedResults"]
            if result.get("IsErroredOnProcessing") is not False or str(result["OCRExitCode"])!="1":
                raise ValueError
            if not isinstance(pages, list) or len(pages)!=1 or str(pages[0]["FileParseExitCode"])!="1":
                raise ValueError
            text=pages[0]["ParsedText"]
            self._check_text(text)
        except (ValueError, TypeError, KeyError, IndexError, RecursionError):
            raise ExtractionError("OCR.space did not return a complete, usable page; no success was inferred.") from None
        output={"image_sha256":image_hash, "settings":settings, "text":text, "cache_hit":False, **extract_regions(pages[0])}
        if cache_path:
            try:
                save_json(output, cache_path)
            except ExtractionError:
                # Successful extraction does not depend on a writable cache.
                output["cache_warning"]="OCR result could not be cached."
        return output

    @staticmethod
    def _check_text(text):
        if not isinstance(text, str) or not text.strip() or len(text)>100_000 or "\0" in text:
            raise ValueError("Invalid OCR text.")
