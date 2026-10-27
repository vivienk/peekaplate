import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def considered_dishes(events):
    """
    Derive considered dishes from event records.

    A dish qualifies when:
    - A linked opening has >= 10,000 ms of completed active time, OR
    - A valid linked opening has a displayed comparison.

    Comparison attribution is provisional:
    only the linked opening's dish qualifies.
    """
    openings = {}
    completed_active_ms = {}
    qualifying_comparisons = set()

    # Identify actual dish openings.
    for event in events:
        if event["event_type"] == "dish_detail_opened":
            openings[event["opening_id"]] = event["dish_id"]

    # Derive completed active time from checkpoints.
    for event in events:
        if event["event_type"] != "dish_activity_checkpoint":
            continue

        opening_id = event["opening_id"]

        if opening_id not in openings:
            continue

        if event["dish_id"] != openings[opening_id]:
            continue

        if event.get("is_final") is not True:
            continue

        completed_active_ms[opening_id] = max(
            completed_active_ms.get(opening_id, 0),
            event["cumulative_active_ms"],
        )

    # Derive qualifying comparisons from displayed events.
    for event in events:
        if event["event_type"] != "dish_compared":
            continue

        if event.get("compare_action") != "start":
            continue

        if event.get("display_state") != "displayed":
            continue

        opening_id = event.get("opening_id")

        if opening_id not in openings:
            continue

        linked_dish = openings[opening_id]

        if linked_dish not in event.get("dish_ids", []):
            continue

        qualifying_comparisons.add(linked_dish)

    considered = set(qualifying_comparisons)

    for opening_id, active_ms in completed_active_ms.items():
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


if __name__ == "__main__":
    unittest.main()
