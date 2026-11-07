// 最適化の進行（予算・モード・結果の反映）。

import { state, saveSettings, saveSelection } from '../core/state.js';
import { byId } from '../core/data.js';
import { OPT_MAX_BUDGET } from '../core/constants.js';
import { $ } from '../core/utils.js';
import { addSkillWithChain, render } from './table.js';
import { renderCardEvolution, renderScenarioEvolution } from './evolution.js';
import { optimizerState, invalidateOptimization } from '../core/optimizer-state.js';
import {
  optimizerCandidates,
  packageValue,
  scenarioEvolutionContext,
  buildFamilies,
  sortChosen,
} from './optimizerCandidates.js';
import { runKnapsack } from './optimizerKnapsack.js';
import { renderSkillTestResult, renderEvalResult } from './optimizerView.js';

export { invalidateOptimization };

function optimizeSkills(budget, mode) {
  const candidates = optimizerCandidates();
  if (!candidates.length) return null;

  const scenario = scenarioEvolutionContext(candidates);
  const valuesBySkill = new Map();
  for (const s of candidates) valuesBySkill.set(s.skill_id, packageValue(s, mode));

  const groupList = buildFamilies(candidates);
  const knapsack = runKnapsack(groupList, valuesBySkill, budget, scenario, mode);
  if (!knapsack) return null;

  sortChosen(knapsack.chosen, mode, valuesBySkill);

  return {
    mode,
    chosen: knapsack.chosen,
    totalValue: knapsack.totalValue,
    totalEval: knapsack.totalValue,
    totalSp: knapsack.totalSp,
    efficiency:
      knapsack.totalSp > 0 ? knapsack.totalValue / knapsack.totalSp : null,
    candidates: candidates.length,
    groups: groupList.length,
    scenarioEvolutions: knapsack.chosen.filter((s) => scenario.ids.has(s.skill_id)).length,
    scenarioEvolutionLimit: scenario.limit,
    learnedScenarioEvolutions: scenario.learned,
    budget: Math.floor(budget),
    capped: budget > OPT_MAX_BUDGET,
  };
}

export function runOptimization() {
  const input = $('optBudget');
  const budget = Math.max(
    0,
    Math.min(OPT_MAX_BUDGET, Math.floor(Number(input.value) || 0))
  );
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
    renderSkillTestResult(result, elapsed, efficiency);
  } else {
    renderEvalResult(result, elapsed, efficiency);
  }
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
