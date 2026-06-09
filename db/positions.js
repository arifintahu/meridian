import { v4 as uuidv4 } from 'uuid';
import { insertOutbox } from './outbox.js';

/**
 * Insert a new dry-run position record.
 * @param {import('better-sqlite3').Database} db
 * @param {string} experimentId
 * @param {object} data
 */
export function insertPosition(db, experimentId, data) {
  const id = uuidv4();
  const row = {
    id,
    experiment_id:        experimentId,
    position:             data.position || null,
    pool:                 data.pool || null,
    pool_name:            data.pool_name || null,
    strategy:             data.strategy || null,
    deployed_at:          data.deployed_at || Date.now(),
    amount_sol:           data.amount_sol ?? null,
    bin_range:            JSON.stringify(data.bin_range || {}),
    bin_step:             data.bin_step ?? null,
    active_bin_at_deploy: data.active_bin_at_deploy ?? null,
    volatility:           data.volatility ?? null,
    fee_tvl_ratio:        data.fee_tvl_ratio ?? null,
    organic_score:        data.organic_score ?? null,
    entry_mcap:           data.entry_mcap ?? null,
    entry_tvl:            data.entry_tvl ?? null,
    entry_volume:         data.entry_volume ?? null,
    entry_holders:        data.entry_holders ?? null,
    signal_snapshot:      JSON.stringify(data.signal_snapshot || null),
    closed_at: null, close_reason: null, minutes_held: null,
    minutes_in_range: null, range_efficiency: null,
    fees_earned_usd: null, pnl_usd: null, pnl_pct: null,
  };

  db.prepare(`
    INSERT INTO positions
      (id, experiment_id, position, pool, pool_name, strategy, deployed_at,
       amount_sol, bin_range, bin_step, active_bin_at_deploy, volatility,
       fee_tvl_ratio, organic_score, entry_mcap, entry_tvl, entry_volume,
       entry_holders, signal_snapshot)
    VALUES
      (@id, @experiment_id, @position, @pool, @pool_name, @strategy, @deployed_at,
       @amount_sol, @bin_range, @bin_step, @active_bin_at_deploy, @volatility,
       @fee_tvl_ratio, @organic_score, @entry_mcap, @entry_tvl, @entry_volume,
       @entry_holders, @signal_snapshot)
  `).run(row);

  insertOutbox(db, 'positions', id, row);
  return id;
}

/**
 * Fill in close-time fields on an existing position row.
 * @param {import('better-sqlite3').Database} db
 * @param {string} positionAddress - the on-chain position address
 * @param {object} closeData
 */
export function updatePositionClose(db, positionAddress, closeData) {
  db.prepare(`
    UPDATE positions SET
      closed_at        = @closed_at,
      close_reason     = @close_reason,
      minutes_held     = @minutes_held,
      minutes_in_range = @minutes_in_range,
      range_efficiency = @range_efficiency,
      fees_earned_usd  = @fees_earned_usd,
      pnl_usd          = @pnl_usd,
      pnl_pct          = @pnl_pct
    WHERE position = @position AND closed_at IS NULL
  `).run({ ...closeData, position: positionAddress });

  // Re-queue updated row to outbox for Postgres sync
  const updated = db.prepare('SELECT * FROM positions WHERE position = ?').get(positionAddress);
  if (updated) insertOutbox(db, 'positions', updated.id, updated);
}

/**
 * Insert a periodic PnL snapshot for a position.
 */
export function insertSnapshot(db, experimentId, positionAddress, data) {
  const id = uuidv4();
  const row = {
    id,
    experiment_id:   experimentId,
    position:        positionAddress,
    ts:              Date.now(),
    pnl_pct:         data.pnl_pct ?? null,
    in_range:        data.in_range ? 1 : 0,
    fees_earned_usd: data.fees_earned_usd ?? null,
  };
  db.prepare(`
    INSERT INTO position_snapshots (id, experiment_id, position, ts, pnl_pct, in_range, fees_earned_usd)
    VALUES (@id, @experiment_id, @position, @ts, @pnl_pct, @in_range, @fees_earned_usd)
  `).run(row);
  insertOutbox(db, 'position_snapshots', id, row);
}

/**
 * Get all positions for an experiment.
 */
export function getPositions(db, experimentId) {
  return db.prepare('SELECT * FROM positions WHERE experiment_id = ? ORDER BY deployed_at ASC').all(experimentId);
}
