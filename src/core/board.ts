import { getUnit, unitState } from './data/units';
import type { Direction, OwnedUnit } from './types';

export const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];
export const DEFAULT_DIRECTION: Direction = 'right';
const DIR_DELTA: Record<Direction, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
export const DIRECTION_NAME: Record<Direction, string> = { up: '上', right: '右', down: '下', left: '左' };

// 配置エリア（4x4 グリッド）の位置関係。
// オペレーターは上下左右のいずれかを向いて配置される。
//   「前方1マス」「後方1マス」はオペレーターの向きから見た相対位置、
//   「左右一直線上」は向きに関係なく絶対方角の横一列（同じ y）。

export const BOARD_COLS = 4;
export const BOARD_ROWS = 4;
export const BOARD_CELLS = BOARD_COLS * BOARD_ROWS;

export const cellX = (pos: number) => pos % BOARD_COLS;
export const cellY = (pos: number) => Math.floor(pos / BOARD_COLS);
export const cellPos = (x: number, y: number) => y * BOARD_COLS + x;
const inside = (x: number, y: number) => x >= 0 && x < BOARD_COLS && y >= 0 && y < BOARD_ROWS;

export function unitAt(board: OwnedUnit[], pos: number): OwnedUnit | undefined {
  return board.find((o) => o.pos === pos);
}

export function firstFreeCell(board: OwnedUnit[]): number | null {
  for (let p = 0; p < BOARD_CELLS; p++) if (!unitAt(board, p)) return p;
  return null;
}

/** pos が未設定・重複しているユニットに空きマスを割り当てる（古いセーブデータ対策） */
export function normalizePositions(board: OwnedUnit[]): void {
  const used = new Set<number>();
  for (const o of board) {
    if (o.pos === undefined || used.has(o.pos) || o.pos < 0 || o.pos >= BOARD_CELLS) o.pos = undefined;
    else used.add(o.pos);
  }
  for (const o of board) {
    if (o.pos !== undefined) continue;
    for (let p = 0; p < BOARD_CELLS; p++) {
      if (!used.has(p)) {
        o.pos = p;
        used.add(p);
        break;
      }
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
