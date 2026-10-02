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
  /** 倒れると周囲に汚染秽蝕を残す（範囲内の味方は毎秒HPを失う。HP50%超で high、以下で low） */
  deathPollution?: { high: number; low: number; duration: number; radius: number };
  /** 攻撃時に攻撃力×ratio の元素損傷を与える */
  element?: { type: ElementType; ratio: number };
  /** 攻撃。近接はブロックしている相手を、遠距離は範囲内の相手を攻撃する。無ければ攻撃しない */
  attack?: { kind: 'melee' | 'ranged'; atk: number; interval: number; range: number; arts: boolean };
}

/** 元素損傷の種類：灼燃・神経・侵蝕・凋亡（壊死） */
export type ElementType = 'burning' | 'neural' | 'erosion' | 'apoptosis';

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
  /** 懸賞の敵：倒すと得る資金 */
  bounty?: number;
  /** 飛行用の枠（飛行の敵グループのラウンドだけ使う。それ以外のラウンドは地上用の枠を使う） */
  flySlot?: boolean;
}

/** 敵グループの種類（主力部隊は常に出る。ほかの6種から3種がゲーム開始時に選ばれる） */
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
  bounties: BountyDef[];
};

/** 懸賞（倒すと資金を得る追加の敵）。tier は I〜III、group は対応する敵グループ */
export interface BountyDef {
  id: string;
  enemy: string;
  tier: number;
  group: EnemyGroupType;
  coin: number;
}

export const ENEMIES: Record<string, EnemySpec> = DATA.enemies;
export const ROUNDS: RoundSpec[] = DATA.rounds;
export const ENEMY_GROUPS = DATA.groups;
export const BOUNTIES: BountyDef[] = DATA.bounties;
export const getBounty = (id: string | null | undefined) => BOUNTIES.find((b) => b.id === id);
/** 懸賞が提示されるラウンドと、懸賞の敵が出るラウンド */
export const BOUNTY_OFFER_ROUND = 3;
export const BOUNTY_ROUNDS = [3, 4];

/** 懸賞の敵を出現に加える（出現はステージ序盤、2つの出現マスを交互に） */
export function withBounty(spec: RoundSpec, bounty: BountyDef | undefined): RoundSpec {
  if (!bounty || !BOUNTY_ROUNDS.includes(spec.round)) return spec;
  return { ...spec, spawns: [...spec.spawns, { enemy: bounty.enemy, count: 1, interval: 0, delay: 8, spawn: spec.round % 2, bounty: bounty.coin }] };
}
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
 * ラウンドの敵グループを決める。主力部隊と選ばれた3種から1つ、その中から組み合わせを1つ（重み付き）。
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
  // ステージには地上用と飛行用の2組の枠があり、グループに合う組だけを使う
  const fly = group!.type === 'FLY';
  const slots = base.spawns.filter((s) => !s.role || !!s.flySlot === fly);
  // 強敵は1ラウンドに STRONG_PER_ROUND 体まで（出現の早い順）。超えた枠はエリートにする
  let strongLeft = STRONG_PER_ROUND;
  const order = slots.map((_, i) => i).sort((a, b) => slots[a].delay - slots[b].delay);
  const roles = new Map<number, { strong: number; elite: number }>();
  for (const i of order) {
    const s = slots[i];
    if (s.role !== 'strong') continue;
    const strong = Math.min(s.count, strongLeft);
    strongLeft -= strong;
    roles.set(i, { strong, elite: s.count - strong });
  }
  const spawns: SpawnSpec[] = [];
  slots.forEach((s, i) => {
    if (!s.role) return spawns.push(s);
    const r = roles.get(i);
    if (!r) return spawns.push({ ...s, enemy: pick(s.role, i) });
    // 強敵の枠を前半（強敵）と後半（エリート）に分ける
    if (r.strong > 0) spawns.push({ ...s, count: r.strong, enemy: pick('strong', i) });
    if (r.elite > 0) spawns.push({ ...s, count: r.elite, delay: s.delay + r.strong * s.interval, enemy: pick('elite', i) });
  });
  return { ...base, spawns };
}

/** 1ラウンドに出る強敵の上限（本家の出現数がデータに無いため、プレイ時の記憶に合わせた仮の値） */
export const STRONG_PER_ROUND = 3;

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
