import argparse
import json
from pathlib import Path
from typing import Sequence

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.spatial import prepare_spatial_bundle


def positive_int(value:str)->int:
    try:
        number=int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Budget must be a whole number of bytes.") from None
    if number<=0:
        raise argparse.ArgumentTypeError("Budget must be greater than zero.")
    return number


def main(argv:Sequence[str]|None=None)->int:
    parser=argparse.ArgumentParser(description="Validate a human-prepared layered sample against an approved T0 asset.")
    parser.add_argument("--t0-manifest", required=True, type=Path, help="manifest.json of an approved T0 bundle.")
    parser.add_argument("--layers", required=True, type=Path, help="Layers input manifest describing the layered sample.")
    parser.add_argument("--output-root", required=True, type=Path, help="Directory that receives the new spatial bundle.")
    parser.add_argument("--budget-bytes", required=True, type=positive_int, help="Total spatial asset byte ceiling.")
    args=parser.parse_args(argv)
    try:
        prepared=prepare_spatial_bundle(
            t0_manifest_path=args.t0_manifest, layers_manifest_path=args.layers,
            output_root=args.output_root, budget_bytes=args.budget_bytes,
        )
    except ExtractionError as error:
        print(json.dumps({"status":"failed", "errors":[str(error)]}, ensure_ascii=False))
        return 2
    print(json.dumps({
        "status":"ready", "asset_id":prepared.asset_id, "directory":str(prepared.directory),
        "manifest":str(prepared.directory/"spatial-manifest.json"),
        "harness":str(prepared.directory/"harness.html"),
        "review_status":prepared.manifest.review.status, "publication_eligible":prepared.manifest.publication.eligible,
    }, ensure_ascii=False))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
