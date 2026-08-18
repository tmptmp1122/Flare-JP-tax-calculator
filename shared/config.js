/**
 * Flare メインネットの設定（ブラウザ / Node.js 共通）。
 *
 * イベントの topic0 は keccak256(シグネチャ) の固定値なので、あらかじめ計算して
 * 埋め込んである。これによりブラウザ側で ethers を読み込む必要がなくなる。
 * 値は scripts/verify-topics.js で ethers を使って検証できる。
 */

export const CHAIN = {
  name: 'Flare Mainnet',
  chainId: 14,
  symbol: 'FLR',
  decimals: 18,
  rpc: 'https://flare-api.flare.network/ext/C/rpc',
  explorer: 'https://flare-explorer.flare.network',
  explorerApi: 'https://flare-explorer.flare.network/api',
  explorerApiV2: 'https://flare-explorer.flare.network/api/v2',
  // FlareContractRegistry は全 Flare 系チェーンで同一アドレス
  registry: '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019',
};

/** レジストリ照会が失敗した場合のフォールバック（2026-08 時点の実測値） */
export const FALLBACK_ADDRESSES = {
  FtsoRewardManager: '0xA0FF992E0b33DBdC577e488Dc917a042F7B42875',
  RewardManager: '0xC8f55c5aA2C752eE285Bd872855C749f4ee6239B',
  ValidatorRewardManager: '0xc0CF3Aaf93bd978C5BC662564Aa73E331f2eC0B5',
  DistributionToDelegators: '0x9c7A4C83842B29bB4A082b0E689CB9474BD938d0',
  RNat: '0x26d460c3Cf931Fb2014FA436a49e3Af08619810e',
  WNat: '0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d',
};

/**
 * RewardManager (FTSOv2) の ClaimType enum。
 * flare-smart-contracts-v2 IRewardManager.sol:
 *   enum ClaimType { DIRECT, FEE, WNAT, MIRROR, CCHAIN }
 */
export const CLAIM_TYPE = {
  0: { key: 'direct', label: 'ダイレクト報酬' },
  1: { key: 'provider_fee', label: 'データ提供者手数料' },
  2: { key: 'delegation', label: 'FTSOデリゲート報酬' },
  3: { key: 'staking', label: 'ステーキング報酬(Pチェーン)' },
  4: { key: 'staking', label: 'ステーキング報酬(Cチェーン)' },
};

export const CATEGORY = {
  delegation: 'FTSOデリゲート報酬',
  staking: 'ステーキング報酬',
  provider_fee: 'データ提供者手数料',
  direct: 'ダイレクト報酬',
  flaredrop: 'FlareDrop (配布)',
  rnat: 'RNat報酬',
  ftso_v1: 'FTSOデリゲート報酬 (v1)',
};

/**
 * 収集対象のイベント定義。
 *
 * topic0      : keccak256(イベントシグネチャ)
 * walletTopic : ウォレットアドレスが入る indexed topic の番号(1〜3)
 * dataFields  : indexed でないパラメータ名を宣言順に並べたもの。
 *               いずれも 32 バイト以内の整数なので、data を 32 バイトずつ
 *               切り出して順に対応させるだけで復号できる（decode.js）。
 */
export const REWARD_EVENTS = [
  {
    id: 'rewardmanager_v2',
    contract: 'RewardManager',
    signature: 'RewardClaimed(address,address,address,uint24,uint8,uint120)',
    topic0: '0x06f77960d1401cc7d724b5c2b5ad672b9dbf08d8b11516a38c21697c23fbb0d2',
    // topic1=beneficiary, topic2=rewardOwner, topic3=recipient
    walletTopic: 2,
    dataFields: ['rewardEpochId', 'claimType', 'amount'],
    amountField: 'amount',
    epochField: 'rewardEpochId',
    categoryFrom: (a) => CLAIM_TYPE[Number(a.claimType)]?.key ?? 'direct',
    labelFrom: (a) => CLAIM_TYPE[Number(a.claimType)]?.label ?? 'その他報酬',
  },
  {
    id: 'ftsorewardmanager_v1',
    contract: 'FtsoRewardManager',
    signature: 'RewardClaimed(address,address,address,uint256,uint256)',
    topic0: '0x6ec685171a9028d19dc155a48e7824e3c68b03bc8995410e006abe3cbbeb3e2d',
    // topic1=dataProvider, topic2=whoClaimed, topic3=sentTo
    walletTopic: 2,
    dataFields: ['rewardEpoch', 'amount'],
    amountField: 'amount',
    epochField: 'rewardEpoch',
    categoryFrom: () => 'ftso_v1',
    labelFrom: () => 'FTSOデリゲート報酬 (v1)',
  },
  {
    id: 'validatorrewardmanager',
    contract: 'ValidatorRewardManager',
    signature: 'RewardClaimed(address,address,uint256)',
    topic0: '0x0aa4d283470c904c551d18bb894d37e17674920f3261a7f854be501e25f421b7',
    walletTopic: 1,
    dataFields: ['amount'],
    amountField: 'amount',
    epochField: null,
    categoryFrom: () => 'staking',
    labelFrom: () => 'バリデータ/ステーキング報酬',
  },
  {
    id: 'flaredrop',
    contract: 'DistributionToDelegators',
    signature: 'AccountClaimed(address,address,uint256,uint256)',
    topic0: '0xbdb59bec3f0c77052f6645d7365d5008c0affb5d51489a220d01bb1af96897b0',
    walletTopic: 1,
    dataFields: ['month', 'amountWei'],
    amountField: 'amountWei',
    epochField: 'month',
    categoryFrom: () => 'flaredrop',
    labelFrom: () => 'FlareDrop (配布)',
  },
  {
    id: 'rnat',
    contract: 'RNat',
    signature: 'RewardsClaimed(uint256,uint256,address,uint128)',
    topic0: '0x991476c3a75b7c98873b2a3ff8ea47ece4cad28a0b122c8064f619d37787424a',
    // topic1=projectId, topic2=month, topic3=owner
    walletTopic: 3,
    dataFields: ['amount'],
    amountField: 'amount',
    epochField: null,
    categoryFrom: () => 'rnat',
    labelFrom: () => 'RNat報酬',
  },
];
