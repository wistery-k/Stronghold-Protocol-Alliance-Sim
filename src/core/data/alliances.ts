import type { AllianceDef, AllianceId, Modifier } from '../types';

// すべてオリジナルの架空陣営。名前・効果ともに本家とは無関係。
// 段階（level）は 1 始まりで、thresholds[level-1] 人以上で発動。

const pick = (arr: number[], level: number) => arr[Math.min(level, arr.length) - 1] ?? 0;

export const ALLIANCES: Record<AllianceId, AllianceDef> = {
  // ===== 核心盟約 =====
  iron: {
    id: 'iron',
    name: '鉄壁団',
    kind: 'core',
    thresholds: [2, 4, 6],
    levelText: ['所属者の攻撃力+10%', '所属者の攻撃力+25%', '所属者の攻撃力+45%'],
    stackText: '加算数1につき所属者の攻撃力+1%（最大+50%）',
    scope: 'members',
    gainsStacks: true,
    modifier: (level, stacks) => ({
      atkPct: pick([0.1, 0.25, 0.45], level) + 0.01 * Math.min(stacks, 50),
    }),
  },
  gale: {
    id: 'gale',
    name: '疾風隊',
    kind: 'core',
    thresholds: [2, 4],
    levelText: ['所属者の攻撃速度+20、初期SP+5', '所属者の攻撃速度+50、初期SP+15'],
    scope: 'members',
    modifier: (level) => ({
      aspd: pick([20, 50], level),
      startSp: pick([5, 15], level),
    }),
  },
  star: {
    id: 'star',
    name: '星詠み',
    kind: 'core',
    thresholds: [2, 4, 6],
    levelText: [
      '所属者が術耐性を10無視',
      '所属者が術耐性を20無視、与ダメージ+10%',
      '所属者が術耐性を35無視、与ダメージ+25%',
    ],
    scope: 'members',
    modifier: (level) => ({
      resIgnore: pick([10, 20, 35], level),
      damagePct: pick([0, 0.1, 0.25], level),
    }),
  },
  wolf: {
    id: 'wolf',
    name: '灰狼',
    kind: 'core',
    thresholds: [2, 4],
    levelText: ['所属者の会心率+20%、会心ダメージ+10%', '所属者の会心率+40%、会心ダメージ+50%'],
    scope: 'members',
    modifier: (level) => ({
      critChance: pick([0.2, 0.4], level),
      critDmg: pick([0.1, 0.5], level),
    }),
  },
  abyss: {
    id: 'abyss',
    name: '海淵',
    kind: 'core',
    thresholds: [3, 5],
    levelText: ['所属者のSP自然回復+0.3/秒', '所属者のSP自然回復+0.8/秒'],
    stackText: '加算数1につき所属者の与ダメージ+0.5%（最大+50%）',
    scope: 'members',
    gainsStacks: true,
    modifier: (level, stacks) => ({
      spRegen: pick([0.3, 0.8], level),
      damagePct: 0.005 * Math.min(stacks, 100),
    }),
  },
  guild: {
    id: 'guild',
    name: '商会',
    kind: 'core',
    thresholds: [2, 4],
    levelText: ['ラウンド終了時の資金+1', 'ラウンド終了時の資金+3'],
    stackText: '加算数10ごとにラウンド終了時の資金+1（最大+5）',
    scope: 'members',
    gainsStacks: true,
    modifier: () => ({}),
    incomeBonus: (level, stacks) => pick([1, 3], level) + Math.min(Math.floor(stacks / 10), 5),
  },

  // ===== 追加盟約 =====
  precise: {
    id: 'precise',
    name: '精密',
    kind: 'extra',
    thresholds: [2, 3],
    levelText: ['所属者が防御力を25%無視', '所属者が防御力を50%無視'],
    scope: 'members',
    modifier: (level) => ({ defIgnorePct: pick([0.25, 0.5], level) }),
  },
  combo: {
    id: 'combo',
    name: '連撃',
    kind: 'extra',
    thresholds: [2, 4],
    levelText: ['所属者の攻撃速度+10、与ダメージ+5%', '所属者の攻撃速度+25、与ダメージ+15%'],
    scope: 'members',
    modifier: (level) => ({
      aspd: pick([10, 25], level),
      damagePct: pick([0.05, 0.15], level),
    }),
  },
  arcane: {
    id: 'arcane',
    name: '秘術',
    kind: 'extra',
    thresholds: [2, 3],
    levelText: ['所属者の攻撃に攻撃力10%の確定ダメージを追加', '所属者の攻撃に攻撃力25%の確定ダメージを追加'],
    scope: 'members',
    modifier: (level) => ({ trueDmgPct: pick([0.1, 0.25], level) }),
  },
  guardian: {
    id: 'guardian',
    name: '守護',
    kind: 'extra',
    thresholds: [2, 4],
    levelText: ['配置中の全員の攻撃力+5%', '配置中の全員の攻撃力+12%'],
    scope: 'all',
    modifier: (level) => ({ atkPct: pick([0.05, 0.12], level) }),
  },
};

export const ALLIANCE_IDS = Object.keys(ALLIANCES) as AllianceId[];

export function mergeModifiers(...mods: Modifier[]): Modifier {
  const out: Modifier = {};
  for (const m of mods) {
    for (const [k, v] of Object.entries(m) as [keyof Modifier, number | undefined][]) {
      if (v === undefined || v === 0) continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}
