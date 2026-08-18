import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'flr-tax.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS wallets (
    address    TEXT PRIMARY KEY,           -- 小文字で保存
    label      TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- FLR/USD と USD/JPY の日次終値キャッシュ（date は UTC の YYYY-MM-DD）
  CREATE TABLE IF NOT EXISTS price_daily (
    series TEXT NOT NULL,                  -- 'FLRUSD' | 'USDJPY'
    date   TEXT NOT NULL,
    close  REAL NOT NULL,
    PRIMARY KEY (series, date)
  );

  -- 取得済みイベント/取引のキャッシュ。再スキャン時の待ち時間を減らす
  CREATE TABLE IF NOT EXISTS scan_cache (
    cache_key  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

/* ---------------- wallets ---------------- */

export function listWallets() {
  return db.prepare('SELECT address, label, note, created_at FROM wallets ORDER BY created_at').all();
}

export function addWallet(address, label = '', note = '') {
  db.prepare(
    `INSERT INTO wallets (address, label, note, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET label = excluded.label, note = excluded.note`
  ).run(address.toLowerCase(), label, note, new Date().toISOString());
}

export function removeWallet(address) {
  db.prepare('DELETE FROM wallets WHERE address = ?').run(address.toLowerCase());
}

/* ---------------- prices ---------------- */

export function getPriceRange(series, fromDate, toDate) {
  return db
    .prepare('SELECT date, close FROM price_daily WHERE series = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(series, fromDate, toDate);
}

export function upsertPrices(series, rows) {
  const stmt = db.prepare(
    'INSERT INTO price_daily (series, date, close) VALUES (?, ?, ?) ON CONFLICT(series, date) DO UPDATE SET close = excluded.close'
  );
  for (const r of rows) stmt.run(series, r.date, r.close);
}

/** その系列でキャッシュ済みの最古/最新日を返す（無ければ null） */
export function priceCoverage(series) {
  const row = db.prepare('SELECT MIN(date) AS lo, MAX(date) AS hi FROM price_daily WHERE series = ?').get(series);
  return row && row.lo ? { lo: row.lo, hi: row.hi } : null;
}

/**
 * 指定期間にキャッシュ済みの日数を返す。
 * 最古/最新だけを見ると期間の途中が丸ごと欠けていても気づけないため、
 * 実際の件数で判定する。
 */
export function countPricesInRange(series, fromDate, toDate) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM price_daily WHERE series = ? AND date >= ? AND date <= ?')
    .get(series, fromDate, toDate);
  return row?.n ?? 0;
}

/* ---------------- scan cache ---------------- */

export function getCache(key, maxAgeMs) {
  const row = db.prepare('SELECT payload, fetched_at FROM scan_cache WHERE cache_key = ?').get(key);
  if (!row) return null;
  if (maxAgeMs != null && Date.now() - row.fetched_at > maxAgeMs) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

export function setCache(key, value) {
  db.prepare(
    `INSERT INTO scan_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(key, JSON.stringify(value), Date.now());
}

export function clearCache() {
  db.exec('DELETE FROM scan_cache');
}

export { db };
