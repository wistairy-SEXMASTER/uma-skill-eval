// 最適化結果の描画。

import { OPT_MAX_BUDGET, skillTestBonus } from '../core/constants.js';
import { $, escapeHtml, formatNumber } from '../core/utils.js';
import {
  learnedBaseFor,
  displayHint,
  evolutionGain,
} from './optimizerCandidates.js';

function scenarioNote(result) {
  return (
    `<div class="opt-note">シナリオ進化は最大2個まで（選択 ` +
    `${formatNumber(result.learnedScenarioEvolutions + result.scenarioEvolutions)}/2）。</div>`
  );
}

function resultMetaNote(result, elapsed) {
  return (
    `<div class="opt-note">対象 ${formatNumber(result.candidates)} スキル` +
    `（${formatNumber(result.groups)} グループ）・計算 ${elapsed.toFixed(0)}ms` +
    (result.capped ? `・予算上限 ${formatNumber(OPT_MAX_BUDGET)}SP` : '') +
    `</div>`
  );
}

export function renderSkillTestResult(result, elapsed, efficiency) {
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
      const gainLabel =
        evoGain != null
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

  $('optResult').innerHTML =
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
    scenarioNote(result) +
    resultMetaNote(result, elapsed) +
    `<ol class="opt-list">${items}</ol>`;
}

export function renderEvalResult(result, elapsed, efficiency) {
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

  $('optResult').innerHTML =
    `<div class="opt-summary">最大評価点 <b>${formatNumber(result.totalValue)}</b> ／ ` +
    `合計SP <b>${formatNumber(result.totalSp)}</b> ／ 評価効率 <b>${efficiency}</b></div>` +
    `<div class="opt-note">ヒントLvの高い順に表示（同じLv内は上昇効率の高い順）。` +
    `同評価・同SPの組み合わせでは、上昇効率の合計が高いものを優先しています。` +
    `進化は進化元に対する増分が最大のものを選びます。</div>` +
    scenarioNote(result) +
    resultMetaNote(result, elapsed) +
    `<ol class="opt-list">${items}</ol>`;
}
