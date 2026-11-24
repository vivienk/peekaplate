#!/usr/bin/env python3
"""Expand the 2-session story into 300 deterministic sessions (150 pairs) with --dry-run and --replay validation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
BASE_FILE = ROOT / "events" / "two_session_story.jsonl"
OUT_FILE = ROOT / "events" / "full_dataset.jsonl"
MANIFEST_FILE = ROOT / "manifest.json"
PAIR_COUNT = 150


def build_expanded_lines(base_lines: list[str], pair_count: int = PAIR_COUNT) -> list[str]:
    expanded: list[str] = []
    for pair_idx in range(1, pair_count + 1):
        suffix = f"-pair-{pair_idx:03d}"
        for raw in base_lines:
            record = json.loads(raw)
            record["session_id"] = record["session_id"] + suffix
            record["event_id"] = record["event_id"] + suffix
            if record.get("exposure_id") is not None:
                record["exposure_id"] = record["exposure_id"] + suffix
            expanded.append(json.dumps(record, separators=(",", ":")))
    return expanded


def summarize_and_verify(lines: list[str], manifest: dict[str, Any]) -> dict[str, Any]:
    unique_events: dict[str, dict[str, Any]] = {}
    for line in lines:
        rec = json.loads(line)
        unique_events.setdefault(rec["event_id"], rec)
    sessions = {rec["session_id"] for rec in unique_events.values()}
    digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()

    actual_counts = {
        "pair_count": PAIR_COUNT,
        "delivered_lines": len(lines),
        "unique_events": len(unique_events),
        "distinct_sessions": len(sessions),
    }

    expected_counts = manifest.get("expected_counts")
    if expected_counts and actual_counts != expected_counts:
        raise SystemExit(f"Manifest count mismatch: expected {expected_counts}, got {actual_counts}")

    trusted_sha256 = manifest.get("trusted_sha256")
    if trusted_sha256 and digest != trusted_sha256:
        raise SystemExit(f"Trusted SHA-256 mismatch: expected {trusted_sha256}, got {digest}")

    return {
        "pack_id": manifest["pack_id"],
        **actual_counts,
        "verified_orders_status": manifest["unavailable_metrics"]["verified_orders"]["status"],
        "classified_field_count": len(manifest.get("dashboard_field_classification", [])),
        "sha256": digest,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic synthetic dataset generator (S7-DATA-15)")
    parser.add_argument("--dry-run", action="store_true", help="Compute and verify summary without writing files")
    parser.add_argument("--replay", action="store_true", help="Replay generation and validate against trusted SHA-256 and manifest counts")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    base_lines = [line.strip() for line in BASE_FILE.read_text(encoding="utf-8").splitlines() if line.strip()]
    expanded = build_expanded_lines(base_lines, PAIR_COUNT)
    summary = summarize_and_verify(expanded, manifest)

    if args.dry_run:
        print(json.dumps({"mode": "dry-run", **summary}, indent=2))
        return

    payload = "\n".join(expanded) + "\n"
    if args.replay and OUT_FILE.exists():
        existing = OUT_FILE.read_text(encoding="utf-8").replace("\r\n", "\n")
        if existing != payload:
            raise SystemExit("Replay determinism check failed: generated output differs from existing full_dataset.jsonl")

    with OUT_FILE.open("w", encoding="utf-8", newline="\n") as f:
        f.write(payload)
    mode = "replay" if args.replay else "write"
    print(json.dumps({"mode": mode, "output": str(OUT_FILE.relative_to(ROOT)), **summary}, indent=2))


if __name__ == "__main__":
    main()
