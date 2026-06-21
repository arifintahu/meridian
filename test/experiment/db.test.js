import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createTestDb } from './helpers.js';
import { initDb } from '../../db/connection.js';
import { insertOutbox, getPendingOutbox, markOutboxSynced, markOutboxFailed } from '../../db/outbox.js';
import { createOrResumeExperiment, endExperiment, listExperiments, experimentsToCloseOnReconcile } from '../../db/experiments.js';
import { insertPosition, updatePositionClose, insertSnapshot, getPositions } from '../../db/positions.js';
import { insertScreeningEvent, getScreeningEvents } from '../../db/screening.js';

describe('db/connection', () => {
  it('creates all required tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);

    assert.ok(tables.includes('experiments'), 'experiments table missing');
    assert.ok(tables.includes('screening_events'), 'screening_events table missing');
    assert.ok(tables.includes('positions'), 'positions table missing');
    assert.ok(tables.includes('position_snapshots'), 'position_snapshots table missing');
    assert.ok(tables.includes('sync_outbox'), 'sync_outbox table missing');
    db.close();
  });

  it('enables WAL mode', () => {
    const tmpFile = path.join(os.tmpdir(), `meridian-test-${Date.now()}.sqlite`);
    try {
      const db = initDb(tmpFile);
      const row = db.prepare('PRAGMA journal_mode').get();
      assert.equal(row.journal_mode, 'wal');
      db.close();
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpFile + '-wal'); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpFile + '-shm'); } catch { /* ignore */ }
    }
  });
});

describe('db/outbox', () => {
  it('inserts and retrieves pending rows', () => {
    const db = createTestDb();
    insertOutbox(db, 'positions', 'uuid-1', { id: 'uuid-1', pool: 'ABC' });
    insertOutbox(db, 'screening_events', 'uuid-2', { id: 'uuid-2', type: 'deploy' });
    const rows = getPendingOutbox(db, 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].table_name, 'positions');
    assert.equal(rows[1].table_name, 'screening_events');
    db.close();
  });

  it('marks a row as synced', () => {
    const db = createTestDb();
    insertOutbox(db, 'positions', 'uuid-3', { id: 'uuid-3' });
    const [row] = getPendingOutbox(db, 1);
    markOutboxSynced(db, row.id);
    const remaining = getPendingOutbox(db, 10);
    assert.equal(remaining.length, 0);
    db.close();
  });

  it('marks a row as failed with error and increments attempts', () => {
    const db = createTestDb();
    insertOutbox(db, 'positions', 'uuid-4', { id: 'uuid-4' });
    const [row] = getPendingOutbox(db, 1);
    markOutboxFailed(db, row.id, 'connection refused');
    const failed = db.prepare("SELECT * FROM sync_outbox WHERE id = ?").get(row.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.error, 'connection refused');
    db.close();
  });
});

describe('db/experiments', () => {
  it('creates a new experiment', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 'exp-001', notes: 'baseline' });
    assert.equal(exp.label, 'exp-001');
    assert.equal(exp.notes, 'baseline');
    assert.ok(exp.id);
    assert.ok(exp.started_at > 0);
    db.close();
  });

  it('resumes existing experiment by label', () => {
    const db = createTestDb();
    const exp1 = createOrResumeExperiment(db, { label: 'exp-002' });
    const exp2 = createOrResumeExperiment(db, { label: 'exp-002' });
    assert.equal(exp1.id, exp2.id, 'same label should return same experiment');
    db.close();
  });

  it('lists experiments', () => {
    const db = createTestDb();
    createOrResumeExperiment(db, { label: 'exp-a' });
    createOrResumeExperiment(db, { label: 'exp-b' });
    const list = listExperiments(db);
    assert.equal(list.length, 2);
    db.close();
  });

  it('ends an experiment', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 'exp-end' });
    endExperiment(db, exp.id);
    const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(exp.id);
    assert.ok(row.ended_at > 0);
    db.close();
  });
});

describe('experimentsToCloseOnReconcile', () => {
  it('returns nothing when Postgres has no run for the label', () => {
    assert.deepEqual(experimentsToCloseOnReconcile(undefined, [{ id: 'a', started_at: 100 }]), []);
  });

  it('returns nothing when the latest Postgres run is still active', () => {
    const latest = { started_at: 200, ended_at: null };
    assert.deepEqual(experimentsToCloseOnReconcile(latest, [{ id: 'a', started_at: 100 }]), []);
  });

  it('closes a local run started at/before the latest ended Postgres run', () => {
    const latest = { started_at: 200, ended_at: 250 };
    assert.deepEqual(experimentsToCloseOnReconcile(latest, [{ id: 'old', started_at: 100 }]), ['old']);
    // boundary: equal started_at is the run Postgres ended → close it
    assert.deepEqual(experimentsToCloseOnReconcile(latest, [{ id: 'same', started_at: 200 }]), ['same']);
  });

  it('does NOT close a fresh local run newer than anything in Postgres (the double-create bug)', () => {
    // Postgres still shows the manually-ended run (#2); the just-created local
    // run (#3) has not synced yet, so its started_at is newer than Postgres's latest.
    const latest = { started_at: 1781854039383, ended_at: 1782010594972 };
    const freshLocal = [{ id: 'exp-f2533f16', started_at: 1782010594979 }];
    assert.deepEqual(experimentsToCloseOnReconcile(latest, freshLocal), []);
  });

  it('handles BIGINT-as-string from the pg driver', () => {
    const latest = { started_at: '200', ended_at: '250' };
    const open = [{ id: 'old', started_at: 100 }, { id: 'new', started_at: 999 }];
    assert.deepEqual(experimentsToCloseOnReconcile(latest, open), ['old']);
  });

  it('closes only the covered subset when both old and fresh rows are open', () => {
    const latest = { started_at: 500, ended_at: 600 };
    const open = [
      { id: 'old', started_at: 400 },   // covered → close
      { id: 'fresh', started_at: 700 }, // newer than Postgres → keep
    ];
    assert.deepEqual(experimentsToCloseOnReconcile(latest, open), ['old']);
  });
});

describe('db/positions', () => {
  it('inserts a position and queues outbox row', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 'p-test' });
    insertPosition(db, exp.id, {
      position: 'pos-abc',
      pool: 'pool-xyz',
      pool_name: 'TEST-SOL',
      strategy: 'bid_ask',
      deployed_at: Date.now(),
      amount_sol: 0.5,
      bin_range: { lower: 100, upper: 200 },
      bin_step: 10,
      active_bin_at_deploy: 150,
      volatility: 45,
      fee_tvl_ratio: 0.08,
      organic_score: 70,
      entry_mcap: 500000,
      entry_tvl: 20000,
      entry_volume: 5000,
      entry_holders: 800,
      signal_snapshot: { organic_score: 70 },
    });
    const rows = getPositions(db, exp.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].position, 'pos-abc');
    assert.equal(rows[0].pool_name, 'TEST-SOL');
    const outbox = db.prepare("SELECT * FROM sync_outbox WHERE table_name = 'positions'").all();
    assert.equal(outbox.length, 1);
    db.close();
  });

  it('updates position on close', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 'p-close' });
    insertPosition(db, exp.id, { position: 'pos-close', pool: 'p', pool_name: 'X-SOL', deployed_at: Date.now(), amount_sol: 0.5 });
    updatePositionClose(db, 'pos-close', {
      closed_at: Date.now(),
      close_reason: 'stop_loss',
      minutes_held: 45,
      minutes_in_range: 30,
      range_efficiency: 66.7,
      fees_earned_usd: 0.8,
      pnl_usd: -1.2,
      pnl_pct: -8.5,
    });
    const [row] = getPositions(db, exp.id);
    assert.equal(row.close_reason, 'stop_loss');
    assert.equal(row.pnl_pct, -8.5);
    db.close();
  });

  it('inserts position snapshots', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 'p-snap' });
    insertSnapshot(db, exp.id, 'pos-snap', { pnl_pct: 2.1, in_range: true, fees_earned_usd: 0.3 });
    const row = db.prepare('SELECT * FROM position_snapshots WHERE position = ?').get('pos-snap');
    assert.equal(row.pnl_pct, 2.1);
    assert.equal(row.in_range, 1);
    db.close();
  });
});

describe('db/screening', () => {
  it('inserts a screening event and queues outbox', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 's-test' });
    insertScreeningEvent(db, exp.id, {
      type: 'deploy',
      pool: 'pool-abc',
      pool_name: 'TOKEN-SOL',
      reason: 'strong fee/TVL',
      summary: 'Deployed 0.5 SOL',
      risks: ['low holders'],
      metrics: { fee_tvl: 0.09, volatility: 40 },
      rejected: ['BadPool: fee/TVL 0.01%'],
    });
    const events = getScreeningEvents(db, exp.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'deploy');
    assert.equal(events[0].pool_name, 'TOKEN-SOL');
    const outbox = db.prepare("SELECT * FROM sync_outbox WHERE table_name = 'screening_events'").all();
    assert.equal(outbox.length, 1);
    db.close();
  });

  it('inserts skip and no_deploy events', () => {
    const db = createTestDb();
    const exp = createOrResumeExperiment(db, { label: 's-skip' });
    insertScreeningEvent(db, exp.id, { type: 'skip', reason: 'max positions' });
    insertScreeningEvent(db, exp.id, { type: 'no_deploy', reason: 'no candidates' });
    const events = getScreeningEvents(db, exp.id);
    assert.equal(events.length, 2);
    db.close();
  });
});
