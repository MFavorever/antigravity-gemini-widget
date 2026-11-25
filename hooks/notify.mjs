/**
 * Fast, non-blocking Antigravity hook forwarder for antigravity-gemini-widget.
 * Always writes "{}" to stdout and exits 0 within <= 1300ms.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function getAppDataDir() {
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
}

function findRuntimePort() {
  const candidates = [];
  if (process.env.GEMINI_WIDGET_DATA_DIR) {
    candidates.push(join(process.env.GEMINI_WIDGET_DATA_DIR, 'runtime.json'));
  }
  if (process.env.PLUGIN_DATA) {
    candidates.push(join(process.env.PLUGIN_DATA, 'runtime.json'));
  }
  const appData = getAppDataDir();
  candidates.push(join(appData, 'plugin_data', 'antigravity-gemini-widget', 'runtime.json'));
  candidates.push(join(appData, 'sidecar_data', 'antigravity-gemini-widget', 'gemini_widget', 'data', 'runtime.json'));
  candidates.push(join(appData, 'sidecar_data', 'antigravity-gemini-widget_gemini_widget', 'data', 'runtime.json'));

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (parsed && Number.isFinite(parsed.port) && parsed.port > 0) {
        return parsed.port;
      }
    } catch {
      // try next
    }
  }
  return Number.parseInt(process.env.GEMINI_WIDGET_PORT || '18923', 10) || 18923;
}

function normalizePct(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  return Math.min(100, Math.max(0, Math.round(val)));
}

async function syncQuotaToThemePatch(port) {
  if (!(port > 0)) return { ok: false, reason: 'invalid_port' };
  try {
    const controller = new AbortController();
    const reqTimer = setTimeout(() => controller.abort(), 350);
    let data = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/summary`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      data = await res.json();
    } finally {
      clearTimeout(reqTimer);
    }

    const g = data?.quota?.gemini;
    const fiveHour = normalizePct(g?.fiveHour?.remainingPct);
    const weekly = normalizePct(g?.weekly?.remainingPct);
    if (fiveHour === null && weekly === null) {
      return { ok: false, reason: 'no_quota_data' };
    }

    const fiveHourResetIn = String(g?.fiveHour?.resetIn || '');
    const weeklyResetIn = String(g?.weekly?.resetIn || '');
    const source = String(g?.fiveHour?.source || data?.quota?.source || 'live');
    const parsedTs = Date.parse(data?.quota?.fetchedAt || '');
    const updatedAt = Number.isFinite(parsedTs) ? parsedTs : Date.now();

    const cfgPath = join(getAppDataDir(), 'theme-patch', 'user', 'config.json');
    if (!existsSync(cfgPath)) {
      return { ok: false, reason: 'config_not_found' };
    }

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { ok: false, reason: 'invalid_config_root' };
    }

    const prev = cfg.themeVars && typeof cfg.themeVars === 'object' ? cfg.themeVars._geminiQuota : null;
    const resetChanged =
      prev && (prev.fiveHourResetIn !== fiveHourResetIn || prev.weeklyResetIn !== weeklyResetIn);
    const needWrite =
      !prev ||
      prev.fiveHour !== fiveHour ||
      prev.weekly !== weekly ||
      prev.source !== source ||
      (resetChanged && Date.now() - (Number(prev.updatedAt) || 0) >= 600_000);

    if (!needWrite) {
      return { ok: true, skipped: true, fiveHour, weekly };
    }

    const nextQuota = {
      fiveHour,
      weekly,
      fiveHourResetIn,
      weeklyResetIn,
      source,
      updatedAt,
    };
    cfg.themeVars = Object.assign({}, cfg.themeVars, { _geminiQuota: nextQuota });
    const serialized = `${JSON.stringify(cfg, null, 2)}\n`;
    const tmpPath = `${cfgPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmpPath, serialized, 'utf-8');
      renameSync(tmpPath, cfgPath);
    } catch {
      writeFileSync(cfgPath, serialized, 'utf-8');
    }

    return { ok: true, updated: true, _geminiQuota: nextQuota };
  } catch (err) {
    return { ok: false, reason: err?.message || 'sync_error' };
  }
}

async function readStdin(timeoutMs = 350) {
  return await new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
    if (process.stdin.isTTY) {
      clearTimeout(timer);
      resolve('');
    }
  });
}

async function main() {
  if (process.argv.includes('--sync-quota')) {
    const port = findRuntimePort();
    const result = await syncQuotaToThemePatch(port);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  let safetyTimer = setTimeout(() => {
    process.stdout.write('{}');
    process.exit(0);
  }, 1300);
  safetyTimer.unref();

  const raw = await readStdin(300);
  let payload = {};
  if (raw && raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  const evtName = String(payload?.hookEventName || '');
  const shouldSyncQuota = evtName === 'Stop' || evtName === 'SessionStart';
  if (!shouldSyncQuota) {
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      process.stdout.write('{}');
      process.exit(0);
    }, 500);
    safetyTimer.unref();
  }

  const port = findRuntimePort();
  if (port > 0) {
    try {
      const controller = new AbortController();
      const reqTimer = setTimeout(() => controller.abort(), 500);
      await fetch(`http://127.0.0.1:${port}/api/hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(reqTimer);
    } catch {
      // Never fail or block Antigravity hook execution
    }

    if (shouldSyncQuota) {
      await syncQuotaToThemePatch(port);
    }
  }

  clearTimeout(safetyTimer);
  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
