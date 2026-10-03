import { describe, expect, it } from 'vitest';
import { ENEMY_PATHS, GOAL, MAPS, RANDOM_MAPS, SPAWNS, canPlace, setActiveMap, tileAt } from '../src/core/board';
import { ENEMIES, ENEMY_GROUPS, ROUNDS, pickRoundGroup, roundSpec, type EnemySpec, type RoundSpec } from '../src/core/data/battle';
import { UNITS } from '../src/core/data/units';
import { buildSimInputs, createGame, roundGroupOf } from '../src/core/game';
import { simulateBattle } from '../src/core/sim';
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

  it('ヴィルトゥオーサのスキルで敵が凋亡の元素爆発を起こす', () => {
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
