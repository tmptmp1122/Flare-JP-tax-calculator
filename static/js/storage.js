/**
 * ブラウザ側の保存領域。
 *
 * ウォレット一覧とスキャン結果のキャッシュを localStorage に置く。
 * サーバーが存在しないので、入力したアドレスが外部に送られることはない
 * （ブロックチェーンの公開APIを読むだけ）。
 */

const WALLET_KEY = 'flrtax.wallets.v1';
const CACHE_PREFIX = 'flrtax.cache.';
const SETTINGS_PREFIX = 'flrtax.settings.';

/* ---------------- ウォレット ---------------- */

export function listWallets() {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWallets(list) {
  localStorage.setItem(WALLET_KEY, JSON.stringify(list));
}

export function addWallet(address, label = '') {
  const list = listWallets();
  const addr = address.toLowerCase();
  const found = list.find((w) => w.address === addr);
  if (found) {
    found.label = label;
  } else {
    list.push({ address: addr, label, created_at: new Date().toISOString() });
  }
  saveWallets(list);
  return list;
}

export function removeWallet(address) {
  const list = listWallets().filter((w) => w.address !== address.toLowerCase());
  saveWallets(list);
  return list;
}

/* ---------------- スキャンキャッシュ ---------------- */

/**
 * localStorage は容量が限られる（概ね5MB）。
 * 取得結果は数百KBになりうるので、あふれたら古いものから捨てる。
 *
 * 有効期限は設けない。スキャンのたびに「前回の続き」から差分だけを取り直すため、
 * 古い内容がそのまま使われることはない。
 */
export const cache = {
  get(key) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      return JSON.parse(raw).v;
    } catch {
      return null;
    }
  },

  set(key, value) {
    const payload = JSON.stringify({ at: Date.now(), v: value });
    try {
      localStorage.setItem(CACHE_PREFIX + key, payload);
    } catch {
      // 容量超過。古いキャッシュを消してから一度だけ再挑戦する
      evictOldest();
      try {
        localStorage.setItem(CACHE_PREFIX + key, payload);
      } catch {
        /* それでも入らなければキャッシュを諦める（動作には影響しない） */
      }
    }
  },
};

function evictOldest() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(CACHE_PREFIX)) continue;
    try {
      entries.push({ k, at: JSON.parse(localStorage.getItem(k)).at || 0 });
    } catch {
      entries.push({ k, at: 0 });
    }
  }
  entries.sort((a, b) => a.at - b.at);
  // 古いほうから半分捨てる
  for (const e of entries.slice(0, Math.max(1, Math.ceil(entries.length / 2)))) {
    localStorage.removeItem(e.k);
  }
}

export function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
}

/* ---------------- 入力欄の記憶 ---------------- */

/** 他の所得・年始残高など、入力欄の値をブラウザに覚えさせておく */
export function getSetting(key, fallback = null) {
  try {
    const raw = localStorage.getItem(SETTINGS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  try {
    localStorage.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}
