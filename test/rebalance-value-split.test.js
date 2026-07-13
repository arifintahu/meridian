import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeRebalanceValueSplit } from '../tools/dlmm.js';

// Direct coverage for the pure value-split arithmetic used by rebalancePosition's
// DRY_RUN branch — these are the exact numbers a DRY_RUN validation experiment
// reads to judge whether the rebalance/harvest feature works. Only indirect
// coverage existed before (via dry-run-pnl.test.js's formula tests).

function assertConserved(legValueSol, feesSol, { harvestedSol, newAmountSol }) {
  assert.ok(
    Math.abs((harvestedSol + newAmountSol) - (legValueSol + feesSol)) < 1e-9,
    `harvestedSol (${harvestedSol}) + newAmountSol (${newAmountSol}) should equal legValueSol + feesSol (${legValueSol + feesSol})`,
  );
}

describe('computeRebalanceValueSplit', () => {
  it('compound_fees=true, partial harvest (2500 bps): conserves value, compounds fees into the leg first', () => {
    const legValueSol = 10;
    const feesSol = 0.5;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: true, withdrawBps: 2500 });
    assertConserved(legValueSol, feesSol, r);
    assert.ok(Math.abs(r.compoundedSol - feesSol) < 1e-9); // fees fully compounded
    // preHarvestValueSol = 10.5, harvested = 25% of 10.5 = 2.625
    assert.ok(Math.abs(r.harvestedSol - 2.625) < 1e-9);
    assert.ok(Math.abs(r.newAmountSol - 7.875) < 1e-9);
  });

  it('compound_fees=false, partial harvest (2500 bps): conserves value, fees pulled out entirely (uncompounded) plus a slice of principal', () => {
    const legValueSol = 10;
    const feesSol = 0.5;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: false, withdrawBps: 2500 });
    assertConserved(legValueSol, feesSol, r);
    assert.equal(r.compoundedSol, 0); // fees never enter the new leg
    // preHarvestValueSol = legValueSol only (10), harvested = 25% of 10 + all fees = 2.5 + 0.5 = 3.0
    assert.ok(Math.abs(r.harvestedSol - 3.0) < 1e-9);
    assert.ok(Math.abs(r.newAmountSol - 7.5) < 1e-9);
  });

  it('a third scenario with different magnitudes (small leg, larger relative fees, compound_fees=true)', () => {
    const legValueSol = 1.2345;
    const feesSol = 0.0678;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: true, withdrawBps: 4000 });
    assertConserved(legValueSol, feesSol, r);
    assert.ok(r.harvestedSol > 0 && r.newAmountSol > 0);
  });

  it('withdraw_bps=0 (no harvest, compound_fees=true): everything stays in the new leg', () => {
    const legValueSol = 5;
    const feesSol = 0.3;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: true, withdrawBps: 0 });
    assertConserved(legValueSol, feesSol, r);
    assert.equal(r.harvestedSol, 0);
    assert.ok(Math.abs(r.newAmountSol - (legValueSol + feesSol)) < 1e-9);
  });

  it('withdraw_bps=0 (no harvest, compound_fees=false): fees are still pulled out even though the harvest bps is 0', () => {
    const legValueSol = 5;
    const feesSol = 0.3;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: false, withdrawBps: 0 });
    assertConserved(legValueSol, feesSol, r);
    assert.ok(Math.abs(r.harvestedSol - feesSol) < 1e-9); // uncompounded fees always leave
    assert.ok(Math.abs(r.newAmountSol - legValueSol) < 1e-9);
  });

  it('withdraw_bps=10000 (full harvest, compound_fees=true): nothing stays in the new leg', () => {
    const legValueSol = 8;
    const feesSol = 0.4;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: true, withdrawBps: 10000 });
    assertConserved(legValueSol, feesSol, r);
    assert.equal(r.newAmountSol, 0);
    assert.ok(Math.abs(r.harvestedSol - (legValueSol + feesSol)) < 1e-9);
  });

  it('withdraw_bps=10000 (full harvest, compound_fees=false): nothing stays in the new leg', () => {
    const legValueSol = 8;
    const feesSol = 0.4;
    const r = computeRebalanceValueSplit({ legValueSol, feesSol, compoundFees: false, withdrawBps: 10000 });
    assertConserved(legValueSol, feesSol, r);
    assert.equal(r.newAmountSol, 0);
    assert.ok(Math.abs(r.harvestedSol - (legValueSol + feesSol)) < 1e-9);
  });

  it('newAmountSol is clamped at 0 (never negative) even in a degenerate case', () => {
    const r = computeRebalanceValueSplit({ legValueSol: 0, feesSol: 0, compoundFees: true, withdrawBps: 10000 });
    assert.equal(r.newAmountSol, 0);
    assert.equal(r.harvestedSol, 0);
  });
});
