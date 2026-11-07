// 適性フィルタ・適性倍率・評価点/SPの派生計算。

import { state } from './state.js';
import {
  SKILLS,
  byId,
  CHAINS,
  EVOLUTION_BASE_MAP,
} from './data.js';
import {
  APT_MULT,
  DISTANCE_META,
  STYLE_META,
  GROUND_META,
  UNIQUE_POINT_PER_LEVEL,
  INHERIT_UNIQUE_POINT,
} from './constants.js';
import { effectiveHint, applyHintDiscount } from './hints.js';
import { invalidateOptimization } from './optimizer-state.js';

export function parseAptList(value) {
  const parts = Array.isArray(value) ? value : String(value == null ? '' : value).split('/');
  return parts
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x >= 1 && x <= 4);
}

export function aptitudeText(s) {
  const parts = [];
  const distances = parseAptList(s.apt_distance);
  const styles = parseAptList(s.apt_style);
  const grounds = parseAptList(s.apt_ground);
  if (distances.length) {
    parts.push('距離 ' + distances.map((id) => DISTANCE_META[id].long).join('/'));
  }
  if (styles.length) {
    parts.push('脚質 ' + styles.map((id) => STYLE_META[id].long).join('/'));
  }
  if (grounds.length) {
    parts.push('馬場 ' + grounds.map((id) => GROUND_META[id].long).join('/'));
  }
  return parts.length ? parts.join('・') : 'なし';
}

// 適性フィルタ: 距離・馬場・脚質のいずれかの条件が一致すれば表示
export function skillMatchesAptFilter(s) {
  const filter = state.aptFilter;
  if (!filter.distance.size && !filter.ground.size && !filter.style.size) return true;
  const distances = parseAptList(s.apt_distance);
  const styles = parseAptList(s.apt_style);
  const grounds = parseAptList(s.apt_ground);
  if (!distances.length && !styles.length && !grounds.length) {
    return state.includeGeneral;
  }
  return (
    distances.some((id) => filter.distance.has(id)) ||
    styles.some((id) => filter.style.has(id)) ||
    grounds.some((id) => filter.ground.has(id))
  );
}

// 適性による評価点倍率。固有・継承固有は対象外。
export function aptitudeFactors(s) {
  if (s.type === '固有' || s.type === '継承固有') return [];
  const factors = [];
  const distances = parseAptList(s.apt_distance);
  const styles = parseAptList(s.apt_style);
  if (distances.length) {
    const mult = Math.max(...distances.map((id) =>
      APT_MULT[state.aptitude.distance[id] || 'A']));
    factors.push(mult);
  }
  if (styles.length) {
    const mult = Math.max(...styles.map((id) =>
      APT_MULT[state.aptitude.style[id] || 'A']));
    factors.push(mult);
  }
  return factors;
}

// uma-tools と同じく単精度で積算し、最後に四捨五入
export function adjustedEval(s) {
  if (s.type === '固有') return state.uniqueLevel * UNIQUE_POINT_PER_LEVEL;
  if (s.type === '継承固有') return INHERIT_UNIQUE_POINT;
  let value = Math.fround(Number(s.eval_point) || 0);
  for (const factor of aptitudeFactors(s)) {
    value = Math.fround(value * Math.fround(factor));
  }
  return Math.round(value);
}

// ヒントLv・切れ者・適性を反映した評価点/SP/効率を各スキルに持たせる
export function recomputeDerived() {
  // 1周目: 適性倍率を反映した評価点（下位スキル参照より先に全件計算）
  for (const s of SKILLS) {
    const factors = aptitudeFactors(s);
    s._apt_factor = factors.reduce((acc, factor) => acc * factor, 1);
    s._eval = adjustedEval(s);
  }

  // 2周目: SP割引・下位スキル連鎖・効率
  for (const s of SKILLS) {
    const hint = effectiveHint(s.skill_id);
    let sp = applyHintDiscount(s.sp, hint);
    let prereqSp = 0;
    let prereqSpBase = 0;
    let prereqEval = 0;
    for (const lower of CHAINS.get(s.skill_id) || []) {
      // 取得済みの下位スキルは、残りのSPコストに含めない
      if (!state.learnedSkillIds.has(lower.skill_id) && lower.sp != null) {
        prereqSp += applyHintDiscount(lower.sp, effectiveHint(lower.skill_id)) || 0;
        prereqSpBase += Number(lower.sp) || 0;
      }
      prereqEval = Math.max(prereqEval, lower._eval);
    }
    let totalSp = s.sp == null ? null : sp + prereqSp;
    let totalSpBase = s.sp == null ? null : (Number(s.sp) || 0) + prereqSpBase;
    let evolutionBase = null;
    let evolutionBaseTotalSp = null;

    // 進化スキルは進化元の金スキルのSPをコストとして扱う
    if (s.sp == null) {
      const baseId = EVOLUTION_BASE_MAP.get(s.skill_id);
      const base = baseId != null ? byId.get(baseId) : null;
      if (base && base.sp != null) {
        evolutionBase = base;
        const baseHint = effectiveHint(base.skill_id);
        const baseSp = applyHintDiscount(base.sp, baseHint);
        let basePrereqSp = 0;
        let basePrereqSpBase = 0;
        for (const lower of CHAINS.get(base.skill_id) || []) {
          if (!state.learnedSkillIds.has(lower.skill_id) && lower.sp != null) {
            basePrereqSp += applyHintDiscount(lower.sp, effectiveHint(lower.skill_id)) || 0;
            basePrereqSpBase += Number(lower.sp) || 0;
          }
        }
        sp = baseSp;
        prereqSp = basePrereqSp;
        prereqSpBase = basePrereqSpBase;
        totalSp = baseSp == null ? null : baseSp + basePrereqSp;
        totalSpBase = baseSp == null ? null : (Number(base.sp) || 0) + basePrereqSpBase;
        evolutionBaseTotalSp = totalSpBase;
        prereqEval = base._eval;
      }
    }

    s._hint = hint;
    s._sp = sp;
    s._total_sp = totalSp;
    s._total_sp_base = totalSpBase;
    s._prereq_sp = s.sp == null && !evolutionBase ? 0 : prereqSp;
    s._prereq_sp_base = s.sp == null && !evolutionBase ? 0 : prereqSpBase;
    s._prereq_eval = prereqEval;
    s._upgrade_point = s._eval - prereqEval;
    s._efficiency = sp != null && sp > 0 ? s._upgrade_point / sp : null;
    s._total_efficiency = totalSp != null && totalSp > 0 ? s._eval / totalSp : null;
    s._evolution_base = evolutionBase ? evolutionBase.skill_id : null;
    s._evolution_base_name = evolutionBase ? evolutionBase.name : '';
    s._evolution_base_total_sp = evolutionBaseTotalSp;
    s._evolution_base_prereq_sp = evolutionBase ? prereqSpBase : null;
  }

  invalidateOptimization();
}
