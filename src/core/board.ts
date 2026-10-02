import { rangeGrid, unitRangeIds } from './data/battle';
import { getUnit, unitState } from './data/units';
import type { Direction, OwnedUnit, Star } from './types';

export const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];
export const DEFAULT_DIRECTION: Direction = 'right';
const DIR_DELTA: Record<Direction, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
export const DIRECTION_NAME: Record<Direction, string> = { up: '上', right: '右', down: '下', left: '左' };

// 配置エリア（マップ）の位置関係。
// オペレーターは上下左右のいずれかを向いて配置される。
//   「前方1マス」「後方1マス」はオペレーターの向きから見た相対位置、
//   「左右一直線上」は向きに関係なく絶対方角の横一列（同じ y）。

/**
 * マップ。1: 地上（全員配置可・敵が通る）2: 敵の出現地点 3: 地上（全員配置可・敵は通らない）
 * 4: 壁 5: 高台（遠距離のみ配置可）6: 防衛地点（敵の目的地。到達されると耐久値が減る）
 */
export const MAP_LAYOUT = ['444555112', '445553134', '455533134', '611111112'];

export type TileType = 'ground' | 'spawn' | 'safe' | 'wall' | 'high' | 'goal';
const TILE_CODE: Record<string, TileType> = { '1': 'ground', '2': 'spawn', '3': 'safe', '4': 'wall', '5': 'high', '6': 'goal' };
export const TILE_NAME: Record<TileType, string> = {
  ground: '地上マス',
  spawn: '敵の出現地点',
  safe: '地上マス（敵は通らない）',
  wall: '壁',
  high: '高台マス（遠距離のみ）',
  goal: '防衛地点',
};

export const BOARD_COLS = MAP_LAYOUT[0].length;
export const BOARD_ROWS = MAP_LAYOUT.length;
export const BOARD_CELLS = BOARD_COLS * BOARD_ROWS;

export const cellX = (pos: number) => pos % BOARD_COLS;
export const cellY = (pos: number) => Math.floor(pos / BOARD_COLS);
export const cellPos = (x: number, y: number) => y * BOARD_COLS + x;
const inside = (x: number, y: number) => x >= 0 && x < BOARD_COLS && y >= 0 && y < BOARD_ROWS;

export function tileAt(pos: number): TileType {
  return TILE_CODE[MAP_LAYOUT[cellY(pos)][cellX(pos)]];
}

/** 敵が通れるマス */
export const enemyPassable = (pos: number) => ['ground', 'spawn', 'goal'].includes(tileAt(pos));

/** 近距離職（地上マスにしか置けない職分ではなく、高台に置けない職分） */
export function isMelee(defId: string): boolean {
  return getUnit(defId).position === 'melee';
}

/** そのオペレーターを置けるマスか */
export function canPlace(pos: number, defId: string): boolean {
  if (pos < 0 || pos >= BOARD_CELLS) return false;
  const t = tileAt(pos);
  if (t === 'ground' || t === 'safe') return true;
  if (t === 'high') return !isMelee(defId);
  return false;
}

/** そのマスに置いたオペレーターが敵をブロックできるか（敵が通る地上マス） */
export const canBlockAt = (pos: number) => tileAt(pos) === 'ground';

export const SPAWNS: number[] = [];
export let GOAL = 0;
for (let p = 0; p < BOARD_CELLS; p++) {
  if (tileAt(p) === 'spawn') SPAWNS.push(p);
  if (tileAt(p) === 'goal') GOAL = p;
}

/** 出現地点から防衛地点までの経路（マスの並び） */
function findPath(from: number): number[] {
  const prev = new Map<number, number>([[from, -1]]);
  const queue = [from];
  while (queue.length) {
    const p = queue.shift()!;
    if (p === GOAL) break;
    for (const [dx, dy] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) {
      const x = cellX(p) + dx;
      const y = cellY(p) + dy;
      if (!inside(x, y)) continue;
      const q = cellPos(x, y);
      if (prev.has(q) || !enemyPassable(q)) continue;
      prev.set(q, p);
      queue.push(q);
    }
  }
  const path: number[] = [];
  for (let p = GOAL; p !== -1 && p !== undefined; p = prev.get(p)!) path.unshift(p);
  return path;
}

export const ENEMY_PATHS: number[][] = SPAWNS.map(findPath);
export const PATH_TILES = new Set(ENEMY_PATHS.flat());

/** 攻撃範囲のオフセット（右向き基準の [前方, 横]）を向きに合わせてマス座標に変換 */
export function rotateOffset(dir: Direction, col: number, row: number): [number, number] {
  switch (dir) {
    case 'right':
      return [col, row];
    case 'left':
      return [-col, -row];
    case 'up':
      return [row, -col];
    case 'down':
      return [-row, col];
  }
}

/** pos から dir を向いた時に攻撃範囲に入るマス */
export function rangeCells(pos: number, dir: Direction, grid: [number, number][]): number[] {
  const out: number[] = [];
  for (const [col, row] of grid) {
    const [dx, dy] = rotateOffset(dir, col, row);
    const x = cellX(pos) + dx;
    const y = cellY(pos) + dy;
    if (inside(x, y)) out.push(cellPos(x, y));
  }
  return out;
}

export function unitRangeCells(o: OwnedUnit, skill = false): number[] {
  if (o.pos === undefined) return [];
  const ids = unitRangeIds(o.defId, o.star);
  return rangeCells(o.pos, o.dir ?? DEFAULT_DIRECTION, rangeGrid(skill && ids.skillRange ? ids.skillRange : ids.range));
}

/** 経路マスの評価：通る経路の数（合流後のマスは2）。同点なら出現地点寄り（早く攻撃できる）を優先 */
const PATH_WEIGHT = new Map<number, number>();
/** 防衛地点への近さ（0〜1） */
const GOAL_NEAR = new Map<number, number>();
for (const path of ENEMY_PATHS) {
  path.forEach((p, i) => {
    if (p === GOAL) return;
    PATH_WEIGHT.set(p, (PATH_WEIGHT.get(p) ?? 0) + 1);
    GOAL_NEAR.set(p, Math.max(GOAL_NEAR.get(p) ?? 0, i / path.length));
  });
}

function coverage(pos: number, dir: Direction, grid: [number, number][]): number {
  return rangeCells(pos, dir, grid).reduce((sum, p) => sum + (PATH_WEIGHT.get(p) ?? 0) - 0.05 * (GOAL_NEAR.get(p) ?? 0), 0);
}

/** 経路を最も多く攻撃範囲に収める向き */
export function bestDirection(pos: number, defId: string, star: Star = 1): Direction {
  const grid = rangeGrid(unitRangeIds(defId, star).range);
  let best: Direction = DEFAULT_DIRECTION;
  let bestScore = -1;
  for (const d of ['right', 'left', 'up', 'down'] as Direction[]) {
    const sc = coverage(pos, d, grid);
    if (sc > bestScore + 1e-9) {
      best = d;
      bestScore = sc;
    }
  }
  return best;
}

/** 空いているマスのうち、そのオペレーターに一番向いているマスと向き */
export function autoCell(board: OwnedUnit[], defId: string, star: Star = 1): { pos: number; dir: Direction } | null {
  const def = getUnit(defId);
  const grid = rangeGrid(unitRangeIds(defId, star).range);
  const blocker = isMelee(defId) && unitState(def, star).stats.block > 0 && def.damageType !== 'heal';
  let best: { pos: number; dir: Direction } | null = null;
  let bestScore = -Infinity;
  for (let p = 0; p < BOARD_CELLS; p++) {
    if (!canPlace(p, defId) || unitAt(board, p)) continue;
    const dir = bestDirection(p, defId, star);
    let sc = coverage(p, dir, grid);
    // 近距離のブロック役は経路上（防衛地点寄り）に、それ以外は経路をふさがない場所に置く
    if (canBlockAt(p)) sc += blocker ? 5 + (PATH_WEIGHT.get(p) ?? 0) * 2 + (GOAL_NEAR.get(p) ?? 0) * 3 : -8;
    if (sc > bestScore) {
      bestScore = sc;
      best = { pos: p, dir };
    }
  }
  return best;
}

export function unitAt(board: OwnedUnit[], pos: number): OwnedUnit | undefined {
  return board.find((o) => o.pos === pos);
}

/** pos が未設定・重複・置けないマスのユニットを置き直す（古いセーブデータ対策） */
export function normalizePositions(board: OwnedUnit[]): void {
  const used = new Set<number>();
  for (const o of board) {
    if (o.pos === undefined || used.has(o.pos) || !canPlace(o.pos, o.defId)) o.pos = undefined;
    else used.add(o.pos);
  }
  for (const o of board) {
    if (o.pos !== undefined) continue;
    const placed = board.filter((b) => b.pos !== undefined);
    const c = autoCell(placed, o.defId, o.star);
    if (c) {
      o.pos = c.pos;
      o.dir = c.dir;
    }
  }
}

function offset(board: OwnedUnit[], o: OwnedUnit, dx: number, dy: number): OwnedUnit | undefined {
  if (o.pos === undefined) return undefined;
  const x = cellX(o.pos) + dx;
  const y = cellY(o.pos) + dy;
  return inside(x, y) ? unitAt(board, cellPos(x, y)) : undefined;
}

export function frontOf(board: OwnedUnit[], o: OwnedUnit): OwnedUnit | undefined {
  const [dx, dy] = DIR_DELTA[o.dir ?? DEFAULT_DIRECTION];
  return offset(board, o, dx, dy);
}

export function behindOf(board: OwnedUnit[], o: OwnedUnit): OwnedUnit | undefined {
  const [dx, dy] = DIR_DELTA[o.dir ?? DEFAULT_DIRECTION];
  return offset(board, o, -dx, -dy);
}

/** 向きから見て左右両隣のオペレーター */
export function sidesOf(board: OwnedUnit[], o: OwnedUnit): OwnedUnit[] {
  const [dx, dy] = DIR_DELTA[o.dir ?? DEFAULT_DIRECTION];
  return [offset(board, o, -dy, dx), offset(board, o, dy, -dx)].filter((x): x is OwnedUnit => !!x);
}

/** 左右一直線上（絶対方角の横一列）のオペレーター（自身を含む） */
export function sameRow(board: OwnedUnit[], o: OwnedUnit): OwnedUnit[] {
  if (o.pos === undefined) return [];
  const y = cellY(o.pos);
  return board.filter((b) => b.pos !== undefined && cellY(b.pos) === y);
}

export function rightmostInRow(board: OwnedUnit[], o: OwnedUnit): OwnedUnit | undefined {
  return sameRow(board, o).sort((a, b) => cellX(b.pos!) - cellX(a.pos!))[0];
}

/** 周囲4マス（上下左右）または8マス */
export function neighbors(board: OwnedUnit[], o: OwnedUnit, eight = false): OwnedUnit[] {
  const out: OwnedUnit[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (!eight && dx !== 0 && dy !== 0) continue;
      const n = offset(board, o, dx, dy);
      if (n) out.push(n);
    }
  }
  return out;
}

/**
 * 【エーギル】の捕食：戦闘開始時、エーギル所属者が左・上の者から順に前方1マスのオペレーターを捕食し、
 * 5000の物理ダメージを与えて基礎攻撃力を得る。被捕食者の等級ぶん【エーギル】の加算数が増える。
 */
export function egirDevour(board: OwnedUnit[], egirMembers: Set<number>, damage = 5000) {
  const atkGain = new Map<number, number>();
  const dead = new Set<number>();
  let stacks = 0;
  const order = board
    .filter((o) => egirMembers.has(o.uid) && o.pos !== undefined)
    .sort((a, b) => cellX(a.pos!) - cellX(b.pos!) || cellY(a.pos!) - cellY(b.pos!));
  for (const eater of order) {
    if (dead.has(eater.uid)) continue;
    const prey = frontOf(board, eater);
    if (!prey || dead.has(prey.uid)) continue;
    const preyDef = getUnit(prey.defId);
    const st = unitState(preyDef, prey.star).stats;
    atkGain.set(eater.uid, (atkGain.get(eater.uid) ?? 0) + st.atk);
    stacks += preyDef.tier;
    if (st.hp <= Math.max(damage - st.def, damage * 0.05)) dead.add(prey.uid);
  }
  return { atkGain, dead, stacks };
}
