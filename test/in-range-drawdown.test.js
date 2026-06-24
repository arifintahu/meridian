import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSustainedDrawdownClose, nextDrawdownClockState } from '../state.js';

const cfg = { drawdownExitPct: -10, drawdownWaitMinutes: 60, enabled: true };

describe('isSustainedDrawdownClose', () => {
  it('closes when PnL has sat below the floor past the wait window', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -12, minutesInDrawdown: 70, ...cfg }), true);
  });
  it('closes at the exact wait boundary, not one minute before', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -12, minutesInDrawdown: 60, ...cfg }), true);
    assert.equal(isSustainedDrawdownClose({ pnlPct: -12, minutesInDrawdown: 59, ...cfg }), false);
  });
  it('closes at the exact PnL floor boundary, not just above it', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -10, minutesInDrawdown: 70, ...cfg }), true);
    assert.equal(isSustainedDrawdownClose({ pnlPct: -9.99, minutesInDrawdown: 70, ...cfg }), false);
  });
  it('does NOT close when the feature is disabled', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -50, minutesInDrawdown: 999, ...cfg, enabled: false }), false);
  });
  it('does NOT close a fresh drawdown (clock just started)', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -20, minutesInDrawdown: 0, ...cfg }), false);
  });
  it('does NOT close when PnL has recovered above the floor', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: 1.5, minutesInDrawdown: 120, ...cfg }), false);
  });
  it('does NOT close when PnL is missing', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: null, minutesInDrawdown: 120, ...cfg }), false);
  });
  it('does NOT close when the clock has not been started (null minutes)', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -20, minutesInDrawdown: null, ...cfg }), false);
    assert.equal(isSustainedDrawdownClose({ pnlPct: -20, minutesInDrawdown: undefined, ...cfg }), false);
  });
  it('does NOT close when no floor is configured', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -50, minutesInDrawdown: 120, drawdownExitPct: null, drawdownWaitMinutes: 60, enabled: true }), false);
  });
  it('defaults the wait window to 60 when unset', () => {
    assert.equal(isSustainedDrawdownClose({ pnlPct: -12, minutesInDrawdown: 30, drawdownExitPct: -10, enabled: true }), false);
    assert.equal(isSustainedDrawdownClose({ pnlPct: -12, minutesInDrawdown: 90, drawdownExitPct: -10, enabled: true }), true);
  });
});

const MIN = 60_000;

describe('nextDrawdownClockState (grace-tolerant clock)', () => {
  it('starts the clock on the first below-floor tick', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: true, since: null, recoverySince: null, now: 1000, graceMin: 15 }),
      { since: 1000, recoverySince: null }
    );
  });
  it('keeps a running clock while still below the floor', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: true, since: 1000, recoverySince: null, now: 5000, graceMin: 15 }),
      { since: 1000, recoverySince: null }
    );
  });
  it('cancels a pending recovery when the bleed resumes below the floor', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: true, since: 1000, recoverySince: 4000, now: 5000, graceMin: 15 }),
      { since: 1000, recoverySince: null }
    );
  });
  it('does nothing when above the floor with no clock running', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: false, since: null, recoverySince: null, now: 1000, graceMin: 15 }),
      { since: null, recoverySince: null }
    );
  });
  it('opens a recovery window on the first above-floor tick (clock kept)', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: false, since: 0, recoverySince: null, now: 10 * MIN, graceMin: 15 }),
      { since: 0, recoverySince: 10 * MIN }
    );
  });
  it('tolerates a brief recovery shorter than the grace window (clock survives)', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: false, since: 0, recoverySince: 5 * MIN, now: 14 * MIN, graceMin: 15 }),
      { since: 0, recoverySince: 5 * MIN }
    );
  });
  it('clears the clock once a recovery is sustained past the grace window', () => {
    assert.deepEqual(
      nextDrawdownClockState({ inDrawdown: false, since: 0, recoverySince: 5 * MIN, now: 20 * MIN, graceMin: 15 }),
      { since: null, recoverySince: null }
    );
  });
  it('preserves the original start time across an isolated bounce (cumulative dwell)', () => {
    // t0: below floor → clock starts
    let s = nextDrawdownClockState({ inDrawdown: true, since: null, recoverySince: null, now: 0, graceMin: 15 });
    assert.deepEqual(s, { since: 0, recoverySince: null });
    // t+10m: brief pop above floor → recovery window opens, clock kept
    s = nextDrawdownClockState({ inDrawdown: false, since: s.since, recoverySince: s.recoverySince, now: 10 * MIN, graceMin: 15 });
    assert.deepEqual(s, { since: 0, recoverySince: 10 * MIN });
    // t+20m: back below floor before the 15m grace elapsed → recovery cancelled, original start intact
    s = nextDrawdownClockState({ inDrawdown: true, since: s.since, recoverySince: s.recoverySince, now: 20 * MIN, graceMin: 15 });
    assert.deepEqual(s, { since: 0, recoverySince: null });
  });
});
