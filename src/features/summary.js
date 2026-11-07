// 選択スキルの合計評価点・合計SP・総合効率の計算。

import { state } from '../core/state.js';
import { byId, EVOLUTION_BASE_MAP } from '../core/data.js';
import { $, formatNumber, escapeHtml } from '../core/utils.js';

export function computeSummary() {
  const selected = [...state.selected].map((id) => byId.get(id)).filter(Boolean);
  const evolvedGroupIds = new Set();
  for (const s of selected) {
    const baseId = EVOLUTION_BASE_MAP.get(s.skill_id);
    if (baseId != null) {
      const base = byId.get(baseId);
      if (base) evolvedGroupIds.add(base.group_id);
    }
  }
  const groups = new Map();
  for (const s of selected) {
    // 進化スキルを選択している場合、進化元の金スキルグループは集計しない
    if (evolvedGroupIds.has(s.group_id)) continue;
    const cur = groups.get(s.group_id);
    if (!cur) {
      groups.set(s.group_id, s);
      continue;
    }
    if (s.group_rate > cur.group_rate ||
        (s.group_rate === cur.group_rate && s._eval > cur._eval)) {
      groups.set(s.group_id, s);
    }
  }
  const counted = [...groups.values()];
  const countedSet = new Set(counted.map((s) => s.skill_id));
  let evalTotal = 0;
  let spTotal = 0;
  let spBaseTotal = 0;
  let evalNoSp = 0;
  for (const s of counted) {
    evalTotal += Number(s._eval) || 0;
    if (s._total_sp != null) spTotal += Number(s._total_sp) || 0;
    else evalNoSp += Number(s._eval) || 0;
    if (s._total_sp_base != null) spBaseTotal += Number(s._total_sp_base) || 0;
    else if (s.total_sp != null) spBaseTotal += Number(s.total_sp) || 0;
    else if (s._evolution_base_total_sp != null) spBaseTotal += Number(s._evolution_base_total_sp) || 0;
  }
  const overridden = selected.filter((s) => !countedSet.has(s.skill_id));
  return {
    selected,
    counted,
    overridden,
    evalTotal,
    spTotal,
    spBaseTotal,
    evalNoSp,
    efficiency: spTotal > 0 ? evalTotal / spTotal : null,
  };
}

export function updateSummary() {
  const sum = computeSummary();
  $('statCount').textContent = formatNumber(sum.selected.length);
  $('statEval').textContent = formatNumber(sum.evalTotal);
  $('statSp').textContent = formatNumber(sum.spTotal);
  $('statNoSp').textContent = formatNumber(sum.evalNoSp);
  const eff = $('statEff');
  if (sum.efficiency == null) {
    eff.textContent = '—';
    eff.classList.add('na');
  } else {
    eff.textContent = sum.efficiency.toFixed(2);
    eff.classList.remove('na');
  }
  const note = $('cartNote');
  const hintCount = sum.counted.filter((s) => s._hint > 0).length;
  const settingBits = [];
  if (hintCount) settingBits.push(`ヒントLv ${formatNumber(hintCount)}件`);
  if (state.fastLearner) settingBits.push('切れ者');
  const settingText = settingBits.length
    ? `選択中に ${settingBits.join(' / ')} のSP割引を適用中。`
    : '';
  const savedText = settingText && sum.spBaseTotal > sum.spTotal
    ? ` 割引前 ${formatNumber(sum.spBaseTotal)} SP → ${formatNumber(sum.spTotal)} SP。`
    : '';
  const aptCount = sum.counted.filter((s) => s._apt_factor !== 1).length;
  const aptText = aptCount ? ` 適性倍率を ${formatNumber(aptCount)} 件に適用。` : '';
  if (!sum.selected.length) {
    note.innerHTML = 'スキルを選択すると、合計評価点・合計SP・総合効率を計算します。';
  } else if (sum.overridden.length) {
    note.innerHTML =
      `<span class="warn">集計外 ${formatNumber(sum.overridden.length)} 件</span>` +
      `（集計対象 ${formatNumber(sum.counted.length)} 件）。` +
      `上位スキル・進化スキルを選択すると、未取得の下位スキルのSPを含めて計算されます。` +
      escapeHtml(settingText + aptText + savedText);
  } else {
    note.textContent =
      `選択 ${formatNumber(sum.selected.length)} 件を集計。` +
      (sum.evalNoSp ? ` SP対象外の評価点 ${formatNumber(sum.evalNoSp)} を含みます。` : '') +
      settingText + aptText + savedText;
  }
  $('btnClear').disabled = sum.selected.length === 0;
  $('btnCsv').disabled = sum.counted.length === 0;
}
