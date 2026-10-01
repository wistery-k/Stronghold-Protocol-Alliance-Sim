// ゲーム全体で使う型定義。
// オペレーター・盟約・堅守特性のデータは本家（堅守協定：盟約（後期））のものを
// scripts/extract_gamedata.py で抽出した data/gamedata.json から読み込む。

export type DamageType = 'physical' | 'arts' | 'true' | 'heal';

export type Profession =
  | 'vanguard'
  | 'guard'
  | 'defender'
  | 'sniper'
  | 'caster'
  | 'medic'
  | 'supporter'
  | 'specialist';

export type Tier = 1 | 2 | 3 | 4 | 5 | 6;
/** 1 = 通常, 2 = 昇進（精鋭） */
export type Star = 1 | 2;

export type CoreAllianceId =
  | 'yan'
  | 'sargon'
  | 'victoria'
  | 'kjerag'
  | 'laterano'
  | 'egir'
  | 'siracusa'
  | 'kazimierz';
export type ExtraAllianceId =
  | 'preci'
  | 'swift'
  | 'skillful'
  | 'arcane'
  | 'stead'
  | 'deput'
  | 'visi'
  | 'mira'
  | 'invest'
  | 'raid'
  | 'indom'
  | 'mani'
  | 'empty'
  | 'solo';
export type AllianceId = CoreAllianceId | ExtraAllianceId;

export interface UnitStats {
  hp: number;
  atk: number;
  def: number;
  res: number;
  /** 基礎攻撃間隔（秒） */
  interval: number;
  /** 攻撃速度（基準100） */
  aspd: number;
  block: number;
  cost: number;
}

export interface SkillData {
  id: string;
  name: string;
  description: string;
  skillType: 'MANUAL' | 'AUTO' | 'PASSIVE';
  durationType: 'NONE' | 'AMMO';
  /** INCREASE_WITH_TIME / INCREASE_WHEN_ATTACK / INCREASE_WHEN_TAKEN_DAMAGE / 8(パッシブ) */
  spType: string | number;
  spCost: number;
  initSp: number;
  duration: number;
  blackboard: Record<string, number>;
}

export interface GarrisonData {
  id: string;
  /** 発動タイミング（SERVER_GAIN, SERVER_PREP_FIN, IN_BATTLE など） */
  event: string;
  effect: string;
  description: string;
  blackboard: Record<string, string | number>;
}

export interface UnitState {
  evolvePhase: number;
  level: number;
  skillLevel: number;
  moduleLevel: number;
  stats: UnitStats;
  skill: SkillData;
  garrisons: GarrisonData[];
}

export interface UnitDef {
  /** "1_01" のような ID（等級_番号） */
  id: string;
  charId: string;
  name: string;
  tier: Tier;
  profession: Profession;
  subProfession: string;
  damageType: DamageType;
  bonds: AllianceId[];
  /** 昇進に必要な枚数（通常3） */
  mergeCount: number;
  normal: UnitState;
  golden: UnitState;
}

/** 盟約・特性などから付与される補正。基本は加算で合成する（damageMult のみ乗算） */
export interface Modifier {
  atkPct?: number;
  /** 基礎攻撃力への固定値加算 */
  atkFlat?: number;
  aspd?: number;
  spRegen?: number;
  startSp?: number;
  /** 防御力無視（割合） */
  defIgnorePct?: number;
  /** 術耐性無視（割合） */
  resIgnorePct?: number;
  /** 与ダメージ上昇（加算） */
  damagePct?: number;
  /** 与ダメージ倍率（乗算） */
  damageMult?: number;
  /** 命中ごとに攻撃力×この割合の確定ダメージを追加 */
  trueDmgPct?: number;
  /** スキル終了時に回復するSP（期待値） */
  spOnSkillEnd?: number;
  /** 弾薬量の増加割合 */
  ammoPct?: number;
  /** 弱点ダメージ（物理と術の有利な方になる） */
  weakDamage?: boolean;
}

export interface EnemyPhase {
  /** HP割合がこの値以下になったら移行（0〜1） */
  belowHpRatio: number;
  def?: number;
  res?: number;
  /** 被ダメージ倍率（0.5 = 半減） */
  damageTaken?: number;
  note: string;
}

export interface EnemyDef {
  id: string;
  name: string;
  hp: number;
  def: number;
  res: number;
  /** 制限時間（秒） */
  duration: number;
  isBoss: boolean;
  phases?: EnemyPhase[];
  description?: string;
}

export interface OwnedUnit {
  uid: number;
  defId: string;
  star: Star;
}
