import { enemyForRound } from './data/enemies';
import { UNITS, getUnit, unitState } from './data/units';
import { activeAllianceIds, battleSetup, evaluateAlliances, type AllianceStatus } from './alliance';
import {
  addStacks,
  allTargets,
  benchUnits,
  currentActive,
  deputBonus,
  gainTriggerTimes,
  onDeployStacks,
  stackRewards,
  triggerGarrisons,
} from './garrison';
import { miraProb } from './data/alliances';
import { Rng } from './rng';
import {
  BENCH_SIZE,
  MAX_ROUND,
  POOL_COPIES,
  REFRESH_COST,
  START_LIFE,
  TIER_ODDS,
  baseLevelUpCost,
  buyPrice,
  deployCap,
  lifeLoss,
  roundIncome,
  sellPriceOf,
  shopSlots,
} from './rules';
import { simulateDps, type SimResult } from './sim';
import type { AllianceId, OwnedUnit, Star } from './types';

export type Phase = 'prep' | 'result' | 'gameover' | 'clear';

export interface BattleReport {
  round: number;
  sim: SimResult;
  lifeLost: number;
  /** この戦闘（準備フェーズ終了時〜戦闘中）で増えた加算数 */
  stacksGained: Partial<Record<AllianceId, number>>;
  alliances: AllianceStatus[];
  /** 次ラウンド開始時に得る資金 */
  nextIncome: { base: number; extra: number } | null;
}

export interface GameState {
  version: 2;
  seed: number;
  rngState: number;
  round: number;
  life: number;
  gold: number;
  level: number;
  /** 管理レベルを上げてから経過したラウンド数（レベルアップ価格の割引） */
  levelDiscount: number;
  shop: (string | null)[];
  frozen: boolean;
  bench: (OwnedUnit | null)[];
  board: OwnedUnit[];
  pool: Record<string, number>;
  stacks: Partial<Record<AllianceId, number>>;
  freeRefreshes: number;
  /** 【奇跡】で次の更新が無料 */
  nextRefreshFree: boolean;
  /** 次の準備フェーズで得る追加資金 */
  pendingGold: number;
  /** このラウンドの集計（特性の計算に使う） */
  round_: { gained: number; spent: number; refreshes: number };
  rewards: { visiTens: number; miraHundreds: number; visiDiscount: boolean; allDiscount: boolean };
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
    version: 2,
    seed,
    rngState: seed,
    round: 1,
    life: START_LIFE,
    gold: roundIncome(1),
    level: 1,
    levelDiscount: 0,
    shop: [],
    frozen: false,
    bench: Array(BENCH_SIZE).fill(null),
    board: [],
    pool,
    stacks: {},
    freeRefreshes: 0,
    nextRefreshFree: false,
    pendingGold: 0,
    round_: { gained: 0, spent: 0, refreshes: 0 },
    rewards: { visiTens: 0, miraHundreds: 0, visiDiscount: false, allDiscount: false },
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
    const shop: (string | null)[] = [];
    for (let i = 0; i < shopSlots(state.level); i++) {
      let tier = rng.weighted(odds) + 1;
      let picked: string | null = null;
      for (; tier >= 1 && !picked; tier--) {
        const cands = UNITS.filter((u) => u.tier === tier);
        const idx = rng.weighted(cands.map((c) => state.pool[c.id]));
        if (idx >= 0) picked = cands[idx].id;
      }
      shop.push(picked);
    }
    state.shop = shop;
  });
}

export function allOwned(state: GameState): OwnedUnit[] {
  return [...state.board, ...benchUnits(state)];
}

export function findOwned(state: GameState, uid: number): { unit: OwnedUnit; where: 'board' | 'bench'; index: number } | null {
  const bi = state.board.findIndex((o) => o.uid === uid);
  if (bi >= 0) return { unit: state.board[bi], where: 'board', index: bi };
  const ni = state.bench.findIndex((o) => o?.uid === uid);
  if (ni >= 0) return { unit: state.bench[ni]!, where: 'bench', index: ni };
  return null;
}

/** 同じオペレーターが必要枚数揃ったら昇進させる。盤面にいる個体を優先して残す */
function mergeUnits(state: GameState, defId: string): string[] {
  const def = getUnit(defId);
  const same = allOwned(state).filter((o) => o.defId === defId && o.star === 1);
  if (same.length < def.mergeCount) return [];
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
  return [`${def.name} が昇進！`];
}

export function levelUpCost(state: Pick<GameState, 'level' | 'levelDiscount'>): number | null {
  const base = baseLevelUpCost(state.level);
  return base === null ? null : Math.max(0, base - state.levelDiscount);
}

/** 購入価格（先見の割引・特性による価格固定を含む） */
export function priceOf(state: GameState, defId: string): number {
  const def = getUnit(defId);
  const fixed = def.normal.garrisons.find((g) => g.effect === 'SERVER_CHESS_PRICE');
  let price = fixed ? Number(fixed.blackboard.price) : buyPrice(def.tier);
  if (state.rewards.allDiscount) price -= 1;
  else if (state.rewards.visiDiscount && def.bonds.includes('visi')) price -= 1;
  return Math.max(0, price);
}

export function sellPrice(o: OwnedUnit): number {
  return sellPriceOf(getUnit(o.defId).tier);
}

function spend(state: GameState, amount: number) {
  state.gold -= amount;
  state.round_.spent += amount;
}

// ------------------------------------------------------------
// アクション
// ------------------------------------------------------------

export function applyAction(prev: GameState, action: Action): ActionResult {
  const state = structuredClone(prev);
  const fail = (error: string): ActionResult => ({ state: prev, error });
  const inPrep = state.phase === 'prep';
  if (!inPrep && action.type !== 'next') return fail('準備フェーズではありません');

  switch (action.type) {
    case 'buy': {
      const defId = state.shop[action.slot];
      if (!defId) return fail('その枠は空です');
      const def = getUnit(defId);
      const price = priceOf(state, defId);
      if (state.gold < price) return fail('資金が足りません');
      const emptyIdx = state.bench.indexOf(null);
      const canMerge = allOwned(state).filter((o) => o.defId === defId && o.star === 1).length >= def.mergeCount - 1;
      if (emptyIdx < 0 && !canMerge) return fail('控えがいっぱいです');
      spend(state, price);
      state.pool[defId]--;
      state.shop[action.slot] = null;
      state.round_.gained++;
      const unit: OwnedUnit = { uid: state.nextUid++, defId, star: 1 };
      if (emptyIdx >= 0) state.bench[emptyIdx] = unit;
      else state.bench.push(unit); // 一時的にはみ出させ、直後の昇進で解消する
      state.log.push(`${def.name} を招集（-${price}）`);
      triggerGarrisons(state, 'SERVER_GAIN', [{ unit, where: 'bench' }], gainTriggerTimes(state, currentActive(state)));
      state.log.push(...mergeUnits(state, defId));
      state.bench = compactBench(state.bench);
      return { state };
    }
    case 'sell': {
      const f = findOwned(state, action.uid);
      if (!f) return fail('ユニットが見つかりません');
      const def = getUnit(f.unit.defId);
      triggerGarrisons(state, 'SERVER_CHESS_SOLD', [{ unit: f.unit, where: f.where }]);
      if (f.where === 'board') state.board.splice(f.index, 1);
      else state.bench[f.index] = null;
      const price = sellPrice(f.unit);
      state.gold += price;
      state.pool[f.unit.defId] += f.unit.star === 2 ? def.mergeCount : 1;
      state.log.push(`${def.name} を売却（+${price}）`);
      return { state };
    }
    case 'deploy': {
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'bench') return fail('控えのユニットを選んでください');
      if (state.board.length >= deployCap(state.level)) return fail('配置上限に達しています');
      state.bench[f.index] = null;
      state.board.push(f.unit);
      return { state };
    }
    case 'undeploy': {
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'board') return fail('配置中のユニットを選んでください');
      const emptyIdx = state.bench.indexOf(null);
      if (emptyIdx < 0) return fail('控えがいっぱいです');
      state.board.splice(f.index, 1);
      state.bench[emptyIdx] = f.unit;
      return { state };
    }
    case 'refresh': {
      let label: string;
      if (state.freeRefreshes > 0) {
        state.freeRefreshes--;
        label = '無料更新';
      } else if (state.nextRefreshFree) {
        state.nextRefreshFree = false;
        label = '【奇跡】で無料更新';
      } else {
        if (state.gold < REFRESH_COST) return fail('資金が足りません');
        spend(state, REFRESH_COST);
        label = `更新（-${REFRESH_COST}）`;
      }
      state.frozen = false;
      state.round_.refreshes++;
      rollShop(state);
      state.log.push(label);
      const active = currentActive(state);
      if (active.has('mira')) {
        const free = withRng(state, (rng) => rng.next() < miraProb(state.stacks.mira ?? 0));
        if (free) {
          state.nextRefreshFree = true;
          state.log.push('【奇跡】次の更新が無料に！');
        }
      }
      triggerGarrisons(state, 'SERVER_REFRESH_SHOP', allTargets(state));
      return { state };
    }
    case 'levelUp': {
      const cost = levelUpCost(state);
      if (cost === null) return fail('管理レベルは最大です');
      if (state.gold < cost) return fail('資金が足りません');
      spend(state, cost);
      state.level++;
      state.levelDiscount = 0;
      state.log.push(`管理レベル${state.level}に上昇（-${cost}）`);
      return { state };
    }
    case 'toggleFreeze': {
      state.frozen = !state.frozen;
      return { state };
    }
    case 'battle': {
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
        startRound(state, state.round + 1);
      }
      return { state };
    }
  }
}

function startRound(state: GameState, round: number): void {
  state.round = round;
  state.phase = 'prep';
  const income = roundIncome(round);
  state.gold += income + state.pendingGold;
  if (state.pendingGold) state.log.push(`追加資金+${state.pendingGold}`);
  state.pendingGold = 0;
  state.round_ = { gained: 0, spent: 0, refreshes: 0 };
  state.levelDiscount++;
  if (!state.frozen) rollShop(state);
  state.frozen = false;
  triggerGarrisons(state, 'SERVER_PREP_START', allTargets(state));
  stackRewards(state, currentActive(state));
}

function compactBench(bench: (OwnedUnit | null)[]): (OwnedUnit | null)[] {
  if (bench.length <= BENCH_SIZE) return bench;
  const units = bench.filter((b): b is OwnedUnit => b !== null);
  const out: (OwnedUnit | null)[] = bench.slice(0, BENCH_SIZE);
  for (const u of units) if (!out.includes(u)) out[out.indexOf(null)] = u;
  return out;
}

/** 盤面から戦闘入力を作る（UIの予測でも使う） */
export function buildSimInputs(board: OwnedUnit[], bench: OwnedUnit[], stacks: Partial<Record<AllianceId, number>>) {
  const setup = battleSetup(board, bench, stacks);
  return {
    ...setup,
    inputs: board.map((o) => ({ uid: o.uid, def: getUnit(o.defId), star: o.star, mods: setup.mods.get(o.uid) ?? {} })),
  };
}

/** 戦闘を行うと準備フェーズ終了時〜配置時に加算数がどうなるかを、状態を変えずに求める */
export function previewBattleStacks(state: GameState): Partial<Record<AllianceId, number>> {
  const s = structuredClone(state);
  s.log = [];
  prepFinish(s);
  return s.stacks;
}

function prepFinish(state: GameState): void {
  triggerGarrisons(state, 'SERVER_PREP_FIN', allTargets(state));
  deputBonus(state);
  onDeployStacks(state);
}

function resolveBattle(state: GameState): void {
  const before = { ...state.stacks };
  prepFinish(state);

  const bench = benchUnits(state);
  const { statuses, inputs, globals } = buildSimInputs(state.board, bench, state.stacks);
  const enemy = enemyForRound(state.round);
  const sim = simulateDps(inputs, enemy, { globals, activeAlliances: activeAllianceIds(statuses), stacks: state.stacks });
  const active = activeAllianceIds(evaluateAlliances(state.board, bench));
  for (const [b, n] of Object.entries(sim.stackGains) as [AllianceId, number][]) addStacks(state, b, n, active);

  const lost = sim.killed ? 0 : lifeLoss(sim.remainingHp / enemy.hp, enemy.isBoss);
  state.life = Math.max(0, state.life - lost);

  const stacksGained: Partial<Record<AllianceId, number>> = {};
  for (const [b, n] of Object.entries(state.stacks) as [AllianceId, number][]) {
    const d = n - (before[b] ?? 0);
    if (d > 0) stacksGained[b] = d;
  }

  const last = state.life <= 0 || state.round >= MAX_ROUND;
  state.lastBattle = {
    round: state.round,
    sim,
    lifeLost: lost,
    stacksGained,
    alliances: statuses,
    nextIncome: last ? null : { base: roundIncome(state.round + 1), extra: state.pendingGold },
  };
  state.history.push({ round: state.round, killed: sim.killed, lifeLost: lost });
  state.log.push(
    sim.killed
      ? `ラウンド${state.round}：${enemy.name}を撃破（${sim.killTime}秒）`
      : `ラウンド${state.round}：${enemy.name}を倒しきれず、耐久値-${lost}`,
  );
  state.phase = 'result';
}

/** 予測などUIで使う、ユニットのスキル・特性 */
export function ownedState(o: OwnedUnit) {
  return unitState(getUnit(o.defId), o.star);
}
