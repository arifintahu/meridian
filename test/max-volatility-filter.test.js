import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRawPoolScreeningRejectReason } from '../tools/screening.js';

// Screening config that passes every other hard filter; only maxVolatility varies per test.
const baseConfig = {
  excludeHighSupplyConcentration: true,
  minFeeActiveTvlRatio: 0.05,
  minTvl: 10_000, maxTvl: 150_000,
  minVolume: 500,
  minOrganic: 60, minQuoteOrganic: 60,
  minHolders: 500,
  minMcap: 150_000, maxMcap: 10_000_000,
  minBinStep: 80, maxBinStep: 125,
  allowedLaunchpads: [], blockedLaunchpads: [],
  minTokenAgeHours: null, maxTokenAgeHours: null,
  maxVolatility: 6,
};

// A pool that clears every filter but volatility, which the caller sets.
const poolWithVolatility = (volatility) => ({
  token_x: { market_cap: 300_000, organic_score: 75 },
  token_y: { organic_score: 75 },
  dlmm_params: { bin_step: 100 },
  tvl: 30_000,
  fee_active_tvl_ratio: 0.2,
  volatility,
  volume: 5_000,
  base_token_holders: 1_500,
});

describe('maxVolatility screening filter', () => {
  it('accepts a pool with no other issues when maxVolatility is unset (sanity)', () => {
    assert.equal(getRawPoolScreeningRejectReason(poolWithVolatility(3), { ...baseConfig, maxVolatility: null }), null);
  });

  it('rejects a pool whose volatility exceeds the cap', () => {
    const reason = getRawPoolScreeningRejectReason(poolWithVolatility(8), baseConfig);
    assert.match(reason, /above maxVolatility 6/);
  });

  it('accepts volatility exactly at the cap, rejects just above', () => {
    assert.equal(getRawPoolScreeningRejectReason(poolWithVolatility(6), baseConfig), null);
    assert.match(getRawPoolScreeningRejectReason(poolWithVolatility(6.01), baseConfig), /above maxVolatility/);
  });

  it('accepts low volatility below the cap', () => {
    assert.equal(getRawPoolScreeningRejectReason(poolWithVolatility(3), baseConfig), null);
  });

  it('does NOT cap volatility when maxVolatility is null (backward compatible)', () => {
    assert.equal(getRawPoolScreeningRejectReason(poolWithVolatility(30), { ...baseConfig, maxVolatility: null }), null);
  });

  it('still rejects unusable volatility regardless of the cap', () => {
    assert.match(getRawPoolScreeningRejectReason(poolWithVolatility(0), baseConfig), /unusable/);
  });
});
