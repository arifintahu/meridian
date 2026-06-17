import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeployReport, buildHealthSummary } from '../reports.js';

describe('buildDeployReport', () => {
  it('renders deployed pool fields', () => {
    const out = buildDeployReport({
      candidate: { name: 'FOO-SOL', pool: 'PoolAddr', fee_active_tvl_ratio: 0.08, volume_window: 5000, tvl: 40000, volatility: 1.5, organic_score: 80, mcap: 1000000, active_bin: -393 },
      audit: { top10Pct: 30, botPct: 5, feesSol: 50, smartWallets: 'none' },
      deployResult: { range_coverage: { downside_pct: 12, upside_pct: 0, width_pct: 12 }, min_price: 0.001, max_price: 0.0012 },
      deployAmount: 0.5,
      strategy: 'bid_ask',
    });
    assert.match(out, /🚀 DEPLOYED/);
    assert.match(out, /FOO-SOL/);
    assert.match(out, /bid_ask/);
    assert.match(out, /12\.00% downside/);
    assert.match(out, /Top10: 30%/);
  });
  it('tolerates missing optional fields without throwing', () => {
    const out = buildDeployReport({ candidate: { name: 'BAR-SOL' }, deployResult: {}, deployAmount: 0.5, strategy: 'spot' });
    assert.match(out, /BAR-SOL/);
    assert.match(out, /\?% downside/);
  });
});

describe('buildHealthSummary', () => {
  it('renders portfolio summary', () => {
    const out = buildHealthSummary({
      positions: [{ pair: 'FOO-SOL', pnl_pct: 2.5, fee_per_tvl_24h: 8, in_range: true }],
      totals: { value_usd: 50, unclaimed_usd: 1.2 },
    });
    assert.match(out, /HEALTH CHECK/);
    assert.match(out, /Open positions: 1/);
    assert.match(out, /FOO-SOL/);
  });
  it('handles empty portfolio', () => {
    const out = buildHealthSummary({ positions: [], totals: {} });
    assert.match(out, /Open positions: 0/);
  });
});
