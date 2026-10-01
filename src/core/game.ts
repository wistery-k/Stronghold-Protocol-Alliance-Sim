import { ALLIANCES } from './data/alliances';
import { enemyForRound } from './data/enemies';
import { UNITS, getUnit } from './data/units';
import { evaluateAlliances, unitModifiers, type AllianceStatus } from './alliance';
import { Rng } from './rng';
import {
  BENCH_SIZE,
  LEVEL_UP_COST,
  MAX_LEVEL,
  MAX_ROUND,
  POOL_COPIES,
  REFRESH_COST,
  SHOP_SIZE,
  START_GOLD,
  START_LIFE,
  TIER_ODDS,
  baseIncome,
  copiesOfStar,
  deployCap,
  lifeLoss,
} from './rules';
import { simulateDps, type SimResult } from './sim';
import type { AllianceId, OwnedUnit, Star } from './types';

export type Phase = 'prep' | 'result' | 'gameover' | 'clear';

export interface Income {
  base: number;
  interest: number;
  win: number;
  alliance: number;
}

export interface BattleReport {
  round: number;
  sim: SimResult;
  lifeLost: number;
  income: Income;
  stacksGained: Partial<Record<AllianceId, number>>;
  alliances: AllianceStatus[];
}

export interface GameState {
  version: 1;
  seed: number;
  rngState: number;
  round: number;
  life: number;
  gold: number;
  level: number;
  shop: (string | null)[];
  frozen: boolean;
  bench: (OwnedUnit | null)[];
  board: OwnedUnit[];
  pool: Record<string, number>;
  stacks: Partial<Record<AllianceId, number>>;
  nextUid: number;
  phase: Phase;
  lastBattle: BattleReport | null;
  history: { round: number; killed: boolean; lifeLost: number }[];
  log: string[];
}

export type Action =
  | { type: 'buy'; slot: number }
  | { type: 'sell'; uid: number }
  | { type: 'deploy'; uid: number }
  | { type: 'undeploy'; uid: number }
  | { type: 'refresh' }
  | { type: 'levelUp' }
  | { type: 'toggleFreeze' }
  | { type: 'battle' }
  | { type: 'next' };

export interface ActionResult {
  state: GameState;
  error?: string;
}

// ------------------------------------------------------------
// 生成
// ------------------------------------------------------------

export function createGame(seed = Math.floor(Math.random() * 2 ** 31)): GameState {
  const pool: Record<string, number> = {};
  for (const u of UNITS) pool[u.id] = POOL_COPIES[u.tier];
  const state: GameState = {
    version: 1,
    seed,
    rngState: seed,
    round: 1,
    life: START_LIFE,
    gold: START_GOLD,
    level: 1,
    shop: Array(SHOP_SIZE).fill(null),
    frozen: false,
    bench: Array(BENCH_SIZE).fill(null),
    board: [],
    pool,
    stacks: {},
    nextUid: 1,
    phase: 'prep',
    lastBattle: null,
    history: [],
    log: [`シード ${seed} で開始`],
  };
  rollShop(state);
  return state;
}

// ------------------------------------------------------------
// 補助関数
// ------------------------------------------------------------

function withRng<T>(state: GameState, f: (rng: Rng) => T): T {
  const rng = new Rng(state.rngState);
  const r = f(rng);
  state.rngState = rng.state;
  return r;
}

export function rollShop(state: GameState): void {
  withRng(state, (rng) => {
    const odds = TIER_ODDS[state.level - 1];
    for (let i = 0; i < SHOP_SIZE; i++) {
      let tier = rng.weighted(odds) + 1;
      let picked: string | null = null;
      // 該当等級のプールが枯れていたら下の等級へ
      for (; tier >= 1 && !picked; tier--) {
        const cands = UNITS.filter((u) => u.tier === tier);
        const idx = rng.weighted(cands.map((c) => state.pool[c.id]));
        if (idx >= 0) picked = cands[idx].id;
      }
      state.shop[i] = picked;
    }
  });
}

export function allOwned(state: GameState): OwnedUnit[] {
  return [...state.board, ...state.bench.filter((b): b is OwnedUnit => b !== null)];
}

export function findOwned(state: GameState, uid: number): { unit: OwnedUnit; where: 'board' | 'bench'; index: number } | null {
  const bi = state.board.findIndex((o) => o.uid === uid);
  if (bi >= 0) return { unit: state.board[bi], where: 'board', index: bi };
  const ni = state.bench.findIndex((o) => o?.uid === uid);
  if (ni >= 0) return { unit: state.bench[ni]!, where: 'bench', index: ni };
  return null;
}

/** 同一オペレーター・同一段階が3体揃ったら昇進させる。盤面にいる個体を優先して残す */
function mergeUnits(state: GameState, defId: string): string[] {
  const msgs: string[] = [];
  for (let star = 1; star <= 2; star++) {
    const same = allOwned(state).filter((o) => o.defId === defId && o.star === star);
    if (same.length < 3) continue;
    const onBoard = same.filter((o) => state.board.includes(o));
    const onBench = state.bench
      .map((b, i) => ({ b, i }))
      .filter((x) => x.b && x.b.defId === defId && x.b.star === star);
    const keep = onBoard[0] ?? onBench[0].b!;
    // 消す2体は控えにいる個体を優先する
    const others = same.filter((o) => o !== keep);
    const toRemove = new Set(
      [...others.filter((o) => !state.board.includes(o)), ...others.filter((o) => state.board.includes(o))]
        .slice(0, 2)
        .map((o) => o.uid),
    );
    state.board = state.board.filter((o) => !toRemove.has(o.uid));
    state.bench = state.bench.map((b) => (b && toRemove.has(b.uid) ? null : b));
    keep.star = (star + 1) as Star;
    msgs.push(`${getUnit(defId).name} が昇進段階${keep.star}に昇進！`);
  }
  return msgs;
}

export function levelUpCost(level: number): number | null {
  return level >= MAX_LEVEL ? null : LEVEL_UP_COST[level - 1];
}

export function sellPrice(o: OwnedUnit): number {
  return getUnit(o.defId).tier * copiesOfStar(o.star);
}

// ------------------------------------------------------------
// アクション
// ------------------------------------------------------------

export function applyAction(prev: GameState, action: Action): ActionResult {
  const state = structuredClone(prev);
  const fail = (error: string): ActionResult => ({ state: prev, error });
  const inPrep = state.phase === 'prep';

  switch (action.type) {
    case 'buy': {
      if (!inPrep) return fail('準備フェーズではありません');
      const defId = state.shop[action.slot];
      if (!defId) return fail('その枠は空です');
      const def = getUnit(defId);
      if (state.gold < def.tier) return fail('資金が足りません');
      const emptyIdx = state.bench.indexOf(null);
      const canMerge = allOwned(state).filter((o) => o.defId === defId && o.star === 1).length >= 2;
      if (emptyIdx < 0 && !canMerge) return fail('控えがいっぱいです');
      state.gold -= def.tier;
      state.pool[defId]--;
      state.shop[action.slot] = null;
      const unit: OwnedUnit = { uid: state.nextUid++, defId, star: 1 };
      if (emptyIdx >= 0) state.bench[emptyIdx] = unit;
      else state.bench.push(unit); // 一時的にはみ出させ、直後の昇進で解消する
      state.log.push(`${def.name} を招集（-${def.tier}）`);
      state.log.push(...mergeUnits(state, defId));
      state.bench = compactBench(state.bench);
      return { state };
    }
    case 'sell': {
      if (!inPrep) return fail('準備フェーズではありません');
      const f = findOwned(state, action.uid);
      if (!f) return fail('ユニットが見つかりません');
      const price = sellPrice(f.unit);
      if (f.where === 'board') state.board.splice(f.index, 1);
      else state.bench[f.index] = null;
      state.gold += price;
      state.pool[f.unit.defId] += copiesOfStar(f.unit.star);
      state.log.push(`${getUnit(f.unit.defId).name} を売却（+${price}）`);
      return { state };
    }
    case 'deploy': {
      if (!inPrep) return fail('準備フェーズではありません');
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'bench') return fail('控えのユニットを選んでください');
      if (state.board.length >= deployCap(state.level)) return fail('配置上限に達しています');
      state.bench[f.index] = null;
      state.board.push(f.unit);
      return { state };
    }
    case 'undeploy': {
      if (!inPrep) return fail('準備フェーズではありません');
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'board') return fail('配置中のユニットを選んでください');
      const emptyIdx = state.bench.indexOf(null);
      if (emptyIdx < 0) return fail('控えがいっぱいです');
      state.board.splice(f.index, 1);
      state.bench[emptyIdx] = f.unit;
      return { state };
    }
    case 'refresh': {
      if (!inPrep) return fail('準備フェーズではありません');
      if (state.gold < REFRESH_COST) return fail('資金が足りません');
      state.gold -= REFRESH_COST;
      state.frozen = false;
      rollShop(state);
      return { state };
    }
    case 'levelUp': {
      if (!inPrep) return fail('準備フェーズではありません');
      const cost = levelUpCost(state.level);
      if (cost === null) return fail('管理レベルは最大です');
      if (state.gold < cost) return fail('資金が足りません');
      state.gold -= cost;
      state.level++;
      state.log.push(`管理レベル${state.level}に上昇（-${cost}）`);
      return { state };
    }
    case 'toggleFreeze': {
      if (!inPrep) return fail('準備フェーズではありません');
      state.frozen = !state.frozen;
      return { state };
    }
    case 'battle': {
      if (!inPrep) return fail('準備フェーズではありません');
      resolveBattle(state);
      return { state };
    }
    case 'next': {
      if (state.phase !== 'result') return fail('戦闘結果フェーズではありません');
      if (state.life <= 0) {
        state.phase = 'gameover';
      } else if (state.round >= MAX_ROUND) {
        state.phase = 'clear';
      } else {
        state.round++;
        state.phase = 'prep';
        if (!state.frozen) rollShop(state);
        state.frozen = false;
      }
      return { state };
    }
  }
}

function compactBench(bench: (OwnedUnit | null)[]): (OwnedUnit | null)[] {
  if (bench.length <= BENCH_SIZE) return bench;
  const units = bench.filter((b): b is OwnedUnit => b !== null);
  const out: (OwnedUnit | null)[] = bench.slice(0, BENCH_SIZE);
  // はみ出した個体が残っていたら空き枠へ
  for (const u of units) if (!out.includes(u)) out[out.indexOf(null)] = u;
  return out;
}

/** 盤面から戦闘入力を作る（UIのプレビューでも使う） */
export function buildSimInputs(board: OwnedUnit[], stacks: Partial<Record<AllianceId, number>>) {
  const statuses = evaluateAlliances(board);
  const mods = unitModifiers(board, statuses, stacks);
  return {
    statuses,
    inputs: board.map((o) => ({ uid: o.uid, def: getUnit(o.defId), star: o.star, mods: mods.get(o.uid) ?? {} })),
  };
}

function resolveBattle(state: GameState): void {
  // 加算数の獲得（戦闘開始時）
  const before = evaluateAlliances(state.board);
  const stacksGained: Partial<Record<AllianceId, number>> = {};
  for (const st of before) {
    if (st.level > 0 && ALLIANCES[st.id].gainsStacks) {
      stacksGained[st.id] = st.count;
      state.stacks[st.id] = (state.stacks[st.id] ?? 0) + st.count;
    }
  }

  const { statuses, inputs } = buildSimInputs(state.board, state.stacks);
  const enemy = enemyForRound(state.round);
  const sim = simulateDps(inputs, enemy);
  const lost = sim.killed ? 0 : lifeLoss(sim.remainingHp / enemy.hp, enemy.isBoss);
  state.life = Math.max(0, state.life - lost);

  const bi = baseIncome(state.gold, sim.killed);
  let allianceIncome = 0;
  for (const st of statuses) {
    const inc = ALLIANCES[st.id].incomeBonus;
    if (st.level > 0 && inc) allianceIncome += inc(st.level, state.stacks[st.id] ?? 0);
  }
  const income: Income = { ...bi, alliance: allianceIncome };
  state.gold += income.base + income.interest + income.win + income.alliance;

  state.lastBattle = { round: state.round, sim, lifeLost: lost, income, stacksGained, alliances: statuses };
  state.history.push({ round: state.round, killed: sim.killed, lifeLost: lost });
  state.log.push(
    sim.killed
      ? `ラウンド${state.round}：${enemy.name}を撃破（${sim.killTime}秒）`
      : `ラウンド${state.round}：${enemy.name}を倒しきれず、耐久値-${lost}`,
  );
  state.phase = 'result';
}
