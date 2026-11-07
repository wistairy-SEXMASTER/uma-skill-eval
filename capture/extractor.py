"""復号済み MessagePack から、育成ウマ娘・適性・ヒントを抽出する。

特定のエンドポイント名には依存せず、レスポンス内を再帰的に走査して
`card_id` と `proper_*` を持つオブジェクトを育成ウマ娘とみなす。
これにより `single_mode/load` だけでなく、シナリオ別の load や
`trained_chara/load` にも同じ処理で対応できる。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

# 適性値 1..8 -> G..S
_GRADE_BY_VALUE = {
    1: "G",
    2: "F",
    3: "E",
    4: "D",
    5: "C",
    6: "B",
    7: "A",
    8: "S",
}

_DISTANCE_KEYS = {
    1: "proper_distance_short",
    2: "proper_distance_mile",
    3: "proper_distance_middle",
    4: "proper_distance_long",
}
_STYLE_KEYS = {
    1: "proper_running_style_nige",
    2: "proper_running_style_senko",
    3: "proper_running_style_sashi",
    4: "proper_running_style_oikomi",
}
_GROUND_KEYS = {
    1: "proper_ground_turf",
    2: "proper_ground_dirt",
}

_STAT_KEYS = ("speed", "stamina", "power", "guts", "wiz")


def _walk(node: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], dict]]:
    if isinstance(node, dict):
        yield path, node
        for key, value in node.items():
            yield from _walk(value, path + (str(key),))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk(value, path + (f"[{index}]",))


def _is_chara(data: dict) -> bool:
    card_id = data.get("card_id")
    if not isinstance(card_id, int) or isinstance(card_id, bool):
        return False
    return any(key in data for key in _DISTANCE_KEYS.values())


def _chara_score(data: dict, path: tuple[str, ...]) -> int:
    score = 0
    if isinstance(data.get("skill_tips_array"), list):
        score += 12  # 育成中のウマ娘だけが持つ
    if isinstance(data.get("scenario_id"), int):
        score += 3
    if isinstance(data.get("turn"), int):
        score += 2
    if isinstance(data.get("skill_point"), int):
        score += 2
    if any("chara_info" in part for part in path):
        score += 5
    score += sum(1 for key in _DISTANCE_KEYS.values() if key in data)
    return score


def _grade(data: dict, key: str) -> str | None:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    return _GRADE_BY_VALUE.get(value)


def _aptitudes(data: dict) -> dict:
    return {
        "distance": {
            str(index): _grade(data, key) for index, key in _DISTANCE_KEYS.items()
        },
        "style": {
            str(index): _grade(data, key) for index, key in _STYLE_KEYS.items()
        },
        "ground": {
            str(index): _grade(data, key) for index, key in _GROUND_KEYS.items()
        },
    }


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _hints(data: dict) -> list[dict]:
    """ヒントは (group_id, rarity) 単位。同じ組は最大Lvにまとめる。"""
    merged: dict[tuple[int, int], int] = {}
    tips = data.get("skill_tips_array")
    if not isinstance(tips, list):
        return []
    for tip in tips:
        if not isinstance(tip, dict):
            continue
        group_id = _int_or_none(tip.get("group_id"))
        rarity = _int_or_none(tip.get("rarity"))
        level = _int_or_none(tip.get("level"))
        if group_id is None or rarity is None or level is None:
            continue
        if level < 0 or level > 5:
            continue
        key = (group_id, rarity)
        merged[key] = max(merged.get(key, 0), level)
    return [
        {"group_id": group_id, "rarity": rarity, "level": level}
        for (group_id, rarity), level in sorted(merged.items())
    ]


def _learned_skills(data: dict) -> list[dict]:
    merged: dict[int, int] = {}
    skills = data.get("skill_array")
    if not isinstance(skills, list):
        return []
    for skill in skills:
        if not isinstance(skill, dict):
            continue
        skill_id = _int_or_none(skill.get("skill_id"))
        if skill_id is None:
            continue
        level = _int_or_none(skill.get("level")) or 1
        merged[skill_id] = max(merged.get(skill_id, 0), level)
    return [
        {"skill_id": skill_id, "level": level}
        for skill_id, level in sorted(merged.items())
    ]


def _effects(data: dict) -> list[int]:
    values = data.get("chara_effect_id_array")
    if not isinstance(values, list):
        return []
    result: list[int] = []
    for value in values:
        number = _int_or_none(value)
        if number is not None and number not in result:
            result.append(number)
    return result


def _stats(data: dict) -> dict:
    stats = {}
    for key in _STAT_KEYS:
        value = _int_or_none(data.get(key))
        if value is not None:
            stats[key] = value
    return stats


def extract(
    payload: Any,
    *,
    endpoint: str = "",
    request_id: str = "",
    kind: str = "response",
    body_size: int | None = None,
) -> dict:
    """MessagePack オブジェクトからビューア用の状態を作る。"""
    best: tuple[int, tuple[str, ...], dict] | None = None
    for path, data in _walk(payload):
        if not _is_chara(data):
            continue
        score = _chara_score(data, path)
        if best is None or score > best[0]:
            best = (score, path, data)

    source = {
        "endpoint": endpoint,
        "request_id": request_id,
        "kind": kind,
        "body_size": body_size,
        "extracted_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }

    if best is None:
        return {
            "ok": False,
            "error": "育成ウマ娘のデータが見つかりませんでした。",
            "source": source,
        }

    _, path, data = best
    card_id = _int_or_none(data.get("card_id"))
    chara = {
        "card_id": card_id,
        "scenario_id": _int_or_none(data.get("scenario_id")),
        "turn": _int_or_none(data.get("turn")),
        "skill_point": _int_or_none(data.get("skill_point")),
        "chara_grade": _int_or_none(data.get("chara_grade")),
        "talent_level": _int_or_none(data.get("talent_level")),
        "fans": _int_or_none(data.get("fans")),
        "stats": _stats(data),
        "aptitude": _aptitudes(data),
        "has_hints": isinstance(data.get("skill_tips_array"), list),
        "hints": _hints(data),
        "learned_skills": _learned_skills(data),
        "effects": _effects(data),
    }
    source["path"] = "/".join(path)
    return {"ok": True, "chara": chara, "source": source}
