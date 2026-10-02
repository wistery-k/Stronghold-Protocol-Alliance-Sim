#!/usr/bin/env python3
"""
オートバトル用のデータを本家データから抽出し、src/core/data/battledata.json を生成する。

- ラウンドごとの敵の出現（険境シミュレーションのステージ）
- 敵の能力値（HP・防御力・術耐性・移動速度・飛行・耐久値の減少量）
- オペレーターの攻撃範囲（通常時・スキル中）

使い方:
  python3 scripts/extract_battle.py <ArknightsGameData のパス> <ArknightsGameData_YoStar のパス>
  （<repo>/zh_CN/gamedata/{excel,levels/enemydata,levels/activities/act1autochess,levels/activities/act2autochess} が必要）
"""

import json
import sys
from pathlib import Path

ACT_ID = 'act2autochess'
MODE = 'mode_single_normal'  # 険境シミュレーション
ROUNDS = 15

# 日本版データにまだ無い敵の日本語名
ENEMY_NAME_OVERRIDES = {
    'enemy_9013_acstmk': '仮想敵：冑',
    'enemy_9013_acstmk_2': '仮想敵：冑',
    'enemy_9014_acstma': '「冑を斬る剣」',
    'enemy_9015_acstmb': '「冑を砕く鎚」',
}

PHASE = {'PHASE_0': 0, 'PHASE_1': 1, 'PHASE_2': 2}


def load(p: Path):
    return json.loads(p.read_text(encoding='utf-8'))


def enemy_value(attrs: dict, key: str, default=None):
    a = attrs.get(key)
    if a and a.get('m_defined'):
        return a['m_value']
    return default


def merge_enemy(base: dict, over: dict | None) -> dict:
    """敵データの上書き（overwrittenData の m_defined な値だけ反映）"""
    if not over:
        return base
    out = json.loads(json.dumps(base))
    for k, v in over.items():
        if k == 'attributes':
            for ak, av in v.items():
                if isinstance(av, dict) and av.get('m_defined'):
                    out['attributes'][ak] = av
        elif isinstance(v, dict) and v.get('m_defined'):
            out[k] = v
    return out


def main():
    cn_root = Path(sys.argv[1]) / 'zh_CN/gamedata'
    ja_root = Path(sys.argv[2]) / 'ja_JP/gamedata'
    act = load(cn_root / 'excel/activity_table.json')['activity']['AUTOCHESS_SEASON'][ACT_ID]
    chars = load(cn_root / 'excel/character_table.json')
    skills = load(cn_root / 'excel/skill_table.json')
    range_table = load(cn_root / 'excel/range_table.json')
    enemy_db = {e['Key']: e['Value'] for e in load(cn_root / 'levels/enemydata/enemy_database.json')['enemies']}
    ja_handbook = load(ja_root / 'excel/enemy_handbook_table.json')
    ja_handbook = ja_handbook.get('enemyData', ja_handbook)

    # ---------------- 攻撃範囲 ----------------
    used_ranges = set()
    unit_ranges = {}
    for chess_id, shop in act['charShopChessDatas'].items():
        if shop['isHidden'] or shop['chessType'] == 'DIY':
            continue
        ch = chars[shop['charId']]
        skill_id = ch['skills'][shop['defaultSkillIndex']]['skillId']
        entry = {}
        for key, cid in (('normal', chess_id), ('golden', shop['goldenChessId'])):
            st = act['charChessDataDict'][cid]['status']
            base = ch['phases'][PHASE[st['evolvePhase']]]['rangeId']
            lv = skills[skill_id]['levels'][st['skillLevel'] - 1]
            skill_range = lv.get('rangeId') or None
            entry[key] = {'range': base, 'skillRange': skill_range}
            used_ranges.add(base)
            if skill_range:
                used_ranges.add(skill_range)
        unit_ranges[chess_id.replace('chess_char_', '').removesuffix('_a')] = entry
    ranges = {}
    for rid in sorted(used_ranges):
        r = range_table.get(rid)
        if not r:
            print(f'warning: unknown range {rid}', file=sys.stderr)
            continue
        ranges[rid] = [[g['col'], g['row']] for g in r['grids']]

    # ---------------- ラウンドと敵 ----------------
    enemies = {}
    rounds = []
    battle = act['battleDataDict'][MODE]
    for r in range(1, ROUNDS + 1):
        entry = battle[str(r)][0]  # ボス戦は先頭のボス（14: 仮想敵：冑, 15: 仮想敵：冑ほか）
        level_path = entry['levelId'].lower().replace('activities/', '')
        lp = cn_root / 'levels/activities' / (level_path + '.json')
        level = load(lp)
        refs = {x['id']: x for x in level['enemyDbRefs']}
        spawns = []
        for wave in level['waves']:
            t0 = wave['preDelay']
            for frag in wave['fragments']:
                t1 = t0 + frag['preDelay']
                for a in frag['actions']:
                    if a['actionType'] != 'SPAWN':
                        continue
                    key = a['key']
                    ref = refs.get(key, {})
                    lvl = ref.get('level', 0)
                    if key not in enemies:
                        variants = enemy_db.get(key)
                        if not variants:
                            print(f'warning: unknown enemy {key}', file=sys.stderr)
                            continue
                        base = [v for v in variants if v['level'] == lvl][0]['enemyData']
                        ed = merge_enemy(base, ref.get('overwrittenData'))
                        at = ed['attributes']
                        ja = ja_handbook.get(key.removesuffix('_2'), {}) or ja_handbook.get(key, {})
                        name = ENEMY_NAME_OVERRIDES.get(key) or ja.get('name')
                        if not name:
                            print(f'warning: no Japanese name for {key} ({ed["name"]["m_value"]})', file=sys.stderr)
                            name = ed['name']['m_value']
                        enemies[key] = {
                            'name': name,
                            'hp': enemy_value(at, 'maxHp', 0),
                            'def': enemy_value(at, 'def', 0),
                            'res': enemy_value(at, 'magicResistance', 0),
                            'speed': enemy_value(at, 'moveSpeed', 1.0),
                            'blockCnt': enemy_value(at, 'blockCnt', 1) or 1,
                            'flying': (ed['motion']['m_value'] if ed['motion']['m_defined'] else 'WALK') == 'FLY',
                            'boss': (ed['levelType']['m_value'] if ed['levelType']['m_defined'] else 'NORMAL') == 'BOSS',
                            'elite': (ed['levelType']['m_value'] if ed['levelType']['m_defined'] else 'NORMAL') == 'ELITE',
                            'lifeReduce': ed['lifePointReduce']['m_value'] if ed['lifePointReduce']['m_defined'] else 1,
                        }
                    spawns.append({
                        'enemy': key,
                        'count': a['count'],
                        'interval': a['interval'],
                        'delay': round(t1 + a['preDelay'], 2),
                        'route': a['routeIndex'],
                    })
        rounds.append({
            'round': r,
            'levelId': entry['levelId'].split('/')[-1],
            'timeLimit': level['options']['maxPlayTime'],
            'moveMultiplier': level['options']['moveMultiplier'],
            'spawns': spawns,
        })

    out = {'ranges': ranges, 'unitRanges': unit_ranges, 'enemies': enemies, 'rounds': rounds}
    dest = Path(__file__).resolve().parent.parent / 'src/core/data/battledata.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'wrote {dest} ({len(ranges)} ranges, {len(enemies)} enemies, {len(rounds)} rounds)')


if __name__ == '__main__':
    main()
