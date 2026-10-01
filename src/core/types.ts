// ゲーム全体で使う型定義。
// 本家の仕様を厳密に再現するのではなく、「それっぽく妥当な挙動」をデータで表現する方針。

export type DamageType = 'physical' | 'arts' | 'true';

/** 職分（クラス）。現状はDPS計算には使わず、表示と将来のオート戦闘用 */
export type UnitClass =
  | 'vanguard'
  | 'guard'
  | 'defender'
  | 'sniper'
  | 'caster'
  | 'supporter'
  | 'specialist';

export type Tier = 1 | 2 | 3 | 4 | 5 | 6;
export type Star = 1 | 2 | 3;

export type CoreAllianceId = 'iron' | 'gale' | 'star' | 'wolf' | 'abyss' | 'guild';
export type ExtraAllianceId = 'precise' | 'combo' | 'arcane' | 'guardian';
export type AllianceId = CoreAllianceId | ExtraAllianceId;

export interface SkillDef {
  name: string;
  /** 発動に必要なSP */
  spCost: number;
  /** 初期SP */
  initialSp: number;
  /** 効果時間（秒）。0なら即時発動型 */
  duration: number;
  /** true: 攻撃するたびにSP+1（攻撃回復）。false: 毎秒SP+1（自然回復） */
  spOnHit?: boolean;
  /** スキル中の攻撃力上昇（0.5 = +50%） */
  atkPct?: number;
  /** スキル中の攻撃速度上昇（本家同様、間隔 = 基礎間隔 × 100 / (100 + 攻撃速度)） */
  aspd?: number;
  /** スキル中、1回の攻撃が何ヒットになるか */
  hits?: number;
  /** 発動時に攻撃力×burst の即時ダメージ */
  burst?: number;
  /** スキル中のダメージ種別の上書き */
  damageType?: DamageType;
  description: string;
}

export interface UnitDef {
  id: string;
  name: string;
  tier: Tier;
  cls: UnitClass;
  core: CoreAllianceId;
  extra: ExtraAllianceId[];
  atk: number;
  /** 攻撃間隔（秒） */
  interval: number;
  damageType: DamageType;
  skill: SkillDef;
}

/** 盟約などから付与される補正。複数ソースは基本的に加算で合成する */
export interface Modifier {
  atkPct?: number;
  aspd?: number;
  /** 自然回復SPの毎秒追加量 */
  spRegen?: number;
  /** 戦闘開始時の追加SP */
  startSp?: number;
  /** 防御無視（割合） */
  defIgnorePct?: number;
  /** 術耐性無視（固定値） */
  resIgnore?: number;
  /** 与ダメージ上昇（0.1 = +10%） */
  damagePct?: number;
  critChance?: number;
  /** 会心ダメージ追加（基礎会心倍率は1.5） */
  critDmg?: number;
  /** 命中ごとに攻撃力×この割合の確定ダメージを追加 */
  trueDmgPct?: number;
}

export interface AllianceDef {
  id: AllianceId;
  name: string;
  kind: 'core' | 'extra';
  /** 発動に必要な配置人数（異なるオペレーターの数） */
  thresholds: number[];
  /** 各段階の説明 */
  levelText: string[];
  /** 加算数の説明（加算数を持つ盟約のみ） */
  stackText?: string;
  /** 'members' = 所属者のみ, 'all' = 配置中の全員 */
  scope: 'members' | 'all';
  /** 発動段階（1始まり）と加算数から補正を得る */
  modifier: (level: number, stacks: number) => Modifier;
  /** 戦闘開始時に加算数が増えるか */
  gainsStacks?: boolean;
  /** ラウンド終了時の追加資金 */
  incomeBonus?: (level: number, stacks: number) => number;
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
