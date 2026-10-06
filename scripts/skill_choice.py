"""戦闘で使うスキルの指定（イベントデータの defaultSkillIndex を上書き）。

キーは charId、値は skills の添字（0 = S1）。ユーザーの指定によるもの。
"""

SKILL_INDEX_OVERRIDES = {
    'char_126_shotst': 0,  # メテオ：S1
}


def skill_index(char_id: str, shop: dict) -> int:
    return SKILL_INDEX_OVERRIDES.get(char_id, shop['defaultSkillIndex'])
