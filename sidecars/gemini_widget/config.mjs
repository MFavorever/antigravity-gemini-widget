/**
 * Configuration, shuffle-bag dialogue manager, daily ledger, and runtime discovery
 * for antigravity-gemini-widget. Zero external dependencies.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_DIALOGUES = [
  { text: '嗨~今天也要闪闪发光哦！', weight: 3 },
  { text: '猫姬正在帮你盯着 Token 和额度呢~', weight: 2 },
  { text: '缓存命中越高，省下来的星辉就越多哦✨', weight: 2 },
  { text: '点我一下可以展开账单，再点一下收起~', weight: 2 },
  { text: '写累了就喝口水休息一下吧，代码不会跑掉的~', weight: 2 },
  { text: '拖动我就能贴边吸附，贴到左边我还会自动转身！', weight: 1 },
  { text: '每 5 小时额度会滚雪球刷新，合理切换 Flash / Pro 更省心~', weight: 2 },
  { text: '右键或者点右上角菜单，可以调大小和静音哦！', weight: 1 },
];

export const DEFAULT_SETTINGS = {
  scale: 1.0,
  soundEnabled: true,
  soundVolume: 0.75,
  autoBroadcast: true,
  broadcastDurationSec: 5,
  dockMode: 'antigravity', // 'antigravity' | 'free'
  snapEdge: 'bottom-right',
  snapOffsetX: 0,
  snapOffsetY: 0,
  flipped: false,
  currency: 'CNY', // 'CNY' | 'USD'
  usdToCny: 7.25,
  autoLaunchPet: true,
  // Reference token caps used as fallback estimates when live GetUserStatus quota is unavailable
  fallbackCaps: {
    gemini5hTokens: 20_000_000,
    geminiWeeklyTokens: 100_000_000,
    claudeGpt5hTokens: 10_000_000,
    claudeGptWeeklyTokens: 50_000_000,
  },
  dialogues: DEFAULT_DIALOGUES,
  pricingOverrides: {},
};

export function resolveAppDataDir(explicitDir = '') {
  if (explicitDir) return explicitDir;
  const fromEnv = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (fromEnv) {
    for (let d = fromEnv; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return appData;
      }
    }
    if (existsSync(join(fromEnv, 'brain'))) return fromEnv;
  }
  const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (appDataDir && existsSync(appDataDir)) return appDataDir;
  return join(homedir(), '.gemini', 'antigravity');
}

export function resolvePluginDataDir(explicitDataDir = '') {
  if (explicitDataDir) return explicitDataDir;
  if (process.env.GEMINI_WIDGET_DATA_DIR) return process.env.GEMINI_WIDGET_DATA_DIR;
  if (process.env.PLUGIN_DATA) return process.env.PLUGIN_DATA;
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  return join(resolveAppDataDir(), 'plugin_data', 'antigravity-gemini-widget');
}

export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const scaleNum = Number(src.scale);
  const scale = Number.isFinite(scaleNum) ? Math.max(0.6, Math.min(2.5, Math.round(scaleNum * 100) / 100)) : DEFAULT_SETTINGS.scale;
  const volNum = Number(src.soundVolume);
  const soundVolume = Number.isFinite(volNum) ? Math.max(0, Math.min(1, Math.round(volNum * 100) / 100)) : DEFAULT_SETTINGS.soundVolume;
  const bSec = Number(src.broadcastDurationSec);
  const broadcastDurationSec = Number.isFinite(bSec) ? Math.max(2, Math.min(30, Math.round(bSec))) : DEFAULT_SETTINGS.broadcastDurationSec;
  const usdToCnyNum = Number(src.usdToCny);
  const usdToCny = Number.isFinite(usdToCnyNum) && usdToCnyNum > 0 ? Math.round(usdToCnyNum * 100) / 100 : DEFAULT_SETTINGS.usdToCny;

  const dialogues = Array.isArray(src.dialogues) && src.dialogues.length > 0
    ? src.dialogues
        .map((d) => {
          if (typeof d === 'string' && d.trim()) return { text: d.trim(), weight: 1 };
          if (d && typeof d === 'object' && typeof d.text === 'string' && d.text.trim()) {
            const w = Number(d.weight);
            return { text: d.text.trim(), weight: Number.isFinite(w) && w > 0 ? Math.min(20, Math.round(w)) : 1 };
          }
          return null;
        })
        .filter(Boolean)
    : DEFAULT_DIALOGUES.map((d) => ({ ...d }));

  const fallbackCaps = {
    ...DEFAULT_SETTINGS.fallbackCaps,
    ...(src.fallbackCaps && typeof src.fallbackCaps === 'object' ? src.fallbackCaps : {}),
  };

  return {
    scale,
    soundEnabled: typeof src.soundEnabled === 'boolean' ? src.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
    soundVolume,
    autoBroadcast: typeof src.autoBroadcast === 'boolean' ? src.autoBroadcast : DEFAULT_SETTINGS.autoBroadcast,
    broadcastDurationSec,
    dockMode: src.dockMode === 'free' ? 'free' : 'antigravity',
    snapEdge: typeof src.snapEdge === 'string' && src.snapEdge ? src.snapEdge : DEFAULT_SETTINGS.snapEdge,
    snapOffsetX: Number.isFinite(Number(src.snapOffsetX)) ? Math.round(Number(src.snapOffsetX)) : DEFAULT_SETTINGS.snapOffsetX,
    snapOffsetY: Number.isFinite(Number(src.snapOffsetY)) ? Math.round(Number(src.snapOffsetY)) : DEFAULT_SETTINGS.snapOffsetY,
    flipped: Boolean(src.flipped),
    currency: src.currency === 'USD' ? 'USD' : 'CNY',
    usdToCny,
    autoLaunchPet: typeof src.autoLaunchPet === 'boolean' ? src.autoLaunchPet : DEFAULT_SETTINGS.autoLaunchPet,
    fallbackCaps,
    dialogues,
    pricingOverrides: src.pricingOverrides && typeof src.pricingOverrides === 'object' ? src.pricingOverrides : {},
  };
}

export class ConfigStore {
  constructor(dataDir = resolvePluginDataDir()) {
    this.dataDir = ensureDir(dataDir);
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.ledgerPath = join(this.dataDir, 'ledger.json');
    this.runtimePath = join(this.dataDir, 'runtime.json');
    this._settings = normalizeSettings(readJsonSafe(this.settingsPath, DEFAULT_SETTINGS));
    if (!existsSync(this.settingsPath)) {
      writeJsonAtomic(this.settingsPath, this._settings);
    }
    this._bag = [];
    this._lastLine = '';
  }

  getSettings() {
    return this._settings;
  }

  updateSettings(patch) {
    const merged = {
      ...this._settings,
      ...(patch && typeof patch === 'object' ? patch : {}),
      fallbackCaps: {
        ...this._settings.fallbackCaps,
        ...(patch?.fallbackCaps && typeof patch.fallbackCaps === 'object' ? patch.fallbackCaps : {}),
      },
      pricingOverrides: {
        ...this._settings.pricingOverrides,
        ...(patch?.pricingOverrides && typeof patch.pricingOverrides === 'object' ? patch.pricingOverrides : {}),
      },
    };
    this._settings = normalizeSettings(merged);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'dialogues')) {
      this._bag = [];
    }
    writeJsonAtomic(this.settingsPath, this._settings);
    return this._settings;
  }

  /**
   * Weighted shuffle-bag: draws lines proportional to weight without repeating
   * until every line in the current bag has been shown once.
   */
  nextDialogue() {
    const lines = this._settings.dialogues.length > 0 ? this._settings.dialogues : DEFAULT_DIALOGUES;
    if (this._bag.length === 0) {
      const pool = [];
      for (const item of lines) {
        const copies = Math.max(1, Math.min(10, Number(item.weight) || 1));
        for (let i = 0; i < copies; i++) pool.push(item.text);
      }
      // Fisher-Yates shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      // Deduplicate sequential draws while keeping weighted ordering
      const seen = new Set();
      this._bag = [];
      for (const text of pool) {
        if (!seen.has(text)) {
          seen.add(text);
          this._bag.push(text);
        }
      }
      if (this._bag.length > 1 && this._bag[this._bag.length - 1] === this._lastLine) {
        // Avoid immediate boundary repeat across bag refills (pop takes from end)
        const first = this._bag[0];
        this._bag[0] = this._bag[this._bag.length - 1];
        this._bag[this._bag.length - 1] = first;
      }
    }
    const chosen = this._bag.pop() || DEFAULT_DIALOGUES[0].text;
    this._lastLine = chosen;
    return chosen;
  }

  loadLedger() {
    return readJsonSafe(this.ledgerPath, { days: {}, updatedAt: '' });
  }

  saveLedger(dailyMap) {
    const existing = this.loadLedger();
    const mergedDays = { ...(existing.days || {}) };
    for (const [dayKey, entry] of Object.entries(dailyMap || {})) {
      mergedDays[dayKey] = entry;
    }
    // Keep most recent 90 days
    const sortedKeys = Object.keys(mergedDays).sort().slice(-90);
    const trimmed = {};
    for (const k of sortedKeys) trimmed[k] = mergedDays[k];
    const payload = {
      days: trimmed,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.ledgerPath, payload);
    return payload;
  }

  writeRuntime(info) {
    writeJsonAtomic(this.runtimePath, {
      ...info,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    });
  }

  clearRuntime() {
    try {
      if (existsSync(this.runtimePath)) {
        writeJsonAtomic(this.runtimePath, { port: 0, pid: 0, stoppedAt: new Date().toISOString() });
      }
    } catch {
      // ignore cleanup error
    }
  }
}
