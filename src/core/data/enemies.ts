import type { EnemyDef } from '../types';

// ラウンドごとの「DPSチェック」対象。オート戦闘を実装するまでは、
// 各ラウンドを「制限時間内に単体の標的を削り切れるか」で判定する。
// すべてオリジナルの架空の敵。

export const BOSSES: EnemyDef[] = [
  {
    id: 'boss_golem',
    name: '錆びた番兵',
    hp: 60000,
    def: 600,
    res: 10,
    duration: 60,
    isBoss: true,
    description: '高い防御力を持つ。物理ダメージだけでは苦しい。',
    phases: [{ belowHpRatio: 0.5, def: 900, note: '装甲展開：防御力が900に上昇' }],
  },
  {
    id: 'boss_witch',
    name: '霧の魔女',
    hp: 240000,
    def: 250,
    res: 60,
    duration: 60,
    isBoss: true,
    description: '高い術耐性。HPが減ると霧で被ダメージを軽減する。',
    phases: [{ belowHpRatio: 0.3, damageTaken: 0.7, note: '濃霧：被ダメージ-30%' }],
  },
  {
    id: 'boss_colossus',
    name: '終焉の巨像',
    hp: 400000,
    def: 900,
    res: 40,
    duration: 75,
    isBoss: true,
    description: '最終ボス。段階的に防御と術耐性が上がる。',
    phases: [
      { belowHpRatio: 0.66, def: 1200, note: '第二形態：防御力1200' },
      { belowHpRatio: 0.33, def: 1500, res: 55, note: '最終形態：防御力1500・術耐性55' },
    ],
  },
];

// ラウンドごとの必要DPS（防御・術耐性を無視した値）。HP = 必要DPS × 30秒
const NORMAL_REQUIRED_DPS: Record<number, number> = {
  1: 300, 2: 450, 3: 600, 4: 800, 5: 1000, 6: 1200, 7: 1450,
  8: 1700, 9: 2000, 10: 2300, 11: 2600, 12: 3000, 13: 3400,
};

/** 通常ラウンドの標的。ラウンドごとにHPと防御が伸びる */
function normalEnemy(round: number): EnemyDef {
  const hp = (NORMAL_REQUIRED_DPS[round] ?? 1000) * 30;
  const def = 100 + round * 35;
  const res = round >= 7 ? 20 : 10;
  return {
    id: `normal_${round}`,
    name: round % 2 === 0 ? '突撃部隊' : '重装部隊',
    hp,
    def,
    res,
    duration: 30,
    isBoss: false,
  };
}

// 本家と同じくラウンド14・15がボス戦
const BOSS_ROUNDS: Record<number, number> = { 14: 1, 15: 2 };

export function enemyForRound(round: number): EnemyDef {
  const b = BOSS_ROUNDS[round];
  if (b !== undefined) return BOSSES[b];
  return normalEnemy(round);
}
