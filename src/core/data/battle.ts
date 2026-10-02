import battledata from './battledata.json';
import { Rng } from '../rng';
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
  /** 隠匿：ブロックされるまで攻撃の対象にならない */
  stealth?: boolean;
  /** ブロックできない */
  unblockable?: boolean;
  /** HP は攻撃回数（1回の攻撃で1減る） */
  hitsToKill?: boolean;
  /** 屈折：術耐性がこの値だけ上がる */
  refract?: number;
  /** 最初の数回の攻撃を無効にする */
  hitShield?: number;
  /** 攻撃を受けるたびに防御・術耐性が下がる（1回あたりの量と上限回数） */
  defReduce?: { max: number; def: number; res: number };
  /** 倒れると別の敵を生む */
  deadSpawn?: { enemy: string; count: number };
  /** 倒れると「hits 回の攻撃で倒せる」状態になり、interval 秒後に復活する（1回だけ） */
  revive?: { hits: number; interval: number };
}

/** 敵の枠の役割（雑魚・エリート・強敵） */
export type EnemyRole = 'normal' | 'elite' | 'strong';

export interface SpawnSpec {
  enemy: string;
  /** 敵グループの敵に置き換わる枠。null は固定の敵（ボスなど） */
  role?: EnemyRole | null;
  count: number;
  interval: number;
  delay: number;
  /** 出現マス（0: 上、1: 下） */
  spawn: number;
}

/** 敵グループの種類（力押しは常に出る。ほかの6種から3種がゲーム開始時に選ばれる） */
export type EnemyGroupType = 'SPECIAL' | 'FLY' | 'TIMES' | 'ELEMENT' | 'DOT' | 'INVISIBLE' | 'REFLECTION';

export interface EnemyGroupEntry {
  strong: string;
  normal: string[];
  elite: string[];
  weight: number;
  /** 前半（act1autochess_01〜07 のラウンド）に出る組み合わせ */
  firstHalf: boolean;
}

/** ラウンドの敵グループ（種類と組み合わせの番号） */
export interface RoundGroup {
  type: EnemyGroupType;
  entry: number;
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
  groups: Record<EnemyGroupType, { name: string; entries: EnemyGroupEntry[] }>;
  firstHalfRounds: number;
  rounds: RoundSpec[];
};

export const ENEMIES: Record<string, EnemySpec> = DATA.enemies;
export const ROUNDS: RoundSpec[] = DATA.rounds;
export const ENEMY_GROUPS = DATA.groups;
/** ゲーム開始時に抽選される特殊敵の種類 */
export const SPECIAL_GROUP_TYPES: EnemyGroupType[] = ['FLY', 'TIMES', 'ELEMENT', 'DOT', 'INVISIBLE', 'REFLECTION'];
export const SPECIAL_GROUP_COUNT = 3;

export const groupName = (type: EnemyGroupType) => ENEMY_GROUPS[type]?.name ?? type;

/** そのラウンドで選ばれうる組み合わせの番号 */
function entryCandidates(type: EnemyGroupType, round: number): number[] {
  const entries = ENEMY_GROUPS[type].entries;
  const firstHalf = round <= DATA.firstHalfRounds;
  const idx = entries.map((_, i) => i).filter((i) => entries[i].firstHalf === firstHalf);
  return idx.length ? idx : entries.map((_, i) => i);
}

/**
 * ラウンドの敵グループを決める。力押しと選ばれた3種から1つ、その中から組み合わせを1つ（重み付き）。
 * シードとラウンドだけで決まるので、予測と実際の戦闘で同じになる。
 */
export function pickRoundGroup(seed: number, round: number, types: EnemyGroupType[]): RoundGroup {
  const rng = new Rng((seed ^ Math.imul(round + 1, 0x9e3779b1)) | 0);
  rng.next();
  const choices: EnemyGroupType[] = ['SPECIAL', ...types];
  const type = choices[rng.int(choices.length)];
  const cands = entryCandidates(type, round);
  const entries = ENEMY_GROUPS[type].entries;
  const k = rng.weighted(cands.map((i) => entries[i].weight));
  return { type, entry: cands[Math.max(0, k)] };
}

/** ゲーム開始時の特殊敵の抽選 */
export function pickGroupTypes(rng: Rng): EnemyGroupType[] {
  const pool = [...SPECIAL_GROUP_TYPES];
  const out: EnemyGroupType[] = [];
  while (out.length < SPECIAL_GROUP_COUNT && pool.length) out.push(pool.splice(rng.int(pool.length), 1)[0]);
  return out;
}

export function groupEntry(g: RoundGroup): EnemyGroupEntry | undefined {
  return ENEMY_GROUPS[g.type]?.entries[g.entry];
}

/** グループの組み合わせの短い説明（強敵の名前） */
export function groupLabel(g: RoundGroup): string {
  const e = groupEntry(g);
  return e ? `${groupName(g.type)}（${ENEMIES[e.strong]?.name ?? e.strong}）` : groupName(g.type);
}

/**
 * ラウンドの敵の出現。group を渡すと、ステージの敵の枠をそのグループの敵に置き換える。
 * 省略時はステージファイルの敵のまま。
 */
export function roundSpec(round: number, group?: RoundGroup | null): RoundSpec {
  const base = ROUNDS[Math.min(Math.max(round, 1), ROUNDS.length) - 1];
  const entry = group ? groupEntry(group) : undefined;
  if (!entry) return base;
  const pick = (role: EnemyRole, i: number) => {
    if (role === 'strong') return entry.strong;
    const list = role === 'elite' ? entry.elite : entry.normal;
    return list[i % list.length];
  };
  return {
    ...base,
    spawns: base.spawns.map((s, i) => (s.role ? { ...s, enemy: pick(s.role, i) } : s)),
  };
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
