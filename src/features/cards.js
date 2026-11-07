// ウマ娘（カード）選択と初期適性の適用。

import { state } from '../core/state.js';
import { CARDS, cardsById } from '../core/data.js';
import { $, escapeHtml } from '../core/utils.js';

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
  const card = state.cardId != null ? cardsById.get(state.cardId) : null;
  if (!info) return;
  if (!card) {
    info.textContent = '選択すると距離・脚質の初期適性を自動設定します。';
    return;
  }
  const ground = card.aptitude.ground;
  info.textContent =
    `${card.display_name || card.chara_name}` +
    ` ／ 芝 ${ground['1'] || '—'}・ダート ${ground['2'] || '—'}` +
    ` ／ 初期脚質 ${card.running_style_name || '—'}`;
}

export function applyCardAptitudes(card) {
  if (!card) return;
  for (const id of ['1', '2', '3', '4']) {
    state.aptitude.distance[id] = card.aptitude.distance[id] || 'A';
    state.aptitude.style[id] = card.aptitude.style[id] || 'A';
  }
}
