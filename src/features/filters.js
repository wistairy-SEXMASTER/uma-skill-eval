// 検索・種別・カテゴリ・効果カテゴリ・適性フィルタと、カード/設定UI。

import { state } from '../core/state.js';
import {
  SKILLS,
  META,
  CARDS,
  cardsById,
} from '../core/data.js';
import {
  TYPE_ORDER,
  EFFECT_ORDER,
  FILTER_CATEGORIES,
  APT_GRADES,
  APT_MULT,
  DISTANCE_META,
  STYLE_META,
  UNIQUE_POINT_PER_LEVEL,
} from '../core/constants.js';
import {
  $,
  escapeHtml,
  formatNumber,
  formatDate,
  aptClass,
  normalize,
} from '../core/utils.js';
import { skillMatchesAptFilter } from '../core/aptitude.js';

export function initMeta() {
  const total = SKILLS.length;
  const db = formatDate(META.db_mtime);
  const generated = formatDate(META.generated_at);
  $('meta').innerHTML =
    `収録 <b>${formatNumber(total)}</b> スキル（特殊・期限切れを除く）<br>` +
    `DB更新 ${escapeHtml(db)} ／ 抽出 ${escapeHtml(generated)}`;
}

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

export function renderSettings() {
  const levelSel = $('uniqueLevel');
  if (levelSel) {
    if (levelSel.options.length !== 6) {
      levelSel.innerHTML = [1, 2, 3, 4, 5, 6].map((lv) =>
        `<option value="${lv}">${lv}</option>`
      ).join('');
    }
    levelSel.value = String(state.uniqueLevel);
  }

  const fast = $('fastLearner');
  if (fast) fast.checked = state.fastLearner;
  $('fastLearner-wrap')?.classList.toggle('on', state.fastLearner);

  const groups = [
    ['aptDistanceGroup', 'distance', DISTANCE_META],
    ['aptStyleGroup', 'style', STYLE_META],
  ];
  for (const [groupId, cat, meta] of groups) {
    const group = $(groupId);
    if (!group) continue;
    if (group.querySelectorAll('.apt-pair').length !== 4) {
      group.querySelectorAll('.apt-pair').forEach((el) => el.remove());
      for (const id of [1, 2, 3, 4]) {
        const pair = document.createElement('span');
        pair.className = 'apt-pair';
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = meta[id].short;
        tag.title = meta[id].long;
        const sel = document.createElement('select');
        sel.className = 'apt-select';
        sel.dataset.aptCat = cat;
        sel.dataset.aptId = String(id);
        sel.setAttribute('aria-label', `${meta[id].long}の適性`);
        sel.innerHTML = APT_GRADES.map((g) =>
          `<option value="${g}">${g}</option>`
        ).join('');
        pair.append(tag, sel);
        group.appendChild(pair);
      }
    }
    for (const id of [1, 2, 3, 4]) {
      const sel = group.querySelector(
        `select[data-apt-cat="${cat}"][data-apt-id="${id}"]`
      );
      if (!sel) continue;
      const grade = state.aptitude[cat][id];
      sel.value = grade;
      sel.className = `apt-select ${aptClass(grade)}`;
      sel.title = `${meta[id].long}適性: ${grade}（×${APT_MULT[grade].toFixed(1)}）`;
    }
  }

  const note = $('settingsNote');
  if (note) {
    note.textContent =
      `固有 ${formatNumber(state.uniqueLevel * UNIQUE_POINT_PER_LEVEL)}点` +
      (state.fastLearner ? ' / 切れ者 −10%' : '');
  }
}

export function initCards() {
  const select = $('cardSelect');
  if (!select) return;
  const byChara = new Map();
  for (const card of CARDS) {
    const key = card.chara_name || String(card.chara_id);
    if (!byChara.has(key)) byChara.set(key, []);
    byChara.get(key).push(card);
  }
  const charaNames = [...byChara.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  let html = '<option value="">ウマ娘を選択しない</option>';
  for (const name of charaNames) {
    html += `<optgroup label="${escapeHtml(name)}">`;
    const cards = byChara.get(name)
      .slice()
      .sort((a, b) => (a.costume_name || '').localeCompare(b.costume_name || '', 'ja'));
    for (const card of cards) {
      const label = card.display_name || card.costume_name || String(card.card_id);
      html += `<option value="${card.card_id}">${escapeHtml(label)}</option>`;
    }
    html += '</optgroup>';
  }
  select.innerHTML = html;
  select.value = state.cardId != null ? String(state.cardId) : '';
  updateCardInfo();
}

export function updateCardInfo() {
  const info = $('cardInfo');
  const reset = $('btnCardAptReset');
  const card = state.cardId != null ? cardsById.get(state.cardId) : null;
  if (!info) return;
  if (!card) {
    info.textContent = '選択すると距離・脚質の初期適性を自動設定します。';
    if (reset) reset.disabled = true;
    return;
  }
  const ground = card.aptitude.ground;
  info.textContent =
    `${card.display_name || card.chara_name}` +
    ` ／ 芝 ${ground['1'] || '—'}・ダート ${ground['2'] || '—'}` +
    ` ／ 初期脚質 ${card.running_style_name || '—'}`;
  if (reset) reset.disabled = false;
}

export function applyCardAptitudes(card) {
  if (!card) return;
  for (const id of ['1', '2', '3', '4']) {
    state.aptitude.distance[id] = card.aptitude.distance[id] || 'A';
    state.aptitude.style[id] = card.aptitude.style[id] || 'A';
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
