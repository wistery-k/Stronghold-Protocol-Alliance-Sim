import { BANDS, type BandId } from '../core/data/bands';
import { h } from './dom';

// ゲーム開始時の戦術選択

export function bandView(onPick: (id: BandId) => void, onCancel: (() => void) | null): HTMLElement {
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
