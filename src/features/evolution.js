// カード固有の進化先と、シナリオ別進化スキルの表示・選択。

import { state, saveSelection } from '../core/state.js';
import {
  byId,
  cardsById,
  CARD_INITIAL_SKILLS,
  CARD_GOLD_SKILL_EVOLUTIONS,
  ALL_EVOLUTIONS_BY_BASE,
  CHAINS,
  SCENARIOS,
  SCENARIO_EVOLUTIONS,
} from '../core/data.js';
import { $, escapeHtml, formatNumber } from '../core/utils.js';
import { render } from './table.js';

export function evolutionSkillName(id) {
  const s = byId.get(id);
  return s ? s.name : `#${id}`;
}

export function evolutionOptionsForBase(baseSkillId) {
  if (state.cardId == null) return [];
  const entries = CARD_GOLD_SKILL_EVOLUTIONS[String(state.cardId)] || [];
  return entries
    .filter((e) => e.base_skill_id === baseSkillId)
    .map((e) => byId.get(e.skill_id))
    .filter(Boolean);
}

export function selectEvolutionOption(baseSkillId, selectSkillId) {
  const all = [baseSkillId, ...(ALL_EVOLUTIONS_BY_BASE.get(baseSkillId) || [])];
  for (const id of all) state.selected.delete(id);
  if (selectSkillId != null) {
    state.selected.add(selectSkillId);
    // 進化先を選んだ場合は、進化元の金スキル本体も選択
    if (selectSkillId !== baseSkillId) {
      state.selected.add(baseSkillId);
    }
    // 進化元の金スキルの下位スキルも自動選択
    for (const lower of CHAINS.get(baseSkillId) || []) {
      state.selected.add(lower.skill_id);
    }
  }
  saveSelection();
  renderCardEvolution();
  renderScenarioEvolution();
  render();
}

function evolutionSelectHtml(base, evolutions) {
  const selectedEvo = evolutions.find((s) => state.selected.has(s.skill_id));
  const current = selectedEvo
    ? selectedEvo.skill_id
    : (state.selected.has(base.skill_id) ? base.skill_id : '');
  const baseSp = base.sp != null ? `SP ${formatNumber(base._sp)}` : 'SP —';
  const options = [
    `<option value=""${current === '' ? ' selected' : ''}>未選択</option>`,
    `<option value="${base.skill_id}"${current === base.skill_id ? ' selected' : ''}>` +
      `通常: ${escapeHtml(base.name)}（評価 ${formatNumber(base._eval)} / ${baseSp}）</option>`,
  ];
  for (const evo of evolutions) {
    options.push(
      `<option value="${evo.skill_id}"${current === evo.skill_id ? ' selected' : ''}>` +
      `進化: ${escapeHtml(evo.name)}（評価 ${formatNumber(evo._eval)} / ${baseSp}）</option>`
    );
  }
  return `<select class="evo-select" data-evo-base="${base.skill_id}" ` +
    `aria-label="${escapeHtml(base.name)} の進化先">${options.join('')}</select>`;
}

export function renderCardEvolution() {
  const box = $('cardEvolution');
  if (!box) return;
  const card = state.cardId != null ? cardsById.get(state.cardId) : null;
  if (!card) {
    box.classList.remove('show');
    box.innerHTML = '';
    return;
  }
  const cardId = card.card_id;
  const initialIds = CARD_INITIAL_SKILLS[String(cardId)] || [];
  const initialGold = initialIds
    .map((id) => byId.get(id))
    .filter((s) => s && s.rarity === 2);

  const groups = [];
  for (const base of initialGold) {
    const evolutions = evolutionOptionsForBase(base.skill_id);
    const note = evolutions.length
      ? `${formatNumber(evolutions.length)}件の進化`
      : '進化なし';
    groups.push(
      `<div class="evo-group">` +
        `<div class="evo-group-title">${escapeHtml(base.name)}<span class="evo-meta">${note}</span></div>` +
        evolutionSelectHtml(base, evolutions) +
      `</div>`
    );
  }

  if (!groups.length) {
    box.innerHTML = '<div class="evo-empty">このウマ娘には初期金スキルがありません。</div>';
    box.classList.add('show');
    return;
  }

  box.innerHTML =
    `<div class="evo-section-title">初期金スキルの進化先（ドロップダウンで選択）</div>` +
    `<div class="evo-groups">${groups.join('')}</div>`;
  box.classList.add('show');
}

export function initScenarios() {
  const select = $('scenarioSelect');
  if (!select) return;
  let html = '<option value="">シナリオを選択</option>';
  for (const s of SCENARIOS) {
    const label = String(s.name || '').replace(/\s*\n+\s*/g, ' ');
    html += `<option value="${s.id}">${escapeHtml(label)}</option>`;
  }
  select.innerHTML = html;
  select.value = state.scenarioId != null ? String(state.scenarioId) : '';
}

function scenarioEvolutionEntries(scenarioId) {
  if (scenarioId == null) return [];
  return SCENARIO_EVOLUTIONS[String(scenarioId)] || [];
}

export function renderScenarioEvolution() {
  const list = $('scenarioEvolutionList');
  if (!list) return;
  const entries = scenarioEvolutionEntries(state.scenarioId);
  if (!entries.length) {
    list.innerHTML = '<div class="scenario-evo-empty">シナリオを選択すると、そのシナリオで選択可能な進化スキルを表示します。</div>';
    return;
  }
  const items = entries.map((e) => {
    const base = byId.get(e.base_skill_id);
    const evo = byId.get(e.skill_id);
    if (!base || !evo) return '';
    const selected = state.selected.has(evo.skill_id);
    const baseSp = base.sp != null ? `SP ${formatNumber(base._sp)}` : 'SP —';
    return `<div class="scenario-evo-item">` +
      `<span class="scenario-evo-base">${escapeHtml(base.name)}</span>` +
      `<span class="scenario-evo-arrow">→</span>` +
      `<span class="scenario-evo-skill">${escapeHtml(evo.name)}</span>` +
      `<span class="scenario-evo-meta">評価 ${formatNumber(evo._eval)} / ${baseSp}</span>` +
      `<button class="btn tiny scenario-evo-btn${selected ? ' active' : ''}" type="button" ` +
        `title="${selected ? 'クリックで選択を解除' : 'この進化スキルを選択'}" ` +
        `data-scenario-evo-base="${e.base_skill_id}" data-scenario-evo-select="${e.skill_id}">` +
        `${selected ? '解除' : '選択'}</button>` +
      `</div>`;
  }).join('');
  list.innerHTML = items || '<div class="scenario-evo-empty">進化スキルがありません。</div>';
}
