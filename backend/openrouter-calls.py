#!/usr/bin/env python3
"""Recent API calls with model and price, as JSON on stdout.

Reads the tail of Hermes' agent.log, extracts one row per API call, and prices
each call from OpenRouter's /generation endpoint (the same total_cost the
workspace logs page shows). Prices are immutable once a generation exists, so
each id is fetched exactly once and remembered in a local cache.

Usage:
    openrouter-calls.py [--limit N] [--session ID] [--fetch N] [--log PATH]
                        [--max-bytes N]

Output:
    {"calls": [{"at","session","model","upstream","in","out","latency_s",
                "cache_pct","gen","cost"}],
     "priced", "scanned", "matched", "sessions", "log", "error"}

--max-bytes (default 3600) keeps the JSON under the gateway's 4000-char stdout
tail: the ``shell.exec`` door returns only ``stdout[-4000:]``, so a taller
payload arrives headless and unparseable. Rows are emitted newest-first and
dropped from the oldest end until the encoded body fits; pass 0 for no cap.

Never prints the API key. Never fails loudly: an error becomes {"error": ...}.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request

HOME = os.path.expanduser("~")
HERMES = os.path.join(HOME, ".hermes")
CACHE_PATH = os.path.join(HERMES, "cache", "openrouter-generation-costs.json")
TAIL_BYTES = 512 * 1024

CALL_RE = re.compile(
    r"^(?P<ts>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+\s+\w+\s+\[(?P<session>[^\]]*)\].*?"
    r"API call #(?P<n>\d+): model=(?P<model>\S+) provider=(?P<provider>\S+) "
    r"in=(?P<in>\d+) out=(?P<out>\d+) total=(?P<total>\d+) latency=(?P<latency>[\d.]+)s"
    r"(?: cache=(?P<cache_read>\d+)/(?P<cache_total>\d+) \((?P<cache_pct>\d+)%\))?"
    r" id=(?P<gen>gen-\S+)"
    r"(?: upstream=(?P<upstream>\S+))?"
)


def read_env() -> dict:
    """OPENROUTER_API_KEY / OPENROUTER_BASE_URL from this host's Hermes .env."""
    values = {}

    try:
        with open(os.path.join(HERMES, ".env"), "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if "=" not in line or line.lstrip().startswith("#"):
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if key in ("OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"):
                    values[key] = value.strip().strip("\"'")
    except OSError as error:
        values["error"] = f"cannot read .env: {error}"

    return values


def load_cache() -> dict:
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict) -> None:
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        tmp = f"{CACHE_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(cache, handle)
        os.replace(tmp, CACHE_PATH)
    except OSError:
        pass


def tail_lines(path: str, limit_bytes: int = TAIL_BYTES) -> list:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > limit_bytes:
                handle.seek(size - limit_bytes)
                handle.readline()  # drop the partial first line
            return handle.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return []


def price_call(gen: str, api_key: str, base_url: str) -> dict:
    """total_cost + the exact model/provider OpenRouter billed, or {} on failure."""
    request = urllib.request.Request(
        f"{base_url}/generation?id={gen}",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = (json.loads(response.read()) or {}).get("data") or {}
    except Exception:
        return {}

    cost = data.get("total_cost")

    if not isinstance(cost, (int, float)):
        return {}

    return {
        "cost": round(float(cost), 6),
        "model": data.get("model") or "",
        "upstream": data.get("provider_name") or "",
    }


def normalize_session(value: str) -> str:
    """Clients hand over runtime ids that may carry a profile/connection prefix
    (`default:20261013_130515_60c42a`, `conn:abc:...`) or quotes; the log only
    ever carries the bare backend session id."""
    text = str(value or "").strip().strip("\"'")
    return text.rsplit(":", 1)[-1].strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--session", default="")
    parser.add_argument("--fetch", type=int, default=4, help="max /generation calls per run")
    parser.add_argument("--budget", type=float, default=6.0, help="seconds to spend pricing per run")
    parser.add_argument("--log", default=os.path.join(HERMES, "logs", "agent.log"))
    parser.add_argument("--max-bytes", type=int, default=3600,
                        help="cap the encoded payload (gateway keeps only stdout[-4000:]); 0 = no cap")
    args = parser.parse_args()

    env = read_env()
    api_key = env.get("OPENROUTER_API_KEY", "")
    base_url = (env.get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")

    wanted = normalize_session(args.session)
    calls = []
    seen = set()
    lines = tail_lines(args.log)
    scanned = 0
    matched = 0

    for line in reversed(lines):
        match = CALL_RE.match(line)

        if not match:
            continue

        scanned += 1
        row = match.groupdict()

        if wanted and row["session"] != wanted and not wanted.endswith(row["session"]):
            continue

        matched += 1

        if row["gen"] in seen:
            continue

        seen.add(row["gen"])
        calls.append({
            "at": row["ts"],
            "session": row["session"],
            "model": row["model"],
            "upstream": row.get("upstream") or "",
            "in": int(row["in"]),
            "out": int(row["out"]),
            "latency_s": float(row["latency"]),
            "cache_pct": int(row["cache_pct"]) if row["cache_pct"] else 0,
            "gen": row["gen"],
            "cost": None,
        })

        if len(calls) >= args.limit:
            break

    cache = load_cache()
    fetched = 0
    deadline = time.monotonic() + args.budget

    for call in calls:
        known = cache.get(call["gen"])

        if isinstance(known, dict) and isinstance(known.get("cost"), (int, float)):
            call["cost"] = known["cost"]
            continue

        # Unpriced rows stay "pricing…" and are retried by the next poll: never
        # let a burst of new ids make one run slow enough to look broken.
        if not api_key or fetched >= args.fetch or time.monotonic() > deadline:
            continue

        priced = price_call(call["gen"], api_key, base_url)
        fetched += 1

        if priced:
            cache[call["gen"]] = priced
            call["cost"] = priced["cost"]
            call["upstream"] = priced.get("upstream") or call["upstream"]
        else:
            call["cost"] = None

    if fetched:
        save_cache(cache)

    meta = {
        "priced": sum(1 for call in calls if isinstance(call["cost"], (int, float))),
        "scanned": scanned,
        "matched": matched,
        "sessions": sorted({match.group("session") for match in (CALL_RE.match(line) for line in lines) if match})[:8],
        "log": args.log,
        "error": env.get("error") if env.get("error") else ("" if api_key else "no OPENROUTER_API_KEY on the backend"),
    }

    # Newest-first, then shed the oldest rows until the encoded body fits the
    # gateway's stdout tail. Always keep at least one row: a short answer beats
    # a truncated one, and ``dropped`` says how many are missing.
    kept = list(calls)
    dropped = 0

    while True:
        payload = {"calls": kept, "dropped": dropped, **meta}
        body = json.dumps(payload, separators=(",", ":"))

        if not args.max_bytes or len(body) <= args.max_bytes or len(kept) <= 1:
            break

        # Shed the tail in chunks: a 1-row trim per pass re-encodes the whole
        # payload for every dropped row, which is fine at these sizes but silly.
        shed = max(1, (len(body) - args.max_bytes) // 220)
        dropped += shed
        kept = kept[:-shed] if len(kept) > shed else kept[:1]

    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
