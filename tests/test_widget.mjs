import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigStore } from '../sidecars/gemini_widget/config.mjs';
import {
  buildQuotaView,
  classifyModelFamily,
  parseQuotaSummaryResponse,
  parseUserStatusQuota,
} from '../sidecars/gemini_widget/quota.mjs';
import { TelemetryScanner, computeStepCost } from '../sidecars/gemini_widget/telemetry.mjs';
import { WidgetService, startBridge } from '../sidecars/gemini_widget/main.mjs';

test('ConfigStore: weighted shuffle-bag avoids repeats until exhausted and persists settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agw-cfg-'));
  try {
    const store = new ConfigStore(dir);
    store.updateSettings({
      scale: 1.35,
      currency: 'USD',
      dialogues: [
        { text: 'line-a', weight: 1 },
        { text: 'line-b', weight: 1 },
        { text: 'line-c', weight: 1 },
      ],
    });

    const round1 = [store.nextDialogue(), store.nextDialogue(), store.nextDialogue()];
    assert.deepEqual(new Set(round1), new Set(['line-a', 'line-b', 'line-c']));

    // Next draw from refilled bag should not repeat the last drawn item
    const nextItem = store.nextDialogue();
    assert.notEqual(nextItem, round1[2]);

    const reloaded = new ConfigStore(dir);
    assert.equal(reloaded.getSettings().scale, 1.35);
    assert.equal(reloaded.getSettings().currency, 'USD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TelemetryScanner: parses today, 5h, 7d windows split by Gemini vs Claude/ChatGPT and calculates cost', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'agw-app-'));
  try {
    const convDir = join(appDir, 'brain', '11111111-2222-3333-4444-555555555555', '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });

    const now = Date.now();
    const t1 = new Date(now - 30 * 60_000).toISOString(); // 30m ago (in 5h, 7d, today)
    const t2 = new Date(now - 2 * 3_600_000).toISOString(); // 2h ago (in 5h, 7d, today)
    const t3 = new Date(now - 2 * 86_400_000).toISOString(); // 2d ago (in 7d, not 5h, not today)

    const lines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: t3, content: 'old' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: t3,
        model: 'claude-3-7-sonnet',
        input_tokens: 10_000,
        cache_read_tokens: 20_000,
        output_tokens: 2_000,
      }),
      JSON.stringify({ step_index: 2, type: 'USER_INPUT', created_at: t2, content: 'turn 2' }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: t2,
        model: 'gemini-4-neon-high',
        input_tokens: 5_000,
        cache_read_tokens: 45_000,
        output_tokens: 1_500,
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: t1,
        model: 'gpt-4o',
        input_tokens: 4_000,
        cache_read_tokens: 6_000,
        output_tokens: 1_000,
      }),
    ];
    writeFileSync(join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const scanner = new TelemetryScanner(appDir);
    const res = scanner.scanAll({ nowMs: now, usdToCny: 7.25 });

    // Today (if t2 is same calendar day, or at least t1)
    assert.ok(res.today.total_tokens >= 11_000);
    assert.equal(res.windows.fiveHour.gemini.total_tokens, 51_500);
    assert.equal(res.windows.fiveHour.claude_chatgpt.total_tokens, 11_000);
    assert.equal(res.windows.weekly.claude_chatgpt.total_tokens, 43_000);
    assert.ok(res.latestTurn);
    assert.equal(res.latestTurn.model, 'gpt-4o');
    assert.equal(res.latestTurn.total_tokens, 62_500);

    const stepCost = computeStepCost(1_000_000, 0, 0, 'gemini-4-neon-high');
    assert.equal(stepCost.costUsd, 1.25);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test('Quota parser: classifies Gemini & ChatGPT/Claude pools and builds fallback cleanly', () => {
  assert.equal(classifyModelFamily('gemini-4-neon-high'), 'gemini');
  assert.equal(classifyModelFamily('claude-sonnet-4'), 'claude_chatgpt');
  assert.equal(classifyModelFamily('gpt-5-codex'), 'claude_chatgpt');

  const now = Date.parse('2026-11-25T08:00:00Z');
  const payload = {
    userStatus: {
      planStatus: {
        planInfo: { planName: 'Google AI Pro', monthlyPromptCredits: 1000 },
        availablePromptCredits: 850,
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Neon',
            modelOrAlias: { model: 'gemini-4-neon-high' },
            quotaInfo: {
              remainingFraction: 0.88,
              resetTime: '2026-11-25T10:30:00Z',
              weeklyRemainingFraction: 0.72,
              weeklyResetTime: '2026-11-29T00:00:00Z',
            },
          },
          {
            label: 'Claude 4 Sonnet',
            modelOrAlias: { model: 'claude-4-sonnet' },
            quotaInfo: {
              remainingFraction: 0.64,
              resetTime: '2026-11-25T09:15:00Z',
            },
          },
        ],
      },
    },
  };

  const parsed = parseUserStatusQuota(payload, now);
  assert.equal(parsed.planName, 'Google AI Pro');
  assert.equal(parsed.pools.gemini.fiveHourRemainingPct, 88);
  assert.equal(parsed.pools.gemini.weeklyRemainingPct, 72);
  assert.equal(parsed.pools.claude_chatgpt.fiveHourRemainingPct, 64);

  const view = buildQuotaView({
    liveQuota: parsed,
    telemetryWindows: {
      fiveHour: { gemini: { total_tokens: 200_000 }, claude_chatgpt: { total_tokens: 100_000 } },
      weekly: { gemini: { total_tokens: 500_000 }, claude_chatgpt: { total_tokens: 400_000 } },
    },
    fallbackCaps: {},
    nowMs: now,
  });

  assert.equal(view.source, 'live');
  assert.equal(view.gemini.fiveHour.remainingPct, 88);
  assert.equal(view.gemini.weekly.remainingPct, 72);
  assert.equal(view.claude_chatgpt.fiveHour.remainingPct, 64);
  assert.equal(view.claude_chatgpt.weekly.source, 'estimate');
  assert.equal(view.claude_chatgpt.weekly.remainingPct, 99);
});

test('Quota summary parser: parses RetrieveUserQuotaSummary 5h and weekly buckets accurately', () => {
  const now = Date.parse('2026-11-25T08:00:00Z');
  const summaryPayload = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.7238178,
              resetTime: '2026-12-01T04:50:30Z',
            },
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.6057928,
              resetTime: '2026-11-25T10:03:40Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remainingFraction: 1,
              resetTime: '2026-12-02T07:54:29Z',
            },
            {
              bucketId: '3p-5h',
              window: '5h',
              remainingFraction: 1,
              resetTime: '2026-11-25T12:54:29Z',
            },
          ],
        },
      ],
    },
  };

  const parsed = parseQuotaSummaryResponse(summaryPayload, now);
  assert.ok(parsed);
  assert.equal(parsed.pools.gemini.fiveHourRemainingPct, 61);
  assert.equal(parsed.pools.gemini.weeklyRemainingPct, 72);
  assert.equal(parsed.pools.claude_chatgpt.fiveHourRemainingPct, 100);
  assert.equal(parsed.pools.claude_chatgpt.weeklyRemainingPct, 100);

  const view = buildQuotaView({
    liveQuota: parsed,
    telemetryWindows: {},
    fallbackCaps: {},
    nowMs: now,
  });
  assert.equal(view.gemini.weekly.source, 'live');
  assert.equal(view.gemini.weekly.remainingPct, 72);
  assert.equal(view.gemini.fiveHour.remainingPct, 61);
});

test('Bridge HTTP + SSE: /api/summary, /api/ledger, /api/bubble/next, /api/settings, /api/hook', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agw-data-'));
  const appDir = mkdtempSync(join(tmpdir(), 'agw-app2-'));
  let server;
  try {
    const convDir = join(appDir, 'brain', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    writeFileSync(
      join(convDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: new Date().toISOString(),
        content: 'hello',
      }) +
        '\n' +
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: new Date().toISOString(),
          model: 'gemini-4-neon-high',
          input_tokens: 1000,
          cache_read_tokens: 9000,
          output_tokens: 500,
        }) +
        '\n',
      'utf-8',
    );

    const svc = new WidgetService({
      dataDir,
      appDataDir: appDir,
      enableLiveQuota: false,
      autoLaunchPet: false,
    });
    const started = await startBridge(svc, 0);
    server = started.server;
    const baseUrl = `http://127.0.0.1:${started.port}`;

    assert.equal(existsSync(join(dataDir, 'runtime.json')), true);

    const sumRes = await fetch(`${baseUrl}/api/summary`);
    assert.equal(sumRes.status, 200);
    const sumJson = await sumRes.json();
    assert.equal(sumJson.ok, true);
    assert.equal(sumJson.today.total_tokens, 10_500);
    assert.equal(sumJson.today.cache_hit_pct, 90);

    const ledRes = await fetch(`${baseUrl}/api/ledger?days=7`);
    const ledJson = await ledRes.json();
    assert.equal(ledJson.days.length, 1);

    const bubRes = await fetch(`${baseUrl}/api/bubble/next`);
    const bubJson = await bubRes.json();
    assert.ok(typeof bubJson.text === 'string' && bubJson.text.length > 0);

    const setRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'USD', scale: 1.5 }),
    });
    const setJson = await setRes.json();
    assert.equal(setJson.settings.currency, 'USD');
    assert.equal(setJson.settings.scale, 1.5);

    // Connect SSE and trigger Stop hook
    const sseAbort = new AbortController();
    const ssePromise = (async () => {
      const r = await fetch(`${baseUrl}/api/events`, { signal: sseAbort.signal });
      const reader = r.body.getReader();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        if (buf.includes('event: turn_complete')) {
          sseAbort.abort();
          return buf;
        }
      }
      return buf;
    })();

    await new Promise((r) => setTimeout(r, 80));
    const hookRes = await fetch(`${baseUrl}/api/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hookEventName: 'Stop',
        terminationReason: 'NO_TOOL_CALL',
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    });
    const hookJson = await hookRes.json();
    assert.equal(hookJson.ok, true);
    assert.equal(hookJson.petState, 'done');

    const sseText = await ssePromise.catch(() => '');
    assert.ok(sseText.includes('event: turn_complete'));
  } finally {
    if (server) {
      await new Promise((r) => server.close(r));
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(appDir, { recursive: true, force: true });
  }
});
