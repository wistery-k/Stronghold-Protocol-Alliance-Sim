import { BANDS, type BandId } from '../core/data/bands';
import { ALLIANCES, CORE_IDS } from '../core/data/alliances';
import type { AllianceId } from '../core/types';
import { h } from './dom';

// ゲーム開始時の戦術選択

/** このゲームでBANされる盟約（核心・追加） */
function banPanel(banned: AllianceId[]): HTMLElement {
  const core = banned.filter((b) => CORE_IDS.includes(b as never));
  const extra = banned.filter((b) => !CORE_IDS.includes(b as never));
  const chips = (ids: AllianceId[]) => ids.map((b) => h('span', { class: 'ban-chip' }, ALLIANCES[b].name));
  return h(
    'div',
    { class: 'band-ban' },
    h('b', null, 'このゲームの盟約BAN'),
    banned.length
      ? [
          h('div', { class: 'ban-row' }, h('span', { class: 'muted small' }, '核心'), chips(core)),
          h('div', { class: 'ban-row' }, h('span', { class: 'muted small' }, '追加'), chips(extra)),
        ]
      : h('span', { class: 'muted small' }, 'なし'),
  );
}

export function bandView(onPick: (id: BandId) => void, onCancel: (() => void) | null, banned: AllianceId[] = []): HTMLElement {
  const random = () => {
    const pool = BANDS.filter((b) => b.impl !== 'none');
    onPick(pool[Math.floor(Math.random() * pool.length)].id);
  };
  return h(
    'div',
    { class: 'game band-select' },
    h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', null, '戦術を選択'),
        h('span', { class: 'muted small' }, '戦術ごとに初期耐久値と独自の効果があります'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: random }, 'おまかせ'),
          onCancel ? h('button', { class: 'btn ghost', onclick: onCancel }, 'キャンセル') : null,
        ),
      ),
      banPanel(banned),
      h(
        'div',
        { class: 'band-list' },
        BANDS.map((b) =>
          h(
            'button',
            { class: `band-card${b.impl === 'none' ? ' unimpl' : ''}`, onclick: () => onPick(b.id) },
            h(
              'div',
              { class: 'band-head' },
              h('b', null, b.leader),
              h('span', { class: 'band-name' }, `【${b.name}】`),
              h('span', { class: 'band-life', title: '初期耐久値' }, `耐久 ${b.life}`),
            ),
            h('div', { class: 'small' }, b.description),
            b.impl !== 'full' ? h('div', { class: 'small ng' }, `※${b.note ?? '未実装'}`) : null,
          ),
        ),
      ),
    ),
  );
}
