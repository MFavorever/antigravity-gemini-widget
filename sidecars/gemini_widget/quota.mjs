/**
 * Local Antigravity Language Server quota fetcher + graceful local fallback.
 * Queries GetUserStatus over loopback Connect HTTP/HTTPS when available.
 */

const CACHE_TTL_MS = 60_000;

export function classifyModelFamily(modelName) {
  const s = String(modelName || '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('gemini')) return 'gemini';
  if (s.includes('claude') || s.includes('gpt') || s.includes('openai') || s.includes('chatgpt') || /\bo[134](?:-|$)/.test(s)) {
    return 'claude_chatgpt';
  }
  return 'other';
}

export function formatResetCountdown(isoTime, nowMs = Date.now()) {
  if (!isoTime) return '';
  const ts = Date.parse(isoTime);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((ts - nowMs) / 1000));
  if (diffSec === 0) return '即将刷新';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时后`;
  if (hours > 0) return `${hours}小时${mins}分后`;
  return `${Math.max(1, mins)}分钟后`;
}

function collectModelConfigs(root) {
  const found = [];
  const seen = new Set();

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node.quotaInfo && typeof node.quotaInfo === 'object') {
      const label = node.label || node.modelOrAlias?.model || node.modelId || node.model || 'Unknown Model';
      const id = node.modelOrAlias?.model || node.modelId || node.model || label;
      const key = `${id}::${label}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({
          id: String(id),
          label: String(label),
          family: classifyModelFamily(`${id} ${label}`),
          quotaInfo: node.quotaInfo,
        });
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  }

  walk(root);
  return found;
}

function toFraction(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  if (val > 1 && val <= 100) return Math.max(0, Math.min(1, val / 100));
  return Math.max(0, Math.min(1, val));
}

export function parseUserStatusQuota(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;

  const configs = collectModelConfigs(payload);
  const userStatus = payload.userStatus || payload;
  const planName =
    userStatus?.planStatus?.planInfo?.planName ||
    userStatus?.planStatus?.planInfo?.teamsTier ||
    userStatus?.userTier?.name ||
    '';

  const poolAgg = {
    gemini: {
      label: 'Gemini 模型',
      models: [],
      fiveHourMinFrac: null,
      fiveHourResetTime: '',
      weeklyMinFrac: null,
      weeklyResetTime: '',
    },
    claude_chatgpt: {
      label: 'ChatGPT / Claude',
      models: [],
      fiveHourMinFrac: null,
      fiveHourResetTime: '',
      weeklyMinFrac: null,
      weeklyResetTime: '',
    },
  };

  for (const cfg of configs) {
    const q = cfg.quotaInfo || {};
    const frac5h = toFraction(
      q.remainingFraction ?? q.remaining_fraction ?? q.fiveHourRemainingFraction ?? q.sessionRemainingFraction,
    );
    const reset5h = q.resetTime || q.reset_time || q.fiveHourResetTime || '';
    const fracWeekly = toFraction(
      q.weeklyRemainingFraction ?? q.weekly_remaining_fraction ?? q.weeklyQuotaInfo?.remainingFraction,
    );
    const resetWeekly = q.weeklyResetTime || q.weekly_reset_time || q.weeklyQuotaInfo?.resetTime || '';

    const bucketKey = cfg.family === 'claude_chatgpt' ? 'claude_chatgpt' : cfg.family === 'gemini' ? 'gemini' : null;
    if (!bucketKey) continue;

    const bucket = poolAgg[bucketKey];
    bucket.models.push({
      id: cfg.id,
      label: cfg.label,
      remainingPct: frac5h !== null ? Math.round(frac5h * 100) : null,
      resetTime: reset5h,
      resetIn: formatResetCountdown(reset5h, nowMs),
      weeklyRemainingPct: fracWeekly !== null ? Math.round(fracWeekly * 100) : null,
      weeklyResetIn: formatResetCountdown(resetWeekly, nowMs),
    });

    if (frac5h !== null) {
      if (bucket.fiveHourMinFrac === null || frac5h < bucket.fiveHourMinFrac) {
        bucket.fiveHourMinFrac = frac5h;
        bucket.fiveHourResetTime = reset5h || bucket.fiveHourResetTime;
      }
    }
    if (fracWeekly !== null) {
      if (bucket.weeklyMinFrac === null || fracWeekly < bucket.weeklyMinFrac) {
        bucket.weeklyMinFrac = fracWeekly;
        bucket.weeklyResetTime = resetWeekly || bucket.weeklyResetTime;
      }
    }
  }

  // Also check top-level userStatus promptCredits / flowCredits if present
  const availablePromptCredits = userStatus?.planStatus?.availablePromptCredits;
  const monthlyPromptCredits = userStatus?.planStatus?.planInfo?.monthlyPromptCredits;

  return {
    source: 'live',
    planName: String(planName || ''),
    fetchedAt: new Date(nowMs).toISOString(),
    credits:
      typeof availablePromptCredits === 'number' && typeof monthlyPromptCredits === 'number' && monthlyPromptCredits > 0
        ? {
            available: availablePromptCredits,
            total: monthlyPromptCredits,
            remainingPct: Math.max(0, Math.min(100, Math.round((availablePromptCredits / monthlyPromptCredits) * 100))),
          }
        : null,
    pools: {
      gemini: {
        label: poolAgg.gemini.label,
        fiveHourRemainingPct: poolAgg.gemini.fiveHourMinFrac !== null ? Math.round(poolAgg.gemini.fiveHourMinFrac * 100) : null,
        fiveHourResetTime: poolAgg.gemini.fiveHourResetTime,
        fiveHourResetIn: formatResetCountdown(poolAgg.gemini.fiveHourResetTime, nowMs),
        weeklyRemainingPct: poolAgg.gemini.weeklyMinFrac !== null ? Math.round(poolAgg.gemini.weeklyMinFrac * 100) : null,
        weeklyResetTime: poolAgg.gemini.weeklyResetTime,
        weeklyResetIn: formatResetCountdown(poolAgg.gemini.weeklyResetTime, nowMs),
        models: poolAgg.gemini.models,
      },
      claude_chatgpt: {
        label: poolAgg.claude_chatgpt.label,
        fiveHourRemainingPct:
          poolAgg.claude_chatgpt.fiveHourMinFrac !== null ? Math.round(poolAgg.claude_chatgpt.fiveHourMinFrac * 100) : null,
        fiveHourResetTime: poolAgg.claude_chatgpt.fiveHourResetTime,
        fiveHourResetIn: formatResetCountdown(poolAgg.claude_chatgpt.fiveHourResetTime, nowMs),
        weeklyRemainingPct:
          poolAgg.claude_chatgpt.weeklyMinFrac !== null ? Math.round(poolAgg.claude_chatgpt.weeklyMinFrac * 100) : null,
        weeklyResetTime: poolAgg.claude_chatgpt.weeklyResetTime,
        weeklyResetIn: formatResetCountdown(poolAgg.claude_chatgpt.weeklyResetTime, nowMs),
        models: poolAgg.claude_chatgpt.models,
      },
    },
  };
}

export function parseQuotaSummaryResponse(payload, nowMs = Date.now()) {
  const root = payload?.response || payload;
  const groups = Array.isArray(root?.groups) ? root.groups : [];
  if (groups.length === 0) return null;

  const pools = {
    gemini: {
      label: 'Gemini 模型',
      fiveHourRemainingPct: null,
      fiveHourResetTime: '',
      fiveHourResetIn: '',
      weeklyRemainingPct: null,
      weeklyResetTime: '',
      weeklyResetIn: '',
      models: [],
    },
    claude_chatgpt: {
      label: 'ChatGPT / Claude',
      fiveHourRemainingPct: null,
      fiveHourResetTime: '',
      fiveHourResetIn: '',
      weeklyRemainingPct: null,
      weeklyResetTime: '',
      weeklyResetIn: '',
      models: [],
    },
  };

  let matched = false;
  for (const grp of groups) {
    const gLabel = `${grp?.displayName || ''} ${grp?.description || ''}`;
    const buckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
    const bucketText = buckets.map((b) => `${b?.bucketId || ''} ${b?.displayName || ''}`).join(' ');
    const combined = `${gLabel} ${bucketText}`.toLowerCase();

    let key = null;
    if (combined.includes('gemini')) {
      key = 'gemini';
    } else if (combined.includes('claude') || combined.includes('gpt') || combined.includes('3p')) {
      key = 'claude_chatgpt';
    }
    if (!key) continue;

    matched = true;
    const pool = pools[key];
    for (const b of buckets) {
      const frac = toFraction(b?.remainingFraction ?? b?.remaining_fraction);
      if (frac === null) continue;
      const pct = Math.round(frac * 100);
      const resetTime = b?.resetTime || b?.reset_time || '';
      const resetIn = formatResetCountdown(resetTime, nowMs);
      const win = String(b?.window || '').toLowerCase();
      const bid = String(b?.bucketId || '').toLowerCase();

      if (win === '5h' || bid.includes('5h')) {
        pool.fiveHourRemainingPct = pct;
        pool.fiveHourResetTime = resetTime;
        pool.fiveHourResetIn = resetIn;
      } else if (win === 'weekly' || bid.includes('week')) {
        pool.weeklyRemainingPct = pct;
        pool.weeklyResetTime = resetTime;
        pool.weeklyResetIn = resetIn;
      }
    }
  }

  if (!matched) return null;
  return {
    source: 'live',
    planName: '',
    fetchedAt: new Date(nowMs).toISOString(),
    credits: null,
    pools,
  };
}

function mergeLiveQuotas(summaryQuota, statusQuota) {
  if (!summaryQuota && !statusQuota) return null;
  if (!summaryQuota) return statusQuota;
  if (!statusQuota) return summaryQuota;

  const mergePool = (key) => {
    const s = summaryQuota.pools?.[key] || {};
    const u = statusQuota.pools?.[key] || {};
    return {
      label: s.label || u.label,
      fiveHourRemainingPct: typeof s.fiveHourRemainingPct === 'number' ? s.fiveHourRemainingPct : u.fiveHourRemainingPct,
      fiveHourResetTime: s.fiveHourResetTime || u.fiveHourResetTime || '',
      fiveHourResetIn: s.fiveHourResetIn || u.fiveHourResetIn || '',
      weeklyRemainingPct: typeof s.weeklyRemainingPct === 'number' ? s.weeklyRemainingPct : u.weeklyRemainingPct,
      weeklyResetTime: s.weeklyResetTime || u.weeklyResetTime || '',
      weeklyResetIn: s.weeklyResetIn || u.weeklyResetIn || '',
      models: Array.isArray(u.models) && u.models.length > 0 ? u.models : s.models || [],
    };
  };

  return {
    source: 'live',
    planName: statusQuota.planName || summaryQuota.planName || '',
    fetchedAt: summaryQuota.fetchedAt || statusQuota.fetchedAt,
    credits: statusQuota.credits || summaryQuota.credits || null,
    pools: {
      gemini: mergePool('gemini'),
      claude_chatgpt: mergePool('claude_chatgpt'),
    },
  };
}

export function buildQuotaView({ liveQuota, telemetryWindows, fallbackCaps, nowMs = Date.now() }) {
  const caps = {
    gemini5hTokens: fallbackCaps?.gemini5hTokens || 20_000_000,
    geminiWeeklyTokens: fallbackCaps?.geminiWeeklyTokens || 100_000_000,
    claudeGpt5hTokens: fallbackCaps?.claudeGpt5hTokens || 10_000_000,
    claudeGptWeeklyTokens: fallbackCaps?.claudeGptWeeklyTokens || 50_000_000,
  };

  const w5 = telemetryWindows?.fiveHour || {};
  const w7 = telemetryWindows?.weekly || {};

  const buildPool = (key, label, used5hTok, cap5hTok, used7dTok, cap7dTok) => {
    const live = liveQuota?.pools?.[key];
    const est5hPct = Math.max(0, Math.min(100, Math.round((1 - used5hTok / Math.max(1, cap5hTok)) * 100)));
    const est7dPct = Math.max(0, Math.min(100, Math.round((1 - used7dTok / Math.max(1, cap7dTok)) * 100)));

    const hasLive5h = typeof live?.fiveHourRemainingPct === 'number';
    const hasLive7d = typeof live?.weeklyRemainingPct === 'number';

    return {
      key,
      label,
      fiveHour: {
        remainingPct: hasLive5h ? live.fiveHourRemainingPct : est5hPct,
        source: hasLive5h ? 'live' : 'estimate',
        usedTokens: used5hTok,
        capTokens: cap5hTok,
        resetIn: hasLive5h ? (live.fiveHourResetIn || '滚动 5h 窗口') : '近 5 小时窗口',
        resetTime: live?.fiveHourResetTime || '',
      },
      weekly: {
        remainingPct: hasLive7d ? live.weeklyRemainingPct : est7dPct,
        source: hasLive7d ? 'live' : 'estimate',
        usedTokens: used7dTok,
        capTokens: cap7dTok,
        resetIn: hasLive7d ? (live.weeklyResetIn || '周额度池') : '近 7 天参考池',
        resetTime: live?.weeklyResetTime || '',
      },
      models: live?.models || [],
    };
  };

  return {
    source: liveQuota ? 'live' : 'local_estimate',
    planName: liveQuota?.planName || '',
    fetchedAt: liveQuota?.fetchedAt || new Date(nowMs).toISOString(),
    credits: liveQuota?.credits || null,
    gemini: buildPool(
      'gemini',
      'Gemini 模型',
      w5.gemini?.total_tokens || 0,
      caps.gemini5hTokens,
      w7.gemini?.total_tokens || 0,
      caps.geminiWeeklyTokens,
    ),
    claude_chatgpt: buildPool(
      'claude_chatgpt',
      'ChatGPT / Claude',
      w5.claude_chatgpt?.total_tokens || 0,
      caps.claudeGpt5hTokens,
      w7.claude_chatgpt?.total_tokens || 0,
      caps.claudeGptWeeklyTokens,
    ),
  };
}

export class QuotaClient {
  constructor() {
    this._cache = null;
    this._cacheAt = 0;
  }

  async getLiveQuota({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._cache && now - this._cacheAt < CACHE_TTL_MS) {
      return this._cache;
    }

    const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    if (!lsAddr || !csrf) {
      return this._cache;
    }

    const statusBody = JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'zh-CN',
      },
    });

    const postRpc = async (scheme, method, payloadStr) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(`${scheme}://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': csrf,
          },
          body: payloadStr,
          signal: controller.signal,
        });
        if (!res.ok) return null;
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };

    for (const scheme of ['http', 'https']) {
      try {
        const [summaryJson, statusJson] = await Promise.all([
          postRpc(scheme, 'RetrieveUserQuotaSummary', '{}').catch(() => null),
          postRpc(scheme, 'GetUserStatus', statusBody).catch(() => null),
        ]);
        const nowTs = Date.now();
        const summaryQuota = summaryJson ? parseQuotaSummaryResponse(summaryJson, nowTs) : null;
        const statusQuota = statusJson ? parseUserStatusQuota(statusJson, nowTs) : null;
        const merged = mergeLiveQuotas(summaryQuota, statusQuota);
        if (merged) {
          this._cache = merged;
          this._cacheAt = Date.now();
          return merged;
        }
      } catch {
        // try next scheme or keep stale cache
      }
    }

    return this._cache;
  }
}
