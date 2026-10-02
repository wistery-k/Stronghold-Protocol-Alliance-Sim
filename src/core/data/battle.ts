import battledata from './battledata.json';
import type { Star } from '../types';

// オートバトル用のデータ（本家データから scripts/extract_battle.py で抽出）

export interface EnemySpec {
  name: string;
  hp: number;
  def: number;
  res: number;
  /** 本家の moveSpeed（ステージの moveMultiplier を掛けたものが 1秒あたりのマス数） */
  speed: number;
  /** ブロックに必要な数 */
  blockCnt: number;
  flying: boolean;
  boss: boolean;
  elite: boolean;
  /** 防衛マスに到達した時に減る耐久値 */
  lifeReduce: number;
}

export interface SpawnSpec {
  enemy: string;
  count: number;
  interval: number;
  delay: number;
  route: number;
}

export interface RoundSpec {
  round: number;
  levelId: string;
  /** 制限時間（秒）。超えると残った敵は防衛マスに到達した扱い */
  timeLimit: number;
  moveMultiplier: number;
  spawns: SpawnSpec[];
}

const DATA = battledata as unknown as {
  ranges: Record<string, [number, number][]>;
  unitRanges: Record<string, Record<'normal' | 'golden', { range: string; skillRange: string | null }>>;
  enemies: Record<string, EnemySpec>;
  rounds: RoundSpec[];
};

export const ENEMIES: Record<string, EnemySpec> = DATA.enemies;
export const ROUNDS: RoundSpec[] = DATA.rounds;

export function roundSpec(round: number): RoundSpec {
  return ROUNDS[Math.min(Math.max(round, 1), ROUNDS.length) - 1];
}

/** 攻撃範囲（右向き基準の [前方, 横] のオフセット） */
export function rangeGrid(id: string | null | undefined): [number, number][] {
  return (id && DATA.ranges[id]) || [[0, 0]];
}

export function unitRangeIds(defId: string, star: Star): { range: string; skillRange: string | null } {
  return DATA.unitRanges[defId]?.[star === 2 ? 'golden' : 'normal'] ?? { range: '1-1', skillRange: null };
}

/** 出現する敵の一覧（種類ごとの数） */
export function roundEnemySummary(spec: RoundSpec): { key: string; enemy: EnemySpec; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of spec.spawns) counts.set(s.enemy, (counts.get(s.enemy) ?? 0) + s.count);
  return [...counts.entries()]
    .map(([key, count]) => ({ key, enemy: ENEMIES[key], count }))
    .sort((a, b) => Number(b.enemy.boss) - Number(a.enemy.boss) || b.enemy.hp - a.enemy.hp);
}
