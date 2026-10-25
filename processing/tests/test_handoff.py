import json
import unittest
from pathlib import Path

from peekaplate_processing.schemas import SourceSegment, SourceSpan


class HandoffTests(unittest.TestCase):
    def test_shared_spans_select_exact_source_text(self):
        fixtures = json.loads((Path(__file__).parent / "fixtures/source-spans.json").read_text(encoding="utf-8"))
        for fixture in fixtures:
            with self.subTest(segment_id=fixture["segment_id"]):
                segment = SourceSegment(segment_id=fixture["segment_id"], method="pdf_native", text=fixture["text"])
                span = SourceSpan(segment_id=segment.segment_id, **fixture["code_point_span"])
                self.assertEqual(segment.text[span.start:span.end], fixture["evidence_text"])
                self.assertEqual(len(segment.text[:span.start].encode("utf-16-le")) // 2, fixture["utf16_span"]["start"])
                self.assertEqual(len(segment.text[:span.end].encode("utf-16-le")) // 2, fixture["utf16_span"]["end"])
