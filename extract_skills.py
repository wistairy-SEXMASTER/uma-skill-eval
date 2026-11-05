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
]


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
            }
        )
    return rows


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


def write_js(path: Path, rows: list[dict], meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # index.html から <script src="data/skills.js"> で読み込む
    with path.open("w", encoding="utf-8") as f:
        f.write("window.SKILL_DATA = ")
        json.dump({"meta": meta, "skills": rows}, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")


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
    write_js(Path(args.js), [r for r in rows if r["available"] and r["type"] != "特殊"], meta)

    # レポート
    by_type = Counter(r["type"] for r in rows if r["available"])
    print(f"DB: {db_path}")
    print(f"最終更新: {meta['db_mtime']}  / 抽出: {meta['generated_at']}")
    print(f"スキル数: {len(rows)}  (期限切れ {sum(1 for r in rows if not r['available'])} 件を含む)")
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
