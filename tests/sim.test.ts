import { describe, expect, it } from 'vitest';
import { attackInterval, hitDamage, simulateDps } from '../src/core/sim';
import { getUnit } from '../src/core/data/units';
import type { EnemyDef } from '../src/core/types';

const dummy = (over: Partial<EnemyDef> = {}): EnemyDef => ({
  id: 'dummy',
  name: '木人',
  hp: 1e12,
  def: 0,
  res: 0,
  duration: 10,
  isBoss: false,
  ...over,
});

const noDef = { def: 0, res: 0, damageTaken: 1 };

describe('hitDamage', () => {
  it('物理は攻撃力-防御、最低5%保証', () => {
    expect(hitDamage(1000, 'physical', { ...noDef, def: 300 }, {})).toBe(700);
    expect(hitDamage(1000, 'physical', { ...noDef, def: 5000 }, {})).toBe(50);
  });

  it('術は術耐性で割合軽減、耐性無視が効く', () => {
    expect(hitDamage(1000, 'arts', { ...noDef, res: 40 }, {})).toBeCloseTo(600);
    expect(hitDamage(1000, 'arts', { ...noDef, res: 40 }, { resIgnore: 20 })).toBeCloseTo(800);
  });

  it('防御無視・与ダメ・確定追加・会心期待値', () => {
    expect(hitDamage(1000, 'physical', { ...noDef, def: 400 }, { defIgnorePct: 0.5 })).toBe(800);
    expect(hitDamage(1000, 'true', noDef, { damagePct: 0.1 })).toBeCloseTo(1100);
    expect(hitDamage(1000, 'true', noDef, { trueDmgPct: 0.2 })).toBeCloseTo(1200);
    // 会心率50%、会心倍率1.5 → 期待値 1.25倍
    expect(hitDamage(1000, 'true', noDef, { critChance: 0.5 })).toBeCloseTo(1250);
  });
});

describe('attackInterval', () => {
  it('攻撃速度+100で間隔が半分', () => {
    const d = getUnit('bolt');
    expect(attackInterval(d, 100)).toBeCloseTo(d.interval / 2);
  });
});

describe('simulateDps', () => {
  it('スキルが発動しない範囲では 攻撃力×攻撃回数 になる', () => {
    const def = { ...getUnit('bolt'), skill: { ...getUnit('bolt').skill, spCost: 9999 } };
    const r = simulateDps([{ uid: 1, def, star: 1, mods: {} }], dummy({ duration: 10 }));
    // 間隔1.0秒で t=0 から攻撃 → 10秒間で10回
    expect(r.perUnit[0].hits).toBe(10);
    expect(r.totalDamage).toBe(def.atk * 10);
  });

  it('同じ入力なら同じ結果（決定的）', () => {
    const units = ['kite', 'ember', 'hawk'].map((id, i) => ({ uid: i, def: getUnit(id), star: 1 as const, mods: {} }));
    const e = dummy({ hp: 50000, def: 200, res: 20, duration: 30 });
    expect(simulateDps(units, e)).toEqual(simulateDps(units, e));
  });

  it('撃破時刻が記録され、HPは0で止まる', () => {
    const r = simulateDps([{ uid: 1, def: getUnit('nova'), star: 3, mods: {} }], dummy({ hp: 5000 }));
    expect(r.killed).toBe(true);
    expect(r.remainingHp).toBe(0);
    expect(r.totalDamage).toBe(5000);
    expect(r.killTime).not.toBeNull();
  });

  it('フェーズ移行で防御が変わる', () => {
    const e = dummy({ hp: 20000, def: 0, duration: 60, phases: [{ belowHpRatio: 0.5, def: 99999, note: '硬化' }] });
    const r = simulateDps([{ uid: 1, def: getUnit('bolt'), star: 1, mods: {} }], e);
    expect(r.phaseLog).toHaveLength(1);
    expect(r.killed).toBe(false);
  });
});
