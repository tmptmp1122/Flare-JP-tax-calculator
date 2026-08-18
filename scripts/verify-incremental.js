/**
 * 差分取得の正しさを検証する。
 *
 *   node scripts/verify-incremental.js
 *
 * 「速いが間違っている」ことが最も避けたい状態なので、
 * 全期間を取り直した結果と、差分取得を重ねた結果が一致することを確認する。
 * あわせて再編成(reorg)とキャッシュ破損を模擬し、壊れたデータが残らないことを見る。
 */

import { collectRewards, collectGas } from '../shared/chain-core.js';

const WALLET = process.env.TEST_WALLET || '0xd9B2DB0baB36c78f52968624b148923F49394949';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};

/** テスト用のメモリキャッシュ */
function memCache() {
  const m = new Map();
  return {
    store: m,
    get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: (k, v) => m.set(k, JSON.stringify(v)),
  };
}

const fingerprint = (rows, idFn) =>
  rows
    .map(idFn)
    .sort()
    .join('|');

const rewardId = (r) => `${r.txHash}:${r.logIndex}:${r.amountWei}`;
const gasId = (t) => `${t.txHash}:${t.feeWei}`;

console.log(`\n検証対象アドレス: ${WALLET}\n`);

/* ---------------- 1. 全期間取得（基準） ---------------- */
console.log('[1] 全期間を取得して基準を作る');
const t0 = Date.now();
const baseCache = memCache();
const baseRewards = await collectRewards(WALLET, { cache: baseCache });
const baseGas = await collectGas(WALLET, { cache: baseCache });
const fullSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`  報酬 ${baseRewards.rewards.length} 件 / ガス代 ${baseGas.gasTxs.length} 件（${fullSec} 秒）`);
check('初回は差分取得ではない', baseRewards.incremental === false || baseRewards.incremental === undefined);
check('警告なし', baseRewards.warnings.length === 0, baseRewards.warnings.join(', '));

const baseRewardFp = fingerprint(baseRewards.rewards, rewardId);
const baseGasFp = fingerprint(baseGas.gasTxs, gasId);

/* ---------------- 2. 差分取得の結果が一致するか ---------------- */
console.log('\n[2] 同じキャッシュで再スキャン（差分取得が働くはず）');
const t1 = Date.now();
const inc1 = await collectRewards(WALLET, { cache: baseCache });
const incGas1 = await collectGas(WALLET, { cache: baseCache });
const incSec = ((Date.now() - t1) / 1000).toFixed(1);
console.log(`  ${incSec} 秒で完了`);

check('差分取得が使われた（報酬）', inc1.incremental === true);
check('差分取得が使われた（ガス代）', incGas1.incremental === true);
check('報酬が全期間取得と完全一致', fingerprint(inc1.rewards, rewardId) === baseRewardFp,
  `${inc1.rewards.length} 件 vs ${baseRewards.rewards.length} 件`);
check('ガス代が全期間取得と完全一致', fingerprint(incGas1.gasTxs, gasId) === baseGasFp,
  `${incGas1.gasTxs.length} 件 vs ${baseGas.gasTxs.length} 件`);
check('差分取得のほうが速い', Number(incSec) < Number(fullSec), `${incSec}秒 < ${fullSec}秒`);

/* ---------------- 3. 読み取り位置を巻き戻しても一致するか ---------------- */
console.log('\n[3] 読み取り位置を100万ブロック巻き戻して再取得（取りこぼしが出ないか）');
{
  const c = memCache();
  const cached = JSON.parse(JSON.stringify(baseCache.get(`rewards:${WALLET.toLowerCase()}`)));
  for (const e of Object.values(cached.bySource)) {
    e.scannedTo -= 1_000_000;
    // 巻き戻した範囲のログをわざと消す。差分取得が取り直せていれば復元されるはず
    e.logs = e.logs.filter((l) => l.blockNumber < e.scannedTo - 200_000 + 1);
  }
  c.set(`rewards:${WALLET.toLowerCase()}`, cached);
  const r = await collectRewards(WALLET, { cache: c });
  check('巻き戻し後も全期間取得と一致', fingerprint(r.rewards, rewardId) === baseRewardFp,
    `${r.rewards.length} 件 vs ${baseRewards.rewards.length} 件`);
}

/* ---------------- 4. 再編成の模擬 ---------------- */
console.log('\n[4] 再編成(reorg)の模擬 — 実在しないログを混ぜたら消えるか');
{
  const c = memCache();
  const key = `rewards:${WALLET.toLowerCase()}`;
  const cached = JSON.parse(JSON.stringify(baseCache.get(key)));
  const src = Object.keys(cached.bySource)[0];
  const entry = cached.bySource[src];
  // 再取得される範囲（scannedTo - 200000 以降）に、チェーン上には無いログを仕込む
  const ghostBlock = entry.scannedTo - 1000;
  entry.logs.push({
    source: src, contract: 'X', contractAddress: '0x0', category: 'delegation',
    categoryLabel: 'ダミー', detailLabel: 'ダミー', epoch: '999',
    amountWei: '999000000000000000000', amountFlr: 999,
    blockNumber: ghostBlock, timestamp: Math.floor(Date.now() / 1000),
    txHash: '0xghost', logIndex: 0,
  });
  c.set(key, cached);

  const r = await collectRewards(WALLET, { cache: c });
  const hasGhost = r.rewards.some((x) => x.txHash === '0xghost');
  check('再編成で無効になったログが除去される', !hasGhost);
  check('除去後も全期間取得と一致', fingerprint(r.rewards, rewardId) === baseRewardFp);
}

/* ---------------- 5. 古い形式のキャッシュ ---------------- */
console.log('\n[5] 形式の違うキャッシュは読み捨てて取り直すか');
{
  const c = memCache();
  c.set(`rewards:${WALLET.toLowerCase()}`, { version: 1, rewards: [], warnings: [] });
  const r = await collectRewards(WALLET, { cache: c });
  check('古い形式は無視して全期間取り直し', fingerprint(r.rewards, rewardId) === baseRewardFp,
    `${r.rewards.length} 件`);
}

/* ---------------- 6. 強制再取得 ---------------- */
console.log('\n[6] 「キャッシュを無視して再取得」が全期間を取り直すか');
{
  const r = await collectRewards(WALLET, { cache: baseCache, force: true });
  check('force 指定で差分取得しない', r.incremental === false);
  check('force でも結果は一致', fingerprint(r.rewards, rewardId) === baseRewardFp);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`  成功 ${pass} 件 / 失敗 ${fail} 件`);
console.log(`  全期間 ${fullSec} 秒 → 差分 ${incSec} 秒`);
console.log('='.repeat(50) + '\n');
process.exit(fail ? 1 : 0);
