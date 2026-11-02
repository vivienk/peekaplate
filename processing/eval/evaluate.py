#!/usr/bin/env python3
"""Field-level evaluation of review-candidates.json runs against answer keys.

Reports exact counts and denominators per condition, explicitly separating:
- Dish Recall: matched / total_key_dishes
- Dish Precision: matched / total_candidates
- Single-Price Denominator: matched dishes where ground truth has an unambiguous single price
- Single-Price Accuracy: correct_amount / single_price_denominator
- Price Abstentions: matched single-price dishes where amount is null (safe fallback)
- Wrong Prices: matched dishes where non-null amount contradicts ground truth
- Multi-Price Abstention: multi-price items correctly kept null vs incorrectly assigned an amount
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from decimal import Decimal
from difflib import SequenceMatcher
from pathlib import Path


def norm(text: str | None) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).casefold()
    return " ".join(re.sub(r"[^a-z0-9&/ ]+", " ", text).split())


def amount(value) -> Decimal | None:
    return None if value in (None, "") else Decimal(str(value))


def match(key_items: list[dict], cands: list[dict]) -> list[tuple[dict, dict | None]]:
    pairs = []
    for k in key_items:
        for i, c in enumerate(cands):
            ratio = SequenceMatcher(None, norm(k["name"]), norm(c["name"])).ratio()
            if ratio >= 0.85:
                same_price = amount(k.get("price_amount")) == amount(c.get("price_amount"))
                pairs.append((ratio + (0.01 if same_price else 0), id(k), i))
    pairs.sort(reverse=True)
    used_k, used_c, chosen = set(), set(), {}
    for _, kid, ci in pairs:
        if kid in used_k or ci in used_c:
            continue
        used_k.add(kid)
        used_c.add(ci)
        chosen[kid] = cands[ci]
    return [(k, chosen.get(id(k))) for k in key_items]


def evaluate(run_dir: Path, key: dict) -> tuple[dict, list[dict]]:
    review = json.loads((run_dir / "review-candidates.json").read_text())
    extraction = json.loads((run_dir / "extraction.json").read_text())
    model_name = extraction.get("extraction_model", "unknown")
    cands = [c["original"] for c in review["candidates"]]
    pairs = match(key["items"], cands)
    m = [(k, c) for k, c in pairs if c is not None]
    errors = []

    # Counters matching Zhiliang's exact criteria
    total_key = len(key["items"])
    total_cands = len(cands)
    matched = len(m)

    single_price_denom = 0
    single_price_correct = 0
    single_price_abstained = 0  # Missing amount (cleared to null)
    wrong_price_count = 0       # Silent corruption

    multi_price_denom = 0
    multi_price_correct_null = 0
    multi_price_wrong_assigned = 0

    category_correct = 0
    name_exact = 0

    for k, c in pairs:
        if c is None:
            errors.append({"field": "dish", "expected": k["name"], "actual": "", "error": "missed_dish"})

    for k, c in m:
        if norm(k["name"]) == norm(c["name"]):
            name_exact += 1
        else:
            errors.append({"field": "name", "expected": k["name"], "actual": c["name"], "error": "name_differs"})

        is_single = k.get("price_amount") is not None and not k.get("accept_null_amount")
        want_amt = amount(k.get("price_amount"))
        got_amt = amount(c.get("price_amount"))

        if is_single:
            single_price_denom += 1
            if got_amt == want_amt:
                single_price_correct += 1
            elif got_amt is None:
                single_price_abstained += 1
                errors.append({"field": "price_amount", "dish": k["name"], "expected": str(want_amt), "actual": "null", "error": "price_abstained"})
            else:
                wrong_price_count += 1
                errors.append({"field": "price_amount", "dish": k["name"], "expected": str(want_amt), "actual": str(got_amt), "error": "wrong_price"})
        else:
            multi_price_denom += 1
            accepted = {want_amt} if k.get("accept_amount") else {None}
            if k.get("accept_null_amount"):
                accepted.add(None)
                accepted.add(want_amt)
            if got_amt in accepted:
                multi_price_correct_null += 1
            else:
                multi_price_wrong_assigned += 1
                wrong_price_count += 1
                errors.append({"field": "price_amount", "dish": k["name"], "expected": str(want_amt) if want_amt else "null", "actual": str(got_amt), "error": "multi_price_assigned_unsupported"})

        cat_k, cat_c = norm(k["category"]), norm(c.get("category"))
        if cat_c and (cat_k in cat_c or cat_c in cat_k):
            category_correct += 1
        else:
            errors.append({"field": "category", "dish": k["name"], "expected": k["category"], "actual": c.get("category") or "null", "error": "category_differs"})

    matched_cands = {id(c) for _, c in m}
    for c in cands:
        if id(c) not in matched_cands:
            errors.append({"field": "dish", "expected": "", "actual": c["name"], "error": "extra_candidate"})

    stats = {
        "model": model_name,
        "status": review["status"],
        "key_dishes": total_key,
        "candidates": total_cands,
        "matched": matched,
        "recall_ratio": f"{matched}/{total_key}",
        "recall_pct": round(matched / max(1, total_key) * 100, 1),
        "prec_ratio": f"{matched}/{total_cands}",
        "prec_pct": round(matched / max(1, total_cands) * 100, 1),
        "single_price_denom": single_price_denom,
        "single_price_acc_ratio": f"{single_price_correct}/{single_price_denom}" if single_price_denom else "N/A",
        "single_price_acc_pct": round(single_price_correct / max(1, single_price_denom) * 100, 1) if single_price_denom else 0.0,
        "price_abstained": single_price_abstained,
        "wrong_prices": wrong_price_count,
        "wrong_price_rate_pct": round(wrong_price_count / max(1, matched) * 100, 1) if matched else 0.0,
        "multi_price_denom": multi_price_denom,
        "multi_price_correct": multi_price_correct_null,
        "category_acc_ratio": f"{category_correct}/{matched}" if matched else "N/A",
        "category_acc_pct": round(category_correct / max(1, matched) * 100, 1) if matched else 0.0,
    }
    return stats, errors


def main() -> None:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", type=Path)
    parser.add_argument("--keys", type=Path, default=here / "keys")
    parser.add_argument("--out", type=Path, default=here / "report-detailed")
    args = parser.parse_args()
    keys = {p.stem: json.loads(p.read_text()) for p in args.keys.glob("*.json")}
    args.out.mkdir(parents=True, exist_ok=True)
    rows, all_errors = [], []
    for run_dir in sorted(p for p in args.runs.iterdir() if p.is_dir() and (p / "review-candidates.json").exists()):
        stem, _, mode = run_dir.name.rpartition("-")
        mode = "vision_v4" if run_dir.name.endswith("vision_v4") else "ocr_image"
        stem = run_dir.name[: -len(mode) - 1]
        key_name, _, variant = stem.partition("__")
        if key_name not in keys:
            continue
        stats, errors = evaluate(run_dir, keys[key_name])
        row = {"menu": key_name, "variant": variant or "original", "mode": mode, **stats}
        rows.append(row)
        all_errors += [{"menu": key_name, "variant": row["variant"], "mode": mode, **e} for e in errors]

    cols = [
        "menu", "variant", "mode", "model", "status",
        "recall_ratio", "recall_pct", "prec_ratio", "prec_pct",
        "single_price_denom", "single_price_acc_ratio", "single_price_acc_pct",
        "price_abstained", "wrong_prices", "wrong_price_rate_pct"
    ]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        lines.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")

    (args.out / "report.md").write_text("\n".join(lines) + "\n")
    with (args.out / "errors.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["menu", "variant", "mode", "field", "dish", "expected", "actual", "error"])
        writer.writeheader()
        for e in all_errors:
            writer.writerow({k: e.get(k, "") for k in writer.fieldnames})
    (args.out / "summary.json").write_text(json.dumps(rows, indent=1))
    print("\n".join(lines))
    print(f"\nWrote detailed report to {args.out}")


if __name__ == "__main__":
    main()
