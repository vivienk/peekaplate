import json
import unittest
from datetime import datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def split_visits_on_inactivity(events, timeout_minutes=30):
    """A gap of 30 minutes or more starts a new visit."""
    if not events:
        return []

    ordered = sorted(
        events,
        key=lambda event: datetime.fromisoformat(event["timestamp"]),
    )

    visits = [[ordered[0]]]
    timeout = timedelta(minutes=timeout_minutes)

    for event in ordered[1:]:
        previous = visits[-1][-1]
        gap = (
            datetime.fromisoformat(event["timestamp"])
            - datetime.fromisoformat(previous["timestamp"])
        )

        if gap >= timeout:
            visits.append([event])
        else:
            visits[-1].append(event)

    return visits


def engagement_status(events):
    """Classify observed engagement without implying order completion."""
    opened = set()
    active_ms = {}

    for event in events:
        event_type = event["event_type"]

        if event_type == "dish_detail_opened":
            opened.add(event["dish_id"])

        elif event_type == "dish_activity_checkpoint":
            dish = event["dish_id"]
            if dish in opened:
                active_ms[dish] = max(
                    active_ms.get(dish, 0),
                    event["cumulative_active_ms"],
                )

        elif (
            event_type == "dish_compared"
            and event.get("compare_action") in ("start", "replace")
            and event.get("display_state") == "displayed"
            and opened.intersection(event.get("dish_ids", []))
        ):
            return "engaged (provisional)"

    if any(value >= 10000 for value in active_ms.values()):
        return "engaged (provisional)"

    if events and all(
        event["event_type"] == "menu_viewed" for event in events
    ):
        return "browse-only"

    return "not engaged"


def observed_save_retention(sessions, dish_id):
    """Descriptive Save retention; not checkout or order retention."""
    savers = [
        session for session in sessions
        if dish_id in session["directly_saved_dishes"]
    ]

    retained = sum(
        dish_id in session["saved_dishes"]
        for session in savers
    )

    count = len(savers)

    return {
        "directly_saved_sessions": count,
        "observed_retained_sessions": retained,
        "observed_retention_rate": retained / count if count else None,
    }


class TestSessionInactivity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        path = PROJECT_ROOT / "expected_answers.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        cls.example = data["session_inactivity_example"]

    def test_nonfinal_ten_second_checkpoint_agrees_with_considered_dishes(self):
        from test_metric_examples import considered_dishes

        events = [
            {
                "event_type": "dish_detail_opened",
                "dish_id": "dish-A",
                "opening_id": "opening-A",
            },
            {
                "event_type": "dish_activity_checkpoint",
                "dish_id": "dish-A",
                "opening_id": "opening-A",
                "cumulative_active_ms": 10000,
                "is_final": False,
            },
        ]

        self.assertEqual(considered_dishes(events), {"dish-A"})
        self.assertEqual(engagement_status(events), "engaged (provisional)")

    def test_standalone_engagement_examples(self):
        for session in self.example["sessions"]:
            with self.subTest(session=session["session_id"]):
                self.assertEqual(
                    engagement_status(session["events"]),
                    session["expected_engagement"],
                )

    def test_observed_save_retention(self):
        result = observed_save_retention(
            self.example["sessions"], "dish-A"
        )
        expected = self.example["expected"]

        self.assertEqual(
            result["directly_saved_sessions"],
            expected["directly_saved_sessions"],
        )
        self.assertEqual(
            result["observed_retained_sessions"],
            expected["observed_retained_sessions"],
        )
        self.assertEqual(
            result["observed_retention_rate"],
            expected["observed_retention_rate"],
        )

    def test_29_minute_gap_same_visit(self):
        events = [
            {"event_type": "menu_viewed", "timestamp": "2026-10-20T10:00:00+05:00"},
            {"event_type": "menu_viewed", "timestamp": "2026-10-20T10:29:00+05:00"},
        ]
        self.assertEqual(len(split_visits_on_inactivity(events)), 1)

    def test_30_minute_gap_new_visit(self):
        events = [
            {"event_type": "menu_viewed", "timestamp": "2026-10-20T10:00:00+05:00"},
            {"event_type": "menu_viewed", "timestamp": "2026-10-20T10:30:00+05:00"},
        ]
        self.assertEqual(len(split_visits_on_inactivity(events)), 2)

    def test_save_alone_is_not_engagement(self):
        events = [{"event_type": "dish_saved", "dish_id": "dish-A"}]
        self.assertEqual(engagement_status(events), "not engaged")

    def test_no_eligible_savers(self):
        sessions = [
            {"directly_saved_dishes": [], "saved_dishes": []}
        ]
        result = observed_save_retention(sessions, "dish-A")
        self.assertEqual(result["directly_saved_sessions"], 0)
        self.assertIsNone(result["observed_retention_rate"])


if __name__ == "__main__":
    unittest.main()
