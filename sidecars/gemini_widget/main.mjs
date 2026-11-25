/**
 * Antigravity Gemini Widget — Sidecar & Loopback HTTP/SSE Server.
 * Zero third-party dependencies.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, resolveAppDataDir, resolvePluginDataDir } from './config.mjs';
import { buildQuotaView, QuotaClient } from './quota.mjs';
import { TelemetryScanner } from './telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const ASSETS_DIR = join(PLUGIN_ROOT, 'assets');
const PET_SCRIPT = join(PLUGIN_ROOT, 'pet', 'desktop_pet.py');

const DEFAULT_BRIDGE_PORT = Number.parseInt(process.env.GEMINI_WIDGET_PORT || '18923', 10) || 18923;

const STATIC_UI = {
  '/styles.css': [join(__dirname, 'styles.css'), 'text/css; charset=utf-8'],
  '/app.js': [join(__dirname, 'app.js'), 'application/javascript; charset=utf-8'],
  '/assets/gemini-pet.png': [join(ASSETS_DIR, 'gemini-pet.png'), 'image/png'],
  '/assets/logo.png': [join(ASSETS_DIR, 'logo.png'), 'image/png'],
};

export class WidgetService {
  constructor({
    dataDir = resolvePluginDataDir(),
    appDataDir = resolveAppDataDir(),
    enableLiveQuota = true,
    autoLaunchPet = false,
  } = {}) {
    this.config = new ConfigStore(dataDir);
    this.scanner = new TelemetryScanner(appDataDir);
    this.quotaClient = new QuotaClient();
    this.enableLiveQuota = enableLiveQuota;
    this.autoLaunchPet = autoLaunchPet;

    this.petState = 'idle'; // 'idle' | 'working' | 'done' | 'error'
    this.lastHookEvent = null;
    this.lastTurnBroadcastId = '';
    this.sseClients = new Set();
    this.petProcess = null;
    this._activeConvId = '';
    this._cachedSummary = null;
    this._summaryAt = 0;
  }

  async getSummary({ forceRefresh = false, convId = '' } = {}) {
    const now = Date.now();
    if (convId) this._activeConvId = convId;

    if (!forceRefresh && this._cachedSummary && now - this._summaryAt < 1500) {
      return this._cachedSummary;
    }

    const settings = this.config.getSettings();
    const scan = this.scanner.scanAll({
      nowMs: now,
      pricingOverrides: settings.pricingOverrides,
      usdToCny: settings.usdToCny,
      activeConvId: this._activeConvId,
    });

    this.config.saveLedger(scan.dailyMap);

    let liveQuota = null;
    if (this.enableLiveQuota) {
      liveQuota = await this.quotaClient.getLiveQuota({ force: forceRefresh });
    }

    const quota = buildQuotaView({
      liveQuota,
      telemetryWindows: scan.windows,
      fallbackCaps: settings.fallbackCaps,
      nowMs: now,
    });

    // Check if a new completed turn appeared even without hooks
    const latestTurnId = scan.latestTurn?.turnId || '';
    if (latestTurnId && this.lastTurnBroadcastId && latestTurnId !== this.lastTurnBroadcastId && this.petState === 'idle') {
      // Only passively update tracker; active broadcasts come from Stop hook or new step detection
    }
    if (!this.lastTurnBroadcastId && latestTurnId) {
      this.lastTurnBroadcastId = latestTurnId;
    }

    const summary = {
      ok: true,
      timestamp: new Date(now).toISOString(),
      petState: this.petState,
      lastHookEvent: this.lastHookEvent,
      todayKey: scan.todayKey,
      today: scan.today,
      quota,
      latestTurn: scan.latestTurn,
      activeSession: scan.activeSession,
      settings,
      petRunning: Boolean(this.petProcess && !this.petProcess.killed),
    };

    this._cachedSummary = summary;
    this._summaryAt = now;
    return summary;
  }

  getLedger(days = 14) {
    const ledger = this.config.loadLedger();
    const keys = Object.keys(ledger.days || {}).sort();
    const sliced = keys.slice(-Math.max(1, Math.min(90, Number(days) || 14)));
    return {
      days: sliced.map((k) => ledger.days[k]),
      updatedAt: ledger.updatedAt || '',
      currency: this.config.getSettings().currency,
      usdToCny: this.config.getSettings().usdToCny,
    };
  }

  nextBubble() {
    return {
      text: this.config.nextDialogue(),
      timestamp: new Date().toISOString(),
    };
  }

  async updateSettings(patch) {
    const updated = this.config.updateSettings(patch);
    this._cachedSummary = null;
    this.emitEvent('settings', { settings: updated });
    const summary = await this.getSummary({ forceRefresh: false });
    this.emitEvent('summary', summary);
    return { ok: true, settings: updated };
  }

  async handleHookEvent(payload) {
    const evt = payload && typeof payload === 'object' ? payload : {};
    const eventName = String(evt.hookEventName || '');
    const convId = String(evt.conversationId || '');
    if (convId) this._activeConvId = convId;

    this.lastHookEvent = {
      eventName,
      toolName: evt.toolCall?.name || '',
      error: evt.error || '',
      at: new Date().toISOString(),
    };

    if (eventName === 'PreToolUse' || eventName === 'PreInvocation' || eventName === 'SessionStart') {
      this.petState = 'working';
      this.emitEvent('status_change', { petState: this.petState, hook: this.lastHookEvent });
      return { ok: true, petState: this.petState };
    }

    if (eventName === 'PostToolUse') {
      this.petState = evt.error ? 'error' : 'working';
      this.emitEvent('status_change', { petState: this.petState, hook: this.lastHookEvent });
      return { ok: true, petState: this.petState };
    }

    if (eventName === 'Stop') {
      const isError = evt.terminationReason === 'ERROR' || Boolean(evt.error);
      this.petState = isError ? 'error' : 'done';
      this._cachedSummary = null;
      const summary = await this.getSummary({ forceRefresh: true, convId });
      const turn = summary.latestTurn;
      this.lastTurnBroadcastId = turn?.turnId || this.lastTurnBroadcastId;

      this.emitEvent('turn_complete', {
        isError,
        terminationReason: evt.terminationReason || 'NO_TOOL_CALL',
        error: evt.error || '',
        turn,
        today: summary.today,
        quota: summary.quota,
        settings: summary.settings,
      });

      setTimeout(() => {
        if (this.petState === 'done' || this.petState === 'error') {
          this.petState = 'idle';
          this.emitEvent('status_change', { petState: 'idle' });
        }
      }, 4500);

      return { ok: true, petState: this.petState, turn };
    }

    return { ok: true, petState: this.petState };
  }

  emitEvent(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(chunk);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  launchPet({ port }) {
    if (!existsSync(PET_SCRIPT)) {
      return { ok: false, error: 'desktop_pet.py not found' };
    }
    if (this.petProcess && !this.petProcess.killed) {
      return { ok: true, alreadyRunning: true, pid: this.petProcess.pid };
    }

    const candidates = process.platform === 'win32' ? ['pythonw', 'python'] : ['python3', 'python'];
    const exe = candidates[0];
    try {
      const child = spawn(exe, [PET_SCRIPT, '--port', String(port)], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          GEMINI_WIDGET_PORT: String(port),
        },
      });
      child.on('exit', () => {
        if (this.petProcess === child) this.petProcess = null;
      });
      child.on('error', () => {
        if (exe === 'pythonw') {
          try {
            const fallback = spawn('python', [PET_SCRIPT, '--port', String(port)], {
              detached: false,
              stdio: 'ignore',
              windowsHide: true,
            });
            this.petProcess = fallback;
          } catch {
            // ignore
          }
        }
      });
      this.petProcess = child;
      return { ok: true, pid: child.pid };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  stopPet() {
    this.emitEvent('shutdown', { reason: 'requested' });
    if (this.petProcess && !this.petProcess.killed) {
      try {
        this.petProcess.kill();
      } catch {
        // ignore
      }
      this.petProcess = null;
    }
    return { ok: true };
  }
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 512_000) break;
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

export function createBridgeServer(service, { port = DEFAULT_BRIDGE_PORT } = {}) {
  const server = createServer(async (req, res) => {
    const actualPort = server.address()?.port || port;
    const url = new URL(req.url || '/', `http://127.0.0.1:${actualPort}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      const stub = `window.sidecar = { conversationId: new URLSearchParams(location.search).get('conversationId') || '', fetch: (u, o) => fetch(u, o), ui: {}, agent: {} };`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(stub);
      return;
    }
    if (req.method === 'GET' && STATIC_UI[url.pathname]) {
      const [filePath, mime] = STATIC_UI[url.pathname];
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(filePath));
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, port: actualPort }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/summary') {
        const force = url.searchParams.get('refresh') === '1';
        const convId = url.searchParams.get('conversationId') || '';
        const data = await service.getSummary({ forceRefresh: force, convId });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/ledger') {
        const days = Number.parseInt(url.searchParams.get('days') || '14', 10);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(service.getLedger(days)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/bubble/next') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(service.nextBubble()));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        service.sseClients.add(res);
        req.on('close', () => service.sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const result = await service.updateSettings(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const data = await service.getSummary({ forceRefresh: true });
        service.emitEvent('summary', data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/hook') {
        const body = await readJsonBody(req);
        const result = await service.handleHookEvent(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pet/launch') {
        const result = service.launchPet({ port: actualPort });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pet/stop') {
        const result = service.stopPet();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return server;
}

export async function startBridge(service, preferredPort = DEFAULT_BRIDGE_PORT) {
  const server = createBridgeServer(service, { port: preferredPort });
  await new Promise((resolveListen, rejectListen) => {
    const onErr = (err) => {
      if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
        server.removeListener('error', onErr);
        server.listen(0, '127.0.0.1', resolveListen);
      } else {
        rejectListen(err);
      }
    };
    server.once('error', onErr);
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeListener('error', onErr);
      resolveListen();
    });
  });

  const port = server.address().port;
  service.config.writeRuntime({ port });
  return { server, port };
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const isStandalone = process.argv.includes('--standalone');
  const noPet = process.argv.includes('--no-pet');
  const portIdx = process.argv.indexOf('--port');
  const cliPort = portIdx !== -1 ? Number.parseInt(process.argv[portIdx + 1], 10) : DEFAULT_BRIDGE_PORT;
  const preferredPort = Number.isFinite(cliPort) ? cliPort : DEFAULT_BRIDGE_PORT;

  const service = new WidgetService({
    enableLiveQuota: true,
    autoLaunchPet: !noPet,
  });

  const { server, port } = await startBridge(service, preferredPort);

  const cleanup = () => {
    service.stopPet();
    service.config.clearRuntime();
    try {
      server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  if (isStandalone) {
    console.log(`[antigravity-gemini-widget] standalone listening on http://127.0.0.1:${port}`);
    if (!noPet && service.config.getSettings().autoLaunchPet) {
      service.launchPet({ port });
    }
  } else {
    const { SidecarApp, Response } = await import('sidecar_sdk');
    const app = new SidecarApp();

    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
    for (const [route, [filePath, mime]] of Object.entries(STATIC_UI)) {
      app.api(route, () => new Response(readFileSync(filePath), { contentType: mime }), 'GET');
    }
    app.api('/api/summary', (data) =>
      service.getSummary({
        forceRefresh: data?.refresh === '1',
        convId: data?.conversationId || app.config.conversationId || '',
      }), 'GET');
    app.api('/api/ledger', (data) => service.getLedger(data?.days || 14), 'GET');
    app.api('/api/bubble/next', () => service.nextBubble(), 'GET');
    app.api('/api/settings', (data) => service.updateSettings(data), 'POST');
    app.api('/api/refresh', () => service.getSummary({ forceRefresh: true, convId: app.config.conversationId || '' }), 'POST');
    app.api('/api/pet/launch', () => service.launchPet({ port }), 'POST');
    app.api('/api/pet/stop', () => service.stopPet(), 'POST');

    app.run();

    if (!noPet && service.config.getSettings().autoLaunchPet) {
      service.launchPet({ port });
    }
  }
}
