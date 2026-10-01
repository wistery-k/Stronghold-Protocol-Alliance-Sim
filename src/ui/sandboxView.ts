import { ALLIANCES } from '../core/data/alliances';
import { BOSSES, enemyForRound } from '../core/data/enemies';
import { UNITS, getUnit } from '../core/data/units';
import { activeAllianceIds } from '../core/alliance';
import { buildSimInputs } from '../core/game';
import { DEPLOY_CAP, MAX_ROUND } from '../core/rules';
import { simulateDps } from '../core/sim';
import type { AllianceId, EnemyDef, OwnedUnit, Star } from '../core/types';
import { alliancePanel, boardGrid, enemyInfo, simSummary, unitCard } from './components';
import { firstFreeCell } from '../core/board';
import { h } from './dom';

// 好きな編成で任意の敵に対するDPSを試せるサンドボックス

export interface SandboxState {
  units: OwnedUnit[];
  enemyId: string;
  stacks: Partial<Record<AllianceId, number>>;
  nextUid: number;
  selectedUid: number | null;
}

export const SANDBOX_MAX_UNITS = DEPLOY_CAP;

export function createSandbox(): SandboxState {
  return { units: [], enemyId: BOSSES[0].id, stacks: {}, nextUid: 1, selectedUid: null };
}

function allEnemies(): EnemyDef[] {
  const list: EnemyDef[] = [];
  for (let r = 1; r <= MAX_ROUND; r++) {
    const e = enemyForRound(r);
    list.push({ ...e, name: `R${r} ${e.name}` });
  }
  // ラウンドに出てこないボスも試せるようにする
  for (const b of BOSSES) if (!list.some((e) => e.id === b.id)) list.push(b);
  return list;
}

export function sandboxView(sb: SandboxState, update: (f: (s: SandboxState) => void) => void): HTMLElement {
  const enemies = allEnemies();
  const enemy = enemies.find((e) => e.id === sb.enemyId) ?? enemies[0];
  const { inputs, statuses, globals, excluded } = buildSimInputs(sb.units, [], sb.stacks);
  const selected = sb.units.find((u) => u.uid === sb.selectedUid);
  const activeIds = activeAllianceIds(statuses);
  const result = sb.units.length ? simulateDps(inputs, enemy, { globals, activeAlliances: activeIds, stacks: sb.stacks }) : null;
  const stackAlliances = statuses.map((st) => ALLIANCES[st.id]);

  return h(
    'div',
    { class: 'game sandbox' },
    h(
      'div',
      { class: 'layout' },
      h(
        'main',
        null,
        h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panel-head' },
            h('h2', null, `編成（${sb.units.length}/${SANDBOX_MAX_UNITS}）`),
            h('button', { class: 'btn', onclick: () => update((s) => { s.units = []; }), disabled: !sb.units.length }, 'すべて外す'),
          ),
          sb.units.length === 0
            ? h('p', { class: 'muted' }, '下の一覧からオペレーターを追加してください')
            : h(
                'div',
                null,
                boardGrid(sb.units, {
                  cardOptions: (o) => ({
                    highlight: activeIds,
                    selected: o.uid === sb.selectedUid,
                    dim: excluded.has(o.uid),
                    onClick: () => update((s) => { s.selectedUid = s.selectedUid === o.uid ? null : o.uid; }),
                  }),
                  onTurn: (uid, dir) => update((s) => { s.units.find((u) => u.uid === uid)!.dir = dir; }),
                  onDropCell: (pos, uid) =>
                    update((s) => {
                      const u = s.units.find((x) => x.uid === uid);
                      if (!u) return;
                      const other = s.units.find((x) => x.pos === pos);
                      if (other) other.pos = u.pos;
                      u.pos = pos;
                    }),
                }),
                selected
                  ? h(
                      'div',
                      { class: 'row' },
                      h('b', null, getUnit(selected.defId).name),
                      ([1, 2] as Star[]).map((st) =>
                        h('button', { class: `btn tiny ${selected.star === st ? 'on' : ''}`, onclick: () => update((s) => { s.units.find((u) => u.uid === selected.uid)!.star = st; }) }, st === 2 ? '精鋭' : '通常'),
                      ),
                      h('button', { class: 'btn tiny danger', onclick: () => update((s) => { s.units = s.units.filter((u) => u.uid !== selected.uid); s.selectedUid = null; }) }, '外す'),
                    )
                  : h('p', { class: 'muted small' }, 'クリックで選択して精鋭化・外す。ドラッグで位置を変更'),
              ),
        ),
        h('section', { class: 'panel' }, h('h2', null, '結果'), result ? simSummary(result) : h('p', { class: 'muted' }, '編成すると自動で計算されます')),
        h(
          'section',
          { class: 'panel' },
          h('h2', null, 'オペレーター一覧'),
          [1, 2, 3, 4, 5, 6].map((tier) =>
            h(
              'div',
              { class: 'tier-group' },
              h('h3', null, `等級${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][tier]}`),
              h(
                'div',
                { class: 'cards' },
                UNITS.filter((u) => u.tier === tier).map((u) =>
                  unitCard(u.id, {
                    dim: sb.units.length >= SANDBOX_MAX_UNITS,
                    highlight: activeIds,
                    onClick: () =>
                      update((s) => {
                        if (s.units.length >= SANDBOX_MAX_UNITS) return;
                        const pos = firstFreeCell(s.units);
                        if (pos === null) return;
                        s.units.push({ uid: s.nextUid++, defId: u.id, star: 1, pos });
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'aside',
        null,
        h(
          'section',
          { class: 'panel' },
          h('h2', null, '敵'),
          h(
            'select',
            { class: 'select', onchange: (e: Event) => update((s) => { s.enemyId = (e.target as HTMLSelectElement).value; }) },
            enemies.map((e) => h('option', { value: e.id, selected: e.id === enemy.id }, `${e.isBoss ? '★ ' : ''}${e.name}`)),
          ),
          enemyInfo(enemy),
        ),
        h(
          'section',
          { class: 'panel' },
          h('h2', null, '加算数'),
          stackAlliances.length === 0 ? h('p', { class: 'muted small' }, '編成に含まれる盟約の加算数を設定できます') : null,
          stackAlliances.map((a) =>
            h(
              'label',
              { class: 'stack-input' },
              h('span', null, a.name),
              h('input', {
                type: 'number',
                min: 0,
                max: 200,
                value: sb.stacks[a.id] ?? 0,
                onchange: (e: Event) => update((s) => { s.stacks[a.id] = Math.max(0, Number((e.target as HTMLInputElement).value) || 0); }),
              }),
            ),
          ),
        ),
        h('section', { class: 'panel' }, h('h2', null, '盟約'), alliancePanel(statuses, sb.stacks)),
      ),
    ),
  );
}
