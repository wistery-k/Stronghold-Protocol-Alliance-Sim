import { bondKey, type BattleGlobals } from './alliance';
import { BOARD_COLS, BOARD_ROWS, BOSS_CELLS, BOSS_CENTER, DIR_DELTA, ENEMY_PATHS, GOAL, PATH_TILES, canBlockAt, canPlace, cellPos, cellX, cellY, rangeCells, tileAt, DEFAULT_DIRECTION } from './board';
import { ENEMIES, rangeGrid, unitRangeIds, type ElementType, type EnemySpec, type RoundSpec } from './data/battle';
import { ENEMY_ATK_SCALE, ENEMY_HP_SCALE, ENEMY_SPEED_SCALE } from './rules';
import { unitState } from './data/units';
import { ALLIANCES } from './data/alliances';
import { ABYSSAL, talentBB } from './talents';
import type { AllianceId, DamageType, Direction, EnemyDef, EnemyPhase, GarrisonData, Modifier, SkillData, Star, UnitDef } from './types';

// 戦闘シミュレーション（時間刻み）。
// - マップ戦闘：敵が経路を進み、地上のオペレーターがブロックし、攻撃範囲内の敵を攻撃する。敵も攻撃し、医療が回復する。
// - 単体標的（DPSチェック）：動かない標的1体を全員が攻撃する（テスト・比較用）。
// 本家のスキルデータ（blackboard）から攻撃力・攻撃速度・倍率などを読み取って近似する。
// 確率効果は期待値で扱うので結果は決定的。

export interface SimUnitInput {
  uid: number;
  def: UnitDef;
  star: Star;
  mods: Modifier;
  /** 戦闘中に持つ特性（省略時はオペレーター自身の特性） */
  garrisons?: GarrisonData[];
  /** 左右一直線上のオペレーター数 */
  rowCount?: number;
  /** 特性で加算数が増える時の追加量 */
  bonusGain?: number;
  /** マップ上の位置と向き（マップ戦闘で使う） */
  pos?: number;
  dir?: Direction;
}

/** 与ダメージの種別（元素ダメージは防御力・術耐性の影響を受けない別枠） */
export type DmgKind = 'physical' | 'arts' | 'true' | 'element';
const kindOf = (type: DamageType): DmgKind => (type === 'heal' ? 'physical' : type);

export interface SimUnitResult {
  uid: number;
  defId: string;
  name: string;
  star: Star;
  damage: number;
  hits: number;
  skillCasts: number;
  kills: number;
  /** 受けたダメージ */
  taken: number;
  /** 回復した量（医療） */
  healed: number;
  /** 与ダメージの種別ごとの内訳（確定には【シラクーザ】の確定ダメージも含む） */
  byKind: Record<DmgKind, number>;
  /** 与ダメージのうち【シラクーザ】Lv2の確定ダメージ */
  siracusaDamage?: number;
  /** 付与したバリアが実際に防いだダメージ */
  barrier: number;
  /** 最初に倒れた時刻（倒れなければ null） */
  downAt: number | null;
  /** 撤退（倒れた・コスト不足）回数と再配置回数 */
  retreats: number;
  redeploys: number;
  /** 【強襲】で敵の周囲へ再配置された回数 */
  raids?: number;
}

export interface SimResult {
  enemy: EnemyDef;
  killed: boolean;
  killTime: number | null;
  elapsed: number;
  totalDamage: number;
  remainingHp: number;
  perUnit: SimUnitResult[];
  timeline: { t: number; hp: number }[];
  phaseLog: { t: number; note: string }[];
  /** 戦闘中の特性で増えた加算数（戦闘後に反映） */
  stackGains: Partial<Record<AllianceId, number>>;
}

export interface EnemyMeta {
  id: number;
  key: string;
  name: string;
  boss: boolean;
  flying: boolean;
  maxHp: number;
  /** 懸賞の資金 */
  bounty?: number;
  /** 周囲攻撃の半径（マス） */
  aura?: number;
  /** 常に表示する攻撃範囲の半径（マス。帝国砲撃誘導機） */
  ring?: number;
  /** 大型のボス（右の2列×上の3行を占める） */
  large?: boolean;
}

/** リプレイ用のコマ：敵ごとに [id, x*100, y*100, HP%] と、スキル中のユニット */
export interface ReplayFrame {
  t: number;
  /** [id, x×100, y×100, HP%, 状態ビット（1 = 解放済みの囚人、2 = スタン中、4 = 恐怖中、8 = ステルス中、16 = 活性源石の上、32 = 石像形態、64 = 飛行形態の石像、128 = 寒冷、256 = 凍結、512 = 戦慄、1024 = バインド）] */
  e: [number, number, number, number, number?][];
  s: number[];
  /** 所持コスト */
  c?: number;
  /**
   * オペレーターの状態 [uid, 残りHP%（倒れていれば -1）, ゲージ%, 状態, 値]。
   * 状態 0: SP溜め中（ゲージ=SP%）、1: スキル中（ゲージ=残り時間%、値=残り秒×10）、2: 弾薬スキル中（値=残り弾数）、3: スキルなし・常時、
   * 4: 再配置待ち（ゲージ=経過%、値=残り秒×10。0ならコスト待ち）
   */
  u?: [number, number, number, number, number, number?][];
  /** 【サルゴン】の強化の層数 [uid, 層数]。1層以上のものだけ */
  sg?: [number, number][];
  /** 【シラクーザ】の攻撃速度上昇を受けているオペレーターの uid */
  sc?: number[];
  /** ステルス中のオペレーターの uid */
  st?: number[];
  /** 離陸中のオペレーターの uid（ティッピ） */
  lf?: number[];
  /** 身替りと入れ替わっているオペレーターの uid（傀儡師） */
  dl?: number[];
  /** 【強襲】で再配置されて戦闘開始時の位置にいないオペレーター（撤退中も含む）[uid, マス, 向き（0右・1下・2左・3上）] */
  mv?: [number, number, number][];
  /** 召喚された身替り（カゼマルの紙人形）[uid, マス, HP%, 召喚主の uid] */
  tk?: [number, number, number, number][];
  /** 荒蕪ラップランドS3のザーロ [uid, x×100, y×100, 取り付いていれば1] */
  zr?: [number, number, number, number][];
  /** オペレーターの元素損傷 [uid, 種類（0灼燃・1神経・2侵蝕・3壊死）, 爆発までの蓄積%（爆発中は 100 + 残り%）]。1以上溜まっているものだけ */
  ue?: [number, number, number][];
}

/**
 * リプレイの演出（攻撃・範囲攻撃・敵の射撃など）。[時刻×100, 種類, ...]
 * - 0 命中：[uid, 敵id, ダメージ種別（0物理・1術・2確定）]
 * - 1 円形の範囲：[uid, x×100, y×100, 半径×100]
 * - 2 攻撃範囲全体への攻撃：[uid, スキル中なら1]
 * - 3 敵の遠距離攻撃：[敵id, uid, 術なら1]
 * - 4 治療：[uid, 対象uid]
 * - 5 設置した範囲（ブリキなど）：[uid, x×100, y×100, 半径×100, 秒数×10]
 * - 6 敵の汚染秽蝕：[敵id, x×100, y×100, 半径×100, 秒数×10]
 * - 7 ボスの弾の着弾（周囲8マスをスタン）：[x×100, y×100, スタン秒数×10]
 * - 8 剣雨の命中（術ダメージとスタン）：[uid, x×100, y×100]
 * - 9 ザーロの1秒ごとの術ダメージ：[uid, x×100, y×100]
 * - 13 派手なスキルの演出（SKILL_FX）：[uid, 演出の種類, 0 = 発動・1 = スキル中の攻撃, 命中した敵の位置 x×100, y×100 の並び]
 */
export type FxEvent = number[];

/**
 * fx 13 で専用の演出を出すスキル（オペレーターごとにスキルは1つ）。
 * 1 ノーシスS2「ゼロバースト」、2 凛御シルバーアッシュS2「御敵の鋭鋒」、3 シルバーアッシュS3「真銀斬」、4 聖聆プラマニクスS3「群山俯首」
 */
export const SKILL_FX: Record<string, number> = { char_206_gnosis: 1, char_1045_svash2: 2, char_172_svrash: 3, char_1046_sbell2: 4 };

/** スキル中（攻撃モーション中）にスキルの攻撃範囲を表示するオペレーター（デーゲンブレヒャーS3） */
export const SKILL_RANGE_SHOWN = new Set(['char_4116_blkkgt']);

export interface BattleResult {
  round: number;
  timeLimit: number;
  elapsed: number;
  total: number;
  killed: number;
  leaked: number;
  /** 突破・時間切れによる耐久値の減少（上限適用前） */
  lifeLoss: number;
  /** 突破した敵（種類ごと） */
  leaks: { key: string; name: string; count: number; lifeLoss: number }[];
  /** ボスの残りHP割合（ボスがいない・倒したなら 0） */
  bossRemaining: number;
  /** 大型のボス（冑）を倒して戦闘が即座に終わった */
  bossDefeated?: boolean;
  cleared: boolean;
  totalDamage: number;
  totalHp: number;
  perUnit: SimUnitResult[];
  /** 残っている敵の合計HP（0.5秒ごと） */
  timeline: { t: number; hp: number; alive: number }[];
  stackGains: Partial<Record<AllianceId, number>>;
  /** 戦闘中に加算数を得た内訳 */
  stackSources: StackSource[];
  /** 寒冷・凍結にした回数 */
  colds: number;
  freezes: number;
  /** 元素損傷が爆発した回数（味方・敵） */
  opBursts: number;
  enBursts: number;
  /** 【サルゴン】のスキル発動時の強化：1層あたりの攻撃速度・攻撃力と、層数の最大・時間平均 */
  sargon?: { aspd: number; atkPct: number; max: number; avg: number };
  /** 【シラクーザ】の配置後の攻撃速度上昇（上昇量・秒数・対象人数） */
  siracusa?: { aspd: number; duration: number; members: number };
  enemies: EnemyMeta[];
  /** リプレイの演出 */
  fx?: FxEvent[];
  /** 懸賞の敵を倒して得た資金 */
  bountyGold: number;
  bountyKills: number;
  frames?: ReplayFrame[];
}

export const MIN_DAMAGE_RATIO = 0.05;

// ------------------------------------------------------------
// スキルの解釈
// ------------------------------------------------------------

export interface SkillModel {
  charge: 'time' | 'attack' | 'none';
  passive: boolean;
  spCost: number;
  initSp: number;
  duration: number;
  ammo: number;
  atkPct: number;
  aspd: number;
  /** 攻撃間隔への加算（秒）。本家の base_attack_time は秒単位の加算 */
  intervalAdd: number;
  atkScale: number;
  hits: number;
  /** 同時に攻撃する敵の数（スキルで指定がある場合） */
  maxTarget: number;
  /** ブロック数の増加 */
  blockAdd: number;
  /** 効果時間のない即時発動スキル（1回の大ダメージ） */
  instant: boolean;
  /** スキル中の防御力・最大HPの上昇（割合）と毎秒の回復（最大HP比） */
  defPct: number;
  hpPct: number;
  /** 最大HPの固定値の上昇 */
  hpFlat: number;
  regenPct: number;
  /** blackboard の生の値（スキルごとの特殊な処理用） */
  bb: Record<string, number>;
  /** 配置時に自動で発動し、効果時間が減っていくスキル（ウタゲ・グラベル） */
  onDeploy: boolean;
  /** 配置時にHPがこの割合減る（ウタゲ） */
  deployHpLoss: number;
  /** 配置時に最大HPのこの割合のバリア（グラベル） */
  barrier: number;
  /** スキル中は通常攻撃が術ダメージ */
  artsAttack: boolean;
  /** スキル中、攻撃範囲内の敵の防御力・術耐性を下げる（割合。プラマニクス） */
  enemyDef: number;
  enemyRes: number;
  /** 寒冷：命中した敵に付与（cold 秒、確率 coldProb） */
  cold: number;
  coldProb: number;
  /** コストの獲得：発動時・スキル中の合計（徐々に）・攻撃ごと */
  costOnCast: number;
  costOverTime: number;
  costPerAttack: number;
  /** 連鎖術師：スキル中は跳躍の減衰なし（レイズ） */
  noChainDecay: boolean;
}

export function parseSkill(s: SkillData): SkillModel {
  const bb = s.blackboard;
  const get = (...keys: string[]) => {
    for (const k of keys) if (bb[k] !== undefined) return bb[k];
    return undefined;
  };
  // 「範囲内の敵全員の防御力-」：防御・術耐性の値は敵に掛かる
  const enemyAura = /範囲内の敵全員の(防御力|術耐性)-/.test(s.description);
  // 配置時に発動して時間で終わるスキル（ウタゲ・グラベル・血掟テキサス）
  const onDeploy = s.skillType === 'PASSIVE' && s.description.startsWith('配置後') && (bb.duration !== undefined || s.duration > 0);
  const passive = s.skillType === 'PASSIVE' && !onDeploy;
  const charge = s.spType === 'INCREASE_WITH_TIME' ? 'time' : s.spType === 'INCREASE_WHEN_ATTACK' ? 'attack' : 'none';
  const atk = get('atk', 'attack@atk') ?? 0;
  const timesRaw = get('times', 'attack@times');
  const hits = timesRaw !== undefined && Number.isInteger(timesRaw) && timesRaw >= 2 ? timesRaw : 1;
  const ammo = s.durationType === 'AMMO' ? get('attack@trigger_time', 'trigger_time', 'ammo', 'cnt', 'attack@cnt') ?? 0 : 0;
  // 「退場まで効果継続」のスキル（スルト）は長い効果時間として扱う。それ以外の duration < 0 は即時発動
  const duration = onDeploy
    ? Number(bb.duration ?? s.duration)
    : s.duration < 0 && s.durationType !== 'AMMO' && s.description.includes('退場まで効果継続')
      ? 9999
      : Math.max(0, s.duration);
  return {
    charge,
    passive,
    spCost: s.spCost,
    initSp: s.initSp,
    duration,
    ammo,
    atkPct: atk < 10 ? atk : 0,
    aspd: get('attack_speed', 'attack@attack_speed') ?? 0,
    intervalAdd: get('base_attack_time', 'attack@base_attack_time') ?? 0,
    // 1未満の倍率は副次効果（範囲ダメージ等）のことが多いので、主攻撃には使わない
    atkScale: Math.max(1, get('atk_scale', 'attack@atk_scale') ?? 1),
    hits,
    // 配置時のスキルの max_target は副次効果（血掟テキサスの剣雨）の対象数
    maxTarget: onDeploy ? 1 : Math.max(1, Math.round(get('attack@max_target', 'max_target') ?? 1)),
    blockAdd: Math.max(0, Math.round(get('block_cnt') ?? 0)),
    instant: !passive && !onDeploy && duration <= 0 && ammo <= 0,
    defPct: !enemyAura && (get('def') ?? 0) < 10 ? get('def') ?? 0 : 0,
    hpPct: (get('max_hp') ?? 0) < 10 ? get('max_hp') ?? 0 : 0,
    hpFlat: (get('max_hp') ?? 0) >= 10 ? get('max_hp') ?? 0 : 0,
    // 負の値は敵への効果（回復量低下など）なので使わない
    regenPct: Math.max(0, get('hp_recovery_per_sec_by_max_hp_ratio') ?? 0),
    bb: Object.fromEntries(Object.entries(bb).filter(([, v]) => typeof v === 'number')) as Record<string, number>,
    onDeploy,
    enemyDef: enemyAura ? Number(bb.def ?? 0) : 0,
    enemyRes: enemyAura ? Number(bb.magic_resistance ?? 0) : 0,
    deployHpLoss: onDeploy && /HPが\d+%減少/.test(s.description) ? Number(bb.hp_ratio ?? 0) : 0,
    barrier: onDeploy && s.description.includes('バリア') ? Number(bb.hp_ratio ?? 0) : 0,
    artsAttack: s.description.includes('通常攻撃が術ダメージを与える'),
    cold: Number(get('cold', 'attack@cold') ?? 0),
    coldProb: Number(get('attack@prob') ?? 1),
    costOnCast: Number(/(?<!たびに)所持コスト\+(\d+)/.exec(s.description)?.[1] ?? 0),
    costOverTime: Number(/所持コストが徐々に増加（合計(\d+)）/.exec(s.description)?.[1] ?? 0),
    costPerAttack: /攻撃するたびに所持コスト\+1/.test(s.description) ? 1 : 0,
    noChainDecay: s.description.includes('跳躍時のダメージ減衰が発生しなくなる'),
  };
}

// ------------------------------------------------------------
// ダメージ計算
// ------------------------------------------------------------

export interface DefenseState {
  def: number;
  res: number;
  damageTaken: number;
}

/** 1ヒットぶんのダメージ（倍率込みの攻撃力 raw で計算） */
/** 結果に出す時に数値を丸める */
const outResult = (r: SimUnitResult): SimUnitResult => ({
  ...r,
  damage: Math.round(r.damage),
  barrier: Math.round(r.barrier),
  byKind: { physical: Math.round(r.byKind.physical), arts: Math.round(r.byKind.arts), true: Math.round(r.byKind.true), element: Math.round(r.byKind.element) },
  siracusaDamage: r.siracusaDamage === undefined ? undefined : Math.round(r.siracusaDamage),
});

export function hitDamage(raw: number, type: DamageType, enemy: DefenseState, mods: Modifier, artsVuln = 0): number {
  if (type === 'heal') return 0;
  let dmg: number;
  if (type === 'physical') {
    const def = Math.max(0, enemy.def * (1 - Math.min(mods.defIgnorePct ?? 0, 1)) - (mods.defIgnoreFlat ?? 0));
    dmg = Math.max(raw - def, raw * MIN_DAMAGE_RATIO);
  } else if (type === 'arts') {
    const res = Math.min(Math.max(0, enemy.res * (1 - Math.min(mods.resIgnorePct ?? 0, 1)) - (mods.resIgnoreFlat ?? 0)), 100);
    dmg = Math.max(raw * (1 - res / 100), raw * MIN_DAMAGE_RATIO) * (1 + artsVuln);
  } else {
    dmg = raw;
  }
  return dmg * (1 + (mods.damagePct ?? 0)) * (mods.damageMult ?? 1) * enemy.damageTaken;
}

/** 弱点ダメージ：物理と術のうち与ダメージが大きい方 */
function bestType(base: DamageType, raw: number, enemy: DefenseState, mods: Modifier): DamageType {
  if (!mods.weakDamage || base === 'heal' || base === 'true') return base;
  return hitDamage(raw, 'physical', enemy, mods) >= hitDamage(raw, 'arts', enemy, mods) ? 'physical' : 'arts';
}

export function attackInterval(baseInterval: number, aspd: number, intervalAdd = 0): number {
  return (Math.max(0.1, baseInterval + intervalAdd) * 100) / Math.max(20, Math.min(600, aspd));
}

export function baseAtk(def: UnitDef, star: Star, mods: Modifier, extraPct = 0): number {
  const st = unitState(def, star).stats;
  return (st.atk + (mods.atkFlat ?? 0)) * (1 + (mods.atkPct ?? 0) + extraPct);
}

/** カジミエーシュの競技旗：配置後しばらく与ダメージ上昇、その後減衰 */
function flagFactor(mods: Modifier, t: number): number {
  if (!mods.flagScale) return 1;
  if (t < (mods.flagDuration ?? 0)) return mods.flagScale;
  const steps = Math.floor((t - (mods.flagDuration ?? 0)) / (mods.flagStep || 0.5)) + 1;
  return Math.max(1, mods.flagScale + (mods.flagMinus ?? 0) * steps);
}

// ------------------------------------------------------------
// 職種ごとの攻撃の仕方（近似）
// ------------------------------------------------------------

/** 範囲攻撃（対象の周囲1マスにも同じダメージ） */
const SPLASH_SUB = new Set(['splashcaster', 'bombarder', 'blastcaster', 'fortress']);
/** 攻撃範囲内の敵すべてを攻撃 */
const ALL_IN_RANGE_SUB = new Set(['stalker']);
/** 領主の特性：遠距離攻撃（自身がブロックしていない敵への攻撃）は攻撃力80%。飛行の敵も攻撃できる */
const LORD_RANGED_SCALE = 0.8;
/** 特性で遠距離攻撃もできる近距離の職分（飛行の敵も攻撃する）：領主・偵察兵（偵察兵は攻撃力の低下なし） */
const RANGED_TRAIT_SUBPROF = new Set(['lord', 'agent']);
/** スキル中、領主の遠距離攻撃の攻撃力低下が無くなる（ラップランドS2・チューバイS3は「無効化」、シルバーアッシュS3は「近接攻撃と見なす」） */
const LORD_FULL_ATK_SKILL = new Set(['char_140_whitew', 'char_4082_qiubai', 'char_172_svrash']);
/** 近距離だが、スキルは飛行の敵にも当たる（凛御シルバーアッシュS2・デーゲンブレヒャーS3） */
const SKILL_ANTI_AIR = new Set(['char_1045_svash2', 'char_4116_blkkgt']);
/** スキル中、HP割合に応じて攻撃力が上がる「勇猛」（ヒューマス）：[必要HP割合, 攻撃力] を高い順に */
function peakPerformance(bb: Record<string, number>): [number, number][] {
  const out: [number, number][] = [];
  for (const [k, v] of Object.entries(bb)) {
    const m = k.match(/^(.*)\.peak_performance\.atk$/);
    if (m) out.push([bb[`${m[1]}.peak_performance.hp_ratio`] ?? 0, v]);
  }
  return out.sort((a, b) => b[0] - a[0]);
}
/** 俊敏でSPが回復した後、スキルを再発動できるまでの時間（秒） */
const SWIFT_RECAST_DELAY = 1;
/** 連鎖術師：跳躍できる距離（マス） */
const CHAIN_JUMP_RADIUS = 1.5;
/** シヴィライト・エテルナ：S3の鼓舞とHPの再配分、素質「微塵」で特性の効果1.5倍 */
const ETERNA = 'char_4134_cetsyr';
/** スキル中、近接攻撃を確率で回避して弾薬を補充する（聖約イグゼキュター） */
const EVADE_REFILL = new Set(['char_1032_excu2']);
/**
 * 武者・鎌：他の味方から治療されず、攻撃で自身を回復する（昇進2の値）。
 * 武者は攻撃1回ごと、鎌は命中した敵1体ごと（最大でブロック数まで）
 */
const SELF_HEAL_SUB: Record<string, { hp: number; perTarget: boolean }> = {
  musha: { hp: 70, perTarget: false },
  reaper: { hp: 50, perTarget: true },
};

// ------------------------------------------------------------
// 戦闘中の加算数獲得
// ------------------------------------------------------------

interface GarrisonEvent {
  kind: 'useskill' | 'kill' | 'ammo' | 'dead' | 'freeze' | 'sleepstun';
  bonds: AllianceId[] | 'maxstack';
  count: number;
  /** シヴィライト・エテルナ：この特性で加算数を得るたびに追加される数（上限の対象外） */
  bonus: number;
  max: number;
  every: number;
  gained: number;
  /** 確率（期待値で、累積が1に達するたびに発生） */
  prob: number;
  acc: number;
  /** 特性の持ち主 */
  uid: number;
  name: string;
}

/** 戦闘中に加算数を得た内訳（ユニット・盟約・きっかけごと） */
export interface StackSource {
  uid: number;
  name: string;
  bond: AllianceId;
  amount: number;
  cause: string;
}

const STACK_CAUSE: Record<GarrisonEvent['kind'], string> = {
  useskill: 'スキル発動',
  kill: '撃破',
  ammo: '弾薬消費',
  dead: '撤退',
  freeze: '範囲内の凍結',
  sleepstun: '範囲内の睡眠・スタン',
};

function garrisonEvents(input: SimUnitInput): GarrisonEvent[] {
  const { def, star } = input;
  const rowCount = input.rowCount ?? 1;
  const out: GarrisonEvent[] = [];
  for (const g of input.garrisons ?? unitState(def, star).garrisons) {
    if (g.event !== 'IN_BATTLE' || g.effect !== 'ADD_BOND') continue;
    const bb = g.blackboard;
    const key = bb.key as string | undefined;
    const kind =
      key === 'act1autochess_gar_event_useskill'
        ? 'useskill'
        : key === 'act1autochess_gar_event_selfkillenemy'
          ? 'kill'
          : key === 'act1autochess_gar_event_consume_ammo'
            ? 'ammo'
            : key === 'act1autochess_gar_event_selfdead'
              ? 'dead'
              : key === 'act1autochess_gar_event_enemy_abflag_inrange' && Number(bb.check_ab_flag) === 16
                ? 'freeze'
                : key === 'act2autochess_gar_event_allyenemy_sleepstun_inrange'
                  ? 'sleepstun'
                  : null;
    if (!kind) continue;
    if (bb.conditionkey === 'character_same_row' && rowCount < Number(bb.check_count ?? 0)) continue;
    let count: number;
    if (bb.bond_add_type === 'by_count') count = Number(bb.bond_add_count ?? 0);
    else if (bb.bond_add_type === 'by_charcount_samerow') count = Number(bb.bond_add_count_multi ?? 0) * rowCount;
    else continue;
    const bonds =
      bb.bond_type === 'bond_by_id'
        ? String(bb.bond_id).split(',').map(bondKey)
        : bb.bond_type === 'bond_actived_maxstack'
          ? ('maxstack' as const)
          : bb.bond_type === 'bond_self'
            ? def.bonds
            : null;
    if (!bonds) continue;
    out.push({
      kind,
      bonds,
      count,
      bonus: input.bonusGain ?? 0,
      max: Number(bb.max_add_count_per_battle ?? Infinity),
      every: Number(kind === 'kill' ? (bb.check_cnt ?? 1) : (bb.consume_count ?? 1)),
      gained: 0,
      prob: Number(bb.prob ?? 1),
      acc: ACC_START,
      uid: input.uid,
      name: def.name,
    });
  }
  return out;
}

// ------------------------------------------------------------
// エンジン
// ------------------------------------------------------------

export interface SimOptions {
  dt?: number;
  globals?: BattleGlobals;
  /** 有効化中の盟約と加算数（戦闘中の加算数獲得の判定用） */
  activeAlliances?: Set<AllianceId>;
  stacks?: Partial<Record<AllianceId, number>>;
  /** リプレイ用のコマを記録する */
  record?: boolean;
  /** 敵の移動速度の倍率（ステージごとの値） */
  moveMultiplier?: number;
}

type EnemyInputSpec = Pick<EnemySpec, 'name' | 'hp' | 'def' | 'res' | 'speed' | 'blockCnt' | 'flying' | 'boss' | 'lifeReduce'> &
  Partial<Pick<EnemySpec, 'stealth' | 'unblockable' | 'hitsToKill' | 'refract' | 'hitShield' | 'defReduce' | 'revive' | 'attack' | 'element' | 'elite' | 'deathPollution' | 'liberty' | 'statusResist' | 'large' | 'lowHpGuard' | 'roam' | 'minionOf' | 'bomb' | 'projectile' | 'summon' | 'dive' | 'taunt' | 'ambush' | 'enrage' | 'throwOnce' | 'selfFear' | 'flame' | 'float' | 'stone' | 'parasite' | 'appearStrike'>>;

/**
 * 医療以外の治療・回復を持つスキル
 * - nextHeal：次の攻撃の代わりに周囲の味方1人を治療（グム）
 * - areaHeal：周囲の味方全員を治療（サリア）
 * - attackHeal：スキル中、攻撃のたびに周囲の自分以外の味方1人を治療（ブレミシャイン）
 * - zone：投げた錬金ユニットの範囲で、敵に継続術ダメージ・味方を継続回復（ブリキ・引星ソーンズ）
 * - auraHeal：スキル中、攻撃範囲内の味方全員を毎秒回復（スズラン）
 * - selfHeal：発動時に自身のHPを回復（マドロック）
 * - surtr：発動時にHPを全回復し、以降HPが徐々に減る（スルト）
 */
const SUPPORT_SKILL: Record<string, 'nextHeal' | 'areaHeal' | 'attackHeal' | 'zone' | 'auraHeal' | 'selfHeal' | 'surtr'> = {
  char_196_sunbr: 'nextHeal',
  char_202_demkni: 'areaHeal',
  char_423_blemsh: 'attackHeal',
  char_4151_tinman: 'zone',
  char_1039_thorn2: 'zone',
  char_358_lisa: 'auraHeal',
  char_311_mudrok: 'selfHeal',
  char_350_surtr: 'surtr',
};
/** 周囲の味方を治療する範囲（マス） */
const SUPPORT_HEAL_RADIUS = 1.5;

/** コスト：初期値・上限・1増えるまでの秒数（本家のステージ設定） */
const INITIAL_COST = 10;
const MAX_COST = 99;
const COST_INTERVAL = 1;
/** 行商人：配置中に一定間隔でコストを消費する */
const MERCHANT_INTERVAL = 3;
const MERCHANT_COST = 3;

/** 琳琅スワイヤーの素質（通常・精鋭） */
const SWIRE: Record<string, { maxCoins: [number, number]; maxStacks: [number, number]; atkPerStack: number; saveHp: [number, number] }> = {
  char_1033_swire2: { maxCoins: [3, 4], maxStacks: [8, 9], atkPerStack: 0.04, saveHp: [0.7, 0.8] },
};

/** 寒冷：敵の攻撃速度低下。寒冷中に再び寒冷になると凍結（動けず攻撃できず、術耐性低下） */
const COLD_ATTACK_SPEED = 30;
const FROZEN_RES_DOWN = 15;

/** 元素損傷：上限と爆発（味方：上限1000、敵：通常・エリート1000、ボス2000） */
const OP_ELEMENT_MAX = 1000;
const EN_ELEMENT_MAX = 1000;
const EN_ELEMENT_MAX_BOSS = 2000;
const OP_BURST_DURATION: Record<ElementType, number> = { neural: 10, erosion: 10, burning: 10, apoptosis: 15 };
const EN_BURST_DURATION: Record<ElementType, number> = { neural: 10, erosion: 8, burning: 10, apoptosis: 15 };
const EN_BURST_DAMAGE: Record<ElementType, number> = { neural: 6000, erosion: 5000, burning: 7000, apoptosis: 0 };
/** 行医：治療時に攻撃力のこの割合ぶん元素損傷を回復 */
const WANDER_ELEMENT_HEAL = 0.5;

/** 元素損傷に関わる素質 */
interface ElementTalent {
  /** 受ける元素損傷の減少 */
  elementResist?: number;
  /** 攻撃範囲内の味方が受ける元素損傷の減少（常時／蓄積が半分を超えている時） */
  auraElementResist?: number;
  auraElementResistHalf?: number;
  /** 壊死損傷を受けた時のSP回復 */
  spOnApoptosis?: number;
  /** 攻撃範囲内の敵に毎秒攻撃力のこの割合の壊死損傷、範囲内の敵が受ける壊死損傷の倍率 */
  auraApoptosis?: number;
  auraApoptosisTaken?: number;
  /** 敵の灼燃の爆発時：元素ダメージ（攻撃力倍率）と自身のHP回復 */
  onBurnBurst?: { scale: number; heal: number };
  /** 壊死の爆発中の敵を攻撃すると毎秒攻撃力のこの割合の元素ダメージ */
  nymphDot?: number;
  /** 範囲内で壊死が爆発するたびに攻撃力上昇 */
  atkPerApoptosisBurst?: { atk: number; max: number };
  /** ブロック中：庇護（被ダメージ減少）と、ブロック中の敵への毎秒の術ダメージ・灼燃損傷 */
  protectWhileBlocking?: number;
  blockedDot?: { arts: number; burn: number };
  /** 4人以上配置されている時、毎秒最大HPのこの割合のHPと元素損傷を回復 */
  regenWithAllies?: number;
  /** スキル中、他の味方の術ダメージに灼燃損傷を加える */
  yuSkill?: boolean;
}
const ELEMENT_TALENT: Record<string, ElementTalent> = {
  char_4148_philae: { elementResist: 0.12, spOnApoptosis: 2 },
  char_4114_harold: { auraElementResistHalf: 0.18 },
  char_1016_agoat2: { auraElementResist: 0.12 },
  char_245_cello: { auraApoptosis: 0.1, auraApoptosisTaken: 1.22 },
  char_1040_blaze2: { onBurnBurst: { scale: 3.8, heal: 0.15 } },
  char_4146_nymph: { nymphDot: 0.4, atkPerApoptosisBurst: { atk: 0.02, max: 12 } },
  char_2026_yu: { protectWhileBlocking: 0.3, blockedDot: { arts: 0.4, burn: 0.12 }, regenWithAllies: 0.02, yuSkill: true },
};
/** 元素損傷を与える即時スキル */
const ELEMENT_SKILL: Record<string, 'virtuosa' | 'nymph'> = {
  char_245_cello: 'virtuosa',
  char_4146_nymph: 'nymph',
};
/** スキルでのみ攻撃するオペレーター */
const SKILL_ONLY_ATTACK = new Set(['char_245_cello']);
/** ティッピ：スキルは攻撃を受けると自動発動し、その攻撃を回避して離陸する（離陸中は地上の敵をブロックせず狙われず、空中の敵をブロック・攻撃できる。攻撃は3連撃） */
const TIPPI = 'char_4191_tippi';
const TIPPI_HITS = 3;
/** 傀儡師：致命傷で身替りと入れ替わり、DOLL_DURATION 秒後に本体へ戻る（身替りはブロック数0・周囲8マスが攻撃範囲） */
const DOLL_DURATION = 20;
const KAZEMA = 'char_4016_kazema';
const GHOST2 = 'char_1023_ghost2';
/** カゼマルの紙人形（S2の身替り）の攻撃力はカゼマルの約1.117倍（HP・防御力は同じ。本家のトークンの能力値の比） */
const KAZEMA_TOKEN_ATK = 611 / 547;
/** 周囲8マス（x-4） */
const AROUND: [number, number][] = [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b): [number, number] => [a, b]));
/** スキル発動中のみ攻撃行動を行う（アンジェリーナS3） */
const SKILL_ACTIVE_ONLY_ATTACK = new Set(['char_291_aglina']);
/** スキル中は攻撃しなくなる（スズラン・クオーラ・キャサリン・バブル） */
const NO_ATTACK_IN_SKILL = new Set(['char_358_lisa', 'char_150_snakek', 'char_4162_cathy', 'char_381_bubble']);
/** バブル：スキル中、攻撃されるたび自身の防御力の一定割合の物理ダメージで反撃 */
const BUBBLE = 'char_381_bubble';
/** サンクタ・ミキサー（反撃）・レミュアン（ロックオン爆撃）：弾薬スキル中は通常攻撃しない */
const MIXER = 'char_4194_rmixer';
const LEMUEN = 'char_4193_lemuen';
/** レミュアンの爆撃：スキル終了から最初の着弾までの時間（データの emit_offset）、以降の着弾間隔、着弾位置のばらつき（ロック位置を中心とした一辺 0.4 の正方形）、リプレイで砲弾が落ちる時間 */
const LEMUEN_BOMB_FIRST = 0.2;
const LEMUEN_BOMB_GAP = 0.3;
const LEMUEN_BOMB_SPREAD = 0.4;
const LEMUEN_BOMB_FALL = 0.25;
/** フィラエ：スキル中は攻撃せず、攻撃を受けると周囲の地上の敵に反撃 */
const PHILAE: Record<string, { radius: number }> = { char_4148_philae: { radius: 1.5 } };
/**
 * デーゲンブレヒャー。S3「静寂に帰す」は斬撃10回（d_hit_interval ごと）＋最後の一撃のモーションで、
 * モーション中は通常攻撃せずSPも溜まらない。最初の斬撃は発動と同時、最後の一撃は10回目の d_hit_interval 後（仮）
 */
const BLKKGT = 'char_4116_blkkgt';
const BLKKGT_SLASHES = 10;

/** 狩人：最大弾数、攻撃時の攻撃力倍率、攻撃をやめてから装填が始まるまでと1発の装填時間（秒） */
const HUNTER_AMMO = 8;
/**
 * 確率で起きる効果は「確率を貯めて1に達したら発生」（期待値）で扱う。積み立ての開始値を0.5にして、
 * 発生回数を「試行回数×確率」の四捨五入にする（0から始めると切り捨てになり、短い戦闘ほど損をする）
 */
const ACC_START = 0.5;
/** 浮遊ユニット（遊撃術師）：同じ敵を連続で攻撃するたびに倍率が上がる（初期20%、1回ごとに+15%、上限110%） */
const FUNNEL = { init: 0.2, delta: 0.15, max: 1.1 };
/** 荒蕪ラップランド */
const WHITW2 = 'char_1038_whitw2';
/** ザーロ（S3の特殊形態の浮遊ユニット）の飛ぶ速さ（マス/秒。本家の値が不明なため仮） */
const ZARO_SPEED = 2;
/** <刺胄之弹>の飛ぶ速さ（マス/秒。本家の値が不明なため仮） */
const BOMB_SPEED = 1;
/** ボスの手下が突進する速さ（マス/秒。仮） */
const DIVE_SPEED = 1;
/** 撃ち落とされた手下が受けたダメージのうち、ボスにも入る割合 */
const MINION_DAMAGE_SHARE = 1;
/** 呪癒師：与ダメージのうち味方の回復に回る割合 */
const INCANTATION_HEAL = 0.5;
/** 旋輪射手：旋回投擲物の速度（マス/秒）。射出時15、回収時3.75。手元に戻るまで次の攻撃はできない */
const LOOP_OUT_SPEED = 15;
const LOOP_BACK_SPEED = 3.75;
/**
 * 旋輪射手：投擲物が戻ってから次を放つまでにかかる時間（秒）。実機の計測（1マス 6回/6秒・2マス 7回/8秒・3マス 6回/9秒）から、
 * 1回あたり max(1.0, 0.5 + 往復時間) がよく合う（1マス 1.0秒・2マス 約1.17秒・3マス 1.5秒）
 */
const LOOP_WINDUP = 0.5;
/** 単体標的モード（位置なし）での投擲物の飛距離 */
const LOOP_DEFAULT_DIST = 2;
const HUNTER_ATK_SCALE = 1.2;
const HUNTER_RELOAD_DELAY = 1;
const HUNTER_RELOAD_INTERVAL = 1;
/** スノーハンター（素質「裂雲一撃」：スキル発動時に攻撃力の180%の物理ダメージと寒冷3秒。値は素質の atk_scale・cold） */
const SNOW_HUNTER = 'char_4211_snhunt';

/** 遠距離の敵が攻撃する時に足を止める秒数 */
const RANGED_ATTACK_STALL = 0.5;

/** 素質で攻撃した敵の特殊能力を無効化する秒数（通常・精鋭） */
const TALENT_NEUTRALIZE: Record<string, [number, number]> = {
  char_140_whitew: [1, 5], // ラップランド：精神摧毀
};

/** スキルで範囲の敵の特殊能力を無効化する（ポデンコ：胞子飛散） */
const SKILL_NEUTRALIZE: Record<string, { radius: number; duration: number }> = {
  char_258_podego: { radius: 1.2, duration: 5 },
};

interface EnemyInput {
  key: string;
  spec: EnemyInputSpec;
  /** 倒れた時に生まれる敵 */
  child?: { key: string; spec: EnemyInputSpec; count: number };
  spawnAt: number;
  /** 経路（マス番号）。null なら動かない標的 */
  path: number[] | null;
  phases?: EnemyPhase[];
  /** 懸賞：倒すと得る資金 */
  bounty?: number;
}

/** 素質の戦闘中の状態 */
interface TalentState {
  deployedAt: number;
  /** 最後に攻撃を受けた・ダメージを与えた時刻 */
  lastHitAt: number;
  lastDealtAt: number;
  /** 確率の被ダメージ無効・回避の累積（期待値） */
  nullAcc: number;
  evadeAcc: number;
  /** 撃破で得た層・攻撃力・最大HP */
  killStacks: number;
  killAtk: number;
  /** 奪った攻撃力（イネスの素質）・攻撃速度（イネスS2） */
  stealAtk: number;
  stealAspd: number;
  /** サンクタ・ミキサーの層 */
  mixer: number;
  /** サンクタ・ミキサー：バリアを失ってから（または最後に攻撃してから）の経過時間 */
  barrierTimer: number;
  /** 一度だけの効果を使った */
  saveUsed: boolean;
  /** スルト：強制退場する時刻 */
  surtrUntil: number | null;
  /** マドロックのシールド */
  shields: number;
  shieldTimer: number;
  /** アルケットのシールド（1回） */
  archShield: boolean;
  /** レコードキーパーの攻撃速度上昇の終わる時刻 */
  reckUntil: number;
  /** ペペ：スキル中の撃破数 */
  pepeKills: number;
  /** 血掟テキサス：最初の撃破・スキルの再発動 */
  firstKill: boolean;
  recast: boolean;
  /** ホルン：血戦 */
  bloodBattle: boolean;
  /** 敵ごとに一度だけの効果（敵id → 最初に当てた時刻） */
  firstHit: Map<number, number>;
  /** 一定間隔の効果のタイマー */
  timer: number;
  /** 聖聆プラマニクス：自身の凍結の終わる時刻 */
  selfFrozenUntil: number;
  reedAcc: number;
  /** デーゲンブレヒャーの素質の発動の累積（期待値） */
  blkAcc: number;
}

const newTalentState = (): TalentState => ({
  deployedAt: 0,
  lastHitAt: -99,
  lastDealtAt: -99,
  nullAcc: ACC_START,
  evadeAcc: ACC_START,
  killStacks: 0,
  killAtk: 0,
  stealAtk: 0,
  stealAspd: 0,
  mixer: 0,
  barrierTimer: 0,
  saveUsed: false,
  surtrUntil: null,
  shields: 0,
  shieldTimer: 0,
  archShield: false,
  reckUntil: -1,
  pepeKills: 0,
  firstKill: false,
  recast: false,
  bloodBattle: false,
  firstHit: new Map(),
  timer: 0,
  selfFrozenUntil: -1,
  reedAcc: ACC_START,
  blkAcc: ACC_START,
});

/** 攻撃時に確率で攻撃力が上がる素質（期待値で扱う）：[1つ目/2つ目の素質, 確率のキー, 倍率のキー] */
const CRIT_TALENT: Record<string, [number, string, string]> = {
  char_145_prove: [0, 'prob', 'atk_scale'],
  char_4100_caper: [0, 'prob', 'atk_scale'],
  char_196_sunbr: [0, 'prob', 'atk_scale'],
  char_4054_malist: [0, 'prob', 'atk_scale'],
  char_1021_kroos2: [0, 'prob', 'atk_scale'],
  char_222_bpipe: [0, 'prob', 'atk_scale'],
  char_264_f12yin: [0, 'prob', 'atk_scale'],
};

interface Enemy {
  id: number;
  input: EnemyInput;
  hp: number;
  /** 現在の最大HP（復活待ちの間は攻撃回数） */
  maxHp: number;
  /** 残りの攻撃無効回数 */
  shield: number;
  /** 防御低下の回数 */
  reduceStacks: number;
  /** 特殊能力が無効になっている時刻まで */
  neutralUntil: number;
  /** 攻撃のクールダウン */
  atkTimer: number;
  /** 脆弱（被ダメージ増加）の終わる時刻 */
  vulnUntil: number;
  /** 遠距離攻撃のモーションで足を止めている時刻まで */
  stallUntil: number;
  /** 寒冷・凍結の終わる時刻 */
  coldUntil: number;
  frozenUntil: number;
  /** 元素損傷の蓄積と、爆発の終わる時刻 */
  elem: Partial<Record<ElementType, number>>;
  elemBurst: Partial<Record<ElementType, number>>;
  /** 爆発させたオペレーター（継続ダメージの帰属） */
  elemSrc: Partial<Record<ElementType, Runtime>>;
  /** 侵蝕の爆発で永久に下がった防御力 */
  erosionDef: number;
  /** ニンフの素質：壊死の爆発中に毎秒受ける元素ダメージ */
  nymphDot: { src: Runtime; dps: number } | null;
  /** 復活待ち（攻撃回数で倒せる状態）なら復活する時刻 */
  reviveAt: number | null;
  /** レミュアンの素質：指名手配（【ラテラーノ】の攻撃範囲内に滞在した時間と、手配済みか） */
  wantedTime: number;
  wanted: boolean;
  revived: boolean;
  defense: DefenseState;
  phases: EnemyPhase[];
  phaseIdx: number;
  spawned: boolean;
  alive: boolean;
  leaked: boolean;
  /** 経路上の進んだ距離（マス） */
  d: number;
  x: number;
  y: number;
  blockedBy: number | null;
  arcaneUntil: number;
  /** 素質による弱体化（バブル：攻撃力低下、焔影リード：灼痕、イネス：奪われた攻撃力） */
  bubbleUntil: number;
  reedUntil: number;
  /** イネス：奪われた攻撃力（素質）・攻撃速度（S2）。奪ったオペレーターごと */
  stolenAtk: Map<Runtime, number>;
  stolenAspd: Map<Runtime, number>;
  /** バインド（移動しない。攻撃はする） */
  rootUntil: number;
  /** 「サンクタの翼」「サンクタの眼」：HP半分以下での恐怖を使った・移動速度上昇の終わる時刻 */
  selfFeared: boolean;
  selfFearSpeedUntil: number;
  /** 素質の継続術ダメージ（攻撃者ごと） */
  dots: Map<Runtime, { until: number; dps: number }>;
  /** 睡眠：終わる時刻・眠った時刻・眠らせたオペレーター（行動せず、通常は攻撃の対象にならない） */
  sleepUntil: number;
  sleepAt: number;
  sleepBy: Runtime | null;
  /** スタン（移動・攻撃しない） */
  stunUntil: number;
  /** 恐怖（ブロックされず、攻撃せず、来た道を逃げる） */
  fearUntil: number;
  /** 戦慄（ブロックされている間は通常攻撃できない） */
  trembleUntil: number;
  /** 山海衆精鋭：ステルスが解けた後の最初の攻撃がまだ残っている */
  ambushReady: boolean;
  /** 元核のマレフィセント：臨戦状態と、次に元素損傷を与えるまでの時間 */
  enraged: boolean;
  /** バクダンバチ：爆弾を投げた後 */
  thrown: boolean;
  /** 火炎放射：SP・放射が終わる時刻（放射していなければ -1）・対象 */
  flameSp: number;
  flameUntil: number;
  flameTarget: number | null;
  flameTimer: number;
  /** 攻撃回数（汚染秽蝕の放出） */
  atkCount: number;
  /** 次の連撃が使える時刻 */
  multiAt: number;
  /** 墓守の石像：石像形態が終わる時刻（-1 なら石像ではない）・石像になったか */
  stoneUntil: number;
  stoned: boolean;
  /** 寄生の攻撃タイマー */
  parasiteTimer: number;
  enrageTimer: number;
  /** ボスの手下：飛び回る先 */
  roamTo: { x: number; y: number } | null;
  /** 【灭顶之灾】次に弾を撃つ時刻（ボス）／弾の着弾先と効果（弾） */
  bombAt: number;
  bombTo: { pos: number; stun: number; dotDps: number; dotDuration: number } | null;
  /** 【死亡集群】次に召喚する時刻 */
  summonAt: number;
  /** ボスの手下：飛び回る・突進中・ボスへ戻る・撃ち落とされた。次の突進の時刻と、突進中に受けた攻撃の回数 */
  minion: 'roam' | 'dive' | 'back' | 'down';
  diveAt: number;
  diveTo: number;
  diveHits: number;
  /** 撃ち落とされた状態から復帰する時刻 */
  downUntil: number;
  /** 囚人：拘束中か、拘束中に攻撃した回数 */
  confined: boolean;
  confAttacks: number;
}

interface Runtime {
  input: SimUnitInput;
  skill: SkillModel;
  atkTimer: number;
  sp: number;
  skillLeft: number;
  ammoLeft: number;
  ammoUsed: number;
  sargonBuffs: number[];
  pulseTimer: number;
  events: GarrisonEvent[];
  result: SimUnitResult;
  attacks: number;
  /** 攻撃した敵の特殊能力を無効化する秒数 */
  neutralize: number;
  hp: number;
  maxHp: number;
  /** 補正込みの基礎値（スキルの上昇前） */
  baseMaxHp: number;
  baseDef: number;
  def: number;
  res: number;
  alive: boolean;
  /** 戦闘開始時の配置順（左の列から、同じ列は上から）。大きいほど後に配置 */
  order: number;
  /** 堅守の反撃のクールダウン */
  reflectReadyAt: number;
  retaliateReadyAt: number;
  /** スキルを発動した時刻 */
  castAt: number;
  /** 元素損傷の蓄積と爆発の終わる時刻、爆発の影響 */
  elem: Partial<Record<ElementType, number>>;
  elemBurst: Partial<Record<ElementType, number>>;
  erosionDef: number;
  /** 素質・スキルの層（ニンフ：壊死の爆発ごとの攻撃力、フィラエ：元素損傷を受けた時の攻撃力） */
  talentStacks: number;
  philaeBoost: boolean;
  counterReadyAt: number;
  /** レミュアン：ロックオンした敵の位置と、次のロックオンまでの時間 */
  lockOns: { e: Enemy; x: number; y: number }[];
  lockTimer: number;
  /** 狩人：弾数とリロード */
  huntAmmo: number;
  /** 回避の確率の累積（期待値） */
  evadeAcc: number;
  /** 素質（blackboard）と戦闘中の状態 */
  tb: Record<string, number>[];
  ts: TalentState;
  /** 俊敏の確率の累積と、次にスキルを発動できる時刻 */
  swiftAcc: number;
  recastAt: number;
  /** 鼓舞（攻撃力の固定値加算）とその期限 */
  inspireAtk: number;
  inspireUntil: number;
  /** HP再配分までの時間（エテルナ） */
  redistTimer: number;
  /** 睡眠（ティティのスキル：致命傷を受けた味方が眠る。HPが全回復するかスキル終了まで） */
  sleepUntil: number;
  /** 血掟テキサス：次の剣雨までの時間 */
  swordTimer: number;
  /** 浮遊ユニット：連続で攻撃している敵と回数 */
  funnelTarget: Enemy | null;
  funnelStack: number;
  /** 戦闘中の攻撃力（スキル・補正込み。ザーロのダメージに使う） */
  curAtk: number;
  /** 荒蕪ラップランドS3のザーロ（位置・追っている敵・取り付いたか）と、次のダメージまでの時間 */
  zaros: { x: number; y: number; target: Enemy | null; attached: boolean }[];
  zaroTimer: number;
  /** スタン（<刺胄之弹>）と、毎秒の物理ダメージ */
  stunUntil: number;
  dotUntil: number;
  dotDps: number;
  /** 戦術【食腐の蝶】：味方が倒れるたびに得た攻撃力の層 */
  qalaisaStacks: number;
  /** 戦術【薬枚実験】：護盾（被弾1回を無効化）と確率の累積 */
  mberryShield: number;
  mberryAcc: number;
  lastAttackAt: number;
  /** 旋輪射手：投擲物が手元に戻る時刻 */
  loopBackAt: number;
  /** バリア（残量・減る速さ） */
  barrier: number;
  barrierDecay: number;
  /** 今のバリアを付与した味方（防いだ量をその味方の実績にする） */
  barrierBy: Runtime | null;
  /** 確率の寒冷付与の累積（期待値） */
  coldAcc: number;
  coldDotTimer: number;
  /** 再配置できる時刻（撤退中のみ）と再配置時間 */
  redeployAt: number | null;
  respawn: number;
  /** 行商人：コスト消費までの時間 */
  merchantTimer: number;
  /** 琳琅スワイヤー：コイン・攻撃力の層数・致命傷を耐える時のコスト */
  coins: number;
  swireStacks: number;
  swireSaveCost: number;
  bombTimer: number;
  /** シラクーザの恐怖の発生の累積（期待値） */
  fearAcc: number;
  firstEndDone: boolean;
  melee: boolean;
  /** ブロックできるマスにいるか */
  blocker: boolean;
  block: number;
  rangeNormal: Set<number> | null;
  rangeSkill: Set<number> | null;
  blocked: Enemy[];
  /** 傀儡師：身替りと入れ替わっている間（終わる時刻）。-1 なら本体 */
  dollUntil: number;
  dollTick: number;
  /** 身替りになる前のブロック数・攻撃範囲 */
  saved: { block: number; blocker: boolean; rangeNormal: Set<number> | null; rangeSkill: Set<number> | null } | null;
  /** カゼマルS2が召喚した身替り（紙人形）。結果は召喚主にまとめる */
  owner: Runtime | null;
  /** 攻撃モーションのスキル（デーゲンブレヒャーS3）：モーション全体の秒数（0ならモーションのスキルではない）、残りの斬撃数、次の斬撃までの時間 */
  motionLen: number;
  slashLeft: number;
  slashTimer: number;
  /** 【強襲】：最後に攻撃した（または配置された）時刻と、戦闘開始時の位置と向き */
  raidIdleFrom: number;
  home: { pos: number | undefined; dir: Direction | undefined };
}

interface EngineResult {
  t: number;
  enemies: Enemy[];
  units: Runtime[];
  timeline: { t: number; hp: number; alive: number }[];
  phaseLog: { t: number; note: string }[];
  stackGains: Partial<Record<AllianceId, number>>;
  stackSources: StackSource[];
  frames: ReplayFrame[];
  fx: FxEvent[];
  killTime: number | null;
  bossDefeated: boolean;
  colds: number;
  freezes: number;
  opBursts: number;
  enBursts: number;
  sargon?: { aspd: number; atkPct: number; max: number; avg: number };
  siracusa?: { aspd: number; duration: number; members: number };
}

function runEngine(units: SimUnitInput[], enemyInputs: EnemyInput[], timeLimit: number, field: boolean, opts: SimOptions): EngineResult {
  const dt = opts.dt ?? 0.05;
  const g = opts.globals ?? {};
  const active = opts.activeAlliances ?? new Set<AllianceId>();
  const stacks = opts.stacks ?? {};
  const stackGains: Partial<Record<AllianceId, number>> = {};
  const stackSources: StackSource[] = [];
  const addSource = (uid: number, name: string, bond: AllianceId, amount: number, cause: string) => {
    const x = stackSources.find((y) => y.uid === uid && y.bond === bond && y.cause === cause);
    if (x) x.amount += amount;
    else stackSources.push({ uid, name, bond, amount, cause });
  };

  const toSet = (pos: number | undefined, dir: Direction | undefined, id: string | null) =>
    pos === undefined || !id ? null : new Set(rangeCells(pos, dir ?? DEFAULT_DIRECTION, rangeGrid(id)));

  const cid = (u: Runtime) => u.input.def.charId;
  const makeRuntime = (input: SimUnitInput): Runtime => {
    const st = unitState(input.def, input.star);
    const skill0 = parseSkill(st.skill);
    // 秘技Lv2：SP消費の減少
    const skill = input.mods.spCostCut ? { ...skill0, spCost: skill0.spCost * Math.max(0, 1 - input.mods.spCostCut) } : skill0;
    const ids = unitRangeIds(input.def.id, input.star);
    const blocker = field && input.pos !== undefined && canBlockAt(input.pos) && input.def.damageType !== 'heal';
    return {
      input,
      skill,
      atkTimer: 0,
      sp: skill.initSp + (input.mods.startSp ?? 0),
      skillLeft: 0,
      ammoLeft: 0,
      ammoUsed: 0,
      sargonBuffs: [],
      pulseTimer: g.kazimierzPulse?.interval ?? 0,
      attacks: 0,
      fearAcc: ACC_START,
      neutralize: Math.max(input.mods.neutralize ?? 0, TALENT_NEUTRALIZE[input.def.charId]?.[input.star - 1] ?? 0),
      hp: st.stats.hp * (1 + (input.mods.hpPct ?? 0)),
      maxHp: st.stats.hp * (1 + (input.mods.hpPct ?? 0)),
      baseMaxHp: st.stats.hp * (1 + (input.mods.hpPct ?? 0)),
      baseDef: st.stats.def * (1 + (input.mods.defPct ?? 0)) + (input.mods.defFlat ?? 0),
      def: st.stats.def * (1 + (input.mods.defPct ?? 0)) + (input.mods.defFlat ?? 0),
      res: Math.min(95, st.stats.res + (input.mods.resFlat ?? 0)),
      alive: true,
      order: 0,
      reflectReadyAt: 0,
      retaliateReadyAt: 0,
      castAt: -1,
      elem: {},
      elemBurst: {},
      erosionDef: 0,
      talentStacks: 0,
      philaeBoost: false,
      counterReadyAt: 0,
      lockOns: [],
      lockTimer: 0,
      motionLen: 0,
      slashLeft: 0,
      slashTimer: 0,
      raidIdleFrom: 0,
      home: { pos: input.pos, dir: input.dir },
      huntAmmo: HUNTER_AMMO,
      qalaisaStacks: 0,
      evadeAcc: ACC_START,
      tb: [talentBB(input.def, input.star, 0), talentBB(input.def, input.star, 1)],
      ts: newTalentState(),
      swiftAcc: ACC_START,
      recastAt: -1,
      inspireAtk: 0,
      inspireUntil: -1,
      redistTimer: 0,
      sleepUntil: -1,
      swordTimer: 0,
      funnelTarget: null,
      funnelStack: 0,
      curAtk: 0,
      zaros: [],
      zaroTimer: 0,
      stunUntil: -1,
      dotUntil: -1,
      dotDps: 0,
      mberryShield: 0,
      mberryAcc: ACC_START,
      lastAttackAt: -99,
      loopBackAt: -1,
      barrier: 0,
      barrierDecay: 0,
      barrierBy: null,
      coldAcc: ACC_START,
      coldDotTimer: 1,
      redeployAt: null,
      respawn: Math.max(1, st.stats.respawn * Math.max(0.1, 1 + (input.mods.respawnPct ?? 0)) + (input.mods.respawnFlat ?? 0)),
      merchantTimer: 0,
      // 琳琅スワイヤー（大買家）：スキル（常時）開始時にコイン1枚
      coins: SWIRE[input.def.charId] ? 1 : 0,
      swireStacks: 0,
      swireSaveCost: 5,
      bombTimer: 0,
      firstEndDone: false,
      events: garrisonEvents(input),
      result: { uid: input.uid, defId: input.def.id, name: input.def.name, star: input.star, damage: 0, hits: 0, skillCasts: 0, kills: 0, taken: 0, healed: 0, barrier: 0, byKind: { physical: 0, arts: 0, true: 0, element: 0 }, downAt: null, retreats: 0, redeploys: 0 },
      melee: input.def.position === 'melee',
      blocker,
      block: blocker ? st.stats.block : 0,
      rangeNormal: field ? toSet(input.pos, input.dir, ids.range) : null,
      rangeSkill: field ? toSet(input.pos, input.dir, ids.skillRange ?? ids.range) : null,
      blocked: [],
      dollUntil: -1,
      dollTick: 0,
      saved: null,
      owner: null,
    };
  };
  const rt: Runtime[] = units.map(makeRuntime);

  // 戦闘開始時の配置順：絶対方角で左の列から、同じ列は上から
  [...rt]
    .filter((u) => u.input.pos !== undefined)
    .sort((a, b) => cellX(a.input.pos!) - cellX(b.input.pos!) || cellY(a.input.pos!) - cellY(b.input.pos!))
    .forEach((u, i) => (u.order = i + 1));

  // 常時発動のスキルの最大HP上昇
  for (const u of rt) {
    if (u.skill.passive && u.skill.hpPct) {
      u.maxHp = u.baseMaxHp * (1 + u.skill.hpPct);
      u.hp = u.maxHp;
    }
  }

  const baseRes = (s: EnemyInputSpec) => Math.min(100, s.res + (s.refract ?? 0));

  // ---- 特殊能力無効化：屈折・ステルス・盾・復活・分裂を一時的に失う ----
  const neutral = (e: Enemy) => t < e.neutralUntil;
  /** 屈折込みの現在の術耐性 */
  const currentRes = (e: Enemy) => {
    const s = e.input.spec;
    const dr = s.defReduce ? s.defReduce.res * e.reduceStacks : 0;
    const lib = s.liberty && !e.confined ? s.liberty.res : 0;
    return Math.max(0, (neutral(e) ? s.res : baseRes(s)) + dr + lib - (t < e.frozenUntil ? FROZEN_RES_DOWN : 0) - (t < (e.elemBurst.burning ?? -1) ? 20 : 0));
  };
  const neutralize = (e: Enemy, seconds: number) => {
    if (seconds <= 0 || !e.alive) return;
    e.neutralUntil = Math.max(e.neutralUntil, t + seconds);
    e.defense.res = currentRes(e);
  };
  const isStealthed = (e: Enemy) => !!e.input.spec.stealth && e.blockedBy === null && e.reviveAt === null && !neutral(e) && !revealed(e);

  /** スキルによる防御力・術耐性低下を反映した敵の防御 */
  /** 範囲に敵が入っているか（大型のボスは占めるマスのどれかが入っていればよい） */
  const covers = (range: Set<number> | null | undefined, e: Enemy) =>
    !!range && (e.input.spec.large ? BOSS_CELLS.some((c) => range.has(c)) : range.has(enemyTile(e)));
  const effDefense = (e: Enemy): DefenseState => {
    let dDef = 0;
    let dRes = 0;
    for (const u of rt) {
      const s = u.skill;
      if (!u.alive || (!s.enemyDef && !s.enemyRes) || !(u.skillLeft > 0 || u.ammoLeft > 0) || !covers(u.rangeSkill, e)) continue;
      dDef = Math.min(dDef, s.enemyDef);
      dRes = Math.min(dRes, s.enemyRes);
    }
    if (!dDef && !dRes) return e.defense;
    return { ...e.defense, def: e.defense.def * (1 + dDef), res: e.defense.res * (1 + dRes) };
  };

  // ---- 寒冷・凍結 ----
  const isFrozen = (e: Enemy) => t < e.frozenUntil;

  // ---- 睡眠（ティティ） ----
  const asleep = (e: Enemy) => t < e.sleepUntil;
  const TITI = 'char_4056_titi';
  const titiOn = (u: Runtime) => cid(u) === TITI && u.alive && u.skillLeft > 0 && u.skillLeft < 9000;
  /** 範囲内で敵・味方が睡眠・スタン状態になった（ティティの堅守特性） */
  const onSleepStun = (where: number | Enemy) => {
    for (const u of rt) {
      if (!u.alive || !(typeof where === 'number' ? !!u.rangeNormal?.has(where) : covers(u.rangeNormal, where))) continue;
      for (const ev of u.events) if (ev.kind === 'sleepstun') gainStacks(ev);
    }
  };
  const sleepEnemy = (e: Enemy, seconds: number, src: Runtime) => {
    if (!e.alive || asleep(e) || e.reviveAt !== null || seconds <= 0) return;
    e.sleepAt = t;
    e.sleepUntil = t + seconds;
    e.sleepBy = src;
    if (field) onSleepStun(e);
  };
  /** 睡眠から目覚めた・睡眠中に倒された：スキル中なら睡眠時間に応じた術ダメージと、周囲の別の敵1体を睡眠 */
  const sleepBurst = (e: Enemy) => {
    const src = e.sleepBy;
    e.sleepBy = null;
    if (!src || !titiOn(src)) return;
    const bb = src.skill.bb;
    const dur = bb.sleep ?? 5;
    const ratio = Math.min(1, Math.max(0, (t - e.sleepAt) / dur));
    const scale = (bb.min_atk_scale ?? 1) + ((bb.max_atk_scale ?? 1) - (bb.min_atk_scale ?? 1)) * ratio;
    const atk = baseAtk(src.input.def, src.input.star, src.input.mods, src.skill.atkPct);
    if (e.alive) deal(src, e, hitDamage(atk * scale, 'arts', effDefense(e), src.input.mods), 'arts');
    const r = bb.range_radius ?? 1.5;
    const next = enemies.find((o) => o !== e && o.alive && o.spawned && !asleep(o) && Math.hypot(o.x - e.x, o.y - e.y) <= r);
    if (next) sleepEnemy(next, dur, src);
  };
  const tickSleep = () => {
    for (const e of enemies) {
      if (e.sleepUntil < 0 || !e.alive) continue;
      if (t >= e.sleepUntil) {
        e.sleepUntil = -1;
        sleepBurst(e);
        continue;
      }
      // ティティの素質：場にいる間、睡眠中の敵は毎秒攻撃力の30%の術ダメージ
      for (const u of rt) {
        if (cid(u) !== TITI || !u.alive || !u.tb[0].damage_atk_scale) continue;
        deal(u, e, hitDamage(baseAtk(u.input.def, u.input.star, u.input.mods) * u.tb[0].damage_atk_scale * dt, 'arts', effDefense(e), u.input.mods), 'arts');
      }
    }
    for (const u of rt) {
      // 眠った味方：HPが全回復するかスキル終了で目覚める
      if (u.sleepUntil >= 0 && (t >= u.sleepUntil || u.hp >= u.maxHp - 1e-6 || !u.alive)) u.sleepUntil = -1;
    }
  };
  const isChilled = (e: Enemy) => t < e.coldUntil || isFrozen(e);
  /** 確率の効果（期待値で、累積が1に達するたびに発生） */
  const chance = (u: Runtime, prob: number, f: () => void) => {
    if (prob >= 1) return f();
    u.coldAcc += prob;
    if (u.coldAcc >= 1) {
      u.coldAcc -= 1;
      f();
    }
  };
  /** 凍結した時：範囲内の敵の凍結で加算数を得る特性 */
  const onFreeze = (e: Enemy) => {
    for (const u of rt) {
      if (!u.alive || !covers(u.rangeNormal, e)) continue;
      for (const ev of u.events) {
        if (ev.kind !== 'freeze') continue;
        ev.acc += ev.prob;
        while (ev.acc >= 1) {
          ev.acc -= 1;
          gainStacks(ev);
        }
      }
    }
  };
  const applyCold = (e: Enemy, seconds: number) => {
    // 抵抗：異常状態の時間が短くなる
    seconds *= 1 - (e.input.spec.statusResist ?? 0);
    if (!e.alive || seconds <= 0 || isFrozen(e)) return;
    if (t < e.coldUntil) {
      // 寒冷中に再び寒冷になると凍結。凍結時間は、残っていた寒冷と今回の寒冷の長い方
      const remaining = e.coldUntil - t;
      e.coldUntil = -1;
      e.frozenUntil = t + Math.max(remaining, seconds);
      e.defense.res = currentRes(e);
      freezes++;
      onFreeze(e);
      return;
    }
    e.coldUntil = t + seconds;
    colds++;
  };
  let stormTimer = g.kjerag?.storm?.interval ?? 0;
  let freezes = 0;
  let opBursts = 0;
  let enBursts = 0;
  let colds = 0;
  /** イェラグLv2の寒風と、イェラガンドの涙の継続ダメージ */
  const tickCold = () => {
    const storm = g.kjerag?.storm;
    if (storm) {
      stormTimer -= dt;
      if (stormTimer <= 0) {
        stormTimer += storm.interval;
        for (const e of enemies) if (e.alive && e.spawned) applyCold(e, storm.duration);
      }
    }
    for (const u of rt) {
      const dot = u.input.mods.coldDot;
      if (!dot || !u.alive) continue;
      u.coldDotTimer -= dt;
      if (u.coldDotTimer > 0) continue;
      u.coldDotTimer += 1;
      const atk = baseAtk(u.input.def, u.input.star, u.input.mods);
      for (const e of enemies) {
        if (!e.alive || !isChilled(e) || !covers(u.rangeNormal, e)) continue;
        deal(u, e, hitDamage(atk * dot, 'arts', effDefense(e), u.input.mods, artsVuln(e)), 'arts');
      }
    }
  };
  const newEnemy = (input: EnemyInput, id: number): Enemy => ({
      id,
      input,
      hp: input.spec.hp,
      maxHp: input.spec.hp,
      shield: input.spec.hitShield ?? 0,
      reduceStacks: 0,
      reviveAt: null,
      wantedTime: 0,
      wanted: false,
      revived: false,
      neutralUntil: -1,
      atkTimer: 0,
      vulnUntil: -1,
      stallUntil: -1,
      coldUntil: -1,
      frozenUntil: -1,
      elem: {},
      elemBurst: {},
      elemSrc: {},
      erosionDef: 0,
      nymphDot: null,
      defense: { def: input.spec.def + (input.spec.liberty?.confDef ?? 0), res: baseRes(input.spec), damageTaken: 1 },
      phases: [...(input.phases ?? [])].sort((a, b) => b.belowHpRatio - a.belowHpRatio),
      phaseIdx: 0,
      spawned: false,
      alive: false,
      leaked: false,
      d: 0,
      x: input.path ? cellX(input.path[0]) : 0,
      y: input.path ? cellY(input.path[0]) : 0,
      blockedBy: null,
      arcaneUntil: -1,
      bubbleUntil: -1,
      reedUntil: -1,
      stolenAtk: new Map(),
      stolenAspd: new Map(),
      rootUntil: -1,
      selfFeared: false,
      selfFearSpeedUntil: -1,
      dots: new Map(),
      confined: !!input.spec.liberty,
      confAttacks: 0,
      sleepUntil: -1,
      sleepAt: -1,
      sleepBy: null,
      roamTo: null,
      stunUntil: -1,
      fearUntil: -1,
      trembleUntil: -1,
      ambushReady: true,
      enraged: false,
      thrown: false,
      flameSp: input.spec.flame?.init ?? 0,
      flameUntil: -1,
      flameTarget: null,
      flameTimer: 0,
      atkCount: 0,
      multiAt: input.spawnAt + (input.spec.attack?.multi?.init ?? 0),
      stoneUntil: -1,
      stoned: false,
      parasiteTimer: 0,
      enrageTimer: 0,
      bombAt: input.spec.bomb ? input.spawnAt + input.spec.bomb.init : -1,
      bombTo: null,
      summonAt: input.spec.summon ? input.spawnAt + input.spec.summon.init : -1,
      minion: 'roam',
      diveAt: input.spec.dive ? input.spawnAt + input.spec.dive.init : -1,
      diveTo: -1,
      diveHits: 0,
      downUntil: 0,
    });
  /** シミュレーター内の決定的な乱数（ボスの攻撃対象・手下の移動先） */
  let seed = 0x2545f491;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
  const enemies: Enemy[] = enemyInputs.map((input, i) => newEnemy(input, i + 1)).sort((a, b) => a.input.spawnAt - b.input.spawnAt);

  const gainStacks = (ev: GarrisonEvent, times = 1, cause = STACK_CAUSE[ev.kind]) => {
    const amount = Math.min(ev.count * times, ev.max - ev.gained);
    if (amount <= 0) return;
    const targets: AllianceId[] =
      ev.bonds === 'maxstack'
        ? [...active].filter((b) => !ALLIANCES[b]?.noStack).sort((a, b) => (stacks[b] ?? 0) - (stacks[a] ?? 0)).slice(0, 1)
        : ev.bonds.filter((b) => active.has(b) && !ALLIANCES[b]?.noStack);
    if (targets.length === 0) return;
    ev.gained += amount;
    const bonus = ev.bonus * times;
    for (const b of targets) {
      stackGains[b] = (stackGains[b] ?? 0) + amount + bonus;
      addSource(ev.uid, ev.name, b, amount, cause);
      if (bonus > 0) addSource(ev.uid, ev.name, b, bonus, `${cause}（シヴィライト・エテルナの追加）`);
    }
  };

  const phaseLog: EngineResult['phaseLog'] = [];
  const timeline: EngineResult['timeline'] = [];
  const frames: ReplayFrame[] = [];
  const fx: FxEvent[] = [];
  const fxLast = new Map<string, number>();
  let t = 0;
  /** 演出を記録する（key が同じものは gap 秒以内なら間引く） */
  const emit = (ev: number[], key?: string, gap = 0) => {
    if (!opts.record) return;
    if (key) {
      const last = fxLast.get(key);
      if (last !== undefined && t - last < gap - 1e-9) return;
      fxLast.set(key, t);
    }
    fx.push([Math.round(t * 100), ...ev]);
  };
  const DMG_CODE: Record<string, number> = { physical: 0, arts: 1, true: 2 };
  let lateranoAmmo = 0;
  const bombs: { at: number; u: Runtime; e: Enemy; x: number; y: number; atk: number }[] = [];
  /** 敵の砲撃（帝国砲撃誘導機）：ロックオンした位置に着弾する時刻 */
  const shells: { at: number; e: Enemy; x: number; y: number; atk: number; arts: boolean; radius: number }[] = [];
  let killTime: number | null = null;
  const byUid = new Map(rt.map((u) => [u.input.uid, u]));

  /** 大型のボス（冑）がいて、すべて倒された（ボス戦はその時点で終了） */
  const bossDefeated = () => {
    const big = enemies.filter((e) => e.input.spec.large);
    return big.length > 0 && big.every((e) => e.spawned && !e.alive && !e.leaked);
  };
  const remainingHp = () => enemies.reduce((sum, e) => sum + (e.leaked ? 0 : e.alive || !e.spawned ? e.hp : 0), 0);
  const aliveCount = () => enemies.filter((e) => e.alive).length;

  const release = (e: Enemy) => {
    if (e.blockedBy !== null) {
      const b = byUid.get(e.blockedBy);
      if (b) b.blocked = b.blocked.filter((x) => x !== e);
      e.blockedBy = null;
    }
  };

  /** 恐怖：ブロック不可となり、付与者と逆方向（来た道）へ逃げる。逃げている間は攻撃しない */
  const fearEnemy = (e: Enemy, seconds: number) => {
    if (!e.alive || seconds <= 0 || e.input.spec.large || e.input.spec.boss) return;
    e.fearUntil = Math.max(e.fearUntil, t + seconds * (1 - (e.input.spec.statusResist ?? 0)));
    release(e);
  };
  /** バインド：移動できない（攻撃はする） */
  const rootEnemy = (e: Enemy, seconds: number) => {
    if (!e.alive || seconds <= 0) return;
    e.rootUntil = Math.max(e.rootUntil, t + seconds * (1 - (e.input.spec.statusResist ?? 0)));
  };
  /** 「サンクタの翼」「サンクタの眼」：HPが初めて一定割合以下になると恐怖になり、しばらく移動速度が上がる */
  const checkSelfFear = (e: Enemy) => {
    const sf = e.input.spec.selfFear;
    if (!sf || e.selfFeared || !e.alive || e.hp <= 1e-6 || e.hp / e.maxHp > sf.ratio) return;
    e.selfFeared = true;
    fearEnemy(e, sf.fear);
    e.selfFearSpeedUntil = t + sf.speedDuration;
  };
  /** 戦慄：ブロックされている間は通常攻撃できない */
  const trembleEnemy = (e: Enemy, seconds: number) => {
    if (!e.alive || seconds <= 0) return;
    e.trembleUntil = Math.max(e.trembleUntil, t + seconds * (1 - (e.input.spec.statusResist ?? 0)));
  };

  const killEnemy = (e: Enemy, by: Runtime | null) => {
    release(e);
    // <刺胄之弹>を撃ち落とした：撃破には数えない
    if (e.input.spec.projectile) {
      e.alive = false;
      return;
    }
    // 復活する敵：攻撃回数で倒せる状態になってその場に留まる
    const rv = e.input.spec.revive;
    if (rv && !e.revived && e.reviveAt === null && !neutral(e)) {
      e.reviveAt = t + rv.interval;
      e.hp = rv.hits;
      e.maxHp = rv.hits;
      return;
    }
    // 墓守の石像：一度目に倒れると石像形態（HPは最大値、防御力・術耐性が上がり、動かず攻撃しない）
    const sn = e.input.spec.stone;
    if (sn && !e.stoned && !neutral(e)) {
      e.stoned = true;
      e.stoneUntil = t + sn.duration;
      e.hp = e.maxHp;
      e.defense.def += sn.def;
      e.defense.res = Math.min(100, e.defense.res + sn.res);
      return;
    }
    e.stoneUntil = -1;
    e.alive = false;
    e.reviveAt = null;
    // ボスが倒れると手下も消える
    if (e.input.spec.boss) for (const m of enemies) if (m.alive && m.input.spec.minionOf === e.input.key) m.alive = false;
    if (asleep(e)) {
      e.sleepUntil = -1;
      sleepBurst(e);
    }
    // 枯朽サルカズ戦士：倒れると汚染秽蝕を残す
    const dp = e.input.spec.deathPollution;
    if (dp && field && !neutral(e)) {
      pollutions.push({ x: e.x, y: e.y, until: t + dp.duration, ...dp });
      emit([6, e.id, Math.round(e.x * 100), Math.round(e.y * 100), Math.round(dp.radius * 100), Math.round(dp.duration * 10)]);
    }
    // 倒れると別の敵が生まれる
    const c = e.input.child;
    if (c && e.input.path && !neutral(e)) {
      for (let i = 0; i < c.count; i++) {
        const ne = newEnemy({ key: c.key, spec: c.spec, spawnAt: t, path: e.input.path }, enemies.length + 1);
        ne.spawned = true;
        ne.alive = true;
        ne.d = e.d;
        ne.x = e.x;
        ne.y = e.y;
        enemies.push(ne);
      }
    }
    // マスの効果（深水区・活性源石）で倒れた時は撃破者がいない
    if (!by) return;
    by.result.kills++;
    talentOnKill(e, by);
    // 突撃兵：敵を倒すとコスト+1
    if (field && by.input.def.subProfession === 'charger') cost = Math.min(MAX_COST, cost + 1);
    for (const ev of by.events) if (ev.kind === 'kill' && by.result.kills % ev.every === 0) gainStacks(ev);
  };

  /** 攻撃回数で倒す状態か */
  const countsHits = (e: Enemy) => !!e.input.spec.hitsToKill || e.reviveAt !== null;

  const deal = (u: Runtime, e: Enemy, amount: number, kind: DmgKind) => {
    if (!e.alive || amount <= 0) return;
    // 元核のマレフィセント：攻撃を受けると臨戦状態
    if (e.input.spec.enrage && !e.enraged) e.enraged = true;
    // ボスの手下は無敵（突進中・撃ち落とされた後を除く）
    if (e.input.spec.roam) {
      if (e.minion === 'roam' || e.minion === 'back') return;
      if (e.minion === 'dive') {
        // 突進中：一定回数攻撃されると撃ち落とされる
        if (++e.diveHits >= (e.input.spec.dive?.hits ?? Infinity)) {
          e.minion = 'down';
          e.downUntil = t + (e.input.spec.dive?.downTime ?? Infinity);
        }
      } else {
        // 撃ち落とされた後：受けるダメージ増加、受けたダメージの一部がボスにも入る
        amount *= e.input.spec.dive?.dmgScale ?? 1;
        const boss = enemies.find((b) => b.alive && b.input.key === e.input.spec.minionOf);
        if (boss) deal(u, boss, amount * MINION_DAMAGE_SHARE, kind);
      }
    }
    // 仮想敵：冑：HPが一定割合を下回ると受けるダメージ減少
    const guard = e.input.spec.lowHpGuard;
    if (guard && e.hp / e.input.spec.hp < guard.ratio) amount *= guard.scale;
    // レミュアンの素質：指名手配中の敵は味方【ラテラーノ】から受けるダメージが増える
    if (e.wanted && u.input.def.bonds.includes('laterano')) {
      const lem = rt.find((o) => o.alive && cid(o) === LEMUEN);
      if (lem) amount *= lem.tb[0].damage_scale ?? 1;
    }
    const applied = Math.min(countsHits(e) ? 1 : amount, e.hp);
    e.hp -= applied;
    u.result.damage += applied;
    u.result.byKind[kind] += applied;
    while (e.phaseIdx < e.phases.length && e.hp / e.input.spec.hp <= e.phases[e.phaseIdx].belowHpRatio) {
      const p = e.phases[e.phaseIdx];
      if (p.def !== undefined) e.defense.def = p.def;
      if (p.res !== undefined) e.defense.res = p.res;
      if (p.damageTaken !== undefined) e.defense.damageTaken = p.damageTaken;
      phaseLog.push({ t, note: p.note });
      e.phaseIdx++;
    }
    checkSelfFear(e);
    if (e.hp <= 1e-6) killEnemy(e, u);
  };

  const artsVuln = (e: Enemy) => {
    if (!g.arcane || t > e.arcaneUntil) return 0;
    return g.arcane.vulnLow > 0 && e.hp / e.input.spec.hp < g.arcane.lowRatio ? g.arcane.vulnLow : g.arcane.vuln;
  };

  /** 1ヒット（倍率 scale）を与える */
  const strike = (u: Runtime, e: Enemy, atk: number, scale: number) => {
    const { def, mods, uid } = u.input;
    if (!e.alive) return;
    emit([0, uid, e.id, DMG_CODE[def.damageType] ?? 0], `h${uid}:${e.id}`, 0.01);
    let siraProc = false;
    // 攻撃を無効にする盾
    if (def.damageType !== 'heal') {
      if (u.neutralize) neutralize(e, u.neutralize);
      if (g.siracusa?.members.has(uid) && t - u.ts.deployedAt < g.siracusa.procWindow && g.siracusa.procProb > 0) {
        // シラクーザLv2：確率で確定ダメージと恐怖（期待値で、累積が1に達するたびに発生）
        u.fearAcc += g.siracusa.procProb;
        if (u.fearAcc >= 1) {
          u.fearAcc -= 1;
          siraProc = true;
          fearEnemy(e, g.siracusa.fear);
        }
      }
    }
    if (e.shield > 0 && def.damageType !== 'heal' && !neutral(e)) {
      e.shield--;
      return;
    }
    if (countsHits(e)) {
      if (def.damageType !== 'heal') deal(u, e, 1, kindOf(def.damageType));
      return;
    }
    const skillOn = u.skillLeft > 0 || u.ammoLeft > 0;
    let hitMods = mods;
    let tremble = 0;
    if (cid(u) === BLKKGT && def.damageType !== 'heal') {
      // デーゲンブレヒャーの素質：ダメージを与えた際に確率（S3のモーション中は100%）で攻撃力160%・5秒の戦慄。
      // 戦慄状態の敵には防御力25%無視（この一撃で付く戦慄は、次のダメージから）
      const [b0, b1] = u.tb;
      if (t < e.trembleUntil && b1.def_penetrate) hitMods = { ...mods, defIgnorePct: (mods.defIgnorePct ?? 0) + b1.def_penetrate };
      let proc = skillOn && u.motionLen > 0;
      if (!proc) {
        u.ts.blkAcc += b0.prob ?? 0;
        if (u.ts.blkAcc >= 1) {
          u.ts.blkAcc -= 1;
          proc = true;
        }
      }
      if (proc) {
        scale *= b0.atk_scale ?? 1;
        tremble = b0.not_combat ?? 0;
      }
    }
    const raw = atk * scale;
    const defense = effDefense(e);
    const type = u.skill.artsAttack && skillOn && def.damageType !== 'heal' ? 'arts' : bestType(def.damageType, raw, defense, hitMods);
    // イェラグ：所属者の与ダメージ上昇（寒冷・凍結した敵にはさらに上昇）
    const kj = g.kjerag?.members.has(uid) ? (isChilled(e) ? g.kjerag.ex : g.kjerag.base) : 1;
    const dmg = hitDamage(raw, type, defense, hitMods, type === 'arts' ? artsVuln(e) : 0) * flagFactor(mods, t) * kj * talentDamageMult(u, e, type);
    deal(u, e, dmg, kindOf(type));
    if (tremble > 0 && dmg > 0) trembleEnemy(e, tremble);
    if (dmg > 0 && type !== 'heal') talentOnDealt(u, e, atk);
    if (type !== 'heal' && mods.lifeOnHit) healUnit(u, u, u.maxHp * mods.lifeOnHit);
    if (type !== 'heal') {
      if (mods.trueDmgPct) deal(u, e, atk * mods.trueDmgPct * e.defense.damageTaken, 'true');
      if (siraProc && g.siracusa) {
        const before = u.result.damage;
        deal(u, e, g.siracusa.procDmg * e.defense.damageTaken, 'true');
        u.result.siracusaDamage = (u.result.siracusaDamage ?? 0) + (u.result.damage - before);
      }
      if (type === 'arts' && g.arcane?.members.has(uid) && dmg > 0) e.arcaneUntil = t + g.arcane.duration;
      // 元素損傷：ヴィクトリアの鉄鎚・灼熱（術ダメージの一部を灼燃損傷に）
      if (type === 'arts' && mods.burnOnArts && dmg > 0) addEnElement(e, 'burning', dmg * mods.burnOnArts, u);
      // ユーのスキル中：他の味方の術ダメージにユーの攻撃力の一部の灼燃損傷が加わる
      if (type === 'arts' && dmg > 0) {
        for (const y of rt) {
          if (y === u || !y.alive || y.skillLeft <= 0 || !ELEMENT_TALENT[y.input.def.charId]?.yuSkill) continue;
          addEnElement(e, 'burning', baseAtk(y.input.def, y.input.star, y.input.mods) * (y.skill.bb.ep_damage_ratio ?? 0), y);
        }
      }
      // 熾炎ブレイズのスキル中：灼燃の爆発中の敵に追加で元素ダメージ
      if (skillOn && ELEMENT_TALENT[def.charId]?.onBurnBurst && enBursting(e, 'burning')) deal(u, e, atk * (u.skill.bb['attack@atk_scale'] ?? 0), 'element');
      // ニンフの素質：壊死の爆発中の敵を攻撃すると、爆発が終わるまで毎秒元素ダメージ
      const nymphTal = ELEMENT_TALENT[def.charId]?.nymphDot;
      if (nymphTal && enBursting(e, 'apoptosis')) e.nymphDot = { src: u, dps: atk * nymphTal };
      // 寒冷の付与（スキル中の攻撃・装備）
      if (skillOn && u.skill.cold > 0) chance(u, u.skill.coldProb, () => applyCold(e, u.skill.cold));
      if (mods.coldProb && mods.coldDur) chance(u, mods.coldProb, () => applyCold(e, mods.coldDur!));
      // 攻撃を受けるたびに防御・術耐性が下がる
      const dr = e.input.spec.defReduce;
      if (dr && e.reduceStacks < dr.max) {
        e.reduceStacks++;
        e.defense.def = Math.max(0, e.input.spec.def + dr.def * e.reduceStacks - e.erosionDef);
        e.defense.res = currentRes(e);
      }
    }
  };

  const enemyTile = (e: Enemy) => cellPos(Math.round(e.x), Math.round(e.y));
  /** 飛行中か（撃ち落とされたボスの手下は地上扱い） */
  const isFlying = (e: Enemy) => !!e.input.spec.flying && e.minion !== 'down';
  const remaining = (e: Enemy) => {
    const sp = e.input.spec;
    // 経路を持たない敵（飛び回る手下・弾）は、同じ挑発レベルどうしの比較用に防衛地点までの直線距離
    if (sp.roam || sp.projectile) return Math.hypot(e.x - cellX(GOAL), e.y - cellY(GOAL));
    return e.input.path ? e.input.path.length - 1 - e.d : 0;
  };

  /** 飛行（浮遊）の敵を攻撃できるか：遠距離・離陸中・領主／偵察兵（特性の遠距離攻撃）・対空のスキル中 */
  const hitsAir = (u: Runtime, skillActive: boolean) =>
    !u.melee || lifted(u) || RANGED_TRAIT_SUBPROF.has(u.input.def.subProfession) || (skillActive && SKILL_ANTI_AIR.has(cid(u)));
  /** 領主の遠距離攻撃（自身がブロックしていない敵）の攻撃力の倍率 */
  const lordScale = (u: Runtime, e: Enemy, skillOn: boolean) =>
    u.input.def.subProfession === 'lord' && field && e.blockedBy !== u.input.uid && !(skillOn && LORD_FULL_ATK_SKILL.has(cid(u))) ? LORD_RANGED_SCALE : 1;

  /** 攻撃範囲内で狙える敵（優先順） */
  const targetsInRange = (u: Runtime, skillActive: boolean): Enemy[] => {
    const range = skillActive ? u.rangeSkill : u.rangeNormal;
    const list = enemies.filter((e) => {
      if (!e.alive) return false;
      if (!field) return true;
      if ((isFlying(e) || e.input.spec.float) && !hitsAir(u, skillActive)) return false;
      // ステルス：ブロックされている間だけ狙える（復活待ち・特殊能力無効化中は狙える）
      if (isStealthed(e)) return false;
      // ボスの手下は無敵（攻撃の対象にならない。突進中・撃ち落とされた後は狙える）
      if (e.input.spec.roam && (e.minion === 'roam' || e.minion === 'back')) return false;
      // 睡眠中の敵は狙えない（ティティの素質は例外）
      if (asleep(e) && cid(u) !== TITI) return false;
      // 近距離は、範囲外でもブロックしている敵を攻撃できる
      if (u.melee && e.blockedBy === u.input.uid) return true;
      // レミュアン：攻撃範囲外にいる指名手配中の敵も狙える
      if (e.wanted && cid(u) === LEMUEN) return true;
      return covers(range, e);
    });
    // ブロック中の敵を最優先、次に挑発レベルの高い敵、次に防衛地点までの経路が短い敵
    return list.sort(
      (a, b) =>
        Number(b.blockedBy === u.input.uid) - Number(a.blockedBy === u.input.uid) ||
        (b.input.spec.taunt ?? 0) - (a.input.spec.taunt ?? 0) ||
        remaining(a) - remaining(b),
    );
  };

  /** 1回の攻撃で狙う敵と倍率 */
  const pickTargets = (u: Runtime, skillActive: boolean): [Enemy, number][] => {
    const cands = targetsInRange(u, skillActive);
    if (!cands.length) return [];
    const sub = u.input.def.subProfession;
    // プラマニクスの素質「ハーモニー」：攻撃対象数+1
    const talentTargets = cid(u) === 'char_174_slbell' ? (u.tb[1]['attack@max_target'] ?? 1) : 1;
    const n = Math.max(skillActive && u.skill.maxTarget > 1 ? u.skill.maxTarget : 1, talentTargets);
    if (ALL_IN_RANGE_SUB.has(sub) || (sub === 'phalanx' && skillActive)) return cands.map((e) => [e, 1]);
    if (sub === 'centurion' && u.blocked.length) return u.blocked.map((e) => [e, 1]);
    // 鎌：攻撃範囲内の敵全員を攻撃（群体ダメージ）
    if (sub === 'reaper') return cands.map((e) => [e, 1]);
    if (sub === 'chain') {
      // 連鎖術師：最初の対象から近くの敵へ跳躍（跳躍ごとに15%減衰。レイズのスキル中は減衰なし）
      const maxT = Math.max(n, unitState(u.input.def, u.input.star).evolvePhase >= 2 ? 4 : 3);
      const noDecay = skillActive && u.skill.noChainDecay;
      const chain: Enemy[] = [cands[0]];
      while (chain.length < maxT) {
        const last = chain[chain.length - 1];
        const next = enemies
          .filter((e) => e.alive && e.spawned && !chain.includes(e) && !isStealthed(e) && Math.hypot(e.x - last.x, e.y - last.y) <= CHAIN_JUMP_RADIUS)
          .sort((a, b) => Math.hypot(a.x - last.x, a.y - last.y) - Math.hypot(b.x - last.x, b.y - last.y))[0];
        if (!next) break;
        chain.push(next);
      }
      return chain.map((e, i) => [e, noDecay ? 1 : Math.pow(0.85, i)]);
    }
    const main = cands.slice(0, n).map((e) => [e, 1] as [Enemy, number]);
    if (field && SPLASH_SUB.has(sub)) {
      const p = main[0][0];
      for (const e of enemies) {
        if (!e.alive || main.some(([m]) => m === e)) continue;
        if (isStealthed(e)) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) <= 1.0) main.push([e, 1]);
      }
    }
    return main;
  };

  /** スキル中の最大HP上昇の付け外し */
  /** 【強襲】：有効化中の所属者はスキル発動中に攻撃力・最大HP上昇 */
  const raidSkillBuff = (u: Runtime, key: 'atk' | 'hp') => (field && g.raid?.members.has(u.input.uid) && !u.owner ? g.raid[key] : 0);
  const setSkillHp = (u: Runtime, on: boolean) => {
    const raidHp = raidSkillBuff(u, 'hp');
    if ((!u.skill.hpPct && !u.skill.hpFlat && !raidHp) || !u.alive) return;
    const target = u.baseMaxHp * (1 + (on ? u.skill.hpPct + raidHp : 0)) + (on ? u.skill.hpFlat : 0);
    const diff = target - u.maxHp;
    u.maxHp = target;
    u.hp = Math.min(u.maxHp, Math.max(1, u.hp + Math.max(0, diff)));
  };

  /** イネスS2で奪った攻撃速度を返す */
  const returnStolenAspd = (u: Runtime) => {
    if (!u.ts.stealAspd) return;
    u.ts.stealAspd = 0;
    for (const e of enemies) e.stolenAspd.delete(u);
  };
  const endSkill = (u: Runtime) => {
    setSkillHp(u, false);
    returnStolenAspd(u);
    if (cid(u) === TIPPI) land(u);
    if (cid(u) === LEMUEN) lemuenBombard(u);
    // カゼマル：スキル終了で召喚した身替りは消える
    if (cid(u) === KAZEMA && !u.owner) for (const o of rt) if (o.owner === u && o.alive) removeToken(o);
    // 帰溟スペクター：スキル終了後、身替りと入れ替わる
    if (cid(u) === GHOST2 && !u.owner && u.alive && !inDoll(u)) enterDoll(u);
    talentOnSkillEnd(u);
    // 戦術【回収利用】：地上オペレーターのスキル終了時、周囲4マスのランダムな味方1名のSP回復
    if (g.humus && u.melee && u.input.pos !== undefined) {
      const p = u.input.pos;
      const near = rt.filter(
        (o) => o !== u && o.alive && o.input.pos !== undefined && Math.abs(cellX(o.input.pos) - cellX(p)) + Math.abs(cellY(o.input.pos) - cellY(p)) === 1,
      );
      // ランダムの代わりに、SPの割合が最も低い1名（戦闘を決定的にするため）
      const pick = near.sort((a, b) => a.sp / Math.max(1, a.skill.spCost) - b.sp / Math.max(1, b.skill.spCost))[0];
      if (pick) pick.sp += g.humus.sp;
    }
    u.philaeBoost = false;
    // 俊敏：スキル終了時に確率でSP回復（期待値：累積が1に達するたびに発生）。
    // スキルの動作時間を再現していないので、発生後しばらくは再発動しない
    const swiftSp = u.input.mods.spOnSkillEnd ?? 0;
    if (swiftSp > 0 && (g.swiftProb ?? 0) > 0) {
      u.swiftAcc += Math.min(1, g.swiftProb!);
      if (u.swiftAcc >= 1) {
        u.swiftAcc -= 1;
        u.sp += swiftSp;
        u.recastAt = t + SWIFT_RECAST_DELAY;
      }
    }
    if (!u.firstEndDone) {
      u.firstEndDone = true;
      u.sp += u.input.mods.firstSkillEndSp ?? 0;
    }
  };

  /** 離陸：ブロック中の地上の敵を放す */
  const takeOff = (u: Runtime) => {
    for (const b of u.blocked) if (!b.input.spec.flying) b.blockedBy = null;
    u.blocked = u.blocked.filter((b) => b.input.spec.flying);
  };
  /** 着陸：ブロック中の空中の敵を放す */
  const land = (u: Runtime) => {
    for (const b of u.blocked) if (b.input.spec.flying) b.blockedBy = null;
    u.blocked = u.blocked.filter((b) => !b.input.spec.flying);
  };
  const castSkill = (u: Runtime, outerAtkPct: number) => {
    const { mods, uid, def, star } = u.input;
    const s = u.skill;
    u.sp = 0;
    u.result.skillCasts++;
    u.lockOns = [];
    u.lockTimer = 0;
    // サンクタ・ミキサー：他の味方【ラテラーノ】のうち弾薬スキル中の者に給弾
    if (cid(u) === MIXER && s.bb.ammo) {
      for (const o of rt) if (o !== u && o.alive && o.ammoLeft > 0 && o.input.def.bonds.includes('laterano')) o.ammoLeft += Math.round(s.bb.ammo);
    }
    if (s.ammo > 0) u.ammoLeft = Math.round(s.ammo * (1 + (mods.ammoPct ?? 0))) + (mods.ammoFlat ?? 0);
    else if (s.duration > 0) u.skillLeft = s.duration;
    if (u.skillLeft > 0 || u.ammoLeft > 0) setSkillHp(u, true);
    // ポデンコ（胞子飛散）：着弾地点の周囲の敵の特殊能力を無効化
    const spore = SKILL_NEUTRALIZE[def.charId];
    if (spore) {
      const main = pickTargets(u, true)[0]?.[0];
      if (main) for (const e of enemies) if (e.alive && Math.hypot(e.x - main.x, e.y - main.y) <= spore.radius) neutralize(e, spore.duration);
    }
    const support = field ? SUPPORT_SKILL[def.charId] : undefined;
    const skillAtk = () => baseAtk(def, star, mods, outerAtkPct + s.atkPct);
    u.castAt = t;
    if (SKILL_FX[def.charId] && !s.instant) emit([13, uid, SKILL_FX[def.charId], 0]);
    talentOnCast(u);
    // カゼマルS2：HPが現在値の一定割合減少し、身替りを召喚
    if (cid(u) === KAZEMA && !u.owner && field) {
      u.hp = Math.max(1, u.hp * (1 - (s.bb.hp_ratio ?? 0)));
      summonToken(u);
    }
    if (field && s.costOnCast) cost = Math.min(MAX_COST, cost + s.costOnCast);
    if (support === 'nextHeal') {
      const target = injuredNear(u)[0];
      if (target) healUnit(u, target, skillAtk() * (s.bb.heal_scale ?? 1));
      endSkill(u);
    } else if (support === 'areaHeal') {
      const p = posOf(u);
      for (const o of alliesNear(p.x, p.y, SUPPORT_HEAL_RADIUS)) healUnit(u, o, skillAtk() * (s.bb.heal_scale ?? 1));
      endSkill(u);
    } else if (support === 'zone') {
      const main = pickTargets(u, true)[0]?.[0];
      const p = main ? { x: main.x, y: main.y } : posOf(u);
      const zr = Math.min(1.5, s.bb.projectile_range ?? 1.2);
      const zd = s.bb.projectile_delay_time ?? 10;
      emit([5, uid, Math.round(p.x * 100), Math.round(p.y * 100), Math.round(zr * 100), Math.round(zd * 10)]);
      zones.push({
        owner: u,
        x: p.x,
        y: p.y,
        r: zr,
        until: t + zd,
        atk: skillAtk(),
        heal: s.bb.hp_recovery_per_sec_ratio ?? s.bb.hp_recovery_per_sec_ratio_chr ?? 0,
        // ブリキの素質：錬金ユニットの継続ダメージ上昇
        dot: (s.bb.atk_scale ?? 0) * (u.tb[1]['skill@damage_scale'] ?? 1),
        groundOnly: def.charId === 'char_4151_tinman',
      });
      endSkill(u);
    } else if (support === 'surtr') {
      u.hp = u.maxHp;
    } else if (s.instant && def.damageType === 'heal') {
      if (field) healAction(u, baseAtk(def, star, mods, outerAtkPct + s.atkPct), s.atkScale, true);
      endSkill(u);
    } else if (s.instant && field && ELEMENT_SKILL[def.charId]) {
      const kind = ELEMENT_SKILL[def.charId];
      const atk = baseAtk(def, star, mods, outerAtkPct + s.atkPct);
      const cands = pickTargets(u, true).map(([e]) => e);
      if (kind === 'virtuosa') {
        // 壊死の爆発中でない敵1体に術ダメージと壊死損傷
        const target = cands.find((e) => !enBursting(e, 'apoptosis')) ?? cands[0];
        if (target) {
          strike(u, target, atk, s.bb.atk_scale ?? 1);
          addEnElement(target, 'apoptosis', atk * (s.bb.ep_damage_ratio ?? 0), u);
        }
      } else if (kind === 'nymph') {
        // 対象と周囲の敵に術ダメージ、与えたダメージの一部を壊死損傷に
        const main = cands[0];
        if (main) {
          emit([1, uid, Math.round(main.x * 100), Math.round(main.y * 100), Math.round((s.bb.projectile_range ?? 1.5) * 100)]);
          for (const e of enemies) {
            if (!e.alive || Math.hypot(e.x - main.x, e.y - main.y) > (s.bb.projectile_range ?? 1.5)) continue;
            const before = e.hp;
            strike(u, e, atk, s.bb.atk_scale ?? 1);
            addEnElement(e, 'apoptosis', Math.max(0, before - e.hp) * (s.bb.ep_damage_ratio ?? 0), u);
          }
        }
      }
      endSkill(u);
    } else if (s.instant && def.charId === SNOW_HUNTER) {
      // スノーハンター：特殊弾の2連撃（移動していない敵には倍率上昇）＋素質で裂雲獣の一撃と寒冷
      const atk = baseAtk(def, star, mods, outerAtkPct + s.atkPct);
      const target = pickTargets(u, true)[0]?.[0];
      if (target) {
        const still = target.blockedBy !== null || isFrozen(target);
        const sc = still ? (s.bb.atk_scale_2 ?? 1) : (s.bb.atk_scale_1 ?? 1);
        for (let h = 0; h < 2; h++) strike(u, target, atk, sc);
        strike(u, target, atk, u.tb[0].atk_scale ?? 1);
        applyCold(target, u.tb[0].cold ?? 0);
      }
      endSkill(u);
    } else if (cid(u) === BLKKGT && s.bb.d_atk_scale) {
      // デーゲンブレヒャーS3：斬撃10回＋最後の一撃のモーション（毎コマの処理で斬る。最後の一撃でスキル終了）
      const gap = s.bb.d_hit_interval ?? 0.3;
      u.slashLeft = BLKKGT_SLASHES + 1;
      u.slashTimer = 0;
      u.motionLen = gap * BLKKGT_SLASHES;
      u.skillLeft = u.motionLen;
    } else if (s.instant) {
      if (support === 'selfHeal') healUnit(u, u, u.maxHp * (s.bb.hp_ratio ?? 0));
      const atk = baseAtk(def, star, mods, outerAtkPct + s.atkPct);
      const hitList = pickTargets(u, true);
      const style = SKILL_FX[def.charId];
      if (style) emit([13, uid, style, 0, ...hitList.flatMap(([e]) => [Math.round(e.x * 100), Math.round(e.y * 100)])]);
      else if (hitList.length >= 2) emit([2, uid, 1]);
      for (const [e, m] of hitList) {
        for (let h = 0; h < s.hits; h++) strike(u, e, atk, s.atkScale * m);
        if (s.cold > 0) applyCold(e, s.cold);
      }
      endSkill(u);
    }
    if (g.sargon?.members.has(uid)) {
      for (const o of rt) {
        if (!g.sargon.members.has(o.input.uid)) continue;
        o.sargonBuffs = o.sargonBuffs.filter((until) => until > t);
        if (o.sargonBuffs.length < g.sargon.maxStacks) o.sargonBuffs.push(t + g.sargon.duration);
      }
    }
    if (g.sargonSpOnSkill?.members.has(uid)) {
      for (const o of rt) if (g.sargonSpOnSkill.members.has(o.input.uid) && o !== u) o.sp += g.sargonSpOnSkill.sp;
    }
    for (const ev of u.events) if (ev.kind === 'useskill') gainStacks(ev);
  };

  /** ブロックできるユニット（ブロック数に空きがある） */
  const blockerAt = (tile: number, e: Enemy): Runtime | undefined =>
    rt.find(
      (u) =>
        u.blocker &&
        u.alive &&
        !stunned(u) &&
        u.input.pos === tile &&
        // 離陸中（ティッピ）は空中の敵だけ、それ以外は地上の敵だけをブロックする
        lifted(u) === !!e.input.spec.flying &&
        u.blocked.reduce((s, b) => s + b.input.spec.blockCnt, 0) + e.input.spec.blockCnt <= u.block + (u.skillLeft > 0 || u.ammoLeft > 0 ? u.skill.blockAdd : 0),
    );

  // ------------------------------------------------------------
  // 敵の攻撃・オペレーターの被弾と回復
  // ------------------------------------------------------------
  let indomAcc = ACC_START;
  let egirRevives = g.egirRevive?.count ?? 0;
  let bandRevives = g.bandRevive ?? 0;

  /** 防御・術耐性・被ダメージ軽減を通したダメージ */
  const mitigate = (u: Runtime, raw: number, arts: boolean, defPen = 0) => {
    // 灼燃の爆発中は術耐性-20、侵蝕の爆発で防御力が永久に下がる。defPen は攻撃側の防御無視（割合）
    const res = Math.max(0, u.res - (t < (u.elemBurst.burning ?? -1) ? 20 : 0));
    const df = Math.max(0, u.def - u.erosionDef) * (1 - defPen);
    const dmg = arts ? Math.max(raw * (1 - res / 100), raw * MIN_DAMAGE_RATIO) : Math.max(raw - df, raw * MIN_DAMAGE_RATIO);
    // ユーの素質：ブロック中は庇護30%
    const protect = ELEMENT_TALENT[u.input.def.charId]?.protectWhileBlocking && u.blocked.length ? ELEMENT_TALENT[u.input.def.charId]!.protectWhileBlocking! : 0;
    return dmg * Math.max(0, 1 - (u.input.mods.damageReduce ?? 0) - (arts ? 0 : (u.input.mods.physReduce ?? 0))) * (1 - protect);
  };

  /** イネスの影哨：撤退した位置に残る（イネスごとに最大1体。通常の攻撃範囲で、素質「影哨」の効果だけを持つ） */
  const inesSentinels = new Map<Runtime, Set<number>>();
  /** イネスの退場：奪った攻撃力・攻撃速度を返し（自身の分も消える）、影哨を残す */
  const inesLeaves = (u: Runtime) => {
    for (const e of enemies) e.stolenAtk.delete(u);
    u.ts.stealAtk = 0;
    u.ts.firstHit.clear();
    returnStolenAspd(u);
    if (field && u.rangeNormal) inesSentinels.set(u, u.rangeNormal);
  };
  /** 戦場から外れる（倒れた・コスト不足で撤退）。再配置タイマーが動き出す */
  const leaveField = (u: Runtime) => {
    u.alive = false;
    u.hp = 0;
    if (cid(u) === 'char_4087_ines') inesLeaves(u);
    if (u.result.downAt === null) u.result.downAt = Math.round(t * 100) / 100;
    u.result.retreats++;
    for (const e of u.blocked) e.blockedBy = null;
    u.blocked = [];
    u.skillLeft = 0;
    u.ammoLeft = 0;
    u.qalaisaStacks = 0;
    u.mberryShield = 0;
    if (field && u.input.pos !== undefined) u.redeployAt = t + u.respawn;
  };

  // ---- 傀儡師（カゼマル・帰溟スペクター） ----
  const isDollkeeper = (u: Runtime) => u.input.def.subProfession === 'dollkeeper' && !u.owner;
  const inDoll = (u: Runtime) => u.dollUntil >= 0;
  const around = (pos: number) => new Set(rangeCells(pos, 'right', AROUND));
  /** カゼマルの素質：身替りが出現した時、周囲8マスの敵に攻撃力の一定割合の術ダメージ */
  const dollBlast = (src: Runtime, pos: number) => {
    const owner = src.owner ?? src;
    const scale = owner.tb[0].damage_scale ?? 0;
    if (cid(owner) !== KAZEMA || !scale) return;
    const atk = baseAtk(src.input.def, src.input.star, src.input.mods);
    const x = cellX(pos);
    const y = cellY(pos);
    emit([7, Math.round(x * 100), Math.round(y * 100), 4]);
    for (const e of enemies) {
      if (!e.alive || !e.spawned || Math.abs(e.x - x) > 1.5 || Math.abs(e.y - y) > 1.5) continue;
      deal(src, e, hitDamage(atk * scale, 'arts', effDefense(e), src.input.mods), 'arts');
    }
  };
  /** 身替りと入れ替わる（HPは最大値、ブロック数0、攻撃範囲は周囲8マス） */
  const enterDoll = (u: Runtime) => {
    u.dollUntil = t + DOLL_DURATION;
    if (u.skillLeft > 0 || u.ammoLeft > 0) {
      u.skillLeft = 0;
      u.ammoLeft = 0;
      endSkill(u);
    }
    u.saved = { block: u.block, blocker: u.blocker, rangeNormal: u.rangeNormal, rangeSkill: u.rangeSkill };
    for (const e of u.blocked) e.blockedBy = null;
    u.blocked = [];
    u.block = 0;
    u.blocker = false;
    if (u.input.pos !== undefined) {
      u.rangeNormal = u.rangeSkill = around(u.input.pos);
      dollBlast(u, u.input.pos);
    }
    u.hp = u.maxHp;
    u.dollTick = 1;
    // 「倒れた時か身替りと入れ替わった時」の堅守特性（帰溟スペクター。S2終了後の入れ替わりも含む）
    for (const ev of u.events) if (ev.kind === 'dead') gainStacks(ev, 1, '身替りと入れ替わり');
  };
  const restoreDoll = (u: Runtime) => {
    if (u.saved) Object.assign(u, u.saved);
    u.saved = null;
    u.dollUntil = -1;
  };
  /** 時間が来たら本体に戻る（HPは最大値） */
  const exitDoll = (u: Runtime) => {
    restoreDoll(u);
    u.hp = u.maxHp;
  };
  /** 召喚した身替り（紙人形）を消す */
  const removeToken = (tk: Runtime) => {
    tk.alive = false;
    tk.hp = 0;
    for (const e of tk.blocked) e.blockedBy = null;
    tk.blocked = [];
  };
  let tokenSeq = 0;
  /** カゼマルS2：周囲の近距離配置マス（空いている地上マス。前方を優先）に身替り（紙人形）を1体召喚 */
  const summonToken = (u: Runtime) => {
    const pos = u.input.pos;
    if (!field || pos === undefined) return;
    const [fx, fy] = DIR_DELTA[u.input.dir ?? DEFAULT_DIRECTION];
    const cands = rangeCells(pos, 'right', AROUND)
      .filter((c) => c !== pos && canBlockAt(c) && !rt.some((o) => o.alive && o.input.pos === c))
      .sort((a, b) => {
        const score = (c: number) => -((cellX(c) - cellX(pos)) * fx + (cellY(c) - cellY(pos)) * fy) + (cellX(c) !== cellX(pos) && cellY(c) !== cellY(pos) ? 0.5 : 0);
        return score(a) - score(b);
      });
    if (!cands.length) return;
    const st = unitState(u.input.def, u.input.star).stats;
    const tk = makeRuntime({ ...u.input, uid: 900000 + ++tokenSeq, pos: cands[0], mods: { ...u.input.mods, atkFlat: (u.input.mods.atkFlat ?? 0) + st.atk * (KAZEMA_TOKEN_ATK - 1) } });
    tk.owner = u;
    tk.skill = { ...tk.skill, spCost: 0 };
    tk.sp = 0;
    tk.block = 0;
    tk.blocker = false;
    tk.rangeNormal = tk.rangeSkill = around(cands[0]);
    tk.result = u.result;
    tk.events = [];
    tk.order = ++orderCounter;
    rt.push(tk);
    byUid.set(tk.input.uid, tk);
    dollBlast(tk, cands[0]);
  };

  // ---- 【強襲】の再配置 ----
  const inMotion0 = (u: Runtime) => u.motionLen > 0 && u.skillLeft > 0;
  /** 位置と向きを変える（攻撃範囲・ブロックを置き直し、ブロック中の敵は解放する） */
  const placeAt = (u: Runtime, pos: number | undefined, dir: Direction | undefined) => {
    for (const e of u.blocked) e.blockedBy = null;
    u.blocked = [];
    u.input = { ...u.input, pos, dir };
    const ids = unitRangeIds(u.input.def.id, u.input.star);
    u.rangeNormal = toSet(pos, dir, ids.range);
    u.rangeSkill = toSet(pos, dir, ids.skillRange ?? ids.range);
    u.blocker = pos !== undefined && canBlockAt(pos) && u.input.def.damageType !== 'heal';
    u.block = u.blocker ? unitState(u.input.def, u.input.star).stats.block : 0;
  };
  const DIRS: Direction[] = ['right', 'down', 'left', 'up'];
  /**
   * 地上の敵1体（防衛地点に最も近いもの）の周囲8マス（その敵のマスも含む）の空いている配置可能なマスへ再配置する。
   * マスと向きは、その敵が攻撃範囲に入るもののうち、範囲内の地上の敵が多い → 敵をブロックできる地上マス → 敵に近い → 範囲に入る敵の経路のマスが多い順で選ぶ
   */
  const raidRelocate = (u: Runtime) => {
    if (!g.raid) return;
    const ground = enemies
      .filter((e) => e.alive && e.spawned && !isFlying(e) && !e.input.spec.float && !e.input.spec.roam && !e.input.spec.projectile && !isStealthed(e))
      .sort((a, b) => remaining(a) - remaining(b));
    if (!ground.length) return;
    const taken = new Set(rt.filter((o) => o !== u && (o.alive || o.redeployAt !== null) && o.input.pos !== undefined).map((o) => o.input.pos!));
    const ids = unitRangeIds(u.input.def.id, u.input.star);
    for (const target of ground) {
      const tx = Math.round(target.x);
      const ty = Math.round(target.y);
      let best: { pos: number; dir: Direction; score: number[] } | null = null;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= BOARD_COLS || y >= BOARD_ROWS) continue;
          const c = cellPos(x, y);
          if (c === u.input.pos || taken.has(c) || !canPlace(c, u.input.def.id)) continue;
          for (const dir of DIRS) {
            const range = toSet(c, dir, ids.range);
            const onTile = c === enemyTile(target) && canBlockAt(c);
            if (!covers(range, target) && !onTile) continue;
            const n = ground.filter((e) => covers(range, e)).length;
            const score = [n, canBlockAt(c) ? 1 : 0, -(Math.abs(dx) + Math.abs(dy)), [...(range ?? [])].filter((x) => PATH_TILES.has(x)).length];
            const diff = best ? score.findIndex((v, i) => v !== best!.score[i]) : 0;
            if (!best || (diff >= 0 && score[diff] > best.score[diff])) best = { pos: c, dir, score };
          }
        }
      }
      if (!best) continue;
      placeAt(u, best.pos, best.dir);
      // 後から配置されたので、遠距離の敵に一番狙われやすくなる。配置時の効果も発動する（SPはそのまま）
      u.order = ++orderCounter;
      u.result.raids = (u.result.raids ?? 0) + 1;
      onDeployed(u);
      return;
    }
  };

  const unitDown = (u: Runtime) => {
    // 召喚された身替り（紙人形）はそのまま消える
    if (u.owner) return removeToken(u);
    const ground = u.melee;
    // 素質：致命傷を耐える（スルト・ホルン・聖聆プラマニクス）
    if (talentOnDown(u)) return;
    // 琳琅スワイヤー（破財消災）：コストを払ってHPを回復（払うたびに倍）
    const save = SWIRE[u.input.def.charId];
    if (save && cost >= u.swireSaveCost) {
      cost -= u.swireSaveCost;
      u.swireSaveCost *= 2;
      u.hp = u.maxHp * save.saveHp[u.input.star - 1];
      return;
    }
    // 傀儡師：致命傷で撤退せず身替りと入れ替わる。身替りが倒れたら撤退
    if (isDollkeeper(u)) {
      if (!inDoll(u)) {
        enterDoll(u);
        return;
      }
      restoreDoll(u);
    }
    // 不屈Lv2：地上オペレーターが倒れると全員のSP回復
    if (ground && g.indom?.sp) for (const o of rt) if (o.alive && o !== u) o.sp += g.indom.sp;
    // 戦術【崇高な犠牲】：エーギルが倒れると、その等級だけエーギルの加算数
    if (g.egirSacrifice?.has(u.input.uid) && active.has('egir')) {
      stackGains.egir = (stackGains.egir ?? 0) + u.input.def.tier;
      addSource(u.input.uid, u.input.def.name, 'egir', u.input.def.tier, '戦術【崇高な犠牲】');
    }
    // 戦術【食腐の蝶】：倒れるたびに、場に残る味方の攻撃力上昇
    if (g.qalaisa) for (const o of rt) if (o.alive && o !== u) o.qalaisaStacks = Math.min(g.qalaisa.max, o.qalaisaStacks + 1);
    // 戦術【命結の秘】：戦闘中に最初に倒れた数名は即座に復活
    if (bandRevives > 0) {
      bandRevives--;
      u.hp = u.maxHp;
      return;
    }
    // エーギルLv2：最初に倒れたエーギル数名は即座に復活
    if (g.egirRevive?.members.has(u.input.uid) && egirRevives > 0) {
      egirRevives--;
      u.hp = u.maxHp;
      return;
    }
    // 不屈：確率で即座に再配置（期待値：累積が1に達するたび）
    if (ground && g.indom && g.indom.prob > 0) {
      indomAcc += g.indom.prob;
      if (indomAcc >= 1) {
        indomAcc -= 1;
        u.hp = u.maxHp;
        return;
      }
    }
    for (const ev of u.events) if (ev.kind === 'dead') gainStacks(ev);
    leaveField(u);
  };

  // ---- コスト・再配置 ----
  let cost = INITIAL_COST + (g.initialCost ?? 0);
  let orderCounter = rt.length;
  /** 再配置に必要なコスト（初回の再配置は1.5倍、2回目以降は2倍） */
  const redeployCost = (u: Runtime) => Math.round(unitState(u.input.def, u.input.star).stats.cost * (u.result.retreats <= 1 ? 1.5 : 2));
  const redeploy = (u: Runtime) => {
    const s = u.skill;
    u.alive = true;
    u.maxHp = u.baseMaxHp * (s.passive ? 1 + s.hpPct : 1) + (s.passive ? s.hpFlat : 0);
    u.hp = u.maxHp;
    u.sp = s.initSp + (u.input.mods.startSp ?? 0);
    u.skillLeft = 0;
    u.ammoLeft = 0;
    u.atkTimer = 0;
    u.castAt = -1;
    u.merchantTimer = 0;
    u.redeployAt = null;
    if (SWIRE[u.input.def.charId]) u.coins = Math.max(u.coins, 1);
    // 後から配置されたので、遠距離の敵に一番狙われやすくなる
    u.order = ++orderCounter;
    u.result.redeploys++;
    onDeployed(u);
  };
  // ---- 血掟テキサス S3「ロヴェーショ」 ----
  const TEXAS2 = 'char_1028_texas2';
  const stunEnemy = (e: Enemy, seconds: number) => {
    if (!e.alive || seconds <= 0) return;
    e.stunUntil = Math.max(e.stunUntil, t + seconds * (1 - (e.input.spec.statusResist ?? 0)));
    if (field) onSleepStun(e);
  };
  const texasAtk = (u: Runtime) => baseAtk(u.input.def, u.input.star, u.input.mods, u.tb[0].atk ?? 0);
  /** 配置時：周囲の敵全員に2回連続の術ダメージとスタン */
  const texasAppear = (u: Runtime) => {
    if (!field) return;
    const bb = u.skill.bb;
    emit([2, u.input.uid, 1]);
    for (const e of enemies) {
      if (!e.alive || !e.spawned || !covers(u.rangeSkill, e)) continue;
      for (let i = 0; i < 2; i++) deal(u, e, hitDamage(texasAtk(u) * (bb['appear.atk_scale'] ?? 1), 'arts', effDefense(e), u.input.mods), 'arts');
      stunEnemy(e, bb['appear.stun'] ?? 0);
      emit([8, u.input.uid, Math.round(e.x * 100), Math.round(e.y * 100)]);
    }
    u.swordTimer = bb['texas2_s_3[sword].interval'] ?? 1;
  };
  /** スキル中：1秒ごとに範囲内の敵最大N体に剣雨（術ダメージと短いスタン） */
  const tickTexas = () => {
    for (const u of rt) {
      if (cid(u) !== TEXAS2 || !u.alive || u.skillLeft <= 0 || !u.skill.onDeploy) continue;
      u.swordTimer -= dt;
      if (u.swordTimer > 0) continue;
      const bb = u.skill.bb;
      u.swordTimer += bb['texas2_s_3[sword].interval'] ?? 1;
      const targets = targetsInRange(u, true).slice(0, Math.max(1, Math.round(bb.max_target ?? 1)));
      // 効果範囲を光らせる
      emit([2, u.input.uid, 1]);
      for (const e of targets) {
        deal(u, e, hitDamage(texasAtk(u) * (bb.atk_scale ?? 1), 'arts', effDefense(e), u.input.mods), 'arts');
        stunEnemy(e, bb.stun ?? 0);
        emit([8, u.input.uid, Math.round(e.x * 100), Math.round(e.y * 100)]);
      }
    }
  };
  // ---- 浮遊ユニット（遊撃術師）と荒蕪ラップランドS3「ディザストロ・フィナーレ」 ----
  /** 荒蕪ラップランドの素質「群狼の統率者」：配置から interval 秒ごとに段階が上がる（1: 与ダメージ上限+10%、2: 特殊能力無効化、3: 数+1） */
  const whitw2Stage = (u: Runtime) =>
    cid(u) === WHITW2 && u.tb[0].interval ? Math.min(3, Math.floor((t - u.ts.deployedAt) / u.tb[0].interval)) : 0;
  const funnelCount = (u: Runtime, active: boolean) =>
    1 + (active && !u.skill.passive ? Math.round(u.skill.bb['attack@cnt'] ?? 0) : 0) + (whitw2Stage(u) >= 3 ? 1 : 0);
  /** 倍率の上限（ロックロックのスキル中は上限が上がる。荒蕪ラップランドの素質で+10%） */
  const funnelCap = (u: Runtime, active: boolean) =>
    (active && !u.skill.passive && u.skill.bb.scale ? u.skill.bb.scale : FUNNEL.max) * (whitw2Stage(u) >= 1 ? (u.tb[0].scale ?? 1) : 1);
  const zaroTargets = () => enemies.filter((e) => e.alive && e.spawned && !isStealthed(e) && !(e.input.spec.roam && (e.minion === 'roam' || e.minion === 'back')));
  /** ザーロ周囲の敵の移動速度低下 */
  const zaroSlow = (e: Enemy): number => {
    for (const u of rt) {
      if (!u.zaros.length) continue;
      const r = u.skill.bb['attack@range_radius'] ?? 0.9;
      if (u.zaros.some((z) => z.attached && Math.hypot(z.x - e.x, z.y - e.y) <= r)) return 1 + (u.skill.bb['attack@move_speed'] ?? 0);
    }
    return 1;
  };
  const tickZaro = () => {
    for (const u of rt) {
      if (cid(u) !== WHITW2) continue;
      const active = u.alive && u.skillLeft > 0;
      if (!active) {
        u.zaros = [];
        continue;
      }
      const bb = u.skill.bb;
      // スキル開始時：浮遊ユニットの数だけザーロを放つ
      const n = funnelCount(u, true);
      while (u.zaros.length < n && u.input.pos !== undefined) {
        u.zaros.push({ x: cellX(u.input.pos), y: cellY(u.input.pos), target: null, attached: false });
        u.zaroTimer = 1;
      }
      for (const z of u.zaros) {
        // 目標が倒れたら近い敵を探し直す
        if (!z.target || !z.target.alive) {
          z.attached = false;
          // 他のザーロが追っていない敵を優先（いなければ一番近い敵）
          const taken = new Set(u.zaros.filter((o) => o !== z && o.target?.alive).map((o) => o.target));
          const cands = zaroTargets().sort((a, b) => Math.hypot(a.x - z.x, a.y - z.y) - Math.hypot(b.x - z.x, b.y - z.y));
          z.target = cands.find((e) => !taken.has(e)) ?? cands[0] ?? null;
        }
        if (!z.target) continue;
        if (z.attached) {
          z.x = z.target.x;
          z.y = z.target.y;
          continue;
        }
        const dx = z.target.x - z.x;
        const dy = z.target.y - z.y;
        const dist = Math.hypot(dx, dy);
        const step = ZARO_SPEED * dt;
        if (dist <= step) {
          // 到達：取り付いて恐怖
          z.x = z.target.x;
          z.y = z.target.y;
          z.attached = true;
          fearEnemy(z.target, bb['attack@fear'] ?? 0);
        } else {
          z.x += (dx / dist) * step;
          z.y += (dy / dist) * step;
        }
      }
      // 1秒ごと：取り付いたザーロの周囲の敵に術ダメージ（重複不可：1体につき1回）
      u.zaroTimer -= dt;
      if (u.zaroTimer > 0) continue;
      u.zaroTimer += 1;
      const r = bb['attack@range_radius'] ?? 0.9;
      const hit = new Set<Enemy>();
      for (const z of u.zaros) {
        if (!z.attached) continue;
        emit([9, u.input.uid, Math.round(z.x * 100), Math.round(z.y * 100)]);
        for (const e of enemies) if (e.alive && e.spawned && Math.hypot(e.x - z.x, e.y - z.y) <= r) hit.add(e);
      }
      for (const e of hit) {
        deal(u, e, hitDamage(u.curAtk * (bb['attack@magic_atk_scale'] ?? 1), 'arts', effDefense(e), u.input.mods), 'arts');
        if (whitw2Stage(u) >= 2) neutralize(e, u.tb[0]['attack@silence_duration'] ?? 2);
      }
    }
  };
  const zaroFrame = (): [number, number, number, number][] =>
    rt.flatMap((u) => u.zaros.map((z): [number, number, number, number] => [u.input.uid, Math.round(z.x * 100), Math.round(z.y * 100), z.attached ? 1 : 0]));
  /** 配置時に発動するスキル（ウタゲ：HP減少と効果時間、グラベル：バリア） */
  const onDeployed = (u: Runtime) => {
    const s = u.skill;
    // 素質：配置からの時間、マドロックのシールド（配置時に1枚）、アルケットのシールド
    u.ts.deployedAt = t;
    u.raidIdleFrom = t;
    u.ts.shields = cid(u) === 'char_311_mudrok' ? 1 : 0;
    u.ts.shieldTimer = u.tb[0].interval ?? 9;
    u.ts.archShield = false;
    u.ts.saveUsed = false;
    u.ts.bloodBattle = false;
    u.ts.surtrUntil = null;
    // 血掟テキサス：「1回の配置につき1回」「配置後、敵を1体倒すまで」は配置ごとにリセット
    u.ts.recast = false;
    u.ts.firstKill = false;
    if (!s.onDeploy) return;
    u.skillLeft = s.duration;
    u.castAt = t;
    u.result.skillCasts++;
    setSkillHp(u, true);
    if (s.deployHpLoss) u.hp = Math.max(1, u.hp * (1 - s.deployHpLoss));
    if (s.barrier) {
      u.barrier = u.maxHp * s.barrier;
      u.barrierBy = u;
      u.barrierDecay = u.barrier / Math.max(1, s.duration);
    }
    if (cid(u) === TEXAS2) texasAppear(u);
  };
  if (field) for (const u of rt) onDeployed(u);

  const tickCost = () => {
    // ウルピスフォリア：配置中はコストの自然回復速度上昇
    const vulpis = rt.find((w) => w.alive && cid(w) === 'char_4026_vulpis');
    cost = Math.min(MAX_COST, cost + (dt / COST_INTERVAL) * (vulpis?.tb[1].delta_cost_increase_time ?? 1));
    // 再配置：タイマーが0になり、コストが足りていれば配置する（待っている順に）
    for (const u of [...rt].filter((x) => x.redeployAt !== null && t >= x.redeployAt).sort((a, b) => a.redeployAt! - b.redeployAt!)) {
      const need = redeployCost(u);
      if (cost < need) continue;
      cost -= need;
      redeploy(u);
    }
    // 行商人：配置中は3秒ごとにコストを3消費し、足りなければ撤退
    for (const u of rt) {
      if (!u.alive || u.input.def.subProfession !== 'merchant') continue;
      u.merchantTimer += dt;
      if (u.merchantTimer < MERCHANT_INTERVAL) continue;
      u.merchantTimer -= MERCHANT_INTERVAL;
      if (cost < MERCHANT_COST) {
        leaveField(u);
        continue;
      }
      cost -= MERCHANT_COST;
      // 琳琅スワイヤー（大買家）：コインを得て、攻撃力が上がる
      const sw = SWIRE[u.input.def.charId];
      if (sw) {
        u.coins = Math.min(sw.maxCoins[u.input.star - 1], u.coins + 1);
        u.swireStacks = Math.min(sw.maxStacks[u.input.star - 1], u.swireStacks + 1);
      }
    }
  };

  /** ティッピの離陸中 */
  const lifted = (u: Runtime) => cid(u) === TIPPI && u.skillLeft > 0;
  /** 離陸中の味方は地上の敵の攻撃対象にならない */
  const untargetable = (u: Runtime, e: Enemy) => lifted(u) && !e.input.spec.flying;
  /** 狙われやすさ（装備＋スキル中の taunt_level。バブル） */
  const unitTaunt = (u: Runtime) => (u.input.mods.taunt ?? 0) + (u.skillLeft > 0 ? (u.skill.bb.taunt_level ?? 0) : 0);
  /** 固定値の被ダメージ軽減（海溝の実験体）。1回分のダメージから差し引く */
  const flatCut = (u: Runtime, amount: number) => Math.max(0, amount - (u.input.mods.damageFlatReduce ?? 0));
  /** 毎秒ダメージ（1秒ごとに1回受けるものとして固定値軽減を適用） */
  const takeDps = (u: Runtime, dps: number) => takeDamage(u, flatCut(u, dps) * dt);

  const takeDamage = (u: Runtime, amount: number) => {
    if (!u.alive || amount <= 0) return;
    u.result.taken += amount;
    // バリアが先に受ける
    if (u.barrier > 0) {
      const absorbed = Math.min(u.barrier, amount);
      u.barrier -= absorbed;
      (u.barrierBy ?? u).result.barrier += absorbed;
      amount -= absorbed;
      if (amount <= 0) return;
    }
    // 眠っている味方は攻撃の対象にならない（ダメージを受けない）
    if (t < u.sleepUntil) return;
    u.hp -= amount;
    // 帰溟スペクターS2：スキル中はHPが1未満にならない
    if (cid(u) === GHOST2 && u.skillLeft > 0 && !u.owner) u.hp = Math.max(1, u.hp);
    // ティティのスキル：範囲内の味方が致命傷を受けると、HPが全回復するかスキル終了まで睡眠
    if (u.hp <= 1e-6 && field && u.input.pos !== undefined) {
      const titi = rt.find((o) => titiOn(o) && (o.rangeSkill ?? o.rangeNormal)?.has(u.input.pos!));
      if (titi) {
        u.hp = 1;
        u.sleepUntil = t + titi.skillLeft;
        onSleepStun(u.input.pos);
        return;
      }
    }
    // スルト：余燼の間はHP1で耐える
    if (u.ts.surtrUntil !== null) u.hp = Math.max(1, u.hp);
    // エンテレケイア：HPが25%を下回ると1度だけHP回復
    if (cid(u) === 'char_4010_etlchi' && !u.ts.saveUsed && u.hp < u.maxHp * (u.tb[1].hp_ratio ?? 0) && u.tb[1].hp_ratio) {
      u.ts.saveUsed = true;
      u.hp = Math.max(u.hp, 0) + u.maxHp * (u.tb[1]['etlchi_t_2[heal].hp_ratio'] ?? 0);
    }
    if (u.hp <= 1e-6) unitDown(u);
  };

  /** 堅守Lv2：被弾した【堅守】が攻撃元に術ダメージと脆弱 */
  const steadReflect = (u: Runtime, src: Enemy) => {
    const sd = g.stead;
    if (!sd || !u.alive || !src.alive || t < u.reflectReadyAt) return;
    u.reflectReadyAt = t + sd.cooldown;
    deal(u, src, hitDamage(sd.reflect, 'arts', effDefense(src), {}), 'arts');
    src.vulnUntil = t + sd.vulnDuration;
    src.defense.damageTaken = sd.vuln;
  };

  const hurt = (u: Runtime, raw: number, arts: boolean, src: Enemy, defPen = 0) => {
    // ティッピ：SPが溜まっていれば攻撃を受けた瞬間にスキルが自動発動し、その攻撃を回避して離陸
    if (field && cid(u) === TIPPI && u.skillLeft <= 0 && u.skill.spCost > 0 && u.sp >= u.skill.spCost && !stunned(u)) {
      castSkill(u, 0);
      takeOff(u);
      return;
    }
    philaeCounter(u);
    mixerCounter(u);
    if (talentOnHurt(u, arts, src)) return;
    // 聖約イグゼキュター：スキル中は近接攻撃を確率で回避し、弾薬を補充（期待値）
    if (EVADE_REFILL.has(u.input.def.charId) && u.ammoLeft > 0 && src.input.spec.attack?.kind === 'melee') {
      u.evadeAcc += u.skill.bb.prob ?? 0;
      if (u.evadeAcc >= 1) {
        u.evadeAcc -= 1;
        u.ammoLeft += u.skill.bb.recover_cnt ?? 1;
        return;
      }
    }
    // 戦術【薬枚実験】：護盾で被弾1回を無効化
    if (u.mberryShield > 0) {
      u.mberryShield--;
      return;
    }
    // バブルのスキル：攻撃されるたび防御力の40%の物理ダメージで反撃
    if (cid(u) === BUBBLE && u.skillLeft > 0 && src.alive) deal(u, src, hitDamage(u.def * (u.skill.bb.atk_scale ?? 0.4), 'physical', effDefense(src), u.input.mods), 'physical');
    // 海溝の実験体（【エーギル】）：攻撃元へ術ダメージで反撃
    const rs = u.input.mods.retaliateScale ?? 0;
    if (rs > 0 && u.alive && src.alive && t >= u.retaliateReadyAt) {
      u.retaliateReadyAt = t + (u.input.mods.retaliateLock ?? 0.5);
      deal(u, src, hitDamage(u.curAtk * rs, 'arts', effDefense(src), u.input.mods), 'arts');
    }
    let dmg = flatCut(u, mitigate(u, raw, arts, defPen) * talentTakenMult(u, arts));
    const sd = g.stead;
    if (sd && sd.members.has(u.input.uid)) steadReflect(u, src);
    else if (sd) {
      // 【堅守】以外が受けるダメージの一部を【堅守】が肩代わり
      const guard = rt.filter((o) => o.alive && sd.members.has(o.input.uid)).sort((a, b) => b.hp / b.maxHp - a.hp / a.maxHp)[0];
      if (guard) {
        const moved = dmg * sd.share;
        dmg -= moved;
        takeDamage(guard, moved);
        steadReflect(guard, src);
      }
    }
    takeDamage(u, dmg);
  };

  const healUnit = (healer: Runtime, target: Runtime, amount: number) => {
    if (!target.alive || amount <= 0) return;
    // 武者・鎌は他の味方から治療されない
    if (healer !== target && SELF_HEAL_SUB[target.input.def.subProfession]) return;
    // 百錬ガヴィル：受ける治療効果上昇（HP50%未満でさらに）
    if (cid(target) === 'char_1026_gvial2' && target.tb[1].heal_scale_1) {
      amount *= target.hp / target.maxHp < (target.tb[1].hp_ratio ?? 0.5) ? target.tb[1].heal_scale_2 : target.tb[1].heal_scale_1;
    }
    // ヒューマス：最大値を超えた回復はバリアに
    if (cid(target) === 'char_491_humus') {
      const over = amount - (target.maxHp - target.hp);
      if (over > 0) {
        target.barrier = Math.min(target.maxHp * (target.tb[0].max_hp_ratio ?? 1), target.barrier + over);
        target.barrierBy = target;
      }
    }
    if (healer !== target) {
      // サリア：治療した味方のSP回復
      if (cid(healer) === 'char_202_demkni' && healer.tb[1].sp) target.sp += healer.tb[1].sp;
      // パピルス：治療した味方にバリア
      if (cid(healer) === 'char_4139_papyrs') {
        const b = baseAtk(healer.input.def, healer.input.star, healer.input.mods) * (healer.tb[0]['attack@scale'] ?? 0);
        if (b > target.barrier) {
          target.barrier = b;
          target.barrierBy = healer;
        }
      }
    }
    const applied = Math.min(amount, target.maxHp - target.hp);
    if (applied <= 0) return;
    target.hp += applied;
    healer.result.healed += applied;
    if (healer !== target) emit([4, healer.input.uid, target.input.uid], `heal${healer.input.uid}:${target.input.uid}`, 0.6);
  };

  /** 治療の範囲内にいる味方 */
  const alliesInRange = (u: Runtime, skillActive: boolean) => {
    const range = skillActive ? u.rangeSkill : u.rangeNormal;
    return rt.filter((o) => o.alive && o.input.pos !== undefined && !!range?.has(o.input.pos));
  };
  const elemTotal = (o: Runtime) => (Object.values(o.elem) as number[]).reduce((s2, v) => s2 + v, 0);
  const injuredInRange = (u: Runtime, skillActive: boolean) => {
    // 行医：元素損傷を受けた味方も治療する（元素損傷の多い順を優先）
    const wander = u.input.def.subProfession === 'wandermedic';
    return alliesInRange(u, skillActive)
      .filter((o) => !SELF_HEAL_SUB[o.input.def.subProfession])
      .filter((o) => o.hp < o.maxHp - 1e-6 || (wander && elemTotal(o) > 0))
      .sort((a, b) => (wander ? elemTotal(b) - elemTotal(a) : 0) || a.hp / a.maxHp - b.hp / b.maxHp);
  };

  /** 医療の1回の治療行動 */
  const healAction = (u: Runtime, atk: number, scale: number, skillActive: boolean): boolean => {
    const list = injuredInRange(u, skillActive);
    if (!list.length) return false;
    const sub = u.input.def.subProfession;
    if (sub === 'chainhealer') {
      // 3人の間を跳ね、跳ねるたびに治療量-25%
      list.slice(0, 3).forEach((o, i) => healUnit(u, o, atk * scale * Math.pow(0.75, i)));
      return true;
    }
    const n = Math.max(skillActive ? u.skill.maxTarget : 1, sub === 'ringhealer' ? 3 : 1);
    for (const o of list.slice(0, n)) {
      // 療養師：遠くの対象は治療量80%
      const far = sub === 'healer' && u.input.pos !== undefined && o.input.pos !== undefined && Math.hypot(cellX(o.input.pos) - cellX(u.input.pos), cellY(o.input.pos) - cellY(u.input.pos)) > 1.5;
      healUnit(u, o, atk * scale * (far ? 0.8 : 1));
      // 行医：攻撃力の50%ぶん元素損傷も回復（ハロルドのスキル：蓄積が半分を超える相手には倍率上昇）
      if (sub === 'wandermedic') {
        const boost = skillActive && u.skill.bb.trait_scale && elemMax(o) > OP_ELEMENT_MAX / 2 ? u.skill.bb.trait_scale : 1;
        healElement(o, atk * WANDER_ELEMENT_HEAL * boost * scale);
      }
    }
    return true;
  };

  // ------------------------------------------------------------
  // 元素損傷
  // ------------------------------------------------------------
  const elemMax = (o: Runtime) => Math.max(0, ...(Object.values(o.elem) as number[]));
  const opBursting = (o: Runtime, type: ElementType) => t < (o.elemBurst[type] ?? -1);
  const stunned = (o: Runtime) => t < (o.elemBurst.neural ?? -1) || t < o.ts.selfFrozenUntil || t < o.sleepUntil || t < o.stunUntil;
  /** 元素損傷の回復（多い種類から） */
  const healElement = (o: Runtime, amount: number) => {
    for (const type of (Object.keys(o.elem) as ElementType[]).sort((a, b) => (o.elem[b] ?? 0) - (o.elem[a] ?? 0))) {
      if (amount <= 0) break;
      if (opBursting(o, type)) continue;
      const v = o.elem[type] ?? 0;
      const d = Math.min(v, amount);
      o.elem[type] = v - d;
      amount -= d;
    }
  };
  /** 味方が受ける元素損傷の倍率（素質・周囲の効果） */
  /** 仮想敵：泥濘に寄生されているか（ブロックしている泥濘） */
  const parasiteOf = (o: Runtime) => enemies.find((e) => e.alive && e.input.spec.parasite && e.blockedBy === o.input.uid);
  const opElementTaken = (o: Runtime) => {
    let m = 1 - (ELEMENT_TALENT[o.input.def.charId]?.elementResist ?? 0);
    // 寄生された味方は受ける元素損傷が増える
    const ps = parasiteOf(o)?.input.spec.parasite;
    if (ps) m *= ps.epTaken;
    for (const h of rt) {
      const tal = ELEMENT_TALENT[h.input.def.charId];
      if (!h.alive || !tal || o.input.pos === undefined || !h.rangeNormal?.has(o.input.pos)) continue;
      if (tal.auraElementResist) m *= 1 - tal.auraElementResist;
      if (tal.auraElementResistHalf && elemMax(o) > OP_ELEMENT_MAX / 2) m *= 1 - tal.auraElementResistHalf;
    }
    return m;
  };
  const addOpElement = (o: Runtime, type: ElementType, amount: number) => {
    if (!o.alive || amount <= 0 || opBursting(o, type)) return;
    amount *= opElementTaken(o);
    const tal = ELEMENT_TALENT[o.input.def.charId];
    // フィラエ：壊死損傷を受けるとSP回復、スキル中に元素損傷を受けると攻撃力上昇
    if (tal?.spOnApoptosis && type === 'apoptosis') o.sp += tal.spOnApoptosis;
    if (PHILAE[o.input.def.charId] && o.skillLeft > 0) o.philaeBoost = true;
    o.elem[type] = (o.elem[type] ?? 0) + amount;
    if ((o.elem[type] ?? 0) < OP_ELEMENT_MAX) return;
    // 爆発
    o.elemBurst[type] = t + OP_BURST_DURATION[type];
    opBursts++;
    // 寄生された味方が爆発すると、周囲4マスの他の味方に同じ種類の元素損傷
    const host = parasiteOf(o)?.input.spec.parasite;
    if (host && o.input.pos !== undefined) {
      const ox = cellX(o.input.pos);
      const oy = cellY(o.input.pos);
      for (const n of rt) {
        if (n === o || !n.alive || n.input.pos === undefined || Math.abs(cellX(n.input.pos) - ox) + Math.abs(cellY(n.input.pos) - oy) !== 1) continue;
        addOpElement(n, type, host.spread);
      }
    }
    if (type === 'neural') {
      // 神経損傷の爆発：スタン（ティティの堅守特性の対象）
      if (field && o.input.pos !== undefined) onSleepStun(o.input.pos);
      takeDamage(o, flatCut(o, 1000));
      for (const e of o.blocked) e.blockedBy = null;
      o.blocked = [];
    } else if (type === 'erosion') {
      o.erosionDef += 100;
      takeDamage(o, flatCut(o, mitigate(o, 800, false)));
    } else if (type === 'burning') {
      takeDamage(o, flatCut(o, mitigate(o, 1200, true)));
    }
  };

  /** 壊死の爆発で付く虚弱（攻撃力-50%から徐々に回復） */
  const weakFactor = (e: Enemy) => {
    const until = e.elemBurst.apoptosis ?? -1;
    if (t >= until) return 1;
    return 1 - 0.5 * ((until - t) / EN_BURST_DURATION.apoptosis);
  };
  const enBursting = (e: Enemy, type: ElementType) => t < (e.elemBurst[type] ?? -1);
  const addEnElement = (e: Enemy, type: ElementType, amount: number, src: Runtime) => {
    if (!e.alive || amount <= 0 || enBursting(e, type)) return;
    // ヴィルトゥオーサの素質：範囲内の敵が受ける壊死損傷が上昇
    if (type === 'apoptosis') {
      for (const u of rt) {
        const tal = ELEMENT_TALENT[u.input.def.charId];
        if (u.alive && tal?.auraApoptosisTaken && covers(u.rangeNormal, e)) amount *= tal.auraApoptosisTaken;
      }
    }
    e.elem[type] = (e.elem[type] ?? 0) + amount;
    // 上限：通常・エリートは1000、ボス（領袖）は2000
    if ((e.elem[type] ?? 0) < (e.input.spec.boss ? EN_ELEMENT_MAX_BOSS : EN_ELEMENT_MAX)) return;
    // 爆発
    e.elem[type] = 0;
    e.elemBurst[type] = t + EN_BURST_DURATION[type];
    e.elemSrc[type] = src;
    enBursts++;
    deal(src, e, EN_BURST_DAMAGE[type], 'element');
    if (type === 'erosion') {
      e.erosionDef += 120;
      e.defense.def = Math.max(0, e.defense.def - 120);
    }
    if (type === 'burning') e.defense.res = currentRes(e);
    onEnemyBurst(e, type);
  };
  /** 敵の元素損傷が爆発した時の素質（熾炎ブレイズ・ニンフ） */
  const onEnemyBurst = (e: Enemy, type: ElementType) => {
    for (const u of rt) {
      if (!u.alive) continue;
      const tal = ELEMENT_TALENT[u.input.def.charId];
      if (!tal) continue;
      if (type === 'burning' && tal.onBurnBurst) {
        // 熾炎ブレイズ：灼燃の爆発時に元素ダメージとHP回復、スキル中は弾薬+2
        deal(u, e, baseAtk(u.input.def, u.input.star, u.input.mods) * tal.onBurnBurst.scale, 'element');
        healUnit(u, u, u.maxHp * tal.onBurnBurst.heal);
        if (u.ammoLeft > 0) u.ammoLeft += u.skill.bb.ammo_recover ?? 0;
      }
      if (type === 'apoptosis' && tal.atkPerApoptosisBurst && covers(u.rangeNormal, e)) {
        u.talentStacks = Math.min(tal.atkPerApoptosisBurst.max, u.talentStacks + 1);
      }
    }
  };
  /** 弾薬を1発消費（【ラテラーノ】の攻撃力加算・堅守特性の加算を進め、使い切ったらスキル終了） */
  const useAmmo = (u: Runtime) => {
    u.ammoLeft--;
    u.ammoUsed++;
    if (g.laterano?.members.has(u.input.uid)) lateranoAmmo++;
    for (const ev of u.events) if (ev.kind === 'ammo' && u.ammoUsed % ev.every === 0) gainStacks(ev);
    if (u.ammoLeft === 0) endSkill(u);
  };
  /** サンクタ・ミキサー：スキル中に攻撃を受けると、攻撃範囲内の敵最大3体に反撃（弾薬1発消費。最小間隔は通常攻撃間隔の一定割合） */
  const mixerCounter = (u: Runtime) => {
    if (cid(u) !== MIXER || u.ammoLeft <= 0 || t < u.counterReadyAt) return;
    const targets = targetsInRange(u, true).slice(0, u.skill.maxTarget);
    if (!targets.length) return;
    u.counterReadyAt = t + unitState(u.input.def, u.input.star).stats.interval * (u.skill.bb.base_attack_time ?? 0.6);
    emit([2, u.input.uid, 1], `area${u.input.uid}`, 0.3);
    for (const e of targets) strike(u, e, u.curAtk, 1);
    useAmmo(u);
  };
  /** レミュアン：スキル中は0.5秒ごとに弾薬を1発消費して範囲内の敵を順次ロックオン */
  const lemuenLock = (u: Runtime) => {
    u.lockTimer -= dt;
    // ロックした敵が倒れた後も、最後にいた位置が残る
    for (const l of u.lockOns) if (l.e.alive) [l.x, l.y] = [l.e.x, l.e.y];
    while (u.ammoLeft > 0 && u.lockTimer <= 1e-9) {
      // 未ロックの敵を優先し、いなければロック回数の少ない敵（同点なら優先順）を重ねてロックオン。範囲内に敵がいなければ弾薬を消費せず待つ
      const locks = (c: Enemy) => u.lockOns.filter((l) => l.e === c).length;
      const e = targetsInRange(u, true).reduce<Enemy | undefined>((best, c) => (!best || locks(c) < locks(best) ? c : best), undefined);
      if (!e) {
        u.lockTimer = 0;
        break;
      }
      u.lockTimer += u.skill.bb['attack@aim_interval'] ?? 0.5;
      u.lockOns.push({ e, x: e.x, y: e.y });
      emit([10, u.input.uid, e.id]);
      useAmmo(u);
    }
  };
  /** レミュアン：スキル終了後、ロックオンした順に0.3秒間隔で爆撃する（最初はスキル終了の0.2秒後） */
  const lemuenBombard = (u: Runtime) => {
    const atk = u.curAtk;
    u.lockOns.forEach((l, i) => bombs.push({ at: t + LEMUEN_BOMB_FIRST + LEMUEN_BOMB_GAP * i, u, e: l.e, x: l.x, y: l.y, atk }));
    bombs.sort((a, b) => a.at - b.at);
    u.lockOns = [];
  };
  /**
   * 爆撃の着弾：ロックした敵がその時にいる位置（倒れていれば最後の位置）を中心とした一辺0.4の正方形のランダムな位置に落ちて、
   * 半径内の敵に範囲物理ダメージ（爆心地は倍率が高い）。1発は同じ敵に1回だけ、n発ならn回当たる
   */
  const landBombs = () => {
    for (const b of bombs) if (b.e.alive) [b.x, b.y] = [b.e.x, b.e.y];
    while (bombs.length && bombs[0].at <= t + 1e-9) {
      const b = bombs.shift()!;
      const bb = b.u.skill.bb;
      const x = b.x + (rand() - 0.5) * LEMUEN_BOMB_SPREAD;
      const y = b.y + (rand() - 0.5) * LEMUEN_BOMB_SPREAD;
      emit([11, b.u.input.uid, Math.round(x * 100), Math.round(y * 100), Math.round(LEMUEN_BOMB_FALL * 100)]);
      if (!field) {
        if (b.e.alive) strike(b.u, b.e, b.atk, bb['attack@proj_atk_scale_1'] ?? 0);
        continue;
      }
      for (const e of enemies) {
        if (!e.alive || !e.spawned) continue;
        const d = Math.hypot(e.x - x, e.y - y);
        const scale = d <= (bb['attack@dist_1'] ?? 0.8) ? (bb['attack@proj_atk_scale_1'] ?? 0) : d <= (bb['attack@dist_2'] ?? 1.5) ? (bb['attack@proj_atk_scale_2'] ?? 0) : 0;
        if (scale > 0) strike(b.u, e, b.atk, scale);
      }
    }
  };
  /** レミュアンの素質：【エリート】・【ボス】が【ラテラーノ】の攻撃範囲内に8秒滞在すると指名手配 */
  const tickWanted = () => {
    const lem = rt.find((o) => o.alive && cid(o) === LEMUEN);
    if (!lem) return;
    const need = lem.tb[0].interval ?? 8;
    const laterano = rt.filter((o) => o.alive && o.input.pos !== undefined && o.input.def.bonds.includes('laterano'));
    for (const e of enemies) {
      if (!e.alive || !e.spawned || e.wanted || !(e.input.spec.elite || e.input.spec.boss)) continue;
      // 滞在は連続（範囲の外に出たら数え直す）
      if (!laterano.some((o) => covers(o.skillLeft > 0 || o.ammoLeft > 0 ? o.rangeSkill : o.rangeNormal, e))) {
        e.wantedTime = 0;
        continue;
      }
      e.wantedTime += dt;
      if (e.wantedTime >= need) e.wanted = true;
    }
  };
  /** フィラエ：スキル中に攻撃を受けると周囲の地上の敵に反撃（2秒に1回） */
  const philaeCounter = (u: Runtime) => {
    const ph = PHILAE[u.input.def.charId];
    if (!ph || u.skillLeft <= 0 || t < u.counterReadyAt || u.input.pos === undefined) return;
    u.counterReadyAt = t + (u.skill.bb.aoe_cd ?? 2);
    const p = posOf(u);
    const atk = baseAtk(u.input.def, u.input.star, u.input.mods, u.skill.atkPct * (u.philaeBoost ? 1 : 0));
    for (const e of enemies) {
      if (!e.alive || e.input.spec.flying || Math.hypot(e.x - p.x, e.y - p.y) > ph.radius) continue;
      strike(u, e, atk, u.skill.bb.atk_scale ?? 1);
      addEnElement(e, 'apoptosis', atk * (u.skill.bb.ep_damage_ratio ?? 0), u);
    }
  };
  /** 元素損傷の継続効果（毎フレーム） */
  const tickElements = () => {
    for (const o of rt) {
      if (!o.alive) continue;
      for (const type of Object.keys(o.elemBurst) as ElementType[]) {
        const until = o.elemBurst[type] ?? -1;
        if (t < until) {
          // 爆発中は蓄積が徐々に0へ
          o.elem[type] = Math.max(0, (o.elem[type] ?? 0) - (OP_ELEMENT_MAX / OP_BURST_DURATION[type]) * dt);
          if (type === 'apoptosis') {
            o.sp = Math.max(0, o.sp - dt);
            takeDps(o, mitigate(o, 100, true));
          }
        } else if (until >= 0) {
          o.elemBurst[type] = -1;
          o.elem[type] = 0;
        }
      }
      // ユーの素質：4人以上配置されていればHPと元素損傷を毎秒回復
      const tal = ELEMENT_TALENT[o.input.def.charId];
      if (tal?.regenWithAllies && rt.filter((x) => x.alive).length >= 4) {
        healUnit(o, o, o.maxHp * tal.regenWithAllies * dt);
        healElement(o, o.maxHp * tal.regenWithAllies * dt);
      }
      // ユーの素質：ブロック中の敵に毎秒術ダメージと灼燃損傷
      if (tal?.blockedDot && o.blocked.length) {
        const atk = baseAtk(o.input.def, o.input.star, o.input.mods);
        for (const e of [...o.blocked]) {
          deal(o, e, hitDamage(atk * tal.blockedDot.arts, 'arts', effDefense(e), o.input.mods) * dt, 'arts');
          addEnElement(e, 'burning', atk * tal.blockedDot.burn * dt, o);
        }
      }
      // ヴィルトゥオーサの素質：攻撃範囲内の敵に毎秒壊死損傷
      if (tal?.auraApoptosis) {
        const atk = baseAtk(o.input.def, o.input.star, o.input.mods);
        for (const e of enemies) if (e.alive && covers(o.rangeNormal, e)) addEnElement(e, 'apoptosis', atk * tal.auraApoptosis * dt, o);
      }
    }
    for (const e of enemies) {
      if (!e.alive) continue;
      // 壊死の爆発中は毎秒800の元素ダメージ
      if (enBursting(e, 'apoptosis') && e.elemSrc.apoptosis) deal(e.elemSrc.apoptosis, e, 800 * dt, 'element');
      if (e.nymphDot && enBursting(e, 'apoptosis')) deal(e.nymphDot.src, e, e.nymphDot.dps * dt, 'element');
      else e.nymphDot = null;
      // 灼燃の爆発が終わったら術耐性が戻る
      if (e.elemBurst.burning !== undefined && e.elemBurst.burning >= 0 && t >= e.elemBurst.burning) {
        e.elemBurst.burning = -1;
        e.defense.res = currentRes(e);
      }
    }
  };

  // ---- 医療以外の治療 ----
  const posOf = (u: Runtime) => ({ x: cellX(u.input.pos ?? 0), y: cellY(u.input.pos ?? 0) });
  /** 位置の周囲にいる味方（HP割合の低い順） */
  const alliesNear = (x: number, y: number, r: number) =>
    rt
      .filter((o) => o.alive && o.input.pos !== undefined && Math.hypot(posOf(o).x - x, posOf(o).y - y) <= r)
      .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
  const injuredNear = (u: Runtime, r = SUPPORT_HEAL_RADIUS) => {
    const p = posOf(u);
    return alliesNear(p.x, p.y, r).filter((o) => o.hp < o.maxHp - 1e-6 && (o === u || !SELF_HEAL_SUB[o.input.def.subProfession]));
  };
  /** 錬金ユニットの効果範囲 */
  /** 敵の汚染秽蝕：範囲内の味方は毎秒HPを失う（防御・術耐性無視） */
  const pollutions: { x: number; y: number; radius: number; high: number; low: number; until: number; duration: number }[] = [];
  const tickPollution = () => {
    for (const z of pollutions) {
      if (t >= z.until) continue;
      for (const o of alliesNear(z.x, z.y, z.radius)) takeDps(o, o.hp / o.maxHp > 0.5 ? z.high : z.low);
    }
  };
  const zones: { owner: Runtime; x: number; y: number; r: number; until: number; atk: number; heal: number; dot: number; groundOnly: boolean }[] = [];
  const tickZones = () => {
    for (const z of zones) {
      if (t >= z.until || !z.owner.alive) continue;
      for (const o of alliesNear(z.x, z.y, z.r)) healUnit(z.owner, o, z.atk * z.heal * dt);
      if (z.dot > 0) {
        for (const e of enemies) {
          if (!e.alive || (z.groundOnly && e.input.spec.flying) || Math.hypot(e.x - z.x, e.y - z.y) > z.r) continue;
          deal(z.owner, e, hitDamage(z.atk * z.dot, 'arts', effDefense(e), z.owner.input.mods, artsVuln(e)) * dt, 'arts');
        }
      }
    }
  };

  /** 敵の攻撃：ブロックされていればブロックしている相手、遠距離は範囲内で最後に配置された相手（警報器を優先） */
  // ------------------------------------------------------------
  // 素質（戦闘中に変化するもの）
  // ------------------------------------------------------------
  const posXY = (u: Runtime) => ({ x: cellX(u.input.pos ?? 0), y: cellY(u.input.pos ?? 0) });
  const enemiesInRange = (u: Runtime) => enemies.filter((e) => e.alive && e.spawned && !!covers(u.rangeNormal, e));
  const enemiesNear = (u: Runtime, r: number) => {
    const p = posXY(u);
    return enemies.filter((e) => e.alive && e.spawned && Math.hypot(e.x - p.x, e.y - p.y) <= r);
  };
  /** 素質の持ち主（場にいる） */
  const holders = (id: string) => rt.filter((w) => w.alive && cid(w) === id);

  /** 攻撃力（割合）の上昇 */
  const talentAtkPct = (u: Runtime): number => {
    const [b0, b1] = u.tb;
    const ts = u.ts;
    switch (cid(u)) {
      case 'char_373_lionhd': // レオンハルト：攻撃範囲内の敵の数だけ攻撃力上昇
        return (b0.atk ?? 0) * Math.min(b0.max_valid_stack_cnt ?? 5, enemiesInRange(u).length);
      case 'char_472_pasngr': // パッセンジャー：隣接4マスに敵がいなければ攻撃力上昇
        return b1.atk !== undefined && !enemiesNear(u, 1.01).length ? b1.atk : 0;
      case 'char_437_mizuki': // ミヅキ：攻撃範囲内にHP50%未満の敵がいれば攻撃力上昇
        return b1.atk !== undefined && enemiesInRange(u).some((e) => e.hp / e.maxHp < (b1.hp_ratio ?? 0.5)) ? b1.atk : 0;
      case 'char_4040_rockr': // ロックロック：配置中、一定時間ごとに攻撃力上昇
      case 'char_202_demkni': // サリア：配置中、一定時間ごとに攻撃力・防御力上昇
        return (b0.atk ?? 0) * Math.min(b0.max_stack_cnt ?? 0, Math.floor((t - ts.deployedAt) / Math.max(1, b0.interval ?? 15)));
      case 'char_430_fartth': // ファートゥース：一定時間攻撃を受けていなければ攻撃力上昇
        return t - ts.lastHitAt >= (b0.delay ?? 10) ? (b0.atk ?? 0) : 0;
      case 'char_341_sntlla': // サンタラ：配置から一定時間後に攻撃力上昇
        return t - ts.deployedAt >= (b0.interval ?? 20) ? (b0.atk ?? 0) : 0;
      case 'char_2015_dusk': // シー：撃破ごとに攻撃力上昇
        return (b0.atk ?? 0) * ts.killStacks;
      case 'char_1026_gvial2': // 百錬ガヴィル：ブロック中の敵1体ごとに攻撃力上昇
        return (b0.atk_add ?? 0) * u.blocked.length;
      case 'char_1028_texas2': // 血掟テキサス：スキル発動中は攻撃力上昇
        return u.skillLeft > 0 ? (b0.atk ?? 0) : 0;
      case 'char_4146_nymph':
      default:
        return 0;
    }
  };
  /** 攻撃力（固定値）の上昇 */
  const talentAtkFlat = (u: Runtime) => u.ts.killAtk + u.ts.stealAtk;
  /** 防御力（固定値）の上昇（サンクタ・ミキサー：ダメージを与えるたびに10秒間） */
  const talentDefFlat = (u: Runtime) => (cid(u) === MIXER && t - u.ts.lastDealtAt < (u.tb[0].duration ?? 10) ? u.ts.mixer * (u.tb[0].def ?? 0) : 0);
  /** 攻撃速度の上昇 */
  const talentAspd = (u: Runtime): number => {
    const [b0, b1] = u.tb;
    const ts = u.ts;
    switch (cid(u)) {
      case 'char_337_utage': {
        // ウタゲ：HPが減るほど攻撃速度上昇（最大HPの70%減少で最大）
        const lost = 1 - u.hp / u.maxHp;
        return (b0.min_attack_speed ?? 0) * Math.max(0, Math.min(1, lost / Math.max(0.01, 1 - (b0.min_hp_ratio ?? 0.3))));
      }
      case 'char_4087_ines': // イネスS2：奪った攻撃速度
        return ts.stealAspd;
      case 'char_4194_rmixer': // サンクタ・ミキサー：ダメージを与えるたびに攻撃速度上昇（10秒）
        return t - ts.lastDealtAt < (b0.duration ?? 10) ? ts.mixer * (b0.attack_speed ?? 0) : 0;
      case 'char_4196_reckpr': // レコードキーパー：範囲内の味方のスキル発動で攻撃速度上昇
        return t < ts.reckUntil ? (b0.attack_speed ?? 0) : 0;
      case 'char_4039_horn': // ホルン：血戦
        return ts.bloodBattle ? (b1.attack_speed ?? 0) : 0;
      case 'char_1028_texas2': // 血掟テキサス：最初の撃破まで攻撃速度上昇
        return !ts.firstKill ? (b1.attack_speed ?? 0) : 0;
      default:
        return 0;
    }
  };
  /** 通常攻撃の倍率（対象ごと） */
  const talentScale = (u: Runtime, e: Enemy, skillOn: boolean): number => {
    const [b0] = u.tb;
    let m = 1;
    const crit = CRIT_TALENT[cid(u)];
    if (crit) {
      const b = u.tb[crit[0]];
      m *= 1 + (b[crit[1]] ?? 0) * ((b[crit[2]] ?? 1) - 1);
    }
    switch (cid(u)) {
      case 'char_306_leizi': // レイズ：ブロックされていない敵に攻撃力上昇
        if (e.blockedBy === null) m *= b0.atk_scale ?? 1;
        break;
      case 'char_126_shotst': // メテオ：飛行の敵に攻撃力上昇
        if (e.input.spec.flying) m *= b0.atk_scale ?? 1;
        break;
      case 'char_4064_mlynar': // ムリナール：攻撃力上昇（周囲に敵3体以上でさらに）
        m *= enemiesNear(u, 1.5).length >= (b0.cnt ?? 3) ? (b0.atk_scale_up ?? 1) : (b0.atk_scale_base ?? 1);
        break;
      case 'char_1032_excu2': // 聖約イグゼキュター：確率で追加攻撃（期待値）
        m *= 1 + Math.min(1, (b0.prob ?? 0) + (skillOn ? (b0.prob_add ?? 0) * u.ammoUsed : 0));
        break;
    }
    return m;
  };
  /** 与ダメージ倍率（素質の脆弱など。対象・ダメージ種別ごと） */
  const talentDamageMult = (u: Runtime, e: Enemy, type: DamageType): number => {
    let vuln = 1;
    for (const w of rt) {
      if (!w.alive || !covers(w.rangeNormal, e)) continue;
      const [b0] = w.tb;
      switch (cid(w)) {
        case 'char_4079_haini': // ルシーラ：エリート・ボス以外に脆弱
          if (!e.input.spec.boss && !e.input.spec.elite) vuln = Math.max(vuln, b0.damage_scale ?? 1);
          break;
        case 'char_174_slbell': // プラマニクス：HP40%未満の敵に脆弱
          if (e.hp / e.maxHp < (b0.hp_ratio ?? 0.4)) vuln = Math.max(vuln, b0.damage_scale ?? 1);
          break;
        case 'char_206_gnosis': // ノーシス：寒冷の敵に脆弱（凍結は倍）
          if (isFrozen(e)) vuln = Math.max(vuln, b0.damage_scale_freeze ?? 1);
          else if (isChilled(e)) vuln = Math.max(vuln, b0.damage_scale_cold ?? 1);
          break;
        case 'char_1047_halo2': {
          // 溯光アステジーニ：範囲内の敵に脆弱（7秒以上いると上昇。出現からの時間で近似）
          const base = w.tb[1]['halo2_t_1[weak].damage_scale'] !== undefined ? w.tb[1] : b0;
          const sc = base['halo2_t_1[weak].damage_scale'];
          if (sc) vuln = Math.max(vuln, t - e.input.spawnAt >= (base['halo2_t_1[weak].interval'] ?? 7) ? (base['halo2_t_1[weak].damage_scale_max'] ?? sc) : sc);
          break;
        }
      }
    }
    let m = vuln;
    const [b0] = u.tb;
    // 焔影リードの灼痕：術ダメージ上昇
    if (type === 'arts' && t < e.reedUntil) m *= 1.3;
    switch (cid(u)) {
      case 'char_472_pasngr': // パッセンジャー：HP80%以上の敵への与ダメージ上昇
        if (e.hp / e.maxHp >= (b0.hp_ratio ?? 0.8)) m *= b0['pasngr_t_1[enhance].damage_scale'] ?? 1;
        break;
      case 'char_446_aroma': // アロマ：敵ごとに最初の一撃の攻撃力上昇
        if (!u.ts.firstHit.has(e.id)) m *= b0.damage_scale ?? 1;
        break;
    }
    return m;
  };
  /** ダメージを与えた後の素質 */
  const talentOnDealt = (u: Runtime, e: Enemy, atk: number) => {
    const [b0, b1] = u.tb;
    const ts = u.ts;
    if (t - ts.lastDealtAt >= (b0.duration ?? 10)) ts.mixer = 0;
    ts.lastDealtAt = t;
    const first = !ts.firstHit.has(e.id);
    if (first) ts.firstHit.set(e.id, t);
    const res = effDefense(e);
    switch (cid(u)) {
      case 'char_4194_rmixer':
        ts.mixer = Math.min(b0.max_stack_cnt ?? 3, ts.mixer + 1);
        break;
      case 'char_4137_udflow': // アンダーフロー：継続術ダメージ
        e.dots.set(u, { until: t + (b0.duration ?? 3), dps: b0.damage ?? 0 });
        break;
      case 'char_4010_etlchi': // エンテレケイア：継続術ダメージと最大HPの奪取
        e.dots.set(u, { until: t + (b0.dot_duration ?? 5), dps: b0.magic_value ?? 0 });
        if (u.maxHp - u.baseMaxHp < (b0['attack@steal_hp_max'] ?? 0)) {
          const steal = b0['attack@steal_hp'] ?? 0;
          u.maxHp += steal;
          u.hp += steal;
          deal(u, e, steal, 'true');
        }
        break;
      case 'char_4026_vulpis': // ウルピスフォリア：最初に当ててから10秒間、追加の術ダメージ
        if (t - (ts.firstHit.get(e.id) ?? t) <= (b0.interval ?? 10)) deal(u, e, hitDamage(atk * (b0.atk_scale ?? 0), 'arts', res, u.input.mods), 'arts');
        break;
      case 'char_1020_reed2': // 焔影リード：確率で灼痕（期待値）
        ts.reedAcc += b0.prob ?? 0;
        if (ts.reedAcc >= 1) {
          ts.reedAcc -= 1;
          e.reedUntil = t + (b0.duration ?? 6);
        }
        break;
      case 'char_4087_ines': {
        // イネスの素質：敵ごとに一度だけ、バインドと攻撃力の奪取（奪った攻撃力は対象が倒れても自身に残る）
        if (first) {
          rootEnemy(e, b0.duration ?? 0);
          const steal = Math.min(b0.steal_atk ?? 0, Math.max(0, (b0.steal_atk_max ?? 0) - ts.stealAtk));
          if (steal > 0) {
            ts.stealAtk += steal;
            e.stolenAtk.set(u, (e.stolenAtk.get(u) ?? 0) + steal);
          }
        }
        // S2：攻撃するたびに対象の攻撃速度を奪う（合計の上限あり。スキル終了・退場まで）
        const sb = u.skill.bb;
        if (u.skillLeft > 0 && sb['attack@steal_atk_speed']) {
          const steal = Math.min(sb['attack@steal_atk_speed'], Math.max(0, (sb['attack@steal_atk_speed_max'] ?? 0) - ts.stealAspd));
          if (steal > 0) {
            ts.stealAspd += steal;
            e.stolenAspd.set(u, (e.stolenAspd.get(u) ?? 0) + steal);
          }
        }
        break;
      }
      case 'char_206_gnosis': // ノーシス：攻撃時に寒冷
        if (b0.cold) applyCold(e, b0.cold);
        break;
    }
    void b1;
  };
  /** 被弾時の素質。ダメージを無効化したら true */
  const talentOnHurt = (u: Runtime, arts: boolean, src: Enemy): boolean => {
    const [b0, b1] = u.tb;
    const ts = u.ts;
    const prevHit = ts.lastHitAt;
    ts.lastHitAt = t;
    // バブル：攻撃した敵の攻撃力低下
    if (cid(u) === 'char_381_bubble') src.bubbleUntil = t + (b0.duration ?? 5);
    // 聖聆プラマニクス：攻撃した敵を寒冷に
    if (cid(u) === 'char_1046_sbell2' && b1.cold) applyCold(src, b1.cold);
    // リスカム：自身と隣接する味方1人のSP回復
    if (cid(u) === 'char_107_liskam') {
      u.sp += b0.sp ?? 0;
      const p = posXY(u);
      const ally = rt
        .filter((o) => o !== u && o.alive && o.input.pos !== undefined && Math.abs(cellX(o.input.pos) - p.x) + Math.abs(cellY(o.input.pos) - p.y) === 1)
        .sort((a, b) => a.sp / Math.max(1, a.skill.spCost) - b.sp / Math.max(1, b.skill.spCost))[0];
      if (ally) ally.sp += b0.sp ?? 0;
    }
    // ウルピアヌス：ダメージを受けるたびにHP回復
    if (cid(u) === 'char_4145_ulpia') healUnit(u, u, u.hp / u.maxHp <= (b0.hp_ratio ?? 0.5) ? (b0.value2 ?? 0) : (b0.value1 ?? 0));
    // ティッピ：一定時間攻撃を受けていなければ次のダメージを回避
    if (cid(u) === 'char_4191_tippi' && t - prevHit >= (b0.stack_time ?? 9)) return true;
    // マドロック：シールドで被ダメージを無効化し、HP回復
    if (cid(u) === 'char_311_mudrok' && ts.shields > 0) {
      ts.shields--;
      healUnit(u, u, u.maxHp * (b0.hp_ratio ?? 0));
      return true;
    }
    // アルケット：配置後のシールド（1回）でSP回復
    if (cid(u) === 'char_332_archet' && !ts.archShield && b1.sp) {
      ts.archShield = true;
      u.sp += b1.sp;
      return true;
    }
    // ホシグマ：確率で被ダメージ無効（期待値）
    if (cid(u) === 'char_136_hsguma') {
      ts.nullAcc += b0.prob ?? 0;
      if (ts.nullAcc >= 1) {
        ts.nullAcc -= 1;
        return true;
      }
    }
    // 物理回避（マウンテン・フレイムテイルの付与。期待値）
    const ev = u.input.mods.evadePhys ?? 0;
    if (!arts && ev > 0) {
      ts.evadeAcc += ev;
      if (ts.evadeAcc >= 1) {
        ts.evadeAcc -= 1;
        return true;
      }
    }
    return false;
  };
  /** 被ダメージの倍率 */
  const talentTakenMult = (u: Runtime, arts: boolean): number => {
    const [b0, b1] = u.tb;
    switch (cid(u)) {
      case 'char_4064_mlynar':
        return enemiesNear(u, 1.5).length >= (b0.cnt ?? 3) ? 1 - (b0.damage_resistance ?? 0) : 1;
      case 'char_1028_texas2':
        return !u.ts.firstKill ? 1 - (b1.damage_resistance ?? 0) : 1;
      case 'char_4010_etlchi':
        return u.ts.saveUsed && !arts ? 1 - (b1.damage_resistance ?? 0) : 1;
      default:
        return 1;
    }
  };
  /** 致命傷を受けた時の素質。耐えたら true */
  const talentOnDown = (u: Runtime): boolean => {
    const [, b1] = u.tb;
    const ts = u.ts;
    if (ts.saveUsed) return false;
    switch (cid(u)) {
      case 'char_350_surtr': // スルト：HP1で耐え、8秒後に強制退場
        if (!b1['surtr_t_2[withdraw].interval']) return false;
        ts.saveUsed = true;
        u.hp = 1;
        ts.surtrUntil = t + b1['surtr_t_2[withdraw].interval'];
        return true;
      case 'char_4039_horn': // ホルン：血戦（最大HP-50%、全回復、攻撃速度・防御力上昇）
        if (b1.max_hp === undefined) return false;
        ts.saveUsed = true;
        ts.bloodBattle = true;
        u.maxHp *= 1 - b1.max_hp;
        u.hp = u.maxHp;
        u.def *= 1 + (b1.def ?? 0);
        return true;
      case 'char_1046_sbell2': {
        // 聖聆プラマニクス：全回復し、自身は凍結、攻撃範囲内の敵を凍結
        if (b1.freeze === undefined) return false;
        ts.saveUsed = true;
        u.hp = u.maxHp;
        ts.selfFrozenUntil = t + b1.freeze;
        for (const e of enemiesInRange(u)) {
          e.frozenUntil = Math.max(e.frozenUntil, t + (b1.c2e_freeze ?? 8));
          e.defense.res = currentRes(e);
        }
        return true;
      }
      default:
        return false;
    }
  };
  /** 敵が倒れた時の素質 */
  const talentOnKill = (e: Enemy, by: Runtime) => {
    const [b0, b1] = by.tb;
    switch (cid(by)) {
      case 'char_2015_dusk':
        by.ts.killStacks = Math.min(b0.max_stack_cnt ?? 15, by.ts.killStacks + 1);
        break;
      case 'char_4145_ulpia': {
        // ウルピアヌス：撃破ごとに攻撃力・最大HP上昇。他のアビサルハンターは半分
        const b = b1.atk !== undefined ? b1 : b0;
        if (by.ts.killStacks < (b.max_stack_cnt ?? 9)) {
          by.ts.killStacks++;
          by.ts.killAtk += b.atk ?? 0;
          by.maxHp += b.max_hp ?? 0;
          by.hp += b.max_hp ?? 0;
          for (const o of rt) {
            if (o === by || !o.alive || !ABYSSAL.has(cid(o))) continue;
            o.ts.killAtk += b['ulpia_t_1[abyssal].atk'] ?? 0;
            o.maxHp += b['ulpia_t_1[abyssal].max_hp'] ?? 0;
            o.hp += b['ulpia_t_1[abyssal].max_hp'] ?? 0;
          }
        }
        break;
      }
      case 'char_1028_texas2':
        by.ts.firstKill = true;
        // テキサスの流儀：撃破でHP全回復し、スキルをもう一度（1回のみ）
        if (by.skillLeft > 0 && !by.ts.recast) {
          by.ts.recast = true;
          by.hp = by.maxHp;
          by.skillLeft = by.skill.duration;
          by.result.skillCasts++;
          if (by.skill.onDeploy) texasAppear(by);
        }
        break;
      case 'char_4058_pepe':
        if (by.skillLeft > 0) by.ts.pepeKills++;
        break;
    }
    // エステル：周囲8マスで敵が倒れるとHP回復
    const tile = enemyTile(e);
    for (const w of holders('char_127_estell')) {
      if (w.input.pos === undefined) continue;
      if (Math.abs(cellX(tile) - cellX(w.input.pos)) <= 1 && Math.abs(cellY(tile) - cellY(w.input.pos)) <= 1) healUnit(w, w, w.maxHp * (w.tb[0].hp_ratio ?? 0));
    }
    // ワルファリン：攻撃範囲内で敵が倒れると自身と範囲内の味方1人のSP回復
    for (const w of holders('char_171_bldsk')) {
      if (!covers(w.rangeNormal, e)) continue;
      w.sp += w.tb[0]['bldsk_t_1[self].sp'] ?? 0;
      const ally = alliesInRange(w, false)
        .filter((o) => o !== w && o.skill.spCost > 0)
        .sort((a, b) => a.sp / a.skill.spCost - b.sp / b.skill.spCost)[0];
      if (ally) ally.sp += w.tb[0]['bldsk_t_1[rand].sp'] ?? 0;
    }
  };
  /** スキル発動時の素質 */
  const talentOnCast = (u: Runtime) => {
    // カーネリアン：スキル発動時にHP回復
    if (cid(u) === 'char_426_billro') healUnit(u, u, u.maxHp * (u.tb[0].heal_scale ?? 0));
    // レコードキーパー：攻撃範囲内の味方がスキルを発動するとSP回復・攻撃速度上昇
    for (const w of holders('char_4196_reckpr')) {
      if (w === u || u.input.pos === undefined || !w.rangeNormal?.has(u.input.pos)) continue;
      w.sp += w.tb[0].sp ?? 0;
      w.ts.reckUntil = t + (w.tb[0].duration ?? 8);
    }
  };
  /** スキル終了時の素質 */
  const talentOnSkillEnd = (u: Runtime) => {
    const [b0] = u.tb;
    // ヴェトチキ：スキル終了時にHP回復
    if (cid(u) === 'char_4207_branch') healUnit(u, u, u.maxHp * (b0.hp_ratio ?? 0));
    // ペペ：スキル中の撃破数だけSP回復
    if (cid(u) === 'char_4058_pepe') {
      u.sp += Math.min((b0.sp ?? 0) * u.ts.pepeKills, b0.max_sp ?? 0);
      u.ts.pepeKills = 0;
    }
  };
  /** 毎フレームの素質（継続回復・時間で増える効果など） */
  const tickTalents = () => {
    for (const u of rt) {
      if (!u.alive) continue;
      const [b0, b1] = u.tb;
      const ts = u.ts;
      // スルト：強制退場
      if (ts.surtrUntil !== null && t >= ts.surtrUntil) {
        ts.surtrUntil = null;
        leaveField(u);
        continue;
      }
      switch (cid(u)) {
        case 'char_181_flower': // パフューマー：味方全員を継続回復
          for (const o of rt) if (o.alive) healUnit(u, o, baseAtk(u.input.def, u.input.star, u.input.mods) * (b0.atk_to_hp_recovery_ratio ?? 0) * dt);
          break;
        case 'char_291_aglina': // アンジェリーナ：スキル未使用時、味方全員を継続回復
          if (u.skillLeft <= 0 && b1.hp_recovery_per_sec) for (const o of rt) if (o.alive) healUnit(u, o, b1.hp_recovery_per_sec * dt);
          break;
        case 'char_332_archet': // アルケット：狙撃の攻撃回復スキルのSPを定期的に回復
          ts.timer -= dt;
          if (ts.timer <= 0) {
            ts.timer += b0.interval ?? 2.5;
            for (const o of rt) if (o.alive && o.input.def.profession === 'sniper' && o.skill.charge === 'attack' && o.skillLeft <= 0 && o.ammoLeft <= 0) o.sp += b0.sp ?? 0;
          }
          break;
        case 'char_4026_vulpis': // ウルピスフォリア：一定時間ダメージを受けていなければ継続回復
          if (t - ts.lastHitAt >= (b1.interval ?? 4)) healUnit(u, u, u.maxHp * (b1['vulpis_t_2[heal][interval].hp_recovery_per_sec_by_max_hp_ratio'] ?? 0) * dt);
          break;
        case 'char_311_mudrok': // マドロック：一定時間ごとにシールド（最大3枚）
          ts.shieldTimer -= dt;
          if (ts.shieldTimer <= 0) {
            ts.shieldTimer += b0.interval ?? 9;
            ts.shields = Math.min(b0.max_times ?? 3, ts.shields + 1);
          }
          break;
        case 'char_4194_rmixer': {
          // サンクタ・ミキサー：バリアが無い間に8秒間通常攻撃しないと、最大HPの一定割合のバリアを得る（失った時点から数え直す）
          if (u.barrier > 0) ts.barrierTimer = 0;
          else if ((ts.barrierTimer += dt) >= (b1.interval ?? 8)) {
            ts.barrierTimer = 0;
            u.barrier = u.maxHp * (b1.shield ?? 0);
            u.barrierBy = u;
          }
          break;
        }
        case 'char_202_demkni': // サリア：防御力も時間で上昇
          u.def = u.baseDef * (1 + (b0.def ?? 0) * Math.min(b0.max_stack_cnt ?? 0, Math.floor((t - ts.deployedAt) / Math.max(1, b0.interval ?? 20))));
          break;
        case 'char_1026_gvial2': // 百錬ガヴィル：ブロック数に応じた防御力
          u.def = u.baseDef * (1 + (b0.def_add ?? 0) * u.blocked.length);
          break;
      }
    }
    // 素質の継続術ダメージ
    for (const e of enemies) {
      if (!e.alive || !e.dots.size) continue;
      for (const [src, d] of e.dots) {
        if (t >= d.until) {
          e.dots.delete(src);
          continue;
        }
        deal(src, e, hitDamage(d.dps * dt, 'arts', effDefense(e), src.input.mods), 'arts');
      }
    }
  };
  /** イネスの素質「影哨」が及ぶ：イネスの今の攻撃範囲（S2中は拡大した範囲）か、撤退後に残した影哨の範囲 */
  const inSentinel = (w: Runtime, e: Enemy) =>
    cid(w) === 'char_4087_ines' &&
    w.tb[1].move_speed !== undefined &&
    ((w.alive && covers(w.skillLeft > 0 ? w.rangeSkill : w.rangeNormal, e)) || covers(inesSentinels.get(w), e));
  /** 敵の移動速度の倍率（モスティマ・イネスの減速） */
  const talentSlow = (e: Enemy): number => {
    let slow = 0;
    for (const w of rt) {
      if (inSentinel(w, e)) slow = Math.max(slow, -(w.tb[1].move_speed ?? 0));
      if (!w.alive || !covers(w.rangeNormal, e)) continue;
      if (cid(w) === 'char_213_mostma') slow = Math.max(slow, -(w.tb[1].move_speed ?? 0));
      // 帰溟スペクター：身替りの間、周囲の敵の移動速度低下
      if (cid(w) === GHOST2 && inDoll(w)) slow = Math.max(slow, -(w.tb[0].move_speed ?? 0));
    }
    return 1 - slow;
  };
  /** ステルスを無効にする素質（シルバーアッシュ・イネス） */
  const revealed = (e: Enemy) =>
    rt.some(
      (w) =>
        inSentinel(w, e) ||
        (w.alive && covers(w.rangeNormal, e) && cid(w) === 'char_172_svrash' && (unitState(w.input.def, w.input.star).talents?.length ?? 0) >= 2),
    );
  const sumOf = (m: Map<Runtime, number>) => {
    let v = 0;
    for (const x of m.values()) v += x;
    return v;
  };
  /** 敵の攻撃速度の倍率（イネスS2に奪われた攻撃速度。敵の攻撃速度は100として扱う） */
  const enemyAspdRate = (e: Enemy) => (e.stolenAspd.size ? Math.max(20, 100 - sumOf(e.stolenAspd)) / 100 : 1);
  /** 敵の攻撃力（素質の弱体化） */
  const enemyAtk = (e: Enemy, atk: number) =>
    Math.max(0, atk * (enemyGroundTile(e) === 'infection' ? 1 + INFECTION.atk : 1) * (t < e.bubbleUntil ? 1 + (holders('char_381_bubble')[0]?.tb[0].atk ?? -0.08) : 1) * (t < e.reedUntil ? 0.8 : 1) - sumOf(e.stolenAtk));

  // ------------------------------------------------------------
  // マップの特殊なマス
  // ------------------------------------------------------------
  /** 活性源石：攻撃力+20%・攻撃速度+20、毎秒HP-70（味方・敵とも） */
  const INFECTION = { atk: 0.2, aspd: 20, dps: 70 };
  /** 沼地：味方の攻撃速度-30、敵の移動速度・攻撃速度が下がる。深水区：敵の移動速度・攻撃速度が下がり、毎秒HPを失う */
  const MIRE = { aspd: -30, enemySpeed: 0.6, enemyAtkRate: 0.7 };
  const DEEPSEA = { enemySpeed: 0.6, enemyAtkRate: 0.7, dps: 100 };
  const unitTile = (u: Runtime) => (field && u.input.pos !== undefined ? tileAt(u.input.pos) : null);
  const enemyGroundTile = (e: Enemy) => (field && !e.input.spec.flying && e.spawned ? tileAt(enemyTile(e)) : null);
  const tileAtkPct = (u: Runtime) => (unitTile(u) === 'infection' ? INFECTION.atk : 0);
  const tileAspd = (u: Runtime) => (unitTile(u) === 'infection' ? INFECTION.aspd : unitTile(u) === 'mire' ? MIRE.aspd : 0);
  const tileEnemySpeed = (e: Enemy) => {
    const tl = enemyGroundTile(e);
    return tl === 'mire' ? MIRE.enemySpeed : tl === 'deepsea' ? DEEPSEA.enemySpeed : 1;
  };
  const tileEnemyAtkRate = (e: Enemy) => {
    const tl = enemyGroundTile(e);
    return tl === 'infection' ? 1 + INFECTION.aspd / 100 : tl === 'mire' ? MIRE.enemyAtkRate : tl === 'deepsea' ? DEEPSEA.enemyAtkRate : 1;
  };
  const tickTiles = () => {
    if (!field) return;
    for (const u of rt) if (u.alive && unitTile(u) === 'infection') takeDps(u, INFECTION.dps);
    for (const e of enemies) {
      if (!e.alive || e.reviveAt !== null) continue;
      const tl = enemyGroundTile(e);
      const dps = tl === 'infection' ? INFECTION.dps : tl === 'deepsea' ? DEEPSEA.dps : 0;
      if (!dps) continue;
      e.hp -= dps * dt;
      checkSelfFear(e);
      if (e.hp <= 1e-6) killEnemy(e, null);
    }
  };

  // ---- 囚人の拘束と解放 ----
  let freedAll = false;
  const liberate = (e: Enemy) => {
    const lib = e.input.spec.liberty;
    if (!lib || !e.confined) return;
    e.confined = false;
    e.defense.def = Math.max(0, e.defense.def - lib.confDef);
    e.defense.res = currentRes(e);
    if (lib.freeAll && !freedAll) {
      freedAll = true;
      for (const o of enemies) if (o !== e && o.alive) liberate(o);
    }
  };

  const enemyFrame = (e: Enemy): [number, number, number, number, number?] => {
    const f: [number, number, number, number, number?] = [e.id, Math.round(e.x * 100), Math.round(e.y * 100), Math.round((e.hp / e.maxHp) * 100)];
    // 4つ目以降：ビット1 = 解放済みの囚人、2 = スタン中、4 = 恐怖、8 = ステルス、16 = 活性源石の上（強化と継続ダメージ）
    const flags =
      (e.input.spec.liberty && !e.confined ? 1 : 0) | (t < e.stunUntil ? 2 : 0) | (t < e.fearUntil ? 4 : 0) | (isStealthed(e) ? 8 : 0) | (enemyGroundTile(e) === 'infection' ? 16 : 0) |
      (e.stoneUntil >= 0 ? 32 : 0) |
      (e.stoned && e.stoneUntil < 0 ? 64 : 0) |
      (t < e.coldUntil ? 128 : 0) |
      (isFrozen(e) ? 256 : 0) |
      (t < e.trembleUntil ? 512 : 0) |
      (t < e.rootUntil ? 1024 : 0);
    if (flags) f.push(flags);
    return f;
  };

  /**
   * 火炎放射（祝祭のジャズ奏者）：ステルス中は攻撃しない。SPは毎秒1溜まり、溜まっている時にステルスが解けると即座に放射を始め、
   * 対象1人に最大 duration 秒、攻撃間隔ごとに攻撃力×scale の術ダメージと灼熱損傷を与え続ける。
   * 対象の撤退・自身のスタンなどで中断。終わるとSPは0から。放射していない間（SPを溜めている間）は、ステルスが解けていれば通常攻撃。
   * 戻り値：この時間の行動を済ませたか（false なら通常攻撃へ）
   */
  const flameAttack = (e: Enemy, a: NonNullable<EnemySpec['attack']>, fl: NonNullable<EnemySpec['flame']>): boolean => {
    if (e.flameUntil >= 0) {
      const target = e.flameTarget !== null ? byUid.get(e.flameTarget) : undefined;
      if (t >= e.flameUntil || !target || !target.alive) {
        e.flameUntil = -1;
        e.atkTimer = 0;
        return true;
      }
      if (e.blockedBy === null) e.stallUntil = t + dt * 2;
      if ((e.flameTimer -= dt * tileEnemyAtkRate(e)) > 0) return true;
      e.flameTimer += fl.interval;
      emit([3, e.id, target.input.uid, 1]);
      hurt(target, enemyAtk(e, a.atk * fl.scale) * weakFactor(e), true, e);
      if (e.input.spec.element) addOpElement(target, e.input.spec.element.type, a.atk * e.input.spec.element.ratio * weakFactor(e));
      return true;
    }
    e.flameSp = Math.min(fl.cost, e.flameSp + dt);
    if (isStealthed(e)) return true;
    if (e.flameSp < fl.cost) return false;
    let target: Runtime | undefined = e.blockedBy !== null ? byUid.get(e.blockedBy) : undefined;
    if (!target) {
      for (const u of rt) {
        if (!u.alive || u.input.pos === undefined || unitTile(u) === 'smog' || unitStealthed(u) || untargetable(u, e)) continue;
        if (Math.hypot(cellX(u.input.pos) - e.x, cellY(u.input.pos) - e.y) > fl.range) continue;
        if (!target || unitTaunt(u) > unitTaunt(target) || (unitTaunt(u) === unitTaunt(target) && u.order > target.order)) target = u;
      }
    }
    if (!target) return false;
    e.flameSp = 0;
    e.flameUntil = t + fl.duration;
    e.flameTarget = target.input.uid;
    e.flameTimer = 0;
    return true;
  };

  /** 敵の砲撃の着弾：目標のマスを中心とする範囲の味方に攻撃力のダメージ（砲撃を撃った敵が倒れていても着弾する） */
  const landShells = () => {
    for (let i = 0; i < shells.length; i++) {
      const sh = shells[i];
      if (sh.at > t + 1e-9) continue;
      shells.splice(i--, 1);
      for (const u of rt) {
        if (!u.alive || u.input.pos === undefined || unitStealthed(u)) continue;
        if (Math.abs(cellX(u.input.pos) - sh.x) > sh.radius + 1e-9 || Math.abs(cellY(u.input.pos) - sh.y) > sh.radius + 1e-9) continue;
        hurt(u, enemyAtk(sh.e, sh.atk) * weakFactor(sh.e), sh.arts, sh.e);
      }
    }
  };

  const enemyAttacks = () => {
    for (const e of enemies) {
      const a = e.input.spec.attack;
      if (!a || !e.alive || e.reviveAt !== null || e.thrown || e.stoneUntil >= 0) continue;
      const lib = e.input.spec.liberty;
      // 解放後の囚人はHPが回復する
      if (lib?.regen && !e.confined) e.hp = Math.min(e.maxHp, e.hp + lib.regen * dt);
      const fl = e.input.spec.flame;
      if (isFrozen(e) || asleep(e) || t < e.stunUntil || t < e.fearUntil) {
        // 火炎放射はスタンなどで中断される
        if (fl) e.flameUntil = -1;
        continue;
      }
      if (fl && flameAttack(e, a, fl)) continue;
      if (e.atkTimer > 0) {
        // 寒冷中は攻撃速度が下がる。拘束中の囚人も攻撃速度が下がる
        const conf = lib && e.confined ? Math.max(0.1, (100 + lib.confAspd) / 100) : 1;
        e.atkTimer -= (t < e.coldUntil ? (dt * (100 - COLD_ATTACK_SPEED)) / 100 : dt) * tileEnemyAtkRate(e) * conf * enemyAspdRate(e);
        continue;
      }
      // 戦慄：ブロックされている間は通常攻撃できない（周囲攻撃は通常攻撃ではないので続く）
      if (!a.aura && e.blockedBy !== null && t < e.trembleUntil) continue;
      if (a.aura) {
        // 周囲の味方全員に攻撃し続ける（換気口の上の味方は対象外）
        const free = lib && !e.confined;
        for (const u of rt) {
          if (!u.alive || u.input.pos === undefined || unitTile(u) === 'smog' || unitStealthed(u) || untargetable(u, e)) continue;
          if (Math.hypot(cellX(u.input.pos) - e.x, cellY(u.input.pos) - e.y) > a.range) continue;
          emit([3, e.id, u.input.uid, a.arts ? 1 : 0]);
          hurt(u, enemyAtk(e, a.atk * (free ? 1 + lib.atk : 1)) * weakFactor(e), a.arts, e, free ? lib.defPen : 0);
          if (e.input.spec.element) addOpElement(u, e.input.spec.element.type, a.atk * e.input.spec.element.ratio * weakFactor(e));
        }
        e.atkTimer = a.interval;
        continue;
      }
      let target: Runtime | undefined;
      if (e.blockedBy !== null) target = byUid.get(e.blockedBy);
      else if (a.kind === 'ranged' && a.randomTarget) {
        // 範囲内のランダムな対象（換気口の上の味方は除く）
        const cands = rt.filter(
          (u) => u.alive && u.input.pos !== undefined && unitTile(u) !== 'smog' && !unitStealthed(u) && !untargetable(u, e) && Math.hypot(cellX(u.input.pos) - e.x, cellY(u.input.pos) - e.y) <= a.range,
        );
        if (cands.length) target = cands[Math.floor(rand() * cands.length)];
      } else if (a.kind === 'ranged') {
        for (const u of rt) {
          if (!u.alive || u.input.pos === undefined) continue;
          if (Math.hypot(cellX(u.input.pos) - e.x, cellY(u.input.pos) - e.y) > a.range) continue;
          // 換気口の上の味方・ステルスの味方は遠距離攻撃の対象にならない
          if (unitTile(u) === 'smog' || unitStealthed(u) || untargetable(u, e)) continue;
          // 地面マスの味方だけを攻撃する敵（枯朽サルカズ戦車）
          if (a.groundOnly && !canBlockAt(u.input.pos)) continue;
          const tu = unitTaunt(u);
          const tt = target ? unitTaunt(target) : 0;
          if (!target || tu > tt || (tu === tt && u.order > target.order)) target = u;
        }
      }
      if (!target || !target.alive) continue;
      const ls = a.lockStrike;
      if (ls && target.input.pos !== undefined) {
        // 帝国砲撃誘導機：目標の位置をロックオンし、ls.delay 秒後にそのマスを中心に砲撃が着弾する（目標が撤退しても位置は変わらない）
        const sx = cellX(target.input.pos);
        const sy = cellY(target.input.pos);
        shells.push({ at: t + ls.delay, e, x: sx, y: sy, atk: a.atk, arts: a.arts, radius: ls.radius });
        emit([12, e.id, Math.round(sx * 100), Math.round(sy * 100), Math.round(ls.delay * 100), Math.round(ls.radius * 100)]);
        e.atkTimer = a.interval;
        if (e.blockedBy === null) e.stallUntil = t + RANGED_ATTACK_STALL;
        continue;
      }
      if (a.kind === 'ranged') emit([3, e.id, target.input.uid, a.arts ? 1 : 0]);
      const th = e.input.spec.throwOnce;
      if (th && target.input.pos !== undefined) {
        // バクダンバチ：目標と周囲のマスの味方に攻撃力の100%の物理ダメージ（1回だけ。攻撃力の補正もそのまま掛かる）。その後は攻撃せず速くなる
        const tx = cellX(target.input.pos);
        const ty = cellY(target.input.pos);
        emit([7, Math.round(tx * 100), Math.round(ty * 100), 6]);
        for (const u of rt) {
          if (!u.alive || u.input.pos === undefined || unitStealthed(u)) continue;
          if (Math.abs(cellX(u.input.pos) - tx) > th.radius || Math.abs(cellY(u.input.pos) - ty) > th.radius) continue;
          hurt(u, enemyAtk(e, a.atk) * weakFactor(e), a.arts, e);
        }
        e.thrown = true;
        if (e.blockedBy === null) e.stallUntil = t + RANGED_ATTACK_STALL;
        continue;
      }
      // 「サンクタの眼」：目標が弾薬スキル中なら、ダメージを与える代わりに弾薬を奪う（使い切ったらスキル終了。弾薬の消費には数えない）
      if (a.stealAmmo && target.ammoLeft > 0) {
        target.ammoLeft = Math.max(0, target.ammoLeft - a.stealAmmo);
        if (target.ammoLeft === 0) endSkill(target);
        e.atkTimer = a.interval;
        if (a.kind === 'ranged' && e.blockedBy === null) e.stallUntil = t + RANGED_ATTACK_STALL;
        continue;
      }
      const free = lib && !e.confined;
      // 山海衆精鋭：ステルスが解けた後の最初の攻撃は攻撃力上昇
      const ambush = e.input.spec.ambush && e.ambushReady ? e.input.spec.ambush : 1;
      if (e.input.spec.ambush) e.ambushReady = false;
      // 近距離（ブロックしている相手）と遠距離で倍率が違う敵（枯朽サルカズ戦車・「帝国の甲冑」）
      const melee = e.blockedBy === target.input.uid;
      const scaleAll = melee ? (a.meleeScale ?? 1) : (a.rangedScale ?? 1);
      e.atkCount++;
      e.atkTimer = a.interval;
      // 枯朽サルカズ戦車：数回攻撃した後の攻撃は、目標の位置に汚染秽蝕を残す（ダメージなし）
      if (a.pollute && e.atkCount % a.pollute.every === 0 && target.input.pos !== undefined) {
        const px = cellX(target.input.pos);
        const py = cellY(target.input.pos);
        pollutions.push({ x: px, y: py, until: t + a.pollute.duration, ...a.pollute });
        emit([6, e.id, Math.round(px * 100), Math.round(py * 100), Math.round(a.pollute.radius * 100), Math.round(a.pollute.duration * 10)]);
        if (a.kind === 'ranged' && e.blockedBy === null) e.stallUntil = t + RANGED_ATTACK_STALL;
        continue;
      }
      // 「帝国の甲冑」：周期的に、次の攻撃が連撃（チャージ攻撃）
      let times = 1;
      if (a.multi && t >= e.multiAt) {
        times = a.multi.times;
        e.multiAt = t + a.multi.cooldown;
      }
      for (let i = 0; i < times && target.alive; i++) {
        hurt(target, enemyAtk(e, a.atk * scaleAll * (free ? 1 + lib.atk : 1) * ambush) * weakFactor(e), a.arts, e, free ? lib.defPen : 0);
        // 祝祭のジャズ奏者の灼熱損傷は火炎放射だけ
        if (e.input.spec.element && !fl) addOpElement(target, e.input.spec.element.type, a.atk * e.input.spec.element.ratio * weakFactor(e));
      }
      if (lib && e.confined && ++e.confAttacks >= lib.times) liberate(e);
      // 遠距離攻撃の間は一瞬足を止める
      if (a.kind === 'ranged' && e.blockedBy === null) e.stallUntil = t + RANGED_ATTACK_STALL;
    }
  };

  // ---- 【灭顶之灾】<刺胄之弹> ----
  const bombSpec = (hits: number): EnemyInputSpec => ({
    name: '刺冑の弾',
    hp: hits,
    def: 0,
    res: 0,
    speed: BOMB_SPEED,
    blockCnt: 1,
    flying: true,
    boss: false,
    lifeReduce: 0,
    hitsToKill: true,
    projectile: true,
    // 味方から狙われやすい（挑発レベル+1）
    taunt: 1,
  });
  /** ボスが弾を撃つ（攻撃力が最も高い味方へ1発。ゲーム内の「HPが低下すると追加で発射」は誤りで、発射数は増えない） */
  const fireBombs = (boss: Enemy) => {
    const b = boss.input.spec.bomb!;
    const n = 1;
    const targets = rt
      .filter((u) => u.alive && u.input.pos !== undefined && !unitStealthed(u) && !untargetable(u, boss))
      .sort((x, y) => baseAtk(y.input.def, y.input.star, y.input.mods) - baseAtk(x.input.def, x.input.star, x.input.mods))
      .slice(0, n);
    for (const u of targets) {
      const ne = newEnemy({ key: 'bomb', spec: bombSpec(b.hits), spawnAt: t, path: null }, enemies.length + 1);
      ne.spawned = true;
      ne.alive = true;
      ne.x = boss.x;
      ne.y = boss.y - 1;
      ne.bombTo = { pos: u.input.pos!, stun: b.stun, dotDps: b.dotDps, dotDuration: b.dotDuration };
      enemies.push(ne);
    }
  };
  const flyBomb = (e: Enemy) => {
    const to = e.bombTo!;
    const tx = cellX(to.pos);
    const ty = cellY(to.pos);
    const dist = Math.hypot(tx - e.x, ty - e.y);
    const step = BOMB_SPEED * dt;
    if (dist > step) {
      e.x += ((tx - e.x) / dist) * step;
      e.y += ((ty - e.y) / dist) * step;
      return;
    }
    // 着弾：目標と周囲8マスの味方をスタンさせ、毎秒物理ダメージ
    e.alive = false;
    blast(to.pos, to.stun, to.dotDps, to.dotDuration);
  };
  /** 味方のステルス：【シラクーザ】Lv2の配置後の一定時間、イネスS2の間。敵の遠距離攻撃の対象にならない */
  const unitStealthed = (u: Runtime) =>
    (!!g.siracusa && g.siracusa.fear > 0 && g.siracusa.members.has(u.input.uid) && t - u.ts.deployedAt < g.siracusa.duration) ||
    (cid(u) === 'char_4087_ines' && u.skillLeft > 0);
  /** ステルス中は次の攻撃の倍率を戻す。臨戦状態の敵は周囲に元素損傷を与え続ける */
  const tickEnemyStates = () => {
    for (const e of enemies) {
      if (!e.alive || !e.spawned) continue;
      // 掠海のフローター：スタン・凍結で低空浮揚を失い、以降は地上ユニット（ブロックでき、近距離攻撃のみ）
      if (e.input.spec.float && (t < e.stunUntil || isFrozen(e))) {
        const at = e.input.spec.attack;
        e.input = { ...e.input, spec: { ...e.input.spec, float: false, unblockable: false, attack: at ? { ...at, kind: 'melee', range: 0 } : at } };
      }
      // 仮想敵：泥濘：ブロックしている相手に寄生して術ダメージを与え続ける
      const ps = e.input.spec.parasite;
      if (ps) {
        const host = e.blockedBy !== null ? byUid.get(e.blockedBy) : undefined;
        if (host?.alive && !isFrozen(e) && !asleep(e) && t >= e.stunUntil) {
          if ((e.parasiteTimer -= dt) <= 0) {
            e.parasiteTimer += ps.interval;
            hurt(host, enemyAtk(e, ps.atk * ps.scale) * weakFactor(e), true, e);
          }
        } else e.parasiteTimer = 0;
      }
      if (e.input.spec.ambush && isStealthed(e)) e.ambushReady = true;
      const en = e.input.spec.enrage;
      if (!en || !e.enraged || !en.element || !en.ratio) continue;
      e.enrageTimer -= dt;
      if (e.enrageTimer > 0) continue;
      e.enrageTimer += en.interval;
      const atk = e.input.spec.attack?.atk ?? 0;
      for (const u of rt) {
        if (!u.alive || u.input.pos === undefined || unitStealthed(u) || untargetable(u, e)) continue;
        if (Math.hypot(cellX(u.input.pos) - e.x, cellY(u.input.pos) - e.y) > en.radius) continue;
        addOpElement(u, en.element, atk * en.ratio * weakFactor(e));
      }
    }
  };
  const tickBossSkills = () => {
    for (const e of enemies) {
      if (!e.alive || !e.input.spec.bomb || e.bombAt < 0 || t < e.bombAt) continue;
      fireBombs(e);
      e.bombAt = t + e.input.spec.bomb.cooldown;
    }
    // 【死亡集群】無人機を召喚（上の出現地点から防衛地点へ飛ぶ）
    for (const e of enemies) {
      const sm = e.input.spec.summon;
      if (!e.alive || !sm || e.summonAt < 0 || t < e.summonAt) continue;
      e.summonAt = t + sm.cooldown;
      const base = ENEMIES[sm.enemy];
      if (!base) continue;
      const spec = { ...scaledEnemy(base), hp: Math.round(e.input.spec.hp * sm.hpRatio) || base.hp };
      const ne = newEnemy({ key: sm.enemy, spec, spawnAt: t, path: ENEMY_PATHS[0] ?? null }, enemies.length + 1);
      ne.spawned = true;
      ne.alive = true;
      enemies.push(ne);
    }
    // スタン中の毎秒ダメージ
    for (const u of rt) if (u.alive && t < u.dotUntil) takeDps(u, mitigate(u, u.dotDps, false));
  };

  /** 爆発（弾・手下の突進）：中心と周囲8マスの味方をスタンさせ、継続ダメージ */
  const blast = (pos: number, stun: number, dotDps: number, dotDuration: number) => {
    const tx = cellX(pos);
    const ty = cellY(pos);
    emit([7, Math.round(tx * 100), Math.round(ty * 100), Math.round(stun * 10)]);
    for (const u of rt) {
      // ステルスの味方は範囲攻撃も受けない（迷彩とは別の状態）
      if (!u.alive || u.input.pos === undefined || unitStealthed(u)) continue;
      if (Math.abs(cellX(u.input.pos) - tx) > 1 || Math.abs(cellY(u.input.pos) - ty) > 1) continue;
      u.stunUntil = Math.max(u.stunUntil, t + stun);
      u.dotUntil = t + dotDuration;
      u.dotDps = dotDps;
      for (const b of u.blocked) b.blockedBy = null;
      u.blocked = [];
      onSleepStun(u.input.pos);
    }
  };
  const flyTo = (e: Enemy, tx: number, ty: number, speed: number): boolean => {
    const dist = Math.hypot(tx - e.x, ty - e.y);
    const step = speed * dt;
    if (dist <= step) {
      e.x = tx;
      e.y = ty;
      return true;
    }
    e.x += ((tx - e.x) / dist) * step;
    e.y += ((ty - e.y) / dist) * step;
    return false;
  };
  const roam = (e: Enemy) => {
    const dv = e.input.spec.dive;
    if (e.minion === 'down') {
      // 撃ち落とされてから一定時間で復帰し、ボスのそばへ戻る
      if (t < e.downUntil) return;
      e.minion = 'back';
    }
    if (e.minion === 'roam' && dv && e.diveAt >= 0 && t >= e.diveAt) {
      // 攻撃力が最も低い味方へ突進
      const target = rt
        .filter((u) => u.alive && u.input.pos !== undefined && !unitStealthed(u))
        .sort((x, y) => baseAtk(x.input.def, x.input.star, x.input.mods) - baseAtk(y.input.def, y.input.star, y.input.mods))[0];
      e.diveAt = t + dv.cooldown;
      if (target) {
        e.minion = 'dive';
        e.diveTo = target.input.pos!;
        e.diveHits = 0;
      }
    }
    if (e.minion === 'dive') {
      if (flyTo(e, cellX(e.diveTo), cellY(e.diveTo), DIVE_SPEED)) {
        blast(e.diveTo, dv!.stun, dv!.dotDps, dv!.dotDuration);
        e.minion = 'back';
      }
      return;
    }
    if (e.minion === 'back') {
      if (flyTo(e, BOSS_CENTER.x, BOSS_CENTER.y - 1, DIVE_SPEED)) {
        e.minion = 'roam';
        e.roamTo = null;
      } else return;
    }
    if (!e.roamTo) {
      // 出現位置：ボスのそば
      e.x = BOSS_CENTER.x;
      e.y = BOSS_CENTER.y - 1;
    }
    const gx = cellX(GOAL);
    const gy = cellY(GOAL);
    while (!e.roamTo || Math.hypot(e.roamTo.x - e.x, e.roamTo.y - e.y) < 0.05) {
      const to = { x: rand() * 8, y: rand() * 3 };
      if (Math.hypot(to.x - gx, to.y - gy) >= 2) e.roamTo = to;
    }
    if (t < e.stallUntil || isFrozen(e) || asleep(e)) return;
    const speed = e.input.spec.speed * moveMultiplier * (field ? talentSlow(e) : 1);
    const dx = e.roamTo.x - e.x;
    const dy = e.roamTo.y - e.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.min(dist, speed * dt);
    e.x += (dx / dist) * step;
    e.y += (dy / dist) * step;
  };

  /** 「帝国の甲冑」：出現時、HPが最も高い味方に狙いを定め、その味方と周囲8マスでHPが最も高い味方に攻撃力の物理ダメージを複数回 */
  const appearStrike = (e: Enemy) => {
    const atk = e.input.spec.attack?.atk ?? 0;
    const alive = rt.filter((u) => u.alive && u.input.pos !== undefined && !unitStealthed(u) && !untargetable(u, e));
    const lock = alive.sort((a, b) => b.hp - a.hp)[0];
    if (!lock || !atk) return;
    const lx = cellX(lock.input.pos!);
    const ly = cellY(lock.input.pos!);
    for (let i = 0; i < (e.input.spec.appearStrike ?? 0); i++) {
      const target = alive
        .filter((u) => u.alive && Math.abs(cellX(u.input.pos!) - lx) <= 1 && Math.abs(cellY(u.input.pos!) - ly) <= 1)
        .sort((a, b) => b.hp - a.hp)[0];
      if (!target) break;
      emit([3, e.id, target.input.uid, 0]);
      hurt(target, enemyAtk(e, atk) * weakFactor(e), false, e);
    }
  };
  const moveEnemies = () => {
    for (const e of enemies) {
      if (!e.spawned && e.input.spawnAt <= t + 1e-9) {
        e.spawned = true;
        e.alive = true;
        if (e.input.spec.appearStrike && field) appearStrike(e);
      }
      // 脆弱が切れる
      if (e.vulnUntil >= 0 && t >= e.vulnUntil) {
        e.vulnUntil = -1;
        e.defense.damageTaken = 1;
      }
      // 特殊能力無効化が切れたら屈折が戻る
      if (e.alive && e.neutralUntil >= 0 && t >= e.neutralUntil) {
        e.neutralUntil = -1;
        e.defense.res = currentRes(e);
      }
      if (!e.alive) continue;
      // <刺胄之弹>：着弾先へ飛び、着くと爆発する
      if (e.input.spec.projectile) {
        flyBomb(e);
        continue;
      }
      // 大型のボス：移動しない
      if (e.input.spec.large) {
        e.x = BOSS_CENTER.x;
        e.y = BOSS_CENTER.y;
        continue;
      }
      // ボスの手下：フィールド内を飛び回る（防衛地点の周りには入らない）
      if (e.input.spec.roam) {
        roam(e);
        continue;
      }
      // 墓守の石像：石像形態の間は動かず、時間が来たら飛行形態になって動き出す
      if (e.stoneUntil >= 0) {
        if (t < e.stoneUntil) continue;
        const sn = e.input.spec.stone!;
        e.stoneUntil = -1;
        e.defense.def = Math.max(0, e.defense.def - sn.def);
        e.defense.res = Math.max(0, e.defense.res - sn.res);
        // 飛行形態：遠距離の術攻撃、障害物を無視して防衛地点へ直進
        const at = e.input.spec.attack;
        const here: [number, number] = [Math.round(e.x), Math.round(e.y)];
        const path = routeCells([here, [cellX(GOAL), cellY(GOAL)]]);
        e.input = { ...e.input, path, spec: { ...e.input.spec, flying: true, attack: at ? { ...at, kind: 'ranged', range: sn.flyRange, arts: true } : at } };
        e.d = 0;
        release(e);
      }
      if (!e.input.path || e.blockedBy !== null) continue;
      // 復活待ち：その場に留まり、時間が来たら元のHPで復活する
      if (e.reviveAt !== null) {
        if (t >= e.reviveAt) {
          e.reviveAt = null;
          e.revived = true;
          e.hp = e.input.spec.hp;
          e.maxHp = e.input.spec.hp;
        } else continue;
      }
      if (t < e.stallUntil || asleep(e) || t < e.stunUntil) continue;
      if (e.frozenUntil >= 0) {
        if (t < e.frozenUntil) continue;
        // 凍結が解けたら術耐性が戻る
        e.frozenUntil = -1;
        e.defense.res = currentRes(e);
      }
      const path = e.input.path;
      const speed = e.input.spec.speed * moveMultiplier * (field ? talentSlow(e) * tileEnemySpeed(e) * zaroSlow(e) : 1) * (e.enraged ? (e.input.spec.enrage?.speedMult ?? 1) : 1) * (e.thrown ? (e.input.spec.throwOnce?.speedMult ?? 1) : 1) * (t < e.selfFearSpeedUntil ? (e.input.spec.selfFear?.speedMult ?? 1) : 1);
      // バインド：その場から動かない（恐怖で逃げている間も）
      if (t < e.rootUntil) continue;
      if (t < e.fearUntil) {
        // 恐怖：来た道を逃げる（ブロックされない）
        e.d = Math.max(0, e.d - speed * dt);
        const fi = Math.min(Math.floor(e.d), path.length - 2);
        const ff = e.d - fi;
        e.x = cellX(path[fi]) + (cellX(path[fi + 1]) - cellX(path[fi])) * ff;
        e.y = cellY(path[fi]) + (cellY(path[fi + 1]) - cellY(path[fi])) * ff;
        continue;
      }
      const curTile = path[Math.min(Math.round(e.d), path.length - 1)];
      const nd = e.d + speed * dt;
      const nextTile = path[Math.min(Math.round(nd), path.length - 1)];
      if (!e.input.spec.unblockable && (!e.input.spec.flying || (field && !e.input.spec.projectile && !e.input.spec.roam && rt.some(lifted)))) {
        // 今いるマス・次に入るマスにブロックできるユニットがいれば止まる
        const b = blockerAt(curTile, e) ?? (nextTile !== curTile ? blockerAt(nextTile, e) : undefined);
        if (b) {
          e.blockedBy = b.input.uid;
          b.blocked.push(e);
          continue;
        }
      }
      e.d = nd;
      if (e.d >= path.length - 1) {
        e.d = path.length - 1;
        e.alive = false;
        e.leaked = true;
      }
      const i = Math.min(Math.floor(e.d), path.length - 2);
      const f = e.d - i;
      const a = path[i];
      const b = path[i + 1];
      e.x = cellX(a) + (cellX(b) - cellX(a)) * f;
      e.y = cellY(a) + (cellY(b) - cellY(a)) * f;
    }
  };

  const moveMultiplier = opts.moveMultiplier ?? 0.5;

  const unitFrame = (): [number, number, number, number, number, number?][] =>
    rt
      .filter((u) => u.input.pos !== undefined && !u.owner)
      .map((u) => {
        const hp = u.alive ? Math.round((u.hp / u.maxHp) * 100) : -1;
        const s = u.skill;
        if (!u.alive && u.redeployAt !== null) {
          const left = Math.max(0, u.redeployAt - t);
          return [u.input.uid, -1, Math.round((1 - left / u.respawn) * 100), 4, Math.round(left * 10)];
        }
        if (u.ammoLeft > 0) return [u.input.uid, hp, 100, 2, u.ammoLeft];
        if (u.skillLeft > 0 && u.motionLen > 0) {
          // 攻撃モーションのスキル：残りのモーション時間
          const left = Math.max(0, (u.slashLeft - 1) * (s.bb.d_hit_interval ?? 0.3) + u.slashTimer);
          return [u.input.uid, hp, Math.round((left / u.motionLen) * 100), 1, Math.round(left * 10)];
        }
        if (u.skillLeft > 0 && u.skillLeft < 9000) return [u.input.uid, hp, Math.round((u.skillLeft / Math.max(0.01, s.duration)) * 100), 1, Math.round(u.skillLeft * 10)];
        if (s.passive || s.spCost <= 0 || u.skillLeft > 0) return [u.input.uid, hp, 0, 3, 0];
        return [u.input.uid, hp, Math.min(100, Math.round((u.sp / s.spCost) * 100)), 0, 0, u.input.def.subProfession === 'hunter' ? Math.floor(u.huntAmmo) : undefined];
      });

  const ELEM_ORDER: ElementType[] = ['burning', 'neural', 'erosion', 'apoptosis'];
  const elemFrame = (): [number, number, number][] => {
    const out: [number, number, number][] = [];
    for (const u of rt) {
      if (u.input.pos === undefined || !u.alive || u.owner) continue;
      ELEM_ORDER.forEach((type, i) => {
        if (opBursting(u, type)) out.push([u.input.uid, i, 100 + Math.max(1, Math.round(((u.elem[type] ?? 0) / OP_ELEMENT_MAX) * 100))]);
        else if ((u.elem[type] ?? 0) >= 1) out.push([u.input.uid, i, Math.min(100, Math.max(1, Math.round(((u.elem[type] ?? 0) / OP_ELEMENT_MAX) * 100)))]);
      });
    }
    return out;
  };

  let sargonMax = 0;
  let sargonSum = 0;
  const sargonFrame = (): [number, number][] =>
    rt
      .filter((u) => u.alive && u.input.pos !== undefined)
      .map((u): [number, number] => [u.input.uid, u.sargonBuffs.filter((until) => until > t).length])
      .filter((x) => x[1] > 0);

  const moveFrame = (): [number, number, number][] =>
    rt.filter((u) => !u.owner && u.input.pos !== undefined && (u.input.pos !== u.home.pos || u.input.dir !== u.home.dir)).map((u) => [u.input.uid, u.input.pos!, DIRS.indexOf(u.input.dir ?? DEFAULT_DIRECTION)]);
  const stealthFrame = (): number[] => rt.filter((u) => u.alive && u.input.pos !== undefined && unitStealthed(u)).map((u) => u.input.uid);
  const siracusaFrame = (): number[] =>
    g.siracusa ? rt.filter((u) => u.alive && u.input.pos !== undefined && g.siracusa!.members.has(u.input.uid) && t - u.ts.deployedAt < g.siracusa!.duration).map((u) => u.input.uid) : [];

  const steps = Math.round(timeLimit / dt);
  const sampleEvery = Math.max(1, Math.round(0.5 / dt));
  const frameEvery = Math.max(1, Math.round(0.2 / dt));
  timeline.push({ t: 0, hp: remainingHp(), alive: 0 });

  for (let step = 0; step < steps; step++) {
    t = step * dt;
    moveEnemies();
    landBombs();
    landShells();
    if (enemies.every((e) => e.spawned && !e.alive)) break;
    if (field) {
      tickCost();
      tickCold();
      tickWanted();
      tickElements();
      tickTalents();
      tickTiles();
      enemyAttacks();
      tickZones();
      tickPollution();
      tickSleep();
      tickBossSkills();
      tickEnemyStates();
      tickTexas();
      tickZaro();
      // 【サルゴン】の強化の層数（最大・時間平均）
      if (g.sargon) {
        let cur = 0;
        for (const u of rt) if (u.alive && g.sargon.members.has(u.input.uid)) cur = Math.max(cur, u.sargonBuffs.filter((until) => until > t).length);
        sargonMax = Math.max(sargonMax, cur);
        sargonSum += cur * dt;
      }
      for (const u of rt) if (u.barrier > 0) u.barrier = Math.max(0, u.barrier - u.barrierDecay * dt);
    }

    for (const u of rt) {
      if (!u.alive) continue;
      const { def, mods, uid, star } = u.input;
      if (mods.regenPct) healUnit(u, u, u.maxHp * mods.regenPct * dt);
      {
        // スキル中の防御力上昇と自己回復
        const on = u.skill.passive || u.skillLeft > 0 || u.ammoLeft > 0;
        u.def = u.baseDef * (1 + (on ? u.skill.defPct : 0)) + talentDefFlat(u);
        if (on && u.skill.regenPct) healUnit(u, u, u.maxHp * u.skill.regenPct * dt);
        if (field && u.skillLeft > 0 && u.skill.costOverTime) cost = Math.min(MAX_COST, cost + (u.skill.costOverTime / Math.max(1, u.skill.duration)) * dt);
        const support = field ? SUPPORT_SKILL[def.charId] : undefined;
        if (on && support === 'auraHeal') {
          const ratio = u.skill.bb['attack@atk_to_hp_recovery_ratio'] ?? 0;
          const a = baseAtk(def, star, mods, u.skill.atkPct);
          for (const o of alliesInRange(u, true)) healUnit(u, o, a * ratio * dt);
        }
        // スルト：HPが徐々に減る（60秒かけて毎秒最大HPの20%まで増える）
        if (on && support === 'surtr' && u.castAt >= 0) {
          const ratio = (u.skill.bb.hp_ratio ?? 0.2) * Math.min(1, (t - u.castAt) / (u.skill.bb.duration ?? 60));
          if (ratio > 0) {
            u.hp -= u.maxHp * ratio * dt;
            if (u.hp <= 1e-6) unitDown(u);
          }
        }
        if (!u.alive) continue;
      }
      // 神経の爆発：スタン中は何もできない
      if (stunned(u)) continue;
      const stats = unitState(def, star).stats;
      const s = u.skill;

      const sargonCount = u.sargonBuffs.filter((until) => until > t).length;
      const lateranoAtk = g.laterano?.members.has(uid) ? Math.min(lateranoAmmo * g.laterano.atkPerAmmo, g.laterano.maxAtk) : 0;
      const castAtk = Math.min(u.result.skillCasts, mods.atkPerCastMax ?? 0) * (mods.atkPerCast ?? 0);
      const swire = SWIRE[def.charId];
      const outerAtkPct =
        (g.sargon ? sargonCount * g.sargon.atkPct : 0) +
        lateranoAtk +
        castAtk +
        (swire ? u.swireStacks * swire.atkPerStack : 0) +
        u.talentStacks * (ELEMENT_TALENT[def.charId]?.atkPerApoptosisBurst?.atk ?? 0) +
        u.qalaisaStacks * (g.qalaisa?.atk ?? 0) +
        talentAtkPct(u) +
        tileAtkPct(u);
      // 琳琅スワイヤー：コインを使って「シャンパン爆弾」（範囲内の敵に物理ダメージ）
      if (swire && field) {
        u.bombTimer -= dt;
        if (u.coins > 0 && u.bombTimer <= 0) {
          const target = targetsInRange(u, false)[0];
          if (target) {
            u.coins--;
            u.bombTimer = 1;
            strike(u, target, baseAtk(def, star, mods, outerAtkPct), u.skill.bb.atk_scale ?? 1.7);
          }
        }
      }
      const heal = def.damageType === 'heal';

      // スキル発動判定（攻撃役は攻撃範囲に敵がいる時だけ発動する）
      const skillActive = () => u.skillLeft > 0 || u.ammoLeft > 0;
      // 【強襲】：10秒間攻撃していないかスキル準備完了で、範囲内に敵がいなければ地上の敵の周囲へ再配置（SPはそのまま）
      if (field && g.raid?.members.has(uid) && !u.owner && !inMotion0(u)) {
        const ready = !s.passive && !skillActive() && s.spCost > 0 && u.sp >= s.spCost && t >= u.recastAt;
        if ((t - u.raidIdleFrom >= g.raid.idle - 1e-9 || ready) && !targetsInRange(u, false).length && !targetsInRange(u, true).length) raidRelocate(u);
      }
      if (!s.passive && !skillActive() && t >= u.recastAt && u.sp >= s.spCost && s.spCost > 0 && !(field && def.charId === TIPPI) && !inDoll(u) && !opBursting(u, 'apoptosis') && (heal
          ? !field || injuredInRange(u, true).length > 0
          : field && (SUPPORT_SKILL[def.charId] === 'nextHeal' || SUPPORT_SKILL[def.charId] === 'areaHeal')
            ? injuredNear(u).length > 0
            : targetsInRange(u, true).length > 0)) {
        castSkill(u, outerAtkPct);
      }

      const activeNow = s.passive || skillActive();
      // ヒューマス：スキル中、HP割合に応じた「勇猛」
      const peak = activeNow && !s.passive ? (peakPerformance(s.bb).find(([ratio]) => u.hp / u.maxHp >= ratio)?.[1] ?? 0) : 0;
      const atk =
        baseAtk(def, star, mods, outerAtkPct + peak + (activeNow && (!PHILAE[def.charId] || u.philaeBoost) ? s.atkPct : 0) + (activeNow ? raidSkillBuff(u, 'atk') : 0)) +
        (t < u.inspireUntil ? u.inspireAtk : 0) +
        talentAtkFlat(u);
      u.curAtk = atk;
      const aspd =
        stats.aspd +
        (mods.aspd ?? 0) +
        (activeNow ? s.aspd : 0) +
        (g.sargon ? sargonCount * g.sargon.aspd : 0) +
        Math.min(u.attacks, mods.aspdPerAttackMax ?? 0) * (mods.aspdPerAttack ?? 0) +
        // 【シラクーザ】配置後（再配置でも）一定時間
        (g.siracusa?.members.has(uid) && t - u.ts.deployedAt < g.siracusa.duration ? g.siracusa.aspd : 0) +
        talentAspd(u) +
        tileAspd(u);
      const interval = attackInterval(stats.interval, aspd, activeNow && !s.passive ? s.intervalAdd : 0);
      // デーゲンブレヒャーS3：モーション中の斬撃（スキル範囲の最大 max_target 体）。最初の斬撃は発動したコマで出る
      const inMotion = u.motionLen > 0 && u.skillLeft > 0;
      if (inMotion && u.slashLeft > 0) {
        if (t > u.castAt) u.slashTimer -= dt;
        while (u.slashTimer <= 1e-9 && u.slashLeft > 0) {
          const last = u.slashLeft === 1;
          const targets = pickTargets(u, true);
          if (targets.length) emit([2, uid, 1]);
          for (const [e] of targets) strike(u, e, atk, (last ? s.bb.e_atk_scale_end : s.bb.d_atk_scale) ?? 1);
          if (targets.length) u.raidIdleFrom = t;
          u.slashLeft--;
          u.slashTimer += s.bb.d_hit_interval ?? 0.3;
        }
        if (u.slashLeft <= 0) {
          u.skillLeft = 0;
          endSkill(u);
        }
      }
      const scale = activeNow && !s.instant && !s.passive ? s.atkScale : 1;
      // 旋輪射手（ケイパー）：スキル中は攻撃時に投擲物を追加で放つ（cnt 個）
      const loop = def.subProfession === 'loopshooter';
      // 剣豪の特性：通常攻撃で2回ダメージを与える
      const hits = activeNow && !s.instant ? (def.charId === TIPPI && u.skillLeft > 0 ? TIPPI_HITS : loop && !s.passive && s.bb.cnt ? s.bb.cnt : s.hits) : def.subProfession === 'sword' ? 2 : 1;
      // 陣法術師はスキル中しか攻撃しない
      // ヴィルトゥオーサはスキルでのみ攻撃、フィラエはスキル中は攻撃しない
      const canAttack =
        !heal && !((def.subProfession === 'phalanx' || SKILL_ACTIVE_ONLY_ATTACK.has(def.charId)) && !activeNow) && !(field && SKILL_ONLY_ATTACK.has(def.charId)) && !(PHILAE[def.charId] && u.skillLeft > 0) &&
        !(NO_ATTACK_IN_SKILL.has(def.charId) && u.skillLeft > 0) && !((def.charId === MIXER || def.charId === LEMUEN) && u.ammoLeft > 0) && !inMotion;

      // 医療：治療行動（吟遊者は範囲内の全員を毎秒攻撃力の10%回復）
      if (heal && field) {
        if (def.subProfession === 'bard') {
          // スキル中は特性の回復割合が上がるものがある（エテルナS3）
          const ratio = activeNow && !s.passive ? (s.bb['attack@atk_to_hp_recovery_ratio'] ?? 0.1) : 0.1;
          const eterna = def.charId === ETERNA && activeNow && !s.passive;
          const allies = alliesInRange(u, activeNow);
          // 「微塵」が消えなくなるので、自身以外は特性の効果1.5倍
          for (const o of allies) healUnit(u, o, atk * ratio * (eterna && o !== u ? 1.5 : 1) * dt);
          if (eterna) {
            // 自身以外に最大HP×割合の鼓舞（攻撃力加算）
            for (const o of allies) {
              if (o === u || o.input.def.subProfession === 'bard') continue;
              o.inspireAtk = Math.max(t < o.inspireUntil ? o.inspireAtk : 0, u.maxHp * (s.bb.max_hp ?? 0));
              o.inspireUntil = t + dt * 1.5;
            }
            // 2秒ごとに範囲内の味方全員のHP割合をならす
            u.redistTimer -= dt;
            if (u.redistTimer <= 0) {
              u.redistTimer += s.bb['attack@cetsyr_s_3[cal_hp_ratio].interval'] ?? 2;
              const alive = allies.filter((o) => o.alive);
              const ratioAll = alive.reduce((a, o) => a + o.hp, 0) / Math.max(1, alive.reduce((a, o) => a + o.maxHp, 0));
              for (const o of alive) o.hp = Math.max(1, o.maxHp * ratioAll);
            }
          }
        } else {
          while (u.atkTimer <= 1e-9) {
            if (!healAction(u, atk, scale, activeNow)) {
              u.atkTimer = 0;
              break;
            }
            u.atkTimer += interval;
            if (s.charge === 'attack' && !activeNow) u.sp += 1;
          }
        }
      }

      if (cid(u) === LEMUEN && u.ammoLeft > 0) lemuenLock(u);

      // 狩人：攻撃しない間は弾を装填する
      const hunter = def.subProfession === 'hunter';
      if (hunter && t - u.lastAttackAt >= HUNTER_RELOAD_DELAY && u.huntAmmo < HUNTER_AMMO) {
        u.huntAmmo = Math.min(HUNTER_AMMO, u.huntAmmo + dt / HUNTER_RELOAD_INTERVAL);
      }

      // 通常攻撃
      while (canAttack && u.atkTimer <= 1e-9) {
        // 狩人は弾がないと攻撃できない
        if (hunter && u.huntAmmo < 1) {
          u.atkTimer = 0;
          break;
        }
        // 旋輪射手は投擲物が手元にないと攻撃できない
        if (loop && t < u.loopBackAt) {
          u.atkTimer = 0;
          break;
        }
        const targets = pickTargets(u, activeNow);
        if (!targets.length) {
          u.atkTimer = 0;
          break;
        }
        if (loop) {
          const e0 = targets[0][0];
          const d = field && u.input.pos !== undefined ? Math.hypot(e0.x - cellX(u.input.pos), e0.y - cellY(u.input.pos)) : LOOP_DEFAULT_DIST;
          // 投擲物が戻るまで次の攻撃はできない（実効の間隔 = 攻撃間隔と往復時間の長い方）
          u.loopBackAt = t + LOOP_WINDUP + d / LOOP_OUT_SPEED + d / LOOP_BACK_SPEED;
        }
        if (hunter) {
          u.huntAmmo -= 1;
          u.lastAttackAt = t;
        }
        // 戦術【薬枚実験】：攻撃時に確率で護盾（最大1層。期待値で扱う）
        if (g.mberry?.members.has(uid) && u.mberryShield < 1) {
          u.mberryAcc += g.mberry.prob;
          if (u.mberryAcc >= 1) {
            u.mberryAcc -= 1;
            u.mberryShield = 1;
          }
        }
        // 狩人は弾を消費して攻撃力120%
        // 範囲攻撃の演出：攻撃範囲全体（複数を巻き込む攻撃）、または着弾地点の周囲（スプラッシュ）
        if (SPLASH_SUB.has(def.subProfession) && field) {
          const p0 = targets[0][0];
          emit([1, uid, Math.round(p0.x * 100), Math.round(p0.y * 100), 100]);
        } else {
          const inSkill = !s.passive && activeNow;
          if (inSkill && SKILL_FX[def.charId]) emit([13, uid, SKILL_FX[def.charId], 1, ...targets.flatMap(([e]) => [Math.round(e.x * 100), Math.round(e.y * 100)])]);
          else if (targets.length >= 3 || (inSkill && targets.length >= 2)) emit([2, uid, inSkill ? 1 : 0], `area${uid}`, 0.3);
        }
        const dealtBefore = u.result.damage;
        if (def.subProfession === 'funnel') {
          // 浮遊ユニット：各ユニットが対象を攻撃し、同じ敵を連続で攻撃するほど倍率が上がる
          const [e0, m0] = targets[0];
          if (u.funnelTarget === e0) u.funnelStack++;
          else {
            u.funnelTarget = e0;
            u.funnelStack = 0;
          }
          const fs = Math.min(funnelCap(u, activeNow), FUNNEL.init + FUNNEL.delta * u.funnelStack);
          // 荒蕪ラップランドS3：本体の通常攻撃は続く。スキルで増える浮遊ユニット（+2）はザーロとして別に動くので数えない
          const n = funnelCount(u, activeNow && def.charId !== WHITW2);
          for (let k = 0; k < n; k++) strike(u, e0, atk, fs * m0 * talentScale(u, e0, activeNow));
          if (whitw2Stage(u) >= 2) neutralize(e0, u.tb[0]['attack@silence_duration'] ?? 2);
        } else
        for (const [e, m] of targets) for (let h = 0; h < hits; h++) strike(u, e, atk, scale * m * (hunter ? HUNTER_ATK_SCALE : 1) * talentScale(u, e, activeNow) * lordScale(u, e, activeNow));
        if (def.charId === TITI) {
          for (const [e] of targets) {
            // 素質：移動していない敵に攻撃力15%の術ダメージを追加
            if (e.alive && u.tb[0].extra_atk_scale && (asleep(e) || isFrozen(e) || e.blockedBy !== null || e.input.spec.speed <= 0))
              deal(u, e, hitDamage(atk * u.tb[0].extra_atk_scale, 'arts', effDefense(e), mods), 'arts');
            // スキル：睡眠状態でない対象を睡眠
            if (titiOn(u)) sleepEnemy(e, s.bb['attack@sleep'] ?? s.bb.sleep ?? 5, u);
          }
        }
        // 呪癒師：攻撃時、与ダメージの50%で味方1人を回復（他の医療と同じく、範囲内で回復を受け付ける味方のうちHP割合が最も低い味方）
        if (field && def.subProfession === 'incantationmedic') {
          const dealt = u.result.damage - dealtBefore;
          const target = injuredInRange(u, activeNow)[0];
          if (dealt > 0 && target) healUnit(u, target, dealt * INCANTATION_HEAL);
        }
        // ミヅキ：攻撃範囲内でHPが最も少ない敵に追加の術ダメージ
        if (cid(u) === 'char_437_mizuki') {
          const low = enemiesInRange(u).filter((e) => !isStealthed(e)).sort((a, b) => a.hp - b.hp)[0];
          if (low) deal(u, low, hitDamage(atk * (u.tb[0]['attack@mizuki_t_1.atk_scale'] ?? 0), 'arts', effDefense(low), mods), 'arts');
        }
        // 武者・鎌の職分特性：攻撃で自身を回復
        const selfHeal = SELF_HEAL_SUB[def.subProfession];
        if (selfHeal) healUnit(u, u, selfHeal.hp * (selfHeal.perTarget ? Math.min(targets.length, Math.max(1, u.block)) : 1));
        // ブレミシャイン：スキル中は攻撃のたびに周囲の自分以外の味方1人を治療
        if (field && activeNow && SUPPORT_SKILL[def.charId] === 'attackHeal') {
          const ally = injuredNear(u).find((o) => o !== u);
          if (ally) healUnit(u, ally, atk * (s.bb.heal_scale ?? 0));
        }
        u.result.hits += hits;
        u.raidIdleFrom = t;
        if (field && activeNow && s.costPerAttack) cost = Math.min(MAX_COST, cost + s.costPerAttack);
        u.attacks++;
        u.ts.barrierTimer = 0;
        if (mods.extraShotProb) {
          const e = targets[0][0];
          deal(u, e, mods.extraShotProb * hitDamage(atk * (mods.extraShotScale ?? 1), 'physical', effDefense(e), mods), 'physical');
        }
        u.atkTimer += interval;
        if (u.ammoLeft > 0) {
          useAmmo(u);
        } else if (s.charge === 'attack' && !activeNow) {
          u.sp += 1;
        }
      }
      if (u.atkTimer > 0) u.atkTimer -= dt;

      // 単体標的モードでは回復職のSPも時間で貯める
      if (heal && !field && s.charge === 'attack' && !activeNow) u.sp += dt / Math.max(0.2, interval);

      // カジミエーシュLv2の周期ダメージ（近接・ブロック中に周囲の敵へ）
      if (g.kazimierzPulse?.members.has(uid)) {
        u.pulseTimer -= dt;
        if (u.pulseTimer <= 0) {
          u.pulseTimer += g.kazimierzPulse.interval;
          if (!field) {
            for (const e of enemies) if (e.alive) deal(u, e, atk * g.kazimierzPulse.scale * e.defense.damageTaken, 'true');
          } else if (u.blocked.length && u.input.pos !== undefined) {
            const ux = cellX(u.input.pos);
            const uy = cellY(u.input.pos);
            for (const e of enemies) {
              if (e.alive && Math.hypot(e.x - ux, e.y - uy) <= 1.3) deal(u, e, atk * g.kazimierzPulse.scale * e.defense.damageTaken, 'true');
            }
          }
        }
      }

      // 傀儡師：身替りの時間が終わったら本体に戻る。帰溟スペクターの身替りは周囲の敵に毎秒術ダメージ（減速は talentSlow）
      if (inDoll(u)) {
        if (cid(u) === GHOST2 && (u.dollTick -= dt) <= 0) {
          u.dollTick += 1;
          for (const e of enemies) if (e.alive && covers(u.rangeNormal, e)) deal(u, e, hitDamage(atk * (u.tb[0].atk_scale ?? 0), 'arts', effDefense(e), mods), 'arts');
        }
        if (t >= u.dollUntil) exitDoll(u);
      }

      // SP回復・スキル時間（身替りの間はSPが溜まらない）
      if (u.skillLeft > 0) {
        u.skillLeft -= dt;
        if (u.skillLeft <= 0) endSkill(u);
      } else if (u.ammoLeft <= 0 && s.charge === 'time' && !inDoll(u)) {
        u.sp += (1 + (mods.spRegen ?? 0) + (mods.spRegenTalent ?? 0)) * dt;
      }
    }

    if (killTime === null && (enemies.every((e) => e.spawned && !e.alive && !e.leaked) || bossDefeated())) killTime = Math.round((t + dt) * 100) / 100;
    if ((step + 1) % sampleEvery === 0) timeline.push({ t: Math.round((step + 1) * dt * 100) / 100, hp: remainingHp(), alive: aliveCount() });
    if (opts.record && step % frameEvery === 0) {
      frames.push({
        t: Math.round(t * 100) / 100,
        e: enemies.filter((e) => e.alive).map(enemyFrame),
        s: rt.filter((u) => u.alive && (u.skillLeft > 0 || u.ammoLeft > 0)).map((u) => u.input.uid),
        u: unitFrame(),
        ue: elemFrame(),
        sg: sargonFrame(),
        sc: siracusaFrame(),
        st: stealthFrame(),
        lf: rt.filter((u) => u.alive && lifted(u)).map((u) => u.input.uid),
        dl: rt.filter((u) => u.alive && inDoll(u)).map((u) => u.input.uid),
        mv: moveFrame(),
        tk: rt.filter((u) => u.alive && u.owner && u.input.pos !== undefined).map((u): [number, number, number, number] => [u.input.uid, u.input.pos!, Math.round((u.hp / u.maxHp) * 100), u.owner!.input.uid]),
        zr: zaroFrame(),
        c: Math.floor(cost),
      });
    }
    if (enemies.every((e) => e.spawned && !e.alive) || bossDefeated()) {
      t += dt;
      break;
    }
  }
  if (t < timeLimit && !enemies.every((e) => e.spawned && !e.alive) && !bossDefeated()) t = timeLimit;
  timeline.push({ t: Math.round(t * 100) / 100, hp: remainingHp(), alive: aliveCount() });
  if (opts.record) {
    frames.push({
      t: Math.round(t * 100) / 100,
      e: enemies.filter((e) => e.alive).map(enemyFrame),
      s: [],
      u: unitFrame(),
      ue: elemFrame(),
      sg: sargonFrame(),
        sc: siracusaFrame(),
        st: stealthFrame(),
        lf: rt.filter((u) => u.alive && lifted(u)).map((u) => u.input.uid),
        dl: rt.filter((u) => u.alive && inDoll(u)).map((u) => u.input.uid),
        mv: moveFrame(),
        tk: rt.filter((u) => u.alive && u.owner && u.input.pos !== undefined).map((u): [number, number, number, number] => [u.input.uid, u.input.pos!, Math.round((u.hp / u.maxHp) * 100), u.owner!.input.uid]),
        zr: zaroFrame(),
      c: Math.floor(cost),
    });
  }
  const sargon = g.sargon ? { aspd: g.sargon.aspd, atkPct: g.sargon.atkPct, max: sargonMax, avg: Math.round((sargonSum / Math.max(dt, t)) * 10) / 10 } : undefined;
  const siracusa = g.siracusa && g.siracusa.aspd ? { aspd: g.siracusa.aspd, duration: g.siracusa.duration, members: rt.filter((u) => g.siracusa!.members.has(u.input.uid)).length } : undefined;
  return { t, enemies, units: rt.filter((u) => !u.owner), timeline, phaseLog, stackGains, stackSources, frames, fx, killTime, bossDefeated: bossDefeated(), colds, freezes, opBursts, enBursts, sargon, siracusa };
}

// ------------------------------------------------------------
// マップ戦闘
// ------------------------------------------------------------

/** 敵の能力値に調整を掛ける。ボスと「攻撃回数で倒す敵」の HP は本家のまま */
export function scaledEnemy(enemy: EnemySpec): EnemySpec {
  const hpScale = enemy.boss || enemy.hitsToKill ? 1 : ENEMY_HP_SCALE;
  const attack = enemy.attack ? { ...enemy.attack, atk: enemy.attack.atk * ENEMY_ATK_SCALE } : undefined;
  return { ...enemy, hp: Math.max(1, Math.round(enemy.hp * hpScale)), speed: enemy.speed * ENEMY_SPEED_SCALE, attack };
}

/** 経由点 [列, 行] を1マスずつのマス番号の列にする（斜めの区間は斜めに1マスずつ進む） */
export function routeCells(route: [number, number][]): number[] {
  const out = [cellPos(route[0][0], route[0][1])];
  for (let i = 1; i < route.length; i++) {
    let [x, y] = route[i - 1];
    const [tx, ty] = route[i];
    while (x !== tx || y !== ty) {
      x += Math.sign(tx - x);
      y += Math.sign(ty - y);
      out.push(cellPos(x, y));
    }
  }
  return out;
}

/** ラウンドの敵の出現予定（出現マスは本家の出現地点に合わせる） */
export function roundEnemies(spec: RoundSpec): EnemyInput[] {
  const out: EnemyInput[] = [];
  for (const s of spec.spawns) {
    const enemy = ENEMIES[s.enemy];
    if (!enemy) continue;
    // 飛行の敵は本家の飛行経路（経由点）を通る
    const path = s.route && enemy.flying ? routeCells(s.route) : ENEMY_PATHS[s.spawn % ENEMY_PATHS.length];
    const scaled = scaledEnemy(enemy);
    const ds = enemy.deadSpawn;
    const child = ds && ENEMIES[ds.enemy] ? { key: ds.enemy, spec: scaledEnemy(ENEMIES[ds.enemy]), count: ds.count } : undefined;
    for (let i = 0; i < s.count; i++) out.push({ key: s.enemy, spec: scaled, child, spawnAt: s.delay + i * s.interval, path, bounty: s.bounty });
  }
  return out;
}

/** ボスが時間切れまで残った時の耐久値の減少：残りHP割合に応じる */
export function bossTimeoutLoss(spec: Pick<EnemySpec, 'lifeReduce'>, remainingRatio: number): number {
  return Math.max(spec.lifeReduce, Math.ceil(remainingRatio * 10));
}

/**
 * 戦闘の制限時間。本家のステージ時間（maxPlayTime）より後に出る敵もいるので、
 * すべての敵が経路を歩き切れるだけの時間を確保する。ボスは本家のステージ時間で打ち切る。
 */
export function battleTimeLimit(spec: RoundSpec): number {
  let limit = spec.timeLimit;
  for (const e of roundEnemies(spec)) {
    if (e.spec.boss || !e.path) continue;
    const speed = Math.max(0.01, e.spec.speed * spec.moveMultiplier);
    // 遠距離の敵は攻撃のたびに足を止めるので、そのぶん余裕を持たせる
    const stall = e.spec.attack?.kind === 'ranged' ? 1 + RANGED_ATTACK_STALL / Math.max(0.5, e.spec.attack.interval) : 1;
    limit = Math.max(limit, e.spawnAt + ((e.path.length - 1) / speed) * stall + 5);
  }
  return Math.ceil(limit);
}

export function simulateBattle(units: SimUnitInput[], spec: RoundSpec, opts: SimOptions = {}): BattleResult {
  const inputs = roundEnemies(spec);
  const limit = battleTimeLimit(spec);
  const r = runEngine(
    units.filter((u) => u.pos !== undefined),
    inputs,
    limit,
    true,
    { ...opts, moveMultiplier: spec.moveMultiplier },
  );
  // 冑（大型のボス）を倒すとその時点で戦闘終了。残っている敵（未出現を含む）は消え、突破に数えない
  const vanished = (e: (typeof r.enemies)[number]) => r.bossDefeated && !e.leaked && (e.alive || !e.spawned);
  let lifeLoss = 0;
  let bossRemaining = 0;
  const leakMap = new Map<string, { key: string; name: string; count: number; lifeLoss: number }>();
  for (const e of r.enemies) {
    const sp = e.input.spec;
    const timedOut = !e.leaked && (e.alive || !e.spawned);
    if (!e.leaked && !timedOut) continue;
    if (vanished(e)) continue;
    // ボスの手下は防衛地点に入らない（突破に数えない）。弾も数えない
    if (sp.roam || sp.projectile) continue;
    let loss = sp.lifeReduce;
    if (timedOut && sp.boss) {
      const ratio = e.hp / sp.hp;
      bossRemaining = Math.max(bossRemaining, ratio);
      loss = bossTimeoutLoss(sp, ratio);
    }
    lifeLoss += loss;
    const l = leakMap.get(e.input.key) ?? { key: e.input.key, name: sp.name, count: 0, lifeLoss: 0 };
    l.count++;
    l.lifeLoss += loss;
    leakMap.set(e.input.key, l);
  }
  const isKilled = (e: (typeof r.enemies)[number]) => e.spawned && !e.alive && !e.leaked;
  // ボスの弾（<刺胄之弹>）は敵の数に入れない
  const counted = r.enemies.filter((e) => !e.input.spec.projectile && !vanished(e));
  const killed = counted.filter(isKilled).length;
  const bountyKilled = counted.filter((e) => e.input.bounty && isKilled(e));
  const totalHp = counted.reduce((s, e) => s + e.input.spec.hp, 0);
  const perUnit = r.units.map((u) => outResult(u.result));
  return {
    round: spec.round,
    timeLimit: limit,
    elapsed: Math.round(r.t * 100) / 100,
    total: counted.length,
    killed,
    leaked: counted.length - killed,
    lifeLoss,
    leaks: [...leakMap.values()],
    bossRemaining,
    bossDefeated: r.bossDefeated || undefined,
    cleared: killed === counted.length,
    totalDamage: perUnit.reduce((s, u) => s + u.damage, 0),
    totalHp,
    perUnit,
    timeline: r.timeline,
    stackGains: r.stackGains,
    stackSources: r.stackSources,
    colds: r.colds,
    freezes: r.freezes,
    opBursts: r.opBursts,
    enBursts: r.enBursts,
    sargon: r.sargon,
    siracusa: r.siracusa,
    enemies: r.enemies.map((e) => ({ id: e.id, key: e.input.key, name: e.input.spec.name, boss: e.input.spec.boss, flying: e.input.spec.flying && !e.stoned, maxHp: e.input.spec.hp, bounty: e.input.bounty, aura: e.input.spec.attack?.aura ? e.input.spec.attack.range : undefined, ring: e.input.spec.attack?.lockStrike ? e.input.spec.attack.range : undefined, large: e.input.spec.large || undefined })),
    bountyGold: bountyKilled.reduce((sum, e) => sum + (e.input.bounty ?? 0), 0),
    bountyKills: bountyKilled.length,
    frames: opts.record ? r.frames : undefined,
    fx: opts.record ? r.fx : undefined,
  };
}

// ------------------------------------------------------------
// 単体標的（DPSチェック）
// ------------------------------------------------------------

export function simulateDps(units: SimUnitInput[], enemy: EnemyDef, opts: SimOptions = {}): SimResult {
  const r = runEngine(
    units,
    [
      {
        key: enemy.id,
        spec: { name: enemy.name, hp: enemy.hp, def: enemy.def, res: enemy.res, speed: 0, blockCnt: 1, flying: false, boss: enemy.isBoss, lifeReduce: 1 },
        spawnAt: 0,
        path: null,
        phases: enemy.phases,
      },
    ],
    enemy.duration,
    false,
    opts,
  );
  const e = r.enemies[0];
  const remainingHp = Math.max(0, Math.round(e.hp));
  const killed = !e.alive && e.spawned;
  const elapsed = killed ? (r.killTime ?? r.t) : enemy.duration;
  return {
    enemy,
    killed,
    killTime: killed ? r.killTime : null,
    elapsed,
    totalDamage: Math.round(enemy.hp - remainingHp),
    remainingHp,
    perUnit: r.units.map((u) => outResult(u.result)),
    timeline: r.timeline.map(({ t, hp }) => ({ t, hp })),
    phaseLog: r.phaseLog,
    stackGains: r.stackGains,
  };
}
