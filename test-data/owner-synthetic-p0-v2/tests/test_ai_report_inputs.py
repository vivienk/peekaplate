import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestAIReportInputs(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads(
            (ROOT / "ai_evaluation_cases.json").read_text(
                encoding="utf-8"
            )
        )

    def test_ai001_fixture_exists(self):
        case = next(
            case for case in self.cases
            if case["case_id"] == "AI-001"
        )

        self.assertIn("input_fixture", case)

        fixture_path = ROOT / case["input_fixture"]
        self.assertTrue(fixture_path.is_file())

    def test_ai001_suppressed_values_hidden(self):
        fixture = json.loads(
            (ROOT / "ai_report_inputs" / "AI-001.json").read_text(
                encoding="utf-8"
            )
        )

        suppressed_metrics = [
            metric for metric in fixture["metrics"]
            if metric["status"] == "SUPPRESSED"
        ]

        self.assertGreater(len(suppressed_metrics), 0)

        for metric in suppressed_metrics:
            self.assertIsNone(metric["value"])

    def test_ai001_no_private_event_data(self):
        fixture = json.loads(
            (ROOT / "ai_report_inputs" / "AI-001.json").read_text(
                encoding="utf-8"
            )
        )

        forbidden_fields = {
            "event_id",
            "session_id",
            "checkpoint_history",
            "raw_events",
            "saved_dishes",
            "hidden_count",
            "hidden_numerator",
            "hidden_denominator",
        }

        def check_fields(data):
            if isinstance(data, dict):
                for key, value in data.items():
                    self.assertNotIn(key, forbidden_fields)
                    check_fields(value)

            elif isinstance(data, list):
                for item in data:
                    check_fields(item)

        check_fields(fixture)

    def test_ai001_not_run(self):
        case = next(
            case for case in self.cases
            if case["case_id"] == "AI-001"
        )

        self.assertEqual(
            case["execution_status"],
            "NOT_RUN_AGAINST_APPLICATION_AI"
        )


    def test_all_twenty_cases_have_valid_fixtures(self):
        self.assertEqual(len(self.cases), 20)

        for case in self.cases:
            with self.subTest(case_id=case["case_id"]):
                self.assertIn("input_fixture", case)

                fixture_path = ROOT / case["input_fixture"]
                self.assertTrue(
                    fixture_path.is_file(),
                    f"Missing fixture: {fixture_path}"
                )

                json.loads(
                    fixture_path.read_text(encoding="utf-8")
                )

    def test_all_cases_remain_not_run(self):
        for case in self.cases:
            with self.subTest(case_id=case["case_id"]):
                self.assertEqual(
                    case["execution_status"],
                    "NOT_RUN_AGAINST_APPLICATION_AI"
                )

    def test_all_suppressed_metrics_hide_values(self):
        for case in self.cases:
            with self.subTest(case_id=case["case_id"]):
                fixture = json.loads(
                    (ROOT / case["input_fixture"]).read_text(
                        encoding="utf-8"
                    )
                )

                for metric in fixture.get("metrics", []):
                    if metric.get("status") == "SUPPRESSED":
                        self.assertIsNone(
                            metric.get("value"),
                            f"Suppressed value leaked in {case['case_id']}"
                        )

    def test_all_fixtures_exclude_private_event_data(self):
        forbidden_fields = {
            "event_id",
            "event_ids",
            "session_id",
            "session_ids",
            "raw_events",
            "checkpoint_history",
            "checkpoint_histories",
            "saved_dishes",
            "individual_saved_lists",
            "hidden_count",
            "hidden_numerator",
            "hidden_denominator",
        }

        def check_fields(data, case_id):
            if isinstance(data, dict):
                for key, value in data.items():
                    self.assertNotIn(
                        key,
                        forbidden_fields,
                        f"Private field {key!r} found in {case_id}"
                    )
                    check_fields(value, case_id)

            elif isinstance(data, list):
                for item in data:
                    check_fields(item, case_id)

        for case in self.cases:
            with self.subTest(case_id=case["case_id"]):
                fixture_path = ROOT / case["input_fixture"]

                fixture = json.loads(
                    fixture_path.read_text(encoding="utf-8")
                )

                check_fields(fixture, case["case_id"])

if __name__ == "__main__":
    unittest.main()
