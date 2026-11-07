// 獲得SP予算から、合計評価点（または技能試験スコア）が最大になる
// スキル組み合わせを求める。

import { state, saveSettings, saveSelection } from '../core/state.js';
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
import { OPT_MAX_BUDGET, skillTestBonus } from '../core/constants.js';
import { $, escapeHtml, formatNumber } from '../core/utils.js';
import { filteredSkills } from './filters.js';
import { addSkillWithChain, render } from './table.js';
import { renderCardEvolution, renderScenarioEvolution } from './evolution.js';
import { optimizerState, invalidateOptimization } from '../core/optimizer-state.js';

export { invalidateOptimization };

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
function learnedBaseFor(s) {
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

function optimizerCandidates() {
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
function displayHint(s) {
  if (s._evolution_base != null) {
    const base = byId.get(s._evolution_base);
    if (base) return base._hint || 0;
  }
  return s._hint || 0;
}

// 進化元に対する増分。進化先を選ぶときの比較に使う。
function evolutionGain(s, mode) {
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
function packageValue(s, mode) {
  if (mode !== 'skillTest') return s._eval;
  const base = learnedBaseFor(s);
  const baseValue = base ? base._eval + skillTestBonus(base.type) : 0;
  return s._eval + skillTestBonus(s.type) - baseValue;
}

// 同価値・同SPの組み合わせで使う効率。
function packageEfficiency(s, mode, value) {
  if (mode === 'skillTest') {
    if (s._total_sp > 0) return value / s._total_sp;
    return value;
  }
  if (s._efficiency != null) return s._efficiency;
  if (s._sp > 0) return s._upgrade_point / s._sp;
  return 0;
}

// 系統ごとに「どの段階・進化を取るか」を選ぶ多重選択ナップサック。
// 価値 = 評価点（技能試験では評価点＋ボーナスの増分）、
// コスト = 下位込みSP（ヒント・切れ者込み）。
function optimizeSkills(budget, mode) {
  const candidates = optimizerCandidates();
  if (!candidates.length) return null;

  // シナリオ進化は1回の育成で最大2個まで。
  const scenarioEvolutionIds = new Set(
    (SCENARIO_EVOLUTIONS[String(state.scenarioId)] || []).map((e) => e.skill_id)
  );
  const learnedScenarioEvolutions = [...state.learnedSkillIds].filter((id) =>
    scenarioEvolutionIds.has(id)
  ).length;
  const hasScenarioEvolutionCandidate = candidates.some((s) =>
    scenarioEvolutionIds.has(s.skill_id)
  );
  const scenarioEvolutionLimit = hasScenarioEvolutionCandidate
    ? Math.max(0, 2 - learnedScenarioEvolutions)
    : 0;

  const valuesBySkill = new Map();
  for (const s of candidates) valuesBySkill.set(s.skill_id, packageValue(s, mode));

  const groups = new Map();
  for (const s of candidates) {
    const key = familyKey(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const groupList = [...groups.values()];
  const sumMax = groupList.reduce(
    (sum, packages) => sum + Math.max(...packages.map((p) => p._total_sp)),
    0
  );
  const maxBudget = Math.max(0, Math.min(Math.floor(budget), OPT_MAX_BUDGET, sumMax));

  // dp[選んだシナリオ進化の数][SP] の2次元DP。
  const layers = scenarioEvolutionLimit + 1;
  const dp = Array.from({ length: layers }, () =>
    new Float64Array(maxBudget + 1).fill(-Infinity)
  );
  const efficiencyDp = Array.from({ length: layers }, () =>
    new Float64Array(maxBudget + 1).fill(-Infinity)
  );
  dp[0][0] = 0;
  efficiencyDp[0][0] = 0;

  const choices = [];
  for (const packages of groupList) {
    const costs = packages.map((p) => p._total_sp);
    const values = packages.map((p) => valuesBySkill.get(p.skill_id) ?? 0);
    const efficiencies = packages.map((p, i) => packageEfficiency(p, mode, values[i]));
    const isScenarioEvolution = packages.map((p) =>
      scenarioEvolutionIds.has(p.skill_id)
    );
    const groupChoices = Array.from({ length: layers }, () =>
      new Int16Array(maxBudget + 1).fill(-1)
    );
    for (let k = scenarioEvolutionLimit; k >= 0; k--) {
      const dpLayer = dp[k];
      const efficiencyLayer = efficiencyDp[k];
      const choiceLayer = groupChoices[k];
      for (let b = maxBudget; b >= 0; b--) {
        let best = dpLayer[b];
        let bestEfficiency = efficiencyLayer[b];
        let bestIdx = -1;
        for (let i = 0; i < packages.length; i++) {
          const cost = costs[i];
          if (cost > b) continue;
          const need = isScenarioEvolution[i] ? 1 : 0;
          if (k < need) continue;
          const prev = dp[k - need][b - cost];
          if (prev === -Infinity) continue;
          const value = prev + values[i];
          const efficiency = efficiencyDp[k - need][b - cost] + efficiencies[i];
          const betterValue = value > best;
          const betterEfficiency = value === best && efficiency > bestEfficiency + 1e-9;
          const cheaperTie =
            value === best &&
            Math.abs(efficiency - bestEfficiency) <= 1e-9 &&
            bestIdx !== -1 &&
            cost < costs[bestIdx];
          if (betterValue || betterEfficiency || cheaperTie) {
            best = value;
            bestEfficiency = efficiency;
            bestIdx = i;
          }
        }
        dpLayer[b] = best;
        efficiencyLayer[b] = bestEfficiency;
        choiceLayer[b] = bestIdx;
      }
    }
    choices.push(groupChoices);
  }

  let bestK = 0;
  let bestBudget = -1;
  let bestValue = -Infinity;
  for (let b = 0; b <= maxBudget; b++) {
    for (let k = 0; k <= scenarioEvolutionLimit; k++) {
      if (dp[k][b] > bestValue) {
        bestValue = dp[k][b];
        bestBudget = b;
        bestK = k;
      }
    }
  }
  if (bestBudget < 0 || bestValue === -Infinity) return null;

  const chosen = [];
  let b = bestBudget;
  let k = bestK;
  for (let g = groupList.length - 1; g >= 0; g--) {
    const idx = choices[g][k][b];
    if (idx >= 0) {
      const skill = groupList[g][idx];
      chosen.push(skill);
      b -= skill._total_sp;
      if (scenarioEvolutionIds.has(skill.skill_id)) k -= 1;
    }
  }
  // 結果はヒントLvの高い順。同じLv内は効率の高い順。
  chosen.sort(
    (a, b2) =>
      displayHint(b2) - displayHint(a) ||
      packageEfficiency(b2, mode, valuesBySkill.get(b2.skill_id) ?? 0) -
        packageEfficiency(a, mode, valuesBySkill.get(a.skill_id) ?? 0) ||
      a.group_id - b2.group_id ||
      a.group_rate - b2.group_rate ||
      a.skill_id - b2.skill_id
  );

  return {
    mode,
    chosen,
    totalValue: bestValue,
    totalEval: bestValue,
    totalSp: bestBudget,
    efficiency: bestBudget > 0 ? bestValue / bestBudget : null,
    candidates: candidates.length,
    groups: groupList.length,
    scenarioEvolutions: chosen.filter((s) => scenarioEvolutionIds.has(s.skill_id)).length,
    scenarioEvolutionLimit,
    learnedScenarioEvolutions,
    budget: Math.floor(budget),
    capped: budget > OPT_MAX_BUDGET,
  };
}

export function runOptimization() {
  const input = $('optBudget');
  const budget = Math.max(0, Math.min(OPT_MAX_BUDGET, Math.floor(Number(input.value) || 0)));
  state.optBudget = budget;
  if (input) input.value = String(budget);
  saveSettings();

  const mode = state.optMode === 'skillTest' ? 'skillTest' : 'eval';
  const started = performance.now();
  const result = optimizeSkills(budget, mode);
  const elapsed = performance.now() - started;
  optimizerState.last = result;

  const out = $('optResult');
  const apply = $('btnApplyOpt');
  if (!result || !result.chosen.length) {
    out.innerHTML =
      '<div class="opt-note">条件に合うSP取得可能スキルがありません。絞り込み条件や予算を確認してください。</div>';
    if (apply) apply.disabled = true;
    return;
  }
  if (apply) apply.disabled = false;

  const efficiency = result.efficiency == null ? '—' : result.efficiency.toFixed(2);

  if (mode === 'skillTest') {
    let evalTotal = 0;
    let bonusTotal = 0;
    let ownedTotal = 0;
    const items = result.chosen
      .map((s) => {
        const base = learnedBaseFor(s);
        const baseValue = base ? base._eval + skillTestBonus(base.type) : 0;
        const bonus = skillTestBonus(s.type);
        const gain = s._eval + bonus - baseValue;
        const evoGain = evolutionGain(s, 'skillTest');
        const gainLabel = evoGain != null
          ? `進化 +${formatNumber(evoGain)}`
          : `増分 ${formatNumber(gain)}`;
        evalTotal += s._eval;
        bonusTotal += bonus;
        ownedTotal += baseValue;
        return (
          `<li>${escapeHtml(s.name)}` +
          `<span class="opt-meta">ヒントLv ${displayHint(s)}` +
          ` / SP ${formatNumber(s._total_sp)} / 評価 ${formatNumber(s._eval)}` +
          ` / ボーナス ${formatNumber(bonus)} / ${gainLabel}</span></li>`
        );
      })
      .join('');
    out.innerHTML =
      `<div class="opt-summary">最大スコア（追加） <b>${formatNumber(result.totalValue)}</b> ／ ` +
      `合計SP <b>${formatNumber(result.totalSp)}</b> ／ スコア効率 <b>${efficiency}</b></div>` +
      `<div class="opt-note">技能試験（フリー課程）: 評価点 ${formatNumber(evalTotal)}` +
      ` + 獲得ボーナス ${formatNumber(bonusTotal)}` +
      (ownedTotal ? ` − 取得済み分 ${formatNumber(ownedTotal)}` : '') +
      ` = <b>${formatNumber(result.totalValue)}</b>。基礎能力ボーナスは含みません。</div>` +
      `<div class="opt-note">系統ごとに最上位1個の獲得ボーナスを加算し、` +
      `取得済みの下位スキル分は増分で計算しています。` +
      `進化は進化元に対する増分が最大のものを選びます。` +
      `ヒントLvの高い順に表示（同じLv内は効率順）。</div>` +
      `<div class="opt-note">シナリオ進化は最大2個まで（選択 ` +
      `${formatNumber(result.learnedScenarioEvolutions + result.scenarioEvolutions)}/2）。</div>` +
      `<div class="opt-note">対象 ${formatNumber(result.candidates)} スキル` +
      `（${formatNumber(result.groups)} グループ）・計算 ${elapsed.toFixed(0)}ms` +
      (result.capped ? `・予算上限 ${formatNumber(OPT_MAX_BUDGET)}SP` : '') +
      `</div>` +
      `<ol class="opt-list">${items}</ol>`;
    return;
  }

  const items = result.chosen
    .map((s) => {
      const upgradeEff = s._efficiency == null ? '—' : s._efficiency.toFixed(2);
      const totalEff = s._total_efficiency == null ? '—' : s._total_efficiency.toFixed(2);
      const evoGain = evolutionGain(s, 'eval');
      const evoText = evoGain != null ? ` / 進化 +${formatNumber(evoGain)}` : '';
      return (
        `<li>${escapeHtml(s.name)}` +
        `<span class="opt-meta">ヒントLv ${displayHint(s)}` +
        ` / SP ${formatNumber(s._total_sp)} / 評価 ${formatNumber(s._eval)}` +
        ` / 上昇効率 ${upgradeEff} / 総合効率 ${totalEff}${evoText}</span></li>`
      );
    })
    .join('');
  out.innerHTML =
    `<div class="opt-summary">最大評価点 <b>${formatNumber(result.totalValue)}</b> ／ ` +
    `合計SP <b>${formatNumber(result.totalSp)}</b> ／ 評価効率 <b>${efficiency}</b></div>` +
    `<div class="opt-note">ヒントLvの高い順に表示（同じLv内は上昇効率の高い順）。` +
    `同評価・同SPの組み合わせでは、上昇効率の合計が高いものを優先しています。` +
    `進化は進化元に対する増分が最大のものを選びます。</div>` +
    `<div class="opt-note">シナリオ進化は最大2個まで（選択 ` +
    `${formatNumber(result.learnedScenarioEvolutions + result.scenarioEvolutions)}/2）。</div>` +
    `<div class="opt-note">対象 ${formatNumber(result.candidates)} スキル` +
    `（${formatNumber(result.groups)} グループ）・計算 ${elapsed.toFixed(0)}ms` +
    (result.capped ? `・予算上限 ${formatNumber(OPT_MAX_BUDGET)}SP` : '') +
    `</div>` +
    `<ol class="opt-list">${items}</ol>`;
}

export function applyOptimizationResult() {
  if (!optimizerState.last || !optimizerState.last.chosen.length) return;
  // SP対象外（固有など）の選択は保持し、SP取得スキルと進化は入れ替える。
  const keep = [...state.selected]
    .map((id) => byId.get(id))
    .filter((s) => s && s.sp == null && s._evolution_base == null);
  const next = new Set(keep.map((s) => s.skill_id));
  for (const s of optimizerState.last.chosen) addSkillWithChain(s.skill_id, next);
  // 下位スキルとして追加された取得済みスキルは選択から外す。
  for (const id of state.learnedSkillIds) next.delete(id);
  state.selected = next;
  saveSelection();
  renderCardEvolution();
  renderScenarioEvolution();
  render();
}
