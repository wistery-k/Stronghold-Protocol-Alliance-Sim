import { bondKey, type BattleGlobals } from './alliance';
import { ENEMY_PATHS, canBlockAt, cellPos, cellX, cellY, rangeCells, DEFAULT_DIRECTION } from './board';
import { ENEMIES, rangeGrid, unitRangeIds, type EnemySpec, type RoundSpec } from './data/battle';
import { ENEMY_HP_SCALE, ENEMY_SPEED_SCALE } from './rules';
import { unitState } from './data/units';
import type { AllianceId, DamageType, Direction, EnemyDef, EnemyPhase, GarrisonData, Modifier, SkillData, Star, UnitDef } from './types';

// 戦闘シミュレーション（時間刻み）。
// - マップ戦闘：敵が経路を進み、地上のオペレーターがブロックし、攻撃範囲内の敵を攻撃する。敵は攻撃してこない。
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

interface EnemyInput {
  key: string;
  spec: Pick<EnemySpec, 'name' | 'hp' | 'def' | 'res' | 'speed' | 'blockCnt' | 'flying' | 'boss' | 'lifeReduce'>;
  spawnAt: number;
  /** 経路（マス番号）。null なら動かない標的 */
  path: number[] | null;
  phases?: EnemyPhase[];
}

interface Enemy {
  id: number;
  input: EnemyInput;
  hp: number;
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
      firstEndDone: false,
      events: garrisonEvents(input),
      result: { uid: input.uid, defId: input.def.id, name: input.def.name, star: input.star, damage: 0, hits: 0, skillCasts: 0, kills: 0 },
      melee: MELEE.has(input.def.profession),
      blocker,
      block: blocker ? st.stats.block : 0,
      rangeNormal: field ? toSet(input.pos, input.dir, ids.range) : null,
      rangeSkill: field ? toSet(input.pos, input.dir, ids.skillRange ?? ids.range) : null,
      blocked: [],
    };
  });

  const enemies: Enemy[] = enemyInputs
    .map((input, i) => ({
      id: i + 1,
      input,
      hp: input.spec.hp,
      defense: { def: input.spec.def, res: input.spec.res, damageTaken: 1 },
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
    }))
    .sort((a, b) => a.input.spawnAt - b.input.spawnAt);

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

  const killEnemy = (e: Enemy, by: Runtime) => {
    e.alive = false;
    if (e.blockedBy !== null) {
      const b = byUid.get(e.blockedBy);
      if (b) b.blocked = b.blocked.filter((x) => x !== e);
      e.blockedBy = null;
    }
    by.result.kills++;
    for (const ev of by.events) if (ev.kind === 'kill' && by.result.kills % ev.every === 0) gainStacks(ev);
  };

  const deal = (u: Runtime, e: Enemy, amount: number) => {
    if (!e.alive || amount <= 0) return;
    const applied = Math.min(amount, e.hp);
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
    const raw = atk * scale;
    const type = bestType(def.damageType, raw, e.defense, mods);
    const dmg = hitDamage(raw, type, e.defense, mods, type === 'arts' ? artsVuln(e) : 0) * flagFactor(mods, t);
    deal(u, e, dmg);
    if (type !== 'heal') {
      if (mods.trueDmgPct) deal(u, e, atk * mods.trueDmgPct * e.defense.damageTaken);
      if (g.siracusa?.members.has(uid) && t < g.siracusa.procWindow) deal(u, e, g.siracusa.procProb * g.siracusa.procDmg * e.defense.damageTaken);
      if (type === 'arts' && g.arcane?.members.has(uid) && dmg > 0) e.arcaneUntil = t + g.arcane.duration;
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
    if (s.instant) {
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
        u.input.pos === tile &&
        u.blocked.reduce((s, b) => s + b.input.spec.blockCnt, 0) + e.input.spec.blockCnt <= u.block + (u.skillLeft > 0 || u.ammoLeft > 0 ? u.skill.blockAdd : 0),
    );

  const moveEnemies = () => {
    for (const e of enemies) {
      if (!e.spawned && e.input.spawnAt <= t + 1e-9) {
        e.spawned = true;
        e.alive = true;
      }
      if (!e.alive || !e.input.path || e.blockedBy !== null) continue;
      const path = e.input.path;
      const speed = e.input.spec.speed * moveMultiplier;
      const curTile = path[Math.min(Math.round(e.d), path.length - 1)];
      const nd = e.d + speed * dt;
      const nextTile = path[Math.min(Math.round(nd), path.length - 1)];
      if (!e.input.spec.flying) {
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

  const steps = Math.round(timeLimit / dt);
  const sampleEvery = Math.max(1, Math.round(0.5 / dt));
  const frameEvery = Math.max(1, Math.round(0.2 / dt));
  timeline.push({ t: 0, hp: remainingHp(), alive: 0 });

  for (let step = 0; step < steps; step++) {
    t = step * dt;
    moveEnemies();
    if (enemies.every((e) => e.spawned && !e.alive)) break;

    for (const u of rt) {
      const { def, mods, uid, star } = u.input;
      const stats = unitState(def, star).stats;
      const s = u.skill;

      const sargonCount = u.sargonBuffs.filter((until) => until > t).length;
      const lateranoAtk = g.laterano?.members.has(uid) ? Math.min(lateranoAmmo * g.laterano.atkPerAmmo, g.laterano.maxAtk) : 0;
      const castAtk = Math.min(u.result.skillCasts, mods.atkPerCastMax ?? 0) * (mods.atkPerCast ?? 0);
      const outerAtkPct = (g.sargon ? sargonCount * g.sargon.atkPct : 0) + lateranoAtk + castAtk;
      const heal = def.damageType === 'heal';

      // スキル発動判定（攻撃役は攻撃範囲に敵がいる時だけ発動する）
      const skillActive = () => u.skillLeft > 0 || u.ammoLeft > 0;
      if (!s.passive && !skillActive() && u.sp >= s.spCost && s.spCost > 0 && (heal || targetsInRange(u, true).length > 0)) {
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

      // 回復職もSPは貯まる（攻撃回復型は攻撃の代わりに時間で貯める）
      if (heal && s.charge === 'attack' && !activeNow) u.sp += dt / Math.max(0.2, interval);

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
        e: enemies.filter((e) => e.alive).map((e) => [e.id, Math.round(e.x * 100), Math.round(e.y * 100), Math.round((e.hp / e.input.spec.hp) * 100)]),
        s: rt.filter((u) => u.skillLeft > 0 || u.ammoLeft > 0).map((u) => u.input.uid),
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
      e: enemies.filter((e) => e.alive).map((e) => [e.id, Math.round(e.x * 100), Math.round(e.y * 100), Math.round((e.hp / e.input.spec.hp) * 100)]),
      s: [],
    });
  }
  return { t, enemies, units: rt, timeline, phaseLog, stackGains, frames, killTime };
}

// ------------------------------------------------------------
// マップ戦闘
// ------------------------------------------------------------

/** ラウンドの敵の出現予定（経路は本家の経路番号を出現地点に振り分ける） */
export function roundEnemies(spec: RoundSpec): EnemyInput[] {
  const out: EnemyInput[] = [];
  for (const s of spec.spawns) {
    const enemy = ENEMIES[s.enemy];
    if (!enemy) continue;
    const path = ENEMY_PATHS[s.route % ENEMY_PATHS.length];
    // ボスは調整しない（本家の耐久のまま）
    const hpScale = enemy.boss ? 1 : ENEMY_HP_SCALE;
    const scaled = { ...enemy, hp: Math.round(enemy.hp * hpScale), speed: enemy.speed * ENEMY_SPEED_SCALE };
    for (let i = 0; i < s.count; i++) out.push({ key: s.enemy, spec: scaled, spawnAt: s.delay + i * s.interval, path });
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
