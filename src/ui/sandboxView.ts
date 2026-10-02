import { ALLIANCES } from '../core/data/alliances';
import { ROUNDS, roundEnemySummary, roundSpec } from '../core/data/battle';
import { UNITS, getUnit } from '../core/data/units';
import { activeAllianceIds } from '../core/alliance';
import { buildSimInputs } from '../core/game';
import { DEPLOY_CAP } from '../core/rules';
import { battleTimeLimit, simulateBattle, type BattleResult } from '../core/sim';
import type { AllianceId, OwnedUnit, Star } from '../core/types';
import { alliancePanel, unitCard } from './components';
import { autoCell, bestDirection, canPlace } from '../core/board';
import { battleSummary, mapGrid, predictionLine, roundInfo } from './battleView';
import { h } from './dom';

// 好きな編成で任意のラウンドの戦闘を試せるサンドボックス

export interface SandboxState {
  units: OwnedUnit[];
  round: number;
  /** リプレイ付きで実行した結果（編成を変えると消える） */
  replay: BattleResult | null;
  stacks: Partial<Record<AllianceId, number>>;
  nextUid: number;
  selectedUid: number | null;
}

export const SANDBOX_MAX_UNITS = DEPLOY_CAP;

export function createSandbox(): SandboxState {
  return { units: [], round: 14, replay: null, stacks: {}, nextUid: 1, selectedUid: null };
}

export function sandboxView(sb: SandboxState, rawUpdate: (f: (s: SandboxState) => void) => void): HTMLElement {
  // 何か変えたらリプレイは古くなるので消す
  const update = (f: (s: SandboxState) => void) =>
    rawUpdate((s) => {
      s.replay = null;
      f(s);
    });
  const spec = roundSpec(sb.round ?? 14);
  const { inputs, statuses, globals, excluded } = buildSimInputs(sb.units, [], sb.stacks);
  const selected = sb.units.find((u) => u.uid === sb.selectedUid);
  const activeIds = activeAllianceIds(statuses);
  const simOpts = { globals, activeAlliances: activeIds, stacks: sb.stacks };
  const result = sb.replay ?? (sb.units.length ? simulateBattle(inputs, spec, simOpts) : null);
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
                mapGrid(sb.units, {
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
                      if (!u || !canPlace(pos, u.defId)) return;
                      const other = s.units.find((x) => x.pos === pos);
                      if (other && other !== u) {
                        if (u.pos === undefined || !canPlace(u.pos, other.defId)) return;
                        other.pos = u.pos;
                        other.dir = bestDirection(other.pos, other.defId, other.star);
                      }
                      u.pos = pos;
                      u.dir = bestDirection(pos, u.defId, u.star);
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
                  : h('p', { class: 'muted small' }, 'クリックで選択して精鋭化・外す。ドラッグで位置を変更（高台には遠距離のみ）'),
              ),
        ),
        h(
          'section',
          { class: 'panel' },
          h(
            'div',
            { class: 'panel-head' },
            h('h2', null, `結果（ラウンド${spec.round}）`),
            h(
              'button',
              { class: 'btn primary', disabled: !sb.units.length, onclick: () => rawUpdate((s) => { s.replay = simulateBattle(inputs, spec, { ...simOpts, record: true }); }) },
              sb.replay ? 'もう一度再生' : 'リプレイを見る',
            ),
          ),
          result
            ? sb.replay
              ? battleSummary(result, sb.units.map((u) => ({ uid: u.uid, defId: u.defId, star: u.star, pos: u.pos, dir: u.dir })))
              : h('div', null, predictionLine(result), h('p', { class: 'muted small' }, `撃破 ${result.killed}/${result.total}・総ダメージ ${Math.round(result.totalDamage).toLocaleString()}`))
            : h('p', { class: 'muted' }, '編成すると自動で計算されます'),
        ),
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
                        const cell = autoCell(s.units, u.id, 1);
                        if (!cell) return;
                        s.units.push({ uid: s.nextUid++, defId: u.id, star: 1, pos: cell.pos, dir: cell.dir });
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
            { class: 'select', onchange: (e: Event) => update((s) => { s.round = Number((e.target as HTMLSelectElement).value); }) },
            ROUNDS.map((r) => {
              const boss = roundEnemySummary(r).find((x) => x.enemy.boss);
              return h('option', { value: r.round, selected: r.round === spec.round }, `ラウンド${r.round}${boss ? `　★${boss.enemy.name}` : ''}`);
            }),
          ),
          roundInfo(spec, battleTimeLimit(spec)),
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
