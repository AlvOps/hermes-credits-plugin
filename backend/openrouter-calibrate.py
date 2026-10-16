#!/usr/bin/env python3
"""Fit the rates OpenRouter actually BILLED, from our own priced history.

`openrouter-calls.py` falls back to a local estimate when /generation has no
record of a call. The rate table OpenRouter publishes per endpoint
(`/models/<model>/endpoints`) is not the billed rate: for Morph-served
deepseek-v4.1-flash calls the list says 4.0e-8/token prompt while the invoices
came out at 4.9e-8. Using the published table understated every row by ~29%.

So the estimate prefers rates fitted from generations we have exact costs for:
the cost of a call is exactly linear in

    (prompt - cached) * prompt_rate
  + cached            * cache_read_rate
  + completion        * completion_rate

which is a 3-unknown least squares over the joined corpus of
`cache/openrouter-generation-costs.json` (exact costs) and `logs/agent.log`
(the token split of each generation). Fits are written to
`cache/openrouter-rate-fit.json` and used per (model, provider); a fit that
does not reproduce the corpus (p90 relative error > --tolerance) is discarded
rather than trusted, and the reader falls back to the published table.

Usage:
    openrouter-calibrate.py [--min-samples 20] [--tolerance 0.05] [--dry-run]

Exit is 0 whether or not anything was fitted: a thin corpus is normal, not a
failure.
"""

import argparse
import json
import os
import sys
import time

import importlib.util  # noqa: E402

_SIBLING = os.path.join(os.path.dirname(os.path.abspath(__file__)), "openrouter-calls.py")
_SPEC = importlib.util.spec_from_file_location("openrouter_calls", _SIBLING)
assert _SPEC and _SPEC.loader, f"cannot load the reader script at {_SIBLING}"
calls = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(calls)

FIT_PATH = os.path.join(calls.HERMES, "cache", "openrouter-rate-fit.json")
LOGS = ("agent.log", "agent.log.1", "agent.log.2")


def corpus() -> dict:
    """{(model, upstream): [(uncached, cached, completion, exact_cost)]}"""
    exact = calls.load_json(calls.CACHE_PATH)
    grouped = {}

    for name in LOGS:
        path = os.path.join(calls.HERMES, "logs", name)

        for line in calls.tail_lines(path, limit_bytes=8 * 1024 * 1024):
            match = calls.CALL_RE.match(line)

            if not match:
                continue

            row = match.groupdict()
            known = exact.get(row["gen"])

            if not isinstance(known, dict) or not isinstance(known.get("cost"), (int, float)):
                continue

            if known["cost"] <= 0:
                continue

            tokens_cached = int(row["cache_read"]) if row["cache_read"] else 0
            tokens_cached = max(0, min(tokens_cached, int(row["in"])))
            grouped.setdefault((row["model"], (row.get("upstream") or "").strip()), []).append((
                int(row["in"]) - tokens_cached,
                tokens_cached,
                int(row["out"]),
                float(known["cost"]),
            ))

    return grouped


def solve(matrix: list, vector: list) -> list:
    """Gaussian elimination with partial pivoting on a 3x3 system."""
    work = [row[:] + [value] for row, value in zip(matrix, vector)]
    size = len(vector)

    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(work[row][column]))
        work[column], work[pivot] = work[pivot], work[column]

        if not work[column][column]:
            return []

        for row in range(size):
            if row == column:
                continue

            factor = work[row][column] / work[column][column]

            for index in range(column, size + 1):
                work[row][index] -= factor * work[column][index]

    return [work[index][size] / work[index][index] for index in range(size)]


def fit(samples: list) -> dict:
    """Least squares over [uncached, cached, completion] -> billed cost."""
    normal = [[0.0] * 3 for _ in range(3)]
    moment = [0.0] * 3

    for row in samples:
        for i in range(3):
            moment[i] += row[i] * row[3]

            for j in range(3):
                normal[i][j] += row[i] * row[j]

    rates = solve(normal, moment)

    if not rates or any(rate < 0 for rate in rates):
        return {}

    errors = sorted(
        (sum(rates[i] * row[i] for i in range(3)) - row[3]) / row[3] for row in samples
    )
    p90 = abs(errors[int(0.9 * (len(errors) - 1))])
    return {
        "prompt": rates[0],
        "input_cache_read": rates[1],
        "completion": rates[2],
        "samples": len(samples),
        "p90_error": round(p90, 4),
        "median_error": round(abs(errors[len(errors) // 2]), 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-samples", type=int, default=20)
    parser.add_argument("--tolerance", type=float, default=0.05,
                        help="discard a fit whose p90 relative error exceeds this")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    grouped = corpus()
    fitted = {}
    kept = []
    rejected = []

    for (model, upstream), samples in grouped.items():
        if len(samples) < args.min_samples:
            continue

        result = fit(samples)

        if not result:
            rejected.append((model, upstream, len(samples), "no solution"))
            continue

        if result["p90_error"] > args.tolerance:
            rejected.append((model, upstream, len(samples), f"p90 {result['p90_error']:.3f}"))
            continue

        fitted[f"{model}|{upstream}"] = result
        kept.append((model, upstream, result))

    for model, upstream, result in sorted(kept, key=lambda row: -row[2]["samples"]):
        print(f"fitted {model} via {upstream or '(unknown)'}: n={result['samples']} "
              f"prompt={result['prompt']:.3e} cache_read={result['input_cache_read']:.3e} "
              f"completion={result['completion']:.3e} median_err={result['median_error']:.4f}")

    for model, upstream, count, why in rejected:
        print(f"rejected {model} via {upstream or '(unknown)'}: n={count} ({why})")

    if args.dry_run:
        print("dry run — nothing written")
        return 0

    if not fitted:
        print("nothing fitted (thin corpus) — the reader keeps using the published table")
        return 0

    calls.save_json(FIT_PATH, {"fitted": time.time(), "rates": fitted})
    print(f"wrote {FIT_PATH} with {len(fitted)} fitted rate set(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
