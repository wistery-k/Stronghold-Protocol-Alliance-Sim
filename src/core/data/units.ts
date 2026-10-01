import type {
  CoreAllianceId,
  DamageType,
  ExtraAllianceId,
  SkillDef,
  Tier,
  UnitClass,
  UnitDef,
} from '../types';

// オペレーター（ユニット）データ。すべてオリジナルの架空キャラクター。
// 数値はゲームバランス用の仮値で、scripts/autoplay.ts で大まかに調整している。

// ---- スキルのひな形 ----
const atkUp = (name: string, pct: number, cost = 30, init = 10, dur = 20): SkillDef => ({
  name,
  spCost: cost,
  initialSp: init,
  duration: dur,
  atkPct: pct,
  description: `${dur}秒間、攻撃力+${Math.round(pct * 100)}%（SP${cost}）`,
});

const rapid = (name: string, aspd: number, cost = 35, init = 15, dur = 15): SkillDef => ({
  name,
  spCost: cost,
  initialSp: init,
  duration: dur,
  aspd,
  description: `${dur}秒間、攻撃速度+${aspd}（SP${cost}）`,
});

const burst = (name: string, mult: number, cost = 6, dt?: DamageType): SkillDef => ({
  name,
  spCost: cost,
  initialSp: 0,
  duration: 0,
  spOnHit: true,
  burst: mult,
  damageType: dt,
  description: `攻撃${cost}回ごとに攻撃力の${Math.round(mult * 100)}%の${dt === 'true' ? '確定' : ''}ダメージ（攻撃回復）`,
});

const multi = (name: string, hits: number, pct: number, cost = 40, init = 20, dur = 20): SkillDef => ({
  name,
  spCost: cost,
  initialSp: init,
  duration: dur,
  hits,
  atkPct: pct,
  description: `${dur}秒間、攻撃が${hits}回ヒットし攻撃力+${Math.round(pct * 100)}%（SP${cost}）`,
});

const BASE_INTERVAL: Record<UnitClass, number> = {
  vanguard: 1.0,
  guard: 1.2,
  defender: 1.2,
  sniper: 1.0,
  caster: 1.6,
  supporter: 1.3,
  specialist: 1.0,
};

const DEFAULT_DTYPE: Record<UnitClass, DamageType> = {
  vanguard: 'physical',
  guard: 'physical',
  defender: 'physical',
  sniper: 'physical',
  caster: 'arts',
  supporter: 'arts',
  specialist: 'physical',
};

function u(
  id: string,
  name: string,
  tier: Tier,
  cls: UnitClass,
  core: CoreAllianceId,
  extra: ExtraAllianceId[],
  atk: number,
  skill: SkillDef,
  opts: { interval?: number; damageType?: DamageType } = {},
): UnitDef {
  return {
    id,
    name,
    tier,
    cls,
    core,
    extra,
    atk,
    interval: opts.interval ?? BASE_INTERVAL[cls],
    damageType: opts.damageType ?? DEFAULT_DTYPE[cls],
    skill,
  };
}

export const UNITS: UnitDef[] = [
  // ---- 等級1 ----
  u('kite', 'カイト', 1, 'vanguard', 'gale', ['combo'], 330, rapid('突風', 60)),
  u('bolt', 'ボルト', 1, 'sniper', 'wolf', ['precise'], 360, atkUp('照準', 0.5)),
  u('ember', 'エンバー', 1, 'caster', 'star', ['arcane'], 420, burst('火の粉', 2.0, 5)),
  u('rook', 'ルーク', 1, 'defender', 'iron', ['guardian'], 300, atkUp('構え', 0.6)),
  u('mira', 'ミラ', 1, 'guard', 'abyss', ['combo'], 390, multi('二連', 2, 0, 35, 15, 15)),
  u('penny', 'ペニー', 1, 'supporter', 'guild', ['arcane'], 310, atkUp('投資', 0.4)),

  // ---- 等級2 ----
  u('sable', 'セーブル', 2, 'guard', 'iron', ['combo'], 500, burst('重斬', 2.2, 5)),
  u('wren', 'レン', 2, 'sniper', 'wolf', ['combo'], 470, rapid('速射', 70)),
  u('fen', 'フェン', 2, 'caster', 'star', ['precise'], 560, atkUp('集光', 0.6)),
  u('dash', 'ダッシュ', 2, 'specialist', 'gale', ['precise'], 490, burst('奇襲', 2.5, 6)),
  u('coral', 'コーラル', 2, 'sniper', 'abyss', ['guardian'], 460, atkUp('潮読み', 0.6)),
  u('tally', 'タリー', 2, 'vanguard', 'guild', ['guardian'], 440, rapid('勘定', 60)),

  // ---- 等級3 ----
  u('bastion', 'バスティオン', 3, 'defender', 'iron', ['guardian'], 560, atkUp('反撃態勢', 0.9)),
  u('hawk', 'ホーク', 3, 'sniper', 'wolf', ['precise'], 640, burst('狙撃', 2.6, 5)),
  u('lumen', 'ルーメ', 3, 'caster', 'star', ['arcane'], 700, multi('星屑', 2, 0.2)),
  u('zephyr', 'ゼファー', 3, 'guard', 'gale', ['combo'], 660, rapid('旋風', 80)),
  u('tide', 'タイド', 3, 'caster', 'abyss', ['arcane'], 680, atkUp('満ち潮', 0.8)),
  u('ledger', 'レジャー', 3, 'supporter', 'guild', ['precise'], 600, burst('精算', 2.0, 4)),

  // ---- 等級4 ----
  u('aegis', 'イージス', 4, 'guard', 'iron', ['precise'], 860, atkUp('不落', 1.0)),
  u('falco', 'ファルコ', 4, 'sniper', 'wolf', ['combo'], 800, multi('連弾', 3, 0)),
  u('nova', 'ノヴァ', 4, 'caster', 'star', ['guardian'], 900, burst('新星', 3.0, 5)),
  u('squall', 'スコール', 4, 'specialist', 'gale', ['arcane'], 820, rapid('嵐', 100)),
  u('kraken', 'クラーケン', 4, 'guard', 'abyss', ['combo'], 920, atkUp('深淵の腕', 0.9)),

  // ---- 等級5 ----
  u('rampart', 'ランパート', 5, 'defender', 'iron', ['arcane'], 980, multi('城壁崩し', 2, 0.4)),
  u('moon', 'ムーン', 5, 'sniper', 'wolf', ['arcane'], 1050, burst('月光', 3.2, 5)),
  u('aurora', 'オーロラ', 5, 'caster', 'star', ['combo'], 1150, atkUp('極光', 1.2)),
  u('tempest', 'テンペスト', 5, 'vanguard', 'gale', ['guardian'], 980, rapid('大嵐', 120)),
  u('leviathan', 'リヴァイア', 5, 'guard', 'abyss', ['precise'], 1180, multi('大渦', 2, 0.5)),
  u('magnate', 'マグネイト', 5, 'supporter', 'guild', ['combo'], 950, atkUp('買収', 1.0)),

  // ---- 等級6 ----
  u('citadel', 'シタデル', 6, 'guard', 'iron', ['guardian'], 1400, atkUp('城塞の意志', 1.5)),
  u('eclipse', 'エクリプス', 6, 'caster', 'star', ['precise'], 1500, burst('蝕', 4.0, 4)),
  u('fenrir', 'フェンリル', 6, 'sniper', 'wolf', ['guardian'], 1350, multi('群狼', 3, 0.3)),
  u('maelstrom', 'メイルストロム', 6, 'guard', 'abyss', ['arcane'], 1450, rapid('渦潮', 130)),
];

export const UNIT_MAP: Record<string, UnitDef> = Object.fromEntries(UNITS.map((d) => [d.id, d]));

export function getUnit(id: string): UnitDef {
  const d = UNIT_MAP[id];
  if (!d) throw new Error(`unknown unit: ${id}`);
  return d;
}

export const CLASS_NAME: Record<UnitClass, string> = {
  vanguard: '先鋒',
  guard: '前衛',
  defender: '重装',
  sniper: '狙撃',
  caster: '術師',
  supporter: '補助',
  specialist: '特殊',
};

export const DAMAGE_TYPE_NAME: Record<DamageType, string> = {
  physical: '物理',
  arts: '術',
  true: '確定',
};
