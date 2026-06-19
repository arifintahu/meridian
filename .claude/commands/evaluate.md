---
description: Evaluate a dry-run experiment — queries the remote experiment Postgres (EXPERIMENT_POSTGRES_URL), analyses results, recommends config changes, then applies + commits the approved change to the tracked user-config.json
---

Evaluate dry-run experiment results and recommend config changes.

## Usage

```
/evaluate [experiment-label-or-id]
```

- No args → list recent experiments, ask which to evaluate
- With label/id → evaluate that experiment

> **Data source:** experiments are read from the remote Postgres
> (`EXPERIMENT_POSTGRES_URL`), not local SQLite. The daemon writes to local
> SQLite and the outbox worker (`db/sync.js`) syncs to Postgres, so runs from
> other runners only exist in Postgres. The `scripts/eval-query.js` helper
> loads `.env`, connects to Postgres, and normalises types (BIGINT/NUMERIC →
> numbers, JSONB → JSON strings) so the analysis below is unchanged.

## Steps

### 1. Find experiments

```bash
node scripts/eval-query.js list
```

If no label/id given, show the list and ask the user which to evaluate.

### 2. Load positions and screening events

Pass the experiment label or id (prints `not found` if it doesn't exist):

```bash
node scripts/eval-query.js load LABEL_OR_ID
```

This prints four sections — `=== EXPERIMENT ===`, `=== SCREENING ===`,
`=== CLOSED POSITIONS ===`, `=== OPEN POSITIONS ===` — each as JSON. The
`config_snapshot` and `signal_snapshot` fields are JSON strings (parse them).

### 3. Analyse and present

Compute and present:

**Performance summary:**
- Total closed positions, win rate (pnl_pct > 0), avg PnL%, median PnL%
- Total fees earned, avg range efficiency, avg hold time (minutes_held)
- Exit reason breakdown (close_reason counts)
- Best 3 and worst 3 positions: pool_name, pnl_pct, close_reason, range_efficiency

**Signal correlations:**
- For each signal in `signal_snapshot` JSON: compare average value for winning vs losing positions
- Signals: organic_score, fee_tvl_ratio, volatility, entry_mcap, entry_tvl

**Config snapshot:** parse `exp.config_snapshot` and show the screening/management thresholds that were active.

**Recommendations:**
Suggest specific `user-config.json` key changes based on evidence. Show as a diff block:
```json
{
  "minOrganic": 60 → 70,
  "stopLossPct": -50 → -35
}
```
Only recommend changes with clear evidence. Warn if fewer than 5 closed positions.

### 4. Apply and commit the recommendation

`user-config.json` is git-tracked and the daemon no longer auto-evolves it, so
`/evaluate` is the deliberate path for config changes. Apply, then commit, so the
change is versioned and deploys via `git pull` on the runner.

If the user approves a recommendation:
1. Read current `user-config.json`.
2. Show the exact diff (old → new for each key).
3. Wait for explicit confirmation.
4. Edit `user-config.json` with the approved values.
5. Verify it still parses: `node -e "JSON.parse(require('fs').readFileSync('user-config.json','utf8'));console.log('valid')"`.
6. Commit it so the change is tracked and deployable:
   ```bash
   git add user-config.json
   git commit -m "tune: <changed-keys> from <experiment-label> evaluation"
   ```
7. Confirm what was committed and that the runner can pick it up with `git pull`.

## Guardrails
- Never apply config changes without explicit user confirmation.
- Config changes go through git: tune here, commit, `git pull` on the runner —
  never hand-edit `user-config.json` on the deploy box (it would diverge).
- Only commit `user-config.json` — never stage `.env`, `state.json`, or other
  runtime/secret files in the same commit.
- Never edit `.env` files.
- Warn clearly if fewer than 5 closed positions.
