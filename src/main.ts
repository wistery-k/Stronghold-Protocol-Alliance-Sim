import { DEFAULT_DIFFICULTY, type Difficulty } from './core/difficulty';
import { applyAction, createGame, rollBans, type Action, type GameState } from './core/game';
import { Rng } from './core/rng';
import type { AllianceId } from './core/types';
import { getMap, setActiveMap } from './core/board';
import { h } from './ui/dom';
import { gameView } from './ui/gameView';
import { bandView } from './ui/bandView';
import type { BandId } from './core/data/bands';
import { createSandbox, sandboxView, type SandboxState } from './ui/sandboxView';

const SAVE_KEY = 'sp-sim:game:v9';

type Mode = 'game' | 'sandbox';

const saved = loadGame();
const app = {
  mode: 'game' as Mode,
  game: saved ?? createGame(),
  /** 戦術の選択中（保存されたゲームが無い時と「新しいゲーム」の時） */
  choosingBand: !saved,
  /** 戦術選択中のゲームのシード（BANはシードで決まるので、選択画面で先に見せる） */
  pendingSeed: Math.floor(Math.random() * 2 ** 31),
  /** 戦術選択画面で再抽選した盟約BAN（null ならシードで決まるBAN） */
  pendingBanned: null as AllianceId[] | null,
  /** 戦術選択画面で選んだ難易度 */
  pendingDifficulty: DEFAULT_DIFFICULTY as Difficulty,
  /** 遊べるゲームがある（戦術選択をキャンセルできる） */
  hasGame: !!saved,
  sandbox: createSandbox(),
  selectedUid: null as number | null,
  toast: null as string | null,
};

let toastTimer: number | undefined;

function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as GameState;
    return s.version === 9 ? s : null;
  } catch {
    return null;
  }
}

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(app.game, (k, v) => (k === 'frames' || k === 'fx' ? undefined : v)));
  } catch {
    // 保存できなくても遊べるようにする
  }
}

function showToast(msg: string) {
  app.toast = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    app.toast = null;
    render();
  }, 2200);
}

function dispatch(a: Action) {
  const r = applyAction(app.game, a);
  if (r.error) showToast(r.error);
  app.game = r.state;
  saveGame();
  render();
}

function newGame() {
  app.pendingSeed = Math.floor(Math.random() * 2 ** 31);
  app.pendingBanned = null;
  app.choosingBand = true;
  render();
}

function startGame(band: BandId) {
  app.game = createGame(app.pendingSeed, { band, banned: app.pendingBanned ?? undefined, difficulty: app.pendingDifficulty });
  app.choosingBand = false;
  app.hasGame = true;
  app.selectedUid = null;
  saveGame();
  render();
}

function render() {
  const root = document.getElementById('app')!;
  // マップはゲームごと（サンドボックスは画面内で切り替える）
  if (app.mode === 'game') setActiveMap(app.choosingBand ? createGame(app.pendingSeed).mapId : app.game.mapId);
  const scrollY = window.scrollY;
  const view =
    app.mode === 'game' && app.choosingBand
      ? bandView(
          startGame,
          app.hasGame && app.game.phase !== 'gameover' && app.game.phase !== 'clear' ? () => { app.choosingBand = false; render(); } : null,
          app.pendingBanned ?? createGame(app.pendingSeed).banned,
          getMap(createGame(app.pendingSeed).mapId).name,
          () => {
            // 盟約BANだけを引き直す（マップ・敵・ショップのシードはそのまま）
            app.pendingBanned = rollBans(new Rng(Math.floor(Math.random() * 2 ** 31)));
            render();
          },
          app.pendingDifficulty,
          (d) => {
            app.pendingDifficulty = d;
            render();
          },
        )
      : app.mode === 'game'
      ? gameView({
          state: app.game,
          selectedUid: app.selectedUid,
          dispatch,
          select: (uid) => {
            app.selectedUid = uid;
            render();
          },
          newGame,
        })
      : sandboxView(app.sandbox, (f: (s: SandboxState) => void) => {
          f(app.sandbox);
          render();
        });

  const header = h(
    'header',
    { class: 'header' },
    h(
      'div',
      { class: 'title' },
      h('b', null, '堅守協定シミュレーター'),
      h(
        'span',
        { class: 'build-info' },
        `最終更新 ${__BUILD_INFO__} · `,
        h('a', { href: 'https://github.com/wistery-k/Stronghold-Protocol-Alliance-Sim', target: '_blank', rel: 'noopener' }, 'GitHub'),
      ),
    ),
    h(
      'nav',
      { class: 'tabs' },
      h('button', { class: `tab ${app.mode === 'game' ? 'on' : ''}`, onclick: () => { app.mode = 'game'; render(); } }, 'プレイ'),
      h('button', { class: `tab ${app.mode === 'sandbox' ? 'on' : ''}`, onclick: () => { app.mode = 'sandbox'; render(); } }, 'サンドボックス'),
    ),
    app.mode === 'game' && !app.choosingBand
      ? h('button', { class: 'btn ghost', onclick: () => { if (confirm('現在のゲームを破棄して新しく始めますか？')) newGame(); } }, '新しいゲーム')
      : null,
  );
  const toast = app.toast ? h('div', { class: 'toast', role: 'status' }, app.toast) : null;
  root.replaceChildren(...[header, view, toast].filter((x): x is HTMLElement => x !== null));
  window.scrollTo(0, scrollY);
}

render();
