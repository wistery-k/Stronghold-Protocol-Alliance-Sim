import { DIRECTIONS, DIR_DELTA, canBlockAt, cellPos, cellX, cellY, tileAt, unitAt, BOARD_COLS, BOARD_ROWS } from './board';
import { getUnit } from './data/units';
import type { Direction, OwnedUnit } from './types';

// キャサリンの支援装置：準備フェーズでプレイヤーが置く（配置時に3個獲得し、同時に置けるのは2個まで）

export const DEVICE_MAX = 2;
const CATHY_CHAR_ID = 'char_4162_cathy';

export interface Device {
  pos: number;
  dir: Direction;
}

/** 支援装置を使えるオペレーターか */
export const isDeviceHolder = (defId: string) => getUnit(defId).charId === CATHY_CHAR_ID;

/** 装置を置けるマスか（敵が通る地上マスと敵が通らない地上マス。高台・出現地点・防衛地点などには置けない） */
export const deviceTile = (pos: number) => tileAt(pos) === 'safe' || canBlockAt(pos);

/** 場にいるキャサリンの、いま有効な装置（オペレーターが乗ったマスや重複したマスのものは除く） */
export function validDevices(board: OwnedUnit[], o: OwnedUnit): Device[] {
  if (o.pos === undefined || !isDeviceHolder(o.defId)) return [];
  const out: Device[] = [];
  for (const d of o.devices ?? []) {
    if (out.length >= DEVICE_MAX) break;
    const other = board.some((b) => b !== o && (b.devices ?? []).some((x) => x.pos === d.pos));
    if (!deviceTile(d.pos) || unitAt(board, d.pos) || other || out.some((x) => x.pos === d.pos)) continue;
    out.push(d);
  }
  return out;
}

/** そのマスに置かれている装置（どのキャサリンのものでも） */
export function deviceAt(board: OwnedUnit[], pos: number): { owner: OwnedUnit; index: number } | undefined {
  for (const owner of board) {
    const index = (owner.devices ?? []).findIndex((d) => d.pos === pos);
    if (index >= 0) return { owner, index };
  }
  return undefined;
}

/** 隣のマスにいるオペレーターの方を向く（敵をブロックする者を優先。いなければ右） */
export function autoDeviceDir(board: OwnedUnit[], pos: number): Direction {
  const x = cellX(pos);
  const y = cellY(pos);
  let best: { dir: Direction; score: number } | null = null;
  for (const dir of DIRECTIONS) {
    const [dx, dy] = DIR_DELTA[dir];
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= BOARD_COLS || ny >= BOARD_ROWS) continue;
    const t = unitAt(board, cellPos(nx, ny));
    if (!t) continue;
    const score = canBlockAt(t.pos!) ? 2 : 1;
    if (!best || score > best.score) best = { dir, score };
  }
  return best?.dir ?? 'right';
}

/** 装置を置く。エラーならメッセージを返す */
export function placeDevice(board: OwnedUnit[], o: OwnedUnit, pos: number, dir?: Direction): string | undefined {
  if (o.pos === undefined || !isDeviceHolder(o.defId)) return '配置中のキャサリンを選んでください';
  if (validDevices(board, o).length >= DEVICE_MAX) return `支援装置は同時に${DEVICE_MAX}個までです`;
  if (!deviceTile(pos)) return '支援装置は地上マスにしか置けません';
  if (unitAt(board, pos)) return 'オペレーターがいるマスには置けません';
  if (deviceAt(board, pos)) return 'すでに支援装置があります';
  o.devices = [...validDevices(board, o), { pos, dir: dir ?? autoDeviceDir(board, pos) }];
  return undefined;
}

export function turnDevice(o: OwnedUnit, pos: number, dir: Direction): string | undefined {
  const d = o.devices?.find((x) => x.pos === pos);
  if (!d) return '支援装置が見つかりません';
  d.dir = dir;
  return undefined;
}

export function removeDevice(o: OwnedUnit, pos: number): void {
  o.devices = (o.devices ?? []).filter((d) => d.pos !== pos);
}

/** 盤面の変化（配置・移動・控えに戻す）の後に、使えなくなった装置を片付ける */
export function pruneDevices(board: OwnedUnit[]): void {
  for (const o of board) {
    if (!o.devices) continue;
    o.devices = validDevices(board, o);
    if (!o.devices.length) delete o.devices;
  }
}
