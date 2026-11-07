// 最適化の候補生成と、系統・進化・価値の計算。

import { state } from '../core/state.js';
import {
  byId,
  SKILLS,
  CHAINS,
  EVOLUTION_BASE_MAP,
  ALL_EVOLUTIONS_BY_BASE,
  CARD_GOLD_SKILL_EVOLUTIONS,
  SCENARIO_EVOLUTIONS,
  SUCCESSION_EVOLUTIONS_BY_BASE,
} from '../core/data.js';
import { skillTestBonus } from '../core/constants.js';
import { filteredSkills } from './filters.js';

// シナリオ進化は1回の育成で最大2個まで。
const SCENARIO_EVOLUTION_LIMIT = 2;

// 進化を持つ系統（group_id → 進化元の金スキルID）
const EVOLUTION_BASE_BY_GROUP = new Map();
for (const baseId of ALL_EVOLUTIONS_BY_BASE.keys()) {
  const base = byId.get(baseId);
  if (base) EVOLUTION_BASE_BY_GROUP.set(base.group_id, baseId);
}

// 現在のカード・シナリオ・継承で利用できる進化先を返す。
function availableEvolutionsForBase(baseId) {
  const out = [];
  const add = (id) => {
    if (!out.includes(id)) out.push(id);
  };
  if (state.cardId != null) {
    for (const entry of CARD_GOLD_SKILL_EVOLUTIONS[String(state.cardId)] || []) {
      if (entry.base_skill_id === baseId) add(entry.skill_id);
    }
  }
  if (state.scenarioId != null) {
    for (const entry of SCENARIO_EVOLUTIONS[String(state.scenarioId)] || []) {
      if (entry.base_skill_id === baseId) add(entry.skill_id);
    }
  }
  for (const id of SUCCESSION_EVOLUTIONS_BY_BASE.get(baseId) || []) add(id);
  return out;
}

// 進化先は進化元の系統（group_id）にまとめる。
function familyKey(s) {
  const baseId = EVOLUTION_BASE_MAP.get(s.skill_id);
  if (baseId != null) {
    const base = byId.get(baseId);
    if (base) return base.group_id;
  }
  return s.group_id;
}

// そのスキルを取る前に取得済みの、同じ系統の最上位スキル。
export function learnedBaseFor(s) {
  const baseId = EVOLUTION_BASE_MAP.get(s.skill_id);
  const candidates = [];
  if (baseId != null) {
    const base = byId.get(baseId);
    if (base) candidates.push(base);
    for (const lower of CHAINS.get(baseId) || []) candidates.push(lower);
  } else {
    for (const lower of CHAINS.get(s.skill_id) || []) candidates.push(lower);
  }
  let best = null;
  for (const candidate of candidates) {
    if (!state.learnedSkillIds.has(candidate.skill_id)) continue;
    if (
      !best ||
      (candidate.group_rate || 0) > (best.group_rate || 0) ||
      ((candidate.group_rate || 0) === (best.group_rate || 0) &&
        candidate._eval > best._eval)
    ) {
      best = candidate;
    }
  }
  return best;
}

// 同じ系統の最上位を取得済みなら、それ以上は候補にしない。
function familyMaxed(s) {
  const baseId = EVOLUTION_BASE_MAP.get(s.skill_id);
  if (baseId != null) {
    // 進化候補は、その進化自体を取得済みなら対象外。
    // 進化元を取得済みでも、進化はアップグレードとして残す。
    return state.learnedSkillIds.has(s.skill_id);
  }
  const groupBaseId = EVOLUTION_BASE_BY_GROUP.get(s.group_id);
  if (groupBaseId != null) {
    const evolutions = ALL_EVOLUTIONS_BY_BASE.get(groupBaseId) || [];
    if (evolutions.some((id) => state.learnedSkillIds.has(id))) return true;
    const base = byId.get(groupBaseId);
    const learned = [base, ...(CHAINS.get(groupBaseId) || [])].filter(
      (skill) => skill && state.learnedSkillIds.has(skill.skill_id)
    );
    return learned.some((skill) => skill.group_rate >= s.group_rate);
  }
  const learned = (CHAINS.get(s.skill_id) || []).filter((skill) =>
    state.learnedSkillIds.has(skill.skill_id)
  );
  return learned.some((skill) => skill.group_rate >= s.group_rate);
}

export function optimizerCandidates() {
  let pool;
  if (state.selected.size > 0) {
    // 選択中のスキルがある場合は、その選択だけを候補にする
    pool = [...state.selected].map((id) => byId.get(id)).filter(Boolean);
  } else {
    pool = state.optUseFilter ? filteredSkills() : SKILLS;
  }

  // 選択中の進化元から、現在使える進化先を候補に加える。
  const seen = new Set(pool.map((s) => s.skill_id));
  for (const s of [...pool]) {
    if (!ALL_EVOLUTIONS_BY_BASE.has(s.skill_id)) continue;
    for (const evoId of availableEvolutionsForBase(s.skill_id)) {
      if (seen.has(evoId)) continue;
      const evo = byId.get(evoId);
      if (!evo) continue;
      seen.add(evoId);
      pool.push(evo);
    }
  }

  return pool.filter(
    (s) =>
      s.type !== '特殊' &&
      !state.learnedSkillIds.has(s.skill_id) &&
      s.group_rate >= 0 &&
      s._total_sp != null &&
      s._total_sp >= 0 &&
      s._eval > 0 &&
      (s.sp != null || s._evolution_base != null) &&
      !familyMaxed(s)
  );
}

// 表示・並び順に使うヒントLv。進化は進化元のヒントLvを使う。
export function displayHint(s) {
  if (s._evolution_base != null) {
    const base = byId.get(s._evolution_base);
    if (base) return base._hint || 0;
  }
  return s._hint || 0;
}

// 進化元に対する増分。進化先を選ぶときの比較に使う。
export function evolutionGain(s, mode) {
  if (s._evolution_base == null) return null;
  const base = byId.get(s._evolution_base);
  if (!base) return null;
  if (mode === 'skillTest') {
    return (
      s._eval +
      skillTestBonus(s.type) -
      (base._eval + skillTestBonus(base.type))
    );
  }
  return s._eval - base._eval;
}

// スキル1つの価値。技能試験では評価点＋獲得ボーナスから、
// 取得済みの下位スキル分を差し引いた増分にする。
export function packageValue(s, mode) {
  if (mode !== 'skillTest') return s._eval;
  const base = learnedBaseFor(s);
  const baseValue = base ? base._eval + skillTestBonus(base.type) : 0;
  return s._eval + skillTestBonus(s.type) - baseValue;
}

// 同価値・同SPの組み合わせで使う効率。
export function packageEfficiency(s, mode, value) {
  if (mode === 'skillTest') {
    if (s._total_sp > 0) return value / s._total_sp;
    return value;
  }
  if (s._efficiency != null) return s._efficiency;
  if (s._sp > 0) return s._upgrade_point / s._sp;
  return 0;
}

export function scenarioEvolutionContext(candidates) {
  const ids = new Set(
    (SCENARIO_EVOLUTIONS[String(state.scenarioId)] || []).map((e) => e.skill_id)
  );
  const learned = [...state.learnedSkillIds].filter((id) => ids.has(id)).length;
  const hasCandidate = candidates.some((s) => ids.has(s.skill_id));
  return {
    ids,
    learned,
    limit: hasCandidate ? Math.max(0, SCENARIO_EVOLUTION_LIMIT - learned) : 0,
  };
}

// 系統ごとに候補をまとめる。
export function buildFamilies(candidates) {
  const groups = new Map();
  for (const s of candidates) {
    const key = familyKey(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()];
}

// 結果はヒントLvの高い順。同じLv内は効率の高い順。
export function sortChosen(chosen, mode, valuesBySkill) {
  chosen.sort(
    (a, b) =>
      displayHint(b) - displayHint(a) ||
      packageEfficiency(b, mode, valuesBySkill.get(b.skill_id) ?? 0) -
        packageEfficiency(a, mode, valuesBySkill.get(a.skill_id) ?? 0) ||
      a.group_id - b.group_id ||
      a.group_rate - b.group_rate ||
      a.skill_id - b.skill_id
  );
}
