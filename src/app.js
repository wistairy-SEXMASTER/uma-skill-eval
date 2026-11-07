// アプリのイベント配線と初期化。各機能モジュールを組み合わせる。

import { state, saveSettings, saveSelection, saveHint, loadSettings } from './core/state.js';
import { SKILLS, byId, cardsById } from './core/data.js';
import { APT_MULT, OPT_MAX_BUDGET, EFFECT_ORDER, TYPE_ORDER, GAME_API_DEFAULT } from './core/constants.js';
import { $ } from './core/utils.js';
import { recomputeDerived } from './core/aptitude.js';
import { invalidateOptimization } from './core/optimizer-state.js';
import {
  initMeta,
  initCategory,
  renderTypeChips,
  renderEffectChips,
  renderSettings,
  initCards,
  updateCardInfo,
  applyCardAptitudes,
  renderAptFilter,
} from './features/filters.js';
import {
  renderCardEvolution,
  renderScenarioEvolution,
  initScenarios,
  selectEvolutionOption,
} from './features/evolution.js';
import { render, toggleSkill, togglePage, setSort } from './features/table.js';
import {
  fetchGameData,
  importGameJsonFile,
  initGameData,
  resetGameVersion,
  startGameAuto,
  stopGameAuto,
} from './features/gameData.js';
import { runOptimization, applyOptimizationResult } from './features/optimizer.js';
import { exportCsv } from './features/summary.js';
import {
  ocrAddFile,
  pasteOcrImage,
  renderOcrThumbs,
  runOcr,
  ocrSetStatus,
  setOcrMode,
  getOcrMode,
  removeOcrImage,
} from './features/ocr.js';
import {
  startOcrCapture,
  captureOcrFrame,
  startAutoCapture,
  stopOcrCapture,
  copyOcrUrl,
  updateOcrCaptureHint,
} from './features/capture.js';

function onFilterChanged() {
  saveSettings();
  invalidateOptimization();
  state.page = 1;
  renderAptFilter();
  render();
}

function updateStickyOffset() {
  const controls = $('controls');
  const h = controls ? controls.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty('--controls-h', `${Math.ceil(h)}px`);
}

function bind() {
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    onFilterChanged();
  });

  $('category').addEventListener('change', (e) => {
    state.category = e.target.value;
    onFilterChanged();
  });

  $('sort').addEventListener('change', (e) => {
    const [key, dir] = e.target.value.split(':');
    state.sortKey = key;
    state.sortDir = dir;
    state.page = 1;
    render();
  });

  $('settings').addEventListener('change', (e) => {
    const target = e.target;
    if (target.id === 'fastLearner') {
      state.fastLearner = target.checked;
    } else if (target.id === 'diligent') {
      state.diligent = target.checked;
    } else if (target.id === 'uniqueLevel') {
      const level = Number(target.value);
      state.uniqueLevel = Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1;
    } else if (target.matches('select[data-apt-cat]')) {
      const cat = target.dataset.aptCat;
      const id = target.dataset.aptId;
      const grade = String(target.value).toUpperCase();
      if (state.aptitude[cat] && APT_MULT[grade] != null) {
        state.aptitude[cat][id] = grade;
      }
    } else {
      return;
    }
    saveSettings();
    renderSettings();
    recomputeDerived();
    renderCardEvolution();
    renderScenarioEvolution();
    render();
  });

  $('btnAptReset').addEventListener('click', () => {
    for (const cat of ['distance', 'style']) {
      for (const id of [1, 2, 3, 4]) state.aptitude[cat][id] = 'A';
    }
    saveSettings();
    renderSettings();
    recomputeDerived();
    renderCardEvolution();
    renderScenarioEvolution();
    render();
  });

  $('cardSelect').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    if (!id) {
      state.cardId = null;
      saveSettings();
      updateCardInfo();
      renderCardEvolution();
      renderScenarioEvolution();
      onFilterChanged();
      return;
    }
    const card = cardsById.get(id);
    if (!card) return;
    state.cardId = id;
    applyCardAptitudes(card);
    saveSettings();
    renderSettings();
    updateCardInfo();
    recomputeDerived();
    renderCardEvolution();
    renderScenarioEvolution();
    render();
  });

  $('btnCardAptReset').addEventListener('click', () => {
    const card = state.cardId != null ? cardsById.get(state.cardId) : null;
    if (!card) return;
    applyCardAptitudes(card);
    saveSettings();
    renderSettings();
    recomputeDerived();
    render();
  });

  $('btnGameFetch').addEventListener('click', () => fetchGameData());
  $('btnGameImport').addEventListener('click', () => $('gameFile').click());
  $('gameFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await importGameJsonFile(file);
  });
  $('gameServer').addEventListener('change', (e) => {
    const value = e.target.value.trim() || GAME_API_DEFAULT;
    state.gameServer = value.replace(/\/+$/, '');
    e.target.value = state.gameServer;
    saveSettings();
    resetGameVersion();
  });
  $('gameAuto').addEventListener('change', (e) => {
    state.gameAuto = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    saveSettings();
    if (state.gameAuto) startGameAuto();
    else stopGameAuto();
  });

  $('effectChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-effect]');
    if (!chip) return;
    const cat = chip.dataset.effect;
    const all = EFFECT_ORDER.filter((c) => SKILLS.some((s) => (s.effect_category || 'その他') === c));
    if (cat === '__all__') {
      const every = all.every((c) => state.effectCategories.has(c));
      state.effectCategories = new Set(every ? [] : all);
    } else if (state.effectCategories.has(cat)) {
      state.effectCategories.delete(cat);
    } else {
      state.effectCategories.add(cat);
    }
    renderEffectChips();
    onFilterChanged();
  });

  $('btnHintReset').addEventListener('click', () => {
    state.hintLevels.clear();
    saveHint();
    recomputeDerived();
    renderCardEvolution();
    renderScenarioEvolution();
    render();
  });

  $('cardEvolution').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-evo-base]');
    if (!sel) return;
    const baseId = Number(sel.dataset.evoBase);
    const value = Number(sel.value);
    if (!byId.has(baseId)) return;
    selectEvolutionOption(baseId, value || null);
  });

  $('scenarioSelect').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    state.scenarioId = id ? id : null;
    saveSettings();
    renderScenarioEvolution();
  });

  $('scenarioEvolutionList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scenario-evo-select]');
    if (!btn) return;
    const baseId = Number(btn.dataset.scenarioEvoBase);
    const selectId = Number(btn.dataset.scenarioEvoSelect);
    if (!byId.has(baseId) || !byId.has(selectId)) return;
    selectEvolutionOption(baseId, selectId);
  });

  $('aptFilter').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    const cat = chip.dataset.filterCat;
    const value = Number(chip.dataset.filterValue);
    if (!state.aptFilter[cat]) return;
    if (state.aptFilter[cat].has(value)) state.aptFilter[cat].delete(value);
    else state.aptFilter[cat].add(value);
    onFilterChanged();
  });

  $('includeGeneral').addEventListener('change', (e) => {
    state.includeGeneral = e.target.checked;
    onFilterChanged();
  });

  $('btnFilterClear').addEventListener('click', () => {
    for (const cat of ['distance', 'ground', 'style']) state.aptFilter[cat].clear();
    onFilterChanged();
  });

  $('optBudget').addEventListener('change', (e) => {
    const budget = Math.max(0, Math.min(OPT_MAX_BUDGET, Math.floor(Number(e.target.value) || 0)));
    state.optBudget = budget;
    e.target.value = String(budget);
    saveSettings();
    invalidateOptimization();
  });

  $('optUseFilter').addEventListener('change', (e) => {
    state.optUseFilter = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    saveSettings();
    invalidateOptimization();
  });

  $('optMode').addEventListener('change', (e) => {
    state.optMode = e.target.value === 'skillTest' ? 'skillTest' : 'eval';
    saveSettings();
    invalidateOptimization();
  });

  $('btnOptimize').addEventListener('click', runOptimization);
  $('btnApplyOpt').addEventListener('click', applyOptimizationResult);

  $('ocrFiles').addEventListener('change', async (e) => {
    for (const file of e.target.files || []) await ocrAddFile(file);
    e.target.value = '';
  });
  $('ocrDrop').addEventListener('click', () => $('ocrFiles').click());
  $('ocrDrop').addEventListener('dragover', (e) => {
    e.preventDefault();
    e.currentTarget.classList.add('dragover');
  });
  $('ocrDrop').addEventListener('dragleave', (e) => e.currentTarget.classList.remove('dragover'));
  $('ocrDrop').addEventListener('drop', async (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    for (const file of e.dataTransfer.files || []) await ocrAddFile(file);
  });
  $('ocrThumbs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ocr-remove]');
    if (!btn) return;
    removeOcrImage(Number(btn.dataset.ocrRemove));
    renderOcrThumbs();
  });
  $('ocrModes').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ocr-mode]');
    if (!chip) return;
    setOcrMode(chip.dataset.ocrMode);
    const mode = getOcrMode();
    for (const c of $('ocrModes').querySelectorAll('[data-ocr-mode]')) {
      c.classList.toggle('active', c.dataset.ocrMode === mode);
    }
    $('ocrResult').innerHTML = '';
    $('ocrRaw').textContent = '';
    ocrSetStatus(mode === 'skills'
      ? 'スキル取得画面の画像を追加してください。'
      : 'ウマ娘の名前・適性が写った画像を追加してください。');
  });
  $('ocrPaste').addEventListener('click', pasteOcrImage);
  $('ocrCaptureStart').addEventListener('click', startOcrCapture);
  $('ocrCaptureFrame').addEventListener('click', captureOcrFrame);
  $('ocrCaptureAuto').addEventListener('click', startAutoCapture);
  $('ocrCaptureStop').addEventListener('click', stopOcrCapture);
  $('ocrCopyUrl').addEventListener('click', copyOcrUrl);
  $('ocrFastMode').addEventListener('change', (e) => {
    state.ocrFastMode = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    saveSettings();
  });
  $('ocrAutoCrop').addEventListener('change', (e) => {
    state.ocrAutoCrop = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    saveSettings();
  });
  $('ocrSensitivity').addEventListener('change', (e) => {
    state.ocrSensitivity = e.target.value;
    saveSettings();
  });
  $('ocrRun').addEventListener('click', runOcr);

  $('onlyPurchasable').addEventListener('change', (e) => {
    state.onlyPurchasable = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    onFilterChanged();
  });

  $('includeNegative').addEventListener('change', (e) => {
    state.includeNegative = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    onFilterChanged();
  });

  $('onlySelected').addEventListener('change', (e) => {
    state.onlySelected = e.target.checked;
    e.target.closest('.toggle').classList.toggle('on', e.target.checked);
    onFilterChanged();
  });

  $('typeChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-type]');
    if (!chip) return;
    const type = chip.dataset.type;
    const all = TYPE_ORDER.filter((t) => SKILLS.some((s) => s.type === t));
    if (type === '__all__') {
      const every = all.every((t) => state.types.has(t));
      state.types = new Set(every ? [] : all);
    } else if (state.types.has(type)) {
      state.types.delete(type);
    } else {
      state.types.add(type);
    }
    renderTypeChips();
    onFilterChanged();
  });

  $('tbody').addEventListener('click', (e) => {
    const detailBtn = e.target.closest('[data-action="detail"]');
    if (detailBtn) {
      e.stopPropagation();
      const id = Number(detailBtn.dataset.id);
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      render();
      return;
    }
    if (e.target.closest('input, button, a, select, label')) return;
    const tr = e.target.closest('tr.skill-row');
    if (tr) toggleSkill(Number(tr.dataset.id));
  });

  $('tbody').addEventListener('change', (e) => {
    const hintSel = e.target.closest('select[data-hint-id]');
    if (hintSel) {
      const id = Number(hintSel.dataset.hintId);
      const level = Number(hintSel.value) || 0;
      if (level > 0) state.hintLevels.set(id, level);
      else state.hintLevels.delete(id);
      saveHint();
      recomputeDerived();
      renderCardEvolution();
      renderScenarioEvolution();
      render();
      return;
    }
    const cb = e.target.closest('input[type="checkbox"][data-id]');
    if (!cb) return;
    toggleSkill(Number(cb.dataset.id));
  });

  $('pageSelect').addEventListener('change', (e) => {
    togglePage(e.target.checked);
  });

  $('prevPage').addEventListener('click', () => {
    if (state.page > 1) { state.page--; render(); }
  });

  $('nextPage').addEventListener('click', () => {
    state.page++;
    render();
  });

  $('btnClear').addEventListener('click', () => {
    state.selected.clear();
    saveSelection();
    render();
  });

  $('btnCsv').addEventListener('click', exportCsv);

  for (const th of document.querySelectorAll('thead th[data-sort]')) {
    th.addEventListener('click', () => {
      setSort(th.dataset.sort);
    });
  }

  window.addEventListener('resize', updateStickyOffset);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(updateStickyOffset);
    ro.observe($('controls'));
  }
}

export function init() {
  if (!SKILLS.length) {
    document.body.innerHTML =
      '<div class="empty">データが読み込まれていません。<br>' +
      '<code>data/skills.js</code> を確認し、<code>py extract_skills.py</code> を実行してください。</div>';
    return;
  }
  initMeta();
  initCategory();
  renderTypeChips();
  loadSettings();
  renderEffectChips();
  initCards();
  initScenarios();
  recomputeDerived();
  renderSettings();
  renderAptFilter();
  renderCardEvolution();
  renderScenarioEvolution();
  renderOcrThumbs();
  updateOcrCaptureHint();
  $('ocrFastMode').checked = state.ocrFastMode;
  $('ocrFastMode-wrap').classList.toggle('on', state.ocrFastMode);
  $('ocrAutoCrop').checked = state.ocrAutoCrop;
  $('ocrAutoCrop-wrap').classList.toggle('on', state.ocrAutoCrop);
  $('ocrSensitivity').value = state.ocrSensitivity;
  $('optBudget').value = String(state.optBudget);
  $('optUseFilter').checked = state.optUseFilter;
  $('optUseFilter-wrap').classList.toggle('on', state.optUseFilter);
  $('optMode').value = state.optMode;
  bind();
  updateStickyOffset();
  render();
  initGameData();
}
