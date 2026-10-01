import gamedata from './gamedata.json';
import type { DamageType, Profession, Star, UnitDef, UnitState } from '../types';

// オペレーターのデータは本家から抽出した gamedata.json を使う
// （scripts/extract_gamedata.py で生成）

export const GAMEDATA = gamedata as unknown as {
  source: { activity: string; dataVersion: string[] };
  shop: {
    refreshPrice: number;
    maxBattle: number;
    maxDeck: number;
    prices: Record<string, { buy: number; sell: number }>;
    levels: { level: number; upgradePrice: number; slots: number }[];
  };
  bonds: Record<string, { activeCount: number; condition: string; values: Record<string, number> }>;
  units: UnitDef[];
};

export const UNITS: UnitDef[] = GAMEDATA.units;

export const UNIT_MAP: Record<string, UnitDef> = Object.fromEntries(UNITS.map((d) => [d.id, d]));

export function getUnit(id: string): UnitDef {
  const d = UNIT_MAP[id];
  if (!d) throw new Error(`unknown unit: ${id}`);
  return d;
}

export function unitState(def: UnitDef, star: Star): UnitState {
  return star === 2 ? def.golden : def.normal;
}

export const PROFESSION_NAME: Record<Profession, string> = {
  vanguard: '先鋒',
  guard: '前衛',
  defender: '重装',
  sniper: '狙撃',
  caster: '術師',
  medic: '医療',
  supporter: '補助',
  specialist: '特殊',
};

export const DAMAGE_TYPE_NAME: Record<DamageType, string> = {
  physical: '物理',
  arts: '術',
  true: '確定',
  heal: '治療',
};

/** 遠距離職（精密Lv2の対象判定などに使う） */
export function isRanged(def: UnitDef): boolean {
  return ['sniper', 'caster', 'medic', 'supporter'].includes(def.profession);
}

export const STAR_NAME: Record<Star, string> = { 1: '通常', 2: '昇進' };
