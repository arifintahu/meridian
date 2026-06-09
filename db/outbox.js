const MAX_ATTEMPTS = 10;

/**
 * Queue a row for Postgres sync.
 * @param {import('better-sqlite3').Database} db
 * @param {string} tableName
 * @param {string} rowId   - stable UUID for idempotent upsert
 * @param {object} payload - full row data
 */
export function insertOutbox(db, tableName, rowId, payload) {
  db.prepare(`
    INSERT INTO sync_outbox (table_name, row_id, payload, status, attempts)
    VALUES (?, ?, ?, 'pending', 0)
  `).run(tableName, rowId, JSON.stringify(payload));
}

/**
 * Get pending rows to sync, ordered oldest-first.
 */
export function getPendingOutbox(db, limit = 100) {
  return db.prepare(`
    SELECT * FROM sync_outbox
    WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY id ASC
    LIMIT ?
  `).all(MAX_ATTEMPTS, limit);
}

/**
 * Mark a row as successfully synced.
 */
export function markOutboxSynced(db, id) {
  db.prepare(`UPDATE sync_outbox SET status = 'synced' WHERE id = ?`).run(id);
}

/**
 * Mark a row as failed, increment attempt counter.
 */
export function markOutboxFailed(db, id, error) {
  db.prepare(`
    UPDATE sync_outbox
    SET status = 'failed',
        attempts = attempts + 1,
        last_attempt = ?,
        error = ?
    WHERE id = ?
  `).run(Date.now(), String(error).slice(0, 500), id);
}
