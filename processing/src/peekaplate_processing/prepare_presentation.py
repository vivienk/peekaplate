import argparse
import json
from pathlib import Path
from typing import Sequence

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.presentation import (
    FilePresentationProvider,
    prepare_presentation_bundle,
)


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Budget must be a whole number of bytes.") from None
    if number <= 0:
        raise argparse.ArgumentTypeError("Budget must be greater than zero.")
    return number


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prepare and validate a post-cutout dish presentation asset, retaining T0 fallback on failure."
    )
    parser.add_argument("--t0-manifest", required=True, type=Path, help="manifest.json of an approved T0 bundle.")
    parser.add_argument("--cutout", required=True, type=Path, help="Transparent cutout PNG or WEBP.")
    parser.add_argument("--reference", required=True, type=Path, help="Framing/lighting reference image.")
    parser.add_argument("--candidate-png", required=True, type=Path, help="Generated presentation candidate PNG to validate.")
    parser.add_argument("--output-root", required=True, type=Path, help="Directory that receives the new presentation bundle.")
    parser.add_argument("--capture-evidence", required=True, type=str, help="Evidence identifying the source capture.")
    parser.add_argument("--draft-id", required=False, type=str, default=None, help="Optional draft ID link.")
    parser.add_argument("--model-version", required=False, type=str, default="offline-candidate-v1", help="Model version identifier.")
    parser.add_argument("--budget-bytes", required=False, type=positive_int, default=None, help="Optional presentation PNG byte budget.")
    parser.add_argument("--reconstructed-details-flagged", action="store_true", help="Flag that unseen food or details were reconstructed.")
    parser.add_argument("--preserved-original-viewpoint", action="store_true", help="Flag that original viewpoint was preserved due to limitations.")
    parser.add_argument("--fidelity-note", action="append", default=[], help="Fidelity note documenting limitations.")

    args = parser.parse_args(argv)

    try:
        provider = FilePresentationProvider(
            candidate_path=args.candidate_png,
            model_version=args.model_version,
            preserved_original_viewpoint=args.preserved_original_viewpoint,
            reconstructed_details_flagged=args.reconstructed_details_flagged,
            fidelity_notes=args.fidelity_note,
        )
        prepared = prepare_presentation_bundle(
            t0_manifest_path=args.t0_manifest,
            cutout_path=args.cutout,
            reference_path=args.reference,
            output_root=args.output_root,
            capture_evidence=args.capture_evidence,
            rights_confirmed=True,
            draft_id=args.draft_id,
            budget_bytes=args.budget_bytes,
            provider=provider,
            model_version=args.model_version,
            reconstructed_details_flagged=args.reconstructed_details_flagged,
            preserved_original_viewpoint=args.preserved_original_viewpoint,
            fidelity_notes=args.fidelity_note,
        )
    except ExtractionError as error:
        print(json.dumps({"status": "failed", "errors": [str(error)]}, ensure_ascii=False))
        return 2

    if prepared.manifest.processing.status == "fallback_retained":
        print(
            json.dumps(
                {
                    "status": "fallback_retained",
                    "asset_id": prepared.asset_id,
                    "directory": str(prepared.directory),
                    "manifest": str(prepared.directory / "presentation-manifest.json"),
                    "fallback_retained": True,
                    "active_display_path": prepared.manifest.active_display_path,
                    "review_status": prepared.manifest.review.status,
                    "publication_eligible": prepared.manifest.publication.eligible,
                    "errors": prepared.manifest.processing.validation_errors,
                },
                ensure_ascii=False,
            )
        )
        return 2

    print(
        json.dumps(
            {
                "status": "ready",
                "asset_id": prepared.asset_id,
                "directory": str(prepared.directory),
                "manifest": str(prepared.directory / "presentation-manifest.json"),
                "fallback_retained": False,
                "active_display_path": prepared.manifest.active_display_path,
                "review_status": prepared.manifest.review.status,
                "publication_eligible": prepared.manifest.publication.eligible,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
