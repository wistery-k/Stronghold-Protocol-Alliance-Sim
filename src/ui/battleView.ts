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
  isGroundTile,
  MAP_LAYOUT,
  tileAt,
  type TileType,
  unitRangeCells,
} from '../core/board';
import { ENEMIES, groupLabel, roundEnemySummary, type EnemySpec, type RoundGroup, type RoundSpec } from '../core/data/battle';
import { getUnit } from '../core/data/units';
import { ENEMY_ATK_SCALE, ENEMY_HP_SCALE } from '../core/rules';
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
      SPECIAL_LABEL[tile] && !o ? h('span', { class: 'tile-label faint' }, SPECIAL_LABEL[tile]) : null,
      tile === 'barricade' ? h('span', { class: 'barricade-box', 'aria-label': '障害物' }) : null,
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
    if (isGroundTile(tile) || tile === 'safe' || tile === 'high') makeDropTarget(cell, (uid) => opts.onDropCell(pos, uid));
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
      MAP_LAYOUT.some((row) => row.includes('7')) ? h('span', { class: 'lg t-floor' }, '配置不可（敵は通る）') : null,
      MAP_LAYOUT.some((row) => row.includes('B')) ? h('span', { class: 'lg t-barricade' }, '障害物') : null,
      ...(['infection', 'mire', 'smog', 'deepsea'] as const)
        .filter((tl) => MAP_LAYOUT.some((row) => row.includes(SPECIAL_CODE[tl])))
        .map((tl) => h('span', { class: `lg t-${tl}`, title: TILE_NAME[tl] }, SPECIAL_LABEL[tl]!)),
      h('span', { class: 'lg path' }, '敵の経路'),
      h('span', null, '辺クリックで向き変更・マウスを乗せると攻撃範囲'),
    ),
    h('div', { class: 'map-scroll' }, h('div', { class: 'board-grid map', style: `grid-template-columns: repeat(${BOARD_COLS}, minmax(0, 1fr))` }, cells)),
  );
}

/** 特殊なマスの短い名前とマップの記号 */
const SPECIAL_LABEL: Partial<Record<TileType, string>> = { infection: '源石', mire: '沼地', smog: '換気口', deepsea: '深水', floor: '' };
const SPECIAL_CODE = { infection: 'X', mire: 'M', smog: 'G', deepsea: 'D' } as const;

/** そのマスに置けるかの説明（ドラッグ中の案内用） */
export function placeHint(defId: string, pos: number): string | null {
  return canPlace(pos, defId) ? null : tileAt(pos) === 'high' ? '高台には遠距離オペレーターのみ' : '置けないマス';
}

/** 【サルゴン】の強化の要約（最大・平均の層数と攻撃速度） */
function sargonKpi(sg: NonNullable<BattleResult['sargon']>) {
  const atk = (n: number) => (sg.atkPct ? `・攻撃力+${Math.round(n * sg.atkPct * 100)}%` : '');
  return h(
    'div',
    { title: `【サルゴン】のスキル発動時の強化。最大${sg.max}層（攻撃速度+${sg.max * sg.aspd}${atk(sg.max)}）、戦闘中の平均${sg.avg}層（攻撃速度+${Math.round(sg.avg * sg.aspd)}${atk(sg.avg)}）` },
    h('span', { class: 'muted small' }, 'サルゴン AS 最大/平均'),
    h('b', null, `+${sg.max * sg.aspd}/+${Math.round(sg.avg * sg.aspd)}`),
  );
}

const ELEM_SHORT = ['灼', '神', '侵', '壊'];
const ELEM_FULL = ['灼燃損傷', '神経損傷', '侵蝕損傷', '壊死損傷'];

/** 敵の特殊能力のバッジ */
function enemyBadges(e: EnemySpec) {
  const out: HTMLElement[] = [];
  const b = (label: string, title: string, cls = '') => out.push(h('span', { class: `badge ${cls}`, title }, label));
  if (e.boss) b('BOSS', 'ボス');
  if (e.flying) b('飛行', '飛行：ブロックできず、近距離オペレーターは攻撃できない', 'fly');
  if (e.stealth) b('ステルス', 'ステルス：ブロックされている間しか攻撃の対象にならない（特殊能力無効化中は狙える）', 'sp');
  if (e.unblockable) b('ブロック不可', 'ブロックできない', 'sp');
  if (e.hitsToKill) b(`${e.hp}回`, `攻撃${e.hp}回で倒れる（ダメージ量は関係ない）`, 'sp');
  if (e.refract) b(`屈折+${e.refract}`, `屈折：術耐性+${e.refract}（特殊能力無効化中は失う）`, 'sp');
  if (e.hitShield) b('盾', `最初の${e.hitShield}回の攻撃を無効にする`, 'sp');
  if (e.defReduce) b('防御低下', `攻撃を受けるたびに防御${e.defReduce.def}・術耐性${e.defReduce.res}（最大${e.defReduce.max}回）`, 'sp');
  if (e.revive) b('復活', `倒れると攻撃${e.revive.hits}回で倒せる状態になり、${e.revive.interval}秒以内に倒さないと復活する`, 'sp');
  if (e.deathPollution) {
    const p = e.deathPollution;
    b('汚染', `倒れると半径${p.radius}マスに汚染秽蝕を${p.duration}秒残す（範囲内の味方は毎秒HPを失う：HP50%超で${p.high}、以下で${p.low}）`, 'sp');
  }
  if (e.ambush) b('奇襲', `ステルスが解けた後の最初の攻撃は攻撃力${Math.round(e.ambush * 100)}%`, 'sp');
  if (e.enrage) {
    const en = e.enrage;
    const el = en.element ? ELEM_FULL[['burning', 'neural', 'erosion', 'apoptosis'].indexOf(en.element)] : '';
    b('臨戦', `攻撃を受けると臨戦状態：移動速度×${en.speedMult}${el ? `、${en.interval}秒ごとに半径${en.radius}マスの味方へ攻撃力の${Math.round(en.ratio * 100)}%の${el}` : ''}`, 'sp');
  }
  if (e.attack?.aura) b('周囲攻撃', `通常攻撃をせず、半径${e.attack.range}マスの味方全員に${e.attack.interval}秒ごとに${e.attack.arts ? '術' : '物理'}ダメージ${e.element ? 'と元素損傷' : ''}を与え続ける（換気口の上の味方は対象外）`, 'sp');
  if (e.statusResist) b('抵抗', `寒冷・凍結の時間が${Math.round(e.statusResist * 100)}%短くなる`, 'sp');
  if (e.liberty) {
    const l = e.liberty;
    const freed = [
      `攻撃力+${Math.round(l.atk * 100)}%`,
      l.defPen ? `相手の防御力を${Math.round(l.defPen * 100)}%無視` : '',
      l.res ? `術耐性+${l.res}` : '',
      l.regen ? `毎秒HP${l.regen}回復` : '',
    ].filter(Boolean).join('、');
    b(
      '拘束',
      `拘束中は攻撃速度${l.confAspd}${l.confDef ? `・防御力+${l.confDef}` : ''}。${l.times}回攻撃すると解放され、${freed}${l.freeAll ? '。最初の解放時に場の敵をすべて解放する' : ''}`,
      'sp',
    );
  }
  if (e.deadSpawn) {
    const c = ENEMIES[e.deadSpawn.enemy];
    b('分裂', `倒れると${c?.name ?? '敵'}×${e.deadSpawn.count}が現れる${c?.hitsToKill ? `（攻撃${c.hp}回で倒れる・ブロック不可）` : ''}`, 'sp');
  }
  return out;
}

/** ラウンドに出てくる敵の一覧 */
export function roundInfo(spec: RoundSpec, timeLimit: number, group?: RoundGroup | null) {
  const list = roundEnemySummary(spec);
  const total = list.reduce((sum, x) => sum + x.count, 0);
  const bounties = new Map(spec.spawns.filter((s) => s.bounty).map((s) => [s.enemy, s.bounty!]));
  return h(
    'div',
    { class: 'round-info' },
    h(
      'div',
      { class: 'enemy-stats' },
      group ? h('b', null, groupLabel(group)) : null,
      h('span', null, `敵 ${total}体`),
      h('span', null, `時間 ${timeLimit}秒`),
      ENEMY_HP_SCALE !== 1 ? h('span', { class: 'muted', title: 'ボス以外の敵HPの倍率' }, `HP×${ENEMY_HP_SCALE}`) : null,
    ),
    h(
      'table',
      { class: 'enemy-table' },
      h('thead', null, h('tr', null, h('th', null, '敵'), h('th', null, '数'), h('th', null, 'HP'), h('th', null, '防御'), h('th', null, '術耐'), h('th', { title: '攻撃力（近：ブロックした相手を攻撃、遠：範囲内を攻撃、術：術ダメージ）' }, '攻撃'))),
      h(
        'tbody',
        null,
        list.map(({ key, enemy, count }) =>
          h(
            'tr',
            { class: enemy.boss ? 'boss' : bounties.has(key) ? 'bounty' : '' },
            h('td', null, enemy.name, ' ', enemyBadges(enemy), bounties.has(key) ? h('span', { class: 'badge bounty', title: `懸賞：倒すと資金+${bounties.get(key)}（次のラウンドに支給）` }, `懸賞+${bounties.get(key)}`) : null),
            h('td', null, count),
            h('td', null, enemy.hitsToKill ? '-' : fmt(enemy.boss ? enemy.hp : enemy.hp * ENEMY_HP_SCALE)),
            h('td', null, enemy.def),
            h('td', null, Math.min(100, enemy.res + (enemy.refract ?? 0))),
            h(
              'td',
              { title: enemy.attack ? `攻撃間隔 ${enemy.attack.interval}秒${enemy.attack.kind === 'ranged' ? `・射程 ${enemy.attack.range}マス` : ''}` : '攻撃しない' },
              enemy.attack ? `${fmt(enemy.attack.atk * ENEMY_ATK_SCALE)}${enemy.attack.kind === 'ranged' ? '遠' : '近'}${enemy.attack.arts ? '術' : ''}` : '-',
            ),
          ),
        ),
      ),
    ),
  );
}

/** 予測結果の1行サマリー */
export function predictionLine(r: BattleResult) {
  const down = downCount(r);
  const downText = down ? `・撤退${down}人` : '';
  if (r.cleared) return h('div', { class: 'predict ok' }, `${r.bossDefeated ? 'ボス撃破' : '全滅'}見込み（${r.elapsed}秒${downText}）`);
  return h(
    'div',
    { class: 'predict ng' },
    `突破 ${r.leaked}/${r.total}体の見込み：耐久値-${r.lifeLoss}`,
    r.bossRemaining > 0 ? `（ボス残りHP ${pct(r.bossRemaining)}）` : '',
    downText,
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
  const sorted = [...r.perUnit].sort((a, b) => b.damage + (b.healed ?? 0) - (a.damage + (a.healed ?? 0)));
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
        h(
          'span',
          { class: 'bar-track' },
          // 【シラクーザ】Lv2の確定ダメージは別の色で積み上げる
          h('span', { class: 'bar-fill', style: `width:${((u.damage - (u.siracusaDamage ?? 0)) / max) * 100}%` }),
          u.siracusaDamage ? h('span', { class: 'bar-fill siracusa', title: '【シラクーザ】の確定ダメージ', style: `width:${(u.siracusaDamage / max) * 100}%` }) : null,
        ),
        h('span', { class: 'bar-val' }, `${fmt(u.damage)}（${pct(u.damage / total)}）`),
        h(
          'span',
          { class: 'bar-sub muted' },
          `撃破 ${u.kills}・DPS ${fmt(u.damage / Math.max(1, r.elapsed))}・スキル${u.skillCasts}回・被ダメ ${fmt(u.taken ?? 0)}`,
          u.healed ? `・回復 ${fmt(u.healed)}` : '',
          u.siracusaDamage ? h('span', { class: 'siracusa-txt' }, `・シラクーザ確定 ${fmt(u.siracusaDamage)}`) : '',
          u.downAt !== null && u.downAt !== undefined ? h('span', { class: 'ng' }, `・${u.downAt.toFixed(0)}秒で撤退`) : '',
          u.retreats > 1 ? h('span', { class: 'ng' }, `（計${u.retreats}回）`) : '',
          u.redeploys ? `・再配置${u.redeploys}回` : '',
        ),
      ),
    ),
  );
}

const downCount = (r: BattleResult) => r.perUnit.filter((u) => u.downAt !== null && u.downAt !== undefined).length;

export function battleSummary(r: BattleResult, units: ReplayUnit[]) {
  return h(
    'div',
    { class: 'sim-summary' },
    h(
      'div',
      { class: `verdict ${r.cleared ? 'ok' : 'ng'}` },
      r.cleared ? `${r.bossDefeated ? 'ボス撃破' : '全滅'}！ ${r.elapsed}秒` : `突破 ${r.leaked}体　耐久値-${r.lifeLoss}`,
    ),
    h(
      'div',
      { class: 'kpis' },
      h('div', null, h('span', { class: 'muted small' }, '撃破'), h('b', null, `${r.killed}/${r.total}`)),
      h('div', null, h('span', { class: 'muted small' }, '総ダメージ'), h('b', null, fmt(r.totalDamage))),
      h('div', null, h('span', { class: 'muted small' }, '平均DPS'), h('b', null, fmt(r.totalDamage / Math.max(1, r.elapsed)))),
      r.bountyKills ? h('div', null, h('span', { class: 'muted small' }, '懸賞'), h('b', { class: 'ok' }, `資金+${r.bountyGold}`)) : null,
      r.opBursts || r.enBursts ? h('div', null, h('span', { class: 'muted small', title: '元素損傷が爆発した回数（味方/敵）' }, '元素爆発 味方/敵'), h('b', null, `${r.opBursts ?? 0}/${r.enBursts ?? 0}回`)) : null,
      r.colds || r.freezes ? h('div', null, h('span', { class: 'muted small' }, '寒冷/凍結'), h('b', null, `${r.colds ?? 0}/${r.freezes ?? 0}回`)) : null,
      r.sargon ? sargonKpi(r.sargon) : null,
      r.siracusa
        ? h(
            'div',
            { title: `【シラクーザ】の${r.siracusa.members}人が、配置後${Math.round(r.siracusa.duration)}秒間 攻撃速度+${Math.round(r.siracusa.aspd)}` },
            h('span', { class: 'muted small' }, 'シラクーザ AS'),
            h('b', null, `+${Math.round(r.siracusa.aspd)}（${Math.round(r.siracusa.duration)}秒）`),
          )
        : null,
      h('div', null, h('span', { class: 'muted small' }, '撤退'), h('b', { class: downCount(r) ? 'ng' : '' }, `${downCount(r)}人`)),
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
  floor: 'var(--tile-ground)',
  barricade: 'var(--tile-ground)',
  infection: 'var(--tile-infection)',
  mire: 'var(--tile-mire)',
  smog: 'var(--tile-smog)',
  deepsea: 'var(--tile-deepsea)',
};

/** 敵を表す円の半径（最大HPが大きいほど大きい） */
function enemyRadius(m: { boss: boolean; maxHp: number }): number {
  if (m.boss) return 32;
  return Math.max(9, Math.min(26, 9 + 3.2 * Math.log(Math.max(1, m.maxHp) / 400)));
}

/** 演出の表示時間（秒） */
const FX_LIFE = [0.18, 0.4, 0.4, 0.3, 0.45, 0, 0, 0, 0.7, 0.55];
const DMG_CLASS = ['phys', 'arts', 'true'];

/**
 * リプレイの演出を描く関数を作る。
 * 命中は攻撃者から敵への線（近距離は敵の上の斬撃）、範囲攻撃は攻撃範囲のマスや着弾地点の円、
 * 敵の遠距離攻撃は薄い点線、治療は緑の線、設置した範囲は効果時間のあいだ円を表示する
 */
function replayFx(r: BattleResult, units: ReplayUnit[], S: number) {
  const fx = r.fx ?? [];
  const zones = fx.filter((e) => e[1] === 5 || e[1] === 6);
  // <刺胄之弹>の着弾：3×3マスのスタン範囲
  const stuns = fx.filter((e) => e[1] === 7);
  const events = fx.filter((e) => e[1] !== 5 && e[1] !== 6 && e[1] !== 7);
  const byUid = new Map(units.map((u) => [u.uid, u]));
  const center = (pos: number) => ({ x: cellX(pos) * S + S / 2, y: cellY(pos) * S + S / 2 });
  const rangeCache = new Map<string, number[]>();
  const rangeOf = (u: ReplayUnit, skill: boolean) => {
    const key = `${u.uid}:${skill}`;
    let cells = rangeCache.get(key);
    if (!cells) {
      cells = unitRangeCells({ uid: u.uid, defId: u.defId, star: u.star, pos: u.pos, dir: u.dir } as OwnedUnit, skill);
      rangeCache.set(key, cells);
    }
    return cells;
  };
  const lastPos = new Map<number, { x: number; y: number }>();
  const maxLife = Math.max(...FX_LIFE);
  const firstAfter = (time: number) => {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid][0] / 100 < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return (layer: SVGElement, t: number, a: NonNullable<BattleResult['frames']>[number], b: NonNullable<BattleResult['frames']>[number], f: number) => {
    // 敵の現在位置（消えた敵は最後の位置）
    const next = new Map(b.e.map((e) => [e[0], e]));
    for (const e of a.e) {
      const nb = next.get(e[0]);
      const x = nb ? e[1] + (nb[1] - e[1]) * f : e[1];
      const y = nb ? e[2] + (nb[2] - e[2]) * f : e[2];
      lastPos.set(e[0], { x: (x / 100) * S + S / 2, y: (y / 100) * S + S / 2 });
    }
    const nodes: SVGElement[] = [];
    for (const z of zones) {
      const t0 = z[0] / 100;
      if (t < t0 || t > t0 + z[6] / 10) continue;
      nodes.push(s('circle', { cx: (z[3] / 100) * S + S / 2, cy: (z[4] / 100) * S + S / 2, r: (z[5] / 100) * S, class: z[1] === 6 ? 'fx-pollution' : 'fx-zone' }));
    }
    for (const z of stuns) {
      const t0 = z[0] / 100;
      if (t < t0 || t > t0 + z[4] / 10) continue;
      const cx = z[2] / 100;
      const cy = z[3] / 100;
      nodes.push(s('rect', { x: (cx - 1) * S + 3, y: (cy - 1) * S + 3, width: 3 * S - 6, height: 3 * S - 6, rx: 12, class: 'fx-stun' }));
    }
    for (let i = firstAfter(t - maxLife); i < events.length && events[i][0] / 100 <= t; i++) {
      const ev = events[i];
      const age = t - ev[0] / 100;
      const life = FX_LIFE[ev[1]] ?? 0.3;
      if (age > life) continue;
      const op = String(Math.max(0, 1 - age / life));
      switch (ev[1]) {
        case 0: {
          const u = byUid.get(ev[2]);
          const ep = lastPos.get(ev[3]);
          if (!u || u.pos === undefined || !ep) break;
          const cls = DMG_CLASS[ev[4]] ?? 'phys';
          if (getUnit(u.defId).position === 'melee') {
            nodes.push(s('line', { x1: ep.x - 16, y1: ep.y - 16, x2: ep.x + 16, y2: ep.y + 16, class: `fx-slash ${cls}`, opacity: op }));
          } else {
            const up = center(u.pos);
            nodes.push(s('line', { x1: up.x, y1: up.y, x2: ep.x, y2: ep.y, class: `fx-shot ${cls}`, opacity: op }));
            nodes.push(s('circle', { cx: ep.x, cy: ep.y, r: 8, class: `fx-hit ${cls}`, opacity: op }));
          }
          break;
        }
        case 1: {
          const u = byUid.get(ev[2]);
          const cls = u ? (getUnit(u.defId).damageType === 'arts' ? 'arts' : 'phys') : 'phys';
          nodes.push(s('circle', { cx: (ev[3] / 100) * S + S / 2, cy: (ev[4] / 100) * S + S / 2, r: (ev[5] / 100) * S * (0.6 + 0.4 * (age / life)), class: `fx-burst ${cls}`, opacity: op }));
          break;
        }
        case 2: {
          const u = byUid.get(ev[2]);
          if (!u || u.pos === undefined) break;
          const cls = getUnit(u.defId).damageType === 'arts' ? 'arts' : 'phys';
          for (const c of rangeOf(u, ev[3] === 1)) {
            nodes.push(s('rect', { x: cellX(c) * S + 4, y: cellY(c) * S + 4, width: S - 8, height: S - 8, rx: 8, class: `fx-area ${cls}`, opacity: op }));
          }
          break;
        }
        case 3: {
          const ep = lastPos.get(ev[2]);
          const u = byUid.get(ev[3]);
          if (!ep || !u || u.pos === undefined) break;
          const up = center(u.pos);
          // 敵弾：敵から味方へ進む短い線
          const k = Math.min(1, age / life);
          const hx = ep.x + (up.x - ep.x) * k;
          const hy = ep.y + (up.y - ep.y) * k;
          const tx = ep.x + (up.x - ep.x) * Math.max(0, k - 0.35);
          const ty = ep.y + (up.y - ep.y) * Math.max(0, k - 0.35);
          nodes.push(s('line', { x1: tx, y1: ty, x2: hx, y2: hy, class: `fx-enemy-shot${ev[4] ? ' arts' : ''}` }));
          break;
        }
        case 4: {
          const h0 = byUid.get(ev[2]);
          const tg = byUid.get(ev[3]);
          if (!h0 || !tg || h0.pos === undefined || tg.pos === undefined) break;
          const p0 = center(h0.pos);
          const p1 = center(tg.pos);
          nodes.push(s('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, class: 'fx-heal', opacity: op }));
          nodes.push(s('circle', { cx: p1.x, cy: p1.y, r: 30, class: 'fx-heal-ring', opacity: op }));
          break;
        }
        case 9: {
          // ザーロの術ダメージ：広がる輪
          const x = (ev[3] / 100) * S + S / 2;
          const y = (ev[4] / 100) * S + S / 2;
          nodes.push(s('circle', { cx: x, cy: y, r: S * 0.9 * (0.5 + 0.5 * (age / life)), class: 'fx-zaro-pulse', opacity: op }));
          break;
        }
        case 8: {
          // 剣雨：上から剣が降り、命中点に星形（スタン）
          const x = (ev[3] / 100) * S + S / 2;
          const y = (ev[4] / 100) * S + S / 2;
          const k = Math.min(1, age / 0.25);
          nodes.push(s('line', { x1: x, y1: y - 70 + 60 * k, x2: x, y2: y - 20 + 20 * k, class: 'fx-sword', opacity: op }));
          if (k >= 1) {
            const r0 = 22 + 10 * (age / life);
            const pts = Array.from({ length: 10 }, (_, i) => {
              const a = (Math.PI / 5) * i - Math.PI / 2;
              const rr = i % 2 ? r0 * 0.45 : r0;
              return `${x + rr * Math.cos(a)},${y + rr * Math.sin(a)}`;
            }).join(' ');
            nodes.push(s('polygon', { points: pts, class: 'fx-stun-star', opacity: op }));
          }
          break;
        }
      }
    }
    layer.replaceChildren(...nodes);
  };
}

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
  for (let p = 0; p < BOARD_CELLS; p++) {
    const t = tileAt(p);
    if (t === 'barricade') svg.append(s('rect', { x: cellX(p) * S + 22, y: cellY(p) * S + 22, width: S - 44, height: S - 44, rx: 4, class: 'rp-barricade' }));
    if (t === 'floor') svg.append(s('rect', { x: cellX(p) * S + 1, y: cellY(p) * S + 1, width: S - 2, height: S - 2, rx: 6, class: 'rp-floor' }));
  }
  for (const p of SPAWNS) svg.append(s('text', { x: cellX(p) * S + S / 2, y: cellY(p) * S + 58, class: 'rp-label', 'text-anchor': 'middle' }, '出現'));
  svg.append(s('text', { x: cellX(GOAL) * S + S / 2, y: cellY(GOAL) * S + 58, class: 'rp-label', 'text-anchor': 'middle' }, '防衛'));

  // オペレーター
  const unitNodes = new Map<number, SVGElement>();
  const unitBars = new Map<number, SVGElement>();
  const unitSp = new Map<number, { bar: SVGElement; label: SVGElement }>();
  /** 元素損傷の小さな丸（左上） */
  const unitElem = new Map<number, { g: SVGElement; x: number; y: number; key: string }>();
  /** 【サルゴン】の強化（攻撃速度）の小さな表示（左下） */
  const unitSargon = new Map<number, SVGElement>();
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
      s('rect', { x: x + 14, y: y + S - 22, width: S - 28, height: 6, class: 'rp-hp-bg' }),
    );
    const bar = s('rect', { x: x + 14, y: y + S - 22, width: S - 28, height: 6, class: 'rp-unit-hp' });
    g.append(bar);
    unitBars.set(u.uid, bar);
    // SP・スキル残り時間・残り弾薬
    g.append(s('rect', { x: x + 14, y: y + S - 14, width: S - 28, height: 4, class: 'rp-hp-bg' }));
    const spBar = s('rect', { x: x + 14, y: y + S - 14, width: 0, height: 4, class: 'rp-unit-sp' });
    const spLabel = s('text', { x: x + S - 12, y: y + 24, 'text-anchor': 'end', class: 'rp-unit-skill' }, '');
    g.append(spBar, spLabel);
    unitSp.set(u.uid, { bar: spBar, label: spLabel });
    const elemG = s('g', { class: 'rp-elem' });
    g.append(elemG);
    unitElem.set(u.uid, { g: elemG, x: x + 22, y: y + 21, key: '' });
    if (r.sargon || r.siracusa) {
      const sg = s('text', { x: x + 13, y: y + 74, 'text-anchor': 'start', class: 'rp-sargon' }, '');
      g.append(sg);
      unitSargon.set(u.uid, sg);
    }
    // 傀儡師：身替りと入れ替わっている間の表示
    g.append(s('text', { x: x + S / 2, y: y + 24, 'text-anchor': 'middle', class: 'rp-unit-doll' }, '身替り'));
    unitNodes.set(u.uid, g);
    svg.append(g);
  }
  // 帰溟スペクターの身替り：周囲8マスの領域（減速・毎秒術ダメージ）
  const ghostField = new Map<number, SVGElement>();
  for (const u of units) {
    if (u.pos === undefined || getUnit(u.defId).charId !== 'char_1023_ghost2') continue;
    const cx = cellX(u.pos);
    const cy = cellY(u.pos);
    const x0 = Math.max(0, cx - 1);
    const y0 = Math.max(0, cy - 1);
    const x1 = Math.min(BOARD_COLS - 1, cx + 1);
    const y1 = Math.min(BOARD_ROWS - 1, cy + 1);
    const f = s(
      'g',
      { class: 'rp-ghost-field', style: 'display:none' },
      s('rect', { x: x0 * S + 4, y: y0 * S + 4, width: (x1 - x0 + 1) * S - 8, height: (y1 - y0 + 1) * S - 8, rx: 18, class: 'rp-ghost-area' }),
      s('rect', { x: x0 * S + 4, y: y0 * S + 4, width: (x1 - x0 + 1) * S - 8, height: (y1 - y0 + 1) * S - 8, rx: 18, class: 'rp-ghost-wave' }),
    );
    ghostField.set(u.uid, f);
    svg.append(f);
  }
  // カゼマルS2の身替り（紙人形）
  const tokenLayer = s('g', { class: 'rp-tokens' });
  svg.append(tokenLayer);
  const drawTokens = (a: NonNullable<BattleResult['frames']>[number]) => {
    const list = a.tk ?? [];
    if (!list.length) {
      if (tokenLayer.childNodes.length) tokenLayer.replaceChildren();
      return;
    }
    tokenLayer.replaceChildren(
      ...list.map(([, pos, hp]) => {
        const x = cellX(pos) * S;
        const y = cellY(pos) * S;
        return s(
          'g',
          { class: 'rp-token' },
          s('rect', { x: x + 14, y: y + 14, width: S - 28, height: S - 28, rx: 8, class: 'rp-token-box' }),
          s('text', { x: x + S / 2, y: y + S / 2 + 4, 'text-anchor': 'middle', class: 'rp-token-name' }, '紙人形'),
          s('rect', { x: x + 20, y: y + S - 26, width: S - 40, height: 5, class: 'rp-hp-bg' }),
          s('rect', { x: x + 20, y: y + S - 26, width: ((S - 40) * Math.max(0, hp)) / 100, height: 5, class: 'rp-unit-hp' }),
        );
      }),
    );
  };

  // 敵
  const enemyLayer = s('g', {});
  svg.append(enemyLayer);
  // 演出（攻撃・範囲攻撃・敵の射撃）
  const fxLayer = s('g', { class: 'rp-fx' });
  svg.append(fxLayer);
  // 荒蕪ラップランドS3のザーロ（狼の頭の形。取り付くと周囲に減速範囲の点線）
  const zaroLayer = s('g', { class: 'rp-zaros' });
  svg.append(zaroLayer);
  const WOLF = '-11,9 -13,-11 -4,-5 0,-9 4,-5 13,-11 11,9 0,14';
  const drawZaros = (a: NonNullable<BattleResult['frames']>[number], b: NonNullable<BattleResult['frames']>[number], f: number) => {
    const za = a.zr ?? [];
    const zb = b.zr ?? [];
    if (!za.length) {
      if (zaroLayer.childNodes.length) zaroLayer.replaceChildren();
      return;
    }
    const nodes: SVGElement[] = [];
    za.forEach((z, i) => {
      const n = zb[i] && zb[i][0] === z[0] ? zb[i] : z;
      const x = ((z[1] + (n[1] - z[1]) * f) / 100) * S + S / 2;
      const y = ((z[2] + (n[2] - z[2]) * f) / 100) * S + S / 2;
      if (z[3]) nodes.push(s('circle', { cx: x, cy: y, r: S * 0.9, class: 'rp-zaro-aura' }));
      else nodes.push(s('line', { x1: (z[1] / 100) * S + S / 2, y1: (z[2] / 100) * S + S / 2, x2: x, y2: y, class: 'rp-zaro-trail' }));
      nodes.push(s('polygon', { points: WOLF, transform: `translate(${x},${y})`, class: `rp-zaro${z[3] ? ' on' : ''}` }));
    });
    zaroLayer.replaceChildren(...nodes);
  };
  const fxDraw = replayFx(r, units, S);
  const enemyNodes = new Map<number, { g: SVGElement; bar: SVGElement; barW: number }>();
  const enemyNode = (id: number) => {
    let n = enemyNodes.get(id);
    if (n) return n;
    const m = meta.get(id)!;
    if (m.large) {
      // 大型のボス：右の2列×上の3行を占める（位置は左下のマスの中心）。当たり判定はその左の列も含む
      const x0 = -S / 2 + 6;
      const y0 = -2.5 * S + 6;
      const w = 2 * S - 12;
      const hgt = 3 * S - 12;
      const bar = s('rect', { x: x0 + 8, y: y0 + 8, width: w - 16, height: 8, class: 'rp-hp' });
      const g = s(
        'g',
        { class: 'rp-enemy boss large' },
        // 当たり判定のみの列（(7,1)〜(7,3)）：配置・経路には影響しないので点線で薄く示す
        s('rect', { x: x0 - S, y: y0, width: S + 8, height: hgt, rx: 14, class: 'rp-boss-hitbox' }),
        s('rect', { x: x0, y: y0, width: w, height: hgt, rx: 14, class: 'rp-enemy-body' }),
        s('rect', { x: x0 + 8, y: y0 + 8, width: w - 16, height: 8, class: 'rp-hp-bg' }),
        bar,
        s('text', { x: S / 2, y: -S, 'text-anchor': 'middle', class: 'rp-boss-name' }, m.name),
      );
      g.append(s('title', {}, m.name));
      n = { g, bar, barW: w - 16 };
      enemyNodes.set(id, n);
      enemyLayer.prepend(g);
      return n;
    }
    const rad = enemyRadius(m);
    const bar = s('rect', { x: -rad, y: -rad - 12, width: rad * 2, height: 6, class: 'rp-hp' });
    const g = s(
      'g',
      { class: `rp-enemy${m.boss ? ' boss' : ''}${m.flying ? ' fly' : ''}` },
      // 周囲攻撃の範囲（深溟のミキサーなど）
      m.aura ? s('circle', { r: m.aura * S, class: 'rp-aura' }) : null,
      s('circle', { r: rad, class: 'rp-enemy-body' }),
      // 活性源石の上：右上に源石の結晶（攻撃力・攻撃速度アップと継続ダメージ中）
      s('polygon', { points: `${rad * 0.75},${-rad * 0.75 - 7} ${rad * 0.75 + 5},${-rad * 0.75} ${rad * 0.75},${-rad * 0.75 + 7} ${rad * 0.75 - 5},${-rad * 0.75}`, class: 'rp-infect' }),
      s('rect', { x: -rad, y: -rad - 12, width: rad * 2, height: 6, class: 'rp-hp-bg' }),
      bar,
    );
    g.append(s('title', {}, m.name));
    n = { g, bar, barW: rad * 2 };
    enemyNodes.set(id, n);
    enemyLayer.append(g);
    return n;
  };

  const timeLabel = h('span', { class: 'rp-time' }, '0.0秒');
  const costLabel = h('span', { class: 'rp-cost' }, '');
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
      n.bar.setAttribute('width', String(Math.max(0, (e[3] / 100) * n.barW)));
      n.g.style.display = '';
      n.g.classList.toggle('freed', ((e[4] ?? 0) & 1) !== 0);
      n.g.classList.toggle('stunned', ((e[4] ?? 0) & 2) !== 0);
      n.g.classList.toggle('feared', ((e[4] ?? 0) & 4) !== 0);
      n.g.classList.toggle('stealth', ((e[4] ?? 0) & 8) !== 0);
      n.g.classList.toggle('infected', ((e[4] ?? 0) & 16) !== 0);
      seen.add(e[0]);
    }
    for (const [id, n] of enemyNodes) if (!seen.has(id)) n.g.style.display = 'none';
    fxDraw(fxLayer, t, a, b, f);
    drawZaros(a, b, f);
    const skill = new Set(a.s);
    for (const [uid, g] of unitNodes) g.classList.toggle('skill', skill.has(uid));
    const states = new Map((a.u ?? []).map((x) => [x[0], x]));
    const stealth = new Set(a.st ?? []);
    for (const [uid, g] of unitNodes) g.classList.toggle('stealth', stealth.has(uid));
    drawTokens(a);
    const dolls = new Set(a.dl ?? []);
    for (const [uid, g] of unitNodes) g.classList.toggle('doll', dolls.has(uid));
    for (const [uid, f] of ghostField) f.style.display = dolls.has(uid) ? '' : 'none';
    const lifted = new Set(a.lf ?? []);
    for (const [uid, g] of unitNodes) g.classList.toggle('lifted', lifted.has(uid));
    for (const [uid, bar] of unitBars) {
      const st = states.get(uid);
      const v = st?.[1] ?? 100;
      bar.setAttribute('width', String(Math.max(0, ((S - 28) * Math.max(0, v)) / 100)));
      unitNodes.get(uid)?.classList.toggle('down', v < 0);
      const sp = unitSp.get(uid);
      if (!sp || !st) continue;
      const [, , gauge, mode, val, ammo] = st;
      sp.bar.setAttribute('width', String(mode === 3 || (v < 0 && mode !== 4) ? 0 : ((S - 28) * gauge) / 100));
      sp.bar.classList.toggle('active', mode === 1 || mode === 2);
      sp.bar.classList.toggle('waiting', mode === 4);
      sp.label.textContent =
        mode === 4 ? (val > 0 ? `再配置${Math.ceil(val / 10)}` : 'コスト待ち') : v < 0 ? '' : mode === 1 ? `${(val / 10).toFixed(0)}秒` : mode === 2 ? `弾${val}` : ammo !== undefined && ammo !== null ? `弾${ammo}` : '';
      sp.label.classList.toggle('waiting', mode === 4);
    }
    // 元素損傷（1以上溜まっているものだけ）。丸の周りのリングが爆発までの蓄積
    const elems = new Map<number, [number, number][]>();
    for (const [uid, type, pct] of a.ue ?? []) (elems.get(uid) ?? elems.set(uid, []).get(uid)!).push([type, pct]);
    for (const [uid, el] of unitElem) {
      const list = unitNodes.get(uid)?.classList.contains('down') ? [] : (elems.get(uid) ?? []);
      const key = list.map((x) => x.join(':')).join(',');
      if (key === el.key) continue;
      el.key = key;
      el.g.replaceChildren(
        ...list.map(([type, pct], i) => {
          const cx = el.x + i * 21;
          const R = 8;
          const c = 2 * Math.PI * R;
          const burst = pct > 100;
          return s(
            'g',
            { class: `rp-elem-dot elem-${type}${burst ? ' burst' : ''}` },
            s('circle', { cx, cy: el.y, r: R, class: 'rp-elem-bg' }),
            s('circle', {
              cx,
              cy: el.y,
              r: R,
              class: 'rp-elem-ring',
              'stroke-dasharray': `${(c * (burst ? pct - 100 : pct)) / 100} ${c}`,
              transform: `rotate(-90 ${cx} ${el.y})`,
            }),
            s('text', { x: cx, y: el.y + 3.8, 'text-anchor': 'middle', class: 'rp-elem-label' }, ELEM_SHORT[type]),
            s('title', {}, `${ELEM_FULL[type]}：${burst ? `爆発中（残り${pct - 100}%）` : `${pct}%`}`),
          );
        }),
      );
    }
    // 【サルゴン】の強化・【シラクーザ】の攻撃速度上昇：受けているオペレーターだけ「AS+36」のように表示
    if (r.sargon || r.siracusa) {
      const layers = new Map(a.sg ?? []);
      const sc = new Set(a.sc ?? []);
      for (const [uid, el] of unitSargon) {
        const down = unitNodes.get(uid)?.classList.contains('down');
        const n = down ? 0 : (layers.get(uid) ?? 0);
        const sgAs = r.sargon ? n * r.sargon.aspd : 0;
        const scAs = !down && r.siracusa && sc.has(uid) ? r.siracusa.aspd : 0;
        const total = Math.round(sgAs + scAs);
        const text = total > 0 ? `AS+${total}` : '';
        if (el.getAttribute('data-k') !== text) {
          el.setAttribute('data-k', text);
          const parts = [
            sgAs ? `【サルゴン】${n}層：攻撃速度+${sgAs}${r.sargon!.atkPct ? `・攻撃力+${Math.round(n * r.sargon!.atkPct * 100)}%` : ''}` : '',
            scAs ? `【シラクーザ】攻撃速度+${Math.round(scAs)}（配置後${Math.round(r.siracusa!.duration)}秒間）` : '',
          ].filter(Boolean);
          el.replaceChildren(text, ...(parts.length ? [s('title', {}, parts.join('\n'))] : []));
        }
      }
    }
    timeLabel.textContent = `${t.toFixed(1)}秒`;
    costLabel.textContent = a.c !== undefined ? `コスト ${a.c}` : '';
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
    h('div', { class: 'row rp-controls' }, playBtn, speedBtns, slider, timeLabel, costLabel),
    h('div', { class: 'muted small' }, '●地上の敵　◌飛行の敵（大きさは最大HP）。オペレーターの下の緑はHP、青はSP、橙はスキルの残り（右上に残り秒数・弾数）。薄いオペレーターは撤退中（灰色のゲージが再配置までの時間）。攻撃は橙（物理）・紫（術）、範囲攻撃はマスや円の光、敵の遠距離攻撃は細い赤線、治療は緑の線、敵が残した汚染秽蝕は赤紫の円、敵の周りの紫の点線は周囲攻撃の範囲。オペレーター左上の丸は元素損傷（灼燃・神経・侵蝕・壊死。リングが爆発までの蓄積、塗りつぶしは爆発中）、左下の「AS+」は【サルゴン】の強化・【シラクーザ】による攻撃速度。半透明の敵・味方はステルス中。点線の枠で「身替り」と出ている味方は傀儡師の身替り（ブロックせず周囲8マスを攻撃。一定時間で本体に戻る）、点線の小さな「紙人形」はカゼマルS2の身替り。青く脈打つ3×3の領域は帰溟スペクターの身替りの「内なる抱擁」（敵の移動速度-40%・毎秒術ダメージ）。影が付いて浮いている味方は離陸中（ティッピのスキル：地上の敵に狙われず、空中の敵をブロック・攻撃する）。紫に光って右上に結晶が出ている敵は活性源石の上（攻撃力・攻撃速度アップ、毎秒HP減少）。ピンクの狼の頭は荒蕪ラップランドS3のザーロ（取り付くと点線の円の範囲を減速し、1秒ごとに術ダメージ）'),
  );
}
