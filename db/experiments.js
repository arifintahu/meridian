import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { repoPath } from '../repo-root.js';
import { insertOutbox } from './outbox.js';
import { getPool } from './postgres.js';

/**
 * Create a new experiment or resume one with the same label.
 * @param {import('better-sqlite3').Database} db
 * @param {{ label: string, notes?: string, configSnapshot?: object }} opts
 */
export function createOrResumeExperiment(db, { label, notes = null, configSnapshot = null }) {
  const existing = db.prepare('SELECT * FROM experiments WHERE label = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(label);
  if (existing) {
    // Re-queue the experiment row so it reaches Postgres even if the outbox was
    // previously cleared or this is a fresh Postgres instance. The UPSERT in
    // sync.js is idempotent, so duplicate rows are harmless.
    insertOutbox(db, 'experiments', existing.id, existing);
    return existing;
  }

  const id = `exp-${uuidv4().slice(0, 8)}`;
  const snapshot = configSnapshot || loadUserConfig();
  db.prepare(`
    INSERT INTO experiments (id, label, started_at, config_snapshot, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, label, Date.now(), JSON.stringify(snapshot), notes);

  const saved = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  // Queue the experiment row BEFORE any child rows (screening_events, positions)
  // are inserted so Postgres FK constraints are satisfied when the outbox syncs.
  insertOutbox(db, 'experiments', id, saved);
  return saved;
}

/**
 * Mark an experiment as ended.
 */
export function endExperiment(db, id) {
  db.prepare('UPDATE experiments SET ended_at = ? WHERE id = ?').run(Date.now(), id);
  const updated = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  if (updated) insertOutbox(db, 'experiments', id, updated);
}

/**
 * Pure decision for reconcileEndedFromPostgres: given the latest Postgres run
 * for a label and the currently-open local rows, return the ids to close.
 *
 * Closes only rows the "latest ended" verdict actually covers — those started
 * at or before the latest known Postgres run. A local row *newer* than anything
 * in Postgres (started_at > latest.started_at) is a fresh run that simply hasn't
 * synced yet (the outbox lags ~5s); closing it would orphan it and make
 * createOrResumeExperiment() spawn a duplicate. Leaving it open lets the next
 * startup resume it instead — so repeated restarts are idempotent.
 *
 * @param {{ started_at: number|string, ended_at: number|string|null }|undefined} latest
 * @param {Array<{ id: string, started_at: number|string }>} openRows
 * @returns {string[]} ids to end
 */
export function experimentsToCloseOnReconcile(latest, openRows) {
  if (!latest || latest.ended_at == null) return [];
  const latestStartedAt = Number(latest.started_at);
  if (!Number.isFinite(latestStartedAt)) return [];
  return openRows
    .filter((row) => Number(row.started_at) <= latestStartedAt)
    .map((row) => row.id);
}

/**
 * Reconcile local experiment state against Postgres (the source of truth).
 *
 * If the most recent run for `label` has already ended in Postgres, close the
 * still-open local rows that verdict covers (see experimentsToCloseOnReconcile).
 * That way the subsequent createOrResumeExperiment() either resumes a fresh
 * not-yet-synced local run or starts a new exp id — never closes a brand-new run
 * and duplicates it.
 *
 * No-op when Postgres isn't configured (getPool() === null) or is unreachable —
 * in that case the original local-only resume behaviour stands.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} label
 */
export async function reconcileEndedFromPostgres(db, label) {
  const pool = getPool();
  if (!pool) return;

  let latest;
  try {
    const { rows } = await pool.query(
      'SELECT id, started_at, ended_at FROM experiments WHERE label = $1 ORDER BY started_at DESC LIMIT 1',
      [label]
    );
    latest = rows[0];
  } catch (err) {
    console.warn(`[experiment] Postgres reconcile skipped for "${label}": ${err.message}`);
    return;
  }

  // Only act when the source of truth says the latest run for this label ended.
  if (!latest || latest.ended_at == null) return;

  const open = db.prepare('SELECT id, started_at FROM experiments WHERE label = ? AND ended_at IS NULL').all(label);
  for (const id of experimentsToCloseOnReconcile(latest, open)) endExperiment(db, id);
}

/**
 * List all experiments ordered newest-first.
 */
export function listExperiments(db) {
  return db.prepare('SELECT * FROM experiments ORDER BY started_at DESC').all();
}

function loadUserConfig() {
  try {
    const p = repoPath('user-config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
