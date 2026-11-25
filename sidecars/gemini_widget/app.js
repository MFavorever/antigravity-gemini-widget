(() => {
  const params = new URLSearchParams(window.location.search);
  const convId = () => window.sidecar?.conversationId || params.get('conversationId') || '';
  const apiFetch = (url, opts) => (window.sidecar?.fetch ? window.sidecar.fetch(url, opts) : fetch(url, opts));

  const els = {
    tabs: [...document.querySelectorAll('.tab')],
    panels: {
      overview: document.getElementById('tab-overview'),
      ledger: document.getElementById('tab-ledger'),
      settings: document.getElementById('tab-settings'),
    },
    planSub: document.getElementById('plan-sub'),
    todayTokens: document.getElementById('today-tokens'),
    todayCost: document.getElementById('today-cost'),
    todayBreakdown: document.getElementById('today-breakdown'),
    quotaBadge: document.getElementById('quota-badge'),
    quotaList: document.getElementById('quota-list'),
    turnModel: document.getElementById('turn-model'),
    turnDetail: document.getElementById('turn-detail'),
    dialogueText: document.getElementById('dialogue-text'),
    bubbleCard: document.getElementById('bubble-card'),
    ledgerCurrency: document.getElementById('ledger-currency'),
    ledgerChart: document.getElementById('ledger-chart'),
    ledgerRows: document.getElementById('ledger-rows'),
    petBtn: document.getElementById('pet-btn'),
    stopPetBtn: document.getElementById('stop-pet-btn'),
    refreshBtn: document.getElementById('refresh-btn'),
    saveSettingsBtn: document.getElementById('save-settings-btn'),
    scaleInput: document.getElementById('set-scale'),
    scaleVal: document.getElementById('scale-val'),
    toast: document.getElementById('toast'),
  };

  let currentSettings = null;

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    setTimeout(() => els.toast.classList.add('hidden'), 2200);
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(v);
  }

  function fmtMoney(usd, cny, currency) {
    if (currency === 'USD') {
      const v = Number(usd) || 0;
      return v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
    }
    const v = Number(cny) || 0;
    return v < 0.1 ? `¥${v.toFixed(4)}` : `¥${v.toFixed(2)}`;
  }

  async function postJson(url, body) {
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  }

  async function getJson(url) {
    const res = await apiFetch(url, { method: 'GET' });
    return await res.json();
  }

  function barColor(pct, fallback) {
    if (pct <= 15) return '#ff6b8b';
    if (pct <= 35) return '#f5cc5a';
    return fallback;
  }

  function renderQuotaPool(pool, cls, fallbackColor) {
    if (!pool) return '';
    const renderRow = (label, item) => {
      const pct = Math.max(0, Math.min(100, Number(item?.remainingPct ?? 100)));
      const col = barColor(pct, fallbackColor);
      return `
        <div class="q-row">
          <span>${label}</span>
          <div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${col}"></div></div>
          <span class="q-pct">${pct}%</span>
          <span class="q-rst">${item?.resetIn || ''}</span>
        </div>`;
    };
    return `
      <div>
        <div class="pool-title ${cls}">${pool.label}</div>
        ${renderRow('5h', pool.fiveHour)}
        ${renderRow('周', pool.weekly)}
      </div>`;
  }

  function populateSettingsForm(s) {
    if (!s) return;
    currentSettings = s;
    document.getElementById('set-autoLaunchPet').checked = Boolean(s.autoLaunchPet);
    els.scaleInput.value = s.scale ?? 1.0;
    els.scaleVal.textContent = `${Number(s.scale ?? 1.0).toFixed(2).replace(/\.00$/, '.0')}x`;
    document.getElementById('set-dockMode').value = s.dockMode || 'antigravity';
    document.getElementById('set-currency').value = s.currency || 'CNY';
    document.getElementById('set-soundEnabled').checked = Boolean(s.soundEnabled);
    document.getElementById('set-autoBroadcast').checked = Boolean(s.autoBroadcast);
    document.getElementById('set-broadcastDurationSec').value = s.broadcastDurationSec || 5;
  }

  function renderSummary(data) {
    if (!data || !data.today) return;
    const t = data.today;
    const s = data.settings || {};
    const currency = s.currency || 'CNY';

    if (!currentSettings) populateSettingsForm(s);

    els.todayTokens.textContent = Number(t.total_tokens || 0).toLocaleString();
    els.todayCost.textContent = fmtMoney(t.cost_usd, t.cost_cny, currency);
    const saved = fmtMoney(t.saved_usd, t.saved_cny, currency);
    els.todayBreakdown.textContent =
      `输入 ${fmtTokens(t.input_tokens)} · 缓存 ${fmtTokens(t.cache_read_tokens)} · 输出 ${fmtTokens(t.output_tokens)} · 命中 ${t.cache_hit_pct}% (省 ${saved})`;

    const q = data.quota || {};
    els.planSub.textContent = q.planName ? `${q.planName} · ${data.todayKey}` : `本地监控 · ${data.todayKey}`;
    els.quotaBadge.textContent = q.source === 'live' ? '实时配额' : '本地窗口估算';
    els.quotaList.innerHTML =
      renderQuotaPool(q.gemini, 'gemini', '#7289ff') +
      renderQuotaPool(q.claude_chatgpt, 'claude', '#f083b5');

    const turn = data.latestTurn;
    if (turn) {
      els.turnModel.textContent = turn.model || 'Gemini';
      els.turnDetail.textContent = `总消耗 ${fmtTokens(turn.total_tokens)} tok · 缓存命中 ${turn.cache_hit_pct}% · 等效 ${fmtMoney(turn.cost_usd, turn.cost_cny, currency)}`;
    }
  }

  function renderLedger(data) {
    const days = data?.days || [];
    const currency = data?.currency || 'CNY';
    els.ledgerCurrency.textContent = currency;
    if (days.length === 0) {
      els.ledgerChart.innerHTML = '';
      els.ledgerRows.innerHTML = '<div class="sub-line">暂无历史账单记录</div>';
      return;
    }

    const maxTok = Math.max(1, ...days.map((d) => d.total_tokens || 0));
    const w = 280;
    const h = 48;
    const bw = Math.max(6, Math.floor(w / Math.max(1, days.length)) - 3);
    const bars = days
      .map((d, i) => {
        const bh = Math.max(3, Math.round(((d.total_tokens || 0) / maxTok) * (h - 6)));
        const x = i * (bw + 3);
        const y = h - bh;
        return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="#7289ff" />`;
      })
      .join('');
    els.ledgerChart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${bars}</svg>`;

    els.ledgerRows.innerHTML = days
      .slice()
      .reverse()
      .map((d) => {
        const cost = fmtMoney(d.cost_usd, d.cost_cny, currency);
        return `
          <div class="ledger-row">
            <span>${d.date}</span>
            <span>${fmtTokens(d.total_tokens)} tok</span>
            <span>${d.steps || 0} 步</span>
            <span class="pink" style="text-align:right">${cost}</span>
          </div>`;
      })
      .join('');
  }

  async function loadAll(force = false) {
    try {
      const q = new URLSearchParams();
      if (convId()) q.set('conversationId', convId());
      if (force) q.set('refresh', '1');
      const [summary, ledger] = await Promise.all([
        getJson(`/api/summary?${q.toString()}`),
        getJson('/api/ledger?days=14'),
      ]);
      renderSummary(summary);
      renderLedger(ledger);
    } catch {
      els.planSub.textContent = '连接本地服务失败';
    }
  }

  els.tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      els.tabs.forEach((b) => b.classList.remove('active'));
      Object.values(els.panels).forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      els.panels[btn.dataset.tab].classList.add('active');
    });
  });

  els.scaleInput.addEventListener('input', () => {
    els.scaleVal.textContent = `${Number(els.scaleInput.value).toFixed(2)}x`;
  });

  els.refreshBtn.addEventListener('click', () => {
    loadAll(true).then(() => showToast('已刷新最新数据'));
  });

  els.bubbleCard.addEventListener('click', async () => {
    try {
      const res = await getJson('/api/bubble/next');
      if (res?.text) els.dialogueText.textContent = `💬 ${res.text}`;
    } catch {}
  });

  els.petBtn.addEventListener('click', async () => {
    const res = await postJson('/api/pet/launch', {});
    showToast(res?.ok ? '底部星语猫姬已启动' : '启动失败，请检查 Python');
  });

  els.stopPetBtn.addEventListener('click', async () => {
    await postJson('/api/pet/stop', {});
    showToast('已隐藏底部猫姬');
  });

  els.saveSettingsBtn.addEventListener('click', async () => {
    const patch = {
      autoLaunchPet: document.getElementById('set-autoLaunchPet').checked,
      scale: Number.parseFloat(els.scaleInput.value) || 1.0,
      dockMode: document.getElementById('set-dockMode').value,
      currency: document.getElementById('set-currency').value,
      soundEnabled: document.getElementById('set-soundEnabled').checked,
      autoBroadcast: document.getElementById('set-autoBroadcast').checked,
      broadcastDurationSec: Number.parseInt(document.getElementById('set-broadcastDurationSec').value, 10) || 5,
    };
    const res = await postJson('/api/settings', patch);
    if (res?.ok) {
      populateSettingsForm(res.settings);
      await loadAll(false);
      showToast('设置已保存并同步到挂件');
    }
  });

  loadAll(false);
  setInterval(() => loadAll(false), 6000);
})();
