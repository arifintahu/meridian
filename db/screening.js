import { v4 as uuidv4 } from 'uuid';
import { insertOutbox } from './outbox.js';

/**
 * Record one screening cycle decision.
 * @param {import('better-sqlite3').Database} db
 * @param {string} experimentId
 * @param {object} entry  - shape mirrors decision-log.js appendDecision output
 */
export function insertScreeningEvent(db, experimentId, entry) {
  const id = uuidv4();
  const row = {
    id,
    experiment_id: experimentId,
    ts:            Date.now(),
    type:          entry.type || 'note',
    pool:          entry.pool || null,
    pool_name:     entry.pool_name || null,
    reason:        entry.reason || null,
    summary:       entry.summary || null,
    risks:         JSON.stringify(entry.risks || []),
    metrics:       JSON.stringify(entry.metrics || {}),
    rejected:      JSON.stringify(entry.rejected || []),
  };
  db.prepare(`
    INSERT INTO screening_events
      (id, experiment_id, ts, type, pool, pool_name, reason, summary, risks, metrics, rejected)
    VALUES
      (@id, @experiment_id, @ts, @type, @pool, @pool_name, @reason, @summary, @risks, @metrics, @rejected)
  `).run(row);
  insertOutbox(db, 'screening_events', id, row);
}

/**
 * Get all screening events for an experiment.
 */
export function getScreeningEvents(db, experimentId) {
  return db.prepare('SELECT * FROM screening_events WHERE experiment_id = ? ORDER BY ts ASC').all(experimentId);
}
