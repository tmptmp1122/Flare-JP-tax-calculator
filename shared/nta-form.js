/**
 * 国税庁「暗号資産の計算書」（総平均法用・移動平均法用）への記入内容を計算する。
 *
 * このアプリが把握しているのは「オンチェーンで受け取った報酬」と「ガス代の支払い」だけである。
 * それぞれを計算書上ではこう扱う。
 *
 *   - 報酬の受取り … 受取り時点の時価で暗号資産を「購入等」したものとして計上する。
 *     受取り時点の時価そのものは、この計算書とは別に「雑所得の収入金額」として
 *     既に別途申告される（タブ「税金の試算」）。ここではその後の売却（＝ガス代支払い）に
 *     使う取得価額（コストベース）を積み上げているだけで、二重に所得計上されるわけではない。
 *
 *   - ガス代の支払い … Flareネットワークではガス代を FLR そのもので支払うため、
 *     保有する暗号資産を消費（讓渡）したことになる。支払い時点の時価と、
 *     取得時からの平均取得単価との差額が、追加の雑所得（またはマイナス）として計上される。
 *
 * 取引所での売買・交換や、年始時点で既に保有していた残高は、このアプリのスキャン範囲に
 * 含まれないため、必要に応じて利用者が手動で追加・入力する必要がある。
 *
 * 【総平均法】年間の合計数量・合計金額だけで平均単価が決まるため、取引の順序に関係なく
 * 厳密に一致する（国税庁の様式の丸め方（収入金額計=ROUNDDOWN、必要経費計=ROUNDUP）も再現している）。
 * 何も届け出ていない場合はこちらが法定の評価方法になる。
 *
 * 【移動平均法】本来は取引のたびに逐次平均を再計算する方式。数百件の小さな報酬を
 * 1件ずつ様式に書き出すのは非現実的なため、月単位に集計して近似計算している。
 * ここで表示する所得金額は参考値であり、ダウンロードしたExcel自体は月次集計を
 * 国税庁の数式にそのまま渡して計算し直すため、様式上の数値はその場で正確に算出される。
 */

const round8 = (v) => Math.round(v * 1e8) / 1e8;
const yen = (v) => Math.round(v) || 0;

/** report.byMonth（全期間分）から指定年だけを取り出す */
function yearMonths(report, year) {
  return report.byMonth.filter((m) => m.month.startsWith(String(year)));
}

/** 計算書の対象にできる年の一覧（レポートに含まれる年） */
export function listAvailableYears(report) {
  return [...new Set(report.byMonth.map((m) => m.month.slice(0, 4)))].sort();
}

/**
 * 総平均法用の計算。
 * @param {object} opening { qty, value } 年始残高（前年から繰り越した数量・金額）。初年度は 0 でよい。
 */
export function computeSouHeikinho(report, year, opening = {}) {
  const openingQty = round8(Number(opening.qty) || 0);
  const openingValue = yen(Number(opening.value) || 0);

  const months = yearMonths(report, year).filter((m) => m.rewardFlr > 0 || m.gasFlr > 0);
  const rows = months.map((m) => ({
    month: +m.month.slice(5, 7),
    description: [
      m.rewardCount > 0 ? `デリゲート・ステーキング報酬等 ${m.rewardCount}件` : null,
      m.gasCount > 0 ? `ガス代（送金手数料）支払 ${m.gasCount}件` : null,
    ]
      .filter(Boolean)
      .join(' / '),
    purchaseQty: round8(m.rewardFlr),
    purchaseValue: yen(m.rewardJpy),
    saleQty: round8(m.gasFlr),
    saleValue: yen(m.gasJpy),
  }));

  const purchaseQty = round8(rows.reduce((s, r) => s + r.purchaseQty, 0));
  const purchaseValue = rows.reduce((s, r) => s + r.purchaseValue, 0);
  const saleQty = round8(rows.reduce((s, r) => s + r.saleQty, 0));
  const saleValue = rows.reduce((s, r) => s + r.saleValue, 0);

  const totalQty = openingQty + purchaseQty;
  const totalValue = openingValue + purchaseValue;
  const avgUnitPrice = totalQty > 0 ? totalValue / totalQty : 0;
  const endingQty = round8(totalQty - saleQty);

  // 様式と同じ丸め方: 収入金額計は ROUNDDOWN、必要経費計（売却原価）は ROUNDUP
  const revenueTotal = Math.floor(saleValue);
  const costTotal = Math.ceil(avgUnitPrice * saleQty);
  const endingValue = Math.round(avgUnitPrice * endingQty);
  const income = revenueTotal - costTotal;

  return {
    method: 'sou',
    methodLabel: '総平均法',
    exact: true,
    year,
    rows,
    openingQty,
    openingValue,
    purchaseQty,
    purchaseValue,
    saleQty,
    saleValue,
    avgUnitPrice,
    costTotal,
    endingQty,
    endingValue,
    revenueTotal,
    income,
  };
}

/**
 * 移動平均法用の計算（月単位で近似）。
 * @param {object} opening { qty, value } 年始残高
 */
export function computeIdouHeikinho(report, year, opening = {}) {
  const openingQty = round8(Number(opening.qty) || 0);
  const openingValue = yen(Number(opening.value) || 0);

  const months = yearMonths(report, year);
  let qty = openingQty;
  let value = openingValue;
  let unitPrice = qty > 0 ? value / qty : 0;
  const rows = [];

  for (const m of months) {
    if (m.rewardFlr > 0) {
      const pQty = round8(m.rewardFlr);
      const pValue = yen(m.rewardJpy);
      qty = round8(qty + pQty);
      value += pValue;
      unitPrice = qty > 0 ? value / qty : 0;
      rows.push({
        month: +m.month.slice(5, 7),
        type: 'purchase',
        description: `デリゲート・ステーキング報酬等 ${m.rewardCount}件`,
        qty: pQty,
        value: pValue,
        balanceQty: qty,
        balanceValue: Math.round(value),
        unitPrice,
      });
    }
    if (m.gasFlr > 0) {
      const sQty = round8(m.gasFlr);
      const sValue = yen(m.gasJpy);
      const cost = Math.round(unitPrice * sQty);
      qty = round8(qty - sQty);
      value -= cost;
      rows.push({
        month: +m.month.slice(5, 7),
        type: 'sale',
        description: `ガス代（送金手数料）支払 ${m.gasCount}件`,
        qty: sQty,
        value: sValue,
        cost,
        balanceQty: qty,
        balanceValue: Math.round(value),
        unitPrice,
      });
    }
  }

  const totalPurchaseValue = rows.filter((r) => r.type === 'purchase').reduce((s, r) => s + r.value, 0);
  const totalSaleValue = rows.filter((r) => r.type === 'sale').reduce((s, r) => s + r.value, 0);
  const totalCost = rows.filter((r) => r.type === 'sale').reduce((s, r) => s + r.cost, 0);
  const income = totalSaleValue - totalCost;

  return {
    method: 'idou',
    methodLabel: '移動平均法',
    exact: false,
    year,
    rows,
    openingQty,
    openingValue,
    endingQty: qty,
    endingValue: Math.round(value),
    totalPurchaseValue,
    totalSaleValue,
    totalCost,
    income,
  };
}
