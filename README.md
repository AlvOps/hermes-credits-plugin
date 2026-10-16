# Hermes Credits plugin

An OpenRouter credits readout for the Hermes desktop app: a statusbar chip with
the live balance and a dockable pane showing the API-key quota bar, the monthly
budget bar, and a live per-conversation call log with the billed price of every
API call.

```
plugin.js               →  $HERMES_HOME/desktop-plugins/credits/plugin.js   (desktop host)
openrouter-credits.py   →  $HERMES_HOME/bin/openrouter-credits.py           (backend host)
openrouter-calls.py     →  $HERMES_HOME/bin/openrouter-calls.py             (backend host)
openrouter-calibrate.py →  $HERMES_HOME/bin/openrouter-calibrate.py         (backend host)
```

## Install

1. Copy `plugin.js` to `$HERMES_HOME/desktop-plugins/credits/plugin.js` on the
   machine running the Hermes desktop app (`~/.hermes/desktop-plugins/credits/`
   by default). The app watches that directory and hot-reloads on save, so no
   app restart is needed. Fallback: ⌘K → **Reload desktop plugins**.
2. Copy the two `*.py` scripts to `$HERMES_HOME/bin/` on the **backend** host
   (the one `hermes serve` runs on — the same host whose `~/.hermes/.env` holds
   `OPENROUTER_API_KEY`). The plugin runs them over the gateway's shell door,
   so they execute there, not on the desktop machine.

No dependencies beyond the Python standard library. No credential ever crosses
into the renderer: the scripts read `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL`
from the backend's own `.env`, and `shell.exec` redacts its output.

## Data sources

The pane tries, in order:

1. **The backend reader** (`openrouter-credits.py`) via `shell.exec` — balance,
   the API-key quota, and the *monthly budget* the account is actually billed
   against (`key.effective_budget`).
2. **`session.usage` → `account_lines`** — the backend's own rendered usage
   lines. Kept as a fallback only: it never carries the monthly budget, so
   preferring it made the budget bar appear and vanish between polls.

The call log is never read from the gateway event stream — events carry tool
names, never the model that was billed or what a call cost. It comes from
`openrouter-calls.py`, which tails the agent log and prices each generation from
OpenRouter's `/generation` endpoint (the same `total_cost` the workspace logs
page shows). Prices are immutable, so each generation id is fetched once and
cached in `<hermes_home>/cache/openrouter-generation-costs.json`.

### When `/generation` stops answering

`/generation?id=` began returning `404 Generation … not found` for every id on
2026-10-16 — including ids minted seconds earlier on the same key — so every row
sat on "pricing…" and no cost ever appeared. The reader now prices in two steps:

1. **Exact** — the cached/`/generation` `total_cost`, unchanged.
2. **Estimated** — tokens × the rate of the provider that served the call.
   Rows priced this way carry `"est": true`, render as `~$0.0017`, and the feed
   total gains a `~`. An estimate must not be mistaken for an invoice.

The estimate is a three-unknown fit: billed cost is exactly linear in
`(prompt − cached) × prompt_rate + cached × cache_read_rate + completion × completion_rate`,
and each call names its provider (`upstream=Morph`) in the agent log.

`openrouter-calibrate.py` solves those rates against generations we hold exact
costs for and writes `<hermes_home>/cache/openrouter-rate-fit.json`. Use it —
the rates OpenRouter *publishes* per endpoint are not the rates it *bills*:
fitted Morph rates for `deepseek/deepseek-v4.1-flash` are 4.9e-8/9.0e-9/6.9e-7
while the endpoint list advertises 4.0e-8/9.0e-9/7.0e-7, which understated every
row by ~23%. With the fit, the corpus of 1439 billed generations reproduces to a
median error of 0.0000. Without a fit file the reader falls back to the
published table.

Prices drift, so refit when the numbers look stale:

```
python3 openrouter-calibrate.py --dry-run   # what would be fitted, writes nothing
python3 openrouter-calibrate.py             # write cache/openrouter-rate-fit.json
```

## Why the reader caps its own output

`shell.exec` returns only `stdout[-4000:]` (see `tui_gateway/methods_tools.py`).
A taller payload arrives headless and unparseable — the pane shows
"unreadable reader output" with a fragment starting mid-string. So the reader
caps itself: compact JSON, only the fields the pane reads, oldest rows dropped
until the body fits (`--max-bytes`, default 3600), with `dropped` reporting the
count it hid. `--max-bytes 0` disables the cap.

## Why the call log is per-conversation

`agent.log` records durable session ids (`20261013_130515_60c42a`), never a
runtime handle (`a93bb39d`). The plugin scopes the read to
`host.state.focusedStoredSessionId`, validates the shape
(`/^\d{8}_\d{6}_[0-9a-z]+$/i`), and **never** widens to other sessions on its
own — an empty result means this conversation is idle, not "show me everything".
The wider view is one click away in the feed header (`this chat` / `all chats`).

## Bars

Bars paint from a color resolved at render time
(`getComputedStyle(document.documentElement)`, skipping empty or `var(...)`
values) and inlined as a concrete style, because the `--ui-*` tokens differ per
app build and a `var()` fallback cannot rescue a token that resolves to a faint
`color-mix()`. A bar whose percentage is unknown is **not** drawn at all —
an empty line reads as "nothing spent", which is a different claim from "not
reported".

## Verifying it

```
python3 openrouter-credits.py | python3 -m json.tool | head -20
python3 openrouter-calls.py --limit 24 --max-bytes 3600 | wc -c   # must stay under 4000
python3 openrouter-calls.py --limit 5 --session <durable-session-id>
```

A healthy read prices every row: `priced` equals the row count and
`estimated + exact` adds up. `estimated` counts the rows priced from tokens, so
a run of `estimated: 0` means `/generation` is answering again, and
`priced < rows` means neither source had a rate for that model — the row shows
"pricing…", which is a data gap, not a bug.

Renderer `console.error` output — the plugin's own breadcrumbs included — lands
in `~/.hermes/logs/desktop.log` on the machine running the app:

```
grep -a '\[credits\]' ~/.hermes/logs/desktop.log
```

The pane logs one `diag` line per app run (resolved accent token, resolved
session ids, row count) and a `bars warn` line only when a bar renders empty.
Silence there means both bars are painting.
