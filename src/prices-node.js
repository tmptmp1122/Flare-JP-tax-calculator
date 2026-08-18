/**
 * Node 版の価格取得。Yahoo Finance から取得して SQLite にキャッシュする。
 *
 * 静的サイト版は同梱JSON + CORS対応APIを使う（static/js/prices-browser.js）。
 * どちらも最終的に shared/report.js の makeRateTable に同じ形の Map を渡す。
 */

import { getPriceRange, upsertPrices, countPricesInRange } from './db.js';

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const SERIES = {
  // 暗号資産は毎日値がつく
  FLRUSD: { symbol: 'FLR-USD', daysPerWeek: 7 },
  // 為替は平日のみ（祝日も休むため実際はこれより少し少ない）
  USDJPY: { symbol: 'JPY=X', daysPerWeek: 5 },
};

export const todayUtc = () => new Date().toISOString().slice(0, 10);

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchYahooDaily(symbol, fromDate, toDate) {
  const p1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(addDays(toDate, 2) + 'T00:00:00Z').getTime() / 1000);

  let lastErr;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r) throw new Error(json?.chart?.error?.description || 'レスポンスが空です');

      const ts = r.timestamp || [];
      const closes = r.indicators?.quote?.[0]?.close || [];
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] == null || !Number.isFinite(closes[i])) continue;
        out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${symbol} の価格取得に失敗しました: ${lastErr?.message || 'unknown'}`);
}

/**
 * 指定期間のレートを（必要なぶんだけ）取得してキャッシュに入れる。
 *
 * 覆えているかは「実際に何日ぶん入っているか」で判定する。最古/最新だけを見ると、
 * 期間の途中の年が丸ごと欠けていても見逃してしまうため。
 */
export async function ensurePrices(fromDate, toDate, { force = false } = {}) {
  const notes = [];
  const totalDays = Math.round((new Date(toDate) - new Date(fromDate)) / 86400000) + 1;

  for (const [series, { symbol, daysPerWeek }] of Object.entries(SERIES)) {
    const have = countPricesInRange(series, fromDate, toDate);
    const expected = (totalDays * daysPerWeek) / 7;
    if (!force && have >= expected * 0.9) continue; // 祝日ぶんを見込んで9割で判定

    try {
      const rows = await fetchYahooDaily(symbol, fromDate, toDate);
      if (rows.length === 0) {
        notes.push(`${symbol}: 対象期間の価格データが取得できませんでした`);
        continue;
      }
      upsertPrices(series, rows);
    } catch (e) {
      notes.push(e.message);
    }
  }
  return notes;
}

/** shared/report.js の makeRateTable に渡す形の Map を返す */
export function loadRateMaps(fromDate, toDate) {
  const lookback = addDays(fromDate, -30);
  return {
    flrUsd: new Map(getPriceRange('FLRUSD', lookback, toDate).map((r) => [r.date, r.close])),
    usdJpy: new Map(getPriceRange('USDJPY', lookback, toDate).map((r) => [r.date, r.close])),
  };
}
