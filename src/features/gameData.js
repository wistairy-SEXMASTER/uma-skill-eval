// パケット転送サーバーからの育成データ取得・状態表示。

import { state } from '../core/state.js';
import { GAME_AUTO_INTERVAL } from '../core/constants.js';
import { $, formatNumber } from '../core/utils.js';
import { applyGameData } from './gameDataApply.js';

let lastVersion = -1;
let timer = null;
let busy = false;

function apiBase() {
  return String(state.gameServer || '').replace(/\/+$/, '');
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
