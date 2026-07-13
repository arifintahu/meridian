import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfigValue } from '../tools/executor.js';

describe('normalizeConfigValue — boolean key coercion', () => {
  // Regression test: these three keys were missing from executor.js's internal
  // booleanKeys Set, so update_config silently persisted 0/1 numbers instead of
  // true/false for them (coerceFiniteNumber(false) === 0, not an error).
  const booleanKeys = [
    'repeatDeployCooldownEnabled',
    'volatilitySizedDeployEnabled',
    'rebalanceOnUpsideBreakEnabled',
  ];

  for (const key of booleanKeys) {
    it(`${key}: false coerces to boolean false, not 0`, () => {
      const result = normalizeConfigValue(key, false);
      assert.equal(result, false);
      assert.equal(typeof result, 'boolean');
    });

    it(`${key}: true coerces to boolean true, not 1`, () => {
      const result = normalizeConfigValue(key, true);
      assert.equal(result, true);
      assert.equal(typeof result, 'boolean');
    });

    it(`${key}: string "false" coerces to boolean false`, () => {
      const result = normalizeConfigValue(key, 'false');
      assert.equal(result, false);
      assert.equal(typeof result, 'boolean');
    });
  }

  it('a genuinely numeric key still coerces to a number, not a boolean (control case)', () => {
    const result = normalizeConfigValue('rebalanceMaxCount', '5');
    assert.equal(result, 5);
    assert.equal(typeof result, 'number');
  });

  it('an already-correct boolean key (trailingTakeProfit) still works, unaffected by this fix', () => {
    assert.equal(normalizeConfigValue('trailingTakeProfit', false), false);
    assert.equal(typeof normalizeConfigValue('trailingTakeProfit', false), 'boolean');
  });
});
