import Database from 'better-sqlite3';
import { repoPath } from '../repo-root.js';

const DEFAULT_DB_PATH = process.env.EXPERIMENT_DB_PATH || repoPath('experiment.sqlite');

const DDL_WAL = `PRAGMA journal_mode = WAL;`;

const DDL = `

CREATE TABLE IF NOT EXISTS experiments (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  config_snapshot TEXT,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS screening_events (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT REFERENCES experiments(id),
  ts            INTEGER,
  type          TEXT,
  pool          TEXT,
  pool_name     TEXT,
  reason        TEXT,
  summary       TEXT,
  risks         TEXT,
  metrics       TEXT,
  rejected      TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id                   TEXT PRIMARY KEY,
  experiment_id        TEXT REFERENCES experiments(id),
  position             TEXT,
  pool                 TEXT,
  pool_name            TEXT,
  strategy             TEXT,
  deployed_at          INTEGER,
  amount_sol           REAL,
  bin_range            TEXT,
  bin_step             INTEGER,
  active_bin_at_deploy INTEGER,
  volatility           REAL,
  fee_tvl_ratio        REAL,
  organic_score        REAL,
  entry_mcap           REAL,
  entry_tvl            REAL,
  entry_volume         REAL,
  entry_holders        INTEGER,
  signal_snapshot      TEXT,
  closed_at            INTEGER,
  close_reason         TEXT,
  minutes_held         REAL,
  minutes_in_range     REAL,
  range_efficiency     REAL,
  fees_earned_usd      REAL,
  pnl_usd              REAL,
  pnl_pct              REAL
);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id              TEXT PRIMARY KEY,
  experiment_id   TEXT,
  position        TEXT,
  ts              INTEGER,
  pnl_pct         REAL,
  in_range        INTEGER,
  fees_earned_usd REAL
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id           INTEGER PRIMARY KEY,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status);
CREATE INDEX IF NOT EXISTS idx_screening_exp  ON screening_events(experiment_id);
CREATE INDEX IF NOT EXISTS idx_positions_exp  ON positions(experiment_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_pos  ON position_snapshots(experiment_id, position);
`;

/**
 * Open (or create) the experiment SQLite database.
 * @param {string} [dbPath] - File path or ':memory:' for tests.
 * @returns {import('better-sqlite3').Database}
 */
export function initDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  // WAL mode requires a real file; skip for in-memory test databases
  if (dbPath !== ':memory:') {
    db.exec(DDL_WAL);
  }
  db.exec(DDL);
  return db;
}
