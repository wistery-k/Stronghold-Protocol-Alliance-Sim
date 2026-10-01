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
import { BENCH_SIZE, MAX_ROUND, REFRESH_COST, TIER_ODDS, deployCap } from '../core/rules';
import { benchOverflow } from '../core/acquire';
import { simulateDps } from '../core/sim';
import type { AllianceId } from '../core/types';
import { alliancePanel, boardGrid, emptySlot, enemyInfo, makeDropTarget, predictionLine, simSummary, unitCard, unitDetail } from './components';
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
    extra,
  );
}

const lastClick: { uid: number | null; at: number } = { uid: null, at: 0 };

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
  // 非精鋭で所持しているオペレーター（ショップで光らせる）
  const ownedNormal = new Set(allOwned(state).filter((o) => o.star === 1).map((o) => o.defId));
  const hasChoice = state.choices.length > 0;
  const overflow = benchOverflow(state);
  const blockReason = hasChoice ? '無料獲得の候補を先に選んでください' : overflow > 0 ? `控えが上限を${overflow}名超えています` : null;

  // 詳細表示：マウスオーバー中のユニットを優先し、なければ選択中のユニット。
  // マウスオーバーでは全体を再描画せず（ドラッグが途切れるため）、詳細パネルだけを差し替える
  const renderDetail = (hoverUid: number | null): HTMLElement[] => {
    const shownUid = hoverUid ?? selectedUid;
    const shown = shownUid !== null ? findOwned(state, shownUid) : null;
    const title = h('h2', null, shown && shown.unit.uid !== selectedUid ? '詳細' : '選択中');
    if (!shown) {
      return [title, h('p', { class: 'muted' }, 'ユニットにマウスを乗せると詳細が表示されます。ドラッグで配置・入れ替え、ダブルクリックで配置/控えへ移動、招集欄へドロップで売却')];
    }
    const isSelected = shown.unit.uid === selectedUid;
    return [
      title,
      unitDetail(shown.unit, shown.where === 'board' ? setup.mods.get(shown.unit.uid) : undefined),
      setup.excluded.has(shown.unit.uid) ? h('p', { class: 'small ng' }, '【エーギル】に捕食され、戦闘開始時に倒れます') : null,
      isSelected
        ? h(
            'div',
            { class: 'row' },
            shown.where === 'bench'
              ? h('button', { class: 'btn primary', onclick: () => dispatch({ type: 'deploy', uid: shown.unit.uid }), disabled: state.board.length >= cap }, '配置する')
              : h('button', { class: 'btn', onclick: () => dispatch({ type: 'undeploy', uid: shown.unit.uid }) }, '控えに戻す'),
            h('button', { class: 'btn danger', onclick: () => { dispatch({ type: 'sell', uid: shown.unit.uid }); select(null); } }, `売却（+${sellPrice(shown.unit)}）`),
          )
        : h('p', { class: 'muted small' }, 'クリックで選択すると売却ボタンが出ます'),
    ].filter((x): x is HTMLElement => x !== null);
  };
  const detailPanel = h('section', { class: 'panel detail-panel' }, renderDetail(null));
  let hovered: number | null = null;
  const hover = (uid: number | null) => {
    if (hovered === uid || document.body.classList.contains('dragging')) return;
    hovered = uid;
    detailPanel.replaceChildren(...renderDetail(uid));
  };

  // クリックのたびに再描画されるので、ダブルクリックは自前で判定する
  const cardFor = (uid: number, where: 'board' | 'bench') => ({
    selected: uid === selectedUid,
    highlight: where === 'board' ? activeIds : undefined,
    onClick: () => {
      const now = Date.now();
      if (lastClick.uid === uid && now - lastClick.at < 400) {
        lastClick.uid = null;
        dispatch(where === 'bench' ? { type: 'deploy', uid } : { type: 'undeploy', uid });
        return;
      }
      lastClick.uid = uid;
      lastClick.at = now;
      select(uid === selectedUid ? null : uid);
    },
    onHover: (enter: boolean) => hover(enter ? uid : null),
  });

  const benchSlots = state.bench.map((o, index) => {
    const slot = h(
      'div',
      { class: `slot${index >= BENCH_SIZE ? ' over' : ''}` },
      o ? unitCard(o.defId, { star: o.star, dragUid: o.uid, ...cardFor(o.uid, 'bench') }) : emptySlot(),
    );
    return makeDropTarget(slot, (uid) => dispatch({ type: 'move', uid, to: { zone: 'bench', index } }));
  });

  const odds = TIER_ODDS[state.level - 1];
  const refreshLabel = state.freeRefreshes > 0 ? `更新（無料×${state.freeRefreshes}）` : state.nextRefreshFree ? '更新（無料）' : `更新（${REFRESH_COST}）`;
  const refreshFree = state.freeRefreshes > 0 || state.nextRefreshFree;
  const gainedStacks = (Object.entries(battleStacks) as [AllianceId, number][])
    .map(([id, n]) => [id, n - (state.stacks[id] ?? 0)] as const)
    .filter(([, d]) => d > 0);

  const choice = state.choices[0];
  const choicePanel = choice
    ? h(
        'section',
        { class: 'panel elite' },
        h(
          'div',
          { class: 'panel-head' },
          h('h2', null, `${choice.title}：1名を無料で獲得${state.choices.length > 1 ? `（残り${state.choices.length}回）` : ''}`),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost small', onclick: () => dispatch({ type: 'skipChoice' }) }, '見送る')),
        ),
        h(
          'div',
          { class: 'cards' },
          choice.options.map((id, index) =>
            unitCard(id, {
              owned: ownedNormal.has(id),
              highlight: new Set(unitAlliances(id).filter((a) => activeIds.has(a))),
              onClick: () => dispatch({ type: 'choose', index }),
            }),
          ),
        ),
      )
    : null;

  const shopPanel = makeDropTarget(
    h(
      'section',
      { class: 'panel shop' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', null, '招集'),
        h('div', { class: 'stat gold inline' }, h('span', { class: 'label' }, '資金'), h('b', null, state.gold), state.pendingGold ? h('span', { class: 'muted small' }, `次+${state.pendingGold}`) : null),
        h('div', { class: 'stat inline' }, h('span', { class: 'label' }, '管理レベル'), h('b', null, state.level)),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: () => dispatch({ type: 'levelUp' }), disabled: lvCost === null || state.gold < lvCost }, lvCost === null ? 'レベル最大' : `レベル+1（${lvCost}）`),
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
            owned: ownedNormal.has(id),
            highlight: new Set(unitAlliances(id).filter((a) => activeIds.has(a))),
            onClick: () => dispatch({ type: 'buy', slot }),
          });
        }),
      ),
      h('div', { class: 'muted small odds' }, odds.map((o, i) => (o ? `等級${i + 1}:${o}%` : '')).filter(Boolean).join('　'), '　｜ここへドロップで売却'),
    ),
    (uid) => {
      dispatch({ type: 'sell', uid });
      select(null);
    },
  );

  return h(
    'div',
    { class: 'game' },
    topBar(
      state,
      h(
        'div',
        { class: 'actions' },
        blockReason ? h('span', { class: 'ng small' }, blockReason) : null,
        h('button', { class: 'btn primary big', onclick: () => { select(null); dispatch({ type: 'battle' }); }, disabled: !!blockReason, title: blockReason ?? undefined }, '戦闘開始'),
      ),
    ),
    h(
      'div',
      { class: 'layout' },
      h(
        'main',
        null,
        h(
          'section',
          { class: 'panel' },
          h('h2', null, `配置（${state.board.length}/${cap}）`),
          boardGrid(state.board, {
            cardOptions: (o) => ({
              ...cardFor(o.uid, 'board'),
              dim: setup.excluded.has(o.uid),
            }),
            onDropCell: (pos, uid) => dispatch({ type: 'move', uid, to: { zone: 'board', pos } }),
            onTurn: (uid, dir) => dispatch({ type: 'turn', uid, dir }),
          }),
        ),
        h(
          'section',
          { class: `panel${overflow > 0 ? ' overflow' : ''}` },
          h('h2', null, `控え（${bench.length}/${BENCH_SIZE}）`, overflow > 0 ? h('span', { class: 'ng' }, `　${overflow}名超過：配置か売却で上限内に戻してください`) : null),
          h('div', { class: 'cards bench' }, benchSlots),
        ),
        choicePanel,
        shopPanel,
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
        detailPanel,
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
