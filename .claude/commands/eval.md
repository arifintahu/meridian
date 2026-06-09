---
description: Evaluate a dry-run experiment — queries SQLite DB, analyses results, recommends config changes
---

Evaluate dry-run experiment results and recommend config changes.

## Usage

```
/eval [experiment-label-or-id]
```

- No args → list recent experiments, ask which to evaluate
- With label/id → evaluate that experiment

## Steps

### 1. Find experiments

```bash
node -e "
import('./db/connection.js').then(({ initDb }) => {
  const db = initDb();
  const rows = db.prepare('SELECT id, label, started_at, ended_at FROM experiments ORDER BY started_at DESC LIMIT 10').all();
  for (const r of rows) {
    const started = new Date(r.started_at).toISOString().slice(0,16);
    const ended = r.ended_at ? new Date(r.ended_at).toISOString().slice(0,16) : 'running';
    console.log(r.id, '|', r.label, '|', started, '->', ended);
  }
  db.close();
});
"
```

If no label/id given, show the list and ask the user which to evaluate.

### 2. Load positions and screening events

Replace `LABEL_OR_ID` with the experiment label or id:

```bash
node -e "
const LABEL = 'LABEL_OR_ID';
import('./db/connection.js').then(({ initDb }) => {
  const db = initDb();
  const exp = db.prepare('SELECT * FROM experiments WHERE label = ? OR id = ? ORDER BY started_at DESC LIMIT 1').get(LABEL, LABEL);
  if (!exp) { console.log('not found'); db.close(); return; }

  const positions = db.prepare('SELECT * FROM positions WHERE experiment_id = ? ORDER BY deployed_at ASC').all(exp.id);
  const closed = positions.filter(p => p.closed_at);
  const screening = db.prepare('SELECT type, COUNT(*) as n FROM screening_events WHERE experiment_id = ? GROUP BY type').all(exp.id);

  console.log('=== EXPERIMENT ===');
  console.log(JSON.stringify(exp, null, 2));
  console.log('=== SCREENING ===');
  console.log(JSON.stringify(screening, null, 2));
  console.log('=== CLOSED POSITIONS ===');
  console.log(JSON.stringify(closed, null, 2));
  console.log('=== OPEN POSITIONS ===');
  console.log(JSON.stringify(positions.filter(p => !p.closed_at), null, 2));
  db.close();
});
"
```

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

### 4. Apply config changes (optional)

If the user wants to apply recommendations:
1. Read current `user-config.json`
2. Show exact diff of what will change
3. Wait for explicit confirmation before editing

## Guardrails
- Never apply config changes without explicit user confirmation
- Never edit `.env` files
- Warn clearly if fewer than 5 closed positions
