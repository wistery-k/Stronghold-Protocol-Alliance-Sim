import { describe, expect, it } from 'vitest';
import { difficultyAtkFactor, difficultyBossHp, difficultyHpFactor } from '../src/core/difficulty';
import { ENEMIES, roundSpec } from '../src/core/data/battle';
import { roundEnemies, scaledEnemy } from '../src/core/sim';

describe('難易度', () => {
  it('ラウンドごとの最大HP・攻撃力の補正が表どおり', () => {
    expect(difficultyHpFactor('standard', 9)).toBeCloseTo(0.7);
    expect(difficultyHpFactor('adversity', 4)).toBeCloseTo(1.2 * 0.7);
    expect(difficultyHpFactor('adversity', 14)).toBeCloseTo(1.2 ** 5 * 0.7);
    expect(difficultyHpFactor('deadly', 5)).toBeCloseTo(1.2 * 0.8);
    expect(difficultyHpFactor('deadly', 13)).toBeCloseTo(1.2 ** 4 * 0.8);
    expect(difficultyHpFactor('ultimate', 1)).toBeCloseTo(1.2);
    expect(difficultyHpFactor('ultimate', 15)).toBeCloseTo(1.2 ** 7);
    expect(difficultyAtkFactor('adversity', 8)).toBeCloseTo(1.1 ** 2 * 0.7);
    expect(difficultyAtkFactor('deadly', 3)).toBeCloseTo(0.8);
    expect(difficultyAtkFactor('ultimate', 6)).toBeCloseTo(1.1 ** 3);
  });
  it('ボスのHPは難易度ごとの値で、攻撃力だけ補正を受ける', () => {
    expect(difficultyBossHp('ultimate', 15)).toBe(7200000);
    expect(difficultyBossHp('standard', 14)).toBe(247500);
    const boss = ENEMIES.enemy_9013_acstmk;
    const s = scaledEnemy(boss, 14, 'ultimate');
    expect(s.hp).toBe(3600000);
    expect(s.attack!.atk).toBeCloseTo(boss.attack!.atk * 1.1 ** 7);
  });
  it('通常の敵は最大HP・攻撃力に補正が掛かり、難易度なしなら掛からない', () => {
    const spec = roundSpec(10, null, 'ultimate');
    const e = roundEnemies(spec).find((x) => !x.spec.boss && x.spec.attack)!;
    const base = ENEMIES[e.key];
    expect(e.spec.hp).toBe(Math.round(base.hp * 1.2 ** 4));
    expect(e.spec.attack!.atk).toBeCloseTo(base.attack!.atk * 1.1 ** 4);
    const plain = roundEnemies(roundSpec(10)).find((x) => x.key === e.key)!;
    expect(plain.spec.hp).toBe(base.hp);
  });
});
