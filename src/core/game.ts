import { enemyForRound } from './data/enemies';
import { UNITS, getUnit, unitState } from './data/units';
import { activeAllianceIds, battleSetup, evaluateAlliances, type AllianceStatus } from './alliance';
import {
  addStacks,
  allTargets,
  benchUnits,
  currentActive,
  deputBonus,
  onDeployStacks,
  stackRewards,
  triggerGarrisons,
} from './garrison';
import { miraProb } from './data/alliances';
import { allOwned, benchOverflow, canReceive, compactBench, gainUnit, withRng } from './acquire';
import { firstFreeCell, normalizePositions, unitAt } from './board';
import {
  BENCH_SIZE,
  CHOICE_LOCK_MESSAGE,
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
import type { AllianceId, Direction, OwnedUnit } from './types';

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
  version: 4;
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
  /** 無料で1名を選べる候補（精鋭化の報酬・特別招集）。先頭から順に選ぶ */
  choices: { title: string; options: string[] }[];
  nextUid: number;
  phase: Phase;
  lastBattle: BattleReport | null;
  history: { round: number; killed: boolean; lifeLost: number }[];
  log: string[];
}

export type Action =
  | { type: 'buy'; slot: number }
  | { type: 'sell'; uid: number }
  | { type: 'deploy'; uid: number; pos?: number }
  | { type: 'undeploy'; uid: number }
  | { type: 'move'; uid: number; to: { zone: 'board'; pos: number } | { zone: 'bench'; index: number } }
  | { type: 'turn'; uid: number; dir: Direction }
  | { type: 'choose'; index: number }
  | { type: 'skipChoice' }
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
    version: 4,
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
    choices: [],
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

export function findOwned(state: GameState, uid: number): { unit: OwnedUnit; where: 'board' | 'bench'; index: number } | null {
  const bi = state.board.findIndex((o) => o.uid === uid);
  if (bi >= 0) return { unit: state.board[bi], where: 'board', index: bi };
  const ni = state.bench.findIndex((o) => o?.uid === uid);
  if (ni >= 0) return { unit: state.bench[ni]!, where: 'bench', index: ni };
  return null;
}

export function levelUpCost(state: Pick<GameState, 'level' | 'levelDiscount'>): number | null {
  const base = baseLevelUpCost(state.level);
  return base === null ? null : Math.max(0, base - state.levelDiscount);
}

/** 購入価格（先見の割引・特性による価格固定を含む） */
export function priceOf(state: GameState, defId: string): number {
  const def = getUnit(defId);
  // 「購入価格が◯になる」特性：データ上は値下げ幅として持っている
  const discount = def.normal.garrisons.find((g) => g.effect === 'SERVER_CHESS_PRICE');
  let price = buyPrice(def.tier) - (discount ? Number(discount.blackboard.price) : 0);
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
  const r = applyActionInner(prev, action);
  if (!r.error) r.state.bench = compactBench(r.state.bench);
  return r;
}

function applyActionInner(prev: GameState, action: Action): ActionResult {
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
      if (!canReceive(state, defId)) return fail('控えがいっぱいです');
      spend(state, price);
      state.shop[action.slot] = null;
      state.log.push(`${def.name} を招集（-${price}）`);
      gainUnit(state, defId);
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
      const pos = action.pos ?? firstFreeCell(state.board);
      if (pos === null || unitAt(state.board, pos)) return fail('そのマスには配置できません');
      state.bench[f.index] = null;
      f.unit.pos = pos;
      state.board.push(f.unit);
      return { state };
    }
    case 'undeploy': {
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'board') return fail('配置中のユニットを選んでください');
      const emptyIdx = state.bench.indexOf(null);
      if (emptyIdx < 0) return fail('控えがいっぱいです');
      state.board.splice(f.index, 1);
      delete f.unit.pos;
      state.bench[emptyIdx] = f.unit;
      return { state };
    }
    case 'move': {
      const f = findOwned(state, action.uid);
      if (!f) return fail('ユニットが見つかりません');
      moveUnit(state, f, action.to);
      if (state.board.length > deployCap(state.level)) return fail('配置上限に達しています');
      return { state };
    }
    case 'choose': {
      const choice = state.choices[0];
      const defId = choice?.options[action.index];
      if (!defId) return fail('選択肢がありません');
      state.choices.shift();
      gainUnit(state, defId);
      state.log.push(`${choice.title}：${getUnit(defId).name} を獲得`);
      state.bench = compactBench(state.bench);
      return { state };
    }
    case 'skipChoice': {
      if (!state.choices.length) return fail('選択肢がありません');
      state.choices.shift();
      return { state };
    }
    case 'turn': {
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'board') return fail('配置中のユニットを選んでください');
      f.unit.dir = action.dir;
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
      if (state.choices.length) return fail(CHOICE_LOCK_MESSAGE);
      if (benchOverflow(state) > 0) return fail(`控えが上限を${benchOverflow(state)}名超えています。配置するか売却してください`);
      normalizePositions(state.board);
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

/** ユニットを盤面のマス・控えの枠へ移動する。移動先にユニットがいれば入れ替える */
function moveUnit(
  state: GameState,
  from: { unit: OwnedUnit; where: 'board' | 'bench'; index: number },
  to: { zone: 'board'; pos: number } | { zone: 'bench'; index: number },
): void {
  const u = from.unit;
  if (to.zone === 'board') {
    const other = unitAt(state.board, to.pos);
    if (other === u) return;
    if (from.where === 'board') {
      if (other) other.pos = u.pos;
      u.pos = to.pos;
    } else {
      state.bench[from.index] = null;
      if (other) {
        state.board = state.board.filter((o) => o !== other);
        delete other.pos;
        state.bench[from.index] = other;
      }
      u.pos = to.pos;
      state.board.push(u);
    }
  } else {
    const other = state.bench[to.index];
    if (other === u) return;
    if (from.where === 'bench') {
      state.bench[from.index] = other;
      state.bench[to.index] = u;
    } else {
      state.board = state.board.filter((o) => o !== u);
      if (other) {
        other.pos = u.pos;
        state.board.push(other);
      }
      delete u.pos;
      state.bench[to.index] = u;
    }
  }
}

/** 盤面から戦闘入力を作る（UIの予測でも使う） */
export function buildSimInputs(board: OwnedUnit[], bench: OwnedUnit[], stacks: Partial<Record<AllianceId, number>>) {
  normalizePositions(board);
  const setup = battleSetup(board, bench, stacks);
  return {
    ...setup,
    inputs: board
      .filter((o) => !setup.excluded.has(o.uid))
      .map((o) => ({
        uid: o.uid,
        def: getUnit(o.defId),
        star: o.star,
        mods: setup.mods.get(o.uid) ?? {},
        garrisons: setup.garrisons.get(o.uid),
        rowCount: setup.rowCount.get(o.uid),
        bonusGain: setup.bonusGain.get(o.uid),
      })),
  };
}

/** 戦闘を行うと準備フェーズ終了時〜配置時に加算数がどうなるかを、状態を変えずに求める */
export { allOwned };

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
