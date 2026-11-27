import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from generate_staging_activity import (  # noqa: E402
    GeneratorConfig,
    GuardrailError,
    calculate_expected_metrics,
    compute_manifest_hash,
    generate_manifest,
    load_and_verify_manifest,
    main as cli_main,
    send_manifest_batches,
)

STAGING_VENUE = "00000000-0000-4000-8000-000000000123"
PUBLICATION_ID = "11111111-1111-4111-8111-111111111111"
DISH_ID = "22222222-2222-4222-8222-222222222222"
DISH_REVISION_ID = "33333333-3333-4333-8333-333333333333"
WINDOW_START = "2026-11-23T14:00:00Z"
WINDOW_END = "2026-11-23T14:30:00Z"
STAGING_API = "https://peekaplate-api-staging.vxkong.workers.dev"
TEST_REPORT_VENUE = "1ea97f31-bce5-4b8a-99f0-588afed9102e"


def base_config(**overrides) -> GeneratorConfig:
    defaults = dict(
        scenario="A",
        venue_id=STAGING_VENUE,
        publication_id=PUBLICATION_ID,
        current_publication_id=PUBLICATION_ID,
        dish_id=DISH_ID,
        dish_revision_id=DISH_REVISION_ID,
        dish_is_demo=False,
        seed="s7-data-18-test-seed",
        window_start=WINDOW_START,
        window_end=WINDOW_END,
        event_cap=100,
        api_base_url=STAGING_API,
        dry_run=True,
    )
    defaults.update(overrides)
    return GeneratorConfig(**defaults)


class TestStagingActivityGenerator(unittest.TestCase):
    def test_scenario_a_metrics_and_structure(self):
        manifest = generate_manifest(base_config(scenario="A"))
        self.assertEqual(manifest["scenario"], "A")
        self.assertTrue(manifest["dry_run"])
        self.assertEqual(manifest["event_count"], 55)
        self.assertEqual(len(manifest["session_ids"]), 14)

        metrics = manifest["expected_metrics"]["metrics"]
        self.assertEqual(metrics["active_sessions"], {"value": 14, "status": "NORMAL"})
        self.assertEqual(metrics["open_rate"]["value"], 0.714)
        self.assertEqual(metrics["open_rate"]["numerator"], 10)
        self.assertEqual(metrics["open_rate"]["denominator"], 14)
        self.assertEqual(metrics["timing_coverage"]["value"], 0.909)
        self.assertEqual(metrics["timing_coverage"]["numerator"], 10)
        self.assertEqual(metrics["timing_coverage"]["denominator"], 11)
        self.assertEqual(metrics["avg_interaction_time_seconds"]["value"], 12.0)
        self.assertEqual(metrics["engagement_rate"]["value"], 1.0)
        self.assertEqual(metrics["save_rate"]["value"], 0.214)
        self.assertEqual(metrics["save_rate"]["numerator"], 3)
        self.assertEqual(metrics["save_rate"]["denominator"], 14)

        all_events = [e for b in manifest["batches"] for e in b["events"]]
        nonfinal_cps = [
            e
            for e in all_events
            if e["type"] == "dish_activity_checkpoint" and e["payload"]["final"] is False
        ]
        self.assertEqual(len(nonfinal_cps), 1)
        self.assertEqual(nonfinal_cps[0]["payload"]["active_ms"], 5000)

    def test_scenario_b_metrics_and_structure(self):
        manifest = generate_manifest(base_config(scenario="B"))
        self.assertEqual(manifest["scenario"], "B")
        self.assertEqual(manifest["event_count"], 40)
        self.assertEqual(len(manifest["session_ids"]), 10)

        metrics = manifest["expected_metrics"]["metrics"]
        self.assertEqual(metrics["active_sessions"], {"value": 10, "status": "NORMAL"})
        self.assertEqual(metrics["open_rate"]["value"], 1.0)
        self.assertEqual(metrics["timing_coverage"]["value"], 1.0)
        self.assertEqual(metrics["avg_interaction_time_seconds"]["value"], 8.0)
        self.assertEqual(metrics["engagement_rate"]["value"], 0)
        self.assertEqual(metrics["engagement_rate"]["status"], "VALID_ZERO")
        self.assertEqual(metrics["save_rate"]["value"], 0)
        self.assertEqual(metrics["save_rate"]["status"], "VALID_ZERO")

    def test_deterministic_manifest_and_second_tester_reproduction(self):
        m1 = generate_manifest(base_config(scenario="A", seed="repro-seed"))
        m2 = generate_manifest(base_config(scenario="A", seed="repro-seed"))
        self.assertEqual(m1["manifest_sha256"], m2["manifest_sha256"])
        self.assertEqual(m1["run_id"], m2["run_id"])
        self.assertEqual(m1["event_ids"], m2["event_ids"])

        m_other = generate_manifest(base_config(scenario="A", seed="different-seed"))
        self.assertNotEqual(m1["manifest_sha256"], m_other["manifest_sha256"])
        self.assertNotEqual(m1["run_id"], m_other["run_id"])
        self.assertTrue(set(m1["event_ids"]).isdisjoint(set(m_other["event_ids"])))

    def test_identical_manifest_replay_does_not_inflate_metrics(self):
        manifest = generate_manifest(base_config(scenario="A"))
        all_events = [event for batch in manifest["batches"] for event in batch["events"]]
        replayed = all_events + all_events
        recomputed = calculate_expected_metrics(replayed, DISH_ID)
        self.assertEqual(recomputed, manifest["expected_metrics"])

    def test_manifest_roundtrip_and_tamper_detection(self):
        manifest = generate_manifest(base_config(scenario="B"))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            loaded = load_and_verify_manifest(path)
            self.assertEqual(loaded["manifest_sha256"], manifest["manifest_sha256"])

            tampered = dict(manifest)
            tampered["seed"] = "tampered"
            path.write_text(json.dumps(tampered, indent=2), encoding="utf-8")
            with self.assertRaises(GuardrailError):
                load_and_verify_manifest(path)

    def test_rejects_unauthorized_destination_and_venue(self):
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(api_base_url="https://api.peekaplate.app"))
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(api_base_url="https://evil.example.com"))
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(venue_id="99999999-9999-4999-8999-999999999999"))

    def test_rejects_stale_publication_and_demo_dish(self):
        with self.assertRaises(GuardrailError):
            generate_manifest(
                base_config(
                    publication_id="11111111-1111-4111-8111-111111111111",
                    current_publication_id="44444444-4444-4444-8444-444444444444",
                )
            )
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(dish_is_demo=True))

    def test_rejects_invalid_windows_and_exceeding_cap(self):
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(window_start="2026-11-23T14:00:00+05:00"))
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(window_start=WINDOW_END, window_end=WINDOW_START))
        with self.assertRaises(GuardrailError):
            generate_manifest(
                base_config(
                    window_start="2026-11-22T00:00:00Z",
                    window_end="2026-11-23T01:00:00Z",
                )
            )
        with self.assertRaises(GuardrailError):
            generate_manifest(
                base_config(
                    window_start="2026-11-21T10:00:00Z",
                    window_end="2026-11-21T10:30:00Z",
                    reference_received_at="2026-11-23T14:00:00Z",
                )
            )
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(scenario="A", event_cap=54))
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(scenario="B", event_cap=39))

    def test_cli_blocks_send_without_confirm_staging(self):
        rc = cli_main(
            [
                "--scenario",
                "B",
                "--publication-id",
                PUBLICATION_ID,
                "--dish-id",
                DISH_ID,
                "--dish-revision-id",
                DISH_REVISION_ID,
                "--window-start",
                WINDOW_START,
                "--window-end",
                WINDOW_END,
                "--send",
            ]
        )
        self.assertEqual(rc, 2)

    def test_placeholder_uuids_rejected_for_live_send_and_manifest_provenance_present(self):
        with self.assertRaises(GuardrailError):
            generate_manifest(base_config(dry_run=False))

        dry_manifest = generate_manifest(base_config(scenario="A", dry_run=True))
        self.assertEqual(dry_manifest["fixture_version"], "p0-v2-synthetic-1.0")
        self.assertEqual(dry_manifest["generator_version"], "s7-data-18-generator.v1")
        self.assertEqual(dry_manifest["authorization_status"], "DRY_RUN_UNVERIFIED")
        self.assertEqual(len(dry_manifest["input_sha256"]), 64)
        self.assertEqual(len(dry_manifest["output_sha256"]), 64)
        self.assertTrue(dry_manifest["provenance"]["fictional_only"])
        with self.assertRaises(GuardrailError):
            send_manifest_batches(dry_manifest, "dummy-token")

        real_venue = TEST_REPORT_VENUE
        real_pub = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        real_dish = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        real_rev = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        live_manifest = generate_manifest(
            base_config(
                venue_id=real_venue,
                publication_id=real_pub,
                current_publication_id=real_pub,
                dish_id=real_dish,
                dish_revision_id=real_rev,
                authorized_venues=frozenset({real_venue}),
                dry_run=False,
            )
        )
        self.assertEqual(live_manifest["authorization_status"], "AUTHORIZED_STAGING")
        with patch("generate_staging_activity.build_opener") as build_transport:
            transport = build_transport.return_value
            transport.open.side_effect = HTTPError(
                f"{STAGING_API}/observations", 302, "Found", {}, None
            )
            with self.assertRaises(RuntimeError):
                send_manifest_batches(live_manifest, "test-token")
            transport.open.assert_called_once()
            request = transport.open.call_args.args[0]
            self.assertEqual(request.full_url, f"{STAGING_API}/observations")
            handler = build_transport.call_args.args[0]
            self.assertIsNone(
                handler.redirect_request(request, None, 302, "Found", {}, "https://invalid.example/")
            )

        live_manifest["destination"]["ingest_endpoint"] = "https://invalid.example/observations"
        live_manifest["manifest_sha256"] = compute_manifest_hash(live_manifest)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text(json.dumps(live_manifest), encoding="utf-8")
            with self.assertRaisesRegex(GuardrailError, "endpoint does not match"):
                load_and_verify_manifest(path, frozenset({real_venue}))
        with patch("generate_staging_activity.build_opener") as transport:
            with self.assertRaisesRegex(GuardrailError, "endpoint does not match"):
                send_manifest_batches(live_manifest, "test-token")
            transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
