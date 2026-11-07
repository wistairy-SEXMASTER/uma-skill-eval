// アプリ全体で共有する定数。DOM・データ・状態には依存しない。

export const EFFECT_ORDER = ['速度', '加速', '回復', '緑', 'デバフ', '位置取り', '視野', 'ゲート', '特殊', 'その他'];

export const EFFECT_CLASS = {
  '速度': 'speed',
  '加速': 'accel',
  '回復': 'heal',
  '緑': 'green',
  'デバフ': 'debuff',
  '位置取り': 'position',
  '視野': 'sight',
  'ゲート': 'gate',
  '特殊': 'special',
  'その他': 'other',
};

export const STORAGE_KEY = 'uma-skill-eval:selected:v1';
export const HINT_KEY = 'uma-skill-eval:hint:v1';
export const SETTINGS_KEY = 'uma-skill-eval:settings:v1';

export const TYPE_ORDER = ['ノーマル', 'レア', '固有', '継承固有', '進化', '特殊', 'その他'];

export const TYPE_CLASS = {
  'ノーマル': 'normal',
  'レア': 'rare',
  '固有': 'unique',
  '継承固有': 'inherit',
  '進化': 'evolution',
  '特殊': 'special',
  'その他': 'other',
};

export const TYPE_RANK = new Map(TYPE_ORDER.map((t, i) => [t, i]));

// ヒントLvごとのSP減少率（ゲーム内仕様）
export const HINT_DISCOUNTS = { 0: 0, 1: 0.10, 2: 0.20, 3: 0.30, 4: 0.35, 5: 0.40 };

// 適性ランク → 評価点倍率（S/A=1.1, B/C=0.9, D/E/F=0.8, G=0.7）
export const APT_GRADES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
export const APT_MULT = { S: 1.1, A: 1.1, B: 0.9, C: 0.9, D: 0.8, E: 0.8, F: 0.8, G: 0.7 };

export const DISTANCE_META = {
  1: { short: '短', long: '短距離' },
  2: { short: 'マ', long: 'マイル' },
  3: { short: '中', long: '中距離' },
  4: { short: '長', long: '長距離' },
};

export const STYLE_META = {
  1: { short: '逃', long: '逃げ' },
  2: { short: '先', long: '先行' },
  3: { short: '差', long: '差し' },
  4: { short: '追', long: '追込' },
};

export const GROUND_META = {
  1: { short: '芝', long: '芝' },
  2: { short: 'ダ', long: 'ダート' },
};

export const FILTER_CATEGORIES = [
  { key: 'distance', groupId: 'filterDistance', meta: DISTANCE_META },
  { key: 'ground', groupId: 'filterGround', meta: GROUND_META },
  { key: 'style', groupId: 'filterStyle', meta: STYLE_META },
];

export const OPT_MAX_BUDGET = 20000;
export const FAST_LEARNER_DISCOUNT = 0.10;
export const DILIGENT_DISCOUNT = 0.04; // 勉強家（切れ者と同時の場合は切れ者を優先）
export const UNIQUE_POINT_PER_LEVEL = 170; // 本体固有スキル: 固有Lv × 170
export const INHERIT_UNIQUE_POINT = 180;   // 継承固有スキル: 一律180

export const DERIVED_KEYS = {
  eval_point: '_eval',
  upgrade_point: '_upgrade_point',
  sp: '_sp',
  total_sp: '_total_sp',
  efficiency: '_efficiency',
  total_efficiency: '_total_efficiency',
};

// ゲームデータ取得（パケット転送サーバー）
export const GAME_API_DEFAULT = 'http://127.0.0.1:4693';
export const GAME_AUTO_INTERVAL = 5000;

// OCR
export const OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
export const OCR_FONT_URL = 'assets/umamusume-font.ttf';
export const OCR_MAX_IMAGES = 120;
export const OCR_SENSITIVITY = {
  high: { full: 3, region: 0.8, stableFull: 1, stableRegion: 0.4 },
  medium: { full: 5, region: 1.5, stableFull: 2, stableRegion: 0.8 },
  low: { full: 8, region: 3, stableFull: 3, stableRegion: 1.5 },
};
