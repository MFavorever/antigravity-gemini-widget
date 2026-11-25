/**
 * Incremental transcript.jsonl telemetry scanner for antigravity-gemini-widget.
 * Zero external dependencies. Computes today's usage, rolling 5h & 7d windows
 * split by model family, equivalent API costs, cache savings, and latest turn stats.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyModelFamily } from './quota.mjs';

const DEFAULT_PRICING = [
  { match: /gemini.*flash[-_ ]?lite/i, input: 0.075, cache: 0.01875, output: 0.30 },
  { match: /gemini.*flash/i, input: 0.15, cache: 0.0375, output: 0.60 },
  { match: /gemini.*(?:pro|neon|ultra)/i, input: 1.25, cache: 0.3125, output: 10.00 },
  { match: /gemini/i, input: 1.00, cache: 0.25, output: 4.00 },
  { match: /claude.*opus/i, input: 15.00, cache: 1.50, output: 75.00 },
  { match: /claude.*haiku/i, input: 0.80, cache: 0.08, output: 4.00 },
  { match: /claude/i, input: 3.00, cache: 0.30, output: 15.00 },
  { match: /(?:gpt-4o-mini|o4-mini|o3-mini|mini)/i, input: 0.15, cache: 0.075, output: 0.60 },
  { match: /(?:gpt|chatgpt|openai|o1|o3)/i, input: 2.50, cache: 1.25, output: 10.00 },
];

const FALLBACK_PRICE = { input: 1.00, cache: 0.25, output: 4.00 };

export function getModelPricing(modelName, overrides = {}) {
  const name = String(modelName || '').trim();
  if (name && overrides && typeof overrides[name] === 'object') {
    const o = overrides[name];
    return {
      input: Number(o.input) >= 0 ? Number(o.input) : FALLBACK_PRICE.input,
      cache: Number(o.cache) >= 0 ? Number(o.cache) : FALLBACK_PRICE.cache,
      output: Number(o.output) >= 0 ? Number(o.output) : FALLBACK_PRICE.output,
    };
  }
  for (const rule of DEFAULT_PRICING) {
    if (rule.match.test(name)) {
      return { input: rule.input, cache: rule.cache, output: rule.output };
    }
  }
  return FALLBACK_PRICE;
}

export function computeStepCost(inputTokens, cacheReadTokens, outputTokens, modelName, overrides = {}) {
  const price = getModelPricing(modelName, overrides);
  const inCost = (inputTokens / 1_000_000) * price.input;
  const cacheCost = (cacheReadTokens / 1_000_000) * price.cache;
  const outCost = (outputTokens / 1_000_000) * price.output;
  const uncachedCost = (cacheReadTokens / 1_000_000) * price.input;
  const costUsd = inCost + cacheCost + outCost;
  const savedUsd = Math.max(0, uncachedCost - cacheCost);
  return { costUsd, savedUsd };
}

export function toLocalDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyBucket() {
  return {
    input_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    saved_usd: 0,
    steps: 0,
  };
}

function addToBucket(bucket, ev) {
  bucket.input_tokens += ev.input;
  bucket.cache_read_tokens += ev.cache;
  bucket.output_tokens += ev.output;
  bucket.total_tokens += ev.total;
  bucket.cost_usd += ev.costUsd;
  bucket.saved_usd += ev.savedUsd;
  bucket.steps += 1;
}

export class TelemetryScanner {
  constructor(appDataDir) {
    this.appDataDir = appDataDir;
    this.fileCache = new Map();
  }

  _scanSingleFile(convId, transcriptPath, pricingOverrides) {
    let st;
    try {
      st = statSync(transcriptPath);
    } catch {
      this.fileCache.delete(transcriptPath);
      return null;
    }

    const inode = Number(st.ino);
    const size = Number(st.size);
    let state = this.fileCache.get(transcriptPath);
    if (!state || state.inode !== inode || state.offset < 0 || state.offset > size) {
      state = {
        convId,
        path: transcriptPath,
        inode,
        offset: 0,
        events: [],
        turns: [],
        activeTurn: null,
        latestContextTokens: 0,
        latestModel: '',
        lastStepAt: 0,
        isSubagent: false,
        firstStepSeen: false,
      };
    }

    if (size > state.offset) {
      const toRead = size - state.offset;
      const buf = Buffer.allocUnsafe(toRead);
      const fd = openSync(transcriptPath, 'r');
      let bytesRead = 0;
      try {
        while (bytesRead < toRead) {
          const n = readSync(fd, buf, bytesRead, toRead - bytesRead, state.offset + bytesRead);
          if (n <= 0) break;
          bytesRead += n;
        }
      } finally {
        closeSync(fd);
      }

      const chunk = buf.subarray(0, bytesRead);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        const complete = lastNl + 1;
        state.offset += complete;
        const lines = chunk.subarray(0, complete).toString('utf-8').split('\n');
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          if (
            state.firstStepSeen &&
            !line.includes('"PLANNER_RESPONSE"') &&
            !line.includes('"USER_INPUT"') &&
            !line.includes('"CHECKPOINT"')
          ) {
            continue;
          }
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (!obj || typeof obj !== 'object') continue;
          if (!state.firstStepSeen) {
            state.firstStepSeen = true;
            if (typeof obj.step_index === 'number' && obj.step_index > 0) {
              state.isSubagent = true;
            }
          }

          const ts = obj.created_at ? Date.parse(obj.created_at) : 0;
          const validTs = Number.isFinite(ts) && ts > 0 ? ts : st.mtimeMs;
          if (validTs > state.lastStepAt) state.lastStepAt = validTs;

          if (obj.type === 'USER_INPUT') {
            if (state.activeTurn && state.activeTurn.steps > 0) {
              state.turns.push(state.activeTurn);
              if (state.turns.length > 50) state.turns = state.turns.slice(-30);
            }
            state.activeTurn = {
              turnId: `${convId}:${obj.step_index ?? state.turns.length}:${validTs}`,
              convId,
              startedAt: validTs,
              endedAt: validTs,
              model: state.latestModel || '',
              input: 0,
              cache: 0,
              output: 0,
              total: 0,
              costUsd: 0,
              savedUsd: 0,
              steps: 0,
              contextTokens: state.latestContextTokens,
            };
          } else if (obj.type === 'CHECKPOINT') {
            state.latestContextTokens = 0;
          } else if (obj.type === 'PLANNER_RESPONSE') {
            const input = typeof obj.input_tokens === 'number' ? Math.max(0, obj.input_tokens) : 0;
            const cache = typeof obj.cache_read_tokens === 'number' ? Math.max(0, obj.cache_read_tokens) : 0;
            const output = typeof obj.output_tokens === 'number' ? Math.max(0, obj.output_tokens) : 0;
            const total = input + cache + output;
            const model = typeof obj.model === 'string' && obj.model ? obj.model : state.latestModel || 'unknown';
            const family = classifyModelFamily(model);
            const { costUsd, savedUsd } = computeStepCost(input, cache, output, model, pricingOverrides);

            if (model !== 'unknown') state.latestModel = model;
            if (input + cache > 0) state.latestContextTokens = input + cache;

            const ev = {
              ts: validTs,
              dayKey: toLocalDayKey(validTs),
              model,
              family,
              input,
              cache,
              output,
              total,
              costUsd,
              savedUsd,
            };
            state.events.push(ev);

            if (!state.activeTurn) {
              state.activeTurn = {
                turnId: `${convId}:auto:${validTs}`,
                convId,
                startedAt: validTs,
                endedAt: validTs,
                model,
                input: 0,
                cache: 0,
                output: 0,
                total: 0,
                costUsd: 0,
                savedUsd: 0,
                steps: 0,
                contextTokens: input + cache,
              };
            }
            state.activeTurn.endedAt = validTs;
            state.activeTurn.model = model;
            state.activeTurn.input += input;
            state.activeTurn.cache += cache;
            state.activeTurn.output += output;
            state.activeTurn.total += total;
            state.activeTurn.costUsd += costUsd;
            state.activeTurn.savedUsd += savedUsd;
            state.activeTurn.steps += 1;
            state.activeTurn.contextTokens = input + cache;
          }
        }
      }
    }

    this.fileCache.set(transcriptPath, state);
    return state;
  }

  scanAll({ nowMs = Date.now(), lookbackDays = 30, pricingOverrides = {}, usdToCny = 7.25, activeConvId = '' } = {}) {
    const brainDir = join(this.appDataDir, 'brain');
    const cutoffMs = nowMs - lookbackDays * 86_400_000;
    const fiveHoursAgo = nowMs - 5 * 3_600_000;
    const sevenDaysAgo = nowMs - 7 * 86_400_000;
    const todayKey = toLocalDayKey(nowMs);

    const today = {
      ...emptyBucket(),
      byModel: {},
      turns: 0,
      cache_hit_pct: 0,
      cost_cny: 0,
      saved_cny: 0,
    };

    const fiveHour = {
      gemini: emptyBucket(),
      claude_chatgpt: emptyBucket(),
      other: emptyBucket(),
      all: emptyBucket(),
    };

    const weekly = {
      gemini: emptyBucket(),
      claude_chatgpt: emptyBucket(),
      other: emptyBucket(),
      all: emptyBucket(),
    };

    const dailyMap = {};
    let latestTurn = null;
    let activeSession = null;
    let latestSession = null;

    if (existsSync(brainDir)) {
      let dirs = [];
      try {
        dirs = readdirSync(brainDir, { withFileTypes: true });
      } catch {
        dirs = [];
      }

      for (const ent of dirs) {
        if (!ent.isDirectory()) continue;
        const convId = ent.name;
        const tPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(tPath)) continue;

        let st;
        try {
          st = statSync(tPath);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoffMs && !this.fileCache.has(tPath)) {
          continue;
        }

        const state = this._scanSingleFile(convId, tPath, pricingOverrides);
        if (!state) continue;

        for (const ev of state.events) {
          // Daily ledger accumulation
          if (!dailyMap[ev.dayKey]) {
            dailyMap[ev.dayKey] = {
              date: ev.dayKey,
              input_tokens: 0,
              cache_read_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              cost_usd: 0,
              saved_usd: 0,
              steps: 0,
            };
          }
          addToBucket(dailyMap[ev.dayKey], ev);

          // Today accumulation
          if (ev.dayKey === todayKey) {
            addToBucket(today, ev);
            if (!today.byModel[ev.model]) today.byModel[ev.model] = emptyBucket();
            addToBucket(today.byModel[ev.model], ev);
          }

          // 5-hour rolling window
          if (ev.ts >= fiveHoursAgo && ev.ts <= nowMs + 60_000) {
            addToBucket(fiveHour[ev.family], ev);
            addToBucket(fiveHour.all, ev);
          }

          // 7-day rolling window
          if (ev.ts >= sevenDaysAgo && ev.ts <= nowMs + 60_000) {
            addToBucket(weekly[ev.family], ev);
            addToBucket(weekly.all, ev);
          }
        }

        // Count today's turns
        const allTurns = state.activeTurn && state.activeTurn.steps > 0
          ? [...state.turns, state.activeTurn]
          : state.turns;

        for (const t of allTurns) {
          if (toLocalDayKey(t.endedAt) === todayKey) {
            today.turns += 1;
          }
          if (!latestTurn || t.endedAt > latestTurn.endedAt) {
            latestTurn = t;
          }
        }

        const sessionSummary = {
          convId,
          latestModel: state.latestModel,
          contextTokens: state.latestContextTokens,
          lastStepAt: state.lastStepAt,
        };
        if (activeConvId && convId === activeConvId) {
          activeSession = sessionSummary;
        }
        if (!latestSession || state.lastStepAt > latestSession.lastStepAt) {
          latestSession = sessionSummary;
        }
      }
    }

    const totalPromptTok = today.input_tokens + today.cache_read_tokens;
    today.cache_hit_pct = totalPromptTok > 0 ? Math.round((today.cache_read_tokens / totalPromptTok) * 1000) / 10 : 0;
    today.cost_usd = Math.round(today.cost_usd * 10000) / 10000;
    today.saved_usd = Math.round(today.saved_usd * 10000) / 10000;
    today.cost_cny = Math.round(today.cost_usd * usdToCny * 10000) / 10000;
    today.saved_cny = Math.round(today.saved_usd * usdToCny * 10000) / 10000;

    // Round daily entries
    for (const d of Object.values(dailyMap)) {
      d.cost_usd = Math.round(d.cost_usd * 10000) / 10000;
      d.saved_usd = Math.round(d.saved_usd * 10000) / 10000;
      d.cost_cny = Math.round(d.cost_usd * usdToCny * 10000) / 10000;
    }

    let formattedLatestTurn = null;
    if (latestTurn) {
      const promptSum = latestTurn.input + latestTurn.cache;
      formattedLatestTurn = {
        turnId: latestTurn.turnId,
        convId: latestTurn.convId,
        model: latestTurn.model,
        input_tokens: latestTurn.input,
        cache_read_tokens: latestTurn.cache,
        output_tokens: latestTurn.output,
        total_tokens: latestTurn.total,
        cache_hit_pct: promptSum > 0 ? Math.round((latestTurn.cache / promptSum) * 1000) / 10 : 0,
        cost_usd: Math.round(latestTurn.costUsd * 10000) / 10000,
        cost_cny: Math.round(latestTurn.costUsd * usdToCny * 10000) / 10000,
        saved_cny: Math.round(latestTurn.savedUsd * usdToCny * 10000) / 10000,
        context_tokens: latestTurn.contextTokens,
        endedAt: new Date(latestTurn.endedAt).toISOString(),
      };
    }

    return {
      todayKey,
      today,
      windows: { fiveHour, weekly },
      latestTurn: formattedLatestTurn,
      activeSession: activeSession || latestSession,
      dailyMap,
    };
  }
}
