import { describe, expect, it } from 'vitest';
import { battleSetup, evaluateAlliances } from '../src/core/alliance';
import { behindOf, frontOf, sameRow } from '../src/core/board';
import { applyAction, createGame, levelUpCost, priceOf, type GameState } from '../src/core/game';
import { UNITS, getUnit } from '../src/core/data/units';
import { BENCH_SIZE, DEPLOY_CAP, roundIncome } from '../src/core/rules';
import type { OwnedItem, OwnedUnit } from '../src/core/types';

const id = (name: string) => UNITS.find((u) => u.name === name)!.id;
const owned = (s: GameState) => [...s.board, ...s.bench.filter((b): b is OwnedUnit => !!b && 'defId' in b)];
const benchItems = (s: GameState) => s.bench.filter((b): b is OwnedItem => !!b && 'itemId' in b);
const ou = (uid: number, name: string, star: 1 | 2 = 1): OwnedUnit => ({ uid, defId: id(name), star });

/** ショップの中身を差し替え、資金を多めにする */
function withShop(s: GameState, names: (string | null)[], gold = 100): GameState {
  return { ...s, shop: names.map((n) => (n ? id(n) : null)), gold };
}

describe('盟約', () => {
  it('同じオペレーターは1名として数え、核心盟約は3名から発動', () => {
    const board = [ou(1, 'マッターホルン'), ou(2, 'マッターホルン'), ou(3, 'ハロルド'), ou(4, 'スノーハンター')];
    const kj = evaluateAlliances(board).find((a) => a.id === 'kjerag')!;
    expect(kj.count).toBe(3);
    expect(kj.level).toBe(1);
    expect(kj.next).toBe(6);
  });

  it('先見は控えのオペレーターも数える', () => {
    const st = evaluateAlliances([ou(1, 'サイレンス')], [ou(2, 'イネス')]).find((a) => a.id === 'visi')!;
    expect(st.count).toBe(2);
    expect(st.level).toBe(1);
  });

  it('孤高はちょうど1名のときだけ発動', () => {
    expect(evaluateAlliances([ou(1, 'テキサス')]).find((a) => a.id === 'solo')!.level).toBe(1);
    expect(evaluateAlliances([ou(1, 'テキサス'), ou(2, 'マドロック')]).find((a) => a.id === 'solo')!.level).toBe(0);
  });

  it('調和は核心盟約の人数を+1する', () => {
    const board = [ou(1, 'マッターホルン'), ou(2, 'ハロルド'), ou(3, 'ミュルジス')];
    const kj = evaluateAlliances(board).find((a) => a.id === 'kjerag')!;
    expect(kj.count).toBe(3);
    expect(kj.level).toBe(1);
    expect(kj.memberUids).toContain(3);
  });
});

describe('経済', () => {
  it('ラウンドnの資金は n+3', () => {
    expect(roundIncome(1)).toBe(4);
    expect(createGame(1).gold).toBe(4);
    let s = createGame(1);
    s = applyAction(s, { type: 'battle' }).state;
    const before = s.gold;
    s = applyAction(s, { type: 'next' }).state;
    expect(s.gold).toBe(before + 5);
  });

  it('購入価格：等級Iは2、II〜IVは3、V〜VIは4', () => {
    const s = createGame(1);
    const tierPrice = (tier: number) => priceOf(s, UNITS.find((u) => u.tier === tier && !u.normal.garrisons.some((g) => g.effect === 'SERVER_CHESS_PRICE'))!.id);
    expect([1, 2, 3, 4, 5, 6].map(tierPrice)).toEqual([2, 3, 3, 3, 4, 4]);
  });

  it('管理レベルの価格はラウンドごとに1ずつ下がる', () => {
    let s = createGame(1);
    const c0 = levelUpCost(s)!;
    s = applyAction(s, { type: 'battle' }).state;
    s = applyAction(s, { type: 'next' }).state;
    expect(levelUpCost(s)).toBe(c0 - 1);
  });

  it('盤面は8枠、控えは10枠', () => {
    expect(DEPLOY_CAP).toBe(8);
    expect(BENCH_SIZE).toBe(10);
  });
});

describe('招集と昇進', () => {
  it('3体揃うと昇進する', () => {
    let s = withShop(createGame(1), ['インサイダー', 'インサイダー', 'インサイダー']);
    for (const slot of [0, 1, 2]) s = applyAction(s, { type: 'buy', slot }).state;
    const list = owned(s).filter((o) => o.defId === id('インサイダー'));
    expect(list).toHaveLength(1);
    expect(list[0].star).toBe(2);
  });

  it('配置中の個体を残して昇進する', () => {
    let s = withShop(createGame(1), ['インサイダー', 'インサイダー', 'インサイダー']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    const first = owned(s)[0].uid;
    s = applyAction(s, { type: 'deploy', uid: first }).state;
    s = applyAction(s, { type: 'buy', slot: 1 }).state;
    s = applyAction(s, { type: 'buy', slot: 2 }).state;
    expect(s.board).toHaveLength(1);
    expect(s.board[0]).toMatchObject({ uid: first, star: 2 });
  });

  it('カゼマルは2体で昇進する', () => {
    let s = withShop(createGame(1), ['カゼマル', 'カゼマル']);
    for (const slot of [0, 1]) s = applyAction(s, { type: 'buy', slot }).state;
    expect(owned(s).filter((o) => o.defId === id('カゼマル')).map((o) => o.star)).toEqual([2]);
  });

  it('控えが満杯でも昇進できるなら購入できる', () => {
    let s = createGame(1);
    s = {
      ...withShop(s, ['インサイダー']),
      bench: Array.from({ length: BENCH_SIZE }, (_, i) => ({ uid: 100 + i, defId: i < 2 ? id('インサイダー') : id('グム'), star: 1 as const })),
    };
    const r = applyAction(s, { type: 'buy', slot: 0 });
    expect(r.error).toBeUndefined();
    expect(r.state.bench).toHaveLength(BENCH_SIZE);
  });

  it('売却で資金1とプールが戻る', () => {
    let s = withShop(createGame(1), ['インサイダー']);
    const pool0 = s.pool[id('インサイダー')];
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    const gold = s.gold;
    s = applyAction(s, { type: 'sell', uid: owned(s)[0].uid }).state;
    expect(s.gold).toBe(gold + 1);
    expect(s.pool[id('インサイダー')]).toBe(pool0);
  });
});

describe('堅守特性', () => {
  it('〈獲得時〉自身の盟約の加算数+2（有効化不要）', () => {
    let s = withShop(createGame(1), ['マッターホルン']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    expect(s.stacks.kjerag).toBe(2);
    expect(s.stacks.stead).toBe(2);
  });

  it('投資家が有効なら「獲得時」が2回発動', () => {
    let s = withShop(createGame(1), ['マッターホルン']);
    s.bench[0] = ou(901, 'ブリキ');
    s.bench[1] = ou(902, 'マウンテン');
    s.bench[2] = ou(903, '琳琅スワイヤー');
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    expect(s.stacks.kjerag).toBe(4);
  });

  it('〈獲得時〉無料更新を獲得し、更新が無料になる', () => {
    let s = withShop(createGame(1), ['プロヴァンス'], 2);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    expect(s.freeRefreshes).toBe(1);
    const gold = s.gold;
    s = applyAction(s, { type: 'refresh' }).state;
    expect(s.gold).toBe(gold);
    expect(s.freeRefreshes).toBe(0);
  });

  it('助力：準備フェーズ終了時に有効化中の盟約の加算数+2', () => {
    let s = createGame(1);
    s = { ...s, board: [ou(1, 'ヴァンデラ'), ou(2, 'ポデンコ')] };
    s = applyAction(s, { type: 'battle' }).state;
    // 助力自身（+2）。ポデンコの特性で最多の盟約にさらに+1
    expect(s.stacks.deput).toBeGreaterThanOrEqual(2);
  });
});

describe('進行', () => {
  it('同じシードなら同じショップ、レベル1は3枠で等級Iのみ', () => {
    expect(createGame(42).shop).toEqual(createGame(42).shop);
    const shop = createGame(7).shop;
    expect(shop).toHaveLength(3);
    for (const d of shop) expect(getUnit(d!).tier).toBe(1);
  });

  it('凍結したショップは次ラウンドに持ち越される', () => {
    let s = createGame(3);
    const shop = [...s.shop];
    s = applyAction(s, { type: 'toggleFreeze' }).state;
    s = applyAction(s, { type: 'battle' }).state;
    s = applyAction(s, { type: 'next' }).state;
    expect(s.shop).toEqual(shop);
    expect(s.frozen).toBe(false);
  });
});

describe('精鋭化の報酬', () => {
  it('精鋭化すると管理レベル+1の等級から3名が提示され、選ぶと無料で獲得', () => {
    let s = withShop(createGame(1), ['インサイダー', 'インサイダー', 'インサイダー']);
    for (const slot of [0, 1, 2]) s = applyAction(s, { type: 'buy', slot }).state;
    expect(s.choices).toHaveLength(1);
    expect(s.choices[0].options).toHaveLength(3);
    for (const c of s.choices[0].options) expect(getUnit(c).tier).toBe(2);
    // 選ぶまで戦闘できない
    expect(applyAction(s, { type: 'battle' }).error).toBeDefined();
    const gold = s.gold;
    const pick = s.choices[0].options[0];
    s = applyAction(s, { type: 'choose', index: 0 }).state;
    expect(s.gold).toBe(gold);
    expect(s.choices).toHaveLength(0);
    expect(owned(s).some((o) => o.defId === pick)).toBe(true);
  });
});

describe('配置エリア', () => {
  it('指定マスへ配置し、ドラッグで入れ替えられる', () => {
    let s = withShop(createGame(1), ['インサイダー', 'グム']);
    for (const slot of [0, 1]) s = applyAction(s, { type: 'buy', slot }).state;
    const [a, b] = owned(s);
    s = applyAction(s, { type: 'move', uid: a.uid, to: { zone: 'board', pos: 28 } }).state;
    s = applyAction(s, { type: 'move', uid: b.uid, to: { zone: 'board', pos: 29 } }).state;
    expect(s.board.find((o) => o.uid === a.uid)!.pos).toBe(28);
    s = applyAction(s, { type: 'move', uid: a.uid, to: { zone: 'board', pos: 29 } }).state;
    expect(s.board.find((o) => o.uid === a.uid)!.pos).toBe(29);
    expect(s.board.find((o) => o.uid === b.uid)!.pos).toBe(28);
    // 盤面→控えの埋まった枠へ：入れ替え
    s = applyAction(s, { type: 'move', uid: a.uid, to: { zone: 'bench', index: 0 } }).state;
    expect(s.board.map((o) => o.uid)).toEqual([b.uid]);
    expect(s.bench[0]!.uid).toBe(a.uid);
  });

  it('ミニマリストの購入価格は1', () => {
    expect(priceOf(createGame(1), id('ミニマリスト'))).toBe(1);
  });

  it('前方1マスを参照する特性（アルケット：自身と前方の盟約の加算数）', () => {
    const run = (archetPos: number, tippiPos: number) => {
      let s = createGame(1);
      s = { ...s, board: [{ ...ou(1, 'アルケット'), pos: archetPos }, { ...ou(2, 'ティッピ'), pos: tippiPos }] };
      s = applyAction(s, { type: 'battle' }).state;
      s = applyAction(s, { type: 'next' }).state;
      return s.stacks.skillful ?? 0;
    };
    // ティッピがアルケットの前方（右）にいると、ティッピの盟約にも加算される
    expect(run(28, 29)).toBeGreaterThan(run(29, 28));
  });
});

describe('向き・控えの超過・特別招集', () => {
  it('前方は向いている方向から見た相対位置', () => {
    const a = { ...ou(1, 'アルケット'), pos: 14, dir: 'up' as const };
    const up = { ...ou(2, 'グム'), pos: 5 };
    const right = { ...ou(3, 'ティッピ'), pos: 15 };
    const board = [a, up, right];
    expect(frontOf(board, a)?.uid).toBe(2);
    expect(behindOf(board, a)).toBeUndefined();
    a.dir = 'right' as never;
    expect(frontOf(board, a)?.uid).toBe(3);
    // 左右一直線上は向きに関係なく横一列
    expect(sameRow(board, a).map((o) => o.uid).sort()).toEqual([1, 3]);
  });

  it('向きを変えるアクション', () => {
    let s = withShop(createGame(1), ['グム']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    const uid = owned(s)[0].uid;
    s = applyAction(s, { type: 'deploy', uid }).state;
    s = applyAction(s, { type: 'turn', uid, dir: 'down' }).state;
    expect(s.board[0].dir).toBe('down');
  });

  it('特性で控えの上限を超えても破棄せず、超過中は戦闘できない', () => {
    let s = createGame(1);
    s = {
      ...withShop(s, ['フレイムテイル']),
      bench: Array.from({ length: BENCH_SIZE - 1 }, (_, i) => ({ uid: 100 + i, defId: id('グム'), star: 1 as const })).concat([null as never]),
    };
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    // フレイムテイル（最後の1枠）＋特性で獲得した1名 → 1名超過
    expect(owned(s)).toHaveLength(BENCH_SIZE + 1);
    expect(applyAction(s, { type: 'battle' }).error).toBeDefined();
    s = applyAction(s, { type: 'sell', uid: 100 }).state;
    expect(s.bench).toHaveLength(BENCH_SIZE);
    expect(applyAction(s, { type: 'battle' }).error).toBeUndefined();
  });

  it('パインコーンを売却すると等級Iの特別招集（3択）', () => {
    let s = withShop(createGame(1), ['パインコーン']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    s = applyAction(s, { type: 'sell', uid: owned(s)[0].uid }).state;
    expect(s.choices).toHaveLength(1);
    for (const c of s.choices[0].options) expect(getUnit(c).tier).toBe(1);
  });
});

describe('装備', () => {
  it('精鋭化すると、合成したオペレーター全員の装備が控えに戻る', () => {
    let s = createGame(1);
    const a: OwnedUnit = { ...ou(1, 'グム'), items: [{ uid: 101, itemId: '1_01', star: 1 }] };
    const b: OwnedUnit = { ...ou(2, 'グム'), pos: 28, items: [{ uid: 102, itemId: '1_03', star: 1 }] };
    s = { ...s, nextUid: 200, bench: [a, ...Array(BENCH_SIZE - 1).fill(null)], board: [b] };
    s = applyAction(withShop(s, ['グム']), { type: 'buy', slot: 0 }).state;
    const elite = owned(s).find((o) => o.star === 2)!;
    expect(elite?.star).toBe(2);
    expect(elite.items ?? []).toEqual([]);
    expect(benchItems(s).map((i) => i.itemId).sort()).toEqual(['1_01', '1_03']);
  });

  it('ヴィクトリアの鉄鎚・〇〇はショップに並ばない', () => {
    let s = createGame(3);
    for (let i = 0; i < 300; i++) {
      s = applyAction({ ...s, gold: 99, level: 1 + (i % 6) }, { type: 'refresh' }).state;
      expect(['2_03', '3_09', '3_10', '4_09']).not.toContain(s.itemShop);
    }
  });

  const withItemShop = (s: GameState, itemId: string, gold = 100): GameState => ({ ...s, itemShop: itemId, gold });

  it('購入して2つ揃うと強化される', () => {
    let s = withItemShop(createGame(1), '1_01');
    s = applyAction(s, { type: 'buyItem' }).state;
    s = applyAction({ ...s, itemShop: '1_01' }, { type: 'buyItem' }).state;
    const items = benchItems(s);
    expect(items).toHaveLength(1);
    expect(items[0].star).toBe(2);
  });

  it('装備は控えに入り、1人2つまで、売却すると控えに戻る', () => {
    let s = withShop(createGame(1), ['インサイダー']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    const unit = owned(s)[0];
    for (const id of ['1_01', '1_02', '1_05']) s = applyAction({ ...s, itemShop: id, gold: 100 }, { type: 'buyItem' }).state;
    const ids = benchItems(s).map((i) => i.uid);
    s = applyAction(s, { type: 'equip', itemUid: ids[0], unitUid: unit.uid }).state;
    s = applyAction(s, { type: 'equip', itemUid: ids[1], unitUid: unit.uid }).state;
    expect(applyAction(s, { type: 'equip', itemUid: ids[2], unitUid: unit.uid }).error).toBeDefined();
    expect(owned(s)[0].items).toHaveLength(2);
    s = applyAction(s, { type: 'sell', uid: unit.uid }).state;
    expect(benchItems(s)).toHaveLength(3);
  });

  it('消耗型（盟約のコイン）は装備時に消滅して資金を得る', () => {
    let s = withShop(createGame(1), ['インサイダー']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    s = applyAction({ ...s, itemShop: '1_03', gold: 10 }, { type: 'buyItem' }).state;
    const gold = s.gold;
    const it = benchItems(s)[0];
    s = applyAction(s, { type: 'equip', itemUid: it.uid, unitUid: owned(s)[0].uid }).state;
    expect(s.gold).toBe(gold + 1);
    expect(benchItems(s)).toHaveLength(0);
    expect(owned(s)[0].items ?? []).toHaveLength(0);
  });

  it('攻撃力の装備で攻撃力が上がる', () => {
    const u = { ...ou(1, 'スカジ'), pos: 0, items: [{ uid: 9, itemId: '1_01', star: 1 as const }] };
    expect(battleSetup([u], [], {}).mods.get(1)?.atkPct).toBeCloseTo(0.15);
  });

  it('変形同構体は他の装備の盟約を追加する', () => {
    const u = { ...ou(1, 'グム'), pos: 0, items: [{ uid: 8, itemId: '6_09', star: 1 as const }, { uid: 9, itemId: '1_01', star: 1 as const }] };
    const others = [{ ...ou(2, 'ヴァンデラ'), pos: 1 }, { ...ou(3, 'ミント'), pos: 2 }];
    const st = evaluateAlliances([u, ...others]).find((a) => a.id === 'victoria')!;
    expect(st.count).toBe(3);
    expect(st.level).toBe(1);
  });
});

describe('盟約BAN', () => {
  it('核心盟約3つ・追加盟約4つがBANされ、BAN盟約を2つ以上持つオペレーターは出現しない', () => {
    const s = createGame(11);
    expect(s.banned).toHaveLength(7);
    expect(s.banned.filter((b) => ['yan', 'sargon', 'victoria', 'kjerag', 'laterano', 'egir', 'siracusa', 'kazimierz'].includes(b))).toHaveLength(3);
    const blocked = UNITS.filter((u) => u.bonds.filter((b) => s.banned.includes(b)).length >= Math.min(2, u.bonds.length)).map((u) => u.id);
    expect(blocked.some((id) => UNITS.find((u) => u.id === id)!.bonds.length === 1)).toBe(true);
    for (let i = 0; i < 30; i++) {
      const r = applyAction({ ...s, gold: 100 }, { type: 'refresh' }).state;
      for (const id of r.shop) expect(blocked.includes(id!)).toBe(false);
    }
  });

  it('BANされた盟約も人数を満たせば発動する', () => {
    const board = [ou(1, 'マッターホルン'), ou(2, 'ハロルド'), ou(3, 'スノーハンター')];
    const kj = evaluateAlliances(board, [], ['kjerag']).find((a) => a.id === 'kjerag')!;
    expect(kj.level).toBe(1);
    expect(kj.banned).toBe(true);
  });

  it('BANなしでも遊べる', () => {
    expect(createGame(1, { ban: 'none' }).banned).toEqual([]);
  });
});

describe('凍結', () => {
  it('凍結中もラウンド開始時に購入済みの枠は補充され、売れ残りはそのまま', () => {
    let s = { ...createGame(3), gold: 100 };
    const before = [...s.shop];
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    s = applyAction(s, { type: 'toggleFreeze' }).state;
    s = applyAction(s, { type: 'battle' }).state;
    s = applyAction(s, { type: 'next' }).state;
    expect(s.shop[0]).not.toBeNull();
    expect(s.shop.slice(1)).toEqual(before.slice(1));
  });
});
