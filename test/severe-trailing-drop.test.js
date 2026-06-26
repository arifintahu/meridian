import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSevereTrailingDrop } from '../state.js';

// Default trailing target 1.5% → severe at drop >= 2 × 1.5 = 3.0%, or current PnL <= 0.
const t = 1.5;

describe('isSevereTrailingDrop', () => {
  it('is severe when all gains are given back (current PnL <= 0)', () => {
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 0, dropFromPeak: 2.0, trailingDropPct: t }), true);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: -3.58, dropFromPeak: 7.71, trailingDropPct: t }), true);
  });

  it('is severe when the drop reaches 2x the trailing target, even if still in profit', () => {
    // peaked +8%, now +5% → drop 3.0% == 2×1.5, still a +5% win but an unambiguous reversal
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 5, dropFromPeak: 3.0, trailingDropPct: t }), true);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 4, dropFromPeak: 4.0, trailingDropPct: t }), true);
  });

  it('is NOT severe for a marginal drop that stays in profit (keeps the 15s recheck)', () => {
    // the 3 winning trailing exits from exp-1f710961 were ~1.5-2% drops at positive PnL
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 1.84, dropFromPeak: 1.5, trailingDropPct: t }), false);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 2.6, dropFromPeak: 2.9, trailingDropPct: t }), false);
  });

  it('treats exactly 2x target as severe, just below as not', () => {
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 5, dropFromPeak: 3.0, trailingDropPct: t }), true);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 5, dropFromPeak: 2.99, trailingDropPct: t }), false);
  });

  it('honors a custom severeMult', () => {
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 3, dropFromPeak: 4.5, trailingDropPct: t, severeMult: 3 }), true);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 3, dropFromPeak: 4.4, trailingDropPct: t, severeMult: 3 }), false);
  });

  it('is not severe when inputs are missing (falls back to the recheck)', () => {
    assert.equal(isSevereTrailingDrop({ currentPnlPct: null, dropFromPeak: null, trailingDropPct: t }), false);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 2, dropFromPeak: null, trailingDropPct: t }), false);
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 2, dropFromPeak: 5, trailingDropPct: null }), false);
  });

  it('treats a positive current PnL above the floor with sub-threshold drop as not severe', () => {
    assert.equal(isSevereTrailingDrop({ currentPnlPct: 0.01, dropFromPeak: 2.0, trailingDropPct: t }), false);
  });
});
