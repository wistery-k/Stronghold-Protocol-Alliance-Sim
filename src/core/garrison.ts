import { evaluateAlliances, activeAllianceIds, bondKey, effectiveGarrisons } from './alliance';
import { notify } from './log';
import { gainRandom, rollChoices } from './acquire';
import { gainItem, gainItemFromPool, gainRandomItem } from './items';
import { ITEM_POOLS } from './data/items';
import { itemKey } from './data/items';
import { behindOf, egirDevour, frontOf, frontsOf, sameRow } from './board';
import { ALLIANCES, v } from './data/alliances';
import { UNITS, getUnit, unitState } from './data/units';
import type { GameState } from './game';
import { isUnitEntry, type AllianceId, type GarrisonData, type OwnedUnit, type Tier } from './types';
import { MAX_STACKS, NO_BATTLE_STACKS_FROM_ROUND } from './rules';

// 堅守特性のうち、準備フェーズ側（獲得時・準備フェーズ開始/終了時・売却時・更新時）の処理

export type ServerEvent = 'SERVER_GAIN' | 'SERVER_PREP_START' | 'SERVER_PREP_FIN' | 'SERVER_CHESS_SOLD' | 'SERVER_REFRESH_SHOP';

export function benchUnits(state: GameState): OwnedUnit[] {
  return state.bench.filter(isUnitEntry);
}

export function currentActive(state: GameState): Set<AllianceId> {
  return activeAllianceIds(evaluateAlliances(state.board, benchUnits(state), state.banned));
}

/** 加算数を増やし、加算数に応じた報酬（先見・奇跡）を処理する */
export function addStacks(state: GameState, bond: AllianceId, n: number, active?: Set<AllianceId>): void {
  if (n <= 0 || ALLIANCES[bond]?.noStack) return;
  state.stacks[bond] = Math.min(MAX_STACKS, (state.stacks[bond] ?? 0) + n);
  stackRewards(state, active ?? currentActive(state));
}

export function stackRewards(state: GameState, active: Set<AllianceId>): void {
  const r = state.rewards;
  if (active.has('visi')) {
    const s = state.stacks.visi ?? 0;
    const tens = Math.floor(s / v('visi', 'layer'));
    if (tens > r.visiTens) {
      const gold = (tens - r.visiTens) * v('visi', 'count');
      state.gold += gold;
      notify(state, `【先見】加算数${s}：資金+${gold}`);
      r.visiTens = tens;
    }
    if (s >= v('visi', 'layer1') && !r.visiDiscount) {
      r.visiDiscount = true;
      notify(state, '【先見】80層：【先見】の購入価格-1');
    }
    if (s >= v('visi', 'layer2') && !r.allDiscount) {
      r.allDiscount = true;
      notify(state, '【先見】150層：すべての購入価格-1');
    }
  }
  if (active.has('victoria')) {
    // 【ヴィクトリア】25層ごとにヴィクトリアの鉄鎚を獲得
    const quarters = Math.floor((state.stacks.victoria ?? 0) / 25);
    while (r.victoriaQuarters < quarters) {
      r.victoriaQuarters++;
      gainItemFromPool(state, 'pool_equip_vict', '【ヴィクトリア】');
    }
  }
  if (active.has('mira')) {
    const s = state.stacks.mira ?? 0;
    const hundreds = Math.floor(s / 100);
    if (hundreds > r.miraHundreds) {
      const gold = (hundreds - r.miraHundreds) * 20;
      state.gold += gold;
      notify(state, `【奇跡】加算数${s}：資金+${gold}`);
      r.miraHundreds = hundreds;
    }
  }
}

/** 「獲得時」特性の発動回数（投資家） */
export function gainTriggerTimes(state: GameState, active: Set<AllianceId>): number {
  if (!active.has('invest')) return 1;
  return (state.stacks.invest ?? 0) >= 100 ? 3 : 2;
}

function mostStackedActive(state: GameState, active: Set<AllianceId>): AllianceId | null {
  let best: AllianceId | null = null;
  for (const id of active) {
    if (ALLIANCES[id]?.noStack) continue;
    if (best === null || (state.stacks[id] ?? 0) > (state.stacks[best] ?? 0)) best = id;
  }
  return best;
}

function distinctTiers(state: GameState, bond: AllianceId): number {
  return new Set(state.board.filter((o) => getUnit(o.defId).bonds.includes(bond)).map((o) => getUnit(o.defId).tier)).size;
}

/** 特性で獲得できるオペレーターの候補（名前と重み） */
const POOL_CHARS: Record<string, [string, number][]> = {
  pool_chess_glady: [
    ['スカジ', 1],
    ['スペクター', 1],
    ['アンダーフロー', 1],
  ],
  pool_char_pinus: [
    ['ワイルドメイン', 45],
    ['アッシュロック', 45],
    ['ファートゥース', 10],
  ],
};

const idByName = (name: string) => UNITS.find((u) => u.name === name)!.id;

const bondList = (s: unknown) => String(s ?? '').split(',').filter(Boolean).map(bondKey);

/** 1つの特性を処理する。処理できた（再現している）なら true */
function runGarrison(
  state: GameState,
  g: GarrisonData,
  unit: OwnedUnit,
  where: 'board' | 'bench',
  active: Set<AllianceId>,
): boolean {
  const bb = g.blackboard;
  const n = (k: string) => Number(bb[k] ?? 0);
  const needBoard = bb.conditionkey === 'character_target_inboard' || bb.conditionkey === 'character_same_row';
  if (needBoard && where !== 'board') return true;
  if (bb.conditionkey === 'character_same_row' && sameRow(state.board, unit).length < Number(bb.check_count ?? 0)) return true;
  const def = getUnit(unit.defId);
  const name = def.name;
  // 「有効化中の」盟約だけが対象かどうか
  const onlyActive = needBoard;
  const give = (bonds: AllianceId[], count: number) => {
    for (const b of bonds) {
      if (onlyActive && !active.has(b)) continue;
      if (count > 0) {
        addStacks(state, b, count, active);
        notify(state, `${name}：【${ALLIANCES[b].name}】+${count}`);
      }
    }
  };

  switch (g.effect) {
    case 'SERVER_ADD_BOND_CHESS_ALL':
      give(def.bonds, n('count'));
      return true;
    case 'SERVER_ADD_BOND':
      give(bondList(bb.bond), n('count'));
      return true;
    case 'SERVER_ADD_MULTIPLE_BOND': {
      const bonds = bondList(bb.bond);
      const counts = String(bb.count).split(',').map(Number);
      bonds.forEach((b, i) => give([b], counts[i] ?? 0));
      return true;
    }
    case 'SERVER_ADD_BOND_METHOD': {
      const bond = bondList(bb.bond);
      const multi = n('multi');
      if (bb.add_method === 'shoplv') give(bond, state.level * multi);
      else if (bb.add_method === 'round_gain_char') give(bond, state.round_.gained * multi);
      else if (bb.add_method === 'same_bond_diff_lv') give(bond, distinctTiers(state, bond[0]) * multi);
      else if (bb.add_method === 'same_row') give(bond, sameRow(state.board, unit).length * multi);
      // 控えのオペレーター1名ごと（ニンフ）
      else if (bb.add_method === 'hand_count') give(bond, benchUnits(state).length * multi);
      else return false;
      return true;
    }
    case 'SERVER_ADD_BOND_ACTIVATED_MOST_LAYER': {
      const b = mostStackedActive(state, active);
      if (b) {
        addStacks(state, b, n('count'), active);
        notify(state, `${name}：【${ALLIANCES[b].name}】+${n('count')}`);
      }
      return true;
    }
    case 'SERVER_ADD_ACT_BOND_DIFF_LV_MOST_LAYER': {
      const b = mostStackedActive(state, active);
      if (b) {
        const add = distinctTiers(state, b) * n('multi');
        addStacks(state, b, add, active);
        if (add) notify(state, `${name}：【${ALLIANCES[b].name}】+${add}`);
      }
      return true;
    }
    case 'SERVER_ADD_BOND_IN_HAND': {
      for (const o of benchUnits(state)) {
        give(getUnit(o.defId).bonds.filter((b) => active.has(b)), n('count'));
      }
      return true;
    }
    case 'SERVER_ADD_BOND_ROUND_COIN_COST':
      give(bondList(bb.bond), Math.floor(state.round_.spent / n('count')) * n('layer'));
      return true;
    case 'SERVER_ADD_REFRESH_CNT_MULTIPLIER_BOND_LAYER':
      give(bondList(bb.bond), Math.min(state.round_.refreshes * n('multiplier'), n('max_layer')));
      return true;
    case 'SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT':
      // 更新時に呼ばれる：このラウンド最初の手動更新なら
      if (state.round_.refreshes === n('refresh_cnt')) {
        const bonds = bondList(bb.bond).filter((b) => active.has(b));
        for (const b of bonds) {
          addStacks(state, b, n('layer'), active);
          notify(state, `${name}：【${ALLIANCES[b].name}】+${n('layer')}`);
        }
      }
      return true;
    case 'SERVER_ONCE_GOLD':
      state.pendingGold += n('count');
      notify(state, `${name}：次の準備フェーズで資金+${n('count')}`);
      return true;
    case 'SERVER_ONCE_GOLD_WITH_BOND_CONDITION': {
      const ok = where === 'board' || bondList(bb.bond).some((b) => active.has(b));
      if (ok) {
        state.pendingGold += n('count');
        notify(state, `${name}：次の準備フェーズで資金+${n('count')}`);
      }
      return true;
    }
    case 'SERVER_GAIN_FREE_REFRESH_COUNT':
      state.freeRefreshes += n('count');
      notify(state, `${name}：無料更新+${n('count')}`);
      return true;
    case 'SERVER_CHESS_PRICE':
      return true; // 価格計算側で処理
    case 'SERVER_ADD_BOND_POSITION': {
      const other = bb.dir === 'behind' ? behindOf(state.board, unit) : frontOf(state.board, unit);
      for (const o of [unit, other]) {
        if (!o) continue;
        const bonds = getUnit(o.defId).bonds.filter((b) => active.has(b));
        for (const b of bonds) addStacks(state, b, n('count'), active);
        if (bonds.length) notify(state, `${name}：${getUnit(o.defId).name}の盟約の加算数+${n('count')}`);
      }
      return true;
    }
    case 'SERVER_MOST_BOND': {
      const statuses = evaluateAlliances(state.board, benchUnits(state), state.banned);
      const top = statuses.sort((a, b) => b.count - a.count)[0];
      if (!top) return true;
      const cands = UNITS.filter((u) => u.bonds.includes(top.id) && u.tier <= state.level).map((u) => ({ id: u.id, weight: 1 }));
      gainRandom(state, cands, name);
      return true;
    }
    case 'SERVER_SELL_CHESS_GAIN_SPECIAL_GOODS': {
      // 特別招集：指定等級から3名を提示し、1名を無料で獲得
      const tier = Number(/shop_(\d)_reward/.exec(String(bb.max_pool ?? bb.pool1))?.[1] ?? 1);
      const options = rollChoices(state, Math.min(Math.max(tier, 1), 6) as Tier);
      if (options.length) {
        state.choices.push({ title: `${name}の特別招集`, options });
        notify(state, `${name}：等級${tier}の特別招集`);
      }
      return true;
    }
    case 'SERVER_GAIN_EQUIP':
      for (let i = 0; i < n('count'); i++) gainItem(state, itemKey(String(bb.chess)), name);
      return true;
    case 'SERVER_POOL_EQUIP':
      gainItemFromPool(state, String(bb.pool), name, n('count'));
      return true;
    case 'SERVER_GAIN_RANDOM_EQUIP_CHESS_IN_POOL':
      if (String(bb.round_list ?? '').split(',').map(Number).includes(state.round)) {
        // 候補が決まっている（キャサリン：ヴィクトリアの鉄鎚）ならその中から
        if (ITEM_POOLS[String(bb.pool)]) gainItemFromPool(state, String(bb.pool), name, n('count'));
        else gainRandomItem(state, name, n('count'));
      }
      return true;
    case 'SERVER_POOL_CHAR': {
      const pool = POOL_CHARS[String(bb.pool)] ?? [];
      for (let i = 0; i < n('count'); i++) gainRandom(state, pool.map(([nm, w]) => ({ id: idByName(nm), weight: w })), name);
      return true;
    }
    case 'SERVER_TRIGGER_ANOTHER':
    case 'SERVER_TRIGGER_FRONT_COUNT': {
      // 前方1マス（精鋭は前方2マスまで）のオペレーターの「獲得時」効果をそれぞれ1回発動
      const reach = g.effect === 'SERVER_TRIGGER_FRONT_COUNT' ? n('count') : 1;
      // 【投資家】が有効なら「獲得時」の特性は2回（100層で3回）
      const times = gainTriggerTimes(state, active);
      for (const front of frontsOf(state.board, unit, reach)) {
        const gains = unitState(getUnit(front.defId), front.star).garrisons.filter((fg) => fg.event === 'SERVER_GAIN');
        if (!gains.length) continue;
        notify(state, `${name}：前方の ${getUnit(front.defId).name} の獲得時の特性を発動${times > 1 ? `（【投資家】で${times}回）` : ''}`);
        for (const fg of gains) for (let i = 0; i < times; i++) runGarrison(state, fg, front, 'board', active);
      }
      return true;
    }
    case 'SERVER_FRONT_SAME_EFFECT_PREP_START':
    case 'SERVER_FRONT_SAME_EFFECT_PREP_FIN': {
      const front = frontOf(state.board, unit);
      if (!front) return true;
      const ev = g.effect === 'SERVER_FRONT_SAME_EFFECT_PREP_START' ? 'SERVER_PREP_START' : 'SERVER_PREP_FIN';
      for (const fg of unitState(getUnit(front.defId), front.star).garrisons) {
        if (fg.event !== ev || fg.effect.startsWith('SERVER_FRONT_SAME')) continue;
        runGarrison(state, fg, unit, 'board', active);
      }
      return true;
    }
    default:
      return false;
  }
}

/** 指定タイミングの特性を、対象ユニットについて発動する */
export function triggerGarrisons(
  state: GameState,
  event: ServerEvent,
  targets: { unit: OwnedUnit; where: 'board' | 'bench' }[],
  times = 1,
): void {
  const active = currentActive(state);
  for (const { unit, where } of targets) {
    for (const g of unitState(getUnit(unit.defId), unit.star).garrisons) {
      if (g.event !== event && !(event === 'SERVER_PREP_FIN' && g.id.startsWith('garrison_141'))) continue;
      for (let i = 0; i < times; i++) runGarrison(state, g, unit, where, active);
    }
  }
}

export function allTargets(state: GameState): { unit: OwnedUnit; where: 'board' | 'bench' }[] {
  return [
    ...state.board.map((unit) => ({ unit, where: 'board' as const })),
    ...benchUnits(state).map((unit) => ({ unit, where: 'bench' as const })),
  ];
}

/** 【助力】：準備フェーズ終了時、有効化中の盟約の加算数+2（3名で+4） */
export function deputBonus(state: GameState): void {
  const statuses = evaluateAlliances(state.board, benchUnits(state), state.banned);
  const deput = statuses.find((s) => s.id === 'deput');
  if (!deput || deput.level === 0) return;
  const add = deput.level >= 2 ? v('deput', 'more_layer') : v('deput', 'layer');
  const active = activeAllianceIds(statuses);
  for (const id of active) addStacks(state, id, add, active);
  notify(state, `【助力】有効化中の盟約の加算数+${add}`);
}

/** 〈配置時〉〈戦闘開始時〉に加算数を得る特性と、エーギルの捕食による加算数（戦闘前に反映） */
export function onDeployStacks(state: GameState): void {
  const battleStacks = state.round < NO_BATTLE_STACKS_FROM_ROUND;
  const statuses = evaluateAlliances(state.board, benchUnits(state), state.banned);
  const active = activeAllianceIds(statuses);
  const egir = statuses.find((s) => s.id === 'egir');
  if (egir && egir.level > 0) {
    const dv = egirDevour(state.board, new Set(egir.memberUids), v('egir', 'damage_value'));
    if (dv.stacks > 0) {
      addStacks(state, 'egir', dv.stacks, active);
      notify(state, `【エーギル】捕食：加算数+${dv.stacks}`);
    }
  }
  const garrisons = effectiveGarrisons(state.board);
  // シヴィライト・エテルナ：前方1マスのオペレーターが特性で加算数を増やした時、さらに追加
  const bonusGain = new Map<number, number>();
  for (const o of state.board) {
    for (const g of garrisons.get(o.uid) ?? []) {
      if (g.blackboard.key !== 'act1autochess_gar_event_addition_cnt') continue;
      const front = frontOf(state.board, o);
      if (front) bonusGain.set(front.uid, (bonusGain.get(front.uid) ?? 0) + Number(g.blackboard.extra_cnt ?? 0));
    }
  }
  for (const o of state.board) {
    const def = getUnit(o.defId);
    for (const g of garrisons.get(o.uid) ?? []) {
      const bb = g.blackboard;
      if (g.event !== 'IN_BATTLE' || bb.key !== 'act2autochess_gar_event_onstart' || bb.bond_add_type !== 'by_count') continue;
      // ラウンド14・15は戦闘中の加算数が無効（配置時も戦闘中に含む）
      if (!battleStacks) continue;
      const bonds = bb.bond_type === 'bond_self' ? def.bonds : bondList(bb.bond_id);
      const count = Math.min(Number(bb.bond_add_count ?? 0), Number(bb.max_add_count_per_battle ?? Infinity));
      const bonus = bonusGain.get(o.uid) ?? 0;
      for (const b of bonds) {
        if (!active.has(b) || count <= 0) continue;
        addStacks(state, b, count + bonus, active);
        notify(state, `${def.name}（配置時）：【${ALLIANCES[b].name}】+${count}${bonus ? `（シヴィライト・エテルナ +${bonus}）` : ''}`);
      }
    }
  }
}
