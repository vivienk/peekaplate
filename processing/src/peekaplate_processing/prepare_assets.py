import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Sequence
from uuid import UUID

from peekaplate_processing.assets import prepare_t0_bundle
from peekaplate_processing.errors import ExtractionError


def timestamp(value:str)->datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise argparse.ArgumentTypeError("Capture date must be an ISO-8601 timestamp.") from None


def positive_int(value:str)->int:
    try:
        number=int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Budget must be a whole number of bytes.") from None
    if number<=0:
        raise argparse.ArgumentTypeError("Budget must be greater than zero.")
    return number


def main(argv:Sequence[str]|None=None)->int:
    parser=argparse.ArgumentParser(description="Prepare approved T0 delivery variants for one captured dish photo.")
    parser.add_argument("--input", required=True, type=Path, help="Captured dish photo to prepare.")
    parser.add_argument("--dish-id", required=True, type=UUID, help="Backend dish identifier supplied by the caller.")
    parser.add_argument("--revision-id", required=True, type=UUID, help="Backend dish revision identifier supplied by the caller.")
    parser.add_argument("--capture-evidence", required=True, help="What identifies this capture as the source.")
    parser.add_argument("--captured-at", type=timestamp, default=None, help="Optional ISO-8601 capture timestamp with a timezone.")
    parser.add_argument("--output-root", required=True, type=Path, help="Directory that receives the new bundle.")
    parser.add_argument("--budget-bytes", type=positive_int, default=None, help="Optional total variant byte ceiling.")
    args=parser.parse_args(argv)
    try:
        prepared=prepare_t0_bundle(
            input_path=args.input, output_root=args.output_root, dish_id=args.dish_id,
            revision_id=args.revision_id, capture_evidence=args.capture_evidence,
            captured_at=args.captured_at, budget_bytes=args.budget_bytes,
        )
    except ExtractionError as error:
        print(json.dumps({"status":"failed", "errors":[str(error)]}, ensure_ascii=False))
        return 2
    print(json.dumps({
        "status":"ready", "asset_id":prepared.asset_id, "directory":str(prepared.directory),
        "manifest":str(prepared.directory/"manifest.json"),
        "review_status":prepared.manifest.review.status, "publication_eligible":prepared.manifest.publication.eligible,
    }, ensure_ascii=False))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
