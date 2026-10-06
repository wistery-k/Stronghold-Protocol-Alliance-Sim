import { talentStatus } from '../core/talents';
import { ALLIANCES } from '../core/data/alliances';
import { DAMAGE_TYPE_NAME, PROFESSION_NAME, getUnit, unitState } from '../core/data/units';
import { getItem, itemState } from '../core/data/items';
import { isGarrisonImplemented, type AllianceStatus } from '../core/alliance';
import { attackInterval, baseAtk } from '../core/sim';
import type { AllianceId, Modifier, OwnedItem, OwnedUnit, Star } from '../core/types';
import { fmt, h, pct } from './dom';
import { makeDraggable, registerDropTarget } from './dnd';

export function starBadge(star: Star) {
  return star === 2 ? h('span', { class: 'promoted', title: '精鋭' }, '精鋭') : null;
}


export interface CardOptions {
  star?: Star;
  price?: number;
  selected?: boolean;
  /** 所持中（非精鋭）のオペレーターと同じものを強調 */
  owned?: boolean;
  /** 獲得すると発動人数に届く盟約（先見・奇跡・投資家）。カードとその盟約のタグを強調 */
  completes?: AllianceId[];
  dim?: boolean;
  onClick?: () => void;
  onDblClick?: () => void;
  /** マウスオーバー時（true）と離れた時（false） */
  onHover?: (enter: boolean) => void;
  /** ドラッグで運ぶユニットの uid */
  dragUid?: number;
  /** 装備中のアイテム */
  items?: OwnedItem[];
  /** 装備をドロップされた時 */
  onItemDrop?: (itemUid: number) => void;
  highlight?: Set<AllianceId>;
}

export function unitCard(defId: string, opts: CardOptions = {}) {
  const d = getUnit(defId);
  const st = unitState(d, opts.star ?? 1);
  // button 要素はブラウザによってドラッグできないので div にする
  const card = h(
    'div',
    {
      role: 'button',
      tabindex: 0,
      class: `card tier-${d.tier}${opts.selected ? ' selected' : ''}${opts.owned ? ' owned' : ''}${opts.completes?.length ? ' completes' : ''}${opts.dim ? ' dim' : ''}${opts.star === 2 ? ' golden' : ''}`,
      onclick: opts.onClick ? () => opts.onClick!() : undefined,
      ondblclick: opts.onDblClick ? () => opts.onDblClick!() : undefined,
      onmouseenter: opts.onHover ? () => opts.onHover!(true) : undefined,
      onmouseleave: opts.onHover ? () => opts.onHover!(false) : undefined,
      title: `${d.name}（${PROFESSION_NAME[d.profession]}）${opts.completes?.length ? `\n獲得すると${opts.completes.map((a) => `【${ALLIANCES[a].name}】`).join('')}が発動` : ''}\n${st.skill.name}：${st.skill.description}\n\n${st.garrisons.map((g) => g.description).join('\n')}`,
    },
    h(
      'div',
      { class: 'card-top' },
      h('span', { class: 'card-name' }, d.name),
      opts.price !== undefined ? h('span', { class: 'price' }, `${opts.price}`) : opts.star ? starBadge(opts.star) : null,
    ),
    h('div', { class: 'card-cls' }, `${PROFESSION_NAME[d.profession]}・${DAMAGE_TYPE_NAME[d.damageType]}`),
    h(
      'div',
      { class: 'card-tags' },
      d.bonds.map((t) => h('span', { class: `tag ${ALLIANCES[t].kind}${opts.highlight?.has(t) ? ' on' : ''}${opts.completes?.includes(t) ? ' completes' : ''}` }, ALLIANCES[t].name)),
    ),
    opts.items?.length
      ? h(
          'div',
          { class: 'card-items' },
          opts.items.map((i) => h('span', { class: `item-chip tier-${getItem(i.itemId).tier}`, title: itemState(getItem(i.itemId), i.star).description }, itemState(getItem(i.itemId), i.star).name)),
        )
      : null,
  );
  if (opts.onItemDrop) makeItemDropTarget(card, opts.onItemDrop);
  if (opts.dragUid !== undefined) makeDraggable(card, 'unit', opts.dragUid);
  return card;
}

/** 要素をドロップ先にする。ユニットの uid を受け取る（onItemDrop があれば装備も受け取る） */
export function makeDropTarget<T extends HTMLElement>(el: T, onDrop: (uid: number) => void, onItemDrop?: (itemUid: number) => void): T {
  registerDropTarget(el, { unit: onDrop, ...(onItemDrop ? { item: onItemDrop } : {}) });
  return el;
}

export function emptySlot(label = '') {
  return h('div', { class: 'card empty' }, label);
}

/** 開いている盟約の詳細（再描画しても開閉状態を保つ） */
const openAlliances = new Set<AllianceId>();

/** 発動段階の表記：炎（3/6/9）の2段階目なら「炎6」 */
export function allianceLabel(st: AllianceStatus): string {
  const def = ALLIANCES[st.id];
  return `${def.name}${st.level > 0 ? def.thresholds[st.level - 1] : ''}`;
}

/** 発動中の盟約と加算数だけのまとめ */
export function allianceSummary(statuses: AllianceStatus[], stacks: Partial<Record<AllianceId, number>>, banned: AllianceId[] = []) {
  const active = statuses.filter((s) => s.level > 0);
  return h(
    'div',
    { class: 'alliance-summary' },
    active.length
      ? active.map((st) =>
          h(
            'span',
            { class: `chip ${ALLIANCES[st.id].kind}` },
            h('b', null, allianceLabel(st)),
            h('span', { class: 'chip-stack' }, `${stacks[st.id] ?? 0}`),
          ),
        )
      : h('span', { class: 'muted small' }, '発動中の盟約なし'),
    banned.length ? h('span', { class: 'ban-list small' }, 'BAN：', banned.map((b) => ALLIANCES[b].name).join('・')) : null,
  );
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
      const details = h(
        'details',
        { open: openAlliances.has(st.id) },
        h(
          'summary',
          { class: 'alliance-head' },
          h('span', { class: 'alliance-name' }, def.name),
          st.banned ? h('span', { class: 'badge' }, 'BAN') : null,
          h(
            'span',
            { class: 'thresholds' },
            def.thresholds.map((t, i) => h('span', { class: st.count >= t ? 'th on' : 'th' }, t, i < def.thresholds.length - 1 ? '/' : '')),
          ),
          def.noStack ? null : h('span', { class: 'stack', title: '加算数' }, `加算数 ${stack}`),
          h('span', { class: 'count', title: def.countMode === 'elite' ? '盤面の精鋭オペレーターの人数' : undefined }, `${st.count}人`),
        ),
        h(
          'ul',
          { class: 'alliance-tiers' },
          tiers.map((t, i) =>
            h(
              'li',
              { class: `${i < st.level ? 'on' : ''}${t.notSimulated ? ' nosim' : ''}`, title: t.notSimulated ? '戦闘では再現していません' : undefined },
              h('span', { class: 'need' }, `${t.count}`),
              t.text,
            ),
          ),
          (def.stackMilestones?.(stack) ?? []).map((m) => h('li', { class: `milestone ${m.reached && st.level > 0 ? 'on' : ''}` }, m.text)),
        ),
      ) as HTMLDetailsElement;
      details.addEventListener('toggle', () => {
        if (details.open) openAlliances.add(st.id);
        else openAlliances.delete(st.id);
      });
      return h('li', { class: `alliance ${st.level > 0 ? 'active' : ''} ${st.banned ? 'banned' : ''} ${def.kind}` }, details);
    }),
  );
}

// ------------------------------------------------------------
// 装備
// ------------------------------------------------------------

export function itemCard(
  itemId: string,
  opts: { star?: Star; price?: number; dragItemUid?: number; dim?: boolean; onClick?: () => void } = {},
) {
  const def = getItem(itemId);
  const st = itemState(def, opts.star ?? 1);
  const card = h(
    'div',
    {
      role: 'button',
      tabindex: 0,
      class: `card item tier-${def.tier}${opts.dim ? ' dim' : ''}${opts.star === 2 ? ' golden' : ''}`,
      onclick: opts.onClick ? () => opts.onClick!() : undefined,
      title: `${st.name}\n${st.description}`,
    },
    h(
      'div',
      { class: 'card-top' },
      h('span', { class: 'card-name' }, st.name),
      opts.price !== undefined ? h('span', { class: 'price' }, `${opts.price}`) : opts.star === 2 ? h('span', { class: 'promoted' }, '精鋭') : null,
    ),
    h('div', { class: 'item-desc' }, st.description),
  );
  if (opts.dragItemUid !== undefined) makeDraggable(card, 'item', opts.dragItemUid);
  return card;
}

/** 要素を装備のドロップ先にする（オペレーターへの装備など） */
export function makeItemDropTarget<T extends HTMLElement>(el: T, onDrop: (itemUid: number) => void): T {
  registerDropTarget(el, { item: onDrop });
  return el;
}

function modifierText(m: Modifier): string[] {
  const out: string[] = [];
  if (m.atkPct) out.push(`攻撃力+${pct(m.atkPct)}`);
  if (m.atkFlat) out.push(`基礎攻撃力+${fmt(m.atkFlat)}`);
  if (m.blockFlat) out.push(`ブロック数+${m.blockFlat}`);
  if (m.aspd) out.push(`攻撃速度+${Math.round(m.aspd * 10) / 10}`);
  if (m.spRegen) out.push(`SP回復+${Math.round(m.spRegen * 100) / 100}/秒`);
  if (m.startSp) out.push(`初期SP+${m.startSp}`);
  if (m.defIgnorePct) out.push(`防御無視${pct(m.defIgnorePct)}`);
  if (m.resIgnorePct) out.push(`術耐性無視${pct(m.resIgnorePct)}`);
  if (m.damagePct) out.push(`与ダメ+${pct(m.damagePct)}`);
  if (m.damageMult && m.damageMult !== 1) out.push(`与ダメ×${Math.round(m.damageMult * 100) / 100}`);
  if (m.trueDmgPct) out.push(`確定追加${pct(m.trueDmgPct)}`);
  if (m.spOnSkillEnd) out.push(`スキル終了時に確率でSP+${Math.round(m.spOnSkillEnd * 10) / 10}（【俊敏】）`);
  if (m.ammoPct) out.push(`弾薬+${pct(m.ammoPct)}`);
  if (m.weakDamage) out.push('弱点ダメージ');
  if (m.hpPct) out.push(`最大HP${m.hpPct > 0 ? '+' : ''}${pct(m.hpPct)}`);
  if (m.defPct) out.push(`防御力+${pct(m.defPct)}`);
  if (m.resFlat) out.push(`術耐性+${m.resFlat}`);
  if (m.damageReduce) out.push(`被ダメージ-${pct(m.damageReduce)}`);
  if (m.taunt) out.push('狙われやすい');
  if (m.neutralize) out.push(`攻撃した敵の特殊能力を${m.neutralize}秒無効化`);
  if (m.lifeOnHit) out.push(`攻撃ごとに最大HPの${pct(m.lifeOnHit)}回復`);
  if (m.regenPct) out.push(`毎秒最大HPの${pct(m.regenPct)}回復`);
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
    h('div', { class: 'muted small' }, `${PROFESSION_NAME[d.profession]}・${DAMAGE_TYPE_NAME[d.damageType]}　${phaseText}`),
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
      h('dt', null, '素質'),
      h(
        'dd',
        null,
        talentStatus(d, o.star).length
          ? talentStatus(d, o.star).map((tl) =>
              h(
                'div',
                { class: `talent small${tl.impl === 'none' ? ' nosim' : ''}`, title: tl.note ?? (tl.impl === 'none' ? 'まだシミュレーターで再現していない素質です' : undefined) },
                h('b', null, tl.name),
                h('span', { class: `talent-impl ${tl.impl}` }, tl.impl === 'full' ? '再現' : tl.impl === 'partial' ? '一部' : '未再現'),
                '：',
                tl.description,
                tl.note ? h('span', { class: 'muted' }, `（${tl.note}）`) : null,
              ),
            )
          : h('span', { class: 'muted' }, 'なし'),
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
      h('dt', null, '装備'),
      h(
        'dd',
        null,
        (o.items ?? []).length
          ? (o.items ?? []).map((i) => {
              const st = itemState(getItem(i.itemId), i.star);
              return h('div', { class: 'small' }, h('b', null, st.name, i.star === 2 ? '（精鋭）' : ''), '：', st.description);
            })
          : h('span', { class: 'muted' }, 'なし'),
      ),
      h('dt', null, '補正'),
      h('dd', null, modText.length ? modText.join('、') : h('span', { class: 'muted' }, 'なし（配置すると表示）')),
    ),
  );
}
