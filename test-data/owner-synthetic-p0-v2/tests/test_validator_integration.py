import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "events" / "full_dataset.jsonl"
VALIDATOR = ROOT / "validate_full_dataset.py"


class TestValidatorIntegration(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.original = [
            json.loads(line)
            for line in BASELINE.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def run_validator(self, rows):
        with tempfile.TemporaryDirectory() as directory:
            # Deliberately use a different filename.
            path = Path(directory) / "renamed.jsonl"

            with path.open("w", encoding="utf-8") as file:
                for row in rows:
                    file.write(json.dumps(row) + "\n")

            return subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(VALIDATOR),
                    str(path),
                    "--dataset",
                    "full",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

    def assert_rejected(self, rows, reason):
        result = self.run_validator(rows)

        self.assertNotEqual(
            result.returncode,
            0,
            "Invalid dataset was accepted by the real validator",
        )

        output = result.stdout + result.stderr
        self.assertIn(reason, output)

    def test_valid_baseline(self):
        result = self.run_validator(self.original)
        self.assertEqual(
            result.returncode,
            0,
            result.stdout + result.stderr,
        )

    def test_missing_retries_renamed_file(self):
        self.assert_rejected(
            self.original[:-150],
            "Missing or extra event deliveries",
        )

    def test_invalid_schema_version(self):
        rows = copy.deepcopy(self.original)
        rows[0]["schema_version"] = "synthetic.fixture.v99"
        self.assert_rejected(rows, "schema_version")

    def test_invalid_timestamp(self):
        rows = copy.deepcopy(self.original)
        rows[0]["occurred_at"] = "not-a-date"
        self.assert_rejected(rows, "occurred_at")

    def test_timestamp_without_timezone(self):
        rows = copy.deepcopy(self.original)
        rows[0]["occurred_at"] = "2026-10-20T10:00:00"
        self.assert_rejected(rows, "occurred_at")

    def test_unknown_event_type(self):
        rows = copy.deepcopy(self.original)
        rows[0]["event_type"] = "unknown_event"
        self.assert_rejected(rows, "event_type")

    def test_empty_event_id(self):
        rows = copy.deepcopy(self.original)
        rows[0]["event_id"] = ""
        self.assert_rejected(rows, "event_id")

    def test_zero_sequence(self):
        rows = copy.deepcopy(self.original)
        rows[0]["local_sequence"] = 0
        self.assert_rejected(rows, "local_sequence")


    def test_duplicate_local_sequence(self):
        rows = copy.deepcopy(self.original)

        # Give the second unique event the first event's sequence.
        first = rows[0]
        second = next(
            row for row in rows[1:]
            if row["session_id"] == first["session_id"]
            and row["event_id"] != first["event_id"]
        )

        second["local_sequence"] = first["local_sequence"]

        self.assert_rejected(rows, "Duplicate local_sequence")

    def test_checkpoint_wrong_dish(self):
        rows = copy.deepcopy(self.original)

        checkpoint = next(
            row for row in rows
            if row["event_type"] == "dish_activity_checkpoint"
        )

        checkpoint["dish_id"] = "dish-C"

        self.assert_rejected(rows, "checkpoint")

    def test_undo_without_prior_unsave(self):
        rows = copy.deepcopy(self.original)

        undo = next(
            row for row in rows
            if row["event_type"] == "dish_saved"
            and row.get("save_origin") == "undo"
        )

        session = undo["session_id"]
        dish = undo["dish_id"]
        undo_sequence = undo["local_sequence"]

        # Find the Unsave immediately preceding this Undo.
        prior_unsave = max(
            (
                row for row in rows
                if row["session_id"] == session
                and row["event_type"] == "dish_unsaved"
                and row["local_sequence"] < undo_sequence
            ),
            key=lambda row: row["local_sequence"]
        )

        # Change the prior Unsave to another dish, leaving
        # the Undo unchanged. Update any identical retry too.
        for row in rows:
            if row["event_id"] == prior_unsave["event_id"]:
                row["dish_id"] = (
                    "dish-B" if dish != "dish-B" else "dish-C"
                )

        self.assert_rejected(rows, "Undo restored an already saved dish")


    def test_undo_without_matching_prior_unsave(self):
        rows = copy.deepcopy(self.original)

        # Find an ordinary direct Save.
        direct_save = next(
            row for row in rows
            if row["event_type"] == "dish_saved"
            and row.get("save_origin") == "direct"
        )

        # Turn it into an Undo without any preceding Unsave.
        # Update identical retry deliveries as well.
        for row in rows:
            if row["event_id"] == direct_save["event_id"]:
                row["save_origin"] = "undo"

        self.assert_rejected(
            rows,
            "Undo without matching prior Unsave"
        )


    def test_save_missing_surface_fields(self):
        rows = copy.deepcopy(self.original)

        target = next(
            row for row in rows
            if row["event_type"] == "dish_saved"
            and row.get("save_origin") == "direct"
        )

        for row in rows:
            if row["event_id"] == target["event_id"]:
                row.pop("surface", None)
                row.pop("save_surface", None)

        self.assert_rejected(rows, "save_surface")


    def test_unsave_missing_surface_fields(self):
        rows = copy.deepcopy(self.original)

        target = next(
            row for row in rows
            if row["event_type"] == "dish_unsaved"
        )

        for row in rows:
            if row["event_id"] == target["event_id"]:
                row.pop("surface", None)
                row.pop("unsave_surface", None)

        self.assert_rejected(rows, "'surface' is a required property")


    def test_comparison_missing_identity_fields(self):
        rows = copy.deepcopy(self.original)

        target = next(
            row for row in rows
            if row["event_type"] == "dish_compared"
        )

        for row in rows:
            if row["event_id"] == target["event_id"]:
                row.pop("comparison_id", None)
                row.pop("pair_version", None)

        self.assert_rejected(rows, "comparison_id")

    def test_checkpoint_timestamp_before_opening(self):
        rows = copy.deepcopy(self.original)

        target = next(
            row for row in rows
            if row["event_type"] == "dish_activity_checkpoint"
            and row.get("is_final") is True
            and row.get("cumulative_active_ms") == 10000
        )

        opening = next(
            row for row in rows
            if row["event_type"] == "dish_detail_opened"
            and row["opening_id"] == target["opening_id"]
        )

        from datetime import datetime, timedelta

        earlier = (
            datetime.fromisoformat(opening["occurred_at"])
            - timedelta(seconds=1)
        ).isoformat()

        for row in rows:
            if row["event_id"] == target["event_id"]:
                row["occurred_at"] = earlier

        self.assert_rejected(
            rows,
            "Checkpoint timestamp precedes opening"
        )

    def test_checkpoint_active_time_exceeds_elapsed(self):
        rows = copy.deepcopy(self.original)

        target = next(
            row for row in rows
            if row["event_type"] == "dish_activity_checkpoint"
            and row.get("is_final") is True
            and row.get("cumulative_active_ms") == 10000
        )

        opening = next(
            row for row in rows
            if row["event_type"] == "dish_detail_opened"
            and row["opening_id"] == target["opening_id"]
        )

        from datetime import datetime, timedelta

        too_early = (
            datetime.fromisoformat(opening["occurred_at"])
            + timedelta(seconds=1)
        ).isoformat()

        for row in rows:
            if row["event_id"] == target["event_id"]:
                row["occurred_at"] = too_early

        self.assert_rejected(
            rows,
            "Checkpoint active time exceeds elapsed time"
        )


    def test_supplied_starter_dataset(self):
        starter_path = ROOT / "events" / "two_session_story.jsonl"

        result = subprocess.run(
            [
                sys.executable,
                "-B",
                str(VALIDATOR),
                str(starter_path),
                "--dataset",
                "starter",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )

        self.assertEqual(
            result.returncode,
            0,
            result.stdout + result.stderr,
        )

        self.assertIn(
            "PASS: Starter-dataset metric checks.",
            result.stdout,
        )

    def test_supplied_full_dataset(self):
        result = self.run_validator(self.original)

        self.assertEqual(
            result.returncode,
            0,
            result.stdout + result.stderr,
        )

        self.assertIn(
            "PASS: Full-dataset metric checks.",
            result.stdout,
        )



if __name__ == "__main__":
    unittest.main()
