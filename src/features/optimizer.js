// 獲得SP予算から合計評価点が最大になるスキル組み合わせを求める。

import { state, saveSettings, saveSelection } from '../core/state.js';
import { byId, SKILLS } from '../core/data.js';
import { OPT_MAX_BUDGET } from '../core/constants.js';
import { $, escapeHtml, formatNumber } from '../core/utils.js';
import { filteredSkills } from './filters.js';
import { addSkillWithChain, render } from './table.js';
import { optimizerState, invalidateOptimization } from '../core/optimizer-state.js';

export { invalidateOptimization };

function optimizerCandidates() {
  let pool;
  if (state.selected.size > 0) {
    // 選択中のスキルがある場合は、その選択だけを候補にする
    pool = [...state.selected].map((id) => byId.get(id)).filter(Boolean);
  } else {
    pool = state.optUseFilter ? filteredSkills() : SKILLS;
  }
  return pool.filter((s) =>
    s.sp != null && s.sp > 0 &&
    s._total_sp != null && s._total_sp > 0 &&
    s._eval > 0 &&
    s.group_rate >= 0 &&
    s.type !== '特殊'
  );
}

// スキル単体の上昇効率。表の「上昇効率」と同じく
// （このスキルの評価点 − 直下の下位スキルの評価点）÷ このスキルのSP。
function packageEfficiency(s) {
  if (s._efficiency != null) return s._efficiency;
  if (s._sp > 0) return s._upgrade_point / s._sp;
  return 0;
}

// グループごとに「どの上位段階まで取るか」を選ぶ多重選択ナップサック。
// 価値 = 適性込み評価点、コスト = 下位込みSP（ヒント・切れ者込み）。
// 合計評価点を最大化したうえで、同評価・同SPの組み合わせが複数ある場合は
// 上昇効率の合計が高いものを選ぶ。
function optimizeSkills(budget) {
  const candidates = optimizerCandidates();
  if (!candidates.length) return null;

  const groups = new Map();
  for (const s of candidates) {
    const list = groups.get(s.group_id);
    if (list) list.push(s);
    else groups.set(s.group_id, [s]);
  }
  const groupList = [...groups.values()];
  const sumMax = groupList.reduce(
    (sum, packages) => sum + Math.max(...packages.map((p) => p._total_sp)),
    0
  );
  const maxBudget = Math.max(0, Math.min(Math.floor(budget), OPT_MAX_BUDGET, sumMax));
  const dp = new Float64Array(maxBudget + 1).fill(-Infinity);
  const efficiencyDp = new Float64Array(maxBudget + 1).fill(-Infinity);
  dp[0] = 0;
  efficiencyDp[0] = 0;

  const choices = [];
  for (const packages of groupList) {
    const costs = packages.map((p) => p._total_sp);
    const values = packages.map((p) => p._eval);
    const efficiencies = packages.map(packageEfficiency);
    const choice = new Int16Array(maxBudget + 1).fill(-1);
    for (let b = maxBudget; b >= 0; b--) {
      let best = dp[b];
      let bestEfficiency = efficiencyDp[b];
      let bestIdx = -1;
      for (let i = 0; i < packages.length; i++) {
        const cost = costs[i];
        if (cost > b) continue;
        const prev = dp[b - cost];
        if (prev === -Infinity) continue;
        const value = prev + values[i];
        const efficiency = efficiencyDp[b - cost] + efficiencies[i];
        const betterValue = value > best;
        const betterEfficiency =
          value === best && efficiency > bestEfficiency + 1e-9;
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
      dp[b] = best;
      efficiencyDp[b] = bestEfficiency;
      choice[b] = bestIdx;
    }
    choices.push(choice);
  }

  let bestBudget = -1;
  let bestValue = -Infinity;
  for (let b = 0; b <= maxBudget; b++) {
    if (dp[b] > bestValue) {
      bestValue = dp[b];
      bestBudget = b;
    }
  }
  if (bestBudget < 0 || bestValue === -Infinity) return null;

  const chosen = [];
  let b = bestBudget;
  for (let g = groupList.length - 1; g >= 0; g--) {
    const idx = choices[g][b];
    if (idx >= 0) {
      const skill = groupList[g][idx];
      chosen.push(skill);
      b -= skill._total_sp;
    }
  }
  // 結果はヒントLvの高い順に並べる。同じLv内は上昇効率の高い順。
  chosen.sort((a, b2) =>
    (b2._hint || 0) - (a._hint || 0) ||
    packageEfficiency(b2) - packageEfficiency(a) ||
    a.group_id - b2.group_id ||
    a.group_rate - b2.group_rate ||
    a.skill_id - b2.skill_id
  );

  return {
    chosen,
    totalEval: bestValue,
    totalSp: bestBudget,
    efficiency: bestBudget > 0 ? bestValue / bestBudget : null,
    candidates: candidates.length,
    groups: groupList.length,
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

  const started = performance.now();
  const result = optimizeSkills(budget);
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
  const items = result.chosen.map((s) => {
    const upgradeEff = s._efficiency == null ? '—' : s._efficiency.toFixed(2);
    const totalEff = s._total_efficiency == null ? '—' : s._total_efficiency.toFixed(2);
    return `<li>${escapeHtml(s.name)}` +
      `<span class="opt-meta">ヒントLv ${s._hint || 0}` +
      ` / SP ${formatNumber(s._total_sp)} / 評価 ${formatNumber(s._eval)}` +
      ` / 上昇効率 ${upgradeEff} / 総合効率 ${totalEff}</span></li>`;
  }).join('');
  out.innerHTML =
    `<div class="opt-summary">最大評価点 <b>${formatNumber(result.totalEval)}</b> ／ ` +
    `合計SP <b>${formatNumber(result.totalSp)}</b> ／ 評価効率 <b>${efficiency}</b></div>` +
    `<div class="opt-note">ヒントLvの高い順に表示（同じLv内は上昇効率の高い順）。` +
    `同評価・同SPの組み合わせでは、上昇効率の合計が高いものを優先しています。</div>` +
    `<div class="opt-note">対象 ${formatNumber(result.candidates)} スキル` +
    `（${formatNumber(result.groups)} グループ）・計算 ${elapsed.toFixed(0)}ms` +
    (result.capped ? `・予算上限 ${formatNumber(OPT_MAX_BUDGET)}SP` : '') +
    `</div>` +
    `<ol class="opt-list">${items}</ol>`;
}

export function applyOptimizationResult() {
  if (!optimizerState.last || !optimizerState.last.chosen.length) return;
  // SP対象外（固有など）の選択は保持し、SP取得スキルだけを入れ替える
  const keep = [...state.selected]
    .map((id) => byId.get(id))
    .filter((s) => s && s.sp == null);
  const next = new Set(keep.map((s) => s.skill_id));
  for (const s of optimizerState.last.chosen) addSkillWithChain(s.skill_id, next);
  state.selected = next;
  saveSelection();
  render();
}
