// 選択スキルのCSV出力。

import { state } from '../core/state.js';
import { csvCell } from '../core/utils.js';
import { computeSummary } from './summary.js';

export function exportCsv() {
  const sum = computeSummary();
  if (!sum.counted.length) return;
  const rows = [...sum.counted].sort((a, b) =>
    a.group_id - b.group_id || a.group_rate - b.group_rate || a.skill_id - b.skill_id
  );
  const header = [
    'skill_id', 'name', 'type', 'rarity',
    'eval_base', 'eval_point', 'aptitude_distance', 'aptitude_style', 'aptitude_ground',
    'aptitude_multiplier', 'aptitude_source',
    'unique_level', 'fast_learner',
    'sp_base', 'hint_level', 'sp',
    'upgrade_point', 'efficiency',
    'total_sp_base', 'total_sp', 'total_efficiency',
    'group_id', 'group_rate', 'prereq_sp_base', 'prereq_sp', 'prereq_eval',
    'category', 'category_label', 'effect_category', 'description',
  ];
  const lines = [header.join(',')];
  for (const s of rows) {
    const out = {
      ...s,
      eval_base: s.eval_point,
      eval_point: s._eval,
      aptitude_ground: s.apt_ground || '',
      aptitude_multiplier: Math.round(s._apt_factor * 1000) / 1000,
      aptitude_source: s.apt_source || '',
      unique_level: state.uniqueLevel,
      fast_learner: state.fastLearner ? 1 : 0,
      sp_base: s.sp,
      hint_level: s._hint,
      sp: s._sp,
      upgrade_point: s._upgrade_point,
      efficiency: s._efficiency == null ? null : Math.round(s._efficiency * 1000) / 1000,
      total_sp_base: s._total_sp_base,
      total_sp: s._total_sp,
      total_efficiency: s._total_efficiency == null ? null : Math.round(s._total_efficiency * 1000) / 1000,
      prereq_sp_base: s._prereq_sp_base,
      prereq_sp: s._prereq_sp,
      prereq_eval: s._prereq_eval,
    };
    lines.push(header.map((k) => csvCell(out[k])).join(','));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') + '_' +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0');
  const a = document.createElement('a');
  a.href = url;
  a.download = `uma_skill_selection_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
