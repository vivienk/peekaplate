"""Local, bounded PDF and image inputs."""
from pathlib import Path
from peekaplate_processing.errors import ExtractionError

MAX_SOURCE_BYTES = 12_000_000


def read_file(path: str | Path) -> bytes:
    try:
        with Path(path).open("rb") as source:
            data = source.read(MAX_SOURCE_BYTES + 1)
    except (OSError, ValueError):
        raise ExtractionError("Unable to read the input file.") from None
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise ExtractionError("Source must be nonempty and at most 12 MB.")
    return data


def detect_kind(data: bytes) -> str:
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF8", b"II*\0", b"MM\0*", b"BM")) or (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        return "image"
    raise ExtractionError("Use a local PDF or supported menu image.")
