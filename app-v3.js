import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.95.0/+esm';
import {
  ITEM_KINDS,
  NATIVE_CURRENCIES,
  OWNER_SCOPES,
  calculateAllocation,
  calculateSummary,
  calculateTwdAmount,
  isValidSymbol,
  normalizeFinancialItem,
  parseNonNegative,
  toFiniteNumber,
} from './financial-core.js?v=gold-1';

// App / Supabase -------------------------------------------------------------

const SUPABASE_URL = 'https://gbxsnwqbjmgfikpblyot.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VtGM8w7CqxDB_3NaROR8OA_H0txX-_I';
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const root = document.querySelector('#root');
const tabs = [
  ['husband', '◒', '老公'],
  ['dashboard', '◉', '家庭'],
  ['wife', '◐', '老婆'],
];
const categories = {
  asset: ['現金及存款', '台股', '美股', '不動產', '黃金', '保險', '其他'],
  liability: ['房貸', '增貸', '信貸', '信用卡', '其他負債'],
};
const colors = {
  台股: '#72d7a7', 美股: '#8b94ff', 現金及存款: '#67c8db', 不動產: '#f0b467',
  保險: '#bb8cff', 黃金: '#e5ae4f', 其他: '#ee8f73', 房貸: '#ff7f91', 增貸: '#f0a76b', 信貸: '#df788a',
};

let lifecycle = 'booting';
let session = null;
let member = null;
let items = [];
let history = [];
let scopeHistory = [];
let householdName = '布布一二的家';
let tab = 'dashboard';
let masked = false;
let channel = null;
let realtimeReloadTimer = null;
let loadFlight = null;
let quoteFlight = null;
let quoteStatus = 'idle';
let quoteLastAt = 0;
let quoteLastUpdatedAt = null;
let quoteData = {};
let fxRate = null;
let openGroups = new Set();
let trendMode = 'value';
const pageKind = { husband: 'asset', wife: 'asset' };

// Formatting / calculations --------------------------------------------------

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const formatNumber = value => masked
  ? '••••••'
  : new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(Math.round(toFiniteNumber(value)));
const formatMoney = value => `<small>NT$</small> ${formatNumber(value)}`;
const taipeiDate = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const formatClock = value => {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
};
const summary = ownerScope => calculateSummary(items, ownerScope ?? null);

function chartAxisFormat(value) {
  if (masked) return '••••';
  if (trendMode === 'percent') return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function chartDate(value) {
  const [, month, day] = String(value).split('-');
  return `${Number(month)}/${Number(day)}`;
}

function trendChart(rows) {
  if (!rows.length) return '';
  const firstValue = toFiniteNumber(rows[0].total_twd);
  const lastValue = toFiniteNumber(rows.at(-1).total_twd);
  const delta = lastValue - firstValue;
  const percent = firstValue ? delta / firstValue * 100 : 0;
  const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const color = delta > 0 ? '#ff7f91' : delta < 0 ? '#72d7a7' : '#8c95a5';
  const series = rows.map(row => ({
    ...row,
    plotValue: trendMode === 'percent'
      ? (firstValue ? (toFiniteNumber(row.total_twd) - firstValue) / firstValue * 100 : 0)
      : toFiniteNumber(row.total_twd),
  }));
  const values = series.map(row => row.plotValue);
  const rawLow = Math.min(...values);
  const rawHigh = Math.max(...values);
  const padding = Math.max((rawHigh - rawLow) * 0.08, trendMode === 'percent' ? 0.2 : 100_000);
  const low = rawLow - padding;
  const high = rawHigh + padding;
  const x = index => 112 + index / Math.max(1, series.length - 1) * 552;
  const y = value => 22 + (high - value) / Math.max(1, high - low) * 164;
  const points = series.map((row, index) => `${index ? 'L' : 'M'}${x(index)},${y(row.plotValue)}`).join(' ');
  const axis = [0, 0.25, 0.5, 0.75, 1].map(step => {
    const value = high - (high - low) * step;
    const axisY = 22 + 164 * step;
    return `<line x1="106" y1="${axisY}" x2="664" y2="${axisY}" stroke="#293143" stroke-width="1"/><text x="4" y="${axisY + 6}" fill="#8d96a6" font-size="19">${chartAxisFormat(value)}</text>`;
  }).join('');
  const tickIndexes = [0, 0.25, 0.5, 0.75, 1]
    .map(step => Math.round((series.length - 1) * step))
    .filter((value, index, array) => array.indexOf(value) === index);
  const dateTicks = tickIndexes.map(index => {
    const tickX = x(index);
    return `<line x1="${tickX}" y1="22" x2="${tickX}" y2="190" stroke="#252c39" stroke-width="1" stroke-dasharray="5 7"/><text x="${tickX}" y="222" text-anchor="middle" fill="#8d96a6" font-size="18">${chartDate(series[index].recorded_on)}</text>`;
  }).join('');

  return `<section class="panel trend scopeTrend"><div class="trendHead"><div><h2>淨資產趨勢</h2></div><button class="trendToggle" data-trend-toggle>${trendMode === 'value' ? '↔ %' : 'NT$'}</button><div class="trendChange ${tone}"><b>${delta > 0 ? '+' : ''}${formatNumber(delta)}</b><span>${delta > 0 ? '+' : ''}${percent.toFixed(2)}%</span></div></div><svg viewBox="0 0 680 236" aria-label="淨資產趨勢">${axis}${dateTicks}<path d="${points}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg></section>`;
}

function familyTrendRows(currentNetWorth) {
  const byDate = new Map(history.map(row => [row.recorded_on, row.net_worth_twd]));
  byDate.set(taipeiDate(), currentNetWorth);
  const rows = [...byDate].map(([recorded_on, total_twd]) => ({ recorded_on, total_twd }))
    .sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
  return rows;
}

function personalTrendRows(ownerScope, currentNetWorth) {
  const grouped = new Map();
  scopeHistory
    .filter(row => row.owner_scope === ownerScope)
    .sort((a, b) => a.recorded_on.localeCompare(b.recorded_on))
    .forEach(row => {
      const day = grouped.get(row.recorded_on) ?? { recorded_on: row.recorded_on, asset: null, liability: null };
      day[row.kind] = row.total_twd;
      grouped.set(row.recorded_on, day);
    });

  let latestAsset = null;
  let latestLiability = null;
  const byDate = new Map(
    ownerScope === 'husband'
      ? history.map(row => [row.recorded_on, row.net_worth_twd])
      : [],
  );
  for (const row of grouped.values()) {
    if (row.asset !== null) latestAsset = row.asset;
    if (row.liability !== null) latestLiability = row.liability;
    if (latestAsset !== null && latestLiability !== null) {
      byDate.set(row.recorded_on, latestAsset - latestLiability);
    }
  }
  byDate.set(taipeiDate(), currentNetWorth);
  return [...byDate].map(([recorded_on, total_twd]) => ({ recorded_on, total_twd }))
    .sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
}

// Auth / startup -------------------------------------------------------------

function showBlockingError(message) {
  lifecycle = 'error';
  root.className = 'center';
  root.innerHTML = `<div class="logo big">KS</div><p>${escapeHtml(message)}</p><button class="primary" style="padding:0 18px" data-retry>重新載入</button>`;
  root.querySelector('[data-retry]').onclick = () => location.reload();
}

function authScreen() {
  lifecycle = 'auth';
  root.className = 'auth';
  root.innerHTML = `<section class="authCard"><div class="logo big">KS</div><h1>KS財富管理</h1><p>夫妻共同使用的私人家庭帳本。登入後才能讀取財務資料。</p><div class="seg" id="authseg"><button class="on" data-mode="login">登入</button><button data-mode="signup">建立帳號</button></div><form id="authform" class="form"><label id="namebox" class="hide">顯示名稱<input id="dn" placeholder="例如：鎧麟 / 佳軒"></label><label>Email<input id="em" type="email" required autocomplete="email"></label><label>密碼<input id="pw" type="password" minlength="8" required autocomplete="current-password"></label><button class="primary">登入</button></form><div id="msg"></div><small class="secure">🔒 Supabase Auth + Row Level Security</small></section>`;
  const segment = root.querySelector('#authseg');
  const form = root.querySelector('#authform');
  const nameBox = root.querySelector('#namebox');
  const email = root.querySelector('#em');
  const password = root.querySelector('#pw');
  const displayName = root.querySelector('#dn');
  const message = root.querySelector('#msg');
  const submit = form.querySelector('button.primary');
  let mode = 'login';

  segment.onclick = event => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    mode = button.dataset.mode;
    segment.querySelectorAll('button').forEach(item => item.classList.toggle('on', item.dataset.mode === mode));
    nameBox.classList.toggle('hide', mode === 'login');
    submit.textContent = mode === 'login' ? '登入' : '建立帳號';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    const originalLabel = submit.textContent;
    submit.textContent = mode === 'login' ? '登入中…' : '建立中…';
    try {
      let result;
      if (mode === 'login') {
        result = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
      } else {
        result = await sb.auth.signUp({
          email: email.value.trim(),
          password: password.value,
          options: {
            data: { display_name: displayName.value.trim() || email.value.split('@')[0] },
            emailRedirectTo: location.origin,
          },
        });
      }
      message.className = result.error ? 'message error' : 'message';
      message.textContent = result.error
        ? result.error.message
        : (result.data && !result.data.session ? '註冊完成，請到信箱點驗證連結後登入。' : '處理完成。');
    } finally {
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  };
}

function joinScreen() {
  lifecycle = 'join-household';
  root.className = 'auth';
  root.innerHTML = `<section class="authCard"><div class="logo big">KS</div><h1>加入 KS 家庭</h1><p>帳號已登入。輸入家庭邀請碼後，這支手機就會與另一位家庭成員看到同一份財務資料。</p><form id="joinform" class="form"><label>家庭邀請碼<input id="code" required placeholder="KS-…" autocapitalize="none"></label><button class="primary">加入家庭帳本</button></form><div id="msg"></div><button id="signout" class="link">改用其他帳號</button></section>`;
  const form = root.querySelector('#joinform');
  const code = root.querySelector('#code');
  const message = root.querySelector('#msg');
  const submit = form.querySelector('button.primary');
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = '加入中…';
    const { error } = await sb.rpc('join_household_by_code', { raw_code: code.value.trim() });
    if (error) {
      message.className = 'message error';
      message.textContent = error.message;
      submit.disabled = false;
      submit.textContent = '加入家庭帳本';
      return;
    }
    await resolveMembership();
  };
  root.querySelector('#signout').onclick = () => sb.auth.signOut();
}

async function resolveMembership() {
  lifecycle = 'checking-household';
  const { data, error } = await sb.from('household_members')
    .select('household_id,role')
    .eq('user_id', session.user.id)
    .limit(1);
  if (error) return showBlockingError(error.message);
  member = data?.[0] ?? null;
  if (!member) return joinScreen();

  lifecycle = 'loading-data';
  restoreQuoteTimestamp();
  const loaded = await loadData({ blocking: true });
  if (!loaded) return;
  lifecycle = 'ready';
  subscribeRealtime();
  void refreshQuotes({ reason: 'startup' });
}

async function applySession(nextSession) {
  const previousUserId = session?.user?.id ?? null;
  const nextUserId = nextSession?.user?.id ?? null;
  if (previousUserId === nextUserId && member && lifecycle === 'ready') return;

  clearRealtime();
  session = nextSession;
  member = null;
  items = [];
  history = [];
  scopeHistory = [];
  quoteData = {};
  quoteStatus = 'idle';
  quoteFlight = null;
  if (!session) return authScreen();
  await resolveMembership();
}

// Data loading / Realtime ----------------------------------------------------

async function loadData({ blocking = false } = {}) {
  if (!member) return false;
  if (loadFlight) return loadFlight;
  const householdId = member.household_id;
  loadFlight = (async () => {
    const [itemResult, familyHistoryResult, householdResult, scopeHistoryResult] = await Promise.all([
      sb.from('financial_items').select('*').eq('household_id', householdId).order('sort_order'),
      sb.from('net_worth_history').select('*').eq('household_id', householdId).order('recorded_on').range(0, 9999),
      sb.from('households').select('name').eq('id', householdId).single(),
      sb.from('financial_scope_history').select('*').eq('household_id', householdId).order('recorded_on').range(0, 9999),
    ]);
    const failure = [itemResult.error, familyHistoryResult.error, householdResult.error, scopeHistoryResult.error].find(Boolean);
    if (failure) throw failure;
    if (!member || member.household_id !== householdId) return false;

    items = (itemResult.data ?? []).map(normalizeFinancialItem);
    history = (familyHistoryResult.data ?? []).map(row => ({ ...row, net_worth_twd: toFiniteNumber(row.net_worth_twd) }));
    scopeHistory = (scopeHistoryResult.data ?? []).map(row => ({ ...row, total_twd: toFiniteNumber(row.total_twd) }));
    householdName = householdResult.data?.name || '布布一二的家';
    fxRate = items.find(item => item.fx_rate_twd > 1 && item.quote_currency === 'USD')?.fx_rate_twd ?? fxRate;
    render();
    return true;
  })().catch(error => {
    if (blocking) showBlockingError(error.message || '無法載入家庭資料。');
    else setNonBlockingStatus('同步失敗，將於下次變更時重試。', 'error');
    return false;
  }).finally(() => {
    loadFlight = null;
  });
  return loadFlight;
}

function scheduleRealtimeReload() {
  if (!member) return;
  clearTimeout(realtimeReloadTimer);
  realtimeReloadTimer = setTimeout(() => {
    realtimeReloadTimer = null;
    void loadData({ blocking: false });
  }, 300);
}

function subscribeRealtime() {
  if (!member || channel) return;
  const householdId = member.household_id;
  channel = sb.channel(`ks-v3:${householdId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'financial_items', filter: `household_id=eq.${householdId}`,
    }, scheduleRealtimeReload)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'net_worth_history', filter: `household_id=eq.${householdId}`,
    }, scheduleRealtimeReload)
    .subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setNonBlockingStatus('即時同步暫時中斷，資料仍可使用。', 'error');
      }
    });
}

function clearRealtime() {
  clearTimeout(realtimeReloadTimer);
  realtimeReloadTimer = null;
  if (channel) void sb.removeChannel(channel);
  channel = null;
}

// Quotes ---------------------------------------------------------------------

function quoteStorageKey() {
  return member ? `ks:last-quote:${member.household_id}` : null;
}

function restoreQuoteTimestamp() {
  const key = quoteStorageKey();
  if (!key) return;
  const stored = localStorage.getItem(key);
  if (stored && Number.isFinite(new Date(stored).getTime())) quoteLastUpdatedAt = stored;
}

function saveQuoteTimestamp(value) {
  quoteLastUpdatedAt = value;
  const key = quoteStorageKey();
  if (key) localStorage.setItem(key, value);
}

function quoteStatusCopy() {
  const lastUpdate = formatClock(quoteLastUpdatedAt);
  const suffix = lastUpdate ? ` · 更新於 ${lastUpdate}` : '';
  if (quoteStatus === 'updating') return '正在更新市場行情…';
  if (quoteStatus === 'success') return `台股、美股、黃金與匯率已更新${suffix}`;
  if (quoteStatus === 'partial') return `部分行情更新失敗，沿用上一筆價格${suffix}`;
  if (quoteStatus === 'error') return `行情更新失敗，沿用上一筆價格${suffix}`;
  return `家庭資料已同步${suffix}`;
}

function updateQuoteStatusUi() {
  const status = root.querySelector('.status');
  if (!status) return;
  status.className = `status ${quoteStatus}`;
  const text = status.querySelector('[data-status-text]');
  const button = status.querySelector('#reload');
  if (text) text.textContent = quoteStatusCopy();
  if (button) {
    button.disabled = quoteStatus === 'updating';
    button.textContent = quoteStatus === 'updating' ? '更新中' : '更新行情';
  }
}

async function refreshQuotes({ force = false } = {}) {
  if (!session || !member) return null;
  if (quoteFlight) return quoteFlight;
  if (!force && Date.now() - quoteLastAt < 60_000) return null;
  quoteLastAt = Date.now();
  quoteStatus = 'updating';
  updateQuoteStatusUi();

  quoteFlight = (async () => {
    const { data, error } = await sb.functions.invoke('refresh-tw-quotes', { body: {} });
    if (error) {
      quoteStatus = 'error';
      updateQuoteStatusUi();
      return null;
    }

    const successfulQuotes = (data?.results ?? []).filter(result => result.price);
    quoteData = {
      ...quoteData,
      ...Object.fromEntries(successfulQuotes.map(result => [result.id, result])),
    };
    if (data?.fx?.rate) fxRate = toFiniteNumber(data.fx.rate, fxRate);
    const failed = toFiniteNumber(data?.failed);
    const succeeded = toFiniteNumber(data?.updated) + toFiniteNumber(data?.priceOnly);
    quoteStatus = failed > 0 ? (succeeded > 0 ? 'partial' : 'error') : 'success';
    saveQuoteTimestamp(data?.requestedAt || new Date().toISOString());

    if (toFiniteNumber(data?.updated) > 0) await loadData({ blocking: false });
    else render();
    return data;
  })().catch(() => {
    quoteStatus = 'error';
    updateQuoteStatusUi();
    return null;
  }).finally(() => {
    quoteFlight = null;
    updateQuoteStatusUi();
  });
  return quoteFlight;
}

function setNonBlockingStatus(message, tone = 'error') {
  const status = root.querySelector('.status');
  if (!status) return;
  status.className = `status ${tone}`;
  const text = status.querySelector('[data-status-text]');
  if (text) text.textContent = message;
}

// Rendering ------------------------------------------------------------------

function shell(body, title, showAdd = false) {
  root.className = 'app';
  root.innerHTML = `<header class="topbar"><div class="brand"><div class="logo">KS</div><div><h1>${title}</h1></div></div><div class="headActions"><button class="iconBtn" id="mask" title="隱藏金額">${masked ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.86 21.86 0 0 1 5.06-6.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.86 21.86 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>'}</button><button class="iconBtn avatar" id="logout" title="登出">${escapeHtml(String(session.user.user_metadata?.display_name || session.user.email || 'KS').slice(0, 2))}</button></div></header><div class="status ${quoteStatus}"><i></i><span data-status-text>${quoteStatusCopy()}</span><button id="reload" ${quoteStatus === 'updating' ? 'disabled' : ''}>${quoteStatus === 'updating' ? '更新中' : '更新行情'}</button></div><main class="content">${body}</main>${showAdd ? '<button class="fab" id="add" aria-label="新增財務項目">＋</button>' : ''}<nav class="bottomNav">${tabs.map(item => `<button data-tab="${item[0]}" class="${tab === item[0] ? 'on' : ''}"><span>${item[1]}</span>${item[2]}</button>`).join('')}</nav>`;

  root.querySelector('#logout').onclick = () => sb.auth.signOut();
  root.querySelector('#reload').onclick = () => refreshQuotes({ force: true });
  root.querySelector('#mask').onclick = () => { masked = !masked; render(); };
  root.querySelector('.bottomNav').onclick = event => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    tab = button.dataset.tab;
    render();
  };
}

function dashboard() {
  const family = summary();
  const husband = summary('husband');
  const wife = summary('wife');
  const husbandShare = family.totalAssets ? husband.totalAssets / family.totalAssets * 100 : 0;
  const wifeShare = family.totalAssets ? wife.totalAssets / family.totalAssets * 100 : 0;
  const ownerDistribution = `<section class="panel"><div class="panelTitle"><div><h2>夫妻資產分布</h2></div></div><div class="ownerGrid"><div class="ownerTile"><span>老公資產</span><b>NT$ ${formatNumber(husband.totalAssets)}</b><small>占家庭資產 ${husbandShare.toFixed(1)}%</small></div><div class="ownerTile"><span>老婆資產</span><b>NT$ ${formatNumber(wife.totalAssets)}</b><small>占家庭資產 ${wifeShare.toFixed(1)}%</small></div></div></section>`;

  shell(`<section class="portfolioHero"><div class="heroLabel"><span>家庭淨資產</span><span>老公＋老婆</span></div><div class="bigMoney">${formatMoney(family.netWorth)}</div><div class="miniStats"><div><span>家庭總資產</span><b>NT$ ${formatNumber(family.totalAssets)}</b></div><div><span>家庭總負債</span><b>NT$ ${formatNumber(family.totalLiabilities)}</b></div></div></section>${assetAllocationPanel(family.assets, family.totalAssets, '家庭資產配置')}${trendChart(familyTrendRows(family.netWorth))}${ownerDistribution}`, '家庭');
}

function assetAllocationPanel(assets, totalAssets, title) {
  const groups = calculateAllocation(assets, totalAssets);
  let cursor = 0;
  const segments = groups.map(({ category, percent }) => {
    const start = cursor;
    cursor += percent;
    return `${colors[category] || '#7e8798'} ${start}% ${cursor}%`;
  }).join(',') || '#dcebe6 0 100%';
  return `<section class="panel"><div class="panelTitle"><div><h2>${title}</h2></div><span>${groups.length} 類</span></div><div class="allocation"><div class="donut" style="--segments:${segments}"></div><div class="legend">${groups.map(({ category, percent }) => `<div class="legendRow"><i style="background:${colors[category] || '#7e8798'}"></i><span>${escapeHtml(category)}</span><b>${percent.toFixed(1)}%</b></div>`).join('')}</div></div></section>`;
}

function groupedCards(list, ownerScope, kind) {
  const groups = new Map();
  const total = list.reduce((sum, item) => sum + item.amount_twd, 0);
  list.forEach(item => {
    const rows = groups.get(item.category) || [];
    rows.push(item);
    groups.set(item.category, rows);
  });
  const categoryIndex = category => {
    const index = categories[kind].indexOf(category);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...groups]
    .sort(([categoryA], [categoryB]) => categoryIndex(categoryA) - categoryIndex(categoryB))
    .map(([category, rows]) => {
    const key = encodeURIComponent(`${ownerScope}|${kind}|${category}`);
    const groupTotal = rows.reduce((sum, item) => sum + item.amount_twd, 0);
    const open = openGroups.has(key);
    return `<section class="categoryGroup ${open ? 'open' : ''}"><button class="categoryHead" data-group="${key}"><div><span>${escapeHtml(category)}</span><small>${rows.length} 筆</small></div><div class="categoryTotal"><b>NT$ ${formatNumber(groupTotal)}</b><i>⌄</i></div></button>${open ? `<div class="categoryItems">${rows.map(item => itemCard(item, total)).join('')}</div>` : ''}</section>`;
  }).join('');
}

function personPage(ownerScope) {
  const totals = summary(ownerScope);
  const kind = pageKind[ownerScope];
  const list = kind === 'asset' ? totals.assets : totals.liabilities;
  const total = kind === 'asset' ? totals.totalAssets : totals.totalLiabilities;
  const name = ownerScope === 'husband' ? '老公' : '老婆';
  shell(`<section class="portfolioHero"><div class="heroLabel"><span>${name}淨資產</span><span>${totals.assets.length + totals.liabilities.length} 筆</span></div><div class="bigMoney">${formatMoney(totals.netWorth)}</div><div class="miniStats"><div><span>資產總額</span><b>NT$ ${formatNumber(totals.totalAssets)}</b></div><div><span>負債總額</span><b>NT$ ${formatNumber(totals.totalLiabilities)}</b></div></div></section>${assetAllocationPanel(totals.assets, totals.totalAssets, `${name}資產配置`)}${trendChart(personalTrendRows(ownerScope, totals.netWorth))}<div class="seg personSeg" id="personSeg"><button data-kind="asset" class="${kind === 'asset' ? 'on' : ''}">資產</button><button data-kind="liability" class="${kind === 'liability' ? 'on' : ''}">負債</button></div><div class="sectionHead"><span>${kind === 'asset' ? '投資與資產' : '貸款與負債'}</span><b>NT$ ${formatNumber(total)}</b></div><div class="categoryList">${list.length ? groupedCards(list, ownerScope, kind) : `<div class="empty"><div><b>目前沒有${kind === 'asset' ? '資產' : '負債'}資料</b><span>按右下角 ＋ 新增財務項目。</span></div></div>`}</div>`, name, true);

  root.querySelector('#personSeg').onclick = event => {
    const button = event.target.closest('[data-kind]');
    if (!button || pageKind[ownerScope] === button.dataset.kind) return;
    pageKind[ownerScope] = button.dataset.kind;
    render();
  };
  root.querySelector('#add').onclick = () => editItem(null, ownerScope, kind);
  root.querySelector('.categoryList').onclick = event => {
    const group = event.target.closest('[data-group]');
    if (group) {
      const key = group.dataset.group;
      openGroups.has(key) ? openGroups.delete(key) : openGroups.add(key);
      render();
      return;
    }
    const item = event.target.closest('[data-id]');
    if (item) editItem(items.find(row => row.id === item.dataset.id), ownerScope, kind);
  };
}

function itemCard(item, total) {
  const quote = quoteData[item.id];
  const percent = total ? item.amount_twd / total * 100 : 0;
  const percentLabel = percent > 0 && percent < 1 ? '&lt;1' : Math.round(percent);
  const isNativeUsd = item.native_currency === 'USD' && item.native_amount !== null;
  const subtitle = item.symbol ? escapeHtml(item.symbol) : escapeHtml(item.native_currency || '');
  const quantity = item.quantity === null ? '待設定' : formatNumber(item.quantity);
  const price = quote?.currency === 'USD'
    ? `US$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(toFiniteNumber(quote.price))}`
    : `NT$ ${formatNumber(quote?.price)}`;
  const change = toFiniteNumber(quote?.changePercent);
  const tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const quoteLine = quote
    ? `<span class="quoteLive"><i></i>${price}<b class="${tone}">${change > 0 ? '+' : ''}${change.toFixed(2)}%</b></span>`
    : item.symbol ? '<span class="quotePending">沿用最近市值</span>' : '';
  const meta = item.kind === 'asset'
    ? (item.market === 'GOLD' ? `<span>重量 ${quantity} g</span>${quoteLine}` : item.symbol ? `<span>持有 ${quantity} 股</span>${quoteLine}` : '')
    : `<span>利率 ${item.interest_rate !== null ? item.interest_rate.toFixed(2) + '%' : '待設定'}</span><span>月付 ${item.monthly_payment_twd !== null ? 'NT$ ' + formatNumber(item.monthly_payment_twd) : '待設定'}</span>`;
  const original = isNativeUsd
    ? `<span>US$ ${masked ? '••••••' : new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(item.native_amount)}</span>`
    : '';
  return `<button class="itemCard compactCard" data-id="${item.id}"><div class="compactMain"><div class="allocationRing ${item.kind}" style="--pct:${Math.max(0, Math.min(100, percent))}%"><span>${percentLabel}%</span></div><div class="compactIdentity"><b>${escapeHtml(item.name)}</b>${subtitle ? `<span>${subtitle}</span>` : ''}</div><div class="compactAmount"><b>NT$ ${formatNumber(item.amount_twd)}</b>${original}</div></div>${meta ? `<div class="compactMeta ${item.kind}">${meta}</div>` : ''}</button>`;
}

function render() {
  if (!session || !member) return;
  if (tab === 'dashboard') dashboard();
  else personPage(tab);
}

root.addEventListener('click', event => {
  if (!event.target.closest('[data-trend-toggle]')) return;
  trendMode = trendMode === 'value' ? 'percent' : 'value';
  render();
});

// Financial item CRUD --------------------------------------------------------

function modeForItem(item, kind) {
  if (kind === 'liability') return 'liability';
  if (item?.market === 'TW') return 'stock-tw';
  if (item?.market === 'US') return 'stock-us';
  if (item?.market === 'GOLD') return 'gold';
  const currency = item?.native_currency ?? item?.original_currency ?? 'TWD';
  return currency === 'USD' ? 'manual-usd' : 'manual-twd';
}

function editItem(item, defaultOwner, defaultKind) {
  let owner = item?.owner_scope || defaultOwner || 'husband';
  let kind = item?.kind || defaultKind || 'asset';
  let mode = modeForItem(item, kind);
  let saving = false;
  const initialNativeAmount = item?.native_amount ?? item?.original_amount ?? item?.amount_twd ?? '';
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `<section class="sheet"><div class="handle"></div><div class="sheetHead"><div><h2>${item ? '編輯' : '新增'}財務項目</h2></div>${item ? '<button id="del" class="trash">刪除</button>' : ''}</div><form id="editform" class="form" novalidate><label>歸屬<select id="owner"><option value="husband">老公</option><option value="wife">老婆</option></select></label><div class="seg"><button type="button" data-kind="asset">資產</button><button type="button" data-kind="liability">負債</button></div><label>名稱<input id="nm" required value="${escapeHtml(item?.name || '')}"></label><label>分類<select id="cat"></select></label><label id="modeBox">資料型態<select id="mode"><option value="manual-twd">手動台幣資產</option><option value="manual-usd">手動美元資產</option><option value="stock-tw">台股</option><option value="stock-us">美股</option><option value="gold">黃金（自動行情）</option></select></label><div id="manualFields"><label id="amountLabel">台幣金額<input id="amt" inputmode="decimal" value="${initialNativeAmount}"></label><div id="usdFields" class="two hide"><label>USD/TWD 匯率<input id="fx" inputmode="decimal" readonly></label><label>自動換算台幣<input id="converted" readonly></label></div></div><div id="stockFields" class="hide"><div class="two"><label>股票代號<input id="symbol" value="${escapeHtml(item?.symbol || '')}" placeholder="例如 2330 / VOO" autocapitalize="characters"></label><label>持有股數<input id="qty" inputmode="decimal" value="${item?.quantity ?? ''}"></label></div><div class="quoteHint" id="stockHint"></div></div><div id="goldFields" class="hide"><div class="two"><label>持有重量<input id="goldWeight" inputmode="decimal" value="${item?.market === 'GOLD' ? item.quantity ?? '' : ''}"></label><label>單位<select disabled><option>g 公克</option></select></label></div><div class="quoteHint">依 XAU/USD × USD/TWD 自動換算台幣市值。1 troy oz = 31.1034768 g。</div></div><div id="loanFields" class="hide"><label>剩餘本金（TWD）<input id="principal" inputmode="decimal" value="${item?.amount_twd ?? ''}"></label><div class="two"><label>年利率 %<input id="rate" inputmode="decimal" value="${item?.interest_rate ?? ''}"></label><label>每月月付（TWD）<input id="pay" inputmode="decimal" value="${item?.monthly_payment_twd ?? ''}"></label></div></div><label>備註（選填）<textarea id="note" rows="3">${escapeHtml(item?.notes || '')}</textarea></label><div id="emsg"></div><button id="save" class="primary">儲存並同步</button></form></section>`;
  document.body.append(backdrop);

  const form = backdrop.querySelector('#editform');
  const ownerInput = backdrop.querySelector('#owner');
  const nameInput = backdrop.querySelector('#nm');
  const categoryInput = backdrop.querySelector('#cat');
  const modeBox = backdrop.querySelector('#modeBox');
  const modeInput = backdrop.querySelector('#mode');
  const manualFields = backdrop.querySelector('#manualFields');
  const amountLabel = backdrop.querySelector('#amountLabel');
  const amountInput = backdrop.querySelector('#amt');
  const usdFields = backdrop.querySelector('#usdFields');
  const fxInput = backdrop.querySelector('#fx');
  const convertedInput = backdrop.querySelector('#converted');
  const stockFields = backdrop.querySelector('#stockFields');
  const symbolInput = backdrop.querySelector('#symbol');
  const quantityInput = backdrop.querySelector('#qty');
  const stockHint = backdrop.querySelector('#stockHint');
  const goldFields = backdrop.querySelector('#goldFields');
  const goldWeightInput = backdrop.querySelector('#goldWeight');
  const loanFields = backdrop.querySelector('#loanFields');
  const principalInput = backdrop.querySelector('#principal');
  const rateInput = backdrop.querySelector('#rate');
  const paymentInput = backdrop.querySelector('#pay');
  const noteInput = backdrop.querySelector('#note');
  const message = backdrop.querySelector('#emsg');
  const saveButton = backdrop.querySelector('#save');
  ownerInput.value = owner;
  modeInput.value = mode;

  const currentFxRate = () => toFiniteNumber(fxRate || item?.fx_rate_twd);
  const updateConversion = () => {
    if (mode !== 'manual-usd') return;
    const rate = currentFxRate();
    fxInput.value = rate > 0 ? rate.toFixed(4) : '尚未取得';
    const amount = Number(String(amountInput.value).replace(/,/g, ''));
    convertedInput.value = Number.isFinite(amount) && amount >= 0 && rate > 0
      ? `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(Math.round(amount * rate))}`
      : '等待有效美元金額與匯率';
  };
  const fillCategories = () => {
    const selected = categoryInput.value || item?.category;
    categoryInput.innerHTML = categories[kind].map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    if (categories[kind].includes(selected)) categoryInput.value = selected;
  };
  const updateFields = () => {
    if (kind === 'liability') mode = 'liability';
    else if (mode === 'liability') mode = 'manual-twd';
    modeInput.value = mode;
    const manual = kind === 'asset' && mode.startsWith('manual-');
    const stock = kind === 'asset' && mode.startsWith('stock-');
    const gold = kind === 'asset' && mode === 'gold';
    if (gold) categoryInput.value = '黃金';
    categoryInput.disabled = gold;
    modeBox.classList.toggle('hide', kind === 'liability');
    manualFields.classList.toggle('hide', !manual);
    stockFields.classList.toggle('hide', !stock);
    goldFields.classList.toggle('hide', !gold);
    loanFields.classList.toggle('hide', kind !== 'liability');
    usdFields.classList.toggle('hide', mode !== 'manual-usd');
    amountLabel.firstChild.textContent = mode === 'manual-usd' ? '美元金額（USD）' : '台幣金額（TWD）';
    stockHint.textContent = mode === 'stock-us'
      ? `目前台幣價值由「股數 × 美股市價 × USD/TWD」自動計算。現值：NT$ ${formatNumber(item?.amount_twd || 0)}`
      : `目前台幣價值由「股數 × 台股市價」自動計算。現值：NT$ ${formatNumber(item?.amount_twd || 0)}`;
    backdrop.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('on', button.dataset.kind === kind));
    updateConversion();
  };

  fillCategories();
  updateFields();
  modeInput.onchange = () => { mode = modeInput.value; updateFields(); };
  categoryInput.onchange = () => {
    if (kind === 'asset' && categoryInput.value === '黃金' && !item) mode = 'gold';
    else if (mode === 'gold' && categoryInput.value !== '黃金') mode = 'manual-twd';
    updateFields();
  };
  amountInput.oninput = updateConversion;
  backdrop.onclick = event => {
    if (event.target === backdrop && !saving) backdrop.remove();
    const button = event.target.closest('[data-kind]');
    if (!button || saving) return;
    kind = button.dataset.kind;
    fillCategories();
    updateFields();
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    message.textContent = '';
    try {
      owner = ownerInput.value;
      const name = nameInput.value.trim();
      if (!OWNER_SCOPES.includes(owner)) throw new Error('歸屬設定不正確。');
      if (!ITEM_KINDS.includes(kind)) throw new Error('資產／負債設定不正確。');
      if (!name) throw new Error('請輸入名稱。');
      if (!categories[kind].includes(categoryInput.value)) throw new Error('分類設定不正確。');

      let amountTwd = 0;
      let nativeCurrency = 'TWD';
      let nativeAmount = null;
      let market = 'MANUAL';
      let symbol = null;
      let quantity = null;
      let quoteCurrency = 'TWD';
      let quoteSource = 'manual';
      let exchangeRate = 1;
      let interestRate = null;
      let monthlyPayment = null;

      if (kind === 'liability') {
        nativeAmount = parseNonNegative(principalInput.value, '剩餘本金');
        amountTwd = calculateTwdAmount({ nativeCurrency: 'TWD', nativeAmount, fxRateTwd: 1 });
        interestRate = parseNonNegative(rateInput.value, '年利率', { required: false });
        monthlyPayment = parseNonNegative(paymentInput.value, '每月月付', { required: false });
      } else if (mode === 'manual-twd' || mode === 'manual-usd') {
        nativeCurrency = mode === 'manual-usd' ? 'USD' : 'TWD';
        nativeAmount = parseNonNegative(amountInput.value, nativeCurrency === 'USD' ? '美元金額' : '台幣金額');
        exchangeRate = nativeCurrency === 'USD' ? currentFxRate() : 1;
        amountTwd = calculateTwdAmount({ nativeCurrency, nativeAmount, fxRateTwd: exchangeRate });
        quoteCurrency = nativeCurrency;
        quoteSource = nativeCurrency === 'USD' ? 'twelve_data' : 'manual';
      } else if (mode === 'stock-tw' || mode === 'stock-us') {
        market = mode === 'stock-us' ? 'US' : 'TW';
        symbol = symbolInput.value.trim().toUpperCase();
        if (!isValidSymbol(symbol)) throw new Error('股票代號格式不正確。');
        quantity = parseNonNegative(quantityInput.value, '持有股數', { positive: true });
        amountTwd = toFiniteNumber(item?.amount_twd);
        nativeCurrency = null;
        nativeAmount = null;
        quoteCurrency = market === 'US' ? 'USD' : 'TWD';
        quoteSource = market === 'US' ? 'twelve_data' : 'fugle';
        exchangeRate = market === 'US' ? (toFiniteNumber(item?.fx_rate_twd || fxRate) || null) : 1;
      } else if (mode === 'gold') {
        market = 'GOLD';
        symbol = 'XAU/USD';
        quantity = parseNonNegative(goldWeightInput.value, '黃金重量', { positive: true });
        amountTwd = toFiniteNumber(item?.amount_twd);
        nativeCurrency = null;
        nativeAmount = null;
        quoteCurrency = 'USD';
        quoteSource = 'twelve_data';
        exchangeRate = toFiniteNumber(item?.fx_rate_twd || fxRate) || null;
      } else {
        throw new Error('資料型態設定不正確。');
      }

      const payload = {
        household_id: member.household_id,
        owner_scope: owner,
        kind,
        name,
        category: categoryInput.value,
        amount_twd: amountTwd,
        native_currency: nativeCurrency,
        native_amount: nativeAmount,
        symbol,
        market,
        quantity,
        average_cost: item?.average_cost ?? null,
        quote_currency: quoteCurrency,
        fx_rate_twd: exchangeRate,
        quote_source: quoteSource,
        interest_rate: interestRate,
        monthly_payment_twd: monthlyPayment,
        notes: noteInput.value.trim() || null,
        updated_by: session.user.id,
        updated_at: new Date().toISOString(),
      };

      saving = true;
      saveButton.disabled = true;
      saveButton.textContent = '儲存中…';
      const result = item
        ? await sb.from('financial_items').update(payload).eq('id', item.id).eq('household_id', member.household_id)
        : await sb.from('financial_items').insert({ ...payload, created_by: session.user.id });
      if (result.error) throw result.error;
      backdrop.remove();
      tab = owner;
      pageKind[owner] = kind;
      await loadData({ blocking: false });
      if (kind === 'asset' && (mode.startsWith('stock-') || mode === 'manual-usd' || mode === 'gold')) {
        void refreshQuotes({ force: true });
      }
    } catch (error) {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = '儲存並同步';
      message.className = 'message error';
      message.textContent = error.message || '儲存失敗，請稍後再試。';
    }
  };

  const deleteButton = backdrop.querySelector('#del');
  if (deleteButton) deleteButton.onclick = async () => {
    if (saving || !confirm(`確定刪除「${item.name}」？`)) return;
    saving = true;
    deleteButton.disabled = true;
    deleteButton.textContent = '刪除中…';
    const { error } = await sb.from('financial_items')
      .delete()
      .eq('id', item.id)
      .eq('household_id', member.household_id);
    if (error) {
      saving = false;
      deleteButton.disabled = false;
      deleteButton.textContent = '刪除';
      message.className = 'message error';
      message.textContent = error.message;
      return;
    }
    backdrop.remove();
    await loadData({ blocking: false });
  };
}

// Bootstrap ------------------------------------------------------------------

const { data: { session: initialSession }, error: initialSessionError } = await sb.auth.getSession();
if (initialSessionError) showBlockingError(initialSessionError.message);
else await applySession(initialSession);

sb.auth.onAuthStateChange((event, nextSession) => {
  if (event === 'INITIAL_SESSION') return;
  void applySession(nextSession);
});
