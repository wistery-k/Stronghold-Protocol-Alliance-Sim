#!/usr/bin/env python3
"""
オートバトル用のデータを本家データから抽出し、src/core/data/battledata.json を生成する。

- ラウンドごとの敵の出現（険境シミュレーションのステージ。敵は役割ごとの「枠」）
- 敵グループ（主力部隊＋特殊敵6種。ゲーム開始時に3種を抽選し、ラウンドごとに1グループが枠に入る）
- 敵の能力値（HP・防御力・術耐性・移動速度・飛行・耐久値の減少量・ステルスなどの特殊能力）
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
    # 日本版に未実装の敵：大陸版の名前を日本語の字体に直した仮の名前
    # メインテーマ16章の敵（図鑑番号 JTJ10）
    'enemy_10124_uashld_2': 'ウルサス軍中堅盾兵',
    'enemy_10122_uacann_2': 'ウルサス軍重野砲',
    'enemy_9009_acfort': '仮想敵：黒雲',
    'enemy_9006_actoxi': '仮想敵：蝕裂',
    'enemy_9011_acrefr': '仮想敵：鏡膜',
}

# 懸賞は、序盤（3〜4ラウンド）向けの enemyeffect_10〜15_4〜6（I〜III）を使う

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

# 懸賞の分類 → 敵グループ（懸賞は、そのゲームで選ばれた敵グループの種類から提示する）
BOUNTY_GROUPS = {
    '飞行': 'FLY',
    '频次': 'TIMES',
    '损伤': 'ELEMENT',
    '持续': 'DOT',
    '隐匿': 'INVISIBLE',
    '折射': 'REFLECTION',
}

# 元素損傷の種類（図鑑の説明のタグ → シミュレーターの名前）
# 大型で動かないボス（小型で歩き回るボス：ルシアン・仮想敵：銃 は対象外）
LARGE_BOSSES = {'enemy_9013_acstmk', 'enemy_9021_acduml', 'enemy_1521_dslily', 'enemy_9032_aclionk', 'enemy_9033_acdeer'}
# シークレットコア版のボスの手下（キーはボスのキー）
BOSS_MINIONS = {'enemy_9014_acstma': 'enemy_9013_acstmk_2', 'enemy_9015_acstmb': 'enemy_9013_acstmk_2'}

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
        # 「持続攻撃」（applyWay ALL）：範囲内の味方全員に攻撃し続ける（冑を斬る剣・冑を砕く鎚。他の ALL の敵は攻撃の仕方が様々なので対象外）
        if apply_way == 'ALL' and atk > 0 and key in BOSS_MINIONS:
            bat = enemy_value(at, 'baseAttackTime', 2.0) or 2.0
            aspd = enemy_value(at, 'attackSpeed', 100.0) or 100.0
            radius = ed['rangeRadius']['m_value'] if ed['rangeRadius']['m_defined'] else 1.0
            dtypes = ((cn_handbook.get(key) or {}).get('damageType') or ['PHYSIC'])
            e['attack'] = {'kind': 'ranged', 'atk': atk, 'interval': round(bat * 100 / aspd, 3), 'range': radius, 'arts': dtypes[0] == 'MAGIC', 'aura': True}
        # 大型のボス：移動せず、マップ右上の2列×3行を占める
        if re.sub(r'_\d$', '', key) in LARGE_BOSSES:
            e['large'] = True
            # HPが一定割合を下回ると受けるダメージが減る（仮想敵：冑）
            if '1.hp_ratio' in bb and '1.damage_scale' in bb:
                e['lowHpGuard'] = {'ratio': bb['1.hp_ratio']['value'], 'scale': bb['1.damage_scale']['value']}
            # 【灭顶之灾】<刺胄之弹>（仮想敵：冑のスキル1。初期SP5・必要SP25 → 20秒後から25秒ごと）。
            # 弾の数値は本家データに無いため攻略wikiの値：HP8（どの攻撃も1ダメージ）、着弾で周囲8マスに2.1秒スタンと9.95秒間毎秒400の物理
            if any('灭顶之灾' in a for a in abilities):
                sk = next((x for x in (ed.get('skills') or []) if x.get('prefabKey') == '1'), None)
                if sk:
                    e['bomb'] = {'cooldown': sk['cooldown'], 'init': sk['initCooldown'], 'stun': 2.1, 'dotDps': 400, 'dotDuration': 9.95, 'hits': 8}
            # 【死亡集群】周期的に無人機を召喚（スキル2：enemy_key の敵。HPはボスの最大HP×hp_ratio と解釈）
            sk2 = next((x for x in (ed.get('skills') or []) if x.get('prefabKey') == '2'), None)
            if sk2 and any('死亡集群' in a for a in abilities):
                sbb = {b['key']: b for b in (sk2.get('blackboard') or [])}
                if 'enemy_key' in sbb and add_enemy(sbb['enemy_key']['valueStr']):
                    e['summon'] = {'enemy': sbb['enemy_key']['valueStr'], 'cooldown': sk2['cooldown'], 'init': sk2['initCooldown'], 'hpRatio': sbb.get('hp_ratio', {'value': 0})['value']}
            # 通常攻撃は「ランダムな対象に射線で術ダメージ」
            if 'attack' in e and any('法术' in a for a in abilities[:1]):
                e['attack']['arts'] = True
                e['attack']['randomTarget'] = True
        # ボスの手下：フィールド内を自由に飛び回り、防衛地点には入らない
        if key in BOSS_MINIONS:
            e['roam'] = True
            e['minionOf'] = BOSS_MINIONS[key]
            # 周期的に攻撃力が最も低い味方へ突っ込んで自爆（スキル1）。突進中は無敵が切れ、hits 回攻撃されると撃ち落とされて地上に落ち、
            # 受けるダメージが dmgScale 倍になる。撃ち落とされなければ着弾後ボスのそばへ戻る
            sk = next((x for x in (ed.get('skills') or []) if x.get('prefabKey') == '1'), None)
            if sk:
                sbb = {b['key']: b['value'] for b in (sk.get('blackboard') or [])}
                e['dive'] = {'cooldown': sk['cooldown'], 'init': sk['initCooldown'], 'stun': sbb.get('stun', 10), 'dotDps': sbb.get('dot_damage', 200),
                             'dotDuration': sbb.get('dot_duration', 10), 'hits': int(sbb.get('max_hit_cnt', 15)), 'dmgScale': sbb.get('damage_scale', 1)}
        # 元素損傷：攻撃時に攻撃力×比率の元素損傷を与える（種類は図鑑の説明から）
        etype = next((ELEMENT_TAGS[tag] for a in abilities for tag in ELEMENT_TAGS if tag in a), None)
        eratio = next((b['value'] for k, b in bb.items() if k.endswith('attack@ep_damage_ratio') or k == 'epdamage.ep_damage_ratio'), None)
        if etype and eratio and 'attack' in e:
            e['element'] = {'type': etype, 'ratio': eratio}
        # 周囲の味方全員に攻撃し続ける（深溟のミキサーなど）
        if 'attack' in e and any(a.startswith('持续对周围造成') for a in abilities):
            e['attack']['aura'] = True
        # 抵抗：異常状態（寒冷・凍結など）の時間が短くなる
        if 'buff.one_minus_status_resistance' in bb:
            e['statusResist'] = -bb['buff.one_minus_status_resistance']['value']
        # ステルスが解けた後の最初の攻撃の倍率（山海衆精鋭・密使）
        sk_inv = next((x for x in (ed.get('skills') or []) if x.get('prefabKey') == 'InvisibleCombat'), None)
        if sk_inv:
            sbb = {b['key']: b['value'] for b in (sk_inv.get('blackboard') or [])}
            if sbb.get('atk_scale'):
                e['ambush'] = sbb['atk_scale']
        # 臨戦状態：攻撃を受けると移動速度が上がり、周囲に元素損傷を与え続ける（元核のマレフィセント）
        if any('受到伤害时进入临战状态' in a for a in abilities):
            etype2 = next((ELEMENT_TAGS[tag] for a in abilities for tag in ELEMENT_TAGS if tag in a), None)
            e['enrage'] = {
                'speedMult': bb.get('0.move_speed', {'value': 1})['value'],
                'element': etype2,
                'ratio': bb.get('1.ep_damage_ratio', {'value': 0})['value'],
                'interval': bb.get('1.interval', {'value': 1})['value'],
                'radius': bb.get('1.range_radius', {'value': 0})['value'],
            }
        # 挑発レベル（高いほど味方に優先して狙われる）
        taunt = enemy_value(at, 'tauntLevel', 0) or 0
        if taunt:
            e['taunt'] = int(taunt)
        # ステルス（ブロックされるまで狙えない）
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
        # 倒れると周囲に「汚染秽蝕」（範囲内の味方が継続的にHPを失う）
        if 'polluteddie.projectile_range' in bb:
            e['deathPollution'] = {
                'high': bb['polluteddie.polluted_damage_high']['value'],
                'low': bb['polluteddie.polluted_damage_low']['value'],
                'duration': bb['polluteddie.projectile_life_time']['value'],
                'radius': bb['polluteddie.projectile_range']['value'],
            }
        # 囚人：拘束中は攻撃速度が下がり（一部は防御力が上がる）、一定回数攻撃すると解放されて強くなる
        if 'confinement.times' in bb:
            g = lambda k: bb[k]['value'] if k in bb else 0
            e['liberty'] = {
                'times': int(g('confinement.times')),
                'confAspd': g('confinement.attack_speed'),
                'confDef': g('confinement.def'),
                'atk': g('liberty.atk'),
                'defPen': g('liberty.def_penetrate'),
                'res': g('liberty.magic_resistance'),
                'regen': g('liberty.hp_recovery_per_sec'),
                'freeAll': any('解放全场' in a for a in abilities),
            }
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
                    entry_ = {
                        'enemy': key,
                        'role': SLOT_ROLES.get(key),
                        'count': a['count'],
                        'interval': a['interval'],
                        'delay': round(t1 + a['preDelay'], 2),
                        'spawn': 1 if start_row == goal_row else 0,
                    }
                    # 枠は飛行用（飛行の経路）と地上用の2組。ラウンドの敵グループに合う組だけが使われる
                    if entry_['role'] and route.get('motionMode') == 'FLY':
                        entry_['flySlot'] = True
                    spawns.append(entry_)
        rounds.append({
            'round': r,
            'levelId': entry['levelId'].split('/')[-1],
            'timeLimit': level['options']['maxPlayTime'],
            'moveMultiplier': level['options']['moveMultiplier'],
            'spawns': spawns,
        })

    # ---------------- 懸賞（倒すと資金を得る追加の敵。I〜IIIの3段階） ----------------
    bounties = []
    for eff_id, info in act['effectInfoDataDict'].items():
        m = re.match(r'^悬赏·(.+?)(I{1,3})$', info['effectName'])
        if not m or not re.match(r'^enemyeffect_1[0-5]_[4-6]$', eff_id) or m.group(1) not in BOUNTY_GROUPS:
            continue
        buff = (act['effectBuffInfoDataDict'].get(eff_id) or [{}])[0]
        bb = {b['key']: b for b in buff.get('blackboard', [])}
        if buff.get('key') != 'add_enemy_kill_gain_coin' or 'enemy_id' not in bb:
            continue
        key = bb['enemy_id']['valueStr']
        if not add_enemy(key):
            continue
        bounties.append({
            'id': eff_id,
            'enemy': key,
            'tier': len(m.group(2)),
            'group': BOUNTY_GROUPS[m.group(1)],
            'coin': int(bb['coin']['value']),
        })

    out = {'ranges': ranges, 'unitRanges': unit_ranges, 'enemies': enemies, 'groups': groups, 'firstHalfRounds': FIRST_HALF_ROUNDS, 'rounds': rounds, 'bounties': bounties}
    dest = Path(__file__).resolve().parent.parent / 'src/core/data/battledata.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'wrote {dest} ({len(ranges)} ranges, {len(enemies)} enemies, {len(groups)} groups, {len(rounds)} rounds, {len(bounties)} bounties)')


if __name__ == '__main__':
    main()
