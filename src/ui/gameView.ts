import { ALLIANCES } from '../core/data/alliances';
import { ENEMIES, getBounty, groupLabel, groupName, roundEnemySummary, roundSpec } from '../core/data/battle';
import { getBand } from '../core/data/bands';
import { getMap } from '../core/board';
import { ENEMY_HP_SCALE } from '../core/rules';
import { activeAllianceIds, alliancesCompletedBy, evaluateAlliances, unitAlliances } from '../core/alliance';
import { benchUnits } from '../core/garrison';
import {
  allOwned,
  buildSimInputs,
  findOwned,
  roundGroupOf,
  roundSpecOf,
  levelUpCost,
  previewBattleStacks,
  priceOf,
  sellPrice,
  type Action,
  type GameState,
  deployCapOf,
} from '../core/game';
import { BENCH_SIZE, MAX_ROUND, REFRESH_COST, TIER_ODDS } from '../core/rules';
import { getItem, itemState } from '../core/data/items';
import { equipNeedsDiscard } from '../core/items';
import { getUnit } from '../core/data/units';
import { isItemEntry, type OwnedItem } from '../core/types';
import { benchOverflow } from '../core/acquire';
import { battleTimeLimit, simulateBattle, type BattleResult, type SimOptions, type SimUnitInput } from '../core/sim';
import type { RoundSpec } from '../core/data/battle';
import type { AllianceId } from '../core/types';
import {
  allianceSummary,
  alliancePanel,
  emptySlot,
  itemCard,
  makeDropTarget,
  unitCard,
  unitDetail,
} from './components';
import { battleSummary, mapGrid, predictionLine, roundInfo } from './battleView';
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
    bandStat(state),
    h('div', { class: 'stat' }, h('span', { class: 'label' }, 'マップ'), h('b', null, getMap(state.mapId).name)),
    extra,
  );
}

/** 選んだ戦術（マウスオーバーで効果） */
function bandStat(state: GameState): HTMLElement | null {
  const band = getBand(state.band);
  if (!band) return null;
  const note = band.impl === 'full' ? '' : `\n※${band.note ?? '未実装'}`;
  return h(
    'div',
    { class: 'stat band-stat', title: `${band.description}${note}` },
    h('span', { class: 'label' }, '戦術'),
    h('b', null, `${band.leader}【${band.name}】`),
  );
}

/** 懸賞の候補（3ラウンド開始時に提示） */
function bountyPanel(state: GameState, dispatch: (a: Action) => void): HTMLElement | null {
  const offer = state.bounty.offer;
  if (!offer) return null;
  return h(
    'section',
    { class: 'panel elite' },
    h('div', { class: 'panel-head' }, h('h2', null, '懸賞：対象を1つ選択'), h('span', { class: 'muted small' }, '選んだ敵が3・4ラウンドに追加で出現し、倒すと資金を獲得（次のラウンドに支給）')),
    h(
      'div',
      { class: 'bounty-list' },
      offer.map((id, index) => {
        const b = getBounty(id)!;
        const e = ENEMIES[b.enemy];
        return h(
          'button',
          { class: 'bounty-card', onclick: () => dispatch({ type: 'pickBounty', index }) },
          h('div', { class: 'bounty-tier' }, `懸賞・${groupName(b.group)}${'I'.repeat(b.tier)}`),
          h('b', null, e?.name ?? b.enemy),
          h('div', { class: 'small' }, `撃破で資金+${b.coin}`),
          e
            ? h(
                'div',
                { class: 'muted small' },
                `HP ${Math.round(e.boss ? e.hp : e.hp * ENEMY_HP_SCALE)}・防御 ${e.def}・術耐 ${e.res}${e.flying ? '・飛行' : ''}${e.stealth ? '・潜行' : ''}`,
              )
            : null,
        );
      }),
    ),
  );
}

// 予測は数十ミリ秒かかるので、編成が変わらない限り使い回す
let predictionCache: { key: string; result: BattleResult } | null = null;
function cachedPrediction(inputs: SimUnitInput[], spec: RoundSpec, opts: SimOptions): BattleResult {
  let key: string | null = null;
  try {
    key = JSON.stringify([spec.round, inputs, opts.globals, [...(opts.activeAlliances ?? [])], opts.stacks], (_k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v.entries()] : v));
  } catch {
    key = null;
  }
  if (key && predictionCache?.key === key) return predictionCache.result;
  const result = simulateBattle(inputs, spec, opts);
  if (key) predictionCache = { key, result };
  return result;
}

/** ログパネルの開閉（再描画しても保つ） */
let logOpen = true;

/** プレイヤーに見せる出来事のログ（新しい順、ラウンドごと） */
function eventLog(state: GameState): HTMLElement {
  const events = [...(state.events ?? [])].reverse().slice(0, 120);
  const groups: { round: number; texts: string[] }[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.round === e.round) last.texts.push(e.text);
    else groups.push({ round: e.round, texts: [e.text] });
  }
  const details = h(
    'details',
    { class: 'panel event-log', open: logOpen },
    h('summary', null, h('h2', null, 'ログ')),
    groups.length
      ? h(
          'div',
          { class: 'event-log-body' },
          groups.map((g) =>
            h('div', { class: 'event-group' }, h('div', { class: 'event-round muted small' }, `ラウンド${g.round}`), h('ul', null, g.texts.map((t) => h('li', null, t)))),
          ),
        )
      : h('p', { class: 'muted small' }, '特性の発動・資金の増減・精鋭化などがここに表示されます'),
  ) as HTMLDetailsElement;
  details.addEventListener('toggle', () => (logOpen = details.open));
  return details;
}

/** 取り消した戦闘（同じラウンド）の結果。開いた時だけリプレイを作る */
function undonePanel(state: GameState): HTMLElement | null {
  const list = (state.undoneBattles ?? []).filter((b) => b.round === state.round);
  if (!list.length) return null;
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, `取り消した戦闘（${list.length}）`),
    list.map((b, i) => {
      const verdict = b.sim.cleared ? `${b.sim.bossDefeated ? 'ボス撃破' : '全滅'} ${b.sim.elapsed}秒` : `突破${b.sim.leaked}体・耐久値-${b.lifeLost}`;
      const body = h('div', null);
      const d = h(
        'details',
        { class: 'undone-battle' },
        h('summary', null, `${i === 0 ? '直前' : `${i + 1}つ前`}：${verdict}`),
        body,
      ) as HTMLDetailsElement;
      d.addEventListener('toggle', () => {
        if (d.open) body.replaceChildren(battleSummary(b.sim, b.units ?? []));
        else body.replaceChildren();
      });
      return d;
    }),
  );
}

/** 資金が残っている時の戦闘開始の確認 */
let confirmBattle = false;

function battleDialog(state: GameState, dispatch: (a: Action) => void, select: (uid: number | null) => void, selectedUid: number | null): HTMLElement | null {
  if (!confirmBattle) return null;
  const close = () => {
    confirmBattle = false;
    select(selectedUid);
  };
  return h(
    'div',
    { class: 'modal-backdrop', onclick: (e: Event) => { if (e.target === e.currentTarget) close(); } },
    h(
      'div',
      { class: 'modal panel', role: 'dialog', 'aria-modal': 'true' },
      h('h2', null, '本当に戦闘を開始しますか？'),
      h('p', null, `資金が ${state.gold} 残っています。残った資金は次のラウンドに繰り越されません。`),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              confirmBattle = false;
              select(null);
              dispatch({ type: 'battle' });
            },
          },
          '戦闘開始',
        ),
        h('button', { class: 'btn', onclick: close }, 'キャンセル'),
      ),
    ),
  );
}

/** 装備がいっぱいのオペレーターに装備しようとした時の確認 */
let pendingEquip: { itemUid: number; unitUid: number } | null = null;

function equipDialog(state: GameState, dispatch: (a: Action) => void, rerender: () => void): HTMLElement | null {
  if (!pendingEquip) return null;
  const { itemUid, unitUid } = pendingEquip;
  const f = findOwned(state, unitUid);
  const item = state.bench.find((b) => isItemEntry(b) && b.uid === itemUid) as OwnedItem | undefined;
  if (!f || !item) {
    pendingEquip = null;
    return null;
  }
  const close = () => {
    pendingEquip = null;
    rerender();
  };
  const name = (i: OwnedItem) => itemState(getItem(i.itemId), i.star).name;
  return h(
    'div',
    { class: 'modal-backdrop', onclick: (e: Event) => { if (e.target === e.currentTarget) close(); } },
    h(
      'div',
      { class: 'modal panel', role: 'dialog', 'aria-modal': 'true' },
      h('h2', null, `${getUnit(f.unit.defId).name}の装備は2つまでです`),
      h('p', { class: 'small' }, `「${name(item)}」を装備するために、どちらかを破棄しますか？（破棄した装備は戻りません）`),
      h(
        'div',
        { class: 'cards' },
        (f.unit.items ?? []).map((old) =>
          h(
            'div',
            { class: 'discard-option' },
            itemCard(old.itemId, { star: old.star }),
            h(
              'button',
              {
                class: 'btn danger',
                onclick: () => {
                  pendingEquip = null;
                  dispatch({ type: 'equip', itemUid, unitUid, discard: old.uid });
                },
              },
              `${name(old)}を破棄して装備`,
            ),
          ),
        ),
      ),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: close }, 'キャンセル')),
    ),
  );
}

const lastClick: { uid: number | null; at: number } = { uid: null, at: 0 };

function prepView(p: GameViewProps): HTMLElement {
  const { state, dispatch, select, selectedUid } = p;
  const cap = deployCapOf(state);
  const group = roundGroupOf(state, state.round);
  const spec = roundSpecOf(state, state.round);
  const bench = benchUnits(state);
  const statuses = evaluateAlliances(state.board, bench, state.banned);
  const activeIds = activeAllianceIds(statuses);
  // 戦闘開始時（準備フェーズ終了時の特性・配置時の特性の後）の加算数で予測する
  const battleStacks = previewBattleStacks(state);
  const setup = buildSimInputs(state.board, bench, battleStacks, { banned: state.banned, roundGained: state.round_.gained, band: state.band });
  const predictOpts = { globals: setup.globals, activeAlliances: activeAllianceIds(setup.statuses), stacks: battleStacks };
  const prediction = cachedPrediction(setup.inputs, spec, predictOpts);
  const lvCost = levelUpCost(state);
  // 非精鋭で所持しているオペレーター（ショップで光らせる）
  const ownedNormal = new Set(allOwned(state).filter((o) => o.star === 1).map((o) => o.defId));
  // 獲得すると先見・奇跡・投資家が発動人数に届くオペレーター（ショップで光らせる）
  const completes = (id: string) => alliancesCompletedBy(allOwned(state), id);
  const hasChoice = state.choices.length > 0;
  const overflow = benchOverflow(state);
  const blockReason = hasChoice
    ? '無料獲得の候補を先に選んでください'
    : state.bounty.offer
      ? '懸賞の対象を選んでください'
      : overflow > 0
        ? `控えが上限を${overflow}つ超えています`
        : null;

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
      setup.excluded.has(shown.unit.uid) ? h('p', { class: 'small ng' }, '【エーギル】に捕食され、戦闘開始時に物理ダメージを受けて倒れる見込みです') : null,
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
    items: findOwned(state, uid)?.unit.items,
    onItemDrop: (itemUid: number) => {
      const f = findOwned(state, uid);
      // 装備がいっぱいなら、どちらを破棄するか選ばせる
      if (f && equipNeedsDiscard(state, itemUid, f.unit)) {
        pendingEquip = { itemUid, unitUid: uid };
        select(selectedUid);
        return;
      }
      dispatch({ type: 'equip', itemUid, unitUid: uid });
    },
  });

  // 控えにはオペレーターと装備を一緒に置く
  const benchSlots = state.bench.map((o, index) => {
    const slot = h(
      'div',
      { class: `slot${index >= BENCH_SIZE ? ' over' : ''}` },
      isItemEntry(o)
        ? itemCard(o.itemId, { star: o.star, dragItemUid: o.uid })
        : o
          ? unitCard(o.defId, { star: o.star, dragUid: o.uid, ...cardFor(o.uid, 'bench') })
          : emptySlot(),
    );
    return makeDropTarget(
      slot,
      (uid) => dispatch({ type: 'move', uid, to: { zone: 'bench', index } }),
      (itemUid) => dispatch({ type: 'moveItem', uid: itemUid, index }),
    );
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
              completes: completes(id),
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
            completes: completes(id),
            highlight: new Set(unitAlliances(id).filter((a) => activeIds.has(a))),
            onClick: () => dispatch({ type: 'buy', slot }),
          });
        }),
        state.itemShop
          ? itemCard(state.itemShop, {
              price: getItem(state.itemShop).normal.price,
              dim: state.gold < getItem(state.itemShop).normal.price,
              onClick: () => dispatch({ type: 'buyItem' }),
            })
          : emptySlot('装備：購入済み'),
      ),
      h('div', { class: 'muted small odds' }, odds.map((o, i) => (o ? `等級${i + 1}:${o}%` : '')).filter(Boolean).join('　'), '　｜ここへドロップで売却'),
    ),
    (uid) => {
      dispatch({ type: 'sell', uid });
      select(null);
    },
    (itemUid) => dispatch({ type: 'sellItem', uid: itemUid }),
  );

  return h(
    'div',
    { class: 'game' },
    equipDialog(state, dispatch, () => select(selectedUid)),
    battleDialog(state, dispatch, select, selectedUid),
    topBar(
      state,
      h(
        'div',
        { class: 'actions' },
        blockReason ? h('span', { class: 'ng small' }, blockReason) : null,
        h(
          'button',
          {
            class: 'btn primary big',
            onclick: () => {
              // 資金が残っていれば確認する（戦術【複利】は繰り越せるので確認しない）
              if (state.gold > 0 && state.band !== 'cannot') {
                confirmBattle = true;
                select(selectedUid);
                return;
              }
              select(null);
              dispatch({ type: 'battle' });
            },
            disabled: !!blockReason,
            title: blockReason ?? undefined,
          },
          '戦闘開始',
        ),
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
          allianceSummary(statuses, state.stacks, state.banned),
          mapGrid(state.board, {
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
          h(
            'h2',
            null,
            `控え（${state.bench.filter(Boolean).length}/${BENCH_SIZE}）`,
            overflow > 0
              ? h('span', { class: 'ng' }, `　${overflow}つ超過：配置・装備・売却で上限内に戻してください`)
              : h('span', { class: 'muted small' }, '　装備はオペレーターへドラッグで装備（1人2つまで・外せません）'),
          ),
          h('div', { class: 'cards bench' }, benchSlots),
        ),
        bountyPanel(state, dispatch),
        choicePanel,
        shopPanel,
        undonePanel(state),
      ),
      h(
        'aside',
        null,
        h(
          'section',
          { class: 'panel' },
          h('h2', null, `次の敵（ラウンド${state.round}）`),
          roundInfo(spec, battleTimeLimit(spec), group),
          predictionLine(prediction),
          gainedStacks.length
            ? h('p', { class: 'small muted' }, '戦闘開始時に得る加算数：', gainedStacks.map(([id, d]) => `${ALLIANCES[id].name}+${d}`).join('、'))
            : null,
          h(
            'p',
            { class: 'small muted', title: 'ラウンドごとにこの中から1グループが選ばれます' },
            `このゲームの敵：主力部隊・${state.enemyTypes.map(groupName).join('・')}`,
          ),
        ),
        detailPanel,
        h('section', { class: 'panel' }, h('h2', null, '盟約'), alliancePanel(statuses, state.stacks)),
        eventLog(state),

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
    topBar(
      state,
      h(
        'div',
        { class: 'actions' },
        state.preBattle
          ? h('button', { class: 'btn', title: '盟約の加算数・資金なども戦闘前に戻ります。今回の戦闘結果は準備画面で見返せます', onclick: () => dispatch({ type: 'undoBattle' }) }, '戦闘前に戻す')
          : null,
        h('button', { class: 'btn primary big', onclick: () => dispatch({ type: 'next' }) }, nextLabel),
      ),
    ),
    h(
      'div',
      { class: 'layout' },
      h('main', null, h('section', { class: 'panel' }, h('h2', null, `ラウンド${b.round}　vs ${b.group ? groupLabel(b.group) : ''}`), battleSummary(b.sim, b.units ?? []))),
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
        ),
        h(
          'section',
          { class: 'panel' },
          h('h2', null, '獲得した盟約加算数'),
          gained.length
            ? h(
                'table',
                { class: 'stack-table' },
                h('thead', null, h('tr', null, h('th', null, '盟約'), h('th', null, '前'), h('th', { title: '準備フェーズ終了時・配置時' }, '準備'), h('th', null, '戦闘'), h('th', null, '合計'))),
                h(
                  'tbody',
                  null,
                  gained
                    .sort((a, b) => b[1] - a[1])
                    .map(([id, n]) =>
                      h(
                        'tr',
                        null,
                        h('td', null, ALLIANCES[id].name),
                        h('td', null, `${b.stacksBefore[id] ?? 0}`),
                        h('td', { class: 'ok' }, b.stacksFromPrep[id] ? `+${b.stacksFromPrep[id]}` : '-'),
                        h('td', { class: 'ok' }, b.stacksFromBattle[id] ? `+${b.stacksFromBattle[id]}` : '-'),
                        h('td', null, h('b', null, `${(b.stacksBefore[id] ?? 0) + n}`), h('span', { class: 'ok small' }, `（+${n}）`)),
                      ),
                    ),
                ),
              )
            : h('p', { class: 'small muted' }, '加算数の増加なし'),
        ),
        h('section', { class: 'panel' }, h('h2', null, '敵の構成'), roundInfo(roundSpec(b.round, b.group), b.sim.timeLimit, b.group)),
        h('section', { class: 'panel' }, h('h2', null, '発動した盟約'), alliancePanel(b.alliances.filter((a) => a.level > 0), state.stacks)),
        eventLog(state),
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
      h('p', null, `到達ラウンド ${state.round}　全滅 ${kills}/${state.history.length}　残り耐久値 ${state.life}`),
      h(
        'ol',
        { class: 'history' },
        state.history.map((x) =>
          h('li', { class: x.killed ? 'ok' : 'ng' }, `R${x.round} ${groupLabel(roundGroupOf(state, x.round))}${roundEnemySummary(roundSpec(x.round)).some((e) => e.enemy.boss) ? '・ボス' : ''}：${x.killed ? '全滅' : x.lifeLost ? `耐久値-${x.lifeLost}` : '損害なし'}`),
        ),
      ),
      h('p', { class: 'muted small' }, `シード ${state.seed}`),
      h('button', { class: 'btn primary big', onclick: () => p.newGame() }, 'もう一度遊ぶ'),
    ),
  );
}
