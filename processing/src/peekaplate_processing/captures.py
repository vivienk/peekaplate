import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import open_image
from peekaplate_processing.schemas import CaptureCandidate, NonEmptyText
from peekaplate_processing.sources import read_file


class CaptureInput(BaseModel):

    model_config=ConfigDict(extra="forbid")

    draft_id:NonEmptyText
    restaurant_id:NonEmptyText
    file:NonEmptyText
    captured_at:datetime|None=None
    capture_evidence:NonEmptyText
    rights_confirmed:bool=Field(strict=True)
    origin:str


def add_capture_candidates(result, manifest:str|Path, restaurant_id:str|None, *, max_age_days:int|None=None)->None:
    if not restaurant_id or not restaurant_id.strip():
        raise ExtractionError("Capture matching requires the caller's --restaurant-id; it is not inferred from menu content.")
    if max_age_days is not None and not 1<=max_age_days<=3650:
        raise ExtractionError("Capture maximum age must be between 1 and 3650 days when configured.")
    manifest=Path(manifest)
    try:
        raw=read_file(manifest)
        if len(raw)>100_000:raise ValueError
        values=json.loads(raw)
        if not isinstance(values, list) or len(values)>100:raise ValueError
        entries=[CaptureInput.model_validate(value) for value in values]
    except (ValueError, TypeError, ValidationError, RecursionError):
        raise ExtractionError("Capture manifest must be a bounded list of declared capture records.") from None
    requests={request.draft_id:request for request in result.capture_requests}
    pending=[]
    now=datetime.now(timezone.utc)
    for entry in entries:
        if entry.restaurant_id!=restaurant_id or entry.draft_id not in requests:
            raise ExtractionError("Capture does not match this job's restaurant and stable draft ID.")
        if not entry.rights_confirmed or entry.origin!="restaurant_capture":
            raise ExtractionError("Capture must declare restaurant origin and confirmed usage rights.")
        warnings=["Backend/staff verification of the actual dish, revision and capture provenance is still required."]
        if entry.captured_at is None:
            warnings.append("Capture date is unknown; freshness is unverified.")
        elif entry.captured_at.tzinfo is None or entry.captured_at.utcoffset() is None or entry.captured_at>now:
            raise ExtractionError("Capture date must include a timezone and must not be in the future.")
        elif max_age_days is None:
            warnings.append("No capture-age policy was configured; freshness requires review.")
        elif (now-entry.captured_at).total_seconds()>max_age_days*86400:
            raise ExtractionError("Capture is older than the configured freshness policy.")
        data=read_file(manifest.parent/entry.file)
        image=open_image(data)
        try:
            asset=CaptureCandidate(
                asset_sha256=hashlib.sha256(data).hexdigest(), filename=Path(entry.file).name,
                restaurant_id=entry.restaurant_id, captured_at=entry.captured_at,
                uploaded_at=now, capture_evidence=entry.capture_evidence,
                rights_confirmed=True, origin="restaurant_capture",
                width=image.width, height=image.height, warnings=warnings,
            )
        finally:
            image.close()
        pending.append((requests[entry.draft_id], asset))
    for request,asset in pending:
        request.candidates.append(asset)
        request.status="needs_review"
    # Candidate metadata never grants backend approval or changes DishDraft.image_id.
