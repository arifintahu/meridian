import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotConfig } from '../config.js';

describe('snapshotConfig', () => {
  it('captures the tuning sections', () => {
    const snap = snapshotConfig();
    for (const k of ['risk', 'screening', 'management', 'strategy', 'schedule', 'darwin', 'indicators', 'llm']) {
      assert.ok(snap[k], `missing section: ${k}`);
    }
    assert.equal(typeof snap.management.stopLossPct, 'number');
    assert.equal(typeof snap.screening.minTvl, 'number');
    assert.equal(typeof snap.strategy.strategy, 'string');
  });

  it('keeps llm model names but no provider keys', () => {
    const snap = snapshotConfig();
    assert.ok('managementModel' in snap.llm);
    assert.ok('screeningModel' in snap.llm);
    assert.ok('generalModel' in snap.llm);
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
