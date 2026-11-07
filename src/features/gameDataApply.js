// 取得した育成データを state に反映する。

import { state, saveSettings, saveHint, saveSelection } from '../core/state.js';
import {
  SKILLS,
  byId,
  cardsById,
  SCENARIOS,
  CARD_INITIAL_SKILLS,
  CARD_INITIAL_SKILL_RANKS,
} from '../core/data.js';
import { OPT_MAX_BUDGET } from '../core/constants.js';
import { $ } from '../core/utils.js';
import { applyCardAptitudes, updateCardInfo } from './cards.js';
import { renderSettings } from './settings.js';
import { recomputeDerived } from '../core/derived.js';
import { invalidateOptimization } from '../core/optimizer-state.js';
import { renderCardEvolution, renderScenarioEvolution } from './evolution.js';
import { render, addSkillWithChain } from './table.js';

const GRADES = new Set(['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G']);

function isGrade(value) {
  return GRADES.has(String(value || '').toUpperCase());
}

// カードが最初から取得できるスキル（ヒントLv0）を選択する。
// ゲーム内では覚醒Lvに応じて 3〜7 件が最初から取得可能になる。
// talent_level は覚醒Lv。必要覚醒Lv（need_rank）がそれ以下なら取得可能。
function selectInitialSkills(cardId, learnedSkillIds, talentLevel) {
  const key = String(cardId);
  const ranks = CARD_INITIAL_SKILL_RANKS[key] || {};
  const level = Number.isInteger(talentLevel) && talentLevel > 0 ? talentLevel : null;
  for (const skillId of CARD_INITIAL_SKILLS[key] || []) {
    if (learnedSkillIds.has(skillId)) continue;
    if (level != null) {
      const needRank = Number(ranks[String(skillId)]);
      if (Number.isInteger(needRank) && needRank > level) continue;
    }
    addSkillWithChain(skillId);
  }
}

function collectLearnedSkillIds(chara) {
  return new Set(
    (chara.learned_skills || [])
      .map((skill) => Number(skill && skill.skill_id))
      .filter((id) => Number.isInteger(id))
  );
}

// 取得済みの固有スキルのLvを査定設定へ反映する。
function applyUniqueLevel(chara) {
  for (const skill of chara.learned_skills || []) {
    const unique = byId.get(Number(skill && skill.skill_id));
    if (!unique || unique.type !== '固有') continue;
    const level = Number(skill.level);
    if (Number.isInteger(level) && level >= 1 && level <= 6) {
      state.uniqueLevel = level;
    }
    return;
  }
}

function applyCard(chara, warnings) {
  const card = cardsById.get(Number(chara.card_id));
  if (!card) {
    warnings.push(`カード ${chara.card_id} がDBにありません`);
    return null;
  }
  state.cardId = card.card_id;
  applyCardAptitudes(card);
  const cardSelect = $('cardSelect');
  if (cardSelect) cardSelect.value = String(card.card_id);
  return card;
}

// ゲーム内の適性（継承込み）で上書きする。
function applyAptitudes(chara) {
  const distance = chara.aptitude && chara.aptitude.distance;
  const style = chara.aptitude && chara.aptitude.style;
  for (const id of ['1', '2', '3', '4']) {
    if (distance && isGrade(distance[id])) {
      state.aptitude.distance[id] = String(distance[id]).toUpperCase();
    }
    if (style && isGrade(style[id])) {
      state.aptitude.style[id] = String(style[id]).toUpperCase();
    }
  }
}

function applyScenario(chara) {
  const scenarioId = Number(chara.scenario_id);
  if (Number.isInteger(scenarioId) && SCENARIOS.some((s) => s.id === scenarioId)) {
    state.scenarioId = scenarioId;
  }
  const scenarioSelect = $('scenarioSelect');
  if (scenarioSelect) {
    scenarioSelect.value = state.scenarioId != null ? String(state.scenarioId) : '';
  }
}

// ヒントは (group_id, rarity) 単位。同組のスキルすべてに同じLvを適用する。
function applyHints(chara, warnings) {
  const hintPairs = new Set();
  const hintedSkillIds = new Set();
  if (chara.has_hints === false) {
    warnings.push('ヒント情報なし');
    return { hintPairs, hintedSkillIds };
  }
  state.hintLevels.clear();
  for (const hint of chara.hints || []) {
    const level = Number(hint.level) || 0;
    if (level <= 0) continue;
    const groupId = Number(hint.group_id);
    const rarity = Number(hint.rarity);
    hintPairs.add(`${groupId}:${rarity}`);
    for (const skill of SKILLS) {
      if (
        skill.group_id === groupId &&
        skill.rarity === rarity &&
        skill.group_rate >= 0
      ) {
        state.hintLevels.set(skill.skill_id, level);
        hintedSkillIds.add(skill.skill_id);
      }
    }
  }
  return { hintPairs, hintedSkillIds };
}

// 別の育成に切り替わった場合だけ、前回の選択をリセットする。
// 同じ育成の再取得では手動選択を残し、初期スキル・ヒントのあるスキルを
// 追加でチェックする。
function applySelection(chara, previousCardId, learnedSkillIds, hintedSkillIds) {
  if (previousCardId !== Number(chara.card_id)) {
    state.selected.clear();
  }
  // カードの初期スキル（ヒントLv0）を覚醒Lvに合わせて選択する。
  selectInitialSkills(chara.card_id, learnedSkillIds, chara.talent_level);
  for (const skillId of hintedSkillIds) {
    // すでに取得済みのスキルはチェックしない
    if (learnedSkillIds.has(skillId)) continue;
    addSkillWithChain(skillId);
  }
  // 下位スキルとして追加された場合も含め、取得済みは選択から外す
  for (const skillId of learnedSkillIds) {
    state.selected.delete(skillId);
  }
  saveSelection();
}

function applyEffects(chara) {
  const effects = new Set((chara.effects || []).map(Number));
  state.fastLearner = effects.has(7);
  state.diligent = !state.fastLearner && effects.has(40);
}

// 現在のスキルポイントを「獲得SP」に反映する。
function applyBudget(chara) {
  const skillPoint = Number(chara.skill_point);
  if (!Number.isInteger(skillPoint) || skillPoint < 0) return;
  state.optBudget = Math.min(OPT_MAX_BUDGET, skillPoint);
  const budgetInput = $('optBudget');
  if (budgetInput) budgetInput.value = String(state.optBudget);
}

// 取得したデータを state に反映する。手動設定よりゲーム内の値を優先する。
export function applyGameData(payload) {
  const chara = payload && payload.chara;
  if (!chara) throw new Error('育成データがありません。');

  const previousCardId = state.cardId;
  const warnings = [];
  const learnedSkillIds = collectLearnedSkillIds(chara);
  state.learnedSkillIds = learnedSkillIds;

  applyUniqueLevel(chara);
  const card = applyCard(chara, warnings);
  applyAptitudes(chara);
  applyScenario(chara);
  const { hintPairs, hintedSkillIds } = applyHints(chara, warnings);
  applySelection(chara, previousCardId, learnedSkillIds, hintedSkillIds);
  applyEffects(chara);
  applyBudget(chara);

  saveSettings();
  saveHint();
  invalidateOptimization();
  renderSettings();
  updateCardInfo();
  recomputeDerived();
  renderCardEvolution();
  renderScenarioEvolution();
  render();

  return { card, hintCount: hintPairs.size, warnings };
}
