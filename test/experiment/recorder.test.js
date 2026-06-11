import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.js';
import { createOrResumeExperiment } from '../../db/experiments.js';
import { initRecorder, getRecorder, clearRecorder } from '../../experiment-recorder.js';
import { getPositions } from '../../db/positions.js';
import { getScreeningEvents } from '../../db/screening.js';

describe('ExperimentRecorder', () => {
  let db, expId;

  beforeEach(() => {
    clearRecorder();
    db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: `test-${Date.now()}` });
    expId = exp.id;
  });

  it('getRecorder returns null before init', () => {
    assert.equal(getRecorder(), null);
  });

  it('getRecorder returns recorder after init', () => {
    initRecorder(db, expId);
    assert.ok(getRecorder() !== null);
  });

  it('recordScreening writes a screening_event row', () => {
    initRecorder(db, expId);
    getRecorder().recordScreening({ type: 'deploy', pool: 'p1', pool_name: 'X-SOL', reason: 'ok', risks: [], metrics: {}, rejected: [] });
    const events = getScreeningEvents(db, expId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'deploy');
    db.close();
  });

  it('recordDeploy writes a positions row', () => {
    initRecorder(db, expId);
    getRecorder().recordDeploy('pos-111', {
      pool: 'pool-1', pool_name: 'T-SOL', strategy: 'bid_ask',
      amount_sol: 0.5, bin_step: 10, volatility: 40, fee_tvl_ratio: 0.07,
      organic_score: 65, entry_mcap: 400000, entry_tvl: 18000,
      entry_volume: 4000, entry_holders: 700, signal_snapshot: {},
      bin_range: { lower: 100, upper: 200 }, active_bin_at_deploy: 150,
    });
    const positions = getPositions(db, expId);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].position, 'pos-111');
    db.close();
  });

  it('recordClose updates the positions row', () => {
    initRecorder(db, expId);
    getRecorder().recordDeploy('pos-222', { pool: 'p', pool_name: 'Y-SOL', amount_sol: 0.5 });
    getRecorder().recordClose('pos-222', {
      pool: 'p', pool_name: 'Y-SOL', strategy: 'bid_ask',
      amount_sol: 0.5, initial_value_usd: 50, final_value_usd: 48,
      fees_earned_usd: 1.2, fees_earned_sol: 0.008,
      minutes_held: 60, minutes_in_range: 50,
      close_reason: 'out_of_range', entry_mcap: 300000, entry_tvl: 12000,
      entry_volume: 3000, exit_mcap: 280000, exit_tvl: 11000, exit_volume: 2000,
      pnl_usd: -0.8, pnl_pct: -1.6, range_efficiency: 83.3,
    });
    const [row] = getPositions(db, expId);
    assert.equal(row.close_reason, 'out_of_range');
    assert.ok(row.pnl_pct !== null);
    db.close();
  });

  it('recordSnapshot writes a position_snapshots row', () => {
    initRecorder(db, expId);
    getRecorder().recordSnapshot('pool-snap', {
      position: 'pos-snap',
      pnl_pct: 1.5,
      out_of_range_since: null,
      total_fees_claimed_usd: 0.2
    });
    const row = db.prepare('SELECT * FROM position_snapshots WHERE position = ?').get('pos-snap');
    assert.ok(row);
    assert.equal(row.pnl_pct, 1.5);
    assert.equal(row.in_range, 1);
    assert.equal(row.fees_earned_usd, 0.2);
    db.close();
  });

  it('recordSnapshot uses unclaimed_fees_usd when total_fees_claimed_usd is absent (dry-run case)', () => {
    initRecorder(db, expId);
    getRecorder().recordSnapshot('pool-dry', {
      position: 'pos-dry',
      pnl_pct: 2.5,
      out_of_range_since: null,
      unclaimed_fees_usd: 0.35,
      // total_fees_claimed_usd absent — recordClaim is never called in dry-run
    });
    const row = db.prepare('SELECT * FROM position_snapshots WHERE position = ?').get('pos-dry');
    assert.ok(row);
    assert.equal(row.fees_earned_usd, 0.35);
    db.close();
  });

  it('recordSnapshot sums claimed + unclaimed fees (live position with prior claims)', () => {
    initRecorder(db, expId);
    getRecorder().recordSnapshot('pool-live', {
      position: 'pos-live',
      pnl_pct: 0.8,
      out_of_range_since: null,
      unclaimed_fees_usd: 0.05,
      total_fees_claimed_usd: 0.10,
    });
    const row = db.prepare('SELECT * FROM position_snapshots WHERE position = ?').get('pos-live');
    assert.ok(row);
    assert.ok(Math.abs(row.fees_earned_usd - 0.15) < 1e-9, `expected ~0.15, got ${row.fees_earned_usd}`);
    db.close();
  });
});
