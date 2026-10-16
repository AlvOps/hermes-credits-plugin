#!/usr/bin/env python3
"""Print OpenRouter credit balance as JSON on stdout.

Reads OPENROUTER_API_KEY (and optional OPENROUTER_BASE_URL) from the Hermes
.env beside this script's home, calls the credits + key endpoints, and prints
`{"credits": {...}, "key": {...}}`. No credential is ever echoed back — only
numbers and labels from the API reply.

Used by the desktop `credits` plugin over the gateway's shell door, because
`session.usage`'s own OpenRouter fetch fails closed on a multiplexed backend.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "https://openrouter.ai/api/v1"


def env_value(name: str, path: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        return ""
    return ""


# Two sequential calls run inside the gateway's 30s `shell.exec` window: two
# stalls at 15s each would sit exactly on that edge and time the read out.
# 8s per call keeps the worst case at 16s, so a slow OpenRouter degrades into
# a slow reading instead of a failed one.
TIMEOUT = 8


def get_json(url: str, api_key: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return (json.loads(response.read() or b"{}") or {}).get("data") or {}


def main() -> int:
    home = os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    env_path = os.path.join(home, ".env")
    api_key = env_value("OPENROUTER_API_KEY", env_path)

    if not api_key:
        print(json.dumps({"error": f"no OPENROUTER_API_KEY in {env_path}"}))
        return 0

    base = (env_value("OPENROUTER_BASE_URL", env_path) or DEFAULT_BASE).rstrip("/")

    try:
        credits = get_json(f"{base}/credits", api_key)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(json.dumps({"error": f"credits request failed: {exc}"}))
        return 0

    key: dict = {}
    try:
        key = get_json(f"{base}/key", api_key)
    except (urllib.error.URLError, OSError, ValueError):
        # The key endpoint is informational; the balance alone is still useful.
        pass

    print(json.dumps({"credits": credits, "key": key}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
