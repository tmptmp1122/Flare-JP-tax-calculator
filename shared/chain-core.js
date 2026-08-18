/**
 * Flare からの報酬・ガス代収集（ブラウザ / Node.js 共通）。
 *
 * fetch しか使っていないため、Node.js 18+ とブラウザの両方でそのまま動く。
 * キャッシュの実装だけが環境によって異なるので、外から注入する
 * （Node は SQLite、ブラウザは localStorage）。
 *
 * 【設計上の要点】
 * 報酬の検出はイベントログを正とする。「ウォレットに届いた FLR」を数える方式では、
 * 報酬を WNat にラップして受け取った claim を丸ごと取りこぼす（native は
 * RewardManager から WNat へ動くだけでウォレットには届かないため）。
 */

import { CHAIN, FALLBACK_ADDRESSES, CATEGORY, REWARD_EVENTS } from './config.js';
import { addressToTopic, decodeLogData, weiToNumber, hexToNumber, normalizeAddress } from './decode.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** キャッシュを使わない場合の既定実装 */
const NO_CACHE = { get: () => null, set: () => {} };

/**
 * キャッシュの形式・復号ロジックを変えたら必ずこの値を上げること。
 * 古い形式のキャッシュは読み捨てられ、自動的に全期間の取り直しになる。
 */
const CACHE_VERSION = 2;

/**
 * 差分取得のときに重ねて読み直すブロック数。
 *
 * チェーンの再編成(reorg)で直近のブロックが入れ替わることと、Explorer の
 * 索引付けが最新ブロックに追いついていない可能性の両方に備える。
 * 約20万ブロック = 2〜3日ぶん。狭い範囲の問い合わせは1秒以下で終わるので、
 * 安全側に大きめに取っている。
 */
const REORG_MARGIN = 200_000;

/**
 * Explorer への同時リクエスト数を、全コントラクトを通じて共有の上限に抑える。
 *
 * collectRewards は5種類のコントラクトを並列に問い合わせる。分割取得（フォールバック）が
 * 複数のコントラクトで同時に発生すると、それぞれが自分だけの並列数のつもりでリクエストを
 * 出しても、ブラウザ全体では合計が一気に跳ね上がり、かえって Explorer 側のレスポンスが
 * 悪化して全体が遅くなる。ここで全体の同時実行数を一本化して抑える。
 */
const GLOBAL_CONCURRENCY = 5;
let activeRequests = 0;
const waitQueue = [];

function withGlobalSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests++;
      fn().then(
        (v) => {
          activeRequests--;
          const next = waitQueue.shift();
          if (next) next();
          resolve(v);
        },
        (e) => {
          activeRequests--;
          const next = waitQueue.shift();
          if (next) next();
          reject(e);
        }
      );
    };
    if (activeRequests < GLOBAL_CONCURRENCY) run();
    else waitQueue.push(run);
  });
}

/** 形式が合わないキャッシュは無かったことにする */
function readCache(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== CACHE_VERSION) return null;
  return raw;
}

/** ログの同一性は (トランザクション, ログ番号) で決まる */
function dedupeLogs(logs) {
  const seen = new Map();
  for (const l of logs) seen.set(`${l.txHash}:${l.logIndex}`, l);
  return [...seen.values()];
}

function dedupeTxs(txs) {
  const seen = new Map();
  for (const t of txs) seen.set(t.txHash, t);
  return [...seen.values()];
}

/* ------------------------------------------------------------------ */
/* 低レベル: HTTP                                                       */
/* ------------------------------------------------------------------ */

async function apiGet(url, { retries = 4, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 429(レート制限)と5xx(一時障害)はリトライする価値がある
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1200 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1));
    }
  }
  throw new Error(`Explorer API 呼び出しに失敗しました: ${lastErr?.message || 'unknown'}`);
}

async function getLatestBlock() {
  try {
    const j = await apiGet(`${CHAIN.explorerApiV2}/blocks?type=block`, { retries: 2, timeoutMs: 15000 });
    return j.items?.[0]?.height ?? null;
  } catch {
    return null;
  }
}

/**
 * コントラクトが作成されたブロック番号。
 * 分割取得のとき、デプロイ前の範囲を走査しても必ず空振りなので、そこを飛ばす。
 * ハードコードせず実行時に調べるので、コントラクトが更新されても正しく追随する。
 */
const deployBlockCache = new Map();

async function getDeployBlock(address) {
  const key = address.toLowerCase();
  if (deployBlockCache.has(key)) return deployBlockCache.get(key);
  let block = 0;
  try {
    const info = await apiGet(`${CHAIN.explorerApiV2}/addresses/${address}`, { retries: 2, timeoutMs: 15000 });
    if (info.creation_transaction_hash) {
      const tx = await apiGet(`${CHAIN.explorerApiV2}/transactions/${info.creation_transaction_hash}`, {
        retries: 2,
        timeoutMs: 15000,
      });
      block = tx.block_number ?? 0;
    }
  } catch {
    block = 0; // 分からなければ 0 から見る（安全側）
  }
  deployBlockCache.set(key, block);
  return block;
}

/* ------------------------------------------------------------------ */
/* コントラクトアドレスの解決                                           */
/* ------------------------------------------------------------------ */

let contractCache = null;

/**
 * FlareContractRegistry.getAllContracts() を eth_call で呼び、
 * 返り値 (string[], address[]) を手で復号する。
 * 失敗しても実測済みのフォールバックで動作を継続する。
 */
export async function resolveContracts() {
  if (contractCache) return contractCache;
  try {
    const res = await fetch(CHAIN.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        // getAllContracts() のセレクタ = keccak256("getAllContracts()")[0:4]
        params: [{ to: CHAIN.registry, data: '0x18d3ce96' }, 'latest'],
      }),
    });
    const j = await res.json();
    if (j.error || !j.result) throw new Error(j.error?.message || 'empty');
    contractCache = { ...FALLBACK_ADDRESSES, ...decodeRegistry(j.result) };
  } catch {
    contractCache = { ...FALLBACK_ADDRESSES };
  }
  return contractCache;
}

/** (string[], address[]) のABI復号 */
function decodeRegistry(hexData) {
  const hex = hexData.replace(/^0x/, '');
  const word = (i) => hex.slice(i * 64, i * 64 + 64);
  const num = (i) => Number(BigInt('0x' + word(i)));

  const namesOff = num(0) / 32;
  const addrsOff = num(1) / 32;

  const nameCount = num(namesOff);
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    // 各要素のオフセットは names 配列の先頭からの相対
    const rel = num(namesOff + 1 + i) / 32;
    const at = namesOff + 1 + rel;
    const len = num(at);
    const raw = hex.slice((at + 1) * 64, (at + 1) * 64 + len * 2);
    let s = '';
    for (let k = 0; k < raw.length; k += 2) s += String.fromCharCode(parseInt(raw.slice(k, k + 2), 16));
    names.push(s);
  }

  const addrCount = num(addrsOff);
  const map = {};
  for (let i = 0; i < addrCount; i++) {
    map[names[i]] = '0x' + word(addrsOff + 1 + i).slice(-40);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 報酬イベントの収集                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {number} fromBlock 走査開始ブロック。差分取得ではここが前回の続きになる
 */
async function fetchRewardLogs(wallet, def, contractAddress, latestBlock, fromBlock = 0) {
  const walletTopic = addressToTopic(wallet);

  const queryRange = async (f, t, opts) => {
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      fromBlock: String(f),
      toBlock: String(t),
      address: contractAddress,
      topic0: def.topic0,
      [`topic${def.walletTopic}`]: walletTopic,
      [`topic0_${def.walletTopic}_opr`]: 'and',
    });
    const j = await apiGet(`${CHAIN.explorerApi}?${params}`, opts);
    // "No logs found" は正常系（該当報酬なし）
    return j.status === '1' && Array.isArray(j.result) ? j.result : [];
  };

  let rawLogs;
  if (fromBlock > 0) {
    // 差分取得。範囲が狭いので分割は不要（実測で1秒以下）
    rawLogs = await queryRange(fromBlock, 'latest', { retries: 3, timeoutMs: 20000 });
  } else {
    try {
      // 初回は全期間を一括で試す。重いコントラクトは 504 になるので、
      // 長く待たずに即座に分割方式へ切り替える。
      rawLogs = await queryRange(0, 'latest', { retries: 1, timeoutMs: 20000 });
    } catch (e) {
      if (!latestBlock) throw e;

      // デプロイ前のブロックは必ず空振りなので走査しない
      const startBlock = await getDeployBlock(contractAddress);

      // チャンクは小さめにする。実測では 4M ブロックは応答が遅くなりやすい一方、
      // 1〜2M ブロックなら安定して1秒未満で返る。1回あたりの失敗リスクを下げるほうが、
      // リクエスト数が増える分の不利を上回る。
      const CHUNK = 1_500_000;
      const ranges = [];
      for (let f = startBlock; f <= latestBlock; f += CHUNK) {
        ranges.push([f, Math.min(f + CHUNK - 1, latestBlock)]);
      }

      // 同時実行数はコントラクトごとではなく全体で共有する（withGlobalSlot）。
      // 5種類のコントラクトが同時に分割取得へ入っても、ブラウザからの
      // 同時リクエスト数が跳ね上がらないようにするため。
      const parts = await Promise.all(
        ranges.map(([f, t]) => withGlobalSlot(() => queryRange(f, t, { retries: 3, timeoutMs: 20000 })))
      );
      rawLogs = parts.flat();
    }
  }

  const out = [];
  const seen = new Set();
  for (const log of rawLogs) {
    // 分割取得時の境界重複を排除
    const uniq = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(uniq)) continue;
    seen.add(uniq);

    let args;
    try {
      args = decodeLogData(log.data, def.dataFields);
    } catch {
      continue;
    }
    const amountWei = args[def.amountField];
    if (amountWei == null || amountWei === 0n) continue;

    const ts = hexToNumber(log.timeStamp);
    const category = def.categoryFrom(args);

    out.push({
      source: def.id,
      contract: def.contract,
      contractAddress,
      category,
      categoryLabel: CATEGORY[category] || def.labelFrom(args),
      detailLabel: def.labelFrom(args),
      epoch: def.epochField && args[def.epochField] != null ? args[def.epochField].toString() : null,
      amountWei: amountWei.toString(),
      amountFlr: weiToNumber(amountWei, CHAIN.decimals),
      blockNumber: hexToNumber(log.blockNumber),
      timestamp: ts,
      txHash: log.transactionHash,
      // 差分取得のときに同一ログを見分けるために必要
      logIndex: hexToNumber(log.logIndex),
    });
  }
  return out;
}

export async function collectRewards(address, { cache = NO_CACHE, onProgress, force = false } = {}) {
  const wallet = normalizeAddress(address);
  const key = `rewards:${wallet}`;

  const prev = force ? null : readCache(await cache.get(key));
  const contracts = await resolveContracts();
  const latestBlock = await getLatestBlock();

  const warnings = [];
  const bySource = {};
  let done = 0;
  let incrementalCount = 0;

  // 5種類のコントラクトは互いに独立なので並列に問い合わせる。
  // それぞれ独立した「どこまで読んだか」を持つので、1つが失敗しても
  // 他のコントラクトの進捗は失われない。
  const results = await Promise.all(
    REWARD_EVENTS.map(async (def) => {
      const addr = contracts[def.contract];
      const before = prev?.bySource?.[def.id] ?? null;

      if (!addr) {
        return { id: def.id, keep: before, warning: `${def.contract} のアドレスが解決できませんでした` };
      }

      // 前回の続きから読めるか判断する（&& の結果がブロック番号にならないよう真偽値に揃える）
      const canResume = Boolean(before && Number.isFinite(before.scannedTo) && latestBlock);
      const fromBlock = canResume ? Math.max(1, before.scannedTo - REORG_MARGIN + 1) : 0;
      if (canResume) incrementalCount++;

      try {
        const fresh = await fetchRewardLogs(wallet, def, addr, latestBlock, fromBlock);

        let logs;
        if (canResume) {
          // 再取得した範囲は「消してから入れ直す」。
          // 単に重複を除くだけだと、再編成で無効になったログが残り続けてしまう。
          const kept = before.logs.filter((l) => l.blockNumber < fromBlock);
          logs = dedupeLogs([...kept, ...fresh]);
        } else {
          logs = dedupeLogs(fresh);
        }

        return { id: def.id, entry: { logs, scannedTo: latestBlock ?? before?.scannedTo ?? null } };
      } catch (e) {
        // 失敗したコントラクトは前回の内容と読み取り位置をそのまま維持し、
        // 次回あらためて同じ範囲を取り直す（取りこぼしを作らないため）
        return { id: def.id, keep: before, warning: `${def.contract} の報酬取得に失敗: ${e.message}` };
      } finally {
        done++;
        onProgress?.({ phase: 'rewards', step: done, total: REWARD_EVENTS.length, label: def.contract });
      }
    })
  );

  for (const r of results) {
    if (r.entry) bySource[r.id] = r.entry;
    else if (r.keep) bySource[r.id] = r.keep;
    if (r.warning) warnings.push(r.warning);
  }

  const all = [];
  for (const e of Object.values(bySource)) all.push(...e.logs);
  all.sort((a, b) => a.timestamp - b.timestamp);

  await cache.set(key, { version: CACHE_VERSION, bySource });
  return { rewards: all, warnings, incremental: incrementalCount > 0 };
}

/* ------------------------------------------------------------------ */
/* ガス代の収集                                                         */
/* ------------------------------------------------------------------ */

export async function collectGas(address, { cache = NO_CACHE, onProgress, maxPages = 200, force = false } = {}) {
  const wallet = normalizeAddress(address);
  const key = `gas:${wallet}`;

  const prev = force ? null : readCache(await cache.get(key));
  const latestBlock = await getLatestBlock();

  // 前回の続きから読めるか判断する（&& の結果がブロック番号にならないよう真偽値に揃える）
  const canResume = Boolean(prev && Number.isFinite(prev.scannedTo) && latestBlock);
  const cutoff = canResume ? Math.max(1, prev.scannedTo - REORG_MARGIN + 1) : 0;

  const fresh = [];
  const warnings = [];
  let next = null;
  let page = 0;
  let truncated = false;
  let reachedCutoff = false;

  try {
    do {
      const qs = new URLSearchParams({ filter: 'from' });
      if (next) for (const [k, v] of Object.entries(next)) qs.set(k, String(v));

      const j = await apiGet(`${CHAIN.explorerApiV2}/addresses/${wallet}/transactions?${qs}`);
      for (const t of j.items || []) {
        // このAPIは新しい順に返す。差分取得では、前回読んだ位置より古い
        // トランザクションに到達した時点で以降を見る必要がない。
        if (canResume && t.block_number != null && t.block_number < cutoff) {
          reachedCutoff = true;
          break;
        }
        if (t.from?.hash?.toLowerCase() !== wallet) continue;
        const feeWei = BigInt(t.fee?.value ?? '0');
        if (feeWei === 0n) continue;

        fresh.push({
          txHash: t.hash,
          timestamp: Math.floor(new Date(t.timestamp).getTime() / 1000),
          blockNumber: t.block_number,
          method: t.method || (t.to ? '(コントラクト呼び出し)' : '(コントラクト作成)'),
          to: t.to?.hash || null,
          toName: t.to?.name || null,
          success: t.status === 'ok',
          gasUsed: t.gas_used ?? null,
          gasPrice: t.gas_price ?? null,
          feeWei: feeWei.toString(),
          feeFlr: weiToNumber(feeWei, CHAIN.decimals),
        });
      }
      if (reachedCutoff) break;

      next = j.next_page_params || null;
      page++;
      onProgress?.({ phase: 'gas', step: page, label: `${fresh.length}件` });
      if (next) await sleep(120);
    } while (next && page < maxPages);

    if (next && !reachedCutoff) {
      truncated = true;
      warnings.push(
        `トランザクションが非常に多いため最初の ${maxPages} ページのみ取得しました。ガス代が過少に集計されている可能性があります。`
      );
    }
  } catch (e) {
    warnings.push(`ガス代の取得に失敗: ${e.message}`);
    // 失敗時は前回の内容と読み取り位置をそのまま維持する
    if (prev) return { gasTxs: prev.txs, warnings, incremental: false };
  }

  let txs;
  if (canResume) {
    // 再取得した範囲は消してから入れ直す（再編成で消えた取引を残さないため）
    const kept = prev.txs.filter((t) => t.blockNumber < cutoff);
    txs = dedupeTxs([...kept, ...fresh]);
  } else {
    txs = dedupeTxs(fresh);
  }
  txs.sort((a, b) => a.timestamp - b.timestamp);

  // 全ページを読み切れなかった場合は「どこまで読んだか」を確定できないので、
  // 読み取り位置を記録せず、次回はまた最初から読み直す
  const scannedTo = truncated ? null : latestBlock ?? prev?.scannedTo ?? null;
  await cache.set(key, { version: CACHE_VERSION, txs, scannedTo });

  return { gasTxs: txs, warnings, incremental: canResume };
}
