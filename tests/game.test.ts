import { describe, expect, it } from 'vitest';
import { evaluateAlliances, unitModifiers } from '../src/core/alliance';
import { applyAction, createGame, type GameState } from '../src/core/game';
import { getUnit } from '../src/core/data/units';
import { BENCH_SIZE, deployCap } from '../src/core/rules';
import type { OwnedUnit } from '../src/core/types';

/** ショップの中身を差し替えて購入しやすくする */
function withShop(s: GameState, ids: string[]): GameState {
  return { ...s, shop: ids, gold: 100 };
}

const owned = (s: GameState) => [...s.board, ...s.bench.filter((b): b is OwnedUnit => !!b)];

describe('盟約', () => {
  it('同じオペレーターは1体として数える', () => {
    const board: OwnedUnit[] = [
      { uid: 1, defId: 'rook', star: 1 },
      { uid: 2, defId: 'rook', star: 1 },
      { uid: 3, defId: 'sable', star: 1 },
    ];
    const iron = evaluateAlliances(board).find((a) => a.id === 'iron')!;
    expect(iron.count).toBe(2);
    expect(iron.level).toBe(1);
    expect(iron.next).toBe(4);
  });

  it('守護は所属外にも効く', () => {
    const board: OwnedUnit[] = [
      { uid: 1, defId: 'rook', star: 1 }, // 守護
      { uid: 2, defId: 'coral', star: 1 }, // 守護
      { uid: 3, defId: 'bolt', star: 1 }, // 守護ではない
    ];
    const mods = unitModifiers(board, evaluateAlliances(board), {});
    expect(mods.get(3)?.atkPct).toBeCloseTo(0.05);
  });

  it('加算数が補正に反映される', () => {
    const board: OwnedUnit[] = [
      { uid: 1, defId: 'rook', star: 1 },
      { uid: 2, defId: 'sable', star: 1 },
    ];
    const mods = unitModifiers(board, evaluateAlliances(board), { iron: 20 });
    // 鉄壁団Lv1 +10% と加算数20で+20%、守護は1人なので未発動
    expect(mods.get(2)?.atkPct).toBeCloseTo(0.3);
  });
});

describe('ゲーム進行', () => {
  it('同じシードなら同じショップ', () => {
    expect(createGame(42).shop).toEqual(createGame(42).shop);
  });

  it('管理レベル1のショップは等級1のみ', () => {
    for (let seed = 0; seed < 20; seed++) {
      for (const id of createGame(seed).shop) expect(getUnit(id!).tier).toBe(1);
    }
  });

  it('3体揃うと昇進する', () => {
    let s = withShop(createGame(1), ['kite', 'kite', 'kite', null as unknown as string, 'bolt']);
    for (const slot of [0, 1, 2]) s = applyAction(s, { type: 'buy', slot }).state;
    const kites = owned(s).filter((o) => o.defId === 'kite');
    expect(kites).toHaveLength(1);
    expect(kites[0].star).toBe(2);
  });

  it('配置中の個体を残して昇進する', () => {
    let s = withShop(createGame(1), ['kite', 'kite', 'kite', 'bolt', 'bolt']);
    s = applyAction(s, { type: 'buy', slot: 0 }).state;
    const first = owned(s)[0].uid;
    s = applyAction(s, { type: 'deploy', uid: first }).state;
    s = applyAction(s, { type: 'buy', slot: 1 }).state;
    s = applyAction(s, { type: 'buy', slot: 2 }).state;
    expect(s.board).toHaveLength(1);
    expect(s.board[0]).toMatchObject({ uid: first, star: 2 });
  });

  it('控えが満杯でも昇進できるなら購入できる', () => {
    let s = createGame(1);
    s = {
      ...s,
      gold: 100,
      shop: ['kite', null, null, null, null],
      bench: Array.from({ length: BENCH_SIZE }, (_, i) => ({ uid: 100 + i, defId: i < 2 ? 'kite' : 'bolt', star: 1 as const })),
    };
    const r = applyAction(s, { type: 'buy', slot: 0 });
    expect(r.error).toBeUndefined();
    expect(r.state.bench).toHaveLength(BENCH_SIZE);
    expect(owned(r.state).find((o) => o.defId === 'kite')?.star).toBe(2);
  });

  it('控えが満杯で昇進もできないなら購入できない', () => {
    let s = createGame(1);
    s = {
      ...s,
      gold: 100,
      shop: ['ember', null, null, null, null],
      bench: Array.from({ length: BENCH_SIZE }, (_, i) => ({ uid: 100 + i, defId: 'bolt', star: 1 as const })),
    };
    expect(applyAction(s, { type: 'buy', slot: 0 }).error).toBeDefined();
  });

  it('売却で資金とプールが戻る', () => {
    let s = withShop(createGame(1), ['kite', 'kite', 'kite', 'bolt', 'bolt']);
    const pool0 = s.pool.kite;
    for (const slot of [0, 1, 2]) s = applyAction(s, { type: 'buy', slot }).state;
    const gold = s.gold;
    s = applyAction(s, { type: 'sell', uid: owned(s)[0].uid }).state;
    expect(s.gold).toBe(gold + 3);
    expect(s.pool.kite).toBe(pool0);
  });

  it('配置上限を超えて配置できない', () => {
    let s = withShop(createGame(1), ['kite', 'bolt', 'ember', 'rook', 'mira']);
    for (const slot of [0, 1, 2, 3, 4]) s = applyAction(s, { type: 'buy', slot }).state;
    const uids = owned(s).map((o) => o.uid);
    for (const uid of uids.slice(0, deployCap(1))) s = applyAction(s, { type: 'deploy', uid }).state;
    expect(applyAction(s, { type: 'deploy', uid: uids[deployCap(1)] }).error).toBeDefined();
  });

  it('戦闘→次ラウンドで進行し、資金が増える', () => {
    let s = createGame(7);
    const gold = s.gold;
    s = applyAction(s, { type: 'battle' }).state;
    expect(s.phase).toBe('result');
    expect(s.gold).toBeGreaterThan(gold);
    s = applyAction(s, { type: 'next' }).state;
    expect(s.round).toBe(2);
    expect(s.phase).toBe('prep');
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
