import {
  BOARD_CELLS,
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_DIRECTION,
  DIRECTIONS,
  DIRECTION_NAME,
  GOAL,
  PATH_TILES,
  SPAWNS,
  TILE_NAME,
  canPlace,
  cellX,
  cellY,
  tileAt,
  unitRangeCells,
} from '../core/board';
import { roundEnemySummary, type RoundSpec } from '../core/data/battle';
import { getUnit } from '../core/data/units';
import { ENEMY_HP_SCALE } from '../core/rules';
import type { BattleResult } from '../core/sim';
import type { Direction, OwnedUnit, Star } from '../core/types';
import { makeDropTarget, starBadge, unitCard, type CardOptions } from './components';
import { fmt, h, pct, s } from './dom';

// マップ戦闘まわりの表示：配置マップ、ラウンドの敵、予測、戦闘結果とリプレイ

const DIR_ARROW: Record<Direction, string> = { up: '↑', right: '→', down: '↓', left: '←' };

/** 配置マップ。カードの辺をクリックで向きを変更、マウスを乗せると攻撃範囲を表示 */
export function mapGrid(
  board: OwnedUnit[],
  opts: {
    cardOptions: (o: OwnedUnit) => CardOptions;
    onDropCell: (pos: number, uid: number) => void;
    onTurn: (uid: number, dir: Direction) => void;
    onItemDrop?: (unitUid: number, itemUid: number) => void;
  },
) {
  const cells: HTMLElement[] = [];
  const highlight = (o: OwnedUnit | null) => {
    for (const c of cells) c.classList.remove('in-range', 'in-skill-range');
    if (!o) return;
    const normal = new Set(unitRangeCells(o));
    for (const p of normal) cells[p]?.classList.add('in-range');
    for (const p of unitRangeCells(o, true)) if (!normal.has(p)) cells[p]?.classList.add('in-skill-range');
  };

  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    const tile = tileAt(pos);
    const o = board.find((b) => b.pos === pos);
    const cell = h(
      'div',
      { class: `cell t-${tile}${PATH_TILES.has(pos) ? ' path' : ''}`, title: TILE_NAME[tile] },
      tile === 'spawn' ? h('span', { class: 'tile-label' }, '出現') : null,
      tile === 'goal' ? h('span', { class: 'tile-label' }, '防衛') : null,
      tile === 'high' && !o ? h('span', { class: 'tile-label faint' }, '高台') : null,
    );
    if (o) {
      const dir = o.dir ?? DEFAULT_DIRECTION;
      const base = opts.cardOptions(o);
      cell.append(
        unitCard(o.defId, {
          star: o.star,
          dragUid: o.uid,
          ...base,
          onHover: (enter) => {
            highlight(enter ? o : null);
            base.onHover?.(enter);
          },
        }),
        // 長方形の上下左右の辺をクリックすると、その方向を向く
        ...DIRECTIONS.map((d) =>
          h('button', {
            class: `edge edge-${d}${d === dir ? ' on' : ''}`,
            title: `${DIRECTION_NAME[d]}を向く`,
            'aria-label': `${DIRECTION_NAME[d]}を向く`,
            onclick: (e: Event) => {
              e.stopPropagation();
              opts.onTurn(o.uid, d);
            },
          }),
        ),
      );
    }
    if (tile === 'ground' || tile === 'safe' || tile === 'high') makeDropTarget(cell, (uid) => opts.onDropCell(pos, uid));
    cells.push(cell);
  }
  return h(
    'div',
    { class: 'grid-wrap' },
    h(
      'div',
      { class: 'map-legend small muted' },
      h('span', { class: 'lg t-ground' }, '地上'),
      h('span', { class: 'lg t-safe' }, '地上（敵は通らない）'),
      h('span', { class: 'lg t-high' }, '高台（遠距離のみ）'),
      h('span', { class: 'lg path' }, '敵の経路'),
      h('span', null, '辺クリックで向き変更・マウスを乗せると攻撃範囲'),
    ),
    h('div', { class: 'map-scroll' }, h('div', { class: 'board-grid map', style: `grid-template-columns: repeat(${BOARD_COLS}, minmax(0, 1fr))` }, cells)),
  );
}

/** そのマスに置けるかの説明（ドラッグ中の案内用） */
export function placeHint(defId: string, pos: number): string | null {
  return canPlace(pos, defId) ? null : tileAt(pos) === 'high' ? '高台には遠距離オペレーターのみ' : '置けないマス';
}

/** ラウンドに出てくる敵の一覧 */
export function roundInfo(spec: RoundSpec, timeLimit: number) {
  const list = roundEnemySummary(spec);
  const total = list.reduce((sum, x) => sum + x.count, 0);
  return h(
    'div',
    { class: 'round-info' },
    h(
      'div',
      { class: 'enemy-stats' },
      h('span', null, `敵 ${total}体`),
      h('span', null, `時間 ${timeLimit}秒`),
      ENEMY_HP_SCALE !== 1 ? h('span', { class: 'muted', title: 'ボス以外の敵HPの倍率' }, `HP×${ENEMY_HP_SCALE}`) : null,
    ),
    h(
      'table',
      { class: 'enemy-table' },
      h('thead', null, h('tr', null, h('th', null, '敵'), h('th', null, '数'), h('th', null, 'HP'), h('th', null, '防御'), h('th', null, '術耐'))),
      h(
        'tbody',
        null,
        list.map(({ enemy, count }) =>
          h(
            'tr',
            { class: enemy.boss ? 'boss' : '' },
            h(
              'td',
              null,
              enemy.boss ? h('span', { class: 'badge' }, 'BOSS') : null,
              enemy.flying ? h('span', { class: 'badge fly', title: '飛行：ブロックできず、近距離オペレーターは攻撃できない' }, '飛行') : null,
              enemy.name,
            ),
            h('td', null, count),
            h('td', null, fmt(enemy.boss ? enemy.hp : enemy.hp * ENEMY_HP_SCALE)),
            h('td', null, enemy.def),
            h('td', null, enemy.res),
          ),
        ),
      ),
    ),
  );
}

/** 予測結果の1行サマリー */
export function predictionLine(r: BattleResult) {
  if (r.cleared) return h('div', { class: 'predict ok' }, `全滅見込み（${r.elapsed}秒）`);
  return h(
    'div',
    { class: 'predict ng' },
    `突破 ${r.leaked}/${r.total}体の見込み：耐久値-${r.lifeLoss}`,
    r.bossRemaining > 0 ? `（ボス残りHP ${pct(r.bossRemaining)}）` : '',
  );
}

// ------------------------------------------------------------
// 戦闘結果
// ------------------------------------------------------------

export interface ReplayUnit {
  uid: number;
  defId: string;
  star: Star;
  pos?: number;
  dir?: Direction;
}

function remainingChart(r: BattleResult) {
  const W = 560;
  const H = 140;
  const pad = { l: 64, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const tMax = Math.max(1, r.elapsed);
  const hpMax = Math.max(1, ...r.timeline.map((p) => p.hp));
  const x = (t: number) => pad.l + (Math.min(t, tMax) / tMax) * iw;
  const y = (hp: number) => pad.t + (1 - hp / hpMax) * ih;
  const path = r.timeline.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.hp).toFixed(1)}`).join(' ');
  const ticks: number[] = [];
  const step = tMax > 90 ? 30 : tMax > 40 ? 15 : 10;
  for (let t = 0; t <= tMax; t += step) ticks.push(t);
  return s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': '残っている敵の合計HPの推移' },
    [0, 0.5, 1].map((f) =>
      s(
        'g',
        {},
        s('line', { x1: pad.l, x2: W - pad.r, y1: y(hpMax * f), y2: y(hpMax * f), class: 'grid' }),
        s('text', { x: pad.l - 6, y: y(hpMax * f) + 4, class: 'axis', 'text-anchor': 'end' }, fmt(hpMax * f)),
      ),
    ),
    ticks.map((t) => s('text', { x: x(t), y: H - 6, class: 'axis', 'text-anchor': 'middle' }, `${t}s`)),
    s('path', { d: path, class: 'hp-line' }),
  );
}

function damageBars(r: BattleResult) {
  const sorted = [...r.perUnit].sort((a, b) => b.damage - a.damage);
  const max = Math.max(1, ...sorted.map((u) => u.damage));
  const total = Math.max(1, r.totalDamage);
  return h(
    'ul',
    { class: 'bars' },
    sorted.map((u) =>
      h(
        'li',
        null,
        h('span', { class: 'bar-name' }, u.name, ' ', starBadge(u.star)),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${(u.damage / max) * 100}%` })),
        h('span', { class: 'bar-val' }, `${fmt(u.damage)}（${pct(u.damage / total)}）`),
        h('span', { class: 'bar-sub muted' }, `撃破 ${u.kills}・DPS ${fmt(u.damage / Math.max(1, r.elapsed))}・スキル${u.skillCasts}回`),
      ),
    ),
  );
}

export function battleSummary(r: BattleResult, units: ReplayUnit[]) {
  return h(
    'div',
    { class: 'sim-summary' },
    h(
      'div',
      { class: `verdict ${r.cleared ? 'ok' : 'ng'}` },
      r.cleared ? `全滅！ ${r.elapsed}秒` : `突破 ${r.leaked}体　耐久値-${r.lifeLoss}`,
    ),
    h(
      'div',
      { class: 'kpis' },
      h('div', null, h('span', { class: 'muted small' }, '撃破'), h('b', null, `${r.killed}/${r.total}`)),
      h('div', null, h('span', { class: 'muted small' }, '総ダメージ'), h('b', null, fmt(r.totalDamage))),
      h('div', null, h('span', { class: 'muted small' }, '平均DPS'), h('b', null, fmt(r.totalDamage / Math.max(1, r.elapsed)))),
      r.bossRemaining > 0 ? h('div', null, h('span', { class: 'muted small' }, 'ボス残りHP'), h('b', { class: 'ng' }, pct(r.bossRemaining))) : null,
    ),
    r.frames ? replayPlayer(r, units) : h('p', { class: 'muted small' }, 'リプレイは戦闘直後のみ表示できます'),
    r.leaks.length
      ? h(
          'p',
          { class: 'small' },
          h('b', null, '突破した敵：'),
          r.leaks.map((l) => `${l.name}×${l.count}${l.lifeLoss ? `（-${l.lifeLoss}）` : ''}`).join('、'),
        )
      : null,
    h('h3', null, '残っている敵の合計HP'),
    remainingChart(r),
    h('h3', null, 'オペレーターごとの与ダメージ'),
    damageBars(r),
  );
}

// ------------------------------------------------------------
// リプレイ
// ------------------------------------------------------------

const TILE_FILL: Record<string, string> = {
  ground: 'var(--tile-ground)',
  safe: 'var(--tile-safe)',
  high: 'var(--tile-high)',
  wall: 'var(--tile-wall)',
  spawn: 'var(--tile-spawn)',
  goal: 'var(--tile-goal)',
};

export function replayPlayer(r: BattleResult, units: ReplayUnit[]) {
  const frames = r.frames ?? [];
  const meta = new Map(r.enemies.map((e) => [e.id, e]));
  const S = 100;
  const svg = s('svg', { viewBox: `0 0 ${BOARD_COLS * S} ${BOARD_ROWS * S}`, class: 'replay', role: 'img', 'aria-label': '戦闘のリプレイ' });

  // マップ
  for (let p = 0; p < BOARD_CELLS; p++) {
    const t = tileAt(p);
    svg.append(
      s('rect', { x: cellX(p) * S + 1, y: cellY(p) * S + 1, width: S - 2, height: S - 2, rx: 6, fill: TILE_FILL[t], class: PATH_TILES.has(p) ? 'rp-path' : '' }),
    );
  }
  for (const p of SPAWNS) svg.append(s('text', { x: cellX(p) * S + S / 2, y: cellY(p) * S + 58, class: 'rp-label', 'text-anchor': 'middle' }, '出現'));
  svg.append(s('text', { x: cellX(GOAL) * S + S / 2, y: cellY(GOAL) * S + 58, class: 'rp-label', 'text-anchor': 'middle' }, '防衛'));

  // オペレーター
  const unitNodes = new Map<number, SVGElement>();
  for (const u of units) {
    if (u.pos === undefined) continue;
    const def = getUnit(u.defId);
    const x = cellX(u.pos) * S;
    const y = cellY(u.pos) * S;
    const g = s(
      'g',
      { class: 'rp-unit' },
      s('rect', { x: x + 8, y: y + 8, width: S - 16, height: S - 16, rx: 8, class: `rp-unit-box tier-${def.tier}` }),
      s('text', { x: x + S / 2, y: y + 44, 'text-anchor': 'middle', class: 'rp-unit-name' }, def.name.length > 6 ? def.name.slice(0, 6) : def.name),
      s('text', { x: x + S / 2, y: y + 70, 'text-anchor': 'middle', class: 'rp-unit-dir' }, DIR_ARROW[u.dir ?? DEFAULT_DIRECTION]),
    );
    unitNodes.set(u.uid, g);
    svg.append(g);
  }

  // 敵
  const enemyLayer = s('g', {});
  svg.append(enemyLayer);
  const enemyNodes = new Map<number, { g: SVGElement; bar: SVGElement }>();
  const enemyNode = (id: number) => {
    let n = enemyNodes.get(id);
    if (n) return n;
    const m = meta.get(id)!;
    const rad = m.boss ? 30 : 17;
    const bar = s('rect', { x: -rad, y: -rad - 12, width: rad * 2, height: 6, class: 'rp-hp' });
    const g = s(
      'g',
      { class: `rp-enemy${m.boss ? ' boss' : ''}${m.flying ? ' fly' : ''}` },
      s('circle', { r: rad, class: 'rp-enemy-body' }),
      s('rect', { x: -rad, y: -rad - 12, width: rad * 2, height: 6, class: 'rp-hp-bg' }),
      bar,
    );
    g.append(s('title', {}, m.name));
    n = { g, bar };
    enemyNodes.set(id, n);
    enemyLayer.append(g);
    return n;
  };

  const timeLabel = h('span', { class: 'rp-time' }, '0.0秒');
  const slider = h('input', { type: 'range', min: 0, max: Math.round(r.elapsed * 10), value: 0, class: 'rp-slider', 'aria-label': '再生位置' }) as HTMLInputElement;
  let t = 0;
  let speed = 2;
  let playing = true;
  let last = performance.now();

  const findFrame = (time: number) => {
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const draw = () => {
    if (!frames.length) return;
    const i = findFrame(t);
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const f = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
    const next = new Map(b.e.map((e) => [e[0], e]));
    const seen = new Set<number>();
    for (const e of a.e) {
      const n = enemyNode(e[0]);
      const nb = next.get(e[0]);
      const x = nb ? e[1] + (nb[1] - e[1]) * f : e[1];
      const y = nb ? e[2] + (nb[2] - e[2]) * f : e[2];
      n.g.setAttribute('transform', `translate(${(x / 100) * S + S / 2},${(y / 100) * S + S / 2})`);
      const m = meta.get(e[0])!;
      const rad = m.boss ? 30 : 17;
      n.bar.setAttribute('width', String(Math.max(0, (e[3] / 100) * rad * 2)));
      n.g.style.display = '';
      seen.add(e[0]);
    }
    for (const [id, n] of enemyNodes) if (!seen.has(id)) n.g.style.display = 'none';
    const skill = new Set(a.s);
    for (const [uid, g] of unitNodes) g.classList.toggle('skill', skill.has(uid));
    timeLabel.textContent = `${t.toFixed(1)}秒`;
    slider.value = String(Math.round(t * 10));
  };

  const loop = (now: number) => {
    if (!svg.isConnected) return;
    const dtReal = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      t = Math.min(r.elapsed, t + dtReal * speed);
      if (t >= r.elapsed) playing = false;
      playBtn.textContent = playing ? '一時停止' : t >= r.elapsed ? 'もう一度' : '再生';
    }
    draw();
    requestAnimationFrame(loop);
  };

  const playBtn = h('button', {
    class: 'btn small',
    onclick: () => {
      if (t >= r.elapsed) t = 0;
      playing = !playing;
      playBtn.textContent = playing ? '一時停止' : '再生';
    },
  }, '一時停止');
  const speedBtns = [1, 2, 4, 8].map((v) =>
    h('button', {
      class: `btn tiny${v === speed ? ' on' : ''}`,
      onclick: (e: Event) => {
        speed = v;
        for (const el of speedBtns) el.classList.remove('on');
        (e.currentTarget as HTMLElement).classList.add('on');
      },
    }, `×${v}`),
  );
  slider.addEventListener('input', () => {
    t = Number(slider.value) / 10;
    draw();
  });

  requestAnimationFrame((now) => {
    last = now;
    loop(now);
  });

  return h(
    'div',
    { class: 'replay-wrap' },
    svg,
    h('div', { class: 'row rp-controls' }, playBtn, speedBtns, slider, timeLabel),
    h('div', { class: 'muted small' }, '●地上の敵　◌飛行の敵　大きい丸はボス。光っているオペレーターはスキル発動中'),
  );
}
