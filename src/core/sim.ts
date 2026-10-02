import { bondKey, type BattleGlobals } from './alliance';
import { ENEMY_PATHS, canBlockAt, cellPos, cellX, cellY, rangeCells, DEFAULT_DIRECTION } from './board';
import { ENEMIES, rangeGrid, unitRangeIds, type EnemySpec, type RoundSpec } from './data/battle';
import { ENEMY_ATK_SCALE, ENEMY_HP_SCALE, ENEMY_SPEED_SCALE } from './rules';
import { unitState } from './data/units';
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
  /** 倒れた時刻（倒れなければ null） */
  downAt: number | null;
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
}

/** リプレイ用のコマ：敵ごとに [id, x*100, y*100, HP%] と、スキル中のユニット */
export interface ReplayFrame {
  t: number;
  e: [number, number, number, number][];
  s: number[];
  /** オペレーターの残りHP（%）。倒れていれば -1 */
  u?: [number, number][];
}

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
  cleared: boolean;
  totalDamage: number;
  totalHp: number;
  perUnit: SimUnitResult[];
  /** 残っている敵の合計HP（0.5秒ごと） */
  timeline: { t: number; hp: number; alive: number }[];
  stackGains: Partial<Record<AllianceId, number>>;
  enemies: EnemyMeta[];
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
}

export function parseSkill(s: SkillData): SkillModel {
  const bb = s.blackboard;
  const get = (...keys: string[]) => {
    for (const k of keys) if (bb[k] !== undefined) return bb[k];
    return undefined;
  };
  const passive = s.skillType === 'PASSIVE';
  const charge = s.spType === 'INCREASE_WITH_TIME' ? 'time' : s.spType === 'INCREASE_WHEN_ATTACK' ? 'attack' : 'none';
  const atk = get('atk', 'attack@atk') ?? 0;
  const timesRaw = get('times', 'attack@times');
  const hits = timesRaw !== undefined && Number.isInteger(timesRaw) && timesRaw >= 2 ? timesRaw : 1;
  const ammo = s.durationType === 'AMMO' ? get('attack@trigger_time', 'trigger_time', 'ammo', 'cnt', 'attack@cnt') ?? 0 : 0;
  const duration = Math.max(0, s.duration);
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
    maxTarget: Math.max(1, Math.round(get('max_target', 'attack@max_target') ?? 1)),
    blockAdd: Math.max(0, Math.round(get('block_cnt') ?? 0)),
    instant: !passive && duration <= 0 && ammo <= 0,
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
export function hitDamage(raw: number, type: DamageType, enemy: DefenseState, mods: Modifier, artsVuln = 0): number {
  if (type === 'heal') return 0;
  let dmg: number;
  if (type === 'physical') {
    const def = enemy.def * (1 - Math.min(mods.defIgnorePct ?? 0, 1));
    dmg = Math.max(raw - def, raw * MIN_DAMAGE_RATIO);
  } else if (type === 'arts') {
    const res = Math.min(Math.max(0, enemy.res * (1 - Math.min(mods.resIgnorePct ?? 0, 1))), 100);
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

const MELEE = new Set(['vanguard', 'guard', 'defender', 'specialist']);
/** 範囲攻撃（対象の周囲1マスにも同じダメージ） */
const SPLASH_SUB = new Set(['splashcaster', 'bombarder', 'blastcaster', 'fortress']);
/** 攻撃範囲内の敵すべてを攻撃 */
const ALL_IN_RANGE_SUB = new Set(['stalker']);

// ------------------------------------------------------------
// 戦闘中の加算数獲得
// ------------------------------------------------------------

interface GarrisonEvent {
  kind: 'useskill' | 'kill' | 'ammo';
  bonds: AllianceId[] | 'maxstack';
  count: number;
  max: number;
  every: number;
  gained: number;
}

function garrisonEvents(input: SimUnitInput): GarrisonEvent[] {
  const { def, star } = input;
  const rowCount = input.rowCount ?? 1;
  const out: GarrisonEvent[] = [];
  for (const g of input.garrisons ?? unitState(def, star).garrisons) {
    if (g.event !== 'IN_BATTLE' || g.effect !== 'ADD_BOND') continue;
    const bb = g.blackboard;
    const key = bb.key as string | undefined;
    const kind = key === 'act1autochess_gar_event_useskill' ? 'useskill' : key === 'act1autochess_gar_event_selfkillenemy' ? 'kill' : key === 'act1autochess_gar_event_consume_ammo' ? 'ammo' : null;
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
      count: count + (input.bonusGain ?? 0),
      max: Number(bb.max_add_count_per_battle ?? Infinity),
      every: Number(kind === 'kill' ? (bb.check_cnt ?? 1) : (bb.consume_count ?? 1)),
      gained: 0,
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
  Partial<Pick<EnemySpec, 'stealth' | 'unblockable' | 'hitsToKill' | 'refract' | 'hitShield' | 'defReduce' | 'revive' | 'attack'>>;

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
}

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
  /** 復活待ち（攻撃回数で倒せる状態）なら復活する時刻 */
  reviveAt: number | null;
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
  def: number;
  res: number;
  alive: boolean;
  /** 戦闘開始時の配置順（左の列から、同じ列は上から）。大きいほど後に配置 */
  order: number;
  /** 堅守の反撃のクールダウン */
  reflectReadyAt: number;
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
}

interface EngineResult {
  t: number;
  enemies: Enemy[];
  units: Runtime[];
  timeline: { t: number; hp: number; alive: number }[];
  phaseLog: { t: number; note: string }[];
  stackGains: Partial<Record<AllianceId, number>>;
  frames: ReplayFrame[];
  killTime: number | null;
}

function runEngine(units: SimUnitInput[], enemyInputs: EnemyInput[], timeLimit: number, field: boolean, opts: SimOptions): EngineResult {
  const dt = opts.dt ?? 0.05;
  const g = opts.globals ?? {};
  const active = opts.activeAlliances ?? new Set<AllianceId>();
  const stacks = opts.stacks ?? {};
  const stackGains: Partial<Record<AllianceId, number>> = {};

  const toSet = (pos: number | undefined, dir: Direction | undefined, id: string | null) =>
    pos === undefined || !id ? null : new Set(rangeCells(pos, dir ?? DEFAULT_DIRECTION, rangeGrid(id)));

  const rt: Runtime[] = units.map((input) => {
    const st = unitState(input.def, input.star);
    const skill = parseSkill(st.skill);
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
      fearAcc: 0,
      neutralize: Math.max(input.mods.neutralize ?? 0, TALENT_NEUTRALIZE[input.def.charId]?.[input.star - 1] ?? 0),
      hp: st.stats.hp * (1 + (input.mods.hpPct ?? 0)),
      maxHp: st.stats.hp * (1 + (input.mods.hpPct ?? 0)),
      def: st.stats.def * (1 + (input.mods.defPct ?? 0)),
      res: Math.min(95, st.stats.res + (input.mods.resFlat ?? 0)),
      alive: true,
      order: 0,
      reflectReadyAt: 0,
      firstEndDone: false,
      events: garrisonEvents(input),
      result: { uid: input.uid, defId: input.def.id, name: input.def.name, star: input.star, damage: 0, hits: 0, skillCasts: 0, kills: 0, taken: 0, healed: 0, downAt: null },
      melee: MELEE.has(input.def.profession),
      blocker,
      block: blocker ? st.stats.block : 0,
      rangeNormal: field ? toSet(input.pos, input.dir, ids.range) : null,
      rangeSkill: field ? toSet(input.pos, input.dir, ids.skillRange ?? ids.range) : null,
      blocked: [],
    };
  });

  // 戦闘開始時の配置順：絶対方角で左の列から、同じ列は上から
  [...rt]
    .filter((u) => u.input.pos !== undefined)
    .sort((a, b) => cellX(a.input.pos!) - cellX(b.input.pos!) || cellY(a.input.pos!) - cellY(b.input.pos!))
    .forEach((u, i) => (u.order = i + 1));

  const baseRes = (s: EnemyInputSpec) => Math.min(100, s.res + (s.refract ?? 0));

  // ---- 特殊能力無効化：屈折・隠匿・盾・復活・分裂を一時的に失う ----
  const neutral = (e: Enemy) => t < e.neutralUntil;
  /** 屈折込みの現在の術耐性 */
  const currentRes = (e: Enemy) => {
    const s = e.input.spec;
    const dr = s.defReduce ? s.defReduce.res * e.reduceStacks : 0;
    return Math.max(0, (neutral(e) ? s.res : baseRes(s)) + dr);
  };
  const neutralize = (e: Enemy, seconds: number) => {
    if (seconds <= 0 || !e.alive) return;
    e.neutralUntil = Math.max(e.neutralUntil, t + seconds);
    e.defense.res = currentRes(e);
  };
  const isStealthed = (e: Enemy) => !!e.input.spec.stealth && e.blockedBy === null && e.reviveAt === null && !neutral(e);
  const newEnemy = (input: EnemyInput, id: number): Enemy => ({
      id,
      input,
      hp: input.spec.hp,
      maxHp: input.spec.hp,
      shield: input.spec.hitShield ?? 0,
      reduceStacks: 0,
      reviveAt: null,
      revived: false,
      neutralUntil: -1,
      atkTimer: 0,
      vulnUntil: -1,
      defense: { def: input.spec.def, res: baseRes(input.spec), damageTaken: 1 },
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
    });
  const enemies: Enemy[] = enemyInputs.map((input, i) => newEnemy(input, i + 1)).sort((a, b) => a.input.spawnAt - b.input.spawnAt);

  const gainStacks = (ev: GarrisonEvent, times = 1) => {
    const amount = Math.min(ev.count * times, ev.max - ev.gained);
    if (amount <= 0) return;
    const targets: AllianceId[] =
      ev.bonds === 'maxstack'
        ? [...active].sort((a, b) => (stacks[b] ?? 0) - (stacks[a] ?? 0)).slice(0, 1)
        : ev.bonds.filter((b) => active.has(b));
    if (targets.length === 0) return;
    ev.gained += amount;
    for (const b of targets) stackGains[b] = (stackGains[b] ?? 0) + amount;
  };

  const phaseLog: EngineResult['phaseLog'] = [];
  const timeline: EngineResult['timeline'] = [];
  const frames: ReplayFrame[] = [];
  let t = 0;
  let lateranoAmmo = 0;
  let killTime: number | null = null;
  const byUid = new Map(rt.map((u) => [u.input.uid, u]));

  const remainingHp = () => enemies.reduce((sum, e) => sum + (e.leaked ? 0 : e.alive || !e.spawned ? e.hp : 0), 0);
  const aliveCount = () => enemies.filter((e) => e.alive).length;

  const release = (e: Enemy) => {
    if (e.blockedBy !== null) {
      const b = byUid.get(e.blockedBy);
      if (b) b.blocked = b.blocked.filter((x) => x !== e);
      e.blockedBy = null;
    }
  };

  const killEnemy = (e: Enemy, by: Runtime) => {
    release(e);
    // 復活する敵：攻撃回数で倒せる状態になってその場に留まる
    const rv = e.input.spec.revive;
    if (rv && !e.revived && e.reviveAt === null && !neutral(e)) {
      e.reviveAt = t + rv.interval;
      e.hp = rv.hits;
      e.maxHp = rv.hits;
      return;
    }
    e.alive = false;
    e.reviveAt = null;
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
    by.result.kills++;
    for (const ev of by.events) if (ev.kind === 'kill' && by.result.kills % ev.every === 0) gainStacks(ev);
  };

  /** 攻撃回数で倒す状態か */
  const countsHits = (e: Enemy) => !!e.input.spec.hitsToKill || e.reviveAt !== null;

  const deal = (u: Runtime, e: Enemy, amount: number) => {
    if (!e.alive || amount <= 0) return;
    const applied = Math.min(countsHits(e) ? 1 : amount, e.hp);
    e.hp -= applied;
    u.result.damage += applied;
    while (e.phaseIdx < e.phases.length && e.hp / e.input.spec.hp <= e.phases[e.phaseIdx].belowHpRatio) {
      const p = e.phases[e.phaseIdx];
      if (p.def !== undefined) e.defense.def = p.def;
      if (p.res !== undefined) e.defense.res = p.res;
      if (p.damageTaken !== undefined) e.defense.damageTaken = p.damageTaken;
      phaseLog.push({ t, note: p.note });
      e.phaseIdx++;
    }
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
    // 攻撃を無効にする盾
    if (def.damageType !== 'heal') {
      if (u.neutralize) neutralize(e, u.neutralize);
      if (g.siracusa?.members.has(uid) && t < g.siracusa.procWindow && g.siracusa.fear > 0) {
        // シラクーザLv2：確率で恐怖（期待値で、累積が1に達するたびに発生）
        u.fearAcc += g.siracusa.procProb;
        if (u.fearAcc >= 1) {
          u.fearAcc -= 1;
          neutralize(e, g.siracusa.fear);
        }
      }
    }
    if (e.shield > 0 && def.damageType !== 'heal' && !neutral(e)) {
      e.shield--;
      return;
    }
    if (countsHits(e)) {
      if (def.damageType !== 'heal') deal(u, e, 1);
      return;
    }
    const raw = atk * scale;
    const type = bestType(def.damageType, raw, e.defense, mods);
    const dmg = hitDamage(raw, type, e.defense, mods, type === 'arts' ? artsVuln(e) : 0) * flagFactor(mods, t);
    deal(u, e, dmg);
    if (type !== 'heal' && mods.lifeOnHit) healUnit(u, u, u.maxHp * mods.lifeOnHit);
    if (type !== 'heal') {
      if (mods.trueDmgPct) deal(u, e, atk * mods.trueDmgPct * e.defense.damageTaken);
      if (g.siracusa?.members.has(uid) && t < g.siracusa.procWindow) deal(u, e, g.siracusa.procProb * g.siracusa.procDmg * e.defense.damageTaken);
      if (type === 'arts' && g.arcane?.members.has(uid) && dmg > 0) e.arcaneUntil = t + g.arcane.duration;
      // 攻撃を受けるたびに防御・術耐性が下がる
      const dr = e.input.spec.defReduce;
      if (dr && e.reduceStacks < dr.max) {
        e.reduceStacks++;
        e.defense.def = Math.max(0, e.input.spec.def + dr.def * e.reduceStacks);
        e.defense.res = currentRes(e);
      }
    }
  };

  const enemyTile = (e: Enemy) => cellPos(Math.round(e.x), Math.round(e.y));
  const remaining = (e: Enemy) => (e.input.path ? e.input.path.length - 1 - e.d : 0);

  /** 攻撃範囲内で狙える敵（優先順） */
  const targetsInRange = (u: Runtime, skillActive: boolean): Enemy[] => {
    const range = skillActive ? u.rangeSkill : u.rangeNormal;
    const list = enemies.filter((e) => {
      if (!e.alive) return false;
      if (!field) return true;
      if (e.input.spec.flying && u.melee) return false;
      // 隠匿：ブロックされている間だけ狙える（復活待ち・特殊能力無効化中は狙える）
      if (isStealthed(e)) return false;
      return !!range && range.has(enemyTile(e));
    });
    // ブロック中の敵を優先し、次に防衛地点に近い敵
    return list.sort((a, b) => Number(b.blockedBy === u.input.uid) - Number(a.blockedBy === u.input.uid) || remaining(a) - remaining(b));
  };

  /** 1回の攻撃で狙う敵と倍率 */
  const pickTargets = (u: Runtime, skillActive: boolean): [Enemy, number][] => {
    const cands = targetsInRange(u, skillActive);
    if (!cands.length) return [];
    const sub = u.input.def.subProfession;
    const n = skillActive && u.skill.maxTarget > 1 ? u.skill.maxTarget : 1;
    if (ALL_IN_RANGE_SUB.has(sub) || (sub === 'phalanx' && skillActive)) return cands.map((e) => [e, 1]);
    if (sub === 'centurion' && u.blocked.length) return u.blocked.map((e) => [e, 1]);
    if (sub === 'reaper') return cands.slice(0, Math.max(n, u.block || 1)).map((e) => [e, 1]);
    if (sub === 'chain') return cands.slice(0, Math.max(n, 4)).map((e, i) => [e, Math.pow(0.85, i)]);
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

  const endSkill = (u: Runtime) => {
    u.sp += u.input.mods.spOnSkillEnd ?? 0;
    if (!u.firstEndDone) {
      u.firstEndDone = true;
      u.sp += u.input.mods.firstSkillEndSp ?? 0;
    }
  };

  const castSkill = (u: Runtime, outerAtkPct: number) => {
    const { mods, uid, def, star } = u.input;
    const s = u.skill;
    u.sp = 0;
    u.result.skillCasts++;
    if (s.ammo > 0) u.ammoLeft = Math.round(s.ammo * (1 + (mods.ammoPct ?? 0)));
    else if (s.duration > 0) u.skillLeft = s.duration;
    // ポデンコ（胞子飛散）：着弾地点の周囲の敵の特殊能力を無効化
    const spore = SKILL_NEUTRALIZE[def.charId];
    if (spore) {
      const main = pickTargets(u, true)[0]?.[0];
      if (main) for (const e of enemies) if (e.alive && Math.hypot(e.x - main.x, e.y - main.y) <= spore.radius) neutralize(e, spore.duration);
    }
    if (s.instant && def.damageType === 'heal') {
      if (field) healAction(u, baseAtk(def, star, mods, outerAtkPct + s.atkPct), s.atkScale, true);
      endSkill(u);
    } else if (s.instant) {
      const atk = baseAtk(def, star, mods, outerAtkPct + s.atkPct);
      for (const [e, m] of pickTargets(u, true)) for (let h = 0; h < s.hits; h++) strike(u, e, atk, s.atkScale * m);
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
        u.input.pos === tile &&
        u.blocked.reduce((s, b) => s + b.input.spec.blockCnt, 0) + e.input.spec.blockCnt <= u.block + (u.skillLeft > 0 || u.ammoLeft > 0 ? u.skill.blockAdd : 0),
    );

  // ------------------------------------------------------------
  // 敵の攻撃・オペレーターの被弾と回復
  // ------------------------------------------------------------
  let indomAcc = 0;
  let egirRevives = g.egirRevive?.count ?? 0;

  /** 防御・術耐性・被ダメージ軽減を通したダメージ */
  const mitigate = (u: Runtime, raw: number, arts: boolean) => {
    const dmg = arts ? Math.max(raw * (1 - u.res / 100), raw * MIN_DAMAGE_RATIO) : Math.max(raw - u.def, raw * MIN_DAMAGE_RATIO);
    return dmg * Math.max(0, 1 - (u.input.mods.damageReduce ?? 0));
  };

  const unitDown = (u: Runtime) => {
    const ground = u.melee;
    // 不屈Lv2：地上オペレーターが倒れると全員のSP回復
    if (ground && g.indom?.sp) for (const o of rt) if (o.alive && o !== u) o.sp += g.indom.sp;
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
    u.alive = false;
    u.hp = 0;
    u.result.downAt = Math.round(t * 100) / 100;
    for (const e of u.blocked) e.blockedBy = null;
    u.blocked = [];
    u.skillLeft = 0;
    u.ammoLeft = 0;
  };

  const takeDamage = (u: Runtime, amount: number) => {
    if (!u.alive || amount <= 0) return;
    u.hp -= amount;
    u.result.taken += amount;
    if (u.hp <= 1e-6) unitDown(u);
  };

  /** 堅守Lv2：被弾した【堅守】が攻撃元に術ダメージと脆弱 */
  const steadReflect = (u: Runtime, src: Enemy) => {
    const sd = g.stead;
    if (!sd || !u.alive || !src.alive || t < u.reflectReadyAt) return;
    u.reflectReadyAt = t + sd.cooldown;
    deal(u, src, hitDamage(sd.reflect, 'arts', src.defense, {}));
    src.vulnUntil = t + sd.vulnDuration;
    src.defense.damageTaken = sd.vuln;
  };

  const hurt = (u: Runtime, raw: number, arts: boolean, src: Enemy) => {
    let dmg = mitigate(u, raw, arts);
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
    const applied = Math.min(amount, target.maxHp - target.hp);
    if (applied <= 0) return;
    target.hp += applied;
    healer.result.healed += applied;
  };

  /** 治療の範囲内にいる味方 */
  const alliesInRange = (u: Runtime, skillActive: boolean) => {
    const range = skillActive ? u.rangeSkill : u.rangeNormal;
    return rt.filter((o) => o.alive && o.input.pos !== undefined && !!range?.has(o.input.pos));
  };
  const injuredInRange = (u: Runtime, skillActive: boolean) =>
    alliesInRange(u, skillActive)
      .filter((o) => o.hp < o.maxHp - 1e-6)
      .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);

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
    }
    return true;
  };

  /** 敵の攻撃：ブロックされていればブロックしている相手、遠距離は範囲内で最後に配置された相手（警報器を優先） */
  const enemyAttacks = () => {
    for (const e of enemies) {
      const a = e.input.spec.attack;
      if (!a || !e.alive || e.reviveAt !== null) continue;
      if (e.atkTimer > 0) {
        e.atkTimer -= dt;
        continue;
      }
      let target: Runtime | undefined;
      if (e.blockedBy !== null) target = byUid.get(e.blockedBy);
      else if (a.kind === 'ranged') {
        for (const u of rt) {
          if (!u.alive || u.input.pos === undefined) continue;
          if (Math.hypot(cellX(u.input.pos) - e.x, cellY(u.input.pos) - e.y) > a.range) continue;
          const tu = u.input.mods.taunt ?? 0;
          const tt = target?.input.mods.taunt ?? 0;
          if (!target || tu > tt || (tu === tt && u.order > target.order)) target = u;
        }
      }
      if (!target || !target.alive) continue;
      hurt(target, a.atk, a.arts, e);
      e.atkTimer = a.interval;
    }
  };

  const moveEnemies = () => {
    for (const e of enemies) {
      if (!e.spawned && e.input.spawnAt <= t + 1e-9) {
        e.spawned = true;
        e.alive = true;
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
      if (!e.alive || !e.input.path || e.blockedBy !== null) continue;
      // 復活待ち：その場に留まり、時間が来たら元のHPで復活する
      if (e.reviveAt !== null) {
        if (t >= e.reviveAt) {
          e.reviveAt = null;
          e.revived = true;
          e.hp = e.input.spec.hp;
          e.maxHp = e.input.spec.hp;
        } else continue;
      }
      const path = e.input.path;
      const speed = e.input.spec.speed * moveMultiplier;
      const curTile = path[Math.min(Math.round(e.d), path.length - 1)];
      const nd = e.d + speed * dt;
      const nextTile = path[Math.min(Math.round(nd), path.length - 1)];
      if (!e.input.spec.flying && !e.input.spec.unblockable) {
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

  const unitFrame = (): [number, number][] =>
    rt.filter((u) => u.input.pos !== undefined).map((u) => [u.input.uid, u.alive ? Math.round((u.hp / u.maxHp) * 100) : -1]);

  const steps = Math.round(timeLimit / dt);
  const sampleEvery = Math.max(1, Math.round(0.5 / dt));
  const frameEvery = Math.max(1, Math.round(0.2 / dt));
  timeline.push({ t: 0, hp: remainingHp(), alive: 0 });

  for (let step = 0; step < steps; step++) {
    t = step * dt;
    moveEnemies();
    if (enemies.every((e) => e.spawned && !e.alive)) break;
    if (field) enemyAttacks();

    for (const u of rt) {
      if (!u.alive) continue;
      const { def, mods, uid, star } = u.input;
      if (mods.regenPct) healUnit(u, u, u.maxHp * mods.regenPct * dt);
      const stats = unitState(def, star).stats;
      const s = u.skill;

      const sargonCount = u.sargonBuffs.filter((until) => until > t).length;
      const lateranoAtk = g.laterano?.members.has(uid) ? Math.min(lateranoAmmo * g.laterano.atkPerAmmo, g.laterano.maxAtk) : 0;
      const castAtk = Math.min(u.result.skillCasts, mods.atkPerCastMax ?? 0) * (mods.atkPerCast ?? 0);
      const outerAtkPct = (g.sargon ? sargonCount * g.sargon.atkPct : 0) + lateranoAtk + castAtk;
      const heal = def.damageType === 'heal';

      // スキル発動判定（攻撃役は攻撃範囲に敵がいる時だけ発動する）
      const skillActive = () => u.skillLeft > 0 || u.ammoLeft > 0;
      if (!s.passive && !skillActive() && u.sp >= s.spCost && s.spCost > 0 && (heal ? !field || injuredInRange(u, true).length > 0 : targetsInRange(u, true).length > 0)) {
        castSkill(u, outerAtkPct);
      }

      const activeNow = s.passive || skillActive();
      const atk = baseAtk(def, star, mods, outerAtkPct + (activeNow ? s.atkPct : 0));
      const aspd =
        stats.aspd +
        (mods.aspd ?? 0) +
        (activeNow ? s.aspd : 0) +
        (g.sargon ? sargonCount * g.sargon.aspd : 0) +
        Math.min(u.attacks, mods.aspdPerAttackMax ?? 0) * (mods.aspdPerAttack ?? 0) +
        (g.siracusa?.members.has(uid) && t < g.siracusa.duration ? g.siracusa.aspd : 0);
      const interval = attackInterval(stats.interval, aspd, activeNow && !s.passive ? s.intervalAdd : 0);
      const scale = activeNow && !s.instant && !s.passive ? s.atkScale : 1;
      const hits = activeNow && !s.instant ? s.hits : 1;
      // 陣法術師はスキル中しか攻撃しない
      const canAttack = !heal && !(def.subProfession === 'phalanx' && !activeNow);

      // 医療：治療行動（吟遊者は範囲内の全員を毎秒攻撃力の10%回復）
      if (heal && field) {
        if (def.subProfession === 'bard') {
          for (const o of alliesInRange(u, activeNow)) healUnit(u, o, atk * 0.1 * dt);
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

      // 通常攻撃
      while (canAttack && u.atkTimer <= 1e-9) {
        const targets = pickTargets(u, activeNow);
        if (!targets.length) {
          u.atkTimer = 0;
          break;
        }
        for (const [e, m] of targets) for (let h = 0; h < hits; h++) strike(u, e, atk, scale * m);
        u.result.hits += hits;
        u.attacks++;
        if (mods.extraShotProb) {
          const e = targets[0][0];
          deal(u, e, mods.extraShotProb * hitDamage(atk * (mods.extraShotScale ?? 1), 'physical', e.defense, mods));
        }
        u.atkTimer += interval;
        if (u.ammoLeft > 0) {
          u.ammoLeft--;
          u.ammoUsed++;
          if (g.laterano?.members.has(uid)) lateranoAmmo++;
          for (const ev of u.events) if (ev.kind === 'ammo' && u.ammoUsed % ev.every === 0) gainStacks(ev);
          if (u.ammoLeft === 0) endSkill(u);
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
            for (const e of enemies) if (e.alive) deal(u, e, atk * g.kazimierzPulse.scale * e.defense.damageTaken);
          } else if (u.blocked.length && u.input.pos !== undefined) {
            const ux = cellX(u.input.pos);
            const uy = cellY(u.input.pos);
            for (const e of enemies) {
              if (e.alive && Math.hypot(e.x - ux, e.y - uy) <= 1.3) deal(u, e, atk * g.kazimierzPulse.scale * e.defense.damageTaken);
            }
          }
        }
      }

      // SP回復・スキル時間
      if (u.skillLeft > 0) {
        u.skillLeft -= dt;
        if (u.skillLeft <= 0) endSkill(u);
      } else if (u.ammoLeft <= 0 && s.charge === 'time') {
        u.sp += (1 + (mods.spRegen ?? 0)) * dt;
      }
    }

    if (killTime === null && enemies.every((e) => e.spawned && !e.alive && !e.leaked)) killTime = Math.round((t + dt) * 100) / 100;
    if ((step + 1) % sampleEvery === 0) timeline.push({ t: Math.round((step + 1) * dt * 100) / 100, hp: remainingHp(), alive: aliveCount() });
    if (opts.record && step % frameEvery === 0) {
      frames.push({
        t: Math.round(t * 100) / 100,
        e: enemies.filter((e) => e.alive).map((e) => [e.id, Math.round(e.x * 100), Math.round(e.y * 100), Math.round((e.hp / e.maxHp) * 100)]),
        s: rt.filter((u) => u.alive && (u.skillLeft > 0 || u.ammoLeft > 0)).map((u) => u.input.uid),
        u: unitFrame(),
      });
    }
    if (enemies.every((e) => e.spawned && !e.alive)) {
      t += dt;
      break;
    }
  }
  if (t < timeLimit && !enemies.every((e) => e.spawned && !e.alive)) t = timeLimit;
  timeline.push({ t: Math.round(t * 100) / 100, hp: remainingHp(), alive: aliveCount() });
  if (opts.record) {
    frames.push({
      t: Math.round(t * 100) / 100,
      e: enemies.filter((e) => e.alive).map((e) => [e.id, Math.round(e.x * 100), Math.round(e.y * 100), Math.round((e.hp / e.maxHp) * 100)]),
      s: [],
      u: unitFrame(),
    });
  }
  return { t, enemies, units: rt, timeline, phaseLog, stackGains, frames, killTime };
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

/** ラウンドの敵の出現予定（出現マスは本家の出現地点に合わせる） */
export function roundEnemies(spec: RoundSpec): EnemyInput[] {
  const out: EnemyInput[] = [];
  for (const s of spec.spawns) {
    const enemy = ENEMIES[s.enemy];
    if (!enemy) continue;
    const path = ENEMY_PATHS[s.spawn % ENEMY_PATHS.length];
    const scaled = scaledEnemy(enemy);
    const ds = enemy.deadSpawn;
    const child = ds && ENEMIES[ds.enemy] ? { key: ds.enemy, spec: scaledEnemy(ENEMIES[ds.enemy]), count: ds.count } : undefined;
    for (let i = 0; i < s.count; i++) out.push({ key: s.enemy, spec: scaled, child, spawnAt: s.delay + i * s.interval, path });
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
    limit = Math.max(limit, e.spawnAt + (e.path.length - 1) / speed + 5);
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
  let lifeLoss = 0;
  let bossRemaining = 0;
  const leakMap = new Map<string, { key: string; name: string; count: number; lifeLoss: number }>();
  for (const e of r.enemies) {
    const sp = e.input.spec;
    const timedOut = !e.leaked && (e.alive || !e.spawned);
    if (!e.leaked && !timedOut) continue;
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
  const killed = r.enemies.filter((e) => e.spawned && !e.alive && !e.leaked).length;
  const totalHp = r.enemies.reduce((s, e) => s + e.input.spec.hp, 0);
  const perUnit = r.units.map((u) => ({ ...u.result, damage: Math.round(u.result.damage) }));
  return {
    round: spec.round,
    timeLimit: limit,
    elapsed: Math.round(r.t * 100) / 100,
    total: r.enemies.length,
    killed,
    leaked: r.enemies.length - killed,
    lifeLoss,
    leaks: [...leakMap.values()],
    bossRemaining,
    cleared: killed === r.enemies.length,
    totalDamage: perUnit.reduce((s, u) => s + u.damage, 0),
    totalHp,
    perUnit,
    timeline: r.timeline,
    stackGains: r.stackGains,
    enemies: r.enemies.map((e) => ({ id: e.id, key: e.input.key, name: e.input.spec.name, boss: e.input.spec.boss, flying: e.input.spec.flying, maxHp: e.input.spec.hp })),
    frames: opts.record ? r.frames : undefined,
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
    perUnit: r.units.map((u) => ({ ...u.result, damage: Math.round(u.result.damage) })),
    timeline: r.timeline.map(({ t, hp }) => ({ t, hp })),
    phaseLog: r.phaseLog,
    stackGains: r.stackGains,
  };
}
