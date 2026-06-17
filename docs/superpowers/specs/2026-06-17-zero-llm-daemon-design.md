---
title: Zero-LLM Deterministic Daemon
date: 2026-06-17
status: approved
tags: [#architecture, #llm, #determinism, #experiments]
---

# Zero-LLM Deterministic Daemon

## Problem

The Meridian daemon makes automatic (non-human) LLM calls in three places:

| Site | Cadence | What the LLM does | Functional value |
|---|---|---|---|
| Screening cycle | every `screeningIntervalMin` (~30 min) | pick best candidate + write Telegram report | Low — decides on signals (`smart_wallets_present`, `narrative_quality`) that show no variance across 20+ recorded closes; the one real predictor (`fee_tvl_ratio`) is already a hard filter and in the JS score. |
| Management cycle | every `managementIntervalMin` (~10 min), only when action needed | dispatch a pre-decided CLOSE/CLAIM | ~None — `actionMap` is built 100% in JS ([index.js:280-305](../../../index.js)); the prompt explicitly says "Do NOT re-evaluate — just execute". |
| Health check | hourly | narrate portfolio summary | None — pure prose; management already reports. |

Plus a GENERAL conversational role serving the REPL free-form input and the Telegram bot.

Two costs:

1. **Nondeterminism confounds experiments.** The workflow is run dry-run → `/evaluate` → tune `user-config.json` → repeat. When two configs deploy into different pools, LLM choice variance makes it impossible to attribute PnL differences cleanly to the config change.
2. **Malformed tool-call JSON failure class.** Observed with `gemini_2.5_flash` in the management role — the model emits unrepairable tool-argument JSON and the close never fires.

The operator does not use Telegram. The daemon's job during an experiment is purely: screen → deploy → manage → close → record. The LLM adds nothing the deterministic rules don't already cover.

## Goal

Drive automatic LLM calls in the daemon to **zero**. Fully deterministic dry-run experiment runner. Reproducible: same config + same market data → same decisions.

Non-goal: deleting the LLM machinery. `agent.js` / `prompt.js` / per-role model config stay in place, dormant, so re-enabling is a single revert.

## Decisions (locked with operator)

- **Reports:** code-built (0 LLM). Output to console/log (Telegram plumbing stays but is inert when unconfigured).
- **Health check:** codify as a JS-built portfolio summary.
- **Screening pick:** deploy the top-scored survivor (`passing[0]`). No "good-enough" floor.
- **Instructions:** parse common patterns (`pnl_pct` / `value_usd` thresholds) in JS; **unparseable → HOLD + log warning** (no LLM fallback, since the daemon runs headless during experiments).
- **GENERAL chat:** removed. REPL keeps deterministic commands only; free-form input replies "not supported — use a command".

## Design

### New modules (pure, unit-testable)

**`instruction-parser.js`**
- `parseInstruction(text)` → `{ metric, op, value } | null`
  - `metric` ∈ `pnl_pct` | `value_usd`
  - `op` ∈ `>=` | `<=` (normalize `>`/`above`/`over` → `>=`; `<`/`below`/`under`/`drops below` → `<=`)
  - Matches unambiguous patterns only: e.g. `close if pnl > 10%`, `close below -5%`, `close if value under $40`. Anything else → `null`.
- `evaluateInstruction(parsed, position)` → `boolean`
  - Reads `position.pnl_pct` / `position.total_value_usd`; returns whether the close condition is met. Returns `false` if the needed field is missing.

**`reports.js`**
- `buildDeployReport({ candidate, deployResult, deployAmount, strategy })` → string. Reproduces the existing 🚀 DEPLOYED template ([index.js:634-680](../../../index.js)) from data: pool, address, deploy amount, strategy, active bin, `range_coverage` from the deploy result, MARKET block, AUDIT block. No "WHY THIS WON" prose.
- `buildHealthSummary({ positions, totals, performance })` → string. Portfolio value, open count, total unclaimed fees, per-position PnL/yield/range status, recent performance roll-up.

### index.js edits (5 sites)

1. **Screening cycle** ([index.js:616-695](../../../index.js)). Keep everything up to candidate-block building and signal staging. Replace the `agentLoop` block with:
   - `best = passing[0]` (already score-sorted by `getTopCandidates` at [screening.js:598](../../../tools/screening.js)).
   - `executeTool("deploy_position", { ... })` with the same args the existing `deployLatestCandidate` helper uses ([index.js:1342-1356](../../../index.js)).
   - On success → `buildDeployReport(...)` into `screenReport`; `appendDecision({ type: "deploy", ... })`.
   - On failure → `appendDecision({ type: "no_deploy", ... })`.
   - **Behavior change:** when ≥2 candidates survive filters, the top is always deployed (previously the LLM could veto all). The lone-candidate skip (`getLoneCandidateSkipReason`) still applies at exactly 1 survivor.

2. **Management cycle** ([index.js:340-377](../../../index.js)). `actionMap` already decides everything. Replace the `agentLoop` block with a JS loop over `actionPositions`:
   - `CLOSE` → `executeTool("close_position", { position })`
   - `CLAIM` → `executeTool("claim_fees", { position })`
   - `INSTRUCTION` → `parseInstruction(p.instruction)`; if parseable, `evaluateInstruction` → CLOSE or HOLD; if `null` → HOLD + `log("cron_warn", ...)`.
   - Append a code-built one-line result per position to the existing `mgmtReport`.

3. **Health-check cron** ([index.js:738-753](../../../index.js)). Replace the `agentLoop` with `buildHealthSummary(...)`; log it (and `sendMessage` only if Telegram is enabled).

4. **REPL free-form** ([index.js:1991-1997](../../../index.js)). Replace the GENERAL `agentLoop` with a console notice: free-form input is not supported; list available deterministic commands. Keep all command handlers.

5. **Telegram handler** ([index.js:1644-1668](../../../index.js)). Remove the `agentLoop` path (both SCREENER and GENERAL branches). Deterministic command routing earlier in the handler is unchanged. (Inert in practice since Telegram is unconfigured, but removed for clarity and to eliminate the last `agentLoop` reference.)

### Dormant after change

`agent.js`, `prompt.js`, and `config.llm.*Model` become unreferenced by the daemon runtime. Left in the tree intentionally.

## Data flow (post-change)

```
cron screening → getTopCandidates → hard filters + recon + PVP + lone-skip
              → passing[0] → executeTool(deploy_position) → buildDeployReport → log + appendDecision + recorder

cron management → getMyPositions → updatePnlAndCheckExits + getDeterministicCloseRule → actionMap
              → JS dispatch (close/claim/instruction) → executeTool(...) → mgmtReport(code) → log + recorder

cron health → buildHealthSummary → log

REPL → deterministic command handlers only
```

## Error handling

- Deploy/close/claim go through `executeTool`, which keeps its existing `runSafetyChecks` and post-tool side-effects (recorder, auto-swap, cooldown annotation). No change there.
- A failed `executeTool` in the management loop logs the error and continues to the next position (one bad close does not abort the cycle).
- Unparseable instruction → HOLD + warning; never silently closes.
- Instruction parser is conservative: ambiguous text → `null` → HOLD, never a wrong auto-close.

## Testing

- `test/instruction-parser.test.js` — parse matrix (each pattern, each operator synonym), null/ambiguous cases, evaluate against fixture positions (condition met / not met / missing field).
- `test/reports.test.js` — `buildDeployReport` and `buildHealthSummary` render expected fields from fixture data; no crash on missing optional fields.
- Wire both into the existing `npm run test:unit` script.

## Net result

| Path | Before | After |
|---|---|---|
| Screening | 1 LLM/cycle (~48/day) | 0 |
| Management | 1 LLM when action needed | 0 |
| Health check | 1 LLM/hour (24/day) | 0 |
| REPL / Telegram chat | per message | 0 (removed) |

Daemon makes **0 LLM calls**. Malformed-tool-JSON failure class eliminated from the automatic loops. Config experiments become reproducible.

## Related

- [[experiment-recorder]] — unaffected; hooks into deploy/close in the executor, not the LLM.
- `/evaluate` skill — the parameter-tuning surface this design serves.
