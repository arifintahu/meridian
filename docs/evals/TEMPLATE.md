---
experiment_id: <exp-xxxxxxxx>
label: <label>
evaluated_at: <YYYY-MM-DDTHH:MM:SSZ>   # <local time + tz>
status_at_eval: <running (N open positions) | ended YYYY-MM-DD>
closed_positions: <N>
commits:
  - <hash>  <commit subject>            # one line per related commit; omit list if none
---

# Evaluation — <exp-id> (`<label>`)

- **Experiment:** `<exp-id>` — label `<label>`
- **Started:** <YYYY-MM-DD HH:MM> UTC · **Status at eval:** <running (N open) | ended>
- **Evaluated:** <YYYY-MM-DD HH:MM> UTC (<local tz>)
- **Data source:** remote experiment Postgres (`EXPERIMENT_POSTGRES_URL`) via `scripts/eval-query.js`
- **Screening events:** <N> deploy · <N> no_deploy · <N> skip

---

## 1. Performance (<N> closed positions)

> ⚠️ If fewer than 5 closed positions, state this clearly — recommendations are low-confidence.

| Metric | Value |
|---|---|
| Win rate | <x>% of all (<y>% excl. break-even) — <w> win / <l> loss / <b> flat |
| Avg PnL% | <x>% |
| Median PnL% | <x>% |
| **Total PnL** | <$x> |
| Total fees earned | <$x> |
| Avg range efficiency | <x>% |
| Avg hold | <x> min |

### Exit-reason breakdown

| Reason | n | Avg PnL% |
|---|---|---|
| <reason> | <n> | <x>% |

### Best 3 / Worst 3

- ✅ <pool> <pnl>% (<reason>) · <pool> <pnl>% (<reason>) · <pool> <pnl>% (<reason>)
- ❌ <pool> <pnl>% (<reason>) · <pool> <pnl>% (<reason>) · <pool> <pnl>% (<reason>)

### Signal correlation (winners vs losers)

| Signal | Winners | Losers | Read |
|---|---|---|---|
| organic_score | <x> | <x> | <no signal / weak / strong> |
| fee_tvl_ratio | <x> | <x> | <…> |
| volatility | <x> | <x> | <…> |
| entry_mcap | <$x> | <$x> | <…> |
| entry_tvl | <$x> | <$x> | <…> |

---

## 2. Diagnosis

<2-4 sentences: what drove the result, where the PnL concentrated, what the signals
do (or don't) tell us. Distinguish tail-risk problems from selection problems.>

---

## 3. Config changes applied (commit `<hash>`)

> If no config change was made, write: **None — recommendations below were not applied.**

Edited `user-config.json` (git-tracked; runner picks up via `git pull`).

| Key | Before | After | Rationale |
|---|---|---|---|
| `<key>` | `<old>` | `<new>` | <evidence-based reason> |

```json
// before → after
{
  "<key>": <old>   // → <new>
}
```

**Not changed (mixed/weak evidence):** <keys + why held>.

---

## 4. Code changes (commit `<hash>`)

> If no code changed during this evaluation, write: **None — read-only evaluation.**
> Otherwise document each change as before/after so the doc is self-contained.

### <file path>

<why the change was needed>

```diff
- <before>
+ <after>
```
