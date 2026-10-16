#!/usr/bin/env python3
"""Recent API calls with model and price, as JSON on stdout.

Reads the tail of Hermes' agent.log, extracts one row per API call, and prices
each call. Two sources, in order:

  1. OpenRouter's ``/generation?id=`` endpoint — the exact ``total_cost`` the
     workspace logs page shows. Prices are immutable once a generation exists,
     so each id is fetched once and remembered in
     ``<hermes_home>/cache/openrouter-generation-costs.json``.
  2. A LOCAL ESTIMATE, used when that endpoint has no record of the generation.

Source 2 exists because OpenRouter's generation lookup started answering 404
for every id — including ids minted seconds earlier on the same key — which
left every row sitting on "pricing…". The estimate is tokens x the billed
provider's own published rate for that model
(``/models/<model>/endpoints``, matched by the ``upstream`` the agent log
already records). Rows priced this way carry ``"est": true``, and the pane
renders them with a ``~`` — they are an estimate and say so.

Usage:
    openrouter-calls.py [--limit N] [--session ID] [--fetch N] [--log PATH]
                        [--max-bytes N] [--price-ttl SECONDS]

Output:
    {"calls": [{"at","session","model","upstream","in","out","latency_s",
                "cache_pct","gen","cost","est"}],
     "priced", "estimated", "exact", "scanned", "matched", "sessions", "log",
     "error"}

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
PRICE_CACHE_PATH = os.path.join(HERMES, "cache", "openrouter-model-pricing.json")
FIT_PATH = os.path.join(HERMES, "cache", "openrouter-rate-fit.json")
TAIL_BYTES = 512 * 1024
DEFAULT_BASE = "https://openrouter.ai/api/v1"
PRICE_TTL = 24 * 60 * 60
RATE_KEYS = ("prompt", "completion", "input_cache_read")

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


def load_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_json(path: str, data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"

        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle)

        os.replace(tmp, path)
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


def get_json(url: str, api_key: str, timeout: int = 12) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )

    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}") or {}


def price_call(gen: str, api_key: str, base_url: str) -> dict:
    """total_cost + the exact model/provider OpenRouter billed, or {} on failure."""
    try:
        reply = get_json(f"{base_url}/generation?id={gen}", api_key)
        data = reply.get("data") or {}
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


# ── local estimate ──────────────────────────────────────────────────────────
# Each log row names the provider that served the call ("upstream=Morph"), and
# OpenRouter publishes every provider's rate for the model. With the token
# split the row already carries, the billed cost is
#   (prompt - cached) * prompt + cached * cache_read + completion * completion


def as_rate(value) -> float:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return 0.0

    return rate if rate > 0 else 0.0


def fetch_pricing(model: str, api_key: str, base_url: str) -> dict:
    """{'by_name': {provider: rates}, 'cheapest': rates} for one model, or {}."""
    try:
        payload = get_json(f"{base_url}/models/{model}/endpoints", api_key)
    except Exception:
        return {}

    raw_data = payload.get("data")
    data: dict = raw_data if isinstance(raw_data, dict) else {}
    raw_endpoints = data.get("endpoints")
    endpoints: list = raw_endpoints if isinstance(raw_endpoints, list) else []
    by_name: dict = {}
    candidates: list = []

    for endpoint in endpoints:
        rates = endpoint.get("pricing") or {}
        parsed = {key: as_rate(rates.get(key)) for key in RATE_KEYS}

        if not any(parsed.values()):
            continue

        candidates.append(parsed)
        name = str(endpoint.get("name") or "").strip().lower()

        # One provider name can carry several tags with different rates; a row
        # that only names the provider gets the cheapest of them (a floor).
        if name and (name not in by_name or parsed["prompt"] < by_name[name]["prompt"]):
            by_name[name] = parsed

    if not candidates:
        return {}

    return {
        "by_name": by_name,
        "cheapest": min(candidates, key=lambda rates: rates["prompt"] or float("inf")),
    }


def load_pricing(models: list, api_key: str, base_url: str, ttl: int) -> dict:
    """Cached per-model rate tables; refetched when stale or missing an entry."""
    cache = load_json(PRICE_CACHE_PATH)
    table = cache.get("models") if isinstance(cache.get("models"), dict) else {}
    fresh = (time.time() - float(cache.get("fetched") or 0)) < ttl
    fetched = False

    for model in dict.fromkeys(model for model in models if model):
        if fresh and isinstance(table.get(model), dict) and table[model]:
            continue

        if not api_key:
            break

        found = fetch_pricing(model, api_key, base_url)

        if found:
            table[model] = found
            fetched = True

    if fetched:
        save_json(PRICE_CACHE_PATH, {"fetched": time.time(), "models": table})

    return table


def rates_for(row: dict, table: dict, fitted: dict) -> dict:
    """Fitted billed rates for this model+provider, else the published table.

    The published per-endpoint table is a list price, not the invoice: fitted
    numbers come from generations we hold exact costs for (see
    openrouter-calibrate.py) and are preferred whenever they exist."""
    key = f"{row['model']}|{str(row.get('upstream') or '').strip()}"
    fit = fitted.get(key)
    fit = fit if isinstance(fit, dict) else {}

    if as_rate(fit.get("prompt")) or as_rate(fit.get("completion")):
        return fit

    raw_entry = table.get(row["model"])
    entry: dict = raw_entry if isinstance(raw_entry, dict) else {}
    upstream = str(row.get("upstream") or "").strip().lower()
    raw_names = entry.get("by_name")
    by_name: dict = raw_names if isinstance(raw_names, dict) else {}
    raw_rates = by_name.get(upstream) or entry.get("cheapest")
    return raw_rates if isinstance(raw_rates, dict) else {}


def estimate(row: dict, table: dict, fitted: dict) -> float:
    """Tokens x rates, or 0.0 when nothing is known for the model."""
    rates = rates_for(row, table, fitted)
    prompt = as_rate(rates.get("prompt"))
    completion = as_rate(rates.get("completion"))
    cached = as_rate(rates.get("input_cache_read"))

    if not (prompt or completion):
        return 0.0

    # A log line can carry a cache count above the prompt count; never let the
    # cached slice go negative, and pay the remainder at the prompt rate.
    tokens_in = int(row["in"])
    tokens_cached = max(0, min(int(row["cache_read"]), tokens_in))
    total = (tokens_in - tokens_cached) * prompt
    total += tokens_cached * (cached or prompt)
    total += int(row["out"]) * completion
    return total


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
    parser.add_argument("--price-ttl", type=int, default=PRICE_TTL,
                        help="seconds before a model's rate table is refetched")
    parser.add_argument("--max-bytes", type=int, default=3600,
                        help="cap the encoded payload (gateway keeps only stdout[-4000:]); 0 = no cap")
    args = parser.parse_args()

    env = read_env()
    api_key = env.get("OPENROUTER_API_KEY", "")
    base_url = (env.get("OPENROUTER_BASE_URL") or DEFAULT_BASE).rstrip("/")

    wanted = normalize_session(args.session)
    calls = []
    tokens = {}
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
        tokens[row["gen"]] = int(row["cache_read"]) if row["cache_read"] else 0
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

    exact_cache = load_json(CACHE_PATH)
    fetched = 0
    deadline = time.monotonic() + args.budget

    for call in calls:
        known = exact_cache.get(call["gen"])

        if isinstance(known, dict) and isinstance(known.get("cost"), (int, float)):
            call["cost"] = known["cost"]
            continue

        # Unpriced rows are retried on the next poll: never let a burst of new
        # ids make one run slow enough to look broken.
        if not api_key or fetched >= args.fetch or time.monotonic() > deadline:
            continue

        priced = price_call(call["gen"], api_key, base_url)
        fetched += 1

        if priced:
            exact_cache[call["gen"]] = priced
            call["cost"] = priced["cost"]
            call["upstream"] = priced.get("upstream") or call["upstream"]

    if fetched:
        save_json(CACHE_PATH, exact_cache)

    # Whatever /generation could not price gets the local estimate instead, so
    # no row is left saying "pricing…" for a rate OpenRouter has published.
    pending = [call for call in calls if not isinstance(call["cost"], (int, float))]
    table = load_pricing([call["model"] for call in pending], api_key, base_url, args.price_ttl)
    fitted = load_json(FIT_PATH).get("rates")
    fitted = fitted if isinstance(fitted, dict) else {}
    estimated = 0

    for call in pending:
        value = estimate({
            "model": call["model"], "upstream": call["upstream"], "in": call["in"],
            "out": call["out"], "cache_read": tokens.get(call["gen"], 0),
        }, table, fitted)

        if value > 0:
            call["cost"] = round(value, 6)
            call["est"] = True
            estimated += 1

    meta = {
        "priced": sum(1 for call in calls if isinstance(call["cost"], (int, float))),
        "estimated": estimated,
        "exact": sum(1 for call in calls
                     if isinstance(call["cost"], (int, float)) and not call.get("est")),
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
