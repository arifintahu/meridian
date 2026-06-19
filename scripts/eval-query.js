#!/usr/bin/env node
/**
 * Read-side queries for the /evaluate skill, against the remote experiment
 * Postgres (EXPERIMENT_POSTGRES_URL) — NOT the local SQLite.
 *
 * The daemon writes to local SQLite and an outbox worker syncs to Postgres
 * (see db/sync.js). Experiments produced on other runners only exist in
 * Postgres, so evaluation must read from there.
 *
 * Usage:
 *   node scripts/eval-query.js list
 *   node scripts/eval-query.js load <experiment-label-or-id>
 *
 * Output is shaped to match the old SQLite output the skill expects:
 *   - BIGINT/NUMERIC columns are returned as JS numbers
 *   - JSONB columns (config_snapshot, signal_snapshot, …) are re-serialised
 *     to JSON strings, so the analysis step can JSON.parse() them as before
 */

import 'dotenv/config';
import { getPool, closePool } from '../db/postgres.js';

// Columns that pg returns as strings (int8/numeric) but callers treat as numbers.
const NUMERIC_COLS = new Set([
  'started_at', 'ended_at', 'ts', 'deployed_at', 'closed_at',
  'amount_sol', 'bin_step', 'active_bin_at_deploy', 'volatility',
  'fee_tvl_ratio', 'organic_score', 'entry_mcap', 'entry_tvl',
  'entry_volume', 'entry_holders', 'minutes_held', 'minutes_in_range',
  'range_efficiency', 'fees_earned_usd', 'pnl_usd', 'pnl_pct', 'n',
]);

// Columns stored as JSONB in Postgres but as TEXT (JSON strings) in SQLite.
// Re-serialise so the skill's JSON.parse(...) calls keep working unchanged.
const JSON_COLS = new Set([
  'config_snapshot', 'signal_snapshot', 'bin_range', 'risks', 'metrics', 'rejected',
]);

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { out[k] = v; continue; }
    if (NUMERIC_COLS.has(k)) { out[k] = Number(v); continue; }
    if (JSON_COLS.has(k)) { out[k] = typeof v === 'object' ? JSON.stringify(v) : v; continue; }
    out[k] = v;
  }
  return out;
}

function requirePool() {
  const pool = getPool();
  if (!pool) {
    console.error('EXPERIMENT_POSTGRES_URL is not set — cannot read experiment data from Postgres.');
    console.error('Set it in .env (see .env.example) and retry.');
    process.exit(1);
  }
  return pool;
}

async function list() {
  const pool = requirePool();
  const { rows } = await pool.query(
    'SELECT id, label, started_at, ended_at FROM experiments ORDER BY started_at DESC LIMIT 10'
  );
  for (const raw of rows) {
    const r = normalizeRow(raw);
    const started = r.started_at ? new Date(r.started_at).toISOString().slice(0, 16) : '?';
    const ended = r.ended_at ? new Date(r.ended_at).toISOString().slice(0, 16) : 'running';
    console.log(r.id, '|', r.label, '|', started, '->', ended);
  }
}

async function load(labelOrId) {
  const pool = requirePool();
  const expRes = await pool.query(
    'SELECT * FROM experiments WHERE label = $1 OR id = $1 ORDER BY started_at DESC LIMIT 1',
    [labelOrId]
  );
  if (!expRes.rows.length) { console.log('not found'); return; }
  const exp = normalizeRow(expRes.rows[0]);

  const posRes = await pool.query(
    'SELECT * FROM positions WHERE experiment_id = $1 ORDER BY deployed_at ASC',
    [exp.id]
  );
  const positions = posRes.rows.map(normalizeRow);
  const closed = positions.filter((p) => p.closed_at);
  const open = positions.filter((p) => !p.closed_at);

  const scrRes = await pool.query(
    'SELECT type, COUNT(*)::int AS n FROM screening_events WHERE experiment_id = $1 GROUP BY type',
    [exp.id]
  );
  const screening = scrRes.rows.map(normalizeRow);

  console.log('=== EXPERIMENT ===');
  console.log(JSON.stringify(exp, null, 2));
  console.log('=== SCREENING ===');
  console.log(JSON.stringify(screening, null, 2));
  console.log('=== CLOSED POSITIONS (count=' + closed.length + ') ===');
  console.log(JSON.stringify(closed, null, 2));
  console.log('=== OPEN POSITIONS (count=' + open.length + ') ===');
  console.log(JSON.stringify(open, null, 2));
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'list') {
      await list();
    } else if (cmd === 'load') {
      if (!arg) { console.error('usage: node scripts/eval-query.js load <experiment-label-or-id>'); process.exit(1); }
      await load(arg);
    } else {
      console.error('usage: node scripts/eval-query.js <list|load> [label-or-id]');
      process.exit(1);
    }
  } finally {
    await closePool();
  }
}

main().catch((e) => {
  console.error('eval-query failed:', e.message);
  process.exit(1);
});
