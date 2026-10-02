#!/usr/bin/env python3
"""
オートバトル用のデータを本家データから抽出し、src/core/data/battledata.json を生成する。

- ラウンドごとの敵の出現（険境シミュレーションのステージ。敵は役割ごとの「枠」）
- 敵グループ（主力部隊＋特殊敵6種。ゲーム開始時に3種を抽選し、ラウンドごとに1グループが枠に入る）
- 敵の能力値（HP・防御力・術耐性・移動速度・飛行・耐久値の減少量・隠匿などの特殊能力）
- オペレーターの攻撃範囲（通常時・スキル中）

使い方:
  python3 scripts/extract_battle.py <ArknightsGameData のパス> <ArknightsGameData_YoStar のパス>
  （<repo>/zh_CN/gamedata/{excel,levels/enemydata,levels/activities/act1autochess,levels/activities/act2autochess} が必要）
"""

import json
import re
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

# ステージファイルの敵は「枠」で、ラウンドごとに選ばれた敵グループの敵に置き換わる
SLOT_ROLES = {
    'enemy_1007_slime': 'normal',
    'enemy_1422_lrsldr': 'normal',
    'enemy_1005_yokai': 'normal',
    'enemy_1427_lrnazg': 'elite',
    'enemy_1042_frostd': 'elite',
    'enemy_1425_lrcmra': 'strong',
    'enemy_1040_bombd': 'strong',
}

GROUP_NAMES = {
    'SPECIAL': '主力部隊',
    'FLY': '飛行',
    'TIMES': '頻度',
    'ELEMENT': '元素',
    'DOT': '持続',
    'INVISIBLE': '潜行',
    'REFLECTION': '屈折',
}

# 元素損傷の種類（図鑑の説明のタグ → シミュレーターの名前）
ELEMENT_TAGS = {
    'ba.dt.burning': 'burning',
    'ba.dt.neural': 'neural',
    'ba.dt.erosion': 'erosion',
    'ba.dt.apoptosis': 'apoptosis',
}

# isInFirstHalf の敵が出るラウンド（険境の act1autochess_01〜07）
FIRST_HALF_ROUNDS = 7

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

    # ---------------- 敵 ----------------
    cn_handbook = load(cn_root / 'excel/enemy_handbook_table.json')
    cn_handbook = cn_handbook.get('enemyData', cn_handbook)
    ac_refs = {r['id']: r for r in load(cn_root / 'levels/activities/act1autochess/level_autochess_enemy_data.json')['enemyDbRefs']}
    enemies = {}

    def add_enemy(key, ref=None):
        """敵の能力値と、シミュレーターで扱う特殊能力を登録する"""
        if key in enemies:
            return True
        variants = enemy_db.get(key)
        if not variants:
            print(f'warning: unknown enemy {key}', file=sys.stderr)
            return False
        ref = ref or ac_refs.get(key) or {}
        lvl = ref.get('level', 0)
        base = ([v for v in variants if v['level'] == lvl] or variants)[0]['enemyData']
        ed = merge_enemy(base, ref.get('overwrittenData'))
        at = ed['attributes']
        bb = {b['key'].lower(): b for b in (ed.get('talentBlackboard') or [])}
        abilities = [a.get('text') or '' for a in ((cn_handbook.get(key) or cn_handbook.get(re.sub(r'_\d$', '', key)) or {}).get('abilityList') or [])]
        ja = ja_handbook.get(key) or {}
        name = ENEMY_NAME_OVERRIDES.get(key) or ja.get('name')
        if not name:
            jb = ja_handbook.get(re.sub(r'_\d$', '', key)) or {}
            name = jb.get('name') or (cn_handbook.get(key) or {}).get('name') or ed['name']['m_value']
        name = name.replace('假想敌', '仮想敵')
        level_type = ed['levelType']['m_value'] if ed['levelType']['m_defined'] else 'NORMAL'
        e = {
            'name': name,
            'hp': enemy_value(at, 'maxHp', 0),
            'def': enemy_value(at, 'def', 0),
            'res': enemy_value(at, 'magicResistance', 0),
            'speed': enemy_value(at, 'moveSpeed', 1.0),
            'blockCnt': enemy_value(at, 'blockCnt', 1) or 1,
            'flying': (ed['motion']['m_value'] if ed['motion']['m_defined'] else 'WALK') == 'FLY',
            'boss': level_type == 'BOSS',
            'elite': level_type == 'ELITE',
            'lifeReduce': ed['lifePointReduce']['m_value'] if ed['lifePointReduce']['m_defined'] else 1,
        }
        # 攻撃（近接はブロックしている相手、遠距離は範囲内の相手を攻撃）
        apply_way = ed['applyWay']['m_value'] if ed['applyWay']['m_defined'] else 'MELEE'
        atk = enemy_value(at, 'atk', 0) or 0
        if apply_way in ('MELEE', 'RANGED') and atk > 0:
            bat = enemy_value(at, 'baseAttackTime', 2.0) or 2.0
            aspd = enemy_value(at, 'attackSpeed', 100.0) or 100.0
            radius = ed['rangeRadius']['m_value'] if ed['rangeRadius']['m_defined'] else -1
            dtypes = ((cn_handbook.get(key) or cn_handbook.get(re.sub(r'_\d$', '', key)) or {}).get('damageType') or ['PHYSIC'])
            e['attack'] = {
                'kind': 'ranged' if apply_way == 'RANGED' else 'melee',
                'atk': atk,
                'interval': round(bat * 100 / aspd, 3),
                # 範囲が決まっていない遠距離（直線攻撃など）は2.5マスとみなす
                'range': (radius if radius > 0 else 2.5) if apply_way == 'RANGED' else 0,
                'arts': dtypes[0] == 'MAGIC',
            }
        # 元素損傷：攻撃時に攻撃力×比率の元素損傷を与える（種類は図鑑の説明から）
        etype = next((ELEMENT_TAGS[tag] for a in abilities for tag in ELEMENT_TAGS if tag in a), None)
        eratio = next((b['value'] for k, b in bb.items() if k.endswith('attack@ep_damage_ratio')), None)
        if etype and eratio and 'attack' in e:
            e['element'] = {'type': etype, 'ratio': eratio}
        # 隠匿（ブロックされるまで狙えない）
        if abilities and abilities[0].startswith('<$ba.invisible>'):
            e['stealth'] = True
        if any('无法被阻挡' in a for a in abilities):
            e['unblockable'] = True
        m = next((re.search(r'只能被阻挡数大于等于(\d+)', a) for a in abilities if '只能被阻挡数' in a), None)
        if m:
            e['blockCnt'] = int(m.group(1))
        # 決まった回数の攻撃で倒れる（HPが回数）
        if any(re.search(r'^需要\d+次伤害击倒', a) for a in abilities):
            e['hitsToKill'] = True
        # 屈折：術耐性が上がる
        for k in ('refracting.magic_resistance',):
            if k in bb:
                e['refract'] = bb[k]['value']
        # 1回分のダメージを防ぐ盾
        if 'shield.max_block_damage_cnt' in bb:
            e['hitShield'] = int(bb['shield.max_block_damage_cnt']['value'])
        # 攻撃を受けるたびに防御・術耐性が下がる
        if 'def_reduce.max_stack_cnt' in bb:
            n = bb['def_reduce.max_stack_cnt']['value']
            e['defReduce'] = {'max': int(n), 'def': bb['def_reduce.def']['value'] / n, 'res': bb.get('def_reduce.magic_resistance', {'value': 0})['value'] / n}
        # 倒れると別の敵を生む
        if 'deadspawn.enemy_key' in bb:
            child = bb['deadspawn.enemy_key']['valueStr']
            if add_enemy(child):
                e['deadSpawn'] = {'enemy': child, 'count': int(bb['deadspawn.cnt']['value'])}
        # 倒れると一定回数で倒せる状態になり、時間が経つと復活する
        if 'revive[trigger].interval' in bb:
            e['revive'] = {'hits': int(bb['revive[trigger].prop_max_hp']['value']), 'interval': bb['revive[trigger].interval']['value']}
        enemies[key] = e
        return True

    # ---------------- 敵グループ（主力部隊＋特殊敵6種から3種） ----------------
    groups = {}
    for key, v in act['specialEnemyInfoDict'].items():
        keys = [key, *v['attachedNormalEnemyKeys'], *v['attachedEliteEnemyKeys']]
        if not all(add_enemy(k) for k in keys):
            continue
        groups.setdefault(v['type'], {'name': GROUP_NAMES.get(v['type'], v['type']), 'entries': []})['entries'].append({
            'strong': key,
            'normal': v['attachedNormalEnemyKeys'],
            'elite': v['attachedEliteEnemyKeys'],
            'weight': v['randomWeight'],
            'firstHalf': v['isInFirstHalf'],
        })

    # ---------------- ラウンド ----------------
    rounds = []
    battle = act['battleDataDict'][MODE]
    for r in range(1, ROUNDS + 1):
        entry = battle[str(r)][0]  # ボス戦は先頭のボス（14: 仮想敵：冑, 15: 仮想敵：冑ほか）
        level_path = entry['levelId'].lower().replace('activities/', '')
        level = load(cn_root / 'levels/activities' / (level_path + '.json'))
        refs = {x['id']: x for x in level['enemyDbRefs']}
        routes = level['routes']
        spawns = []
        for wave in level['waves']:
            t0 = wave['preDelay']
            for frag in wave['fragments']:
                t1 = t0 + frag['preDelay']
                for a in frag['actions']:
                    if a['actionType'] != 'SPAWN':
                        continue
                    key = a['key']
                    if not add_enemy(key, refs.get(key)):
                        continue
                    route = routes[a['routeIndex']]
                    # 本家の出現地点は2つ（防衛地点と同じ行＝下、もう一方＝上）
                    start_row = route['startPosition']['row']
                    goal_row = route['endPosition']['row']
                    spawns.append({
                        'enemy': key,
                        'role': SLOT_ROLES.get(key),
                        'count': a['count'],
                        'interval': a['interval'],
                        'delay': round(t1 + a['preDelay'], 2),
                        'spawn': 1 if start_row == goal_row else 0,
                    })
        rounds.append({
            'round': r,
            'levelId': entry['levelId'].split('/')[-1],
            'timeLimit': level['options']['maxPlayTime'],
            'moveMultiplier': level['options']['moveMultiplier'],
            'spawns': spawns,
        })

    out = {'ranges': ranges, 'unitRanges': unit_ranges, 'enemies': enemies, 'groups': groups, 'firstHalfRounds': FIRST_HALF_ROUNDS, 'rounds': rounds}
    dest = Path(__file__).resolve().parent.parent / 'src/core/data/battledata.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'wrote {dest} ({len(ranges)} ranges, {len(enemies)} enemies, {len(groups)} groups, {len(rounds)} rounds)')


if __name__ == '__main__':
    main()
