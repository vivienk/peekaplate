"""PeekaPlate Food3D V1 pipeline package (Stage 0-1: Input QA, Clean Cutouts, Multi-view Prep)."""

from __future__ import annotations

PUBLICATION_ELIGIBLE: bool = False
PIPELINE_VERSION: str = "food3d-v1"

TRIAGE_READY_SINGLE_PHOTO: str = "ready_single_photo"
TRIAGE_NEEDS_CLEAN_CUTOUT: str = "needs_clean_cutout"
TRIAGE_NEEDS_RESHOOT_CLIPPED: str = "needs_reshoot_clipped"
TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT: str = "needs_multiview_or_reshoot"

VALID_TRIAGE_STATES: tuple[str, ...] = (
    TRIAGE_READY_SINGLE_PHOTO,
    TRIAGE_NEEDS_CLEAN_CUTOUT,
    TRIAGE_NEEDS_RESHOOT_CLIPPED,
    TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT,
)

__all__ = [
    "PIPELINE_VERSION",
    "PUBLICATION_ELIGIBLE",
    "TRIAGE_NEEDS_CLEAN_CUTOUT",
    "TRIAGE_NEEDS_MULTIVIEW_OR_RESHOOT",
    "TRIAGE_NEEDS_RESHOOT_CLIPPED",
    "TRIAGE_READY_SINGLE_PHOTO",
    "VALID_TRIAGE_STATES",
]
