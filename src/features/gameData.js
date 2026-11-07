// パケット転送サーバーから育成ウマ娘・適性・ヒントを取り込む。
//
// サーバーは capture/server.py。Hachimi-Edge（URA）の /notify/response か、
// 生パケットを POST /api/ingest で受け取り、GET /api/state で最新状態を返す。

import { state, saveSettings, saveHint, saveSelection } from '../core/state.js';
import {
  SKILLS,
  byId,
  cardsById,
  SCENARIOS,
  CARD_INITIAL_SKILLS,
  CARD_INITIAL_SKILL_RANKS,
} from '../core/data.js';
import { GAME_AUTO_INTERVAL, OPT_MAX_BUDGET } from '../core/constants.js';
import { $, formatNumber } from '../core/utils.js';
import { applyCardAptitudes, renderSettings, updateCardInfo } from './filters.js';
import { recomputeDerived } from '../core/aptitude.js';
import { invalidateOptimization } from '../core/optimizer-state.js';
import { renderCardEvolution, renderScenarioEvolution } from './evolution.js';
import { render, addSkillWithChain } from './table.js';

const GRADES = new Set(['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G']);

let lastVersion = -1;
let timer = null;
let busy = false;

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

function apiBase() {
  return String(state.gameServer || '').replace(/\/+$/, '');
}

function isGrade(value) {
  return GRADES.has(String(value || '').toUpperCase());
}

function formatTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ja-JP', { hour12: false });
}

function setStatus(text, payload = null, isError = false) {
  const el = $('gameStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.classList.toggle('ok', !isError && !!payload);
  if (payload && payload.source) {
    el.title = [payload.source.endpoint, payload.source.extracted_at]
      .filter(Boolean)
      .join('\n');
  } else {
    el.removeAttribute('title');
  }
}

function statusText(payload, card, hintCount, warnings) {
  const chara = payload.chara;
  const name = card
    ? (card.display_name || card.chara_name)
    : `カード ${chara.card_id}`;
  const bits = [formatTime(payload.updated_at), name];
  if (chara.turn != null) bits.push(`ターン ${chara.turn}`);
  if (chara.skill_point != null) bits.push(`残SP ${formatNumber(chara.skill_point)}`);
  const ground = chara.aptitude && chara.aptitude.ground;
  if (ground && (ground['1'] || ground['2'])) {
    bits.push(`芝${ground['1'] || '—'}/ダ${ground['2'] || '—'}`);
  }
  bits.push(`ヒント ${formatNumber(hintCount)}件`);
  if (state.fastLearner) bits.push('切れ者');
  else if (state.diligent) bits.push('勉強家');
  if (state.selected.size) bits.push(`選択 ${formatNumber(state.selected.size)}件`);
  if (warnings.length) bits.push(warnings.join(' / '));
  return bits.join(' / ');
}

// 取得したデータを state に反映する。手動設定よりゲーム内の値を優先する。
export function applyGameData(payload) {
  const chara = payload && payload.chara;
  if (!chara) throw new Error('育成データがありません。');

  const previousCardId = state.cardId;
  const warnings = [];
  const learnedSkillIds = new Set(
    (chara.learned_skills || [])
      .map((skill) => Number(skill && skill.skill_id))
      .filter((id) => Number.isInteger(id))
  );
  state.learnedSkillIds = learnedSkillIds;

  // 取得済みの固有スキルのLvを査定設定へ反映する。
  for (const skill of chara.learned_skills || []) {
    const unique = byId.get(Number(skill && skill.skill_id));
    if (!unique || unique.type !== '固有') continue;
    const level = Number(skill.level);
    if (Number.isInteger(level) && level >= 1 && level <= 6) {
      state.uniqueLevel = level;
    }
    break;
  }

  const card = cardsById.get(Number(chara.card_id));
  if (card) {
    state.cardId = card.card_id;
    applyCardAptitudes(card);
    const cardSelect = $('cardSelect');
    if (cardSelect) cardSelect.value = String(card.card_id);
  } else {
    warnings.push(`カード ${chara.card_id} がDBにありません`);
  }

  // ゲーム内の適性（継承込み）で上書きする。
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

  const scenarioId = Number(chara.scenario_id);
  if (Number.isInteger(scenarioId) && SCENARIOS.some((s) => s.id === scenarioId)) {
    state.scenarioId = scenarioId;
  }

  // ヒントは (group_id, rarity) 単位。同組のスキルすべてに同じLvを適用する。
  const hintPairs = new Set();
  const hintedSkillIds = new Set();
  if (chara.has_hints !== false) {
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
  } else {
    warnings.push('ヒント情報なし');
  }

  // 別の育成に切り替わった場合だけ、前回の選択をリセットする。
  // 同じ育成の再取得では手動選択を残し、初期スキル・ヒントのあるスキルを
  // 追加でチェックする。
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

  const effects = new Set((chara.effects || []).map(Number));
  state.fastLearner = effects.has(7);
  state.diligent = !state.fastLearner && effects.has(40);

  // 現在のスキルポイントを「獲得SP」に反映する。
  const skillPoint = Number(chara.skill_point);
  if (Number.isInteger(skillPoint) && skillPoint >= 0) {
    state.optBudget = Math.min(OPT_MAX_BUDGET, skillPoint);
    const budgetInput = $('optBudget');
    if (budgetInput) budgetInput.value = String(state.optBudget);
  }

  const scenarioSelect = $('scenarioSelect');
  if (scenarioSelect) {
    scenarioSelect.value = state.scenarioId != null ? String(state.scenarioId) : '';
  }

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

export function renderGameSettings() {
  const server = $('gameServer');
  if (server) server.value = state.gameServer;
  const auto = $('gameAuto');
  if (auto) {
    auto.checked = state.gameAuto;
    $('gameAuto-wrap')?.classList.toggle('on', state.gameAuto);
  }
}

export function resetGameVersion() {
  lastVersion = -1;
}

// CLI で復号した JSON（/api/state と同じ形）を読み込む。
export async function importGameJsonFile(file) {
  if (!file) return null;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || !payload.chara) {
      throw new Error('chara がありません。');
    }
    const { card, hintCount, warnings } = applyGameData(payload);
    lastVersion = payload.version == null ? -1 : payload.version;
    setStatus(`読込: ${statusText(payload, card, hintCount, warnings)}`, payload);
    return payload;
  } catch (error) {
    setStatus(`読込できません: ${error.message || error}`, null, true);
    return null;
  }
}

export async function fetchGameData(options = {}) {
  if (busy) return null;
  const silent = !!options.silent;
  busy = true;
  if (!silent) setStatus('取得中...');
  try {
    const response = await fetch(`${apiBase()}/api/state?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.ok === false) {
      throw new Error(payload && payload.error ? payload.error : 'データがありません。');
    }
    if (payload.version === lastVersion) {
      if (!silent) setStatus(`最新です（${formatTime(payload.updated_at)}）`, payload);
      return payload;
    }
    const { card, hintCount, warnings } = applyGameData(payload);
    lastVersion = payload.version;
    setStatus(statusText(payload, card, hintCount, warnings), payload);
    return payload;
  } catch (error) {
    if (!silent) {
      setStatus(`取得できません: ${error.message || error}`, null, true);
    }
    return null;
  } finally {
    busy = false;
  }
}

export function startGameAuto() {
  stopGameAuto();
  timer = setInterval(() => {
    fetchGameData({ silent: true });
  }, GAME_AUTO_INTERVAL);
}

export function stopGameAuto() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function initGameData() {
  renderGameSettings();
  if (state.gameAuto) startGameAuto();
}
