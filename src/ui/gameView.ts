import { ALLIANCES } from '../core/data/alliances';
import { enemyForRound } from '../core/data/enemies';
import { getUnit } from '../core/data/units';
import { evaluateAlliances, unitAlliances, unitModifiers } from '../core/alliance';
import {
  allOwned,
  buildSimInputs,
  findOwned,
  levelUpCost,
  sellPrice,
  type Action,
  type GameState,
} from '../core/game';
import { MAX_ROUND, REFRESH_COST, TIER_ODDS, deployCap } from '../core/rules';
import { simulateDps } from '../core/sim';
import type { AllianceId } from '../core/types';
import {
  alliancePanel,
  emptySlot,
  enemyInfo,
  predictionLine,
  simSummary,
  unitCard,
  unitDetail,
} from './components';
import { h } from './dom';

export interface GameViewProps {
  state: GameState;
  selectedUid: number | null;
  dispatch: (a: Action) => void;
  select: (uid: number | null) => void;
  newGame: () => void;
}

/** 戦闘開始時に増える加算数を含めた値（予測用） */
function stacksAtBattle(state: GameState): Partial<Record<AllianceId, number>> {
  const out = { ...state.stacks };
  for (const st of evaluateAlliances(state.board)) {
    if (st.level > 0 && ALLIANCES[st.id].gainsStacks) out[st.id] = (out[st.id] ?? 0) + st.count;
  }
  return out;
}

export function gameView(p: GameViewProps): HTMLElement {
  const { state } = p;
  if (state.phase === 'result' && state.lastBattle) return resultView(p);
  if (state.phase === 'gameover' || state.phase === 'clear') return endView(p);
  return prepView(p);
}

function topBar(state: GameState, extra: HTMLElement | null = null) {
  const cap = deployCap(state.level);
  return h(
    'div',
    { class: 'topbar' },
    h('div', { class: 'stat' }, h('span', { class: 'label' }, 'ラウンド'), h('b', null, `${state.round}/${MAX_ROUND}`)),
    h('div', { class: `stat ${state.life <= 5 ? 'warn' : ''}` }, h('span', { class: 'label' }, '耐久値'), h('b', null, state.life)),
    h('div', { class: 'stat gold' }, h('span', { class: 'label' }, '資金'), h('b', null, state.gold)),
    h('div', { class: 'stat' }, h('span', { class: 'label' }, '管理レベル'), h('b', null, state.level), h('span', { class: 'muted small' }, `配置上限${cap}`)),
    extra,
  );
}

function prepView(p: GameViewProps): HTMLElement {
  const { state, dispatch, select, selectedUid } = p;
  const cap = deployCap(state.level);
  const enemy = enemyForRound(state.round);
  const statuses = evaluateAlliances(state.board);
  const activeIds = new Set(statuses.filter((s) => s.level > 0).map((s) => s.id));
  const stacks = stacksAtBattle(state);
  const { inputs } = buildSimInputs(state.board, stacks);
  const prediction = simulateDps(inputs, enemy);
  const lvCost = levelUpCost(state.level);
  const ownedIds = new Set(allOwned(state).map((o) => o.defId));

  // 選択中ユニットの詳細
  const sel = selectedUid !== null ? findOwned(state, selectedUid) : null;
  let detail: HTMLElement = h('p', { class: 'muted' }, 'ユニットをクリックすると詳細と操作が表示されます');
  if (sel) {
    const mods = unitModifiers(state.board, statuses, stacks).get(sel.unit.uid);
    detail = h(
      'div',
      null,
      unitDetail(sel.unit, sel.where === 'board' ? mods : undefined),
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
        ? unitCard(o.defId, {
            star: o.star,
            selected: o.uid === selectedUid,
            highlight: activeIds,
            onClick: () => select(o.uid === selectedUid ? null : o.uid),
          })
        : emptySlot('空き'),
    );
  }

  const odds = TIER_ODDS[state.level - 1];

  return h(
    'div',
    { class: 'game' },
    topBar(
      state,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', onclick: () => dispatch({ type: 'levelUp' }), disabled: lvCost === null || state.gold < lvCost }, lvCost === null ? 'レベル最大' : `レベルアップ（${lvCost}）`),
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
              o
                ? unitCard(o.defId, { star: o.star, selected: o.uid === selectedUid, onClick: () => select(o.uid === selectedUid ? null : o.uid) })
                : emptySlot(),
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
              h('button', { class: 'btn', onclick: () => dispatch({ type: 'refresh' }), disabled: state.gold < REFRESH_COST }, `更新（${REFRESH_COST}）`),
            ),
          ),
          h(
            'div',
            { class: `cards ${state.frozen ? 'frozen' : ''}` },
            state.shop.map((id, slot) =>
              id
                ? unitCard(id, {
                    price: getUnit(id).tier,
                    dim: state.gold < getUnit(id).tier,
                    selected: ownedIds.has(id),
                    highlight: new Set(unitAlliances(id).filter((a) => activeIds.has(a))),
                    onClick: () => dispatch({ type: 'buy', slot }),
                  })
                : emptySlot('購入済み'),
            ),
          ),
        ),
      ),
      h(
        'aside',
        null,
        h('section', { class: 'panel' }, h('h2', null, '次の敵'), enemyInfo(enemy), predictionLine(prediction)),
        h('section', { class: 'panel' }, h('h2', null, '選択中'), detail),
        h('section', { class: 'panel' }, h('h2', null, '盟約'), alliancePanel(statuses, state.stacks)),
      ),
    ),
  );
}

function resultView(p: GameViewProps): HTMLElement {
  const { state, dispatch } = p;
  const b = state.lastBattle!;
  const totalIncome = b.income.base + b.income.interest + b.income.win + b.income.alliance;
  const gained = Object.entries(b.stacksGained) as [AllianceId, number][];
  const nextLabel = state.life <= 0 ? '結果を見る' : state.round >= MAX_ROUND ? '結果を見る' : '次のラウンドへ';
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
            h('dt', null, '基本収入'),
            h('dd', null, `+${b.income.base}`),
            h('dt', null, '利子'),
            h('dd', null, `+${b.income.interest}`),
            h('dt', null, '撃破ボーナス'),
            h('dd', null, `+${b.income.win}`),
            h('dt', null, '盟約'),
            h('dd', null, `+${b.income.alliance}`),
            h('dt', null, '合計'),
            h('dd', null, h('b', null, `+${totalIncome}`)),
          ),
          gained.length
            ? h('p', { class: 'small' }, '加算数：', gained.map(([id, n]) => `${ALLIANCES[id].name}+${n}`).join('、'))
            : null,
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
