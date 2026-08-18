/**
 * ブラウザ版の価格取得。
 *
 * Yahoo Finance は CORS ヘッダを返さないためブラウザからは直接呼べない。
 * そこで次の二段構えにしている:
 *
 *   1. 同梱の data/prices.json … 2023年以降の全履歴（20KB程度）。通信1回で済む
 *   2. CORS対応の公開API      … 同梱データの生成日より後の日付を補う
 *        - CoinGecko    FLR/JPY を直接、過去365日
 *        - frankfurter  USD/JPY（ECB）、全期間
 *
 * 1 だけでも過去年分の確定申告には十分で、2 は「今年ぶんを今すぐ見たい」場合の補完。
 */

const COINGECKO = 'https://api.coingecko.com/api/v3';
const FRANKFURTER = 'https://api.frankfurter.dev/v1';

const addDays = (d, n) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** { start, values[] } 形式を Map<date, value> に展開する */
function toMap(series) {
  const m = new Map();
  if (!series) return m;
  series.values.forEach((v, i) => {
    if (v != null) m.set(addDays(series.start, i), v);
  });
  return m;
}

let bundledCache = null;

async function loadBundled() {
  if (bundledCache) return bundledCache;
  const res = await fetch(new URL('../data/prices.json', import.meta.url));
  if (!res.ok) throw new Error(`同梱の価格データを読み込めませんでした (HTTP ${res.status})`);
  const j = await res.json();
  bundledCache = {
    generated: j.generated,
    flrUsd: toMap(j.flrUsd),
    usdJpy: toMap(j.usdJpy),
  };
  return bundledCache;
}

/** CoinGecko から FLR/JPY の日次終値を取る（過去365日まで） */
async function fetchCoinGeckoFlrJpy(fromDate, toDate) {
  const from = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const to = Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000);
  const url = `${COINGECKO}/coins/flare-networks/market_chart/range?vs_currency=jpy&from=${from}&to=${to}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const j = await res.json();
  const m = new Map();
  for (const [ms, price] of j.prices || []) {
    // 同じ日に複数点ある場合は最後の値（その日の終値に近いもの）を採る
    m.set(new Date(ms).toISOString().slice(0, 10), price);
  }
  return m;
}

/** frankfurter(ECB) から USD/JPY を取る */
async function fetchFrankfurterUsdJpy(fromDate, toDate) {
  const url = `${FRANKFURTER}/${fromDate}..${toDate}?base=USD&symbols=JPY`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
  const j = await res.json();
  const m = new Map();
  for (const [d, r] of Object.entries(j.rates || {})) {
    if (r?.JPY != null) m.set(d, r.JPY);
  }
  return m;
}

/**
 * 期間に必要なレートを揃える。
 *
 * @returns {{ flrUsd: Map, usdJpy: Map, flrJpy: Map, notes: string[] }}
 *   flrJpy は CoinGecko から直接得られた FLR/JPY（あれば優先して使う）
 */
export async function loadRates(fromDate, toDate) {
  const notes = [];
  const bundled = await loadBundled();

  const flrUsd = new Map(bundled.flrUsd);
  const usdJpy = new Map(bundled.usdJpy);
  const flrJpy = new Map();

  // 同梱データが対象期間の終わりまで届いているか
  const bundledLast = bundled.generated.slice(0, 10);
  const wantTo = toDate > todayUtc() ? todayUtc() : toDate;

  if (wantTo > bundledLast) {
    // 足りないぶんをライブAPIで補う
    const liveFrom = addDays(bundledLast, -3); // 境界の取りこぼしを防ぐため少し重ねる
    const within365 = dayDiff(liveFrom, todayUtc()) <= 360;

    const tasks = [];
    if (within365) {
      tasks.push(
        fetchCoinGeckoFlrJpy(liveFrom, wantTo)
          .then((m) => {
            for (const [d, v] of m) flrJpy.set(d, v);
          })
          .catch((e) => notes.push(`最新のFLR価格を取得できませんでした (${e.message})`))
      );
    } else {
      notes.push('同梱の価格データが古く、最新期間のFLR価格を補完できません。');
    }
    tasks.push(
      fetchFrankfurterUsdJpy(liveFrom, wantTo)
        .then((m) => {
          for (const [d, v] of m) usdJpy.set(d, v);
        })
        .catch((e) => notes.push(`最新の為替レートを取得できませんでした (${e.message})`))
    );
    await Promise.all(tasks);

    const missingDays = dayDiff(bundledLast, wantTo);
    if (missingDays > 0 && flrJpy.size === 0 && !within365) {
      notes.push(`${bundledLast} より後のレートが無いため、直近の値で代用しています。`);
    }
  }

  return { flrUsd, usdJpy, flrJpy, bundledLast, notes };
}

/**
 * shared/report.js の makeRateTable と同じ役割だが、
 * CoinGecko の FLR/JPY 直値があればそれを優先する。
 */
export function makeRateTableBrowser({ flrUsd, usdJpy, flrJpy }, from, to) {
  const lookback = addDays(from, -30);
  const table = new Map();

  let lastFlrUsd = null;
  let lastFx = null;
  let lastDirect = null;

  // 期間先頭より前に値が無い場合のフォールバック
  const firstOf = (map) => {
    let best = null;
    for (const [d, v] of map) if (d <= to && (best === null || d < best.d)) best = { d, v };
    return best;
  };
  const firstFlr = firstOf(flrUsd);
  const firstFx = firstOf(usdJpy);

  for (let d = lookback; d <= to; d = addDays(d, 1)) {
    const fu = flrUsd.get(d);
    const fx = usdJpy.get(d);
    const dj = flrJpy.get(d);

    const flrExact = fu != null;
    const fxExact = fx != null;
    const directExact = dj != null;

    if (flrExact) lastFlrUsd = fu;
    if (fxExact) lastFx = fx;
    if (directExact) lastDirect = dj;
    if (d < from) continue;

    const useFlrUsd = lastFlrUsd ?? firstFlr?.v ?? null;
    const useFx = lastFx ?? firstFx?.v ?? null;

    let entry = null;
    if (directExact || (lastDirect != null && useFlrUsd == null)) {
      // CoinGecko の FLR/JPY 直値。USD/JPY は表示用に添える
      const jp = directExact ? dj : lastDirect;
      entry = {
        flrUsd: useFx ? jp / useFx : null,
        usdJpy: useFx,
        flrJpy: jp,
        estimated: !directExact,
      };
    } else if (useFlrUsd != null && useFx != null) {
      entry = {
        flrUsd: useFlrUsd,
        usdJpy: useFx,
        flrJpy: useFlrUsd * useFx,
        estimated: !(flrExact && fxExact),
      };
    }
    if (entry) table.set(d, entry);
  }

  let lastKnown = null;
  for (const v of table.values()) lastKnown = v;

  return { get: (date) => table.get(date) ?? lastKnown, size: table.size };
}
