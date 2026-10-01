import { UNITS, getUnit } from './data/units';
import { benchUnits, currentActive, gainTriggerTimes, triggerGarrisons } from './garrison';
import { Rng } from './rng';
import { itemOnGain, unitAvailable } from './items';
import { BENCH_SIZE } from './rules';
import type { GameState } from './game';
import type { BenchEntry, OwnedUnit, Star, Tier } from './types';

// オペレーターの獲得（購入・特性による獲得・精鋭化報酬）と精鋭化の処理

export function withRng<T>(state: GameState, f: (rng: Rng) => T): T {
  const rng = new Rng(state.rngState);
  const r = f(rng);
  state.rngState = rng.state;
  return r;
}

export function allOwned(state: GameState): OwnedUnit[] {
  return [...state.board, ...benchUnits(state)];
}

/** 控えの上限を超えているか（超えたままでは戦闘を開始できない） */
export function benchOverflow(state: GameState): number {
  return Math.max(0, state.bench.filter((b) => b !== null).length - BENCH_SIZE);
}

/** 購入できるか：控えに空きがあるか、入れた瞬間に精鋭化できる */
export function canReceive(state: GameState, defId: string): boolean {
  if (state.bench.slice(0, BENCH_SIZE).includes(null) && benchOverflow(state) === 0) return true;
  const def = getUnit(defId);
  return allOwned(state).filter((o) => o.defId === defId && o.star === 1).length >= def.mergeCount - 1;
}

/**
 * 控えの並びを整える。上限を超えている間ははみ出したまま保持し（破棄しない）、
 * 上限以内に収まったら枠数を元に戻す
 */
export function compactBench(bench: BenchEntry[]): BenchEntry[] {
  if (bench.length <= BENCH_SIZE) return bench;
  const entries = bench.filter((b): b is NonNullable<BenchEntry> => b !== null);
  if (entries.length > BENCH_SIZE) return entries;
  const out: BenchEntry[] = bench.slice(0, BENCH_SIZE);
  for (const u of entries) if (!out.includes(u)) out[out.indexOf(null)] = u;
  return out;
}

/** 控えに入れる（上限を超えてもはみ出させて保持する） */
export function putOnBench(state: GameState, entry: NonNullable<BenchEntry>): void {
  const emptyIdx = state.bench.slice(0, BENCH_SIZE).indexOf(null);
  if (emptyIdx >= 0 && benchOverflow(state) === 0) state.bench[emptyIdx] = entry;
  else state.bench.push(entry);
}

/** 指定等級から3名を提示する（精鋭化の報酬・特別招集） */
export function rollChoices(state: GameState, tier: Tier): string[] {
  return withRng(state, (rng) => {
    const picked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const cands = UNITS.filter((u) => u.tier === tier && !picked.includes(u.id) && unitAvailable(state, u.id));
      const idx = rng.weighted(cands.map((c) => state.pool[c.id]));
      if (idx < 0) break;
      picked.push(cands[idx].id);
    }
    return picked;
  });
}

/** 同じオペレーターが必要枚数揃ったら精鋭化する。盤面にいる個体を優先して残す */
function mergeUnits(state: GameState, defId: string): void {
  const def = getUnit(defId);
  const same = allOwned(state).filter((o) => o.defId === defId && o.star === 1);
  if (same.length < def.mergeCount) return;
  const keep = same.find((o) => state.board.includes(o)) ?? same[0];
  const others = same.filter((o) => o !== keep);
  const toRemove = new Set(
    [...others.filter((o) => !state.board.includes(o)), ...others.filter((o) => state.board.includes(o))]
      .slice(0, def.mergeCount - 1)
      .map((o) => o.uid),
  );
  state.board = state.board.filter((o) => !toRemove.has(o.uid));
  state.bench = state.bench.map((b) => (b && toRemove.has(b.uid) ? null : b));
  keep.star = 2 as Star;
  state.log.push(`${def.name} を精鋭化！`);
  const tier = Math.min(state.level + 1, 6) as Tier;
  const options = rollChoices(state, tier);
  if (options.length) state.choices.push({ title: `${def.name}の精鋭化報酬`, options });
}

/**
 * オペレーターを獲得して控えに入れる。獲得時の特性を発動し、揃えば精鋭化する。
 * 控えがいっぱいでも破棄せず、はみ出させて保持する（はみ出している間は戦闘不可）
 */
export function gainUnit(state: GameState, defId: string): boolean {
  if (state.pool[defId] <= 0) return false;
  state.pool[defId]--;
  state.round_.gained++;
  const unit: OwnedUnit = { uid: state.nextUid++, defId, star: 1 };
  putOnBench(state, unit);
  triggerGarrisons(state, 'SERVER_GAIN', [{ unit, where: 'bench' }], gainTriggerTimes(state, currentActive(state)));
  itemOnGain(state);
  mergeUnits(state, defId);
  state.bench = compactBench(state.bench);
  return true;
}

/** 候補からランダムに1名を獲得（特性による獲得用） */
export function gainRandom(state: GameState, candidates: { id: string; weight: number }[], source: string): void {
  const avail = candidates.filter((c) => state.pool[c.id] > 0 && unitAvailable(state, c.id));
  const idx = withRng(state, (rng) => rng.weighted(avail.map((c) => c.weight)));
  if (idx < 0) return;
  const id = avail[idx].id;
  if (gainUnit(state, id)) state.log.push(`${source}：${getUnit(id).name} を獲得`);
}
