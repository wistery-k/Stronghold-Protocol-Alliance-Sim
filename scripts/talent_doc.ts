// 素質の再現状況の一覧（docs/talents.md）を作る
//   npx tsx scripts/talent_doc.ts
import { writeFileSync } from 'node:fs';
import { UNITS } from '../src/core/data/units';
import { talentStatus } from '../src/core/talents';

const MARK = { full: '✅ 再現', partial: '🟡 一部', none: '❌ 未再現' } as const;
const lines: string[] = [];
const count = { full: 0, partial: 0, none: 0 };
for (const tier of [1, 2, 3, 4, 5, 6]) {
  lines.push(`\n## 等級${tier}\n`, '| オペレーター | 素質 | 状況 | 説明（精鋭） | 備考 |', '|---|---|---|---|---|');
  for (const u of UNITS.filter((x) => x.tier === tier)) {
    const list = talentStatus(u, 2);
    if (!list.length) lines.push(`| ${u.name} | - | - | - | |`);
    for (const t of list) {
      count[t.impl]++;
      lines.push(`| ${u.name} | ${t.name} | ${MARK[t.impl]} | ${t.description.replace(/\n/g, ' ').replace(/\|/g, '／')} | ${t.note ?? ''} |`);
    }
  }
}
const head = [
  '# 素質の再現状況',
  '',
  '`scripts/talent_doc.ts` で `src/core/talents.ts` の `TALENT_STATUS` から生成しています。確率の効果は期待値（確率を累積し、1に達するたびに発生）で扱います。',
  '',
  `再現 ${count.full}・一部 ${count.partial}・未再現 ${count.none}（全${count.full + count.partial + count.none}）`,
];
writeFileSync(new URL('../docs/talents.md', import.meta.url), [...head, ...lines, ''].join('\n'));
console.log(count);
