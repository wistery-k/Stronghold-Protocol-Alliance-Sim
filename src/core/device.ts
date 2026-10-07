import { BOARD_COLS, BOARD_ROWS, DIRECTIONS, DIR_DELTA, PATH_TILES, canBlockAt, cellPos, cellX, cellY, tileAt, unitAt } from './board';
import { getUnit, unitState } from './data/units';
import { BENCH_SIZE } from './rules';
import { isDeviceEntry, type BenchEntry, type Direction, type OwnedDevice, type OwnedUnit } from './types';

// キャサリンの支援装置：オペレーターと同じように、場・控えへ置き、ドラッグで動かし、辺のクリックで向きを変える。
// キャサリンを場に置くと3個獲得し（場に出せるのは同時に2個まで）、キャサリンが場を離れると消える。売却はできない

/** キャサリン1人につき同時に置ける数 */
export const DEVICE_MAX = 2;
/** キャサリン1人を場に置いた時に獲得する数 */
export const DEVICES_PER_CATHY = 3;
const CATHY_CHAR_ID = 'char_4162_cathy';

export interface Device {
  pos: number;
  dir: Direction;
}

/** 支援装置を使えるオペレーターか */
export const isDeviceHolder = (defId: string) => getUnit(defId).charId === CATHY_CHAR_ID;

/** 装置を置けるマスか（敵が通る地上マスと敵が通らない地上マス。高台・出現地点・防衛地点などには置けない） */
export const deviceTile = (pos: number) => tileAt(pos) === 'safe' || canBlockAt(pos);

/** 場にいるキャサリン */
export const holdersOn = (board: OwnedUnit[]) => board.filter((o) => o.pos !== undefined && isDeviceHolder(o.defId));

/** 場に置ける装置の上限（場にいるキャサリン×2） */
export const deviceCap = (board: OwnedUnit[]) => holdersOn(board).length * DEVICE_MAX;

export interface DeviceHost {
  board: OwnedUnit[];
  devices: OwnedDevice[];
  bench?: BenchEntry[];
  nextUid: number;
}

export function findDevice(host: Pick<DeviceHost, 'devices' | 'bench'>, uid: number): { device: OwnedDevice; where: 'board' | 'bench'; index: number } | null {
  const bi = host.devices.findIndex((d) => d.uid === uid);
  if (bi >= 0) return { device: host.devices[bi], where: 'board', index: bi };
  const ni = (host.bench ?? []).findIndex((b) => isDeviceEntry(b) && b.uid === uid);
  if (ni >= 0) return { device: host.bench![ni] as OwnedDevice, where: 'bench', index: ni };
  return null;
}

export const deviceAt = (devices: OwnedDevice[], pos: number) => devices.find((d) => d.pos === pos);

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

/** 装置の前方1マス */
export const deviceFront = (d: Device) => cellPos(cellX(d.pos) + DIR_DELTA[d.dir][0], cellY(d.pos) + DIR_DELTA[d.dir][1]);

const inBoard = (x: number, y: number) => x >= 0 && y >= 0 && x < BOARD_COLS && y < BOARD_ROWS;

/**
 * 自動で置く場所。支援先は、敵をブロックする味方→最大HPの高い順（すでに装置が向いている味方は除く）。
 * 置き場所は支援先の隣の空きマス（敵が通らないマス→敵の経路でないマス→経路のマスの順）で、支援先の方を向く。
 * 支援先になる味方がいなければ、キャサリンの隣の空きマスからキャサリンの方を向けて置く
 */
export function deviceSpot(board: OwnedUnit[], devices: OwnedDevice[]): Device | null {
  const used = new Set(devices.filter((d) => d.pos !== undefined).map((d) => d.pos!));
  const covered = new Set(devices.filter((d) => d.pos !== undefined).map((d) => deviceFront({ pos: d.pos!, dir: d.dir ?? 'right' })));
  const rank = (c: number) => (tileAt(c) === 'safe' ? 0 : PATH_TILES.has(c) ? 2 : 1);
  const spotFor = (t: OwnedUnit): Device | null => {
    let best: (Device & { rank: number }) | null = null;
    for (const dir of DIRECTIONS) {
      const [dx, dy] = DIR_DELTA[dir];
      const x = cellX(t.pos!) - dx;
      const y = cellY(t.pos!) - dy;
      if (!inBoard(x, y)) continue;
      const c = cellPos(x, y);
      if (!deviceTile(c) || unitAt(board, c) || used.has(c)) continue;
      if (!best || rank(c) < best.rank) best = { pos: c, dir, rank: rank(c) };
    }
    return best ? { pos: best.pos, dir: best.dir } : null;
  };
  const hp = (u: OwnedUnit) => unitState(getUnit(u.defId), u.star).stats.hp;
  const targets = board
    .filter((t) => t.pos !== undefined && !isDeviceHolder(t.defId) && !covered.has(t.pos))
    .sort((a, b) => Number(canBlockAt(b.pos!)) - Number(canBlockAt(a.pos!)) || hp(b) - hp(a));
  for (const t of targets) {
    const s = spotFor(t);
    if (s) return s;
  }
  for (const h of holdersOn(board)) {
    if (covered.has(h.pos!)) continue;
    const s = spotFor(h);
    if (s) return s;
  }
  return null;
}

/**
 * キャサリンが場にいる数に合わせて装置を増減する（盤面が変わるたびに呼ぶ）。
 * 1人につき3個：新しく増える分は、場に出せる数（1人2個）に空きがあれば自動で場に、なければ控えに置く（控えに空きが無ければ作らない）。
 * キャサリンが減ったら、控えの装置から先に消す。すでにある装置の位置は動かさない
 */
export function syncDevices(host: DeviceHost): void {
  const want = holdersOn(host.board).length * DEVICES_PER_CATHY;
  const benchDevs = () => (host.bench ?? []).filter(isDeviceEntry);
  let total = host.devices.length + benchDevs().length;
  while (total > want) {
    const b = benchDevs().at(-1);
    if (b) host.bench![host.bench!.indexOf(b)] = null;
    else host.devices.pop();
    total--;
  }
  while (total < want) {
    const device: OwnedDevice = { uid: host.nextUid, device: true };
    const spot = host.devices.length < deviceCap(host.board) ? deviceSpot(host.board, host.devices) : null;
    if (spot) host.devices.push({ ...device, ...spot });
    else {
      const empty = host.bench ? host.bench.slice(0, BENCH_SIZE).indexOf(null) : -1;
      if (empty < 0) break;
      host.bench![empty] = device;
    }
    host.nextUid++;
    total++;
  }
}

/** 戦闘に使う装置：有効な（置けるマスで、オペレーターが乗っておらず、重複しない）場の装置を、場のキャサリンに先頭から2個ずつ割り当てる */
export function simDevices(board: OwnedUnit[], devices: OwnedDevice[]): Map<number, Device[]> {
  const out = new Map<number, Device[]>();
  const seen = new Set<number>();
  const valid: Device[] = [];
  for (const d of devices) {
    if (d.pos === undefined || seen.has(d.pos) || !deviceTile(d.pos) || unitAt(board, d.pos)) continue;
    seen.add(d.pos);
    valid.push({ pos: d.pos, dir: d.dir ?? 'right' });
  }
  holdersOn(board).forEach((h, i) => out.set(h.uid, valid.slice(i * DEVICE_MAX, (i + 1) * DEVICE_MAX)));
  return out;
}
