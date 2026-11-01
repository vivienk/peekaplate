from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "events" / "two_session_story.jsonl"

def main():
    rows = [json.loads(line) for line in SOURCE.read_text(encoding="utf-8").splitlines() if line.strip()]
    # Stable compact serialization makes the committed fixture easy to diff.
    SOURCE.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows), encoding="utf-8")
    print(f"Validated and normalized {len(rows)} fixture events in {SOURCE}")

if __name__ == "__main__":
    main()
