/**
 * 収集したデータとレート表から税務用レポートを組み立てる（ブラウザ / Node.js 共通）。
 *
 * この関数は純粋な計算のみで、通信もファイル入出力も行わない。
 * データ取得はブラウザ版と Node 版でそれぞれ実装し、結果をここに渡す。
 */

import { CATEGORY } from './config.js';

/** UNIX秒 → JST の YYYY-MM-DD（日本の税務は暦年=JST基準） */
export function jstDate(tsSec) {
  return new Date((tsSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

/** UNIX秒 → JST の表示用日時 */
export function jstDateTime(tsSec) {
  return new Date((tsSec + 9 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

const round2 = (v) => Math.round(v * 100) / 100;
// Math.round(-0.4) は -0 になるため 0 に寄せる
const yen = (v) => Math.round(v) || 0;

/**
 * @param {object} p
 * @param {string[]} p.wallets   対象ウォレット（小文字）
 * @param {Array} p.rewards      collectRewards の結果を結合したもの（wallet 付き）
 * @param {Array} p.gasTxs       collectGas の結果を結合したもの（wallet 付き）
 * @param {object} p.rates       { get(date) → {flrUsd, usdJpy, flrJpy, estimated} }
 * @param {string} p.from        期間開始 YYYY-MM-DD（JST, 含む）
 * @param {string} p.to          期間終了 YYYY-MM-DD（JST, 含む）
 * @param {string[]} p.warnings
 */
export function buildReport({ wallets, rewards: allRewards, gasTxs: allGas, rates, from, to, warnings = [] }) {
  const notes = [...warnings];

  const inPeriod = (row) => {
    const d = jstDate(row.timestamp);
    return d >= from && d <= to;
  };
  const rewards = allRewards.filter(inPeriod).sort((a, b) => a.timestamp - b.timestamp);
  const gas = allGas.filter(inPeriod).sort((a, b) => a.timestamp - b.timestamp);

  // --- 円換算 ---
  let estimatedCount = 0;
  let missingRate = 0;
  const valuate = (row, amountField) => {
    const date = jstDate(row.timestamp);
    row.date = date;
    row.datetimeJst = jstDateTime(row.timestamp);
    const rate = rates.get(date);
    if (!rate) {
      row.flrUsd = row.usdJpy = row.flrJpy = row.jpy = null;
      row.rateEstimated = true;
      missingRate++;
      return;
    }
    row.flrUsd = rate.flrUsd;
    row.usdJpy = rate.usdJpy;
    row.flrJpy = rate.flrJpy;
    row.jpy = row[amountField] * rate.flrJpy;
    row.rateEstimated = !!rate.estimated;
    if (rate.estimated) estimatedCount++;
  };
  for (const r of rewards) valuate(r, 'amountFlr');
  for (const g of gas) valuate(g, 'feeFlr');

  if (estimatedCount > 0) {
    notes.push(`${estimatedCount} 件は当日のレートが存在しないため、直近営業日のレートで換算しています（土日祝の為替など）。`);
  }
  if (missingRate > 0) {
    notes.push(`${missingRate} 件はレートが取得できず円換算できませんでした。合計額から除外されています。`);
  }

  // --- 合計 ---
  const totalRewardFlr = rewards.reduce((s, r) => s + r.amountFlr, 0);
  const totalRewardJpy = rewards.reduce((s, r) => s + (r.jpy || 0), 0);
  const totalGasFlr = gas.reduce((s, g) => s + g.feeFlr, 0);
  const totalGasJpy = gas.reduce((s, g) => s + (g.jpy || 0), 0);

  // --- 種別別 ---
  const catMap = new Map();
  for (const r of rewards) {
    if (!catMap.has(r.category)) {
      catMap.set(r.category, { category: r.category, label: CATEGORY[r.category] || r.category, count: 0, flr: 0, jpy: 0 });
    }
    const e = catMap.get(r.category);
    e.count++;
    e.flr += r.amountFlr;
    e.jpy += r.jpy || 0;
  }
  const byCategory = [...catMap.values()].sort((a, b) => b.jpy - a.jpy);

  // --- 月別 ---
  const monthMap = new Map();
  const touch = (m) => {
    if (!monthMap.has(m)) {
      monthMap.set(m, { month: m, rewardFlr: 0, rewardJpy: 0, gasFlr: 0, gasJpy: 0, rewardCount: 0, gasCount: 0 });
    }
    return monthMap.get(m);
  };
  for (const r of rewards) {
    const e = touch(r.date.slice(0, 7));
    e.rewardFlr += r.amountFlr;
    e.rewardJpy += r.jpy || 0;
    e.rewardCount++;
  }
  for (const g of gas) {
    const e = touch(g.date.slice(0, 7));
    e.gasFlr += g.feeFlr;
    e.gasJpy += g.jpy || 0;
    e.gasCount++;
  }
  const byMonth = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const m of byMonth) m.netJpy = m.rewardJpy - m.gasJpy;

  // --- 年別 ---
  const yearMap = new Map();
  for (const m of byMonth) {
    const y = m.month.slice(0, 4);
    if (!yearMap.has(y)) yearMap.set(y, { year: y, rewardFlr: 0, rewardJpy: 0, gasFlr: 0, gasJpy: 0 });
    const e = yearMap.get(y);
    e.rewardFlr += m.rewardFlr;
    e.rewardJpy += m.rewardJpy;
    e.gasFlr += m.gasFlr;
    e.gasJpy += m.gasJpy;
  }
  const byYear = [...yearMap.values()].sort((a, b) => a.year.localeCompare(b.year));
  for (const y of byYear) y.netJpy = y.rewardJpy - y.gasJpy;

  // --- ウォレット別 ---
  const walletMap = new Map(wallets.map((w) => [w, { wallet: w, rewardFlr: 0, rewardJpy: 0, gasFlr: 0, gasJpy: 0 }]));
  for (const r of rewards) {
    const e = walletMap.get(r.wallet);
    if (e) {
      e.rewardFlr += r.amountFlr;
      e.rewardJpy += r.jpy || 0;
    }
  }
  for (const g of gas) {
    const e = walletMap.get(g.wallet);
    if (e) {
      e.gasFlr += g.feeFlr;
      e.gasJpy += g.jpy || 0;
    }
  }

  return {
    period: { from, to },
    wallets,
    generatedAt: new Date().toISOString(),
    summary: {
      rewardCount: rewards.length,
      gasTxCount: gas.length,
      totalRewardFlr: round2(totalRewardFlr),
      totalRewardJpy: yen(totalRewardJpy),
      totalGasFlr: round2(totalGasFlr),
      totalGasJpy: yen(totalGasJpy),
      netJpy: yen(totalRewardJpy - totalGasJpy),
    },
    byCategory,
    byMonth,
    byYear,
    byWallet: [...walletMap.values()],
    rewards,
    gas,
    warnings: [...new Set(notes)],
  };
}

/**
 * 日次レート表を作る。欠損日は直前の値で前方補完する。
 * @param {object} src { flrUsd: Map<date,number>, usdJpy: Map<date,number> }
 */
export function makeRateTable(src, from, to) {
  const addDays = (d, n) => {
    const x = new Date(d + 'T00:00:00Z');
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  // 前方補完の起点を確保するため少し手前から走る
  const lookback = addDays(from, -30);
  const table = new Map();
  let lastFlr = null;
  let lastFx = null;

  // 期間先頭より前に値が無い場合に備え、最初に見つかる値を控えておく
  let firstFlr = null;
  let firstFx = null;
  for (const [d, v] of src.flrUsd) {
    if (d <= to && (firstFlr === null || d < firstFlr.d)) firstFlr = { d, v };
  }
  for (const [d, v] of src.usdJpy) {
    if (d <= to && (firstFx === null || d < firstFx.d)) firstFx = { d, v };
  }

  for (let d = lookback; d <= to; d = addDays(d, 1)) {
    const fv = src.flrUsd.get(d);
    const xv = src.usdJpy.get(d);
    const flrExact = fv != null;
    const fxExact = xv != null;
    if (flrExact) lastFlr = fv;
    if (fxExact) lastFx = xv;
    if (d < from) continue;

    const flrUsd = lastFlr ?? firstFlr?.v ?? null;
    const usdJpy = lastFx ?? firstFx?.v ?? null;
    if (flrUsd == null || usdJpy == null) continue;

    table.set(d, { flrUsd, usdJpy, flrJpy: flrUsd * usdJpy, estimated: !(flrExact && fxExact) });
  }

  let lastKnown = null;
  for (const v of table.values()) lastKnown = v;

  return {
    get: (date) => table.get(date) ?? lastKnown,
    size: table.size,
  };
}
