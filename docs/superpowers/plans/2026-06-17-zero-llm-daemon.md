# Zero-LLM Deterministic Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all automatic LLM calls from the Meridian daemon so dry-run experiments are fully deterministic and reproducible.

**Architecture:** Two new pure modules (`instruction-parser.js`, `reports.js`) replace LLM judgment/prose. Five edit sites in `index.js` swap `agentLoop` calls for deterministic JS: screening deploys the top-scored survivor, management dispatches pre-decided actions, health check builds a code summary, and the REPL/Telegram free-form chat is removed. `agent.js`/`prompt.js` stay in the tree, dormant.

**Tech Stack:** Node 22 ESM, `node:test` test runner, existing `executeTool` / `getMyPositions` / `appendDecision` helpers.

**Spec:** `docs/superpowers/specs/2026-06-17-zero-llm-daemon-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `instruction-parser.js` (new) | Parse free-text position instructions into `{metric, op, value}`; evaluate against a position. Pure. |
| `reports.js` (new) | Build deploy report + health summary strings from data. Pure. |
| `test/instruction-parser.test.js` (new) | Unit tests for the parser. |
| `test/reports.test.js` (new) | Unit tests for the report builders. |
| `index.js` (modify) | 6 edits: 2 imports + screening + management + health + REPL + Telegram. |
| `package.json` (modify) | Add the two new test files to `test:unit`. |

---

## Task 1: instruction-parser.js

**Files:**
- Create: `instruction-parser.js`
- Test: `test/instruction-parser.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/instruction-parser.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruction, evaluateInstruction } from '../instruction-parser.js';

describe('parseInstruction', () => {
  it('parses pnl above threshold', () => {
    assert.deepEqual(parseInstruction('close if pnl > 10%'), { metric: 'pnl_pct', op: '>=', value: 10 });
  });
  it('parses bare percentage as pnl below', () => {
    assert.deepEqual(parseInstruction('close below -5%'), { metric: 'pnl_pct', op: '<=', value: -5 });
  });
  it('parses value under dollar threshold', () => {
    assert.deepEqual(parseInstruction('close if value under $40'), { metric: 'value_usd', op: '<=', value: 40 });
  });
  it('returns null for ambiguous text', () => {
    assert.equal(parseInstruction('keep an eye on this one'), null);
  });
  it('returns null when both directions present', () => {
    assert.equal(parseInstruction('close if pnl above 10% or below -5%'), null);
  });
  it('returns null for empty/non-string', () => {
    assert.equal(parseInstruction(''), null);
    assert.equal(parseInstruction(null), null);
  });
});

describe('evaluateInstruction', () => {
  it('true when pnl meets >= condition', () => {
    assert.equal(evaluateInstruction({ metric: 'pnl_pct', op: '>=', value: 10 }, { pnl_pct: 12 }), true);
  });
  it('false when pnl below >= threshold', () => {
    assert.equal(evaluateInstruction({ metric: 'pnl_pct', op: '>=', value: 10 }, { pnl_pct: 8 }), false);
  });
  it('true when value meets <= condition', () => {
    assert.equal(evaluateInstruction({ metric: 'value_usd', op: '<=', value: 40 }, { total_value_usd: 35 }), true);
  });
  it('false when needed field missing', () => {
    assert.equal(evaluateInstruction({ metric: 'pnl_pct', op: '>=', value: 10 }, {}), false);
  });
  it('false for null parsed', () => {
    assert.equal(evaluateInstruction(null, { pnl_pct: 50 }), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/instruction-parser.test.js`
Expected: FAIL — cannot find module `../instruction-parser.js`.

- [ ] **Step 3: Write the implementation**

Create `instruction-parser.js`:

```js
// Parses free-text position instructions into deterministic close conditions.
// Conservative: only unambiguous threshold patterns are recognized. Anything
// ambiguous returns null so the caller HOLDs rather than guessing.

/**
 * @param {string} text
 * @returns {{ metric: 'pnl_pct'|'value_usd', op: '>='|'<=', value: number } | null}
 */
export function parseInstruction(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase().trim();

  // Metric: dollar/value wording → value_usd; pnl wording or a bare % → pnl_pct.
  let metric = null;
  if (/\bvalue\b|\bworth\b|\busd\b|\$/.test(t)) metric = 'value_usd';
  else if (/\bpnl\b|\bprofit\b|\bp&l\b|\breturn\b/.test(t) || /%/.test(t)) metric = 'pnl_pct';
  if (!metric) return null;

  // Direction: exactly one of up/down must be present.
  const up = /(>=|≥|at least|>|above|over|exceeds?|reaches?|hits?)/.test(t);
  const down = /(<=|≤|at most|<|below|under|drops? below|falls? below|dips? below)/.test(t);
  if (up === down) return null; // neither, or both → ambiguous
  const op = up ? '>=' : '<=';

  // Number: first numeric token, optional leading '-' and '$'.
  const numMatch = t.match(/-?\$?\d+(?:\.\d+)?/);
  if (!numMatch) return null;
  const value = Number(numMatch[0].replace(/\$/g, ''));
  if (!Number.isFinite(value)) return null;

  return { metric, op, value };
}

/**
 * @param {{ metric: string, op: string, value: number } | null} parsed
 * @param {{ pnl_pct?: number, total_value_usd?: number }} position
 * @returns {boolean} whether the close condition is met
 */
export function evaluateInstruction(parsed, position) {
  if (!parsed || !position) return false;
  const field = parsed.metric === 'pnl_pct' ? position.pnl_pct : position.total_value_usd;
  if (field == null || !Number.isFinite(Number(field))) return false;
  const v = Number(field);
  return parsed.op === '>=' ? v >= parsed.value : v <= parsed.value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/instruction-parser.test.js`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git -C "D:\code\projects\meridian" add instruction-parser.js test/instruction-parser.test.js
git -C "D:\code\projects\meridian" commit -m "feat: deterministic position-instruction parser"
```

---

## Task 2: reports.js

**Files:**
- Create: `reports.js`
- Test: `test/reports.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/reports.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeployReport, buildHealthSummary } from '../reports.js';

describe('buildDeployReport', () => {
  it('renders deployed pool fields', () => {
    const out = buildDeployReport({
      candidate: { name: 'FOO-SOL', pool: 'PoolAddr', fee_active_tvl_ratio: 0.08, volume_window: 5000, tvl: 40000, volatility: 1.5, organic_score: 80, mcap: 1000000, active_bin: -393 },
      audit: { top10Pct: 30, botPct: 5, feesSol: 50, smartWallets: 'none' },
      deployResult: { range_coverage: { downside_pct: 12, upside_pct: 0, width_pct: 12 }, min_price: 0.001, max_price: 0.0012 },
      deployAmount: 0.5,
      strategy: 'bid_ask',
    });
    assert.match(out, /🚀 DEPLOYED/);
    assert.match(out, /FOO-SOL/);
    assert.match(out, /bid_ask/);
    assert.match(out, /12\.00% downside/);
    assert.match(out, /Top10: 30%/);
  });
  it('tolerates missing optional fields without throwing', () => {
    const out = buildDeployReport({ candidate: { name: 'BAR-SOL' }, deployResult: {}, deployAmount: 0.5, strategy: 'spot' });
    assert.match(out, /BAR-SOL/);
    assert.match(out, /\?% downside/);
  });
});

describe('buildHealthSummary', () => {
  it('renders portfolio summary', () => {
    const out = buildHealthSummary({
      positions: [{ pair: 'FOO-SOL', pnl_pct: 2.5, fee_per_tvl_24h: 8, in_range: true }],
      totals: { value_usd: 50, unclaimed_usd: 1.2 },
    });
    assert.match(out, /HEALTH CHECK/);
    assert.match(out, /Open positions: 1/);
    assert.match(out, /FOO-SOL/);
  });
  it('handles empty portfolio', () => {
    const out = buildHealthSummary({ positions: [], totals: {} });
    assert.match(out, /Open positions: 0/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/reports.test.js`
Expected: FAIL — cannot find module `../reports.js`.

- [ ] **Step 3: Write the implementation**

Create `reports.js`:

```js
// Pure string builders for daemon output. Replace LLM-generated prose so the
// automatic loops make zero LLM calls.

function fmt(n, d = 2) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(d) : '?';
}

/**
 * Build the deploy report (replaces the screener's 🚀 DEPLOYED prose).
 * @param {{ candidate?: object, audit?: object, deployResult?: object, deployAmount?: number, strategy?: string }} args
 * @returns {string}
 */
export function buildDeployReport({ candidate = {}, audit = {}, deployResult = {}, deployAmount, strategy } = {}) {
  const rc = deployResult.range_coverage || {};
  const activeBin = deployResult.active_bin ?? candidate.active_bin ?? '?';
  return [
    '🚀 DEPLOYED',
    '',
    `${candidate.name ?? '?'}`,
    `${candidate.pool ?? '?'}`,
    '',
    `◎ ${deployAmount ?? '?'} SOL | ${strategy ?? '?'} | bin ${activeBin}`,
    `Range: ${deployResult.min_price ?? '?'} → ${deployResult.max_price ?? '?'}`,
    `Range cover: ${fmt(rc.downside_pct)}% downside | ${fmt(rc.upside_pct)}% upside | ${fmt(rc.width_pct)}% total`,
    '',
    'MARKET',
    `Fee/TVL: ${candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? '?'}`,
    `Volume: $${candidate.volume_window ?? '?'}`,
    `TVL: $${candidate.tvl ?? candidate.active_tvl ?? '?'}`,
    `Volatility: ${candidate.volatility ?? '?'}`,
    `Organic: ${candidate.organic_score ?? '?'}`,
    `Mcap: $${candidate.mcap ?? '?'}`,
    '',
    'AUDIT',
    `Top10: ${audit.top10Pct ?? '?'}%`,
    `Bots: ${audit.botPct ?? '?'}%`,
    `Fees paid: ${audit.feesSol ?? '?'} SOL`,
    `Smart wallets: ${audit.smartWallets ?? 'none'}`,
  ].join('\n');
}

/**
 * Build the hourly health summary (replaces the LLM health-check narration).
 * @param {{ positions?: object[], totals?: object, performance?: object }} args
 * @returns {string}
 */
export function buildHealthSummary({ positions = [], totals = {}, performance = {} } = {}) {
  const lines = ['🩺 HEALTH CHECK', ''];
  lines.push(`Open positions: ${positions.length}`);
  lines.push(`Portfolio value: $${fmt(totals.value_usd)}`);
  lines.push(`Unclaimed fees: $${fmt(totals.unclaimed_usd)}`);
  if (performance && performance.closed_count != null) {
    lines.push(`Closed (all-time): ${performance.closed_count} | win rate ${fmt(performance.win_rate, 0)}% | avg PnL ${fmt(performance.avg_pnl_pct)}%`);
  }
  lines.push('');
  for (const p of positions) {
    const inRange = p.in_range ? '🟢 IN' : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
    lines.push(`${p.pair ?? p.pool_name ?? '?'} | PnL ${fmt(p.pnl_pct)}% | yield ${p.fee_per_tvl_24h ?? '?'}% | ${inRange}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/reports.test.js`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git -C "D:\code\projects\meridian" add reports.js test/reports.test.js
git -C "D:\code\projects\meridian" commit -m "feat: code-built deploy report and health summary"
```

---

## Task 3: Wire new tests into test:unit

**Files:**
- Modify: `package.json` (the `test:unit` script line)

- [ ] **Step 1: Edit the script**

Find this line in `package.json`:

```json
    "test:unit": "node --test test/dry-run-pnl.test.js test/config-snapshot.test.js test/low-yield-gate.test.js",
```

Replace with:

```json
    "test:unit": "node --test test/dry-run-pnl.test.js test/config-snapshot.test.js test/low-yield-gate.test.js test/instruction-parser.test.js test/reports.test.js",
```

- [ ] **Step 2: Run the full unit suite**

Run: `npm --prefix "D:\code\projects\meridian" run test:unit`
Expected: PASS — all five files green, no failures.

- [ ] **Step 3: Commit**

```bash
git -C "D:\code\projects\meridian" add package.json
git -C "D:\code\projects\meridian" commit -m "test: add instruction-parser and reports to test:unit"
```

---

## Task 4: Add imports to index.js

**Files:**
- Modify: `index.js` (import block near the top, around lines 6-12)

- [ ] **Step 1: Add the imports**

Find the line:

```js
import { agentLoop } from "./agent.js";
```

Add immediately after it:

```js
import { parseInstruction, evaluateInstruction } from "./instruction-parser.js";
import { buildDeployReport, buildHealthSummary } from "./reports.js";
```

- [ ] **Step 2: Syntax check**

Run: `node --check "D:\code\projects\meridian\index.js"`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git -C "D:\code\projects\meridian" add index.js
git -C "D:\code\projects\meridian" commit -m "chore: import deterministic helpers in index.js"
```

---

## Task 5: Screening cycle → deterministic deploy

**Files:**
- Modify: `index.js:616-695` (the `let deployAttempted = false;` block through the end of the `agentLoop` result handling, ending just before `} catch (error) {` at line 712)

- [ ] **Step 1: Replace the LLM block**

Replace everything from line 616 (`let deployAttempted = false;`) up to and including line 711 (the closing `}` of the `else if (!deploySucceeded) {` decision block, immediately before `} catch (error) {`) with:

```js
    // ── Deterministic deploy: top-scored survivor ──────────────────────
    // passing[] preserves getTopCandidates' score-descending order, so
    // passing[0] is the highest-scored candidate that cleared all filters.
    const best = passing[0];
    const bestActiveBin = activeBinResults[0]?.status === "fulfilled" ? activeBinResults[0].value?.binId : null;
    const binsBelow = computeBinsBelow(best.pool.volatility);

    let deployAttempted = false;
    let deploySucceeded = false;
    let deployResult = null;
    try {
      deployAttempted = true;
      deployResult = await executeTool("deploy_position", {
        pool_address: best.pool.pool,
        amount_y: deployAmount,
        strategy: deployStrategy,
        bins_below: binsBelow,
        bins_above: 0,
        pool_name: best.pool.name,
        base_mint: best.pool.base?.mint || best.pool.base_mint || null,
        bin_step: best.pool.bin_step,
        base_fee: best.pool.base_fee,
        volatility: best.pool.volatility,
        fee_tvl_ratio: best.pool.fee_active_tvl_ratio ?? best.pool.fee_tvl_ratio,
        organic_score: best.pool.organic_score,
        initial_value_usd: best.pool.tvl ?? best.pool.active_tvl ?? null,
      });
      deploySucceeded = Boolean(deployResult && deployResult.success !== false && !deployResult.error && !deployResult.blocked);
    } catch (e) {
      log("cron_error", `Deploy failed: ${e.message}`);
      deployResult = { error: e.message };
    }

    if (deploySucceeded) {
      screenReport = buildDeployReport({
        candidate: { ...best.pool, active_bin: bestActiveBin },
        audit: {
          top10Pct: best.ti?.audit?.top_holders_pct ?? "?",
          botPct: best.ti?.audit?.bot_holders_pct ?? "?",
          feesSol: best.ti?.global_fees_sol ?? "?",
          smartWallets: best.sw?.in_pool?.map((w) => w.name).join(", ") || "none",
        },
        deployResult,
        deployAmount,
        strategy: deployStrategy,
      });
      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        summary: `Deployed ${deployAmount} SOL into ${best.pool.name}`,
        reason: "Top-scored surviving candidate",
        pool: best.pool.pool,
        pool_name: best.pool.name,
        metrics: {
          fee_tvl_ratio: best.pool.fee_active_tvl_ratio ?? best.pool.fee_tvl_ratio,
          organic_score: best.pool.organic_score,
          volatility: best.pool.volatility,
        },
      });
    } else {
      screenReport = `⛔ NO DEPLOY\n\n${best.pool.name}\n\nDeploy did not succeed: ${deployResult?.error || deployResult?.blocked || "unknown"}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No deploy",
        reason: String(deployResult?.error || deployResult?.blocked || "deploy failed").slice(0, 500),
        pool: best.pool.pool,
        pool_name: best.pool.name,
      });
    }
```

> Note: this removes the `agentLoop(...)` call, its `onToolStart/onToolFinish` live-message handlers, and the `/⛔\s*NO DEPLOY/i.test(content)` branch. The `liveMessage` finalize call in the existing `finally` block (lines 717-722) stays unchanged and still renders `screenReport`.

- [ ] **Step 2: Syntax check**

Run: `node --check "D:\code\projects\meridian\index.js"`
Expected: no output (valid).

- [ ] **Step 3: Verify no agentLoop remains in screening**

Run: `node -e "const s=require('fs').readFileSync('D:/code/projects/meridian/index.js','utf8').split('\n').slice(456,725).join('\n'); console.log(/agentLoop/.test(s) ? 'STILL PRESENT' : 'clean')"`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git -C "D:\code\projects\meridian" add index.js
git -C "D:\code\projects\meridian" commit -m "feat: deterministic screening deploy (top-scored survivor, no LLM)"
```

---

## Task 6: Management cycle → deterministic dispatch

**Files:**
- Modify: `index.js:340-377` (the `if (actionPositions.length > 0) { ... } else { ... }` block that contains the `agentLoop` call)

- [ ] **Step 1: Replace the LLM dispatch block**

Replace the block from line 340 (`if (actionPositions.length > 0) {`) through line 377 (the closing `}` of the `else` branch, immediately before the `// Trigger screening after management` comment) with:

```js
    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — deterministic dispatch`);
      const resultLines = [];
      for (const p of actionPositions) {
        const act = actionMap.get(p.position);
        try {
          if (act.action === "CLOSE") {
            await liveMessage?.toolStart("close_position");
            const r = await executeTool("close_position", { position: p.position });
            const ok = r && r.success !== false && !r.error;
            await liveMessage?.toolFinish("close_position", r, ok);
            resultLines.push(`${p.pair}: ${ok ? "✅ closed" : `❌ close failed (${r?.error || "?"})`} — ${act.reason || act.rule || "exit"}`);
          } else if (act.action === "CLAIM") {
            await liveMessage?.toolStart("claim_fees");
            const r = await executeTool("claim_fees", { position: p.position });
            const ok = r && r.success !== false && !r.error;
            await liveMessage?.toolFinish("claim_fees", r, ok);
            resultLines.push(`${p.pair}: ${ok ? "✅ claimed" : `❌ claim failed (${r?.error || "?"})`}`);
          } else if (act.action === "INSTRUCTION") {
            const parsed = parseInstruction(p.instruction);
            if (!parsed) {
              log("cron_warn", `Unparseable instruction for ${p.pair}: "${p.instruction}" — holding`);
              resultLines.push(`${p.pair}: ⏸ HOLD — instruction not understood (no LLM fallback)`);
            } else if (evaluateInstruction(parsed, p)) {
              await liveMessage?.toolStart("close_position");
              const r = await executeTool("close_position", { position: p.position });
              const ok = r && r.success !== false && !r.error;
              await liveMessage?.toolFinish("close_position", r, ok);
              resultLines.push(`${p.pair}: ${ok ? "✅ closed" : `❌ close failed (${r?.error || "?"})`} — instruction met (${parsed.metric} ${parsed.op} ${parsed.value})`);
            } else {
              resultLines.push(`${p.pair}: ⏸ HOLD — instruction condition not met`);
            }
          }
        } catch (e) {
          log("cron_error", `Management dispatch failed for ${p.pair}: ${e.message}`);
          resultLines.push(`${p.pair}: ❌ error — ${e.message}`);
        }
      }
      mgmtReport += `\n\n${resultLines.join("\n")}`;
    } else {
      log("cron", "Management: all positions STAY — no action");
      await liveMessage?.note("No tool actions needed.");
    }
```

> Note: this removes the `agentLoop(...)` call and its `actionBlocks` prompt construction. `actionMap`, `actionPositions`, `mgmtReport`, and `liveMessage` are all already defined above this block and remain in use.

- [ ] **Step 2: Syntax check**

Run: `node --check "D:\code\projects\meridian\index.js"`
Expected: no output (valid).

- [ ] **Step 3: Verify no agentLoop remains in management**

Run: `node -e "const s=require('fs').readFileSync('D:/code/projects/meridian/index.js','utf8').split('\n').slice(224,410).join('\n'); console.log(/agentLoop/.test(s) ? 'STILL PRESENT' : 'clean')"`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git -C "D:\code\projects\meridian" add index.js
git -C "D:\code\projects\meridian" commit -m "feat: deterministic management dispatch + instruction parser (no LLM)"
```

---

## Task 7: Health check → code summary

**Files:**
- Modify: `index.js:738-753` (the `healthTask` cron callback)

- [ ] **Step 1: Replace the LLM health check**

Replace the block from line 738 (`const healthTask = cron.schedule(\`0 * * * *\`, async () => {`) through line 753 (its closing `});`) with:

```js
  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      const snap = await getMyPositions({ force: true }).catch(() => null);
      const positions = snap?.positions || [];
      const totals = {
        value_usd: positions.reduce((s, p) => s + (p.total_value_usd ?? 0), 0),
        unclaimed_usd: positions.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0),
      };
      const summary = buildHealthSummary({ positions, totals });
      log("health", summary);
      if (telegramEnabled()) await sendMessage(summary).catch(() => {});
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });
```

- [ ] **Step 2: Syntax check**

Run: `node --check "D:\code\projects\meridian\index.js"`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git -C "D:\code\projects\meridian" add index.js
git -C "D:\code\projects\meridian" commit -m "feat: code-built health check (no LLM)"
```

---

## Task 8: Remove REPL free-form chat

**Files:**
- Modify: `index.js:1991-1997` (the `// ── Free-form chat ───` block in the REPL `rl.on("line")` handler)

- [ ] **Step 1: Replace the free-form chat block**

Replace the block from line 1991 (`// ── Free-form chat ───────────────────────`) through line 1997 (the closing `});` of the `runBusy(async () => { ... })` call) with:

```js
    // ── Free-form chat removed (deterministic daemon) ──
    console.log("\nNot a recognized command. Free-form LLM chat is disabled.");
    console.log("Available commands: status, positions, pool <n>, screen, candidates, deploy <n>, close <n>, closeall, set <n> <note>, pause, resume, help.\n");
    refreshPrompt();
```

- [ ] **Step 2: Syntax check**

Run: `node --check "D:\code\projects\meridian\index.js"`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git -C "D:\code\projects\meridian" add index.js
git -C "D:\code\projects\meridian" commit -m "feat: disable REPL free-form chat (deterministic commands only)"
```

---

## Task 9: Remove Telegram free-form chat

**Files:**
- Modify: `index.js:1644-1668` (the `busy = true;` try/catch/finally block at the end of `telegramHandler` that runs `agentLoop`)

- [ ] **Step 1: Replace the agentLoop block**

Replace the block from line 1644 (`busy = true;`) through line 1668 (the closing `}` of the `finally` block, immediately before the closing `}` of `telegramHandler`) with:

```js
  busy = true;
  try {
    log("telegram", `Incoming non-command (ignored): ${text}`);
    await sendMessage("Free-form chat is disabled. Use commands: /status /positions /screen /deploy /close /closeall /pause /resume /help").catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
```

> Note: removes the `agentLoop`, `createLiveMessage`, `appendHistory`, and the `isDeployRequest`/`agentRole`/`agentModel` lines (1648-1651) along with the `liveMessage` handling. The deterministic command routing earlier in `telegramHandler` is untouched.

- [ ] **Step 2: Syntax check**

Run: `node --check "D:\code\projects\meridian\index.js"`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git -C "D:\code\projects\meridian" add index.js
git -C "D:\code\projects\meridian" commit -m "feat: disable Telegram free-form chat"
```

---

## Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full syntax pass**

Run: `npm --prefix "D:\code\projects\meridian" run test:syntax`
Expected: completes with no `SyntaxError`.

- [ ] **Step 2: Full unit suite**

Run: `npm --prefix "D:\code\projects\meridian" run test:unit`
Expected: PASS — all five files green (dry-run-pnl, config-snapshot, low-yield-gate, instruction-parser, reports).

- [ ] **Step 3: Confirm no automatic agentLoop calls remain**

Run: `node -e "const s=require('fs').readFileSync('D:/code/projects/meridian/index.js','utf8'); const m=[...s.matchAll(/agentLoop/g)]; console.log('agentLoop refs in index.js:', m.length)"`
Expected: `agentLoop refs in index.js: 1` (only the `import` line remains; all call sites removed).

- [ ] **Step 4: Confirm the import is the only remaining reference**

Run: `node -e "const s=require('fs').readFileSync('D:/code/projects/meridian/index.js','utf8').split('\n'); s.forEach((l,i)=>{ if(/agentLoop/.test(l)) console.log((i+1)+': '+l.trim()); })"`
Expected: a single line — `import { agentLoop } from "./agent.js";`. If any call site prints, it was missed — go back and remove it.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git -C "D:\code\projects\meridian" add -A
git -C "D:\code\projects\meridian" commit -m "test: verify zero automatic LLM calls in daemon"
```

---

## Self-review notes

- **Spec coverage:** screening (Task 5), management + instruction parser (Tasks 1, 6), health check (Tasks 2, 7), GENERAL chat removal (Tasks 8, 9), reports (Task 2), tests (Tasks 1-3, 10). All spec sections mapped.
- **Behavior change flagged in spec:** 2+ survivors always deploys the top (Task 5) — intentional, no LLM veto.
- **Dormant code:** `agent.js`/`prompt.js` left intact; only the `import` reference remains (Task 10 step 4 asserts this).
- **Type consistency:** `parseInstruction` returns `{metric, op, value}`; `evaluateInstruction` consumes the same shape; `buildDeployReport`/`buildHealthSummary` signatures match their call sites in Tasks 5 and 7.
