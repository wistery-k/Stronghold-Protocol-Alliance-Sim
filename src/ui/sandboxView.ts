import { ALLIANCES } from '../core/data/alliances';
import { BOSSES, enemyForRound } from '../core/data/enemies';
import { UNITS } from '../core/data/units';
import { evaluateAlliances } from '../core/alliance';
import { buildSimInputs } from '../core/game';
import { MAX_ROUND } from '../core/rules';
import { simulateDps } from '../core/sim';
import type { AllianceId, EnemyDef, OwnedUnit, Star } from '../core/types';
import { alliancePanel, enemyInfo, simSummary, unitCard } from './components';
import { h } from './dom';

// 好きな編成で任意の敵に対するDPSを試せるサンドボックス

export interface SandboxState {
  units: OwnedUnit[];
  enemyId: string;
  stacks: Partial<Record<AllianceId, number>>;
  nextUid: number;
}

export const SANDBOX_MAX_UNITS = 9;

export function createSandbox(): SandboxState {
  return { units: [], enemyId: BOSSES[0].id, stacks: {}, nextUid: 1 };
}

function allEnemies(): EnemyDef[] {
  const list: EnemyDef[] = [];
  for (let r = 1; r <= MAX_ROUND; r++) {
    const e = enemyForRound(r);
    list.push({ ...e, name: `R${r} ${e.name}` });
  }
  return list;
}

export function sandboxView(sb: SandboxState, update: (f: (s: SandboxState) => void) => void): HTMLElement {
  const enemies = allEnemies();
  const enemy = enemies.find((e) => e.id === sb.enemyId) ?? enemies[0];
  const statuses = evaluateAlliances(sb.units);
  const activeIds = new Set(statuses.filter((s) => s.level > 0).map((s) => s.id));
  const { inputs } = buildSimInputs(sb.units, sb.stacks);
  const result = sb.units.length ? simulateDps(inputs, enemy) : null;
  const stackAlliances = Object.values(ALLIANCES).filter((a) => a.gainsStacks);

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
                { class: 'cards' },
                sb.units.map((o) =>
                  h(
                    'div',
                    { class: 'sb-unit' },
                    unitCard(o.defId, { star: o.star, highlight: activeIds }),
                    h(
                      'div',
                      { class: 'row tight' },
                      ([1, 2, 3] as Star[]).map((st) =>
                        h('button', { class: `btn tiny ${o.star === st ? 'on' : ''}`, onclick: () => update((s) => { s.units.find((u) => u.uid === o.uid)!.star = st; }) }, `★${st}`),
                      ),
                      h('button', { class: 'btn tiny danger', onclick: () => update((s) => { s.units = s.units.filter((u) => u.uid !== o.uid); }) }, '×'),
                    ),
                  ),
                ),
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
              h('h3', null, `等級${tier}`),
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
                        s.units.push({ uid: s.nextUid++, defId: u.id, star: 1 });
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
