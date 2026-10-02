import { compactBench, gainRandom, gainUnit, putOnBench, withRng } from './acquire';
import { cellX, cellY } from './board';
import { notify } from './log';
import { getBand, type BandId } from './data/bands';
import { UNITS, getUnit, unitState } from './data/units';
import { addStacks, currentActive, triggerGarrisons } from './garrison';
import { gainItem, gainRandomItem, returnItems, unitAvailable } from './items';
import { ownedBonds } from './alliance';
import { TIER_ODDS, roundIncome } from './rules';
import type { GameState } from './game';
import type { Rng } from './rng';
import type { AllianceId, OwnedUnit, Star, Tier } from './types';

// 戦術（ゲーム開始時に選ぶリーダー）の準備フェーズ側の効果

/** 戦術ごとの進行状況 */
export interface BandState {
  /** 累計で使った資金（キララ・パガニーニ） */
  spent: number;
  /** キララ：獲得済みの回数 */
  kiraraGot: number;
  /** パガニーニ：獲得済み */
  paganiniDone: boolean;
  /** ペペ：未使用の特殊更新 */
  pepePending: number;
  /** キアーベ：累計の更新回数と、このラウンドの獲得数 */
  chiaveRefreshes: number;
  chiaveRound: number;
  /** スキウルス：このラウンドの割引を使った */
  sciurusUsed: boolean;
  /** シャマレ：このラウンドの交換を使った */
  vodfoxUsed: boolean;
  /** ムリナール：このラウンドに招集したカジミエーシュの数 */
  mlynarBuys: number;
  /** キャノット：前のラウンドから繰り越した資金 */
  carried: number;
}

export const newBandState = (): BandState => ({
  spent: 0,
  kiraraGot: 0,
  paganiniDone: false,
  pepePending: 0,
  chiaveRefreshes: 0,
  chiaveRound: 0,
  sciurusUsed: false,
  vodfoxUsed: false,
  mlynarBuys: 0,
  carried: 0,
});

const bandOf = (state: GameState): BandId | null => state.band ?? null;
const label = (state: GameState) => {
  const b = getBand(state.band);
  return b ? `【${b.name}】` : '';
};

/** 管理レベル以下の等級からランダムな候補（重みは残り枚数） */
function poolCandidates(state: GameState, filter: (id: string) => boolean = () => true, minTier = 1) {
  return UNITS.filter((u) => u.tier >= minTier && u.tier <= Math.max(minTier, state.level) && filter(u.id)).map((u) => ({ id: u.id, weight: state.pool[u.id] }));
}

const hasBond = (bond: AllianceId) => (id: string) => getUnit(id).bonds.includes(bond);

/** 指定の盟約のオペレーターを、出現率に従った等級で1名抽選する（無ければ低い等級へ） */
function rollBondUnit(state: GameState, rng: Rng, bond: AllianceId): string | null {
  for (let tier = rng.weighted(TIER_ODDS[state.level - 1]) + 1; tier >= 1; tier--) {
    const cands = UNITS.filter((u) => u.tier === tier && u.bonds.includes(bond) && unitAvailable(state, u.id) && state.pool[u.id] > 0);
    const idx = rng.weighted(cands.map((c) => state.pool[c.id]));
    if (idx >= 0) return cands[idx].id;
  }
  return null;
}

/** 精鋭のオペレーターを直接獲得する（必要枚数を共有プールから引く） */
function gainElite(state: GameState, defId: string, source: string): void {
  const def = getUnit(defId);
  state.pool[defId] = Math.max(0, state.pool[defId] - def.mergeCount);
  const unit: OwnedUnit = { uid: state.nextUid++, defId, star: 2 as Star };
  putOnBench(state, unit);
  state.round_.gained++;
  notify(state, `${source}：精鋭の ${def.name} を獲得`);
  triggerGarrisons(state, 'SERVER_GAIN', [{ unit, where: 'bench' }]);
  state.bench = compactBench(state.bench);
}

// ------------------------------------------------------------
// 資金
// ------------------------------------------------------------

/** ラウンドの基本収入（リー：1・2ラウンドの資金は3ラウンドにまとめて支給） */
export function bandIncome(state: Pick<GameState, 'band'>, round: number): number {
  if (state.band === 'lmlee') {
    if (round <= 2) return 0;
    if (round === 3) return roundIncome(1) + roundIncome(2) + roundIncome(3);
  }
  return roundIncome(round);
}

/** 戦闘開始時に残った資金を繰り越すか（キャノット） */
export const bandKeepsGold = (state: Pick<GameState, 'band'>) => state.band === 'cannot';

/** 資金を使った時（キララ・パガニーニ） */
export function bandOnSpend(state: GameState, amount: number): void {
  const band = bandOf(state);
  if (!band || amount <= 0) return;
  state.bandState.spent += amount;
  if (band === 'kirara') {
    while (Math.floor(state.bandState.spent / 20) > state.bandState.kiraraGot) {
      state.bandState.kiraraGot++;
      gainRandom(state, poolCandidates(state), label(state));
    }
  }
  if (band === 'paganini' && !state.bandState.paganiniDone && state.bandState.spent >= 55) {
    state.bandState.paganiniDone = true;
    const cands = UNITS.filter((u) => u.tier >= 4 && u.bonds.includes('laterano') && unitAvailable(state, u.id) && state.pool[u.id] >= u.mergeCount);
    if (cands.length) gainElite(state, cands[withRng(state, (rng) => rng.int(cands.length))].id, label(state));
  }
}

// ------------------------------------------------------------
// 調達所
// ------------------------------------------------------------

/** 招集価格（スキウルス：毎ラウンド最初のイェラグは1） */
export function bandPrice(state: GameState, defId: string, price: number): number {
  if (state.band === 'sciurus' && !state.bandState.sciurusUsed && getUnit(defId).bonds.includes('kjerag')) return Math.min(price, 1);
  return price;
}

export function bandOnBuy(state: GameState, defId: string): void {
  const def = getUnit(defId);
  if (state.band === 'sciurus' && def.bonds.includes('kjerag')) state.bandState.sciurusUsed = true;
  if (state.band === 'mlynar' && def.bonds.includes('kazimierz') && state.bandState.mlynarBuys < 3) {
    state.bandState.mlynarBuys++;
    state.pendingGold++;
  }
}

/** 調達所を手動で更新した後（ドゥ・ヤオイェ・ペペの特殊更新、キアーベ） */
export function bandAfterRefresh(state: GameState): void {
  const band = bandOf(state);
  if (band === 'duyaoy' && state.round_.refreshes <= 2) ensureBondInShop(state, 'yan', false);
  if (band === 'pepe' && state.bandState.pepePending > 0) {
    state.bandState.pepePending--;
    ensureBondInShop(state, 'sargon', true);
    notify(state, `${label(state)}特殊更新：【サルゴン】を優先`);
  }
  if (band === 'chiave') {
    state.bandState.chiaveRefreshes++;
    if (state.bandState.chiaveRefreshes % 6 === 0 && state.bandState.chiaveRound < 2) {
      state.bandState.chiaveRound++;
      gainRandom(state, poolCandidates(state, hasBond('siracusa')), label(state));
    }
  }
}

/** 調達所に指定の盟約のオペレーターを出す。all なら全枠を優先して置き換える */
function ensureBondInShop(state: GameState, bond: AllianceId, all: boolean): void {
  withRng(state, (rng) => {
    const slots = state.shop.map((_, i) => i);
    if (!all) {
      if (state.shop.some((id) => id && getUnit(id).bonds.includes(bond))) return;
      const i = slots[rng.int(slots.length)];
      const id = rollBondUnit(state, rng, bond);
      if (id) state.shop[i] = id;
      return;
    }
    for (const i of slots) {
      if (state.shop[i] && getUnit(state.shop[i]!).bonds.includes(bond)) continue;
      const id = rollBondUnit(state, rng, bond);
      if (id) state.shop[i] = id;
    }
  });
}

/** 管理レベルを上げた時（ペペ・キャサリン） */
export function bandOnLevelUp(state: GameState): void {
  const band = bandOf(state);
  if (band === 'pepe' && [2, 4, 6].includes(state.level)) {
    state.bandState.pepePending++;
    state.freeRefreshes++;
    notify(state, `${label(state)}特殊更新（【サルゴン】優先）を1回獲得`);
  }
  if (band === 'cathy') gainRandomItem(state, label(state));
}

/**
 * 売却の代わりの処理（シャマレ：毎ラウンド最初の通常オペレーターの売却は、調達所のランダムなオペレーターとの交換になる）。
 * 処理したら true
 */
export function bandOnSell(state: GameState, unit: OwnedUnit): boolean {
  if (state.band !== 'vodfox' || state.bandState.vodfoxUsed || unit.star !== 1) return false;
  const slots = state.shop.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);
  if (!slots.length) return false;
  state.bandState.vodfoxUsed = true;
  const slot = slots[withRng(state, (rng) => rng.int(slots.length))];
  const got = state.shop[slot]!;
  state.board = state.board.filter((o) => o !== unit);
  state.bench = state.bench.map((o) => (o === unit ? null : o));
  returnItems(state, unit);
  state.pool[unit.defId] += 1;
  state.shop[slot] = unit.defId;
  notify(state, `${label(state)}${getUnit(unit.defId).name} を調達所の ${getUnit(got).name} と交換`);
  gainUnit(state, got);
  return true;
}

// ------------------------------------------------------------
// ラウンドの区切り
// ------------------------------------------------------------

const ITEM_ROUNDS: Partial<Record<BandId, { rounds: number[]; item: string; star?: Star }>> = {
  justin: { rounds: [1, 4, 7, 10], item: '3_12' },
  jesica: { rounds: [4, 7, 10, 13], item: '4_01' },
  orchid: { rounds: [10], item: '4_01' },
  quintus: { rounds: [3], item: '5_08' },
  malkie: { rounds: [1], item: '5_07' },
  mlyss: { rounds: [1], item: '5_06', star: 2 },
  damaztic: { rounds: [5, 10, 15], item: '6_09' },
  fang: { rounds: [8, 10, 12, 14], item: '5_04' },
};

/** 準備フェーズ開始時 */
export function bandRoundStart(state: GameState): void {
  const band = bandOf(state);
  if (!band) return;
  const round = state.round;
  const bs = state.bandState;
  bs.sciurusUsed = false;
  bs.vodfoxUsed = false;
  bs.mlynarBuys = 0;
  bs.chiaveRound = 0;

  const it = ITEM_ROUNDS[band];
  if (it?.rounds.includes(round)) {
    gainItem(state, it.item, label(state));
    if (it.star === 2) {
      const last = [...state.bench].reverse().find((b) => b && 'itemId' in b && b.itemId === it.item);
      if (last && 'itemId' in last) last.star = 2;
    }
  }
  switch (band) {
    case 'cannot': {
      if (bs.carried >= 5) {
        state.gold += 1;
        notify(state, `${label(state)}繰り越し資金${bs.carried}の利子+1`);
      }
      break;
    }
    case 'lmlee':
      if (round === 3) {
        for (const tier of [2, 4] as Tier[]) gainRandom(state, UNITS.filter((u) => u.tier === tier).map((u) => ({ id: u.id, weight: state.pool[u.id] })), label(state));
      }
      break;
    case 'harold':
      if (round >= 4 && (round - 4) % 2 === 0) gainRandom(state, poolCandidates(state, hasBond('victoria')), label(state));
      break;
    case 'makiri':
      if (round % 2 === 0) {
        const slots = state.shop.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);
        if (slots.length) {
          const slot = slots[withRng(state, (rng) => rng.int(slots.length))];
          const id = state.shop[slot]!;
          state.shop[slot] = null;
          if (gainUnit(state, id)) notify(state, `${label(state)}調達所の ${getUnit(id).name} を獲得`);
        }
      }
      break;
    case 'narant':
      if (round % 2 === 0) gainRandomItem(state, label(state));
      break;
    case 'yu':
      if (round === 8) {
        const active = [...currentActive(state)];
        const n = active.length === 1 ? 36 : 12;
        for (const b of active) addStacks(state, b, n);
        if (active.length) notify(state, `${label(state)}発動中の盟約${active.length}つの加算数+${n}`);
      }
      break;
    case 'lisa': {
      // 獲得時の特性を持つオペレーターのうち、一番右（同じ列なら一番下）
      const hasGain = (o: OwnedUnit) => unitState(getUnit(o.defId), o.star).garrisons.some((g) => g.event === 'SERVER_GAIN');
      const target = state.board.filter(hasGain).sort((a, b) => cellX(b.pos ?? 0) - cellX(a.pos ?? 0) || cellY(b.pos ?? 0) - cellY(a.pos ?? 0))[0];
      if (target) {
        notify(state, `${label(state)}${getUnit(target.defId).name} の獲得時の特性を発動`);
        triggerGarrisons(state, 'SERVER_GAIN', [{ unit: target, where: 'board' }]);
      }
      break;
    }
  }
}

/** 準備フェーズ終了時（ワルファリン：等級ごとにランダムな1名の盟約の加算数+2） */
export function bandPrepFinish(state: GameState): void {
  if (state.band !== 'bldsk') return;
  const byTier = new Map<number, OwnedUnit[]>();
  for (const o of state.board) {
    const t = getUnit(o.defId).tier;
    byTier.set(t, [...(byTier.get(t) ?? []), o]);
  }
  const active = currentActive(state);
  for (const [, units] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
    const o = units[withRng(state, (rng) => rng.int(units.length))];
    for (const b of ownedBonds(o)) addStacks(state, b, 2, active);
  }
}

