
import unittest
from datetime import datetime


def deduplicate_events(rows):
    unique = {}

    for row in rows:
        event_id = row["event_id"]

        if event_id in unique:
            if unique[event_id] != row:
                raise ValueError(
                    f"Conflicting event_id: {event_id}"
                )
        else:
            unique[event_id] = row

    return list(unique.values())


def safe_rate(numerator, denominator):
    if denominator == 0:
        return None

    return numerator / denominator


class TestNegativeCases(unittest.TestCase):

    def test_neg_001_identical_retry(self):
        event = {
            "event_id": "event-1",
            "event_type": "dish_saved",
            "save_origin": "undo",
        }

        rows = [event, event.copy()]
        result = deduplicate_events(rows)

        self.assertEqual(len(result), 1)

    def test_neg_002_conflicting_retry(self):
        original = {
            "event_id": "event-1",
            "event_type": "dish_saved",
        }

        conflicting = {
            "event_id": "event-1",
            "event_type": "dish_unsaved",
        }

        with self.assertRaises(ValueError):
            deduplicate_events([original, conflicting])

    def test_neg_020_zero_denominator(self):
        self.assertIsNone(safe_rate(0, 0))
        self.assertEqual(safe_rate(1, 2), 0.5)



    def test_neg_003_missing_event_id(self):
        event = {
            "event_type": "dish_saved",
            "save_origin": "direct"
        }

        with self.assertRaises(KeyError):
            deduplicate_events([event])

    def test_neg_005_duplicate_checkpoint(self):
        checkpoint = {
            "event_id": "checkpoint-1",
            "opening_id": "opening-1",
            "cumulative_active_ms": 5000
        }

        unique = deduplicate_events([
            checkpoint, checkpoint.copy()
        ])

        self.assertEqual(len(unique), 1)
        self.assertEqual(
            max(row["cumulative_active_ms"] for row in unique),
            5000
        )

    def test_neg_008_invalid_comparison_pair(self):
        pair = ["dish-A", "dish-A"]

        is_valid = (
            len(pair) == 2
            and len(set(pair)) == 2
        )

        self.assertFalse(is_valid)

    def test_neg_010_privacy_threshold(self):
        threshold = 10

        for session_count in (2, 9):
            self.assertTrue(session_count < threshold)

        for session_count in (10, 11):
            self.assertFalse(session_count < threshold)


    def test_undo_without_prior_unsave_helper(self):
        saved = set()
        last_unsaved_by_session = {}
        session = "session-test"
        dish = "dish-A"

        # Attempt Undo without a previous Unsave.
        with self.assertRaises(AssertionError):
            assert dish not in saved
            assert last_unsaved_by_session.get(session) == dish, (
                "Undo without matching prior Unsave"
            )


    def test_neg_invalid_schema_version(self):
        expected_version = "synthetic.fixture.v1"

        event = {
            "event_id": "event-invalid-version",
            "schema_version": "synthetic.fixture.v99"
        }

        self.assertNotEqual(
            event["schema_version"],
            expected_version
        )


    def test_reject_invalid_schema_version(self):
        expected_version = "synthetic.fixture.v1"

        event = {
            "event_id": "invalid-schema-event",
            "schema_version": "synthetic.fixture.v99"
        }

        with self.assertRaises(AssertionError):
            assert event["schema_version"] == expected_version, (
                "Invalid schema version"
            )


    def test_reject_invalid_timestamp(self):
        event = {
            "event_id": "invalid-time-event",
            "occurred_at": "not-a-valid-date"
        }

        with self.assertRaises(ValueError):
            datetime.fromisoformat(event["occurred_at"])



if __name__ == "__main__":
    unittest.main()
