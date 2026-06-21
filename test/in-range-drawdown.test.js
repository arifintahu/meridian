import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSustainedDrawdownClose } from '../state.js';

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
