---
description: Run one deterministic screening cycle (find best pool and deploy if funded)
---
Run a single deterministic screening cycle — the same logic the autopilot uses. The cycle reads `user-config.json`, checks the Discord signal queue, applies all hard filters, scores the survivors, and deploys into the top-scored candidate if the wallet is funded.

Use the Bash tool, sequentially (never background, never parallel).

**1. Run the cycle**

Dry run (no on-chain transaction — recommended for inspection):
```
node cli.js screen --dry-run
```

Live:
```
node cli.js screen
```

**2. Report what happened**

The cycle prints a `🚀 DEPLOYED …` or `⛔ NO DEPLOY …` report. Summarize:
- Whether it deployed, into which pool, and the amount.
- If it skipped: the reason (insufficient funds, at `maxPositions`, no candidate passed the filters, or lone-candidate skip).

For the full rationale (scored candidates, rejected alternatives, metrics), read `decision-log.json`.

> The deploy decision is deterministic — the top-scored survivor of the hard filters (`fee/TVL × 1000 + organic × 10 + volume/100 + holders/100`). To change what it picks, edit `user-config.json` thresholds (use `/evaluate`), not by overriding the choice here.
