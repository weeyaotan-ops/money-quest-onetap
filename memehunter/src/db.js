import pg from 'pg';
import { randomUUID } from 'node:crypto';
const { Pool } = pg;

function poolConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, max: 3 };
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 3,
  };
}

export const pool = new Pool(poolConfig());

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mh_meme_trades (
      id uuid PRIMARY KEY,
      mint text NOT NULL,
      symbol text,
      pair_address text,
      status text NOT NULL,
      entry_time timestamptz,
      exit_time timestamptz,
      entry_usdc numeric,
      entry_token_raw text,
      entry_expected_raw text,
      entry_sig text,
      exit_usdc numeric,
      exit_sig text,
      exit_reason text,
      realized_pnl_usdc numeric,
      peak_value_usdc numeric,
      score numeric,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mh_meme_trades_status_idx ON mh_meme_trades(status);
    CREATE INDEX IF NOT EXISTS mh_meme_trades_mint_idx ON mh_meme_trades(mint, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS mh_meme_one_active_per_mint
      ON mh_meme_trades(mint)
      WHERE status IN ('ENTRY_PENDING','OPEN','EXIT_PENDING');

    CREATE TABLE IF NOT EXISTS mh_meme_events (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      event_type text NOT NULL,
      mint text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS mh_meme_events_ts_idx ON mh_meme_events(ts DESC);

    CREATE TABLE IF NOT EXISTS mh_meme_runtime (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function event(eventType, mint = null, details = {}) {
  try {
    await pool.query(
      `INSERT INTO mh_meme_events(event_type,mint,details) VALUES($1,$2,$3::jsonb)`,
      [eventType, mint, JSON.stringify(details)]
    );
  } catch (e) {
    console.error('DB_EVENT_FAIL', eventType, e.message);
  }
}

export async function createPendingTrade({ mint, symbol, pairAddress, entryUsdc, expectedRaw, score, meta }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mh_meme_trades
      (id,mint,symbol,pair_address,status,entry_usdc,entry_expected_raw,score,meta)
     VALUES($1,$2,$3,$4,'ENTRY_PENDING',$5,$6,$7,$8::jsonb)`,
    [id, mint, symbol, pairAddress, entryUsdc, String(expectedRaw || ''), score, JSON.stringify(meta || {})]
  );
  return id;
}

export async function markEntryOpen(id, { tokenRaw, signature, entryUsdc, metaPatch = {} }) {
  await pool.query(
    `UPDATE mh_meme_trades SET status='OPEN', entry_time=now(), entry_token_raw=$2,
      entry_sig=$3, entry_usdc=$4, meta=meta || $5::jsonb, updated_at=now() WHERE id=$1`,
    [id, String(tokenRaw), signature || null, entryUsdc, JSON.stringify(metaPatch)]
  );
}

export async function markEntryFailed(id, reason) {
  await pool.query(
    `UPDATE mh_meme_trades SET status='ENTRY_FAILED', exit_reason=$2, updated_at=now() WHERE id=$1`,
    [id, String(reason).slice(0, 500)]
  );
}

export async function markExitPending(id, reason, metaPatch = {}) {
  const r = await pool.query(
    `UPDATE mh_meme_trades SET status='EXIT_PENDING', exit_reason=$2,
      meta=meta || $3::jsonb, updated_at=now()
     WHERE id=$1 AND status='OPEN' RETURNING *`,
    [id, reason, JSON.stringify(metaPatch)]
  );
  return r.rows[0] || null;
}

export async function markClosed(id, { exitUsdc, signature, reason, pnl }) {
  await pool.query(
    `UPDATE mh_meme_trades SET status='CLOSED', exit_time=now(), exit_usdc=$2,
      exit_sig=$3, exit_reason=$4, realized_pnl_usdc=$5, updated_at=now() WHERE id=$1`,
    [id, exitUsdc, signature || null, reason, pnl]
  );
}

export async function markClosedUnknown(id, reason) {
  await pool.query(
    `UPDATE mh_meme_trades SET status='CLOSED_REVIEW', exit_time=now(), exit_reason=$2,
      updated_at=now() WHERE id=$1`,
    [id, reason]
  );
}

export async function restoreExitPendingToOpen(id, reason) {
  await pool.query(
    `UPDATE mh_meme_trades SET status='OPEN', exit_reason=$2, updated_at=now() WHERE id=$1 AND status='EXIT_PENDING'`,
    [id, reason]
  );
}

export async function updatePeak(id, peakValueUsdc) {
  await pool.query(
    `UPDATE mh_meme_trades SET peak_value_usdc=GREATEST(COALESCE(peak_value_usdc,0),$2), updated_at=now() WHERE id=$1`,
    [id, peakValueUsdc]
  );
}

export async function openTrades() {
  const r = await pool.query(`SELECT * FROM mh_meme_trades WHERE status='OPEN' ORDER BY entry_time ASC`);
  return r.rows;
}

export async function pendingTrades() {
  const r = await pool.query(`SELECT * FROM mh_meme_trades WHERE status IN ('ENTRY_PENDING','EXIT_PENDING') ORDER BY created_at ASC`);
  return r.rows;
}

export async function openCount() {
  const r = await pool.query(`SELECT count(*)::int AS n FROM mh_meme_trades WHERE status IN ('ENTRY_PENDING','OPEN','EXIT_PENDING')`);
  return r.rows[0]?.n || 0;
}

export async function recentlyTraded(mint, hours) {
  const r = await pool.query(
    `SELECT 1 FROM mh_meme_trades WHERE mint=$1 AND created_at > now() - ($2::text || ' hours')::interval LIMIT 1`,
    [mint, String(hours)]
  );
  return r.rowCount > 0;
}

export async function todayStats() {
  const r = await pool.query(`
    SELECT
      count(*) FILTER (WHERE entry_time >= date_trunc('day', now()))::int AS trades,
      COALESCE(sum(realized_pnl_usdc) FILTER (WHERE exit_time >= date_trunc('day', now())),0)::numeric AS pnl
    FROM mh_meme_trades
  `);
  return { trades: Number(r.rows[0]?.trades || 0), pnl: Number(r.rows[0]?.pnl || 0) };
}

export async function getRuntime(key, fallback = null) {
  const r = await pool.query(`SELECT value FROM mh_meme_runtime WHERE key=$1`, [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}

export async function setRuntime(key, value) {
  await pool.query(
    `INSERT INTO mh_meme_runtime(key,value) VALUES($1,$2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=now()`,
    [key, JSON.stringify(value)]
  );
}
