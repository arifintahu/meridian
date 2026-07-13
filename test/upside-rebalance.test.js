import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { isUpsideRebalanceEligible, recordRebalance, trackPosition, getTrackedPosition } from '../state.js';
import { repoPath } from '../repo-root.js';

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
  it('defaults a missing rebalanceMaxCount to 0 (ineligible — fail-closed)', () => {
    assert.equal(isUpsideRebalanceEligible({ ...base, rebalanceMaxCount: undefined }), false);
  });
});

describe('recordRebalance', () => {
  // state.js has no test seam (no STATE_FILE env override / setter) and no other
  // test in this repo touches load()/save() against the real state.json — it's a
  // live file with real position data, so back it up and restore it around this
  // suite rather than inventing a new mocking mechanism.
  const STATE_FILE = repoPath('state.json');
  const TEST_POSITION = '__test_recordRebalance_position__';
  let backup;

  before(() => {
    backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
  });

  after(() => {
    if (backup !== null) {
      fs.writeFileSync(STATE_FILE, backup);
    } else if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  });

  beforeEach(() => {
    trackPosition({
      position: TEST_POSITION,
      pool: 'TestPool11111111111111111111111111111111',
      pool_name: 'TEST/SOL',
      strategy: 'bid_ask',
      bin_range: { min: -10, max: 0 },
      amount_sol: 1,
      active_bin: 0,
    });
  });

  it('increments rebalance_count from 0', () => {
    assert.equal(getTrackedPosition(TEST_POSITION).rebalance_count, 0);
    recordRebalance(TEST_POSITION, { newBinRange: { min: -5, max: 20 }, newAmountSol: 1.5 });
    assert.equal(getTrackedPosition(TEST_POSITION).rebalance_count, 1);
  });

  it('overwrites bin_range, active_bin_at_deploy, and amount_sol to the new values', () => {
    const newBinRange = { min: -3, max: 25 };
    recordRebalance(TEST_POSITION, { newBinRange, newAmountSol: 2.5, harvestedSol: 0.1, compoundedSol: 0.05 });
    const pos = getTrackedPosition(TEST_POSITION);
    assert.deepEqual(pos.bin_range, newBinRange);
    assert.equal(pos.active_bin_at_deploy, newBinRange.max);
    assert.equal(pos.amount_sol, 2.5);
  });

  it('accumulates harvested_sol additively across two calls (not overwritten)', () => {
    recordRebalance(TEST_POSITION, { newBinRange: { min: -5, max: 10 }, newAmountSol: 1.1, harvestedSol: 0.2, compoundedSol: 0.1 });
    assert.ok(Math.abs(getTrackedPosition(TEST_POSITION).harvested_sol - 0.2) < 1e-9);
    recordRebalance(TEST_POSITION, { newBinRange: { min: -6, max: 12 }, newAmountSol: 1.3, harvestedSol: 0.15, compoundedSol: 0.05 });
    assert.ok(Math.abs(getTrackedPosition(TEST_POSITION).harvested_sol - 0.35) < 1e-9);
  });

  it('is a no-op for a non-existent position_address (does not throw)', () => {
    assert.doesNotThrow(() => {
      recordRebalance('__does_not_exist__', { newBinRange: { min: 0, max: 1 }, newAmountSol: 1 });
    });
    assert.equal(getTrackedPosition('__does_not_exist__'), null);
  });
});
