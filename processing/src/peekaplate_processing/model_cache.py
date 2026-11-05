"""Private cache of complete model candidates, always revalidated on reuse."""
import hashlib
import json
from pathlib import Path

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.storage import save_json


def cache_path(directory, llm, source_sha256, pages, prompt, schema):
    model = getattr(llm, "model_name", None)
    endpoint = getattr(llm, "openai_api_base", None)
    if directory is None or not source_sha256 or not model or not endpoint:
        return None
    settings = {name: getattr(llm, name, None) for name in (
        "max_tokens", "temperature", "top_p", "seed", "reasoning_effort",
        "reasoning", "extra_body", "model_kwargs",
    )}
    identity = {"version": 2, "source_sha256": source_sha256, "model": model,
                "endpoint": str(endpoint), "settings": settings, "pages": pages,
                "prompt": prompt, "schema": schema}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    return Path(directory) / f"{digest}.json"


def read_candidates(path):
    if path is None or not path.exists():
        return None
    try:
        with path.open("rb") as source:
            data = source.read(2_000_001)
        if len(data) > 2_000_000:
            raise ValueError
        record = json.loads(data)
        if set(record) != {"cache_key", "dishes", "sections"} or record["cache_key"] != path.stem:
            raise ValueError
        return {"dishes": record["dishes"], "sections":record["sections"]}
    except (OSError, ValueError, TypeError, RecursionError):
        raise ExtractionError("Model candidate cache is invalid; remove that entry or use --no-llm-cache.") from None


def write_candidates(path, dishes, sections=None):
    if path is None:
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    save_json({"cache_key": path.stem, "dishes": dishes, "sections":sections or []}, path)
