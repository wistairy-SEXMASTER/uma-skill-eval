// 抽出データの読み込みと、ビューアで使う派生インデックスの構築。

import { SKILL_DATA } from '../../data/skills.js';
import { normalize } from './utils.js';

export const DATA = SKILL_DATA || {};
export const SKILLS = Array.isArray(DATA.skills) ? DATA.skills : [];
export const META = DATA.meta || {};
export const CARD_INITIAL_SKILLS = DATA.cardInitialSkills || {};
export const CARD_INITIAL_SKILL_RANKS = DATA.cardInitialSkillRanks || {};
export const CARD_GOLD_SKILL_EVOLUTIONS = DATA.cardGoldSkillEvolutions || {};
export const SUCCESSION_EVOLUTIONS = Array.isArray(DATA.successionEvolutions)
  ? DATA.successionEvolutions
  : [];
export const SCENARIOS = Array.isArray(DATA.scenarios) ? DATA.scenarios : [];
export const SCENARIO_EVOLUTIONS = DATA.scenarioEvolutions || {};

// 進化スキル → 進化元の金スキル
export const EVOLUTION_BASE_MAP = new Map();
// 進化元の金スキル → 進化先スキルID一覧（カード固有 + シナリオ）
export const ALL_EVOLUTIONS_BY_BASE = new Map();

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

// 継承固有 → 継承進化
export const SUCCESSION_EVOLUTIONS_BY_BASE = new Map();
for (const entry of SUCCESSION_EVOLUTIONS) {
  EVOLUTION_BASE_MAP.set(entry.skill_id, entry.base_skill_id);
  const all = ALL_EVOLUTIONS_BY_BASE.get(entry.base_skill_id) || [];
  if (!all.includes(entry.skill_id)) all.push(entry.skill_id);
  ALL_EVOLUTIONS_BY_BASE.set(entry.base_skill_id, all);
  const succession = SUCCESSION_EVOLUTIONS_BY_BASE.get(entry.base_skill_id) || [];
  if (!succession.includes(entry.skill_id)) succession.push(entry.skill_id);
  SUCCESSION_EVOLUTIONS_BY_BASE.set(entry.base_skill_id, succession);
}

export const byId = new Map(SKILLS.map((s) => [s.skill_id, s]));

export const CARDS = (Array.isArray(DATA.cards) ? DATA.cards : []).filter((c) =>
  c.aptitude &&
  c.aptitude.distance && c.aptitude.distance['1'] &&
  c.aptitude.style && c.aptitude.style['1']
);
export const cardsById = new Map(CARDS.map((c) => [c.card_id, c]));

// 下位スキル連鎖（同じ group_id の下位 group_rate。rate ごとの代表は評価点最大）
export const REPRESENTATIVE = new Map();
for (const s of SKILLS) {
  if (s.group_rate < 1) continue;
  const key = `${s.group_id}:${s.group_rate}`;
  const cur = REPRESENTATIVE.get(key);
  if (!cur || s.eval_point > cur.eval_point) REPRESENTATIVE.set(key, s);
}

export const CHAINS = new Map();
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

// 検索用の正規化済み文字列をあらかじめ作っておく
for (const s of SKILLS) {
  s._hay = normalize(`${s.name} ${s.description} ${s.skill_id} ${s.type} ${s.category_label} ${s.effect_category || ''}`);
  s._descOneLine = String(s.description || '').replace(/\s*\n+\s*/g, ' ');
}
