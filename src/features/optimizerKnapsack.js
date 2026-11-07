// 系統ごとの多重選択ナップサック（2次元DP）。

import { OPT_MAX_BUDGET } from '../core/constants.js';
import { packageEfficiency } from './optimizerCandidates.js';

// dp[選んだシナリオ進化の数][SP] の2次元DP。
export function runKnapsack(groupList, valuesBySkill, budget, scenario, mode) {
  const sumMax = groupList.reduce(
    (sum, packages) => sum + Math.max(...packages.map((p) => p._total_sp)),
    0
  );
  const maxBudget = Math.max(0, Math.min(Math.floor(budget), OPT_MAX_BUDGET, sumMax));

  const layers = scenario.limit + 1;
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
    const isScenarioEvolution = packages.map((p) => scenario.ids.has(p.skill_id));
    const groupChoices = Array.from({ length: layers }, () =>
      new Int16Array(maxBudget + 1).fill(-1)
    );

    for (let k = scenario.limit; k >= 0; k--) {
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
    for (let k = 0; k <= scenario.limit; k++) {
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
      if (scenario.ids.has(skill.skill_id)) k -= 1;
    }
  }

  return { chosen, totalValue: bestValue, totalSp: bestBudget };
}
