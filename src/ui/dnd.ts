// ポインターイベントによるドラッグ&ドロップ。
// ブラウザ標準の HTML5 ドラッグ&ドロップは環境によって動かないことがあるので、自前で実装する。
// マウスでもタッチでも動き、ドロップするまで画面を再描画しない。

export type DragKind = 'unit' | 'item';

interface DropHandlers {
  unit?: (uid: number) => void;
  item?: (uid: number) => void;
}

const targets = new WeakMap<Element, DropHandlers>();

/** ドラッグを始めるまでの移動量（px） */
const THRESHOLD = 6;

interface DragState {
  kind: DragKind;
  uid: number;
  source: HTMLElement;
  startX: number;
  startY: number;
  pointerId: number;
  ghost: HTMLElement | null;
  over: Element | null;
}

let drag: DragState | null = null;
/** ドラッグ直後のクリックを無視する */
let suppressClick = false;

export const isDragging = () => !!drag?.ghost;

/** 要素をドロップ先にする */
export function registerDropTarget(el: Element, handlers: DropHandlers): void {
  targets.set(el, { ...targets.get(el), ...handlers });
}

/** ポインター位置の下にある、その種類を受け付けるドロップ先 */
function findTarget(x: number, y: number, kind: DragKind): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const h = targets.get(el);
    if (h?.[kind]) return el;
    el = el.parentElement;
  }
  return null;
}

function setOver(el: Element | null, kind: DragKind) {
  if (!drag || drag.over === el) return;
  drag.over?.classList.remove('drop-over', 'item-over');
  drag.over = el;
  el?.classList.add(kind === 'item' ? 'item-over' : 'drop-over');
}

function startGhost(d: DragState, x: number, y: number) {
  const rect = d.source.getBoundingClientRect();
  const ghost = d.source.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.append(ghost);
  d.ghost = ghost;
  d.source.classList.add('drag-source');
  document.body.classList.add('dragging');
  moveGhost(d, x, y);
}

function moveGhost(d: DragState, x: number, y: number) {
  if (!d.ghost) return;
  const w = d.ghost.offsetWidth;
  const h = d.ghost.offsetHeight;
  d.ghost.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px)`;
}

function cleanup() {
  if (!drag) return;
  drag.ghost?.remove();
  drag.source.classList.remove('drag-source');
  drag.over?.classList.remove('drop-over', 'item-over');
  document.body.classList.remove('dragging');
  drag = null;
}

function onMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < THRESHOLD) return;
    startGhost(drag, e.clientX, e.clientY);
  }
  e.preventDefault();
  moveGhost(drag, e.clientX, e.clientY);
  setOver(findTarget(e.clientX, e.clientY, drag.kind), drag.kind);
}

function onUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  if (!d.ghost) {
    // 動かしていなければただのクリック
    drag = null;
    return;
  }
  const target = findTarget(e.clientX, e.clientY, d.kind);
  cleanup();
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  const handler = target ? targets.get(target)?.[d.kind] : undefined;
  if (handler) handler(d.uid);
}

function onCancel(e: PointerEvent) {
  if (drag && e.pointerId === drag.pointerId) cleanup();
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cleanup();
  });
  // ドラッグを終えた直後のクリック（選択など）を無視する
  window.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

/** 要素をドラッグできるようにする */
export function makeDraggable(el: HTMLElement, kind: DragKind, uid: number): void {
  install();
  el.classList.add('draggable');
  // ブラウザ標準のドラッグ（画像・文字の選択）を止める
  el.addEventListener('dragstart', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    // 向きを変えるボタンなどからは始めない
    if ((e.target as Element).closest('button')) return;
    drag = { kind, uid, source: el, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, ghost: null, over: null };
  });
}
