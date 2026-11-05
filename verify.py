# -*- coding: utf-8 -*-
import json, io
data = json.load(open("out/skills.json", encoding="utf-8"))
skills = data["skills"]
by_name = {}
for s in skills:
    by_name.setdefault(s["name"], []).append(s)

out = io.StringIO()
def p(*a): print(*a, file=out)
for name in ["円弧のマエストロ","先手必勝","右回り◎","右回り○","右回りの鬼","コンセントレーション","集中力","地固め","中距離直線◎","シューティングスター","脱兎の先へ"]:
    for s in by_name.get(name, []):
        p(name, {k: s[k] for k in ("skill_id","type","eval_point","sp","upgrade_point","efficiency","total_sp","total_efficiency","group_id","group_rate","prereq_sp","prereq_eval")})

p("\n=== top total_efficiency (purchasable, sp>=50) ===")
rows = [s for s in skills if s["purchasable"] and s["available"] and s["sp"] and s["sp"]>=50]
for s in sorted(rows, key=lambda x: -(x["total_efficiency"] or -999))[:15]:
    p(s["name"], s["type"], "eval",s["eval_point"],"sp",s["sp"],"totSP",s["total_sp"],"totEff",s["total_efficiency"])
with open("verify.txt","w",encoding="utf-8") as f: f.write(out.getvalue())
print("ok")
