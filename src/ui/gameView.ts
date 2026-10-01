import { ALLIANCES } from '../core/data/alliances';
import { enemyForRound } from '../core/data/enemies';
import { activeAllianceIds, evaluateAlliances, unitAlliances } from '../core/alliance';
import { benchUnits } from '../core/garrison';
import {
  allOwned,
  buildSimInputs,
  findOwned,
  levelUpCost,
  previewBattleStacks,
  priceOf,
  sellPrice,
  type Action,
  type GameState,
} from '../core/game';
import { MAX_ROUND, REFRESH_COST, TIER_ODDS, deployCap } from '../core/rules';
import { simulateDps } from '../core/sim';
import type { AllianceId } from '../core/types';
import { alliancePanel, emptySlot, enemyInfo, predictionLine, simSummary, unitCard, unitDetail } from './components';
import { h } from './dom';

export interface GameViewProps {
  state: GameState;
  selectedUid: number | null;
  dispatch: (a: Action) => void;
  select: (uid: number | null) => void;
  newGame: () => void;
}

export function gameView(p: GameViewProps): HTMLElement {
  const { state } = p;
  if (state.phase === 'result' && state.lastBattle) return resultView(p);
  if (state.phase === 'gameover' || state.phase === 'clear') return endView(p);
  return prepView(p);
}

function topBar(state: GameState, extra: HTMLElement | null = null) {
  return h(
    'div',
    { class: 'topbar' },
    h('div', { class: 'stat' }, h('span', { class: 'label' }, 'ラウンド'), h('b', null, `${state.round}/${MAX_ROUND}`)),
    h('div', { class: `stat ${state.life <= 5 ? 'warn' : ''}` }, h('span', { class: 'label' }, '耐久値'), h('b', null, state.life)),
    h(
      'div',
      { class: 'stat gold' },
      h('span', { class: 'label' }, '資金'),
      h('b', null, state.gold),
      state.pendingGold ? h('span', { class: 'muted small' }, `次ラウンド+${state.pendingGold}`) : null,
    ),
    h('div', { class: 'stat' }, h('span', { class: 'label' }, '管理レベル'), h('b', null, state.level)),
    extra,
  );
}

function prepView(p: GameViewProps): HTMLElement {
  const { state, dispatch, select, selectedUid } = p;
  const cap = deployCap(state.level);
  const enemy = enemyForRound(state.round);
  const bench = benchUnits(state);
  const statuses = evaluateAlliances(state.board, bench);
  const activeIds = activeAllianceIds(statuses);
  // 戦闘開始時（準備フェーズ終了時の特性・配置時の特性の後）の加算数で予測する
  const battleStacks = previewBattleStacks(state);
  const setup = buildSimInputs(state.board, bench, battleStacks);
  const prediction = simulateDps(setup.inputs, enemy, { globals: setup.globals, activeAlliances: activeAllianceIds(setup.statuses), stacks: battleStacks });
  const lvCost = levelUpCost(state);
  const ownedIds = new Set(allOwned(state).map((o) => o.defId));

  const sel = selectedUid !== null ? findOwned(state, selectedUid) : null;
  let detail: HTMLElement = h('p', { class: 'muted' }, 'ユニットをクリックすると詳細と操作が表示されます');
  if (sel) {
    detail = h(
      'div',
      null,
      unitDetail(sel.unit, sel.where === 'board' ? setup.mods.get(sel.unit.uid) : undefined),
      h(
        'div',
        { class: 'row' },
        sel.where === 'bench'
          ? h('button', { class: 'btn primary', onclick: () => dispatch({ type: 'deploy', uid: sel.unit.uid }), disabled: state.board.length >= cap }, '配置する')
          : h('button', { class: 'btn', onclick: () => dispatch({ type: 'undeploy', uid: sel.unit.uid }) }, '控えに戻す'),
        h('button', { class: 'btn danger', onclick: () => { dispatch({ type: 'sell', uid: sel.unit.uid }); select(null); } }, `売却（+${sellPrice(sel.unit)}）`),
      ),
    );
  }

  const boardSlots = [];
  for (let i = 0; i < cap; i++) {
    const o = state.board[i];
    boardSlots.push(
      o
        ? unitCard(o.defId, { star: o.star, selected: o.uid === selectedUid, highlight: activeIds, onClick: () => select(o.uid === selectedUid ? null : o.uid) })
        : emptySlot('空き'),
    );
  }

  const odds = TIER_ODDS[state.level - 1];
  const refreshLabel = state.freeRefreshes > 0 ? `更新（無料×${state.freeRefreshes}）` : state.nextRefreshFree ? '更新（無料）' : `更新（${REFRESH_COST}）`;
  const refreshFree = state.freeRefreshes > 0 || state.nextRefreshFree;
  const gainedStacks = (Object.entries(battleStacks) as [AllianceId, number][])
    .map(([id, n]) => [id, n - (state.stacks[id] ?? 0)] as const)
    .filter(([, d]) => d > 0);

  return h(
    'div',
    { class: 'game' },
    topBar(
      state,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', onclick: () => dispatch({ type: 'levelUp' }), disabled: lvCost === null || state.gold < lvCost }, lvCost === null ? 'レベル最大' : `管理レベル+1（${lvCost}）`),
        h('button', { class: 'btn primary big', onclick: () => { select(null); dispatch({ type: 'battle' }); } }, '戦闘開始'),
      ),
    ),
    h(
      'div',
      { class: 'layout' },
      h(
        'main',
        null,
        h('section', { class: 'panel' }, h('h2', null, `配置（${state.board.length}/${cap}）`), h('div', { class: 'cards' }, boardSlots)),
        h(
          'section',
          { class: 'panel' },
          h('h2', null, '控え'),
          h(
            'div',
            { class: 'cards' },
            state.bench.map((o) =>
              o ? unitCard(o.defId, { star: o.star, selected: o.uid === selectedUid, onClick: () => select(o.uid === selectedUid ? null : o.uid) }) : emptySlot(),
            ),
          ),
        ),
        h(
          'section',
          { class: 'panel shop' },
          h(
            'div',
            { class: 'panel-head' },
            h('h2', null, '招集'),
            h('span', { class: 'muted small odds' }, odds.map((o, i) => (o ? `等級${i + 1}:${o}%` : '')).filter(Boolean).join('　')),
            h(
              'div',
              { class: 'row' },
              h('button', { class: `btn ${state.frozen ? 'on' : ''}`, onclick: () => dispatch({ type: 'toggleFreeze' }) }, state.frozen ? '凍結中' : '凍結'),
              h('button', { class: 'btn', onclick: () => dispatch({ type: 'refresh' }), disabled: !refreshFree && state.gold < REFRESH_COST }, refreshLabel),
            ),
          ),
          h(
            'div',
            { class: `cards ${state.frozen ? 'frozen' : ''}` },
            state.shop.map((id, slot) => {
              if (!id) return emptySlot('購入済み');
              const price = priceOf(state, id);
              return unitCard(id, {
                price,
                dim: state.gold < price,
                selected: ownedIds.has(id),
                highlight: new Set(unitAlliances(id).filter((a) => activeIds.has(a))),
                onClick: () => dispatch({ type: 'buy', slot }),
              });
            }),
          ),
        ),
      ),
      h(
        'aside',
        null,
        h(
          'section',
          { class: 'panel' },
          h('h2', null, '次の敵'),
          enemyInfo(enemy),
          predictionLine(prediction),
          gainedStacks.length
            ? h('p', { class: 'small muted' }, '戦闘開始時に得る加算数：', gainedStacks.map(([id, d]) => `${ALLIANCES[id].name}+${d}`).join('、'))
            : null,
        ),
        h('section', { class: 'panel' }, h('h2', null, '選択中'), detail),
        h('section', { class: 'panel' }, h('h2', null, '盟約'), alliancePanel(statuses, state.stacks)),
      ),
    ),
  );
}

function resultView(p: GameViewProps): HTMLElement {
  const { state, dispatch } = p;
  const b = state.lastBattle!;
  const gained = Object.entries(b.stacksGained) as [AllianceId, number][];
  const nextLabel = state.life <= 0 || state.round >= MAX_ROUND ? '結果を見る' : '次のラウンドへ';
  return h(
    'div',
    { class: 'game' },
    topBar(state, h('div', { class: 'actions' }, h('button', { class: 'btn primary big', onclick: () => dispatch({ type: 'next' }) }, nextLabel))),
    h(
      'div',
      { class: 'layout' },
      h('main', null, h('section', { class: 'panel' }, h('h2', null, `ラウンド${b.round}　vs ${b.sim.enemy.name}`), simSummary(b.sim))),
      h(
        'aside',
        null,
        h(
          'section',
          { class: 'panel' },
          h('h2', null, '精算'),
          h(
            'dl',
            { class: 'stats' },
            h('dt', null, '耐久値'),
            h('dd', { class: b.lifeLost ? 'ng' : 'ok' }, b.lifeLost ? `-${b.lifeLost}` : '損害なし'),
            b.nextIncome ? h('dt', null, '次ラウンドの資金') : null,
            b.nextIncome
              ? h('dd', null, `+${b.nextIncome.base}`, b.nextIncome.extra ? h('span', { class: 'muted' }, `（追加+${b.nextIncome.extra}）`) : null)
              : null,
          ),
          gained.length
            ? h('p', { class: 'small' }, '増えた加算数：', gained.map(([id, n]) => `${ALLIANCES[id].name}+${n}`).join('、'))
            : h('p', { class: 'small muted' }, '加算数の増加なし'),
        ),
        h('section', { class: 'panel' }, h('h2', null, '発動した盟約'), alliancePanel(b.alliances.filter((a) => a.level > 0), state.stacks)),
      ),
    ),
  );
}

function endView(p: GameViewProps): HTMLElement {
  const { state } = p;
  const clear = state.phase === 'clear';
  const kills = state.history.filter((x) => x.killed).length;
  return h(
    'div',
    { class: 'game end' },
    h(
      'section',
      { class: 'panel center' },
      h('h1', { class: clear ? 'ok' : 'ng' }, clear ? '防衛成功！' : '防衛失敗…'),
      h('p', null, `到達ラウンド ${state.round}　撃破 ${kills}/${state.history.length}　残り耐久値 ${state.life}`),
      h(
        'ol',
        { class: 'history' },
        state.history.map((x) =>
          h('li', { class: x.killed ? 'ok' : 'ng' }, `R${x.round} ${enemyForRound(x.round).name}：${x.killed ? '撃破' : `耐久値-${x.lifeLost}`}`),
        ),
      ),
      h('p', { class: 'muted small' }, `シード ${state.seed}`),
      h('button', { class: 'btn primary big', onclick: () => p.newGame() }, 'もう一度遊ぶ'),
    ),
  );
}
