import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUpsideRebalanceEligible } from '../state.js';

describe('isUpsideRebalanceEligible', () => {
  const base = { activeBin: 10, upperBin: 5, rebalanceCount: 0, rebalanceMaxCount: 5, enabled: true };

  it('eligible when active bin is above upper bin and under the cap', () => {
    assert.equal(isUpsideRebalanceEligible(base), true);
  });
  it('not eligible when disabled', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, enabled: false }), false);
  });
  it('not eligible when active bin equals upper bin (not an upside break)', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, activeBin: 5 }), false);
  });
  it('not eligible when active bin is below upper bin (downside — not our case)', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, activeBin: 2 }), false);
  });
  it('eligible at the last count before the cap', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, rebalanceCount: 4, rebalanceMaxCount: 5 }), true);
  });
  it('not eligible once the count reaches the cap', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, rebalanceCount: 5, rebalanceMaxCount: 5 }), false);
  });
  it('not eligible when activeBin is missing', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, activeBin: null }), false);
  });
  it('not eligible when upperBin is missing', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, upperBin: null }), false);
  });
  it('defaults a missing rebalanceCount to 0 (still eligible under a positive cap)', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, rebalanceCount: undefined }), true);
  });
});
