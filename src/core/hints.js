// ヒントLv・切れ者によるSP割引。

import { state } from './state.js';
import { HINT_DISCOUNTS, FAST_LEARNER_DISCOUNT } from './constants.js';

export function discountPct(level) {
  return Math.round((HINT_DISCOUNTS[level] || 0) * 100);
}

export function effectiveHint(skillId) {
  return state.hintLevels.get(skillId) || 0;
}

// 切れ者はヒント割引に加算（例: Lv5 + 切れ者 = −50%）
export function spDiscountRate(level) {
  let rate = HINT_DISCOUNTS[level] || 0;
  if (state.fastLearner) rate += FAST_LEARNER_DISCOUNT;
  return Math.min(1, Math.max(0, rate));
}

// ゲーム内と同じく、割引後のSPは小数点以下切り捨て
export function applyHintDiscount(sp, level) {
  if (sp == null) return null;
  return Math.max(0, Math.floor(sp * (1 - spDiscountRate(level)) + 1e-9));
}
