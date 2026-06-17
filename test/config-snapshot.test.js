import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotConfig } from '../config.js';

describe('snapshotConfig', () => {
  it('captures the tuning sections', () => {
    const snap = snapshotConfig();
    for (const k of ['risk', 'screening', 'management', 'strategy', 'schedule', 'signalStaging', 'indicators']) {
      assert.ok(snap[k], `missing section: ${k}`);
    }
    assert.equal(typeof snap.management.stopLossPct, 'number');
    assert.equal(typeof snap.screening.minTvl, 'number');
    assert.equal(typeof snap.strategy.strategy, 'string');
  });

  it('has no LLM section (deterministic daemon)', () => {
    const snap = snapshotConfig();
    assert.equal(snap.llm, undefined);
    assert.equal(snap.darwin, undefined);
    assert.equal(typeof snap.signalStaging.enabled, 'boolean');
  });

  it('strips secret-bearing sections entirely', () => {
    const snap = snapshotConfig();
    assert.equal(snap.api, undefined);
    assert.equal(snap.jupiter, undefined);
    assert.equal(snap.hiveMind, undefined);
    assert.equal(snap.tokens, undefined);

    const serialized = JSON.stringify(snap);
    for (const needle of ['apiKey', 'referralAccount', 'walletKey', 'privateKey']) {
      assert.ok(!serialized.includes(needle), `snapshot leaked: ${needle}`);
    }
  });
});
