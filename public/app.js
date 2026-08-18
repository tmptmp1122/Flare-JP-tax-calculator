'use strict';

const $ = (id) => document.getElementById(id);
const EXPLORER = 'https://flare-explorer.flare.network';

let state = {
  wallets: [],
  selected: new Set(),
  report: null,
  tax: null,
};

/* ---------------- utils ---------------- */

// Math.round(-0.4) は -0 になり "-0 円" と表示されてしまうので 0 に寄せる
const jpy = (v) => (v == null ? '—' : (Math.round(v) || 0).toLocaleString('ja-JP') + ' 円');
const flr = (v) => (v == null ? '—' : v.toLocaleString('ja-JP', { maximumFractionDigits: 4 }) + ' FLR');
const pct = (v) => (v * 100).toFixed(2) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortHash = (h) => (h ? h.slice(0, 10) + '…' + h.slice(-6) : '');
const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

async function api(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `エラーが発生しました (${res.status})`);
  return json;
}

/* ---------------- 入力欄の記憶（ブラウザのlocalStorage） ---------------- */

const SETTINGS_PREFIX = 'flrtax.settings.';

function getSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(SETTINGS_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  try {
    localStorage.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
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
  el.value = String(getSetting(storageKey, defaultValue));
  reformat();
  el.addEventListener('input', () => {
    setSetting(storageKey, parseFormattedNumber(el));
  });
}

function buildTable(el, columns, rows, footer) {
  const head = `<thead><tr>${columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows
        .map((r) => `<tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.render(r)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`
    : `<tbody><tr><td colspan="${columns.length}" class="empty">データがありません</td></tr></tbody>`;
  const foot = footer ? `<tfoot><tr>${columns.map((c) => `<td class="${c.num ? 'num' : ''}">${footer[c.key] ?? ''}</td>`).join('')}</tr></tfoot>` : '';
  el.innerHTML = head + body + foot;
}

/* ---------------- wallets ---------------- */

async function loadWallets() {
  state.wallets = await api('/api/wallets');
  // 初回は全選択
  if (state.selected.size === 0) state.wallets.forEach((w) => state.selected.add(w.address));
  renderWallets();
}

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
    cb.onchange = () => {
      cb.checked ? state.selected.add(cb.dataset.addr) : state.selected.delete(cb.dataset.addr);
    };
  });
  el.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('このウォレットを削除しますか？')) return;
      const r = await api('/api/wallets/' + b.dataset.del, { method: 'DELETE' });
      state.selected.delete(b.dataset.del);
      state.wallets = r.wallets;
      renderWallets();
    };
  });
}

$('wallet-form').onsubmit = async (e) => {
  e.preventDefault();
  const address = $('w-address').value.trim();
  const label = $('w-label').value.trim();
  if (!address) return;
  try {
    const r = await api('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label }),
    });
    state.wallets = r.wallets;
    state.selected.add(r.wallets.find((w) => w.address.toLowerCase() === address.toLowerCase())?.address || address);
    $('w-address').value = '';
    $('w-label').value = '';
    renderWallets();
  } catch (err) {
    alert(err.message);
  }
};

/* ---------------- period ---------------- */

function setDates(from, to) {
  $('from-date').value = from;
  $('to-date').value = to;
}

function initPeriod() {
  const now = new Date();
  const y = now.getFullYear();
  setDates(`${y}-01-01`, now.toISOString().slice(0, 10));

  const presets = [
    { label: '今年', from: `${y}-01-01`, to: `${y}-12-31` },
    { label: `${y - 1}年`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
    { label: `${y - 2}年`, from: `${y - 2}-01-01`, to: `${y - 2}-12-31` },
    { label: '全期間', from: '2022-01-01', to: `${y}-12-31` },
  ];
  $('presets').innerHTML = presets.map((p, i) => `<button type="button" data-i="${i}">${p.label}</button>`).join('');
  $('presets').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const p = presets[+b.dataset.i];
      setDates(p.from, p.to);
    };
  });

  // 税額試算の対象年
  const sel = $('tax-year');
  sel.innerHTML = '';
  for (let yy = y; yy >= 2022; yy--) sel.innerHTML += `<option value="${yy}">${yy} 年</option>`;
}

/* ---------------- scan ---------------- */

$('scan-btn').onclick = async () => {
  const addresses = [...state.selected];
  if (addresses.length === 0) return alert('対象のウォレットを選択してください');

  const btn = $('scan-btn');
  btn.disabled = true;
  $('progress').classList.remove('hidden');
  $('progress').textContent = 'ブロックチェーンから履歴を取得しています…（初回は1〜3分かかります）';

  try {
    const report = await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addresses,
        from: $('from-date').value,
        to: $('to-date').value,
        refresh: $('refresh-cache').checked,
      }),
    });
    state.report = report;
    renderReport(report);
    $('results').classList.remove('hidden');
    // 期間の年に合わせて税額試算の年を寄せる
    const yr = report.period.to.slice(0, 4);
    if ([...$('tax-year').options].some((o) => o.value === yr)) $('tax-year').value = yr;
    recalcTax();
    initNtaYearSelect(report, yr);
    recalcNta();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert('集計に失敗しました: ' + err.message);
  } finally {
    btn.disabled = false;
    $('progress').classList.add('hidden');
  }
};

/* ---------------- render report ---------------- */

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

  // 警告
  const w = $('warnings');
  if (r.warnings?.length) {
    w.innerHTML = `<strong>注意</strong><ul>${r.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    w.classList.remove('hidden');
  } else {
    w.classList.add('hidden');
  }

  // 種別集計
  buildTable(
    $('cat-table'),
    [
      { key: 'label', label: '種別', render: (x) => esc(x.label) },
      { key: 'count', label: '件数', num: true, render: (x) => x.count.toLocaleString() },
      { key: 'flr', label: '数量', num: true, render: (x) => flr(x.flr) },
      { key: 'jpy', label: '評価額', num: true, render: (x) => jpy(x.jpy) },
    ],
    r.byCategory,
    { label: '合計', count: r.summary.rewardCount.toLocaleString(), flr: flr(r.summary.totalRewardFlr), jpy: jpy(r.summary.totalRewardJpy) }
  );

  // 年別
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

  // 月別
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

  // 明細
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

/* ---------------- tax ---------------- */

async function recalcTax() {
  if (!state.report) return;
  const ratio = +$('gas-ratio').value / 100;
  const gasExpense = state.report.summary.totalGasJpy * ratio;

  $('gas-ratio-val').textContent = $('gas-ratio').value;
  $('gas-ratio-jpy').textContent = Math.round(gasExpense).toLocaleString('ja-JP');

  const t = await api('/api/tax', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rewardIncomeJpy: state.report.summary.totalRewardJpy,
      gasExpenseJpy: gasExpense,
      otherIncomeJpy: parseFormattedNumber($('other-income')),
      otherDeductionsJpy: parseFormattedNumber($('other-deductions')),
      year: +$('tax-year').value,
    }),
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

['other-income', 'other-deductions', 'tax-year', 'gas-ratio'].forEach((id) => {
  $(id).addEventListener('input', () => {
    clearTimeout(window.__taxTimer);
    window.__taxTimer = setTimeout(recalcTax, 250);
  });
});

/* ---------------- 確定申告 記入ガイド（暗号資産の計算書） ---------------- */

function ntaAvailableYears(report) {
  return [...new Set(report.byMonth.map((m) => m.month.slice(0, 4)))].sort();
}

function initNtaYearSelect(report, preferYear) {
  const years = ntaAvailableYears(report);
  const sel = $('nta-year');
  sel.innerHTML = years.map((y) => `<option value="${y}">${y} 年</option>`).join('');
  if (years.includes(preferYear)) sel.value = preferYear;
  else if (years.length) sel.value = years[years.length - 1];
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

async function recalcNta() {
  if (!state.report) return;
  const years = ntaAvailableYears(state.report);
  if (years.length === 0) {
    $('nta-preview').innerHTML = '<tbody><tr><td class="empty">対象期間に報酬・ガス代のデータがありません。</td></tr></tbody>';
    $('nta-summary').innerHTML = '';
    return;
  }
  const params = new URLSearchParams({
    id: state.report.id,
    method: $('nta-method').value,
    year: $('nta-year').value,
    openingQty: parseFormattedNumber($('nta-opening-qty')),
    openingValue: parseFormattedNumber($('nta-opening-value')),
  });
  try {
    const { computed } = await api('/api/nta-preview?' + params);
    renderNtaPreview(computed);
  } catch (e) {
    $('nta-preview').innerHTML = `<tbody><tr><td class="empty">${esc(e.message)}</td></tr></tbody>`;
    $('nta-summary').innerHTML = '';
  }
}

['nta-year', 'nta-method', 'nta-opening-qty', 'nta-opening-value'].forEach((id) => {
  $(id).addEventListener('input', () => {
    clearTimeout(window.__ntaTimer);
    window.__ntaTimer = setTimeout(recalcNta, 250);
  });
});

$('nta-download').onclick = () => {
  if (!state.report) return;
  const params = new URLSearchParams({
    id: state.report.id,
    method: $('nta-method').value,
    year: $('nta-year').value,
    openingQty: parseFormattedNumber($('nta-opening-qty')),
    openingValue: parseFormattedNumber($('nta-opening-value')),
  });
  location.href = `/api/export/nta?${params}`;
};

/* ---------------- exports ---------------- */

$('dl-xlsx').onclick = () => {
  if (!state.report) return;
  const tax = state.tax ? '&tax=' + encodeURIComponent(JSON.stringify(state.tax)) : '';
  location.href = `/api/export/xlsx?id=${state.report.id}${tax}`;
};
$('dl-csv-reward').onclick = () => {
  if (state.report) location.href = `/api/export/csv?id=${state.report.id}&kind=rewards`;
};
$('dl-csv-gas').onclick = () => {
  if (state.report) location.href = `/api/export/csv?id=${state.report.id}&kind=gas`;
};

/* ---------------- init ---------------- */

initPeriod();
loadWallets().catch((e) => console.error(e));

// 入力値をブラウザに記憶させ、桁区切り表示にする
bindPersistedNumberInput('other-income', 'otherIncome', 0);
bindPersistedNumberInput('other-deductions', 'otherDeductions', 0);
bindPersistedNumberInput('nta-opening-qty', 'ntaOpeningQty', 0);
bindPersistedNumberInput('nta-opening-value', 'ntaOpeningValue', 0);
