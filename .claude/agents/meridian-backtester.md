---
name: meridian-backtester
description: Stub for future backtesting against historical OHLCV data from Agent Meridian API. NOT YET IMPLEMENTED — this agent is a placeholder.
tools: Bash, Read
---

⚠️ **This agent is not yet implemented.**

The backtester will replay archived screening decisions against historical pool OHLCV data from the Agent Meridian API (`tools/agent-meridian.js`), similar to Charon's backtest runner.

Planned workflow:
1. Fetch historical pool OHLCV data for closed experiment positions
2. Replay bin-range logic against historical active bin data
3. Simulate exit triggers (stop loss, trailing TP, out-of-range, low yield)
4. Compare simulated vs actual exits to validate simulator accuracy
5. Run parameter sweeps (vary TP%, stop loss%, OOR wait) over historical data

For now, use `node eval-agent.js` to evaluate dry-run results.
