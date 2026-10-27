import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EVENTS = [
    json.loads(line)
    for line in (
        ROOT / "events" / "two_session_story.jsonl"
    ).read_text(encoding="utf-8").splitlines()
    if line.strip()
]

ANSWERS = json.loads(
    (ROOT / "expected_answers.json").read_text(encoding="utf-8")
)["expected"]


class FixtureTests(unittest.TestCase):

    def test_unique_event_ids(self):
        ids = [row["event_id"] for row in EVENTS]

        self.assertEqual(len(ids), ANSWERS["delivery_lines"])
        self.assertEqual(len(set(ids)), ANSWERS["unique_observations"])

        # A retry must repeat the exact original event.
        for event_id in set(ids):
            copies = [row for row in EVENTS if row["event_id"] == event_id]
            for copy in copies[1:]:
                self.assertEqual(copy, copies[0])

    def test_required_fields(self):
        required = {
            "schema_version",
            "event_id",
            "session_id",
            "local_sequence",
            "occurred_at",
            "event_type",
        }

        for row in EVENTS:
            self.assertTrue(
                required.issubset(row),
                row.get("event_id")
            )

    def test_session_sequence_order(self):
        for session_id in {row["session_id"] for row in EVENTS}:
            session_events = [
                row for row in EVENTS
                if row["session_id"] == session_id
            ]

            # Ignore repeated deliveries of the same event.
            unique_events = list({
                row["event_id"]: row
                for row in session_events
            }.values())

            sequences = [
                row["local_sequence"]
                for row in unique_events
            ]

            self.assertEqual(sequences, sorted(sequences))
            self.assertEqual(len(sequences), len(set(sequences)))

    def test_open_count(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }

        openings = [
            row for row in unique_events.values()
            if row["event_type"] == "dish_detail_opened"
        ]

        self.assertEqual(len(openings), 2)

        self.assertEqual(
            len({row["session_id"] for row in unique_events.values()}),
            ANSWERS["sessions"]
        )

    def test_time_arithmetic(self):
        seconds = ANSWERS["completed_active_time_seconds"]

        self.assertEqual(seconds["opening-X-A1"], 10)
        self.assertEqual(seconds["opening-Y-B1"], 5)
        self.assertEqual(sum(seconds.values()), 15)

        self.assertAlmostEqual(
            sum(seconds.values()) / len(seconds),
            ANSWERS["average_completed_active_seconds"]["value"]
        )

    def test_time_based_consideration_candidates(self):
        seconds = ANSWERS["completed_active_time_seconds"]

        qualifies_by_time = {
            opening_id
            for opening_id, active_seconds in seconds.items()
            if active_seconds >= 10
        }

        self.assertEqual(
            qualifies_by_time,
            {"opening-X-A1"}
        )

    def test_strict_engaged_pairs_draft_structure(self):
        metric = ANSWERS["strict_engaged_session_dish_pairs"]

        self.assertEqual(
            metric["status"],
            "PROPOSED_PENDING_PRODUCT_VALIDATION"
        )

        self.assertEqual(len(metric["pairs"]), 1)

        pair = metric["pairs"][0]

        self.assertEqual(pair["session_id"], "session-X")
        self.assertEqual(pair["dish_id"], "dish-A")
        self.assertEqual(pair["validation_status"], "proposed")

    def test_event_counts_match_expected(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }

        self.assertEqual(
            len(EVENTS),
            ANSWERS["delivery_lines"]
        )

        self.assertEqual(
            len(unique_events),
            ANSWERS["unique_observations"]
        )

        openings = [
            row for row in unique_events.values()
            if row["event_type"] == "dish_detail_opened"
        ]

        for dish_id, expected_count in ANSWERS[
            "actual_detail_openings"
        ].items():
            actual_count = sum(
                row["dish_id"] == dish_id
                for row in openings
            )

            self.assertEqual(actual_count, expected_count)

    def test_save_undo_unsave_counts(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }

        rows = list(unique_events.values())

        direct_saves = [
            row for row in rows
            if row["event_type"] == "dish_saved"
            and row.get("save_origin") == "direct"
        ]

        undo_restorations = [
            row for row in rows
            if row["event_type"] == "dish_saved"
            and row.get("save_origin") == "undo"
        ]

        unsaves = [
            row for row in rows
            if row["event_type"] == "dish_unsaved"
        ]

        for dish_id, expected_count in ANSWERS[
            "save"
        ]["direct_saves"].items():
            actual_count = sum(
                row["dish_id"] == dish_id
                for row in direct_saves
            )
            self.assertEqual(actual_count, expected_count)

        for dish_id, expected_count in ANSWERS[
            "save"
        ]["undo_restorations"].items():
            actual_count = sum(
                row["dish_id"] == dish_id
                for row in undo_restorations
            )
            self.assertEqual(actual_count, expected_count)

        for dish_id, expected_count in ANSWERS[
            "save"
        ]["successful_unsaves"].items():
            actual_count = sum(
                row["dish_id"] == dish_id
                for row in unsaves
            )
            self.assertEqual(actual_count, expected_count)

    def test_active_time_from_events(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }

        checkpoints = [
            row for row in unique_events.values()
            if row["event_type"] == "dish_activity_checkpoint"
        ]

        for opening_id, expected_seconds in ANSWERS[
            "completed_active_time_seconds"
        ].items():
            opening_checkpoints = [
                row for row in checkpoints
                if row["opening_id"] == opening_id
            ]

            self.assertTrue(opening_checkpoints)

            # Each completed opening needs a final checkpoint.
            self.assertTrue(
                any(
                    row.get("is_final") is True
                    for row in opening_checkpoints
                )
            )

            # Checkpoints are cumulative, so use the maximum.
            actual_seconds = max(
                row["cumulative_active_ms"]
                for row in opening_checkpoints
            ) / 1000

            self.assertEqual(actual_seconds, expected_seconds)



    def test_card_exposure_counts(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }

        exposures = [
            row for row in unique_events.values()
            if row["event_type"] == "dish_viewed"
        ]

        for dish_id, expected_count in ANSWERS[
            "card_exposed_sessions"
        ].items():
            sessions = {
                row["session_id"]
                for row in exposures
                if row["dish_id"] == dish_id
            }

            self.assertEqual(
                len(sessions),
                expected_count
            )



    def test_comparison_from_events(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }

        comparisons = [
            row for row in unique_events.values()
            if row["event_type"] == "dish_compared"
            and row.get("compare_action") == "start"
            and row.get("display_state") == "displayed"
        ]

        self.assertEqual(
            len(comparisons),
            ANSWERS["comparison"]["starts"]
        )

        self.assertEqual(len(comparisons), 1)

        comparison = comparisons[0]

        self.assertEqual(
            set(comparison["dish_ids"]),
            {"dish-A", "dish-B"}
        )

        self.assertEqual(comparison["pair_version"], 1)
        self.assertEqual(
            comparison["opening_id"],
            "opening-X-A1"
        )



    def test_detail_opening_exposure_links(self):
        unique_events = {
            row["event_id"]: row for row in EVENTS
        }
        rows = list(unique_events.values())

        exposures = [
            row for row in rows
            if row["event_type"] == "dish_viewed"
        ]

        openings = [
            row for row in rows
            if row["event_type"] == "dish_detail_opened"
        ]

        for opening in openings:
            matching_exposures = [
                exposure for exposure in exposures
                if exposure["session_id"] == opening["session_id"]
                and exposure["dish_id"] == opening["dish_id"]
                and exposure.get("exposure_id") == opening.get("exposure_id")
                and exposure["local_sequence"] < opening["local_sequence"]
            ]

            self.assertEqual(
                len(matching_exposures),
                1,
                f"Invalid exposure link: {opening['event_id']}"
            )



    def test_linked_detail_open_rates(self):
        rows = list({
            row["event_id"]: row for row in EVENTS
        }.values())

        exposures = [
            row for row in rows
            if row["event_type"] == "dish_viewed"
        ]

        openings = [
            row for row in rows
            if row["event_type"] == "dish_detail_opened"
        ]

        for dish_id, expected in ANSWERS[
            "linked_detail_open_rate"
        ].items():
            exposed_sessions = {
                row["session_id"]
                for row in exposures
                if row["dish_id"] == dish_id
            }

            opened_sessions = {
                opening["session_id"]
                for opening in openings
                if opening["dish_id"] == dish_id
                and any(
                    exposure["session_id"] == opening["session_id"]
                    and exposure["dish_id"] == dish_id
                    and exposure.get("exposure_id") == opening.get("exposure_id")
                    and exposure["local_sequence"] < opening["local_sequence"]
                    for exposure in exposures
                )
            }

            numerator = len(opened_sessions)
            denominator = len(exposed_sessions)

            self.assertEqual(numerator, expected["numerator"])
            self.assertEqual(denominator, expected["denominator"])

            actual_rate = (
                numerator / denominator
                if denominator else None
            )

            self.assertEqual(actual_rate, expected["value"])



    def test_save_adoption(self):
        rows = list({
            row["event_id"]: row for row in EVENTS
        }.values())

        direct_save_sessions = {
            row["session_id"]
            for row in rows
            if row["event_type"] == "dish_saved"
            and row.get("save_origin") == "direct"
        }

        expected = ANSWERS["save_adoption"]

        self.assertEqual(
            len(direct_save_sessions),
            expected["numerator"]
        )

        # The two sessions are the eligible Save-display
        # sessions in this specific synthetic story.
        eligible_sessions = {
            row["session_id"]
            for row in rows
            if row["event_type"] == "menu_viewed"
        }

        self.assertEqual(
            len(eligible_sessions),
            expected["denominator"]
        )

        actual_rate = (
            len(direct_save_sessions) / len(eligible_sessions)
            if eligible_sessions else None
        )

        self.assertEqual(actual_rate, expected["value"])


    def test_final_save_retention(self):
        rows = list({
            row["event_id"]: row for row in EVENTS
        }.values())

        final_saved = {}
        direct_save_sessions = {}

        for row in sorted(
            rows,
            key=lambda r: (r["session_id"], r["local_sequence"])
        ):
            session = row["session_id"]
            dish = row.get("dish_id")

            final_saved.setdefault(session, set())

            if row["event_type"] == "dish_saved":
                final_saved[session].add(dish)

                if row.get("save_origin") == "direct":
                    direct_save_sessions.setdefault(
                        dish, set()
                    ).add(session)

            elif row["event_type"] == "dish_unsaved":
                final_saved[session].discard(dish)

        for dish_id, expected in ANSWERS[
            "save"
        ]["story_end_saved_rate_among_direct_savers"].items():

            numerator = sum(
                dish_id in saved
                for saved in final_saved.values()
            )

            denominator = len(
                direct_save_sessions.get(dish_id, set())
            )

            self.assertEqual(
                numerator, expected["numerator"]
            )
            self.assertEqual(
                denominator, expected["denominator"]
            )

            actual_rate = (
                numerator / denominator
                if denominator else None
            )

            self.assertEqual(actual_rate, expected["value"])



    def test_average_active_time_from_events(self):
        rows = list({
            row["event_id"]: row for row in EVENTS
        }.values())

        checkpoints = [
            row for row in rows
            if row["event_type"] == "dish_activity_checkpoint"
        ]

        completed_openings = {}

        for row in checkpoints:
            opening_id = row["opening_id"]

            if row.get("is_final") is True:
                completed_openings.setdefault(opening_id, [])

        for row in checkpoints:
            opening_id = row["opening_id"]

            if opening_id in completed_openings:
                completed_openings[opening_id].append(
                    row["cumulative_active_ms"]
                )

        active_seconds = [
            max(values) / 1000
            for values in completed_openings.values()
        ]

        expected = ANSWERS["average_completed_active_seconds"]

        self.assertEqual(
            sum(active_seconds),
            expected["numerator"]
        )

        self.assertEqual(
            len(active_seconds),
            expected["denominator"]
        )

        self.assertAlmostEqual(
            sum(active_seconds) / len(active_seconds),
            expected["value"]
        )



    def test_duplicate_is_undo_restoration(self):
        event_groups = {}

        for row in EVENTS:
            event_groups.setdefault(
                row["event_id"], []
            ).append(row)

        duplicates = {
            event_id: copies
            for event_id, copies in event_groups.items()
            if len(copies) > 1
        }

        self.assertEqual(len(duplicates), 1)

        copies = next(iter(duplicates.values()))

        self.assertEqual(len(copies), 2)
        self.assertEqual(copies[0], copies[1])
        self.assertEqual(copies[0]["event_type"], "dish_saved")
        self.assertEqual(copies[0]["save_origin"], "undo")
        self.assertEqual(copies[0]["dish_id"], "dish-A")


    def test_privacy_suppression(self):
        privacy = ANSWERS["owner_visible_behavioral_values"]

        self.assertEqual(privacy["status"], "SUPPRESSED")
        self.assertEqual(privacy["threshold"], 10)
        self.assertLess(
            privacy["eligible_sessions"],
            privacy["threshold"]
        )


if __name__ == "__main__":
    unittest.main()
