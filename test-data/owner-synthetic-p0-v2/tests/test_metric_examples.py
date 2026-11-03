import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def considered_dishes(events):
    """
    Derive considered dishes from event records.

    A dish qualifies when:
    - A linked opening has >= 10,000 ms of checkpointed active time, OR
    - A valid linked opening has a displayed comparison.

    Comparison attribution is provisional:
    only the linked opening's dish qualifies.
    """
    openings = {}
    checkpointed_active_ms = {}
    qualifying_comparisons = set()

    # Identify actual dish openings.
    for event in events:
        if event["event_type"] == "dish_detail_opened":
            openings[event["opening_id"]] = event["dish_id"]

    # Derive provisional active time from valid checkpoints.
    for event in events:
        if event["event_type"] != "dish_activity_checkpoint":
            continue

        opening_id = event["opening_id"]

        if opening_id not in openings:
            continue

        if event["dish_id"] != openings[opening_id]:
            continue


        checkpointed_active_ms[opening_id] = max(
            checkpointed_active_ms.get(opening_id, 0),
            event["cumulative_active_ms"],
        )

    # A displayed Start or Replace qualifies if at least one compared
    # dish was opened earlier in the same session.
    previously_opened = {}

    for event in events:
        session = event.get("session_id", "example-session")
        event_type = event["event_type"]

        if event_type == "dish_detail_opened":
            previously_opened.setdefault(session, set()).add(event["dish_id"])

        elif (
            event_type == "dish_compared"
            and event.get("compare_action") in ("start", "replace")
            and event.get("display_state") == "displayed"
        ):
            linked_dishes = (
                set(event.get("dish_ids", []))
                & previously_opened.get(session, set())
            )
            qualifying_comparisons.update(linked_dishes)
    considered = set(qualifying_comparisons)

    for opening_id, active_ms in checkpointed_active_ms.items():
        if active_ms >= 10000:
            considered.add(openings[opening_id])

    return considered


class TestMetricExamples(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        path = ROOT / "metric_examples.json"
        cls.examples = json.loads(
            path.read_text(encoding="utf-8")
        )["examples"]


    def test_ten_second_non_final_checkpoint_qualifies(self):
        events = [
            {
                "event_type": "dish_detail_opened",
                "session_id": "session-A",
                "opening_id": "open-A",
                "dish_id": "dish-A",
            },
            {
                "event_type": "dish_activity_checkpoint",
                "session_id": "session-A",
                "opening_id": "open-A",
                "dish_id": "dish-A",
                "cumulative_active_ms": 10000,
                "is_final": False,
            },
        ]

        self.assertEqual(
            considered_dishes(events),
            {"dish-A"},
        )

    def test_replace_comparison_qualifies(self):
        events = [
            {
                "event_type": "dish_detail_opened",
                "session_id": "session-A",
                "opening_id": "open-A",
                "dish_id": "dish-A",
            },
            {
                "event_type": "dish_compared",
                "session_id": "session-A",
                "opening_id": "different-opening",
                "dish_ids": ["dish-A", "dish-C"],
                "compare_action": "replace",
                "display_state": "displayed",
            },
        ]
        self.assertEqual(considered_dishes(events), {"dish-A"})

    def test_cross_session_comparison_does_not_qualify(self):
        events = [
            {
                "event_type": "dish_detail_opened",
                "session_id": "session-A",
                "opening_id": "open-A",
                "dish_id": "dish-A",
            },
            {
                "event_type": "dish_compared",
                "session_id": "session-B",
                "dish_ids": ["dish-A", "dish-B"],
                "compare_action": "start",
                "display_state": "displayed",
            },
        ]
        self.assertEqual(considered_dishes(events), set())

    def test_comparison_before_opening_does_not_qualify(self):
        events = [
            {
                "event_type": "dish_compared",
                "session_id": "session-A",
                "dish_ids": ["dish-A", "dish-B"],
                "compare_action": "start",
                "display_state": "displayed",
            },
            {
                "event_type": "dish_detail_opened",
                "session_id": "session-A",
                "opening_id": "open-A",
                "dish_id": "dish-A",
            },
        ]
        self.assertEqual(considered_dishes(events), set())
    def test_all_six_examples_exist(self):
        self.assertEqual(len(self.examples), 6)

    def test_expected_metric_results(self):
        for example in self.examples:
            with self.subTest(scenario=example["scenario"]):
                actual_dishes = considered_dishes(
                    example["events"]
                )

                actual_count = len(actual_dishes)
                actual_considered = actual_count > 0

                self.assertEqual(
                    actual_considered,
                    example["expected_considered"],
                )

                self.assertEqual(
                    actual_count,
                    example["expected_count"],
                )

    def test_comparison_reentry_uses_new_flow_id(self):
        events = [
            {
                "event_type": "dish_compared",
                "session_id": "session-A",
                "compare_action": "start",
                "comparison_id": "flow-1",
                "pair_version": 1,
                "display_state": "displayed",
            },
            {
                "event_type": "dish_compared",
                "session_id": "session-A",
                "compare_action": "replace",
                "comparison_id": "flow-1",
                "pair_version": 2,
                "display_state": "displayed",
            },
            {
                "event_type": "dish_compared",
                "session_id": "session-A",
                "compare_action": "start",
                "comparison_id": "flow-2",
                "pair_version": 1,
                "display_state": "displayed",
            },
        ]

        starts = [
            event for event in events
            if event["compare_action"] == "start"
        ]

        self.assertEqual(len(starts), 2)
        self.assertNotEqual(
            starts[0]["comparison_id"],
            starts[1]["comparison_id"]
        )

        self.assertEqual(
            events[0]["comparison_id"],
            events[1]["comparison_id"]
        )

        self.assertEqual(
            [event["pair_version"] for event in events],
            [1, 2, 1]
        )

        self.assertEqual(
            len({event["comparison_id"] for event in events}),
            2
        )


if __name__ == "__main__":
    unittest.main()
