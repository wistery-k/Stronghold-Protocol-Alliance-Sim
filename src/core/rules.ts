import type { Tier } from './types';

// ゲーム進行に関わる定数をここに集約する（調整しやすくするため）。

export const MAX_ROUND = 15;
export const START_LIFE = 20;
export const START_GOLD = 8;
export const SHOP_SIZE = 5;
export const BENCH_SIZE = 8;
export const MAX_LEVEL = 7;
export const REFRESH_COST = 1;

/** 管理レベル n → n+1 に必要な資金（index = 現在レベル-1） */
export const LEVEL_UP_COST = [4, 6, 8, 10, 14, 18];

/** 配置上限 */
export const deployCap = (level: number) => level + 2;

/** 管理レベルごとの等級出現率（%）。index = レベル-1, 内側 index = 等級-1 */
export const TIER_ODDS: number[][] = [
  [100, 0, 0, 0, 0, 0],
  [70, 30, 0, 0, 0, 0],
  [45, 35, 20, 0, 0, 0],
  [30, 30, 28, 12, 0, 0],
  [20, 25, 28, 20, 7, 0],
  [15, 20, 25, 22, 13, 5],
  [10, 15, 22, 25, 18, 10],
];

/** 各オペレーターの共有プール枚数（等級ごと） */
export const POOL_COPIES: Record<Tier, number> = { 1: 18, 2: 15, 3: 13, 4: 11, 5: 9, 6: 7 };

/** 昇進段階ごとの攻撃力倍率 */
export const STAR_ATK_MULT = [1, 1.8, 3.0];

/** 売却額 = 等級 × 枚数 （全額返金。昇進済みは3枚/9枚ぶん） */
export const copiesOfStar = (star: number) => 3 ** (star - 1);

/** ラウンド終了時の収入 */
export function baseIncome(gold: number, won: boolean): { base: number; interest: number; win: number } {
  return {
    base: 5,
    interest: Math.min(Math.floor(gold / 10), 3),
    win: won ? 1 : 0,
  };
}

/** 撃破失敗時の耐久値減少。残りHP割合に応じる */
export function lifeLoss(remainingRatio: number, isBoss: boolean): number {
  if (remainingRatio <= 0) return 0;
  const base = 1 + Math.ceil(remainingRatio * 4);
  return isBoss ? base * 2 : base;
}
