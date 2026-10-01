// 簡易ボットで多数回プレイして、ラウンドごとの撃破率を出すバランス確認用スクリプト。
// 使い方: npm run balance -- [試行回数]

import { activeAllianceIds } from '../src/core/alliance';
import { enemyForRound } from '../src/core/data/enemies';
import { getUnit, unitState } from '../src/core/data/units';
import { benchUnits } from '../src/core/garrison';
import {
  applyAction,
  buildSimInputs,
  createGame,
  levelUpCost,
  previewBattleStacks,
  priceOf,
  type Action,
  type GameState,
} from '../src/core/game';
import { deployCap, MAX_ROUND } from '../src/core/rules';
import { simulateDps } from '../src/core/sim';
import type { OwnedUnit } from '../src/core/types';

/** ざっくりした強さの目安（毎秒の攻撃力） */
const power = (o: OwnedUnit) => {
  const def = getUnit(o.defId);
  if (def.damageType === 'heal') return 0;
  const st = unitState(def, o.star).stats;
  return st.atk / st.interval;
};

const act = (s: GameState, a: Action): GameState => applyAction(s, a).state;

function playPrep(s: GameState): GameState {
  // 管理レベル：ラウンドに応じた目標まで上げる
  const targetLevel = Math.min(6, 1 + Math.floor(s.round / 2.5));
  for (;;) {
    const cost = levelUpCost(s);
    if (cost === null || s.level >= targetLevel || s.gold < cost) break;
    s = act(s, { type: 'levelUp' });
  }

  for (let iter = 0; iter < 30; iter++) {
    const owned = [...s.board, ...benchUnits(s)];
    const cands = s.shop
      .map((id, slot) => ({ id, slot }))
      .filter((x): x is { id: string; slot: number } => !!x.id && priceOf(s, x.id) <= s.gold)
      .sort((a, b) => {
        const da = owned.some((o) => o.defId === a.id) ? 10 : 0;
        const db = owned.some((o) => o.defId === b.id) ? 10 : 0;
        return db + getUnit(b.id).tier - (da + getUnit(a.id).tier);
      });
    let bought = false;
    for (const c of cands) {
      const r = applyAction(s, { type: 'buy', slot: c.slot });
      if (!r.error) {
        s = r.state;
        bought = true;
        break;
      }
    }
    if (bought) continue;
    if (s.gold >= 6 || s.freeRefreshes > 0 || s.nextRefreshFree) {
      s = act(s, { type: 'refresh' });
      continue;
    }
    break;
  }

  const all = [...s.board, ...benchUnits(s)].sort((a, b) => power(b) - power(a));
  const want = new Set(all.slice(0, deployCap(s.level)).map((o) => o.uid));
  for (const o of [...s.board]) if (!want.has(o.uid)) s = act(s, { type: 'undeploy', uid: o.uid });
  for (const uid of want) s = act(s, { type: 'deploy', uid });

  const bench = benchUnits(s).sort((a, b) => power(a) - power(b));
  if (bench.length >= 8) for (const o of bench.slice(0, 3)) s = act(s, { type: 'sell', uid: o.uid });
  return s;
}

const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

const trials = Number(process.argv[2] ?? 200);
const killsByRound = Array(MAX_ROUND + 1).fill(0);
const reachByRound = Array(MAX_ROUND + 1).fill(0);
const ratioByRound: number[][] = Array.from({ length: MAX_ROUND + 1 }, () => []);
const dpsByRound: number[][] = Array.from({ length: MAX_ROUND + 1 }, () => []);
let clears = 0;

for (let t = 0; t < trials; t++) {
  let s = createGame(1000 + t);
  while (s.phase !== 'gameover' && s.phase !== 'clear') {
    if (s.phase === 'prep') {
      s = playPrep(s);
      // HP無限の木人（同じ防御・術耐性）に対する潜在DPS
      const stacks = previewBattleStacks(s);
      const setup = buildSimInputs(s.board, benchUnits(s), stacks);
      s = act(s, { type: 'battle' });
      const b = s.lastBattle!;
      reachByRound[b.round]++;
      if (b.sim.killed) killsByRound[b.round]++;
      ratioByRound[b.round].push(b.sim.totalDamage / b.sim.enemy.hp);
      const dummy = { ...b.sim.enemy, hp: 1e12, phases: [] };
      const sim = simulateDps(setup.inputs, dummy, { globals: setup.globals, activeAlliances: activeAllianceIds(setup.statuses), stacks });
      dpsByRound[b.round].push(sim.totalDamage / dummy.duration);
    }
    s = act(s, { type: 'next' });
  }
  if (s.phase === 'clear') clears++;
}

console.log(`試行 ${trials} 回 / クリア率 ${((clears / trials) * 100).toFixed(1)}%`);
console.log('R   到達  撃破率  与ダメ/HP(中央値)  潜在DPS(中央値)  必要DPS');
for (let r = 1; r <= MAX_ROUND; r++) {
  const rate = reachByRound[r] ? (killsByRound[r] / reachByRound[r]) * 100 : 0;
  const e = enemyForRound(r);
  console.log(
    `${String(r).padStart(2)}  ${String(reachByRound[r]).padStart(4)}  ${rate.toFixed(0).padStart(5)}%  ${median(ratioByRound[r]).toFixed(2)}  ${median(dpsByRound[r]).toFixed(0).padStart(8)}  ${(e.hp / e.duration).toFixed(0).padStart(8)}`,
  );
}
