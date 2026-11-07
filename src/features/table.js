// スキル一覧テーブルの描画・ソート・選択。

import { state, saveSelection } from '../core/state.js';
import { SKILLS, CHAINS } from '../core/data.js';
import {
  TYPE_CLASS,
  EFFECT_CLASS,
  DERIVED_KEYS,
  TYPE_RANK,
  UNIQUE_POINT_PER_LEVEL,
  INHERIT_UNIQUE_POINT,
} from '../core/constants.js';
import { $, escapeHtml, formatNumber } from '../core/utils.js';
import { discountPct, spDiscountRate } from '../core/hints.js';
import { aptitudeText } from '../core/aptitude.js';
import { computeSummary, updateSummary } from './summary.js';
import { filteredSkills } from './filters.js';

export function compareSkills(a, b) {
  const key = state.sortKey;
  const dir = state.sortDir;
  let r = 0;
  if (key === 'name') {
    r = a.name.localeCompare(b.name, 'ja');
  } else if (key === 'type') {
    r = (TYPE_RANK.get(a.type) ?? 99) - (TYPE_RANK.get(b.type) ?? 99);
    if (r === 0) r = a.name.localeCompare(b.name, 'ja');
  } else {
    const dkey = DERIVED_KEYS[key] || key;
    const av = a[dkey];
    const bv = b[dkey];
    if (av == null && bv == null) r = 0;
    else if (av == null) r = 1;
    else if (bv == null) r = -1;
    else r = dir === 'asc' ? av - bv : bv - av;
    if (r === 0) r = b._eval - a._eval;
    if (r === 0) r = a.skill_id - b.skill_id;
  }
  if (dir === 'desc' && (key === 'name' || key === 'type')) r = -r;
  return r;
}

function typeBadge(type) {
  return `<span class="badge type-${TYPE_CLASS[type] || 'other'}">${escapeHtml(type)}</span>`;
}

function effClass(value) {
  if (value == null) return '';
  if (value >= 1.5) return 'eff-high';
  if (value >= 1.0) return 'eff-mid';
  return '';
}

function hintSelectHtml(s) {
  if (s._evolution_base != null) {
    return '<span class="na" title="進化元の金スキルのヒントLvを使用します">—</span>';
  }
  const hint = s._hint || 0;
  const options = [0, 1, 2, 3, 4, 5].map((lv) =>
    `<option value="${lv}"${hint === lv ? ' selected' : ''}>Lv${lv}</option>`
  ).join('');
  const title = hint > 0
    ? `ヒントLv${hint}（−${discountPct(hint)}%）${state.fastLearner ? '＋切れ者' : ''}`
    : (state.fastLearner ? '切れ者（−10%）' : 'ヒントLv0（割引なし）');
  return `<select class="hint-select${hint > 0 ? ' on' : ''}" data-hint-id="${s.skill_id}" ` +
    `title="${title}" aria-label="${escapeHtml(s.name)} のヒントLv">${options}</select>`;
}

function rowHtml(s, overriddenIds) {
  const id = s.skill_id;
  const checked = state.selected.has(id);
  const overridden = overriddenIds.has(id);
  const open = state.expanded.has(id);
  const badges = [typeBadge(s.type)];
  if (s.effect_category) {
    const cls = EFFECT_CLASS[s.effect_category] || 'other';
    badges.push(`<span class="badge effect-${cls}">${escapeHtml(s.effect_category)}</span>`);
  }
  if (s.group_rate < 0) {
    badges.push('<span class="badge minus">マイナス</span>');
  } else if (s._prereq_eval > 0 || s.prereq_sp > 0) {
    badges.push('<span class="badge chain">上位</span>');
  }
  if (s.total_sp == null) {
    badges.push('<span class="badge nosp">SP対象外</span>');
  }
  if (overridden) {
    badges.push('<span class="badge overridden">集計外</span>');
  }
  badges.push(
    `<button type="button" class="link-btn badge-detail" data-action="detail" data-id="${id}">` +
    `${open ? '詳細を閉じる' : '詳細'}</button>`
  );

  const isEvolution = s._evolution_base != null;
  const spDiscounted = !isEvolution && s.sp != null && s._sp !== s.sp;
  const sp = s._sp == null
    ? '<span class="na">—</span>'
    : (spDiscounted
        ? `${formatNumber(s._sp)}<span class="sp-base">${formatNumber(s.sp)}</span>`
        : formatNumber(s._sp));
  const spTitle = isEvolution
    ? `進化元 ${s._evolution_base_name} のSP ${formatNumber(s._sp)}` +
      `（ヒントLv${s._hint}${state.fastLearner ? '＋切れ者' : ''}）`
    : (s.sp == null
        ? 'SP対象外'
        : (spDiscounted
            ? `ヒントLv${s._hint}${state.fastLearner ? '＋切れ者' : ''}` +
              `（−${Math.round(spDiscountRate(s._hint) * 100)}%）: ` +
              `${formatNumber(s.sp)} → ${formatNumber(s._sp)} SP`
            : `${formatNumber(s.sp)} SP`));
  const evalShowsBase = s.type !== '固有' && s.type !== '継承固有' && s._apt_factor !== 1;
  const evalTitle = s.type === '固有'
    ? `固有Lv${state.uniqueLevel} × ${UNIQUE_POINT_PER_LEVEL} = ${formatNumber(s._eval)}`
    : s.type === '継承固有'
      ? `継承固有は一律 ${INHERIT_UNIQUE_POINT}`
      : (s._apt_factor !== 1
          ? `基礎 ${formatNumber(s.eval_point)} × 適性 ${s._apt_factor.toFixed(2)} = ${formatNumber(s._eval)}`
          : `${formatNumber(s.eval_point)}`);
  const evalDisplay = evalShowsBase
    ? `${formatNumber(s._eval)}<span class="eval-base">${formatNumber(s.eval_point)}</span>`
    : formatNumber(s._eval);
  const upgrade = s._upgrade_point == null ? '<span class="na">—</span>' : formatNumber(s._upgrade_point);
  const effort = s._efficiency == null ? '<span class="na">—</span>' : s._efficiency.toFixed(2);
  const totalSp = s._total_sp == null
    ? '<span class="na">—</span>'
    : formatNumber(s._total_sp);
  const totalEffort = s._total_efficiency == null ? '<span class="na">—</span>' : s._total_efficiency.toFixed(2);
  const totalDiscounted = !isEvolution && s.total_sp != null && s._total_sp !== s.total_sp;
  const totalSpTitle = isEvolution
    ? `進化元 ${s._evolution_base_name} の下位込みSP ${formatNumber(s._total_sp)}`
    : (s.total_sp == null
        ? 'SP対象外'
        : (s._prereq_sp > 0
            ? `下位込み（内訳: 下位 ${formatNumber(s._prereq_sp)} + このスキル ${formatNumber(s._sp || 0)}）` +
              (totalDiscounted ? ` / 割引前 ${formatNumber(s.total_sp)}` : '')
            : `${formatNumber(s._total_sp)}` + (totalDiscounted ? ` / 割引前 ${formatNumber(s.total_sp)}` : '')));
  const desc = s._descOneLine ? escapeHtml(s._descOneLine) : '<span class="na">説明なし</span>';
  const descShort = s._descOneLine
    ? (s._descOneLine.length > 56 ? escapeHtml(s._descOneLine.slice(0, 56)) + '…' : escapeHtml(s._descOneLine))
    : '<span class="na">説明なし</span>';

  const rows = [];
  rows.push(
    `<tr class="skill-row${checked ? ' selected' : ''}${overridden ? ' overridden' : ''}" data-id="${id}">` +
      `<td class="col-check"><input type="checkbox" data-id="${id}"${checked ? ' checked' : ''} aria-label="${escapeHtml(s.name)} を選択"></td>` +
      `<td class="col-name">` +
        `<div class="skill-name">${escapeHtml(s.name)}</div>` +
        `<div class="skill-sub">${badges.join('')}</div>` +
      `</td>` +
      `<td class="num col-eval${s._eval < 0 ? ' neg' : ''}" title="${escapeHtml(evalTitle)}">${evalDisplay}</td>` +
      `<td class="col-hint">${hintSelectHtml(s)}</td>` +
      `<td class="num col-sp" title="${escapeHtml(spTitle)}">${sp}</td>` +
      `<td class="num col-upgrade">${upgrade}</td>` +
      `<td class="num col-eff ${effClass(s._efficiency)}">${effort}</td>` +
      `<td class="num col-totalsp" title="${escapeHtml(totalSpTitle)}">${totalSp}</td>` +
      `<td class="num col-toteff ${effClass(s._total_efficiency)}">${totalEffort}</td>` +
      `<td class="col-desc"><span class="desc-text" title="${desc}">${descShort}</span></td>` +
    `</tr>`
  );
  if (open) {
    const fullDesc = s.description
      ? escapeHtml(s.description).replace(/\n/g, '<br>')
      : '<span class="na">説明なし</span>';
    const discountedSp = s._sp == null ? '' : formatNumber(s._sp);
    const discountedTotal = s._total_sp == null ? '' : formatNumber(s._total_sp);
    const spDiscounted = !isEvolution && s.sp != null && s._sp !== s.sp;
    const hintNote = isEvolution
      ? `（進化元 ${escapeHtml(s._evolution_base_name)} のSP）`
      : (spDiscounted
          ? `（元 ${formatNumber(s.sp)} / −${Math.round(spDiscountRate(s._hint) * 100)}%` +
            `${state.fastLearner ? '・切れ者込み' : ''}）`
          : '');
    const evolutionNote = isEvolution
      ? `<span>進化元 <b>${escapeHtml(s._evolution_base_name)}</b></span>`
      : '';
    const uniqueNote = s.type === '固有'
      ? `<span>固有Lv <b>${state.uniqueLevel}</b>（${state.uniqueLevel} × ${UNIQUE_POINT_PER_LEVEL}）</span>`
      : (s.type === '継承固有'
          ? `<span>継承固有 <b>一律 ${INHERIT_UNIQUE_POINT}</b></span>`
          : '');
    const aptNote = s.type === '固有' || s.type === '継承固有'
      ? ''
      : `<span>適性条件 <b>${escapeHtml(aptitudeText(s))}</b>` +
        `${s._apt_factor !== 1 ? `（×${s._apt_factor.toFixed(2)}）` : ''}</span>`;
    rows.push(
      `<tr class="detail-row"><td colspan="10">` +
        `<div class="detail-desc">${fullDesc}</div>` +
        `<div class="detail-meta">` +
          `<span>ID <b>${s.skill_id}</b></span>` +
          `<span>グループ <b>${s.group_id}</b>（rate ${s.group_rate}）</span>` +
          `<span>カテゴリ <b>${escapeHtml(s.category_label)}</b></span>` +
          uniqueNote +
          evolutionNote +
          aptNote +
          `<span>ヒントLv <b>${s._hint}</b>${s._hint > 0 ? `（−${discountPct(s._hint)}%）` : '（割引なし）'}</span>` +
          `<span>評価点 <b>${formatNumber(s._eval)}</b>${s._eval !== s.eval_point ? `（基礎 ${formatNumber(s.eval_point)}）` : ''}</span>` +
          `<span>割引後SP <b>${discountedSp || '—'}</b>${hintNote}</span>` +
          `<span>下位込み割引後SP <b>${discountedTotal || '—'}</b></span>` +
          `<span>${isEvolution ? '進化元の評価点' : '下位評価点'} <b>${formatNumber(s._prereq_eval)}</b></span>` +
          `<span>${isEvolution ? '進化元の下位SP（割引前）' : '下位SP（割引前）'} <b>${formatNumber(isEvolution ? s._evolution_base_prereq_sp : s._prereq_sp_base)}</b></span>` +
          `<span>上昇評価点 <b>${formatNumber(s._upgrade_point)}</b></span>` +
        `</div>` +
      `</td></tr>`
    );
  }
  return rows.join('');
}

function renderArrows() {
  for (const key of ['name', 'eval_point', 'hint', 'sp', 'upgrade_point', 'efficiency', 'total_sp', 'total_efficiency']) {
    const el = $('arrow-' + key);
    if (!el) continue;
    el.textContent = state.sortKey === key ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  }
  for (const th of document.querySelectorAll('thead th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
  }
}

export function render() {
  const filtered = filteredSkills().sort(compareSkills);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);

  const sum = computeSummary();
  const overriddenIds = new Set(sum.overridden.map((s) => s.skill_id));

  $('tbody').innerHTML = pageRows.map((s) => rowHtml(s, overriddenIds)).join('');

  $('resultCount').textContent = formatNumber(total);
  const hiddenNegative = state.includeNegative
    ? 0
    : SKILLS.filter((s) => (s.group_rate < 0 || s.eval_point < 0) && state.types.has(s.type)).length;
  const hints = [];
  if (hiddenNegative) hints.push(`マイナス系 ${formatNumber(hiddenNegative)} 件を非表示`);
  $('resultHint').textContent = hints.length ? `（${hints.join(' / ')}）` : '';

  const from = total ? start + 1 : 0;
  const to = start + pageRows.length;
  $('pageInfo').textContent = `${formatNumber(from)}–${formatNumber(to)} / ${formatNumber(total)}`;
  $('prevPage').disabled = state.page <= 1;
  $('nextPage').disabled = state.page >= totalPages;

  const pageAll = pageRows.length > 0 && pageRows.every((s) => state.selected.has(s.skill_id));
  const pageSome = pageRows.some((s) => state.selected.has(s.skill_id));
  const pageSelect = $('pageSelect');
  pageSelect.checked = pageAll;
  pageSelect.indeterminate = !pageAll && pageSome;
  pageSelect.disabled = pageRows.length === 0;

  updateSummary();
  renderArrows();
}

export function addSkillWithChain(id, target = state.selected) {
  target.add(id);
  for (const lower of CHAINS.get(id) || []) {
    target.add(lower.skill_id);
  }
}

export function toggleSkill(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else addSkillWithChain(id);
  saveSelection();
  render();
}

export function togglePage(select) {
  const filtered = filteredSkills().sort(compareSkills);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);
  for (const s of pageRows) {
    if (select) addSkillWithChain(s.skill_id);
    else state.selected.delete(s.skill_id);
  }
  saveSelection();
  render();
}

export function syncSortSelect() {
  const select = $('sort');
  const value = `${state.sortKey}:${state.sortDir}`;
  const has = [...select.options].some((o) => o.value === value);
  if (has) {
    select.value = value;
  } else {
    // ヘッダークリックで select にない組み合わせになった場合の保険
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
    select.value = value;
  }
}

export function setSort(key, dir) {
  if (state.sortKey === key && !dir) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = dir || (key === 'name' || key === 'type' ? 'asc' : 'desc');
  }
  state.page = 1;
  syncSortSelect();
  render();
}
