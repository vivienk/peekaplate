#!/usr/bin/env python3
"""S7-DATA-18: Deterministic synthetic diner activity generator for staging.

Extends the owner-synthetic-p0-v2 pack to emit canonical observation.v2
batches for POST /observations, produce deterministic manifests, compute
independent DATA-17 expected metrics, and enforce destination, publication,
dish, UTC window, and event-cap guardrails.

Default mode is dry-run; live staging delivery requires explicit --send
and --confirm-staging flags.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid

FIXTURE_VERSION = "p0-v2-synthetic-1.0"
GENERATOR_VERSION = "s7-data-18-generator.v1"
PLACEHOLDER_UUIDS = frozenset(
    {
        "00000000-0000-4000-8000-000000000123",
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    }
)
DEFAULT_AUTHORIZED_STAGING_VENUES = frozenset(
    {
        "00000000-0000-4000-8000-000000000123",
    }
)
DEFAULT_AUTHORIZED_STAGING_ORIGINS = frozenset(
    {
        "https://peekaplate-api-staging.vxkong.workers.dev",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
    }
)
PRODUCTION_ORIGINS = frozenset(
    {
        "https://api.peekaplate.app",
    }
)

MAX_BATCH_EVENTS = 25
MAX_BATCH_BYTES = 32 * 1024
PRIVACY_FLOOR_SESSIONS = 10
ENGAGEMENT_ACTIVE_MS_THRESHOLD = 10_000

OBSERVATION_NAMESPACE = uuid.UUID("7f3b5f84-2d73-4f16-9b4a-5e2d0c3c1801")


class GuardrailError(ValueError):
    """Raised when destination, publication, dish, window, or cap checks fail."""


@dataclass(frozen=True)
class GeneratorConfig:
    scenario: str
    venue_id: str
    publication_id: str
    current_publication_id: str | None
    dish_id: str
    dish_revision_id: str
    dish_is_demo: bool
    seed: str
    window_start: str
    window_end: str
    event_cap: int
    api_base_url: str
    authorized_venues: frozenset[str] = DEFAULT_AUTHORIZED_STAGING_VENUES
    authorized_origins: frozenset[str] = DEFAULT_AUTHORIZED_STAGING_ORIGINS
    reference_received_at: str | None = None
    dry_run: bool = True


def _normalize_uuid(value: str, field_name: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError) as exc:
        raise GuardrailError(f"Invalid UUID for {field_name}: {value!r}") from exc
    return str(parsed).lower()


def _parse_utc_iso(value: str, field_name: str) -> datetime:
    if not isinstance(value, str) or not (
        value.endswith("Z") or value.endswith("+00:00")
    ):
        raise GuardrailError(
            f"{field_name} must be an explicit UTC ISO-8601 timestamp (ending in Z or +00:00): {value!r}"
        )
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise GuardrailError(f"Invalid timestamp for {field_name}: {value!r}") from exc
    if dt.tzinfo is None or dt.utcoffset() != timedelta(0):
        raise GuardrailError(f"{field_name} must have UTC offset 0: {value!r}")
    return dt.astimezone(timezone.utc)


def _format_utc_iso(dt: datetime) -> str:
    utc_dt = dt.astimezone(timezone.utc)
    if utc_dt.microsecond:
        return utc_dt.isoformat().replace("+00:00", "Z")
    return utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_origin(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise GuardrailError(f"Invalid API base URL: {url!r}")
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def validate_config(config: GeneratorConfig) -> dict[str, Any]:
    """Validate destination, venue, publication, dish, UTC window, and cap."""
    scenario = config.scenario.upper()
    if scenario not in ("A", "B"):
        raise GuardrailError(f"Unsupported scenario {config.scenario!r}; expected 'A' or 'B'.")

    origin = _normalize_origin(config.api_base_url)
    if origin in PRODUCTION_ORIGINS or origin not in config.authorized_origins:
        raise GuardrailError(
            f"Unauthorized destination {origin!r}; allowed staging origins: {sorted(config.authorized_origins)}"
        )

    venue_id = _normalize_uuid(config.venue_id, "venue_id")
    if venue_id not in config.authorized_venues:
        raise GuardrailError(
            f"Unauthorized venue_id {venue_id!r}; allowed staging venues: {sorted(config.authorized_venues)}"
        )

    publication_id = _normalize_uuid(config.publication_id, "publication_id")
    if config.current_publication_id is not None:
        current_pub = _normalize_uuid(config.current_publication_id, "current_publication_id")
        if publication_id != current_pub:
            raise GuardrailError(
                f"Stale publication_id {publication_id!r}; current publication is {current_pub!r}"
            )

    dish_id = _normalize_uuid(config.dish_id, "dish_id")
    dish_revision_id = _normalize_uuid(config.dish_revision_id, "dish_revision_id")
    if not config.dry_run:
        for label, value in (
            ("venue_id", venue_id),
            ("publication_id", publication_id),
            ("dish_id", dish_id),
            ("dish_revision_id", dish_revision_id),
        ):
            if value in PLACEHOLDER_UUIDS:
                raise GuardrailError(
                    f"Placeholder {label} ({value!r}) cannot be used for live staging delivery."
                )
    if config.dish_is_demo:
        raise GuardrailError("Demo dishes are not allowed; provide a newly published non-demo dish.")

    if not config.seed or not config.seed.strip():
        raise GuardrailError("Deterministic seed must be non-empty.")

    if config.event_cap <= 0:
        raise GuardrailError(f"event_cap must be positive, got {config.event_cap}")

    start_dt = _parse_utc_iso(config.window_start, "window_start")
    end_dt = _parse_utc_iso(config.window_end, "window_end")
    if start_dt >= end_dt:
        raise GuardrailError(
            f"Invalid UTC window: window_start ({config.window_start}) must be strictly before window_end ({config.window_end})"
        )
    if (end_dt - start_dt) > timedelta(hours=24):
        raise GuardrailError(
            "Invalid UTC window: duration cannot exceed 24 hours (ingestion window limit)."
        )

    if config.reference_received_at is not None:
        ref_dt = _parse_utc_iso(config.reference_received_at, "reference_received_at")
        if start_dt < ref_dt - timedelta(hours=24):
            raise GuardrailError(
                "Invalid UTC window: window_start is older than 24 hours before reference_received_at (would be rejected as too_old)."
            )
        if end_dt > ref_dt + timedelta(minutes=5):
            raise GuardrailError(
                "Invalid UTC window: window_end exceeds 5 minutes after reference_received_at (would be rejected as future_time)."
            )

    return {
        "scenario": scenario,
        "origin": origin,
        "venue_id": venue_id,
        "publication_id": publication_id,
        "dish_id": dish_id,
        "dish_revision_id": dish_revision_id,
        "seed": config.seed.strip(),
        "start_dt": start_dt,
        "end_dt": end_dt,
        "event_cap": config.event_cap,
    }


def deterministic_uuid(*parts: str) -> str:
    return str(uuid.uuid5(OBSERVATION_NAMESPACE, "|".join(parts))).lower()


def _make_event(
    *,
    run_key: str,
    session_id: str,
    producer_id: str,
    publication_id: str,
    local_sequence: int,
    occurred_at: datetime,
    event_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    event_id = deterministic_uuid(
        run_key,
        "event",
        session_id,
        str(local_sequence),
        event_type,
    )
    return {
        "schema_version": "observation.v2",
        "event_id": event_id,
        "session_id": session_id,
        "producer_id": producer_id,
        "local_sequence": local_sequence,
        "occurred_at": _format_utc_iso(occurred_at),
        "publication_revision_id": publication_id,
        "type": event_type,
        "payload": payload,
    }


def _visit_time(start_dt: datetime, end_dt: datetime, visit_index: int, total_visits: int, step_seconds: int) -> datetime:
    total_span_seconds = max(1, int((end_dt - start_dt).total_seconds()))
    # Reserve at least 60s per visit if window permits, otherwise space proportionally inside [start_dt, end_dt).
    slot_seconds = max(1, (total_span_seconds - 1) // max(1, total_visits))
    base_offset = min(visit_index * slot_seconds, max(0, total_span_seconds - 1))
    candidate = start_dt + timedelta(seconds=base_offset + step_seconds)
    if candidate >= end_dt:
        candidate = end_dt - timedelta(seconds=1)
    return candidate


def _build_scenario_a_events(validated: dict[str, Any], run_key: str) -> list[dict[str, Any]]:
    """Scenario A: 14 exposed visits, 10 unique opened, 11 openings (10x12s final + 1 nonfinal), 3 direct saves (1 undone)."""
    total_visits = 14
    events: list[dict[str, Any]] = []
    pub_id = validated["publication_id"]
    dish_id = validated["dish_id"]
    dish_rev_id = validated["dish_revision_id"]
    start_dt = validated["start_dt"]
    end_dt = validated["end_dt"]

    for idx in range(total_visits):
        visit_tag = f"visit-{idx + 1:02d}"
        session_id = deterministic_uuid(run_key, "session", visit_tag)
        producer_id = deterministic_uuid(run_key, "producer", visit_tag)
        exposure_id = deterministic_uuid(run_key, "exposure", visit_tag)
        seq = 0

        def next_seq() -> int:
            nonlocal seq
            seq += 1
            return seq

        # 1. menu_viewed
        events.append(
            _make_event(
                run_key=run_key,
                session_id=session_id,
                producer_id=producer_id,
                publication_id=pub_id,
                local_sequence=next_seq(),
                occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 0),
                event_type="menu_viewed",
                payload={"entry_source": "qr"},
            )
        )

        # 2. dish_viewed (all 14 visits exposed)
        events.append(
            _make_event(
                run_key=run_key,
                session_id=session_id,
                producer_id=producer_id,
                publication_id=pub_id,
                local_sequence=next_seq(),
                occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 1),
                event_type="dish_viewed",
                payload={
                    "dish_id": dish_id,
                    "dish_revision_id": dish_rev_id,
                    "exposure_id": exposure_id,
                    "surface": "menu_list",
                    "position": 1,
                    "exposure_basis": "viewport_50pct_1s",
                },
            )
        )

        # Visits 1..10 open once and finalize at 12 seconds.
        if idx < 10:
            opening_id = deterministic_uuid(run_key, "opening", visit_tag, "1")
            events.append(
                _make_event(
                    run_key=run_key,
                    session_id=session_id,
                    producer_id=producer_id,
                    publication_id=pub_id,
                    local_sequence=next_seq(),
                    occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 2),
                    event_type="dish_detail_opened",
                    payload={
                        "opening_id": opening_id,
                        "dish_id": dish_id,
                        "dish_revision_id": dish_rev_id,
                        "source": "menu_card",
                        "from_exposure_id": exposure_id,
                        "save_available": True,
                    },
                )
            )
            events.append(
                _make_event(
                    run_key=run_key,
                    session_id=session_id,
                    producer_id=producer_id,
                    publication_id=pub_id,
                    local_sequence=next_seq(),
                    occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 14),
                    event_type="dish_activity_checkpoint",
                    payload={
                        "dish_id": dish_id,
                        "dish_revision_id": dish_rev_id,
                        "opening_id": opening_id,
                        "active_ms": 12000,
                        "final": True,
                    },
                )
            )

        # Visits 1..3 each have one direct save; Visit 3's save is subsequently undone.
        if idx < 3:
            events.append(
                _make_event(
                    run_key=run_key,
                    session_id=session_id,
                    producer_id=producer_id,
                    publication_id=pub_id,
                    local_sequence=next_seq(),
                    occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 15),
                    event_type="dish_saved",
                    payload={
                        "dish_id": dish_id,
                        "dish_revision_id": dish_rev_id,
                        "save_origin": "direct",
                        "save_surface": "dish_detail",
                        "shortlist_size": 1,
                    },
                )
            )
            if idx == 2:
                events.append(
                    _make_event(
                        run_key=run_key,
                        session_id=session_id,
                        producer_id=producer_id,
                        publication_id=pub_id,
                        local_sequence=next_seq(),
                        occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 16),
                        event_type="dish_unsaved",
                        payload={
                            "dish_id": dish_id,
                            "dish_revision_id": dish_rev_id,
                            "unsave_surface": "dish_detail",
                            "shortlist_size": 0,
                        },
                    )
                )
                events.append(
                    _make_event(
                        run_key=run_key,
                        session_id=session_id,
                        producer_id=producer_id,
                        publication_id=pub_id,
                        local_sequence=next_seq(),
                        occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 17),
                        event_type="dish_saved",
                        payload={
                            "dish_id": dish_id,
                            "dish_revision_id": dish_rev_id,
                            "save_origin": "undo",
                            "save_surface": "saved_screen",
                            "shortlist_size": 1,
                        },
                    )
                )

        # Visit 1 has the 11th opening event with only a nonfinal checkpoint.
        if idx == 0:
            second_opening_id = deterministic_uuid(run_key, "opening", visit_tag, "2")
            events.append(
                _make_event(
                    run_key=run_key,
                    session_id=session_id,
                    producer_id=producer_id,
                    publication_id=pub_id,
                    local_sequence=next_seq(),
                    occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 18),
                    event_type="dish_detail_opened",
                    payload={
                        "opening_id": second_opening_id,
                        "dish_id": dish_id,
                        "dish_revision_id": dish_rev_id,
                        "source": "menu_card",
                        "from_exposure_id": exposure_id,
                        "save_available": True,
                    },
                )
            )
            events.append(
                _make_event(
                    run_key=run_key,
                    session_id=session_id,
                    producer_id=producer_id,
                    publication_id=pub_id,
                    local_sequence=next_seq(),
                    occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 23),
                    event_type="dish_activity_checkpoint",
                    payload={
                        "dish_id": dish_id,
                        "dish_revision_id": dish_rev_id,
                        "opening_id": second_opening_id,
                        "active_ms": 5000,
                        "final": False,
                    },
                )
            )

    return events


def _build_scenario_b_events(validated: dict[str, Any], run_key: str) -> list[dict[str, Any]]:
    """Scenario B: 10 exposed visits, each opening once and finalizing at 8 seconds, with zero saves."""
    total_visits = 10
    events: list[dict[str, Any]] = []
    pub_id = validated["publication_id"]
    dish_id = validated["dish_id"]
    dish_rev_id = validated["dish_revision_id"]
    start_dt = validated["start_dt"]
    end_dt = validated["end_dt"]

    for idx in range(total_visits):
        visit_tag = f"visit-{idx + 1:02d}"
        session_id = deterministic_uuid(run_key, "session", visit_tag)
        producer_id = deterministic_uuid(run_key, "producer", visit_tag)
        exposure_id = deterministic_uuid(run_key, "exposure", visit_tag)
        opening_id = deterministic_uuid(run_key, "opening", visit_tag, "1")

        events.append(
            _make_event(
                run_key=run_key,
                session_id=session_id,
                producer_id=producer_id,
                publication_id=pub_id,
                local_sequence=1,
                occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 0),
                event_type="menu_viewed",
                payload={"entry_source": "qr"},
            )
        )
        events.append(
            _make_event(
                run_key=run_key,
                session_id=session_id,
                producer_id=producer_id,
                publication_id=pub_id,
                local_sequence=2,
                occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 1),
                event_type="dish_viewed",
                payload={
                    "dish_id": dish_id,
                    "dish_revision_id": dish_rev_id,
                    "exposure_id": exposure_id,
                    "surface": "menu_list",
                    "position": 1,
                    "exposure_basis": "viewport_50pct_1s",
                },
            )
        )
        events.append(
            _make_event(
                run_key=run_key,
                session_id=session_id,
                producer_id=producer_id,
                publication_id=pub_id,
                local_sequence=3,
                occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 2),
                event_type="dish_detail_opened",
                payload={
                    "opening_id": opening_id,
                    "dish_id": dish_id,
                    "dish_revision_id": dish_rev_id,
                    "source": "menu_card",
                    "from_exposure_id": exposure_id,
                    "save_available": True,
                },
            )
        )
        events.append(
            _make_event(
                run_key=run_key,
                session_id=session_id,
                producer_id=producer_id,
                publication_id=pub_id,
                local_sequence=4,
                occurred_at=_visit_time(start_dt, end_dt, idx, total_visits, 10),
                event_type="dish_activity_checkpoint",
                payload={
                    "dish_id": dish_id,
                    "dish_revision_id": dish_rev_id,
                    "opening_id": opening_id,
                    "active_ms": 8000,
                    "final": True,
                },
            )
        )

    return events


def calculate_expected_metrics(events: list[dict[str, Any]], dish_id: str) -> dict[str, Any]:
    """Independently calculate DATA-17 metrics from generated observation.v2 events."""
    # Deduplicate by event_id (preserving canonical payload identity).
    deduped_by_id: dict[str, dict[str, Any]] = {}
    for event in events:
        event_id = event["event_id"]
        if event_id not in deduped_by_id:
            deduped_by_id[event_id] = event

    exposed_sessions: set[str] = set()
    opened_sessions: set[str] = set()
    direct_saved_sessions: set[str] = set()
    openings: dict[str, dict[str, Any]] = {}
    checkpoints_by_opening: dict[str, list[dict[str, Any]]] = {}

    for event in deduped_by_id.values():
        etype = event["type"]
        sid = event["session_id"]
        payload = event["payload"]
        if payload.get("dish_id") != dish_id:
            continue
        if etype == "dish_viewed":
            exposed_sessions.add(sid)
        elif etype == "dish_detail_opened":
            opened_sessions.add(sid)
            oid = payload["opening_id"]
            openings[oid] = {"session_id": sid}
        elif etype == "dish_activity_checkpoint":
            oid = payload["opening_id"]
            checkpoints_by_opening.setdefault(oid, []).append(payload)
        elif etype == "dish_saved" and payload.get("save_origin") == "direct":
            direct_saved_sessions.add(sid)

    finalized_durations_ms: list[int] = []
    timed_sessions: set[str] = set()
    engaged_sessions: set[str] = set()

    for oid, info in openings.items():
        cps = checkpoints_by_opening.get(oid, [])
        if not cps:
            continue
        max_active_ms = max(cp["active_ms"] for cp in cps)
        is_final = any(bool(cp["final"]) for cp in cps)
        if max_active_ms >= ENGAGEMENT_ACTIVE_MS_THRESHOLD:
            engaged_sessions.add(info["session_id"])
        if is_final:
            timed_sessions.add(info["session_id"])
            finalized_durations_ms.append(max_active_ms)

    active_count = len(exposed_sessions)
    opened_count = len(opened_sessions)
    exposed_opened_count = len(exposed_sessions & opened_sessions)
    total_openings = len(openings)
    timed_openings = len(finalized_durations_ms)
    timed_session_count = len(timed_sessions)
    direct_save_count = len(exposed_sessions & direct_saved_sessions)
    engaged_count = len(opened_sessions & engaged_sessions)
    below_floor = active_count < PRIVACY_FLOOR_SESSIONS

    def _rate(numerator: int, denominator: int, cohort: int) -> dict[str, Any]:
        if below_floor or cohort < PRIVACY_FLOOR_SESSIONS:
            return {"value": None, "status": "SUPPRESSED", "numerator": numerator, "denominator": denominator}
        if denominator == 0:
            return {"value": None, "status": "NOT_MEASURABLE", "numerator": numerator, "denominator": denominator}
        if numerator == 0:
            return {"value": 0, "status": "VALID_ZERO", "numerator": numerator, "denominator": denominator}
        return {
            "value": round(numerator / denominator, 3),
            "status": "NORMAL",
            "numerator": numerator,
            "denominator": denominator,
        }

    def _avg_seconds() -> dict[str, Any]:
        if below_floor or timed_session_count < PRIVACY_FLOOR_SESSIONS:
            return {"value": None, "status": "SUPPRESSED", "numerator": sum(finalized_durations_ms) / 1000.0, "denominator": timed_openings}
        if timed_openings == 0:
            return {"value": None, "status": "NOT_MEASURABLE", "numerator": 0, "denominator": 0}
        avg = (sum(finalized_durations_ms) / timed_openings) / 1000.0
        if avg == 0:
            return {"value": 0, "status": "VALID_ZERO", "numerator": 0, "denominator": timed_openings}
        return {"value": round(avg, 3), "status": "NORMAL", "numerator": sum(finalized_durations_ms) / 1000.0, "denominator": timed_openings}

    return {
        "unique_events": len(deduped_by_id),
        "evidence_state": "SUPPRESSED" if below_floor else "NORMAL",
        "metrics": {
            "active_sessions": {
                "value": None if below_floor else active_count,
                "status": "SUPPRESSED" if below_floor else "NORMAL",
            },
            "open_rate": _rate(exposed_opened_count, active_count, active_count),
            "timing_coverage": _rate(timed_openings, total_openings, opened_count),
            "avg_interaction_time_seconds": _avg_seconds(),
            "engagement_rate": _rate(engaged_count, opened_count, opened_count),
            "save_rate": _rate(direct_save_count, active_count, active_count),
        },
    }


def chunk_batches(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Split events into ObservationBatchV2Schema-compliant batches (<=25 items, <=32 KiB)."""
    batches: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    for event in events:
        candidate = current + [event]
        encoded = json.dumps(
            {"contract": "observation.v2", "events": candidate},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        if current and (len(candidate) > MAX_BATCH_EVENTS or len(encoded) > MAX_BATCH_BYTES):
            batches.append({"contract": "observation.v2", "events": current})
            current = [event]
        else:
            current = candidate

    if current:
        batches.append({"contract": "observation.v2", "events": current})
    return batches


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_manifest_hash(manifest_body: dict[str, Any]) -> str:
    payload = {k: v for k, v in manifest_body.items() if k != "manifest_sha256"}
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def generate_manifest(config: GeneratorConfig) -> dict[str, Any]:
    """Validate inputs, generate scenario events, compute metrics and deterministic manifest."""
    validated = validate_config(config)
    run_key = "|".join(
        [
            "s7-data-18",
            validated["scenario"],
            validated["venue_id"],
            validated["publication_id"],
            validated["dish_id"],
            validated["dish_revision_id"],
            _format_utc_iso(validated["start_dt"]),
            _format_utc_iso(validated["end_dt"]),
            validated["seed"],
        ]
    )
    run_id = deterministic_uuid(run_key, "run")

    if validated["scenario"] == "A":
        events = _build_scenario_a_events(validated, run_key)
    else:
        events = _build_scenario_b_events(validated, run_key)

    if len(events) > validated["event_cap"]:
        raise GuardrailError(
            f"Generated {len(events)} events, exceeding event_cap ({validated['event_cap']})."
        )

    batches = chunk_batches(events)
    expected = calculate_expected_metrics(events, validated["dish_id"])
    session_ids = sorted({event["session_id"] for event in events})
    event_ids = [event["event_id"] for event in events]
    input_tuple = {
        "fixture_version": FIXTURE_VERSION,
        "generator_version": GENERATOR_VERSION,
        "scenario": validated["scenario"],
        "venue_id": validated["venue_id"],
        "publication_revision_id": validated["publication_id"],
        "dish_id": validated["dish_id"],
        "dish_revision_id": validated["dish_revision_id"],
        "window_start": _format_utc_iso(validated["start_dt"]),
        "window_end": _format_utc_iso(validated["end_dt"]),
        "seed": validated["seed"],
        "event_cap": validated["event_cap"],
    }
    input_sha256 = hashlib.sha256(canonical_json(input_tuple).encode("utf-8")).hexdigest()
    output_sha256 = hashlib.sha256(
        canonical_json({"batches": batches, "expected_metrics": expected}).encode("utf-8")
    ).hexdigest()
    uses_placeholder = any(
        value in PLACEHOLDER_UUIDS
        for value in (
            validated["venue_id"],
            validated["publication_id"],
            validated["dish_id"],
            validated["dish_revision_id"],
        )
    )
    authorization_status = (
        "DRY_RUN_UNVERIFIED" if (config.dry_run or uses_placeholder) else "AUTHORIZED_STAGING"
    )

    manifest_body: dict[str, Any] = {
        "schema_version": "s7-data-18.manifest.v1",
        "fixture_version": FIXTURE_VERSION,
        "generator_version": GENERATOR_VERSION,
        "provenance": {
            "pack_id": "owner-synthetic-p0-v2",
            "fixture_status": "DRAFT_FOR_INDEPENDENT_REVIEW",
            "fictional_only": True,
        },
        "authorization_status": authorization_status,
        "run_id": run_id,
        "scenario": validated["scenario"],
        "dry_run": config.dry_run,
        "destination": {
            "api_base_url": validated["origin"],
            "ingest_endpoint": f"{validated['origin']}/observations",
        },
        "target": {
            "venue_id": validated["venue_id"],
            "publication_revision_id": validated["publication_id"],
            "dish_id": validated["dish_id"],
            "dish_revision_id": validated["dish_revision_id"],
            "dish_is_demo": False,
        },
        "window_utc": {
            "start": _format_utc_iso(validated["start_dt"]),
            "end": _format_utc_iso(validated["end_dt"]),
        },
        "seed": validated["seed"],
        "event_cap": validated["event_cap"],
        "event_count": len(events),
        "batch_count": len(batches),
        "session_ids": session_ids,
        "event_ids": event_ids,
        "expected_metrics": expected,
        "input_sha256": input_sha256,
        "output_sha256": output_sha256,
        "batches": batches,
    }
    manifest_body["manifest_sha256"] = compute_manifest_hash(manifest_body)
    return manifest_body


def load_and_verify_manifest(
    manifest_path: Path,
    authorized_venues: frozenset[str] = DEFAULT_AUTHORIZED_STAGING_VENUES,
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_hash = compute_manifest_hash(manifest)
    if manifest.get("manifest_sha256") != expected_hash:
        raise GuardrailError(
            f"Manifest checksum mismatch: expected {expected_hash}, got {manifest.get('manifest_sha256')}"
        )
    origin = _normalize_origin(manifest["destination"]["api_base_url"])
    if origin in PRODUCTION_ORIGINS or origin not in DEFAULT_AUTHORIZED_STAGING_ORIGINS:
        raise GuardrailError(f"Unauthorized destination in manifest: {origin!r}")
    venue_id = _normalize_uuid(manifest["target"]["venue_id"], "venue_id")
    if venue_id not in authorized_venues:
        raise GuardrailError(f"Unauthorized venue_id in manifest: {venue_id!r}")
    return manifest


def send_manifest_batches(manifest: dict[str, Any], menu_token: str) -> list[dict[str, Any]]:
    """Send batches to POST /observations using the normal tracking endpoint."""
    if not menu_token or not menu_token.strip():
        raise GuardrailError("A valid menu_token is required for live delivery.")
    if manifest.get("authorization_status") != "AUTHORIZED_STAGING":
        raise GuardrailError(
            f"Refusing live delivery for unverified manifest status {manifest.get('authorization_status')!r}."
        )
    target_venue = _normalize_uuid(manifest.get("target", {}).get("venue_id", ""), "venue_id")
    if target_venue in PLACEHOLDER_UUIDS:
        raise GuardrailError(
            f"Refusing live delivery to placeholder venue_id {target_venue!r}."
        )
    endpoint = manifest["destination"]["ingest_endpoint"]
    origin = manifest["destination"]["api_base_url"]
    if origin in PRODUCTION_ORIGINS or origin not in DEFAULT_AUTHORIZED_STAGING_ORIGINS:
        raise GuardrailError(f"Refusing to send to unauthorized destination {origin!r}")

    receipts: list[dict[str, Any]] = []
    for batch in manifest["batches"]:
        req = Request(
            endpoint,
            data=json.dumps(batch, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {menu_token.strip()}",
            },
            method="POST",
        )
        try:
            with urlopen(req, timeout=15) as resp:
                receipts.append(json.loads(resp.read().decode("utf-8")))
        except (HTTPError, URLError) as exc:
            raise RuntimeError(f"POST /observations failed: {exc}") from exc
    return receipts


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="S7-DATA-18 deterministic synthetic diner activity generator (dry-run by default)."
    )
    parser.add_argument("--scenario", choices=["A", "B", "a", "b"], help="Acceptance scenario (A or B).")
    parser.add_argument("--venue-id", default="00000000-0000-4000-8000-000000000123", help="Authorized staging venue UUID.")
    parser.add_argument(
        "--authorized-venue-id",
        action="append",
        default=[],
        help="Explicitly authorized non-placeholder staging venue UUID for live --send or --replay.",
    )
    parser.add_argument("--publication-id", help="Current publication revision UUID.")
    parser.add_argument("--current-publication-id", default=None, help="Optional authoritative current publication UUID to guard against stale publications.")
    parser.add_argument("--dish-id", help="Newly published non-demo dish UUID.")
    parser.add_argument("--dish-revision-id", help="Newly published non-demo dish revision UUID.")
    parser.add_argument("--demo-dish", action="store_true", help="Mark dish as demo (always rejected).")
    parser.add_argument("--seed", default="s7-data-18-seed-1", help="Deterministic seed string.")
    parser.add_argument("--window-start", help="Explicit UTC window start (ISO-8601 ending in Z or +00:00).")
    parser.add_argument("--window-end", help="Explicit UTC window end (ISO-8601 ending in Z or +00:00).")
    parser.add_argument("--reference-received-at", default=None, help="Optional UTC receipt time to verify 24h/+5m ingestion window.")
    parser.add_argument("--event-cap", type=int, default=100, help="Maximum allowed events for the run.")
    parser.add_argument("--api-base-url", default="https://peekaplate-api-staging.vxkong.workers.dev", help="Authorized staging API base URL.")
    parser.add_argument("--output", type=Path, default=None, help="Optional path to write the deterministic manifest JSON.")
    parser.add_argument("--replay", type=Path, default=None, help="Replay an existing manifest file after verifying its SHA-256.")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Validate and emit manifest without sending HTTP requests (default).")
    parser.add_argument("--send", action="store_true", help="Actually POST batches to /observations (requires --confirm-staging and --menu-token).")
    parser.add_argument("--confirm-staging", action="store_true", help="Explicit confirmation that venue, publication, dish, window, and cap are approved for staging.")
    parser.add_argument("--menu-token", default=None, help="Bearer menu token for live staging delivery (never stored in manifest).")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.send and not args.confirm_staging:
        print("Error: --send requires --confirm-staging after confirming venue, publication, dish, UTC window, and cap.", file=sys.stderr)
        return 2

    dry_run = not args.send
    authorized_venues = frozenset(
        {
            *DEFAULT_AUTHORIZED_STAGING_VENUES,
            *(_normalize_uuid(v, "authorized_venue_id") for v in args.authorized_venue_id),
        }
    )

    try:
        if args.replay is not None:
            manifest = load_and_verify_manifest(args.replay, authorized_venues=authorized_venues)
        else:
            missing = [
                flag
                for flag, val in (
                    ("--scenario", args.scenario),
                    ("--publication-id", args.publication_id),
                    ("--dish-id", args.dish_id),
                    ("--dish-revision-id", args.dish_revision_id),
                    ("--window-start", args.window_start),
                    ("--window-end", args.window_end),
                )
                if not val
            ]
            if missing:
                parser.error(f"Missing required arguments: {', '.join(missing)}")

            config = GeneratorConfig(
                scenario=args.scenario,
                venue_id=args.venue_id,
                publication_id=args.publication_id,
                current_publication_id=args.current_publication_id,
                dish_id=args.dish_id,
                dish_revision_id=args.dish_revision_id,
                dish_is_demo=args.demo_dish,
                seed=args.seed,
                window_start=args.window_start,
                window_end=args.window_end,
                event_cap=args.event_cap,
                api_base_url=args.api_base_url,
                authorized_venues=authorized_venues,
                reference_received_at=args.reference_received_at,
                dry_run=dry_run,
            )
            manifest = generate_manifest(config)
    except GuardrailError as exc:
        print(f"Guardrail rejected run: {exc}", file=sys.stderr)
        return 2

    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    if not dry_run:
        receipts = send_manifest_batches(manifest, args.menu_token or "")
        print(
            json.dumps(
                {
                    "mode": "live",
                    "run_id": manifest["run_id"],
                    "manifest_sha256": manifest["manifest_sha256"],
                    "batches_sent": len(receipts),
                    "receipts": receipts,
                },
                indent=2,
            )
        )
    else:
        summary = {
            "mode": "dry-run",
            "run_id": manifest["run_id"],
            "scenario": manifest["scenario"],
            "manifest_sha256": manifest["manifest_sha256"],
            "event_count": manifest["event_count"],
            "batch_count": manifest["batch_count"],
            "expected_metrics": manifest["expected_metrics"],
        }
        print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
