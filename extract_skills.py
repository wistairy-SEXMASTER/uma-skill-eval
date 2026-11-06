# -*- coding: utf-8 -*-
"""
Uma Musume master.mdb からスキル名・評価点・スキルポイント(SP)を抽出する。

使い方:
    py extract_skills.py
    py extract_skills.py --db "C:\\path\\to\\master.mdb"
    py extract_skills.py --db master.mdb --out out

出力:
    out/skills.csv            全スキル（Excel向け UTF-8 BOM）
    out/skills.json           JSON
    out/skills_purchasable.csv SPで取得できるスキルのみ
    out/skills_rating.csv     特殊・期限切れを除いた査定用一覧
    data/skills.js            index.html 用データ
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

DEFAULT_DB = (
    r"C:\Program Files (x86)\STEAM\steamapps\common"
    r"\UmamusumePrettyDerby_Jpn\UmamusumePrettyDerby_Jpn_Data"
    r"\Persistent\master\master.mdb"
)

# skill_category はゲーム内のスキル分類。数値しかないため、一般的な呼び方で補助ラベルを付ける。
CATEGORY_LABELS = {
    0: "コース・馬場・天候",
    1: "スタート・序盤",
    2: "中盤",
    3: "終盤",
    4: "コーナー・直線",
    5: "固有",
    101: "イベント",
}

FIELDS = [
    "skill_id",
    "name",
    "type",
    "rarity",
    "eval_point",
    "sp",
    "upgrade_point",
    "efficiency",
    "total_sp",
    "total_efficiency",
    "group_id",
    "group_rate",
    "prereq_sp",
    "prereq_eval",
    "category",
    "category_label",
    "purchasable",
    "available",
    "description",
    "start_date",
    "end_date",
    "apt_distance",
    "apt_style",
    "apt_ground",
    "apt_source",
]

# 説明文の ＜...＞ タグに使われる適性名と、DB の distance_type / running_style の対応
DISTANCE_IDS = {"短距離": 1, "マイル": 2, "中距離": 3, "長距離": 4}
STYLE_IDS = {"大逃げ": 1, "逃げ": 1, "先行": 2, "差し": 3, "追込": 4}
GROUND_IDS = {"芝": 1, "ダート": 2}
APT_TAG_RE = re.compile(r"[<＜]([^>＞]{1,40})[>＞]")
APTITUDE_LESS_TYPES = ("固有", "継承固有")


def connect(db_path: Path) -> sqlite3.Connection:
    uri = "file:" + db_path.as_posix() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def clean_text(value: str) -> str:
    """master.mdb のテキストは改行を「\\n」の2文字で持つことがあるため、実改行に直す。"""
    return (value or "").replace("\\n", "\n").strip()


def type_label(skill_id: int, rarity: int) -> str:
    if 900_000 <= skill_id < 1_000_000:
        return "継承固有"
    if rarity == 6:
        return "進化"
    if rarity in (3, 4, 5):
        return "固有"
    if rarity == 2:
        return "レア"
    if rarity == 1:
        # 300xxx はストーリー/NPC用、1000000以上はイベント/特殊スキル
        if skill_id < 300_000:
            return "ノーマル"
        return "特殊"
    return "その他"


def parse_aptitude_tag(tag: str) -> tuple[list[int], list[int], list[int]]:
    """説明文の ＜...＞ を距離適性ID・脚質適性ID・馬場IDに分解する。

    - 「/」は同じカテゴリ内のOR（良い方を使用）
    - 「・」は異なるカテゴリのAND（倍率を乗算）
    - 芝・ダートは評価点倍率の対象外だが、絞り込み用に保持する
    """
    text = tag.strip()
    if text.startswith("作戦・"):
        text = text[len("作戦・"):]
    distances: set[int] = set()
    styles: set[int] = set()
    grounds: set[int] = set()
    for group in text.split("・"):
        for part in group.split("/"):
            part = part.strip()
            if part in DISTANCE_IDS:
                distances.add(DISTANCE_IDS[part])
            if part in STYLE_IDS:
                styles.add(STYLE_IDS[part])
            if part in GROUND_IDS:
                grounds.add(GROUND_IDS[part])
    return sorted(distances), sorted(styles), sorted(grounds)


def aptitude_from_conditions(text: str) -> tuple[list[int], list[int], list[int]]:
    """発動条件から距離・脚質・馬場のIDを拾う（重複なし）。"""
    distances = {int(x) for x in re.findall(r"distance_type\s*==\s*(\d+)", text)}
    styles = {int(x) for x in re.findall(r"running_style\s*==\s*(\d+)", text)}
    grounds = {int(x) for x in re.findall(r"ground_type\s*==\s*(\d+)", text)}
    return sorted(distances), sorted(styles), sorted(grounds)


def aptitude_for(row: dict, skill_type: str) -> tuple[str, str, str, str]:
    tags = APT_TAG_RE.findall(row.get("description") or "")
    condition = " ".join(
        value for value in (row.get("condition"), row.get("precondition")) if value
    )
    cond_distances, cond_styles, cond_grounds = aptitude_from_conditions(condition)

    if tags:
        distances, styles, grounds = parse_aptitude_tag(tags[0])
        # 発動条件に馬場指定があれば、タグに無くても絞り込み用に補完する
        grounds = sorted(set(grounds) | set(cond_grounds))
        source = "tag" if (distances or styles or grounds) else ""
        return (
            "/".join(map(str, distances)),
            "/".join(map(str, styles)),
            "/".join(map(str, grounds)),
            source,
        )

    grounds = cond_grounds
    if skill_type in APTITUDE_LESS_TYPES:
        # 固有・継承固有は評価点倍率の対象外だが、絞り込み用に条件を保持する
        distances, styles = cond_distances, cond_styles
    else:
        # 通常スキルは単一条件のみを適性として扱う（誤った倍率適用を避ける）
        distances = cond_distances if len(cond_distances) == 1 else []
        styles = cond_styles if len(cond_styles) == 1 else []

    source = "condition" if (distances or styles or grounds) else ""
    return (
        "/".join(map(str, distances)),
        "/".join(map(str, styles)),
        "/".join(map(str, grounds)),
        source,
    )


def load_rows(con: sqlite3.Connection) -> list[dict]:
    sql = """
        SELECT
            s.id,
            s.rarity,
            s.group_id,
            s.group_rate,
            s.grade_value,
            s.skill_category,
            s.is_general_skill,
            s.disp_order,
            s.start_date,
            s.end_date,
            s.condition_1,
            s.precondition_1,
            n.need_skill_point,
            tn.text AS name,
            td.text AS description
        FROM skill_data AS s
        LEFT JOIN single_mode_skill_need_point AS n ON n.id = s.id
        LEFT JOIN text_data AS tn ON tn.category = 47 AND tn."index" = s.id
        LEFT JOIN text_data AS td ON td.category = 48 AND td."index" = s.id
        ORDER BY s.id
    """
    rows = []
    for r in con.execute(sql):
        rows.append(
            {
                "id": int(r["id"]),
                "rarity": int(r["rarity"]),
                "group_id": int(r["group_id"]),
                "group_rate": int(r["group_rate"]),
                "eval": int(r["grade_value"]),
                "category": int(r["skill_category"]),
                "is_general": int(r["is_general_skill"]),
                "start_date": int(r["start_date"] or 0),
                "end_date": int(r["end_date"] or 0),
                "sp": None if r["need_skill_point"] is None else int(r["need_skill_point"]),
                "name": clean_text(r["name"]),
                "description": clean_text(r["description"]),
                "condition": r["condition_1"] or "",
                "precondition": r["precondition_1"] or "",
            }
        )
    return rows


APTITUDE_GRADE = {1: "G", 2: "F", 3: "E", 4: "D", 5: "C", 6: "B", 7: "A", 8: "S"}
RUNNING_STYLE_NAMES = {1: "逃げ", 2: "先行", 3: "差し", 4: "追込"}


def load_cards(con: sqlite3.Connection) -> list[dict]:
    """カード（ウマ娘）ごとの初期適性を読み込む。適性はレアリティ間で共通。"""
    sql = """
        SELECT
            c.id AS card_id,
            c.chara_id,
            c.default_rarity,
            c.running_style,
            t170.text AS chara_name,
            t4.text AS display_name,
            t5.text AS costume_name,
            r.proper_distance_short,
            r.proper_distance_mile,
            r.proper_distance_middle,
            r.proper_distance_long,
            r.proper_running_style_nige,
            r.proper_running_style_senko,
            r.proper_running_style_sashi,
            r.proper_running_style_oikomi,
            r.proper_ground_turf,
            r.proper_ground_dirt
        FROM card_data AS c
        LEFT JOIN card_rarity_data AS r
            ON r.card_id = c.id
            AND r.rarity = (SELECT MIN(rarity) FROM card_rarity_data WHERE card_id = c.id)
        LEFT JOIN text_data AS t170 ON t170.category = 170 AND t170."index" = c.chara_id
        LEFT JOIN text_data AS t4 ON t4.category = 4 AND t4."index" = c.id
        LEFT JOIN text_data AS t5 ON t5.category = 5 AND t5."index" = c.id
        ORDER BY c.chara_id, c.id
    """

    def grade(value) -> str:
        return APTITUDE_GRADE.get(int(value or 0), "")

    cards = []
    for r in con.execute(sql):
        cards.append(
            {
                "card_id": int(r["card_id"]),
                "chara_id": int(r["chara_id"]),
                "chara_name": clean_text(r["chara_name"]),
                "display_name": clean_text(r["display_name"]),
                "costume_name": clean_text(r["costume_name"]),
                "rarity": int(r["default_rarity"] or 0),
                "running_style": int(r["running_style"] or 0),
                "running_style_name": RUNNING_STYLE_NAMES.get(int(r["running_style"] or 0), ""),
                "aptitude": {
                    "distance": {
                        "1": grade(r["proper_distance_short"]),
                        "2": grade(r["proper_distance_mile"]),
                        "3": grade(r["proper_distance_middle"]),
                        "4": grade(r["proper_distance_long"]),
                    },
                    "style": {
                        "1": grade(r["proper_running_style_nige"]),
                        "2": grade(r["proper_running_style_senko"]),
                        "3": grade(r["proper_running_style_sashi"]),
                        "4": grade(r["proper_running_style_oikomi"]),
                    },
                    "ground": {
                        "1": grade(r["proper_ground_turf"]),
                        "2": grade(r["proper_ground_dirt"]),
                    },
                },
            }
        )
    return cards


def build_groups(rows: list[dict]) -> dict[int, list[dict]]:
    groups: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        groups[r["group_id"]].append(r)
    return groups


def analyze(rows: list[dict], now: int) -> list[dict]:
    """下位スキル連鎖・評価点上昇・SP効率を計算して付与する。"""
    groups = build_groups(rows)
    # 同グループ・同rateが複数ある場合に備え、rateごとに評価点が最大のものを代表にする
    representative: dict[tuple[int, int], dict] = {}
    for gid, members in groups.items():
        for r in members:
            key = (gid, r["group_rate"])
            cur = representative.get(key)
            if cur is None or r["eval"] > cur["eval"]:
                representative[key] = r

    out = []
    for r in rows:
        sid = r["id"]
        rarity = r["rarity"]
        gid = r["group_id"]
        rate = r["group_rate"]
        sp = r["sp"]
        eval_point = r["eval"]

        # 下位スキル（1 <= group_rate < 自身のrate）を rate 昇順で連鎖とみなす
        chain = []
        if rate >= 1:
            for lower_rate in range(1, rate):
                lower = representative.get((gid, lower_rate))
                if lower is not None:
                    chain.append(lower)

        prereq_eval = max((c["eval"] for c in chain), default=0)
        prereq_sp = sum((c["sp"] or 0) for c in chain) if chain else 0
        upgrade_point = eval_point - prereq_eval
        total_sp = (sp or 0) + prereq_sp if sp is not None else None

        efficiency = None
        if sp is not None and sp > 0:
            efficiency = round(upgrade_point / sp, 3)
        total_efficiency = None
        if total_sp is not None and total_sp > 0:
            total_efficiency = round(eval_point / total_sp, 3)

        available = (r["start_date"] <= now <= r["end_date"]) if r["end_date"] else True
        purchasable = sp is not None

        skill_type = type_label(sid, rarity)
        # 300xxx のレアはストーリー/NPC用のダミー（評価点0・SPなし）なので特殊扱いにする
        if skill_type == "レア" and 300_000 <= sid < 400_000 and eval_point == 0 and sp is None:
            skill_type = "特殊"

        apt_distance, apt_style, apt_ground, apt_source = aptitude_for(r, skill_type)

        out.append(
            {
                "skill_id": sid,
                "name": r["name"],
                "type": skill_type,
                "rarity": rarity,
                "eval_point": eval_point,
                "sp": sp,
                "upgrade_point": upgrade_point,
                "efficiency": efficiency,
                "total_sp": total_sp,
                "total_efficiency": total_efficiency,
                "group_id": gid,
                "group_rate": rate,
                "prereq_sp": prereq_sp if chain else 0,
                "prereq_eval": prereq_eval if chain else 0,
                "category": r["category"],
                "category_label": CATEGORY_LABELS.get(r["category"], str(r["category"])),
                "purchasable": purchasable,
                "available": available,
                "description": r["description"],
                "start_date": r["start_date"],
                "end_date": r["end_date"],
                "apt_distance": apt_distance,
                "apt_style": apt_style,
                "apt_ground": apt_ground,
                "apt_source": apt_source,
                "_sort": sid,
            }
        )
    return out


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


def write_json(path: Path, rows: list[dict], meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"meta": meta, "skills": rows}
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)


def write_js(path: Path, rows: list[dict], meta: dict, cards: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # index.html から <script src="data/skills.js"> で読み込む
    with path.open("w", encoding="utf-8") as f:
        f.write("window.SKILL_DATA = ")
        json.dump(
            {"meta": meta, "skills": rows, "cards": cards},
            f,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        f.write(";\n")


def update_index_cache_version(index_path: Path, version: str) -> None:
    """index.html の data/skills.js の ?v= を更新してキャッシュを回避する。"""
    if not index_path.is_file():
        return
    with index_path.open("r", encoding="utf-8", newline="") as f:
        text = f.read()
    updated = re.sub(
        r'(src=["\']data/skills\.js)(?:\?v=[^"\']*)?(["\'])',
        rf"\1?v={version}\2",
        text,
        count=1,
    )
    if updated != text:
        with index_path.open("w", encoding="utf-8", newline="") as f:
            f.write(updated)


def extract_game_font(db_path: Path, out_path: Path) -> bool:
    """Unity の resources.assets からゲーム内フォントを抽出する。

    ライセンス上、抽出したフォントは Git にコミットしない（.gitignore 済み）。
    """
    try:
        resources = db_path.parents[2] / "resources.assets"
    except IndexError:
        return False
    if not resources.is_file():
        return False
    if out_path.is_file() and out_path.stat().st_mtime >= resources.stat().st_mtime:
        return True
    try:
        import UnityPy  # type: ignore
    except Exception as exc:
        print(f"[WARN] UnityPy が無いためフォント抽出をスキップします: {exc}")
        return False
    try:
        env = UnityPy.load(str(resources))
        for obj in env.objects:
            if obj.type.name != "Font":
                continue
            data = obj.read()
            name = getattr(data, "m_Name", "")
            if name not in ("Dynamic01", "Dynamic01_Normal_Horse"):
                continue
            font_data = getattr(data, "m_FontData", None)
            if not font_data:
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(bytes(font_data))
            print(f"フォント抽出: {name} -> {out_path}")
            return True
    except Exception as exc:
        print(f"[WARN] フォント抽出に失敗しました: {exc}")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="master.mdb からスキル評価点/SPを抽出")
    parser.add_argument("--db", default=os.environ.get("UMA_MASTER_DB", DEFAULT_DB), help="master.mdb のパス")
    parser.add_argument("--out", default="out", help="CSV/JSON の出力先ディレクトリ")
    parser.add_argument("--js", default="data/skills.js", help="index.html 用 JS の出力先")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.is_file():
        print(f"[ERROR] master.mdb が見つかりません: {db_path}", file=sys.stderr)
        return 2

    now = int(time.time())
    con = connect(db_path)
    raw = load_rows(con)
    cards = load_cards(con)
    con.close()

    if not raw:
        print("[ERROR] skill_data が空です。DB形式を確認してください。", file=sys.stderr)
        return 3

    rows = analyze(raw, now)

    meta = {
        "db_path": str(db_path),
        "db_mtime": datetime.fromtimestamp(db_path.stat().st_mtime).isoformat(timespec="seconds"),
        "generated_at": datetime.fromtimestamp(now).isoformat(timespec="seconds"),
        "total": len(rows),
        "cards": len(cards),
        "note": "eval_point=grade_value, sp=need_skill_point, upgrade_point=下位スキルからの上昇分, total_sp=下位込みSP",
    }

    out_dir = Path(args.out)
    write_csv(out_dir / "skills.csv", rows)
    write_csv(
        out_dir / "skills_purchasable.csv",
        [r for r in rows if r["purchasable"] and r["available"]],
    )
    write_json(out_dir / "skills.json", rows, meta)
    write_csv(out_dir / "skills_rating.csv", [r for r in rows if r["available"] and r["type"] != "特殊"])
    write_js(
        Path(args.js),
        [r for r in rows if r["available"] and r["type"] != "特殊"],
        meta,
        cards,
    )
    update_index_cache_version(Path(args.js).resolve().parent.parent / "index.html", str(now))
    font_path = Path(args.js).resolve().parent.parent / "assets" / "umamusume-font.ttf"
    extract_game_font(db_path, font_path)

    # レポート
    by_type = Counter(r["type"] for r in rows if r["available"])
    print(f"DB: {db_path}")
    print(f"最終更新: {meta['db_mtime']}  / 抽出: {meta['generated_at']}")
    print(f"スキル数: {len(rows)}  (期限切れ {sum(1 for r in rows if not r['available'])} 件を含む)")
    print(f"ウマ娘カード: {len(cards)} 件")
    print(f"ゲーム内フォント: {font_path}")
    print("種別:", ", ".join(f"{k}={v}" for k, v in by_type.most_common()))
    purch = [r for r in rows if r["purchasable"] and r["available"]]
    print(f"SP取得可能: {len(purch)} 件")
    print(f"出力: {out_dir / 'skills.csv'}")
    print(f"      {out_dir / 'skills_purchasable.csv'}")
    print(f"      {out_dir / 'skills.json'}")
    print(f"      {Path(args.js)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
