import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { repoPath } from '../repo-root.js';
import { insertOutbox } from './outbox.js';

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
