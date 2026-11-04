import unittest
from test_metric_examples import considered_dishes


class TestFollowupComparison(unittest.TestCase):
    def test_soup_and_salad_both_considered(self):
        events = [
            {"event_type": "dish_detail_opened", "session_id": "session-A", "opening_id": "open-soup", "dish_id": "soup"},
            {"event_type": "dish_detail_opened", "session_id": "session-A", "opening_id": "open-salad", "dish_id": "salad"},
            {"event_type": "dish_activity_checkpoint", "session_id": "session-A", "opening_id": "open-salad", "dish_id": "salad", "cumulative_active_ms": 5000, "is_final": True},
            {"event_type": "dish_compared", "session_id": "session-A", "dish_ids": ["soup", "salad"], "compare_action": "start", "display_state": "displayed"},
        ]
        self.assertEqual(considered_dishes(events), {"soup", "salad"})


    def test_salad_opened_after_comparison(self):
        events = [
            {
                "event_type": "dish_detail_opened",
                "session_id": "session-A",
                "opening_id": "open-soup",
                "dish_id": "soup",
            },
            {
                "event_type": "dish_compared",
                "session_id": "session-A",
                "dish_ids": ["soup", "salad"],
                "compare_action": "start",
                "display_state": "displayed",
            },
            {
                "event_type": "dish_detail_opened",
                "session_id": "session-A",
                "opening_id": "open-salad",
                "dish_id": "salad",
            },
        ]

        self.assertEqual(considered_dishes(events), {"soup"})


if __name__ == "__main__":
    unittest.main()
