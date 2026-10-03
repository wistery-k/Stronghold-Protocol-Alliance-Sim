import { Rng } from './rng';
import { notify, trimLog } from './log';
import {
  BOUNTIES,
  BOUNTY_OFFER_ROUND,
  ENEMIES,
  getBounty,
  pickGroupTypes,
  pickRoundGroup,
  roundSpec,
  withBounty,
  type EnemyGroupType,
  type RoundGroup,
  type RoundSpec,
} from './data/battle';
import { getBand, type BandId } from './data/bands';
import {
  bandAfterRefresh,
  bandIncome,
  bandKeepsGold,
  bandOnBuy,
  bandOnLevelUp,
  bandOnSell,
  bandOnSpend,
  bandPrepFinish,
  bandPrice,
  bandRoundStart,
  newBandState,
  type BandState,
} from './band';
import { UNITS, getUnit, unitState } from './data/units';
import { activeAllianceIds, battleSetup, evaluateAlliances, type AllianceStatus, type BattleOptions } from './alliance';
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
import { allOwned, benchOverflow, canReceive, compactBench, gainUnit, putOnBench, withRng } from './acquire';
import {
  ITEM_SELL_PRICE,
  gainItem,
  equipItem,
  itemBattleEnd,
  itemOnSold,
  itemRoundStart,
  returnItems,
  rollItemShop,
  storedItems,
  unitAvailable,
} from './items';
import { getItem, itemState } from './data/items';
import { ALLIANCES, ALLIANCE_IDS, CORE_IDS } from './data/alliances';
import { RANDOM_MAPS, autoCell, bestDirection, canPlace, normalizePositions, setActiveMap, unitAt } from './board';
import {
  BENCH_SIZE,
  CHOICE_LOCK_MESSAGE,
  MAX_ROUND,
  NO_BATTLE_STACKS_FROM_ROUND,
  POOL_COPIES,
  REFRESH_COST,
  START_LIFE,
  TIER_ODDS,
  baseLevelUpCost,
  buyPrice,
  DEPLOY_CAP,
  MAX_LIFE_LOSS,
  sellPriceOf,
  shopSlots,
} from './rules';
import { simulateBattle, type BattleResult } from './sim';
import { isItemEntry, isUnitEntry, type AllianceId, type BenchEntry, type Direction, type OwnedItem, type OwnedUnit, type Star } from './types';

export type Phase = 'prep' | 'result' | 'gameover' | 'clear';

export interface BattleReport {
  round: number;
  /** このラウンドの敵グループ */
  group: RoundGroup;
  sim: BattleResult;
  /** 戦闘時の配置（リプレイ表示用） */
  units: { uid: number; defId: string; star: Star; pos?: number; dir?: Direction }[];
  lifeLost: number;
  /** この戦闘（準備フェーズ終了時〜戦闘中）で増えた加算数 */
  stacksGained: Partial<Record<AllianceId, number>>;
  /** 戦闘前（準備フェーズ終了前）の加算数 */
  stacksBefore: Partial<Record<AllianceId, number>>;
  /** 準備フェーズ終了時〜配置時に増えた分と、戦闘中に増えた分 */
  stacksFromPrep: Partial<Record<AllianceId, number>>;
  stacksFromBattle: Partial<Record<AllianceId, number>>;
  alliances: AllianceStatus[];
  /** 次ラウンド開始時に得る資金 */
  nextIncome: { base: number; extra: number } | null;
}

export interface GameState {
  version: 9;
  /** 選んだ戦術（null = なし） */
  band: BandId | null;
  /** マップ（ゲーム開始時に抽選。古いセーブデータには無い） */
  mapId?: string;
  /** 戦闘前の状態（戦闘結果の画面から戻すため。次のラウンドへ進むと消える） */
  preBattle?: GameState | null;
  /** 戦闘前に戻したラウンドの戦闘結果（新しい順。比較用） */
  undoneBattles?: BattleReport[];
  bandState: BandState;
  /** 懸賞：提示中の候補と、選んだ懸賞（3〜4ラウンドに出現） */
  bounty: { offer: string[] | null; picked: string | null };
  seed: number;
  rngState: number;
  round: number;
  life: number;
  gold: number;
  level: number;
  /** 管理レベルを上げてから経過したラウンド数（レベルアップ価格の割引） */
  levelDiscount: number;
  shop: (string | null)[];
  /** ショップの装備枠 */
  itemShop: string | null;
  frozen: boolean;
  /** 盟約BANされた盟約 */
  banned: AllianceId[];
  /** ゲーム開始時に抽選された特殊敵の種類（主力部隊は常に出る） */
  enemyTypes: EnemyGroupType[];
  /** ラウンド開始時の追加資金（倹約家の人形） */
  extraRoundGold: number;
  /** 最大配置人数の上書き（人事部の書類） */
  deployCapOverride: number | null;
  /** 売却したオペレーターの累計（商業パッケージ案） */
  soldCount: number;
  /** 控え：オペレーターと装備を一緒に保管する（上限を超えても保持し、超過中は戦闘不可） */
  bench: BenchEntry[];
  board: OwnedUnit[];
  pool: Record<string, number>;
  stacks: Partial<Record<AllianceId, number>>;
  freeRefreshes: number;
  /** 【奇跡】で次の更新が無料 */
  nextRefreshFree: boolean;
  /** 次の準備フェーズで得る追加資金 */
  pendingGold: number;
  /** このラウンドの集計（特性の計算に使う） */
  round_: { gained: number; spent: number; refreshes: number; cauldron: number };
  rewards: { visiTens: number; miraHundreds: number; visiDiscount: boolean; allDiscount: boolean; victoriaQuarters: number };
  /** 無料で1名を選べる候補（精鋭化の報酬・特別招集）。先頭から順に選ぶ */
  choices: { title: string; options: string[] }[];
  nextUid: number;
  phase: Phase;
  lastBattle: BattleReport | null;
  history: { round: number; killed: boolean; lifeLost: number }[];
  log: string[];
  /** プレイヤーに見せる出来事（特性の発動・資金の増減・精鋭化など） */
  events?: { round: number; text: string }[];
}

export type Action =
  | { type: 'buy'; slot: number }
  | { type: 'buyItem' }
  | { type: 'sellItem'; uid: number }
  | { type: 'equip'; itemUid: number; unitUid: number; discard?: number }
  | { type: 'moveItem'; uid: number; index: number }
  | { type: 'sell'; uid: number }
  | { type: 'deploy'; uid: number; pos?: number }
  | { type: 'undeploy'; uid: number }
  | { type: 'move'; uid: number; to: { zone: 'board'; pos: number } | { zone: 'bench'; index: number } }
  | { type: 'turn'; uid: number; dir: Direction }
  | { type: 'choose'; index: number }
  | { type: 'skipChoice' }
  | { type: 'pickBounty'; index: number }
  | { type: 'undoBattle' }
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

export interface GameOptions {
  /** 盟約BAN：'random' = 核心盟約3つ・追加盟約4つをランダムに、'none' = なし */
  ban?: 'random' | 'none';
  /** 戦術 */
  band?: BandId | null;
  /** マップ（省略時は抽選） */
  mapId?: string;
}

/** ラウンドの敵グループ（シードとラウンドで決まる） */
export function roundGroupOf(state: Pick<GameState, 'seed' | 'enemyTypes'>, round: number): RoundGroup {
  return pickRoundGroup(state.seed, round, state.enemyTypes);
}

/** ラウンドの敵の出現（敵グループを反映） */
export function roundSpecOf(state: Pick<GameState, 'seed' | 'enemyTypes'> & { bounty?: GameState['bounty'] }, round: number): RoundSpec {
  return withBounty(roundSpec(round, roundGroupOf(state, round)), getBounty(state.bounty?.picked));
}

export const BAN_CORE_COUNT = 3;
export const BAN_EXTRA_COUNT = 4;
/** BANの対象にならない追加盟約（本家データで出現の重みが0のもの） */
const BAN_EXEMPT: AllianceId[] = ['invest', 'mani', 'empty', 'sunt'];

export function createGame(seed = Math.floor(Math.random() * 2 ** 31), opts: GameOptions = {}): GameState {
  const pool: Record<string, number> = {};
  for (const u of UNITS) pool[u.id] = POOL_COPIES[u.tier];
  const band = opts.band ?? null;
  // マップはショップとは別系統の乱数で抽選する
  const mapId = opts.mapId ?? RANDOM_MAPS[new Rng(seed ^ 0x3a9b1c55).int(RANDOM_MAPS.length)].id;
  setActiveMap(mapId);
  const state: GameState = {
    mapId,
    version: 9,
    band,
    bandState: newBandState(),
    bounty: { offer: null, picked: null },
    seed,
    rngState: seed,
    round: 1,
    life: getBand(band)?.life ?? START_LIFE,
    gold: bandIncome({ band }, 1),
    level: 1,
    levelDiscount: 0,
    shop: [],
    itemShop: null,
    frozen: false,
    banned: [],
    // ショップの乱数とは別系統で抽選する（同じシードならショップは変わらない）
    enemyTypes: pickGroupTypes(new Rng(seed ^ 0x5eed5eed)),
    extraRoundGold: 0,
    deployCapOverride: null,
    soldCount: 0,
    bench: Array(BENCH_SIZE).fill(null),
    board: [],
    pool,
    stacks: {},
    freeRefreshes: 0,
    nextRefreshFree: false,
    pendingGold: 0,
    round_: { gained: 0, spent: 0, refreshes: 0, cauldron: 0 },
    rewards: { visiTens: 0, miraHundreds: 0, visiDiscount: false, allDiscount: false, victoriaQuarters: 0 },
    choices: [],
    nextUid: 1,
    phase: 'prep',
    lastBattle: null,
    history: [],
    log: [`シード ${seed} で開始`],
    events: [],
  };
  if ((opts.ban ?? 'random') === 'random') {
    state.banned = withRng(state, (rng) => {
      const pick = (cands: AllianceId[], n: number) => {
        const out: AllianceId[] = [];
        while (out.length < n && cands.length) out.push(cands.splice(rng.int(cands.length), 1)[0]);
        return out;
      };
      const extras = ALLIANCE_IDS.filter((id) => !CORE_IDS.includes(id as never) && !BAN_EXEMPT.includes(id));
      return [...pick([...CORE_IDS], BAN_CORE_COUNT), ...pick(extras, BAN_EXTRA_COUNT)];
    });
  }
  rollShop(state);
  bandRoundStart(state);
  return state;
}

// ------------------------------------------------------------
// 補助関数
// ------------------------------------------------------------

/**
 * ショップを更新する。refillOnly のときは（凍結中のラウンド開始時）、
 * 売れ残っている枠はそのままにして、購入済みの空き枠だけを補充する
 */
export function rollShop(state: GameState, refillOnly = false): void {
  withRng(state, (rng) => {
    const odds = TIER_ODDS[state.level - 1];
    const shop: (string | null)[] = [];
    for (let i = 0; i < shopSlots(state.level); i++) {
      if (refillOnly && state.shop[i]) {
        shop.push(state.shop[i]);
        continue;
      }
      let tier = rng.weighted(odds) + 1;
      let picked: string | null = null;
      for (; tier >= 1 && !picked; tier--) {
        const cands = UNITS.filter((u) => u.tier === tier && unitAvailable(state, u.id));
        const idx = rng.weighted(cands.map((c) => state.pool[c.id]));
        if (idx >= 0) picked = cands[idx].id;
      }
      shop.push(picked);
    }
    state.shop = shop;
  });
  if (!refillOnly || !state.itemShop) rollItemShop(state);
}

export function findOwned(state: GameState, uid: number): { unit: OwnedUnit; where: 'board' | 'bench'; index: number } | null {
  const bi = state.board.findIndex((o) => o.uid === uid);
  if (bi >= 0) return { unit: state.board[bi], where: 'board', index: bi };
  const ni = state.bench.findIndex((o) => isUnitEntry(o) && o.uid === uid);
  if (ni >= 0) return { unit: state.bench[ni] as OwnedUnit, where: 'bench', index: ni };
  return null;
}

export function deployCapOf(state: Pick<GameState, 'deployCapOverride'>): number {
  return state.deployCapOverride ?? DEPLOY_CAP;
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
  return bandPrice(state, defId, Math.max(0, price));
}

export function sellPrice(o: OwnedUnit): number {
  return sellPriceOf(getUnit(o.defId).tier);
}

function spend(state: GameState, amount: number) {
  state.gold -= amount;
  state.round_.spent += amount;
  bandOnSpend(state, amount);
}

// ------------------------------------------------------------
// アクション
// ------------------------------------------------------------

export function applyAction(prev: GameState, action: Action): ActionResult {
  const r = applyActionInner(prev, action);
  if (!r.error) {
    r.state.bench = compactBench(r.state.bench);
    trimLog(r.state);
  }
  return r;
}

function applyActionInner(prev: GameState, action: Action): ActionResult {
  setActiveMap(prev.mapId);
  const state = structuredClone(prev);
  const fail = (error: string): ActionResult => ({ state: prev, error });
  const inPrep = state.phase === 'prep';
  if (!inPrep && action.type !== 'next' && action.type !== 'undoBattle') return fail('準備フェーズではありません');

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
      bandOnBuy(state, defId);
      gainUnit(state, defId);
      return { state };
    }
    case 'sell': {
      const f = findOwned(state, action.uid);
      if (!f) return fail('ユニットが見つかりません');
      const def = getUnit(f.unit.defId);
      if (bandOnSell(state, f.unit)) return { state };
      triggerGarrisons(state, 'SERVER_CHESS_SOLD', [{ unit: f.unit, where: f.where }]);
      if (f.where === 'board') state.board.splice(f.index, 1);
      else state.bench[f.index] = null;
      const price = sellPrice(f.unit);
      state.gold += price;
      state.pool[f.unit.defId] += f.unit.star === 2 ? def.mergeCount : 1;
      state.log.push(`${def.name} を売却（+${price}）`);
      returnItems(state, f.unit);
      itemOnSold(state);
      return { state };
    }
    case 'buyItem': {
      if (!state.itemShop) return fail('装備枠は空です');
      const def = getItem(state.itemShop);
      const price = def.normal.price;
      if (state.gold < price) return fail('資金が足りません');
      const canMerge = storedItems(state).filter((i) => i.itemId === def.id && i.star === 1).length >= def.mergeCount - 1;
      if (!(state.bench.slice(0, BENCH_SIZE).includes(null) && benchOverflow(state) === 0) && !canMerge) return fail('控えがいっぱいです');
      spend(state, price);
      state.itemShop = null;
      state.log.push(`${def.normal.name} を購入（-${price}）`);
      gainItem(state, def.id);
      return { state };
    }
    case 'sellItem': {
      const idx = state.bench.findIndex((i) => isItemEntry(i) && i.uid === action.uid);
      if (idx < 0) return fail('装備が見つかりません');
      const it = state.bench[idx] as OwnedItem;
      state.bench[idx] = null;
      state.gold += ITEM_SELL_PRICE;
      state.log.push(`${itemState(getItem(it.itemId), it.star).name} を売却（+${ITEM_SELL_PRICE}）`);
      return { state };
    }
    case 'moveItem': {
      const from = state.bench.findIndex((i) => isItemEntry(i) && i.uid === action.uid);
      if (from < 0) return fail('装備が見つかりません');
      const other = state.bench[action.index] ?? null;
      state.bench[action.index] = state.bench[from];
      state.bench[from] = other;
      return { state };
    }
    case 'equip': {
      const f = findOwned(state, action.unitUid);
      if (!f) return fail('オペレーターが見つかりません');
      const err = equipItem(state, action.itemUid, f.unit, action.discard);
      if (err) return fail(err);
      return { state };
    }
    case 'deploy': {
      const f = findOwned(state, action.uid);
      if (!f || f.where !== 'bench') return fail('控えのユニットを選んでください');
      if (state.board.length >= deployCapOf(state)) return fail('配置上限に達しています');
      const auto = autoCell(state.board, f.unit.defId, f.unit.star);
      const pos = action.pos ?? auto?.pos ?? null;
      if (pos === null || unitAt(state.board, pos) || !canPlace(pos, f.unit.defId)) return fail(placeError(f.unit.defId));
      state.bench[f.index] = null;
      f.unit.pos = pos;
      f.unit.dir = bestDirection(pos, f.unit.defId, f.unit.star);
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
      const err = moveUnit(state, f, action.to);
      if (err) return fail(err);
      if (state.board.length > deployCapOf(state)) return fail('配置上限に達しています');
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
    case 'pickBounty': {
      const id = state.bounty.offer?.[action.index];
      if (!id) return fail('懸賞の候補がありません');
      state.bounty = { offer: null, picked: id };
      const b = getBounty(id)!;
      notify(state, `懸賞：${ENEMIES[b.enemy]?.name ?? b.enemy}（撃破で資金+${b.coin}）を選択`);
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
      bandAfterRefresh(state);
      state.log.push(label);
      const active = currentActive(state);
      if (active.has('mira')) {
        const free = withRng(state, (rng) => rng.next() < miraProb(state.stacks.mira ?? 0));
        if (free) {
          state.nextRefreshFree = true;
          notify(state, '【奇跡】次の更新が無料に！');
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
      bandOnLevelUp(state);
      return { state };
    }
    case 'toggleFreeze': {
      state.frozen = !state.frozen;
      return { state };
    }
    case 'undoBattle': {
      // 戦闘前の状態に戻す（盟約の加算数・資金・乱数もすべて戦闘前に戻る）。今回の戦闘結果は比較用に残す
      if (state.phase !== 'result' || !state.preBattle || !state.lastBattle) return fail('戻せる戦闘がありません');
      const back = structuredClone(state.preBattle);
      back.undoneBattles = [state.lastBattle, ...(state.undoneBattles ?? [])].filter((x) => x.round === state.round).slice(0, 3);
      notify(back, `ラウンド${state.round}の戦闘を取り消して、戦闘前に戻した`);
      return { state: back };
    }
    case 'battle': {
      if (state.choices.length) return fail(CHOICE_LOCK_MESSAGE);
      if (state.bounty.offer) return fail('懸賞の対象を先に選んでください');
      if (benchOverflow(state) > 0) return fail(`控えが上限を${benchOverflow(state)}名超えています。配置するか売却してください`);
      normalizePositions(state.board);
      // 戻せるように戦闘前の状態を残す（取り消した戦闘の記録は持たせない）
      const snap = structuredClone(state);
      snap.preBattle = null;
      resolveBattle(state);
      state.preBattle = snap;
      return { state };
    }
    case 'next': {
      if (state.phase !== 'result') return fail('戦闘結果フェーズではありません');
      state.preBattle = null;
      state.undoneBattles = [];
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
  const income = bandIncome(state, round);
  state.gold += income + state.pendingGold + state.extraRoundGold;
  if (state.pendingGold) notify(state, `追加資金+${state.pendingGold}`);
  if (state.extraRoundGold) notify(state, `倹約家の人形：資金+${state.extraRoundGold}`);
  state.pendingGold = 0;
  state.round_ = { gained: 0, spent: 0, refreshes: 0, cauldron: 0 };
  itemRoundStart(state);
  state.levelDiscount++;
  rollShop(state, state.frozen);
  state.frozen = false;
  triggerGarrisons(state, 'SERVER_PREP_START', allTargets(state));
  stackRewards(state, currentActive(state));
  bandRoundStart(state);
  if (round === BOUNTY_OFFER_ROUND && !state.bounty.picked) state.bounty.offer = rollBountyOffer(state);
}

/** 懸賞の候補：I〜IIIの各段階から1つずつ。このゲームで選ばれた敵グループの種類を優先する */
function rollBountyOffer(state: GameState): string[] {
  return withRng(state, (rng) =>
    [1, 2, 3].flatMap((tier) => {
      const all = BOUNTIES.filter((b) => b.tier === tier);
      const preferred = all.filter((b) => state.enemyTypes.includes(b.group));
      const cands = preferred.length ? preferred : all;
      return cands.length ? [cands[rng.int(cands.length)].id] : [];
    }),
  );
}

/** ユニットを盤面のマス・控えの枠へ移動する。移動先にユニットがいれば入れ替える */
function moveUnit(
  state: GameState,
  from: { unit: OwnedUnit; where: 'board' | 'bench'; index: number },
  to: { zone: 'board'; pos: number } | { zone: 'bench'; index: number },
): string | undefined {
  const u = from.unit;
  if (to.zone === 'board') {
    if (!canPlace(to.pos, u.defId)) return placeError(u.defId);
    const other = unitAt(state.board, to.pos);
    if (other === u) return;
    if (from.where === 'board') {
      if (other && !canPlace(u.pos!, other.defId)) return `${getUnit(other.defId).name}はそのマスに置けません`;
      if (other) other.pos = u.pos;
      u.pos = to.pos;
    } else {
      state.bench[from.index] = null;
      if (other) {
        state.board = state.board.filter((o) => o !== other);
        delete other.pos;
        delete other.dir;
        state.bench[from.index] = other;
      }
      u.pos = to.pos;
      u.dir = bestDirection(to.pos, u.defId, u.star);
      state.board.push(u);
    }
  } else {
    const other = state.bench[to.index];
    if (other === u) return;
    if (from.where === 'bench') {
      state.bench[from.index] = other;
      state.bench[to.index] = u;
    } else {
      if (isUnitEntry(other) && !canPlace(u.pos!, other.defId)) return `${getUnit(other.defId).name}はそのマスに置けません`;
      state.board = state.board.filter((o) => o !== u);
      if (isUnitEntry(other)) {
        other.pos = u.pos;
        other.dir = bestDirection(u.pos!, other.defId, other.star);
        state.board.push(other);
      }
      delete u.pos;
      delete u.dir;
      state.bench[to.index] = u;
      // 装備がいた枠なら、その装備は別の枠へ
      if (isItemEntry(other)) putOnBench(state, other);
    }
  }
  return undefined;
}

function placeError(defId: string): string {
  return getUnit(defId)?.position === 'melee'
    ? 'そのマスには置けません（近距離オペレーターは地上マスのみ）'
    : 'そのマスには置けません';
}

/** 盤面から戦闘入力を作る（UIの予測でも使う） */
export function buildSimInputs(
  board: OwnedUnit[],
  bench: OwnedUnit[],
  stacks: Partial<Record<AllianceId, number>>,
  opts: BattleOptions = {},
) {
  normalizePositions(board);
  const setup = battleSetup(board, bench, stacks, opts);
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
        pos: o.pos,
        dir: o.dir,
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
  bandPrepFinish(state);
  deputBonus(state);
  onDeployStacks(state);
}

function resolveBattle(state: GameState): void {
  // 使い切れなかった資金は繰り越さない（戦闘後に得た資金は次のラウンドで使える）。戦術【複利】なら繰り越す
  if (bandKeepsGold(state)) {
    state.bandState.carried = state.gold;
  } else {
    if (state.gold > 0) notify(state, `残った資金${state.gold}は失われた`);
    state.gold = 0;
  }
  const before = { ...state.stacks };
  prepFinish(state);

  const bench = benchUnits(state);
  const { statuses, inputs, globals } = buildSimInputs(state.board, bench, state.stacks, { banned: state.banned, roundGained: state.round_.gained, band: state.band });
  const spec = roundSpecOf(state, state.round);
  const sim = simulateBattle(inputs, spec, { globals, activeAlliances: activeAllianceIds(statuses), stacks: state.stacks, record: true });
  const afterPrep = { ...state.stacks };
  const active = activeAllianceIds(evaluateAlliances(state.board, bench, state.banned));
  if (state.round >= NO_BATTLE_STACKS_FROM_ROUND) {
    // ラウンド14・15は戦闘中に堅守特性で得る加算数が無効
    if ((sim.stackSources ?? []).length) notify(state, `ラウンド${NO_BATTLE_STACKS_FROM_ROUND}以降は、戦闘中に堅守特性で得る加算数は無効`);
  } else {
    for (const [b, n] of Object.entries(sim.stackGains) as [AllianceId, number][]) addStacks(state, b, n, active);
    // 戦闘中に堅守特性で得た加算数をログに出す（ユニット・きっかけごと）
    for (const src of sim.stackSources ?? []) {
      notify(state, `戦闘中：${src.name}（${src.cause}）：【${ALLIANCES[src.bond].name}】+${src.amount}`);
    }
  }
  if (sim.siracusa) {
    notify(state, `戦闘中：【シラクーザ】の${sim.siracusa.members}人が配置後${Math.round(sim.siracusa.duration)}秒間 攻撃速度+${Math.round(sim.siracusa.aspd)}`);
  }
  if (sim.sargon && sim.sargon.max > 0) {
    const sg = sim.sargon;
    notify(state, `戦闘中：【サルゴン】の強化：最大${sg.max}層（攻撃速度+${sg.max * sg.aspd}）、平均${sg.avg}層（攻撃速度+${Math.round(sg.avg * sg.aspd)}）`);
  }

  if (sim.bountyGold > 0) {
    state.pendingGold += sim.bountyGold;
    notify(state, `懸賞の敵を撃破：次のラウンドに資金+${sim.bountyGold}`);
  }
  const lost = Math.min(sim.lifeLoss, MAX_LIFE_LOSS);
  state.life = Math.max(0, state.life - lost);
  itemBattleEnd(state);

  const diff = (from: Partial<Record<AllianceId, number>>, to: Partial<Record<AllianceId, number>>) => {
    const out: Partial<Record<AllianceId, number>> = {};
    for (const [b, n] of Object.entries(to) as [AllianceId, number][]) {
      const d = n - (from[b] ?? 0);
      if (d > 0) out[b] = d;
    }
    return out;
  };
  const stacksGained = diff(before, state.stacks);

  const last = state.life <= 0 || state.round >= MAX_ROUND;
  state.lastBattle = {
    round: state.round,
    group: roundGroupOf(state, state.round),
    sim,
    units: state.board.map((o) => ({ uid: o.uid, defId: o.defId, star: o.star, pos: o.pos, dir: o.dir })),
    lifeLost: lost,
    stacksGained,
    stacksBefore: before,
    stacksFromPrep: diff(before, afterPrep),
    stacksFromBattle: diff(afterPrep, state.stacks),
    alliances: statuses,
    nextIncome: last ? null : { base: bandIncome(state, state.round + 1), extra: state.pendingGold },
  };
  state.history.push({ round: state.round, killed: sim.cleared, lifeLost: lost });
  notify(state, 
    sim.cleared && sim.bossDefeated
      ? `ラウンド${state.round}：ボスを撃破（${sim.elapsed}秒）`
      : sim.cleared
      ? `ラウンド${state.round}：敵${sim.total}体をすべて撃破（${sim.elapsed}秒）`
      : `ラウンド${state.round}：${sim.leaked}体に突破され、耐久値-${lost}`,
  );
  state.phase = 'result';
}

/** 予測などUIで使う、ユニットのスキル・特性 */
export function ownedState(o: OwnedUnit) {
  return unitState(getUnit(o.defId), o.star);
}
