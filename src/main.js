import { SKILL_DATA } from '../data/skills.js';
import './style.css';

(() => {
    'use strict';

    const DATA = SKILL_DATA || {};
    const SKILLS = Array.isArray(DATA.skills) ? DATA.skills : [];
    const META = DATA.meta || {};
    const CARD_INITIAL_SKILLS = DATA.cardInitialSkills || {};
    const CARD_GOLD_SKILL_EVOLUTIONS = DATA.cardGoldSkillEvolutions || {};
    const SCENARIOS = Array.isArray(DATA.scenarios) ? DATA.scenarios : [];
    const SCENARIO_EVOLUTIONS = DATA.scenarioEvolutions || {};
    const EVOLUTION_BASE_MAP = new Map();
    const ALL_EVOLUTIONS_BY_BASE = new Map();
    for (const entries of Object.values(CARD_GOLD_SKILL_EVOLUTIONS)) {
      for (const entry of entries) {
        EVOLUTION_BASE_MAP.set(entry.skill_id, entry.base_skill_id);
        const list = ALL_EVOLUTIONS_BY_BASE.get(entry.base_skill_id) || [];
        if (!list.includes(entry.skill_id)) list.push(entry.skill_id);
        ALL_EVOLUTIONS_BY_BASE.set(entry.base_skill_id, list);
      }
    }
    for (const entries of Object.values(SCENARIO_EVOLUTIONS)) {
      for (const entry of entries) {
        EVOLUTION_BASE_MAP.set(entry.skill_id, entry.base_skill_id);
        const list = ALL_EVOLUTIONS_BY_BASE.get(entry.base_skill_id) || [];
        if (!list.includes(entry.skill_id)) list.push(entry.skill_id);
        ALL_EVOLUTIONS_BY_BASE.set(entry.base_skill_id, list);
      }
    }
    const EFFECT_ORDER = ['速度', '加速', '回復', '緑', 'デバフ', '位置取り', '視野', 'ゲート', '特殊', 'その他'];
    const EFFECT_CLASS = {
      '速度': 'speed',
      '加速': 'accel',
      '回復': 'heal',
      '緑': 'green',
      'デバフ': 'debuff',
      '位置取り': 'position',
      '視野': 'sight',
      'ゲート': 'gate',
      '特殊': 'special',
      'その他': 'other',
    };
    const STORAGE_KEY = 'uma-skill-eval:selected:v1';
    const TYPE_ORDER = ['ノーマル', 'レア', '固有', '継承固有', '進化', '特殊', 'その他'];
    const TYPE_CLASS = {
      'ノーマル': 'normal',
      'レア': 'rare',
      '固有': 'unique',
      '継承固有': 'inherit',
      '進化': 'evolution',
      '特殊': 'special',
      'その他': 'other',
    };
    const TYPE_RANK = new Map(TYPE_ORDER.map((t, i) => [t, i]));

    // ヒントLvごとのSP減少率（ゲーム内仕様）
    const HINT_DISCOUNTS = { 0: 0, 1: 0.10, 2: 0.20, 3: 0.30, 4: 0.35, 5: 0.40 };
    const HINT_KEY = 'uma-skill-eval:hint:v1';
    const SETTINGS_KEY = 'uma-skill-eval:settings:v1';

    // 適性ランク → 評価点倍率（S/A=1.1, B/C=0.9, D/E/F=0.8, G=0.7）
    const APT_GRADES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const APT_MULT = { S: 1.1, A: 1.1, B: 0.9, C: 0.9, D: 0.8, E: 0.8, F: 0.8, G: 0.7 };
    const DISTANCE_META = {
      1: { short: '短', long: '短距離' },
      2: { short: 'マ', long: 'マイル' },
      3: { short: '中', long: '中距離' },
      4: { short: '長', long: '長距離' },
    };
    const STYLE_META = {
      1: { short: '逃', long: '逃げ' },
      2: { short: '先', long: '先行' },
      3: { short: '差', long: '差し' },
      4: { short: '追', long: '追込' },
    };
    const GROUND_META = {
      1: { short: '芝', long: '芝' },
      2: { short: 'ダ', long: 'ダート' },
    };
    const FILTER_CATEGORIES = [
      { key: 'distance', groupId: 'filterDistance', meta: DISTANCE_META },
      { key: 'ground', groupId: 'filterGround', meta: GROUND_META },
      { key: 'style', groupId: 'filterStyle', meta: STYLE_META },
    ];
    const OPT_MAX_BUDGET = 20000;
    const FAST_LEARNER_DISCOUNT = 0.10;
    const UNIQUE_POINT_PER_LEVEL = 170; // 本体固有スキル: 固有Lv × 170
    const INHERIT_UNIQUE_POINT = 180;   // 継承固有スキル: 一律180
    const DERIVED_KEYS = {
      eval_point: '_eval',
      upgrade_point: '_upgrade_point',
      sp: '_sp',
      total_sp: '_total_sp',
      efficiency: '_efficiency',
      total_efficiency: '_total_efficiency',
    };

    const $ = (id) => document.getElementById(id);
    const byId = new Map(SKILLS.map((s) => [s.skill_id, s]));
    const CARDS = (Array.isArray(DATA.cards) ? DATA.cards : []).filter((c) =>
      c.aptitude &&
      c.aptitude.distance && c.aptitude.distance['1'] &&
      c.aptitude.style && c.aptitude.style['1']
    );
    const cardsById = new Map(CARDS.map((c) => [c.card_id, c]));

    // 下位スキル連鎖（同じ group_id の下位 group_rate。rate ごとの代表は評価点最大）
    const REPRESENTATIVE = new Map();
    for (const s of SKILLS) {
      if (s.group_rate < 1) continue;
      const key = `${s.group_id}:${s.group_rate}`;
      const cur = REPRESENTATIVE.get(key);
      if (!cur || s.eval_point > cur.eval_point) REPRESENTATIVE.set(key, s);
    }
    const CHAINS = new Map();
    for (const s of SKILLS) {
      const chain = [];
      if (s.group_rate >= 1) {
        for (let rate = 1; rate < s.group_rate; rate++) {
          const lower = REPRESENTATIVE.get(`${s.group_id}:${rate}`);
          if (lower) chain.push(lower);
        }
      }
      CHAINS.set(s.skill_id, chain);
    }

    const state = {
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
    let lastOptimization = null;

    // ---------- image recognition (OCR) ----------
    const OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    const OCR_FONT_URL = 'assets/umamusume-font.ttf';
    const OCR_MAX_IMAGES = 120;
    const OCR_SENSITIVITY = {
      high: { full: 3, region: 0.8, stableFull: 1, stableRegion: 0.4 },
      medium: { full: 5, region: 1.5, stableFull: 2, stableRegion: 0.8 },
      low: { full: 8, region: 3, stableFull: 3, stableRegion: 1.5 },
    };
    let ocrImages = [];
    let ocrMode = 'skills';
    let ocrWorkers = [];
    let ocrEngWorker = null;
    let ocrWorkerPromise = null;
    let ocrImageSeq = 0;
    let ocrFontPromise = null;
    let ocrFontReady = false;
    const ocrFontCache = new Map();
    const ocrFontCharCache = new Map();
    let ocrCapture = {
      stream: null,
      video: null,
      sampleTimer: null,
      lastFullSig: null,
      lastRegionSig: null,
      lastSampleAt: 0,
      changed: false,
      stableCount: 0,
      lastCaptureAt: 0,
      autoActive: false,
      processorReader: null,
      frameLoopStarted: false,
    };

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    }

    function normalize(value) {
      return String(value == null ? '' : value).toLowerCase().normalize('NFKC');
    }

    function formatNumber(n) {
      return Number(n).toLocaleString('ja-JP');
    }

    function formatDate(iso) {
      if (!iso) return '不明';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    }

    // 検索用の正規化済み文字列をあらかじめ作っておく
    for (const s of SKILLS) {
      s._hay = normalize(`${s.name} ${s.description} ${s.skill_id} ${s.type} ${s.category_label} ${s.effect_category || ''}`);
      s._descOneLine = String(s.description || '').replace(/\s*\n+\s*/g, ' ');
    }

    // 選択状態を復元
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        for (const id of JSON.parse(raw)) {
          const n = Number(id);
          if (byId.has(n)) state.selected.add(n);
        }
      }
    } catch (err) { /* localStorage が使えない環境でも動作させる */ }

    function saveSelection() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.selected]));
      } catch (err) { /* ignore */ }
    }

    // ヒントLv設定を復元（旧形式の default は使わず、個別設定のみ引き継ぐ）
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

    function saveHint() {
      try {
        localStorage.setItem(HINT_KEY, JSON.stringify({
          overrides: Object.fromEntries(state.hintLevels),
        }));
      } catch (err) { /* ignore */ }
    }

    // 査定設定（切れ者・固有Lv・適性・ウマ娘・フィルタ・最適化）を復元
    function loadSettings() {
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

    function saveSettings() {
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

    function discountPct(level) {
      return Math.round((HINT_DISCOUNTS[level] || 0) * 100);
    }

    function effectiveHint(skillId) {
      return state.hintLevels.get(skillId) || 0;
    }

    // 切れ者はヒント割引に加算（例: Lv5 + 切れ者 = −50%）
    function spDiscountRate(level) {
      let rate = HINT_DISCOUNTS[level] || 0;
      if (state.fastLearner) rate += FAST_LEARNER_DISCOUNT;
      return Math.min(1, Math.max(0, rate));
    }

    // ゲーム内と同じく、割引後のSPは小数点以下切り捨て
    function applyHintDiscount(sp, level) {
      if (sp == null) return null;
      return Math.max(0, Math.floor(sp * (1 - spDiscountRate(level)) + 1e-9));
    }

    function parseAptList(value) {
      const parts = Array.isArray(value) ? value : String(value == null ? '' : value).split('/');
      return parts
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x >= 1 && x <= 4);
    }

    function aptitudeText(s) {
      const parts = [];
      const distances = parseAptList(s.apt_distance);
      const styles = parseAptList(s.apt_style);
      const grounds = parseAptList(s.apt_ground);
      if (distances.length) {
        parts.push('距離 ' + distances.map((id) => DISTANCE_META[id].long).join('/'));
      }
      if (styles.length) {
        parts.push('脚質 ' + styles.map((id) => STYLE_META[id].long).join('/'));
      }
      if (grounds.length) {
        parts.push('馬場 ' + grounds.map((id) => GROUND_META[id].long).join('/'));
      }
      return parts.length ? parts.join('・') : 'なし';
    }

    // 適性フィルタ: 距離・馬場・脚質のいずれかの条件が一致すれば表示
    function skillMatchesAptFilter(s) {
      const filter = state.aptFilter;
      if (!filter.distance.size && !filter.ground.size && !filter.style.size) return true;
      const distances = parseAptList(s.apt_distance);
      const styles = parseAptList(s.apt_style);
      const grounds = parseAptList(s.apt_ground);
      if (!distances.length && !styles.length && !grounds.length) {
        return state.includeGeneral;
      }
      return (
        distances.some((id) => filter.distance.has(id)) ||
        styles.some((id) => filter.style.has(id)) ||
        grounds.some((id) => filter.ground.has(id))
      );
    }

    // 適性による評価点倍率。固有・継承固有は対象外。
    function aptitudeFactors(s) {
      if (s.type === '固有' || s.type === '継承固有') return [];
      const factors = [];
      const distances = parseAptList(s.apt_distance);
      const styles = parseAptList(s.apt_style);
      if (distances.length) {
        const mult = Math.max(...distances.map((id) =>
          APT_MULT[state.aptitude.distance[id] || 'A']));
        factors.push(mult);
      }
      if (styles.length) {
        const mult = Math.max(...styles.map((id) =>
          APT_MULT[state.aptitude.style[id] || 'A']));
        factors.push(mult);
      }
      return factors;
    }

    // uma-tools と同じく単精度で積算し、最後に四捨五入
    function adjustedEval(s) {
      if (s.type === '固有') return state.uniqueLevel * UNIQUE_POINT_PER_LEVEL;
      if (s.type === '継承固有') return INHERIT_UNIQUE_POINT;
      let value = Math.fround(Number(s.eval_point) || 0);
      for (const factor of aptitudeFactors(s)) {
        value = Math.fround(value * Math.fround(factor));
      }
      return Math.round(value);
    }

    // ヒントLv・切れ者・適性を反映した評価点/SP/効率を各スキルに持たせる
    function recomputeDerived() {
      // 1周目: 適性倍率を反映した評価点（下位スキル参照より先に全件計算）
      for (const s of SKILLS) {
        const factors = aptitudeFactors(s);
        s._apt_factor = factors.reduce((acc, factor) => acc * factor, 1);
        s._eval = adjustedEval(s);
      }

      // 2周目: SP割引・下位スキル連鎖・効率
      for (const s of SKILLS) {
        const hint = effectiveHint(s.skill_id);
        let sp = applyHintDiscount(s.sp, hint);
        let prereqSp = 0;
        let prereqEval = 0;
        for (const lower of CHAINS.get(s.skill_id) || []) {
          if (lower.sp != null) {
            prereqSp += applyHintDiscount(lower.sp, effectiveHint(lower.skill_id)) || 0;
          }
          prereqEval = Math.max(prereqEval, lower._eval);
        }
        let totalSp = s.sp == null ? null : sp + prereqSp;
        let evolutionBase = null;
        let evolutionBaseTotalSp = null;

        // 進化スキルは進化元の金スキルのSPをコストとして扱う
        if (s.sp == null) {
          const baseId = EVOLUTION_BASE_MAP.get(s.skill_id);
          const base = baseId != null ? byId.get(baseId) : null;
          if (base && base.sp != null) {
            evolutionBase = base;
            const baseHint = effectiveHint(base.skill_id);
            const baseSp = applyHintDiscount(base.sp, baseHint);
            let basePrereqSp = 0;
            for (const lower of CHAINS.get(base.skill_id) || []) {
              if (lower.sp != null) {
                basePrereqSp += applyHintDiscount(lower.sp, effectiveHint(lower.skill_id)) || 0;
              }
            }
            sp = baseSp;
            prereqSp = basePrereqSp;
            totalSp = baseSp == null ? null : baseSp + basePrereqSp;
            evolutionBaseTotalSp = base.total_sp == null ? null : base.total_sp;
            prereqEval = base._eval;
          }
        }

        s._hint = hint;
        s._sp = sp;
        s._total_sp = totalSp;
        s._prereq_sp = s.sp == null && !evolutionBase ? 0 : prereqSp;
        s._prereq_eval = prereqEval;
        s._upgrade_point = s._eval - prereqEval;
        s._efficiency = sp != null && sp > 0 ? s._upgrade_point / sp : null;
        s._total_efficiency = totalSp != null && totalSp > 0 ? s._eval / totalSp : null;
        s._evolution_base = evolutionBase ? evolutionBase.skill_id : null;
        s._evolution_base_name = evolutionBase ? evolutionBase.name : '';
        s._evolution_base_total_sp = evolutionBaseTotalSp;
        s._evolution_base_prereq_sp = evolutionBase ? evolutionBase.prereq_sp : null;
      }

      invalidateOptimization();
    }

    function initMeta() {
      const total = SKILLS.length;
      const db = formatDate(META.db_mtime);
      const generated = formatDate(META.generated_at);
      $('meta').innerHTML =
        `収録 <b>${formatNumber(total)}</b> スキル（特殊・期限切れを除く）<br>` +
        `DB更新 ${escapeHtml(db)} ／ 抽出 ${escapeHtml(generated)}`;
    }

    function initCategory() {
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

    function renderTypeChips() {
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

    function aptClass(grade) {
      if (grade === 'S' || grade === 'A') return 'apt-good';
      if (grade === 'B' || grade === 'C') return 'apt-mid';
      return 'apt-bad';
    }

    function effectCounts() {
      const counts = new Map();
      for (const s of SKILLS) {
        const cat = s.effect_category || 'その他';
        counts.set(cat, (counts.get(cat) || 0) + 1);
      }
      return counts;
    }

    function renderEffectChips() {
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

    function evolutionSkillName(id) {
      const s = byId.get(id);
      return s ? s.name : `#${id}`;
    }

    function evolutionOptionsForBase(baseSkillId) {
      if (state.cardId == null) return [];
      const entries = CARD_GOLD_SKILL_EVOLUTIONS[String(state.cardId)] || [];
      return entries
        .filter((e) => e.base_skill_id === baseSkillId)
        .map((e) => byId.get(e.skill_id))
        .filter(Boolean);
    }

    function selectEvolutionOption(baseSkillId, selectSkillId) {
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

    function renderCardEvolution() {
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

    function initScenarios() {
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

    function renderScenarioEvolution() {
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
            `data-scenario-evo-base="${e.base_skill_id}" data-scenario-evo-select="${e.skill_id}">` +
            `${selected ? '選択済み' : '選択'}</button>` +
          `</div>`;
      }).join('');
      list.innerHTML = items || '<div class="scenario-evo-empty">進化スキルがありません。</div>';
    }

    function renderSettings() {
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

    function initCards() {
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

    function updateCardInfo() {
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

    function applyCardAptitudes(card) {
      if (!card) return;
      for (const id of ['1', '2', '3', '4']) {
        state.aptitude.distance[id] = card.aptitude.distance[id] || 'A';
        state.aptitude.style[id] = card.aptitude.style[id] || 'A';
      }
    }

    function renderAptFilter() {
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

    function onFilterChanged() {
      saveSettings();
      invalidateOptimization();
      state.page = 1;
      renderAptFilter();
      render();
    }

    function filteredSkills(options = {}) {
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

    function invalidateOptimization() {
      if (!lastOptimization) return;
      lastOptimization = null;
      const apply = $('btnApplyOpt');
      if (apply) apply.disabled = true;
      const out = $('optResult');
      if (out) out.innerHTML = '<div class="opt-note">設定が変更されました。再計算してください。</div>';
    }

    function optimizerCandidates() {
      let pool;
      if (state.selected.size > 0) {
        // 選択中のスキルがある場合は、その選択だけを候補にする
        pool = [...state.selected].map((id) => byId.get(id)).filter(Boolean);
      } else {
        pool = state.optUseFilter ? filteredSkills() : SKILLS;
      }
      return pool.filter((s) =>
        s.sp != null && s.sp > 0 &&
        s._total_sp != null && s._total_sp > 0 &&
        s._eval > 0 &&
        s.group_rate >= 0 &&
        s.type !== '特殊'
      );
    }

    // グループごとに「どの上位段階まで取るか」を選ぶ多重選択ナップサック。
    // 価値 = 適性込み評価点、コスト = 下位込みSP（ヒント・切れ者込み）。
    function optimizeSkills(budget) {
      const candidates = optimizerCandidates();
      if (!candidates.length) return null;

      const groups = new Map();
      for (const s of candidates) {
        const list = groups.get(s.group_id);
        if (list) list.push(s);
        else groups.set(s.group_id, [s]);
      }
      const groupList = [...groups.values()];
      const sumMax = groupList.reduce(
        (sum, packages) => sum + Math.max(...packages.map((p) => p._total_sp)),
        0
      );
      const maxBudget = Math.max(0, Math.min(Math.floor(budget), OPT_MAX_BUDGET, sumMax));
      const dp = new Float64Array(maxBudget + 1).fill(-Infinity);
      dp[0] = 0;

      const choices = [];
      for (const packages of groupList) {
        const costs = packages.map((p) => p._total_sp);
        const values = packages.map((p) => p._eval);
        const choice = new Int16Array(maxBudget + 1).fill(-1);
        for (let b = maxBudget; b >= 0; b--) {
          let best = dp[b];
          let bestIdx = -1;
          for (let i = 0; i < packages.length; i++) {
            const cost = costs[i];
            if (cost > b) continue;
            const prev = dp[b - cost];
            if (prev === -Infinity) continue;
            const value = prev + values[i];
            if (value > best || (value === best && bestIdx !== -1 && cost < costs[bestIdx])) {
              best = value;
              bestIdx = i;
            }
          }
          dp[b] = best;
          choice[b] = bestIdx;
        }
        choices.push(choice);
      }

      let bestBudget = -1;
      let bestValue = -Infinity;
      for (let b = 0; b <= maxBudget; b++) {
        if (dp[b] > bestValue) {
          bestValue = dp[b];
          bestBudget = b;
        }
      }
      if (bestBudget < 0 || bestValue === -Infinity) return null;

      const chosen = [];
      let b = bestBudget;
      for (let g = groupList.length - 1; g >= 0; g--) {
        const idx = choices[g][b];
        if (idx >= 0) {
          const skill = groupList[g][idx];
          chosen.push(skill);
          b -= skill._total_sp;
        }
      }
      chosen.sort((a, b2) =>
        a.group_id - b2.group_id || a.group_rate - b2.group_rate || a.skill_id - b2.skill_id
      );

      return {
        chosen,
        totalEval: bestValue,
        totalSp: bestBudget,
        efficiency: bestBudget > 0 ? bestValue / bestBudget : null,
        candidates: candidates.length,
        groups: groupList.length,
        budget: Math.floor(budget),
        capped: budget > OPT_MAX_BUDGET,
      };
    }

    function runOptimization() {
      const input = $('optBudget');
      const budget = Math.max(0, Math.min(OPT_MAX_BUDGET, Math.floor(Number(input.value) || 0)));
      state.optBudget = budget;
      if (input) input.value = String(budget);
      saveSettings();

      const started = performance.now();
      const result = optimizeSkills(budget);
      const elapsed = performance.now() - started;
      lastOptimization = result;

      const out = $('optResult');
      const apply = $('btnApplyOpt');
      if (!result || !result.chosen.length) {
        out.innerHTML =
          '<div class="opt-note">条件に合うSP取得可能スキルがありません。絞り込み条件や予算を確認してください。</div>';
        if (apply) apply.disabled = true;
        return;
      }
      if (apply) apply.disabled = false;

      const efficiency = result.efficiency == null ? '—' : result.efficiency.toFixed(2);
      const items = result.chosen.map((s) =>
        `<li>${escapeHtml(s.name)}` +
        `<span class="opt-meta">SP ${formatNumber(s._total_sp)} / 評価 ${formatNumber(s._eval)}</span></li>`
      ).join('');
      out.innerHTML =
        `<div class="opt-summary">最大評価点 <b>${formatNumber(result.totalEval)}</b> ／ ` +
        `合計SP <b>${formatNumber(result.totalSp)}</b> ／ 評価効率 <b>${efficiency}</b></div>` +
        `<div class="opt-note">対象 ${formatNumber(result.candidates)} スキル` +
        `（${formatNumber(result.groups)} グループ）・計算 ${elapsed.toFixed(0)}ms` +
        (result.capped ? `・予算上限 ${formatNumber(OPT_MAX_BUDGET)}SP` : '') +
        `</div>` +
        `<ol class="opt-list">${items}</ol>`;
    }

    function applyOptimizationResult() {
      if (!lastOptimization || !lastOptimization.chosen.length) return;
      // SP対象外（固有など）の選択は保持し、SP取得スキルだけを入れ替える
      const keep = [...state.selected]
        .map((id) => byId.get(id))
        .filter((s) => s && s.sp == null);
      const next = new Set(keep.map((s) => s.skill_id));
      for (const s of lastOptimization.chosen) addSkillWithChain(s.skill_id, next);
      state.selected = next;
      saveSelection();
      render();
    }

    // ---------- image recognition (OCR) ----------

    function ocrSetStatus(text) {
      const el = $('ocrStatus');
      if (el) el.textContent = text;
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }

    function renderOcrThumbs() {
      const wrap = $('ocrThumbs');
      if (!wrap) return;
      wrap.innerHTML = ocrImages.map((img) =>
        `<div class="ocr-thumb">` +
          `<button type="button" class="ocr-thumb-remove" data-ocr-remove="${img.id}" title="削除">×</button>` +
          `<img src="${img.dataUrl}" alt="">` +
          `<div class="ocr-thumb-name">${escapeHtml(img.name)}</div>` +
        `</div>`
      ).join('');
      $('ocrRun').disabled = ocrImages.length === 0;
      $('ocrDrop').textContent = ocrImages.length
        ? `${ocrImages.length} 枚を追加済み。さらに追加できます。`
        : 'ここに画像をドラッグ＆ドロップ（複数可）';
    }

    function addOcrCanvas(canvas, name) {
      if (ocrImages.length >= OCR_MAX_IMAGES) {
        ocrSetStatus(`画像は最大 ${OCR_MAX_IMAGES} 枚までです。`);
        return false;
      }
      const hash = ocrCanvasHash(canvas);
      if (ocrImages.some((img) => img.hash === hash)) {
        ocrSetStatus('同じ画面のため追加をスキップしました。');
        return false;
      }
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      ocrImages.push({
        id: ++ocrImageSeq,
        name,
        dataUrl,
        hash,
        width: canvas.width,
        height: canvas.height,
      });
      renderOcrThumbs();
      return true;
    }

    async function ocrAddFile(file) {
      if (!file || !String(file.type || '').startsWith('image/')) return;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const img = await loadImage(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const added = addOcrCanvas(canvas, file.name || `画像${ocrImageSeq + 1}`);
      if (added) {
        ocrSetStatus(`${ocrImages.length} 枚の画像を追加しました。「認識開始」を押してください。`);
      }
    }

    async function pasteOcrImage() {
      try {
        if (!navigator.clipboard || !navigator.clipboard.read) {
          throw new Error('このブラウザはクリップボード読み取りに対応していません');
        }
        const items = await navigator.clipboard.read();
        let added = 0;
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const blob = await item.getType(type);
          await ocrAddFile(new File([blob], 'clipboard.png', { type }));
          added++;
        }
        if (!added) ocrSetStatus('クリップボードに画像がありませんでした。');
      } catch (err) {
        ocrSetStatus(`クリップボードから読み取れませんでした: ${err.message || err}`);
      }
    }

    // ---------- OCR text normalization / fuzzy matching ----------

    function ocrNormalizeText(text) {
      return String(text || '')
        .normalize('NFKC')
        .replace(/\s+/g, '')
        .replace(/[、。，．,.:;：；・\/\\|｜_＿~〜\-―–—]/g, '')
        .replace(/[「」『』（）()【】\[\]{}<>＜＞]/g, '')
        .replace(/〇/g, '○')
        .replace(/◯/g, '○')
        .toUpperCase();
    }

    function ocrStripHintCost(text) {
      return String(text || '')
        .replace(/ヒント\s*[Ll][vV]\.?\s*\d.*$/i, '')
        .replace(/\d+\s*%\s*OFF.*$/i, '')
        .replace(/\s+\d{2,4}\s*$/, '')
        .trim();
    }

    function ocrBigrams(text) {
      const set = new Set();
      if (!text) return set;
      if (text.length === 1) { set.add(text); return set; }
      for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
      return set;
    }

    function ocrLevenshtein(a, b) {
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      let prev = new Array(b.length + 1);
      let cur = new Array(b.length + 1);
      for (let j = 0; j <= b.length; j++) prev[j] = j;
      for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= b.length; j++) {
          const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
          cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        const tmp = prev; prev = cur; cur = tmp;
      }
      return prev[b.length];
    }

    function ocrJaccard(a, b) {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      return inter / (a.size + b.size - inter);
    }

    function ocrCommonPrefix(a, b) {
      const n = Math.min(a.length, b.length);
      let i = 0;
      while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
      return i;
    }

    function ocrSimilarity(a, b, aBigrams, bBigrams) {
      if (!a || !b) return 0;
      if (a === b) return 1;
      if (a.includes(b) || b.includes(a)) {
        const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
        return 0.75 + 0.2 * ratio;
      }
      const dist = ocrLevenshtein(a, b);
      const edit = 1 - dist / Math.max(a.length, b.length);
      const bg = ocrJaccard(aBigrams || ocrBigrams(a), bBigrams || ocrBigrams(b));
      const prefix = ocrCommonPrefix(a, b) / Math.min(a.length, b.length);
      return 0.55 * edit + 0.3 * bg + 0.15 * prefix;
    }

    let ocrSkillIndex = null;
    function getOcrSkillIndex() {
      if (!ocrSkillIndex) {
        ocrSkillIndex = SKILLS.map((s) => {
          const norm = ocrNormalizeText(s.name);
          return { skill: s, norm, bigrams: ocrBigrams(norm) };
        });
      }
      return ocrSkillIndex;
    }

    let ocrCharaIndex = null;
    function getOcrCharaIndex() {
      if (!ocrCharaIndex) {
        const map = new Map();
        for (const card of CARDS) {
          const name = card.chara_name || '';
          if (!name) continue;
          if (!map.has(name)) map.set(name, []);
          map.get(name).push(card);
        }
        ocrCharaIndex = [...map.entries()].map(([name, cards]) => ({
          name,
          norm: ocrNormalizeText(name),
          bigrams: ocrBigrams(ocrNormalizeText(name)),
          cards,
        }));
      }
      return ocrCharaIndex;
    }

    function ocrSkillCandidates(norm, limit = 8, minScore = 0.35) {
      if (!norm || norm.length < 2) return [];
      if (/^\d+$/.test(norm)) return [];
      if (/^(スキル|ヒント|獲得|SP|閉じる|戻る|次へ|前へ|確認|キャンセル|ウマ娘|育成|レース)$/.test(norm)) return [];
      const lineBigrams = ocrBigrams(norm);
      const scored = [];
      for (const entry of getOcrSkillIndex()) {
        if (!entry.norm) continue;
        const lenDiff = Math.abs(entry.norm.length - norm.length);
        const maxAllowed = Math.max(2, Math.round(entry.norm.length * 0.35));
        if (lenDiff > maxAllowed) continue;
        const score = ocrSimilarity(norm, entry.norm, lineBigrams, entry.bigrams);
        if (score >= minScore) scored.push({ skill: entry.skill, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    }

    function ocrBestSkillMatch(norm) {
      const minScore = norm && norm.length <= 3 ? 0.78 : 0.55;
      const list = ocrSkillCandidates(norm, 1, minScore);
      return list.length ? list[0] : null;
    }

    function ocrSubstringSimilarity(a, b, aBigrams, bBigrams) {
      const dist = ocrLevenshtein(a, b);
      const edit = 1 - dist / Math.max(a.length, b.length);
      const bg = ocrJaccard(aBigrams || ocrBigrams(a), bBigrams || ocrBigrams(b));
      return 0.8 * edit + 0.2 * bg;
    }

    function ocrBestSkillSubstringMatch(norm) {
      if (!norm || norm.length < 2) return null;
      let best = null;
      for (const entry of getOcrSkillIndex()) {
        if (!entry.norm) continue;
        const n = entry.norm.length;
        for (const len of [n - 1, n, n + 1]) {
          if (len < 2 || len > norm.length) continue;
          if (norm.length > 8 && len < 4) continue;
          for (let start = 0; start <= norm.length - len; start++) {
            const sub = norm.slice(start, start + len);
            const coverage = len / norm.length;
            if (norm.length > 12 && coverage < 0.4) continue;
            const score = ocrSubstringSimilarity(sub, entry.norm, ocrBigrams(sub), entry.bigrams);
            if (score < 0.55) continue;
            const adjusted = score * (0.8 + 0.2 * coverage);
            if (!best || adjusted > best.adjusted) {
              best = { skill: entry.skill, score, adjusted, sub };
            }
          }
        }
      }
      return best;
    }

    function ocrExtractCost(text) {
      const norm = String(text || '').normalize('NFKC');
      const nums = [...norm.matchAll(/\d{2,4}/g)]
        .map((m) => Number(m[0]))
        .filter((n) => n >= 20 && n <= 500);
      return nums.length ? nums[nums.length - 1] : null;
    }

    function ocrExtractHint(text) {
      if (!text) return null;
      const t = String(text).normalize('NFKC');
      let m = t.match(/ヒント\s*[Ll][vV]\.?\s*([1-5])/);
      if (m) return Number(m[1]);
      m = t.match(/(?:レベル|ﾚﾍﾞﾙ)\s*([1-5])/);
      if (m) return Number(m[1]);
      if (/35\s*%/.test(t)) return 4;
      m = t.match(/([1-5])\s*0\s*%/);
      if (m) return Number(m[1]);
      m = t.match(/([1-5])\s*%\s*(?:OFF|off|割引)/);
      if (m) return Number(m[1]);
      m = t.match(/ヒント.{0,4}?([1-5])/);
      if (m) return Number(m[1]);
      m = t.match(/[Ll][vV]\.?\s*([1-5])/);
      if (m) return Number(m[1]);
      return null;
    }

    function ocrInferHint(baseSp, observedCost) {
      if (!Number.isFinite(baseSp) || baseSp <= 0 || !Number.isFinite(observedCost)) return null;
      let bestHint = null;
      let bestError = Infinity;
      for (let h = 0; h <= 5; h++) {
        const expected = Math.floor(baseSp * (1 - (HINT_DISCOUNTS[h] || 0)) + 1e-9);
        const err = Math.abs(expected - observedCost);
        if (err < bestError) {
          bestError = err;
          bestHint = h;
        }
      }
      const tolerance = Math.max(3, Math.round(baseSp * 0.03));
      return bestError <= tolerance ? bestHint : null;
    }

    function ocrGroupLinesIntoRows(lines) {
      const withBox = lines.filter((l) => l.bbox && Number.isFinite(l.bbox.y0));
      if (!withBox.length) return lines.map((l) => ({ lines: [l], y0: 0, y1: 0, cy: 0 }));
      const sorted = withBox.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
      const rows = [];
      for (const line of sorted) {
        const h = Math.max(1, line.bbox.y1 - line.bbox.y0);
        const cy = (line.bbox.y0 + line.bbox.y1) / 2;
        let row = null;
        for (const r of rows) {
          if (Math.abs(r.cy - cy) <= Math.max(5, h * 0.55)) {
            row = r;
            break;
          }
        }
        if (!row) {
          row = { lines: [], cy, y0: line.bbox.y0, y1: line.bbox.y1 };
          rows.push(row);
        }
        row.lines.push(line);
        row.cy = (row.cy * (row.lines.length - 1) + cy) / row.lines.length;
        row.y0 = Math.min(row.y0, line.bbox.y0);
        row.y1 = Math.max(row.y1, line.bbox.y1);
      }
      for (const row of rows) row.lines.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      rows.sort((a, b) => a.y0 - b.y0);
      return rows;
    }

    function ocrParseSkillData(data, canvas) {
      const rawText = String(data.text || '');
      const lines = (Array.isArray(data.lines) && data.lines.length
        ? data.lines
        : rawText.split(/\r?\n/).map((t) => ({ text: t, confidence: data.confidence || 0 })))
        .map((l) => ({
          text: String(l.text || '').trim(),
          confidence: Number(l.confidence) || 0,
          bbox: l.bbox || null,
        }))
        .filter((l) => l.text);

      const rows = ocrGroupLinesIntoRows(lines);
      const results = [];

      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const rowText = row.lines.map((l) => l.text).join(' ');
        let best = null;

        for (const line of row.lines) {
          if (line.bbox && canvas && line.bbox.x0 > canvas.width * 0.55) continue;
          if (/試験ボーナス|進化条件達成|説明省略|スキルセット|リセット|決定/.test(line.text)) continue;
          const norm = ocrNormalizeText(ocrStripHintCost(line.text));
          if (norm.length < 2) continue;
          let candidate = ocrBestSkillSubstringMatch(norm.replace(/\d{2,4}$/, ''));
          if (candidate) candidate = { ...candidate, line, span: 1, normUsed: norm };

          if (!candidate || candidate.score < 0.75) {
            const nextRowText = rows[ri + 1]?.lines.map((l) => l.text).join('') || '';
            if (nextRowText) {
              const mergedNorm = norm + ocrNormalizeText(nextRowText);
              const merged = ocrBestSkillMatch(mergedNorm.replace(/\d{2,4}$/, ''));
              if (merged && (!candidate || merged.score > candidate.score)) {
                candidate = { ...merged, line, span: 2, normUsed: mergedNorm };
              }
            }
          }
          if (candidate && (!best || (candidate.adjusted || candidate.score) > (best.adjusted || best.score))) best = candidate;
        }

        if (!best) {
          const fallbackNorm = ocrNormalizeText(rowText);
          const match = ocrBestSkillSubstringMatch(fallbackNorm.replace(/\d{2,4}$/, ''));
          if (match) best = { ...match, line: row.lines[0] || null, span: 1, normUsed: fallbackNorm };
        }
        if (!best) continue;

        // ゲーム内フォントで候補を画像照合し、OCRの文字誤りを補正する
        const matchCoverage = best.sub && best.normUsed ? best.sub.length / best.normUsed.length : 1;
        if (ocrFontReady && canvas && best.line && best.line.bbox && best.normUsed && matchCoverage >= 0.7) {
          const lineCanvas = ocrCropLine(canvas, best.line.bbox);
          if (lineCanvas) {
            const candidates = ocrSkillCandidates(best.normUsed.replace(/\d{2,4}$/, ''), 12, 0.15);
            if (candidates.length) {
              const reranked = ocrFontRerank(candidates, lineCanvas);
              if (reranked && Math.max(reranked.imageScore || 0, reranked.suffixScore || 0) >= 0.2) {
                const different = reranked.skill.skill_id !== best.skill.skill_id;
                const strongImage = (reranked.imageScore || 0) >= 0.7 || (reranked.suffixScore || 0) >= 0.75;
                if (!different) {
                  best = {
                    ...best,
                    score: Math.max(best.score, reranked.combined),
                    imageScore: reranked.imageScore,
                  };
                } else if (strongImage) {
                  best = {
                    ...best,
                    skill: reranked.skill,
                    score: Math.max(best.score, reranked.combined),
                    imageScore: reranked.imageScore,
                  };
                }
              }
            }
          }
        }

        // 同じ行の右側（ヒントLv・SP）を優先して読む
        let rightText = '';
        if (best.line && best.line.bbox) {
          rightText = row.lines
            .filter((l) => l.bbox && l.bbox.x0 > best.line.bbox.x1 - 5)
            .map((l) => l.text)
            .join(' ');
        }

        const rowNorm = ocrNormalizeText(rowText);
        const skillNorm = ocrNormalizeText(best.skill.name);
        const rowIsJustName = rowNorm === skillNorm ||
          (rowNorm.includes(skillNorm) && rowNorm.length <= skillNorm.length + 2);

        let hint = ocrExtractHint(rightText);
        let observedCost = ocrExtractCost(rightText);
        if (!rowIsJustName) {
          if (hint == null) hint = ocrExtractHint(rowText);
          if (observedCost == null) observedCost = ocrExtractCost(rowText);
        }

        // 同じ行に無ければ、次の行（名前の下にヒント/SPがあるレイアウト）を見る
        if (hint == null && observedCost == null && rows[ri + 1]) {
          const nextText = rows[ri + 1].lines.map((l) => l.text).join(' ');
          hint = ocrExtractHint(nextText);
          observedCost = ocrExtractCost(nextText);
        }

        // それでも無ければ、行順の前後を見る
        if (hint == null && observedCost == null) {
          const idx = best.line ? lines.indexOf(best.line) : -1;
          const nextText = idx >= 0 ? (lines[idx + 1]?.text || '') : '';
          hint = ocrExtractHint(nextText);
          observedCost = ocrExtractCost(nextText);
        }

        if (hint == null && observedCost != null) hint = ocrInferHint(best.skill.sp, observedCost);

        const lineConf = ((best.line?.confidence || 0) / 100);
        const costBonus = observedCost != null ? 0.1 : 0;
        const confidence = Math.min(1, best.score * 0.7 + Math.max(lineConf, 0.5) * 0.2 + costBonus);

        results.push({
          skill: best.skill,
          hint: hint == null ? null : hint,
          cost: observedCost,
          score: best.score,
          confidence,
          line: best.line?.text || rowText,
          lineObj: best.line || null,
        });
      }

      return { results, rawText };
    }

    function ocrParseCharacterData(data) {
      const rawText = String(data.text || '');
      const lines = (Array.isArray(data.lines) && data.lines.length
        ? data.lines
        : rawText.split(/\r?\n/).map((t) => ({ text: t, confidence: data.confidence || 0 })))
        .map((l) => ({ text: String(l.text || '').trim(), confidence: Number(l.confidence) || 0 }))
        .filter((l) => l.text);

      const candidates = [];
      for (const entry of getOcrCharaIndex()) {
        let bestScore = 0;
        let bestLine = '';
        for (const line of lines) {
          const norm = ocrNormalizeText(line.text);
          if (!norm) continue;
          const score = ocrSimilarity(norm, entry.norm, ocrBigrams(norm), entry.bigrams);
          if (score > bestScore) {
            bestScore = score;
            bestLine = line.text;
          }
        }
        if (bestScore >= 0.55) {
          for (const card of entry.cards) {
            candidates.push({
              card,
              charaScore: bestScore,
              displayScore: 0,
              score: bestScore,
              line: bestLine,
            });
          }
        }
      }

      // 衣装名（[スペシャルドリーマー] など）が写っていればカードを特定しやすくする。
      // キャラ名だけの行は全カードに部分一致してしまうため、衣装名で照合する。
      let maxCostumeScore = 0;
      for (const c of candidates) {
        const costumeNorm = ocrNormalizeText(c.card.costume_name || '');
        const costumeBigrams = ocrBigrams(costumeNorm);
        let bestCostume = 0;
        for (const line of lines) {
          const norm = ocrNormalizeText(line.text);
          if (!norm) continue;
          const score = ocrSimilarity(norm, costumeNorm, ocrBigrams(norm), costumeBigrams);
          if (score > bestCostume) {
            bestCostume = score;
            if (score > c.charaScore) c.line = line.text;
          }
        }
        c.costumeScore = bestCostume;
        if (bestCostume > maxCostumeScore) maxCostumeScore = bestCostume;
      }

      // 衣装名が十分に読めている場合は衣装一致を優先する。
      // キャラ名しか読めていない場合は同名カードを並べ、ユーザーに選ばせる。
      const useCostume = maxCostumeScore >= 0.7;
      for (const c of candidates) {
        c.score = useCostume
          ? c.charaScore * 0.35 + c.costumeScore * 0.65
          : c.charaScore;
      }

      candidates.sort((a, b) => b.score - a.score || a.card.card_id - b.card.card_id);
      return { candidates, rawText };
    }

    function mergeOcrSkillResults(results) {
      const map = new Map();
      for (const r of results) {
        const id = r.skill.skill_id;
        const cur = map.get(id);
        if (!cur) {
          map.set(id, r);
          continue;
        }
        if (r.hintSource === 'badge' && cur.hintSource !== 'badge') {
          map.set(id, { ...cur, hint: r.hint, hintSource: 'badge' });
          continue;
        }
        if (cur.hintSource === 'badge' && r.hintSource !== 'badge') continue;
        const better =
          r.confidence > cur.confidence ||
          (r.hint != null && cur.hint == null) ||
          (r.hint != null && cur.hint != null && r.confidence >= cur.confidence);
        if (better) map.set(id, r);
      }
      return map;
    }

    function applyOcrSkillResults() {
      const hintMap = new Map();
      for (const sel of $('ocrResult').querySelectorAll('select[data-ocr-hint]')) {
        hintMap.set(Number(sel.dataset.ocrHint), Number(sel.value) || 0);
      }
      for (const [id, hint] of hintMap) {
        if (hint > 0) state.hintLevels.set(id, hint);
        else state.hintLevels.delete(id);
      }
      saveHint();
      if ($('ocrSelectSkills')?.checked) {
        for (const id of hintMap.keys()) addSkillWithChain(id);
        saveSelection();
      }
      recomputeDerived();
      renderCardEvolution();
      renderScenarioEvolution();
      render();
      ocrSetStatus(`${formatNumber(hintMap.size)} 件のヒントLvを反映しました。`);
    }

    function renderOcrSkillResults(merged, rawText) {
      const items = [...merged.values()].sort((a, b) => b.confidence - a.confidence);
      if (!items.length) {
        $('ocrResult').innerHTML = '<div class="ocr-summary">スキルを認識できませんでした。画像を確認してください。</div>';
        $('ocrRaw').textContent = rawText;
        return;
      }
      const avg = items.reduce((s, r) => s + r.confidence, 0) / items.length;
      const rows = items.map((r) => {
        const hint = r.hint == null ? 0 : r.hint;
        const options = [0, 1, 2, 3, 4, 5].map((h) =>
          `<option value="${h}"${h === hint ? ' selected' : ''}>Lv${h}</option>`
        ).join('');
        const confClass = r.confidence >= 0.8 ? 'ocr-conf-high' : r.confidence >= 0.6 ? 'ocr-conf-mid' : 'ocr-conf-low';
        return `<tr>` +
          `<td title="${escapeHtml(r.line || '')} (text ${(r.score || 0).toFixed(2)}${r.imageScore != null ? ' / img ' + r.imageScore.toFixed(2) : ''})">${escapeHtml(r.skill.name)}</td>` +
          `<td><select class="hint-select" data-ocr-hint="${r.skill.skill_id}">${options}</select></td>` +
          `<td class="num ${confClass}">${Math.round(r.confidence * 100)}%</td>` +
          `</tr>`;
      }).join('');
      $('ocrResult').innerHTML =
        `<div class="ocr-summary">${formatNumber(items.length)} 件のスキルを認識（平均信頼度 ${Math.round(avg * 100)}%）</div>` +
        `<div class="ocr-table-wrap"><table class="ocr-table"><thead><tr><th>スキル</th><th>ヒントLv</th><th>信頼度</th></tr></thead><tbody>${rows}</tbody></table></div>` +
        `<div class="ocr-actions">` +
          `<button class="btn primary" id="ocrApplySkills" type="button">認識結果をヒントLvに反映</button>` +
          `<label class="toggle"><input type="checkbox" id="ocrSelectSkills"> 認識したスキルを選択</label>` +
        `</div>`;
      $('ocrApplySkills').addEventListener('click', applyOcrSkillResults);
      $('ocrRaw').textContent = rawText;
    }

    function renderOcrCharacterResults(candidates, rawText) {
      if (!candidates.length) {
        $('ocrResult').innerHTML = '<div class="ocr-summary">ウマ娘を認識できませんでした。名前がはっきり写った画像を使ってください。</div>';
        $('ocrRaw').textContent = rawText;
        return;
      }
      const seen = new Set();
      const unique = [];
      for (const c of candidates) {
        if (seen.has(c.card.card_id)) continue;
        seen.add(c.card.card_id);
        unique.push(c);
      }
      const top = unique.slice(0, 20);
      const options = top.map((c) =>
        `<option value="${c.card.card_id}">${escapeHtml(c.card.display_name)}（${Math.round(c.score * 100)}%）</option>`
      ).join('');
      const first = top[0].card;
      $('ocrResult').innerHTML =
        `<div class="ocr-summary">認識したウマ娘: <b>${escapeHtml(first.chara_name)}</b></div>` +
        `<div>${escapeHtml(first.display_name)} ／ 芝 ${first.aptitude.ground['1']}・ダート ${first.aptitude.ground['2']} ／ 初期脚質 ${escapeHtml(first.running_style_name)}</div>` +
        `<div class="ocr-actions">` +
          `<select id="ocrCardChoice" class="card-select">${options}</select>` +
          `<button class="btn primary" id="ocrApplyCharacter" type="button">このウマ娘の初期適性を設定</button>` +
        `</div>`;
      $('ocrApplyCharacter').addEventListener('click', () => {
        const id = Number($('ocrCardChoice').value);
        const card = cardsById.get(id);
        if (!card) return;
        state.cardId = id;
        const cardSelect = $('cardSelect');
        if (cardSelect) cardSelect.value = String(id);
        applyCardAptitudes(card);
        saveSettings();
        renderSettings();
        updateCardInfo();
        recomputeDerived();
        renderCardEvolution();
        renderScenarioEvolution();
        render();
        ocrSetStatus(`「${card.display_name}」の初期適性を設定しました。`);
      });
      $('ocrRaw').textContent = rawText;
    }

    // ---------- OCR image preprocessing / engine ----------

    function ocrSourceSize(source) {
      if (!source) return { w: 0, h: 0 };
      return {
        w: source.videoWidth || source.displayWidth || source.codedWidth || source.width || 0,
        h: source.videoHeight || source.displayHeight || source.codedHeight || source.height || 0,
      };
    }

    function ocrFrameSignature(source, size = 24, region = null) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (region) {
        ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, size, size);
      } else {
        ctx.drawImage(source, 0, 0, size, size);
      }
      const d = ctx.getImageData(0, 0, size, size).data;
      const out = new Uint8Array(size * size);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        out[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      }
      return out;
    }

    function ocrListRegion(source) {
      const { w, h } = ocrSourceSize(source);
      return {
        x: Math.round(w * 0.10),
        y: Math.round(h * 0.25),
        w: Math.round(w * 0.50),
        h: Math.round(h * 0.65),
      };
    }

    function ocrSignatureDiff(a, b) {
      if (!a || !b || a.length !== b.length) return 255;
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      return sum / a.length;
    }

    function ocrCanvasHash(canvas) {
      const sig = ocrFrameSignature(canvas, 16);
      let sum = 0;
      for (const v of sig) sum += v;
      const avg = sum / sig.length;
      let bits = '';
      for (const v of sig) bits += v >= avg ? '1' : '0';
      let hex = '';
      for (let i = 0; i < bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
      }
      return hex;
    }

    // ---------- game font (UMAMUSUME-RodinWanpaku) based reranking ----------

    function loadOcrFont() {
      if (ocrFontPromise) return ocrFontPromise;
      ocrFontPromise = (async () => {
        try {
          if (!('FontFace' in window) || !document.fonts) return false;
          const face = new FontFace('UmaGameFont', `url(${OCR_FONT_URL})`);
          await face.load();
          document.fonts.add(face);
          ocrFontReady = true;
          return true;
        } catch (err) {
          console.warn('game font load failed:', err);
          return false;
        }
      })();
      return ocrFontPromise;
    }

    function ocrOtsuThreshold(gray) {
      const hist = new Array(256).fill(0);
      for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
      const total = gray.length;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0;
      let wB = 0;
      let max = 0;
      let threshold = 127;
      for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += i * hist[i];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > max) {
          max = between;
          threshold = i;
        }
      }
      return threshold;
    }

    function ocrTrimRect(canvas) {
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) return null;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      }
      const threshold = ocrOtsuThreshold(gray);
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (gray[row + x] < threshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) return null;
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    function ocrNormalizedTextImage(canvas, expectedAspect = null) {
      const rect = ocrTrimRect(canvas);
      if (!rect) return null;
      let cropW = rect.w;
      if (expectedAspect && expectedAspect > 0) {
        cropW = Math.min(rect.w, Math.max(1, Math.round(rect.h * expectedAspect)));
      }
      const out = document.createElement('canvas');
      out.width = 192;
      out.height = 48;
      const ctx = out.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 192, 48);
      ctx.drawImage(canvas, rect.x, rect.y, cropW, rect.h, 0, 0, 192, 48);
      const d = ctx.getImageData(0, 0, 192, 48).data;
      const gray = new Uint8Array(192 * 48);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      }
      return gray;
    }

    function ocrRenderNameCanvas(name) {
      const size = 64;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.font = `${size}px "UmaGameFont", sans-serif`;
      const width = Math.max(32, Math.ceil(ctx.measureText(name).width) + 24);
      const height = 96;
      canvas.width = width;
      canvas.height = height;
      const c = canvas.getContext('2d', { willReadFrequently: true });
      c.fillStyle = '#fff';
      c.fillRect(0, 0, width, height);
      c.fillStyle = '#000';
      c.font = `${size}px "UmaGameFont", sans-serif`;
      c.textBaseline = 'middle';
      c.fillText(name, 12, height / 2);
      return canvas;
    }

    function ocrFontNameSignature(name) {
      if (ocrFontCache.has(name)) return ocrFontCache.get(name);
      const rendered = ocrRenderNameCanvas(name);
      const rect = ocrTrimRect(rendered);
      if (!rect) {
        ocrFontCache.set(name, null);
        return null;
      }
      const norm = ocrNormalizedTextImage(rendered);
      const sig = { norm, aspect: rect.w / rect.h };
      ocrFontCache.set(name, sig);
      return sig;
    }

    function ocrFontSimilarity(lineCanvas, name) {
      if (!ocrFontReady || !lineCanvas) return 0;
      const sig = ocrFontNameSignature(name);
      if (!sig) return 0;
      const lineNorm = ocrNormalizedTextImage(lineCanvas, sig.aspect);
      if (!lineNorm) return 0;
      const a = lineNorm;
      const b = sig.norm;
      const ta = ocrOtsuThreshold(a);
      const tb = ocrOtsuThreshold(b);
      let inter = 0;
      let union = 0;
      for (let i = 0; i < a.length; i++) {
        const da = a[i] < ta;
        const db = b[i] < tb;
        if (da && db) inter++;
        if (da || db) union++;
      }
      return union ? inter / union : 0;
    }

    function ocrFontCharSignature(ch) {
      if (ocrFontCharCache.has(ch)) return ocrFontCharCache.get(ch);
      const rendered = ocrRenderNameCanvas(ch);
      const norm = ocrNormalizedTextImage(rendered);
      ocrFontCharCache.set(ch, norm);
      return norm;
    }

    function ocrFontSuffixSimilarity(lineCanvas, name) {
      if (!ocrFontReady || !lineCanvas || !name) return 0;
      const lineRect = ocrTrimRect(lineCanvas);
      const fullSig = ocrFontNameSignature(name);
      if (!lineRect || !fullSig) return 0;
      const nameW = Math.min(lineRect.w, Math.max(1, Math.round(lineRect.h * fullSig.aspect)));
      const nameEndX = lineRect.x + nameW;
      const startX = Math.max(lineRect.x, nameEndX - lineRect.h);
      const w = Math.max(1, nameEndX - startX);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = lineRect.h;
      c.getContext('2d', { willReadFrequently: true })
        .drawImage(lineCanvas, startX, lineRect.y, w, lineRect.h, 0, 0, w, lineRect.h);
      const lineSig = ocrNormalizedTextImage(c);
      const charSig = ocrFontCharSignature(name.slice(-1));
      if (!lineSig || !charSig) return 0;
      const ta = ocrOtsuThreshold(lineSig);
      const tb = ocrOtsuThreshold(charSig);
      let inter = 0;
      let union = 0;
      for (let i = 0; i < lineSig.length; i++) {
        const da = lineSig[i] < ta;
        const db = charSig[i] < tb;
        if (da && db) inter++;
        if (da || db) union++;
      }
      return union ? inter / union : 0;
    }

    function ocrCropLine(canvas, bbox) {
      if (!canvas || !bbox) return null;
      const x = Math.max(0, Math.floor(bbox.x0));
      const y = Math.max(0, Math.floor(bbox.y0));
      const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(bbox.x1 - bbox.x0)));
      const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(bbox.y1 - bbox.y0)));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      if (!canvas._ocrInverted) {
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i];
          d[i + 1] = 255 - d[i + 1];
          d[i + 2] = 255 - d[i + 2];
        }
        ctx.putImageData(img, 0, 0);
      }
      return c;
    }

    function ocrFontRerank(candidates, lineCanvas) {
      if (!candidates.length) return null;
      if (!ocrFontReady || !lineCanvas) return candidates[0];
      let best = null;
      for (const cand of candidates) {
        const imageScore = ocrFontSimilarity(lineCanvas, cand.skill.name);
        const suffixScore = ocrFontSuffixSimilarity(lineCanvas, cand.skill.name);
        const combined = cand.score * 0.35 + imageScore * 0.3 + suffixScore * 0.35;
        if (!best || combined > best.combined) {
          best = { ...cand, imageScore, suffixScore, combined };
        }
      }
      return best;
    }

    function ocrCropCanvas(source, x, y, w, h) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w);
      c.height = Math.max(1, h);
      c.getContext('2d', { willReadFrequently: true })
        .drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
      return c;
    }

    function ocrRegionEdgeDensity(source, x, y, w, h) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, x, y, w, h, 0, 0, 64, 64);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      const gray = new Uint8Array(64 * 64);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      }
      let sum = 0;
      let count = 0;
      for (let yy = 0; yy < 64; yy++) {
        for (let xx = 0; xx < 64; xx++) {
          const idx = yy * 64 + xx;
          if (xx > 0) {
            sum += Math.abs(gray[idx] - gray[idx - 1]);
            count++;
          }
          if (yy > 0) {
            sum += Math.abs(gray[idx] - gray[idx - 64]);
            count++;
          }
        }
      }
      return count ? sum / count : 0;
    }

    function ocrCropForMode(source, mode) {
      if (!state.ocrAutoCrop) return source;
      const w = source.width;
      const h = source.height;
      if (!w || !h) return source;
      let area = source;

      // 左:ゲーム、右:ログ等の横並び複合スクリーンショットを検出
      if (w / h > 1.3) {
        const half = Math.floor(w * 0.5);
        const leftEdge = ocrRegionEdgeDensity(source, 0, 0, half, h);
        const rightEdge = ocrRegionEdgeDensity(source, half, 0, w - half, h);
        if (rightEdge < leftEdge * 0.65) {
          area = ocrCropCanvas(source, 0, 0, half, h);
        }
      }

      const aw = area.width;
      const ah = area.height;
      if (mode === 'skills') {
        return ocrCropCanvas(
          area,
          Math.round(aw * 0.18),
          Math.round(ah * 0.28),
          Math.round(aw * 0.74),
          Math.round(ah * 0.62)
        );
      }
      return ocrCropCanvas(
        area,
        Math.round(aw * 0.18),
        Math.round(ah * 0.02),
        Math.round(aw * 0.72),
        Math.round(ah * 0.96)
      );
    }

    function ocrNormalizeColorCanvas(source) {
      const targetWidth = state.ocrFastMode ? 1400 : 1800;
      const scale = Math.min(2.5, Math.max(1, targetWidth / Math.max(1, source.width)));
      const w = Math.min(3000, Math.round(source.width * scale));
      const h = Math.max(1, Math.round(source.height * (w / source.width)));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
      return canvas;
    }

    function ocrFindBadges(canvas) {
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, w, h).data;
      const orange = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        orange[j] = r > 200 && g > 110 && g < 215 && b < 110 ? 1 : 0;
      }
      const startX = Math.floor(w * 0.5);
      const rowCount = new Uint32Array(h);
      for (let y = 0; y < h; y++) {
        let count = 0;
        for (let x = startX; x < w; x++) if (orange[y * w + x]) count++;
        rowCount[y] = count;
      }
      const bands = [];
      let inBand = false;
      let y0 = 0;
      for (let y = 0; y < h; y++) {
        if (rowCount[y] > 5 && !inBand) {
          y0 = y;
          inBand = true;
        } else if (rowCount[y] <= 5 && inBand) {
          if (y - y0 > 15) bands.push([y0, y - 1]);
          inBand = false;
        }
      }
      if (inBand) bands.push([y0, h - 1]);

      const badges = [];
      for (const [ya, yb] of bands) {
        let minX = w;
        let maxX = -1;
        for (let y = ya; y <= yb; y++) {
          for (let x = startX; x < w; x++) {
            if (orange[y * w + x]) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (maxX < minX) continue;
        const bw = maxX - minX + 1;
        const bh = yb - ya + 1;
        if (bw < 60 || bh < 50) continue;
        badges.push({ x: minX, y: ya, w: bw, h: bh });
      }
      return badges;
    }

    async function ocrReadBadge(canvas, badge) {
      const margin = 4;
      const x = Math.max(0, badge.x - margin);
      const y = Math.max(0, badge.y - margin);
      const w = Math.min(canvas.width - x, badge.w + margin * 2);
      const h = Math.min(canvas.height - y, badge.h + margin * 2);
      const crop = document.createElement('canvas');
      crop.width = w * 4;
      crop.height = h * 4;
      const ctx = crop.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
      const im = ctx.getImageData(0, 0, crop.width, crop.height);
      const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        g = g >= 200 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
      const worker = await getOcrEngWorker();
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
        tessedit_char_whitelist: '',
      });
      const r = await worker.recognize(crop);
      const text = (r.data ? r.data.text : '').replace(/\s+/g, ' ').trim();
      let hint = null;
      let m = text.match(/[Ll][vV]\.?\s*([1-5])/);
      if (m) hint = Number(m[1]);
      if (hint == null) {
        if (/35\s*%/.test(text)) hint = 4;
        else {
          m = text.match(/([1-5])\s*0\s*%/);
          if (m) hint = Number(m[1]);
        }
      }
      return { hint, text };
    }

    async function ocrReadBadges(canvas, badgeList = null) {
      const badges = badgeList || ocrFindBadges(canvas);
      const out = [];
      for (const badge of badges) {
        const { hint, text } = await ocrReadBadge(canvas, badge);
        out.push({ y: badge.y + badge.h / 2, hint, text });
      }
      return out;
    }

    function ocrMergeBadges(results, badges) {
      for (const b of badges) {
        if (b.hint == null) continue;
        let best = null;
        for (const r of results) {
          if (!r.lineObj || !r.lineObj.bbox) continue;
          const ry = (r.lineObj.bbox.y0 + r.lineObj.bbox.y1) / 2;
          const dist = Math.abs(ry - b.y);
          if (!best || dist < best.dist) best = { r, dist };
        }
        if (best && best.dist < 120) {
          best.r.hint = b.hint;
          best.r.hintSource = 'badge';
        }
      }
    }

    function ocrNormalizeCanvas(source) {
      const targetWidth = state.ocrFastMode ? 1400 : 1800;
      const scale = Math.min(2.5, Math.max(1, targetWidth / Math.max(1, source.width)));
      const w = Math.min(3000, Math.round(source.width * scale));
      const h = Math.max(1, Math.round(source.height * (w / source.width)));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const d = imageData.data;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < d.length; i += 16) {
        sum += d[i] + d[i + 1] + d[i + 2];
        count += 3;
      }
      const avg = count ? sum / count : 128;
      const invert = avg < 120;
      for (let i = 0; i < d.length; i += 4) {
        let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (invert) gray = 255 - gray;
        gray = (gray - 128) * 1.35 + 128;
        gray = Math.max(0, Math.min(255, gray));
        d[i] = d[i + 1] = d[i + 2] = gray;
        d[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
      canvas._ocrInverted = invert;
      return canvas;
    }

    function ocrOtsuCanvas(source) {
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      canvas._ocrInverted = source._ocrInverted;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      const hist = new Array(256).fill(0);
      for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
      const total = d.length / 4;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0;
      let wB = 0;
      let max = 0;
      let threshold = 127;
      for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += i * hist[i];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > max) {
          max = between;
          threshold = i;
        }
      }
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] >= threshold ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(imageData, 0, 0);
      return canvas;
    }

    function loadTesseract() {
      if (window.Tesseract) return Promise.resolve(window.Tesseract);
      if (ocrWorkerPromise) return ocrWorkerPromise;
      ocrWorkerPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = OCR_CDN;
        script.onload = () => resolve(window.Tesseract);
        script.onerror = () => reject(new Error('OCRエンジンを読み込めませんでした（ネット接続を確認してください）'));
        document.head.appendChild(script);
      });
      return ocrWorkerPromise;
    }

    async function getOcrWorkers(count = 2) {
      if (ocrWorkers.length >= count) return ocrWorkers;
      ocrSetStatus('OCRエンジンを準備中です（初回は日本語データのダウンロードで時間がかかります）...');
      const T = await loadTesseract();
      while (ocrWorkers.length < count) {
        const index = ocrWorkers.length + 1;
        ocrSetStatus(`OCRエンジンを準備中... (${index}/${count})`);
        const worker = await T.createWorker('jpn+eng', 1, {
          logger: (m) => {
            if (m.status === 'loading language traineddata' || m.status === 'initializing api') {
              ocrSetStatus(`OCR準備中: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
            }
          },
        });
        await worker.setParameters({
          tessedit_pageseg_mode: '11',
          preserve_interword_spaces: '1',
        });
        ocrWorkers.push(worker);
      }
      return ocrWorkers;
    }

    async function getOcrEngWorker() {
      if (ocrEngWorker) return ocrEngWorker;
      const T = await loadTesseract();
      ocrEngWorker = await T.createWorker('eng', 1, { logger: () => {} });
      await ocrEngWorker.setParameters({
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      });
      return ocrEngWorker;
    }

    async function runOcr() {
      if (!ocrImages.length) return;
      const runBtn = $('ocrRun');
      runBtn.disabled = true;
      ocrSetStatus('OCRを実行中です...');
      try {
        await loadOcrFont();
        const workers = await getOcrWorkers(2);
        const results = new Array(ocrImages.length);
        let nextIndex = 0;
        let completed = 0;

        async function processWorker(worker) {
          while (true) {
            const i = nextIndex++;
            if (i >= ocrImages.length) break;
            const img = ocrImages[i];
            const image = await loadImage(img.dataUrl);
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            const cropped = ocrCropForMode(canvas, ocrMode);
            const colorNorm = ocrNormalizeColorCanvas(cropped);
            const gray = ocrNormalizeCanvas(cropped);
            const badges = ocrMode === 'skills' ? ocrFindBadges(colorNorm) : [];
            const variants = state.ocrFastMode ? [gray] : [gray, ocrOtsuCanvas(gray)];
            let bestParsed = null;
            let bestRaw = '';
            const collected = [];
            const rawParts = [];

            for (let v = 0; v < variants.length; v++) {
              const recognized = await worker.recognize(variants[v]);
              const data = recognized && recognized.data ? recognized.data : recognized;
              if (ocrMode === 'skills') {
                const parsed = ocrParseSkillData(data, variants[v]);
                collected.push(...parsed.results);
                rawParts.push(parsed.rawText);
                if (v === 0 && state.ocrFastMode && collected.length < Math.max(3, badges.length)) {
                  variants.push(ocrOtsuCanvas(gray));
                }
              } else {
                const parsed = ocrParseCharacterData(data);
                if (!bestParsed || (parsed.candidates[0]?.score || 0) > (bestParsed.candidates[0]?.score || 0)) {
                  bestParsed = parsed;
                  bestRaw = parsed.rawText;
                }
              }
            }

            if (ocrMode === 'skills') {
              const merged = mergeOcrSkillResults(collected);
              bestParsed = { results: [...merged.values()], rawText: rawParts.join('\n') };
              bestRaw = bestParsed.rawText;
              try {
                const badgeHints = await ocrReadBadges(colorNorm, badges);
                ocrMergeBadges(bestParsed.results, badgeHints);
              } catch (err) {
                console.warn('badge OCR failed:', err);
              }
            }

            results[i] = { parsed: bestParsed, raw: bestRaw, name: img.name };
            completed++;
            ocrSetStatus(`OCR ${completed}/${ocrImages.length} 件完了...`);
          }
        }

        await Promise.all(workers.map((worker) => processWorker(worker)));

        const skillResults = [];
        const charaCandidates = [];
        let rawAll = '';
        for (const r of results) {
          if (!r) continue;
          rawAll += `--- ${r.name} ---\n${r.raw}\n\n`;
          if (ocrMode === 'skills') skillResults.push(...(r.parsed?.results || []));
          else charaCandidates.push(...(r.parsed?.candidates || []));
        }

        if (ocrMode === 'skills') {
          const merged = mergeOcrSkillResults(skillResults);
          renderOcrSkillResults(merged, rawAll);
          ocrSetStatus(`${formatNumber(merged.size)} 件のスキルを認識しました。内容を確認して反映してください。`);
        } else {
          charaCandidates.sort((a, b) => b.score - a.score || a.card.card_id - b.card.card_id);
          renderOcrCharacterResults(charaCandidates, rawAll);
          ocrSetStatus(charaCandidates.length
            ? 'ウマ娘を認識しました。候補を確認して設定してください。'
            : 'ウマ娘を認識できませんでした。');
        }
      } catch (err) {
        console.error(err);
        ocrSetStatus(`OCRに失敗しました: ${err.message || err}`);
      } finally {
        runBtn.disabled = ocrImages.length === 0;
      }
    }

    // ---------- live screen capture ----------

    async function startOcrCapture() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          throw new Error('このブラウザは画面キャプチャに対応していません');
        }
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30 },
          audio: false,
        });
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        ocrCapture.stream = stream;
        ocrCapture.video = video;
        ocrCapture.frameLoopStarted = false;
        ocrCapture.processorReader = null;
        ocrCapture.autoActive = false;
        const usedProcessor = await startFrameProcessor(stream);
        if (!usedProcessor) startVideoFrameLoop();
        stream.getVideoTracks()[0].addEventListener('ended', stopOcrCapture);
        $('ocrCaptureFrame').disabled = false;
        $('ocrCaptureAuto').disabled = false;
        $('ocrCaptureStop').disabled = false;
        $('ocrCaptureStart').disabled = true;
        ocrSetStatus('画面キャプチャ中です。ゲーム画面を共有し、スクロールしながら「この画面を取り込む」を押してください。');
      } catch (err) {
        if (err && err.name === 'NotAllowedError') {
          ocrSetStatus(
            '画面キャプチャが許可されませんでした。OpenCode内蔵ブラウザでは使用できません。' +
            'Chrome/Edgeでこのページを開くか、「画像を追加」「クリップボードから貼り付け」を使ってください。'
          );
        } else if (err && err.name === 'NotFoundError') {
          ocrSetStatus('共有できる画面が見つかりませんでした。ゲーム画面を開いた状態で再試行してください。');
        } else {
          ocrSetStatus(`画面キャプチャを開始できませんでした: ${err && err.message ? err.message : err}`);
        }
      }
    }

    function updateOcrCaptureHint() {
      const hint = $('ocrCaptureHint');
      if (!hint) return;
      const inApp = /OpenCode|Electron/i.test(navigator.userAgent);
      hint.textContent = inApp
        ? '内蔵ブラウザでは画面キャプチャ不可。Chrome/Edgeで開いてください。'
        : '画面キャプチャはChrome/Edge推奨。';
    }

    async function copyOcrUrl() {
      const url = location.href.split('?')[0];
      try {
        await navigator.clipboard.writeText(url);
        ocrSetStatus(`URLをコピーしました。Chrome/Edgeのアドレス欄に貼り付けて開いてください: ${url}`);
      } catch (err) {
        ocrSetStatus(`Chrome/Edgeで次のURLを開いてください: ${url}`);
      }
    }

    function captureOcrFrame(source = ocrCapture.video) {
      if (!source) return;
      const { w, h } = ocrSourceSize(source);
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(source, 0, 0, w, h);
      ocrCapture.lastCaptureAt = Date.now();
      const added = addOcrCanvas(canvas, `キャプチャ ${ocrImages.length + 1}`);
      if (added) {
        ocrSetStatus(`${ocrImages.length} 枚の画像を取り込みました。続けてスクロールして取り込めます。`);
      }
    }

    function sampleCaptureSource(source) {
      if (!source) return;
      const { w, h } = ocrSourceSize(source);
      if (!w || !h) return;
      const fullSig = ocrFrameSignature(source, 24);
      const regionSig = ocrFrameSignature(source, 32, ocrListRegion(source));
      const fullDiff = ocrSignatureDiff(fullSig, ocrCapture.lastFullSig);
      const regionDiff = ocrSignatureDiff(regionSig, ocrCapture.lastRegionSig);
      ocrCapture.lastFullSig = fullSig;
      ocrCapture.lastRegionSig = regionSig;

      const s = OCR_SENSITIVITY[state.ocrSensitivity] || OCR_SENSITIVITY.medium;
      const live = $('ocrLiveStatus');
      if (live) {
        live.textContent = `画面 ${fullDiff.toFixed(1)} / 一覧 ${regionDiff.toFixed(1)} / 取り込み ${ocrImages.length}枚`;
      }

      if (fullDiff > s.full || regionDiff > s.region) {
        ocrCapture.changed = true;
        ocrCapture.stableCount = 0;
        return;
      }
      if (!ocrCapture.changed) return;
      if (fullDiff > s.stableFull || regionDiff > s.stableRegion) {
        ocrCapture.stableCount = 0;
        return;
      }
      ocrCapture.stableCount++;
      if (ocrCapture.stableCount >= 2) {
        captureOcrFrame(source);
        ocrCapture.changed = false;
        ocrCapture.stableCount = 0;
      }
    }

    async function startFrameProcessor(stream) {
      if (!('MediaStreamTrackProcessor' in window)) return false;
      try {
        const track = stream.getVideoTracks()[0];
        if (!track) return false;
        const processor = new MediaStreamTrackProcessor({ track });
        const reader = processor.readable.getReader();
        ocrCapture.processorReader = reader;
        (async () => {
          while (true) {
            let result;
            try {
              result = await reader.read();
            } catch (err) {
              break;
            }
            const { value: frame, done } = result;
            if (done) break;
            if (ocrCapture.autoActive) {
              const now = performance.now();
              if (now - ocrCapture.lastSampleAt >= 200) {
                ocrCapture.lastSampleAt = now;
                sampleCaptureSource(frame);
              }
            }
            frame.close();
          }
          ocrCapture.processorReader = null;
          if (ocrCapture.autoActive) startVideoFrameLoop();
        })();
        return true;
      } catch (err) {
        console.warn('MediaStreamTrackProcessor failed:', err);
        return false;
      }
    }

    function startVideoFrameLoop() {
      if (ocrCapture.frameLoopStarted) return;
      const video = ocrCapture.video;
      if (!video) return;
      ocrCapture.frameLoopStarted = true;
      if ('requestVideoFrameCallback' in video) {
        const loop = () => {
          if (!ocrCapture.video) return;
          if (ocrCapture.autoActive) {
            const now = performance.now();
            if (now - ocrCapture.lastSampleAt >= 200) {
              ocrCapture.lastSampleAt = now;
              sampleCaptureSource(video);
            }
          }
          video.requestVideoFrameCallback(loop);
        };
        video.requestVideoFrameCallback(loop);
      } else {
        ocrCapture.sampleTimer = setInterval(() => {
          if (ocrCapture.autoActive) sampleCaptureSource(video);
        }, 250);
      }
    }

    function startAutoCapture() {
      if (ocrCapture.autoActive) return;
      ocrCapture.autoActive = true;
      ocrCapture.lastFullSig = null;
      ocrCapture.lastRegionSig = null;
      ocrCapture.changed = true;
      ocrCapture.stableCount = 0;
      ocrCapture.lastSampleAt = 0;
      if (!ocrCapture.processorReader) startVideoFrameLoop();
      $('ocrCaptureAuto').disabled = true;
      ocrSetStatus('フレーム変化を検出して自動取り込み中です。スクロールを止めると、その画面を保存します。');
    }

    function stopAutoCapture() {
      ocrCapture.autoActive = false;
      if (ocrCapture.sampleTimer) {
        clearInterval(ocrCapture.sampleTimer);
        ocrCapture.sampleTimer = null;
      }
      $('ocrCaptureAuto').disabled = false;
    }

    function stopOcrCapture() {
      stopAutoCapture();
      if (ocrCapture.processorReader) {
        try {
          ocrCapture.processorReader.cancel();
        } catch (err) { /* ignore */ }
        ocrCapture.processorReader = null;
      }
      ocrCapture.frameLoopStarted = false;
      if (ocrCapture.stream) {
        for (const track of ocrCapture.stream.getTracks()) track.stop();
        ocrCapture.stream = null;
      }
      ocrCapture.video = null;
      const live = $('ocrLiveStatus');
      if (live) live.textContent = '';
      $('ocrCaptureFrame').disabled = true;
      $('ocrCaptureAuto').disabled = true;
      $('ocrCaptureStop').disabled = true;
      $('ocrCaptureStart').disabled = false;
      ocrSetStatus('画面キャプチャを停止しました。');
    }

    function compareSkills(a, b) {
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

    function computeSummary() {
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
        if (s.total_sp != null) spBaseTotal += Number(s.total_sp) || 0;
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

    function updateSummary() {
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
          `上位スキル・進化スキルを選択すると、下位スキルのSPを含めて計算されます。` +
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
              `<span>${isEvolution ? '進化元の下位SP（割引前）' : '下位SP（割引前）'} <b>${formatNumber(isEvolution ? s._evolution_base_prereq_sp : s.prereq_sp)}</b></span>` +
              `<span>上昇評価点 <b>${formatNumber(s._upgrade_point)}</b></span>` +
            `</div>` +
          `</td></tr>`
        );
      }
      return rows.join('');
    }

    function renderArrows() {
      for (const key of ['name', 'eval_point', 'sp', 'upgrade_point', 'efficiency', 'total_sp', 'total_efficiency']) {
        const el = $('arrow-' + key);
        if (!el) continue;
        el.textContent = state.sortKey === key ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
      }
      for (const th of document.querySelectorAll('thead th[data-sort]')) {
        th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
      }
    }

    function render() {
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

    function addSkillWithChain(id, target = state.selected) {
      target.add(id);
      for (const lower of CHAINS.get(id) || []) {
        target.add(lower.skill_id);
      }
    }

    function toggleSkill(id) {
      if (state.selected.has(id)) state.selected.delete(id);
      else addSkillWithChain(id);
      saveSelection();
      render();
    }

    function togglePage(select) {
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

    function syncSortSelect() {
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

    function setSort(key, dir) {
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

    function csvCell(value) {
      if (value == null) return '';
      const str = String(value);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }

    function exportCsv() {
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
          total_sp_base: s.total_sp,
          total_sp: s._total_sp,
          total_efficiency: s._total_efficiency == null ? null : Math.round(s._total_efficiency * 1000) / 1000,
          prereq_sp_base: s.prereq_sp,
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
        const id = Number(btn.dataset.ocrRemove);
        ocrImages = ocrImages.filter((img) => img.id !== id);
        renderOcrThumbs();
      });
      $('ocrModes').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-ocr-mode]');
        if (!chip) return;
        ocrMode = chip.dataset.ocrMode === 'character' ? 'character' : 'skills';
        for (const c of $('ocrModes').querySelectorAll('[data-ocr-mode]')) {
          c.classList.toggle('active', c.dataset.ocrMode === ocrMode);
        }
        $('ocrResult').innerHTML = '';
        $('ocrRaw').textContent = '';
        ocrSetStatus(ocrMode === 'skills'
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

    function init() {
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
      bind();
      updateStickyOffset();
      render();
    }

    init();
  })();
