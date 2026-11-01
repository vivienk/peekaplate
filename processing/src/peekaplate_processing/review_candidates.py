"""Prepare existing extraction results for human review without OCR or LLM calls."""
import argparse
import base64
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.schemas import DishDraft, MenuExtractionResult, SourceSegment, SourceSpan, _box_evidence_links, validate_box_evidence
from peekaplate_processing.storage import save_json


CandidateField = Literal["description", "category", "price_amount", "price_currency", "ingredients"]
CANDIDATE_FIELDS = ("description", "category", "price_amount", "price_currency", "ingredients")


def missing_fields(draft:DishDraft)->list[CandidateField]:
    return [field for field in CANDIDATE_FIELDS if getattr(draft, field) is None
            and not (field == "price_amount" and draft.price_text is not None)]


class ReviewSource(BaseModel):

    model_config=ConfigDict(extra="forbid")

    source_id:str=Field(min_length=1)
    sha256:str=Field(pattern=r"^[0-9a-f]{64}$")
    kind:Literal["pdf", "image", "website", "text"]
    location:str=Field(min_length=1)
    retrieved_at:datetime
    size_bytes:int=Field(ge=1, le=12_000_000)


class ReviewCandidate(BaseModel):

    model_config=ConfigDict(extra="forbid")

    candidate_id:str=Field(min_length=1)
    original:DishDraft
    evidence:list[SourceSpan]=Field(min_length=1)
    missing_fields:list[CandidateField]

    @model_validator(mode="after")
    def validate_missing_fields(self):
        expected=missing_fields(self.original)
        if self.missing_fields != expected:
            raise ValueError("missing_fields must match the original fields; printed price options are not a missing price.")
        return self


class ReviewCandidateResult(BaseModel):

    model_config=ConfigDict(extra="forbid")

    schema_version:Literal[1, 2]=1
    extraction_id:str=Field(min_length=1)
    pipeline_version:Literal["2", "3"]="2"
    status:Literal["complete", "incomplete", "failed"]
    started_at:datetime
    finished_at:datetime|None
    extraction_model:str|None
    source:ReviewSource
    segments:list[SourceSegment]
    candidates:list[ReviewCandidate]
    warnings:list[str]
    errors:list[str]

    @model_validator(mode="after")
    def validate_evidence(self):
        if (self.schema_version, self.pipeline_version) not in {(1, "2"), (2, "3")}:
            raise ValueError("Review schema and pipeline versions do not match.")
        if self.schema_version == 1 and any(
            candidate.original.subcategory is not None or candidate.original.category_page_number is not None or candidate.original.price_text is not None
            for candidate in self.candidates
        ):
            raise ValueError("Category hierarchy and printed price fields require review schema 2.")
        references=[self.extraction_id, self.source.location]
        references.extend(segment.segment_id for segment in self.segments)
        references.extend(candidate.candidate_id for candidate in self.candidates)
        if any(not reference.strip() for reference in references):
            raise ValueError("Source and candidate references cannot be blank.")
        for timestamp in (self.started_at, self.finished_at, self.source.retrieved_at):
            if timestamp is not None and timestamp.utcoffset() is None:
                raise ValueError("Provenance timestamps must include a timezone.")
        segments={segment.segment_id:segment for segment in self.segments}
        if len(segments) != len(self.segments):
            raise ValueError("Segment identifiers must be unique.")
        if len({candidate.candidate_id for candidate in self.candidates}) != len(self.candidates):
            raise ValueError("Candidate identifiers must be unique within an extraction.")
        if self.source.source_id != f"sha256:{self.source.sha256}":
            raise ValueError("Source identifier must match its hash.")
        if self.status == "failed" and self.candidates:
            raise ValueError("A failed extraction cannot contain reviewable candidates.")
        heading_pages={segment.page_number for segment in self.segments if segment.status == "ready" and segment.error is None and segment.text.strip()}
        for candidate in self.candidates:
            if candidate.original.source_id != self.source.source_id:
                raise ValueError("Candidate source does not match the extraction source.")
            if candidate.original.category_page_number is not None and candidate.original.category_page_number not in heading_pages:
                raise ValueError("Category heading must reference a readable, error-free source page.")
            passages=[]
            for span in candidate.evidence:
                segment=segments.get(span.segment_id)
                if segment is None or segment.status != "ready" or segment.error is not None:
                    raise ValueError("Candidate evidence must reference a ready, error-free segment.")
                if not 0 <= span.start < span.end <= len(segment.text):
                    raise ValueError("Candidate evidence offsets are outside the source text.")
                passages.append(segment.text[span.start:span.end])
            if "\n".join(passages) != candidate.original.source_text:
                raise ValueError("Candidate evidence must reconstruct the original source text.")
        # Validate public OCR links on JSON reload as well as preparation.
        boxes_by_candidate = {candidate.candidate_id: [] for candidate in self.candidates}
        for segment in self.segments:
            if "candidate_box_evidence" not in segment.metadata:
                continue
            mapping = segment.metadata["candidate_box_evidence"]
            if not isinstance(mapping, dict) or not mapping:
                raise ValueError("Public candidate box links must be a nonempty map.")
            for key, boxes in mapping.items():
                if key not in boxes_by_candidate or not isinstance(boxes, list) or not boxes:
                    raise ValueError("Public box links require existing candidates and nonempty records.")
                boxes_by_candidate[key].extend(boxes)
        _box_evidence_links(self.source, self.segments, [
            (candidate.candidate_id, candidate.original, candidate.evidence, boxes_by_candidate[candidate.candidate_id])
            for candidate in self.candidates
        ])
        return self


def prepare_review_candidates(report:MenuExtractionResult)->ReviewCandidateResult:
    public_links=validate_box_evidence(report)
    if report.source is None:
        raise ValueError("An extraction source is required.")
    source=report.source
    snapshot=base64.b64decode(source.snapshot_base64, validate=True)
    if len(snapshot) != source.size_bytes or hashlib.sha256(snapshot).hexdigest() != source.sha256:
        raise ValueError("Original source snapshot does not match its size and hash.")
    by_index={evidence.draft_index:evidence for evidence in report.evidence}
    if len(by_index) != len(report.evidence) or set(by_index) != set(range(len(report.drafts))):
        raise ValueError("Every draft must have exactly one evidence record.")

    candidates=[]
    for index,draft in enumerate(report.drafts):
        evidence=by_index[index]
        candidates.append(ReviewCandidate(
            candidate_id=evidence.draft_id,
            original=draft.model_copy(deep=True),
            evidence=[span.model_copy(deep=True) for span in evidence.spans],
            missing_fields=missing_fields(draft),
        ))
    identity=f"{source.source_id}:{report.started_at.isoformat()}:{report.pipeline_version}"
    extraction_id="extraction:"+hashlib.sha256(identity.encode()).hexdigest()[:32]
    segments=[segment.model_copy(deep=True) for segment in report.segments]
    for segment in segments:
        if segment.segment_id in public_links:
            segment.metadata["candidate_box_evidence"]=public_links[segment.segment_id]
        # Preserve vision_boxes in public review candidate metadata when present
        orig_seg = next((s for s in report.segments if s.segment_id == segment.segment_id), None)
        if orig_seg and "vision_boxes" in orig_seg.metadata:
            # Map draft_id to candidate_id
            draft_to_cand = {by_index[i].draft_id: candidates[i].candidate_id for i in range(len(candidates))}
            mapped_boxes = {}
            for d_id, b_list in orig_seg.metadata["vision_boxes"].items():
                target_id = draft_to_cand.get(d_id, d_id)
                mapped_boxes[target_id] = b_list
            segment.metadata["vision_boxes"] = mapped_boxes
    return ReviewCandidateResult(
        schema_version=report.schema_version,
        extraction_id=extraction_id,
        pipeline_version=report.pipeline_version,
        status=report.status,
        started_at=report.started_at,
        finished_at=report.finished_at,
        extraction_model=report.extraction_model,
        source=ReviewSource.model_validate(source.model_dump(exclude={"snapshot_base64"})),
        segments=segments,
        candidates=candidates,
        warnings=list(report.warnings),
        errors=list(report.errors),
    )


def export_review_candidates(input_path:Path, output_path:Path)->ReviewCandidateResult:
    try:
        with input_path.open("rb") as handle:
            content=handle.read(32_000_001)
        if len(content) > 32_000_000:
            raise ValueError("Extraction report exceeds 32 MB.")
        report=MenuExtractionResult.model_validate_json(content)
        result=prepare_review_candidates(report)
    except (OSError, ValueError):
        raise ExtractionError("Invalid extraction report or candidate evidence; no review export was written.") from None
    save_json(result.model_dump(mode="json"), output_path)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Existing full extraction.json report.")
    parser.add_argument("--output", required=True, type=Path, help="New review-candidates.json path.")
    args=parser.parse_args(argv)
    try:
        result=export_review_candidates(args.input, args.output)
    except ExtractionError as error:
        parser.exit(1, f"Review export failed: {error}\n")
    print(f"Saved {len(result.candidates)} candidates ({result.status}) to {args.output}.")
    print("All candidates need human review. No OCR/LLM calls or publication occurred.")
    return 0


if __name__ == "__main__": raise SystemExit(main())
