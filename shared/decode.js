/**
 * 依存ライブラリなしの最小限のABI復号（ブラウザ / Node.js 共通）。
 *
 * 収集対象イベントの indexed でないパラメータは、いずれも 32 バイト以内の
 * 符号なし整数（uint8 / uint24 / uint120 / uint256）しかない。
 * そのため data を 32 バイトずつ切り出して BigInt にするだけで復号できる。
 * 動的型(string, bytes, 配列)は現れないので、汎用ABIデコーダは不要。
 *
 * この前提は scripts/verify-topics.js で ethers の復号結果と突き合わせて検証している。
 */

/** アドレスを 32 バイトの topic 形式にする（小文字・ゼロ埋め） */
export function addressToTopic(address) {
  const hex = address.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) throw new Error(`不正なアドレスです: ${address}`);
  return '0x' + hex.padStart(64, '0');
}

/** topic からアドレスを取り出す */
export function topicToAddress(topic) {
  return '0x' + topic.replace(/^0x/, '').slice(-40).toLowerCase();
}

/** 0x… の16進文字列を 32 バイトごとに分割して BigInt の配列にする */
export function splitWords(data) {
  const hex = (data || '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    out.push(BigInt('0x' + hex.slice(i, i + 64)));
  }
  return out;
}

/**
 * ログの data 部を、イベント定義の dataFields に従って名前付きの値にする。
 * @returns {Object<string, bigint>}
 */
export function decodeLogData(data, dataFields) {
  const words = splitWords(data);
  if (words.length < dataFields.length) {
    throw new Error(`データ長が不足しています (期待 ${dataFields.length} 語, 実際 ${words.length} 語)`);
  }
  const args = {};
  dataFields.forEach((name, i) => {
    args[name] = words[i];
  });
  return args;
}

/** wei(bigint) を FLR の数値にする。18桁ぶん割るだけなので誤差なく扱える範囲で十分 */
export function weiToNumber(wei, decimals = 18) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = wei / base;
  const frac = wei % base;
  return Number(whole) + Number(frac) / Number(base);
}

/** 0x… の16進文字列を10進数にする（ブロック番号やタイムスタンプ用） */
export function hexToNumber(hex) {
  return typeof hex === 'string' && hex.startsWith('0x') ? parseInt(hex, 16) : Number(hex);
}

/** アドレスの形式チェック（チェックサムは検証しない） */
export function isValidAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

export function normalizeAddress(addr) {
  if (!isValidAddress(addr)) throw new Error(`不正なアドレスです: ${addr}`);
  return addr.trim().toLowerCase();
}
