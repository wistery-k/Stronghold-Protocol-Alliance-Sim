import { evaluateAlliances, activeAllianceIds, bondKey } from './alliance';
import { ALLIANCES, v } from './data/alliances';
import { getUnit, unitState } from './data/units';
import type { GameState } from './game';
import type { AllianceId, GarrisonData, OwnedUnit } from './types';

// 堅守特性のうち、準備フェーズ側（獲得時・準備フェーズ開始/終了時・売却時・更新時）の処理

export type ServerEvent = 'SERVER_GAIN' | 'SERVER_PREP_START' | 'SERVER_PREP_FIN' | 'SERVER_CHESS_SOLD' | 'SERVER_REFRESH_SHOP';

export function benchUnits(state: GameState): OwnedUnit[] {
  return state.bench.filter((b): b is OwnedUnit => b !== null);
}

export function currentActive(state: GameState): Set<AllianceId> {
  return activeAllianceIds(evaluateAlliances(state.board, benchUnits(state)));
}

/** 加算数を増やし、加算数に応じた報酬（先見・奇跡）を処理する */
export function addStacks(state: GameState, bond: AllianceId, n: number, active?: Set<AllianceId>): void {
  if (n <= 0) return;
  state.stacks[bond] = (state.stacks[bond] ?? 0) + n;
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
      state.log.push(`【先見】加算数${s}：資金+${gold}`);
      r.visiTens = tens;
    }
    if (s >= v('visi', 'layer1') && !r.visiDiscount) {
      r.visiDiscount = true;
      state.log.push('【先見】80層：【先見】の購入価格-1');
    }
    if (s >= v('visi', 'layer2') && !r.allDiscount) {
      r.allDiscount = true;
      state.log.push('【先見】150層：すべての購入価格-1');
    }
  }
  if (active.has('mira')) {
    const s = state.stacks.mira ?? 0;
    const hundreds = Math.floor(s / 100);
    if (hundreds > r.miraHundreds) {
      const gold = (hundreds - r.miraHundreds) * 20;
      state.gold += gold;
      state.log.push(`【奇跡】加算数${s}：資金+${gold}`);
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
    if (best === null || (state.stacks[id] ?? 0) > (state.stacks[best] ?? 0)) best = id;
  }
  return best;
}

function distinctTiers(state: GameState, bond: AllianceId): number {
  return new Set(state.board.filter((o) => getUnit(o.defId).bonds.includes(bond)).map((o) => getUnit(o.defId).tier)).size;
}

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
  const needBoard = bb.conditionkey === 'character_target_inboard';
  if (bb.conditionkey === 'character_same_row') return false;
  if (needBoard && where !== 'board') return true;
  const def = getUnit(unit.defId);
  const name = def.name;
  // 「有効化中の」盟約だけが対象かどうか
  const onlyActive = needBoard;
  const give = (bonds: AllianceId[], count: number) => {
    for (const b of bonds) {
      if (onlyActive && !active.has(b)) continue;
      if (count > 0) {
        addStacks(state, b, count, active);
        state.log.push(`${name}：【${ALLIANCES[b].name}】+${count}`);
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
      else return false;
      return true;
    }
    case 'SERVER_ADD_BOND_ACTIVATED_MOST_LAYER': {
      const b = mostStackedActive(state, active);
      if (b) {
        addStacks(state, b, n('count'), active);
        state.log.push(`${name}：【${ALLIANCES[b].name}】+${n('count')}`);
      }
      return true;
    }
    case 'SERVER_ADD_ACT_BOND_DIFF_LV_MOST_LAYER': {
      const b = mostStackedActive(state, active);
      if (b) {
        const add = distinctTiers(state, b) * n('multi');
        addStacks(state, b, add, active);
        if (add) state.log.push(`${name}：【${ALLIANCES[b].name}】+${add}`);
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
          state.log.push(`${name}：【${ALLIANCES[b].name}】+${n('layer')}`);
        }
      }
      return true;
    case 'SERVER_ONCE_GOLD':
      state.pendingGold += n('count');
      state.log.push(`${name}：次の準備フェーズで資金+${n('count')}`);
      return true;
    case 'SERVER_ONCE_GOLD_WITH_BOND_CONDITION': {
      const ok = where === 'board' || bondList(bb.bond).some((b) => active.has(b));
      if (ok) {
        state.pendingGold += n('count');
        state.log.push(`${name}：次の準備フェーズで資金+${n('count')}`);
      }
      return true;
    }
    case 'SERVER_GAIN_FREE_REFRESH_COUNT':
      state.freeRefreshes += n('count');
      state.log.push(`${name}：無料更新+${n('count')}`);
      return true;
    case 'SERVER_CHESS_PRICE':
      return true; // 価格計算側で処理
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
  const statuses = evaluateAlliances(state.board, benchUnits(state));
  const deput = statuses.find((s) => s.id === 'deput');
  if (!deput || deput.level === 0) return;
  const add = deput.level >= 2 ? v('deput', 'more_layer') : v('deput', 'layer');
  const active = activeAllianceIds(statuses);
  for (const id of active) addStacks(state, id, add, active);
  state.log.push(`【助力】有効化中の盟約の加算数+${add}`);
}

/** 〈配置時〉〈戦闘開始時〉に加算数を得る特性（戦闘前に反映） */
export function onDeployStacks(state: GameState): void {
  const active = currentActive(state);
  for (const o of state.board) {
    const def = getUnit(o.defId);
    for (const g of unitState(def, o.star).garrisons) {
      const bb = g.blackboard;
      if (g.event !== 'IN_BATTLE' || bb.key !== 'act2autochess_gar_event_onstart' || bb.bond_add_type !== 'by_count') continue;
      const bonds = bb.bond_type === 'bond_self' ? def.bonds : bondList(bb.bond_id);
      const count = Math.min(Number(bb.bond_add_count ?? 0), Number(bb.max_add_count_per_battle ?? Infinity));
      for (const b of bonds) {
        if (!active.has(b)) continue;
        addStacks(state, b, count, active);
        state.log.push(`${def.name}（配置時）：【${ALLIANCES[b].name}】+${count}`);
      }
    }
  }
}
