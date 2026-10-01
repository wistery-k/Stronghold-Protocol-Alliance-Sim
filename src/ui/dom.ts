// 依存なしの小さな DOM ヘルパー

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function h(tag: string, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'style') {
        el.setAttribute('style', String(v));
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el: Element, children: (Child | Child[])[]) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag: string, attrs: Record<string, string | number> = {}, ...children: (Child | Child[])[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  appendChildren(el, children);
  return el;
}

export const fmt = (n: number) => Math.round(n).toLocaleString('ja-JP');
export const pct = (n: number) => `${Math.round(n * 100)}%`;
