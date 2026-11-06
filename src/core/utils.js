// DOM・文字列・数値の小さなユーティリティ。状態には依存しない。

export const $ = (id) => document.getElementById(id);

export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function normalize(value) {
  return String(value == null ? '' : value).toLowerCase().normalize('NFKC');
}

export function formatNumber(n) {
  return Number(n).toLocaleString('ja-JP');
}

export function formatDate(iso) {
  if (!iso) return '不明';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function aptClass(grade) {
  if (grade === 'S' || grade === 'A') return 'apt-good';
  if (grade === 'B' || grade === 'C') return 'apt-mid';
  return 'apt-bad';
}

export function csvCell(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
