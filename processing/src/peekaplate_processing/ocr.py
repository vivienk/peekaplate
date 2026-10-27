from abc import ABC, abstractmethod

from peekaplate_processing.errors import ExtractionError


class OCRProvider(ABC):

    @abstractmethod
    def extract(self, image:bytes)->dict:
        """Return OCR.space Engine 3-compatible text, settings and cache_hit.

        settings must contain the integer OCREngine=3. Other providers/engines
        need an explicit evidence contract before they can be used here.
        Providers may also return image_sha256, regions, region_status and
        cache_warning. Image preparation belongs to the caller. Raise
        ExtractionError when extraction fails.
        """
        raise NotImplementedError


def validate_ocr_settings(response:dict)->None:
    settings=response.get("settings")
    engine=settings.get("OCREngine") if isinstance(settings, dict) else None
    if type(engine) is not int or engine!=3:
        raise ExtractionError("OCR provider must return OCR.space Engine 3-compatible settings (OCREngine=3).")
