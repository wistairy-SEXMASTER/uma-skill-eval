// 最適化結果の共有状態。UI 更新のみを担当する。

import { $ } from './utils.js';

export const optimizerState = {
  last: null,
};

export function invalidateOptimization() {
  if (!optimizerState.last) return;
  optimizerState.last = null;
  const apply = $('btnApplyOpt');
  if (apply) apply.disabled = true;
  const out = $('optResult');
  if (out) out.innerHTML = '<div class="opt-note">設定が変更されました。再計算してください。</div>';
}
