// 画面キャプチャとフレーム変化検出。OCRモジュールの画像ユーティリティを利用する。

import { state } from '../core/state.js';
import { OCR_SENSITIVITY } from '../core/constants.js';
import { $ } from '../core/utils.js';
import {
  ocrImages,
  addOcrCanvas,
  ocrSetStatus,
  ocrSourceSize,
  ocrFrameSignature,
  ocrListRegion,
  ocrSignatureDiff,
} from './ocr.js';

let ocrCapture = {
  stream: null,
  video: null,
  sampleTimer: null,
  lastFullSig: null,
  lastRegionSig: null,
  lastSampleAt: 0,
  changed: false,
  stableCount: 0,
  lastCaptureAt: 0,
  autoActive: false,
  processorReader: null,
  frameLoopStarted: false,
};

// ---------- live screen capture ----------

async function startOcrCapture() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('このブラウザは画面キャプチャに対応していません');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    ocrCapture.stream = stream;
    ocrCapture.video = video;
    ocrCapture.frameLoopStarted = false;
    ocrCapture.processorReader = null;
    ocrCapture.autoActive = false;
    const usedProcessor = await startFrameProcessor(stream);
    if (!usedProcessor) startVideoFrameLoop();
    stream.getVideoTracks()[0].addEventListener('ended', stopOcrCapture);
    $('ocrCaptureFrame').disabled = false;
    $('ocrCaptureAuto').disabled = false;
    $('ocrCaptureStop').disabled = false;
    $('ocrCaptureStart').disabled = true;
    ocrSetStatus('画面キャプチャ中です。ゲーム画面を共有し、スクロールしながら「この画面を取り込む」を押してください。');
  } catch (err) {
    if (err && err.name === 'NotAllowedError') {
      ocrSetStatus(
        '画面キャプチャが許可されませんでした。OpenCode内蔵ブラウザでは使用できません。' +
        'Chrome/Edgeでこのページを開くか、「画像を追加」「クリップボードから貼り付け」を使ってください。'
      );
    } else if (err && err.name === 'NotFoundError') {
      ocrSetStatus('共有できる画面が見つかりませんでした。ゲーム画面を開いた状態で再試行してください。');
    } else {
      ocrSetStatus(`画面キャプチャを開始できませんでした: ${err && err.message ? err.message : err}`);
    }
  }
}

function updateOcrCaptureHint() {
  const hint = $('ocrCaptureHint');
  if (!hint) return;
  const inApp = /OpenCode|Electron/i.test(navigator.userAgent);
  hint.textContent = inApp
    ? '内蔵ブラウザでは画面キャプチャ不可。Chrome/Edgeで開いてください。'
    : '画面キャプチャはChrome/Edge推奨。';
}

async function copyOcrUrl() {
  const url = location.href.split('?')[0];
  try {
    await navigator.clipboard.writeText(url);
    ocrSetStatus(`URLをコピーしました。Chrome/Edgeのアドレス欄に貼り付けて開いてください: ${url}`);
  } catch (err) {
    ocrSetStatus(`Chrome/Edgeで次のURLを開いてください: ${url}`);
  }
}

function captureOcrFrame(source = ocrCapture.video) {
  if (!source) return;
  const { w, h } = ocrSourceSize(source);
  if (!w || !h) return;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  ocrCapture.lastCaptureAt = Date.now();
  const added = addOcrCanvas(canvas, `キャプチャ ${ocrImages.length + 1}`);
  if (added) {
    ocrSetStatus(`${ocrImages.length} 枚の画像を取り込みました。続けてスクロールして取り込めます。`);
  }
}

function sampleCaptureSource(source) {
  if (!source) return;
  const { w, h } = ocrSourceSize(source);
  if (!w || !h) return;
  const fullSig = ocrFrameSignature(source, 24);
  const regionSig = ocrFrameSignature(source, 32, ocrListRegion(source));
  const fullDiff = ocrSignatureDiff(fullSig, ocrCapture.lastFullSig);
  const regionDiff = ocrSignatureDiff(regionSig, ocrCapture.lastRegionSig);
  ocrCapture.lastFullSig = fullSig;
  ocrCapture.lastRegionSig = regionSig;

  const s = OCR_SENSITIVITY[state.ocrSensitivity] || OCR_SENSITIVITY.medium;
  const live = $('ocrLiveStatus');
  if (live) {
    live.textContent = `画面 ${fullDiff.toFixed(1)} / 一覧 ${regionDiff.toFixed(1)} / 取り込み ${ocrImages.length}枚`;
  }

  if (fullDiff > s.full || regionDiff > s.region) {
    ocrCapture.changed = true;
    ocrCapture.stableCount = 0;
    return;
  }
  if (!ocrCapture.changed) return;
  if (fullDiff > s.stableFull || regionDiff > s.stableRegion) {
    ocrCapture.stableCount = 0;
    return;
  }
  ocrCapture.stableCount++;
  if (ocrCapture.stableCount >= 2) {
    captureOcrFrame(source);
    ocrCapture.changed = false;
    ocrCapture.stableCount = 0;
  }
}

async function startFrameProcessor(stream) {
  if (!('MediaStreamTrackProcessor' in window)) return false;
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return false;
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    ocrCapture.processorReader = reader;
    (async () => {
      while (true) {
        let result;
        try {
          result = await reader.read();
        } catch (err) {
          break;
        }
        const { value: frame, done } = result;
        if (done) break;
        if (ocrCapture.autoActive) {
          const now = performance.now();
          if (now - ocrCapture.lastSampleAt >= 200) {
            ocrCapture.lastSampleAt = now;
            sampleCaptureSource(frame);
          }
        }
        frame.close();
      }
      ocrCapture.processorReader = null;
      if (ocrCapture.autoActive) startVideoFrameLoop();
    })();
    return true;
  } catch (err) {
    console.warn('MediaStreamTrackProcessor failed:', err);
    return false;
  }
}

function startVideoFrameLoop() {
  if (ocrCapture.frameLoopStarted) return;
  const video = ocrCapture.video;
  if (!video) return;
  ocrCapture.frameLoopStarted = true;
  if ('requestVideoFrameCallback' in video) {
    const loop = () => {
      if (!ocrCapture.video) return;
      if (ocrCapture.autoActive) {
        const now = performance.now();
        if (now - ocrCapture.lastSampleAt >= 200) {
          ocrCapture.lastSampleAt = now;
          sampleCaptureSource(video);
        }
      }
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
  } else {
    ocrCapture.sampleTimer = setInterval(() => {
      if (ocrCapture.autoActive) sampleCaptureSource(video);
    }, 250);
  }
}

function startAutoCapture() {
  if (ocrCapture.autoActive) return;
  ocrCapture.autoActive = true;
  ocrCapture.lastFullSig = null;
  ocrCapture.lastRegionSig = null;
  ocrCapture.changed = true;
  ocrCapture.stableCount = 0;
  ocrCapture.lastSampleAt = 0;
  if (!ocrCapture.processorReader) startVideoFrameLoop();
  $('ocrCaptureAuto').disabled = true;
  ocrSetStatus('フレーム変化を検出して自動取り込み中です。スクロールを止めると、その画面を保存します。');
}

function stopAutoCapture() {
  ocrCapture.autoActive = false;
  if (ocrCapture.sampleTimer) {
    clearInterval(ocrCapture.sampleTimer);
    ocrCapture.sampleTimer = null;
  }
  $('ocrCaptureAuto').disabled = false;
}

function stopOcrCapture() {
  stopAutoCapture();
  if (ocrCapture.processorReader) {
    try {
      ocrCapture.processorReader.cancel();
    } catch (err) { /* ignore */ }
    ocrCapture.processorReader = null;
  }
  ocrCapture.frameLoopStarted = false;
  if (ocrCapture.stream) {
    for (const track of ocrCapture.stream.getTracks()) track.stop();
    ocrCapture.stream = null;
  }
  ocrCapture.video = null;
  const live = $('ocrLiveStatus');
  if (live) live.textContent = '';
  $('ocrCaptureFrame').disabled = true;
  $('ocrCaptureAuto').disabled = true;
  $('ocrCaptureStop').disabled = true;
  $('ocrCaptureStart').disabled = false;
  ocrSetStatus('画面キャプチャを停止しました。');
}

export {
  startOcrCapture,
  updateOcrCaptureHint,
  copyOcrUrl,
  captureOcrFrame,
  startAutoCapture,
  stopAutoCapture,
  stopOcrCapture,
};
