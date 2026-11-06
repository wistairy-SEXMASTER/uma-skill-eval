// 画像認識（OCR）。画像の前処理・文字認識・スキル名/ヒントLv/ウマ娘名の照合を担当する。

import { state, saveSettings } from '../core/state.js';
import { SKILLS, byId, CARDS, cardsById } from '../core/data.js';
import { OCR_CDN, OCR_FONT_URL, OCR_MAX_IMAGES } from '../core/constants.js';
import { $, escapeHtml, normalize, formatNumber } from '../core/utils.js';
import { applyHintDiscount, spDiscountRate } from '../core/hints.js';
import { recomputeDerived } from '../core/aptitude.js';
import { applyCardAptitudes, renderSettings, updateCardInfo } from './filters.js';
import { render } from './table.js';
import { renderCardEvolution, renderScenarioEvolution } from './evolution.js';

let ocrImages = [];
let ocrMode = 'skills';
let ocrWorkers = [];
let ocrEngWorker = null;
let ocrWorkerPromise = null;
let ocrImageSeq = 0;
let ocrFontPromise = null;
let ocrFontReady = false;
const ocrFontCache = new Map();
const ocrFontCharCache = new Map();

// ---------- image recognition (OCR) ----------

function ocrSetStatus(text) {
  const el = $('ocrStatus');
  if (el) el.textContent = text;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function renderOcrThumbs() {
  const wrap = $('ocrThumbs');
  if (!wrap) return;
  wrap.innerHTML = ocrImages.map((img) =>
    `<div class="ocr-thumb">` +
      `<button type="button" class="ocr-thumb-remove" data-ocr-remove="${img.id}" title="削除">×</button>` +
      `<img src="${img.dataUrl}" alt="">` +
      `<div class="ocr-thumb-name">${escapeHtml(img.name)}</div>` +
    `</div>`
  ).join('');
  $('ocrRun').disabled = ocrImages.length === 0;
  $('ocrDrop').textContent = ocrImages.length
    ? `${ocrImages.length} 枚を追加済み。さらに追加できます。`
    : 'ここに画像をドラッグ＆ドロップ（複数可）';
}

function addOcrCanvas(canvas, name) {
  if (ocrImages.length >= OCR_MAX_IMAGES) {
    ocrSetStatus(`画像は最大 ${OCR_MAX_IMAGES} 枚までです。`);
    return false;
  }
  const hash = ocrCanvasHash(canvas);
  if (ocrImages.some((img) => img.hash === hash)) {
    ocrSetStatus('同じ画面のため追加をスキップしました。');
    return false;
  }
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  ocrImages.push({
    id: ++ocrImageSeq,
    name,
    dataUrl,
    hash,
    width: canvas.width,
    height: canvas.height,
  });
  renderOcrThumbs();
  return true;
}

async function ocrAddFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const added = addOcrCanvas(canvas, file.name || `画像${ocrImageSeq + 1}`);
  if (added) {
    ocrSetStatus(`${ocrImages.length} 枚の画像を追加しました。「認識開始」を押してください。`);
  }
}

async function pasteOcrImage() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      throw new Error('このブラウザはクリップボード読み取りに対応していません');
    }
    const items = await navigator.clipboard.read();
    let added = 0;
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      await ocrAddFile(new File([blob], 'clipboard.png', { type }));
      added++;
    }
    if (!added) ocrSetStatus('クリップボードに画像がありませんでした。');
  } catch (err) {
    ocrSetStatus(`クリップボードから読み取れませんでした: ${err.message || err}`);
  }
}

// ---------- OCR text normalization / fuzzy matching ----------

function ocrNormalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[、。，．,.:;：；・\/\\|｜_＿~〜\-―–—]/g, '')
    .replace(/[「」『』（）()【】\[\]{}<>＜＞]/g, '')
    .replace(/〇/g, '○')
    .replace(/◯/g, '○')
    .toUpperCase();
}

function ocrStripHintCost(text) {
  return String(text || '')
    .replace(/ヒント\s*[Ll][vV]\.?\s*\d.*$/i, '')
    .replace(/\d+\s*%\s*OFF.*$/i, '')
    .replace(/\s+\d{2,4}\s*$/, '')
    .trim();
}

function ocrBigrams(text) {
  const set = new Set();
  if (!text) return set;
  if (text.length === 1) { set.add(text); return set; }
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

function ocrLevenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

function ocrJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function ocrCommonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function ocrSimilarity(a, b, aBigrams, bBigrams) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return 0.75 + 0.2 * ratio;
  }
  const dist = ocrLevenshtein(a, b);
  const edit = 1 - dist / Math.max(a.length, b.length);
  const bg = ocrJaccard(aBigrams || ocrBigrams(a), bBigrams || ocrBigrams(b));
  const prefix = ocrCommonPrefix(a, b) / Math.min(a.length, b.length);
  return 0.55 * edit + 0.3 * bg + 0.15 * prefix;
}

let ocrSkillIndex = null;
function getOcrSkillIndex() {
  if (!ocrSkillIndex) {
    ocrSkillIndex = SKILLS.map((s) => {
      const norm = ocrNormalizeText(s.name);
      return { skill: s, norm, bigrams: ocrBigrams(norm) };
    });
  }
  return ocrSkillIndex;
}

let ocrCharaIndex = null;
function getOcrCharaIndex() {
  if (!ocrCharaIndex) {
    const map = new Map();
    for (const card of CARDS) {
      const name = card.chara_name || '';
      if (!name) continue;
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(card);
    }
    ocrCharaIndex = [...map.entries()].map(([name, cards]) => ({
      name,
      norm: ocrNormalizeText(name),
      bigrams: ocrBigrams(ocrNormalizeText(name)),
      cards,
    }));
  }
  return ocrCharaIndex;
}

function ocrSkillCandidates(norm, limit = 8, minScore = 0.35) {
  if (!norm || norm.length < 2) return [];
  if (/^\d+$/.test(norm)) return [];
  if (/^(スキル|ヒント|獲得|SP|閉じる|戻る|次へ|前へ|確認|キャンセル|ウマ娘|育成|レース)$/.test(norm)) return [];
  const lineBigrams = ocrBigrams(norm);
  const scored = [];
  for (const entry of getOcrSkillIndex()) {
    if (!entry.norm) continue;
    const lenDiff = Math.abs(entry.norm.length - norm.length);
    const maxAllowed = Math.max(2, Math.round(entry.norm.length * 0.35));
    if (lenDiff > maxAllowed) continue;
    const score = ocrSimilarity(norm, entry.norm, lineBigrams, entry.bigrams);
    if (score >= minScore) scored.push({ skill: entry.skill, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function ocrBestSkillMatch(norm) {
  const minScore = norm && norm.length <= 3 ? 0.78 : 0.55;
  const list = ocrSkillCandidates(norm, 1, minScore);
  return list.length ? list[0] : null;
}

function ocrSubstringSimilarity(a, b, aBigrams, bBigrams) {
  const dist = ocrLevenshtein(a, b);
  const edit = 1 - dist / Math.max(a.length, b.length);
  const bg = ocrJaccard(aBigrams || ocrBigrams(a), bBigrams || ocrBigrams(b));
  return 0.8 * edit + 0.2 * bg;
}

function ocrBestSkillSubstringMatch(norm) {
  if (!norm || norm.length < 2) return null;
  let best = null;
  for (const entry of getOcrSkillIndex()) {
    if (!entry.norm) continue;
    const n = entry.norm.length;
    for (const len of [n - 1, n, n + 1]) {
      if (len < 2 || len > norm.length) continue;
      if (norm.length > 8 && len < 4) continue;
      for (let start = 0; start <= norm.length - len; start++) {
        const sub = norm.slice(start, start + len);
        const coverage = len / norm.length;
        if (norm.length > 12 && coverage < 0.4) continue;
        const score = ocrSubstringSimilarity(sub, entry.norm, ocrBigrams(sub), entry.bigrams);
        if (score < 0.55) continue;
        const adjusted = score * (0.8 + 0.2 * coverage);
        if (!best || adjusted > best.adjusted) {
          best = { skill: entry.skill, score, adjusted, sub };
        }
      }
    }
  }
  return best;
}

function ocrExtractCost(text) {
  const norm = String(text || '').normalize('NFKC');
  const nums = [...norm.matchAll(/\d{2,4}/g)]
    .map((m) => Number(m[0]))
    .filter((n) => n >= 20 && n <= 500);
  return nums.length ? nums[nums.length - 1] : null;
}

function ocrExtractHint(text) {
  if (!text) return null;
  const t = String(text).normalize('NFKC');
  let m = t.match(/ヒント\s*[Ll][vV]\.?\s*([1-5])/);
  if (m) return Number(m[1]);
  m = t.match(/(?:レベル|ﾚﾍﾞﾙ)\s*([1-5])/);
  if (m) return Number(m[1]);
  if (/35\s*%/.test(t)) return 4;
  m = t.match(/([1-5])\s*0\s*%/);
  if (m) return Number(m[1]);
  m = t.match(/([1-5])\s*%\s*(?:OFF|off|割引)/);
  if (m) return Number(m[1]);
  m = t.match(/ヒント.{0,4}?([1-5])/);
  if (m) return Number(m[1]);
  m = t.match(/[Ll][vV]\.?\s*([1-5])/);
  if (m) return Number(m[1]);
  return null;
}

function ocrInferHint(baseSp, observedCost) {
  if (!Number.isFinite(baseSp) || baseSp <= 0 || !Number.isFinite(observedCost)) return null;
  let bestHint = null;
  let bestError = Infinity;
  for (let h = 0; h <= 5; h++) {
    const expected = Math.floor(baseSp * (1 - (HINT_DISCOUNTS[h] || 0)) + 1e-9);
    const err = Math.abs(expected - observedCost);
    if (err < bestError) {
      bestError = err;
      bestHint = h;
    }
  }
  const tolerance = Math.max(3, Math.round(baseSp * 0.03));
  return bestError <= tolerance ? bestHint : null;
}

function ocrGroupLinesIntoRows(lines) {
  const withBox = lines.filter((l) => l.bbox && Number.isFinite(l.bbox.y0));
  if (!withBox.length) return lines.map((l) => ({ lines: [l], y0: 0, y1: 0, cy: 0 }));
  const sorted = withBox.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows = [];
  for (const line of sorted) {
    const h = Math.max(1, line.bbox.y1 - line.bbox.y0);
    const cy = (line.bbox.y0 + line.bbox.y1) / 2;
    let row = null;
    for (const r of rows) {
      if (Math.abs(r.cy - cy) <= Math.max(5, h * 0.55)) {
        row = r;
        break;
      }
    }
    if (!row) {
      row = { lines: [], cy, y0: line.bbox.y0, y1: line.bbox.y1 };
      rows.push(row);
    }
    row.lines.push(line);
    row.cy = (row.cy * (row.lines.length - 1) + cy) / row.lines.length;
    row.y0 = Math.min(row.y0, line.bbox.y0);
    row.y1 = Math.max(row.y1, line.bbox.y1);
  }
  for (const row of rows) row.lines.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  rows.sort((a, b) => a.y0 - b.y0);
  return rows;
}

function ocrParseSkillData(data, canvas) {
  const rawText = String(data.text || '');
  const lines = (Array.isArray(data.lines) && data.lines.length
    ? data.lines
    : rawText.split(/\r?\n/).map((t) => ({ text: t, confidence: data.confidence || 0 })))
    .map((l) => ({
      text: String(l.text || '').trim(),
      confidence: Number(l.confidence) || 0,
      bbox: l.bbox || null,
    }))
    .filter((l) => l.text);

  const rows = ocrGroupLinesIntoRows(lines);
  const results = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const rowText = row.lines.map((l) => l.text).join(' ');
    let best = null;

    for (const line of row.lines) {
      if (line.bbox && canvas && line.bbox.x0 > canvas.width * 0.55) continue;
      if (/試験ボーナス|進化条件達成|説明省略|スキルセット|リセット|決定/.test(line.text)) continue;
      const norm = ocrNormalizeText(ocrStripHintCost(line.text));
      if (norm.length < 2) continue;
      let candidate = ocrBestSkillSubstringMatch(norm.replace(/\d{2,4}$/, ''));
      if (candidate) candidate = { ...candidate, line, span: 1, normUsed: norm };

      if (!candidate || candidate.score < 0.75) {
        const nextRowText = rows[ri + 1]?.lines.map((l) => l.text).join('') || '';
        if (nextRowText) {
          const mergedNorm = norm + ocrNormalizeText(nextRowText);
          const merged = ocrBestSkillMatch(mergedNorm.replace(/\d{2,4}$/, ''));
          if (merged && (!candidate || merged.score > candidate.score)) {
            candidate = { ...merged, line, span: 2, normUsed: mergedNorm };
          }
        }
      }
      if (candidate && (!best || (candidate.adjusted || candidate.score) > (best.adjusted || best.score))) best = candidate;
    }

    if (!best) {
      const fallbackNorm = ocrNormalizeText(rowText);
      const match = ocrBestSkillSubstringMatch(fallbackNorm.replace(/\d{2,4}$/, ''));
      if (match) best = { ...match, line: row.lines[0] || null, span: 1, normUsed: fallbackNorm };
    }
    if (!best) continue;

    // ゲーム内フォントで候補を画像照合し、OCRの文字誤りを補正する
    const matchCoverage = best.sub && best.normUsed ? best.sub.length / best.normUsed.length : 1;
    if (ocrFontReady && canvas && best.line && best.line.bbox && best.normUsed && matchCoverage >= 0.7) {
      const lineCanvas = ocrCropLine(canvas, best.line.bbox);
      if (lineCanvas) {
        const candidates = ocrSkillCandidates(best.normUsed.replace(/\d{2,4}$/, ''), 12, 0.15);
        if (candidates.length) {
          const reranked = ocrFontRerank(candidates, lineCanvas);
          if (reranked && Math.max(reranked.imageScore || 0, reranked.suffixScore || 0) >= 0.2) {
            const different = reranked.skill.skill_id !== best.skill.skill_id;
            const strongImage = (reranked.imageScore || 0) >= 0.7 || (reranked.suffixScore || 0) >= 0.75;
            if (!different) {
              best = {
                ...best,
                score: Math.max(best.score, reranked.combined),
                imageScore: reranked.imageScore,
              };
            } else if (strongImage) {
              best = {
                ...best,
                skill: reranked.skill,
                score: Math.max(best.score, reranked.combined),
                imageScore: reranked.imageScore,
              };
            }
          }
        }
      }
    }

    // 同じ行の右側（ヒントLv・SP）を優先して読む
    let rightText = '';
    if (best.line && best.line.bbox) {
      rightText = row.lines
        .filter((l) => l.bbox && l.bbox.x0 > best.line.bbox.x1 - 5)
        .map((l) => l.text)
        .join(' ');
    }

    const rowNorm = ocrNormalizeText(rowText);
    const skillNorm = ocrNormalizeText(best.skill.name);
    const rowIsJustName = rowNorm === skillNorm ||
      (rowNorm.includes(skillNorm) && rowNorm.length <= skillNorm.length + 2);

    let hint = ocrExtractHint(rightText);
    let observedCost = ocrExtractCost(rightText);
    if (!rowIsJustName) {
      if (hint == null) hint = ocrExtractHint(rowText);
      if (observedCost == null) observedCost = ocrExtractCost(rowText);
    }

    // 同じ行に無ければ、次の行（名前の下にヒント/SPがあるレイアウト）を見る
    if (hint == null && observedCost == null && rows[ri + 1]) {
      const nextText = rows[ri + 1].lines.map((l) => l.text).join(' ');
      hint = ocrExtractHint(nextText);
      observedCost = ocrExtractCost(nextText);
    }

    // それでも無ければ、行順の前後を見る
    if (hint == null && observedCost == null) {
      const idx = best.line ? lines.indexOf(best.line) : -1;
      const nextText = idx >= 0 ? (lines[idx + 1]?.text || '') : '';
      hint = ocrExtractHint(nextText);
      observedCost = ocrExtractCost(nextText);
    }

    if (hint == null && observedCost != null) hint = ocrInferHint(best.skill.sp, observedCost);

    const lineConf = ((best.line?.confidence || 0) / 100);
    const costBonus = observedCost != null ? 0.1 : 0;
    const confidence = Math.min(1, best.score * 0.7 + Math.max(lineConf, 0.5) * 0.2 + costBonus);

    results.push({
      skill: best.skill,
      hint: hint == null ? null : hint,
      cost: observedCost,
      score: best.score,
      confidence,
      line: best.line?.text || rowText,
      lineObj: best.line || null,
    });
  }

  return { results, rawText };
}

function ocrParseCharacterData(data) {
  const rawText = String(data.text || '');
  const lines = (Array.isArray(data.lines) && data.lines.length
    ? data.lines
    : rawText.split(/\r?\n/).map((t) => ({ text: t, confidence: data.confidence || 0 })))
    .map((l) => ({ text: String(l.text || '').trim(), confidence: Number(l.confidence) || 0 }))
    .filter((l) => l.text);

  const candidates = [];
  for (const entry of getOcrCharaIndex()) {
    let bestScore = 0;
    let bestLine = '';
    for (const line of lines) {
      const norm = ocrNormalizeText(line.text);
      if (!norm) continue;
      const score = ocrSimilarity(norm, entry.norm, ocrBigrams(norm), entry.bigrams);
      if (score > bestScore) {
        bestScore = score;
        bestLine = line.text;
      }
    }
    if (bestScore >= 0.55) {
      for (const card of entry.cards) {
        candidates.push({
          card,
          charaScore: bestScore,
          displayScore: 0,
          score: bestScore,
          line: bestLine,
        });
      }
    }
  }

  // 衣装名（[スペシャルドリーマー] など）が写っていればカードを特定しやすくする。
  // キャラ名だけの行は全カードに部分一致してしまうため、衣装名で照合する。
  let maxCostumeScore = 0;
  for (const c of candidates) {
    const costumeNorm = ocrNormalizeText(c.card.costume_name || '');
    const costumeBigrams = ocrBigrams(costumeNorm);
    let bestCostume = 0;
    for (const line of lines) {
      const norm = ocrNormalizeText(line.text);
      if (!norm) continue;
      const score = ocrSimilarity(norm, costumeNorm, ocrBigrams(norm), costumeBigrams);
      if (score > bestCostume) {
        bestCostume = score;
        if (score > c.charaScore) c.line = line.text;
      }
    }
    c.costumeScore = bestCostume;
    if (bestCostume > maxCostumeScore) maxCostumeScore = bestCostume;
  }

  // 衣装名が十分に読めている場合は衣装一致を優先する。
  // キャラ名しか読めていない場合は同名カードを並べ、ユーザーに選ばせる。
  const useCostume = maxCostumeScore >= 0.7;
  for (const c of candidates) {
    c.score = useCostume
      ? c.charaScore * 0.35 + c.costumeScore * 0.65
      : c.charaScore;
  }

  candidates.sort((a, b) => b.score - a.score || a.card.card_id - b.card.card_id);
  return { candidates, rawText };
}

function mergeOcrSkillResults(results) {
  const map = new Map();
  for (const r of results) {
    const id = r.skill.skill_id;
    const cur = map.get(id);
    if (!cur) {
      map.set(id, r);
      continue;
    }
    if (r.hintSource === 'badge' && cur.hintSource !== 'badge') {
      map.set(id, { ...cur, hint: r.hint, hintSource: 'badge' });
      continue;
    }
    if (cur.hintSource === 'badge' && r.hintSource !== 'badge') continue;
    const better =
      r.confidence > cur.confidence ||
      (r.hint != null && cur.hint == null) ||
      (r.hint != null && cur.hint != null && r.confidence >= cur.confidence);
    if (better) map.set(id, r);
  }
  return map;
}

function applyOcrSkillResults() {
  const hintMap = new Map();
  for (const sel of $('ocrResult').querySelectorAll('select[data-ocr-hint]')) {
    hintMap.set(Number(sel.dataset.ocrHint), Number(sel.value) || 0);
  }
  for (const [id, hint] of hintMap) {
    if (hint > 0) state.hintLevels.set(id, hint);
    else state.hintLevels.delete(id);
  }
  saveHint();
  if ($('ocrSelectSkills')?.checked) {
    for (const id of hintMap.keys()) addSkillWithChain(id);
    saveSelection();
  }
  recomputeDerived();
  renderCardEvolution();
  renderScenarioEvolution();
  render();
  ocrSetStatus(`${formatNumber(hintMap.size)} 件のヒントLvを反映しました。`);
}

function renderOcrSkillResults(merged, rawText) {
  const items = [...merged.values()].sort((a, b) => b.confidence - a.confidence);
  if (!items.length) {
    $('ocrResult').innerHTML = '<div class="ocr-summary">スキルを認識できませんでした。画像を確認してください。</div>';
    $('ocrRaw').textContent = rawText;
    return;
  }
  const avg = items.reduce((s, r) => s + r.confidence, 0) / items.length;
  const rows = items.map((r) => {
    const hint = r.hint == null ? 0 : r.hint;
    const options = [0, 1, 2, 3, 4, 5].map((h) =>
      `<option value="${h}"${h === hint ? ' selected' : ''}>Lv${h}</option>`
    ).join('');
    const confClass = r.confidence >= 0.8 ? 'ocr-conf-high' : r.confidence >= 0.6 ? 'ocr-conf-mid' : 'ocr-conf-low';
    return `<tr>` +
      `<td title="${escapeHtml(r.line || '')} (text ${(r.score || 0).toFixed(2)}${r.imageScore != null ? ' / img ' + r.imageScore.toFixed(2) : ''})">${escapeHtml(r.skill.name)}</td>` +
      `<td><select class="hint-select" data-ocr-hint="${r.skill.skill_id}">${options}</select></td>` +
      `<td class="num ${confClass}">${Math.round(r.confidence * 100)}%</td>` +
      `</tr>`;
  }).join('');
  $('ocrResult').innerHTML =
    `<div class="ocr-summary">${formatNumber(items.length)} 件のスキルを認識（平均信頼度 ${Math.round(avg * 100)}%）</div>` +
    `<div class="ocr-table-wrap"><table class="ocr-table"><thead><tr><th>スキル</th><th>ヒントLv</th><th>信頼度</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<div class="ocr-actions">` +
      `<button class="btn primary" id="ocrApplySkills" type="button">認識結果をヒントLvに反映</button>` +
      `<label class="toggle"><input type="checkbox" id="ocrSelectSkills"> 認識したスキルを選択</label>` +
    `</div>`;
  $('ocrApplySkills').addEventListener('click', applyOcrSkillResults);
  $('ocrRaw').textContent = rawText;
}

function renderOcrCharacterResults(candidates, rawText) {
  if (!candidates.length) {
    $('ocrResult').innerHTML = '<div class="ocr-summary">ウマ娘を認識できませんでした。名前がはっきり写った画像を使ってください。</div>';
    $('ocrRaw').textContent = rawText;
    return;
  }
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.card.card_id)) continue;
    seen.add(c.card.card_id);
    unique.push(c);
  }
  const top = unique.slice(0, 20);
  const options = top.map((c) =>
    `<option value="${c.card.card_id}">${escapeHtml(c.card.display_name)}（${Math.round(c.score * 100)}%）</option>`
  ).join('');
  const first = top[0].card;
  $('ocrResult').innerHTML =
    `<div class="ocr-summary">認識したウマ娘: <b>${escapeHtml(first.chara_name)}</b></div>` +
    `<div>${escapeHtml(first.display_name)} ／ 芝 ${first.aptitude.ground['1']}・ダート ${first.aptitude.ground['2']} ／ 初期脚質 ${escapeHtml(first.running_style_name)}</div>` +
    `<div class="ocr-actions">` +
      `<select id="ocrCardChoice" class="card-select">${options}</select>` +
      `<button class="btn primary" id="ocrApplyCharacter" type="button">このウマ娘の初期適性を設定</button>` +
    `</div>`;
  $('ocrApplyCharacter').addEventListener('click', () => {
    const id = Number($('ocrCardChoice').value);
    const card = cardsById.get(id);
    if (!card) return;
    state.cardId = id;
    const cardSelect = $('cardSelect');
    if (cardSelect) cardSelect.value = String(id);
    applyCardAptitudes(card);
    saveSettings();
    renderSettings();
    updateCardInfo();
    recomputeDerived();
    renderCardEvolution();
    renderScenarioEvolution();
    render();
    ocrSetStatus(`「${card.display_name}」の初期適性を設定しました。`);
  });
  $('ocrRaw').textContent = rawText;
}

// ---------- OCR image preprocessing / engine ----------

function ocrSourceSize(source) {
  if (!source) return { w: 0, h: 0 };
  return {
    w: source.videoWidth || source.displayWidth || source.codedWidth || source.width || 0,
    h: source.videoHeight || source.displayHeight || source.codedHeight || source.height || 0,
  };
}

function ocrFrameSignature(source, size = 24, region = null) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (region) {
    ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, size, size);
  } else {
    ctx.drawImage(source, 0, 0, size, size);
  }
  const d = ctx.getImageData(0, 0, size, size).data;
  const out = new Uint8Array(size * size);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    out[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  return out;
}

function ocrListRegion(source) {
  const { w, h } = ocrSourceSize(source);
  return {
    x: Math.round(w * 0.10),
    y: Math.round(h * 0.25),
    w: Math.round(w * 0.50),
    h: Math.round(h * 0.65),
  };
}

function ocrSignatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function ocrCanvasHash(canvas) {
  const sig = ocrFrameSignature(canvas, 16);
  let sum = 0;
  for (const v of sig) sum += v;
  const avg = sum / sig.length;
  let bits = '';
  for (const v of sig) bits += v >= avg ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

// ---------- game font (UMAMUSUME-RodinWanpaku) based reranking ----------

function loadOcrFont() {
  if (ocrFontPromise) return ocrFontPromise;
  ocrFontPromise = (async () => {
    try {
      if (!('FontFace' in window) || !document.fonts) return false;
      const face = new FontFace('UmaGameFont', `url(${OCR_FONT_URL})`);
      await face.load();
      document.fonts.add(face);
      ocrFontReady = true;
      return true;
    } catch (err) {
      console.warn('game font load failed:', err);
      return false;
    }
  })();
  return ocrFontPromise;
}

function ocrOtsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let max = 0;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      threshold = i;
    }
  }
  return threshold;
}

function ocrTrimRect(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  const threshold = ocrOtsuThreshold(gray);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[row + x] < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function ocrNormalizedTextImage(canvas, expectedAspect = null) {
  const rect = ocrTrimRect(canvas);
  if (!rect) return null;
  let cropW = rect.w;
  if (expectedAspect && expectedAspect > 0) {
    cropW = Math.min(rect.w, Math.max(1, Math.round(rect.h * expectedAspect)));
  }
  const out = document.createElement('canvas');
  out.width = 192;
  out.height = 48;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 192, 48);
  ctx.drawImage(canvas, rect.x, rect.y, cropW, rect.h, 0, 0, 192, 48);
  const d = ctx.getImageData(0, 0, 192, 48).data;
  const gray = new Uint8Array(192 * 48);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  return gray;
}

function ocrRenderNameCanvas(name) {
  const size = 64;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = `${size}px "UmaGameFont", sans-serif`;
  const width = Math.max(32, Math.ceil(ctx.measureText(name).width) + 24);
  const height = 96;
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff';
  c.fillRect(0, 0, width, height);
  c.fillStyle = '#000';
  c.font = `${size}px "UmaGameFont", sans-serif`;
  c.textBaseline = 'middle';
  c.fillText(name, 12, height / 2);
  return canvas;
}

function ocrFontNameSignature(name) {
  if (ocrFontCache.has(name)) return ocrFontCache.get(name);
  const rendered = ocrRenderNameCanvas(name);
  const rect = ocrTrimRect(rendered);
  if (!rect) {
    ocrFontCache.set(name, null);
    return null;
  }
  const norm = ocrNormalizedTextImage(rendered);
  const sig = { norm, aspect: rect.w / rect.h };
  ocrFontCache.set(name, sig);
  return sig;
}

function ocrFontSimilarity(lineCanvas, name) {
  if (!ocrFontReady || !lineCanvas) return 0;
  const sig = ocrFontNameSignature(name);
  if (!sig) return 0;
  const lineNorm = ocrNormalizedTextImage(lineCanvas, sig.aspect);
  if (!lineNorm) return 0;
  const a = lineNorm;
  const b = sig.norm;
  const ta = ocrOtsuThreshold(a);
  const tb = ocrOtsuThreshold(b);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] < ta;
    const db = b[i] < tb;
    if (da && db) inter++;
    if (da || db) union++;
  }
  return union ? inter / union : 0;
}

function ocrFontCharSignature(ch) {
  if (ocrFontCharCache.has(ch)) return ocrFontCharCache.get(ch);
  const rendered = ocrRenderNameCanvas(ch);
  const norm = ocrNormalizedTextImage(rendered);
  ocrFontCharCache.set(ch, norm);
  return norm;
}

function ocrFontSuffixSimilarity(lineCanvas, name) {
  if (!ocrFontReady || !lineCanvas || !name) return 0;
  const lineRect = ocrTrimRect(lineCanvas);
  const fullSig = ocrFontNameSignature(name);
  if (!lineRect || !fullSig) return 0;
  const nameW = Math.min(lineRect.w, Math.max(1, Math.round(lineRect.h * fullSig.aspect)));
  const nameEndX = lineRect.x + nameW;
  const startX = Math.max(lineRect.x, nameEndX - lineRect.h);
  const w = Math.max(1, nameEndX - startX);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = lineRect.h;
  c.getContext('2d', { willReadFrequently: true })
    .drawImage(lineCanvas, startX, lineRect.y, w, lineRect.h, 0, 0, w, lineRect.h);
  const lineSig = ocrNormalizedTextImage(c);
  const charSig = ocrFontCharSignature(name.slice(-1));
  if (!lineSig || !charSig) return 0;
  const ta = ocrOtsuThreshold(lineSig);
  const tb = ocrOtsuThreshold(charSig);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < lineSig.length; i++) {
    const da = lineSig[i] < ta;
    const db = charSig[i] < tb;
    if (da && db) inter++;
    if (da || db) union++;
  }
  return union ? inter / union : 0;
}

function ocrCropLine(canvas, bbox) {
  if (!canvas || !bbox) return null;
  const x = Math.max(0, Math.floor(bbox.x0));
  const y = Math.max(0, Math.floor(bbox.y0));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(bbox.x1 - bbox.x0)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(bbox.y1 - bbox.y0)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  if (!canvas._ocrInverted) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

function ocrFontRerank(candidates, lineCanvas) {
  if (!candidates.length) return null;
  if (!ocrFontReady || !lineCanvas) return candidates[0];
  let best = null;
  for (const cand of candidates) {
    const imageScore = ocrFontSimilarity(lineCanvas, cand.skill.name);
    const suffixScore = ocrFontSuffixSimilarity(lineCanvas, cand.skill.name);
    const combined = cand.score * 0.35 + imageScore * 0.3 + suffixScore * 0.35;
    if (!best || combined > best.combined) {
      best = { ...cand, imageScore, suffixScore, combined };
    }
  }
  return best;
}

function ocrCropCanvas(source, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  c.getContext('2d', { willReadFrequently: true })
    .drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

function ocrRegionEdgeDensity(source, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, x, y, w, h, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  const gray = new Uint8Array(64 * 64);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  let sum = 0;
  let count = 0;
  for (let yy = 0; yy < 64; yy++) {
    for (let xx = 0; xx < 64; xx++) {
      const idx = yy * 64 + xx;
      if (xx > 0) {
        sum += Math.abs(gray[idx] - gray[idx - 1]);
        count++;
      }
      if (yy > 0) {
        sum += Math.abs(gray[idx] - gray[idx - 64]);
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

function ocrCropForMode(source, mode) {
  if (!state.ocrAutoCrop) return source;
  const w = source.width;
  const h = source.height;
  if (!w || !h) return source;
  let area = source;

  // 左:ゲーム、右:ログ等の横並び複合スクリーンショットを検出
  if (w / h > 1.3) {
    const half = Math.floor(w * 0.5);
    const leftEdge = ocrRegionEdgeDensity(source, 0, 0, half, h);
    const rightEdge = ocrRegionEdgeDensity(source, half, 0, w - half, h);
    if (rightEdge < leftEdge * 0.65) {
      area = ocrCropCanvas(source, 0, 0, half, h);
    }
  }

  const aw = area.width;
  const ah = area.height;
  if (mode === 'skills') {
    return ocrCropCanvas(
      area,
      Math.round(aw * 0.18),
      Math.round(ah * 0.28),
      Math.round(aw * 0.74),
      Math.round(ah * 0.62)
    );
  }
  return ocrCropCanvas(
    area,
    Math.round(aw * 0.18),
    Math.round(ah * 0.02),
    Math.round(aw * 0.72),
    Math.round(ah * 0.96)
  );
}

function ocrNormalizeColorCanvas(source) {
  const targetWidth = state.ocrFastMode ? 1400 : 1800;
  const scale = Math.min(2.5, Math.max(1, targetWidth / Math.max(1, source.width)));
  const w = Math.min(3000, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * (w / source.width)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
  return canvas;
}

function ocrFindBadges(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  const orange = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    orange[j] = r > 200 && g > 110 && g < 215 && b < 110 ? 1 : 0;
  }
  const startX = Math.floor(w * 0.5);
  const rowCount = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = startX; x < w; x++) if (orange[y * w + x]) count++;
    rowCount[y] = count;
  }
  const bands = [];
  let inBand = false;
  let y0 = 0;
  for (let y = 0; y < h; y++) {
    if (rowCount[y] > 5 && !inBand) {
      y0 = y;
      inBand = true;
    } else if (rowCount[y] <= 5 && inBand) {
      if (y - y0 > 15) bands.push([y0, y - 1]);
      inBand = false;
    }
  }
  if (inBand) bands.push([y0, h - 1]);

  const badges = [];
  for (const [ya, yb] of bands) {
    let minX = w;
    let maxX = -1;
    for (let y = ya; y <= yb; y++) {
      for (let x = startX; x < w; x++) {
        if (orange[y * w + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (maxX < minX) continue;
    const bw = maxX - minX + 1;
    const bh = yb - ya + 1;
    if (bw < 60 || bh < 50) continue;
    badges.push({ x: minX, y: ya, w: bw, h: bh });
  }
  return badges;
}

async function ocrReadBadge(canvas, badge) {
  const margin = 4;
  const x = Math.max(0, badge.x - margin);
  const y = Math.max(0, badge.y - margin);
  const w = Math.min(canvas.width - x, badge.w + margin * 2);
  const h = Math.min(canvas.height - y, badge.h + margin * 2);
  const crop = document.createElement('canvas');
  crop.width = w * 4;
  crop.height = h * 4;
  const ctx = crop.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
  const im = ctx.getImageData(0, 0, crop.width, crop.height);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = g >= 200 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = g;
    d[i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  const worker = await getOcrEngWorker();
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: '',
  });
  const r = await worker.recognize(crop);
  const text = (r.data ? r.data.text : '').replace(/\s+/g, ' ').trim();
  let hint = null;
  let m = text.match(/[Ll][vV]\.?\s*([1-5])/);
  if (m) hint = Number(m[1]);
  if (hint == null) {
    if (/35\s*%/.test(text)) hint = 4;
    else {
      m = text.match(/([1-5])\s*0\s*%/);
      if (m) hint = Number(m[1]);
    }
  }
  return { hint, text };
}

async function ocrReadBadges(canvas, badgeList = null) {
  const badges = badgeList || ocrFindBadges(canvas);
  const out = [];
  for (const badge of badges) {
    const { hint, text } = await ocrReadBadge(canvas, badge);
    out.push({ y: badge.y + badge.h / 2, hint, text });
  }
  return out;
}

function ocrMergeBadges(results, badges) {
  for (const b of badges) {
    if (b.hint == null) continue;
    let best = null;
    for (const r of results) {
      if (!r.lineObj || !r.lineObj.bbox) continue;
      const ry = (r.lineObj.bbox.y0 + r.lineObj.bbox.y1) / 2;
      const dist = Math.abs(ry - b.y);
      if (!best || dist < best.dist) best = { r, dist };
    }
    if (best && best.dist < 120) {
      best.r.hint = b.hint;
      best.r.hintSource = 'badge';
    }
  }
}

function ocrNormalizeCanvas(source) {
  const targetWidth = state.ocrFastMode ? 1400 : 1800;
  const scale = Math.min(2.5, Math.max(1, targetWidth / Math.max(1, source.width)));
  const w = Math.min(3000, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * (w / source.width)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < d.length; i += 16) {
    sum += d[i] + d[i + 1] + d[i + 2];
    count += 3;
  }
  const avg = count ? sum / count : 128;
  const invert = avg < 120;
  for (let i = 0; i < d.length; i += 4) {
    let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (invert) gray = 255 - gray;
    gray = (gray - 128) * 1.35 + 128;
    gray = Math.max(0, Math.min(255, gray));
    d[i] = d[i + 1] = d[i + 2] = gray;
    d[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  canvas._ocrInverted = invert;
  return canvas;
}

function ocrOtsuCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas._ocrInverted = source._ocrInverted;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = d.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let max = 0;
  let threshold = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      threshold = i;
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = OCR_CDN;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('OCRエンジンを読み込めませんでした（ネット接続を確認してください）'));
    document.head.appendChild(script);
  });
  return ocrWorkerPromise;
}

async function getOcrWorkers(count = 2) {
  if (ocrWorkers.length >= count) return ocrWorkers;
  ocrSetStatus('OCRエンジンを準備中です（初回は日本語データのダウンロードで時間がかかります）...');
  const T = await loadTesseract();
  while (ocrWorkers.length < count) {
    const index = ocrWorkers.length + 1;
    ocrSetStatus(`OCRエンジンを準備中... (${index}/${count})`);
    const worker = await T.createWorker('jpn+eng', 1, {
      logger: (m) => {
        if (m.status === 'loading language traineddata' || m.status === 'initializing api') {
          ocrSetStatus(`OCR準備中: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
        }
      },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
    });
    ocrWorkers.push(worker);
  }
  return ocrWorkers;
}

async function getOcrEngWorker() {
  if (ocrEngWorker) return ocrEngWorker;
  const T = await loadTesseract();
  ocrEngWorker = await T.createWorker('eng', 1, { logger: () => {} });
  await ocrEngWorker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1',
  });
  return ocrEngWorker;
}

async function runOcr() {
  if (!ocrImages.length) return;
  const runBtn = $('ocrRun');
  runBtn.disabled = true;
  ocrSetStatus('OCRを実行中です...');
  try {
    await loadOcrFont();
    const workers = await getOcrWorkers(2);
    const results = new Array(ocrImages.length);
    let nextIndex = 0;
    let completed = 0;

    async function processWorker(worker) {
      while (true) {
        const i = nextIndex++;
        if (i >= ocrImages.length) break;
        const img = ocrImages[i];
        const image = await loadImage(img.dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const cropped = ocrCropForMode(canvas, ocrMode);
        const colorNorm = ocrNormalizeColorCanvas(cropped);
        const gray = ocrNormalizeCanvas(cropped);
        const badges = ocrMode === 'skills' ? ocrFindBadges(colorNorm) : [];
        const variants = state.ocrFastMode ? [gray] : [gray, ocrOtsuCanvas(gray)];
        let bestParsed = null;
        let bestRaw = '';
        const collected = [];
        const rawParts = [];

        for (let v = 0; v < variants.length; v++) {
          const recognized = await worker.recognize(variants[v]);
          const data = recognized && recognized.data ? recognized.data : recognized;
          if (ocrMode === 'skills') {
            const parsed = ocrParseSkillData(data, variants[v]);
            collected.push(...parsed.results);
            rawParts.push(parsed.rawText);
            if (v === 0 && state.ocrFastMode && collected.length < Math.max(3, badges.length)) {
              variants.push(ocrOtsuCanvas(gray));
            }
          } else {
            const parsed = ocrParseCharacterData(data);
            if (!bestParsed || (parsed.candidates[0]?.score || 0) > (bestParsed.candidates[0]?.score || 0)) {
              bestParsed = parsed;
              bestRaw = parsed.rawText;
            }
          }
        }

        if (ocrMode === 'skills') {
          const merged = mergeOcrSkillResults(collected);
          bestParsed = { results: [...merged.values()], rawText: rawParts.join('\n') };
          bestRaw = bestParsed.rawText;
          try {
            const badgeHints = await ocrReadBadges(colorNorm, badges);
            ocrMergeBadges(bestParsed.results, badgeHints);
          } catch (err) {
            console.warn('badge OCR failed:', err);
          }
        }

        results[i] = { parsed: bestParsed, raw: bestRaw, name: img.name };
        completed++;
        ocrSetStatus(`OCR ${completed}/${ocrImages.length} 件完了...`);
      }
    }

    await Promise.all(workers.map((worker) => processWorker(worker)));

    const skillResults = [];
    const charaCandidates = [];
    let rawAll = '';
    for (const r of results) {
      if (!r) continue;
      rawAll += `--- ${r.name} ---\n${r.raw}\n\n`;
      if (ocrMode === 'skills') skillResults.push(...(r.parsed?.results || []));
      else charaCandidates.push(...(r.parsed?.candidates || []));
    }

    if (ocrMode === 'skills') {
      const merged = mergeOcrSkillResults(skillResults);
      renderOcrSkillResults(merged, rawAll);
      ocrSetStatus(`${formatNumber(merged.size)} 件のスキルを認識しました。内容を確認して反映してください。`);
    } else {
      charaCandidates.sort((a, b) => b.score - a.score || a.card.card_id - b.card.card_id);
      renderOcrCharacterResults(charaCandidates, rawAll);
      ocrSetStatus(charaCandidates.length
        ? 'ウマ娘を認識しました。候補を確認して設定してください。'
        : 'ウマ娘を認識できませんでした。');
    }
  } catch (err) {
    console.error(err);
    ocrSetStatus(`OCRに失敗しました: ${err.message || err}`);
  } finally {
    runBtn.disabled = ocrImages.length === 0;
  }
}

export {
  ocrImages,
  ocrSetStatus,
  renderOcrThumbs,
  addOcrCanvas,
  ocrAddFile,
  pasteOcrImage,
  runOcr,
  applyOcrSkillResults,
  ocrSourceSize,
  ocrFrameSignature,
  ocrListRegion,
  ocrSignatureDiff,
  ocrCanvasHash,
};

export function setOcrMode(mode) {
  ocrMode = mode === 'character' ? 'character' : 'skills';
}

export function getOcrMode() {
  return ocrMode;
}

export function removeOcrImage(id) {
  ocrImages = ocrImages.filter((img) => img.id !== id);
}
