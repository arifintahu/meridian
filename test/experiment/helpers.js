import { initDb } from '../../db/connection.js';

/**
 * Returns a fresh in-memory SQLite database for tests.
 * Each call creates an isolated DB with all tables.
 */
export function createTestDb() {
  return initDb(':memory:');
}
