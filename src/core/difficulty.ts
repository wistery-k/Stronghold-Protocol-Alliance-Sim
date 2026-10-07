/**
 * 難易度（単独演算）。ラウンドごとの最大HP・攻撃力の補正と、ボスの最大HP。
 * ボスはラウンドによるHP補正を受けず（HPは下の表の値）、攻撃力補正だけ受ける。
 */
export type Difficulty = 'standard' | 'adversity' | 'deadly' | 'ultimate';

export const DIFFICULTIES: Difficulty[] = ['standard', 'adversity', 'deadly', 'ultimate'];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { standard: '標準', adversity: '逆境', deadly: '死地', ultimate: '究極' };
/** 新しいゲームの既定。ゲーム内の難易度が未指定の古い戦闘は補正なし */
export const DEFAULT_DIFFICULTY: Difficulty = 'deadly';

/** 補正 = mult × base^(ラウンドごとの指数)。HP は base 1.2、攻撃力は base 1.1 */
const MULT: Record<Difficulty, number> = { standard: 0.7, adversity: 0.7, deadly: 0.8, ultimate: 1 };
//                                           R1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
const EXP: Record<Difficulty, number[]> = {
  standard: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 10R以降は表に無いので9R と同じ
  adversity: [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 4, 5, 5, 5],
  deadly: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4],
  ultimate: [1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 5, 5, 6, 7, 7],
};

/** ボスの最大HP（ラウンド14・15）。標準の15Rは表に無い */
const BOSS_HP: Record<Difficulty, Record<number, number>> = {
  standard: { 14: 247500 },
  adversity: { 14: 675000, 15: 937500 },
  deadly: { 14: 1800000, 15: 3600000 },
  ultimate: { 14: 3600000, 15: 7200000 },
};

const factor = (d: Difficulty, round: number, base: number) => MULT[d] * base ** EXP[d][Math.min(Math.max(round, 1), 15) - 1];

export const difficultyHpFactor = (d: Difficulty, round: number) => factor(d, round, 1.2);
export const difficultyAtkFactor = (d: Difficulty, round: number) => factor(d, round, 1.1);
/** 独自の補正：表は同盟演算（4人で削る想定）の水準なので、単独演算ではボスのHPを半分にする */
export const BOSS_HP_SCALE = 0.5;
/** ボスの最大HP（表に無ければ undefined = データのまま） */
export const difficultyBossHp = (d: Difficulty, round: number): number | undefined => {
  const hp = BOSS_HP[d][round];
  return hp === undefined ? undefined : Math.round(hp * BOSS_HP_SCALE);
};
