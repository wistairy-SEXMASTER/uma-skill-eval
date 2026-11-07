// 適性条件の解析・表示・フィルタ。

import { state } from './state.js';
import { DISTANCE_META, STYLE_META, GROUND_META } from './constants.js';

export function parseAptList(value) {
  const parts = Array.isArray(value) ? value : String(value == null ? '' : value).split('/');
  return parts
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x >= 1 && x <= 4);
}

export function aptitudeText(s) {
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
export function skillMatchesAptFilter(s) {
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
