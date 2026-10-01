import { ALLIANCES } from '../core/data/alliances';
import { DAMAGE_TYPE_NAME, PROFESSION_NAME, getUnit, unitState } from '../core/data/units';
import { isGarrisonImplemented, type AllianceStatus } from '../core/alliance';
import { attackInterval, baseAtk, type SimResult } from '../core/sim';
import type { AllianceId, EnemyDef, Modifier, OwnedUnit, Star } from '../core/types';
import { fmt, h, pct, s } from './dom';

export function starBadge(star: Star) {
  return star === 2 ? h('span', { class: 'promoted', title: '昇進済み' }, '昇進') : null;
}

const TIER_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

export function unitCard(
  defId: string,
  opts: {
    star?: Star;
    price?: number;
    selected?: boolean;
    dim?: boolean;
    onClick?: () => void;
    highlight?: Set<AllianceId>;
  } = {},
) {
  const d = getUnit(defId);
  const st = unitState(d, opts.star ?? 1);
  return h(
    'button',
    {
      class: `card tier-${d.tier}${opts.selected ? ' selected' : ''}${opts.dim ? ' dim' : ''}${opts.star === 2 ? ' golden' : ''}`,
      onclick: opts.onClick ? () => opts.onClick!() : undefined,
      title: `${d.name}（等級${TIER_ROMAN[d.tier]} ${PROFESSION_NAME[d.profession]}）\n${st.skill.name}：${st.skill.description}\n\n${st.garrisons.map((g) => g.description).join('\n')}`,
    },
    h(
      'div',
      { class: 'card-top' },
      h('span', { class: 'tier' }, `等級${TIER_ROMAN[d.tier]}`),
      opts.price !== undefined ? h('span', { class: 'price' }, `${opts.price}`) : opts.star ? starBadge(opts.star) : null,
    ),
    h('div', { class: 'card-name' }, d.name),
    h('div', { class: 'card-cls' }, `${PROFESSION_NAME[d.profession]}・${DAMAGE_TYPE_NAME[d.damageType]}`),
    h(
      'div',
      { class: 'card-tags' },
      d.bonds.map((t) => h('span', { class: `tag ${ALLIANCES[t].kind}${opts.highlight?.has(t) ? ' on' : ''}` }, ALLIANCES[t].name)),
    ),
  );
}

export function emptySlot(label = '') {
  return h('div', { class: 'card empty' }, label);
}

export function alliancePanel(statuses: AllianceStatus[], stacks: Partial<Record<AllianceId, number>>) {
  if (statuses.length === 0) return h('p', { class: 'muted' }, 'オペレーターを配置すると盟約が表示されます');
  return h(
    'ul',
    { class: 'alliances' },
    statuses.map((st) => {
      const def = ALLIANCES[st.id];
      const stack = stacks[st.id] ?? 0;
      const tiers = def.describe(stack);
      return h(
        'li',
        { class: `alliance ${st.level > 0 ? 'active' : ''} ${def.kind}` },
        h(
          'div',
          { class: 'alliance-head' },
          h('span', { class: 'alliance-name' }, def.name),
          h(
            'span',
            { class: 'thresholds' },
            def.thresholds.map((t, i) => h('span', { class: st.count >= t ? 'th on' : 'th' }, t, i < def.thresholds.length - 1 ? '/' : '')),
          ),
          h('span', { class: 'stack', title: '加算数' }, `加算数 ${stack}`),
          h('span', { class: 'count' }, `${st.count}人`),
        ),
        h(
          'ul',
          { class: 'alliance-tiers' },
          tiers.map((t, i) =>
            h(
              'li',
              { class: `${i < st.level ? 'on' : ''}${t.notSimulated ? ' nosim' : ''}`, title: t.notSimulated ? 'DPSチェックでは再現していません' : undefined },
              h('span', { class: 'need' }, `${t.count}`),
              t.text,
            ),
          ),
          (def.stackMilestones?.(stack) ?? []).map((m) => h('li', { class: `milestone ${m.reached && st.level > 0 ? 'on' : ''}` }, m.text)),
        ),
      );
    }),
  );
}

export function enemyInfo(e: EnemyDef) {
  return h(
    'div',
    { class: `enemy ${e.isBoss ? 'boss' : ''}` },
    h('div', { class: 'enemy-name' }, e.isBoss ? h('span', { class: 'badge' }, 'BOSS') : null, e.name),
    h(
      'div',
      { class: 'enemy-stats' },
      h('span', null, `HP ${fmt(e.hp)}`),
      h('span', null, `防御 ${e.def}`),
      h('span', null, `術耐性 ${e.res}`),
      h('span', null, `制限 ${e.duration}秒`),
    ),
    e.description ? h('div', { class: 'muted small' }, e.description) : null,
    e.phases?.length ? h('ul', { class: 'phases small' }, e.phases.map((p) => h('li', null, `HP${pct(p.belowHpRatio)}以下：${p.note}`))) : null,
  );
}

/** 予測結果の1行サマリー */
export function predictionLine(r: SimResult) {
  if (r.killed) return h('div', { class: 'predict ok' }, `撃破見込み：${r.killTime}秒`);
  return h('div', { class: 'predict ng' }, `撃破できない見込み：残りHP ${pct(r.remainingHp / r.enemy.hp)}`);
}

function modifierText(m: Modifier): string[] {
  const out: string[] = [];
  if (m.atkPct) out.push(`攻撃力+${pct(m.atkPct)}`);
  if (m.atkFlat) out.push(`基礎攻撃力+${fmt(m.atkFlat)}`);
  if (m.aspd) out.push(`攻撃速度+${Math.round(m.aspd * 10) / 10}`);
  if (m.spRegen) out.push(`SP回復+${Math.round(m.spRegen * 100) / 100}/秒`);
  if (m.startSp) out.push(`初期SP+${m.startSp}`);
  if (m.defIgnorePct) out.push(`防御無視${pct(m.defIgnorePct)}`);
  if (m.resIgnorePct) out.push(`術耐性無視${pct(m.resIgnorePct)}`);
  if (m.damagePct) out.push(`与ダメ+${pct(m.damagePct)}`);
  if (m.damageMult && m.damageMult !== 1) out.push(`与ダメ×${Math.round(m.damageMult * 100) / 100}`);
  if (m.trueDmgPct) out.push(`確定追加${pct(m.trueDmgPct)}`);
  if (m.spOnSkillEnd) out.push(`スキル終了時SP+${Math.round(m.spOnSkillEnd * 10) / 10}（期待値）`);
  if (m.ammoPct) out.push(`弾薬+${pct(m.ammoPct)}`);
  if (m.weakDamage) out.push('弱点ダメージ');
  return out;
}

export function unitDetail(o: OwnedUnit, mods: Modifier | undefined) {
  const d = getUnit(o.defId);
  const st = unitState(d, o.star);
  const m = mods ?? {};
  const atk = baseAtk(d, o.star, m);
  const interval = attackInterval(st.stats.interval, st.stats.aspd + (m.aspd ?? 0));
  const modText = modifierText(m);
  const phaseText = `昇進${st.evolvePhase} Lv${st.level}・スキルLv${st.skillLevel}${st.moduleLevel ? `・モジュールLv${st.moduleLevel}` : ''}`;
  return h(
    'div',
    { class: 'detail' },
    h('div', { class: 'detail-name' }, d.name, ' ', starBadge(o.star)),
    h('div', { class: 'muted small' }, `等級${TIER_ROMAN[d.tier]}・${PROFESSION_NAME[d.profession]}・${DAMAGE_TYPE_NAME[d.damageType]}　${phaseText}`),
    h(
      'dl',
      { class: 'stats' },
      h('dt', null, '攻撃力'),
      h('dd', null, `${fmt(atk)}`, h('span', { class: 'muted' }, `（基礎 ${fmt(st.stats.atk)}）`)),
      h('dt', null, '攻撃間隔'),
      h('dd', null, `${interval.toFixed(2)}秒`),
      h('dt', null, 'HP/防御/術耐'),
      h('dd', null, `${fmt(st.stats.hp)} / ${fmt(st.stats.def)} / ${st.stats.res}`),
      h('dt', null, 'スキル'),
      h(
        'dd',
        null,
        h('b', null, st.skill.name),
        h('span', { class: 'muted small' }, `　SP ${st.skill.initSp}/${st.skill.spCost}${st.skill.duration > 0 ? `・${st.skill.duration}秒` : ''}`),
        h('br'),
        h('span', { class: 'small' }, st.skill.description),
      ),
      h('dt', null, '堅守特性'),
      h(
        'dd',
        null,
        st.garrisons.map((g) =>
          h(
            'div',
            { class: `garrison small${isGarrisonImplemented(g) ? '' : ' nosim'}`, title: isGarrisonImplemented(g) ? undefined : 'まだシミュレーターで再現していない特性です' },
            g.description,
          ),
        ),
      ),
      h('dt', null, '補正'),
      h('dd', null, modText.length ? modText.join('、') : h('span', { class: 'muted' }, 'なし（配置すると表示）')),
    ),
  );
}

// ------------------------------------------------------------
// 戦闘結果の表示
// ------------------------------------------------------------

export function hpChart(r: SimResult) {
  const W = 560;
  const H = 160;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (t: number) => pad.l + (t / r.enemy.duration) * iw;
  const y = (hp: number) => pad.t + (1 - hp / r.enemy.hp) * ih;
  const path = r.timeline.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.hp).toFixed(1)}`).join(' ');
  const ticks = [];
  const step = r.enemy.duration > 40 ? 15 : 10;
  for (let t = 0; t <= r.enemy.duration; t += step) ticks.push(t);
  return s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': '敵HPの推移' },
    [0, 0.5, 1].map((f) =>
      s(
        'g',
        {},
        s('line', { x1: pad.l, x2: W - pad.r, y1: y(r.enemy.hp * f), y2: y(r.enemy.hp * f), class: 'grid' }),
        s('text', { x: pad.l - 6, y: y(r.enemy.hp * f) + 4, class: 'axis', 'text-anchor': 'end' }, pct(f)),
      ),
    ),
    ticks.map((t) => s('text', { x: x(t), y: H - 6, class: 'axis', 'text-anchor': 'middle' }, `${t}s`)),
    r.phaseLog.map((p) => s('line', { x1: x(p.t), x2: x(p.t), y1: pad.t, y2: pad.t + ih, class: 'phase-line' })),
    s('path', { d: path, class: 'hp-line' }),
    r.killTime !== null ? s('circle', { cx: x(r.killTime), cy: y(0), r: 4, class: 'kill-dot' }) : null,
  );
}

export function damageBars(r: SimResult) {
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
        h('span', { class: 'bar-sub muted' }, `DPS ${fmt(u.damage / r.elapsed)}・スキル${u.skillCasts}回`),
      ),
    ),
  );
}

export function simSummary(r: SimResult) {
  return h(
    'div',
    { class: 'sim-summary' },
    h(
      'div',
      { class: `verdict ${r.killed ? 'ok' : 'ng'}` },
      r.killed ? `撃破！ ${r.killTime}秒` : `撃破失敗　残りHP ${fmt(r.remainingHp)}（${pct(r.remainingHp / r.enemy.hp)}）`,
    ),
    h(
      'div',
      { class: 'kpis' },
      h('div', null, h('span', { class: 'muted small' }, '総ダメージ'), h('b', null, fmt(r.totalDamage))),
      h('div', null, h('span', { class: 'muted small' }, '平均DPS'), h('b', null, fmt(r.totalDamage / r.elapsed))),
      h('div', null, h('span', { class: 'muted small' }, '必要DPS'), h('b', null, fmt(r.enemy.hp / r.enemy.duration))),
    ),
    hpChart(r),
    r.phaseLog.length
      ? h('ul', { class: 'phases small' }, r.phaseLog.map((p) => h('li', null, `${p.t.toFixed(1)}秒：${p.note}`)))
      : null,
    damageBars(r),
  );
}
