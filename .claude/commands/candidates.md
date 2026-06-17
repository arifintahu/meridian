---
description: Fetch and analyse top pool candidates (deterministic screening view)
---
Fetch the top enriched pool candidates and analyse them the way the deterministic screener does.

```
!`node cli.js candidates --limit 5`
```

Assess each candidate against the active config thresholds — these are the hard filters the daemon applies, so check `user-config.json` for the current values:

- fee/active-TVL ratio ≥ `minFeeActiveTvlRatio` (default `0.08`) — higher is better
- organic score ≥ `minOrganic` (default `60`), prefer 70+
- bot holders ≤ `maxBotHoldersPct` (default `30%`) — reject above
- top-10 concentration ≤ `maxTop10Pct` (default `60%`) — reject above
- TVL within `minTvl`–`maxTvl`, mcap within `minMcap`–`maxMcap`
- bin step within `minBinStep`–`maxBinStep`
- not on cooldown (pool-memory) and not a PVP rival

The daemon scores survivors by `fee/TVL × 1000 + organic × 10 + volume/100 + holders/100` and deploys the top one. Rank the candidates the same way and note which (if any) the deterministic screener would pick.

To actually deploy, run `/screen` (the deterministic cycle) — don't hand-pick against the score.
