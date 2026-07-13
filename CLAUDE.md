# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Audience**: future agents/sessions that need to make non-trivial changes
> (add a tool, change a safety rule, fix a cron race, extend a state file)
> without re-reading the whole repo. The README stays user-facing; this
> file is the engineering manual.

---

## TL;DR (read this first)

- **What it is**: Node 22+ ESM service that runs a **fully deterministic,
  zero-LLM daemon** to screen Meteora DLMM pools, deploy SOL into positions,
  monitor them, and close/rebalance them — all without a human or an LLM in
  the loop. Telegram + Discord provide ops surface; HiveMind provides shared
  learning (lesson push/pull only, not decision-making).
- **Entry points**: `node index.js` (full daemon — REPL + cron + Telegram),
  `node cli.js <cmd>` (one-shot CLI), `node setup.js` (first-run wizard).
- **Two cycles run automatically, both pure JS decision logic**:
  - **Screening** — every `screeningIntervalMin` minutes, scores candidates
    deterministically and deploys into the top-scored survivor.
  - **Management** — every `managementIntervalMin` minutes, evaluates open
    positions against `getDeterministicCloseRule` (stop loss / take profit /
    rebalance / pumped-far-above-range / OOR / low yield) and dispatches
    CLOSE / CLAIM / REBALANCE / INSTRUCTION actions directly.
- **There is no LLM anywhere in the automatic loops.** `agent.js` and
  `prompt.js` (the old ReAct loop) were removed; `tools/definitions.js`
  (OpenAI-format tool schemas) still exists on disk but is **unimported —
  dead weight**, kept only in case an LLM path is reintroduced. Telegram
  free-form chat is explicitly disabled with a static reply, not routed to
  anything.
- **All state lives in JSON files at the repo root** — see
  [§ Persistent files](#persistent-files) below. There is no DB.
- **"Always first read the rest of this file"** — there are real
  cross-cutting invariants (lazy SDK load, position-cache TTL, trailing-TP
  15s recheck, the REBALANCE/CLOSE rule ordering) that are easy to break.

---

## Architecture

Everything in the automatic loops is deterministic JS. There is no LLM call
anywhere in `runScreeningCycle`, `runManagementCycle`, the health check, or
the PnL poller — decisions come from scoring functions and rule functions,
and the result is dispatched straight to `executeTool`.

```
                ┌──────────────────────────────────────────────┐
                │              index.js  (daemon)              │
                │  REPL + cron + Telegram bot + PnL poller    │
                │  Health check + briefing + HiveMind HB      │
                └────────────┬─────────────────────────────────┘
                             │
            ┌────────────────┼────────────────────┐
            ▼                ▼                    ▼
       runScreeningCycle  runManagementCycle  cron (every N min)
            │                │
            │ getTopCandidates()   getDeterministicCloseRule(p, mgmtConfig)
            │ (deterministic score)   → { action: CLOSE|CLAIM|REBALANCE|INSTRUCTION }
            └────────┬───────┘
                     ▼
              executeTool(name, args)
                     │
                     ▼
              PROTECTED_TOOLS →
              runSafetyChecks()
                     │
                     ▼
              toolMap[name](args)
                     │
        ┌────────────┴──────────┐
        ▼                        ▼
tools/dlmm.js (SDK)     tools/wallet.js (Jupiter)
tools/screening.js      tools/token.js (Jupiter)
tools/study.js (LPAgent) tools/agent-meridian.js
                        tools/chart-indicators.js
        │                        │
        └──── on-chain + 3rd-party APIs ─┘
```

Telegram commands (`/close`, `/deploy`, `/settings`, etc.) also call
`executeTool` directly — same dispatch path, no separate code path for
"manual" vs "automatic" actions. Free-form chat text that isn't a
recognized `/command` gets a static "Free-form chat is disabled" reply
(`index.js` telegram handler fallback) and is dropped — it never reaches
any decision logic.

### Module responsibilities (read me before editing)

| File | Lines | Purpose |
|---|---:|---|
| **Entry / orchestration** | | |
| `index.js` | ~2000+ | Daemon. Cron, REPL, Telegram bot, briefing, HiveMind bootstrap, PnL poller, `getDeterministicCloseRule` (the decision function for the whole management cycle), single-candidate skip rule, settings menu. **All** automatic cycles start and end here — no handoff to an LLM anywhere. |
| `cli.js` | ~700+ | One-shot CLI; every tool exposed as a subcommand (including `rebalance-position`). Also writes a `~/.meridian/SKILL.md` at startup for agent discovery. Loads `.env`/`user-config.json` from `~/.meridian/` if present, else from cwd. |
| `setup.js` | ~750 | Interactive first-run wizard. Three presets (degen/moderate/safe) + custom. Covers strategy, screening filters, position sizing, trailing TP. |
| **Config & state** | | |
| `config.js` | ~330 | Loads `user-config.json` → live `config` object. Sections: `risk`, `screening`, `management`, `strategy`, `schedule`, `signalStaging`, `tokens`, `hiveMind`, `api`, `jupiter`, `indicators`. No `llm`/`darwin` sections — removed along with the LLM loop. Exposes `computeDeployAmount(walletSol)`, `reloadScreeningThresholds()`. `MIN_SAFE_BINS_BELOW = 35` (exported). |
| **Tools layer** | | |
| `tools/definitions.js` | ~1150 | OpenAI-format tool schemas. **Currently unimported anywhere in the codebase — vestigial.** Kept for documentation parity with the ~45 real tool names and in case an LLM path is reintroduced; do not assume anything reading this file actually reaches the LLM, because nothing does. |
| `tools/executor.js` | ~850+ | `executeTool(name, args)`. Pre-flight safety checks for `PROTECTED_TOOLS = WRITE_TOOLS ∪ {self_update}`, where `WRITE_TOOLS = {deploy_position, claim_fees, close_position, swap_token, rebalance_position}`. Validates pool thresholds via fresh pool discovery call before deploy. Post-tool side-effects: telegram notifications, pool-memory auto-annotation on `low yield` close, auto-swap base→SOL on close. |
| `tools/dlmm.js` | huge | Meteora DLMM SDK wrapper. **Lazy-loads** `@meteora-ag/dlmm` to avoid CJS-import-time crash in DRY_RUN/test. Pool cache (5 min), metadata cache (15 min), positions cache (5 min TTL + inflight dedup). `deployPosition`, `getMyPositions`, `getPositionPnl`, `getActiveBin`, `closePosition`, `claimFees`, `searchPools`, `getWalletPositions`, `rebalancePosition` (in-place upside range-shift + partial harvest + fee compound, via the SDK's native `simulateRebalancePositionWithBalancedStrategy`/`rebalancePosition`), `computeRebalanceValueSplit` (pure value-split helper). Also has relay-mode (zap-in via LPAgent) and wide-range path (multi-tx `createExtendedEmptyPosition` + `addLiquidityByStrategyChunkable` for >69 bin ranges). Asserts Meteora bin-array initialization rent never charged. |
| `tools/screening.js` | 862 | `discoverPools`, `getTopCandidates` (hard filter + enrich + score), `getPoolDetail`. Scoring = `fee_tvl*1000 + organic*10 + vol/100 + holders/100`. Has Discord signal merge/only modes, PVP-rival detection. |
| `tools/wallet.js` | 251 | `getWalletBalances` (Helius), `swapToken` (Jupiter Swap V2). `normalizeMint` collapses "SOL"/"native"/any So1-prefixed token to wrapped-SOL. Built-in referral: 50 bps to a fixed address (configurable). |
| `tools/token.js` | 209 | `getTokenInfo` (Jupiter datapi), `getTokenHolders` (top 100 + filter pool-tagged), `getTokenNarrative` (Jupiter ChainInsight). Cross-references smart wallets from `smart-wallets.json`. |
| `tools/study.js` | 152 | `studyTopLPers` → Agent Meridian `/top-lp` + `/study-top-lp`. Returns ranked LPer patterns (avg hold, win rate, preferred strategy). |
| `tools/agent-meridian.js` | 110 | `agentMeridianJson(path, opts)` with retry/backoff. Default base = `https://api.agentmeridian.xyz/api`. |
| `tools/chart-indicators.js` | 299 | `confirmIndicatorPreset({mint, side})`. Eight presets: `supertrend_break`, `rsi_reversal`, `bollinger_reversion`, `rsi_plus_supertrend`, `supertrend_or_rsi`, `bb_plus_rsi`, `fibo_reclaim`, `fibo_reject`. Fetches from Agent Meridian `/chart-indicators/{mint}`. |
| **Persistence (all `.json` at repo root)** | | |
| `state.js` | ~550+ | `trackPosition`, `markOutOfRange/InRange`, `recordClaim`, `recordClose`, `recordRebalance` (bumps `rebalance_count`, replaces tracked bin range/`amount_sol` with the new leg, accumulates `harvested_sol`), `setPositionInstruction`, `updatePnlAndCheckExits` (the deterministic rules: STOP_LOSS, IN_RANGE_DRAWDOWN, TRAILING_TP, OUT_OF_RANGE, LOW_YIELD), `isSustainedDrawdownClose` / `isUpsideRebalanceEligible` (pure predicates), `getStateSummary`. `syncOpenPositions` reconciles local state with on-chain after 5 min grace. Tracked positions carry `original_amount_sol` (frozen at first deploy) and `harvested_sol` (cumulative, SOL-denominated) so PnL stays measured against true original capital across rebalances. |
| `pool-memory.js` | 405 | Per-pool deploy history + rolling 48-snapshot trend (5min × 4h). Computes `avg_pnl_pct`, `win_rate`, `adjusted_win_rate` (excludes OOR pumps). Cooldown logic: low yield → 4h pool cooldown, 3× OOR closes → 12h pool+token cooldown, optional repeat-deploy cooldown (configurable trigger count/hours/min fee yield/scope). `recordPositionSnapshot`, `recallForPool` for prompt injection. |
| `lessons.js` | 765 | `recordPerformance(perf)` called by executor after `close_position`. Builds lesson string (PREFER/AVOID/WORKED/FAILED). Pinned + role-tagged lesson injection (3-tier cap: PINNED, ROLE, RECENT) with `ROLE_TAGS` map. `evolveThresholds` adjusts `minOrganic` (auto), and writes `[AUTO-EVOLVED @ N]` lesson + applies to live `config`. **Known bug: also references `maxVolatility` and `minFeeTvlRatio` which don't exist in config — no-op for those keys.** `pushHiveLesson`/`pushHivePerformanceEvent` are fire-and-forget. |
| `decision-log.js` | 68 | Rolling 100-entry log. Types: `deploy` / `close` / `skip` / `no_deploy`. Each entry: actor, pool, summary, reason, risks[], metrics{}, rejected[]. Surfaced via `get_recent_decisions` tool and `getDecisionSummary()` in the prompt. |
| `signal-tracker.js` | 87 | In-memory 10-min staging for screening-time signals (`organic_score`, `fee_tvl_ratio`, …). Cleared on deploy or TTL. **Not persisted** — fine because the staged snapshot is also written to `state.json` via `trackPosition({ signal_snapshot })`. |
| `signal-weights.js` | 330 | Darwinian signal weighting. Recalculates every 5 closes (or 10-sample min). Splits signals into quartiles; top → `weight*1.05`, bottom → `weight*0.95`. Persists `signal-weights.json`. `getWeightsSummary()` injected into SCREENER prompt. |
| `strategy-library.js` | 227 | Saved LP strategies. Five defaults preloaded: `custom_ratio_spot`, `single_sided_reseed`, `fee_compounding`, `multi_layer`, `partial_harvest`. `getActiveStrategy()` → used in SCREENER prompt. |
| `smart-wallets.js` | 103 | Tracked KOL/alpha wallets. `type: "lp"` (default) checks positions; `type: "holder"` only checks token holdings. 5-min position cache. `check_smart_wallets_on_pool` is the deployment confidence signal. |
| `token-blacklist.js` | 103 | Mint → reason. Hard-filtered in `getTopCandidates` before scoring. |
| `dev-blocklist.js` | 66 | Deployer wallet → reason. Hard-filtered before scoring, fetched from Jupiter dev field. |
| `hivemind.js` | 346 | Agent Meridian shared learning. `bootstrapHiveMind` on startup, `startHiveMindBackgroundSync` every 15 min. Pushes lessons + performance events; pulls shared lessons + presets. `getSharedLessonsForPrompt` → injected under `── HIVEMIND ──` in prompt. Failures are non-blocking. |
| **Integrations** | | |
| `telegram.js` | 494 | `startPolling(onMessage)`, `stopPolling()`. Long-poll with 35s abort. `createLiveMessage` returns a handle with `toolStart/toolFinish/note/finalize/fail` for live progress. Sends deploy/close/swap/OOR notifications. Auth: `isAuthorizedIncomingMessage` (chatId match + group→allowed user IDs). Registers `/help` `/status` `/positions` `/close` `/closeall` `/set` `/settings` `/setcfg` `/screen` `/candidates` `/deploy` `/briefing` `/hive` `/pause` `/resume` `/stop` via `setMyCommands`. |
| `discord-listener/index.js` | 152 | Selfbot (uses `discord.js-selfbot-v13`). Listens to `DISCORD_CHANNEL_IDS` for `Metlex Pool Bot`, extracts Solana addresses, runs pre-check pipeline, appends to `discord-signals.json`. |
| `discord-listener/pre-checks.js` | 205 | Pipeline: dedup (10min) → blacklist → pool resolution (Meteora direct → DexScreener) → rugcheck.xyz (score>50000 OR top10>60% reject) → deployer blacklist → Jupiter global fees check (`minTokenFeesSol`). |
| `briefing.js` | 71 | HTML daily report. 24h activity, performance, lessons, current portfolio. Sent at 1:00 UTC. |
| `envcrypt.js` | 121 | XOR-cipher with a key from `.envrypt`/`ENVRYPT_KEY`. Encrypts anything matching `*_KEY`, `*SECRET*`, `*TOKEN*`, `*MNEMONIC*`, etc. The `# encrypted` marker in `.env` precedes encrypted lines. |
| `logger.js` | 75 | Daily-rotating `logs/agent-YYYY-MM-DD.log`. `logAction({tool, args, result, duration_ms, success})` writes JSONL `actions-YYYY-MM-DD.jsonl` audit trail. Level via `LOG_LEVEL` env. |
| **Other** | | |
| `discord-listener/`, `test/`, `scripts/`, `utils/` | | Discord listener (above), syntax-checked tests, envcrypt CLI, `safeNumber`. |
| `.claude/agents/{screener,manager}.md` | | Claude Code sub-agent configs — used when you run `claude` inside the repo. |
| `.claude/commands/*.md` | | Slash commands (`/screen`, `/manage`, `/balance`, `/candidates`, `/pool-ohlcv`, etc.) that wrap `cli.js`. |
| `.claude/settings.json` | | Denies `rm -rf`, `wget`, `Read(./.env*)`. **Forbids `run_in_background: true` via a PreToolUse hook.** |

---

## Tool dispatch (no roles — everything goes through one path)

There are no LLM "roles" anymore. Every tool call — whether triggered by the
deterministic screening/management cycles, a Telegram command, or the CLI —
goes through the same function: `executeTool(name, args)` in
`tools/executor.js`. There is no role-based tool filtering (`MANAGER_TOOLS`/
`SCREENER_TOOLS`/`INTENT_TOOLS` do not exist) because there is no LLM
choosing which tool to call — the calling code (a cron cycle, a Telegram
handler, a CLI subcommand) already knows exactly which tool it wants and
calls it directly with concrete args.

### Adding a new tool

1. **`tools/executor.js`** — add `tool_name: functionImpl` to the `toolMap`. If it modifies on-chain state, also add it to `WRITE_TOOLS` (which `PROTECTED_TOOLS` spreads from) and add a `case` in `runSafetyChecks()`.
2. Wire the actual call site — wherever the deterministic logic should invoke it (a branch in `index.js`'s management-cycle dispatch loop, a new CLI subcommand in `cli.js`, a Telegram command handler).
3. **`tools/definitions.js`** — optionally add the OpenAI-format schema for documentation parity with the other tool entries. This file has no functional consumer today, so skipping this step doesn't break anything — but keep it in sync if you touch it, since a future LLM path (if reintroduced) would read from here.
4. If you want it in the Telegram `/settings` button menu, add it to `settingValue()` in `index.js` + the relevant `renderSettingsMenu` page.

---

## The deterministic dispatch loop (`index.js`)

There is no retry/repair/tool-choice machinery to document — the old
ReAct loop (`agent.js`, JSON repair, provider fallback, once-per-session
tool locks, no-tool-loop guards) was removed entirely along with the LLM.
What replaces it, in the management cycle:

- `getMyPositions({ force: true })` builds a fresh snapshot every cycle.
- `getDeterministicCloseRule(position, managementConfig)` is a pure function
  that inspects one position and returns either `null` (no action) or an
  action object: `{ action: "CLOSE", rule: N, reason }`, `{ action: "REBALANCE", newBinsBelow, newBinsAbove, harvestBps }`, or a `CLAIM`/`INSTRUCTION` variant assembled by the calling loop.
- The management cycle builds an `actionMap` (one entry per position) purely
  from this function plus a `CLAIM` check (`unclaimed_fees_usd >=
  minClaimAmount`) and an `instruction`-set check — then dispatches each
  non-`STAY` entry straight to `executeTool(name, args)` in a loop. No LLM
  step, no re-evaluation, no retry logic beyond whatever `executeTool`
  itself does.
- **On every tool call**: `logAction({tool, args, result, duration_ms, success})` writes the audit JSONL — this part is unchanged.

There is one still-live position guard worth knowing: `deploy_position` and
`close_position`/`swap_token` are naturally idempotent per cycle because
the deterministic dispatch loop only ever calls each tool once per position
per cycle (it's driven by the `actionMap`, not a retry loop) — but there is
**no cross-cycle session lock** anymore. If you need "never call this twice
regardless of cycle," you have to build it explicitly (state-flag pattern,
same as `rebalance_count`/`rebalanceMaxCount` caps a position's REBALANCE
eligibility).

---

## Cron & cycle architecture (`index.js`)

Cron tasks created by `startCronJobs()`:

| Task | Cadence | Job |
|---|---|---|
| Management | `*/managementIntervalMin * * * *` | `runManagementCycle()` |
| Screening | `*/screeningIntervalMin * * * *` | `runScreeningCycle()` |
| Health check | `0 * * * *` | `buildHealthSummary` (`reports.js`) — a pure string builder over `getMyPositions({ force: true })` totals. No LLM, no on-chain writes. |
| Briefing | `0 1 * * *` (UTC) | `runBriefing()` — 8 AM Jakarta |
| Briefing watchdog | `0 */6 * * *` (UTC) | `maybeRunMissedBriefing()` — fires on startup if missed |
| **PnL poller** | every 20s (`setInterval`) | Trailing-TP detection + **hard stop-loss fast path** between management cycles (below) |

**Race condition guards** (all in `index.js`):
- `_managementBusy` / `_screeningBusy` flags prevent overlap.
- `_screeningLastTriggered` (epoch ms) prevents management from spamming screening.
- `_pollTriggeredAt` cooldown equal to `managementIntervalMin` to avoid PnL-poller double-triggering. **Exception:** a hard stop loss (any position `pnl_pct <= stopLossPct`, suspicious ticks skipped) triggers management immediately via a dedicated pre-scan at the top of the poller, bypassing this cooldown and the per-position `break` — fast in-range bleeds can cross the threshold within one management cycle, so the stop must not wait on the cooldown.
- `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh position count.

### The management cycle (100% deterministic JS)

1. `getMyPositions({ force: true })` → snapshot.
2. `recordPositionSnapshot` per pool.
3. JS `updatePnlAndCheckExits(position, …)` for each:
   - `STOP_LOSS` if `pnl_pct <= stopLossPct`
   - `IN_RANGE_DRAWDOWN` if `inRangeDrawdownExitEnabled` and `pnl_pct` has sat `<= inRangeDrawdownPct` *while in range* for `>= inRangeDrawdownWaitMinutes` (clock = `in_range_drawdown_since`, mirrors `out_of_range_since`; off by default — currently disabled in the shipped config since `stopLossPct` is shallower than `inRangeDrawdownPct`, making this rule unreachable there). Catches single-sided downside bleeds that never leave the range — the case STOP_LOSS (deeper) and OOR (only fires out-of-range) both miss.
   - `TRAILING_TP` if `trailing_active && (peak - current) >= trailingDropPct` (queued for 15s recheck) — currently disabled in the shipped config, superseded by REBALANCE's harvest-on-upside-break mechanism.
   - `OUT_OF_RANGE` if `minutes_out_of_range >= outOfRangeWaitMinutes`
   - `LOW_YIELD` if `fee_per_tvl_24h < minFeePerTvl24h && age >= minAgeBeforeYieldCheck`
4. For positions with no exit alert: `getDeterministicCloseRule(p, mgmtConfig)` applies, in order:
   - Rule 1: stop loss, Rule 2: take profit, **REBALANCE** (upside-only — `active_bin > upper_bin`, `rebalance_count < rebalanceMaxCount`, `rebalanceOnUpsideBreakEnabled`: shifts the range up in place instead of closing, optionally harvesting a % as realized profit once cumulative PnL crosses `rebalanceHarvestTriggerPct`), Rule 3: pumped far above range, Rule 4: OOR wait, Rule 5: low yield. REBALANCE sits between rules 2 and 3 and intercepts the same upside-only condition space rules 3/4 already require — downside cases fall through to rules 3-5 unaffected.
5. Positions needing `CLAIM` if `unclaimed_fees_usd >= minClaimAmount`.
6. Positions with `instruction` set are marked `INSTRUCTION` — parsed and evaluated by `instruction-parser.js` (pure JS condition matcher), not deferred to anything external. If the instruction can't be parsed, the position holds with a logged warning ("no LLM fallback").
7. **Every non-`STAY` `actionMap` entry dispatches straight to `executeTool(name, args)`** — CLOSE, CLAIM, REBALANCE, or the parsed INSTRUCTION's resulting close. No LLM step, no re-evaluation; the JS rules are the only decision-maker.

**Trailing TP two-phase confirmation** (15s recheck):
- First poll: candidate drop queued in state.
- 15s later: re-fetch positions, `resolvePendingTrailingDrop` — if the drop still holds (within 1% tolerance), fire `confirmed_trailing_exit` and trigger management cycle.
- Mirror pattern for peak confirmation (`queuePeakConfirmation` / `resolvePendingPeak`).

### The screening cycle (multi-stage pipeline, deterministic)

1. **Pre-checks**: `getMyPositions` + `getWalletBalances` in parallel. Skip if at `maxPositions` or `balance.sol < deployAmountSol + gasReserve`. Each skip writes a `decision-log` entry.
2. **Top candidates**: `getTopCandidates({limit: 10})` — applies ALL hard filters (TVL, fee/TVL, volatility, organic, holders, mcap, bin step, launchpad allow/block, token age, cooldowns, base mints already in use, dev blocklist), optional indicator confirmation, **and** PVP-rival detection (default: warn; `blockPvpSymbols: true` → hard filter). Candidates are returned in score-descending order.
3. **Sequential recon** with 150ms throttle (avoid 429s): `getActiveBin`, `checkSmartWalletsOnPool`, `getTokenNarrative`, `getTokenInfo` per candidate.
4. **Hard filters after recon**: launchpad allow/block, `bot_holders_pct > maxBotHoldersPct`.
5. **If 0 pass**: write `no_deploy` decision with `rejected[]` and return `⛔ NO DEPLOY` report.
6. **If 1 pass**: `getLoneCandidateSkipReason()` (smart-wallet absence, no narrative, PVP conflict, etc.) — if skipped, write `no_deploy` decision.
7. **Stage signals** for Darwinian attribution (if `signalStaging.enabled`).
8. **Deterministic deploy**: `passing[0]` (the highest-scored surviving candidate) is deployed directly via `executeTool("deploy_position", {...})` — `bins_below` from `computeBinsBelow(volatility)`, `amount_y` from `computeVolatilityScaledAmount(deployAmount, volatility)` (tapers size down for riskier entries). No LLM step, no candidate presented for "choice" — the top score wins deterministically.
9. **Post-deploy**: `appendDecision` with full context. Darwinian signals (if enabled) get consumed via `getAndClearStagedSignals`.

---

## Position lifecycle

```
deployPosition()                   tools/dlmm.js
   ├─ safety: pool_detail fresh fetch, TVL, fee/TVL, volatility, bin_step
   ├─ safety: bin-array init rent check (refuses pools that need initialization)
   ├─ strategy: spot | curve | bid_ask (config.strategy.strategy)
   ├─ range: bins_below linear in volatility, totalBins >= 35 (MIN_SAFE_BINS_BELOW)
   ├─ wide path: totalBins > 69 → createExtendedEmptyPosition + addLiquidityByStrategyChunkable
   ├─ standard path: initializePositionAndAddLiquidityByStrategy
   └─ post: trackPosition({ signal_snapshot: getAndClearStagedSignals })
        appendDecision({ type: "deploy", actor: "SCREENER", metrics, risks, rejected })
        notifyDeploy (Telegram)   ── skip if live message active

manage cycle (every N min)
   ├─ recordPositionSnapshot per pool
   ├─ updatePnlAndCheckExits → STOP_LOSS / TRAILING_TP / OOR / LOW_YIELD
   ├─ getDeterministicCloseRule → rules 1/2/3/4/5 + REBALANCE branch
   ├─ non-STAY actions (CLOSE / CLAIM / REBALANCE / INSTRUCTION) dispatch straight to executeTool — no LLM anywhere
   ├─ REBALANCE: rebalancePosition() shifts the range up in place via the SDK's native
   │  rebalance API, optionally harvesting a % as realized profit — recordRebalance()
   │  updates the tracked position in place (same address), does NOT recordClose()
   └─ on close: recordClose() → recordPerformance() in lessons.js
                 ├─ recordPoolDeploy (pool-memory.json)
                 ├─ derive lesson (PREFER/AVOID/WORKED/FAILED)
                 ├─ if performance.length % 5 == 0 → evolveThresholds (minOrganic, minFeeActiveTvlRatio only)
                 └─ push HiveMind event (fire-and-forget)

auto-swap on close (executor.js:610)
   ├─ only if !skip_swap && result.base_mint
   ├─ get wallet balance, find base token
   ├─ if usd >= 0.10 → swapToken back to SOL
   └─ result.auto_swapped = true + auto_swap_note (so LLM doesn't double-swap)
```

**OOR detection**: `getMyPositions` calls `markOutOfRange` / `markInRange` for every position every cycle. The first time we see OOR, `out_of_range_since` is set; `minutesOutOfRange` is the diff.

**Position instruction** (`set_position_note`): `instruction` is sanitized (no newlines, max 280 chars, no `<>`) and parsed deterministically by `instruction-parser.js` (a pure JS condition matcher — metric/operator/value, e.g. "pnl_pct >= 20"). The management cycle evaluates the parsed condition against the position's live PnL every cycle and closes immediately if met; an unparseable instruction holds with a logged warning instead of erroring.

**Cooldown logic** (`pool-memory.js`):
- Single `low yield` close → 4h pool cooldown.
- `oorCooldownTriggerCount` (default 3) consecutive OOR closes → `oorCooldownHours` (default 12h) cooldown on **both pool and base mint**.
- Optional repeat-deploy cooldown: `repeatDeployCooldownTriggerCount` (default 3) fee-generating deploys in a row → pool+token cooldown (configurable scope).
- All checked by `isPoolOnCooldown` / `isBaseMintOnCooldown` in `getTopCandidates` and `deployPosition`.

---

## Persistent files (all JSON at repo root)

| File | Shape | Mutated by |
|---|---|---|
| `user-config.json` | Flat keys (e.g. `minTvl`, `deployAmountSol`); nested `chartIndicators`. | `config.js` (load), `update_config` tool, `evolveThresholds`, setup wizard. **NEVER gitignored but you must `.gitignore` it locally** — README says so. |
| `state.json` | `{ positions: { [address]: {position, pool, pool_name, strategy, bin_range, amount_sol, original_amount_sol, active_bin_at_deploy, deployed_at, out_of_range_since, last_claim_at, total_fees_claimed_usd, rebalance_count, last_rebalance_at, harvested_sol, closed, closed_at, notes, peak_pnl_pct, pending_*, trailing_active, instruction, _lastBriefingDate, recentEvents[]} }` | `state.js` |
| `lessons.json` | `{ lessons: [{id, rule, tags, outcome, sourceType, confidence, role, pinned, context, ...}], performance: [{position, pool, pnl_pct, pnl_usd, fees_earned_usd, range_efficiency, minutes_held, close_reason, signal_snapshot, ...}] }` | `lessons.js` |
| `pool-memory.json` | `{ [poolAddress]: { name, base_mint, deploys[], total_deploys, avg_pnl_pct, win_rate, adjusted_win_rate, cooldown_until, base_mint_cooldown_until, notes[], snapshots[] } }` | `pool-memory.js` |
| `decision-log.json` | `{ decisions: [{id, ts, type, actor, pool, summary, reason, risks[], metrics{}, rejected[]}] }` max 100 | `decision-log.js` (called from deploy/close/skip in `tools/dlmm.js`, `index.js`) |
| `signal-weights.json` | `{ weights: {signal: 0.3-2.5}, last_recalc, recalc_count, history[] }` | `signal-weights.js` |
| `strategy-library.json` | `{ active: <id>, strategies: { [id]: {id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw} } }` | `strategy-library.js` |
| `smart-wallets.json` | `{ wallets: [{name, address, category, type, addedAt}] }` | `smart-wallets.js` |
| `token-blacklist.json` | `{ [mint]: {symbol, reason, added_at, added_by} }` | `token-blacklist.js` |
| `dev-blocklist.json` | `{ [wallet]: {label, reason, added_at} }` | `dev-blocklist.js` |
| `deployer-blacklist.json` | `{ _note, addresses: [wallet, …] }` (legacy) | `discord-listener/pre-checks.js` |
| `discord-signals.json` | Array of signals with status pending/processed | `discord-listener` |
| `hivemind-cache.json` | `{ sharedLessons: [], presets: [], pulledAt }` | `hivemind.js` |
| `logs/agent-YYYY-MM-DD.log` | Plain text | `logger.js` |
| `logs/actions-YYYY-MM-DD.jsonl` | Audit JSONL | `logger.js logAction` |

All persistent files are loaded/saved on each call — no in-memory caching layer. Keep writes small and on the path of one position close, never inside a hot loop.

---

## Config system

`config.js` exports a single `config` object built once at module load, then mutated by `update_config` tool and `reloadScreeningThresholds()`. **Top-level keys** (all flat unless noted):

| Section | Keys | Default |
|---|---|---|
| `risk` | `maxPositions`, `maxDeployAmount` | 3, 50 |
| `screening` | `excludeHighSupplyConcentration`, `minFeeActiveTvlRatio`, `minTvl`, `maxTvl`, `minVolume`, `minOrganic`, `minQuoteOrganic`, `minHolders`, `minMcap`, `maxMcap`, `minBinStep`, `maxBinStep`, `timeframe`, `category`, `minTokenFeesSol`, `useDiscordSignals`, `discordSignalMode`, `avoidPvpSymbols`, `blockPvpSymbols`, `maxBotHoldersPct`, `maxTop10Pct`, `allowedLaunchpads`, `blockedLaunchpads`, `minTokenAgeHours`, `maxTokenAgeHours`, `maxVolatility` | see `user-config.example.json`; `maxVolatility` default `null` = no cap |
| `management` | Position sizing/exit keys — see `user-config.example.json` for the full flat list and current defaults (this table doesn't try to stay byte-exact; the set has grown with `volatilitySizedDeployEnabled`/`volatilitySizeFloor` and `rebalanceOnUpsideBreakEnabled`/`rebalanceMaxCount`/`rebalanceHarvestTriggerPct`/`rebalanceHarvestBps` — check that file, not this row, for exact current values). `trailingTakeProfit` and `inRangeDrawdownExitEnabled` both default to `false` as of the in-place-rebalancing work — the former is superseded by REBALANCE's harvest mechanism, the latter is unreachable dead logic once `stopLossPct` is shallower than `inRangeDrawdownPct`. |
| `strategy` | `strategy`, `minBinsBelow`, `maxBinsBelow`, `defaultBinsBelow` | bid_ask, 35, 69, 69 |
| `schedule` | `managementIntervalMin`, `screeningIntervalMin`, `healthCheckIntervalMin` | 10, 30, 60 |
| `signalStaging` | `enabled` | true — gates entry-time signal capture for experiment attribution; the daemon is deterministic regardless, this only controls whether signals get recorded |
| `tokens` | `SOL`, `USDC`, `USDT` (mint addresses) | canonical |
| `hiveMind` | `url`, `apiKey`, `agentId`, `pullMode` | `https://api.agentmeridian.xyz`, built-in key, auto-generated, "auto" |
| `api` | `url`, `publicApiKey`, `lpAgentRelayEnabled` | `https://api.agentmeridian.xyz/api`, built-in key, false |
| `jupiter` | `apiKey`, `referralAccount`, `referralFeeBps` | env override, fixed referral, 50 bps |
| `indicators` | `enabled`, `entryPreset`, `exitPreset`, `rsiLength`, `intervals`, `candles`, `rsiOversold`, `rsiOverbought`, `requireAllIntervals` | false, supertrend_break, supertrend_break, 2, ["5_MINUTE"], 298, 30, 80, false |

No `llm` or `darwin` sections — removed along with the LLM loop and Darwinian per-role signal weighting.

`update_config` (executor.js) uses a flat-key `CONFIG_MAP` (60+ entries now) that knows how to (a) coerce booleans/arrays/strings/numbers via `normalizeConfigValue`'s `booleanKeys`/`arrayKeys`/`stringKeys` Sets (falls through to numeric coercion otherwise — **a key present in `CONFIG_MAP` but missing from `booleanKeys` silently persists `0`/`1` instead of `true`/`false`**; this has bitten real boolean keys before, double-check both Sets stay in sync when adding a boolean config key), (b) clamp `binsBelow*` to `MIN_SAFE_BINS_BELOW=35`, (c) restart cron if `managementIntervalMin` / `screeningIntervalMin` changed, (d) write a `[SELF-TUNED]` lesson.

`computeDeployAmount(walletSol) = clamp((walletSol - gasReserve) × positionSizePct, [deployAmountSol, maxDeployAmount])` → 2-decimal SOL.

`reloadScreeningThresholds()` (config.js:236) is called by `evolveThresholds` to re-apply changes to the in-memory `config` without process restart.

---

## Environment variables (`.env`)

| Var | Required | Purpose |
|---|---|---|
| `WALLET_PRIVATE_KEY` | yes | Base58 (or JSON array) |
| `RPC_URL` | yes | Solana RPC. Helius recommended. |
| `OPENROUTER_API_KEY` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | **no — vestigial** | Leftover from the removed LLM loop. `config.js` still applies these from `user-config.json` overrides and `index.js` logs the model name at startup, but nothing makes an actual LLM call — safe to leave unset. `setup.js`'s wizard still prompts for `OPENROUTER_API_KEY` (not yet cleaned up). |
| `HELIUS_API_KEY` | recommended | Wallet balance lookups via Helius. |
| `LPAGENT_API_KEY` | optional | Direct LPAgent positions fetch fallback. |
| `JUPITER_API_KEY` | optional | Better rate limit on Jupiter Swap. Default key baked in. |
| `TELEGRAM_BOT_TOKEN` | no | Notifications + REPL. |
| `TELEGRAM_CHAT_ID` | no | Default chat (also persisted to `user-config.telegramChatId`). |
| `TELEGRAM_ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs allowed to control. Required if chat is a group. |
| `ALLOW_SELF_UPDATE` | no | Set `true` to allow the `self_update` tool (default false). |
| `DRY_RUN` | no | Skip all on-chain txs. `npm run dev` sets it. |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. |
| `DISCORD_USER_TOKEN` | no | Selfbot for `discord-listener/`. |
| `DISCORD_GUILD_ID` / `DISCORD_CHANNEL_IDS` | no | Discord listener config. |
| `DISCORD_MIN_FEES_SOL` | no | Default 5. |
| `ENVRYPT_KEY` / `ENVCRYPT_KEY` | no | Key for `.env` XOR encryption (line-by-line marked with `# encrypted`). |
| `HIVE_MIND_URL` / `HIVE_MIND_API_KEY` | no | Override defaults. |

Encrypted env flow (optional, see `scripts/envrypt.js`):
1. Save plain values to `.env.raw`.
2. `printf "long-local-key\n" > .envrypt`.
3. `npm run env:encrypt` reads `.env.raw`, encrypts anything matching `*_KEY`/`*SECRET*`/`*TOKEN*`/`*MNEMONIC*`/etc., writes `.env`. Originals are XOR'd with a positional repeating key — **not** cryptographically secure, but obscures values in plaintext grep.

---

## Telegram ops surface

| Surface | Where handled | Notes |
|---|---|---|
| `/help` / `/status` / `/wallet` / `/config` | `index.js#telegramHandler` | Read-only. |
| `/positions` / `/pool <n>` / `/close <n>` / `/set <n> <note>` | `index.js#telegramHandler` | Direct dispatch to `executeTool` — no intermediary of any kind. `/close <n>` calls `closePosition` directly. |
| `/closeall` | index.js | Closes all open positions in sequence. |
| `/screen` / `/candidates` / `/deploy <n>` | `runDeterministicScreen` + `deployLatestCandidate` | Deterministic — no LLM. The single-candidate skip rule applies. |
| `/briefing` | `generateBriefing` | On-demand daily report. |
| `/settings` / `/menu` / `/configmenu` | `renderSettingsMenu` + `applySettingsMenuCallback` | Inline-keyboard menu with toggle/step buttons. Updates flow through `update_config` tool. |
| `/hive pull` | `pullHiveMindLessons` + `pullHiveMindPresets` | Manual HiveMind fetch. |
| `/pause` / `/resume` / `/stop` | index.js | Toggle cron jobs / graceful shutdown. |
| Free-form chat | `telegramHandler` fallback | **Disabled.** Any message that isn't a recognized `/command` gets a static "Free-form chat is disabled. Use commands: ..." reply and is dropped — never routed anywhere. |
| `cfg:*` callback queries | `applySettingsMenuCallback` | Settings menu button presses. |

**Auth** (`telegram.js#isAuthorizedIncomingMessage`):
- `chatId` must match incoming message's chat (env or persisted `user-config.telegramChatId`).
- If chat is a group/supergroup, `TELEGRAM_ALLOWED_USER_IDS` must be non-empty.
- Otherwise, all messages from the matching chat are accepted.
- Warns-once on missing config, then silently ignores inbound.

**Queueing**: while a management/screening cycle is busy, inbound messages are queued (`_telegramQueue`, max 5). Overflow sends "Queue is full".

**Live messages**: `createLiveMessage` returns a handle. `toolStart`/`toolFinish` push per-tool lines (with `ℹ️`/`✅`/`❌` icons) into a single Telegram message that gets edited in place. While a live message is active, standalone notifications (`notifyDeploy`/`notifyClose`/`notifySwap`/`notifyOutOfRange`) are suppressed to avoid spam.

---

## Discord listener

Standalone process — `cd discord-listener && npm install && npm start`. Shares `../.env` for env vars.

- Uses `discord.js-selfbot-v13` (personal account, not bot). **Selfbot — use responsibly; against Discord TOS.**
- Filters: only `Metlex Pool Bot` author, only configured channels.
- Extracts Solana addresses (base58, 32-44 chars, must contain digit, not in `FALSE_POSITIVE_SKIP` set).
- For each address: runs `runPreChecks` (dedup → blacklist → pool resolve → rug → deployer → fees) and appends to `discord-signals.json` with `status: "pending"`.
- Screener picks up pending signals first (or only, if `discordSignalMode: "only"`).
- `DISCORD_MIN_FEES_SOL` defaults to 5; the screener's hard floor is `minTokenFeesSol` (default 30) — both apply.

---

## Strategy library (default strategies)

| id | name | lp_strategy | idea |
|---|---|---|---|
| `custom_ratio_spot` | Custom Ratio Spot | spot | Express directional bias via token:SOL ratio. |
| `single_sided_reseed` | Single-Sided Bid-Ask + Re-seed | bid_ask | Token-only redeploys on OOR downside. |
| `fee_compounding` | Fee Compounding | any | Now real, not aspirational: on an upside out-of-range break, `rebalance_position` compounds accrued fees back into the same position automatically as part of the range shift. |
| `multi_layer` | Multi-Layer | mixed | One position, multiple add-liquidity layers with different shapes. |
| `partial_harvest` | Partial Harvest | any | Now real, not aspirational: on an upside out-of-range break with cumulative PnL >= `rebalanceHarvestTriggerPct`, `rebalance_position` withdraws `rebalanceHarvestBps` as realized profit while shifting the range, up to `rebalanceMaxCount` times. |

`set_active_strategy` swaps the active one. **This whole file's entries are descriptive metadata only — with no LLM in the loop, nothing reads this text as instructions.** The `fee_compounding`/`partial_harvest` entries above describe real deterministic mechanics (wired into `getDeterministicCloseRule`'s REBALANCE branch); `custom_ratio_spot`/`single_sided_reseed`/`multi_layer` remain purely descriptive with no corresponding code path.

---

## Known issues / tech debt (verified by reading the code)

- **`lessons.js evolveThresholds()`** evolves `minOrganic` and `minFeeActiveTvlRatio` only — still true; `maxVolatility` was added to screening config separately but `evolveThresholds` was never extended to touch it, so it stays manually configured.
- **`tools/definitions.js` is entirely unimported** — zero files reference it (verified by grep). It's ~1150 lines of OpenAI-format schemas describing tools that no LLM ever sees. Don't assume editing it has any runtime effect; it's documentation-only until/unless an LLM path is reintroduced.
- **`get_wallet_positions` tool** is in `definitions.js` and wired in `executor.js`'s `toolMap`, but since there's no role-based tool filtering anymore, this note about role exposure no longer applies — any caller with the tool name can invoke it via `executeTool`.
- **Lazy SDK load** (`tools/dlmm.js`) — `@meteora-ag/dlmm` is dynamic-imported on first on-chain call to avoid CJS-import crash on Node 24 (the `postinstall` `patch-anchor.js` handles another piece of this). Don't `import` it eagerly at top of file.
- **Position cache** (`_positionsCache` 5min TTL) — in single-process mode it's a perf win, but the cache is invalidated by `_positionsCacheAt = 0` after every deploy/close/rebalance, and the executor's `deploy_position` safety check uses `force: true` for a fresh count.
- **PnL sanity check** (`pnlSanityMaxDiffPct`, default 5%) — if reported vs derived pnl_pct differ by more than this, the tick is flagged as suspect and the deterministic close rules skip it that cycle (no LLM to "tell" anymore — the skip is a hard-coded guard in `getDeterministicCloseRule`). Implemented in `dlmm.js` getMyPositions and `state.js` updatePnlAndCheckExits.
- **`update_config`'s boolean coercion requires a matching `booleanKeys` entry** — a CONFIG_MAP key whose underlying config value is a boolean but is missing from `normalizeConfigValue`'s `booleanKeys` Set silently persists `0`/`1` instead of `true`/`false` (no error, since it falls through to numeric coercion). Verify both when adding a new boolean config key.
- **DRY_RUN auto-skip SOL balance check** — `runSafetyChecks` for `deploy_position` only checks `balance.sol < amountY + gasReserve` if `DRY_RUN !== "true"`.
- **HiveMind disable path is murky** — README says "there is currently no empty-string disable path" for HiveMind. `config.hiveMind.url/apiKey` fall back to defaults if blank. Set `pullMode: "manual"` to suppress auto-pull.
- **Selfbot in `discord-listener/`** is a ToS gray area. Make sure operators know.
- **`.claude/settings.json`** denies `rm -rf`, `wget`, and **reads of `.env*`**. It also blocks `run_in_background: true` via a PreToolUse hook. So in this repo, Claude Code can't background long-running commands — serial execution only.
- **Drift risk** — `user-config.json` keys must match the **flat** `update_config` CONFIG_MAP in executor.js. New keys: add to both, otherwise `update_config` returns `unknown: [...]` and skips the apply.
- **The Discord `useDiscordSignals` flag** lives in `screening`, not `discord`. Screener checks `config.screening.useDiscordSignals`, and `discordSignalMode: "merge" | "only"`.

---

## Patterns to copy

When adding a new tool that reads on-chain data, copy the **cache + inflight dedup + `force` flag** pattern from `getMyPositions` (`tools/dlmm.js`, ~line 1344 — the file has grown, don't trust the exact line number, grep for `POSITIONS_CACHE_TTL`). The `force: true` is what the deploy safety check relies on.

When adding a new persistent JSON store, copy the load/save pattern from `state.js` or `pool-memory.js`. **Always** run text through `sanitizeStoredText` (or write a domain-specific sanitizer that strips `<>` and newlines) before persisting — those values get echoed into Telegram reports, logs, and the daily briefing.

When adding a new pre-deploy enrichment, follow the **3-strikes (Discord pre-checks)** model: cheap checks first (in-memory dedup, file lookup), then network (pool resolution, rugcheck), then more network (deployer, global fees). Log each pass/reject with the stage name.

When scheduling work, follow the **`_busy` flag + cooldown** pattern. `_managementBusy`, `_screeningBusy`, `_pnlPollBusy`, `_pollTriggeredAt`, `_screeningLastTriggered` are the canonical examples.

---

## What to read next

- Adding a new tool → `tools/executor.js` (see "Adding a new tool" above).
- Changing safety rules → `tools/executor.js#runSafetyChecks` and `index.js#getDeterministicCloseRule`.
- Adding a new persistent state file → copy `state.js` or `pool-memory.js`. Wire a getter into `index.js` wherever the corresponding report/notification is built (there's no LLM prompt to inject into anymore).
- Changing the deterministic decision logic → `index.js#getDeterministicCloseRule` (management cycle) and `index.js#runScreeningCycle` (screening cycle's deterministic top-score selection).
- Changing deploy/close/rebalance behavior → `tools/dlmm.js` (the SDK wrapper — `deployPosition`, `closePosition`, `rebalancePosition`) and `tools/executor.js` (the post-tool side effects + Telegram notify + auto-swap).
- Discord listener issues → `discord-listener/pre-checks.js`.
- HiveMind protocol issues → `hivemind.js` (push side) and `lessons.js` (pull side — `getLessonsForPrompt` still exists but nothing consumes its output as an LLM prompt anymore; check current callers before assuming it's load-bearing).
