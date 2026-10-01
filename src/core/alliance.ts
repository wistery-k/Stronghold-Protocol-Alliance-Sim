import { ALLIANCES, ALLIANCE_IDS, mergeModifiers } from './data/alliances';
import { getUnit } from './data/units';
import type { AllianceId, Modifier, OwnedUnit } from './types';

export interface AllianceStatus {
  id: AllianceId;
  /** 配置中の異なる所属オペレーター数 */
  count: number;
  /** 発動段階（0 = 未発動） */
  level: number;
  /** 次の段階に必要な人数（最大段階なら null） */
  next: number | null;
  /** 所属している配置中ユニットの uid */
  memberUids: number[];
}

export function unitAlliances(defId: string): AllianceId[] {
  const d = getUnit(defId);
  return [d.core, ...d.extra];
}

/** 配置中ユニットから盟約の発動状況を求める。同じオペレーターは1体として数える */
export function evaluateAlliances(board: OwnedUnit[]): AllianceStatus[] {
  const result: AllianceStatus[] = [];
  for (const id of ALLIANCE_IDS) {
    const def = ALLIANCES[id];
    const members = board.filter((o) => unitAlliances(o.defId).includes(id));
    const count = new Set(members.map((m) => m.defId)).size;
    if (count === 0) continue;
    let level = 0;
    def.thresholds.forEach((t, i) => {
      if (count >= t) level = i + 1;
    });
    const next = def.thresholds.find((t) => t > count) ?? null;
    result.push({ id, count, level, next, memberUids: members.map((m) => m.uid) });
  }
  // 発動中 → 人数の多い順
  return result.sort((a, b) => b.level - a.level || b.count - a.count);
}

/** 各ユニットに乗る盟約補正を計算する */
export function unitModifiers(
  board: OwnedUnit[],
  statuses: AllianceStatus[],
  stacks: Partial<Record<AllianceId, number>>,
): Map<number, Modifier> {
  const out = new Map<number, Modifier>();
  for (const o of board) out.set(o.uid, {});
  for (const st of statuses) {
    if (st.level === 0) continue;
    const def = ALLIANCES[st.id];
    const mod = def.modifier(st.level, stacks[st.id] ?? 0);
    const targets = def.scope === 'all' ? board.map((o) => o.uid) : st.memberUids;
    for (const uid of targets) out.set(uid, mergeModifiers(out.get(uid) ?? {}, mod));
  }
  return out;
}
