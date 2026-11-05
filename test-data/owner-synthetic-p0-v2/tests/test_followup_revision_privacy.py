import unittest
from collections import defaultdict


def revision_privacy_status(events, threshold=10):
    sessions_by_revision = defaultdict(set)

    for event in events:
        sessions_by_revision[event["revision_id"]].add(event["session_id"])

    return {
        revision: {
            "eligible_sessions": len(sessions),
            "status": "SUPPRESSED" if len(sessions) < threshold else "ELIGIBLE",
        }
        for revision, sessions in sessions_by_revision.items()
    }


class TestRevisionPrivacy(unittest.TestCase):
    def test_each_publication_revision_is_evaluated_separately(self):
        revisions = [
            ("rev-monday", 8),
            ("rev-tuesday", 12),
            ("rev-wednesday", 9),
            ("rev-thursday", 15),
        ]

        events = [
            {"revision_id": revision, "session_id": f"{revision}-session-{i}"}
            for revision, count in revisions
            for i in range(count)
        ]

        result = revision_privacy_status(events)

        self.assertEqual(result["rev-monday"]["status"], "SUPPRESSED")
        self.assertEqual(result["rev-tuesday"]["status"], "ELIGIBLE")
        self.assertEqual(result["rev-wednesday"]["status"], "SUPPRESSED")
        self.assertEqual(result["rev-thursday"]["status"], "ELIGIBLE")
        self.assertEqual(
            [result[revision]["eligible_sessions"] for revision, _ in revisions],
            [8, 12, 9, 15],
        )

    def test_privacy_threshold_boundaries_per_revision(self):
        revisions = [
            ("rev-nine", 9, "SUPPRESSED"),
            ("rev-ten", 10, "ELIGIBLE"),
            ("rev-eleven", 11, "ELIGIBLE"),
        ]

        events = [
            {
                "revision_id": revision,
                "session_id": f"{revision}-session-{i}",
            }
            for revision, count, _ in revisions
            for i in range(count)
        ]

        result = revision_privacy_status(events)

        for revision, count, expected_status in revisions:
            with self.subTest(revision=revision):
                self.assertEqual(
                    result[revision]["eligible_sessions"], count
                )
                self.assertEqual(
                    result[revision]["status"], expected_status
                )

if __name__ == "__main__":
    unittest.main()
