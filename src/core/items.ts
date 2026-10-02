import { allOwned, compactBench, gainRandom, gainUnit, putOnBench, rollChoices, withRng } from './acquire';
import { notify } from './log';
import { ownedBonds } from './alliance';
import { ITEMS, ITEM_POOLS, NOT_IN_SHOP, findBuff, getItem, isConsumable, itemState } from './data/items';
import { UNITS, getUnit } from './data/units';
import { addStacks, benchUnits, currentActive } from './garrison';
import { TIER_ODDS } from './rules';
import type { GameState } from './game';
import { isItemEntry, type OwnedItem, type OwnedUnit, type Tier } from './types';

// 装備（アイテム）の入手・装備・効果（準備フェーズ側）

export const MAX_EQUIP = 2;
/** 所持している間はショップに出ない装備（プロデュース戦略） */
const ONE_AT_A_TIME = new Set(['5_07']);
export const ITEM_SELL_PRICE = 1;

/** 控えにある装備 */
export function storedItems(state: GameState): OwnedItem[] {
  return state.bench.filter(isItemEntry);
}

/** ショップの装備枠を更新する（等級は管理レベルの出現率に従う） */
export function rollItemShop(state: GameState): void {
  withRng(state, (rng) => {
    const tier = rng.weighted(TIER_ODDS[state.level - 1]) + 1;
    // プロデュース戦略は、所持している間は出さない（複数持つと資金が無限に増えるため）
    const owned = new Set([...storedItems(state), ...allOwned(state).flatMap((o) => o.items ?? [])].map((i) => i.itemId));
    const cands = ITEMS.filter((i) => i.tier === tier && !NOT_IN_SHOP.has(i.id) && !(ONE_AT_A_TIME.has(i.id) && owned.has(i.id)));
    state.itemShop = cands.length ? cands[rng.int(cands.length)].id : null;
  });
}

/**
 * 同じ装備が2つ揃ったら精鋭化する。
 * 控えの装備に加え、オペレーターが装備している同じ非精鋭の装備とも合成し、精鋭化した装備は控えに置く
 */
function mergeItems(state: GameState, itemId: string): void {
  const def = getItem(itemId);
  const same = storedItems(state).filter((i) => i.itemId === itemId && i.star === 1);
  if (!same.length) return;
  const equipped = allOwned(state).flatMap((o) => (o.items ?? []).filter((i) => i.itemId === itemId && i.star === 1).map((it) => ({ o, it })));
  if (same.length + equipped.length < def.mergeCount) return;
  // 新しく入った装備（最後の1つ）を残す
  const keep = same[same.length - 1];
  let need = def.mergeCount - 1;
  const remove = new Set<number>();
  for (const i of same) {
    if (need <= 0) break;
    if (i === keep) continue;
    remove.add(i.uid);
    need--;
  }
  state.bench = state.bench.map((i) => (i && remove.has(i.uid) ? null : i));
  for (const { o, it } of equipped) {
    if (need <= 0) break;
    o.items = (o.items ?? []).filter((x) => x !== it);
    notify(state, `${getUnit(o.defId).name} の ${def.normal.name} と合成`);
    need--;
  }
  keep.star = 2;
  notify(state, `${def.normal.name} を精鋭化！`);
}

/** 装備を獲得して控えに入れる（上限を超えても破棄しない） */
export function gainItem(state: GameState, itemId: string, source?: string): void {
  putOnBench(state, { uid: state.nextUid++, itemId, star: 1 });
  if (source) notify(state, `${source}：${getItem(itemId).normal.name} を獲得`);
  mergeItems(state, itemId);
  state.bench = compactBench(state.bench);
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
    const cands = ITEMS.filter((it) => it.tier <= state.level && !NOT_IN_SHOP.has(it.id));
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

/** オペレーターの装備を控えに戻す（売却時） */
export function returnItems(state: GameState, o: OwnedUnit): void {
  for (const it of o.items ?? []) putOnBench(state, it);
  o.items = [];
}

/**
 * 控えの装備をオペレーターに装備する。消耗型の装備は効果を発動して消滅する。
 * エラーならメッセージを返す
 */
/** 装備がいっぱいで、どれかを外す（破棄する）必要があるか */
export function equipNeedsDiscard(state: GameState, itemUid: number, unit: OwnedUnit): boolean {
  const item = state.bench.find((i) => isItemEntry(i) && i.uid === itemUid) as OwnedItem | undefined;
  if (!item) return false;
  const def = getItem(item.itemId);
  const st = itemState(def, item.star);
  const anyone = !!findBuff(st, 'equip_round_start_upgrade_char') || !!findBuff(st, 'use_equip_upgrade_char');
  return !isConsumable(def) && !anyone && (unit.items?.length ?? 0) >= MAX_EQUIP;
}

export function equipItem(state: GameState, itemUid: number, unit: OwnedUnit, discardUid?: number): string | undefined {
  const idx = state.bench.findIndex((i) => isItemEntry(i) && i.uid === itemUid);
  if (idx < 0) return '装備が見つかりません';
  const item = state.bench[idx] as OwnedItem;
  const def = getItem(item.itemId);
  const st = itemState(def, item.star);
  const consumable = isConsumable(def);
  const anyone = !!findBuff(st, 'equip_round_start_upgrade_char');
  // 精鋭のドクターのホログラム：誰でも装備でき、即座に精鋭化
  if (findBuff(st, 'use_equip_upgrade_char')) {
    if (unit.star === 2) return 'すでに精鋭化しています';
    state.bench[idx] = null;
    unit.star = 2;
    notify(state, `${st.name}：${getUnit(unit.defId).name} を精鋭化`);
    return undefined;
  }
  if (!consumable && !anyone && (unit.items?.length ?? 0) >= MAX_EQUIP) {
    // 指定された装備を破棄して付け替える
    const old = unit.items?.find((i) => i.uid === discardUid);
    if (!old) return `装備は1人${MAX_EQUIP}つまでです`;
    unit.items = unit.items!.filter((i) => i !== old);
    state.log.push(`${itemState(getItem(old.itemId), old.star).name} を破棄`);
  }
  if (anyone && unit.star === 2) return 'すでに精鋭化しています';

  state.bench[idx] = null;
  const name = getUnit(unit.defId).name;
  const n = (b: { [k: string]: unknown } | undefined, k: string) => Number(b?.[k] ?? 0);

  if (!consumable) {
    unit.items = [...(unit.items ?? []), item];
    state.log.push(`${name} に ${st.name} を装備`);
    return undefined;
  }

  for (const b of st.buffs) {
    switch (b.type) {
      case 'equip_destory_gain_random_coin': {
        const gold = withRng(state, (rng) => n(b, 'min') + rng.int(n(b, 'max') - n(b, 'min') + 1));
        state.gold += gold;
        notify(state, `${st.name}：資金+${gold}`);
        break;
      }
      case 'use_equip_reward_char_chess_bond_layer': {
        const active = currentActive(state);
        for (const bond of ownedBonds(unit)) addStacks(state, bond, n(b, 'layer'), active);
        notify(state, `${st.name}：${name}の盟約の加算数+${n(b, 'layer')}`);
        break;
      }
      case 'use_equip_reward_random_char_chess_in_shop': {
        for (let i = 0; i < n(b, 'count'); i++) {
          const slots = state.shop.map((id, s) => ({ id, s })).filter((x) => x.id);
          if (!slots.length) break;
          const pick = slots[withRng(state, (rng) => rng.int(slots.length))];
          state.shop[pick.s] = null;
          gainUnit(state, pick.id!);
          notify(state, `${st.name}：${getUnit(pick.id!).name} を獲得`);
        }
        break;
      }
      case 'gain_coin_when_round_start':
        state.extraRoundGold += n(b, 'count');
        notify(state, `${st.name}：以降のラウンド開始時に資金+${n(b, 'count')}`);
        break;
      case 'use_equip_reward_char_chess_with_same_bond':
        for (let i = 0; i < n(b, 'count'); i++) gainRandom(state, sameBondCandidates(state, unit), st.name);
        break;
      case 'use_equip_gain_coin_when_next_round_start':
        state.pendingGold += n(b, 'count');
        notify(state, `${st.name}：次のラウンドで資金+${n(b, 'count')}`);
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
        notify(state, `${st.name}：${name} が消滅`);
        break;
      }
      case 'use_equip_reward_char_chess': {
        const owned = allOwned(state).filter((o) => o.defId === unit.defId && o.star === 1).length;
        if (owned >= 2) {
          gainUnit(state, unit.defId);
          notify(state, `${st.name}：${name} を獲得`);
        } else {
          gainRandom(state, sameBondCandidates(state, unit, getUnit(unit.defId).tier), st.name);
        }
        break;
      }
      case 'equip_destory_deployment_cnt_change':
        state.deployCapOverride = n(b, 'count');
        notify(state, `${st.name}：最大配置人数が${n(b, 'count')}に`);
        break;
    }
  }
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
      notify(state, `ドクターのホログラム：${getUnit(o.defId).name} を精鋭化`);
    }
  }
}

/** 戦闘終了後：変異細胞で1つ上の等級のオペレーターに置き換わる */
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
    notify(state, `変異細胞：${def.name} が ${next.name} に変化`);
    o.defId = next.id;
    o.star = 1;
  }
}

/** オペレーター売却時：プロデュース戦略 */
export function itemOnSold(state: GameState): void {
  state.soldCount++;
  for (const o of allOwned(state)) {
    for (const it of o.items ?? []) {
      const b = findBuff(itemState(getItem(it.itemId), it.star), 'sell_char_count_gain_equip_owner_bond');
      if (b && state.soldCount % Number(b.count) === 0) gainRandom(state, sameBondCandidates(state, o), getItem(it.itemId).normal.name);
    }
  }
}

/** 天師の祭器＋炎国の短刀（炎）：オペレーターを獲得するたびに資金（1ラウンド最大3回） */
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
    notify(state, `天師の祭器：資金+${gold}`);
  }
}

/**
 * 盟約BAN：BANされた盟約を2つ以上持つオペレーターは出現しない。
 * 盟約を1つしか持たないオペレーターは、その盟約がBANされていれば出現しない
 */
export function unitAvailable(state: Pick<GameState, 'banned'>, defId: string): boolean {
  const bonds = getUnit(defId).bonds;
  return bonds.filter((b) => state.banned.includes(b)).length < Math.min(2, bonds.length);
}
