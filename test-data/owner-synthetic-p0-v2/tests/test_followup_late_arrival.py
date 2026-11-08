import unittest
from test_session_completion import split_visits_on_inactivity


class TestLateArrival(unittest.TestCase):
    def test_late_event_stays_in_original_visit(self):
        events = [
            {"event_type": "menu_viewed", "timestamp": "2026-10-20T10:00:00+05:00", "received_at": "2026-10-20T10:00:01+05:00", "session_id": "session-A"},
            {"event_type": "dish_detail_opened", "timestamp": "2026-10-20T10:05:00+05:00", "received_at": "2026-10-20T11:00:00+05:00", "session_id": "session-A"},
            {"event_type": "menu_viewed", "timestamp": "2026-10-20T10:40:00+05:00", "received_at": "2026-10-20T10:40:01+05:00", "session_id": "session-B"},
        ]

        visits = split_visits_on_inactivity(events)

        self.assertEqual(len(visits), 2)
        self.assertEqual(
            [event["session_id"] for event in visits[0]],
            ["session-A", "session-A"],
        )
        self.assertEqual(visits[1][0]["session_id"], "session-B")


if __name__ == "__main__":
    unittest.main()
