#!/usr/bin/env python3
"""Compute-unit safeguard for the Colab Track 2B stage.

The Colab CLI cannot enforce a spend cap itself, so this helper turns a cap into
a wall-clock limit:

    remaining   = cap - (start_balance - current_balance)
    rate        = max(reported_or_measured_rate, floor_rate)     # units / hour
    max_seconds = safety * remaining / rate * 3600 - overhead_seconds

A dish is skipped when max_seconds < min_seconds. Every decision is appended to
<out_root>/colab_spend.jsonl so the actual spend can be audited afterwards.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_ASSUMED_RATE = 8.0  # deliberately above any published L4 rate
DEFAULT_FLOOR_RATE = 4.0
DEFAULT_SAFETY = 0.8
DEFAULT_OVERHEAD_S = 600.0
DEFAULT_MIN_S = 1200.0

_BAL_RE = re.compile(r"balance:\s*([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
_RATE_RE = re.compile(r"rate:\s*([0-9]+(?:\.[0-9]+)?)\s*/\s*hr", re.IGNORECASE)
_ASSIGN_RE = re.compile(r"active assignments:\s*([0-9]+)", re.IGNORECASE)


@dataclass(frozen=True)
class Usage:
    balance: float
    rate_per_hour: float | None
    active_assignments: int | None


def parse_usage(text: str) -> Usage:
    """Parse `colab usage` output. Raises ValueError if the balance is missing."""
    bal = _BAL_RE.search(text)
    if not bal:
        raise ValueError(f"could not find a compute-unit balance in: {text!r}")
    rate = _RATE_RE.search(text)
    assign = _ASSIGN_RE.search(text)
    return Usage(
        balance=float(bal.group(1)),
        rate_per_hour=float(rate.group(1)) if rate else None,
        active_assignments=int(assign.group(1)) if assign else None,
    )


@dataclass(frozen=True)
class Plan:
    cap: float
    start_balance: float
    current_balance: float
    spent: float
    remaining: float
    rate_per_hour: float
    rate_source: str
    max_seconds: int
    run: bool
    reason: str


def plan_dish(
    *,
    cap: float,
    start_balance: float,
    current_balance: float,
    reported_rate: float | None = None,
    measured_rate: float | None = None,
    assumed_rate: float = DEFAULT_ASSUMED_RATE,
    floor_rate: float = DEFAULT_FLOOR_RATE,
    safety: float = DEFAULT_SAFETY,
    overhead_s: float = DEFAULT_OVERHEAD_S,
    min_s: float = DEFAULT_MIN_S,
) -> Plan:
    if cap <= 0:
        raise ValueError("cap must be positive")
    spent = max(0.0, start_balance - current_balance)
    remaining = cap - spent
    # Prefer the larger of reported and measured; a zero report (idle account) is ignored.
    candidates = [(r, s) for r, s in ((reported_rate, "reported"), (measured_rate, "measured")) if r and r > 0]
    if candidates:
        rate, source = max(candidates)
    else:
        rate, source = assumed_rate, "assumed"
    if rate < floor_rate:
        rate, source = floor_rate, f"floor({source})"
    if remaining <= 0:
        return Plan(cap, start_balance, current_balance, spent, remaining, rate, source, 0, False, "cap reached")
    max_s = safety * remaining / rate * 3600.0 - overhead_s
    if max_s < min_s:
        return Plan(cap, start_balance, current_balance, spent, remaining, rate, source, max(0, int(max_s)), False,
                    f"budget allows {max_s/60:.1f} min < {min_s/60:.0f} min minimum")
    return Plan(cap, start_balance, current_balance, spent, remaining, rate, source, int(max_s), True, "ok")


def measured_rate_from_log(log_path: Path) -> float | None:
    """Highest units/hour observed across completed dishes in colab_spend.jsonl."""
    if not log_path.is_file():
        return None
    best = None
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("event") != "dish_done":
            continue
        hours = rec.get("elapsed_s", 0) / 3600.0
        used = rec.get("units_used")
        if hours > 0.05 and used is not None:
            r = used / hours
            best = r if best is None else max(best, r)
    return best


def start_balance_from_log(log_path: Path) -> float | None:
    if not log_path.is_file():
        return None
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("event") == "budget_start":
            return float(rec["balance"])
    return None


def append_log(log_path: Path, record: dict) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **record}
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="Decide whether a dish may run; prints shell-evaluable vars.")
    p.add_argument("--log", type=Path, required=True)
    p.add_argument("--dish", required=True)
    p.add_argument("--cap", type=float, required=True)
    p.add_argument("--usage-text", required=True, help="Raw `colab usage` output")
    p.add_argument("--reported-rate", type=float, default=None,
                   help="Rate read while the dish's runtime is assigned (overrides the usage text rate).")
    p.add_argument("--overhead-s", type=float, default=DEFAULT_OVERHEAD_S)
    p.add_argument("--min-s", type=float, default=DEFAULT_MIN_S)

    d = sub.add_parser("done", help="Record actual spend after a dish.")
    d.add_argument("--log", type=Path, required=True)
    d.add_argument("--dish", required=True)
    d.add_argument("--before", type=float, required=True)
    d.add_argument("--usage-text", required=True)
    d.add_argument("--elapsed-s", type=float, required=True)
    d.add_argument("--status", required=True)

    args = ap.parse_args(argv)
    usage = parse_usage(args.usage_text)

    if args.cmd == "plan":
        start = start_balance_from_log(args.log)
        if start is None:
            start = usage.balance
            append_log(args.log, {"event": "budget_start", "balance": start, "cap": args.cap})
        reported = args.reported_rate if args.reported_rate is not None else usage.rate_per_hour
        pl = plan_dish(cap=args.cap, start_balance=start, current_balance=usage.balance,
                       reported_rate=reported, measured_rate=measured_rate_from_log(args.log),
                       overhead_s=args.overhead_s, min_s=args.min_s)
        append_log(args.log, {"event": "plan", "dish": args.dish, **asdict(pl)})
        print(f"PLAN_RUN={1 if pl.run else 0}")
        print(f"PLAN_MAX_SECONDS={pl.max_seconds}")
        print(f"PLAN_REMAINING={pl.remaining:.2f}")
        print(f"PLAN_RATE={pl.rate_per_hour:.2f}")
        print(f"PLAN_RATE_SOURCE='{pl.rate_source}'")
        print(f"PLAN_BALANCE={pl.current_balance:.2f}")
        print(f"PLAN_REASON='{pl.reason}'")
        return 0

    used = max(0.0, args.before - usage.balance)
    append_log(args.log, {"event": "dish_done", "dish": args.dish, "status": args.status,
                          "balance_before": args.before, "balance_after": usage.balance,
                          "units_used": round(used, 3), "elapsed_s": args.elapsed_s})
    print(f"UNITS_USED={used:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
