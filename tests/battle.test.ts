import { describe, expect, it } from 'vitest';
import { ENEMY_PATHS, GOAL, MAPS, cellX, cellY, RANDOM_MAPS, SPAWNS, canPlace, setActiveMap, tileAt } from '../src/core/board';
import { ENEMIES, ENEMY_GROUPS, ROUNDS, pickRoundGroup, roundSpec, type EnemySpec, type RoundSpec } from '../src/core/data/battle';
import { UNITS } from '../src/core/data/units';
import { buildSimInputs, createGame, roundGroupOf } from '../src/core/game';
import { roundEnemies, routeCells, simulateBattle } from '../src/core/sim';
import type { OwnedUnit } from '../src/core/types';

const byProf = (p: string) => UNITS.find((u) => u.profession === p && u.tier <= 3)!;

/** テスト用：倒れない敵を1体だけ出すラウンド */
function oneEnemy(key: string, flying: boolean, over: Partial<EnemySpec> = {}): RoundSpec {
  // 位置を決め打ちしたテストは以前の仮マップで行う（他のテストのゲーム生成でマップが変わるため）
  setActiveMap('legacy');
  ENEMIES[key] = { name: key, hp: 1e9, def: 5000, res: 100, speed: 1, blockCnt: 1, flying, boss: false, elite: false, lifeReduce: 1, ...over };
  return { round: 1, levelId: 'test', timeLimit: 30, moveMultiplier: 0.5, spawns: [{ enemy: key, count: 1, interval: 0, delay: 0, spawn: 1 }] };
}

function run(board: OwnedUnit[], spec: RoundSpec) {
  setActiveMap('legacy');
  const { inputs, globals } = buildSimInputs(board, [], {});
  return simulateBattle(inputs, spec, { globals, record: true });
}

describe('マップ', () => {
  it('低難易度のみのマップ1は抽選されない', () => {
    expect(RANDOM_MAPS.some((m) => m.id === 'm1')).toBe(false);
    expect(RANDOM_MAPS.length).toBe(7);
    for (let seed = 1; seed <= 40; seed++) expect(createGame(seed).mapId === 'm1').toBe(false);
    setActiveMap('legacy');
  });

  it('本家の8マップはどれも出現地点が2つで、防衛地点まで経路がある', () => {
    for (const m of MAPS) {
      setActiveMap(m.id);
      expect(SPAWNS.length).toBe(2);
      for (const p of ENEMY_PATHS) {
        expect(p[0]).toBe(SPAWNS[ENEMY_PATHS.indexOf(p)]);
        expect(p[p.length - 1]).toBe(GOAL);
      }
    }
    setActiveMap('legacy');
  });

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
  it('ボスは本家の仮想敵：冑（HPは絶境＝死地の値）', () => {
    const boss = ROUNDS[13].spawns.map((s) => ENEMIES[s.enemy]).find((e) => e.boss)!;
    expect(boss.hp).toBe(1800000);
    expect(ROUNDS[14].spawns.map((s) => ENEMIES[s.enemy]).find((e) => e.boss && e.large)!.hp).toBe(3600000);
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

  it('領主（シルバーアッシュ）は飛行の敵も攻撃でき、遠距離攻撃は攻撃力80%', () => {
    const sa = UNITS.find((u) => u.name === 'シルバーアッシュ')!;
    const board: OwnedUnit[] = [{ uid: 1, defId: sa.id, star: 1, pos: 29, dir: 'right' }];
    // 1撃ごとのダメージ（0.5秒ごとの残りHPの減り。攻撃間隔1.3秒なので1区間に1撃）をスキル発動前で比べる
    const perHit = (fly: boolean) => {
      const r = run(board, oneEnemy(fly ? 'test_lord_fly' : 'test_lord_gr', fly, { def: 0, res: 0, speed: fly ? 0.3 : 1 }));
      const cast = r.fx!.find((e) => e[1] === 13 && e[4] === 0)?.[0] ?? Infinity;
      const tl = r.timeline.filter((p) => p.t * 100 < cast - 50);
      const drops = tl.slice(1).map((p, i) => Math.round(tl[i].hp - p.hp)).filter((d) => d > 0);
      return { r, drops: [...new Set(drops)].sort((a, b) => a - b) };
    };
    const air = perHit(true);
    expect(air.r.perUnit[0].damage > 0).toBe(true);
    expect(air.drops.length).toBe(1);
    // 地上の敵：ブロックする前は遠距離（80%）、ブロックしてからは近距離（100%）
    const ground = perHit(false);
    expect(ground.drops.length).toBe(2);
    expect(ground.drops[0]).toBe(air.drops[0]);
    expect(Math.abs(ground.drops[0] / ground.drops[1] - 0.8) < 0.01).toBe(true);
    // スキル（真銀斬）も飛行の敵に当たる
    expect(air.r.perUnit[0].skillCasts).toBe(1);
    const sk = air.r.fx!.filter((e) => e[1] === 13 && e[4] === 1);
    expect(sk.length > 0).toBe(true);
  });

  it('近距離の非領主は飛行の敵を攻撃できない', () => {
    const guard = UNITS.find((u) => u.profession === 'guard' && u.position === 'melee' && u.subProfession !== 'lord')!;
    const r = run([{ uid: 1, defId: guard.id, star: 1, pos: 29, dir: 'right' }], oneEnemy('test_fly_g', true, { speed: 0.3 }));
    expect(r.perUnit[0].damage).toBe(0);
  });

  it('凛御シルバーアッシュは通常攻撃では飛行の敵を狙えないが、S2は飛行の敵に撃って当たる', () => {
    const sv = UNITS.find((u) => u.name === '凛御シルバーアッシュ')!;
    const r = run([{ uid: 1, defId: sv.id, star: 1, pos: 29, dir: 'right' }], oneEnemy('test_fly_sv', true, { def: 0, res: 0, speed: 0.3 }));
    const p = r.perUnit[0];
    expect(p.hits).toBe(0);
    expect(p.skillCasts > 0).toBe(true);
    expect(p.damage > 0).toBe(true);
    // 専用の演出に命中した敵の位置が入る（[時刻, 13, uid, 種類, 0, x, y]）
    const sk = r.fx!.filter((e) => e[1] === 13 && e[2] === 1);
    expect(sk.length).toBe(p.skillCasts);
    expect(sk.every((e) => e.length >= 7)).toBe(true);
    expect(r.colds > 0).toBe(true);
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

  it('ステルスの敵はブロックされるまで遠距離から狙われない', () => {
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
  it('ラウンドの敵は、グループに合う枠（地上用か飛行用）だけを使い、強敵は3体まで', () => {
    for (const type of ['SPECIAL', 'FLY'] as const) {
      const entry = ENEMY_GROUPS[type].entries.findIndex((e) => !e.firstHalf);
      const spec = roundSpec(13, { type, entry });
      const strong = ENEMY_GROUPS[type].entries[entry].strong;
      expect(spec.spawns.filter((x) => x.enemy === strong).reduce((a, x) => a + x.count, 0)).toBe(3);
      expect(spec.spawns.every((x) => !x.role || !!x.flySlot === (type === 'FLY'))).toBe(true);
    }
  });

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

  it('医療以外の治療スキル（グム・サリア・ブリキ）も味方を回復する', () => {
    const spec = oneEnemy('test_poke2', false, { attack: { kind: 'melee', atk: 1200, interval: 2, range: 0, arts: false } });
    for (const name of ['グム', 'サリア']) {
      const u = UNITS.find((x) => x.name === name)!;
      const r = run([{ uid: 1, defId: u.id, star: 2, pos: 31, dir: 'right' }], spec);
      expect(r.perUnit[0].healed).toBeGreaterThan(0);
    }
    const tin = UNITS.find((x) => x.name === 'ブリキ')!;
    const tank = UNITS.find((u) => u.profession === 'defender')!;
    const r = run([{ uid: 1, defId: tank.id, star: 2, pos: 31, dir: 'right' }, { uid: 2, defId: tin.id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r.perUnit.find((u) => u.uid === 2)!.healed).toBeGreaterThan(0);
  });
});

describe('コストと再配置', () => {
  it('倒れたオペレーターは再配置時間が過ぎ、コストが足りれば再配置される', () => {
    const spec = oneEnemy('test_slowkiller', false, { speed: 0.01, attack: { kind: 'melee', atk: 99999, interval: 1, range: 0, arts: false } });
    const tank = UNITS.find((u) => u.profession === 'defender')!;
    const r = run([{ uid: 1, defId: tank.id, star: 1, pos: 34, dir: 'right' }], spec);
    const u = r.perUnit[0];
    expect(u.retreats).toBeGreaterThan(1);
    expect(u.redeploys).toBeGreaterThan(0);
    // 再配置待ちの状態がリプレイに記録される
    expect(r.frames!.some((f) => f.u?.some((x) => x[3] === 4))).toBe(true);
  });

  it('行商人は配置中にコストを消費する（琳琅スワイヤーはコインで追加攻撃）', () => {
    const spec = oneEnemy('test_target', false, { speed: 0.01 });
    const swire = UNITS.find((u) => u.name === '琳琅スワイヤー')!;
    const r = run([{ uid: 1, defId: swire.id, star: 2, pos: 34, dir: 'right' }], spec);
    // コストは1秒に1増え、3秒ごとに3減るので、初期値付近から増えない
    const costs = r.frames!.map((f) => f.c ?? 0);
    expect(Math.max(...costs)).toBeGreaterThan(9);
    expect(15).toBeGreaterThan(Math.max(...costs));
  });
});

describe('寒冷・凍結とスキルの細部', () => {
  const unit = (name: string) => UNITS.find((u) => u.name === name)!;

  it('イェラグ6人の寒風と寒冷の重ねがけで凍結し、凍結で加算数を得る特性が働く', () => {
    const names = ['マッターホルン', 'シルバーアッシュ', 'スノーハンター', 'プラマニクス', 'イェラ', 'ノーシス'];
    const pos = [33, 34, 22, 23, 24, 25];
    const board: OwnedUnit[] = names.map((n, i) => ({ uid: i + 1, defId: unit(n).id, star: 2, pos: pos[i], dir: i < 2 ? 'right' : 'down' }));
    // スノーハンターに「イェラグの不融氷」（攻撃時に確率で寒冷）
    board[2].items = [{ uid: 99, itemId: '5_02', star: 2 }];
    const { inputs, globals, statuses } = buildSimInputs(board, [], {});
    const active = new Set(statuses.filter((s) => s.level > 0).map((s) => s.id));
    const r = simulateBattle(inputs, roundSpec(7), { globals, activeAlliances: active, stacks: {} });
    expect(r.colds).toBeGreaterThan(0);
    expect(r.freezes).toBeGreaterThan(0);
    expect(r.stackGains.kjerag ?? 0).toBeGreaterThan(0);
    // 内訳：誰の特性で得たか
    const src = r.stackSources.filter((x) => x.bond === 'kjerag');
    expect(src.reduce((sum, x) => sum + x.amount, 0)).toBe(r.stackGains.kjerag);
    expect(src.every((x) => x.cause === '範囲内の凍結')).toBe(true);
  });

  it('リプレイに寒冷・凍結の状態と、4つのスキルの専用演出が記録される', () => {
    const names = ['シルバーアッシュ', '凛御シルバーアッシュ', 'ノーシス', '聖聆プラマニクス', 'イェラ', 'スノーハンター'];
    const pos = [33, 34, 22, 23, 24, 25];
    const board: OwnedUnit[] = names.map((n, i) => ({ uid: i + 1, defId: unit(n).id, star: 2, pos: pos[i], dir: i < 2 ? 'right' : 'down' }));
    const { inputs, globals, statuses } = buildSimInputs(board, [], {});
    const active = new Set(statuses.filter((s) => s.level > 0).map((s) => s.id));
    const r = simulateBattle(inputs, roundSpec(9), { globals, activeAlliances: active, stacks: {}, record: true });
    const flags = r.frames!.flatMap((f) => f.e.map((e) => e[4] ?? 0));
    expect(flags.some((x) => (x & 128) !== 0)).toBe(true);
    expect(flags.some((x) => (x & 256) !== 0)).toBe(true);
    // fx 13：[時刻, 13, uid, 種類, 0発動/1攻撃, x, y, ...]
    const sk = r.fx!.filter((e) => e[1] === 13);
    expect([...new Set(sk.map((e) => e[3]))].sort()).toEqual([1, 2, 3, 4]);
    expect(sk.some((e) => e[3] === 3 && e[4] === 1 && e.length >= 7)).toBe(true);
    expect(sk.some((e) => e[3] === 4 && e[4] === 1 && e.length >= 7)).toBe(true);
  });

  it('ウタゲのスキルは配置時に発動し、HPが減って効果時間が減っていく', () => {
    const spec = oneEnemy('test_dummy2', false, { speed: 0.01 });
    const r = run([{ uid: 1, defId: unit('ウタゲ').id, star: 1, pos: 34, dir: 'right' }], spec);
    expect(r.perUnit[0].skillCasts).toBe(1);
    const first = r.frames![0].u![0];
    // HP50%（開始直後の攻撃で武者の特性によりわずかに回復しうる）
    expect(first[1] >= 50 && first[1] <= 55).toBe(true);
    expect(first[3]).toBe(1); // スキル中
  });

  it('近距離はブロックしている敵を、攻撃範囲外でも攻撃する', () => {
    const spec = oneEnemy('test_behind', false, { hp: 1e9, def: 0, res: 0 });
    // 左（防衛マス側）を向いて置くと、右から来てブロックした敵は範囲外
    const r = run([{ uid: 1, defId: unit('ウタゲ').id, star: 1, pos: 31, dir: 'left' }], spec);
    expect(r.perUnit[0].damage).toBeGreaterThan(0);
  });
  it('狩人は弾が尽きると攻撃できず、攻撃しない間に装填する', () => {
    const spec = oneEnemy('test_hunt', false, { speed: 0.01, def: 0, res: 0 });
    spec.timeLimit = 60;
    const r = run([{ uid: 1, defId: unit('スノーハンター').id, star: 1, pos: 22, dir: 'down' }], spec);
    const ammo = r.frames!.map((f) => f.u![0][5] as number);
    expect(ammo[0]).toBe(8);
    expect(Math.min(...ammo)).toBe(0);
    // 弾切れのあとも装填して撃ち続ける
    const firstEmpty = ammo.indexOf(0);
    expect(ammo.slice(firstEmpty).some((a) => a > 0)).toBe(true);
  });

  it('敵の神経損傷が溜まると味方が元素爆発する', () => {
    const spec = oneEnemy('test_neural', false, {
      attack: { kind: 'melee', atk: 600, interval: 1, range: 0, arts: false },
      element: { type: 'neural', ratio: 1 },
    });
    const r = run([{ uid: 1, defId: UNITS.find((u) => u.profession === 'defender')!.id, star: 3, pos: 31, dir: 'right' }], spec);
    expect(r.opBursts).toBeGreaterThan(0);
  });

  it('ヴィルトゥオーサのスキルで敵が壊死の元素爆発を起こす', () => {
    const spec = oneEnemy('test_virt', false, { speed: 0.3, def: 0, res: 0 });
    spec.timeLimit = 60;
    const r = run([{ uid: 1, defId: unit('ヴィルトゥオーサ').id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r.enBursts).toBeGreaterThan(0);
  });
  it('戦術【命結の秘】：最初に倒れた3名はその場で復活する', () => {
    const spec = oneEnemy('test_crush', false, { attack: { kind: 'melee', atk: 99999, interval: 1, range: 0, arts: false } });
    const board: OwnedUnit[] = [{ uid: 1, defId: UNITS.find((u) => u.profession === 'defender')!.id, star: 1, pos: 31, dir: 'right' }];
    const plain = buildSimInputs(board, [], {});
    const withBand = buildSimInputs(board, [], {}, { band: 'ermengard' });
    const a = simulateBattle(plain.inputs, spec, { globals: plain.globals });
    const b = simulateBattle(withBand.inputs, spec, { globals: withBand.globals });
    expect(b.perUnit[0].taken).toBeGreaterThan(a.perUnit[0].taken * 2);
  });

  it('懸賞の敵を倒すと資金を得る', () => {
    const spec = oneEnemy('test_bounty', false, { hp: 100, def: 0, res: 0 });
    spec.spawns[0].bounty = 3;
    const r = run([{ uid: 1, defId: byProf('sniper').id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r.bountyGold).toBe(3);
  });
  it('武者は攻撃で自身を回復し、医療からは治療されない', () => {
    const spec = oneEnemy('test_musha', false, { def: 0, res: 0, attack: { kind: 'melee', atk: 400, interval: 1, range: 0, arts: false } });
    const medic = UNITS.find((u) => u.damageType === 'heal' && u.subProfession === 'physician')!;
    const r = run(
      [
        { uid: 1, defId: unit('ウタゲ').id, star: 1, pos: 31, dir: 'right' },
        { uid: 2, defId: medic.id, star: 2, pos: 22, dir: 'down' },
      ],
      spec,
    );
    expect(r.perUnit[0].healed).toBeGreaterThan(0);
    expect(r.perUnit[1].healed).toBe(0);
  });

  it('鎌は範囲内の敵全員を攻撃し、命中数（ブロック数まで）に応じて回復する', () => {
    // ヒューマスは素質で回復がバリアになるので、別の鎌で確かめる
    const reaper = UNITS.find((u) => u.subProfession === 'reaper' && u.charId !== 'char_491_humus')!;
    const spec = oneEnemy('test_reap', false, { def: 0, res: 0, attack: { kind: 'melee', atk: 300, interval: 1, range: 0, arts: false } });
    const r = run([{ uid: 1, defId: reaper.id, star: 1, pos: 31, dir: 'right' }], spec);
    expect(r.perUnit[0].healed).toBeGreaterThan(0);
  });
  it('枯朽サルカズ戦士は倒れると汚染秽蝕を残し、周囲の味方がHPを失う', () => {
    const spec = oneEnemy('test_pollute', false, { hp: 10, def: 0, res: 0, speed: 0.3, deathPollution: { high: 50, low: 25, duration: 8, radius: 2 } });
    // 戦闘が続くように、後から倒れない敵を出す
    ENEMIES.test_late = { ...ENEMIES.test_pollute, hp: 1e9, deathPollution: undefined, speed: 0.01 };
    spec.spawns.push({ enemy: 'test_late', count: 1, interval: 0, delay: 1, spawn: 0 });
    const r = run([{ uid: 1, defId: UNITS.find((u) => u.profession === 'defender')!.id, star: 1, pos: 34, dir: 'right' }], spec);
    expect(r.perUnit[0].taken).toBeGreaterThan(200);
  });

  it('囚人は数回攻撃すると解放され、攻撃力が上がり防御力を無視する', () => {
    const atk = { kind: 'melee' as const, atk: 400, interval: 1, range: 0, arts: false };
    const liberty = { times: 4, confAspd: -50, confDef: 0, atk: 0.5, defPen: 0.8, res: 0, regen: 0, freeAll: false };
    const board: OwnedUnit[] = [{ uid: 1, defId: byProf('defender').id, star: 2, pos: 34, dir: 'right' }];
    const plain = run(board, oneEnemy('test_prisoner_plain', false, { speed: 3, attack: atk }));
    const prisoner = run(board, oneEnemy('test_prisoner', false, { speed: 3, attack: atk, liberty }));
    expect(prisoner.perUnit[0].taken).toBeGreaterThan(plain.perUnit[0].taken * 3);
    // 解放されるまで（拘束中）は攻撃速度が下がる：同じ時間内の被ダメージは解放なしより少ない
    const short = (s: RoundSpec) => ({ ...s, timeLimit: 5 });
    const conf = run(board, short(oneEnemy('test_prisoner_conf', false, { speed: 3, attack: atk, liberty: { ...liberty, times: 99 } })));
    const plain5 = run(board, short(oneEnemy('test_prisoner_plain', false, { speed: 3, attack: atk })));
    expect(conf.perUnit[0].taken < plain5.perUnit[0].taken).toBe(true);
  });

  it('深溟のミキサー：通常攻撃せず周囲の味方全員に術ダメージと神経損傷。換気口の上の味方は対象外', () => {
    const mixer = ENEMIES.enemy_1234_dsubrl;
    expect(mixer.attack?.aura).toBe(true);
    expect(mixer.element?.type).toBe('neural');
    ENEMIES.test_mixer = { ...mixer, hp: 1e9 };
    setActiveMap('m7');
    const sniper = byProf('sniper').id;
    // 4 は換気口（上ルート上）、13 はその下の地上
    const board: OwnedUnit[] = [
      { uid: 1, defId: sniper, star: 1, pos: 4, dir: 'right' },
      { uid: 2, defId: sniper, star: 1, pos: 13, dir: 'right' },
    ];
    const { inputs, globals } = buildSimInputs(board, [], {});
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 20, moveMultiplier: 0.5, spawns: [{ enemy: 'test_mixer', count: 1, interval: 0, delay: 0, spawn: 0 }] };
    const r = simulateBattle(inputs, spec, { globals, record: true });
    const taken = (uid: number) => r.perUnit.find((u) => u.uid === uid)!.taken;
    expect(taken(1)).toBe(0);
    expect(taken(2)).toBeGreaterThan(0);
    setActiveMap('legacy');
  });

  it('レミュアン：スキル中は攻撃せず、弾薬5発で敵をロックオンし、終了時にまとめて爆撃する', () => {
    const spec = oneEnemy('test_lemuen', false, { speed: 0.01, def: 0 });
    const r = run([{ uid: 1, defId: unit('レミュアン').id, star: 1, pos: 34, dir: 'right' }], spec);
    const u = r.perUnit[0];
    expect(u.skillCasts).toBeGreaterThan(0);
    // 発動後の最初のフレームから弾薬を消費して0になるまで、ダメージは爆撃のみ
    const frames = r.frames!.filter((f) => f.u![0][3] === 2);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].u![0][4]).toBeLessThanOrEqual(5);
    expect(u.damage).toBeGreaterThan(0);
  });

  it('レミュアン：ロックオンと爆撃のリプレイ演出。爆撃はスキル終了の0.2秒後から0.3秒間隔で、敵が1体なら5発すべて同じ敵にロックして5回当たる', () => {
    const spec = oneEnemy('test_lemuen2', false, { speed: 0.01, def: 0 });
    const r = run([{ uid: 1, defId: unit('レミュアン').id, star: 1, pos: 34, dir: 'right' }], spec);
    const locks = r.fx!.filter((e) => e[1] === 10);
    const bombs = r.fx!.filter((e) => e[1] === 11);
    expect(locks.length).toBeGreaterThanOrEqual(5);
    expect(bombs.length).toBeGreaterThanOrEqual(5);
    expect(new Set(locks.slice(0, 5).map((l) => l[3])).size).toBe(1);
    // 着弾の間隔は0.3秒（30）
    expect(bombs[1][0] - bombs[0][0]).toBe(30);
    expect(bombs[4][0] - bombs[0][0]).toBe(120);
    // 最初の着弾は最後のロックオンの後（スキル終了の0.2秒後）
    expect(bombs[0][0] - locks[locks.length > 5 ? 4 : locks.length - 1][0]).toBeGreaterThanOrEqual(20);
  });

  it('レミュアン：範囲内に敵がいない間は弾薬を消費せずに待つ', () => {
    // 敵が現れる前にスキルが発動しないので、ロックオンの数は敵が現れた後から数えて弾薬数以下
    const spec = oneEnemy('test_lemuen3', false, { speed: 0.01, def: 0 });
    spec.spawns[0].delay = 25;
    const r = run([{ uid: 1, defId: unit('レミュアン').id, star: 1, pos: 34, dir: 'right' }], spec);
    const locks = r.fx!.filter((e) => e[1] === 10);
    expect(locks.every((l) => l[0] >= 2500)).toBe(true);
  });

  it('サンクタ・ミキサーの素質：8秒間攻撃しないとバリアを得て、被ダメージのHPへの反映が遅れる。レミュアンの指名手配で【エリート】への与ダメージが+15%', () => {
    // 敵が現れるのを遅らせると、バリアがある間はHPが減らない
    const spec = oneEnemy('test_mixer_b', false, { speed: 0.01, def: 0, attack: ENEMIES.enemy_1005_yokai_2.attack });
    spec.spawns[0].spawn = 1;
    spec.spawns[0].delay = 9;
    const r = run([{ uid: 1, defId: unit('サンクタ・ミキサー').id, star: 1, pos: 34, dir: 'right' }], spec);
    const hpAt = (sec: number) => r.frames!.find((f) => f.t >= sec)!.u![0][1] as number;
    const first = r.frames!.find((f) => (f.u![0][1] as number) < 100);
    expect(first === undefined || first.t > 9 + 3).toBe(true);
    expect(hpAt(9)).toBe(100);
    // 通常の敵と【エリート】で、レミュアンの与ダメージを比べる
    const dmg = (elite: boolean) => run([{ uid: 1, defId: unit('レミュアン').id, star: 1, pos: 34, dir: 'right' }], oneEnemy('test_lem_w', false, { speed: 0.01, def: 0, elite })).perUnit[0].damage;
    const ratio = dmg(true) / dmg(false);
    expect(ratio > 1.1 && ratio < 1.2).toBe(true);
  });

  it('サンクタ・ミキサー：スキル中は攻撃せず、攻撃を受けると反撃して弾薬を消費する', () => {
    const spec = oneEnemy('test_mixer_s', false, { speed: 0.01, def: 0, attack: ENEMIES.enemy_1005_yokai_2.attack });
    const r = run([{ uid: 1, defId: unit('サンクタ・ミキサー').id, star: 1, pos: 34, dir: 'right' }], spec);
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    expect(r.perUnit[0].taken).toBeGreaterThan(0);
    // 攻撃を受けるたびに弾薬（30発）が減る（通常攻撃では減らない）
    const ammo = r.frames!.filter((f) => f.u![0][3] === 2).map((f) => f.u![0][4] as number);
    expect(Math.max(...ammo)).toBeGreaterThanOrEqual(30);
    expect(Math.min(...ammo) < 30).toBe(true);
  });

  it('旋輪射手は投擲物が戻るまで攻撃できない（1マス1.0秒・2マス約1.17秒・3マス1.5秒ごと）', () => {
    const caper = UNITS.find((u) => u.name === 'ケイパー')!;
    const at = (pos: number) => {
      // ボス扱いにして制限時間をステージ時間で打ち切る
      const spec = oneEnemy('test_loop', false, { speed: 0, def: 0, boss: true });
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: caper.id, star: 1, pos, dir: 'right' }], [], {});
      // スキル（1回で2個放つ）が溜まる前の15秒で数える
      return simulateBattle(inputs, { ...spec, timeLimit: 15 }, { globals }).perUnit[0].hits;
    };
    // 敵は出現地点（下段の右端・35）で止まる。34 = 1マス、33 = 2マス、32 = 3マス
    const [d1, d2, d3] = [at(34), at(33), at(32)];
    expect(d1 > d2 && d2 > d3).toBe(true);
    // 1マス:3マス ≒ 1.5:1
    expect(Math.abs(d1 / d3 - 1.5) < 0.1).toBe(true);
  });

  it('ティティ：スキル中の攻撃で敵を睡眠にし、範囲内の睡眠で【サルゴン】【精密】を加算', () => {
    const titi = UNITS.find((u) => u.name === 'ティティ')!;
    ENEMIES.test_sleep = { name: 's', hp: 20000, def: 100, res: 0, speed: 0.6, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const { inputs, globals } = buildSimInputs(
      [
        { uid: 1, defId: titi.id, star: 1, pos: 24, dir: 'down' },
        { uid: 2, defId: byProf('defender').id, star: 2, pos: 31, dir: 'right' },
      ],
      [],
      {},
    );
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 90, moveMultiplier: 0.5, spawns: [{ enemy: 'test_sleep', count: 8, interval: 4, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, activeAlliances: new Set(['sargon', 'preci']) });
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    expect(r.stackGains.sargon ?? 0).toBeGreaterThan(0);
    expect(r.stackGains.preci).toBe(r.stackGains.sargon);
  });

  it('呪癒師は攻撃で与えたダメージの50%で範囲内の味方を回復する', () => {
    for (const name of ['ヴァンデラ', 'ティティ', '焔影リード']) {
      const medic = UNITS.find((u) => u.name === name)!;
      ENEMIES.test_inc = { name: 'i', hp: 1e9, def: 0, res: 0, speed: 0.6, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1, attack: { kind: 'melee', atk: 600, interval: 1, range: 0, arts: false } };
      setActiveMap('legacy');
      const { inputs, globals } = buildSimInputs(
        [
          { uid: 1, defId: medic.id, star: 1, pos: 24, dir: 'down' },
          { uid: 2, defId: byProf('defender').id, star: 2, pos: 33, dir: 'right' },
        ],
        [],
        {},
      );
      const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 30, moveMultiplier: 0.5, spawns: [{ enemy: 'test_inc', count: 1, interval: 0, delay: 0, spawn: 1 }] };
      const r = simulateBattle(inputs, spec, { globals });
      expect(r.perUnit[0].healed).toBeGreaterThan(0);
    }
  });

  it('シヴィライト・エテルナ：前方1マスのオペレーターが戦闘中に特性で加算数を得るたびに+1', () => {
    const id = (n: string) => UNITS.find((u) => u.name === n)!.id;
    ENEMIES.test_eterna = { name: 'e', hp: 2000, def: 100, res: 0, speed: 0.6, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 90, moveMultiplier: 0.5, spawns: [{ enemy: 'test_eterna', count: 6, interval: 5, delay: 0, spawn: 1 }] };
    const run = (withEterna: boolean) => {
      setActiveMap('legacy');
      // スカジ：2体倒すたびに【エーギル】+1
      const board: OwnedUnit[] = [{ uid: 1, defId: id('スカジ'), star: 1, pos: 31, dir: 'right' }];
      if (withEterna) board.push({ uid: 2, defId: id('シヴィライト・エテルナ'), star: 1, pos: 30, dir: 'right' });
      const { inputs, globals } = buildSimInputs(board, [], {});
      return simulateBattle(inputs, spec, { globals, activeAlliances: new Set(['egir']) }).stackGains.egir ?? 0;
    };
    const base = run(false);
    expect(base).toBeGreaterThan(0);
    expect(run(true)).toBe(base * 2);
  });

  it('【サルゴン】の強化の層数（最大・平均）を結果とリプレイに記録する', () => {
    const id = (n: string) => UNITS.find((u) => u.name === n)!.id;
    ENEMIES.test_sg = { name: 's', hp: 60000, def: 200, res: 0, speed: 0.4, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const board: OwnedUnit[] = [
      { uid: 1, defId: id('エステル'), star: 1, pos: 33, dir: 'right' },
      { uid: 2, defId: id('バブル'), star: 1, pos: 32, dir: 'right' },
      { uid: 3, defId: id('パピルス'), star: 1, pos: 14, dir: 'down' },
    ];
    const { inputs, globals } = buildSimInputs(board, [], { sargon: 20 });
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_sg', count: 3, interval: 8, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, activeAlliances: new Set(['sargon']), stacks: { sargon: 20 }, record: true });
    expect(r.sargon!.aspd).toBe(12);
    expect(r.sargon!.max).toBeGreaterThan(0);
    expect(r.sargon!.avg > 0 && r.sargon!.avg <= r.sargon!.max).toBe(true);
    expect(r.frames!.some((f) => (f.sg ?? []).length > 0)).toBe(true);
  });

  it('大型のボスは動かず右上の2列×3行を占め、そのどこかが範囲に入れば攻撃できる', () => {
    ENEMIES.test_bigboss = { ...ENEMIES.enemy_9013_acstmk, hp: 1e8, summon: undefined };
    setActiveMap('legacy');
    const spec: RoundSpec = { round: 14, levelId: 'test', timeLimit: 30, moveMultiplier: 0.5, spawns: [{ enemy: 'test_bigboss', count: 1, interval: 0, delay: 0, spawn: 0 }] };
    // 6 = (7,1)。右向きの狙撃は (8,1)(9,1) の列に届く
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('sniper').id, star: 1, pos: 6, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect(r.perUnit[0].hits).toBeGreaterThan(0);
    // 位置は (8,3) から動かない
    const xs = new Set(r.frames!.flatMap((f) => f.e.map((e) => `${e[1]},${e[2]}`)));
    expect([...xs]).toEqual(['700,200']);
  });

  it('大型のボスの当たり判定は (7,1)〜(7,3) の列も含む（配置・経路には影響しない）', () => {
    ENEMIES.test_bigboss2 = { ...ENEMIES.enemy_9013_acstmk, hp: 1e8, summon: undefined, bomb: undefined, attack: undefined };
    setActiveMap('legacy');
    const spec: RoundSpec = { round: 14, levelId: 'test', timeLimit: 20, moveMultiplier: 0.5, spawns: [{ enemy: 'test_bigboss2', count: 1, interval: 0, delay: 0, spawn: 0 }] };
    // 6 = (7,1)。左向きの重装の範囲は自分のマス（と左）だけ → 当たり判定の列にいるので攻撃できる
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('defender').id, star: 1, pos: 6, dir: 'left' }], [], {});
    const r = simulateBattle(inputs, spec, { globals });
    expect(r.perUnit[0].hits).toBeGreaterThan(0);
  });

  it('冑を倒すとその時点で戦闘終了。残りの敵（未出現を含む）は突破に数えない', () => {
    ENEMIES.test_weakboss = { ...ENEMIES.enemy_9013_acstmk, hp: 3000, def: 0, res: 0, summon: undefined, bomb: undefined, attack: undefined };
    ENEMIES.test_late = { name: 'l', hp: 1e9, def: 0, res: 0, speed: 1, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const spec: RoundSpec = {
      round: 14,
      levelId: 'test',
      timeLimit: 120,
      moveMultiplier: 0.5,
      spawns: [
        { enemy: 'test_weakboss', count: 1, interval: 0, delay: 0, spawn: 0 },
        { enemy: 'test_late', count: 3, interval: 1, delay: 3, spawn: 1 },
        { enemy: 'test_late', count: 2, interval: 1, delay: 100, spawn: 1 },
      ],
    };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('sniper').id, star: 2, pos: 6, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, spec, { globals });
    expect(r.bossDefeated).toBe(true);
    expect(r.elapsed < 30).toBe(true);
    expect(r.lifeLoss).toBe(0);
    expect(r.cleared).toBe(true);
  });

  it('海溝の実験体：ダメージを固定値で軽減（活性源石のマスのダメージにも有効）、【エーギル】なら反撃', () => {
    const spec = oneEnemy('test_flat', false, { speed: 0, boss: true });
    const run4 = (items: OwnedUnit['items'], defId = byProf('defender').id) => {
      setActiveMap('m4');
      // 13 = (5,2) の活性源石
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId, star: 1, pos: 13, dir: 'right', items }], [], {});
      const r = simulateBattle(inputs, { ...spec, timeLimit: 10 }, { globals });
      setActiveMap('legacy');
      return r.perUnit[0];
    };
    expect(run4([]).taken).toBeGreaterThan(0);
    expect(run4([{ uid: 9, itemId: '6_04', star: 1 }]).taken).toBe(0);
    // 反撃：【エーギル】が装備し、近接の敵に殴られると攻撃元へ術ダメージ
    const skadi = UNITS.find((u) => u.name === 'スカジ')!.id;
    ENEMIES.test_ret = { name: 'r', hp: 1e9, def: 0, res: 0, speed: 0.6, blockCnt: 1, flying: false, boss: true, elite: false, lifeReduce: 1, attack: { kind: 'melee', atk: 2000, interval: 1, range: 0, arts: false } };
    const fight = (items: OwnedUnit['items']) => {
      setActiveMap('legacy');
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: skadi, star: 1, pos: 33, dir: 'left', items }], [], {});
      const s: RoundSpec = { round: 1, levelId: 'test', timeLimit: 20, moveMultiplier: 0.5, spawns: [{ enemy: 'test_ret', count: 1, interval: 0, delay: 0, spawn: 1 }] };
      return simulateBattle(inputs, s, { globals }).perUnit[0];
    };
    const plain = fight([]);
    const withItem = fight([{ uid: 9, itemId: '6_04', star: 1 }]);
    expect(withItem.damage).toBeGreaterThan(plain.damage);
    expect(withItem.taken < plain.taken).toBe(true);
  });

  it('冑の【灭顶之灾】：攻撃力最高の味方へ弾を撃ち、着弾で周囲をスタン。弾は撃ち落とせて、敵の数には入らない', () => {
    ENEMIES.test_bomb_boss = { ...ENEMIES.enemy_9013_acstmk, hp: 1e8, attack: undefined, summon: undefined };
    setActiveMap('legacy');
    const spec: RoundSpec = { round: 14, levelId: 'test', timeLimit: 40, moveMultiplier: 0.5, spawns: [{ enemy: 'test_bomb_boss', count: 1, interval: 0, delay: 0, spawn: 0 }] };
    // 近距離だけ（飛んでいる弾を落とせない）→ 着弾する
    const melee = buildSimInputs([{ uid: 1, defId: byProf('defender').id, star: 1, pos: 31, dir: 'right' }], [], {});
    const r1 = simulateBattle(melee.inputs, spec, { globals: melee.globals, record: true });
    const hits1 = (r1.fx ?? []).filter((f) => f[1] === 7);
    expect(hits1.length).toBeGreaterThan(0);
    expect(r1.total).toBe(1);
    expect(r1.perUnit[0].taken).toBeGreaterThan(0);
    // 弾の通り道を狙える狙撃が複数いれば、撃ち落とせることがある（少なくとも着弾は減る）
    const snipers = buildSimInputs(
      [
        { uid: 1, defId: byProf('defender').id, star: 1, pos: 31, dir: 'right' },
        { uid: 2, defId: byProf('sniper').id, star: 2, pos: 23, dir: 'right' },
        { uid: 3, defId: byProf('sniper').id, star: 2, pos: 24, dir: 'right' },
        { uid: 4, defId: byProf('sniper').id, star: 2, pos: 15, dir: 'right' },
      ],
      [],
      {},
    );
    const r2 = simulateBattle(snipers.inputs, spec, { globals: snipers.globals, record: true });
    expect((r2.fx ?? []).filter((f) => f[1] === 7).length <= hits1.length).toBe(true);
    expect(r2.total).toBe(1);
  });

  it('冑の【死亡集群】：周期的に無人機を召喚し、無人機は防衛地点へ飛ぶ', () => {
    ENEMIES.test_summon_boss = { ...ENEMIES.enemy_9013_acstmk, hp: 1e8, attack: undefined, bomb: undefined };
    setActiveMap('legacy');
    const spec: RoundSpec = { round: 14, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_summon_boss', count: 1, interval: 0, delay: 0, spawn: 0 }] };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('defender').id, star: 1, pos: 31, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, spec, { globals });
    // 0秒・50秒に召喚。近距離だけでは落とせず突破される
    expect(r.total).toBe(3);
    expect(r.leaks.some((l) => l.key === 'enemy_1005_yokai')).toBe(true);
  });

  it('手下は周期的に攻撃力が最も低い味方へ突進して周囲をスタンさせ、突進中に何度も攻撃されると撃ち落とされる', () => {
    ENEMIES.test_boss3 = { ...ENEMIES.enemy_9013_acstmk_2, hp: 1e8, attack: undefined, summon: undefined, bomb: undefined };
    ENEMIES.test_diver = { ...ENEMIES.enemy_9014_acstma, minionOf: 'test_boss3', attack: undefined, dive: { ...ENEMIES.enemy_9014_acstma.dive!, init: 2 } };
    setActiveMap('legacy');
    const spec: RoundSpec = {
      round: 15,
      levelId: 'test',
      timeLimit: 40,
      moveMultiplier: 0.5,
      spawns: [
        { enemy: 'test_boss3', count: 1, interval: 0, delay: 0, spawn: 0 },
        { enemy: 'test_diver', count: 1, interval: 0, delay: 0, spawn: 0 },
      ],
    };
    // 近距離だけ：突進は着弾する
    const a = buildSimInputs([{ uid: 1, defId: byProf('defender').id, star: 1, pos: 31, dir: 'right' }], [], {});
    const r1 = simulateBattle(a.inputs, spec, { globals: a.globals, record: true });
    expect((r1.fx ?? []).filter((f) => f[1] === 7).length).toBeGreaterThan(0);
    // 狙撃が多数：突進中に撃ち落とされ、地上に落ちて動かなくなる
    const sn = byProf('sniper').id;
    const b = buildSimInputs(
      [
        { uid: 1, defId: byProf('defender').id, star: 1, pos: 31, dir: 'right' },
        ...[14, 15, 22, 23, 24].map((pos, i) => ({ uid: 2 + i, defId: sn, star: 2 as const, pos, dir: 'right' as const })),
      ],
      [],
      {},
    );
    const r2 = simulateBattle(b.inputs, spec, { globals: b.globals, record: true });
    const minionDamage = r2.perUnit.reduce((s2, u) => s2 + u.damage, 0);
    expect(minionDamage).toBeGreaterThan(0);
  });

  it('シークレットコア版の手下は飛び回り、防衛地点に入らず、無敵で、ボスが倒れると消える', () => {
    ENEMIES.test_boss2 = { ...ENEMIES.enemy_9013_acstmk_2, hp: 3000, def: 0, attack: undefined, summon: undefined, bomb: undefined };
    ENEMIES.test_minion = { ...ENEMIES.enemy_9014_acstma, minionOf: 'test_boss2' };
    setActiveMap('legacy');
    const spec: RoundSpec = {
      round: 15,
      levelId: 'test',
      timeLimit: 60,
      moveMultiplier: 0.5,
      spawns: [
        { enemy: 'test_boss2', count: 1, interval: 0, delay: 0, spawn: 0 },
        { enemy: 'test_minion', count: 1, interval: 0, delay: 0, spawn: 0 },
      ],
    };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('sniper').id, star: 2, pos: 6, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, spec, { globals, record: true });
    // ボスを倒すと手下も消えて全滅
    expect(r.cleared).toBe(true);
    expect(r.lifeLoss).toBe(0);
    // 手下は動き回る
    const pos = new Set(r.frames!.flatMap((f) => f.e.filter((e) => e[0] === 2).map((e) => `${e[1]},${e[2]}`)));
    expect(pos.size).toBeGreaterThan(3);
  });

  it('血掟テキサスS3：配置時に発動し、周囲の敵に2連撃とスタン、その後時間切れまで剣雨', () => {
    const texas = UNITS.find((u) => u.charId === 'char_1028_texas2')!;
    ENEMIES.test_tx = { name: 't', hp: 1e9, def: 0, res: 0, speed: 1, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    // 出現地点（35）の隣に置き、出現直後から範囲内に入るようにする
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 15, moveMultiplier: 0.5, spawns: [{ enemy: 'test_tx', count: 3, interval: 0.5, delay: 0, spawn: 1 }] };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: texas.id, star: 1, pos: 34, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect(r.perUnit[0].skillCasts).toBe(1);
    // 剣雨の命中（剣と星の演出）がスキル時間（6秒）の間だけ出る
    const bursts = (r.fx ?? []).filter((f) => f[1] === 8 && f[2] === 1).map((f) => f[0] / 100);
    expect(bursts.length).toBeGreaterThan(2);
    expect(Math.max(...bursts) <= 6.05).toBe(true);
    // スタン中の敵がいる
    expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 2) !== 0))).toBe(true);
  });

  it('【シラクーザ】の攻撃速度上昇を結果とリプレイに記録する（配置後の一定時間）', () => {
    const sira = UNITS.filter((u) => u.bonds.includes('siracusa')).slice(0, 3);
    ENEMIES.test_sc = { name: 's', hp: 1e9, def: 0, res: 0, speed: 0.5, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const board: OwnedUnit[] = sira.map((u, i) => ({ uid: i + 1, defId: u.id, star: 1, pos: [31, 32, 33][i], dir: 'right' }));
    const { inputs, globals } = buildSimInputs(board, [], {});
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 40, moveMultiplier: 0.5, spawns: [{ enemy: 'test_sc', count: 1, interval: 0, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect(r.siracusa!.aspd).toBeGreaterThan(0);
    expect(r.frames![0].sc!.length).toBe(3);
    expect(r.frames!.at(-1)!.sc ?? []).toEqual([]);
  });

  it('血掟テキサスの素質：スキル中に撃破するとスキルをもう一度発動（配置ごとに1回）', () => {
    const texas = UNITS.find((u) => u.charId === 'char_1028_texas2')!;
    ENEMIES.test_tx2 = { name: 't', hp: 3000, def: 0, res: 0, speed: 1, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 30, moveMultiplier: 0.5, spawns: [{ enemy: 'test_tx2', count: 12, interval: 1.5, delay: 0, spawn: 1 }] };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: texas.id, star: 2, pos: 33, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect(r.perUnit[0].skillCasts).toBe(2);
    // スキル時間7秒を超えてスキルが続く
    expect(r.frames!.some((f) => f.t > 7.5 && f.s.includes(1))).toBe(true);
  });

  it('【シラクーザ】Lv2：確定ダメージを別に記録し、恐怖で敵が逃げる（ブロック不可・攻撃しない）', () => {
    const sira = UNITS.filter((u) => u.bonds.includes('siracusa'));
    const picked = [...new Map(sira.map((u) => [u.charId, u])).values()].slice(0, 6);
    expect(picked.length).toBe(6);
    ENEMIES.test_fear = { name: 'f', hp: 1e9, def: 0, res: 0, speed: 0.6, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const board: OwnedUnit[] = picked.map((u, i) => ({ uid: i + 1, defId: u.id, star: 1, pos: 28 + i, dir: 'right' }));
    const { inputs, globals, statuses } = buildSimInputs(board, [], {});
    expect(statuses.find((x) => x.id === 'siracusa')!.level).toBe(2);
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_fear', count: 3, interval: 3, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, activeAlliances: new Set(['siracusa']), record: true });
    expect(r.perUnit.reduce((a, u) => a + (u.siracusaDamage ?? 0), 0)).toBeGreaterThan(0);
    expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 4) !== 0))).toBe(true);
    // Lv2 は配置後の一定時間ステルス（リプレイに記録）
    expect(r.frames![0].st!.length).toBe(6);
  });

  it('ステルスの敵はリプレイに記録される', () => {
    const spec = oneEnemy('test_stealth_rec', false, { ...ENEMIES.enemy_1299_ymkilr, hp: 1e9 });
    const r = run([], { ...spec, timeLimit: 5 });
    expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 8) !== 0))).toBe(true);
  });

  it('山海衆精鋭：ステルスが解けた後の最初の攻撃は攻撃力2倍', () => {
    const spec0 = ENEMIES.enemy_1299_ymkilr;
    expect(spec0.ambush).toBe(2);
    const run = (ambush?: number) => {
      ENEMIES.test_amb = { ...spec0, hp: 1e9, ambush };
      const spec = oneEnemy('test_amb', false, { ...ENEMIES.test_amb });
      return run0(spec);
    };
    const run0 = (spec: RoundSpec) => {
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('defender').id, star: 2, pos: 34, dir: 'right' }], [], {});
      return simulateBattle(inputs, { ...spec, timeLimit: 4 }, { globals }).perUnit[0].taken;
    };
    expect(run(2)).toBeGreaterThan(run(undefined));
  });

  it('元核のマレフィセント：攻撃を受けると速くなり、周囲に神経損傷を与え続ける', () => {
    const spec0 = ENEMIES.enemy_1439_dslntf;
    expect(spec0.enrage?.element).toBe('neural');
    ENEMIES.test_mal = { ...spec0, hp: 1e9 };
    const spec = oneEnemy('test_mal', false, { ...ENEMIES.test_mal });
    // 攻撃が届かない：臨戦にならない／狙撃が攻撃する：臨戦になって速く進む
    const reach = (pos: number, dir: 'down' | 'up') => {
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: byProf('sniper').id, star: 2, pos, dir }], [], {});
      const r = simulateBattle(inputs, { ...spec, timeLimit: 30 }, { globals, record: true });
      // 12秒時点の位置（左ほど進んでいる）
      return r.frames!.find((f) => f.t >= 12)?.e[0]?.[1] ?? -1;
    };
    expect(reach(23, 'down') < reach(3, 'up')).toBe(true);
  });

  it('浮遊ユニット：同じ敵を攻撃し続けるほどダメージが上がる（20%から110%まで）', () => {
    const rock = UNITS.find((u) => u.charId === 'char_4040_rockr')!;
    ENEMIES.test_fn = { name: 'f', hp: 1e9, def: 0, res: 0, speed: 0, blockCnt: 1, flying: false, boss: true, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const dmg = (limit: number) => {
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: rock.id, star: 1, pos: 33, dir: 'right' }], [], {});
      return simulateBattle(inputs, { round: 1, levelId: 'test', timeLimit: limit, moveMultiplier: 0.5, spawns: [{ enemy: 'test_fn', count: 1, interval: 0, delay: 0, spawn: 1 }] }, { globals }).perUnit[0];
    };
    const a = dmg(6);
    const b = dmg(12);
    // 後半の6秒の方が1回あたりのダメージが大きい
    expect((b.damage - a.damage) / Math.max(1, b.hits - a.hits) > a.damage / Math.max(1, a.hits)).toBe(true);
  });

  it('荒蕪ラップランドS3：ザーロ（浮遊ユニット+2）が近い敵を追い、取り付くと恐怖・減速・1秒ごとの術ダメージ', () => {
    const w = UNITS.find((u) => u.charId === 'char_1038_whitw2')!;
    ENEMIES.test_zz = { name: 'z', hp: 30000, def: 100, res: 0, speed: 0.8, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('legacy');
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: w.id, star: 2, pos: 24, dir: 'down' }], [], {});
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 70, moveMultiplier: 0.5, spawns: [{ enemy: 'test_zz', count: 10, interval: 4, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect(r.perUnit[0].skillCasts).toBe(1);
    expect(Math.max(...r.frames!.map((f) => (f.zr ?? []).length))).toBeGreaterThanOrEqual(3);
    expect((r.fx ?? []).filter((x) => x[1] === 9).length).toBeGreaterThan(0);
    expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 4) !== 0))).toBe(true);
  });

  it('スキル中の通常攻撃：スズランS3は攻撃しない、荒蕪ラップランドS3は本体が攻撃を続ける', () => {
    ENEMIES.test_sk = { name: 'k', hp: 1e6, def: 100, res: 0, speed: 0.4, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 80, moveMultiplier: 0.5, spawns: [{ enemy: 'test_sk', count: 12, interval: 4, delay: 0, spawn: 1 }] };
    const hitsInSkill = (name: string) => {
      setActiveMap('legacy');
      const def = UNITS.find((u) => u.name === name)!;
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: def.id, star: 2, pos: 24, dir: 'down' }], [], {});
      const r = simulateBattle(inputs, spec, { globals, record: true });
      expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
      const on = r.frames!.filter((f) => f.s.includes(1)).map((f) => f.t);
      const [from, to] = [Math.min(...on) + 0.5, Math.max(...on) - 0.5];
      return (r.fx ?? []).filter((x) => x[1] === 0 && x[2] === 1 && x[0] / 100 >= from && x[0] / 100 <= to).length;
    };
    expect(hitsInSkill('スズラン')).toBe(0);
    expect(hitsInSkill('荒蕪ラップランド')).toBeGreaterThan(0);
  });

  it('バクダンバチ：一度だけ爆弾を投げて目標と周囲8マスに物理ダメージ、その後は攻撃せず速くなる', () => {
    const bee = ENEMIES.enemy_1040_bombd;
    expect(bee.throwOnce?.radius).toBe(1);
    ENEMIES.test_bee = { ...bee, hp: 1e9 };
    setActiveMap('legacy');
    const sn = byProf('sniper').id;
    // 下段の経路沿いに隣り合う2人と、離れた1人
    const board: OwnedUnit[] = [
      { uid: 1, defId: sn, star: 1, pos: 24, dir: 'down' },
      { uid: 2, defId: sn, star: 1, pos: 25, dir: 'down' },
      { uid: 3, defId: sn, star: 1, pos: 19, dir: 'down' },
    ];
    const { inputs, globals } = buildSimInputs(board, [], {});
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_bee', count: 1, interval: 0, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect((r.fx ?? []).filter((x) => x[1] === 7).length).toBe(1);
    const taken = (uid: number) => r.perUnit.find((u) => u.uid === uid)!.taken;
    expect(taken(1) > 0 && taken(2) > 0).toBe(true);
    expect(taken(3)).toBe(0);
    // 投げた後は速い（同じ経路を投げずに進む場合より早く突破する）
    const calm = simulateBattle([], spec, { record: true });
    expect(r.elapsed < calm.elapsed).toBe(true);
  });

  it('帝国砲撃誘導機：射程内の味方をロックオンし、2秒後にそのマスを中心とする3×3へ砲撃が着弾する。射程の円は常に表示される', () => {
    const drone = ENEMIES.enemy_1112_emppnt;
    expect(drone.attack?.lockStrike).toEqual({ delay: 2, radius: 1 });
    ENEMIES.test_drone = { ...drone, hp: 1e9 };
    setActiveMap('legacy');
    const sn = byProf('sniper').id;
    // 下段の経路沿いに隣り合う2人と、離れた1人
    const board: OwnedUnit[] = [
      { uid: 1, defId: sn, star: 1, pos: 24, dir: 'down' },
      { uid: 2, defId: sn, star: 1, pos: 25, dir: 'down' },
      { uid: 3, defId: sn, star: 1, pos: 19, dir: 'down' },
    ];
    const { inputs, globals } = buildSimInputs(board, [], {});
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 40, moveMultiplier: 0.5, spawns: [{ enemy: 'test_drone', count: 1, interval: 0, delay: 0, spawn: 1 }] };
    const r = simulateBattle(inputs, spec, { globals, record: true });
    const locks = (r.fx ?? []).filter((x) => x[1] === 12);
    expect(locks.length).toBeGreaterThan(1);
    // ロックオンの間隔は攻撃間隔、着弾までの時間は2秒
    expect(locks[1][0] - locks[0][0] >= 500 && locks[1][0] - locks[0][0] <= 520).toBe(true);
    expect(locks[0][5]).toBe(200);
    const taken = (uid: number) => r.perUnit.find((u) => u.uid === uid)!.taken;
    expect(taken(1) > 0 || taken(2) > 0).toBe(true);
    // 射程の円はリプレイの敵の情報に入る
    expect(r.enemies[0].ring).toBe(2);
    // ロックオンの位置は味方のいるマスの中心
    const cells = new Set(board.map((u) => `${cellX(u.pos!) * 100},${cellY(u.pos!) * 100}`));
    expect(locks.every((l) => cells.has(`${l[3]},${l[4]}`))).toBe(true);
  });

  it('活性源石の上の敵は毎秒HPを失い、リプレイに記録される', () => {
    ENEMIES.test_inf = { name: 'i', hp: 1000, def: 0, res: 0, speed: 1, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    setActiveMap('m4');
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 40, moveMultiplier: 0.5, spawns: [{ enemy: 'test_inf', count: 1, interval: 0, delay: 0, spawn: 1 }] };
    const r = simulateBattle([], spec, { record: true });
    setActiveMap('legacy');
    expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 16) !== 0))).toBe(true);
    expect(r.frames!.some((f) => f.e.some((e) => e[3] < 100))).toBe(true);
  });

  it('飛行の敵は本家の飛行経路（経由点）を通る', () => {
    expect(routeCells([[8, 3], [6, 3], [6, 1], [7, 0]])).toEqual([35, 34, 33, 24, 15, 7]);
    // ラウンド1の飛行枠には経路がある
    const fly = ROUNDS[0].spawns.find((s) => s.flySlot)!;
    expect(fly.route![0]).toEqual([8, 3]);
    expect(fly.route![fly.route!.length - 1]).toEqual([0, 3]);
    setActiveMap('legacy');
    const flyer = roundEnemies({ ...ROUNDS[0], spawns: [fly] }).find((e) => e.spec.flying)!;
    expect(flyer.path).toEqual(routeCells(fly.route!));
  });

  it('ティッピ：攻撃を受けるとスキルが自動発動して回避・離陸。離陸中は地上の敵を放し、空中の敵をブロックして攻撃する', () => {
    const tippi = UNITS.find((u) => u.name === 'ティッピ')!;
    setActiveMap('legacy');
    const board: OwnedUnit[] = [{ uid: 1, defId: tippi.id, star: 1, pos: 33, dir: 'right' }];
    // 地上の近接の敵：SPが溜まった後の被弾で離陸し、敵は通り抜ける
    ENEMIES.test_tg = { name: 'g', hp: 1e9, def: 0, res: 0, speed: 0.6, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1, attack: { kind: 'melee', atk: 100, interval: 1, range: 0, arts: false } };
    const a = buildSimInputs(board, [], {});
    const g = simulateBattle(a.inputs, { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_tg', count: 1, interval: 0, delay: 0, spawn: 1 }] }, { globals: a.globals, record: true });
    expect(g.perUnit[0].skillCasts).toBeGreaterThan(0);
    expect(g.frames!.some((f) => (f.lf ?? []).includes(1))).toBe(true);
    expect(g.leaked).toBe(1);
    // 空中の敵：離陸するまでは攻撃できない。離陸後はブロックして攻撃する
    ENEMIES.test_tf = { name: 'f', hp: 1e9, def: 0, res: 0, speed: 0.6, blockCnt: 1, flying: true, boss: false, elite: false, lifeReduce: 1, attack: { kind: 'ranged', atk: 100, interval: 1, range: 1.5, arts: false } };
    const b = buildSimInputs(board, [], {});
    const f = simulateBattle(b.inputs, { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_tf', count: 1, interval: 0, delay: 10, spawn: 1 }] }, { globals: b.globals, record: true });
    expect(f.perUnit[0].skillCasts).toBeGreaterThan(0);
    expect(f.perUnit[0].hits).toBeGreaterThan(0);
    // ブロックで足止めされる（ブロックしない場合より突破が遅い）
    const free = simulateBattle([], { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_tf', count: 1, interval: 0, delay: 10, spawn: 1 }] }, {});
    expect(f.elapsed > free.elapsed).toBe(true);
  });

  it('傀儡師：致命傷で撤退せず身替りと入れ替わり、20秒後に本体へ戻る（身替りはブロックしない）', () => {
    const ghost = UNITS.find((u) => u.name === '帰溟スペクター')!;
    setActiveMap('legacy');
    // 強い近接の敵が次々来る。スキルは使わせない（必要SPを大きく）ために通常の素の動きで確認
    ENEMIES.test_dk = { name: 'd', hp: 1e9, def: 0, res: 0, speed: 0.4, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1, attack: { kind: 'melee', atk: 3000, interval: 1, range: 0, arts: false } };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: ghost.id, star: 1, pos: 33, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_dk', count: 1, interval: 0, delay: 0, spawn: 1 }] }, { globals, record: true });
    const dollFrames = r.frames!.filter((f) => (f.dl ?? []).includes(1));
    expect(dollFrames.length).toBeGreaterThan(0);
    // 身替りの間はブロックしないので、敵が通り抜ける
    expect(r.leaked).toBe(1);
    // 身替りの間も攻撃する（周囲8マス）
    const [from, to] = [dollFrames[0].t, dollFrames[dollFrames.length - 1].t];
    expect((r.fx ?? []).some((x) => x[1] === 0 && x[2] === 1 && x[0] / 100 > from && x[0] / 100 < to)).toBe(true);
    // 20秒で本体に戻る
    expect(to - from < 20.5).toBe(true);
    // 堅守特性：倒れた時か身替りと入れ替わった時、有効化中の【エーギル】【不屈】+5
    const s2 = simulateBattle(inputs, { round: 1, levelId: 'test', timeLimit: 30, moveMultiplier: 0.5, spawns: [{ enemy: 'test_dk', count: 1, interval: 0, delay: 0, spawn: 1 }] }, { globals, activeAlliances: new Set(['egir', 'indom']) });
    expect(s2.stackGains.indom ?? 0).toBeGreaterThanOrEqual(5);
    expect(s2.stackGains.egir ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('カゼマルS2：HPが減り、周囲に紙人形（身替り）を召喚して出現時に周囲の敵へ術ダメージ。スキル終了で消える', () => {
    const kz = UNITS.find((u) => u.name === 'カゼマル')!;
    setActiveMap('legacy');
    ENEMIES.test_kz = { name: 'k', hp: 1e9, def: 0, res: 0, speed: 0.4, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: kz.id, star: 1, pos: 32, dir: 'right' }], [], {});
    const r = simulateBattle(inputs, { round: 1, levelId: 'test', timeLimit: 80, moveMultiplier: 0.5, spawns: [{ enemy: 'test_kz', count: 6, interval: 3, delay: 0, spawn: 1 }] }, { globals, record: true });
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    const tkFrames = r.frames!.filter((f) => (f.tk ?? []).length > 0);
    expect(tkFrames.length).toBeGreaterThan(0);
    // 紙人形は召喚主の周囲8マス
    const pos = tkFrames[0].tk![0][1];
    expect(Math.abs((pos % 9) - (32 % 9)) <= 1 && Math.abs(Math.floor(pos / 9) - Math.floor(32 / 9)) <= 1).toBe(true);
    // 出現時の術ダメージ（爆発の範囲表示）
    expect((r.fx ?? []).some((x) => x[1] === 7)).toBe(true);
    // スキル（20秒）の後は消える
    const first = tkFrames[0].tk![0][0];
    const life = tkFrames.filter((f) => f.tk!.some((x) => x[0] === first)).map((f) => f.t);
    expect(life[life.length - 1] - life[0] < 20.5).toBe(true);
    // 結果は召喚主にまとまり、紙人形の行は出ない
    expect(r.perUnit.length).toBe(1);
  });

  it('祝祭のジャズ奏者：ステルス中は攻撃せず、ステルスが解ける（ブロックされる）と火炎放射で術ダメージと灼熱損傷', () => {
    const jazz = ENEMIES.enemy_10034_cnvsax;
    expect(jazz.attack?.atk).toBe(650);
    expect(jazz.flame?.scale).toBe(0.2);
    ENEMIES.test_jazz = { ...jazz, hp: 1e9 };
    setActiveMap('legacy');
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 40, moveMultiplier: 0.5, spawns: [{ enemy: 'test_jazz', count: 1, interval: 0, delay: 0, spawn: 1 }] };
    // 経路沿いの狙撃だけ：ステルスのままなので攻撃されない
    const a = buildSimInputs([{ uid: 1, defId: byProf('sniper').id, star: 1, pos: 24, dir: 'down' }], [], {});
    expect(simulateBattle(a.inputs, spec, { globals: a.globals }).perUnit[0].taken).toBe(0);
    // 重装がブロック：ステルスが解けて火炎放射を受ける（灼熱損傷も溜まる）
    const b = buildSimInputs([{ uid: 1, defId: byProf('defender').id, star: 2, pos: 33, dir: 'right' }], [], {});
    const r = simulateBattle(b.inputs, spec, { globals: b.globals, record: true });
    expect(r.perUnit[0].taken).toBeGreaterThan(0);
    expect(r.frames!.some((f) => (f.ue ?? []).some((x) => x[0] === 1 && x[1] === 0))).toBe(true);
    // 放射の前（SPを溜めている間）はブロックしている相手に近接の通常攻撃。ブロックされたのはSPが溜まる前（3+経過<10秒）なので、放射より前に被弾している
    const firstFlame = Math.min(...(r.fx ?? []).filter((x) => x[1] === 3).map((x) => x[0] / 100));
    expect(firstFlame >= 7 - 0.01).toBe(true);
  });

  describe('近距離と遠距離を使い分ける敵など', () => {
    const one = (key: string, over: Partial<EnemySpec>, board: OwnedUnit[], time = 40, map = 'legacy') => {
      ENEMIES[`t_${key}`] = { ...ENEMIES[key], ...over };
      setActiveMap(map);
      const { inputs, globals } = buildSimInputs(board, [], {});
      const r = simulateBattle(inputs, { round: 1, levelId: 'test', timeLimit: time, moveMultiplier: 0.5, spawns: [{ enemy: `t_${key}`, count: 1, interval: 0, delay: 0, spawn: 1 }] }, { globals, record: true });
      setActiveMap('legacy');
      return r;
    };
    const def2 = byProf('defender').id;
    const sn = byProf('sniper').id;

    it('掠海のフローター：低空浮揚（ブロックされず近距離は攻撃できない）、射程内の味方に物理＋侵蝕損傷', () => {
      const r = one('enemy_2025_syufo', { hp: 1e9 }, [{ uid: 1, defId: def2, star: 2, pos: 33, dir: 'right' }]);
      expect(r.perUnit[0].hits).toBe(0);
      expect(r.leaked).toBe(1);
      expect(r.perUnit[0].taken).toBeGreaterThan(0);
      expect(r.frames!.some((f) => (f.ue ?? []).some((x) => x[0] === 1 && x[1] === 2))).toBe(true);
      const s = one('enemy_2025_syufo', { hp: 1e9 }, [{ uid: 1, defId: sn, star: 2, pos: 24, dir: 'down' }]);
      expect(s.perUnit[0].hits).toBeGreaterThan(0);
      // 凍結すると低空浮揚を失って地上ユニットになり、ブロックされる（近距離も攻撃できる）
      ENEMIES.t_float = { ...ENEMIES.enemy_2025_syufo, hp: 1e9 };
      setActiveMap('legacy');
      const { inputs, globals } = buildSimInputs([{ uid: 1, defId: sn, star: 2, pos: 24, dir: 'down' }, { uid: 2, defId: def2, star: 2, pos: 31, dir: 'right' }], [], {});
      inputs[0].mods = { ...inputs[0].mods, coldProb: 1, coldDur: 3 };
      const g = simulateBattle(inputs, { round: 1, levelId: 'test', timeLimit: 40, moveMultiplier: 0.5, spawns: [{ enemy: 't_float', count: 1, interval: 0, delay: 0, spawn: 1 }] }, { globals });
      expect(g.freezes).toBeGreaterThan(0);
      expect(g.perUnit.find((u) => u.uid === 2)!.hits).toBeGreaterThan(0);
    });

    it('枯朽サルカズ戦車：地面マスの味方だけを攻撃し、数回ごとに汚染秽蝕を残す', () => {
      // 21 は旧マップの高台（地面マスではない）
      const high = one('enemy_1272_nhtank', { hp: 1e9 }, [{ uid: 1, defId: sn, star: 2, pos: 21, dir: 'down' }]);
      expect(high.perUnit[0].taken).toBe(0);
      const r = one('enemy_1272_nhtank', { hp: 1e9 }, [{ uid: 1, defId: def2, star: 2, pos: 33, dir: 'right' }]);
      expect(r.perUnit[0].taken).toBeGreaterThan(0);
      expect((r.fx ?? []).some((x) => x[1] === 6)).toBe(true);
    });

    it('墓守の石像：一度目に倒れると石像形態になり、その後は飛行形態で進む', () => {
      // 石像形態の間に倒されないよう、石像の防御力を極端に上げて確認
      const r = one('enemy_1172_dugago', { hp: 3000, def: 0, refract: 0, stone: { def: 99999, res: 30, duration: 10 } }, [{ uid: 1, defId: sn, star: 2, pos: 24, dir: 'down' }], 80);
      expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 32) !== 0))).toBe(true);
      expect(r.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 64) !== 0))).toBe(true);
      // 飛行形態は防衛地点へ向かって進む
      const flyXs = r.frames!.flatMap((f) => f.e.filter((e) => ((e[4] ?? 0) & 64) !== 0).map((e) => e[1]));
      expect(flyXs[flyXs.length - 1] < flyXs[0]).toBe(true);
    });

    it('「帝国の甲冑」：出現時にHPが最も高い味方へ複数回の物理ダメージ', () => {
      const r = one('enemy_10027_vtsk', { hp: 1e9, speed: 0.01 }, [
        { uid: 1, defId: sn, star: 1, pos: 24, dir: 'down' },
        { uid: 2, defId: def2, star: 2, pos: 2, dir: 'right' },
      ], 3);
      // 出現した瞬間（0秒）に、HPが高い重装へ8回
      const atSpawn = (r.fx ?? []).filter((x) => x[0] === 0 && x[1] === 3);
      expect(atSpawn.length).toBe(ENEMIES.enemy_10027_vtsk.appearStrike);
      expect(atSpawn.every((x) => x[3] === 2)).toBe(true);
    });

    it('仮想敵：泥濘：ブロックした相手に寄生して術ダメージ。狙われにくい', () => {
      expect(ENEMIES.enemy_9007_acelem.name).toBe('仮想敵：泥濘');
      expect(ENEMIES.enemy_9007_acelem.taunt).toBe(-1);
      const r = one('enemy_9007_acelem', { hp: 1e9 }, [{ uid: 1, defId: def2, star: 2, pos: 33, dir: 'right' }]);
      expect(r.perUnit[0].taken).toBeGreaterThan(0);
    });
  });

  it('アンジェリーナS3：スキル発動中のみ攻撃する', () => {
    ENEMIES.test_ag = { name: 'a', hp: 1e6, def: 100, res: 0, speed: 0.4, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    const spec: RoundSpec = { round: 1, levelId: 'test', timeLimit: 60, moveMultiplier: 0.5, spawns: [{ enemy: 'test_ag', count: 10, interval: 4, delay: 0, spawn: 1 }] };
    setActiveMap('legacy');
    const def = UNITS.find((u) => u.name === 'アンジェリーナ')!;
    const { inputs, globals } = buildSimInputs([{ uid: 1, defId: def.id, star: 1, pos: 24, dir: 'down' }], [], {});
    const r = simulateBattle(inputs, spec, { globals, record: true });
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    const on = new Set(r.frames!.filter((f) => f.s.includes(1)).map((f) => Math.round(f.t * 5)));
    const hits = (r.fx ?? []).filter((x) => x[1] === 0 && x[2] === 1);
    expect(hits.length).toBeGreaterThan(0);
    // 攻撃はすべてスキル中（記録の0.2秒刻みで前後1コマの誤差を許す）
    expect(hits.every((x) => [-1, 0, 1].some((d) => on.has(Math.floor((x[0] / 100) * 5) + d)))).toBe(true);
  });

  it('連鎖術師は近くの敵へ跳躍し、離れた敵には跳ばない', () => {
    const chain = UNITS.find((u) => u.name === 'レイズ')!;
    // 1回の攻撃（同じ時刻）で何体に命中したか
    const maxPerAttack = (r: ReturnType<typeof run>) => {
      const per = new Map<number, Set<number>>();
      for (const e of r.fx ?? []) if (e[1] === 0) per.set(e[0], (per.get(e[0]) ?? new Set()).add(e[3]));
      return Math.max(0, ...[...per.values()].map((x) => x.size));
    };
    const near: RoundSpec = { round: 1, levelId: 'test', timeLimit: 20, moveMultiplier: 0.5, spawns: [{ enemy: 'test_chain', count: 4, interval: 0.3, delay: 0, spawn: 1 }] };
    ENEMIES.test_chain = { name: 'c', hp: 1e9, def: 0, res: 0, speed: 1, blockCnt: 1, flying: false, boss: false, elite: false, lifeReduce: 1 };
    const far: RoundSpec = { ...near, spawns: [{ enemy: 'test_chain', count: 4, interval: 6, delay: 0, spawn: 1 }] };
    const board: OwnedUnit[] = [{ uid: 1, defId: chain.id, star: 2, pos: 23, dir: 'down' }];
    const a = run(board, near);
    const b = run(board, far);
    expect(maxPerAttack(a)).toBeGreaterThan(1);
    expect(maxPerAttack(b)).toBe(1);
  });

  it('エテルナのS3は自身も大きく回復する', () => {
    const eterna = UNITS.find((u) => u.charId === 'char_4134_cetsyr')!;
    const spec = oneEnemy('test_eterna', false, { speed: 0.01, attack: { kind: 'ranged', atk: 120, interval: 2, range: 99, arts: true } });
    const r = run([{ uid: 1, defId: eterna.id, star: 2, pos: 22, dir: 'down' }], spec);
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    // 特性（攻撃力の10%/秒）のままなら2.5万程度。S3で75%/秒になる
    expect(r.perUnit[0].healed).toBeGreaterThan(40000);
  });
  it('俊敏でSPが回復しても、1秒は再発動しない（瞬間発動のスキルが毎フレーム出ない）', () => {
    const spec = oneEnemy('test_swift', false, { speed: 0.05 });
    spec.timeLimit = 30;
    const board: OwnedUnit[] = [
      { uid: 1, defId: unit('レオンハルト').id, star: 2, pos: 22, dir: 'down' },
      { uid: 2, defId: unit('ティッピ').id, star: 2, pos: 23, dir: 'down' },
    ];
    const { inputs, globals, statuses } = buildSimInputs(board, [], { swift: 300 });
    const active = new Set(statuses.filter((x) => x.level > 0).map((x) => x.id));
    expect(globals.swiftProb).toBe(1);
    const r = simulateBattle(inputs, spec, { globals, activeAlliances: active, stacks: { swift: 300 } });
    const leon = r.perUnit.find((u) => u.uid === 1)!;
    expect(leon.skillCasts).toBeGreaterThan(5);
    expect(leon.skillCasts <= r.elapsed + 2).toBe(true);
  });
  it('ウタゲの素質：HPが減るほど攻撃速度が上がる', () => {
    const def = unit('ウタゲ');
    const calm = oneEnemy('test_utage_calm', false, { def: 0, res: 0 });
    const hard = oneEnemy('test_utage_hard', false, { def: 0, res: 0, attack: { kind: 'melee', atk: 400, interval: 1, range: 0, arts: false } });
    calm.timeLimit = hard.timeLimit = 20;
    const a = run([{ uid: 1, defId: def.id, star: 2, pos: 31, dir: 'right' }], calm);
    const b = run([{ uid: 1, defId: def.id, star: 2, pos: 31, dir: 'right' }], hard);
    // 殴られてHPが低いほうが攻撃回数が多い
    expect(b.perUnit[0].hits).toBeGreaterThan(a.perUnit[0].hits);
  });

  it('マドロックの素質：シールドが被弾を防ぎ、HPを回復する', () => {
    const spec = oneEnemy('test_mud', false, { attack: { kind: 'melee', atk: 3000, interval: 1, range: 0, arts: false } });
    const mud = unit('マドロック');
    const r = run([{ uid: 1, defId: mud.id, star: 2, pos: 31, dir: 'right' }], spec);
    expect(r.perUnit[0].healed).toBeGreaterThan(0);
  });
});

describe('デーゲンブレヒャー', () => {
  const degen = () => UNITS.find((u) => u.name === 'デーゲンブレヒャー')!;
  const board = (): OwnedUnit[] => [{ uid: 1, defId: degen().id, star: 1, pos: 31, dir: 'right' }];

  it('S3は発動と同時に始まる0.3秒ごとの斬撃10回と最後の一撃のモーションで、その間はスキル中（ゲージが減っていく）表示になり通常攻撃しない', () => {
    const r = run(board(), oneEnemy('test_degen_s3', false, { speed: 0.01, def: 0 }));
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    const slashes = r.fx!.filter((e) => e[1] === 2 && e[2] === 1 && e[3] === 1);
    const first = slashes.slice(0, 11);
    expect(first.length).toBe(11);
    for (let i = 1; i < 11; i++) expect(first[i][0] - first[i - 1][0]).toBe(30);
    // 斬撃の前後0.3秒以上の間隔はなく、モーション中のコマはすべてスキル中（状態1）でゲージが減っていく
    // 最初の斬撃は発動と同時
    const t0 = first[0][0] / 100;
    expect(r.frames!.filter((f) => f.t < t0 - 0.01).every((f) => f.u![0][3] === 0)).toBe(true);
    const t1 = first[10][0] / 100;
    const motion = r.frames!.filter((f) => f.t > t0 + 0.05 && f.t < t1 - 0.05);
    expect(motion.length).toBeGreaterThan(5);
    expect(motion.every((f) => f.u![0][3] === 1 && f.s.includes(1))).toBe(true);
    for (let i = 1; i < motion.length; i++) expect(motion[i].u![0][2] <= motion[i - 1].u![0][2]).toBe(true);
    // モーション中の命中はすべて斬撃（通常攻撃の命中がない）
    const hits = r.fx!.filter((e) => e[1] === 0 && e[2] === 1 && e[0] / 100 > t0 + 0.01 && e[0] / 100 < t1 + 0.01);
    expect(hits.every((h) => slashes.some((s) => s[0] === h[0]))).toBe(true);
    // 終わるとSP溜めに戻る
    expect(r.frames!.find((f) => f.t > t1 + 0.1)!.u![0][3]).toBe(0);
  });

  it('S3は飛行の敵にも当たる（通常攻撃は当たらない）', () => {
    const r = run(board(), oneEnemy('test_degen_air', true, { speed: 0.3, def: 0 }));
    expect(r.perUnit[0].skillCasts).toBeGreaterThan(0);
    expect(r.perUnit[0].damage).toBeGreaterThan(0);
    expect(r.fx!.some((e) => e[1] === 2 && e[2] === 1)).toBe(true);
  });

  it('素質：戦慄にした敵はブロック中に攻撃できず、戦慄の敵には防御力25%無視', () => {
    const attack = { kind: 'melee' as const, atk: 400, interval: 1, range: 0, arts: false };
    const normal = run(board(), oneEnemy('test_degen_t1', false, { def: 600, attack }));
    // 抵抗100%の敵は戦慄にならない
    const resist = run(board(), oneEnemy('test_degen_t2', false, { def: 600, attack, statusResist: 1 }));
    expect(normal.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 512) !== 0))).toBe(true);
    expect(resist.frames!.some((f) => f.e.some((e) => ((e[4] ?? 0) & 512) !== 0))).toBe(false);
    expect(normal.perUnit[0].taken < resist.perUnit[0].taken).toBe(true);
    expect(normal.perUnit[0].damage > resist.perUnit[0].damage * 1.1).toBe(true);
  });
});
