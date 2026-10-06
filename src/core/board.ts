import { rangeGrid, unitRangeIds } from './data/battle';
import { getUnit, unitState } from './data/units';
import type { Direction, OwnedUnit, Star } from './types';

export const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];
export const DEFAULT_DIRECTION: Direction = 'right';
export const DIR_DELTA: Record<Direction, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
export const DIRECTION_NAME: Record<Direction, string> = { up: '上', right: '右', down: '下', left: '左' };

// 配置エリア（マップ）の位置関係。
// オペレーターは上下左右のいずれかを向いて配置される。
//   「前方1マス」「後方1マス」はオペレーターの向きから見た相対位置、
//   「左右一直線上」は向きに関係なく絶対方角の横一列（同じ y）。

/**
 * マップ（9列×4行）。本家の盟約（後期）の配置エリア（act1autochess_m01〜m04・act2autochess_m01〜m04）。
 * 1: 地上（全員配置可・敵が通る） 2: 敵の出現地点 3: 地上（全員配置可・敵は通らない） 4: 配置不可
 * 5: 高台（遠距離のみ配置可） 6: 防衛地点 7: 通路（配置不可・敵が通る） B: 障害物（地上に置かれた木箱。配置不可・敵も通れない）
 * 1人用の配置エリア（マップの左上）と、そこに置かれる木箱（trap_1105_accrate → B）・射撃台（trap_1106_achplat → 5 高台）。出現地点の間の2マスはボス戦以外は塞がれている
 * 特殊な地上（全員配置可・敵が通る）: X 活性源石 M 沼地 G 換気口 D 深水区
 */
export interface MapDef {
  id: string;
  name: string;
  layout: string[];
  /** 低難易度のみに出るマップ（ゲーム開始時の抽選には含めない。サンドボックスでは選べる） */
  lowOnly?: boolean;
}

export const MAPS: MapDef[] = [
  { id: 'm1', name: 'マップ1（低難易度のみ）', layout: ['431111172', '431B33174', '431BB3174', '611444112'], lowOnly: true },
  { id: 'm2', name: 'マップ2', layout: ['411111172', '413311174', '413314474', '611114412'] },
  { id: 'm3', name: 'マップ3', layout: ['444311172', '444B155B4', '4551133B4', '611111112'] },
  { id: 'm4', name: 'マップ4（活性源石）', layout: ['4BB444B72', '4311X1174', '4311X1174', '611444112'] },
  { id: 'm5', name: 'マップ5（高台）', layout: ['445111472', '445141474', '445141474', '611141112'] },
  { id: 'm6', name: 'マップ6（沼地）', layout: ['44445M172', '44453M3B4', '44533M3B4', '611111112'] },
  { id: 'm7', name: 'マップ7（換気口）', layout: ['4B11G1172', '4B13333B4', '4313G1174', '611114412'] },
  { id: 'm8', name: 'マップ8（深水区）', layout: ['4311D1172', '4311D33B4', '4313D33B4', '611311112'] },
];
/** テスト・古いセーブデータ用の以前の仮マップ */
export const LEGACY_MAP: MapDef = { id: 'legacy', name: '旧マップ', layout: ['444555112', '445553134', '455533134', '611111112'] };
/** ゲーム開始時に抽選されるマップ（高難易度に出るもの） */
export const RANDOM_MAPS: MapDef[] = MAPS.filter((m) => !m.lowOnly);
export const getMap = (id: string | null | undefined): MapDef => MAPS.find((m) => m.id === id) ?? LEGACY_MAP;

export type TileType = 'ground' | 'spawn' | 'safe' | 'wall' | 'high' | 'goal' | 'floor' | 'barricade' | 'infection' | 'mire' | 'smog' | 'deepsea';
const TILE_CODE: Record<string, TileType> = {
  '1': 'ground',
  '2': 'spawn',
  '3': 'safe',
  '4': 'wall',
  '5': 'high',
  '6': 'goal',
  '7': 'floor',
  B: 'barricade',
  X: 'infection',
  M: 'mire',
  G: 'smog',
  D: 'deepsea',
};
export const TILE_NAME: Record<TileType, string> = {
  ground: '地上マス',
  spawn: '敵の出現地点',
  safe: '地上マス（敵は通らない）',
  wall: '配置できないマス',
  high: '高台マス（遠距離と鈎縄師のみ）',
  goal: '防衛地点',
  floor: '地上（配置できない・敵が通る）',
  barricade: '障害物（配置できない・敵も通れない）',
  infection: '活性源石：配置した味方と通る敵は攻撃力+20%・攻撃速度+20、毎秒HPを70失う',
  mire: '沼地：配置した味方は攻撃速度-30、通る敵は移動速度・攻撃速度が下がる',
  smog: '換気口：配置した味方は敵の遠距離攻撃の対象にならない',
  deepsea: '深水区：通る敵は移動速度・攻撃速度が下がり、毎秒HPを失う',
};
/** 地上として扱う（配置でき、敵が通り、ブロックできる）特殊なマス */
const SPECIAL_GROUND: TileType[] = ['infection', 'mire', 'smog', 'deepsea'];

export const BOARD_COLS = 9;
export const BOARD_ROWS = 4;
export const BOARD_CELLS = BOARD_COLS * BOARD_ROWS;

export const cellX = (pos: number) => pos % BOARD_COLS;
export const cellY = (pos: number) => Math.floor(pos / BOARD_COLS);
export const cellPos = (x: number, y: number) => y * BOARD_COLS + x;
const inside = (x: number, y: number) => x >= 0 && x < BOARD_COLS && y >= 0 && y < BOARD_ROWS;

/**
 * 大型のボスの当たり判定のマス（右の3列×上の3行。(列,行)で(7,1)〜(9,3)）。
 * 見た目の本体は (8,1)〜(9,3)。(7,1)〜(7,3) は当たり判定のみで、配置や敵の経路には影響しない
 */
export const BOSS_CELLS: number[] = [6, 7, 8].flatMap((x) => [0, 1, 2].map((y) => cellPos(x, y)));
/** 大型のボスの位置（対象を中心とする効果の中心。(8,3)） */
export const BOSS_CENTER = { x: 7, y: 2 };

/** 使用中のマップ（ゲームごとに setActiveMap で切り替える） */
export let ACTIVE_MAP: MapDef = LEGACY_MAP;
export let MAP_LAYOUT: string[] = LEGACY_MAP.layout;

export function tileAt(pos: number): TileType {
  return TILE_CODE[MAP_LAYOUT[cellY(pos)][cellX(pos)]];
}

/** 地上（特殊なマスを含む） */
export const isGroundTile = (t: TileType) => t === 'ground' || SPECIAL_GROUND.includes(t);

/** 敵が通れるマス */
export const enemyPassable = (pos: number) => {
  const t = tileAt(pos);
  return isGroundTile(t) || t === 'spawn' || t === 'goal' || t === 'floor';
};

/** 近距離職（地上マスにしか置けない職分ではなく、高台に置けない職分） */
export function isMelee(defId: string): boolean {
  return getUnit(defId).position === 'melee';
}

/** 近距離でも高台に置ける職分（鈎縄師：本家の配置可能マスが地上・高台の両方） */
const HIGH_GROUND_MELEE_SUBPROF = new Set(['hookmaster']);

/** そのオペレーターを置けるマスか */
export function canPlace(pos: number, defId: string): boolean {
  if (pos < 0 || pos >= BOARD_CELLS) return false;
  const t = tileAt(pos);
  if (isGroundTile(t) || t === 'safe') return true;
  if (t === 'high') return !isMelee(defId) || HIGH_GROUND_MELEE_SUBPROF.has(getUnit(defId).subProfession);
  return false;
}

/** そのマスに置いたオペレーターが敵をブロックできるか（敵が通る地上マス） */
export const canBlockAt = (pos: number) => isGroundTile(tileAt(pos));

/** 経路マスの評価：通る経路の数（合流後のマスは2）。同点なら出現地点寄り（早く攻撃できる）を優先 */
const PATH_WEIGHT = new Map<number, number>();
/** 防衛地点への近さ（0〜1） */
const GOAL_NEAR = new Map<number, number>();

export const SPAWNS: number[] = [];
export let GOAL = 0;
export let ENEMY_PATHS: number[][] = [];
export let PATH_TILES = new Set<number>();

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

/** 使用するマップを切り替える（出現地点・経路を計算し直す） */
export function setActiveMap(id: string | null | undefined): void {
  const map = getMap(id);
  if (map === ACTIVE_MAP && ENEMY_PATHS.length) return;
  ACTIVE_MAP = map;
  MAP_LAYOUT = map.layout;
  SPAWNS.length = 0;
  for (let p = 0; p < BOARD_CELLS; p++) {
    if (tileAt(p) === 'spawn') SPAWNS.push(p);
    if (tileAt(p) === 'goal') GOAL = p;
  }
  // 出現地点は上（0）→下（1）の順
  SPAWNS.sort((a, b) => cellY(a) - cellY(b));
  ENEMY_PATHS = SPAWNS.map(findPath);
  PATH_TILES = new Set(ENEMY_PATHS.flat());
  PATH_WEIGHT.clear();
  GOAL_NEAR.clear();
  for (const path of ENEMY_PATHS) {
    path.forEach((p, i) => {
      if (p === GOAL) return;
      PATH_WEIGHT.set(p, (PATH_WEIGHT.get(p) ?? 0) + 1);
      GOAL_NEAR.set(p, Math.max(GOAL_NEAR.get(p) ?? 0, i / path.length));
    });
  }
}

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

/** 前方 reach マスまでにいるオペレーター（近い順） */
export function frontsOf(board: OwnedUnit[], o: OwnedUnit, reach: number): OwnedUnit[] {
  const [dx, dy] = DIR_DELTA[o.dir ?? DEFAULT_DIRECTION];
  const out: OwnedUnit[] = [];
  for (let k = 1; k <= reach; k++) {
    const f = offset(board, o, dx * k, dy * k);
    if (f) out.push(f);
  }
  return out;
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
 * 5000の物理ダメージを与えて基礎攻撃力とブロック数を得る。被捕食者の等級ぶん【エーギル】の加算数が増える。
 *
 * 捕食で上がった後の基礎攻撃力・ブロック数を捕食できる（連鎖する）。捕食する前に、被捕食者が【エーギル】なら
 * その者の捕食を先に済ませる（連鎖の先から順に捕食する）ので、連鎖の根元の者が全員分を得る。
 * 向き合った2人やループでは、捕食を始めた者は捕食されない（その者を前にした者は捕食せずに倒れる）。
 * 捕食で倒れたオペレーターも捕食対象になる（2人で同じ者を捕食できる）。
 */
export function egirDevour(board: OwnedUnit[], egirMembers: Set<number>, damage = 5000) {
  const atkGain = new Map<number, number>();
  const blockGain = new Map<number, number>();
  const dead = new Set<number>();
  /** 捕食された回数（戦闘開始時にその回数だけ物理ダメージを受ける） */
  const hits = new Map<number, number>();
  const done = new Set<number>();
  const busy = new Set<number>();
  let stacks = 0;
  const order = board
    .filter((o) => egirMembers.has(o.uid) && o.pos !== undefined)
    .sort((a, b) => cellX(a.pos!) - cellX(b.pos!) || cellY(a.pos!) - cellY(b.pos!));
  const isEgir = new Set(order.map((o) => o.uid));
  const devour = (eater: OwnedUnit) => {
    if (done.has(eater.uid) || dead.has(eater.uid)) return;
    const prey = frontOf(board, eater);
    // 捕食を始めた者を前にした者は捕食しない
    if (!prey || busy.has(prey.uid)) {
      done.add(eater.uid);
      return;
    }
    busy.add(eater.uid);
    if (isEgir.has(prey.uid)) devour(prey);
    busy.delete(eater.uid);
    done.add(eater.uid);
    const preyDef = getUnit(prey.defId);
    const st = unitState(preyDef, prey.star).stats;
    atkGain.set(eater.uid, (atkGain.get(eater.uid) ?? 0) + st.atk + (atkGain.get(prey.uid) ?? 0));
    blockGain.set(eater.uid, (blockGain.get(eater.uid) ?? 0) + st.block + (blockGain.get(prey.uid) ?? 0));
    stacks += preyDef.tier;
    hits.set(prey.uid, (hits.get(prey.uid) ?? 0) + 1);
    if (!dead.has(prey.uid) && st.hp <= Math.max(damage - st.def, damage * 0.05)) dead.add(prey.uid);
  };
  for (const eater of order) devour(eater);
  // 捕食した後に捕食された者も、得た基礎攻撃力・ブロック数は持ち続ける（耐える・復活・再配置した時に効く）
  return { atkGain, blockGain, dead, hits, stacks };
}

setActiveMap(LEGACY_MAP.id);
