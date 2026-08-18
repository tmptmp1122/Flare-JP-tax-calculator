/**
 * 共通ロジックの検証スクリプト。
 *
 *   npm run verify
 *
 * ブラウザ版は軽量化のため ethers を積んでいない（topic ハッシュは埋め込み、
 * ABI 復号は自前）。ここで ethers を正解として突き合わせ、その手抜きが
 * 正しいことを保証する。税額計算は手計算値と照合する。
 */

import { ethers } from 'ethers';
import { REWARD_EVENTS, CHAIN } from '../shared/config.js';
import { decodeLogData, addressToTopic, weiToNumber, splitWords } from '../shared/decode.js';
import { resolveContracts } from '../shared/chain-core.js';
import { estimateTax, incomeTaxFromTaxable, basicDeduction } from '../shared/tax.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};
const eq = (name, got, want) => check(name, got === want, got === want ? '' : `got=${got} want=${want}`);

/* ---------------- 1. イベント topic ハッシュ ---------------- */
console.log('\n[1] 埋め込み topic0 が keccak256(シグネチャ) と一致するか');
for (const d of REWARD_EVENTS) {
  eq(d.id, d.topic0, ethers.id(d.signature));
}

/* ---------------- 2. レジストリ復号 ---------------- */
console.log('\n[2] FlareContractRegistry の自前復号が ethers と一致するか');
const mine = await resolveContracts();
const provider = new ethers.JsonRpcProvider(CHAIN.rpc, CHAIN.chainId, { staticNetwork: true });
try {
  const reg = new ethers.Contract(CHAIN.registry, ['function getAllContracts() view returns (string[], address[])'], provider);
  const [names, addrs] = await reg.getAllContracts();
  let diff = 0;
  names.forEach((n, i) => {
    if ((mine[n] || '').toLowerCase() !== addrs[i].toLowerCase()) {
      diff++;
      console.log(`       差異: ${n} 自前=${mine[n]} ethers=${addrs[i]}`);
    }
  });
  check(`レジストリ ${names.length} 件すべて一致`, diff === 0, diff ? `不一致 ${diff} 件` : '');
  // 報酬コントラクトが確かに取れているか
  for (const d of REWARD_EVENTS) {
    check(`${d.contract} のアドレス解決`, !!mine[d.contract], mine[d.contract] || '未解決');
  }
} catch (e) {
  check('レジストリ照会', false, e.message);
}

/* ---------------- 3. ログ復号 ---------------- */
console.log('\n[3] 自前の ABI 復号が ethers と一致するか（実チェーンのログで検証）');
const TEST_WALLET = '0xd9B2DB0baB36c78f52968624b148923F49394949';
// parseLog は topic0 で照合するため、イベント名も実物と一致させる必要がある
const ABIS = {
  rewardmanager_v2:
    'event RewardClaimed(address indexed a,address indexed b,address indexed c,uint24 rewardEpochId,uint8 claimType,uint120 amount)',
  ftsorewardmanager_v1:
    'event RewardClaimed(address indexed a,address indexed b,address indexed c,uint256 rewardEpoch,uint256 amount)',
  flaredrop: 'event AccountClaimed(address indexed a,address indexed b,uint256 month,uint256 amountWei)',
};

for (const def of REWARD_EVENTS) {
  const abi = ABIS[def.id];
  if (!abi) continue;
  const addr = mine[def.contract];
  const params = new URLSearchParams({
    module: 'logs', action: 'getLogs', fromBlock: '0', toBlock: 'latest',
    address: addr, topic0: def.topic0,
    [`topic${def.walletTopic}`]: addressToTopic(TEST_WALLET),
    [`topic0_${def.walletTopic}_opr`]: 'and',
  });
  let logs = [];
  try {
    const j = await (await fetch(`${CHAIN.explorerApi}?${params}`, { signal: AbortSignal.timeout(60000) })).json();
    logs = Array.isArray(j.result) ? j.result.slice(0, 5) : [];
  } catch (e) {
    check(`${def.id} のログ取得`, false, e.message);
    continue;
  }
  if (logs.length === 0) {
    console.log(`  --   ${def.id}: 検証用ログなし（スキップ）`);
    continue;
  }
  const iface = new ethers.Interface([abi]);
  let bad = 0;
  for (const log of logs) {
    const m = decodeLogData(log.data, def.dataFields);
    const e = iface.parseLog({ topics: log.topics.filter(Boolean), data: log.data }).args;
    for (const f of def.dataFields) {
      if (m[f] !== BigInt(e[f])) bad++;
    }
  }
  check(`${def.id} のログ ${logs.length} 件の全フィールド一致`, bad === 0, bad ? `不一致 ${bad}` : '');
}

/* ---------------- 4. wei 変換 ---------------- */
console.log('\n[4] wei → FLR 変換が ethers.formatEther と一致するか');
for (const v of ['1', '1000000000000000000', '19482996456096376138', '376786000499916400000000', '123456789']) {
  const got = weiToNumber(BigInt(v));
  const want = Number(ethers.formatEther(v));
  check(`${v} wei`, Math.abs(got - want) < Math.max(1e-9, Math.abs(want) * 1e-12), `${got} vs ${want}`);
}

/* ---------------- 5. 税額計算 ---------------- */
console.log('\n[5] 税額計算（国税庁の速算表・基礎控除と照合）');
eq('課税1,949,000円 → 5%', incomeTaxFromTaxable(1_949_000), Math.floor(1949000 * 0.05));
eq('課税1,950,000円 → 10%', incomeTaxFromTaxable(1_950_000), Math.floor(1950000 * 0.1 - 97500));
eq('課税3,300,000円 → 20%', incomeTaxFromTaxable(3_300_000), Math.floor(3300000 * 0.2 - 427500));
eq('課税7,000,000円 → 23%', incomeTaxFromTaxable(7_000_000), Math.floor(7000000 * 0.23 - 636000));
eq('課税40,000,000円 → 45%', incomeTaxFromTaxable(40_000_000), Math.floor(40000000 * 0.45 - 4796000));
eq('基礎控除 2026年 所得300万', basicDeduction(3_000_000, 2026), 880_000);
eq('基礎控除 2026年 所得600万', basicDeduction(6_000_000, 2026), 630_000);
eq('基礎控除 2027年 所得600万', basicDeduction(6_000_000, 2027), 580_000);
eq('基礎控除 所得100万', basicDeduction(1_000_000, 2026), 950_000);
eq('基礎控除 所得2,460万', basicDeduction(24_600_000, 2026), 160_000);

{
  // 給与所得500万 + FLR報酬100万 - ガス2万、控除80万（2026年）
  const r = estimateTax({ rewardIncomeJpy: 1_000_000, gasExpenseJpy: 20_000, otherIncomeJpy: 5_000_000, otherDeductionsJpy: 800_000, year: 2026 });
  eq('雑所得', r.miscIncome, 980_000);
  // 合計所得598万 → 基礎控除63万 → 課税所得455万 → 20%区分
  eq('課税所得', r.withFlr.taxableIncome, 4_550_000);
  eq('所得税', r.withFlr.incomeTax, Math.floor(4_550_000 * 0.2 - 427_500));
  check('FLR起因の税額が正', r.attributable.total > 0, `${r.attributable.total.toLocaleString()}円`);
}
{
  // 雑所得が赤字でも他の所得と損益通算しない
  const r = estimateTax({ rewardIncomeJpy: 10_000, gasExpenseJpy: 50_000, otherIncomeJpy: 3_000_000, year: 2026 });
  eq('赤字時の雑所得は0', r.miscIncome, 0);
  eq('赤字時のFLR起因税額は0', r.attributable.total, 0);
}

/* ---------------- 6. 価格データ ---------------- */
console.log('\n[6] 同梱の価格データ');
try {
  const { readFileSync } = await import('node:fs');
  const p = JSON.parse(readFileSync(new URL('../static/data/prices.json', import.meta.url)));
  const nFlr = p.flrUsd.values.filter((v) => v != null).length;
  const nFx = p.usdJpy.values.filter((v) => v != null).length;
  check('FLR/USD の日数', nFlr > 1000, `${nFlr}日 (${p.flrUsd.start}〜)`);
  check('USD/JPY の日数', nFx > 700, `${nFx}日 (${p.usdJpy.start}〜)`);
  const idx = (s, d) => Math.round((new Date(d) - new Date(s)) / 86400000);
  const a = p.flrUsd.values[idx(p.flrUsd.start, '2025-01-03')];
  const b = p.usdJpy.values[idx(p.usdJpy.start, '2025-01-03')];
  check('2025-01-03 の FLR/JPY が妥当', a * b > 1 && a * b < 100, `${(a * b).toFixed(5)} 円`);
} catch (e) {
  check('価格データの読み込み', false, e.message);
}

provider.destroy();
console.log(`\n${'='.repeat(50)}`);
console.log(`  成功 ${pass} 件 / 失敗 ${fail} 件`);
console.log('='.repeat(50) + '\n');
process.exit(fail ? 1 : 0);
