// 査定設定（固有Lv・切れ者・勉強家・距離/脚質適性）の描画。

import { state } from '../core/state.js';
import {
  APT_GRADES,
  APT_MULT,
  DISTANCE_META,
  STYLE_META,
  UNIQUE_POINT_PER_LEVEL,
} from '../core/constants.js';
import { $, formatNumber, aptClass } from '../core/utils.js';

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

  const diligent = $('diligent');
  if (diligent) diligent.checked = state.diligent;
  $('diligent-wrap')?.classList.toggle('on', state.diligent);

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
    const discount = state.fastLearner
      ? '切れ者 −10%'
      : (state.diligent ? '勉強家 −4%' : '');
    note.textContent =
      `固有 ${formatNumber(state.uniqueLevel * UNIQUE_POINT_PER_LEVEL)}点` +
      (discount ? ` / ${discount}` : '');
  }
}
