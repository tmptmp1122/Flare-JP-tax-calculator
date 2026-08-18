/**
 * 日本の税制にもとづく概算計算。
 *
 * 【前提】
 * 個人が暗号資産のステーキング/デリゲート報酬を受け取った場合、原則として
 * 「雑所得(総合課税)」となり、給与など他の所得と合算して累進課税される。
 * 報酬は「受け取った時点の時価」で収入計上する。
 *
 * 【この計算の位置づけ】
 * 実際の納税額は他の所得・各種控除・自治体によって変わるため、ここで出る数字は
 * あくまで概算。確定申告の際は税理士や税務署に確認すること。
 */

/** 所得税の速算表（国税庁 No.2260） */
export const INCOME_TAX_BRACKETS = [
  { upTo: 1_949_000, rate: 0.05, deduct: 0 },
  { upTo: 3_299_000, rate: 0.1, deduct: 97_500 },
  { upTo: 6_949_000, rate: 0.2, deduct: 427_500 },
  { upTo: 8_999_000, rate: 0.23, deduct: 636_000 },
  { upTo: 17_999_000, rate: 0.33, deduct: 1_536_000 },
  { upTo: 39_999_000, rate: 0.4, deduct: 2_796_000 },
  { upTo: Infinity, rate: 0.45, deduct: 4_796_000 },
];

/** 復興特別所得税（基準所得税額の 2.1%） */
export const RECONSTRUCTION_RATE = 0.021;

/** 住民税 所得割の標準税率（道府県民税4% + 市町村民税6%） */
export const RESIDENT_TAX_RATE = 0.1;

/** 住民税の基礎控除（合計所得金額 2,400万円以下） */
export const RESIDENT_BASIC_DEDUCTION = 430_000;

/**
 * 所得税の基礎控除（国税庁 No.1199 / 令和7年度税制改正）。
 * 令和7・8年分は 88万/68万/63万 の上乗せ特例がある。
 */
export function basicDeduction(totalIncome, year) {
  if (totalIncome > 25_000_000) return 0;
  if (totalIncome > 24_500_000) return 160_000;
  if (totalIncome > 24_000_000) return 320_000;
  if (totalIncome > 23_500_000) return 480_000;
  if (totalIncome <= 1_320_000) return 950_000;

  // 令和7年・8年分(2025・2026)のみの上乗せ特例
  const isSpecialPeriod = year === 2025 || year === 2026;
  if (isSpecialPeriod) {
    if (totalIncome <= 3_360_000) return 880_000;
    if (totalIncome <= 4_890_000) return 680_000;
    if (totalIncome <= 6_550_000) return 630_000;
  }
  return 580_000;
}

export function incomeTaxFromTaxable(taxableIncome) {
  if (taxableIncome <= 0) return 0;
  const b = INCOME_TAX_BRACKETS.find((x) => taxableIncome <= x.upTo);
  return Math.max(0, Math.floor(taxableIncome * b.rate - b.deduct));
}

/** 課税所得金額は1,000円未満切捨て */
const roundTaxableIncome = (v) => Math.floor(Math.max(0, v) / 1000) * 1000;

/**
 * 指定の所得構成で、所得税・復興税・住民税を計算する。
 * @param {number} totalIncome  合計所得金額（各種所得の合計）
 * @param {number} otherDeductions 基礎控除以外の所得控除合計
 * @param {number} year 対象年
 */
export function computeTaxes(totalIncome, otherDeductions, year) {
  const basic = basicDeduction(totalIncome, year);

  // --- 所得税 ---
  const taxableIncome = roundTaxableIncome(totalIncome - basic - otherDeductions);
  const incomeTax = incomeTaxFromTaxable(taxableIncome);
  const reconstructionTax = Math.floor(incomeTax * RECONSTRUCTION_RATE);

  // --- 住民税（所得割のみの概算。均等割は含まない） ---
  const residentTaxable = roundTaxableIncome(totalIncome - RESIDENT_BASIC_DEDUCTION - otherDeductions);
  const residentTax = Math.floor(residentTaxable * RESIDENT_TAX_RATE);

  return {
    basicDeduction: basic,
    otherDeductions,
    taxableIncome,
    incomeTax,
    reconstructionTax,
    residentTaxable,
    residentTax,
    total: incomeTax + reconstructionTax + residentTax,
  };
}

/**
 * FLR報酬にかかる税金の概算を計算する。
 *
 * @param {object} p
 * @param {number} p.rewardIncomeJpy  FLR報酬の収入金額（受取時時価の合計, 円）
 * @param {number} p.gasExpenseJpy    必要経費に算入するガス代（円）
 * @param {number} p.otherIncomeJpy   FLR以外の合計所得金額（給与所得控除後の金額など, 円）
 * @param {number} p.otherDeductionsJpy 基礎控除を除く所得控除の合計（社会保険料控除など, 円）
 * @param {number} p.year             対象年
 */
export function estimateTax({
  rewardIncomeJpy = 0,
  gasExpenseJpy = 0,
  otherIncomeJpy = 0,
  otherDeductionsJpy = 0,
  year = new Date().getFullYear(),
} = {}) {
  // 雑所得は赤字でも他の所得と損益通算できないため、マイナスは0として扱う
  const miscIncome = Math.max(0, Math.round(rewardIncomeJpy - gasExpenseJpy));

  const withFlr = computeTaxes(otherIncomeJpy + miscIncome, otherDeductionsJpy, year);
  const withoutFlr = computeTaxes(otherIncomeJpy, otherDeductionsJpy, year);

  const attributable = {
    incomeTax: withFlr.incomeTax - withoutFlr.incomeTax,
    reconstructionTax: withFlr.reconstructionTax - withoutFlr.reconstructionTax,
    residentTax: withFlr.residentTax - withoutFlr.residentTax,
    total: withFlr.total - withoutFlr.total,
  };

  // 雑所得に対する実効税率
  const effectiveRate = miscIncome > 0 ? attributable.total / miscIncome : 0;

  // 雑所得の最後の1円に適用される税率（次に1円稼いだときの税率の目安）
  const marginalBracket = INCOME_TAX_BRACKETS.find((x) => withFlr.taxableIncome <= x.upTo);
  const marginalRate = marginalBracket.rate * (1 + RECONSTRUCTION_RATE) + RESIDENT_TAX_RATE;

  return {
    year,
    input: { rewardIncomeJpy, gasExpenseJpy, otherIncomeJpy, otherDeductionsJpy },
    miscIncome,
    withFlr,
    withoutFlr,
    attributable,
    effectiveRate,
    marginalRate,
  };
}
