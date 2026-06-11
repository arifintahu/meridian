import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLowYieldClose } from '../state.js';

const cfg = { minFeePerTvl24h: 7, minAgeBeforeYieldCheck: 60 };

describe('isLowYieldClose', () => {
  it('closes when aged past the gate and yield is below the floor', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 3, ageMinutes: 70, ...cfg }), true);
  });
  it('closes at the exact age-gate boundary, not one minute before', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 3, ageMinutes: 60, ...cfg }), true);
    assert.equal(isLowYieldClose({ feePerTvl24h: 3, ageMinutes: 59, ...cfg }), false);
  });
  it('does NOT close a brand-new position (age 0)', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 0, ageMinutes: 0, ...cfg }), false);
  });
  it('does NOT close when age is null/undefined (the regression — null age bypassed the gate)', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 0, ageMinutes: null, ...cfg }), false);
    assert.equal(isLowYieldClose({ feePerTvl24h: 0, ageMinutes: undefined, ...cfg }), false);
  });
  it('does NOT close when fee/TVL data is missing', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: null, ageMinutes: 70, ...cfg }), false);
  });
  it('does NOT close when yield is at/above the floor', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 8, ageMinutes: 70, ...cfg }), false);
  });
  it('does NOT close when no floor is configured', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 3, ageMinutes: 70, minFeePerTvl24h: null, minAgeBeforeYieldCheck: 60 }), false);
  });
  it('defaults the age gate to 60 when unset', () => {
    assert.equal(isLowYieldClose({ feePerTvl24h: 3, ageMinutes: 30, minFeePerTvl24h: 7 }), false);
    assert.equal(isLowYieldClose({ feePerTvl24h: 3, ageMinutes: 90, minFeePerTvl24h: 7 }), true);
  });
});
