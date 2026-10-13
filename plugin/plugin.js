/**
 * Credits — OpenRouter balance (and API-key quota) in the Hermes desktop app.
 *
 * TWO data sources, tried in order, because only one of them is reliable here:
 *
 *  1. The gateway RPC `session.usage` -> `account_lines` (what the backend's
 *     own /usage renders). Sanctioned, and no key comes near the renderer —
 *     but on a MULTIPLEXED backend (`hermes serve`) the OpenRouter fetch fails
 *     closed: `resolve_runtime_provider` raises UnscopedSecretError and
 *     `fetch_account_usage` swallows it into None, so `account_lines` arrives
 *     EMPTY. That is a backend bug, not a "provider has no limits" case.
 *  2. The gateway's `shell.exec` door running `~/.hermes/bin/openrouter-credits.py`
 *     on the BACKEND host — the script reads that host's .env itself and calls
 *     OpenRouter, printing `{credits, key}`. No session needed, and no
 *     credential ever crosses into the renderer (the app blocks reading .env
 *     from disk by design, and rightly so).
 *
 * The backend script is the only thing to install beside this plugin; drop the
 * folder and the plugin is gone.
 *
 * Surfaces: a statusbar chip (balance at a glance, click reveals the pane) and
 * a pane with the full breakdown. Styling is injected CSS on the app's theme
 * variables — disk plugins are not scanned by Tailwind.
 */

import {
  compactNumber, GlyphSpinner, host, PALETTE_AREA, STATUSBAR_AREAS,
  Tip, usePluginI18n, useQuery, useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'credits'
const PANE_ID = `${ID}:pane`
const CACHE_KEY = 'last-snapshot'
const POLL_MS = 120_000
/** Backend-side reader (this plugin's sibling script). `$HOME` is set for the
 *  gateway's shell children; the literal path is the fallback. */
const READER_CMD = 'python3 "${HOME:-/home/talos}/.hermes/bin/openrouter-credits.py"'

// ── live call log ───────────────────────────────────────────────────────────
// One row per API call: model, tokens, latency, cache and the billed price.
// Rows come from the backend reader, which prices each generation from
// OpenRouter's /generation endpoint — the same total_cost the workspace logs
// page shows. Newest first; the newest call or two may still be unpriced.

const FEED_LIMIT = 24
/** `shell.exec` hands back only `stdout[-4000:]`, so the reader caps its own
 *  payload; anything taller arrives as a headless, unparseable fragment. */
const FEED_BYTES = 3600
const CALLS_CMD = 'python3 "${HOME:-/home/talos}/.hermes/bin/openrouter-calls.py"'
/** Last good call list, so a blocked gateway shows recent rows (labelled)
 *  instead of an error where the data should be. */
const CALLS_CACHE_KEY = 'last-calls'
/** Bring the pane up on every app start (plugin load), instead of leaving it
 *  behind the palette. Set false to make it fully manual — statusbar chip and
 *  Ctrl+K still open it either way. */
const AUTO_REVEAL = true
/** How long a load keeps re-asserting the pane before it leaves the layout
 *  alone: long enough to outlast the tree restore, short enough that closing
 *  the pane mid-session sticks. */
const STARTUP_WINDOW_MS = 15_000

// Poll fast only while the newest call is waiting on OpenRouter to publish its
// cost, and only for so long: a generation that never prices must not keep the
// reader on a 5s leash forever.
const FAST_MS = 5_000
const SLOW_MS = 15_000
const FAST_MAX = 36
let unpriced = { gen: '', streak: 0 }

function noteUnpriced(payload) {
  const newest = (payload?.calls || [])[0]
  const gen = newest && !Number.isFinite(newest.cost) ? newest.gen : ''

  if (!gen) {
    unpriced = { gen: '', streak: 0 }
    return
  }

  unpriced = { gen, streak: unpriced.gen === gen ? unpriced.streak + 1 : 1 }
}

function refetchDelay() {
  return unpriced.streak > 0 && unpriced.streak <= FAST_MAX ? FAST_MS : SLOW_MS
}

function oneLine(value, max = 96) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`; long slugs elide. */
function shortModel(model) {
  const slug = String(model || '').split('/').pop().replace(/-\d{8}$/, '')
  return slug.length > 26 ? `${slug.slice(0, 25)}…` : slug || 'model'
}

/** "2026-10-13 13:33:38" → "13:33:38". */
function callTime(at) {
  return String(at || '').slice(11, 19)
}

function price(value) {
  if (!Number.isFinite(value)) return null
  return `$${value < 0.01 ? value.toFixed(5) : value.toFixed(4)}`
}

/** The dim second line: what the call consumed. */
function callStats(call) {
  const bits = [`in ${compactNumber(call.in)} · out ${compactNumber(call.out)}`]

  bits.push(`${call.latency_s.toFixed(1)}s`)

  if (call.cache_pct) bits.push(`cache ${call.cache_pct}%`)
  if (call.upstream) bits.push(call.upstream)

  return oneLine(bits.join(' · '), 78)
}

/** One reader run: the scoped call list, or a thrown reason. Failures are
 *  logged with the command, so the desktop's own log carries the diagnosis
 *  (renderer console output lands in ~/.hermes/logs/desktop.log). */
async function runCalls(scope) {
  const command = `${CALLS_CMD} --limit ${FEED_LIMIT} --max-bytes ${FEED_BYTES}${scope}`

  try {
    const result = await host.request('shell.exec', { command })
    const stdout = String(result?.stdout || '').trim()

    if (!stdout) {
      const detail = String(result?.stderr || '').trim().split('\n').slice(-2).join(' ')
      throw new Error(detail || 'call reader produced no output')
    }

    let payload

    try {
      payload = JSON.parse(stdout)
    } catch {
      throw new Error(`unreadable reader output: ${stdout.slice(0, 160)}`)
    }

    if (payload.error) {
      throw new Error(String(payload.error).slice(0, 200))
    }

    return payload
  } catch (error) {
    // console.error, not warn: only errors land in ~/.hermes/logs/desktop.log.
    console.error(`[credits] call log read failed :: ${command} :: ${error?.message || error}`)
    throw error
  }
}

/** Poll the backend reader for this conversation's calls. Strictly scoped: a
 *  session-scoped read that finds nothing reports nothing — silently widening
 *  to every session put two conversations' rows under one heading. The wider
 *  view is available, but only when the user asks for it. */
function useCalls(sessionId, wide) {
  const scoped = sessionId && !wide
  const scope = scoped ? ` --session ${sessionId}` : ''

  return useQuery({
    queryKey: [ID, 'calls', scoped ? sessionId : 'all'],
    queryFn: async () => {
      const payload = await runCalls(scope)
      const answer = {
        ...payload,
        asked: sessionId || '',
        scope: scoped ? 'session' : 'all',
        at: Date.now()
      }

      noteUnpriced(answer)
      rememberCalls(answer)
      return answer
    },
    staleTime: 2_000,
    refetchInterval: () => refetchDelay(),
    retry: 0
  })
}

const EN = {
  pane: 'Credits',
  chipTip: 'OpenRouter credits — click for the pane',
  balance: 'credits balance',
  quota: 'API key quota',
  usage: 'Usage',
  budget: 'Monthly budget',
  // Values arrive already formatted by money(); adding "$" here doubled it.
  quotaRemaining: (have, of) => `${have} of ${of} remaining`,
  resets: day => `resets ${day}`,
  usedPercent: used => `${used}% used`,
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  updated: when => `updated ${when}`,
  cached: when => `last known ${when}`,
  reader: 'reader',
  backend: 'backend',
  noSession: 'Waiting for the first reading — press Refresh.',
  activity: 'Live calls',
  live: 'live',
  clear: 'clear',
  pending: 'pricing…',
  feedEmpty: 'No API calls for this session in the log.',
  otherSessions: 'all chats',
  thisChat: 'this chat',
  olderHidden: count => `+${count} older`,
  noConversation: 'No conversation id yet — open or send in the chat you want read.',
  feedFailed: 'Could not read the call log.',
  notFresh: reason => `last known — gateway blocked${reason ? `: ${reason}` : ''}`,
  callsSummary: (count, total) => `${count} calls · ${total}`,
  failed: 'Could not read the balance.',
  reveal: 'Show credits pane'
}

const CSS = `
.hc-pane{display:flex;flex-direction:column;gap:10px;height:100%;padding:10px 12px;overflow:auto;font-size:12px;line-height:17px;color:var(--ui-text-secondary)}
.hc-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.hc-title{font-size:12px;color:var(--ui-text-primary)}
.hc-provider{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.hc-balance{font-size:26px;line-height:30px;font-weight:600;color:var(--ui-text-primary);font-variant-numeric:tabular-nums}
.hc-balance-label{font-size:11px;color:var(--ui-text-quaternary)}
.hc-block{display:flex;flex-direction:column;gap:4px}
.hc-bar{height:5px;border-radius:3px;background:var(--ui-stroke-secondary,var(--border,rgba(127,127,140,.30)));overflow:hidden}
.hc-bar-fill{height:100%;min-height:1px;background:var(--ui-accent,var(--accent,#6ea8fe))}
.hc-split{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px}
.hc-key{color:var(--ui-text-tertiary)}
.hc-note{font-size:11px;color:var(--ui-text-quaternary)}
.hc-raw{display:block;font-family:var(--font-mono,monospace);font-size:10px;line-height:14px;color:var(--ui-text-quaternary);white-space:pre-wrap;word-break:break-word}
.hc-list{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--ui-text-tertiary)}
.hc-foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:6px}
.hc-action{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;background:none;color:var(--ui-text-secondary);font-size:11px;cursor:pointer}
.hc-action:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.hc-action:disabled{opacity:.5;cursor:default}
.hc-chip{display:inline-flex;align-items:center;gap:5px;height:100%;padding:0 6px;border:0;background:none;color:var(--ui-text-tertiary);font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer}
.hc-feed-wrap{display:flex;flex-direction:column;gap:3px;min-height:0}
.hc-feed-head{display:flex;align-items:baseline;gap:6px;padding-top:7px;border-top:1px solid var(--ui-stroke-secondary)}
.hc-feed-title{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.hc-feed-live{font-size:10px;color:var(--ui-accent,var(--accent,#6ea8fe))}
.hc-feed-live::before{content:'●';display:inline-block;margin-right:4px;animation:hc-pulse 1.4s ease-in-out infinite}
@keyframes hc-pulse{0%,100%{opacity:1}50%{opacity:.25}}
.hc-feed-scope{margin-left:auto;padding:0;border:0;background:none;color:var(--ui-text-quaternary);font-size:10px;cursor:pointer}
.hc-feed-scope:hover{color:var(--ui-text-secondary)}
.hc-feed-clear{padding:0 0 0 6px;border:0;background:none;color:var(--ui-text-quaternary);font-size:10px;cursor:pointer}
.hc-feed-clear:hover{color:var(--ui-text-secondary)}
.hc-feed{display:flex;flex-direction:column;max-height:260px;overflow:auto;margin:0 -4px}
.hc-call{display:flex;flex-direction:column;gap:1px;padding:4px;border-left:2px solid transparent;border-radius:3px}
.hc-call:hover{background:var(--ui-row-hover-background)}
.hc-call[data-priced=yes]{border-left-color:var(--ui-accent,var(--accent,#6ea8fe))}
.hc-call-top{display:flex;align-items:baseline;gap:6px}
.hc-call-time{flex:none;font-family:var(--font-mono,monospace);font-size:10px;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary)}
.hc-call-model{flex:1;min-width:0;overflow:hidden;font-size:11px;color:var(--ui-text-primary);text-overflow:ellipsis;white-space:nowrap}
.hc-call-cost{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-accent,var(--accent,#6ea8fe));white-space:nowrap}
.hc-call[data-priced=no] .hc-call-cost{color:var(--ui-text-quaternary)}
.hc-call-stats{overflow:hidden;font-size:10px;color:var(--ui-text-quaternary);text-overflow:ellipsis;white-space:nowrap}
.hc-chip:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.hc-dot{width:6px;height:6px;border-radius:50%;background:var(--ui-accent,var(--accent,#6ea8fe));flex:none}
.hc-dot[data-state=stale]{background:var(--ui-text-quaternary)}
`

// ── colors ─────────────────────────────────────────────────────────────────
// The bar rendered as an invisible line on this app build: `--ui-accent` /
// `--ui-stroke-secondary` did not reach the pane, and a `var()` fallback only
// helps when the variable is UNDEFINED — an empty or self-referential token
// still wins. Resolve the first real value and inline it; fall back to a
// concrete color when no token yields one.

function resolvedToken() {
  try {
    const styles = getComputedStyle(document.documentElement)
    for (const name of arguments) {
      const value = String(styles.getPropertyValue(name) || '').trim()
      if (value && !/^var\(/.test(value)) return value
    }
  } catch {
    // No DOM (headless render): the caller falls back.
  }
  return ''
}

/** Priority order, not "documented order": `--ui-accent` first, then the
 *  app-wide accent, then a literal that is guaranteed visible. */
function accentColor() {
  return resolvedToken('--ui-accent', '--accent') || '#6ea8fe'
}

function trackColor() {
  return resolvedToken('--ui-stroke-secondary', '--border') || 'rgba(127,127,140,.30)'
}

/** One-shot breadcrumb: renderer console output is the only channel that
 *  reaches ~/.hermes/logs/desktop.log. */
const DIAG = { done: false, bars: false }

// ── source 1: parse the backend's rendered lines ───────────────────────────
// agent/account_usage.py::render_account_usage_lines produces human lines.
// Pull the numbers out and keep the raw lines, so a format change degrades to
// "show what the backend said" instead of an empty pane.

function parseAccountLines(lines) {
  const text = Array.isArray(lines) ? lines.filter(line => typeof line === 'string' && line.trim()) : []
  const find = re => {
    for (const line of text) {
      const match = line.match(re)
      if (match) return match
    }
    return null
  }
  if (!text.length) return null

  const balance = find(/Credits balance:\s*\$([0-9][0-9,]*\.?[0-9]*)/)
  const quota = find(/\$([0-9][0-9,.]*)\s+of\s+\$([0-9][0-9,.]*)\s+remaining/)
  // The backend renders "<n>% remaining (<100-n>% used) • …": read the USED
  // side, or the bar paints inverted.
  const remainingPercent = find(/([0-9]{1,3})%\s+remaining/)
  const usedPercent = find(/([0-9]{1,3})%\s+used/)
  const provider = find(/^Provider:\s*([a-z0-9._-]+)/i)
  const usage = text.find(line => /^API key usage:/i.test(line)) || ''
  const unavailable = text.find(line => /^Unavailable:/i.test(line)) || ''

  const number = value => {
    if (value === null || value === undefined) return null
    const parsed = Number(String(value).replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }

  return {
    source: 'backend',
    provider: provider ? provider[1].toLowerCase() : '',
    balance: number(balance && balance[1]),
    quotaRemaining: number(quota && quota[1]),
    quotaLimit: number(quota && quota[2]),
    quotaUsedPercent: usedPercent
      ? Number(usedPercent[1])
      : remainingPercent ? 100 - Number(remainingPercent[1]) : null,
    usage: usage.replace(/^API key usage:\s*/i, '').trim(),
    unavailable,
    lines: text.filter(line => !/^📈/.test(line) && !/^Provider:/i.test(line)),
    at: Date.now()
  }
}

// ── source 2: this machine's key, straight to OpenRouter ───────────────────

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Shape the reader's raw OpenRouter replies like the parsed backend lines. */
function snapshotFromApi(credits, key) {
  const total = num(credits.total_credits)
  const spent = num(credits.total_usage)
  const limit = num(key.limit)
  const limitRemaining = num(key.limit_remaining)
  // The workspace/free-tier guardrail, when the account has one: it applies
  // BEFORE the raw balance, so its remaining is the number that bites.
  const budget = key.effective_budget || {}
  const budgetLimit = num(budget.limit_usd)
  const budgetRemaining = num(budget.remaining_usd)
  const parts = []

  if (num(key.usage) !== null) parts.push(`$${num(key.usage).toFixed(2)} total`)
  for (const [field, label] of [['usage_daily', 'today'], ['usage_weekly', 'this week'], ['usage_monthly', 'this month']]) {
    if (num(key[field])) parts.push(`$${num(key[field]).toFixed(2)} ${label}`)
  }

  return {
    source: 'reader',
    provider: 'openrouter',
    balance: total !== null && spent !== null ? Math.max(0, total - spent) : null,
    quotaRemaining: limitRemaining,
    quotaLimit: limit && limit > 0 ? limit : null,
    quotaUsedPercent: limit && limit > 0 && limitRemaining !== null
      ? Math.min(100, Math.max(0, ((limit - limitRemaining) / limit) * 100))
      : null,
    budgetRemaining: budgetRemaining,
    budgetLimit: budgetLimit && budgetLimit > 0 ? budgetLimit : null,
    budgetUsedPercent: budgetLimit && budgetLimit > 0 && budgetRemaining !== null
      ? Math.min(100, Math.max(0, ((budgetLimit - budgetRemaining) / budgetLimit) * 100))
      : null,
    budgetReset: typeof budget.resets_at === 'string' ? budget.resets_at.slice(0, 10) : '',
    usage: parts.join(' • '),
    unavailable: '',
    lines: [],
    at: Date.now()
  }
}

/** Run the backend reader over the gateway's shell door. The renderer never
 *  sees a credential: the child reads the backend host's .env itself, and
 *  `shell.exec` redacts the output before it crosses the RPC boundary. */
async function readViaShell() {
  try {
    const result = await host.request('shell.exec', { command: READER_CMD })
    const stdout = String(result?.stdout || '').trim()

    if (!stdout) {
      const detail = String(result?.stderr || '').trim().split('\n').slice(-2).join(' ')
      throw new Error(detail || 'the backend reader produced no output')
    }

    let payload

    try {
      payload = JSON.parse(stdout)
    } catch {
      throw new Error(`unreadable reader output: ${stdout.slice(0, 160)}`)
    }

    if (payload.error) {
      throw new Error(String(payload.error).slice(0, 200))
    }

    return snapshotFromApi(payload.credits || {}, payload.key || {})
  } catch (error) {
    console.error(`[credits] balance read failed :: ${READER_CMD} :: ${error?.message || error}`)
    throw error
  }
}

// ── shared state ───────────────────────────────────────────────────────────

let store = null

function readCached() {
  try {
    const cached = store?.get(CACHE_KEY, null)
    return cached && typeof cached === 'object' && Number.isFinite(cached.at) ? cached : null
  } catch {
    return null
  }
}

function remember(snapshot) {
  try {
    store?.set(CACHE_KEY, snapshot)
  } catch {
    // Persistence is a nicety; a failed write must never break the readout.
  }
}

function readCachedCalls() {
  try {
    const cached = store?.get(CALLS_CACHE_KEY, null)
    return cached && Array.isArray(cached.calls) ? cached : null
  } catch {
    return null
  }
}

function rememberCalls(payload) {
  try {
    store?.set(CALLS_CACHE_KEY, payload)
  } catch {
    // Same as above: the readout must survive a storage refusal.
  }
}

function useCredits(sessionId) {
  return useQuery({
    queryKey: [ID, 'usage', sessionId],
    queryFn: async () => {
      const failures = []

      // Source 1, preferred: the reader, which is the only source that carries
      // the MONTHLY BUDGET as well as the key quota. The backend's rendered
      // lines below never include the budget, so preferring them made the
      // budget bar appear, vanish and repaint between polls.
      try {
        const shell = await readViaShell()
        remember(shell)
        return shell
      } catch (error) {
        failures.push(error?.message || String(error))
      }

      // Source 2: the backend's own rendered account lines, when there is a
      // session to read through. Labelled `backend` in the header.
      if (sessionId) {
        try {
          const result = await host.request('session.usage', { session_id: sessionId })
          const parsed = parseAccountLines(result?.account_lines)

          if (parsed) {
            remember(parsed)
            return parsed
          }

          failures.push('backend reported no account limits')
        } catch (error) {
          failures.push(`backend: ${error?.message || error}`)
        }
      }

      throw new Error(failures.join(' · '))
    },
    staleTime: 30_000,
    refetchInterval: POLL_MS,
    retry: 0
  })
}

/** Runtime id of the chat to read the balance through. Both atoms are always
 *  subscribed — a conditional `useValue` is a hooks-order violation. */
function useSessionId() {
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)

  return focused || active || null
}

/** Durable ids only: agent.log records `20261013_130515_60c42a`, never a
 *  runtime handle like `a93bb39d`, so scoping with a runtime id can only ever
 *  match nothing. `raw` is kept for the breadcrumb, not for the query. */
const DURABLE_ID = /^\d{8}_\d{6}_[0-9a-z]+$/i

function useStoredSessionId() {
  const focused = useValue(host.state.focusedStoredSessionId)
  const runtime = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const candidates = [focused, runtime, active].map(value => String(value || ''))

  return {
    id: candidates.find(value => DURABLE_ID.test(value)) || '',
    raw: candidates.find(Boolean) || ''
  }
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function money(value) {
  return `$${value.toFixed(2)}`
}

// ── the activity feed ──────────────────────────────────────────────────────

function CallsFeed({ sessionId, rawSessionId }) {
  const t = usePluginI18n(ID)
  const busy = useValue(host.state.busy)
  const [wide, setWide] = useState(false)
  const query = useCalls(sessionId, wide)
  const cached = readCachedCalls()
  const payload = query.data || cached || {}
  const calls = payload.calls || []
  const stale = !query.data && Boolean(cached)
  const priced = calls.filter(call => Number.isFinite(call.cost))
  const total = priced.reduce((sum, call) => sum + call.cost, 0)
  const allScope = payload.scope === 'all'

  // One breadcrumb per app run: which accent token this build actually exposes,
  // and which id the reader is being scoped to.
  if (!DIAG.done) {
    DIAG.done = true
    console.error(`[credits] diag :: accent=${resolvedToken('--ui-accent') || '(unset)'} accentApp=${resolvedToken('--accent') || '(unset)'} track=${resolvedToken('--ui-stroke-secondary') || '(unset)'} border=${resolvedToken('--border') || '(unset)'} stored=${sessionId || '(none)'} raw=${rawSessionId || '(none)'} wide=${wide} calls=${calls.length}`)
  }

  const head = jsxs('div', { className: 'hc-feed-head', children: [
    jsx('span', { className: 'hc-feed-title', children: t('activity') }),
    busy ? jsx('span', { className: 'hc-feed-live', children: t('live') }) : null,
    stale ? jsx('span', { className: 'hc-note', children: t('notFresh', query.error ? oneLine(String(query.error.message || ''), 60) : '') }) : null,
    calls.length
      ? jsx('span', { className: 'hc-note', children: t('callsSummary', calls.length, price(total)) })
      : null,
    payload.dropped ? jsx('span', { className: 'hc-note', children: t('olderHidden', payload.dropped) }) : null,
    jsx('button', {
      className: 'hc-feed-scope',
      type: 'button',
      onClick: () => setWide(value => !value),
      children: allScope ? t('otherSessions') : t('thisChat')
    }),
    jsx('button', {
      className: 'hc-feed-clear',
      type: 'button',
      disabled: query.isFetching,
      onClick: () => void query.refetch(),
      children: query.isFetching ? '…' : t('refresh')
    })
  ] })

  let list

  if (query.isError && !calls.length) {
    list = jsxs('div', { children: [
      jsx('span', { className: 'hc-note', children: t('feedFailed') }),
      jsx('code', { className: 'hc-raw', children: String(query.error?.message || '').slice(0, 240) })
    ] })
  } else if (!calls.length) {
    list = jsxs('div', { children: [
      jsx('span', {
        className: 'hc-note',
        children: query.isFetching
          ? t('refreshing')
          : (sessionId || allScope ? t('feedEmpty') : t('noConversation'))
      }),
      jsx('code', {
        className: 'hc-raw',
        children: `session=${payload.asked || rawSessionId || 'none'}\nscope=${payload.scope || '?'}\nlog=${payload.log || '?'}\ncalls in tail=${payload.scanned ?? '?'}`
      })
    ] })
  } else {
    list = jsx('div', { className: 'hc-feed', children: calls.map(call => jsxs('div', {
      'data-priced': Number.isFinite(call.cost) ? 'yes' : 'no',
      className: 'hc-call',
      children: [
        jsxs('div', { className: 'hc-call-top', children: [
          jsx('span', { className: 'hc-call-time', children: callTime(call.at) }),
          jsx('span', { className: 'hc-call-model', children: shortModel(call.model) }),
          jsx('span', {
            className: 'hc-call-cost',
            children: Number.isFinite(call.cost) ? price(call.cost) : t('pending')
          })
        ] }),
        jsx('span', { className: 'hc-call-stats', children: callStats(call) })
      ]
    }, `${call.gen}`)) })
  }

  return jsxs('div', { className: 'hc-feed-wrap', 'data-tour': 'credits-feed', children: [head, list] })
}

// ── the pane ───────────────────────────────────────────────────────────────

function CreditsPane() {
  const t = usePluginI18n(ID)
  const sessionId = useSessionId()
  const stored = useStoredSessionId()
  const query = useCredits(sessionId)
  const snapshot = query.data || readCached()
  const fresh = Boolean(query.data)

  useEffect(() => {
    // The pane can mount, unmount and remount while the layout settles; poll for
    // the bars instead of firing once on mount, or the probe gets cleared by a
    // cleanup before it ever measures anything.
    const started = Date.now()
    const timer = window.setInterval(() => {
      const nodes = Array.from(document.querySelectorAll('.hc-bar, .hc-bar-fill'))

      if (!nodes.length && Date.now() - started < 10_000) return
      window.clearInterval(timer)
      if (DIAG.bars) return
      DIAG.bars = true

      try {
        const detail = nodes.map(node => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return `${node.className}[w=${Math.round(rect.width)} h=${Math.round(rect.height)} bg=${String(style.background).slice(0, 44)} inline=${String(node.getAttribute('style') || '').slice(0, 72)}]`
        }).join(' | ')
        const empty = nodes.filter(node => node.className === 'hc-bar-fill' && Math.round(node.getBoundingClientRect().width) === 0)

        if (nodes.length && !empty.length) return

        console.error(`[credits] bars warn :: source=${snapshot?.source || 'none'} quotaLimit=${snapshot?.quotaLimit} quotaRemaining=${snapshot?.quotaRemaining} quotaUsed=${snapshot?.quotaUsedPercent} budgetLimit=${snapshot?.budgetLimit} budgetRemaining=${snapshot?.budgetRemaining} budgetUsed=${snapshot?.budgetUsedPercent} nodes=${nodes.length} ${detail}`)
      } catch (error) {
        console.error(`[credits] bars probe failed :: ${error?.message || error}`)
      }
    }, 500)

    return () => window.clearInterval(timer)
  }, [snapshot])

  const header = jsxs('div', { className: 'hc-head', children: [
    jsx('span', { className: 'hc-title', children: t('pane') }),
    snapshot?.provider ? jsx('span', { className: 'hc-provider', children: snapshot.provider }) : null,
    snapshot?.source ? jsx('span', { className: 'hc-provider', children: t(snapshot.source) }) : null
  ] })

  const footer = jsxs('div', { className: 'hc-foot', children: [
    jsx('button', {
      className: 'hc-action',
      type: 'button',
      disabled: query.isFetching,
      onClick: () => void query.refetch(),
      children: query.isFetching ? jsx(GlyphSpinner, { ariaLabel: t('refreshing') }) : t('refresh')
    }),
    jsx('span', {
      className: 'hc-note',
      children: snapshot ? t(fresh ? 'updated' : 'cached', ago(snapshot.at)) : ''
    })
  ] })

  let body

  if (!snapshot && query.isError) {
    body = jsxs('div', { className: 'hc-block', children: [
      jsx('span', { className: 'hc-note', children: t('failed') }),
      jsx('code', { className: 'hc-raw', children: String(query.error?.message || '').slice(0, 320) })
    ] })
  } else if (!snapshot) {
    body = jsx('span', { className: 'hc-note', children: query.isFetching ? t('refreshing') : t('noSession') })
  } else {
    const used = snapshot.quotaUsedPercent
    const quotaPercent = snapshot.quotaLimit
      ? (Number.isFinite(used)
        ? used
        : Number.isFinite(snapshot.quotaRemaining)
          ? (1 - snapshot.quotaRemaining / snapshot.quotaLimit) * 100
          : null)
      : null
    const children = [jsxs('div', { className: 'hc-block', children: [
      jsx('div', { className: 'hc-balance', children: Number.isFinite(snapshot.balance) ? money(snapshot.balance) : '—' }),
      jsx('div', { className: 'hc-balance-label', children: t('balance') })
    ] })]

    if (snapshot.quotaLimit && Number.isFinite(quotaPercent)) {
      const percent = quotaPercent

      children.push(jsxs('div', { className: 'hc-block', children: [
        jsx('div', { className: 'hc-split', children: [
          jsx('span', { className: 'hc-key', children: t('quota') }),
          jsx('span', { className: 'hc-note', children: t('usedPercent', Math.round(percent)) })
        ] }),
        jsx('div', { className: 'hc-bar', style: { background: trackColor() }, children: jsx('div', {
          className: 'hc-bar-fill',
          style: { width: `${Math.min(100, Math.max(0, percent))}%`, background: accentColor() }
        }) }),
        jsx('span', {
          className: 'hc-note',
          children: t('quotaRemaining', money(snapshot.quotaRemaining), money(snapshot.quotaLimit))
        })
      ] }))
    }

    if (snapshot.budgetLimit && Number.isFinite(snapshot.budgetUsedPercent)) {
      const percent = snapshot.budgetUsedPercent

      children.push(jsxs('div', { className: 'hc-block', children: [
        jsx('div', { className: 'hc-split', children: [
          jsx('span', { className: 'hc-key', children: t('budget') }),
          jsx('span', { className: 'hc-note', children: t('usedPercent', Math.round(percent)) })
        ] }),
        jsx('div', { className: 'hc-bar', style: { background: trackColor() }, children: jsx('div', {
          className: 'hc-bar-fill',
          style: { width: `${Math.min(100, Math.max(0, percent))}%`, background: accentColor() }
        }) }),
        jsx('span', {
          className: 'hc-note',
          children: [
            t('quotaRemaining', money(snapshot.budgetRemaining), money(snapshot.budgetLimit)),
            snapshot.budgetReset ? ` • ${t('resets', snapshot.budgetReset)}` : ''
          ].join('')
        })
      ] }))
    }

    if (snapshot.usage) {
      children.push(jsxs('div', { className: 'hc-block', children: [
        jsx('span', { className: 'hc-key', children: t('usage') }),
        jsx('span', { className: 'hc-note', children: snapshot.usage })
      ] }))
    }

    // Anything the backend explained or handed over that this pane does not
    // model — shown, not swallowed.
    if (snapshot.unavailable) {
      children.push(jsx('span', { className: 'hc-note', children: snapshot.unavailable }))
    }

    const rest = (snapshot.lines || []).filter(
      line => !/^API key usage:|^Unavailable:|^API key quota:|^Credits balance:/i.test(line)
    )

    if (rest.length) {
      children.push(jsx('div', { className: 'hc-list', children: rest.map((line, index) => jsx('span', { children: line }, index)) }))
    }

    if (!fresh) {
      children.push(jsx('span', { className: 'hc-note', children: t('cached', ago(snapshot.at)) }))
    }

    body = jsxs('div', { className: 'hc-block', children })
  }

  return jsxs('div', {
    className: 'hc-pane',
    'data-tour': 'credits-pane',
    children: [header, body, jsx(CallsFeed, { sessionId: stored.id, rawSessionId: stored.raw }), footer]
  })
}

// ── the statusbar chip ─────────────────────────────────────────────────────

function CreditsChip() {
  const t = usePluginI18n(ID)
  const sessionId = useSessionId()
  const query = useCredits(sessionId)
  const snapshot = query.data || readCached()

  const label = Number.isFinite(snapshot?.balance)
    ? money(snapshot.balance)
    : query.isFetching ? '…' : '—'

  return jsx(Tip, {
    label: t('chipTip'),
    children: jsx('button', {
      className: 'hc-chip',
      type: 'button',
      onClick: () => host.revealPane?.(PANE_ID),
      children: [
        jsx('span', { className: 'hc-dot', 'data-state': query.data ? 'live' : 'stale' }),
        jsx('span', { children: label })
      ]
    })
  })
}

// ── plugin ─────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Credits',
  description: 'OpenRouter credits balance and API-key quota: a statusbar chip plus a dockable pane.',
  register(ctx) {
    store = ctx.storage
    ctx.i18n.register({ en: EN })

    // The call log is read from the backend (agent.log + OpenRouter pricing),
    // not from the gateway event stream: events carry tool names, never the
    // model that was billed or what the call cost.
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'credits',
      data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, width: '292px' },
      render: () => jsx(CreditsPane, {})
    })

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(CreditsChip, {})
    })

    // Keep the pane on screen through the startup window: the layout tree is
    // restored after plugins load, so a single early reveal can be re-fronted
    // back to another tab of the zone. Poll until the pane reports visible
    // (then stop calling), and give up after STARTUP_WINDOW_MS so a later
    // manual close during the session sticks.
    if (AUTO_REVEAL) {
      const visibility = host.paneVisibility?.(PANE_ID)
      const stopAt = Date.now() + STARTUP_WINDOW_MS

      const ensureVisible = () => {
        if (Date.now() > stopAt) {
          window.clearInterval(timer)
          return
        }

        if (!visibility || !visibility.get()) {
          host.revealPane?.(PANE_ID)
        }
      }

      const timer = window.setInterval(ensureVisible, 1_000)

      ensureVisible()
      ctx.onDispose(() => window.clearInterval(timer))
    }

    ctx.register({
      id: 'reveal',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.reveal`,
        label: EN.reveal,
        keywords: ['credits', 'balance', 'openrouter', 'usage', 'quota', 'spend'],
        run: () => host.revealPane?.(PANE_ID)
      }
    })
  }
}
