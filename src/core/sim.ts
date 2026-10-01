import { STAR_ATK_MULT } from './rules';
import type { DamageType, EnemyDef, EnemyPhase, Modifier, Star, UnitDef } from './types';

// 単体標的に対する DPS チェックの時間刻みシミュレーション。
// 決定的（乱数なし）に動くよう、会心は期待値で計算している。

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
  /** 実際に戦った時間 */
  elapsed: number;
  totalDamage: number;
  remainingHp: number;
  perUnit: SimUnitResult[];
  /** 0.5秒ごとの敵HP */
  timeline: { t: number; hp: number }[];
  /** フェーズ移行の記録 */
  phaseLog: { t: number; note: string }[];
}

export const BASE_CRIT_DMG = 0.5;
export const MIN_DAMAGE_RATIO = 0.05;

export interface DefenseState {
  def: number;
  res: number;
  damageTaken: number;
}

/** 1ヒットぶんのダメージ（会心は期待値） */
export function hitDamage(
  atk: number,
  type: DamageType,
  enemy: DefenseState,
  mods: Modifier,
): number {
  let dmg: number;
  if (type === 'physical') {
    const def = Math.max(0, enemy.def * (1 - Math.min(mods.defIgnorePct ?? 0, 1)));
    dmg = Math.max(atk - def, atk * MIN_DAMAGE_RATIO);
  } else if (type === 'arts') {
    const res = Math.min(Math.max(0, enemy.res - (mods.resIgnore ?? 0)), 100);
    dmg = Math.max(atk * (1 - res / 100), atk * MIN_DAMAGE_RATIO);
  } else {
    dmg = atk;
  }
  const critChance = Math.min(mods.critChance ?? 0, 1);
  const critMult = 1 + BASE_CRIT_DMG + (mods.critDmg ?? 0);
  dmg *= 1 + critChance * (critMult - 1);
  dmg *= 1 + (mods.damagePct ?? 0);
  dmg += atk * (mods.trueDmgPct ?? 0);
  return dmg * enemy.damageTaken;
}

interface RuntimeUnit {
  input: SimUnitInput;
  baseAtk: number;
  atkTimer: number;
  sp: number;
  skillLeft: number;
  result: SimUnitResult;
}

export function effectiveAtk(def: UnitDef, star: Star, mods: Modifier, skillAtkPct = 0): number {
  return def.atk * STAR_ATK_MULT[star - 1] * (1 + (mods.atkPct ?? 0) + skillAtkPct);
}

export function attackInterval(def: UnitDef, aspd: number): number {
  return (def.interval * 100) / Math.max(10, 100 + aspd);
}

export function simulateDps(units: SimUnitInput[], enemy: EnemyDef, dt = 0.05): SimResult {
  const rt: RuntimeUnit[] = units.map((input) => ({
    input,
    baseAtk: effectiveAtk(input.def, input.star, input.mods),
    atkTimer: 0,
    sp: input.def.skill.initialSp + (input.mods.startSp ?? 0),
    skillLeft: 0,
    result: {
      uid: input.uid,
      defId: input.def.id,
      name: input.def.name,
      star: input.star,
      damage: 0,
      hits: 0,
      skillCasts: 0,
    },
  }));

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
  let currentT = 0;

  const deal = (u: RuntimeUnit, amount: number) => {
    const applied = Math.min(amount, hp);
    hp -= applied;
    u.result.damage += applied;
    // フェーズ移行
    while (phaseIdx < phases.length && hp / enemy.hp <= phases[phaseIdx].belowHpRatio) {
      const p = phases[phaseIdx];
      if (p.def !== undefined) defense.def = p.def;
      if (p.res !== undefined) defense.res = p.res;
      if (p.damageTaken !== undefined) defense.damageTaken = p.damageTaken;
      phaseLog.push({ t: currentT, note: p.note });
      phaseIdx++;
    }
  };

  for (let step = 0; step < steps && hp > 0; step++) {
    currentT = step * dt;
    for (const u of rt) {
      if (hp <= 0) break;
      const { def, mods } = u.input;
      const skill = def.skill;

      // スキル発動判定
      if (u.skillLeft <= 0 && u.sp >= skill.spCost) {
        u.sp = 0;
        u.result.skillCasts++;
        if (skill.duration > 0) u.skillLeft = skill.duration;
        if (skill.burst) {
          const atk = effectiveAtk(def, u.input.star, mods);
          const type = skill.damageType ?? def.damageType;
          deal(u, hitDamage(atk * skill.burst, type, defense, mods));
        }
      }

      const active = u.skillLeft > 0;
      const atk = active ? effectiveAtk(def, u.input.star, mods, skill.atkPct ?? 0) : u.baseAtk;
      const aspd = (mods.aspd ?? 0) + (active ? skill.aspd ?? 0 : 0);
      const interval = attackInterval(def, aspd);
      const type = (active ? skill.damageType : undefined) ?? def.damageType;
      const hits = active ? skill.hits ?? 1 : 1;

      // 通常攻撃（1ステップで複数回攻撃することもある）
      while (u.atkTimer <= 1e-9 && hp > 0) {
        for (let h = 0; h < hits; h++) deal(u, hitDamage(atk, type, defense, mods));
        u.result.hits += hits;
        u.atkTimer += interval;
        if (skill.spOnHit && !active) u.sp += 1;
      }
      u.atkTimer -= dt;

      // SP回復・スキル時間
      if (active) {
        u.skillLeft -= dt;
      } else if (!skill.spOnHit) {
        u.sp += (1 + (mods.spRegen ?? 0)) * dt;
      }
    }

    if (hp <= 0) {
      killTime = Math.round((currentT + dt) * 100) / 100;
      elapsed = killTime;
    }
    if ((step + 1) % sampleEvery === 0 || hp <= 0) {
      timeline.push({ t: Math.round((step + 1) * dt * 100) / 100, hp: Math.max(0, hp) });
    }
  }

  const perUnit = rt.map((u) => ({ ...u.result, damage: Math.round(u.result.damage) }));
  return {
    enemy,
    killed: hp <= 0,
    killTime,
    elapsed,
    totalDamage: Math.round(enemy.hp - Math.max(0, hp)),
    remainingHp: Math.max(0, Math.round(hp)),
    perUnit,
    timeline,
    phaseLog,
  };
}
