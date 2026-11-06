// アプリの可変状態と localStorage への永続化。

import { byId, cardsById, SCENARIOS, SKILLS } from './data.js';
import {
  STORAGE_KEY,
  HINT_KEY,
  SETTINGS_KEY,
  APT_MULT,
  EFFECT_ORDER,
  OPT_MAX_BUDGET,
  TYPE_ORDER,
} from './constants.js';

export const state = {
  query: '',
  types: new Set(TYPE_ORDER.filter((t) => SKILLS.some((s) => s.type === t))),
  category: '',
  onlyPurchasable: false,
  includeNegative: false,
  onlySelected: false,
  sortKey: 'total_efficiency',
  sortDir: 'desc',
  page: 1,
  pageSize: 100,
  selected: new Set(),
  expanded: new Set(),
  hintLevels: new Map(),
  fastLearner: false,
  uniqueLevel: 1,
  aptitude: {
    distance: { 1: 'A', 2: 'A', 3: 'A', 4: 'A' },
    style: { 1: 'A', 2: 'A', 3: 'A', 4: 'A' },
  },
  cardId: null,
  scenarioId: null,
  effectCategories: new Set(EFFECT_ORDER),
  aptFilter: {
    distance: new Set(),
    ground: new Set(),
    style: new Set(),
  },
  includeGeneral: true,
  optBudget: 1200,
  optUseFilter: true,
  ocrFastMode: true,
  ocrAutoCrop: true,
  ocrSensitivity: 'medium',
};

export function restoreSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      for (const id of JSON.parse(raw)) {
        const n = Number(id);
        if (byId.has(n)) state.selected.add(n);
      }
    }
  } catch (err) { /* localStorage が使えない環境でも動作させる */ }
}

export function saveSelection() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.selected]));
  } catch (err) { /* ignore */ }
}

export function restoreHints() {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const map = saved && saved.overrides && typeof saved.overrides === 'object'
        ? saved.overrides
        : saved;
      if (map && typeof map === 'object') {
        for (const [id, lv] of Object.entries(map)) {
          const skillId = Number(id);
          const level = Number(lv);
          if (byId.has(skillId) && Number.isInteger(level) && level > 0 && level <= 5) {
            state.hintLevels.set(skillId, level);
          }
        }
      }
    }
  } catch (err) { /* ignore */ }
}

export function saveHint() {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify({
      overrides: Object.fromEntries(state.hintLevels),
    }));
  } catch (err) { /* ignore */ }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;
    if (typeof saved.fastLearner === 'boolean') state.fastLearner = saved.fastLearner;
    const level = Number(saved.uniqueLevel);
    if (Number.isInteger(level) && level >= 1 && level <= 6) state.uniqueLevel = level;
    for (const cat of ['distance', 'style']) {
      const src = saved.aptitude && saved.aptitude[cat];
      if (!src || typeof src !== 'object') continue;
      for (const id of ['1', '2', '3', '4']) {
        const grade = String(src[id] || '').toUpperCase();
        if (APT_MULT[grade] != null) state.aptitude[cat][id] = grade;
      }
    }
    const cardId = Number(saved.cardId);
    if (Number.isInteger(cardId) && cardsById.has(cardId)) state.cardId = cardId;
    const scenarioId = Number(saved.scenarioId);
    if (Number.isInteger(scenarioId) && SCENARIOS.some((s) => s.id === scenarioId)) {
      state.scenarioId = scenarioId;
    }
    if (Array.isArray(saved.effectCategories)) {
      const valid = saved.effectCategories.filter((v) => EFFECT_ORDER.includes(v));
      state.effectCategories = new Set(valid);
    }
    if (saved.aptFilter && typeof saved.aptFilter === 'object') {
      for (const cat of ['distance', 'ground', 'style']) {
        const values = saved.aptFilter[cat];
        if (!Array.isArray(values)) continue;
        state.aptFilter[cat] = new Set(
          values.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 1 && v <= 4)
        );
      }
    }
    if (typeof saved.includeGeneral === 'boolean') state.includeGeneral = saved.includeGeneral;
    const budget = Number(saved.optBudget);
    if (Number.isFinite(budget) && budget >= 0) {
      state.optBudget = Math.min(OPT_MAX_BUDGET, Math.floor(budget));
    }
    if (typeof saved.optUseFilter === 'boolean') state.optUseFilter = saved.optUseFilter;
    if (typeof saved.ocrFastMode === 'boolean') state.ocrFastMode = saved.ocrFastMode;
    if (typeof saved.ocrAutoCrop === 'boolean') state.ocrAutoCrop = saved.ocrAutoCrop;
    if (saved.ocrSensitivity === 'high' || saved.ocrSensitivity === 'medium' || saved.ocrSensitivity === 'low') {
      state.ocrSensitivity = saved.ocrSensitivity;
    }
  } catch (err) { /* ignore */ }
}

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      fastLearner: state.fastLearner,
      uniqueLevel: state.uniqueLevel,
      aptitude: state.aptitude,
      cardId: state.cardId,
      scenarioId: state.scenarioId,
      effectCategories: [...state.effectCategories],
      aptFilter: {
        distance: [...state.aptFilter.distance],
        ground: [...state.aptFilter.ground],
        style: [...state.aptFilter.style],
      },
      includeGeneral: state.includeGeneral,
      optBudget: state.optBudget,
      optUseFilter: state.optUseFilter,
      ocrFastMode: state.ocrFastMode,
      ocrAutoCrop: state.ocrAutoCrop,
      ocrSensitivity: state.ocrSensitivity,
    }));
  } catch (err) { /* ignore */ }
}
