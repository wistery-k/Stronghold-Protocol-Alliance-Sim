import { ALLIANCES, ALLIANCE_IDS, CORE_IDS, v } from './data/alliances';
import { getUnit, isRanged, unitState } from './data/units';
import type { AllianceId, GarrisonData, Modifier, OwnedUnit } from './types';

export interface AllianceStatus {
  id: AllianceId;
  /** 数えた人数（異なるオペレーター数。調和の+1を含む） */
  count: number;
  /** 発動段階（0 = 未発動） */
  level: number;
  /** 次の段階に必要な人数（最大段階なら null） */
  next: number | null;
  /** 効果を受ける盤面ユニットの uid */
  memberUids: number[];
}

/** 大陸版データの盟約ID（"yanShip" など）をこのプロジェクトのIDに変換 */
export const bondKey = (s: string) => s.replace(/Ship$/, '') as AllianceId;

export function unitAlliances(defId: string): AllianceId[] {
  return getUnit(defId).bonds;
}

function distinctCount(units: OwnedUnit[]): number {
  return new Set(units.map((u) => getUnit(u.defId).charId)).size;
}

/**
 * 盟約の発動状況を求める。
 * - 同じオペレーターは1名として数える
 * - 先見・奇跡・投資家は控えのオペレーターも数える
 * - 調和が有効なら、盤面に所属者がいる核心盟約の人数+1
 */
export function evaluateAlliances(board: OwnedUnit[], bench: OwnedUnit[] = []): AllianceStatus[] {
  const counts = new Map<AllianceId, { count: number; members: OwnedUnit[] }>();
  for (const id of ALLIANCE_IDS) {
    const def = ALLIANCES[id];
    const onBoard = board.filter((o) => unitAlliances(o.defId).includes(id));
    const pool = def.countMode === 'boardAndBench' ? [...onBoard, ...bench.filter((o) => unitAlliances(o.defId).includes(id))] : onBoard;
    counts.set(id, { count: distinctCount(pool), members: onBoard });
  }

  const maniActive = (counts.get('mani')?.count ?? 0) >= 1;
  const maniUnits = counts.get('mani')?.members ?? [];

  const result: AllianceStatus[] = [];
  for (const id of ALLIANCE_IDS) {
    const def = ALLIANCES[id];
    let { count, members } = counts.get(id)!;
    if (maniActive && CORE_IDS.includes(id as never) && count > 0) {
      count += 1;
    }
    if (count === 0) continue;
    let level = 0;
    let next: number | null = null;
    if (def.countMode === 'exactlyOne') {
      level = count === 1 ? 1 : 0;
    } else {
      def.thresholds.forEach((t, i) => {
        if (count >= t) level = i + 1;
      });
      next = def.thresholds.find((t) => t > count) ?? null;
    }
    // 調和の所属者は有効化中の核心盟約の効果を受ける
    if (maniActive && level > 0 && CORE_IDS.includes(id as never)) {
      members = [...members, ...maniUnits.filter((m) => !members.includes(m))];
    }
    result.push({ id, count, level, next, memberUids: members.map((m) => m.uid) });
  }
  return result.sort((a, b) => b.level - a.level || b.count - a.count);
}

export function activeAllianceIds(statuses: AllianceStatus[]): Set<AllianceId> {
  return new Set(statuses.filter((s) => s.level > 0).map((s) => s.id));
}

// ------------------------------------------------------------
// 戦闘用の補正計算
// ------------------------------------------------------------

export interface BattleGlobals {
  /** サルゴン：スキル発動で所属者全員に時限バフ */
  sargon?: { members: Set<number>; aspd: number; atkPct: number; duration: number; maxStacks: number };
  /** シラクーザ：配置後の攻撃速度上昇と確定ダメージの発生 */
  siracusa?: { members: Set<number>; aspd: number; duration: number; procProb: number; procDmg: number; procWindow: number };
  /** 秘術：術ダメージで被術ダメージ上昇を付与 */
  arcane?: { members: Set<number>; vuln: number; vulnLow: number; lowRatio: number; duration: number };
  /** ラテラーノLv2：弾薬消費でラテラーノ全員の攻撃力上昇 */
  laterano?: { members: Set<number>; atkPerAmmo: number; maxAtk: number };
  /** カジミエーシュLv2：近接は2秒ごとに攻撃力120%の確定ダメージ */
  kazimierzPulse?: { members: Set<number>; scale: number; interval: number };
}

export interface BattleSetup {
  statuses: AllianceStatus[];
  mods: Map<number, Modifier>;
  globals: BattleGlobals;
}

function add(m: Modifier, d: Modifier): void {
  for (const [k, val] of Object.entries(d) as [keyof Modifier, number | boolean | undefined][]) {
    if (val === undefined) continue;
    if (k === 'weakDamage') {
      m.weakDamage = m.weakDamage || (val as boolean);
    } else if (k === 'damageMult') {
      m.damageMult = (m.damageMult ?? 1) * (val as number);
    } else {
      (m as Record<string, number>)[k] = ((m as Record<string, number>)[k] ?? 0) + (val as number);
    }
  }
}

/** 戦闘中に効く堅守特性（攻撃力上昇など）を補正に変換。再現していない特性は null */
export function garrisonBattleModifier(g: GarrisonData, stacks: Partial<Record<AllianceId, number>>): Modifier | null {
  if (g.event !== 'IN_BATTLE' || g.effect !== 'GAIN_BUFF') return null;
  const bb = g.blackboard;
  const key = bb.key as string | undefined;
  const n = (k: string) => Number(bb[k] ?? 0);
  const bondStacks = () =>
    String(bb.bond_id ?? '')
      .split(',')
      .filter(Boolean)
      .reduce((sum, b) => sum + (stacks[bondKey(b)] ?? 0), 0);

  if (key === undefined && bb.atk !== undefined) return { atkPct: n('atk') - 1 };
  if (key === 'attr_common_global_buff') return { spRegen: n('sp_recovery_per_sec') };
  if (key === 'act1autochess_gar_eff_chaos') return { weakDamage: true };
  if (key === 'act1autochess_gar_eff_attrByBond') {
    const times = Math.floor(bondStacks() / n('divide_num'));
    return { atkPct: times * n('atk'), aspd: times * n('attack_speed'), spRegen: times * n('sp_recovery_per_sec') };
  }
  if (key === 'act2autochess_gar_eff_attrByBond_add_onstart') {
    const times = Math.floor(bondStacks() / n('divide_num'));
    return { atkFlat: times * n('atk') };
  }
  return null;
}

/** DPS チェックに反映している堅守特性かどうか（UI表示用） */
export function isGarrisonImplemented(g: GarrisonData): boolean {
  if (g.event === 'IN_BATTLE') {
    if (g.effect === 'GAIN_BUFF') {
      const key = g.blackboard.key as string | undefined;
      return (
        (key === undefined && g.blackboard.atk !== undefined) ||
        key === 'attr_common_global_buff' ||
        key === 'act1autochess_gar_eff_chaos' ||
        key === 'act1autochess_gar_eff_attrByBond' ||
        key === 'act2autochess_gar_eff_attrByBond_add_onstart'
      );
    }
    if (g.effect === 'ADD_BOND') {
      const key = g.blackboard.key as string | undefined;
      return (
        g.blackboard.bond_add_type === 'by_count' &&
        ['act1autochess_gar_event_useskill', 'act1autochess_gar_event_selfkillenemy', 'act1autochess_gar_event_consume_ammo', 'act2autochess_gar_event_onstart'].includes(
          key ?? '',
        )
      );
    }
    return g.effect === 'NONE';
  }
  if (g.blackboard.conditionkey === 'character_same_row' || g.blackboard.add_method === 'same_row') return false;
  return IMPLEMENTED_SERVER_EFFECTS.has(g.effect);
}

export const IMPLEMENTED_SERVER_EFFECTS = new Set([
  'SERVER_ADD_BOND_CHESS_ALL',
  'SERVER_ADD_BOND',
  'SERVER_ADD_MULTIPLE_BOND',
  'SERVER_ADD_BOND_METHOD',
  'SERVER_ADD_BOND_ACTIVATED_MOST_LAYER',
  'SERVER_ADD_ACT_BOND_DIFF_LV_MOST_LAYER',
  'SERVER_ADD_BOND_IN_HAND',
  'SERVER_ADD_BOND_ROUND_COIN_COST',
  'SERVER_ADD_REFRESH_CNT_MULTIPLIER_BOND_LAYER',
  'SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT',
  'SERVER_ONCE_GOLD',
  'SERVER_ONCE_GOLD_WITH_BOND_CONDITION',
  'SERVER_GAIN_FREE_REFRESH_COUNT',
  'SERVER_CHESS_PRICE',
]);

/** 盤面から、各ユニットの補正と戦闘中の全体効果を計算する */
export function battleSetup(
  board: OwnedUnit[],
  bench: OwnedUnit[],
  stacks: Partial<Record<AllianceId, number>>,
): BattleSetup {
  const statuses = evaluateAlliances(board, bench);
  const mods = new Map<number, Modifier>();
  for (const o of board) mods.set(o.uid, {});
  const globals: BattleGlobals = {};
  const st = (id: AllianceId) => statuses.find((s) => s.id === id);
  const lv = (id: AllianceId) => st(id)?.level ?? 0;
  const members = (id: AllianceId) => new Set(st(id)?.memberUids ?? []);
  const sk = (id: AllianceId) => stacks[id] ?? 0;
  const apply = (uids: Iterable<number>, d: Modifier) => {
    for (const uid of uids) if (mods.has(uid)) add(mods.get(uid)!, d);
  };
  const all = board.map((o) => o.uid);

  // 炎
  if (lv('yan') >= 1) apply(members('yan'), { atkPct: v('yan', 'base_atk') + v('yan', 'atk_per_stack') * sk('yan') });
  // サルゴン
  if (lv('sargon') >= 1) {
    globals.sargon = {
      members: members('sargon'),
      aspd: v('sargon', 'base_attack_speed'),
      atkPct: lv('sargon') >= 2 ? v('sargon', 'base_atk') : 0,
      duration: v('sargon', 'base_time') + v('sargon', 'time_per_stack') * sk('sargon'),
      maxStacks: v('sargon', 'max_buff_stack_cnt'),
    };
  }
  // イェラグ（寒冷・凍結の追加倍率は未再現）
  if (lv('kjerag') >= 1) apply(members('kjerag'), { damageMult: v('kjerag', 'base_damage_scale') });
  // ラテラーノ
  if (lv('laterano') >= 1) {
    apply(members('laterano'), { ammoPct: v('laterano', 'base_ammo_percent') + v('laterano', 'ammo_percent_per_stack') * sk('laterano') });
    if (lv('laterano') >= 2) {
      globals.laterano = { members: members('laterano'), atkPerAmmo: v('laterano', 'atk_per_consume'), maxAtk: v('laterano', 'max_atk_for_consume') };
    }
  }
  // シラクーザ
  if (lv('siracusa') >= 1) {
    const duration = v('siracusa', 'base_duration') + v('siracusa', 'duration_per_stack') * sk('siracusa');
    globals.siracusa = {
      members: members('siracusa'),
      aspd: v('siracusa', 'base_attack_speed') + v('siracusa', 'attack_speed_per_stack') * sk('siracusa'),
      duration,
      procProb: lv('siracusa') >= 2 ? v('siracusa', 'prob') : 0,
      procDmg: v('siracusa', 'base_damage') + v('siracusa', 'damage_per_stack') * sk('siracusa'),
      procWindow: duration + v('siracusa', 'end_duration'),
    };
  }
  // カジミエーシュ：戦闘開始時に盤面の全員が配置される扱い
  if (lv('kazimierz') >= 1) {
    const cap = v('kazimierz', 'base_max_atk_when_born') + v('kazimierz', 'max_atk_when_born_per_stack') * sk('kazimierz');
    apply(members('kazimierz'), { atkPct: Math.min(v('kazimierz', 'atk_when_born') * board.length, cap) });
    if (lv('kazimierz') >= 2) {
      const ranged = [...members('kazimierz')].filter((uid) => isRanged(getUnit(board.find((o) => o.uid === uid)!.defId)));
      const melee = [...members('kazimierz')].filter((uid) => !ranged.includes(uid));
      apply(ranged, { trueDmgPct: v('kazimierz', 'pure_atk_scale') });
      globals.kazimierzPulse = { members: new Set(melee), scale: v('kazimierz', 'damage_atk_scale'), interval: v('kazimierz', 'damage_interval') };
    }
  }
  // 精密
  if (lv('preci') >= 1) {
    const targets = new Set(members('preci'));
    if (lv('preci') >= 2) for (const o of board) if (isRanged(getUnit(o.defId))) targets.add(o.uid);
    apply(targets, { atkPct: v('preci', 'base_atk') + v('preci', 'atk_per_stack') * sk('preci') });
    if (lv('preci') >= 2) apply(targets, { defIgnorePct: v('preci', 'power_def_penetrate'), resIgnorePct: v('preci', 'power_magic_resist_penetrate') });
  }
  // 俊敏：確率でSP回復 → 期待値で扱う
  if (lv('swift') >= 1) {
    const p = Math.min(1, v('swift', 'base_prob') + v('swift', 'prob_per_stack') * sk('swift'));
    apply(members('swift'), { spOnSkillEnd: p * v('swift', 'normal_sp') });
    if (sk('swift') >= v('swift', 'power_bond_stack_cnt')) apply(all, { spOnSkillEnd: p * v('swift', 'power_sp') });
  }
  // 器用（配置位置がまだ無いので所属者のみ）
  if (lv('skillful') >= 1) apply(members('skillful'), { aspd: v('skillful', 'base_attack_speed') + v('skillful', 'attack_speed_per_stack') * sk('skillful') });
  // 秘術
  if (lv('arcane') >= 1) {
    globals.arcane = {
      members: members('arcane'),
      vuln: v('arcane', 'base_damage_scale_show') + v('arcane', 'damage_scale_per_stack') * sk('arcane'),
      vulnLow: lv('arcane') >= 2 ? v('arcane', 'base_damage_scale_show_ex') + v('arcane', 'damage_scale_per_stack_show_ex') * sk('arcane') : 0,
      lowRatio: v('arcane', 'hp_ratio'),
      duration: v('arcane', 'weak_duration'),
    };
  }
  // 強襲：50層で全員の攻撃速度+50
  if (lv('raid') >= 1 && sk('raid') >= v('raid', 'power_bond_stack_cnt')) apply(all, { aspd: v('raid', 'power_attack_speed') });
  // 共同防衛
  if (lv('empty') >= 1) {
    for (const uid of members('empty')) {
      const o = board.find((b) => b.uid === uid)!;
      apply([uid], { damageMult: o.star === 2 ? v('empty', 'damage_scale_extra') : v('empty', 'damage_scale_normal') });
    }
  }
  // 孤高
  if (lv('solo') >= 1) apply(members('solo'), { atkPct: v('solo', 'atk'), startSp: v('solo', 'sp') });

  // 堅守特性（戦闘中のバフ）
  for (const o of board) {
    for (const g of unitState(getUnit(o.defId), o.star).garrisons) {
      const m = garrisonBattleModifier(g, stacks);
      if (m) add(mods.get(o.uid)!, m);
    }
  }

  return { statuses, mods, globals };
}
