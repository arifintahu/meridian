#!/usr/bin/env node
/**
 * Creates Postgres tables for the experiment system.
 * Run once: node scripts/pg-migrate.js
 * Requires: docker compose up -d (or EXPERIMENT_POSTGRES_URL set)
 */

import 'dotenv/config';
import pg from 'pg';
const { Client } = pg;

const url = process.env.EXPERIMENT_POSTGRES_URL || 'postgres://meridian:meridian@localhost:5433/meridian';

const DDL = `
CREATE TABLE IF NOT EXISTS experiments (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  started_at      BIGINT,
  ended_at        BIGINT,
  config_snapshot JSONB,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS screening_events (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT REFERENCES experiments(id),
  ts            BIGINT,
  type          TEXT,
  pool          TEXT,
  pool_name     TEXT,
  reason        TEXT,
  summary       TEXT,
  risks         JSONB,
  metrics       JSONB,
  rejected      JSONB
);

CREATE TABLE IF NOT EXISTS positions (
  id                   TEXT PRIMARY KEY,
  experiment_id        TEXT REFERENCES experiments(id),
  position             TEXT,
  pool                 TEXT,
  pool_name            TEXT,
  strategy             TEXT,
  deployed_at          BIGINT,
  amount_sol           NUMERIC,
  bin_range            JSONB,
  bin_step             INTEGER,
  active_bin_at_deploy INTEGER,
  volatility           NUMERIC,
  fee_tvl_ratio        NUMERIC,
  organic_score        NUMERIC,
  entry_mcap           NUMERIC,
  entry_tvl            NUMERIC,
  entry_volume         NUMERIC,
  entry_holders        INTEGER,
  signal_snapshot      JSONB,
  closed_at            BIGINT,
  close_reason         TEXT,
  minutes_held         NUMERIC,
  minutes_in_range     NUMERIC,
  range_efficiency     NUMERIC,
  fees_earned_usd      NUMERIC,
  pnl_usd              NUMERIC,
  pnl_pct              NUMERIC
);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id              TEXT PRIMARY KEY,
  experiment_id   TEXT,
  position        TEXT,
  ts              BIGINT,
  pnl_pct         NUMERIC,
  in_range        BOOLEAN,
  fees_earned_usd NUMERIC
);

CREATE TABLE IF NOT EXISTS bots (
  machine_id   TEXT PRIMARY KEY,
  label        TEXT,
  last_seen_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_pg_screening_exp ON screening_events(experiment_id);
CREATE INDEX IF NOT EXISTS idx_pg_positions_exp ON positions(experiment_id);
CREATE INDEX IF NOT EXISTS idx_pg_snapshots_pos ON position_snapshots(experiment_id, position);
`;

const client = new Client({ connectionString: url });
await client.connect();
console.log('Connected to Postgres, running migrations…');
await client.query(DDL);
await client.end();
console.log('✅ Postgres schema ready.');
