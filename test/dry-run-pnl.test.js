import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDryRunPnl, binWeight } from '../dry-run-pnl.js';

describe('binWeight', () => {
  it('bid_ask ramps up with distance from active (heaviest at far edge)', () => {
    // range [-10, 0], deploy at top D=0 → far edge is b=-10
    assert.ok(binWeight(-10, 0, -10, 0, 'bid_ask') > binWeight(-1, 0, -10, 0, 'bid_ask'));
  });
  it('spot is uniform', () => {
    assert.equal(binWeight(-10, 0, -10, 0, 'spot'), binWeight(-1, 0, -10, 0, 'spot'));
  });
  it('curve peaks at the active bin', () => {
    assert.ok(binWeight(0, 0, -10, 0, 'curve') > binWeight(-10, 0, -10, 0, 'curve'));
  });
  it('curve: weight at active bin equals maxDist + 1', () => {
    // D=0, L=-10, U=0 → maxDist=10, dist at b=0 is 0 → weight = 10 + 1 = 11
    assert.equal(binWeight(0, 0, -10, 0, 'curve'), 11);
  });
});

describe('simulateDryRunPnl — price PnL', () => {
  const base = {
    amountSol: 1, binRange: { min: -10, max: 0 }, activeBinAtDeploy: 0,
    binStep: 100, strategy: 'bid_ask', feePerTvl24h: 0, minutesInRange: 0, solPrice: 100,
  };

  it('price recovered above range → ~0 price PnL (single-sided SOL position)', () => {
    const r = simulateDryRunPnl({ ...base, currentActiveBin: 5 });
    assert.ok(Math.abs(r.price_pnl_sol) < 1e-9);
    assert.ok(Math.abs(r.pnl_pct) < 1e-6);
  });
  it('active bin unchanged (= deploy) → ~0 price PnL', () => {
    const r = simulateDryRunPnl({ ...base, currentActiveBin: 0 });
    assert.ok(Math.abs(r.price_pnl_sol) < 1e-9);
  });
  it('token dumped below range → loss', () => {
    const r = simulateDryRunPnl({ ...base, currentActiveBin: -20 });
    assert.ok(r.price_pnl_sol < 0);
    assert.ok(r.pnl_pct < 0);
  });
  it('deeper dump → bigger loss', () => {
    const a = simulateDryRunPnl({ ...base, currentActiveBin: -15 });
    const b = simulateDryRunPnl({ ...base, currentActiveBin: -30 });
    assert.ok(b.price_pnl_sol < a.price_pnl_sol);
  });
  it('bid_ask loses LESS than spot on a partial dip (liquidity sits at the far edge)', () => {
    // On a shallow dip only the near-D bins convert; bid_ask weights those lightly
    // (heavy weight sits on the deep, still-unconverted bins) → smaller realized loss.
    const bid  = simulateDryRunPnl({ ...base, strategy: 'bid_ask', currentActiveBin: -3 });
    const spot = simulateDryRunPnl({ ...base, strategy: 'spot',    currentActiveBin: -3 });
    assert.ok(bid.price_pnl_sol < 0 && spot.price_pnl_sol < 0);
    assert.ok(bid.price_pnl_sol > spot.price_pnl_sol); // bid_ask less negative
  });
});

describe('simulateDryRunPnl — fees', () => {
  const base = {
    amountSol: 1, binRange: { min: -10, max: 0 }, activeBinAtDeploy: 0, currentActiveBin: 0,
    binStep: 100, strategy: 'bid_ask', solPrice: 100,
  };

  it('accrues fees from pool yield over in-range time (7% over a full day)', () => {
    const r = simulateDryRunPnl({ ...base, feePerTvl24h: 7, minutesInRange: 1440 });
    assert.ok(Math.abs(r.fees_sol - 0.07) < 1e-9);       // 1 SOL × 7% × 1 day
    assert.ok(Math.abs(r.fees_earned_usd - 7) < 1e-6);   // × $100/SOL
  });
  it('half a day in range → half the fees', () => {
    const r = simulateDryRunPnl({ ...base, feePerTvl24h: 7, minutesInRange: 720 });
    assert.ok(Math.abs(r.fees_sol - 0.035) < 1e-9);
  });
  it('null fee/TVL → zero fees', () => {
    const r = simulateDryRunPnl({ ...base, feePerTvl24h: null, minutesInRange: 1440 });
    assert.equal(r.fees_sol, 0);
  });
});

describe('simulateDryRunPnl — guards', () => {
  it('falsy solPrice → USD fields 0 but pnl_pct still computed', () => {
    const r = simulateDryRunPnl({
      amountSol: 1, binRange: { min: -10, max: 0 }, activeBinAtDeploy: 0, currentActiveBin: -20,
      binStep: 100, strategy: 'bid_ask', feePerTvl24h: 0, minutesInRange: 0, solPrice: 0,
    });
    assert.equal(r.pnl_usd, 0);
    assert.ok(r.pnl_pct < 0);
  });
  it('null currentActiveBin → treated as unchanged (0 price PnL)', () => {
    const r = simulateDryRunPnl({
      amountSol: 1, binRange: { min: -10, max: 0 }, activeBinAtDeploy: 0, currentActiveBin: null,
      binStep: 100, strategy: 'bid_ask', feePerTvl24h: 0, minutesInRange: 0, solPrice: 100,
    });
    assert.ok(Math.abs(r.price_pnl_sol) < 1e-9);
  });
  it('single-bin range (L==U) with price below the bin → loss', () => {
    const r = simulateDryRunPnl({
      amountSol: 1, binRange: { min: 0, max: 0 }, activeBinAtDeploy: 0,
      currentActiveBin: -1, binStep: 100, strategy: 'bid_ask',
    });
    assert.ok(r.price_pnl_sol < 0);
  });
});

describe('simulateDryRunPnl — cumulative PnL across rebalances', () => {
  const base = {
    amountSol: 1, binRange: { min: -10, max: 0 }, activeBinAtDeploy: 0,
    binStep: 100, strategy: 'bid_ask', feePerTvl24h: 0, minutesInRange: 0, solPrice: 100,
  };

  it('without originalAmountSol/harvestedSol, denom/numerator reduce to the pre-rebalance-support formula', () => {
    // Reconstructs the exact formula simulateDryRunPnl used BEFORE this task (denom = amount,
    // numerator = pricePnlSol + feesSol, no harvested term) as an independent reference — computed
    // locally from base.amountSol and the returned breakdown fields, not by calling production code
    // for the denom/numerator logic — so this proves the new code path collapses to the old one
    // rather than just comparing two calls to the new function against each other.
    const r = simulateDryRunPnl({ ...base, currentActiveBin: -5 });
    const oldStyleDenom = base.amountSol > 0 ? base.amountSol : 1;
    const oldStylePnlPct = (r.price_pnl_sol + r.fees_sol) / oldStyleDenom * 100;
    assert.ok(Math.abs(r.pnl_pct - oldStylePnlPct) < 1e-6);
  });

  it('harvesting half the leg value preserves total cumulative value (no principal/profit double-count)', () => {
    // Leg 1: currentActiveBin -5 (below deploy D=0) gives the leg a genuinely nonzero price PnL
    // — some liquidity has converted to the base token and is marked at the lower current price.
    // No originalAmountSol/harvestedSol passed, so this is leg 1's own (first-entry) cumulative PnL.
    const leg1 = simulateDryRunPnl({ ...base, currentActiveBin: -5 });
    const leg1Amount = base.amountSol;
    const leg1TotalValue = leg1Amount + leg1.price_pnl_sol + leg1.fees_sol;

    // A real 50%-harvest rebalance splits the leg's total mark-to-market value: half is
    // withdrawn (harvestedSol), half is redeposited as the new leg's starting amount — this
    // mirrors rebalancePosition's newAmountSol/harvestedSol split in tools/dlmm.js, which is
    // itself a proportional (principal+profit) split, matching Meteora's on-chain semantics.
    const newAmount = leg1TotalValue * 0.5;
    const harvestedSol = leg1TotalValue * 0.5;

    // Leg 2 is checked immediately after the harvest — no further price movement (currentActiveBin
    // held at leg 1's deploy bin) — so leg 2's own price PnL/fees are 0 and the only cumulative
    // inputs are the carried-forward amount plus harvestedSol.
    const leg2 = simulateDryRunPnl({
      ...base,
      amountSol: newAmount,
      originalAmountSol: leg1Amount,
      harvestedSol,
      currentActiveBin: base.activeBinAtDeploy,
    });

    // A harvest just moves value from "in the leg" to "withdrawn" — total cumulative PnL must
    // be unchanged (money that was already there doesn't vanish, and no new money appears).
    assert.ok(Math.abs(leg2.pnl_pct - leg1.pnl_pct) < 1e-6);
  });

  it('compounding the full leg value back in preserves cumulative PnL (no reset toward 0%)', () => {
    // Same leg-1 setup as the harvest test above.
    const leg1 = simulateDryRunPnl({ ...base, currentActiveBin: -5 });
    const leg1Amount = base.amountSol;
    const leg1TotalValue = leg1Amount + leg1.price_pnl_sol + leg1.fees_sol;

    // Pure compound: nothing withdrawn — the entire leg value becomes the new leg's amount.
    const newAmount = leg1TotalValue;
    const harvestedSol = 0;

    const leg2 = simulateDryRunPnl({
      ...base,
      amountSol: newAmount,
      originalAmountSol: leg1Amount,
      harvestedSol,
      currentActiveBin: base.activeBinAtDeploy,
    });

    // Under the OLD formula (pnlSol = pricePnlSol + feesSol + harvested, both 0 for leg 2) this
    // would read ~0% regardless of leg 1's real gain/loss — the "reset to zero" bug. The new
    // formula must still report leg 1's cumulative PnL unchanged.
    assert.ok(Math.abs(leg2.pnl_pct - leg1.pnl_pct) < 1e-6);
  });

  it('a harvested amount cannot mask a real loss on the remaining leg', () => {
    // Plausible post-harvest leg-2 state: original capital 1 SOL, leg 2 carries 0.45 SOL,
    // a small 0.05 SOL harvest happened earlier — then the remaining leg dumps hard
    // (currentActiveBin far below range). The big loss on the live leg must dominate the
    // small prior harvest.
    const r = simulateDryRunPnl({ ...base, amountSol: 0.45, currentActiveBin: -20, originalAmountSol: 1, harvestedSol: 0.05 });
    assert.ok(r.pnl_pct < 0);
  });
});
