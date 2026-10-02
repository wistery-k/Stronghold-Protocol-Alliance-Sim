import type { GameState } from './game';

// ログ。state.log はすべての記録（デバッグ用）、state.events はプレイヤーに見せる記録。
// プレイヤーに見せるのは、操作の直接の結果ではないもの（特性の発動、資金の増減、精鋭化など）だけ。

const MAX_LOG = 300;

/** プレイヤーに見せる出来事として記録する */
export function notify(state: GameState, text: string): void {
  state.log.push(text);
  state.events ??= [];
  state.events.push({ round: state.round, text });
  if (state.events.length > MAX_LOG) state.events.splice(0, state.events.length - MAX_LOG);
}

/** 記録が増えすぎないように古いものを捨てる */
export function trimLog(state: GameState): void {
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}
