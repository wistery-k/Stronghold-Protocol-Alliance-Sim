#!/usr/bin/env python3
"""
本家のゲームデータから「堅守協定：盟約（後期）」で使うデータを抽出し、
src/core/data/gamedata.json を生成する。

データ出典:
  - 大陸版: https://github.com/Kengxxiao/ArknightsGameData （盟約（後期）のテーブル・能力値・スキル）
  - 日本版: https://github.com/Kengxxiao/ArknightsGameData_YoStar （オペレーター名・スキル名の日本語表記）

使い方:
  python3 scripts/extract_gamedata.py <ArknightsGameData のパス> <ArknightsGameData_YoStar のパス>
  （どちらも <repo>/zh_CN/gamedata/excel, <repo>/ja_JP/gamedata/excel だけあれば良い）
"""

import json
import re
import sys
from pathlib import Path

ACT_ID = 'act2autochess'  # 堅守協定：盟約（後期）

sys.path.insert(0, str(Path(__file__).resolve().parent))
from item_ja import ITEM_JA, ITEM_JA_FIXED  # noqa: E402

# 日本版データにまだ無いオペレーターの日本語名
NAME_OVERRIDES = {
    'char_4196_reckpr': 'レコードキーパー',
    'char_4056_titi': 'ティティ',
    'char_1045_svash2': '凛御シルバーアッシュ',
    'char_1046_sbell2': '聖聆プラマニクス',
    'char_1047_halo2': '溯光アステジーニ',
    'char_4211_snhunt': 'スノーハンター',
    'char_4207_branch': 'ヴェトチキ',
    'char_4051_akkord': 'アコード',
}

# 日本版データにまだ無いスキルの日本語表記（説明はテンプレート。数値は本家データから埋める）
SKILL_JA_OVERRIDES = {
    'skchr_branch_2': ('生存の決意', 'スキル発動時、周囲の地上の敵を{not_combat}秒間戦慄状態にする。攻撃力+{atk:0%}、防御力+{def:0%}、ブロック中の敵すべてを同時に攻撃'),
    'skchr_titi_3': ('往日の開花', '攻撃力+{atk:0%}、敵2体を同時に攻撃し、睡眠状態でない対象を{attack@sleep}秒間睡眠状態にする。スキル中、睡眠から目覚めたか睡眠中に倒された敵は術ダメージ（睡眠時間に応じて最大で攻撃力の{max_atk_scale:0%}）を受け、周囲の別の敵1体を{sleep}秒間睡眠状態にする。攻撃範囲内の味方が致命傷を受けると、HPが全回復するかスキル終了まで睡眠状態になる'),
    'skchr_svash2_2': ('御敵の鋭鋒', '前方の敵最大6体に攻撃力の{atk_scale:0%}の物理ダメージを与え、{cold}秒間寒冷状態にしてステルスを無効化する。待機中で「風雪の眼」に最も近いオペレーター1名のコスト-{cost}。「風雪の眼」より左のオペレーターは配置時に自身の攻撃力でこのスキルの範囲効果を1回発動（最大2回まで重複）\n2回までチャージ可能'),
    'skchr_reckpr_2': ('勘所', '攻撃力+{atk:0%}、治療したオペレーターに{attack@buff_duration}秒間、ダメージを受けるたびにHPを{attack@fixed_heal_value}回復する効果を付与'),
    'skchr_halo2_3': ('並流連鎖', '攻撃範囲拡大、攻撃力+{atk:0%}、攻撃間隔短縮、敵{attack@max_target}体を継続してロックオンして攻撃し、ロック中の敵同士を連結する。連結された敵は受ける術ダメージの{attack@atk_share:0%}を他の連結対象にも伝える'),
}

BOND_ID = {  # 大陸版の盟約ID → このプロジェクトでのID
    'yanShip': 'yan', 'sargonShip': 'sargon', 'victoriaShip': 'victoria', 'kjeragShip': 'kjerag',
    'lateranoShip': 'laterano', 'egirShip': 'egir', 'siracusaShip': 'siracusa', 'kazimierzShip': 'kazimierz',
    'preciShip': 'preci', 'swiftShip': 'swift', 'skillfulShip': 'skillful', 'arcaneShip': 'arcane',
    'steadShip': 'stead', 'deputShip': 'deput', 'visiShip': 'visi', 'miraShip': 'mira',
    'investShip': 'invest', 'raidShip': 'raid', 'indomShip': 'indom', 'maniShip': 'mani',
    'emptyShip': 'empty', 'soloShip': 'solo', 'suntShip': 'sunt',
}

PROFESSION = {
    'PIONEER': 'vanguard', 'WARRIOR': 'guard', 'TANK': 'defender', 'SNIPER': 'sniper',
    'CASTER': 'caster', 'MEDIC': 'medic', 'SUPPORT': 'supporter', 'SPECIAL': 'specialist',
}

# 術ダメージを与える職分・職種（それ以外の攻撃職は物理）。医療・吟遊者は攻撃しない
ARTS_SUBPROF = {'slower', 'underminer', 'ritualist', 'artsfghter', 'incantationmedic', 'alchemist', 'primprotector'}
HEAL_SUBPROF = {'physician', 'wandermedic', 'ringhealer', 'chainhealer', 'healer', 'bard'}

# ---------------------------------------------------------------------------
# 堅守特性の日本語訳。{0},{1},... には大陸版テキスト中の数値が出現順に入る
# ---------------------------------------------------------------------------
WEAK = '与えるダメージが弱点ダメージになる（敵の防御力と術耐性に応じて物理・術を切り替える）'
GARRISON_JA = {
    '01': f'〈戦闘中〉{WEAK}',
    '03': '攻撃力と最大HP+{0}',
    '05': '【イェラグ】【秘術】の加算数{0}ごとに、自身の攻撃力+{1}',
    '07': '【エーギル】の加算数{0}ごとに、自身の攻撃力+{1}',
    '08': 'SP自然回復速度+{0}/秒',
    '09': '攻撃力と最大HP+{0}。核心盟約の加算数{1}ごとに、自身の攻撃力と最大HP+{2}',
    '10': '核心盟約の加算数{0}ごとに、自身の攻撃力と最大HP+{1}',
    '100': '【サルゴン】【俊敏】【精密】の加算数{0}ごとに、自身の攻撃力+{1}',
    '101': '【炎】【強襲】の加算数{0}ごとに、拘束・停止状態の敵に与えるダメージ+{1}',
    '102': '〈準備フェーズ終了時〉有効化中で加算数が最も多い盟約の加算数+{0}（控えにいても有効）',
    '104': '〈準備フェーズ終了時〉自身が所属する有効化中の盟約の加算数+{0}',
    '105': '〈獲得時〉有効化中で加算数が最も多い盟約の加算数+{0}',
    '106': '〈配置時〉自身が所属する有効化中の盟約の加算数+{0}（戦闘1回につき最大{1}）',
    '107': '〈配置時〉有効化中の【強襲】の加算数+{0}（戦闘1回につき最大{1}）',
    '11': '【ヴィクトリア】の加算数{0}ごとに、自身の攻撃速度+{1}',
    '111': '〈獲得時〉自身が所属する盟約の加算数+{0}（盟約の有効化不要）',
    '113': '〈獲得時〉無料更新を{0}回獲得',
    '114': '〈準備フェーズ開始時〉無料更新を{0}回獲得',
    '115': '【カジミエーシュ】の加算数{0}ごとに、配置後{1}秒間、自身の基礎攻撃力+{2}・基礎HP+{3}',
    '116': '〈売却時〉等級Iのオペレーターを1回無料で特別招集（精鋭化後は等級Vの特別招集になる）',
    '118': '〈戦闘中〉敵を倒すたびに有効化中の【シラクーザ】の加算数+{0}（荒蕪ラップランドを精鋭化すると、すべての【シラクーザ】オペレーターがこの効果を得る）',
    '119': '〈準備フェーズ終了時〉この準備フェーズでオペレーターを1名獲得するごとに、有効化中の【炎】【秘術】の加算数+{0}',
    '120': '〈売却時〉無料更新を{0}回獲得',
    '121': '〈準備フェーズ終了時〉このラウンドで資金を{0}消費するごとに、有効化中の【器用】【秘術】の加算数+{1}',
    '122': '〈準備フェーズ終了時〉このラウンドで{0}回更新するごとに、有効化中の【シラクーザ】【秘術】の加算数+{1}（最大{2}）',
    '123': '〈更新時〉このラウンド最初の手動更新なら、有効化中の【シラクーザ】の加算数+{0}（控えにいても有効）',
    '125': '〈戦闘中〉範囲内の敵か味方が睡眠・スタン状態になるたびに、有効化中の【サルゴン】【精密】の加算数+{0}（戦闘1回につき最大{1}）',
    '126': '〈戦闘開始時〉前方1マスの【イェラグ】オペレーターに特性「範囲内の敵{0}体が凍結するたびに、{1}の確率で有効化中の【イェラグ】の加算数+{2}」を付与',
    '127': '〈準備フェーズ開始時〉奇数ラウンドなら、ランダムなヴィクトリアの鉄鎚を{0}個獲得',
    '128': '〈戦闘中〉スキル発動時、有効化中の【サルゴン】の加算数+{0}',
    '12': '【エーギル】の加算数{0}ごとに、自身の攻撃力+{1}',
    '131': '〈戦闘中〉初めて敵か味方を倒した時、有効化中の【エーギル】【秘術】の加算数+{0}',
    '133': '〈獲得時〉「盟約のコイン」を{0}個獲得',
    '137': f'〈戦闘中〉攻撃力と最大HP+{{0}}、{WEAK}',
    '138': '〈戦闘中〉初めて敵を倒した時、有効化中の【精密】【ラテラーノ】の加算数+{0}',
    '13': '購入価格が{0}になる',
    '117': '〈戦闘中〉敵を倒すたびに、有効化中の【シラクーザ】の加算数+{0}',
    '108': '〈配置時〉有効化中の【カジミエーシュ】【精密】の加算数+{0}（戦闘1回につき最大{1}）',
    '29': '〈戦闘中〉範囲内の敵{0}体が凍結するたびに、{1}の確率で有効化中の【イェラグ】の加算数+{2}',
    '140': '〈戦闘中〉スキル発動時、有効化中で加算数が最も多い盟約の加算数+{0}',
    '141': '〈準備フェーズ開始時・終了時〉有効化中の【先見】の加算数+{0}',
    '142': '〈準備フェーズ終了時〉有効化中の【先見】の加算数+{0}',
    '143': '〈配置時〉有効化中の【カジミエーシュ】の加算数+{0}',
    '144': '【カジミエーシュ】の加算数{0}ごとに、自身の再配置時間-{1}、攻撃速度+{2}',
    '145': '〈戦闘開始時〉自身と前方1マスのオペレーターに特性「【カジミエーシュ】の加算数{0}ごとに、再配置時間-{1}、攻撃速度+{2}」を付与',
    '147': '〈準備フェーズ終了時〉このラウンドで{0}回更新するごとに、有効化中の【シラクーザ】の加算数+{1}（1ラウンドにつき最大{2}）',
    '148': '〈戦闘開始時〉左右一直線上で最も右のオペレーターに特性「〈配置時〉有効化中の【カジミエーシュ】【精密】の加算数+{0}（戦闘1回につき最大{1}）」を付与',
    '149': '〈獲得時〉ワイルドメインかアッシュロックを{0}体獲得（低確率でファートゥース）',
    '14': '【ラテラーノ】【堅守】の加算数{0}ごとに、自身の防御力+{1}',
    '150': '〈準備フェーズ開始時〉自身と前方1マスのオペレーターの有効化中の盟約の加算数をそれぞれ+{0}',
    '151': '攻撃力と最大HP+{0}。【投資家】【俊敏】の加算数{1}ごとに、自身の攻撃力と最大HP+{2}',
    '152': f'〈戦闘中〉{WEAK}。最初の{{0}}回敵を倒すたびに、有効化中の【シラクーザ】の加算数+{{1}}、【奇跡】の加算数+{{2}}',
    '153': f'〈戦闘中〉{WEAK}。最初の{{0}}回敵を倒すたびに、有効化中の【シラクーザ】の加算数+{{1}}、【奇跡】の加算数+{{2}}',
    '154': '〈準備フェーズ終了時〉有効化中の【ヴィクトリア】の加算数+{0}',
    '155': '〈獲得時〉自身が所属する盟約の加算数+{0}\n〈配置時〉自身が所属する有効化中の盟約の加算数+{1}（最大{2}）',
    '156': '〈獲得時〉【炎】の加算数+{0}、【奇跡】の加算数+{1}（盟約の有効化不要）',
    '158': '〈準備フェーズ終了時〉有効化中の【不屈】の加算数+{0}',
    '159': '【カジミエーシュ】の加算数{0}ごとに、自身の攻撃速度+{1}',
    '15': '【サルゴン】【堅守】の加算数{0}ごとに、自身の防御力+{1}',
    '160': '〈戦闘開始時〉自身と前方1マスのオペレーターに特性「【カジミエーシュ】の加算数{0}ごとに、攻撃速度+{1}」を付与',
    '16': '【ラテラーノ】の加算数{0}ごとに、自身の攻撃速度+{1}',
    '18': '海の怪物を攻撃する時、攻撃力が{0}に上昇',
    '19': 'ドローンを攻撃する時、攻撃力が{0}に上昇',
    '21': '〈売却時〉次の準備フェーズで資金+{0}',
    '22': '〈戦闘中〉周囲{0}マスのオペレーターが弾薬を{1}発消費するごとに、有効化中の【ラテラーノ】の加算数+{2}',
    '23': '〈戦闘中〉自身が弾薬を{0}発消費するごとに、有効化中の【ラテラーノ】の加算数+{1}、【先見】の加算数+{2}（戦闘1回につきそれぞれ最大{3}回）',
    '24': '〈戦闘中〉自身が弾薬を{0}発消費するごとに、左右一直線上に{1}名いれば有効化中の【ラテラーノ】【精密】の加算数+{2}',
    '25': '〈獲得時〉自身が所属する盟約の加算数+{0}（盟約の有効化不要）',
    '26': '〈獲得時〉次の準備フェーズで資金+{0}',
    '28': '〈戦闘中〉範囲内の敵{0}体が凍結するたびに、{1}の確率で有効化中の【イェラグ】の加算数+{2}',
    '31': '〈準備フェーズ終了時〉このラウンドでオペレーターを{0}名獲得するごとに、有効化中の【炎】の加算数+{1}',
    '32': '〈獲得時〉次の準備フェーズで資金+{0}',
    '34': '〈準備フェーズ終了時〉このラウンドでオペレーターを{0}名獲得するごとに、有効化中の【投資家】の加算数+{1}',
    '35': '〈獲得時〉【炎】【ヴィクトリア】の加算数+{0}（盟約の有効化不要）',
    '37': '〈準備フェーズ開始時〉左右一直線上に{0}名いれば、現在人数が最も多い盟約のオペレーターを{1}名ランダムに獲得',
    '38': '〈戦闘中〉{0}体倒すたびに、有効化中の【エーギル】【堅守】【強襲】の加算数+{1}',
    '39': '〈準備フェーズ開始時〉左右一直線上に{0}名いれば、スカジ・スペクター・アンダーフローのいずれかを{1}体獲得',
    '40': '〈戦闘中〉自身が倒れた時か身代わりと入れ替わった時、有効化中の【エーギル】の加算数+{0}、【不屈】の加算数+{1}',
    '42': '〈戦闘中〉初めてスキルを発動した時、有効化中の【サルゴン】の加算数+{0}',
    '43': '〈戦闘中〉スキル発動時、有効化中の【サルゴン】の加算数+{0}',
    '46': '〈戦闘中〉自身が倒れた時、有効化中の【エーギル】の加算数+{0}',
    '47': '〈準備フェーズ終了時〉自身と後方1マスのオペレーターの有効化中の盟約の加算数をそれぞれ+{0}',
    '48': '〈準備フェーズ終了時〉場にいる異なる等級の【ヴィクトリア】オペレーター{0}名ごとに、有効化中の【ヴィクトリア】の加算数+{1}',
    '49': '〈獲得時〉「速攻用レーション」を{0}個獲得',
    '50': '〈戦闘中〉最初の{0}回敵を倒すたびに、有効化中の【ヴィクトリア】【先見】【不屈】の加算数+{1}',
    '51': '〈準備フェーズ終了時〉自身が所属する有効化中の盟約の加算数+{0}',
    '53': '〈準備フェーズ終了時〉場にいる異なる等級の【ヴィクトリア】／【奇跡】オペレーター{0}名ごとに、有効化中の【ヴィクトリア】の加算数+{1}／【奇跡】の加算数+{2}',
    '54': '〈準備フェーズ終了時〉場にいる異なる等級の【ヴィクトリア】／【奇跡】オペレーター{0}名ごとに、有効化中の【ヴィクトリア】の加算数+{1}／【奇跡】の加算数+{2}',
    '55': '〈戦闘中〉自身が弾薬を{0}発消費するごとに、有効化中の【ラテラーノ】の加算数+{1}、【先見】の加算数+{2}（【先見】は戦闘1回につき最大{3}）',
    '56': '〈準備フェーズ終了時〉控えのオペレーター{0}名ごとに、有効化中の【俊敏】の加算数+{1}',
    '57': '〈準備フェーズ終了時〉控えにいる各オペレーターが所属する有効化中の盟約の加算数をそれぞれ+{0}',
    '59': '〈戦闘中〉前方1マスのオペレーターが特性で加算数を増やした時、さらに+{0}',
    '60': '〈準備フェーズ開始時〉前方1マスの他のオペレーターの「獲得時」効果を発動させる',
    '61': '〈準備フェーズ終了時〉有効化中で加算数が最も多い盟約について、場にいる異なる等級の所属オペレーター{0}名ごとに加算数+{1}',
    '65': '〈獲得時〉自身が所属する盟約の加算数+{0}（盟約の有効化不要）',
    '67': '〈売却時〉次の準備フェーズで資金+{0}',
    '69': '〈準備フェーズ終了時〉有効化中の【堅守】の加算数+{0}',
    '70': '〈準備フェーズ終了時〉左右一直線上のオペレーター{0}名ごとに、有効化中の【堅守】の加算数+{1}',
    '71': '〈獲得時〉自身が所属する盟約の加算数+{0}（盟約の有効化不要）',
    '72': '〈戦闘開始時〉前方1マスのオペレーターに特性「スキル発動時、自身が所属する有効化中の盟約の加算数+{0}」を付与（戦闘1回につき最大{1}）',
    '73': '〈戦闘開始時〉前方1マスのオペレーターに特性「スキル発動時、有効化中の【精密】の加算数+{0}」を付与（戦闘1回につき最大{1}）',
    '75': '〈配置時〉有効化中の【カジミエーシュ】の加算数+{0}\n〈倒れた時〉有効化中の【不屈】の加算数+{1}',
    '76': '〈獲得時〉「変形同位体」を{0}個獲得',
    '77': '〈戦闘中〉敵を{0}体倒すたびに、有効化中の【強襲】の加算数+{1}',
    '79': '〈準備フェーズ終了時〉自身と前方1マスのオペレーターの有効化中の盟約の加算数をそれぞれ+{0}',
    '80': '〈準備フェーズ開始時〉自身が所属する有効化中の盟約の加算数+{0}',
    '81': '〈準備フェーズ終了時〉有効化中で加算数が最も多い盟約の加算数+{0}（控えにいても有効）',
    '84': '【エーギル】の加算数{0}ごとに、自身のHPが毎秒{1}回復し、SP自然回復速度+{2}/秒',
    '86': '前方1マスのオペレーターが「準備フェーズ開始時」の特性を持つ場合、自身の特性もそれと同じになる',
    '90': '〈戦闘中〉スキル発動時、左右一直線上のオペレーター{0}名ごとに、有効化中で加算数が最も多い盟約の加算数+{1}（戦闘1回につき最大{2}）',
    '91': '〈獲得時〉ロックロックの特製品をランダムに{0}個製作',
    '92': '〈獲得時〉「イェラグの不融氷」を{0}個獲得',
    '93': '同じオペレーターが{0}体揃えば精鋭化できる',
    '94': '〈準備フェーズ開始時〉「盟約のコイン」か「サルゴンの渋茶」を{0}個獲得（低確率で「黄砂のコンパス」）',
    '98': '〈準備フェーズ終了時〉次の準備フェーズで資金+{0}（【炎】か【投資家】が有効化中なら控えでも有効）',
    '99': '前方1マスのオペレーターが「準備フェーズ終了時」の特性を持つ場合、自身の特性もそれと同じになる',
}


def garrison_30(cn: str, _nums):
    if '两倍' in cn:
        return '〈獲得時〉現在の管理レベルの2倍に等しい【炎】の加算数を獲得（盟約の有効化不要）'
    return '〈獲得時〉現在の管理レベルに等しい【炎】の加算数を獲得（盟約の有効化不要）'


def garrison_37(cn: str, nums):
    if len(nums) == 1:
        return f'〈準備フェーズ開始時〉現在人数が最も多い盟約のオペレーターを{nums[0]}名ランダムに獲得'
    return f'〈準備フェーズ開始時〉左右一直線上に{nums[0]}名いれば、現在人数が最も多い盟約のオペレーターを{nums[1]}名ランダムに獲得'


def garrison_39(cn: str, nums):
    text = f'〈準備フェーズ開始時〉左右一直線上に{nums[0]}名いれば、スカジ・スペクター・アンダーフローのいずれかを{nums[1]}体獲得'
    return text + (f'（{nums[2]}回繰り返す）' if len(nums) > 2 else '')


def with_optional_max(text: str):
    def fn(_cn: str, nums):
        out = text.format(nums[0])
        return out + (f'（戦闘1回につき最大{nums[1]}）' if len(nums) > 1 else '')
    return fn


GARRISON_JA_FN = {
    '30': garrison_30,
    '37': garrison_37,
    '39': garrison_39,
    '95': with_optional_max('〈戦闘中〉スキル発動時、自身が所属する有効化中の盟約の加算数+{0}'),
    '96': with_optional_max('〈戦闘中〉スキル発動時、有効化中の【精密】の加算数+{0}'),
}

TAG_RE = re.compile(r'<[@$][^>]*>|</>')
NUM_RE = re.compile(r'\d+(?:\.\d+)?%?')


def strip_tags(s: str) -> str:
    return TAG_RE.sub('', s or '').replace('\\n', '\n')


def translate_garrison(gid: str, cn: str) -> str:
    base = gid.split('_')[1]
    body = re.sub(r'^【\d+】', '', cn)
    nums = NUM_RE.findall(body)
    if base in GARRISON_JA_FN:
        return GARRISON_JA_FN[base](body, nums)
    tmpl = GARRISON_JA.get(base)
    if tmpl is None:
        print(f'warning: no translation for {gid}: {cn}', file=sys.stderr)
        return cn
    need = len(set(re.findall(r'\{(\d+)\}', tmpl)))
    if need != len(nums):
        print(f'warning: number mismatch for {gid}: {nums} vs {tmpl}', file=sys.stderr)
        return cn
    return tmpl.format(*nums)


# ---------------------------------------------------------------------------
# 能力値
# ---------------------------------------------------------------------------
PHASE = {'PHASE_0': 0, 'PHASE_1': 1, 'PHASE_2': 2}


def interp_attrs(char: dict, phase: int, level: int) -> dict:
    frames = char['phases'][phase]['attributesKeyFrames']
    a, b = frames[0], frames[-1]
    if b['level'] == a['level']:
        t = 0.0
    else:
        t = (level - a['level']) / (b['level'] - a['level'])
    out = {}
    for k in ('maxHp', 'atk', 'def', 'magicResistance', 'baseAttackTime', 'blockCnt', 'cost', 'attackSpeed'):
        va, vb = a['data'][k], b['data'][k]
        out[k] = va + (vb - va) * t if k in ('maxHp', 'atk', 'def') else va
    for k in ('maxHp', 'atk', 'def'):
        out[k] = round(out[k])
    return out


def module_bonus(equip_table: dict, equip_id, equip_level: int) -> dict:
    if not equip_id or equip_level <= 0 or equip_id not in equip_table:
        return {}
    phases = equip_table[equip_id]['phases']
    ph = phases[min(equip_level, len(phases)) - 1]
    return {x['key']: x['value'] for x in ph.get('attributeBlackboard', [])}


def build_stats(char: dict, status: dict, equip_table: dict, equip_id) -> dict:
    a = interp_attrs(char, PHASE[status['evolvePhase']], status['charLevel'])
    bonus = module_bonus(equip_table, equip_id, status.get('equipLevel', 0))
    return {
        'hp': a['maxHp'] + round(bonus.get('max_hp', 0)),
        'atk': a['atk'] + round(bonus.get('atk', 0)),
        'def': a['def'] + round(bonus.get('def', 0)),
        'res': a['magicResistance'] + bonus.get('magic_resistance', 0),
        'interval': a['baseAttackTime'],
        'aspd': a['attackSpeed'] + bonus.get('attack_speed', 0),
        'block': a['blockCnt'],
        'cost': a['cost'],
    }


# ---------------------------------------------------------------------------
# スキル
# ---------------------------------------------------------------------------
def fmt_value(v: float, fmt: str) -> str:
    if fmt.endswith('%'):
        s = f'{v * 100:.1f}'.rstrip('0').rstrip('.')
        return s + '%'
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return s


def render_desc(tmpl: str, bb: dict) -> str:
    text = strip_tags(tmpl)

    def rep(m):
        key, fmt = m.group(1), m.group(2) or ''
        neg = key.startswith('-')
        k = key[1:] if neg else key
        if k.lower() not in bb:
            return m.group(0)
        v = bb[k.lower()]
        return fmt_value(-v if neg else v, fmt)

    return re.sub(r'\{([-\w@\[\].]+)(?::([0-9.%]+))?\}', rep, text)


def build_skill(skill_cn: dict, skill_ja, level: int) -> dict:
    lv = skill_cn['levels'][level - 1]
    bb = {x['key'].lower(): x['value'] for x in lv['blackboard']}
    name = (skill_ja or {}).get('levels', [{}])[0].get('name') if skill_ja else None
    desc_tmpl = None
    if skill_ja and len(skill_ja['levels']) >= level:
        desc_tmpl = skill_ja['levels'][level - 1]['description']
    if skill_cn['skillId'] in SKILL_JA_OVERRIDES:
        name, desc_tmpl = SKILL_JA_OVERRIDES[skill_cn['skillId']]
    return {
        'id': skill_cn['skillId'],
        'name': name or lv['name'],
        'description': render_desc(desc_tmpl or lv['description'], bb),
        'skillType': lv['skillType'],
        'durationType': lv['durationType'],
        'spType': lv['spData']['spType'],
        'spCost': lv['spData']['spCost'],
        'initSp': lv['spData']['initSp'],
        'duration': lv['duration'],
        'blackboard': bb,
    }


# ---------------------------------------------------------------------------
def main():
    cn_dir = Path(sys.argv[1]) / 'zh_CN/gamedata/excel'
    ja_dir = Path(sys.argv[2]) / 'ja_JP/gamedata/excel'
    load = lambda p: json.loads(p.read_text(encoding='utf-8'))

    act = load(cn_dir / 'activity_table.json')['activity']['AUTOCHESS_SEASON'][ACT_ID]
    chars_cn = load(cn_dir / 'character_table.json')
    skills_cn = load(cn_dir / 'skill_table.json')
    equips = load(cn_dir / 'battle_equip_table.json')
    chars_ja = load(ja_dir / 'character_table.json')
    skills_ja = load(ja_dir / 'skill_table.json')
    version = (cn_dir / 'data_version.txt').read_text(encoding='utf-8').strip().splitlines()

    units = []
    for chess_id, shop in act['charShopChessDatas'].items():
        if shop['isHidden'] or shop['chessType'] == 'DIY':
            continue
        char_id = shop['charId']
        ch = chars_cn[char_id]
        name = chars_ja.get(char_id, {}).get('name') or NAME_OVERRIDES.get(char_id)
        if not name:
            print(f'warning: no Japanese name for {char_id} ({ch["name"]})', file=sys.stderr)
            name = ch['name']
        sub = ch['subProfessionId']
        dmg = 'arts' if (ch['profession'] == 'CASTER' or sub in ARTS_SUBPROF) else 'physical'
        if sub in HEAL_SUBPROF:
            dmg = 'heal'

        states = {}
        merge = 3
        for key, cid in (('normal', chess_id), ('golden', shop['goldenChessId'])):
            cd = act['charChessDataDict'][cid]
            st = cd['status']
            skill_ref = ch['skills'][shop['defaultSkillIndex']]['skillId']
            garrisons = []
            for gid in cd['garrisonIds']:
                g = act['garrisonDataDict'][gid]
                cn_desc = strip_tags(g['description'])
                if gid.startswith('garrison_93'):
                    merge = 2
                garrisons.append({
                    'id': gid,
                    'event': g['eventType'],
                    'effect': g['effectType'],
                    'description': translate_garrison(gid, cn_desc),
                    'blackboard': {x['key']: (x['valueStr'] if x['valueStr'] is not None else x['value']) for x in g['blackboard']},
                })
            states[key] = {
                'evolvePhase': PHASE[st['evolvePhase']],
                'level': st['charLevel'],
                'skillLevel': st['skillLevel'],
                'moduleLevel': st['equipLevel'],
                'stats': build_stats(ch, st, equips, shop['defaultUniEquipId']),
                'skill': build_skill(skills_cn[skill_ref], skills_ja.get(skill_ref), st['skillLevel']),
                'garrisons': garrisons,
            }
            if key == 'normal':
                bonds = [BOND_ID[b] for b in cd['bondIds']]

        units.append({
            'id': chess_id.replace('chess_char_', '').removesuffix('_a'),
            'charId': char_id,
            'name': name,
            'tier': shop['chessLevel'],
            'profession': PROFESSION[ch['profession']],
            'subProfession': sub,
            'damageType': dmg,
            'bonds': bonds,
            'mergeCount': merge,
            'normal': states['normal'],
            'golden': states['golden'],
        })

    units.sort(key=lambda u: (u['tier'], u['id']))

    # 他のオペレーターに付与される特性（「〜に特性を付与」）
    given = {}
    for u in units:
        for key in ('normal', 'golden'):
            for g in u[key]['garrisons']:
                gid = g['blackboard'].get('give_garrison_id')
                if gid and gid not in given:
                    gd = act['garrisonDataDict'][gid]
                    given[gid] = {
                        'id': gid,
                        'event': gd['eventType'],
                        'effect': gd['effectType'],
                        'description': translate_garrison(gid, strip_tags(gd['description'])),
                        'blackboard': {x['key']: (x['valueStr'] if x['valueStr'] is not None else x['value']) for x in gd['blackboard']},
                    }

    # 盟約の数値
    bonds = {}
    for cn_id, b in act['bondInfoDict'].items():
        if cn_id not in BOND_ID:
            continue
        eff = act['effectBuffInfoDataDict'].get(b['effectId'], [])
        values = {}
        for e in eff:
            for x in e['blackboard']:
                if x['valueStr'] is None:
                    values.setdefault(x['key'], x['value'])
        bonds[BOND_ID[cn_id]] = {
            'activeCount': b['activeCount'],
            'condition': b['activeCondition'],
            'values': values,
        }

    # 装備（アイテム）
    items = []
    for item_id, shop in act['trapShopChessDatas'].items():
        if shop['hideInShop'] or shop['itemType'] != 'EQUIP':
            continue
        base = item_id.replace('chess_item_', '').removesuffix('_e_a')
        states = {}
        for key, cid in (('normal', item_id), ('golden', shop['goldenItemId'])):
            c = act['trapChessDataDict'][cid]
            eff = act['effectInfoDataDict'][c['effectId']]
            cn = strip_tags(eff['effectDesc'])
            if base in ITEM_JA_FIXED:
                name, desc = ITEM_JA_FIXED[base]
            elif base in ITEM_JA:
                name, tmpl = ITEM_JA[base]
                nums = NUM_RE.findall(cn)
                need = len(set(re.findall(r'\{(\d+)\}', tmpl)))
                if need != len(nums):
                    print(f'warning: item number mismatch {cid}: {nums} vs {tmpl}', file=sys.stderr)
                    desc = tmpl.format(*(nums + ['?'] * need))
                else:
                    desc = tmpl.format(*nums)
            else:
                print(f'warning: no item translation {cid}: {cn}', file=sys.stderr)
                name, desc = eff['effectName'], cn
            buffs = []
            for b in act['effectBuffInfoDataDict'].get(c['effectId'], []):
                buffs.append({'type': b['key'], **{x['key']: (x['valueStr'] if x['valueStr'] is not None else x['value']) for x in b['blackboard']}})
            states[key] = {
                'name': name,
                'description': desc,
                'price': c['purchasePrice'],
                'buffs': buffs,
            }
        c0 = act['trapChessDataDict'][item_id]
        items.append({
            'id': base,
            'tier': shop['itemLevel'],
            'giveBond': BOND_ID.get(c0['giveBondId']) if c0['giveBondId'] else None,
            'canGiveBond': c0['canGiveBond'],
            'mergeCount': c0['upgradeNum'],
            'normal': states['normal'],
            'golden': states['golden'],
        })
    items.sort(key=lambda x: x['id'])

    prices = {}
    for tier, infos in act['shopCharChessInfoData'].items():
        normal = next(i for i in infos if not i['isGolden'])
        prices[tier] = {'buy': normal['purchasePrice'], 'sell': normal['chessSoldPrice']}

    levels = [
        {'level': v['shopLevel'], 'upgradePrice': v['initialUpgradePrice'], 'slots': v['charChessCount']}
        for v in act['shopLevelDataDict']['mode_single_normal'].values()
    ]

    out = {
        'source': {'activity': ACT_ID, 'dataVersion': version},
        'shop': {
            'refreshPrice': act['constData']['shopRefreshPrice'],
            'maxBattle': act['constData']['maxBattleChessCnt'],
            'maxDeck': act['constData']['maxDeckChessCnt'],
            'prices': prices,
            'levels': levels,
        },
        'bonds': bonds,
        'givenGarrisons': given,
        'items': items,
        'units': units,
    }
    dest = Path(__file__).resolve().parent.parent / 'src/core/data/gamedata.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'wrote {dest} ({len(units)} units, {len(bonds)} bonds)')


if __name__ == '__main__':
    main()
