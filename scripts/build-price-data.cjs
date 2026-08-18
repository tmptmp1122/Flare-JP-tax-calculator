'use strict';

/**
 * 静的サイトに同梱する価格データ(JSON)を生成する。
 *
 *   node scripts/build-price-data.js
 *
 * Yahoo Finance から FLR/USD と USD/JPY の日次終値を取得し、
 * static/data/prices.json に書き出す。
 *
 * 日付ごとにキーを持つと冗長なので、開始日からの連続配列で保持する
 * （値が無い日は null）。これでファイルサイズを 1/3 以下に抑えられる。
 */

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const START = '2023-01-01'; // FLR の取引開始は 2023-01-10
const OUT = path.join(__dirname, '..', 'static', 'data', 'prices.json');

const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

async function fetchDaily(symbol, from, to) {
  const p1 = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000);
  const p2 = Math.floor(new Date(addDays(to, 2) + 'T00:00:00Z').getTime() / 1000);
  let lastErr;
  for (const host of HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const r = j?.chart?.result?.[0];
      if (!r) throw new Error('empty result');
      const ts = r.timestamp || [];
      const cl = r.indicators?.quote?.[0]?.close || [];
      const map = new Map();
      for (let i = 0; i < ts.length; i++) {
        if (cl[i] == null || !Number.isFinite(cl[i])) continue;
        map.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), cl[i]);
      }
      return map;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${symbol}: ${lastErr?.message}`);
}

/** Map<date,value> を { start, values[] } の連続配列にする */
function densify(map, start, end, digits) {
  const n = dayDiff(start, end) + 1;
  const values = new Array(n).fill(null);
  for (const [d, v] of map) {
    const i = dayDiff(start, d);
    if (i >= 0 && i < n) values[i] = Number(v.toFixed(digits));
  }
  return { start, values };
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`取得中: ${START} 〜 ${today}`);

  const [flr, fx] = await Promise.all([fetchDaily('FLR-USD', START, today), fetchDaily('JPY=X', START, today)]);
  console.log(`  FLR/USD: ${flr.size} 日ぶん`);
  console.log(`  USD/JPY: ${fx.size} 日ぶん`);

  if (flr.size === 0 || fx.size === 0) throw new Error('価格データが取得できませんでした');

  const payload = {
    generated: new Date().toISOString(),
    note: 'FLR/USD と USD/JPY の日次終値。値が null の日は取引が無い日(為替の土日祝など)。',
    flrUsd: densify(flr, START, today, 8),
    usdJpy: densify(fx, START, today, 4),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`書き出し: ${OUT} (${kb} KB)`);
})().catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
