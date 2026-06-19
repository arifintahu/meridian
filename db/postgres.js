import pg from 'pg';
const { Pool } = pg;

let _pool = null;

/**
 * Returns the shared pg Pool. Lazily created on first call.
 * Returns null if EXPERIMENT_POSTGRES_URL is not set.
 */
export function getPool() {
  if (_pool) return _pool;
  const url = process.env.EXPERIMENT_POSTGRES_URL;
  if (!url) return null;
  // connectionTimeoutMillis caps how long a query waits for a connection so the
  // startup reconcile (db/experiments.js) can't hang the daemon on a dead host.
  _pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000 });
  _pool.on('error', (err) => {
    console.error('[experiment-pg] pool error:', err.message);
  });
  return _pool;
}

/**
 * Close the pool (call on graceful shutdown).
 */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
