import { allOwned, gainRandom, gainUnit, rollChoices, withRng } from './acquire';
import { ownedBonds } from './alliance';
import { ITEMS, ITEM_POOLS, ITEM_STORE_SIZE, findBuff, getItem, isConsumable, itemState } from './data/items';
import { UNITS, getUnit } from './data/units';
import { addStacks, benchUnits, currentActive } from './garrison';
import { TIER_ODDS } from './rules';
import type { GameState } from './game';
import type { OwnedItem, OwnedUnit, Tier } from './types';

// 装備（アイテム）の入手・装備・効果（準備フェーズ側）

export const MAX_EQUIP = 2;
export const ITEM_SELL_PRICE = 1;

export function storedItems(state: GameState): OwnedItem[] {
  return state.itemStore.filter((i): i is OwnedItem => i !== null);
}

export function itemOverflow(state: GameState): number {
  return Math.max(0, storedItems(state).length - ITEM_STORE_SIZE);
}

export function compactItemStore(store: (OwnedItem | null)[]): (OwnedItem | null)[] {
  const items = store.filter((i): i is OwnedItem => i !== null);
  if (items.length > ITEM_STORE_SIZE) return items;
  return [...items, ...Array(ITEM_STORE_SIZE - items.length).fill(null)];
}

/** ショップの装備枠を更新する（等級は管理レベルの出現率に従う） */
export function rollItemShop(state: GameState): void {
  withRng(state, (rng) => {
    const tier = rng.weighted(TIER_ODDS[state.level - 1]) + 1;
    const cands = ITEMS.filter((i) => i.tier === tier);
    state.itemShop = cands.length ? cands[rng.int(cands.length)].id : null;
  });
}

/** 同じ装備が2つ揃ったら強化する（保管庫の中だけ） */
function mergeItems(state: GameState, itemId: string): void {
  const def = getItem(itemId);
  const same = storedItems(state).filter((i) => i.itemId === itemId && i.star === 1);
  if (same.length < def.mergeCount) return;
  const [keep, ...rest] = same;
  const remove = new Set(rest.slice(0, def.mergeCount - 1).map((i) => i.uid));
  state.itemStore = state.itemStore.map((i) => (i && remove.has(i.uid) ? null : i));
  keep.star = 2;
  state.log.push(`${def.normal.name} を強化！`);
}

/** 装備を獲得して保管庫に入れる（上限を超えても破棄しない） */
export function gainItem(state: GameState, itemId: string, source?: string): void {
  const item: OwnedItem = { uid: state.nextUid++, itemId, star: 1 };
  const idx = state.itemStore.slice(0, ITEM_STORE_SIZE).indexOf(null);
  if (idx >= 0 && itemOverflow(state) === 0) state.itemStore[idx] = item;
  else state.itemStore.push(item);
  if (source) state.log.push(`${source}：${getItem(itemId).normal.name} を獲得`);
  mergeItems(state, itemId);
  state.itemStore = compactItemStore(state.itemStore);
}

export function gainItemFromPool(state: GameState, pool: string, source: string, count = 1): void {
  const cands = ITEM_POOLS[pool] ?? [];
  for (let i = 0; i < count; i++) {
    const idx = withRng(state, (rng) => rng.weighted(cands.map(([, w]) => w)));
    if (idx >= 0) gainItem(state, cands[idx][0], source);
  }
}

/** 管理レベル以下の等級からランダムな装備 */
export function gainRandomItem(state: GameState, source: string, count = 1): void {
  for (let i = 0; i < count; i++) {
    const cands = ITEMS.filter((it) => it.tier <= state.level);
    const idx = withRng(state, (rng) => rng.int(cands.length));
    gainItem(state, cands[idx].id, source);
  }
}

/** 装備者と同じ盟約のオペレーター候補（管理レベル以下の等級） */
function sameBondCandidates(state: GameState, o: OwnedUnit, maxTier = state.level) {
  const bonds = ownedBonds(o);
  return UNITS.filter((u) => u.tier <= maxTier && u.bonds.some((b) => bonds.includes(b))).map((u) => ({ id: u.id, weight: 1 }));
}

function removeUnit(state: GameState, o: OwnedUnit): void {
  state.board = state.board.filter((x) => x !== o);
  state.bench = state.bench.map((x) => (x === o ? null : x));
}

/** オペレーターの装備を保管庫に戻す（売却時） */
export function returnItems(state: GameState, o: OwnedUnit): void {
  for (const it of o.items ?? []) {
    const idx = state.itemStore.slice(0, ITEM_STORE_SIZE).indexOf(null);
    if (idx >= 0 && itemOverflow(state) === 0) state.itemStore[idx] = it;
    else state.itemStore.push(it);
  }
  o.items = [];
  state.itemStore = compactItemStore(state.itemStore);
}

/**
 * 保管庫の装備をオペレーターに装備する。消耗型の装備は効果を発動して消滅する。
 * エラーならメッセージを返す
 */
export function equipItem(state: GameState, itemUid: number, unit: OwnedUnit): string | undefined {
  const idx = state.itemStore.findIndex((i) => i?.uid === itemUid);
  if (idx < 0) return '装備が見つかりません';
  const item = state.itemStore[idx]!;
  const def = getItem(item.itemId);
  const st = itemState(def, item.star);
  const consumable = isConsumable(def);
  const anyone = !!findBuff(st, 'equip_round_start_upgrade_char');
  if (!consumable && !anyone && (unit.items?.length ?? 0) >= MAX_EQUIP) return `装備は1人${MAX_EQUIP}つまでです`;
  if (anyone && unit.star === 2) return 'すでに精鋭化しています';

  state.itemStore[idx] = null;
  const name = getUnit(unit.defId).name;
  const n = (b: { [k: string]: unknown } | undefined, k: string) => Number(b?.[k] ?? 0);

  if (!consumable) {
    unit.items = [...(unit.items ?? []), item];
    state.log.push(`${name} に ${st.name} を装備`);
    state.itemStore = compactItemStore(state.itemStore);
    return undefined;
  }

  for (const b of st.buffs) {
    switch (b.type) {
      case 'equip_destory_gain_random_coin': {
        const gold = withRng(state, (rng) => n(b, 'min') + rng.int(n(b, 'max') - n(b, 'min') + 1));
        state.gold += gold;
        state.log.push(`${st.name}：資金+${gold}`);
        break;
      }
      case 'use_equip_reward_char_chess_bond_layer': {
        const active = currentActive(state);
        for (const bond of ownedBonds(unit)) addStacks(state, bond, n(b, 'layer'), active);
        state.log.push(`${st.name}：${name}の盟約の加算数+${n(b, 'layer')}`);
        break;
      }
      case 'use_equip_reward_random_char_chess_in_shop': {
        for (let i = 0; i < n(b, 'count'); i++) {
          const slots = state.shop.map((id, s) => ({ id, s })).filter((x) => x.id);
          if (!slots.length) break;
          const pick = slots[withRng(state, (rng) => rng.int(slots.length))];
          state.shop[pick.s] = null;
          gainUnit(state, pick.id!);
          state.log.push(`${st.name}：${getUnit(pick.id!).name} を獲得`);
        }
        break;
      }
      case 'gain_coin_when_round_start':
        state.extraRoundGold += n(b, 'count');
        state.log.push(`${st.name}：以降のラウンド開始時に資金+${n(b, 'count')}`);
        break;
      case 'use_equip_reward_char_chess_with_same_bond':
        for (let i = 0; i < n(b, 'count'); i++) gainRandom(state, sameBondCandidates(state, unit), st.name);
        break;
      case 'use_equip_gain_coin_when_next_round_start':
        state.pendingGold += n(b, 'count');
        state.log.push(`${st.name}：次のラウンドで資金+${n(b, 'count')}`);
        break;
      case 'use_equip_reward_special_goods_char_chess': {
        const cands = sameBondCandidates(state, unit).map((c) => c.id);
        const options = withRng(state, (rng) => {
          const out: string[] = [];
          const pool = cands.filter((c) => state.pool[c] > 0);
          while (out.length < 3 && pool.length) out.push(pool.splice(rng.int(pool.length), 1)[0]);
          return out;
        });
        if (options.length) state.choices.push({ title: st.name, options });
        break;
      }
      case 'use_equip_recruit_new_char_and_give_char_to_player_most_bond': {
        const tier = getUnit(unit.defId).tier as Tier;
        returnItems(state, unit);
        removeUnit(state, unit);
        state.pool[unit.defId] += unit.star === 2 ? getUnit(unit.defId).mergeCount : 1;
        const options = rollChoices(state, tier).slice(0, 2);
        if (options.length) state.choices.push({ title: st.name, options });
        state.log.push(`${st.name}：${name} が消滅`);
        break;
      }
      case 'use_equip_reward_char_chess': {
        const owned = allOwned(state).filter((o) => o.defId === unit.defId && o.star === 1).length;
        if (owned >= 2) {
          gainUnit(state, unit.defId);
          state.log.push(`${st.name}：${name} を獲得`);
        } else {
          gainRandom(state, sameBondCandidates(state, unit, getUnit(unit.defId).tier), st.name);
        }
        break;
      }
      case 'equip_destory_deployment_cnt_change':
        state.deployCapOverride = n(b, 'count');
        state.log.push(`${st.name}：最大配置人数が${n(b, 'count')}に`);
        break;
    }
  }
  state.itemStore = compactItemStore(state.itemStore);
  return undefined;
}

/** ラウンド開始時：ドクターのホログラムで精鋭化 */
export function itemRoundStart(state: GameState): void {
  for (const o of allOwned(state)) {
    const holo = (o.items ?? []).find((i) => findBuff(itemState(getItem(i.itemId), i.star), 'equip_round_start_upgrade_char'));
    if (!holo) continue;
    o.items = (o.items ?? []).filter((i) => i !== holo);
    if (o.star === 1) {
      o.star = 2;
      state.log.push(`ドクターのホログラム：${getUnit(o.defId).name} を精鋭化`);
    }
  }
}

/** 戦闘終了後：突然変異細胞で1つ上の等級のオペレーターに置き換わる */
export function itemBattleEnd(state: GameState): void {
  for (const o of [...state.board, ...benchUnits(state)]) {
    const cell = (o.items ?? []).find((i) => findBuff(itemState(getItem(i.itemId), i.star), 'char_chess_transformation_equip'));
    if (!cell) continue;
    const def = getUnit(o.defId);
    const tier = Math.min(def.tier + 1, 6);
    const cands = UNITS.filter((u) => u.tier === tier && u.id !== o.defId && state.pool[u.id] > 0 && unitAvailable(state, u.id));
    if (!cands.length) continue;
    const next = cands[withRng(state, (rng) => rng.int(cands.length))];
    state.pool[o.defId] += o.star === 2 ? def.mergeCount : 1;
    state.pool[next.id]--;
    o.items = (o.items ?? []).filter((i) => i !== cell);
    state.log.push(`突然変異細胞：${def.name} が ${next.name} に変化`);
    o.defId = next.id;
    o.star = 1;
  }
}

/** オペレーター売却時：商業パッケージ案 */
export function itemOnSold(state: GameState): void {
  state.soldCount++;
  for (const o of allOwned(state)) {
    for (const it of o.items ?? []) {
      const b = findBuff(itemState(getItem(it.itemId), it.star), 'sell_char_count_gain_equip_owner_bond');
      if (b && state.soldCount % Number(b.count) === 0) gainRandom(state, sameBondCandidates(state, o), getItem(it.itemId).normal.name);
    }
  }
}

/** 天師の古鼎＋炎国の短刀（炎）：オペレーターを獲得するたびに資金（1ラウンド最大3回） */
export function itemOnGain(state: GameState): void {
  for (const o of allOwned(state)) {
    const cauldron = (o.items ?? []).find((i) => i.itemId === '6_03');
    if (!cauldron || !(o.items ?? []).some((i) => i.itemId === '3_04') || !ownedBonds(o).includes('yan')) continue;
    const b = itemState(getItem('6_03'), cauldron.star).buffs.find((x) => x.type === 'equip_with_another_gain_coin_when_gain_char');
    const max = Number(b?.max ?? 3);
    if (state.round_.cauldron >= max) continue;
    state.round_.cauldron++;
    const gold = Number(b?.count ?? 2);
    state.gold += gold;
    state.log.push(`天師の古鼎：資金+${gold}`);
  }
}

/** 盟約BAN：BANされた盟約を2つ以上持つオペレーターは出現しない */
export function unitAvailable(state: Pick<GameState, 'banned'>, defId: string): boolean {
  return getUnit(defId).bonds.filter((b) => state.banned.includes(b)).length < 2;
}
