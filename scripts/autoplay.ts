// 簡易ボットで多数回プレイして、ラウンドごとの撃破率を出すバランス確認用スクリプト。
// 使い方: npm run balance -- [試行回数]

import { applyAction, createGame, levelUpCost, sellPrice, type Action, type GameState } from '../src/core/game';
import { getUnit } from '../src/core/data/units';
import { deployCap, MAX_ROUND, STAR_ATK_MULT } from '../src/core/rules';
import { buildSimInputs } from '../src/core/game';
import { simulateDps } from '../src/core/sim';
import { enemyForRound } from '../src/core/data/enemies';
import type { OwnedUnit } from '../src/core/types';

const power = (o: OwnedUnit) => getUnit(o.defId).atk * STAR_ATK_MULT[o.star - 1];

function act(s: GameState, a: Action): GameState {
  return applyAction(s, a).state;
}

function playPrep(s: GameState): GameState {
  // レベル上げ：ラウンドに応じた目標レベルまで
  const targetLevel = Math.min(7, 1 + Math.floor((s.round + 1) / 2));
  for (;;) {
    const cost = levelUpCost(s.level);
    if (cost === null || s.level >= targetLevel || s.gold < cost) break;
    s = act(s, { type: 'levelUp' });
  }

  for (let iter = 0; iter < 30; iter++) {
    const owned = [...s.board, ...s.bench.filter((b): b is OwnedUnit => !!b)];
    // 購入候補：所持中と重複するもの優先 → 等級が高いもの
    const cands = s.shop
      .map((id, slot) => ({ id, slot }))
      .filter((x): x is { id: string; slot: number } => !!x.id && getUnit(x.id).tier <= s.gold)
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
    // 利子のため10以上は残しつつ、余剰でリフレッシュ
    if (s.gold >= 12) {
      s = act(s, { type: 'refresh' });
      continue;
    }
    break;
  }

  // 配置：強い順に上限まで
  const all = [...s.board, ...s.bench.filter((b): b is OwnedUnit => !!b)].sort((a, b) => power(b) - power(a));
  const want = new Set(all.slice(0, deployCap(s.level)).map((o) => o.uid));
  for (const o of [...s.board]) if (!want.has(o.uid)) s = act(s, { type: 'undeploy', uid: o.uid });
  for (const uid of want) s = act(s, { type: 'deploy', uid });

  // 控えが満杯なら弱いものを売る
  const bench = s.bench.filter((b): b is OwnedUnit => !!b).sort((a, b) => sellPrice(a) - sellPrice(b));
  if (bench.length >= 7) for (const o of bench.slice(0, 2)) s = act(s, { type: 'sell', uid: o.uid });
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
      // 標的と同じ防御・術耐性で、HP無限の木人に対する潜在DPSを測る
      const { inputs } = buildSimInputs(s.board, s.stacks);
      s = act(s, { type: 'battle' });
      const b = s.lastBattle!;
      reachByRound[b.round]++;
      if (b.sim.killed) killsByRound[b.round]++;
      ratioByRound[b.round].push(b.sim.totalDamage / b.sim.enemy.hp);
      const dummy = { ...b.sim.enemy, hp: 1e12, phases: [] };
      dpsByRound[b.round].push(simulateDps(inputs, dummy).totalDamage / dummy.duration);
    }
    s = act(s, { type: 'next' });
  }
  if (s.phase === 'clear') clears++;
}

console.log(`試行 ${trials} 回 / クリア率 ${((clears / trials) * 100).toFixed(1)}%`);
console.log('R   到達  撃破率  与ダメ/HP(中央値)  潜在DPS(中央値)  必要DPS');
for (let r = 1; r <= MAX_ROUND; r++) {
  const arr = ratioByRound[r].sort((a, b) => a - b);
  const med = arr.length ? arr[Math.floor(arr.length / 2)] : 0;
  const rate = reachByRound[r] ? (killsByRound[r] / reachByRound[r]) * 100 : 0;
  console.log(
    `${String(r).padStart(2)}  ${String(reachByRound[r]).padStart(4)}  ${rate.toFixed(0).padStart(5)}%  ${med.toFixed(2)}  ${median(dpsByRound[r]).toFixed(0).padStart(8)}  ${(enemyForRound(r).hp / enemyForRound(r).duration).toFixed(0).padStart(8)}`,
  );
}
