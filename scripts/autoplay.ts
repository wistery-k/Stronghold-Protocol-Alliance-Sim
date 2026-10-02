// 簡易ボットで多数回プレイして、ラウンドごとの撃破率を出すバランス確認用スクリプト。
// 使い方: npm run balance -- [試行回数]

import { isMelee } from '../src/core/board';
import { getUnit, unitState } from '../src/core/data/units';
import { benchUnits } from '../src/core/garrison';
import {
  applyAction,
  createGame,
  deployCapOf,
  levelUpCost,
  priceOf,
  type Action,
  type GameState,
} from '../src/core/game';
import { MAX_ROUND } from '../src/core/rules';
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

  // 精鋭化の報酬は一番強そうなものを選ぶ
  while (s.choices.length) {
    const options = s.choices[0].options;
    const best = options.map((id, i) => ({ i, p: power({ uid: 0, defId: id, star: 1 }) })).sort((a, b) => b.p - a.p)[0];
    const r = applyAction(s, { type: 'choose', index: best.i });
    s = r.error ? act(s, { type: 'skipChoice' }) : r.state;
  }

  // 編成：ブロック役（近距離）は最大3人、医療1人、残りは遠距離から強い順
  const all = [...s.board, ...benchUnits(s)].sort((a, b) => power(b) - power(a));
  const melee = all.filter((o) => isMelee(o.defId)).slice(0, 3);
  // 敵が攻撃してくるので、医療がいれば1人入れる
  const healer = all.filter((o) => getUnit(o.defId).damageType === 'heal').slice(0, 1);
  const ranged = all.filter((o) => !isMelee(o.defId) && getUnit(o.defId).damageType !== 'heal');
  const picked = [...melee, ...healer, ...ranged].slice(0, deployCapOf(s));
  const want = new Set(picked.map((o) => o.uid));
  for (const o of [...s.board]) if (!want.has(o.uid)) s = act(s, { type: 'undeploy', uid: o.uid });
  // ブロック役から先に置く（自動配置で経路上の良い位置に入る）
  for (const o of picked) if (!s.board.some((b) => b.uid === o.uid)) s = act(s, { type: 'deploy', uid: o.uid });

  const bench = benchUnits(s).sort((a, b) => power(a) - power(b));
  if (bench.length >= 8) for (const o of bench.slice(0, 3)) s = act(s, { type: 'sell', uid: o.uid });
  return s;
}

const trials = Number(process.argv[2] ?? 100);
const reach = Array(MAX_ROUND + 1).fill(0);
const clearsBy = Array(MAX_ROUND + 1).fill(0);
const lossBy: number[][] = Array.from({ length: MAX_ROUND + 1 }, () => []);
const leakBy: number[][] = Array.from({ length: MAX_ROUND + 1 }, () => []);
const lifeAfter: number[][] = Array.from({ length: MAX_ROUND + 1 }, () => []);
let clears = 0;
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

for (let t = 0; t < trials; t++) {
  let s = createGame(1000 + t);
  while (s.phase !== 'gameover' && s.phase !== 'clear') {
    if (s.phase === 'prep') {
      s = playPrep(s);
      s = act(s, { type: 'battle' });
      const b = s.lastBattle!;
      reach[b.round]++;
      if (b.sim.cleared) clearsBy[b.round]++;
      lossBy[b.round].push(b.lifeLost);
      leakBy[b.round].push(b.sim.leaked);
      lifeAfter[b.round].push(s.life);
    }
    s = act(s, { type: 'next' });
  }
  if (s.phase === 'clear') clears++;
}

console.log(`試行 ${trials} 回 / クリア率 ${((clears / trials) * 100).toFixed(1)}%`);
console.log('R   到達  全滅率  突破数(中央値)  耐久減少(中央値)  残り耐久(中央値)');
for (let r = 1; r <= MAX_ROUND; r++) {
  const rate = reach[r] ? (clearsBy[r] / reach[r]) * 100 : 0;
  console.log(
    `${String(r).padStart(2)}  ${String(reach[r]).padStart(4)}  ${rate.toFixed(0).padStart(5)}%  ${String(median(leakBy[r])).padStart(8)}  ${String(median(lossBy[r])).padStart(8)}  ${String(median(lifeAfter[r])).padStart(8)}`,
  );
}
