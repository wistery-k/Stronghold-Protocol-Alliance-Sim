import { GAMEDATA } from './units';
import type { AllianceId, Star, Tier } from '../types';

// 装備（アイテム）のデータ。本家データから scripts/extract_gamedata.py で抽出。

export interface ItemBuff {
  type: string;
  key?: string;
  [k: string]: string | number | undefined;
}

export interface ItemState {
  name: string;
  description: string;
  price: number;
  buffs: ItemBuff[];
}

export interface ItemDef {
  /** "1_01" のような ID（等級_番号） */
  id: string;
  tier: Tier;
  /** 対応する盟約（変形同位体で付与される） */
  giveBond: AllianceId | null;
  canGiveBond: boolean;
  /** 精鋭化に必要な枚数（2） */
  mergeCount: number;
  normal: ItemState;
  golden: ItemState;
}

export const ITEMS: ItemDef[] = (GAMEDATA as unknown as { items: ItemDef[] }).items;
export const ITEM_MAP: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

export function getItem(id: string): ItemDef {
  const d = ITEM_MAP[id];
  if (!d) throw new Error(`unknown item: ${id}`);
  return d;
}

export function itemState(def: ItemDef, star: Star): ItemState {
  return star === 2 ? def.golden : def.normal;
}

/** buff の配列から、type または key が一致するものを探す */
export function findBuff(st: ItemState, keyOrType: string): ItemBuff | undefined {
  return st.buffs.find((b) => b.key === keyOrType || b.type === keyOrType);
}

/** 装備した瞬間に消滅する（効果を発動する）アイテムか */
export const CONSUME_TYPES = new Set([
  'equip_destory_gain_random_coin',
  'use_equip_reward_char_chess_bond_layer',
  'use_equip_reward_random_char_chess_in_shop',
  'gain_coin_when_round_start',
  'use_equip_reward_char_chess_with_same_bond',
  'use_equip_gain_coin_when_next_round_start',
  'use_equip_reward_special_goods_char_chess',
  'use_equip_recruit_new_char_and_give_char_to_player_most_bond',
  'use_equip_reward_char_chess',
  'equip_destory_deployment_cnt_change',
]);

export function isConsumable(def: ItemDef): boolean {
  return def.normal.buffs.some((b) => CONSUME_TYPES.has(b.type));
}

/** 本家データの "chess_item_3_05_e_a" のような ID をこのプロジェクトの ID に変換 */
export const itemKey = (chessId: string) => chessId.replace('chess_item_', '').replace(/_e(_[ab])?$/, '');

/** ショップに並ばない装備（ヴィクトリアの鉄鎚・〇〇は特性や盟約でのみ手に入る） */
export const NOT_IN_SHOP = new Set(['2_03', '3_09', '3_10', '4_09']);

/** 特性などで得られる装備の候補 */
export const ITEM_POOLS: Record<string, [string, number][]> = {
  // ヴィクトリアの鉄鎚（【ヴィクトリア】25層ごとの報酬、ロックロックの特製品）
  pool_equip_vict: [
    ['1_01', 1],
    ['2_03', 1],
    ['3_09', 1],
    ['3_10', 1],
    ['4_09', 1],
  ],
  // キャサリン：奇数ラウンドにヴィクトリアの鉄鎚
  pool_equip_normal: [
    ['1_01', 1],
    ['2_03', 1],
    ['3_09', 1],
    ['3_10', 1],
    ['4_09', 1],
  ],
  pool_equip_rockr: [
    ['1_01', 1],
    ['2_03', 1],
    ['3_09', 1],
    ['3_10', 1],
    ['4_09', 1],
  ],
  // ペペ：盟約のコインかサルゴンの渋茶、低確率で黄砂のコンパス
  pool_equip_pepe: [
    ['1_03', 45],
    ['2_04', 45],
    ['6_07', 10],
  ],
};
