// 検索・種別・カテゴリ・効果カテゴリ・適性フィルタ。

import { state } from '../core/state.js';
import { SKILLS } from '../core/data.js';
import {
  TYPE_ORDER,
  EFFECT_ORDER,
  FILTER_CATEGORIES,
} from '../core/constants.js';
import { $, escapeHtml, formatNumber, normalize } from '../core/utils.js';
import { skillMatchesAptFilter } from '../core/aptitude.js';

export function initCategory() {
  const select = $('category');
  const cats = new Map();
  for (const s of SKILLS) {
    cats.set(String(s.category), s.category_label || String(s.category));
  }
  const sorted = [...cats.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [value, label] of sorted) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
}

function typeCounts() {
  const counts = new Map();
  for (const s of SKILLS) counts.set(s.type, (counts.get(s.type) || 0) + 1);
  return counts;
}

export function renderTypeChips() {
  const wrap = $('typeChips');
  const counts = typeCounts();
  const types = TYPE_ORDER.filter((t) => counts.has(t));
  const allActive = types.every((t) => state.types.has(t));
  const html = [
    `<button type="button" class="chip chip-all" data-type="__all__">すべて</button>`,
  ];
  for (const t of types) {
    const active = state.types.has(t);
    html.push(
      `<button type="button" class="chip${active ? ' active' : ''}" data-type="${escapeHtml(t)}">` +
      `${escapeHtml(t)}<span class="n">${formatNumber(counts.get(t))}</span></button>`
    );
  }
  wrap.innerHTML = html.join('');
  const all = wrap.querySelector('[data-type="__all__"]');
  if (all) {
    all.classList.toggle('active', allActive);
    all.setAttribute('aria-pressed', String(allActive));
  }
  for (const btn of wrap.querySelectorAll('[data-type]:not([data-type="__all__"])')) {
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
  }
}

function effectCounts() {
  const counts = new Map();
  for (const s of SKILLS) {
    const cat = s.effect_category || 'その他';
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  return counts;
}

export function renderEffectChips() {
  const wrap = $('effectChips');
  if (!wrap) return;
  const counts = effectCounts();
  const cats = EFFECT_ORDER.filter((c) => counts.has(c));
  const allActive = cats.every((c) => state.effectCategories.has(c));
  const html = [
    `<button type="button" class="chip chip-all" data-effect="__all__">すべて</button>`,
  ];
  for (const cat of cats) {
    const active = state.effectCategories.has(cat);
    html.push(
      `<button type="button" class="chip${active ? ' active' : ''}" data-effect="${escapeHtml(cat)}">` +
      `${escapeHtml(cat)}<span class="n">${formatNumber(counts.get(cat))}</span></button>`
    );
  }
  wrap.innerHTML = html.join('');
  const all = wrap.querySelector('[data-effect="__all__"]');
  if (all) {
    all.classList.toggle('active', allActive);
    all.setAttribute('aria-pressed', String(allActive));
  }
  for (const btn of wrap.querySelectorAll('[data-effect]:not([data-effect="__all__"])')) {
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
  }
}

export function renderAptFilter() {
  for (const { key, groupId, meta } of FILTER_CATEGORIES) {
    const group = $(groupId);
    if (!group) continue;
    if (group.querySelectorAll('.filter-chip').length === 0) {
      for (const id of Object.keys(meta)) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-chip';
        chip.dataset.filterCat = key;
        chip.dataset.filterValue = id;
        chip.textContent = meta[id].long;
        chip.title = `${meta[id].long}のスキルを表示`;
        group.appendChild(chip);
      }
    }
    for (const chip of group.querySelectorAll('.filter-chip')) {
      const active = state.aptFilter[key].has(Number(chip.dataset.filterValue));
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }

  const general = $('includeGeneral');
  if (general) {
    general.checked = state.includeGeneral;
    $('includeGeneral-wrap')?.classList.toggle('on', state.includeGeneral);
  }
  const note = $('filterNote');
  if (note) {
    const count = state.aptFilter.distance.size + state.aptFilter.ground.size + state.aptFilter.style.size;
    note.textContent = count
      ? `いずれかの条件に一致（汎用${state.includeGeneral ? 'を含む' : 'を除く'}）`
      : '';
  }
}

export function filteredSkills(options = {}) {
  const terms = normalize(state.query).split(/\s+/).filter(Boolean);
  const out = [];
  for (const s of SKILLS) {
    if (!state.types.has(s.type)) continue;
    if (state.category && String(s.category) !== state.category) continue;
    if (!state.effectCategories.has(s.effect_category || 'その他')) continue;
    if (state.onlyPurchasable && !(s.sp != null && s.sp > 0)) continue;
    if (!state.includeNegative && (s.group_rate < 0 || s.eval_point < 0)) continue;
    if (!options.ignoreOnlySelected && state.onlySelected && !state.selected.has(s.skill_id)) continue;
    if (!skillMatchesAptFilter(s)) continue;
    if (terms.length) {
      let ok = true;
      for (const t of terms) {
        if (!s._hay.includes(t)) { ok = false; break; }
      }
      if (!ok) continue;
    }
    out.push(s);
  }
  return out;
}
