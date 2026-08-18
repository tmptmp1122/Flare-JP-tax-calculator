/**
 * ローカルWebアプリ版のサーバー。
 *
 * 集計・税額計算・Excel出力のロジックは shared/ にあり、静的サイト版と共通。
 * このサーバーが担うのは SQLite によるキャッシュとウォレット保存だけ。
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import * as db from './src/db.js';
import { ensurePrices, loadRateMaps, todayUtc } from './src/prices-node.js';
import { collectRewards, collectGas, resolveContracts } from './shared/chain-core.js';
import { isValidAddress, normalizeAddress } from './shared/decode.js';
import { buildReport, makeRateTable } from './shared/report.js';
import { estimateTax } from './shared/tax.js';
import { buildWorkbook, rewardsCsv, gasCsv } from './shared/workbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

/**
 * shared/chain-core に渡す SQLite キャッシュ。
 *
 * 有効期限は設けない。スキャンのたびに「前回の続き」から差分だけを取り直すので、
 * キャッシュが古いまま使われることはなく、かつ全期間の再取得も起きない。
 */
const sqliteCache = {
  get: (key) => db.getCache(key, null),
  set: (key, value) => db.setCache(key, value),
};

/** 直近のレポートを保持し、エクスポート時に再取得しなくて済むようにする */
const reportStore = new Map();

const asHandler = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'サーバーエラーが発生しました' });
  });
};

/* ---------------- ウォレット管理 ---------------- */

app.get('/api/wallets', asHandler((req, res) => res.json(db.listWallets())));

app.post('/api/wallets', asHandler((req, res) => {
  const { address, label = '', note = '' } = req.body || {};
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: '有効なFlareアドレス(0x...)を入力してください' });
  }
  db.addWallet(normalizeAddress(address), String(label).slice(0, 100), String(note).slice(0, 500));
  res.json({ ok: true, wallets: db.listWallets() });
}));

app.delete('/api/wallets/:address', asHandler((req, res) => {
  db.removeWallet(req.params.address);
  res.json({ ok: true, wallets: db.listWallets() });
}));

/* ---------------- スキャン ---------------- */

app.post('/api/scan', asHandler(async (req, res) => {
  const { addresses, from, to, refresh } = req.body || {};

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: '対象のウォレットを1つ以上選択してください' });
  }
  const bad = addresses.find((a) => !isValidAddress(a));
  if (bad) return res.status(400).json({ error: `無効なアドレスです: ${bad}` });

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from || '') || !dateRe.test(to || '')) {
    return res.status(400).json({ error: '期間は YYYY-MM-DD 形式で指定してください' });
  }
  if (from > to) return res.status(400).json({ error: '開始日が終了日より後になっています' });

  const wallets = addresses.map(normalizeAddress);
  const rewards = [];
  const gasTxs = [];
  const warnings = [];

  for (const w of wallets) {
    const r = await collectRewards(w, { cache: sqliteCache, force: !!refresh });
    warnings.push(...r.warnings.map((m) => `[${w}] ${m}`));
    for (const x of r.rewards) rewards.push({ ...x, wallet: w });

    const g = await collectGas(w, { cache: sqliteCache, force: !!refresh });
    warnings.push(...g.warnings.map((m) => `[${w}] ${m}`));
    for (const x of g.gasTxs) gasTxs.push({ ...x, wallet: w });
  }

  // 価格は未来日を要求しても意味がないので今日で頭打ちにする
  const priceTo = to > todayUtc() ? todayUtc() : to;
  warnings.push(...(await ensurePrices(from, priceTo)));
  const rates = makeRateTable(loadRateMaps(from, priceTo), from, priceTo);

  const report = buildReport({ wallets, rewards, gasTxs, rates, from, to, warnings });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  reportStore.set(id, report);
  if (reportStore.size > 20) reportStore.delete(reportStore.keys().next().value);

  res.json({ id, ...report });
}));

/* ---------------- 税額計算 ---------------- */

app.post('/api/tax', asHandler((req, res) => {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  res.json(estimateTax({
    rewardIncomeJpy: num(req.body?.rewardIncomeJpy),
    gasExpenseJpy: num(req.body?.gasExpenseJpy),
    otherIncomeJpy: num(req.body?.otherIncomeJpy),
    otherDeductionsJpy: num(req.body?.otherDeductionsJpy),
    year: Number(req.body?.year) || new Date().getFullYear(),
  }));
}));

/* ---------------- エクスポート ---------------- */

function getReport(req, res) {
  const report = reportStore.get(req.query.id);
  if (!report) {
    res.status(404).json({ error: 'レポートが見つかりません。もう一度スキャンしてください。' });
    return null;
  }
  return report;
}

/** 日本語ファイル名は RFC 5987 でエンコードして渡す */
function filenameHeader(res, name) {
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
}

app.get('/api/export/xlsx', asHandler(async (req, res) => {
  const report = getReport(req, res);
  if (!report) return;

  let taxResult = null;
  if (req.query.tax) {
    try {
      taxResult = JSON.parse(req.query.tax);
    } catch {
      /* 税額が無くてもレポート自体は出力する */
    }
  }

  const wb = await buildWorkbook(ExcelJS, report, taxResult);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  filenameHeader(res, `FLR報酬レポート_${report.period.from}_${report.period.to}.xlsx`);
  res.send(buf);
}));

app.get('/api/export/csv', asHandler((req, res) => {
  const report = getReport(req, res);
  if (!report) return;

  const isGas = req.query.kind === 'gas';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  filenameHeader(res, `FLR${isGas ? 'ガス代明細' : '報酬明細'}_${report.period.from}_${report.period.to}.csv`);
  res.send(isGas ? gasCsv(report) : rewardsCsv(report));
}));

/* ---------------- 起動 ---------------- */

app.get('/api/health', asHandler(async (req, res) => {
  res.json({ ok: true, contracts: await resolveContracts() });
}));

app.listen(PORT, () => {
  console.log(`\n  FLR獲得金額算出アプリ が起動しました`);
  console.log(`  ブラウザで開いてください →  http://localhost:${PORT}\n`);
});
