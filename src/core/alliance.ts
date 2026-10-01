import { ALLIANCES, ALLIANCE_IDS, CORE_IDS, v } from './data/alliances';
import { GIVEN_GARRISONS, getUnit, isRanged, unitState } from './data/units';
import { getItem, itemState } from './data/items';
import { egirDevour, frontOf, neighbors, rightmostInRow, sameRow, sidesOf } from './board';
import type { AllianceId, GarrisonData, Modifier, OwnedUnit } from './types';

export interface AllianceStatus {
  id: AllianceId;
  /** 数えた人数（異なるオペレーター数。調和の+1を含む） */
  count: number;
  /** 発動段階（0 = 未発動） */
  level: number;
  /** 次の段階に必要な人数（最大段階なら null） */
  next: number | null;
  /** 盟約BANされている */
  banned?: boolean;
  /** 効果を受ける盤面ユニットの uid */
  memberUids: number[];
}

/** 大陸版データの盟約ID（"yanShip" など）をこのプロジェクトのIDに変換 */
export const bondKey = (s: string) => s.replace(/Ship$/, '') as AllianceId;

export function unitAlliances(defId: string): AllianceId[] {
  return getUnit(defId).bonds;
}

/** 所持ユニットの盟約（変形同位体で追加された盟約を含む） */
export function ownedBonds(o: OwnedUnit): AllianceId[] {
  const bonds = [...getUnit(o.defId).bonds];
  const items = o.items ?? [];
  if (items.some((i) => getItem(i.itemId).canGiveBond)) {
    for (const i of items) {
      const b = getItem(i.itemId).giveBond;
      if (b && !bonds.includes(b)) bonds.push(b);
    }
  }
  return bonds;
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
export function evaluateAlliances(board: OwnedUnit[], bench: OwnedUnit[] = [], banned: AllianceId[] = []): AllianceStatus[] {
  const counts = new Map<AllianceId, { count: number; members: OwnedUnit[] }>();
  for (const id of ALLIANCE_IDS) {
    const def = ALLIANCES[id];
    const onBoard = board.filter((o) => ownedBonds(o).includes(id));
    const pool = def.countMode === 'boardAndBench' ? [...onBoard, ...bench.filter((o) => ownedBonds(o).includes(id))] : onBoard;
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
    result.push({ id, count, level, next, memberUids: members.map((m) => m.uid), banned: banned.includes(id) || undefined });
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
  /** 黄砂のコンパス＋サルゴンの渋茶：サルゴンのスキル発動で全サルゴンのSP回復 */
  sargonSpOnSkill?: { members: Set<number>; sp: number };
}

export interface BattleOptions {
  banned?: AllianceId[];
  /** このラウンドに獲得したオペレーター数（天師の祭器） */
  roundGained?: number;
}

export interface BattleSetup {
  statuses: AllianceStatus[];
  mods: Map<number, Modifier>;
  globals: BattleGlobals;
  /** 各ユニットが戦闘中に持つ特性（他のオペレーターから付与されたものを含む） */
  garrisons: Map<number, GarrisonData[]>;
  /** 同じ行のオペレーター数 */
  rowCount: Map<number, number>;
  /** 特性で加算数が増える時の追加量（シヴィライト・エテルナ） */
  bonusGain: Map<number, number>;
  /** 戦闘開始時に倒れているユニット（エーギルの捕食） */
  excluded: Set<number>;
}

/** 特性を付与する特性の対象（付与元の特性IDの番号 → 対象） */
const GIVE_TARGET: Record<string, 'front' | 'selfFront' | 'rowRightmost' | 'frontKjerag' | 'siracusaAll'> = {
  '72': 'front',
  '73': 'front',
  '145': 'selfFront',
  '160': 'selfFront',
  '148': 'rowRightmost',
  '126': 'frontKjerag',
  '118': 'siracusaAll',
};

/** 盤面の各ユニットが戦闘中に持つ特性（自身の特性＋付与された特性） */
export function effectiveGarrisons(board: OwnedUnit[]): Map<number, GarrisonData[]> {
  const out = new Map<number, GarrisonData[]>();
  for (const o of board) out.set(o.uid, [...unitState(getUnit(o.defId), o.star).garrisons]);
  for (const o of board) {
    for (const g of unitState(getUnit(o.defId), o.star).garrisons) {
      const gid = g.blackboard.give_garrison_id as string | undefined;
      if (!gid || !GIVEN_GARRISONS[gid]) continue;
      const kind = GIVE_TARGET[g.id.split('_')[1]] ?? 'front';
      const front = frontOf(board, o);
      let targets: OwnedUnit[] = [];
      if (kind === 'front' && front) targets = [front];
      else if (kind === 'selfFront') targets = front ? [o, front] : [o];
      else if (kind === 'rowRightmost') targets = [rightmostInRow(board, o)].filter((x): x is OwnedUnit => !!x);
      else if (kind === 'frontKjerag' && front && getUnit(front.defId).bonds.includes('kjerag')) targets = [front];
      else if (kind === 'siracusaAll') targets = board.filter((b) => getUnit(b.defId).bonds.includes('siracusa'));
      for (const t of targets) out.get(t.uid)!.push(GIVEN_GARRISONS[gid]);
    }
  }
  return out;
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
  if (key === 'act1autochess_gar_eff_respawnTimeByBond') {
    // 説明文では再配置時間短縮に加えて攻撃速度が上がる（-1.5%ごとに+0.5）
    const times = Math.floor(bondStacks() / n('divide_num'));
    return { aspd: (times * -n('respawn_time')) / 0.03 };
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
        key === 'act2autochess_gar_eff_attrByBond_add_onstart' ||
        key === 'act1autochess_gar_eff_respawnTimeByBond' ||
        key === 'act1autochess_gar_event_addition_cnt'
      );
    }
    if (g.effect === 'ADD_BOND') {
      const key = g.blackboard.key as string | undefined;
      const give = g.blackboard.give_garrison_id as string | undefined;
      if (give) return !!GIVEN_GARRISONS[give] && isGarrisonImplemented(GIVEN_GARRISONS[give]);
      return (
        ['by_count', 'by_charcount_samerow'].includes(String(g.blackboard.bond_add_type)) &&
        ['act1autochess_gar_event_useskill', 'act1autochess_gar_event_selfkillenemy', 'act1autochess_gar_event_consume_ammo', 'act2autochess_gar_event_onstart'].includes(
          key ?? '',
        )
      );
    }
    return g.effect === 'NONE';
  }
  if (g.effect === 'SERVER_POOL_CHAR') return true;
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
  'SERVER_ADD_BOND_POSITION',
  'SERVER_SELL_CHESS_GAIN_SPECIAL_GOODS',
  'SERVER_GAIN_EQUIP',
  'SERVER_POOL_EQUIP',
  'SERVER_GAIN_RANDOM_EQUIP_CHESS_IN_POOL',
  'SERVER_MOST_BOND',
  'SERVER_TRIGGER_ANOTHER',
  'SERVER_TRIGGER_FRONT_COUNT',
  'SERVER_FRONT_SAME_EFFECT_PREP_START',
  'SERVER_FRONT_SAME_EFFECT_PREP_FIN',
]);

/** 盤面から、各ユニットの補正と戦闘中の全体効果を計算する */
export function battleSetup(
  board: OwnedUnit[],
  bench: OwnedUnit[],
  stacks: Partial<Record<AllianceId, number>>,
  opts: BattleOptions = {},
): BattleSetup {
  const statuses = evaluateAlliances(board, bench, opts.banned ?? []);
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

  // ヴィクトリア：装備を持つ所属者の与ダメージ上昇、Lv2で装備1つごとに攻撃力上昇
  if (lv('victoria') >= 1) {
    for (const uid of members('victoria')) {
      const o = board.find((b) => b.uid === uid);
      const items = o?.items ?? [];
      if (!items.length) continue;
      apply([uid], { damageMult: v('victoria', 'base_damage_scale') + v('victoria', 'damage_scale_per_stack') * sk('victoria') });
      if (lv('victoria') >= 2) {
        const atk = items.reduce((sum, i) => sum + v('victoria', 'atk_normal_equip') + (i.star === 2 ? v('victoria', 'atk_golden_equip') : 0), 0);
        apply([uid], { atkPct: atk });
      }
    }
  }
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
  // 器用：所属者と周囲4マス（40層で8マス）
  if (lv('skillful') >= 1) {
    const eight = sk('skillful') >= v('skillful', 'power_bond_stack_cnt');
    const targets = new Set<number>();
    for (const uid of members('skillful')) {
      const o = board.find((b) => b.uid === uid);
      if (!o) continue;
      targets.add(uid);
      for (const n of neighbors(board, o, eight)) targets.add(n.uid);
    }
    apply(targets, { aspd: v('skillful', 'base_attack_speed') + v('skillful', 'attack_speed_per_stack') * sk('skillful') });
  }
  // エーギル：前方1マスを捕食して基礎攻撃力を得る
  let excluded = new Set<number>();
  if (lv('egir') >= 1) {
    const dv = egirDevour(board, members('egir'), v('egir', 'damage_value'));
    for (const [uid, atk] of dv.atkGain) apply([uid], { atkFlat: atk });
    excluded = dv.dead;
  }
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

  // 装備
  for (const o of board) {
    for (const it of o.items ?? []) {
      const def = getItem(it.itemId);
      for (const b of itemState(def, it.star).buffs) {
        const n = (k: string) => Number(b[k] ?? 0);
        const has = (id: string) => (o.items ?? []).some((x) => x.itemId === id);
        const bonds = ownedBonds(o);
        switch (b.key) {
          case 'attr_common_global_buff':
          case 'act1autochess_equip_acarm044_global_buff':
            apply([o.uid], { atkPct: n('atk'), aspd: n('attack_speed') });
            break;
          case 'act1autochess_equip_acarm050_global_buff':
            apply([o.uid], { spRegen: n('sp_recovery_per_sec') });
            break;
          case 'magic_penetrate_global_buff':
            apply([o.uid], { resIgnorePct: n('magic_resist_penetrate') });
            break;
          case 'act1autochess_equip_acarm063_global_buff':
            if (isRanged(getUnit(o.defId))) apply([o.uid], { damageMult: n('damage_scale') });
            break;
          case 'act1vautochess_equip_acarm024_global_buff':
            apply([o.uid], { atkPerCast: n('atk'), atkPerCastMax: n('atk_buff_cnt') });
            break;
          case 'act1autochess_equip_acarm051_global_buff': {
            const others = board.filter((x) => x !== o && ownedBonds(x).some((bb) => bonds.includes(bb))).length;
            apply([o.uid], { startSp: n('sp_each_person') * (1 + others) });
            break;
          }
          case 'act1vautochess_equip_acarm037_global_buff':
            apply([o.uid], { aspdPerAttack: n('attack_speed'), aspdPerAttackMax: n('max_buff_cnt') });
            break;
          case 'act2autochess_equip_acarm120_global_buff':
            apply([o.uid], { flagScale: n('damage_scale'), flagDuration: n('interval'), flagStep: n('ex_interval'), flagMinus: n('damage_scale_minus') });
            break;
          case 'act1autochess_equip_acarm067_global_buff':
            apply([o.uid], { weakDamage: true });
            break;
          case 'act2autochess_equip_acarm117_global_buff':
            if (has('5_09')) apply([o.uid], { trueDmgPct: n('atk_scale') });
            break;
          case 'act1autochess_equip_acarm076_global_buff':
            if (bonds.includes('laterano')) apply([o.uid], { extraShotProb: n('prob'), extraShotScale: has('4_08') ? n('atk_scale_2') : n('atk_scale_1') });
            break;
          case 'act1autochess_equip_acarm077_global_buff':
            if (bonds.includes('yan')) apply([o.uid], { aspd: Math.min(opts.roundGained ?? 0, n('max_cnt')) * n('attack_speed') });
            break;
          case 'act1autochess_equip_acarm103_global_buff':
            apply([o.uid], { startSp: n('init_sp') });
            if (bonds.includes('sargon')) {
              apply([o.uid], { firstSkillEndSp: n('sp') });
              if (has('2_04') && lv('sargon') >= 1) {
                globals.sargonSpOnSkill = { members: members('sargon'), sp: (globals.sargonSpOnSkill?.sp ?? 0) + n('addition_sp') };
              }
            }
            break;
          case 'act1autochess_equip_acarm079_global_buff':
            // 蒸気の心臓：【ヴィクトリア】が装備すると盤面の加速ハンマーの効果を得る（自身が持っていれば2倍）
            if (bonds.includes('victoria') && board.some((x) => (x.items ?? []).some((i) => i.itemId === '3_10'))) {
              apply([o.uid], { aspd: n('attack_speed') * (has('3_10') ? 2 : 1) });
            }
            break;
          case 'act2autochess_equip_acarm121_ability':
            for (const side of sidesOf(board, o)) apply([side.uid], { aspd: n('attack_speed') });
            break;
        }
      }
    }
  }

  // 堅守特性（付与されたものを含む）
  const garrisons = effectiveGarrisons(board);
  const rowCount = new Map<number, number>();
  const bonusGain = new Map<number, number>();
  for (const o of board) {
    rowCount.set(o.uid, sameRow(board, o).length);
    for (const g of garrisons.get(o.uid) ?? []) {
      const m = garrisonBattleModifier(g, stacks);
      if (m) add(mods.get(o.uid)!, m);
      if (g.blackboard.key === 'act1autochess_gar_event_addition_cnt') {
        const front = frontOf(board, o);
        if (front) bonusGain.set(front.uid, (bonusGain.get(front.uid) ?? 0) + Number(g.blackboard.extra_cnt ?? 0));
      }
    }
  }

  return { statuses, mods, globals, garrisons, rowCount, bonusGain, excluded };
}
