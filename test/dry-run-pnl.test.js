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
