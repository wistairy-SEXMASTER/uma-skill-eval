// ヘッダーのデータ情報表示。

import { SKILLS, META } from '../core/data.js';
import { $, escapeHtml, formatNumber, formatDate } from '../core/utils.js';

export function initMeta() {
  const total = SKILLS.length;
  const db = formatDate(META.db_mtime);
  const generated = formatDate(META.generated_at);
  $('meta').innerHTML =
    `収録 <b>${formatNumber(total)}</b> スキル（特殊・期限切れを除く）<br>` +
    `DB更新 ${escapeHtml(db)} ／ 抽出 ${escapeHtml(generated)}`;
}
