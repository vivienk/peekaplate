
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "events" / "two_session_story.jsonl"
OUTPUT = ROOT / "events" / "full_dataset.jsonl"

PAIR_COUNT = 150


def main():
    source_rows = [
        json.loads(line)
        for line in SOURCE.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    generated_rows = []

    for pair_number in range(1, PAIR_COUNT + 1):
        suffix = f"pair-{pair_number:03d}"

        for original in source_rows:
            row = original.copy()

            # Give each repeated story its own event identities.
            row["event_id"] = f"{original['event_id']}-{suffix}"
            row["session_id"] = f"{original['session_id']}-{suffix}"

            # Preserve relationships within each repeated story.
            for field in (
                "opening_id",
                "exposure_id",
                "comparison_id",
            ):
                if row.get(field):
                    row[field] = f"{row[field]}-{suffix}"

            generated_rows.append(row)

    OUTPUT.write_text(
        "".join(
            json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
            for row in generated_rows
        ),
        encoding="utf-8",
    )

    unique_ids = {row["event_id"] for row in generated_rows}
    sessions = {row["session_id"] for row in generated_rows}

    print(f"Delivery lines: {len(generated_rows)}")
    print(f"Unique observations: {len(unique_ids)}")
    print(f"Sessions: {len(sessions)}")
    print(f"Output: {OUTPUT}")


if __name__ == "__main__":
    main()
