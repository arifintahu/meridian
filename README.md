# Meridian

**Autonomous, deterministic Meteora DLMM liquidity management agent for Solana — no LLM at runtime.**

**Links:** [Website](https://agentmeridian.xyz) | [Telegram](https://t.me/agentmeridian) | [X](https://x.com/meridian_agent)

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. Every decision is made by deterministic rules in code — no LLM in the loop — so runs are reproducible and you tune behavior by changing config, not prompts. You discover good parameters by running dry-run experiments and evaluating the results.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step), then deploys into the top-scored survivor — all in code, no model call
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously via fixed rules (stop-loss, take-profit, out-of-range, low-yield, trailing TP)
- **Records performance** — logs every closed position and derives lessons; you tune thresholds deliberately from the evidence (see the experiment workflow below) rather than letting the agent drift
- **Reproducible experiments** — dry-run mode records every deploy/close to a local SQLite DB so you can compare config variants without LLM nondeterminism muddying the results
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram notifications** — cycle reports, deploy/close/OOR alerts, and a few control commands (`/positions`, `/close`, `/set`)
- **Claude Code integration** — run deterministic screening/management and evaluate experiment results from your terminal using Claude Code slash commands

---

## How it works

Meridian runs two deterministic cycles on independent cron schedules. There is no model in the loop — each cycle reads live data and applies fixed rules in code:

| Cycle | Default interval | What it does |
|---|---|---|
| **Screening** | Every 30 min | Hard-filters Meteora pools (TVL, fee/TVL, organic, holders, bin step, cooldowns, PVP), scores the survivors, and deploys into the top-scored one |
| **Management** | Every 10 min | Evaluates each open position against fixed exit rules and claims/closes accordingly |

### Decision rules

- **Screening** filters every candidate, then deploys the highest-scored survivor (`fee/TVL × 1000 + organic × 10 + volume/100 + holders/100`). If only one weak candidate survives, a lone-candidate skip can veto it.
- **Management** applies, in order: stop-loss, take-profit, pumped-far-above-range, out-of-range-timeout, and low-yield. A 30-second PnL poller handles trailing-take-profit between cycles. Free-text position notes (e.g. "close if pnl > 10%") are parsed and evaluated in code.

Every deploy, close, skip, and no-deploy is written to a structured decision log (`decision-log.json`) with the actor, pool/position, reason, risks, metrics, and rejected alternatives — and to a SQLite experiment DB in dry-run mode.

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

> **No API key for an LLM provider is required.** Meridian made the entire loop deterministic; the old ReAct/LLM harness has been removed.

---

## Experiment & tuning workflow

Because the daemon is deterministic, the same config + same market data produces the same decisions — which makes parameter tuning a clean, evidence-driven loop:

1. **Run a dry-run experiment** — `npm run dev` records every deploy/close to a local SQLite DB (`experiment.sqlite`), tagged with the active `user-config.json` snapshot.
2. **Evaluate** — in Claude Code, run `/evaluate`. It analyses the experiment (win rate, PnL, exit-reason breakdown, signal correlations) and recommends specific `user-config.json` changes backed by the data.
3. **Apply + commit** — on your approval, `/evaluate` edits `user-config.json` and commits it. The file is **git-tracked** for exactly this reason.
4. **Deploy** — on the runner, `git pull` picks up the new config.

`user-config.json` is versioned config you change deliberately. The daemon never rewrites it at runtime (auto-evolution is off), so the tracked file stays clean between pulls. Keep all secrets in `.env` (gitignored) — never in `user-config.json`.

---

## Requirements

- Node.js 18+
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional, for notifications)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands + `/evaluate`)

> No LLM provider key is needed — the agent runs entirely on deterministic rules.

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard writes **both** files at the repo root:

| Goes in `.env` | Goes in `user-config.json` |
|---|---|
| `WALLET_PRIVATE_KEY`, `RPC_URL`, `HELIUS_API_KEY` | Risk preset, deploy size, max positions |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS` | Strategy, screening filters, exit rules, trailing TP |
| `DRY_RUN` | Position sizing, cycle intervals, `solMode` |

`TELEGRAM_CHAT_ID` only needs to live in `.env` — setup also copies it to `user-config.json` when provided. Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

> **Secrets live in `.env` only — never in `user-config.json`.** `.env` is gitignored; `user-config.json` is **git-tracked** (it holds non-secret tuning config you version and deploy).

Optional encrypted `.env` flow:

```bash
cp .env .env.raw
printf "replace-with-a-long-local-key\n" > .envrypt
npm run env:encrypt
```

Meridian loads envrypt-style encrypted values automatically. Keep `.env.raw` and `.envrypt` local; both are gitignored.

`user-config.json` is tracked in the repo, so a clone already has it — edit it directly. `user-config.example.json` documents every available field. See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

### Run with PM2 (VPS / always-on)

PM2 is the recommended way to keep Telegram control online on a VPS. **Always start via the ecosystem file** so the working directory and script path stay pinned to the repo:

```bash
npm install
npm run pm2:start    # uses ecosystem.config.cjs — do NOT use "pm2 start index.js"
pm2 save
```

After `.env`, `user-config.json`, or code changes:

```bash
npm run pm2:restart  # re-reads .env on each restart
npm run pm2:logs
```

To update an existing PM2 install:

```bash
git pull
npm install
npm run pm2:restart
pm2 save
```

If a previous PM2 run was started incorrectly, reset it once:

```bash
pm2 delete meridian
npm run pm2:start
pm2 save
```

**PM2 vs `npm start`**

| | `npm start` | PM2 |
|---|---|---|
| Terminal | Interactive REPL | Headless daemon |
| Cron / Telegram | Starts after REPL banner | Starts immediately on boot |
| First screening | On cron schedule | May run one cycle right at startup |
| Best for | Local dev / testing | VPS / 24-7 operation |

On startup, logs show `Repo: ... | cwd: ... | PM2 id: ...`. **Repo and cwd must match.** If they differ, delete the process and use `npm run pm2:start` again.

**Common PM2 issues**

| Symptom | Likely cause | Fix |
|---|---|---|
| Crash loop after `git pull` | `npm install` skipped | `npm install && npm run pm2:restart` |
| Missing wallet / API keys | Started with `pm2 start index.js` from wrong directory | `pm2 delete meridian && npm run pm2:start` |
| `.env` changes ignored | Old PM2 env snapshot | `npm run pm2:restart` (`.env` now overrides stale PM2 env) |
| Telegram `401 Unauthorized` | Invalid `TELEGRAM_BOT_TOKEN` (not chat ID) | Fix token in `.env`; if encrypted, ensure `.envrypt` exists |
| Telegram commands ignored | Missing/wrong `TELEGRAM_CHAT_ID` | Set in `.env` (or `telegramChatId` in `user-config.json`) |
| Duplicate polling / 409 errors | `nohup node index.js` or second PM2 instance running | Kill stray processes; run only one PM2 app |
| Encrypted env crash at boot | `# encrypted` lines without `.envrypt` key | Add `.envrypt` or use plain `.env` values |

Avoid `nohup node index.js` — it runs outside PM2 and can leave a duplicate Telegram poller fighting the managed process.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `1` / `2` / `3` … | Deploy into that candidate (deterministic) |
| `auto` | Run a deterministic screen + deploy |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Manually adjust thresholds from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |

> The REPL is command-only. Free-form chat has been removed along with the LLM loop.

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/evaluate` | Analyse a dry-run experiment and recommend + commit `user-config.json` tuning changes |
| `/screen` | Deterministic screening cycle — checks Discord queue, reads config, fetches candidates, and deploys the top survivor |
| `/manage` | Deterministic management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and analyse top pool candidates against the deterministic screening thresholds |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two read-only analyst sub-agents run inside Claude Code. The deploy/close decisions themselves are deterministic and live in code — the agents surface data, explain what the rules will do, and run the deterministic cycle when asked. They do not apply their own thresholds.

**`screener`** — pool screening analyst. Inspect candidates and token risk, explain what the deterministic screener would pick, and run a screening cycle.

**`manager`** — position management analyst. Review open positions and PnL, explain the deterministic exit rules, and run a management cycle.

A third agent, **`meridian-experiment-runner`**, drives the dry-run experiment workflow (start a labelled DRY_RUN, monitor closes, hand off to `/evaluate`).

To trigger an agent directly, just describe what you want:
```
> run a screening cycle and tell me what it deployed and why
> review my positions and run a management cycle
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one deterministic screening cycle
meridian manage [--dry-run] [--silent]   # one deterministic management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>          # .env alone is enough; also saved to user-config by setup
TELEGRAM_ALLOWED_USER_IDS=<user id>    # required for group/supergroup control
```

Meridian does **not** auto-register the first chat for safety — you must set `TELEGRAM_CHAT_ID` explicitly. For groups, also set `TELEGRAM_ALLOWED_USER_IDS` or inbound commands are ignored.

`401 Unauthorized` in logs means a bad `TELEGRAM_BOT_TOKEN` (invalid, revoked, or encrypted without a working `.envrypt` key) — not a chat ID problem.

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (rule-based decisions + results)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

Telegram is for notifications and these control commands only — there is no free-form chat. Only allowed user IDs can issue commands in groups.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBotHoldersPct` | `30` | Maximum bot holder % (Jupiter audit) |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR before acting |
| `stopLossPct` | `-50` | Close position if PnL drops by this % |
| `takeProfitPct` | `5` | Close when fees earned reach this % of capital |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing TP at this PnL % |
| `trailingDropPct` | `1.5` | Close when PnL drops this % from peak |
| `strategy` | `bid_ask` | LP strategy: `spot`, `bid_ask`, or `curve` |

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |

### Signal staging

| Field | Default | Description |
|---|---|---|
| `signalStagingEnabled` | `true` | Capture entry-time signals (fee/TVL, organic, volatility, …) into each position's record for experiment analysis. Recorded, never acted on. |

---

## Performance & tuning

### Performance log & lessons

Every closed position is recorded with its full context (entry signals, PnL, fees, range efficiency, hold time, close reason) in `lessons.json` and — in dry-run — the experiment SQLite DB. From each close the agent derives a structured lesson (PREFER / AVOID / WORKED / FAILED).

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Tuning thresholds

The recommended path is the [experiment workflow](#experiment--tuning-workflow): run a dry-run, then `/evaluate` in Claude Code to get evidence-backed `user-config.json` changes and commit them.

Auto-evolution is **disabled** — the daemon never rewrites your tracked config on its own. For a quick manual pass over closed-position performance you can still run:
```bash
node cli.js evolve     # needs 5+ closed positions
```
This adjusts `minOrganic` / `minFeeActiveTvlRatio` in `user-config.json` from win-rate and yield data. Review the diff and commit it.

---

## HiveMind

HiveMind sync uses Agent Meridian at `https://api.agentmeridian.xyz` by default with the built-in public key. Agents can register, pull shared lessons/presets, and push learning events without a separate registration flow.

**What you get:**
- Shared lessons from other Meridian agents
- Strategy presets and crowd performance context
- Role-aware shared lessons available to future cycles when `hiveMindPullMode` is `auto`

**What you share:**
- Lessons from `lessons.json`
- Closed-position performance events: pool, pool name, base mint, strategy, close reason, PnL, fees, and hold time
- Agent heartbeat metadata: agent ID, version, timestamp, and basic capability flags
- **Private keys and wallet balances are never sent**

HiveMind failures are non-blocking. If Agent Meridian is unavailable, the agent logs a warning and keeps running.

### Setup

No manual HiveMind registration command is required for the shared Agent Meridian setup. `agentId` is generated automatically on startup if it is missing.

To use a private HiveMind API key, check the Telegram announcement channel and set it as `hiveMindApiKey`.

Relevant config fields:

```json
{
  "agentId": "",
  "hiveMindUrl": "",
  "hiveMindApiKey": "",
  "hiveMindPullMode": "auto"
}
```

Blank `hiveMindUrl` and `hiveMindApiKey` values intentionally fall back to the Agent Meridian defaults. Set `hiveMindPullMode` to `manual` if you do not want shared lessons and presets pulled automatically.

### Disable

There is currently no empty-string disable path for HiveMind; blank values fall back to the built-in Agent Meridian defaults. A true off switch should be implemented as an explicit config flag before documenting HiveMind as disabled by clearing fields.

---

## Architecture

```
index.js              Main entry: REPL + deterministic cron cycles + Telegram polling
config.js             Runtime config from user-config.json + .env (repo-root paths)
repo-root.js          Stable absolute repo path — used by PM2, state files, and .env loading
instruction-parser.js Parses free-text position notes into close conditions (no LLM)
reports.js            Code-built deploy + health report strings
state.js              Position registry (state.json)
decision-log.js       Structured decision log for deploy, close, skip, and no-deploy rationale
lessons.js            Performance log + derived lessons + manual threshold evolution
pool-memory.js        Per-pool deploy history, cooldowns, and snapshots
signal-tracker.js     Stages entry-time signals into the position record
strategy-library.js   Saved LP strategy definitions
experiment-recorder.js Records deploys/closes/snapshots to the experiment SQLite DB
telegram.js           Telegram bot: polling + notifications
hivemind.js           Agent Meridian HiveMind sync
smart-wallets.js      KOL/alpha wallet tracker
token-blacklist.js    Permanent token blacklist
cli.js                Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js      Tool schemas
  executor.js         Tool dispatch + safety checks
  dlmm.js             Meteora DLMM SDK wrapper
  screening.js        Pool discovery + scoring + hard filters
  wallet.js           SOL/token balances + Jupiter swap
  token.js            Token info, holders, narrative
  study.js            Top LPer study via LPAgent API

db/                   Experiment SQLite schema, recorders, and Postgres outbox sync

discord-listener/
  index.js            Selfbot Discord listener
  pre-checks.js       Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    evaluate.md     /evaluate — analyse experiment + tune config
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
