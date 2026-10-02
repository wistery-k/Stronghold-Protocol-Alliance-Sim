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
    const reaper = UNITS.find((u) => u.subProfession === 'reaper')!;
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
});
