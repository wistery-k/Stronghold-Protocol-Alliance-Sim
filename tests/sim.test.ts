import { describe, expect, it } from 'vitest';
import { attackInterval, hitDamage, parseSkill, simulateDps } from '../src/core/sim';
import { battleSetup } from '../src/core/alliance';
import { UNITS, getUnit } from '../src/core/data/units';
import type { EnemyDef, UnitDef } from '../src/core/types';

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
const byName = (name: string) => UNITS.find((u) => u.name === name)!;

/** スキルを発動しないようにした複製 */
function withoutSkill(def: UnitDef): UnitDef {
  const c = structuredClone(def);
  c.normal.skill.spCost = 9999;
  c.normal.skill.initSp = 0;
  c.normal.garrisons = [];
  return c;
}

describe('hitDamage', () => {
  it('物理は攻撃力-防御、最低5%保証', () => {
    expect(hitDamage(1000, 'physical', { ...noDef, def: 300 }, {})).toBe(700);
    expect(hitDamage(1000, 'physical', { ...noDef, def: 5000 }, {})).toBe(50);
  });

  it('術は術耐性で割合軽減、耐性無視（割合）と被術ダメージ上昇が効く', () => {
    expect(hitDamage(1000, 'arts', { ...noDef, res: 40 }, {})).toBeCloseTo(600);
    expect(hitDamage(1000, 'arts', { ...noDef, res: 40 }, { resIgnorePct: 0.5 })).toBeCloseTo(800);
    expect(hitDamage(1000, 'arts', { ...noDef, res: 40 }, {}, 0.2)).toBeCloseTo(720);
  });

  it('防御無視・与ダメ加算・与ダメ倍率', () => {
    expect(hitDamage(1000, 'physical', { ...noDef, def: 400 }, { defIgnorePct: 0.5 })).toBe(800);
    expect(hitDamage(1000, 'true', noDef, { damagePct: 0.1, damageMult: 1.25 })).toBeCloseTo(1375);
  });

  it('治療職はダメージを与えない', () => {
    expect(hitDamage(1000, 'heal', noDef, {})).toBe(0);
  });
});

describe('attackInterval', () => {
  it('攻撃速度200で間隔が半分', () => {
    expect(attackInterval(1.0, 200)).toBeCloseTo(0.5);
  });
  it('base_attack_time は秒単位で加算', () => {
    expect(attackInterval(2.8, 100, -1.8)).toBeCloseTo(1.0);
  });
});

describe('parseSkill', () => {
  it('弾薬型スキルの弾数を読む', () => {
    const s = parseSkill(byName('インサイダー').normal.skill);
    expect(s.ammo).toBe(14);
    expect(s.atkPct).toBeCloseTo(0.8);
    expect(s.intervalAdd).toBeCloseTo(-0.3);
  });
  it('攻撃間隔短縮のスキル', () => {
    const s = parseSkill(byName('ホルン').golden.skill);
    expect(s.intervalAdd).toBeCloseTo(-1.8);
    expect(s.duration).toBeGreaterThan(0);
  });
  it('メテオS1：命中した敵の防御力低下', () => {
    const s = parseSkill(byName('メテオ').normal.skill);
    expect(s.instant).toBe(true);
    expect(s.atkScale).toBeCloseTo(1.35);
    expect(s.hitDefDown).toBeCloseTo(-0.25);
    expect(s.hitDefDownTime).toBe(5);
  });
  it('「次の通常攻撃時」のチャージ・連撃・周囲全員・範囲拡大', () => {
    const malist = parseSkill(byName('ミニマリスト').golden.skill);
    expect(malist.charges).toBe(3);
    expect(malist.hits).toBe(2);
    const bpipe = parseSkill(byName('バグパイプ').normal.skill);
    expect(bpipe.charges).toBe(1);
    expect(bpipe.hits).toBe(2);
    expect(bpipe.atkScale).toBeCloseTo(1.45);
    expect(parseSkill(byName('グム').golden.skill).charges).toBe(2);
    const mud = parseSkill(byName('マドロック').normal.skill);
    expect(mud.allGround).toBe(true);
    expect(mud.hits).toBe(1);
    const dusk = parseSkill(byName('シー').normal.skill);
    expect(dusk.charges).toBe(2);
    expect(dusk.splashRadius > 1).toBe(true);
    expect(parseSkill(byName('メテオ').normal.skill).charges).toBe(1);
  });
});

describe('simulateDps', () => {
  it('スキルを使わなければ 攻撃力×攻撃回数 になる', () => {
    const def = withoutSkill(byName('インサイダー'));
    const r = simulateDps([{ uid: 1, def, star: 1, mods: {} }], dummy({ duration: 10 }));
    // 間隔1.0秒で t=0 から攻撃 → 10秒間で10回
    expect(r.perUnit[0].hits).toBe(10);
    expect(r.totalDamage).toBe(def.normal.stats.atk * 10);
  });

  it('同じ入力なら同じ結果（決定的）', () => {
    const units = UNITS.slice(0, 6).map((def, i) => ({ uid: i, def, star: 1 as const, mods: {} }));
    const e = dummy({ hp: 50000, def: 200, res: 20, duration: 30 });
    expect(simulateDps(units, e)).toEqual(simulateDps(units, e));
  });

  it('昇進すると強くなる', () => {
    const def = getUnit(byName('スカジ').id);
    const e = dummy({ duration: 60, def: 300 });
    const n = simulateDps([{ uid: 1, def, star: 1, mods: {} }], e).totalDamage;
    const g = simulateDps([{ uid: 1, def, star: 2, mods: {} }], e).totalDamage;
    expect(g).toBeGreaterThan(n);
  });

  it('撃破時刻が記録され、HPは0で止まる', () => {
    const r = simulateDps([{ uid: 1, def: byName('スカジ'), star: 2, mods: {} }], dummy({ hp: 5000 }));
    expect(r.killed).toBe(true);
    expect(r.remainingHp).toBe(0);
    expect(r.totalDamage).toBe(5000);
  });

  it('フェーズ移行で防御が変わる', () => {
    const e = dummy({ hp: 5000, def: 0, duration: 60, phases: [{ belowHpRatio: 0.5, def: 99999, note: '硬化' }] });
    const r = simulateDps([{ uid: 1, def: withoutSkill(byName('インサイダー')), star: 1, mods: {} }], e);
    expect(r.phaseLog).toHaveLength(1);
    expect(r.killed).toBe(false);
  });

  it('スノーハンターの素質の一撃はゲームデータの倍率（攻撃力の180%）', () => {
    // 開始直後にスキルを撃たせる：通常攻撃120%＋特殊弾160%×2＋素質180%
    const def = structuredClone(byName('スノーハンター'));
    def.normal.skill.initSp = def.normal.skill.spCost;
    const r = simulateDps([{ uid: 1, def, star: 1, mods: {} }], dummy({ duration: 0.05 }));
    expect(r.perUnit[0].skillCasts).toBe(1);
    expect(r.totalDamage).toBe(Math.round(def.normal.stats.atk * (1.2 + 1.6 * 2 + 1.8)));
  });

  it('スキル発動で加算数を得る特性（パピルス：サルゴン）', () => {
    const def = byName('パピルス');
    const r = simulateDps([{ uid: 1, def, star: 1, mods: {} }], dummy({ duration: 60 }), { activeAlliances: new Set(['sargon']) });
    expect(r.stackGains.sargon).toBe(5);
    const r2 = simulateDps([{ uid: 1, def, star: 1, mods: {} }], dummy({ duration: 60 }), { activeAlliances: new Set() });
    expect(r2.stackGains.sargon).toBeUndefined();
  });
});

describe('位置による効果', () => {
  it('器用は周囲4マスのオペレーターにも攻撃速度を与える', () => {
    const u = (uid: number, name: string, pos: number) => ({ uid, defId: byName(name).id, star: 1 as const, pos });
    const board = [u(1, 'ティッピ', 28), u(2, 'アルケット', 11), u(3, 'スカジ', 29), u(4, 'スペクター', 34)];
    const setup = battleSetup(board, [], {});
    expect(setup.mods.get(3)?.aspd ?? 0).toBeGreaterThan(0); // ティッピの右隣
    expect(setup.mods.get(4)?.aspd ?? 0).toBe(0); // 離れている
  });
});
