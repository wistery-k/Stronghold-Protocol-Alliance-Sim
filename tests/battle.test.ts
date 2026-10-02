import { describe, expect, it } from 'vitest';
import { ENEMY_PATHS, GOAL, SPAWNS, canPlace, tileAt } from '../src/core/board';
import { ENEMIES, ENEMY_GROUPS, ROUNDS, pickRoundGroup, roundSpec, type EnemySpec, type RoundSpec } from '../src/core/data/battle';
import { UNITS } from '../src/core/data/units';
import { buildSimInputs, createGame, roundGroupOf } from '../src/core/game';
import { simulateBattle } from '../src/core/sim';
import type { OwnedUnit } from '../src/core/types';

const byProf = (p: string) => UNITS.find((u) => u.profession === p && u.tier <= 3)!;

/** テスト用：倒れない敵を1体だけ出すラウンド */
function oneEnemy(key: string, flying: boolean, over: Partial<EnemySpec> = {}): RoundSpec {
  ENEMIES[key] = { name: key, hp: 1e9, def: 5000, res: 100, speed: 1, blockCnt: 1, flying, boss: false, elite: false, lifeReduce: 1, ...over };
  return { round: 1, levelId: 'test', timeLimit: 30, moveMultiplier: 0.5, spawns: [{ enemy: key, count: 1, interval: 0, delay: 0, spawn: 1 }] };
}

function run(board: OwnedUnit[], spec: RoundSpec) {
  const { inputs, globals } = buildSimInputs(board, [], {});
  return simulateBattle(inputs, spec, { globals, record: true });
}

describe('マップ', () => {
  it('出現マスから防衛マスまでの経路がある', () => {
    expect(SPAWNS.length).toBe(2);
    for (const p of ENEMY_PATHS) {
      expect(SPAWNS).toContain(p[0]);
      expect(p[p.length - 1]).toBe(GOAL);
      for (const c of p) expect(['ground', 'spawn', 'goal']).toContain(tileAt(c));
    }
  });

  it('高台は遠距離のみ、壁・出現・防衛マスには置けない', () => {
    const melee = byProf('defender').id;
    const ranged = byProf('sniper').id;
    const high = [...Array(36).keys()].find((p) => tileAt(p) === 'high')!;
    const safe = [...Array(36).keys()].find((p) => tileAt(p) === 'safe')!;
    expect(canPlace(high, melee)).toBe(false);
    expect(canPlace(high, ranged)).toBe(true);
    expect(canPlace(safe, melee)).toBe(true);
    expect(canPlace(0, ranged)).toBe(false); // 壁
    expect(canPlace(SPAWNS[0], melee)).toBe(false);
    expect(canPlace(GOAL, melee)).toBe(false);
    // 職業の既定と違う近遠（錬金術師は遠距離、工匠は近距離）
    const tin = UNITS.find((u) => u.name === 'ブリキ')!;
    expect(canPlace(high, tin.id)).toBe(true);
    const cat = UNITS.find((u) => u.name === 'キャサリン')!;
    expect(canPlace(high, cat.id)).toBe(false);
  });
});

describe('マップ戦闘', () => {
  it('ボスは本家の仮想敵：冑の耐久', () => {
    const boss = ROUNDS[13].spawns.map((s) => ENEMIES[s.enemy]).find((e) => e.boss)!;
    expect(boss.hp).toBe(600000);
    expect(boss.def).toBe(1000);
    expect(boss.res).toBe(25);
  });

  it('誰もいなければ全員突破され、耐久値が減る', () => {
    const r = run([], roundSpec(1));
    expect(r.killed).toBe(0);
    expect(r.leaked).toBe(r.total);
    expect(r.lifeLoss).toBeGreaterThan(0);
  });

  it('経路上の重装が地上の敵をブロックし続ける（防衛マスに着かない）', () => {
    const spec = oneEnemy('test_ground', false);
    const tank = UNITS.find((u) => u.profession === 'defender')!;
    const open = run([], spec);
    const blocked = run([{ uid: 1, defId: tank.id, star: 1, pos: 29, dir: 'right' }], spec);
    // ブロックなし：時間切れより前に到達して消える
    expect(open.frames!.at(-1)!.e.length).toBe(0);
    // ブロックあり：時間切れまで盤面に残り、位置は重装の手前
    const last = blocked.frames!.at(-1)!.e;
    expect(last.length).toBe(1);
    expect(last[0][1] / 100).toBeGreaterThan(1.4);
  });

  it('飛行の敵はブロックできない', () => {
    const spec = oneEnemy('test_fly', true);
    const tank = UNITS.find((u) => u.profession === 'defender')!;
    const r = run([{ uid: 1, defId: tank.id, star: 1, pos: 29, dir: 'right' }], spec);
    expect(r.frames!.at(-1)!.e.length).toBe(0);
    expect(r.leaked).toBe(1);
  });

  it('遠距離オペレーターで序盤の敵を倒せる', () => {
    const sniper = byProf('sniper');
    const caster = byProf('caster');
    const board: OwnedUnit[] = [
      { uid: 1, defId: sniper.id, star: 2, pos: 22, dir: 'down' },
      { uid: 2, defId: caster.id, star: 2, pos: 25, dir: 'down' },
    ];
    const r = run(board, roundSpec(1));
    expect(r.killed).toBeGreaterThan(0);
  });

  it('隠匿の敵はブロックされるまで遠距離から狙われない', () => {
    const spec = oneEnemy('test_stealth', false, { hp: 100, def: 0, res: 0, stealth: true });
    const sniper = byProf('sniper');
    const r = run([{ uid: 1, defId: sniper.id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r.killed).toBe(0);
    const tank = UNITS.find((u) => u.profession === 'defender')!;
    const r2 = run([{ uid: 1, defId: sniper.id, star: 2, pos: 22, dir: 'down' }, { uid: 2, defId: tank.id, star: 2, pos: 31, dir: 'right' }], spec);
    expect(r2.killed).toBe(1);
  });

  it('攻撃回数で倒れる敵は、ダメージ量に関係なく回数で倒れる', () => {
    const spec = oneEnemy('test_hits', false, { hp: 3, def: 99999, res: 100, hitsToKill: true, unblockable: true });
    const sniper = byProf('sniper');
    const r = run([{ uid: 1, defId: sniper.id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r.killed).toBe(1);
  });

  it('分裂する敵は倒れると子が生まれる', () => {
    ENEMIES.test_child = { name: 'child', hp: 1, def: 0, res: 0, speed: 1, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1, hitsToKill: true };
    const spec = oneEnemy('test_parent', false, { hp: 10, def: 0, res: 0, deadSpawn: { enemy: 'test_child', count: 2 } });
    const r = run([], spec);
    expect(r.total).toBe(1); // 倒れないので子は出ない
    const sniper = byProf('sniper');
    const r2 = run([{ uid: 1, defId: sniper.id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r2.total).toBe(3);
  });
});

describe('敵グループ', () => {
  it('主力部隊と6種のグループがある', () => {
    expect(Object.keys(ENEMY_GROUPS).sort()).toEqual(['DOT', 'ELEMENT', 'FLY', 'INVISIBLE', 'REFLECTION', 'SPECIAL', 'TIMES']);
  });

  it('ゲーム開始時に3種が選ばれ、ラウンドの敵はそのグループか主力部隊から出る', () => {
    const s = createGame(42);
    expect(s.enemyTypes.length).toBe(3);
    for (let r = 1; r <= 13; r++) {
      const g = roundGroupOf(s, r);
      expect(['SPECIAL', ...s.enemyTypes]).toContain(g.type);
      const entry = ENEMY_GROUPS[g.type].entries[g.entry];
      const allowed = new Set([entry.strong, ...entry.normal, ...entry.elite]);
      for (const sp of roundSpec(r, g).spawns) if (sp.role) expect(allowed.has(sp.enemy)).toBe(true);
    }
    // シードとラウンドで決まる
    expect(pickRoundGroup(42, 5, s.enemyTypes)).toEqual(roundGroupOf(s, 5));
  });

  it('序盤2ラウンドは雑魚だけ', () => {
    for (const r of [1, 2]) expect(ROUNDS[r - 1].spawns.every((s) => s.role === 'normal')).toBe(true);
  });

  it('特殊能力無効化（秘術法陣）で屈折の術耐性が消える', () => {
    const spec = oneEnemy('test_refract', false, { hp: 1e9, def: 0, res: 0, refract: 70 });
    const caster = byProf('caster');
    const base: OwnedUnit = { uid: 1, defId: caster.id, star: 2, pos: 22, dir: 'down' };
    const plain = run([base], spec).totalDamage;
    const withItem = run([{ ...base, items: [{ uid: 9, itemId: '3_08', star: 1 }] }], spec).totalDamage;
    expect(withItem).toBeGreaterThan(plain * 2);
  });
});

describe('敵の攻撃と回復', () => {
  const tank = () => UNITS.find((u) => u.profession === 'defender')!;
  const sniper = () => byProf('sniper');
  const medic = () => UNITS.find((u) => u.damageType === 'heal' && u.subProfession === 'physician')!;

  it('近接の敵はブロックしている相手だけを攻撃する', () => {
    const spec = oneEnemy('test_melee', false, { attack: { kind: 'melee', atk: 2000, interval: 1, range: 0, arts: false } });
    const r = run([{ uid: 1, defId: tank().id, star: 2, pos: 31, dir: 'right' }, { uid: 2, defId: sniper().id, star: 2, pos: 22, dir: 'down' }], spec);
    const t = r.perUnit.find((u) => u.uid === 1)!;
    const s = r.perUnit.find((u) => u.uid === 2)!;
    expect(t.taken).toBeGreaterThan(0);
    expect(s.taken).toBe(0);
  });

  it('ブロックしている相手が倒れると敵は再び進む', () => {
    const spec = oneEnemy('test_strong', false, { attack: { kind: 'melee', atk: 99999, interval: 1, range: 0, arts: false } });
    const r = run([{ uid: 1, defId: tank().id, star: 1, pos: 31, dir: 'right' }], spec);
    expect(r.perUnit[0].downAt).not.toBeNull();
    expect(r.leaked).toBe(1);
  });

  it('遠距離の敵は範囲内で最後に配置された（右・下の）相手を狙う', () => {
    const spec = oneEnemy('test_ranged', false, { speed: 0.01, attack: { kind: 'ranged', atk: 200, interval: 5, range: 99, arts: true } });
    const a: OwnedUnit = { uid: 1, defId: sniper().id, star: 2, pos: 22, dir: 'down' }; // (4,2)
    const b: OwnedUnit = { uid: 2, defId: sniper().id, star: 2, pos: 25, dir: 'down' }; // (7,2) 右
    const c: OwnedUnit = { uid: 3, defId: sniper().id, star: 2, pos: 16, dir: 'down' }; // (7,1) 右・上
    const r = run([a, b, c], spec);
    // 右の列（下→上）から順に倒され、最後に左の列
    const down = (uid: number) => r.perUnit.find((u) => u.uid === uid)!.downAt!;
    expect(down(3)).toBeGreaterThan(down(2));
    expect(down(1)).toBeGreaterThan(down(3));
  });

  it('医療は傷ついた味方を回復する', () => {
    const spec = oneEnemy('test_poke', false, { attack: { kind: 'melee', atk: 1500, interval: 2, range: 0, arts: false } });
    const board: OwnedUnit[] = [
      { uid: 1, defId: tank().id, star: 2, pos: 31, dir: 'right' },
      { uid: 2, defId: medic().id, star: 2, pos: 22, dir: 'down' },
    ];
    const r = run(board, spec);
    expect(r.perUnit.find((u) => u.uid === 2)!.healed).toBeGreaterThan(0);
  });
});
