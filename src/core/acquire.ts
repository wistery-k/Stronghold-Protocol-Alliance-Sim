import { UNITS, getUnit } from './data/units';
import { benchUnits, currentActive, gainTriggerTimes, triggerGarrisons } from './garrison';
import { Rng } from './rng';
import { BENCH_SIZE } from './rules';
import type { GameState } from './game';
import type { OwnedUnit, Star, Tier } from './types';

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

/** 控えに空きがあるか、入れた瞬間に精鋭化できるなら獲得できる */
export function canReceive(state: GameState, defId: string): boolean {
  if (state.bench.includes(null)) return true;
  const def = getUnit(defId);
  return allOwned(state).filter((o) => o.defId === defId && o.star === 1).length >= def.mergeCount - 1;
}

function compactBench(bench: (OwnedUnit | null)[]): (OwnedUnit | null)[] {
  if (bench.length <= BENCH_SIZE) return bench;
  const units = bench.filter((b): b is OwnedUnit => b !== null);
  const out: (OwnedUnit | null)[] = bench.slice(0, BENCH_SIZE);
  for (const u of units) if (!out.includes(u)) out[out.indexOf(null)] = u;
  return out;
}

/** 精鋭化の報酬：管理レベル+1の等級から3名を提示 */
export function rollEliteChoices(state: GameState): string[] {
  const tier = Math.min(state.level + 1, 6) as Tier;
  return withRng(state, (rng) => {
    const picked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const cands = UNITS.filter((u) => u.tier === tier && !picked.includes(u.id));
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
  const choices = rollEliteChoices(state);
  if (choices.length) state.eliteChoices.push(choices);
}

/**
 * オペレーターを獲得して控えに入れる。獲得時の特性を発動し、揃えば精鋭化する。
 * 控えがいっぱいで精鋭化もできないなら false
 */
export function gainUnit(state: GameState, defId: string): boolean {
  if (!canReceive(state, defId) || state.pool[defId] <= 0) return false;
  state.pool[defId]--;
  state.round_.gained++;
  const unit: OwnedUnit = { uid: state.nextUid++, defId, star: 1 };
  const emptyIdx = state.bench.indexOf(null);
  if (emptyIdx >= 0) state.bench[emptyIdx] = unit;
  else state.bench.push(unit); // 一時的にはみ出させ、直後の精鋭化で解消する
  triggerGarrisons(state, 'SERVER_GAIN', [{ unit, where: 'bench' }], gainTriggerTimes(state, currentActive(state)));
  mergeUnits(state, defId);
  state.bench = compactBench(state.bench);
  return true;
}

/** 候補からランダムに1名を獲得（特性による獲得用） */
export function gainRandom(state: GameState, candidates: { id: string; weight: number }[], source: string): void {
  const avail = candidates.filter((c) => state.pool[c.id] > 0);
  const idx = withRng(state, (rng) => rng.weighted(avail.map((c) => c.weight)));
  if (idx < 0) return;
  const id = avail[idx].id;
  if (gainUnit(state, id)) state.log.push(`${source}：${getUnit(id).name} を獲得`);
  else state.log.push(`${source}：控えがいっぱいで獲得できませんでした`);
}
