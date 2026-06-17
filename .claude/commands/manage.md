---
description: Run one deterministic management cycle (evaluate positions, claim/close)
---
Run a single deterministic management cycle — the same rules the autopilot applies. It snapshots every open position, applies the fixed exit rules in priority order, and claims/closes accordingly.

Use the Bash tool, sequentially (never background, never parallel).

**1. (Optional) Inspect positions first**
```
node cli.js positions
```

**2. Run the cycle**
```
node cli.js manage --dry-run     # inspect, no on-chain transaction
node cli.js manage               # live
```

**3. Report**

Summarize per position what the cycle did (STAY / CLAIM / CLOSE) and why. The exit rules, in priority order:
1. **Stop-loss** — `pnl_pct <= stopLossPct` (default `-50`)
2. **Take-profit** — `pnl_pct >= takeProfitPct` (default `5`)
3. **Pumped far above range** — active bin far above the upper bin
4. **Out-of-range timeout** — OOR ≥ `outOfRangeWaitMinutes` (default `30`)
5. **Low yield** — `fee/TVL 24h < minFeePerTvl24h` (default `7`) after `minAgeBeforeYieldCheck` (default `60m`)

Plus **trailing take-profit** (a 30s poller arms at `trailingTriggerPct` and closes on a `trailingDropPct` drop from peak), fee **claim** when unclaimed ≥ `minClaimAmount`, and any free-text **position note** condition (parsed in code).

> All thresholds live in `user-config.json`. Change behavior there (use `/evaluate`) — don't close positions manually against the rules.
