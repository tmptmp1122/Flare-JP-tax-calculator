/**
 * レポートを Excel(.xlsx) と CSV に出力する。
 * Excel は Google スプレッドシートでもそのまま開ける形式。
 */


const JPY_FMT = '#,##0';
const FLR_FMT = '#,##0.000000';
const RATE_FMT = '#,##0.0000000';

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE62058' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 22;
}

function autoWidth(sheet, minWidth = 10) {
  sheet.columns.forEach((col) => {
    let max = minWidth;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      // 日本語は概ね2文字幅として見積もる
      const s = String(cell.value ?? '');
      const len = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 48);
  });
}

export async function buildWorkbook(ExcelJS, report, taxResult) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FLR獲得金額算出アプリ';
  wb.created = new Date();

  /* ---------------- サマリー ---------------- */
  const s = wb.addWorksheet('サマリー');
  s.addRow(['FLR 報酬・ガス代 集計レポート']).font = { bold: true, size: 16 };
  s.addRow([]);
  s.addRow(['対象期間', `${report.period.from} 〜 ${report.period.to}（JST）`]);
  s.addRow(['対象ウォレット', report.wallets.join('\n')]).alignment = { wrapText: true, vertical: 'top' };
  s.addRow(['作成日時', new Date(report.generatedAt).toLocaleString('ja-JP')]);
  s.addRow([]);

  const sum = report.summary;
  styleHeader(s.addRow(['項目', 'FLR', '円(JPY)']));
  s.addRow(['報酬 合計（収入金額）', sum.totalRewardFlr, sum.totalRewardJpy]);
  s.addRow(['ガス代 合計（必要経費の候補）', sum.totalGasFlr, sum.totalGasJpy]);
  s.addRow(['差引（報酬 − ガス代）', sum.totalRewardFlr - sum.totalGasFlr, sum.netJpy]);
  s.addRow([]);
  s.addRow(['報酬の受取回数', sum.rewardCount]);
  s.addRow(['送信トランザクション数', sum.gasTxCount]);
  s.getColumn(2).numFmt = FLR_FMT;
  s.getColumn(3).numFmt = JPY_FMT;

  if (taxResult) {
    s.addRow([]);
    s.addRow(['■ 税額の概算']).font = { bold: true, size: 13 };
    styleHeader(s.addRow(['項目', '金額(円)', '']));
    const t = taxResult;
    s.addRow(['雑所得の金額（報酬 − 経費）', t.miscIncome]);
    s.addRow(['FLR以外の合計所得金額', t.input.otherIncomeJpy]);
    s.addRow(['所得控除（基礎控除以外）', t.input.otherDeductionsJpy]);
    s.addRow(['基礎控除', t.withFlr.basicDeduction]);
    s.addRow(['課税所得金額', t.withFlr.taxableIncome]);
    s.addRow([]);
    s.addRow(['FLR報酬による増加分 — 所得税', t.attributable.incomeTax]);
    s.addRow(['FLR報酬による増加分 — 復興特別所得税', t.attributable.reconstructionTax]);
    s.addRow(['FLR報酬による増加分 — 住民税(所得割)', t.attributable.residentTax]);
    const totalRow = s.addRow(['FLR報酬にかかる税金 合計（概算）', t.attributable.total]);
    totalRow.font = { bold: true };
    s.addRow(['雑所得に対する実効税率', `${(t.effectiveRate * 100).toFixed(2)}%`]);
    s.addRow([]);
    s.addRow(['※ 概算値です。実際の納税額は他の所得・控除・自治体により異なります。']).font = {
      italic: true,
      color: { argb: 'FF888888' },
    };
  }
  s.getColumn(1).width = 40;
  s.getColumn(2).width = 20;
  s.getColumn(3).width = 20;
  s.getColumn(2).numFmt = JPY_FMT;

  /* ---------------- 報酬明細 ---------------- */
  const rw = wb.addWorksheet('報酬明細');
  styleHeader(
    rw.addRow([
      '日時(JST)',
      '日付',
      'ウォレット',
      '種別',
      '詳細',
      'エポック/月',
      '数量(FLR)',
      'FLR/USD',
      'USD/JPY',
      'FLR/JPY',
      '評価額(円)',
      'レート補完',
      'トランザクション',
    ])
  );
  for (const r of report.rewards) {
    rw.addRow([
      r.datetimeJst,
      r.date,
      r.wallet,
      r.categoryLabel,
      r.detailLabel,
      r.epoch ?? '',
      r.amountFlr,
      r.flrUsd ?? '',
      r.usdJpy ?? '',
      r.flrJpy ?? '',
      r.jpy != null ? Math.round(r.jpy) : '',
      r.rateEstimated ? '補完' : '',
      r.txHash,
    ]);
  }
  rw.getColumn(7).numFmt = FLR_FMT;
  rw.getColumn(8).numFmt = RATE_FMT;
  rw.getColumn(9).numFmt = '#,##0.00';
  rw.getColumn(10).numFmt = RATE_FMT;
  rw.getColumn(11).numFmt = JPY_FMT;
  rw.views = [{ state: 'frozen', ySplit: 1 }];
  rw.autoFilter = { from: 'A1', to: 'M1' };
  autoWidth(rw);

  /* ---------------- ガス代明細 ---------------- */
  const gs = wb.addWorksheet('ガス代明細');
  styleHeader(
    gs.addRow([
      '日時(JST)',
      '日付',
      'ウォレット',
      'メソッド',
      '送信先',
      '結果',
      'ガス使用量',
      '手数料(FLR)',
      'FLR/JPY',
      '手数料(円)',
      'トランザクション',
    ])
  );
  for (const g of report.gas) {
    gs.addRow([
      g.datetimeJst,
      g.date,
      g.wallet,
      g.method,
      g.toName || g.to || '',
      g.success ? '成功' : '失敗',
      g.gasUsed ? Number(g.gasUsed) : '',
      g.feeFlr,
      g.flrJpy ?? '',
      g.jpy != null ? Math.round(g.jpy) : '',
      g.txHash,
    ]);
  }
  gs.getColumn(8).numFmt = FLR_FMT;
  gs.getColumn(9).numFmt = RATE_FMT;
  gs.getColumn(10).numFmt = JPY_FMT;
  gs.views = [{ state: 'frozen', ySplit: 1 }];
  gs.autoFilter = { from: 'A1', to: 'K1' };
  autoWidth(gs);

  /* ---------------- 種別集計 ---------------- */
  const cat = wb.addWorksheet('種別集計');
  styleHeader(cat.addRow(['種別', '件数', '数量(FLR)', '評価額(円)']));
  for (const c of report.byCategory) cat.addRow([c.label, c.count, c.flr, Math.round(c.jpy)]);
  cat.getColumn(3).numFmt = FLR_FMT;
  cat.getColumn(4).numFmt = JPY_FMT;
  autoWidth(cat, 14);

  /* ---------------- 月別集計 ---------------- */
  const mo = wb.addWorksheet('月別集計');
  styleHeader(mo.addRow(['年月', '報酬(FLR)', '報酬(円)', 'ガス代(FLR)', 'ガス代(円)', '差引(円)']));
  for (const m of report.byMonth) {
    mo.addRow([m.month, m.rewardFlr, Math.round(m.rewardJpy), m.gasFlr, Math.round(m.gasJpy), Math.round(m.netJpy)]);
  }
  mo.getColumn(2).numFmt = FLR_FMT;
  mo.getColumn(4).numFmt = FLR_FMT;
  [3, 5, 6].forEach((c) => (mo.getColumn(c).numFmt = JPY_FMT));
  autoWidth(mo, 14);

  /* ---------------- 年別集計 ---------------- */
  const yr = wb.addWorksheet('年別集計');
  styleHeader(yr.addRow(['年', '報酬(FLR)', '報酬(円)', 'ガス代(FLR)', 'ガス代(円)', '差引＝雑所得(円)']));
  for (const y of report.byYear) {
    yr.addRow([y.year, y.rewardFlr, Math.round(y.rewardJpy), y.gasFlr, Math.round(y.gasJpy), Math.round(y.netJpy)]);
  }
  yr.getColumn(2).numFmt = FLR_FMT;
  yr.getColumn(4).numFmt = FLR_FMT;
  [3, 5, 6].forEach((c) => (yr.getColumn(c).numFmt = JPY_FMT));
  autoWidth(yr, 14);

  /* ---------------- ウォレット別 ---------------- */
  if (report.byWallet.length > 1) {
    const wl = wb.addWorksheet('ウォレット別');
    styleHeader(wl.addRow(['ウォレット', '報酬(FLR)', '報酬(円)', 'ガス代(FLR)', 'ガス代(円)']));
    for (const w of report.byWallet) {
      wl.addRow([w.wallet, w.rewardFlr, Math.round(w.rewardJpy), w.gasFlr, Math.round(w.gasJpy)]);
    }
    wl.getColumn(2).numFmt = FLR_FMT;
    wl.getColumn(4).numFmt = FLR_FMT;
    [3, 5].forEach((c) => (wl.getColumn(c).numFmt = JPY_FMT));
    autoWidth(wl, 14);
  }

  /* ---------------- 注意事項 ---------------- */
  const nt = wb.addWorksheet('注意事項');
  nt.getColumn(1).width = 110;
  const notes = [
    '【このレポートについて】',
    '・報酬は各報酬コントラクトの請求イベント(RewardClaimed 等)から取得しています。',
    '  報酬をWNat(ラップFLR)で受け取った場合も漏れなく計上されます。',
    '・評価額は「受取日(JST)の FLR/USD 終値 × USD/JPY 終値」で円換算しています。',
    '・日本の税制では、暗号資産の報酬は原則として受取時の時価で雑所得(総合課税)として計上します。',
    '・ガス代の必要経費算入は、その支出が報酬獲得に直接必要だったかで判断が分かれます。',
    '  本レポートは全ガス代を集計しているため、経費算入の範囲は税理士にご確認ください。',
    '・税額はあくまで概算です。実際の納税額は他の所得・各種控除・お住まいの自治体により変わります。',
    '',
    '【警告・注記】',
    ...(report.warnings.length ? report.warnings.map((w) => `・${w}`) : ['・特にありません']),
  ];
  notes.forEach((n) => nt.addRow([n]));

  return wb;
}


/** Excel / スプレッドシートで文字化けしないよう BOM 付き UTF-8 で出力 */
export function toCsv(rows, header) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '﻿' + lines.join('\r\n');
}

export function rewardsCsv(report) {
  return toCsv(
    report.rewards.map((r) => [
      r.datetimeJst,
      r.date,
      r.wallet,
      r.categoryLabel,
      r.detailLabel,
      r.epoch ?? '',
      r.amountFlr,
      r.flrUsd ?? '',
      r.usdJpy ?? '',
      r.flrJpy ?? '',
      r.jpy != null ? Math.round(r.jpy) : '',
      r.rateEstimated ? '補完' : '',
      r.txHash,
    ]),
    ['日時(JST)', '日付', 'ウォレット', '種別', '詳細', 'エポック/月', '数量(FLR)', 'FLR/USD', 'USD/JPY', 'FLR/JPY', '評価額(円)', 'レート補完', 'トランザクション']
  );
}

export function gasCsv(report) {
  return toCsv(
    report.gas.map((g) => [
      g.datetimeJst,
      g.date,
      g.wallet,
      g.method,
      g.toName || g.to || '',
      g.success ? '成功' : '失敗',
      g.gasUsed ?? '',
      g.feeFlr,
      g.flrJpy ?? '',
      g.jpy != null ? Math.round(g.jpy) : '',
      g.txHash,
    ]),
    ['日時(JST)', '日付', 'ウォレット', 'メソッド', '送信先', '結果', 'ガス使用量', '手数料(FLR)', 'FLR/JPY', '手数料(円)', 'トランザクション']
  );
}
