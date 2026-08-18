/**
 * 静的サイト版のUI。サーバーを介さず、ブラウザ内で完結する。
 *
 * 集計・税額計算・Excel出力は js/shared/ の共通ロジックをそのまま使うため、
 * ローカルWebアプリ版と必ず同じ結果になる。
 */

import { collectRewards, collectGas } from './shared/chain-core.js';
import { isValidAddress, normalizeAddress } from './shared/decode.js';
import { buildReport } from './shared/report.js';
import { estimateTax } from './shared/tax.js';
import { buildWorkbook, rewardsCsv, gasCsv } from './shared/workbook.js';
import { computeSouHeikinho, computeIdouHeikinho, listAvailableYears } from './shared/nta-form.js';
import { fillSouHeikinho, fillIdouHeikinho } from './shared/nta-workbook.js';
import { loadRates, makeRateTableBrowser } from './prices-browser.js';
import * as store from './storage.js';

const NTA_ASSET_NAME = 'FLR（フレア）';
const NTA_TEMPLATE_URL = {
  sou: 'assets/nta-templates/soheikinho.xlsx',
  idou: 'assets/nta-templates/idouheikinho.xlsx',
};

const $ = (id) => document.getElementById(id);
const EXPLORER = 'https://flare-explorer.flare.network';

const state = { wallets: [], selected: new Set(), report: null, tax: null };

/* ---------------- 表示用ヘルパ ---------------- */

// Math.round(-0.4) は -0 になるため 0 に寄せる
const jpy = (v) => (v == null ? '—' : (Math.round(v) || 0).toLocaleString('ja-JP') + ' 円');
const flr = (v) => (v == null ? '—' : v.toLocaleString('ja-JP', { maximumFractionDigits: 4 }) + ' FLR');
const pct = (v) => (v * 100).toFixed(2) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortHash = (h) => (h ? h.slice(0, 10) + '…' + h.slice(-6) : '');
const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

function buildTable(el, columns, rows, footer) {
  const head = `<thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody>`
    : `<tbody><tr><td colspan="${columns.length}" class="empty">データがありません</td></tr></tbody>`;
  const foot = footer
    ? `<tfoot><tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${footer[c.key] ?? ''}</td>`).join('')}</tr></tfoot>`
    : '';
  el.innerHTML = head + body + foot;
}

/* ---------------- 桁区切り入力欄 ---------------- */

/**
 * カンマ区切り表示の数値入力を扱う。
 * 入力のたびに桁区切りへ整形し直し、カーソル位置もできるだけ保つ。
 * @returns {() => void} 整形だけを行う関数（初期値をセットした直後などに呼ぶ）
 */
function attachThousandsFormatting(el) {
  el.setAttribute('inputmode', 'decimal');
  el.setAttribute('autocomplete', 'off');

  const reformat = () => {
    const start = el.selectionStart ?? el.value.length;
    // カーソルより前にある「数字」の個数を数えておき、整形後も同じ位置に戻す
    const digitsBeforeCursor = el.value.slice(0, start).replace(/[^0-9]/g, '').length;

    let raw = el.value.replace(/[^0-9.]/g, '');
    const firstDot = raw.indexOf('.');
    if (firstDot !== -1) raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '');

    const [intRaw, decRaw] = raw.split('.');
    const intDigits = (intRaw || '').replace(/^0+(?=\d)/, '');
    const formattedInt = intDigits ? Number(intDigits).toLocaleString('ja-JP') : '';
    const next = formattedInt + (decRaw !== undefined ? '.' + decRaw : '');
    el.value = next;

    if (digitsBeforeCursor === 0) {
      el.setSelectionRange(0, 0);
      return;
    }
    let count = 0;
    for (let i = 0; i < next.length; i++) {
      if (/[0-9]/.test(next[i])) count++;
      if (count === digitsBeforeCursor) {
        el.setSelectionRange(i + 1, i + 1);
        return;
      }
    }
    el.setSelectionRange(next.length, next.length);
  };

  el.addEventListener('input', reformat);
  return reformat;
}

/** カンマ区切り表示の欄から数値を取り出す */
function parseFormattedNumber(el) {
  const n = Number(String(el.value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 桁区切り整形をつけたうえで、ブラウザに値を記憶させる */
function bindPersistedNumberInput(id, storageKey, defaultValue) {
  const el = $(id);
  const reformat = attachThousandsFormatting(el);
  const saved = store.getSetting(storageKey, defaultValue);
  el.value = String(saved);
  reformat();
  el.addEventListener('input', () => {
    store.setSetting(storageKey, parseFormattedNumber(el));
  });
}

function setProgress(msg) {
  const el = $('progress');
  if (msg == null) {
    el.classList.add('hidden');
  } else {
    el.classList.remove('hidden');
    el.textContent = msg;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- ウォレット ---------------- */

function renderWallets() {
  const el = $('wallet-list');
  if (state.wallets.length === 0) {
    el.innerHTML = '<div class="empty">まだウォレットが登録されていません。上のフォームからアドレスを追加してください。</div>';
    return;
  }
  el.innerHTML = state.wallets
    .map(
      (w) => `
      <div class="wallet-item">
        <input type="checkbox" data-addr="${esc(w.address)}" ${state.selected.has(w.address) ? 'checked' : ''}>
        <div class="grow">
          ${w.label ? `<span class="label">${esc(w.label)}</span>` : ''}
          <span class="addr">${esc(w.address)}</span>
        </div>
        <button class="del" data-del="${esc(w.address)}" title="削除">×</button>
      </div>`
    )
    .join('');

  el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => (cb.checked ? state.selected.add(cb.dataset.addr) : state.selected.delete(cb.dataset.addr));
  });
  el.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      if (!confirm('このウォレットを削除しますか？')) return;
      state.wallets = store.removeWallet(b.dataset.del);
      state.selected.delete(b.dataset.del);
      renderWallets();
    };
  });
}

$('wallet-form').onsubmit = (e) => {
  e.preventDefault();
  const address = $('w-address').value.trim();
  if (!address) return;
  if (!isValidAddress(address)) {
    alert('有効なFlareアドレス(0x で始まる42文字)を入力してください');
    return;
  }
  state.wallets = store.addWallet(normalizeAddress(address), $('w-label').value.trim());
  state.selected.add(normalizeAddress(address));
  $('w-address').value = '';
  $('w-label').value = '';
  renderWallets();
};

/* ---------------- 期間 ---------------- */

function initPeriod() {
  const now = new Date();
  const y = now.getFullYear();
  $('from-date').value = `${y}-01-01`;
  $('to-date').value = now.toISOString().slice(0, 10);

  const presets = [
    { label: '今年', from: `${y}-01-01`, to: `${y}-12-31` },
    { label: `${y - 1}年`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
    { label: `${y - 2}年`, from: `${y - 2}-01-01`, to: `${y - 2}-12-31` },
    { label: '全期間', from: '2022-01-01', to: `${y}-12-31` },
  ];
  $('presets').innerHTML = presets.map((p, i) => `<button type="button" data-i="${i}">${p.label}</button>`).join('');
  $('presets')
    .querySelectorAll('button')
    .forEach((b) => {
      b.onclick = () => {
        const p = presets[+b.dataset.i];
        $('from-date').value = p.from;
        $('to-date').value = p.to;
      };
    });

  const sel = $('tax-year');
  sel.innerHTML = '';
  for (let yy = y; yy >= 2022; yy--) sel.innerHTML += `<option value="${yy}">${yy} 年</option>`;
}

/* ---------------- スキャン ---------------- */

$('scan-btn').onclick = async () => {
  const addresses = [...state.selected];
  if (addresses.length === 0) return alert('対象のウォレットを選択してください');

  const from = $('from-date').value;
  const to = $('to-date').value;
  if (!from || !to) return alert('期間を指定してください');
  if (from > to) return alert('開始日が終了日より後になっています');

  const btn = $('scan-btn');
  btn.disabled = true;

  try {
    const force = $('refresh-cache').checked;
    const wallets = addresses.map(normalizeAddress);
    const rewards = [];
    const gasTxs = [];
    const warnings = [];

    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      const tag = wallets.length > 1 ? `(${i + 1}/${wallets.length}) ` : '';

      setProgress(`${tag}${shortAddr(w)} の報酬を取得しています…`);
      const r = await collectRewards(w, {
        cache: store.cache,
        force,
        onProgress: (p) =>
          p.step && setProgress(`${tag}${shortAddr(w)} の報酬を取得中… ${p.step}/${p.total} (${p.label})`),
      });
      warnings.push(...r.warnings.map((m) => `[${shortAddr(w)}] ${m}`));
      for (const x of r.rewards) rewards.push({ ...x, wallet: w });

      setProgress(`${tag}${shortAddr(w)} のガス代を取得しています…`);
      const g = await collectGas(w, {
        cache: store.cache,
        force,
        onProgress: (p) => p.step && setProgress(`${tag}${shortAddr(w)} のガス代を取得中… ${p.label}`),
      });
      warnings.push(...g.warnings.map((m) => `[${shortAddr(w)}] ${m}`));
      for (const x of g.gasTxs) gasTxs.push({ ...x, wallet: w });
    }

    setProgress('価格・為替レートを読み込んでいます…');
    const today = new Date().toISOString().slice(0, 10);
    const priceTo = to > today ? today : to;
    const rateSrc = await loadRates(from, priceTo);
    warnings.push(...rateSrc.notes);
    const rates = makeRateTableBrowser(rateSrc, from, priceTo);

    setProgress('集計しています…');
    state.report = buildReport({ wallets, rewards, gasTxs, rates, from, to, warnings });

    renderReport(state.report);
    $('results').classList.remove('hidden');

    const yr = to.slice(0, 4);
    if ([...$('tax-year').options].some((o) => o.value === yr)) $('tax-year').value = yr;
    recalcTax();
    initNtaYearSelect(yr);
    recalcNta();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    alert('集計に失敗しました: ' + err.message);
  } finally {
    btn.disabled = false;
    setProgress(null);
  }
};

/* ---------------- 結果の描画 ---------------- */

function renderReport(r) {
  const s = r.summary;

  $('stats').innerHTML = `
    <div class="stat accent">
      <div class="k">報酬 合計（収入金額）</div>
      <div class="v">${jpy(s.totalRewardJpy)}</div>
      <div class="s">${flr(s.totalRewardFlr)} ／ ${s.rewardCount} 回</div>
    </div>
    <div class="stat">
      <div class="k">ガス代 合計</div>
      <div class="v">${jpy(s.totalGasJpy)}</div>
      <div class="s">${flr(s.totalGasFlr)} ／ ${s.gasTxCount} 件</div>
    </div>
    <div class="stat">
      <div class="k">差引（報酬 − ガス代）</div>
      <div class="v">${jpy(s.netJpy)}</div>
      <div class="s">雑所得の目安</div>
    </div>
    <div class="stat">
      <div class="k">対象期間</div>
      <div class="v" style="font-size:16px">${r.period.from}<br>〜 ${r.period.to}</div>
      <div class="s">${r.wallets.length} ウォレット</div>
    </div>`;

  const w = $('warnings');
  if (r.warnings?.length) {
    w.innerHTML = `<strong>注意</strong><ul>${r.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    w.classList.remove('hidden');
  } else {
    w.classList.add('hidden');
  }

  buildTable(
    $('cat-table'),
    [
      { key: 'label', label: '種別', render: (x) => esc(x.label) },
      { key: 'count', label: '件数', num: true, render: (x) => x.count.toLocaleString() },
      { key: 'flr', label: '数量', num: true, render: (x) => flr(x.flr) },
      { key: 'jpy', label: '評価額', num: true, render: (x) => jpy(x.jpy) },
    ],
    r.byCategory,
    { label: '合計', count: s.rewardCount.toLocaleString(), flr: flr(s.totalRewardFlr), jpy: jpy(s.totalRewardJpy) }
  );

  buildTable(
    $('year-table'),
    [
      { key: 'year', label: '年', render: (x) => x.year + ' 年' },
      { key: 'rewardFlr', label: '報酬(FLR)', num: true, render: (x) => flr(x.rewardFlr) },
      { key: 'rewardJpy', label: '報酬(円)', num: true, render: (x) => jpy(x.rewardJpy) },
      { key: 'gasJpy', label: 'ガス代(円)', num: true, render: (x) => jpy(x.gasJpy) },
      { key: 'netJpy', label: '差引＝雑所得(円)', num: true, render: (x) => `<strong>${jpy(x.netJpy)}</strong>` },
    ],
    r.byYear
  );

  buildTable(
    $('month-table'),
    [
      { key: 'month', label: '年月', render: (x) => x.month },
      { key: 'rewardCount', label: '受取回数', num: true, render: (x) => x.rewardCount },
      { key: 'rewardFlr', label: '報酬(FLR)', num: true, render: (x) => flr(x.rewardFlr) },
      { key: 'rewardJpy', label: '報酬(円)', num: true, render: (x) => jpy(x.rewardJpy) },
      { key: 'gasJpy', label: 'ガス代(円)', num: true, render: (x) => jpy(x.gasJpy) },
      { key: 'netJpy', label: '差引(円)', num: true, render: (x) => jpy(x.netJpy) },
    ],
    r.byMonth
  );

  $('reward-count').textContent = r.rewards.length.toLocaleString();
  buildTable(
    $('reward-table'),
    [
      { key: 'dt', label: '日時(JST)', render: (x) => esc(x.datetimeJst) },
      { key: 'cat', label: '種別', render: (x) => `<span class="tag">${esc(x.categoryLabel)}</span>` },
      { key: 'epoch', label: 'エポック', num: true, render: (x) => x.epoch ?? '' },
      { key: 'amt', label: '数量', num: true, render: (x) => flr(x.amountFlr) },
      { key: 'rate', label: 'FLR/JPY', num: true, render: (x) => (x.flrJpy != null ? x.flrJpy.toFixed(5) : '—') },
      { key: 'jpy', label: '評価額', num: true, render: (x) => jpy(x.jpy) },
      { key: 'tx', label: 'Tx', cls: 'mono', render: (x) => `<a href="${EXPLORER}/tx/${x.txHash}" target="_blank" rel="noopener">${shortHash(x.txHash)}</a>` },
    ],
    r.rewards.slice().reverse()
  );

  $('gas-count').textContent = r.gas.length.toLocaleString();
  buildTable(
    $('gas-table'),
    [
      { key: 'dt', label: '日時(JST)', render: (x) => esc(x.datetimeJst) },
      { key: 'method', label: 'メソッド', render: (x) => esc(x.method) },
      { key: 'to', label: '送信先', cls: 'mono', render: (x) => esc(x.toName || shortAddr(x.to)) },
      { key: 'ok', label: '結果', render: (x) => (x.success ? '成功' : '<span style="color:var(--neg)">失敗</span>') },
      { key: 'fee', label: '手数料', num: true, render: (x) => flr(x.feeFlr) },
      { key: 'jpy', label: '手数料(円)', num: true, render: (x) => jpy(x.jpy) },
      { key: 'tx', label: 'Tx', cls: 'mono', render: (x) => `<a href="${EXPLORER}/tx/${x.txHash}" target="_blank" rel="noopener">${shortHash(x.txHash)}</a>` },
    ],
    r.gas.slice().reverse()
  );
}

/* ---------------- 税額試算 ---------------- */

function recalcTax() {
  if (!state.report) return;
  const ratio = +$('gas-ratio').value / 100;
  const gasExpense = state.report.summary.totalGasJpy * ratio;

  $('gas-ratio-val').textContent = $('gas-ratio').value;
  $('gas-ratio-jpy').textContent = Math.round(gasExpense).toLocaleString('ja-JP');

  const t = estimateTax({
    rewardIncomeJpy: state.report.summary.totalRewardJpy,
    gasExpenseJpy: gasExpense,
    otherIncomeJpy: parseFormattedNumber($('other-income')),
    otherDeductionsJpy: parseFormattedNumber($('other-deductions')),
    year: +$('tax-year').value,
  });
  state.tax = t;

  $('tax-result').innerHTML = `
    <div class="tax-total">
      <div class="k">FLR報酬にかかる税金（概算）</div>
      <div class="v">${jpy(t.attributable.total)}</div>
      <div class="s">雑所得 ${jpy(t.miscIncome)} に対する実効税率 ${pct(t.effectiveRate)}（限界税率 ${pct(t.marginalRate)}）</div>
    </div>
    <div class="tax-grid">
      <div class="stat"><div class="k">所得税</div><div class="v">${jpy(t.attributable.incomeTax)}</div></div>
      <div class="stat"><div class="k">復興特別所得税</div><div class="v">${jpy(t.attributable.reconstructionTax)}</div></div>
      <div class="stat"><div class="k">住民税（所得割）</div><div class="v">${jpy(t.attributable.residentTax)}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>項目</th><th class="num">FLR報酬あり</th><th class="num">FLR報酬なし</th><th class="num">差額</th></tr></thead>
      <tbody>
        <tr><td>合計所得金額</td><td class="num">${jpy(t.input.otherIncomeJpy + t.miscIncome)}</td><td class="num">${jpy(t.input.otherIncomeJpy)}</td><td class="num">${jpy(t.miscIncome)}</td></tr>
        <tr><td>基礎控除</td><td class="num">${jpy(t.withFlr.basicDeduction)}</td><td class="num">${jpy(t.withoutFlr.basicDeduction)}</td><td class="num">${jpy(t.withFlr.basicDeduction - t.withoutFlr.basicDeduction)}</td></tr>
        <tr><td>課税所得金額</td><td class="num">${jpy(t.withFlr.taxableIncome)}</td><td class="num">${jpy(t.withoutFlr.taxableIncome)}</td><td class="num">${jpy(t.withFlr.taxableIncome - t.withoutFlr.taxableIncome)}</td></tr>
        <tr><td>所得税</td><td class="num">${jpy(t.withFlr.incomeTax)}</td><td class="num">${jpy(t.withoutFlr.incomeTax)}</td><td class="num">${jpy(t.attributable.incomeTax)}</td></tr>
        <tr><td>復興特別所得税</td><td class="num">${jpy(t.withFlr.reconstructionTax)}</td><td class="num">${jpy(t.withoutFlr.reconstructionTax)}</td><td class="num">${jpy(t.attributable.reconstructionTax)}</td></tr>
        <tr><td>住民税（所得割）</td><td class="num">${jpy(t.withFlr.residentTax)}</td><td class="num">${jpy(t.withoutFlr.residentTax)}</td><td class="num">${jpy(t.attributable.residentTax)}</td></tr>
      </tbody>
      <tfoot><tr><td>税額 合計</td><td class="num">${jpy(t.withFlr.total)}</td><td class="num">${jpy(t.withoutFlr.total)}</td><td class="num">${jpy(t.attributable.total)}</td></tr></tfoot>
    </table></div>`;
}

let taxTimer;
['other-income', 'other-deductions', 'tax-year', 'gas-ratio'].forEach((id) => {
  $(id).addEventListener('input', () => {
    clearTimeout(taxTimer);
    taxTimer = setTimeout(recalcTax, 200);
  });
});

/* ---------------- 確定申告 記入ガイド（暗号資産の計算書） ---------------- */

function initNtaYearSelect(preferYear) {
  const years = listAvailableYears(state.report);
  const sel = $('nta-year');
  sel.innerHTML = years.map((y) => `<option value="${y}">${y} 年</option>`).join('');
  if (years.includes(preferYear)) sel.value = preferYear;
  else if (years.length) sel.value = years[years.length - 1];
}

function ntaComputed() {
  const year = $('nta-year').value;
  const opening = { qty: parseFormattedNumber($('nta-opening-qty')), value: parseFormattedNumber($('nta-opening-value')) };
  const method = $('nta-method').value;
  return method === 'idou' ? computeIdouHeikinho(state.report, year, opening) : computeSouHeikinho(state.report, year, opening);
}

function renderNtaPreview(c) {
  const note = $('nta-approx-note');
  if (!c.exact) {
    note.innerHTML =
      '<strong>参考値（近似計算）</strong><p>移動平均法は本来、取引のたびに逐次平均を再計算する方式です。' +
      '数百件の小さな報酬を1件ずつ記載するのは非現実的なため、ここでは月単位に集計して近似しています。' +
      'ダウンロードしたExcel自体は国税庁の数式でその場から正確に再計算されますが、月次集計を入力データとしている点は変わりません。' +
      '特に届出をしていない場合は、下の総平均法（既定・厳密に一致）を使うことをお勧めします。</p>';
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  if (c.method === 'sou') {
    buildTable(
      $('nta-preview'),
      [
        { key: 'month', label: '月', render: (x) => x.month + '月' },
        { key: 'description', label: '摘要', render: (x) => esc(x.description) },
        { key: 'purchaseQty', label: '購入等 数量', num: true, render: (x) => (x.purchaseQty ? flr(x.purchaseQty) : '') },
        { key: 'purchaseValue', label: '購入等 金額', num: true, render: (x) => (x.purchaseValue ? jpy(x.purchaseValue) : '') },
        { key: 'saleQty', label: '売却等 数量', num: true, render: (x) => (x.saleQty ? flr(x.saleQty) : '') },
        { key: 'saleValue', label: '売却等 金額', num: true, render: (x) => (x.saleValue ? jpy(x.saleValue) : '') },
      ],
      c.rows
    );
    $('nta-summary').innerHTML = `
      <div class="stat"><div class="k">年始残高</div><div class="v">${flr(c.openingQty)}</div><div class="s">${jpy(c.openingValue)}</div></div>
      <div class="stat"><div class="k">購入等 合計</div><div class="v">${flr(c.purchaseQty)}</div><div class="s">${jpy(c.purchaseValue)}</div></div>
      <div class="stat"><div class="k">売却等 合計</div><div class="v">${flr(c.saleQty)}</div><div class="s">${jpy(c.saleValue)}</div></div>
      <div class="stat"><div class="k">総平均単価</div><div class="v">${c.avgUnitPrice.toFixed(6)} 円/FLR</div></div>
      <div class="stat"><div class="k">売却原価（必要経費）</div><div class="v">${jpy(c.costTotal)}</div></div>
      <div class="stat"><div class="k">年末残高・翌年繰越</div><div class="v">${flr(c.endingQty)}</div><div class="s">${jpy(c.endingValue)}</div></div>
      <div class="stat accent"><div class="k">所得金額（収入−必要経費）</div><div class="v">${jpy(c.income)}</div></div>`;
  } else {
    buildTable(
      $('nta-preview'),
      [
        { key: 'month', label: '月', render: (x) => x.month + '月' },
        { key: 'type', label: '種別', render: (x) => (x.type === 'purchase' ? '購入等' : '売却等') },
        { key: 'description', label: '摘要', render: (x) => esc(x.description) },
        { key: 'qty', label: '数量', num: true, render: (x) => flr(x.qty) },
        { key: 'value', label: '金額', num: true, render: (x) => jpy(x.value) },
        { key: 'balanceQty', label: '残高 数量', num: true, render: (x) => flr(x.balanceQty) },
        { key: 'balanceValue', label: '残高 金額', num: true, render: (x) => jpy(x.balanceValue) },
        { key: 'unitPrice', label: '単価', num: true, render: (x) => x.unitPrice.toFixed(6) },
      ],
      c.rows
    );
    $('nta-summary').innerHTML = `
      <div class="stat"><div class="k">年始残高</div><div class="v">${flr(c.openingQty)}</div><div class="s">${jpy(c.openingValue)}</div></div>
      <div class="stat"><div class="k">購入等 合計金額</div><div class="v">${jpy(c.totalPurchaseValue)}</div></div>
      <div class="stat"><div class="k">売却等 合計金額</div><div class="v">${jpy(c.totalSaleValue)}</div></div>
      <div class="stat"><div class="k">売却原価（必要経費）</div><div class="v">${jpy(c.totalCost)}</div></div>
      <div class="stat"><div class="k">年末残高・翌年繰越</div><div class="v">${flr(c.endingQty)}</div><div class="s">${jpy(c.endingValue)}</div></div>
      <div class="stat accent"><div class="k">所得金額（参考値）</div><div class="v">${jpy(c.income)}</div></div>`;
  }
}

function recalcNta() {
  if (!state.report) return;
  const years = listAvailableYears(state.report);
  if (years.length === 0) {
    $('nta-preview').innerHTML = '<div class="empty">対象期間に報酬・ガス代のデータがありません。</div>';
    $('nta-summary').innerHTML = '';
    return;
  }
  try {
    renderNtaPreview(ntaComputed());
  } catch (e) {
    $('nta-preview').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    $('nta-summary').innerHTML = '';
  }
}

let ntaTimer;
['nta-year', 'nta-method', 'nta-opening-qty', 'nta-opening-value'].forEach((id) => {
  $(id).addEventListener('input', () => {
    clearTimeout(ntaTimer);
    ntaTimer = setTimeout(recalcNta, 200);
  });
});

$('nta-download').onclick = async () => {
  if (!state.report) return;
  const btn = $('nta-download');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '作成中…';
  try {
    const method = $('nta-method').value;
    const year = $('nta-year').value;
    const computed = ntaComputed();

    const templateBuf = await fetch(NTA_TEMPLATE_URL[method]).then((r) => {
      if (!r.ok) throw new Error(`様式の読み込みに失敗しました (HTTP ${r.status})`);
      return r.arrayBuffer();
    });

    const wb =
      method === 'idou'
        ? await fillIdouHeikinho(window.ExcelJS, templateBuf, { year, assetName: NTA_ASSET_NAME, computed })
        : await fillSouHeikinho(window.ExcelJS, templateBuf, { year, assetName: NTA_ASSET_NAME, computed });

    const buf = await wb.xlsx.writeBuffer();
    download(
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `暗号資産の計算書_${method === 'idou' ? '移動平均法' : '総平均法'}_${year}年分.xlsx`
    );
  } catch (e) {
    console.error(e);
    alert('様式の作成に失敗しました: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

/* ---------------- エクスポート ---------------- */

$('dl-xlsx').onclick = async () => {
  if (!state.report) return;
  const btn = $('dl-xlsx');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '作成中…';
  try {
    const wb = await buildWorkbook(window.ExcelJS, state.report, state.tax);
    const buf = await wb.xlsx.writeBuffer();
    const p = state.report.period;
    download(
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `FLR報酬レポート_${p.from}_${p.to}.xlsx`
    );
  } catch (e) {
    console.error(e);
    alert('Excelの作成に失敗しました: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

const csvDownload = (kind) => () => {
  if (!state.report) return;
  const p = state.report.period;
  const csv = kind === 'gas' ? gasCsv(state.report) : rewardsCsv(state.report);
  download(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    `FLR${kind === 'gas' ? 'ガス代明細' : '報酬明細'}_${p.from}_${p.to}.csv`
  );
};
$('dl-csv-reward').onclick = csvDownload('rewards');
$('dl-csv-gas').onclick = csvDownload('gas');

/* ---------------- 初期化 ---------------- */

initPeriod();
state.wallets = store.listWallets();
state.wallets.forEach((w) => state.selected.add(w.address));
renderWallets();

// 入力値をブラウザに記憶させ、桁区切り表示にする
bindPersistedNumberInput('other-income', 'otherIncome', 0);
bindPersistedNumberInput('other-deductions', 'otherDeductions', 0);
bindPersistedNumberInput('nta-opening-qty', 'ntaOpeningQty', 0);
bindPersistedNumberInput('nta-opening-value', 'ntaOpeningValue', 0);

// 同梱データの生成日を表示しておく（古ければ更新の目安になる）
fetch('data/prices.json')
  .then((r) => r.json())
  .then((j) => {
    $('price-info').textContent = `同梱データ: ${j.generated.slice(0, 10)} 時点`;
  })
  .catch(() => {});
