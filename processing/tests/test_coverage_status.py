import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from fixture_factory import make_pdf
from test_input_modes import RecordingLLM
from peekaplate_processing.review_candidates import export_review_candidates
from peekaplate_processing.run_pipeline import run_pipeline, saved_page_text
from peekaplate_processing.schemas import SourceSegment
from peekaplate_processing.vision import image_source


class CoverageStatusTest(unittest.TestCase):
    def _make_four_page_source(self, root: Path):
        source = root / "source.pdf"
        source.write_bytes(make_pdf([{"text": "Soup 8.50"} for _ in range(4)]))
        base = image_source(source)
        return source, base

    def test_saved_coverage_through_save_and_export(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, saved = self._make_four_page_source(root)
            saved.status = "incomplete"
            saved.segments = [
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-1",
                    page_number=1,
                    method="pdf_native",
                    status="ready",
                    text="Soup 8.50",
                ),
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-2",
                    page_number=2,
                    method="ocr_space_engine3",
                    status="failed",
                    text="",
                    error="OCR timeout on page 2.",
                ),
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-3",
                    page_number=3,
                    method="ocr_space_engine3",
                    status="skipped",
                    text="",
                ),
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-4",
                    page_number=4,
                    method="ocr_space_engine3",
                    status="ready",
                    text="Soup 8.50",
                    error="Partial OCR acquisition warning-level error.",
                ),
            ]
            saved.errors = [
                "Page 2: OCR timeout on page 2.",
                "Page 3: Saved page acquisition was skipped.",
                "Page 4: Partial OCR acquisition warning-level error.",
            ]
            saved.configuration["failed_ocr_recovery"] = {
                "input_report_sha256": "a" * 64,
                "selected_pages": [2, 3],
                "max_requests": 2,
                "pages": [
                    {"page_number": 2, "status": "failed", "error": "OCR timeout on page 2."},
                    {"page_number": 3, "status": "not_attempted"},
                ],
            }
            pages_file = root / "saved_pages.json"
            pages_file.write_text(saved.model_dump_json())

            # Even when tested individually (e.g. only skipped or only ready-with-error),
            # saved_page_text and run_pipeline must keep incomplete status and errors.
            for label, modified_segments in [
                (
                    "skipped_only",
                    [
                        saved.segments[0],
                        SourceSegment(
                            segment_id=f"{saved.source.source_id}#page-2",
                            page_number=2,
                            method="ocr_space_engine3",
                            status="skipped",
                            text="",
                        ),
                        SourceSegment(
                            segment_id=f"{saved.source.source_id}#page-3",
                            page_number=3,
                            method="pdf_native",
                            status="ready",
                            text="Soup 8.50",
                        ),
                        SourceSegment(
                            segment_id=f"{saved.source.source_id}#page-4",
                            page_number=4,
                            method="pdf_native",
                            status="ready",
                            text="Soup 8.50",
                        ),
                    ],
                ),
                (
                    "ready_with_error_only",
                    [
                        saved.segments[0],
                        SourceSegment(
                            segment_id=f"{saved.source.source_id}#page-2",
                            page_number=2,
                            method="pdf_native",
                            status="ready",
                            text="Soup 8.50",
                        ),
                        SourceSegment(
                            segment_id=f"{saved.source.source_id}#page-3",
                            page_number=3,
                            method="pdf_native",
                            status="ready",
                            text="Soup 8.50",
                        ),
                        saved.segments[3],
                    ],
                ),
                ("combined", saved.segments),
            ]:
                with self.subTest(case=label):
                    case_saved = saved.model_copy(deep=True)
                    case_saved.segments = modified_segments
                    case_file = root / f"{label}.json"
                    case_file.write_text(case_saved.model_dump_json())

                    loaded = saved_page_text(source, case_file)
                    self.assertTrue(loaded.errors, f"{label}: expected acquisition errors to be retained")
                    self.assertIn(
                        "failed_ocr_recovery",
                        loaded.configuration,
                        f"{label}: expected failed_ocr_recovery history to be retained",
                    )

                    run_dir = root / f"run_{label}"
                    llm = RecordingLLM()
                    report = run_pipeline(
                        source,
                        run_dir,
                        llm=llm,
                        pages_json=case_file,
                        input_mode="ocr",
                        llm_cache_dir=None,
                    )
                    self.assertEqual(report.status, "incomplete")
                    self.assertTrue(report.drafts)
                    self.assertTrue(report.errors)
                    self.assertEqual(
                        report.configuration.get("failed_ocr_recovery"),
                        saved.configuration["failed_ocr_recovery"],
                    )

                    saved_pages_out = json.loads((run_dir / "pages.json").read_text())
                    saved_extraction_out = json.loads((run_dir / "extraction.json").read_text())
                    self.assertEqual(saved_extraction_out["status"], "incomplete")
                    self.assertEqual(
                        [s["status"] for s in saved_pages_out["segments"]],
                        [s.status for s in modified_segments],
                    )
                    self.assertEqual(
                        [s["status"] for s in saved_extraction_out["segments"]],
                        [s.status for s in modified_segments],
                    )

                    if label == "combined":
                        self.assertTrue(any("Page 2:" in e for e in report.errors))
                        self.assertTrue(any("Page 3:" in e for e in report.errors))
                        self.assertTrue(any("Page 4:" in e for e in report.errors))

                    candidates_out = root / f"candidates_{label}.json"
                    exported = export_review_candidates(run_dir / "extraction.json", candidates_out)
                    self.assertEqual(exported.status, "incomplete")
                    self.assertTrue(exported.errors)

    def test_rerun_keeps_superseded_model_history(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            source.write_bytes(make_pdf([{"text": "Soup 8.50"}, {"text": "Soup 8.50"}]))
            saved = image_source(source)
            saved.status = "incomplete"
            saved.segments = [
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-1",
                    page_number=1,
                    method="pdf_native",
                    status="ready",
                    text="Soup 8.50",
                ),
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-2",
                    page_number=2,
                    method="pdf_native",
                    status="ready",
                    text="Soup 8.50",
                ),
            ]
            saved.errors = ["LLM batch 1 (pages 2): request timed out after 90s."]
            saved.configuration["llm_batches"] = [
                {"batch_index": 0, "page_numbers": [1], "model_status": "succeeded"},
                {"batch_index": 1, "page_numbers": [2], "model_status": "failed", "error": "timeout"},
            ]
            pages_file = root / "saved_model_fail.json"
            raw_bytes = saved.model_dump_json().encode()
            pages_file.write_bytes(raw_bytes)

            # 1) Full rerun of all ready pages: historical model error is retained as superseded
            # history, not promoted into a current acquisition failure.
            full_run = root / "run_full"
            report_full = run_pipeline(
                source,
                full_run,
                llm=RecordingLLM(),
                pages_json=pages_file,
                input_mode="ocr",
                llm_cache_dir=None,
            )
            self.assertEqual(report_full.status, "complete")
            self.assertEqual(report_full.errors, [])
            superseded = report_full.configuration.get("superseded_model_history")
            self.assertIsNotNone(superseded)
            self.assertEqual(superseded["input_report_sha256"], hashlib.sha256(raw_bytes).hexdigest())
            self.assertEqual(superseded["previous_status"], "incomplete")
            self.assertEqual(superseded["previous_errors"], ["LLM batch 1 (pages 2): request timed out after 90s."])
            self.assertEqual(len(superseded["previous_model_batches"]), 2)

            # 2) Targeted subset rerun of page 2 only: unselected page 1 keeps overall status incomplete
            # while preserving targeted_model_recovery history.
            subset_run = root / "run_subset"
            report_subset = run_pipeline(
                source,
                subset_run,
                llm=RecordingLLM(),
                pages_json=pages_file,
                input_mode="ocr",
                target_pages=[2],
                max_model_requests=1,
                llm_cache_dir=None,
            )
            self.assertEqual(report_subset.status, "incomplete")
            self.assertIn("targeted_model_recovery", report_subset.configuration)
            self.assertEqual(
                report_subset.configuration["targeted_model_recovery"]["previous_errors"],
                ["LLM batch 1 (pages 2): request timed out after 90s."],
            )

    def test_complete_saved_input_control(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.pdf"
            source.write_bytes(make_pdf([{"text": "Soup 8.50"}, {"text": "Soup 8.50"}]))
            saved = image_source(source)
            saved.status = "complete"
            saved.segments = [
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-1",
                    page_number=1,
                    method="pdf_native",
                    status="ready",
                    text="Soup 8.50",
                ),
                SourceSegment(
                    segment_id=f"{saved.source.source_id}#page-2",
                    page_number=2,
                    method="pdf_native",
                    status="ready",
                    text="Soup 8.50",
                ),
            ]
            pages_file = root / "saved_complete.json"
            pages_file.write_text(saved.model_dump_json())

            run_dir = root / "run_complete"
            report = run_pipeline(
                source,
                run_dir,
                llm=RecordingLLM(),
                pages_json=pages_file,
                input_mode="ocr",
                llm_cache_dir=None,
            )
            self.assertEqual(report.status, "complete")
            self.assertEqual(report.errors, [])
            self.assertEqual(len(report.drafts), 2)
            exported = export_review_candidates(run_dir / "extraction.json", root / "candidates.json")
            self.assertEqual(exported.status, "complete")
            self.assertEqual(exported.errors, [])


if __name__ == "__main__":
    unittest.main()
