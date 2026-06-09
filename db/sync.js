/**
 * Background outbox sync worker.
 * Periodically pulls pending rows from SQLite and upserts them into Postgres.
 */

import { getPool } from './postgres.js';
import { getPendingOutbox, markOutboxSynced, markOutboxFailed } from './outbox.js';

/**
 * Maps table name to an upsert query builder.
 * Each builder accepts the full payload and returns { text, values } for pg.query.
 */
const UPSERT = {
  experiments: (payload) => ({
    text: `INSERT INTO experiments (id, label, started_at, ended_at, config_snapshot, notes)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (id) DO UPDATE SET
             ended_at = EXCLUDED.ended_at,
             config_snapshot = EXCLUDED.config_snapshot,
             notes = EXCLUDED.notes`,
    values: [
      payload.id, payload.label, payload.started_at, payload.ended_at,
      payload.config_snapshot, payload.notes,
    ],
  }),

  screening_events: (payload) => ({
    text: `INSERT INTO screening_events
             (id, experiment_id, ts, type, pool, pool_name, reason, summary, risks, metrics, rejected)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)
           ON CONFLICT (id) DO NOTHING`,
    values: [
      payload.id, payload.experiment_id, payload.ts, payload.type,
      payload.pool, payload.pool_name, payload.reason, payload.summary,
      payload.risks, payload.metrics, payload.rejected,
    ],
  }),

  positions: (payload) => ({
    text: `INSERT INTO positions
             (id, experiment_id, position, pool, pool_name, strategy, deployed_at,
              amount_sol, bin_range, bin_step, active_bin_at_deploy, volatility,
              fee_tvl_ratio, organic_score, entry_mcap, entry_tvl, entry_volume,
              entry_holders, signal_snapshot, closed_at, close_reason, minutes_held,
              minutes_in_range, range_efficiency, fees_earned_usd, pnl_usd, pnl_pct)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,
                   $18,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (id) DO UPDATE SET
             closed_at = EXCLUDED.closed_at, close_reason = EXCLUDED.close_reason,
             minutes_held = EXCLUDED.minutes_held, minutes_in_range = EXCLUDED.minutes_in_range,
             range_efficiency = EXCLUDED.range_efficiency, fees_earned_usd = EXCLUDED.fees_earned_usd,
             pnl_usd = EXCLUDED.pnl_usd, pnl_pct = EXCLUDED.pnl_pct`,
    values: [
      payload.id, payload.experiment_id, payload.position, payload.pool,
      payload.pool_name, payload.strategy, payload.deployed_at, payload.amount_sol,
      payload.bin_range, payload.bin_step, payload.active_bin_at_deploy, payload.volatility,
      payload.fee_tvl_ratio, payload.organic_score, payload.entry_mcap, payload.entry_tvl,
      payload.entry_volume, payload.entry_holders, payload.signal_snapshot, payload.closed_at,
      payload.close_reason, payload.minutes_held, payload.minutes_in_range,
      payload.range_efficiency, payload.fees_earned_usd, payload.pnl_usd, payload.pnl_pct,
    ],
  }),

  position_snapshots: (payload) => ({
    text: `INSERT INTO position_snapshots (id, experiment_id, position, ts, pnl_pct, in_range, fees_earned_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
    values: [
      payload.id, payload.experiment_id, payload.position,
      payload.ts, payload.pnl_pct, payload.in_range === 1, payload.fees_earned_usd,
    ],
  }),
};

let _timer = null;

/**
 * Start the background outbox sync worker.
 * @param {import('better-sqlite3').Database} db
 * @param {number} [intervalMs]
 */
export function startPostgresSync(db, intervalMs = Number(process.env.EXPERIMENT_SYNC_INTERVAL_MS) || 5000) {
  const pool = getPool();
  if (!pool) {
    console.log('[experiment-sync] No EXPERIMENT_POSTGRES_URL set — outbox sync disabled.');
    return;
  }
  _timer = setInterval(() => runSyncBatch(db, pool), intervalMs);
  console.log(`[experiment-sync] Outbox worker started (interval ${intervalMs}ms)`);
}

/**
 * Stop the background worker.
 */
export function stopPostgresSync() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * Run one batch of outbox syncs.
 * @private
 */
async function runSyncBatch(db, pool) {
  const rows = getPendingOutbox(db, Number(process.env.EXPERIMENT_SYNC_BATCH_SIZE) || 100);
  if (!rows.length) return;

  for (const row of rows) {
    const build = UPSERT[row.table_name];
    if (!build) {
      console.warn(`[sync] Unknown table "${row.table_name}" in outbox row ${row.id} — skipping`);
      markOutboxSynced(db, row.id);
      continue;
    }
    try {
      const payload = JSON.parse(row.payload);
      const query = build(payload);
      await pool.query(query);
      markOutboxSynced(db, row.id);
    } catch (err) {
      console.error(`[sync] Failed to sync row ${row.id} (${row.table_name}): ${err.message}`);
      markOutboxFailed(db, row.id, err.message);
    }
  }
}
