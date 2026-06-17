import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstruction, evaluateInstruction } from '../instruction-parser.js';

describe('parseInstruction', () => {
  it('parses pnl above threshold', () => {
    assert.deepEqual(parseInstruction('close if pnl > 10%'), { metric: 'pnl_pct', op: '>=', value: 10 });
  });
  it('parses bare percentage as pnl below', () => {
    assert.deepEqual(parseInstruction('close below -5%'), { metric: 'pnl_pct', op: '<=', value: -5 });
  });
  it('parses value under dollar threshold', () => {
    assert.deepEqual(parseInstruction('close if value under $40'), { metric: 'value_usd', op: '<=', value: 40 });
  });
  it('returns null for ambiguous text', () => {
    assert.equal(parseInstruction('keep an eye on this one'), null);
  });
  it('returns null when both directions present', () => {
    assert.equal(parseInstruction('close if pnl above 10% or below -5%'), null);
  });
  it('returns null for empty/non-string', () => {
    assert.equal(parseInstruction(''), null);
    assert.equal(parseInstruction(null), null);
  });
});

describe('evaluateInstruction', () => {
  it('true when pnl meets >= condition', () => {
    assert.equal(evaluateInstruction({ metric: 'pnl_pct', op: '>=', value: 10 }, { pnl_pct: 12 }), true);
  });
  it('false when pnl below >= threshold', () => {
    assert.equal(evaluateInstruction({ metric: 'pnl_pct', op: '>=', value: 10 }, { pnl_pct: 8 }), false);
  });
  it('true when value meets <= condition', () => {
    assert.equal(evaluateInstruction({ metric: 'value_usd', op: '<=', value: 40 }, { total_value_usd: 35 }), true);
  });
  it('false when needed field missing', () => {
    assert.equal(evaluateInstruction({ metric: 'pnl_pct', op: '>=', value: 10 }, {}), false);
  });
  it('false for null parsed', () => {
    assert.equal(evaluateInstruction(null, { pnl_pct: 50 }), false);
  });
});
