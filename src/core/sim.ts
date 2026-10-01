import { bondKey, type BattleGlobals } from './alliance';
import { unitState } from './data/units';
import type { AllianceId, DamageType, EnemyDef, EnemyPhase, Modifier, SkillData, Star, UnitDef } from './types';

// 単体標的に対する DPS チェックの時間刻みシミュレーション。
// 本家のスキルデータ（blackboard）から攻撃力・攻撃速度・倍率などを読み取り、
// 単体の敵に対してどれだけ削れるかを近似する。確率効果は期待値で扱うので結果は決定的。

export interface SimUnitInput {
  uid: number;
  def: UnitDef;
  star: Star;
  mods: Modifier;
}

export interface SimUnitResult {
  uid: number;
  defId: string;
  name: string;
  star: Star;
  damage: number;
  hits: number;
  skillCasts: number;
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

// ------------------------------------------------------------
// シミュレーション本体
// ------------------------------------------------------------

interface GarrisonEvent {
  kind: 'useskill' | 'kill' | 'ammo';
  bonds: AllianceId[] | 'maxstack';
  count: number;
  max: number;
  every: number;
  gained: number;
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
}

export interface SimOptions {
  dt?: number;
  globals?: BattleGlobals;
  /** 有効化中の盟約と加算数（戦闘中の加算数獲得の判定用） */
  activeAlliances?: Set<AllianceId>;
  stacks?: Partial<Record<AllianceId, number>>;
}

function garrisonEvents(def: UnitDef, star: Star): GarrisonEvent[] {
  const out: GarrisonEvent[] = [];
  for (const g of unitState(def, star).garrisons) {
    if (g.event !== 'IN_BATTLE' || g.effect !== 'ADD_BOND') continue;
    const bb = g.blackboard;
    const key = bb.key as string | undefined;
    const kind = key === 'act1autochess_gar_event_useskill' ? 'useskill' : key === 'act1autochess_gar_event_selfkillenemy' ? 'kill' : key === 'act1autochess_gar_event_consume_ammo' ? 'ammo' : null;
    if (!kind || bb.bond_add_type !== 'by_count') continue;
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
      count: Number(bb.bond_add_count ?? 0),
      max: Number(bb.max_add_count_per_battle ?? Infinity),
      every: Number(bb.consume_count ?? 1),
      gained: 0,
    });
  }
  return out;
}

export function simulateDps(units: SimUnitInput[], enemy: EnemyDef, opts: SimOptions = {}): SimResult {
  const dt = opts.dt ?? 0.05;
  const g = opts.globals ?? {};
  const active = opts.activeAlliances ?? new Set<AllianceId>();
  const stacks = opts.stacks ?? {};
  const stackGains: Partial<Record<AllianceId, number>> = {};

  const rt: Runtime[] = units.map((input) => {
    const skill = parseSkill(unitState(input.def, input.star).skill);
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
      events: garrisonEvents(input.def, input.star),
      result: { uid: input.uid, defId: input.def.id, name: input.def.name, star: input.star, damage: 0, hits: 0, skillCasts: 0 },
    };
  });

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

  let hp = enemy.hp;
  const defense: DefenseState = { def: enemy.def, res: enemy.res, damageTaken: 1 };
  const phases: EnemyPhase[] = [...(enemy.phases ?? [])].sort((a, b) => b.belowHpRatio - a.belowHpRatio);
  let phaseIdx = 0;
  const phaseLog: SimResult['phaseLog'] = [];
  const timeline: SimResult['timeline'] = [{ t: 0, hp }];
  const steps = Math.round(enemy.duration / dt);
  const sampleEvery = Math.max(1, Math.round(0.5 / dt));
  let killTime: number | null = null;
  let elapsed = enemy.duration;
  let t = 0;
  let arcaneUntil = -1;
  let lateranoAmmo = 0;

  const deal = (u: Runtime, amount: number) => {
    if (hp <= 0 || amount <= 0) return;
    const applied = Math.min(amount, hp);
    hp -= applied;
    u.result.damage += applied;
    while (phaseIdx < phases.length && hp / enemy.hp <= phases[phaseIdx].belowHpRatio) {
      const p = phases[phaseIdx];
      if (p.def !== undefined) defense.def = p.def;
      if (p.res !== undefined) defense.res = p.res;
      if (p.damageTaken !== undefined) defense.damageTaken = p.damageTaken;
      phaseLog.push({ t, note: p.note });
      phaseIdx++;
    }
    if (hp <= 0) for (const ev of u.events) if (ev.kind === 'kill') gainStacks(ev);
  };

  const artsVuln = () => {
    if (!g.arcane || t > arcaneUntil) return 0;
    return g.arcane.vulnLow > 0 && hp / enemy.hp < g.arcane.lowRatio ? g.arcane.vulnLow : g.arcane.vuln;
  };

  /** 1ヒット（倍率 scale）を与える */
  const strike = (u: Runtime, atk: number, scale: number) => {
    const { def, mods, uid } = u.input;
    const raw = atk * scale;
    const type = bestType(def.damageType, raw, defense, mods);
    const dmg = hitDamage(raw, type, defense, mods, type === 'arts' ? artsVuln() : 0);
    deal(u, dmg);
    if (type !== 'heal') {
      if (mods.trueDmgPct) deal(u, atk * mods.trueDmgPct * defense.damageTaken);
      if (g.siracusa?.members.has(uid) && t < g.siracusa.procWindow) deal(u, g.siracusa.procProb * g.siracusa.procDmg * defense.damageTaken);
      if (type === 'arts' && g.arcane?.members.has(uid) && dmg > 0) arcaneUntil = t + g.arcane.duration;
    }
  };

  const endSkill = (u: Runtime) => {
    u.sp += u.input.mods.spOnSkillEnd ?? 0;
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
      for (let h = 0; h < s.hits; h++) strike(u, atk, s.atkScale);
      endSkill(u);
    }
    if (g.sargon?.members.has(uid)) {
      for (const o of rt) {
        if (!g.sargon.members.has(o.input.uid)) continue;
        o.sargonBuffs = o.sargonBuffs.filter((until) => until > t);
        if (o.sargonBuffs.length < g.sargon.maxStacks) o.sargonBuffs.push(t + g.sargon.duration);
      }
    }
    for (const ev of u.events) if (ev.kind === 'useskill') gainStacks(ev);
  };

  for (let step = 0; step < steps && hp > 0; step++) {
    t = step * dt;
    for (const u of rt) {
      if (hp <= 0) break;
      const { def, mods, uid, star } = u.input;
      const stats = unitState(def, star).stats;
      const s = u.skill;

      const sargonCount = u.sargonBuffs.filter((until) => until > t).length;
      const lateranoAtk = g.laterano?.members.has(uid) ? Math.min(lateranoAmmo * g.laterano.atkPerAmmo, g.laterano.maxAtk) : 0;
      const outerAtkPct = (g.sargon ? sargonCount * g.sargon.atkPct : 0) + lateranoAtk;

      // スキル発動判定
      const skillActive = () => u.skillLeft > 0 || u.ammoLeft > 0;
      if (!s.passive && !skillActive() && u.sp >= s.spCost && s.spCost > 0) {
        castSkill(u, outerAtkPct);
      }

      const activeNow = s.passive || skillActive();
      const atk = baseAtk(def, star, mods, outerAtkPct + (activeNow ? s.atkPct : 0));
      const aspd =
        stats.aspd +
        (mods.aspd ?? 0) +
        (activeNow ? s.aspd : 0) +
        (g.sargon ? sargonCount * g.sargon.aspd : 0) +
        (g.siracusa?.members.has(uid) && t < g.siracusa.duration ? g.siracusa.aspd : 0);
      const interval = attackInterval(stats.interval, aspd, activeNow && !s.passive ? s.intervalAdd : 0);
      const scale = activeNow && !s.instant && !s.passive ? s.atkScale : 1;
      const hits = activeNow && !s.instant ? s.hits : 1;

      // 通常攻撃
      while (u.atkTimer <= 1e-9 && hp > 0) {
        for (let h = 0; h < hits; h++) strike(u, atk, scale);
        u.result.hits += hits;
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
      u.atkTimer -= dt;

      // カジミエーシュLv2の周期ダメージ（近接）
      if (g.kazimierzPulse?.members.has(uid)) {
        u.pulseTimer -= dt;
        if (u.pulseTimer <= 0) {
          deal(u, atk * g.kazimierzPulse.scale * defense.damageTaken);
          u.pulseTimer += g.kazimierzPulse.interval;
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

    if (hp <= 0) {
      killTime = Math.round((t + dt) * 100) / 100;
      elapsed = killTime;
    }
    if ((step + 1) % sampleEvery === 0 || hp <= 0) {
      timeline.push({ t: Math.round((step + 1) * dt * 100) / 100, hp: Math.max(0, hp) });
    }
  }

  return {
    enemy,
    killed: hp <= 0,
    killTime,
    elapsed,
    totalDamage: Math.round(enemy.hp - Math.max(0, hp)),
    remainingHp: Math.max(0, Math.round(hp)),
    perUnit: rt.map((u) => ({ ...u.result, damage: Math.round(u.result.damage) })),
    timeline,
    phaseLog,
    stackGains,
  };
}
