import json
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def finalized_retention(sessions, dish_id):
    completed = [
        session for session in sessions
        if session["completion_status"] == "completed"
    ]

    eligible_savers = [
        session for session in completed
        if dish_id in session["directly_saved_dishes"]
    ]

    retained = sum(
        dish_id in session["saved_dishes"]
        for session in eligible_savers
    )

    denominator = len(eligible_savers)

    return {
        "eligible_completed_savers": denominator,
        "retained_sessions": retained,
        "rate": retained / denominator if denominator else None,
        "excluded_unfinished_sessions": sum(
            session["completion_status"] != "completed"
            for session in sessions
        )
    }


class TestSessionCompletion(unittest.TestCase):

    def test_unfinished_session_excluded_from_retention(self):
        # Read the actual JSON example included in the handoff.
        json_path = PROJECT_ROOT / "expected_answers.json"

        with json_path.open("r", encoding="utf-8") as file:
            data = json.load(file)

        example = data["unfinished_session_example"]
        sessions = example["sessions"]
        expected = example["expected"]

        result = finalized_retention(sessions, "dish-A")

        self.assertEqual(
            result["eligible_completed_savers"],
            expected["eligible_completed_savers"]
        )
        self.assertEqual(
            result["retained_sessions"],
            expected["retained_sessions"]
        )
        self.assertEqual(
            result["rate"],
            expected["finalized_retention_rate"]
        )
        self.assertEqual(
            result["excluded_unfinished_sessions"],
            expected["excluded_unfinished_sessions"]
        )

    def test_completed_saver_who_unsaved_is_not_retained(self):
        sessions = [
            {
                "session_id": "session-A",
                "completion_status": "completed",
                "directly_saved_dishes": ["dish-A"],
                "saved_dishes": []
            }
        ]

        result = finalized_retention(sessions, "dish-A")

        self.assertEqual(result["eligible_completed_savers"], 1)
        self.assertEqual(result["retained_sessions"], 0)
        self.assertEqual(result["rate"], 0.0)

    def test_no_eligible_completed_savers(self):
        sessions = [
            {
                "session_id": "session-B",
                "completion_status": "completed",
                "directly_saved_dishes": [],
                "saved_dishes": []
            }
        ]

        result = finalized_retention(sessions, "dish-A")

        self.assertEqual(result["eligible_completed_savers"], 0)
        self.assertIsNone(result["rate"])


if __name__ == "__main__":
    unittest.main()
