
from pathlib import Path
import json
from datetime import datetime
import sys
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent

import argparse

parser = argparse.ArgumentParser()
parser.add_argument(
    "source",
    nargs="?",
    default=str(ROOT / "events" / "full_dataset.jsonl"),
    help="Path to the dataset to validate"
)
parser.add_argument(
    "--dataset",
    choices=["full", "starter"],
    default="full",
    help="Declared dataset profile; defaults to full"
)

args = parser.parse_args()
SOURCE = Path(args.source)

if args.source == str(ROOT / "events" / "full_dataset.jsonl"):
    SOURCE = ROOT / "events" / (
        "two_session_story.jsonl"
        if args.dataset == "starter"
        else "full_dataset.jsonl"
    )

manifest = json.loads(
    (ROOT / "manifest.json").read_text(encoding="utf-8")
)
dataset_profile = manifest["datasets"][args.dataset]

rows = [
    json.loads(line)
    for line in SOURCE.read_text(encoding="utf-8").splitlines()
    if line.strip()
]

# Validate every delivery against the declared fixture schema.
schema = json.loads(
    (ROOT / "schema.json").read_text(encoding="utf-8")
)

validator = Draft202012Validator(
    schema,
    format_checker=FormatChecker()
)

for line_number, row in enumerate(rows, start=1):
    errors = list(validator.iter_errors(row))

    if errors:
        error = sorted(
            errors,
            key=lambda e: (list(map(str, e.path)), e.message)
        )[0]

        event_id = row.get("event_id", "<missing>")
        field = ".".join(map(str, error.path)) or "<record>"

        raise AssertionError(
            f"Schema validation failed at line {line_number}, "
            f"event {event_id!r}, field {field}: {error.message}"
        )

print("PASS: All event deliveries match schema.json.")

# Remove identical retry deliveries.
unique_events = {}

for row in rows:
    event_id = row["event_id"]

    if event_id in unique_events:
        assert unique_events[event_id] == row, (
            f"Conflicting duplicate: {event_id}"
        )
    else:
        unique_events[event_id] = row

events = list(unique_events.values())

# Validate expected delivery counts for the full synthetic dataset.
EXPECTED_TOTAL_DELIVERIES = 3150
EXPECTED_UNIQUE_EVENTS = 3000
EXPECTED_RETRY_DELIVERIES = 150

# Validate counts using the explicitly selected manifest dataset.
expected_total = dataset_profile["delivery_lines"]
expected_unique = dataset_profile["unique_observations"]
expected_retries = expected_total - expected_unique

actual_total = len(rows)
actual_unique = len(unique_events)
actual_retries = actual_total - actual_unique

assert actual_total == expected_total, (
    f"Missing or extra event deliveries: expected {expected_total}, "
    f"found {actual_total}"
)

assert actual_unique == expected_unique, (
    f"Unexpected unique event count: expected {expected_unique}, "
    f"found {actual_unique}"
)

assert actual_retries == expected_retries, (
    f"Missing or extra retry deliveries: expected {expected_retries}, "
    f"found {actual_retries}"
)

print(f"PASS: Declared {args.dataset} dataset counts match.")

# Validate schema versions.
EXPECTED_SCHEMA_VERSION = "synthetic.fixture.v1"

for row in events:
    assert row.get("schema_version") == EXPECTED_SCHEMA_VERSION, (
        f"Invalid schema version in {row['event_id']}: "
        f"{row.get('schema_version')}"
    )

print("PASS: All events use the correct schema version.")

# Validate event timestamps and require an explicit timezone.
for row in events:
    timestamp = row.get("occurred_at")
    event_id = row.get("event_id", "<missing>")

    assert isinstance(timestamp, str) and timestamp, (
        f"Invalid occurred_at for event {event_id}: missing timestamp"
    )

    try:
        parsed = datetime.fromisoformat(
            timestamp.replace("Z", "+00:00")
        )
    except (ValueError, TypeError):
        raise AssertionError(
            f"Invalid occurred_at for event {event_id}: {timestamp!r}"
        )

    assert parsed.tzinfo is not None and parsed.utcoffset() is not None, (
        f"Invalid occurred_at for event {event_id}: "
        f"timezone offset is required"
    )

print("PASS: All event timestamps are valid and timezone-aware.")

# Reject duplicate sequence numbers within a session.
seen_sequences = set()

for row in events:
    key = (row["session_id"], row["local_sequence"])

    assert key not in seen_sequences, (
        f"Duplicate local_sequence in session: {key}"
    )

    seen_sequences.add(key)

print("PASS: No duplicate sequence numbers within sessions.")

exposures = {
    (
        row["session_id"],
        row["dish_id"],
        row["exposure_id"]
    ): row
    for row in events
    if row["event_type"] == "dish_viewed"
}

openings = [
    row for row in events
    if row["event_type"] == "dish_detail_opened"
]

for opening in openings:
    key = (
        opening["session_id"],
        opening["dish_id"],
        opening["exposure_id"]
    )

    assert key in exposures, (
        f"Missing exposure for {opening['event_id']}"
    )

    assert (
        exposures[key]["local_sequence"]
        < opening["local_sequence"]
    ), f"Exposure occurs after opening: {opening['event_id']}"

print("PASS: Duplicate deliveries are identical.")
print("PASS: All detail openings link to valid earlier exposures.")
print(f"Validated openings: {len(openings)}")


# Validate checkpoint-to-opening relationships.
opening_lookup = {
    row["opening_id"]: row
    for row in openings
}

checkpoints = [
    row for row in events
    if row["event_type"] == "dish_activity_checkpoint"
]

for checkpoint in checkpoints:
    opening_id = checkpoint["opening_id"]

    assert opening_id in opening_lookup, (
        f"Missing opening for checkpoint: {checkpoint['event_id']}"
    )

    opening = opening_lookup[opening_id]

    assert checkpoint["session_id"] == opening["session_id"], (
        f"Wrong session for checkpoint: {checkpoint['event_id']}"
    )

      # Check that the checkpoint references the correct dish.
    if "dish_id" in checkpoint:
        assert checkpoint["dish_id"] == opening["dish_id"], (
            f"Checkpoint dish mismatch: {checkpoint['event_id']}"
        )

    assert checkpoint["local_sequence"] > opening["local_sequence"], (
        f"Checkpoint occurs before opening: {checkpoint['event_id']}"
    )


        # Check actual event timestamps, not delivery-line order.
    opening_time = datetime.fromisoformat(opening["occurred_at"])
    checkpoint_time = datetime.fromisoformat(checkpoint["occurred_at"])

    elapsed_ms = (
        checkpoint_time - opening_time
    ).total_seconds() * 1000

    assert elapsed_ms >= 0, (
        f"Checkpoint timestamp precedes opening: {checkpoint['event_id']}"
    )

    assert checkpoint["cumulative_active_ms"] <= elapsed_ms + 0.001, (
        f"Checkpoint active time exceeds elapsed time: {checkpoint['event_id']}"
    )

print("PASS: All checkpoints link to valid earlier openings.")
print(f"Validated checkpoints: {len(checkpoints)}")



# Validate comparison relationships.
comparisons = [
    row for row in events
    if row["event_type"] == "dish_compared"
]

for comparison in comparisons:
    opening_id = comparison["opening_id"]

    assert opening_id in opening_lookup, (
        f"Missing opening for comparison: {comparison['event_id']}"
    )

    opening = opening_lookup[opening_id]

    assert comparison["session_id"] == opening["session_id"], (
        f"Wrong session: {comparison['event_id']}"
    )

    assert comparison["local_sequence"] > opening["local_sequence"], (
        f"Comparison before opening: {comparison['event_id']}"
    )

    assert len(comparison["dish_ids"]) == 2, (
        f"Invalid pair size: {comparison['event_id']}"
    )

    assert len(set(comparison["dish_ids"])) == 2, (
        f"Duplicate dish in pair: {comparison['event_id']}"
    )

    assert opening["dish_id"] in comparison["dish_ids"], (
        f"Opening dish missing from pair: {comparison['event_id']}"
    )

    assert comparison["display_state"] == "displayed", (
        f"Pair not displayed: {comparison['event_id']}"
    )

print("PASS: All comparisons have valid opening links and displayed pairs.")
print(f"Validated comparisons: {len(comparisons)}")


# Validate Save, Unsave, and Undo state transitions.
saved_by_session = {}
last_unsaved_by_session = {}
direct_saves = 0
undo_restorations = 0
unsaves = 0

for row in sorted(
    events,
    key=lambda r: (r["session_id"], r["local_sequence"])
):
    session = row["session_id"]
    dish = row.get("dish_id")
    event_type = row["event_type"]

    saved = saved_by_session.setdefault(session, set())

    if event_type == "dish_saved":
        origin = row.get("save_origin")

        if origin == "direct":
            assert dish not in saved, (
                f"Dish already saved: {row['event_id']}"
            )
            direct_saves += 1

        elif origin == "undo":
            assert dish not in saved, (
                f"Undo restored an already saved dish: {row['event_id']}"
    )

            assert last_unsaved_by_session.get(session) == dish, (
                f"Undo without matching prior Unsave: {row['event_id']}"
    )

            last_unsaved_by_session.pop(session, None)
            undo_restorations += 1

        else:
            raise AssertionError(
                f"Unknown save origin: {row['event_id']}"
            )

        saved.add(dish)

    elif event_type == "dish_unsaved":
        assert dish in saved, (
            f"Unsave without prior Save: {row['event_id']}"
        )

        saved.remove(dish)
        last_unsaved_by_session[session] = dish
        unsaves += 1

print("PASS: Save, Unsave, and Undo transitions are valid.")
print(f"Direct Saves: {direct_saves}")
print(f"Undo restorations: {undo_restorations}")
print(f"Successful Unsaves: {unsaves}")



# Validate shortlist_size after each Save or Unsave.
shortlists = {}
validated_sizes = 0

for row in sorted(
    events,
    key=lambda r: (r["session_id"], r["local_sequence"])
):
    session = row["session_id"]
    dish = row.get("dish_id")
    saved = shortlists.setdefault(session, set())

    if row["event_type"] == "dish_saved":
        saved.add(dish)

    elif row["event_type"] == "dish_unsaved":
        saved.discard(dish)

    else:
        continue

    assert row["shortlist_size"] == len(saved), (
        f"Incorrect shortlist_size: {row['event_id']} "
        f"expected {len(saved)}, got {row['shortlist_size']}"
    )

    validated_sizes += 1

print("PASS: All shortlist sizes match saved state.")
print(f"Validated shortlist sizes: {validated_sizes}")


# Validate final Saved state for the selected dataset.
session_x_count = 0
session_y_count = 0

expected_pairs = 1 if args.dataset == "starter" else 150

for session_id, saved in saved_by_session.items():

    if (
        session_id == "session-X"
        if args.dataset == "starter"
        else session_id.startswith("session-X-pair-")
    ):
        assert saved == {"dish-A"}, (
            f"Incorrect final Saved state: {session_id}"
        )
        session_x_count += 1

    elif (
        session_id == "session-Y"
        if args.dataset == "starter"
        else session_id.startswith("session-Y-pair-")
    ):
        assert saved == set(), (
            f"Incorrect final Saved state: {session_id}"
        )
        session_y_count += 1

    else:
        raise AssertionError(
            f"Unexpected session: {session_id}"
        )

assert session_x_count == expected_pairs
assert session_y_count == expected_pairs

print("PASS: Final retained dishes match the expected story.")
print(f"Session X copies with Dish A saved: {session_x_count}")
print(f"Session Y copies with no saved dishes: {session_y_count}")




# Validate completed active-time metrics.
from collections import Counter

checkpoints_by_opening = {}

for row in checkpoints:
    checkpoints_by_opening.setdefault(
        row["opening_id"], []
    ).append(row)

completed_times = []

for opening_id, opening_checkpoints in checkpoints_by_opening.items():
    final_checkpoints = [
        row for row in opening_checkpoints
        if row.get("is_final") is True
    ]

    assert len(final_checkpoints) == 1, (
        f"Expected one final checkpoint: {opening_id}"
    )

    final_ms = final_checkpoints[0]["cumulative_active_ms"]

    assert all(
        row["cumulative_active_ms"] <= final_ms
        for row in opening_checkpoints
    ), f"Checkpoint exceeds final time: {opening_id}"

    completed_times.append(final_ms / 1000)

time_counts = Counter(completed_times)

assert len(completed_times) == 2 * expected_pairs
assert time_counts[10.0] == expected_pairs
assert time_counts[5.0] == expected_pairs

average_seconds = sum(completed_times) / len(completed_times)

assert average_seconds == 7.5

print("PASS: Completed active-time metrics match expectations.")
print(f"Completed openings: {len(completed_times)}")
print(f"10-second openings: {time_counts[10.0]}")
print(f"5-second openings: {time_counts[5.0]}")
print(f"Average active time: {average_seconds} seconds")



# Validate full-dataset exposure, opening, Save,
# and comparison metrics.

from collections import defaultdict

exposed_sessions = defaultdict(set)
opened_sessions = defaultdict(set)
direct_save_sessions = set()
comparison_pairs = defaultdict(set)

for row in events:
    event_type = row["event_type"]
    session = row["session_id"]

    if event_type == "dish_viewed":
        exposed_sessions[row["dish_id"]].add(session)

    elif event_type == "dish_detail_opened":
        opened_sessions[row["dish_id"]].add(session)

    elif event_type == "dish_saved":
        if row.get("save_origin") == "direct":
            direct_save_sessions.add(session)

    elif event_type == "dish_compared":
        if row.get("display_state") == "displayed":
            pair = tuple(sorted(row["dish_ids"]))
            comparison_pairs[pair].add(session)

expected_exposures = {
    "dish-A": 2 * expected_pairs,
    "dish-B": 2 * expected_pairs,
    "dish-C": expected_pairs,
}

expected_openings = {
    "dish-A": expected_pairs,
    "dish-B": expected_pairs,
    "dish-C": 0,
}

for dish, expected in expected_exposures.items():
    assert len(exposed_sessions[dish]) == expected
    assert len(opened_sessions[dish]) == expected_openings[dish]

    rate = len(opened_sessions[dish]) / len(exposed_sessions[dish])

    assert rate == {
        "dish-A": 0.5,
        "dish-B": 0.5,
        "dish-C": 0.0,
    }[dish]

assert len(direct_save_sessions) == 2 * expected_pairs

all_sessions = {row["session_id"] for row in events}
assert len(all_sessions) == 2 * expected_pairs

save_adoption = len(direct_save_sessions) / len(all_sessions)
assert save_adoption == 1.0

assert len(comparison_pairs[("dish-A", "dish-B")]) == expected_pairs

print(f"PASS: {args.dataset.capitalize()}-dataset metric checks.")
print(
    f"Exposure sessions: A={len(exposed_sessions['dish-A'])}, "
    f"B={len(exposed_sessions['dish-B'])}, "
    f"C={len(exposed_sessions['dish-C'])}"
)
print(
    f"Opening sessions: A={len(opened_sessions['dish-A'])}, "
    f"B={len(opened_sessions['dish-B'])}, "
    f"C={len(opened_sessions['dish-C'])}"
)
print("Linked opening rates: A=50%, B=50%, C=0%")
print(
    f"Save adoption: {len(direct_save_sessions)}/{len(all_sessions)} "
    f"= {save_adoption:.0%}"
)
print(
    "Displayed A/B comparison sessions: "
    f"{len(comparison_pairs[('dish-A', 'dish-B')])}"
)


# Verify Start and Replace comparison metrics.
comparison_events = [
    row for row in events
    if row["event_type"] == "dish_compared"
    and row.get("display_state") == "displayed"
]

comparison_starts = [
    row for row in comparison_events
    if row["compare_action"] == "start"
]

comparison_replaces = [
    row for row in comparison_events
    if row["compare_action"] == "replace"
]

distinct_flows = {
    (row["session_id"], row["comparison_id"])
    for row in comparison_events
}

assert len(comparison_starts) == dataset_profile["comparison_starts"]
assert len(comparison_replaces) == dataset_profile["comparison_replaces"]
assert len(distinct_flows) == dataset_profile["distinct_comparison_flows"]
assert len(comparison_events) == dataset_profile["displayed_pair_events"]

assert len(comparison_pairs[("dish-A", "dish-B")]) == expected_pairs
assert len(comparison_pairs[("dish-A", "dish-C")]) == expected_pairs

print("PASS: Start/Replace comparison attribution checks.")
print(f"Comparison Starts: {len(comparison_starts)}")
print(f"Comparison Replaces: {len(comparison_replaces)}")
print(f"Distinct comparison flows: {len(distinct_flows)}")
print(f"Displayed pair events: {len(comparison_events)}")
