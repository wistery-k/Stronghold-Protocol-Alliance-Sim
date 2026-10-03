import { GAMEDATA } from './units';
import type { AllianceId, CoreAllianceId } from '../types';

// 盟約の名称・発動人数・効果説明。数値は本家データ（gamedata.json の bonds）から読む。
// 効果のうち戦闘に反映しているものは alliance.ts で計算している。

export type CountMode = 'board' | 'boardAndBench' | 'exactlyOne' | 'elite';

export interface AllianceTier {
  /** 必要人数 */
  count: number;
  text: string;
  /** 戦闘で再現していない効果 */
  notSimulated?: boolean;
}

export interface AllianceDef {
  id: AllianceId;
  name: string;
  kind: 'core' | 'extra';
  thresholds: number[];
  countMode: CountMode;
  /** 加算数 stacks のときの効果説明（段階ごと） */
  describe: (stacks: number) => AllianceTier[];
  /** 加算数を持たない（秘技） */
  noStack?: boolean;
  /** 加算数による追加効果（○層到達で〜） */
  stackMilestones?: (stacks: number) => { at: number; text: string; reached: boolean }[];
}

export const v = (id: AllianceId, key: string): number => GAMEDATA.bonds[id]?.values[key] ?? 0;

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const num = (x: number) => `${Math.round(x * 100) / 100}`;

export const CORE_IDS: CoreAllianceId[] = ['yan', 'sargon', 'victoria', 'kjerag', 'laterano', 'egir', 'siracusa', 'kazimierz'];

export const ALLIANCES: Record<AllianceId, AllianceDef> = {
  // ===================== 核心盟約 =====================
  yan: {
    id: 'yan',
    name: '炎',
    kind: 'core',
    thresholds: [3, 6, 9],
    countMode: 'board',
    describe: (s) => [
      { count: 3, text: `【炎】の攻撃力+${pct(v('yan', 'base_atk') + v('yan', 'atk_per_stack') * s)}` },
      { count: 6, text: '戦闘開始時、【炎】の攻撃力・HP合計の30%を持つ「炎佑」を召喚（3体同時攻撃、灼燃損傷・元素脆弱付与）', notSimulated: true },
      { count: 9, text: '「炎佑」を2体召喚、攻撃力1.5倍・被ダメージ-90%', notSimulated: true },
    ],
  },
  sargon: {
    id: 'sargon',
    name: 'サルゴン',
    kind: 'core',
    thresholds: [3, 6],
    countMode: 'board',
    describe: (s) => [
      {
        count: 3,
        text: `【サルゴン】がスキルを発動するたび、すべての【サルゴン】の攻撃速度+${v('sargon', 'base_attack_speed')}（最大+300）、${num(v('sargon', 'base_time') + v('sargon', 'time_per_stack') * s)}秒間`,
      },
      { count: 6, text: `スキル発動時、さらにすべての【サルゴン】の攻撃力+${pct(v('sargon', 'base_atk'))}（最大+300%）` },
    ],
  },
  victoria: {
    id: 'victoria',
    name: 'ヴィクトリア',
    kind: 'core',
    thresholds: [3, 6],
    countMode: 'board',
    describe: (s) => [
      {
        count: 3,
        text: `装備を持つ【ヴィクトリア】の与ダメージが${pct(v('victoria', 'base_damage_scale') + v('victoria', 'damage_scale_per_stack') * s)}に上昇`,
      },
      { count: 6, text: '【ヴィクトリア】は装備1つにつき攻撃力+50%（精鋭の装備は+80%）' },
    ],
    stackMilestones: (s) => [{ at: 25, text: '25層ごとにランダムなヴィクトリアの鉄鎚を獲得', reached: s >= 25 }],
  },
  kjerag: {
    id: 'kjerag',
    name: 'イェラグ',
    kind: 'core',
    thresholds: [3, 6],
    countMode: 'board',
    describe: (s) => [
      {
        count: 3,
        text: `【イェラグ】の与ダメージが${pct(v('kjerag', 'base_damage_scale'))}に上昇。寒冷・凍結した敵には${pct(v('kjerag', 'base_ex_damage_scale') + v('kjerag', 'ex_damage_scale_per_stack') * s)}`,
      },
      {
        count: 6,
        text: `25秒ごとに寒風が吹き、敵を${num(v('kjerag', 'bond_eff_kjerag[storm].base_time') + v('kjerag', 'bond_eff_kjerag[storm].time_per_stack') * s)}秒間寒冷状態にする`,
      },
    ],
  },
  laterano: {
    id: 'laterano',
    name: 'ラテラーノ',
    kind: 'core',
    thresholds: [3, 6],
    countMode: 'board',
    describe: (s) => [
      { count: 3, text: `【ラテラーノ】がスキルで得る弾薬数+${pct(v('laterano', 'base_ammo_percent') + v('laterano', 'ammo_percent_per_stack') * s)}` },
      { count: 6, text: `【ラテラーノ】が弾薬を1発消費するたび、すべての【ラテラーノ】の攻撃力+${pct(v('laterano', 'atk_per_consume'))}（最大+${pct(v('laterano', 'max_atk_for_consume'))}）` },
    ],
  },
  egir: {
    id: 'egir',
    name: 'エーギル',
    kind: 'core',
    thresholds: [3, 5],
    countMode: 'board',
    describe: (s) => [
      {
        count: 3,
        text: `【エーギル】の最大HP+${pct(v('egir', 'base_max_hp') + v('egir', 'max_hp_per_stack') * s)}。戦闘開始時、左・上の者から順に前方1マスのオペレーターを捕食し、5000の物理ダメージを与えて基礎攻撃力とブロック数を得る。被捕食者の等級ぶん加算数+`,
      },
      { count: 5, text: '最初に倒された【エーギル】3名が即座に復活' },
    ],
  },
  siracusa: {
    id: 'siracusa',
    name: 'シラクーザ',
    kind: 'core',
    thresholds: [3, 6],
    countMode: 'board',
    describe: (s) => [
      {
        count: 3,
        text: `【シラクーザ】は配置後${num(v('siracusa', 'base_duration') + v('siracusa', 'duration_per_stack') * s)}秒間、攻撃速度+${num(v('siracusa', 'base_attack_speed') + v('siracusa', 'attack_speed_per_stack') * s)}`,
      },
      {
        count: 6,
        text: `同じ時間ステルス状態になり、ステルス中と解除後10秒間、攻撃時3%の確率で${num(v('siracusa', 'base_damage') + v('siracusa', 'damage_per_stack') * s)}の確定ダメージ＋恐怖3秒`,
      },
    ],
  },
  kazimierz: {
    id: 'kazimierz',
    name: 'カジミエーシュ',
    kind: 'core',
    thresholds: [3, 6],
    countMode: 'board',
    describe: (s) => [
      {
        count: 3,
        text: `オペレーターが配置されるたびに【カジミエーシュ】の攻撃力+${pct(v('kazimierz', 'atk_when_born'))}（最大+${pct(v('kazimierz', 'base_max_atk_when_born') + v('kazimierz', 'max_atk_when_born_per_stack') * s)}）`,
      },
      { count: 6, text: '【カジミエーシュ】はブロック中、2秒ごとに周囲へ攻撃力120%の確定ダメージ。ブロックしていない時は攻撃に攻撃力30%の確定ダメージを追加' },
    ],
  },

  // ===================== 追加盟約 =====================
  preci: {
    id: 'preci',
    name: '精密',
    kind: 'extra',
    thresholds: [2, 3],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `【精密】の攻撃力+${pct(v('preci', 'base_atk') + v('preci', 'atk_per_stack') * s)}` },
      { count: 3, text: `対象が【精密】とすべての遠距離オペレーターに拡大し、防御力と術耐性を${pct(v('preci', 'power_def_penetrate'))}無視` },
    ],
  },
  swift: {
    id: 'swift',
    name: '俊敏',
    kind: 'extra',
    thresholds: [2],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `【俊敏】のスキル終了時、${pct(Math.min(1, v('swift', 'base_prob') + v('swift', 'prob_per_stack') * s))}の確率でSPを${v('swift', 'normal_sp')}回復` },
    ],
    stackMilestones: (s) => [{ at: 40, text: `40層：すべてのオペレーターがスキル終了時に同確率でSPを${v('swift', 'power_sp')}回復`, reached: s >= 40 }],
  },
  skillful: {
    id: 'skillful',
    name: '器用',
    kind: 'extra',
    thresholds: [2],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `【器用】と周囲4マスのオペレーターの攻撃速度+${num(v('skillful', 'base_attack_speed') + v('skillful', 'attack_speed_per_stack') * s)}` },
    ],
    stackMilestones: (s) => [{ at: 40, text: '40層：効果範囲が周囲8マスに拡大', reached: s >= 40 }],
  },
  arcane: {
    id: 'arcane',
    name: '秘術',
    kind: 'extra',
    thresholds: [2, 3],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `【秘術】が術ダメージを与えると、対象の被術ダメージ+${pct(v('arcane', 'base_damage_scale_show') + v('arcane', 'damage_scale_per_stack') * s)}（3秒間）` },
      { count: 3, text: `HP50%未満の敵に対しては被術ダメージ+${pct(v('arcane', 'base_damage_scale_show_ex') + v('arcane', 'damage_scale_per_stack_show_ex') * s)}` },
    ],
  },
  stead: {
    id: 'stead',
    name: '堅守',
    kind: 'extra',
    thresholds: [2, 3],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `すべてのオペレーターの最大HP+${pct(v('stead', 'base_max_hp') + v('stead', 'max_hp_per_stack') * s)}` },
      {
        count: 3,
        text: `【堅守】以外が受けるダメージの40%を【堅守】が肩代わり。【堅守】が被弾すると攻撃元に${num(v('stead', 'base_damage_value') + v('stead', 'damage_value_per_stack') * s)}の術ダメージと脆弱40%（5秒）`,
      },
    ],
  },
  deput: {
    id: 'deput',
    name: '助力',
    kind: 'extra',
    thresholds: [2, 3],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `すべてのオペレーターの防御力+${pct(v('deput', 'base_def') + v('deput', 'def_per_stack') * s)}、再配置時間-30%。準備フェーズ終了時、有効化中の盟約の加算数+2` },
      { count: 3, text: '準備フェーズ終了時の加算数増加が+4になる' },
    ],
  },
  visi: {
    id: 'visi',
    name: '先見',
    kind: 'extra',
    thresholds: [2],
    countMode: 'boardAndBench',
    describe: () => [{ count: 2, text: '加算数10ごとに資金+2（控えの【先見】も人数に数える）' }],
    stackMilestones: (s) => [
      { at: 80, text: '80層：【先見】の購入価格が永続的に-1', reached: s >= 80 },
      { at: 150, text: '150層：すべてのオペレーターの購入価格が永続的に-1', reached: s >= 150 },
    ],
  },
  mira: {
    id: 'mira',
    name: '奇跡',
    kind: 'extra',
    thresholds: [2],
    countMode: 'boardAndBench',
    describe: (s) => [
      { count: 2, text: `更新時、${pct(miraProb(s))}の確率で次の更新が無料になる（控えの【奇跡】も人数に数える）` },
    ],
    stackMilestones: (s) => [{ at: 100, text: '100層ごとに資金+20', reached: s >= 100 }],
  },
  invest: {
    id: 'invest',
    name: '投資家',
    kind: 'extra',
    thresholds: [3],
    countMode: 'boardAndBench',
    describe: () => [{ count: 3, text: '「獲得時」の特性が2回発動する（控えの【投資家】も人数に数える）' }],
    stackMilestones: (s) => [{ at: 100, text: '100層：「獲得時」の特性が3回発動', reached: s >= 100 }],
  },
  raid: {
    id: 'raid',
    name: '強襲',
    kind: 'extra',
    thresholds: [2],
    countMode: 'board',
    describe: (s) => [
      {
        count: 2,
        text: `【強襲】は10秒間攻撃しないかスキル準備完了時に範囲内に敵がいなければ、敵の近くへ再配置され、その間攻撃力とHP+${pct(v('raid', 'base_atk') + v('raid', 'atk_per_stack') * s)}`,
        notSimulated: true,
      },
    ],
    stackMilestones: (s) => [{ at: 50, text: '50層：すべてのオペレーターの攻撃速度+50', reached: s >= 50 }],
  },
  indom: {
    id: 'indom',
    name: '不屈',
    kind: 'extra',
    thresholds: [2, 3],
    countMode: 'board',
    describe: (s) => [
      { count: 2, text: `地上オペレーターが倒れた時、${pct(v('indom', 'base_prob') + v('indom', 'prob_per_stack') * s)}の確率で即座に再配置` },
      { count: 3, text: '地上オペレーターが倒れた時、すべてのオペレーターのSP+5' },
    ],
  },
  mani: {
    id: 'mani',
    name: '調和',
    kind: 'extra',
    thresholds: [1],
    countMode: 'board',
    describe: () => [{ count: 1, text: '盤面の核心盟約の人数+1。【調和】は有効化中の核心盟約の効果を受ける' }],
  },
  empty: {
    id: 'empty',
    name: '共同防衛',
    kind: 'extra',
    thresholds: [2],
    countMode: 'board',
    describe: () => [
      {
        count: 2,
        text: `すべてのオペレーターの被物理・術ダメージ-20%。【共同防衛】の与ダメージ${pct(v('empty', 'damage_scale_normal'))}（精鋭は${pct(v('empty', 'damage_scale_extra'))}）`,
      },
    ],
  },
  solo: {
    id: 'solo',
    name: '孤高',
    kind: 'extra',
    thresholds: [1],
    countMode: 'exactlyOne',
    describe: () => [
      { count: 1, text: `盤面の【孤高】がちょうど1名なら、その攻撃力とHP+${pct(v('solo', 'atk'))}、初期SP+${v('solo', 'sp')}（2名以上で無効）` },
    ],
  },
  sunt: {
    id: 'sunt',
    name: '秘技',
    kind: 'extra',
    thresholds: [v('sunt', 'power_char_cnt') || 2, v('sunt', 'ex_char_cnt') || 5],
    countMode: 'elite',
    noStack: true,
    describe: () => [
      { count: v('sunt', 'power_char_cnt') || 2, text: `盤面に精鋭のオペレーターが2名以上いると、精鋭のオペレーターの攻撃力+${pct(v('sunt', 'power_atk'))}` },
      { count: v('sunt', 'ex_char_cnt') || 5, text: `5名以上いると、さらに精鋭のオペレーターのスキルのSP消費-${pct(1 - v('sunt', 'sp_ratio'))}` },
    ],
  },
};

export function miraProb(stacks: number): number {
  return Math.min(1, v('mira', 'baseprob') + v('mira', 'prob') * stacks);
}

export const ALLIANCE_IDS = Object.keys(ALLIANCES) as AllianceId[];
