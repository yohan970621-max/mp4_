const fs = require('fs');
const path = require('path');
const { Pool: PgPool } = require('pg');

let PoolClass = PgPool;
if (process.env.USE_PGMEM === '1') {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = mem.adapters.createPg();
  PoolClass = adapter.Pool;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString && process.env.USE_PGMEM !== '1') {
  throw new Error('DATABASE_URL 환경변수가 필요합니다.');
}

const isLocal = connectionString && /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new PoolClass({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.USE_PGMEM === '1' || isLocal || process.env.DB_SSL === '0'
    ? false
    : { rejectUnauthorized: false }
});

pool.on?.('error', (error) => {
  console.error('[DB] Unexpected pool error:', error);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  const migrationDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const filename of files) {
    const existing = await query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (existing.rowCount > 0) continue;
    const sql = fs.readFileSync(path.join(migrationDir, filename), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
    });
    console.log(`[DB] Applied migration: ${filename}`);
  }
}

async function getSetting(key, fallback = '') {
  const result = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rowCount ? result.rows[0].value : fallback;
}

async function getSettings() {
  const result = await query('SELECT key, value FROM settings');
  return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
}

async function setSetting(key, value, client = pool) {
  await client.query(
    `INSERT INTO settings(key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  );
}

module.exports = { pool, query, withTransaction, migrate, getSetting, getSettings, setSetting };
