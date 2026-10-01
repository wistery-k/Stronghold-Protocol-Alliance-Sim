import { GAMEDATA } from './data/units';
import type { Tier } from './types';

// ゲーム進行に関わる定数。本家データにあるものはそこから読み、
// 無いもの（確率・プール枚数など）は妥当そうな値を定めている。

export const MAX_ROUND = 15;
export const START_LIFE = 20;
/** 1ラウンドに失う耐久値の上限（本家データ costPlayerHpLimit） */
export const MAX_LIFE_LOSS = 10;

/** ラウンド n の開始時に得る資金 */
export const roundIncome = (round: number) => round + 3;

/** 盤面の配置上限（本家データ maxBattleChessCnt） */
export const DEPLOY_CAP = GAMEDATA.shop.maxBattle;
export const deployCap = (_level: number) => DEPLOY_CAP;
/** 控え（整備区）の枠数（本家データ maxDeckChessCnt） */
export const BENCH_SIZE = GAMEDATA.shop.maxDeck;
export const REFRESH_COST = GAMEDATA.shop.refreshPrice;

export const SHOP_LEVELS = GAMEDATA.shop.levels;
export const MAX_LEVEL = SHOP_LEVELS.length;
/** 管理レベルごとのショップ枠数 */
export const shopSlots = (level: number) => SHOP_LEVELS[level - 1].slots;
/** 管理レベル level → level+1 の基本価格。ラウンドが進むごとに1ずつ安くなる */
export const baseLevelUpCost = (level: number) => (level >= MAX_LEVEL ? null : SHOP_LEVELS[level - 1].upgradePrice);

/** 購入価格（等級1:2、等級2〜4:3、等級5〜6:4） */
export const buyPrice = (tier: Tier) => GAMEDATA.shop.prices[String(tier)].buy;
/** 売却価格 */
export const sellPriceOf = (tier: Tier) => GAMEDATA.shop.prices[String(tier)].sell;

/** 管理レベルごとの等級出現率（%）。本家データに無いので独自に設定 */
export const TIER_ODDS: number[][] = [
  [100, 0, 0, 0, 0, 0],
  [65, 35, 0, 0, 0, 0],
  [40, 35, 25, 0, 0, 0],
  [25, 30, 30, 15, 0, 0],
  [15, 20, 30, 25, 10, 0],
  [10, 15, 25, 25, 17, 8],
];

/** 各オペレーターの共有プール枚数（等級ごと。独自設定） */
export const POOL_COPIES: Record<Tier, number> = { 1: 12, 2: 10, 3: 9, 4: 8, 5: 7, 6: 6 };

/** 撃破失敗時の耐久値減少。残りHP割合に応じる */
export function lifeLoss(remainingRatio: number, isBoss: boolean): number {
  if (remainingRatio <= 0) return 0;
  const base = 1 + Math.ceil(remainingRatio * 4);
  return Math.min(isBoss ? base * 2 : base, MAX_LIFE_LOSS);
}

export const BUY_LOCK_MESSAGE = '精鋭化の報酬を先に選んでください';
