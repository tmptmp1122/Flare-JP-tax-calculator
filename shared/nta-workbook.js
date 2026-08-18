/**
 * 国税庁の公式様式（暗号資産の計算書）に、shared/nta-form.js の計算結果を書き込む。
 *
 * 既存の数式セルには一切触れず、入力欄（数値・文字列）だけを埋める。
 * 所得金額などは様式に元から入っている数式がそのまま計算するので、
 * ここではその数式が参照する「生データ」のセルだけを埋めればよい。
 *
 * 対象は「計算書①」シートのみ。1つの銘柄(FLR)を月単位で集計しているため、
 * 総平均法は最大12行、移動平均法は最大24行で収まり、他のシート（②〜⑩）は
 * 複数銘柄を持つ人向けの予備なので触れずに残す。
 */

const SHEET_NAME = '計算書①';

/**
 * 開いたときに Excel/LibreOffice側で数式を再計算させる。
 *
 * 注意: ExcelJS は読み込んだ xlsx から calcPr を復元しないため（ライブラリ側の既知の制限）、
 * 一度保存したファイルを ExcelJS で再度読み込んでも wb.calcProperties は空に見える。
 * これは正常で、書き込み時には xl/workbook.xml に fullCalcOnLoad="1" が
 * 正しく出力されていることを実ファイルで確認済み。
 */
function forceRecalcOnLoad(wb) {
  wb.calcProperties = { fullCalcOnLoad: true };
}

/**
 * 総平均法用の様式に書き込む。
 * @param {*} ExcelJS ExcelJS モジュール（ブラウザ/Nodeで注入元が違うため引数で受け取る）
 * @param {ArrayBuffer|Buffer} templateBuffer assets/nta-templates/soheikinho.xlsx の中身
 * @param {object} p
 * @param {number} p.year 年分
 * @param {string} p.assetName 暗号資産の名称（例: "FLR（フレア）"）
 * @param {ReturnType<import('./nta-form.js').computeSouHeikinho>} p.computed
 */
export async function fillSouHeikinho(ExcelJS, templateBuffer, { year, assetName, computed }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuffer);
  forceRecalcOnLoad(wb);

  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`様式に ${SHEET_NAME} シートが見つかりません`);

  if (computed.rows.length > 13) {
    throw new Error(`月次集計が ${computed.rows.length} 行あり、様式1枚(13行)に入りきりません`);
  }

  ws.getCell('L3').value = year;
  ws.getCell('U6').value = assetName;

  computed.rows.forEach((r, i) => {
    const rr = 23 + i;
    ws.getCell(`C${rr}`).value = r.month;
    ws.getCell(`G${rr}`).value = 'Flareネットワーク（オンチェーン）';
    ws.getCell(`M${rr}`).value = r.description;
    if (r.purchaseQty) ws.getCell(`U${rr}`).value = r.purchaseQty;
    if (r.purchaseValue) ws.getCell(`AD${rr}`).value = r.purchaseValue;
    if (r.saleQty) ws.getCell(`AM${rr}`).value = r.saleQty;
    if (r.saleValue) ws.getCell(`AV${rr}`).value = r.saleValue;
  });

  // 年始残高（前年から繰り越した数量・金額）。初年度は 0 のままでよい
  ws.getCell('N41').value = computed.openingQty || 0;
  ws.getCell('N42').value = computed.openingValue || 0;

  return wb;
}

/**
 * 移動平均法用の様式に書き込む。
 * 各行は「購入等」または「売却等」のどちらか一方のみを埋める
 * （様式の数式が同一行での購入・売却同時入力を想定していないため）。
 */
export async function fillIdouHeikinho(ExcelJS, templateBuffer, { year, assetName, computed }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuffer);
  forceRecalcOnLoad(wb);

  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`様式に ${SHEET_NAME} シートが見つかりません`);

  if (computed.rows.length > 27) {
    throw new Error(`取引行が ${computed.rows.length} 行あり、様式1枚(27行)に入りきりません`);
  }

  ws.getCell('L3').value = year;
  ws.getCell('U7').value = assetName;

  // 年始残高（前年繰越）。様式の row13 が専用行
  ws.getCell('U13').value = computed.openingQty || 0;
  ws.getCell('Y13').value = computed.openingValue || 0;

  computed.rows.forEach((r, i) => {
    const rr = 14 + i;
    ws.getCell(`C${rr}`).value = r.month;
    ws.getCell(`G${rr}`).value = 'Flareネットワーク（オンチェーン）';
    ws.getCell(`M${rr}`).value = r.description;
    if (r.type === 'purchase') {
      ws.getCell(`U${rr}`).value = r.qty;
      ws.getCell(`Y${rr}`).value = r.value;
    } else {
      ws.getCell(`AE${rr}`).value = r.qty;
      ws.getCell(`AI${rr}`).value = r.value;
    }
  });

  return wb;
}
