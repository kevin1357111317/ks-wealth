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
} from './financial-core.js?v=hide-sold-out-1';
import { calculatePortfolio, calculateStockValue, decodePortfolioBootstrap } from './portfolio-core.js?v=xirr-fast-1';
import { calculateUsd } from './usd-core.js?v=xirr-fast-1';
import { calculateGold } from './gold-core.js?v=xirr-fast-1';
import { calculateLoanCashflow } from './loan-core.js?v=xirr-fast-1';

// App / Supabase -------------------------------------------------------------

const SUPABASE_URL = 'https://gbxsnwqbjmgfikpblyot.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VtGM8w7CqxDB_3NaROR8OA_H0txX-_I';
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const root = document.querySelector('#root');
// 兩張頭像以前是 base64 直接寫在這支檔案裡，光它們就 82 KB —— 佔整支 app-v3.js 的四成，
// 每次改前端 bump ?v= 就要連它們一起重新下載、重新解析成 JS 字串。改成一般的圖檔：
// 瀏覽器平行下載、不擋 JS 解析，而且改程式不會讓圖片的快取失效。
const NAV_FACES = { bubu: '/icons/nav-bubu.png?v=nav-face-1', yier: '/icons/nav-yier.png?v=nav-face-1' };
const tabs = [
  ['husband', `<img class="navBear" src="${NAV_FACES.bubu}" alt="布布" width="34" height="34" decoding="async">`, '老公'],
  ['dashboard', '◉', '家庭'],
  ['wife', `<img class="navBear" src="${NAV_FACES.yier}" alt="一二" width="34" height="34" decoding="async">`, '老婆'],
];
const categories = {
  asset: ['現金及存款', '台股', '美股', '不動產', '黃金', '保險', '其他'],
  liability: ['房貸', '增貸', '信貸', '信用卡', '其他負債'],
};
const colors = {
  台股: '#72d7a7', 美股: '#8b94ff', 現金及存款: '#67c8db', 不動產: '#f0b467',
  保險: '#bb8cff', 黃金: '#e5ae4f', 其他: '#ee8f73', 房貸: '#ff7f91', 增貸: '#f0a76b', 信貸: '#df788a',
};
const automaticCategoryByMode = {
  'stock-tw': '台股',
  'stock-us': '美股',
  gold: '黃金',
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
let itemReloadTimer = null;
let loadFlight = null;
let quoteFlight = null;
let quoteStatus = 'idle';
let quoteFailureNote = '';
let quoteLastAt = 0;
// 兩條更新路徑，快慢差很多是因為成本差很多：
//   台股：Fugle，免費、沒有 credit 的概念，所以可以每幾秒抓一次。走輕量路徑
//         （scope='tw'）—— 只拿價格、不寫資料庫，畫面直接套用。
//   其餘：美股 + 匯率 + 黃金走 Twelve Data，一輪 7 credits、上限每分鐘 8，
//         所以一分鐘一次就是極限，而且這一輪才是寫進資料庫的權威值。
const QUOTE_TW_INTERVAL_MS = 5 * 1000;
const QUOTE_FULL_INTERVAL_MS = 60 * 1000;
let quoteTwTimer = null;
let quoteTimer = null;
let wakeLock = null;
let quoteLastUpdatedAt = null;
let quoteData = {};
let fxRate = null;
// 台帳（39 檔標的、1489 筆交易、92 KB）只有股票分析頁與編輯表單的交易紀錄要用。
// 資產列的股數與市值是觸發器算好存在 financial_items 的，開 App 根本不需要台帳，
// 所以改成第一次真的要用時才載。
let portfolioStocks = [];
let ledgerLoaded = false;
let ledgerFlight = null;
// 美金部位自己一本帳，跟 financial_items 沒有連動：買賣只在美金分析頁裡進出。
let usdTransactions = [];
let goldTransactions = [];
let loanAccounts = [];
// 還款排程有 837 列，只有貸款分析頁要用，跟台帳一樣點進去才載。
let loanSchedule = [];
let loanScheduleLoaded = false;
let loanScheduleFlight = null;
let expandedLoan = null;   // 就地展開的那一筆，一次只開一個
// 主畫面的負債列要顯示下次繳款，但完整排程有 800 多列。這裡只留每一筆「還沒扣款的
// 最早一期」，由 loadData() 抓一小段回來組成 { 貸款 id: { date, amount } }。
let loanNextDue = {};
let autopayCheckedOn = null;
let loanTypeFilter = 'personal';   // 貸款分析預設先看信貸，可切換增貸／房貸
let analysisScreen = null;   // 'stocks'｜'usd'｜'gold'｜'loans'，null 就是一般的資產頁
let analysisOwner = 'husband';   // 分析頁看的是誰的部位
let expandedStock = null;   // 台帳清單裡就地展開的那一檔，一次只開一個
// 分析頁是狀態切換不是換頁，返回手勢預設不會有反應。進去時推一筆歷史，
// 手勢／返回鍵就有東西可以退，popstate 再把畫面收回來。
let analysisPushed = false;
let analysisReturnScroll = 0;   // 進分析頁前在資產頁停的位置，退出來要回到那裡
// 瀏覽器預設會在 popstate 之後自己還原捲動位置，蓋掉我們設好的值。
// 這個 App 的畫面是狀態切換不是真的換頁，捲動由我們自己決定。
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
let portfolioMarket = 'all';
let portfolioShowExited = false;
let openGroups = new Set();
let trendMode = 'value';
let currentTrendSeries = [];
let trendDrag = null;
const pageKind = { husband: 'asset', wife: 'asset' };
const distributionMode = { dashboard: 'asset', husband: 'asset', wife: 'asset' };

// Formatting / calculations --------------------------------------------------

// 對照表提到外面：原本寫成箭頭函式裡的物件字面量，等於每跳脫一個字元就配置一個新物件。
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
// Intl 的格式器建構一次要幾十微秒，格式化本身反而很便宜。以前有好幾個是寫在
// 每一列的樣板字串裡，一頁上千列交易就 new 上千個一模一樣的格式器。
const integerFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const twoDigitFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const fourDigitFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 4 });
const sixDigitFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 6 });
const taipeiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});
const taipeiClockFormatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
});
const formatReadableNumber = value => {
  const rounded = Math.round(toFiniteNumber(value));
  const absolute = Math.abs(rounded);
  if (absolute < 100_000_000) return integerFormatter.format(rounded);

  const sign = rounded < 0 ? '-' : '';
  let yi = Math.floor(absolute / 100_000_000);
  let wan = Math.round((absolute % 100_000_000) / 10_000);
  if (wan === 10_000) {
    yi += 1;
    wan = 0;
  }
  return `${sign}${integerFormatter.format(yi)}億${wan ? `${integerFormatter.format(wan)}萬` : ''}`;
};
const formatNumber = value => masked ? '••••••' : formatReadableNumber(value);
const formatMoney = value => `<small>NT$</small> ${formatNumber(value)}`;
const formatPercent = value => value === null || !Number.isFinite(value)
  ? '—'
  : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
const taipeiDate = () => taipeiDateFormatter.format(new Date());
const formatClock = value => {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return taipeiClockFormatter.format(date);
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

function chartFullDate(value) {
  const [year, month, day] = String(value).split('-');
  return `${year}/${Number(month)}/${Number(day)}`;
}

function trendChart(rows) {
  if (!rows.length) {
    currentTrendSeries = [];
    return '';
  }
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
  currentTrendSeries = series.map((row, index) => ({
    ...row,
    chartX: x(index),
    chartY: y(row.plotValue),
  }));
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

  return `<section class="panel trend scopeTrend"><div class="trendHead"><h2>淨資產趨勢</h2><button class="trendToggle" data-trend-toggle>${trendMode === 'value' ? '%' : 'NT$'}</button></div><div class="trendChange ${tone}"><b>${delta > 0 ? '+' : ''}${formatNumber(delta)}</b><span>${delta > 0 ? '+' : ''}${percent.toFixed(2)}%</span></div><div class="trendPlot"><svg class="trendChart" data-trend-chart viewBox="0 0 680 236" aria-label="淨資產趨勢，點選折線可查看日期與金額">${axis}${dateTicks}<path d="${points}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><rect class="trendChartHit" x="106" y="8" width="558" height="190" fill="transparent"/><g class="trendSelection" data-trend-selection hidden><line class="trendGuide" data-trend-guide y1="12" y2="190"/><circle class="trendDotHalo" data-trend-dot-halo r="12"/><circle class="trendDot" data-trend-dot r="6"/><g class="trendTooltip" data-trend-tooltip><rect class="trendTooltipBox" x="-105" y="0" width="210" height="56" rx="13"/><text class="trendTooltipDate" data-trend-tooltip-date x="0" y="20" text-anchor="middle"></text><text class="trendTooltipValue" data-trend-tooltip-value x="0" y="43" text-anchor="middle"></text></g></g></svg></div></section>`;
}

function clearTrendPoint() {
  root.querySelector('[data-trend-selection]')?.setAttribute('hidden', '');
}

function showTrendPoint(event, svg) {
  if (!currentTrendSeries.length) return;
  const bounds = trendDrag?.chart === svg ? trendDrag.bounds : svg.getBoundingClientRect();
  if (!bounds.width) return;
  const svgX = (event.clientX - bounds.left) / bounds.width * 680;
  const ratio = Math.max(0, Math.min(1, (svgX - 112) / 552));
  const index = Math.round(ratio * Math.max(0, currentTrendSeries.length - 1));
  const point = currentTrendSeries[index];
  const selection = svg.querySelector('[data-trend-selection]');
  if (!point || !selection) return;
  if (!selection.hasAttribute('hidden') && selection.dataset.index === String(index)) return;
  selection.dataset.index = String(index);

  const tooltipX = Math.max(109, Math.min(571, point.chartX));
  const tooltipY = point.chartY > 88 ? point.chartY - 68 : point.chartY + 14;
  selection.removeAttribute('hidden');
  selection.querySelector('[data-trend-guide]').setAttribute('x1', point.chartX);
  selection.querySelector('[data-trend-guide]').setAttribute('x2', point.chartX);
  selection.querySelector('[data-trend-dot-halo]').setAttribute('cx', point.chartX);
  selection.querySelector('[data-trend-dot-halo]').setAttribute('cy', point.chartY);
  selection.querySelector('[data-trend-dot]').setAttribute('cx', point.chartX);
  selection.querySelector('[data-trend-dot]').setAttribute('cy', point.chartY);
  selection.querySelector('[data-trend-tooltip]').setAttribute('transform', `translate(${tooltipX} ${tooltipY})`);
  selection.querySelector('[data-trend-tooltip-date]').textContent = chartFullDate(point.recorded_on);
  selection.querySelector('[data-trend-tooltip-value]').textContent = masked
    ? 'NT$ ••••••'
    : `NT$ ${integerFormatter.format(Math.round(toFiniteNumber(point.total_twd)))}`;
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
  void applyDueLoanPayments();
  void refreshQuotes({ reason: 'startup' });
  startQuoteAutoRefresh();
}

// ── 螢幕恆亮與自動更新 ──────────────────────────────────────────────────────
// 兩件事都綁在「畫面看得到」這個條件上：Wake Lock 本來就會在切到背景時被系統收回，
// 而背景分頁的計時器會被瀏覽器降頻，更新了也沒人看，只是耗電跟吃 API 額度。
async function keepScreenAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // 系統自己收回時（低電量、切背景）把它清掉，回前景才會重新要一次。
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  } catch { /* 低電量模式或使用者不給，就照一般的螢幕逾時走 */ }
}

function startQuoteAutoRefresh() {
  stopQuoteAutoRefresh();
  quoteTwTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refreshTwQuotes();
  }, QUOTE_TW_INTERVAL_MS);
  quoteTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refreshQuotes({ reason: 'auto' });
  }, QUOTE_FULL_INTERVAL_MS);
}

function stopQuoteAutoRefresh() {
  if (quoteTwTimer !== null) clearInterval(quoteTwTimer);
  if (quoteTimer !== null) clearInterval(quoteTimer);
  quoteTwTimer = null;
  quoteTimer = null;
}

// 報價更新之後要跟上的只有兩樣：資產列的金額，以及股票分析用的那一份股價。
// 金額 Edge Function 已經算好回傳了，股價再去 klfan_quotes 撈一次就好 —— 交易
// 歷史沒有變，沒有理由重載。
async function applyQuoteRefresh(data) {
  for (const result of data?.results ?? []) {
    const item = items.find(row => row.id === result.id);
    const amountTwd = toFiniteNumber(result.amountTwd);
    if (item && result.status === 'updated' && amountTwd > 0) item.amount_twd = amountTwd;
  }
  const { data: rows, error } = await sb.from('klfan_quotes')
    .select('symbol,price,currency,source,quoted_at,updated_at');
  if (error || !rows) return;
  const bySymbol = new Map(rows.map(row => [String(row.symbol ?? '').toUpperCase(), {
    price: toFiniteNumber(row.price),
    currency: row.currency,
    source: row.source,
    quotedAt: row.quoted_at,
    updatedAt: Date.parse(String(row.updated_at ?? '')) || 0,
  }]));
  if (!ledgerLoaded) return;
  for (const stock of portfolioStocks) {
    const quote = bySymbol.get(String(stock.symbol ?? '').toUpperCase());
    if (quote) stock.quote = quote;
  }
}

// 台股的輕量更新：只拿價格套進畫面，不寫資料庫、不重載、不動狀態列。
// 狀態列每五秒閃一次「更新中」比不更新還糟。
let twFlight = null;
async function refreshTwQuotes() {
  if (!session || !member || twFlight || quoteFlight) return null;
  twFlight = (async () => {
    const { data, error } = await sb.functions.invoke('refresh-tw-quotes', { body: { scope: 'tw' } });
    if (error || !data) return null;
    let changed = false;
    for (const result of data.results ?? []) {
      const price = toFiniteNumber(result.price);
      const item = price > 0 ? items.find(row => row.id === result.id) : null;
      const quantity = toFiniteNumber(item?.quantity);
      if (!item || !(quantity > 0)) continue;
      const amountTwd = Math.round(price * quantity);
      if (amountTwd === item.amount_twd) continue;
      item.amount_twd = amountTwd;
      changed = true;
    }
    if (changed) render();
    return data;
  })().catch(() => null).finally(() => { twFlight = null; });
  return twFlight;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void keepScreenAwake();
  void applyDueLoanPayments();   // App 擺著過了午夜，回來時補扣當天的
  // 螢幕關著的那段時間計時器是停的，回來時先補一次。
  if (session && member && Date.now() - quoteLastAt >= QUOTE_FULL_INTERVAL_MS) {
    void refreshQuotes({ reason: 'visible' });
  }
});

void keepScreenAwake();

async function applySession(nextSession) {
  const previousUserId = session?.user?.id ?? null;
  const nextUserId = nextSession?.user?.id ?? null;
  if (previousUserId === nextUserId && member && lifecycle === 'ready') return;

  clearRealtime();
  stopQuoteAutoRefresh();   // 換人或登出就先停，登入完成後 bootstrap 會重開
  session = nextSession;
  member = null;
  items = [];
  history = [];
  scopeHistory = [];
  portfolioStocks = [];
  ledgerLoaded = false;
  ledgerFlight = null;
  loanSchedule = [];
  loanScheduleLoaded = false;
  loanScheduleFlight = null;
  expandedLoan = null;
  loanNextDue = {};
  autopayCheckedOn = null;
  loanTypeFilter = 'personal';
  analysisScreen = null;
  analysisOwner = 'husband';
  usdTransactions = [];
  goldTransactions = [];
  expandedStock = null;
  analysisPushed = false;
  analysisReturnScroll = 0;
  quoteData = {};
  quoteStatus = 'idle';
  quoteFlight = null;
  if (!session) return authScreen();
  await resolveMembership();
}

// Data loading / Realtime ----------------------------------------------------

// PostgREST 伺服器端一次最多吐 1000 列，.range(0, 9999) 要更多也沒用 —— 超出的直接被
// 砍掉，而且不會報錯。排程總共一千九百多列，不分頁抓的話尾巴就不見了：潤隆房貸曾經
// 只拿到 360 期裡最早的 143 期，貸款年限（11 年 11 個月）、已繳期數（36/143）、
// 年化成本（−8.94%，因為看起來永遠還不完）三個數字一起錯。
const PAGE_ROWS = 1000;
async function fetchAllRows(build) {
  const all = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await build().range(from, from + PAGE_ROWS - 1);
    if (error) return { data: null, error };
    all.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_ROWS) return { data: all, error: null };
  }
}

async function ensureLoanSchedule() {
  if (loanScheduleLoaded) return true;
  if (loanScheduleFlight) return loanScheduleFlight;
  loanScheduleFlight = (async () => {
    const { data, error } = await fetchAllRows(() => sb.from('loan_schedule')
      .select('id,loan_account_id,due_date,actual_date,amount_twd,balance_after_twd,entry_type,note').order('due_date').order('id'));
    if (error) return false;
    loanSchedule = data ?? [];
    loanScheduleLoaded = true;
    return true;
  })().catch(() => false).finally(() => { loanScheduleFlight = null; });
  return loanScheduleFlight;
}

// 繳款日一到（台北時間跨過午夜）就把負債扣掉，不用每個月自己改數字。真正的計算在
// apply_due_loan_payments() 裡 —— 放資料庫是因為每台裝置、還有每天的快照都要走同一套
// 規則，而且它是冪等的：同一期扣過就不會再扣第二次。日期沒換就不用再問。
async function applyDueLoanPayments() {
  const today = taipeiDate();
  if (!member || autopayCheckedOn === today) return false;
  autopayCheckedOn = today;
  const { data, error } = await sb.rpc('apply_due_loan_payments');
  if (error) {
    autopayCheckedOn = null;   // 沒問成就別記，下次進來再試
    return false;
  }
  if (!data?.length) return false;
  loanScheduleLoaded = false;   // 排程上的 applied_* 變了，下次進分析頁重抓
  await loadData({ blocking: false });
  return true;
}

async function ensureLedger() {
  if (ledgerLoaded) return true;
  if (ledgerFlight) return ledgerFlight;
  ledgerFlight = (async () => {
    const { data, error } = await sb.rpc('klfan_bootstrap');
    if (error || !data) return false;
    portfolioStocks = decodePortfolioBootstrap(data);
    ledgerLoaded = true;
    return true;
  })().catch(() => false).finally(() => { ledgerFlight = null; });
  return ledgerFlight;
}

async function loadData({ blocking = false } = {}) {
  if (!member) return false;
  if (loadFlight) return loadFlight;
  const householdId = member.household_id;
  loadFlight = (async () => {
    const [itemResult, familyHistoryResult, householdResult, scopeHistoryResult, usdResult, goldResult, loanResult, nextDueResult] = await Promise.all([
      sb.from('financial_items').select('*').eq('household_id', householdId).order('sort_order'),
      // 這三張表也走分頁：淨值快照一天一列，放個三年就會撞到 1000 列的上限
      fetchAllRows(() => sb.from('net_worth_history').select('*').eq('household_id', householdId).order('recorded_on')),
      sb.from('households').select('name').eq('id', householdId).single(),
      fetchAllRows(() => sb.from('financial_scope_history').select('*').eq('household_id', householdId).order('recorded_on')),
      fetchAllRows(() => sb.from('usd_transactions').select('*').eq('household_id', householdId).order('trade_date').order('id')),
      fetchAllRows(() => sb.from('gold_transactions').select('*').eq('household_id', householdId).order('trade_date').order('id')),
      sb.from('loan_accounts').select('*').eq('household_id', householdId).order('start_date'),
      sb.from('loan_schedule').select('loan_account_id,due_date,amount_twd')
        .eq('entry_type', 'payment').is('applied_at', null).order('due_date').range(0, 299),
    ]);
    const failure = [itemResult.error, familyHistoryResult.error, householdResult.error, scopeHistoryResult.error].find(Boolean);
    if (failure) throw failure;
    if (!member || member.household_id !== householdId) return false;

    items = (itemResult.data ?? []).map(normalizeFinancialItem);
    history = (familyHistoryResult.data ?? []).map(row => ({ ...row, net_worth_twd: toFiniteNumber(row.net_worth_twd) }));
    scopeHistory = (scopeHistoryResult.data ?? []).map(row => ({ ...row, total_twd: toFiniteNumber(row.total_twd) }));
    householdName = householdResult.data?.name || '布布一二的家';
    fxRate = items.find(item => item.fx_rate_twd > 1 && item.quote_currency === 'USD')?.fx_rate_twd ?? fxRate;
    if (!usdResult.error) usdTransactions = usdResult.data ?? [];
    if (!goldResult.error) goldTransactions = goldResult.data ?? [];
    if (!loanResult.error) loanAccounts = loanResult.data ?? [];
    if (!nextDueResult.error) {
      loanNextDue = {};
      for (const row of nextDueResult.data ?? []) {
        // 已經按 due_date 排好，每一筆貸款第一次遇到的就是下一期
        if (!loanNextDue[row.loan_account_id]) {
          loanNextDue[row.loan_account_id] = { date: String(row.due_date), amount: Math.abs(toFiniteNumber(row.amount_twd)) };
        }
      }
    }
    // 已經載過才重載 —— 完整重載的觸發時機是交易真的變了。
    if (ledgerLoaded) {
      ledgerLoaded = false;
      await ensureLedger();
    }
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

// financial_items 變動不代表台帳變動 —— 每一輪報價更新都會寫它，realtime 再把事件
// 送回來給我們自己。照單全收就是每分鐘整包重載一次（92 KB，其中 89 KB 是交易）。
// 這裡只重抓 financial_items 本身；交易真的變了會由 klfan_transactions 的事件帶進來，
// 那一條才走完整重載。用時間窗把自己的寫入濾掉也行，但別的裝置剛好在窗口內改東西就漏了。
function scheduleItemReload() {
  if (!member) return;
  clearTimeout(itemReloadTimer);
  itemReloadTimer = setTimeout(() => {
    itemReloadTimer = null;
    void reloadItems();
  }, 300);
}

async function reloadItems() {
  if (!member) return;
  const householdId = member.household_id;
  const { data, error } = await sb.from('financial_items')
    .select('*').eq('household_id', householdId).order('sort_order');
  if (error || !member || member.household_id !== householdId) return;
  items = (data ?? []).map(normalizeFinancialItem);
  fxRate = items.find(item => item.fx_rate_twd > 1 && item.quote_currency === 'USD')?.fx_rate_twd ?? fxRate;
  render();
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
    }, scheduleItemReload)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'net_worth_history', filter: `household_id=eq.${householdId}`,
    }, scheduleRealtimeReload)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'klfan_transactions',
    }, scheduleRealtimeReload)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'loan_accounts', filter: `household_id=eq.${householdId}`,
    }, scheduleRealtimeReload)
    .subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setNonBlockingStatus('即時同步暫時中斷，資料仍可使用。', 'error');
      }
    });
}

function clearRealtime() {
  clearTimeout(realtimeReloadTimer);
  clearTimeout(itemReloadTimer);
  realtimeReloadTimer = null;
  itemReloadTimer = null;
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

const QUOTE_ERROR_COPY = {
  twelve_429: '行情商額度用完了，等一分鐘再按更新',
  twelve_401: '行情商金鑰無效',
  twelve_key_missing: '缺少行情商金鑰',
  twelve_unreachable: '連不上行情商',
  fugle_key_missing: '缺少 Fugle 金鑰',
  fugle_unreachable: '連不上 Fugle',
  price_unavailable: '行情商沒有回價格',
  fx_unavailable: '匯率抓不到',
  gold_unavailable: '金價抓不到',
  invalid_symbol: '代號有問題',
};

// 「部分行情更新失敗」本身沒有資訊量。把沒更新的標的名字與原因接上去，
// 才看得出來是額度用完（等一下就好）還是代號寫錯（要自己去改）。
function describeQuoteFailures(results) {
  const failures = (results ?? []).filter(row => row?.status === 'error');
  if (!failures.length) return '';
  const names = [...new Set(failures.map(row => row.name).filter(Boolean))];
  const reasons = [...new Set(failures.map(row => QUOTE_ERROR_COPY[row.error] ?? row.error).filter(Boolean))];
  const who = names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 筆` : names.join('、');
  return `${who}：${reasons.join('、')}`;
}

function quoteStatusCopy() {
  const lastUpdate = formatClock(quoteLastUpdatedAt);
  const suffix = lastUpdate ? ` · 更新於 ${lastUpdate}` : '';
  const why = quoteFailureNote ? `（${quoteFailureNote}）` : '';
  if (quoteStatus === 'updating') return '正在更新市場行情…';
  if (quoteStatus === 'success') return `台股、美股、黃金與匯率已更新${suffix}`;
  if (quoteStatus === 'partial') return `部分行情更新失敗${why}，沿用上一筆價格${suffix}`;
  if (quoteStatus === 'error') return `行情更新失敗${why}，沿用上一筆價格${suffix}`;
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
  // 節流的門檻要低於整輪的間隔，不然計時器早個幾毫秒觸發就會被自己擋掉。
  if (!force && Date.now() - quoteLastAt < QUOTE_FULL_INTERVAL_MS / 2) return null;
  quoteLastAt = Date.now();
  quoteStatus = 'updating';
  updateQuoteStatusUi();

  quoteFlight = (async () => {
    // 以前這裡會連 KLFAN 的 refresh-klfan-quotes 一起叫，但兩支抓的是完全一樣的
    // 8 檔，等於自己跟自己搶 Twelve Data 每分鐘 8 credits 的額度。klfan_quotes 的
    // 寫回與修剪已經由 refresh-tw-quotes 接手，這支就不必再叫了。
    const { data, error } = await sb.functions.invoke('refresh-tw-quotes', { body: {} });
    if (error) {
      quoteStatus = 'error';
      quoteFailureNote = '';
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
    // 只說「部分行情更新失敗」等於什麼都沒說 —— 把哪幾筆、什麼原因帶出來，
    // 不然每次都要翻資料庫的 updated_at 才知道是誰沒更新。
    quoteFailureNote = failed > 0 ? describeQuoteFailures(data?.results) : '';
    saveQuoteTimestamp(data?.requestedAt || new Date().toISOString());

    // 報價更新只改價格，交易一筆都沒動 —— 以前這裡整包重載，等於每分鐘為了幾個股價
    // 把 1489 筆交易（92 KB，其中 89 KB 是交易）再拉一次。改成只補報價那 3 KB。
    if (toFiniteNumber(data?.updated) > 0) await applyQuoteRefresh(data);
    render();
    return data;
  })().catch(() => {
    quoteStatus = 'error';
    quoteFailureNote = '';
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
  root.innerHTML = `<header class="topbar"><div class="brand"><div class="logo">KS</div><div><h1>${title}</h1></div></div><div class="headActions"><button class="iconBtn" id="mask" title="隱藏金額">${masked ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.86 21.86 0 0 1 5.06-6.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.86 21.86 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>'}</button><button class="iconBtn avatar" id="logout" title="登出">${escapeHtml(String(session.user.user_metadata?.display_name || session.user.email || 'KS').slice(0, 2))}</button></div></header><div class="status ${quoteStatus}"><i></i><span data-status-text>${quoteStatusCopy()}</span><button id="reload" ${quoteStatus === 'updating' ? 'disabled' : ''}>${quoteStatus === 'updating' ? '更新中' : '更新行情'}</button></div><main class="content">${body}</main>${showAdd ? '<button class="fab" id="add" aria-label="新增財務項目">＋</button>' : ''}<nav class="bottomNav">${tabs.map(item => `<button data-tab="${item[0]}" class="${tab === item[0] ? 'on' : ''}" aria-label="${item[2]}"><span>${item[1]}</span></button>`).join('')}</nav>`;

  bindTrendChart(root.querySelector('[data-trend-chart]'));
  root.querySelector('#logout').onclick = () => sb.auth.signOut();
  root.querySelector('#reload').onclick = () => refreshQuotes({ force: true });
  root.querySelector('#mask').onclick = () => { masked = !masked; render(); };
  root.querySelector('.bottomNav').onclick = event => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    tab = button.dataset.tab;
    // 在分析頁時 render() 會直接回傳分析畫面，不先收掉就切不出去。
    // 有推過歷史就用 history.back()，交給 popstate 收 —— 免得歷史多留一筆。
    if (analysisScreen) {
      analysisReturnScroll = 0;   // 切到別的分頁是換畫面，不是返回
      if (analysisPushed) return window.history.back();
      analysisScreen = null;
      expandedStock = null;
    }
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

  const distributionKind = distributionMode.dashboard;
  const distributionRows = distributionKind === 'asset' ? family.assets : family.liabilities;
  const distributionTotal = distributionKind === 'asset' ? family.totalAssets : family.totalLiabilities;
  const distributionTitle = distributionKind === 'asset' ? '家庭資產分布' : '家庭負債分布';

  shell(`<section class="portfolioHero"><div class="heroLabel"><span>家庭淨資產</span><span>老公＋老婆</span></div><div class="bigMoney">${formatMoney(family.netWorth)}</div><div class="miniStats"><div><span>家庭總資產</span><b>NT$ ${formatNumber(family.totalAssets)}</b></div><div><span>家庭總負債</span><b>NT$ ${formatNumber(family.totalLiabilities)}</b></div></div></section>${trendChart(familyTrendRows(family.netWorth))}${distributionPanel(distributionRows, distributionTotal, distributionTitle, distributionKind)}${ownerDistribution}`, '家庭');
}

function distributionPanel(rows, total, title, kind) {
  const groups = calculateAllocation(rows, total);
  let cursor = 0;
  const segments = groups.map(({ category, percent }) => {
    const start = cursor;
    cursor += percent;
    return `${colors[category] || '#7e8798'} ${start}% ${cursor}%`;
  }).join(',') || '#dcebe6 0 100%';
  const centerLabel = kind === 'asset' ? '資產分布' : '負債分布';
  const targetLabel = kind === 'asset' ? '負債' : '資產';
  return `<section class="panel distributionPanel"><div class="panelTitle"><div><h2>${title}</h2></div><div class="distributionActions"><span>${groups.length} 類</span><button class="distributionToggle" data-distribution-toggle>${targetLabel}</button></div></div><div class="allocation"><div class="donut" data-label="${centerLabel}" style="--segments:${segments}"></div><div class="legend">${groups.map(({ category, percent }) => `<div class="legendRow"><i style="background:${colors[category] || '#7e8798'}"></i><span>${escapeHtml(category)}</span><b>${percent.toFixed(1)}%</b></div>`).join('')}</div></div></section>`;
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
    // 分類裡面照金額由大到小 —— 原本是 sort_order，等於建立的先後，
    // 展開後最小的那筆常常排在最上面。
    rows.sort((a, b) => b.amount_twd - a.amount_twd || a.name.localeCompare(b.name, 'zh-Hant'));
    const key = encodeURIComponent(`${ownerScope}|${kind}|${category}`);
    const groupTotal = rows.reduce((sum, item) => sum + item.amount_twd, 0);
    const open = openGroups.has(key);
    return `<section class="categoryGroup ${open ? 'open' : ''}"><button class="categoryHead" data-group="${key}"><div><span>${escapeHtml(category)}</span><small>${rows.length} 筆</small></div><div class="categoryTotal"><b>NT$ ${formatNumber(groupTotal)}</b><i>⌄</i></div></button>${open ? `<div class="categoryItems">${rows.map(item => itemCard(item, total)).join('')}</div>` : ''}</section>`;
  }).join('');
}

// 資產頁上只放入口，數字留在分析頁裡面講。
function analysisEntry() {
  return `<div class="analysisEntry"><button data-open-portfolio>股票分析<i>›</i></button><button data-open-loans>貸款分析<i>›</i></button><button data-open-gold>黃金分析<i>›</i></button><button data-open-usd>美金分析<i>›</i></button></div>`;
}

// 分析頁只看單一個人的部位。編輯表單與 syncPortfolioFinancialItem() 則是照 key 找標的、
// 跟歸屬無關，走下面的 portfolioPosition()。
const ownerName = ownerScope => ownerScope === 'wife' ? '老婆' : '老公';

// 用 key 找台帳裡的一檔。編輯表單與台帳同步要的只有名稱、市場、股數與市值 ——
// 一檔現算就好。以前這裡靠 portfolioModel，那是整份台帳（39 檔、1489 筆交易，
// 外加台股／美股／全部三個總計 XIRR）算出來的，光是為了查一個 key 就重算一次，
// 而且每分鐘報價更新完還會再算一遍。順帶把匯率過時的問題一起解掉：現算一定用當下的
// fxRate，不會停在上一次重算時的匯率。
function portfolioPosition(key) {
  if (!key) return null;
  const stock = portfolioStocks.find(row => row.key === key);
  return stock ? calculateStockValue(stock, fxRate) : null;
}

// 分析頁每次 render() 都會走到這裡，但 render() 多半是「展開一張卡片」這種純畫面的事，
// 數字一個都沒動。會讓數字變的只有四件事，全部進指紋：台帳整份換掉（重載一定是新陣列）、
// 匯率、報價（唯一會就地改到 portfolioStocks 的欄位），以及跨過午夜換日期。
let portfolioModelCache = { key: null, stocks: null, value: null };
function ownerPortfolioModel(ownerScope) {
  const quoteSignature = portfolioStocks.map(stock => stock.quote?.price ?? '').join(',');
  const key = `${ownerScope}|${fxRate}|${taipeiDate()}|${quoteSignature}`;
  if (portfolioModelCache.stocks === portfolioStocks && portfolioModelCache.key === key) {
    return portfolioModelCache.value;
  }
  const value = calculatePortfolio(portfolioStocks.filter(stock => stock.ownerScope === ownerScope), fxRate);
  portfolioModelCache = { key, stocks: portfolioStocks, value };
  return value;
}

function ownerUsdModel(ownerScope) {
  return calculateUsd(usdTransactions.filter(row => (row.owner_scope ?? 'husband') === ownerScope), fxRate);
}

function ownerGoldModel(ownerScope) {
  return calculateGold(
    goldTransactions.filter(row => (row.owner_scope ?? 'husband') === ownerScope),
    items.filter(item => item.owner_scope === ownerScope && item.market === 'GOLD'),
  );
}

function portfolioSummaryCards(bucket) {
  const tone = bucket.profitTwd >= 0 ? 'up' : 'down';
  return `<div class="portfolioSummary"><div class="portfolioMetric"><span>目前市值</span><b>NT$ ${formatNumber(bucket.currentValueTwd)}</b><small>${bucket.holdings} 檔持有中</small></div><div class="portfolioMetric"><span>累計淨投入</span><b>NT$ ${formatNumber(bucket.netInvestedTwd)}</b><small>買進－賣出－股息</small></div><div class="portfolioMetric"><span>累計損益</span><b class="${tone}">NT$ ${formatNumber(bucket.profitTwd)}</b><small>${formatPercent(bucket.returnRate)}</small></div><div class="portfolioMetric"><span>年化報酬率</span><b>${formatPercent(bucket.xirr)}</b><small>計入每筆買賣的時點</small></div></div>`;
}

const shareFormat = value => sixDigitFormatter.format(value);
const signedMoney = value => `${value >= 0 ? '+' : '−'}NT$ ${formatNumber(Math.abs(value))}`;

function portfolioStockDetail(stock) {
  // 剛好是零就不上漲跌色，紅綠留給真的有賺賠的時候。
  const tone = value => Math.round(value) === 0 ? '' : value > 0 ? 'up' : 'down';
  const pair = (aLabel, aValue, aTone, bLabel, bValue, bTone) =>
    `<div class="portfolioPair"><div><span>${aLabel}</span><b class="${aTone}">${aValue}</b></div><div><span>${bLabel}</span><b class="${bTone}">${bValue}</b></div></div>`;
  const rows = stock.transactions.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const live = stock.quote?.price > 0;
  return `<div class="portfolioStockDetail">
    ${pair('已實現損益', signedMoney(stock.realizedTwd), tone(stock.realizedTwd), '未實現損益', signedMoney(stock.unrealizedTwd), tone(stock.unrealizedTwd))}
    ${pair('累計股息', `NT$ ${formatNumber(stock.dividendsTwd)}`, '', `目前股價${live ? ' · 即時' : ''}`, `${stock.currency === 'USD' ? 'US$' : 'NT$'} ${formatNumber(stock.price)}`, '')}
    ${pair('投資期間', stock.holdingYears === null ? '—' : `${stock.holdingYears.toFixed(2)} 年`, '', '持有股數', `${shareFormat(stock.shares)} 股`, '')}
    <div class="sectionHead"><b>交易紀錄</b><span>${rows.length} 筆</span></div>
    <div class="portfolioTxList">${rows.length ? rows.map(tx => transactionRow(tx, stock)).join('') : '<div class="portfolioEmpty">還沒有交易。</div>'}</div>
  </div>`;
}

function portfolioStockCard(stock, expanded) {
  const tone = stock.profitTwd >= 0 ? 'up' : 'down';
  return `<article class="portfolioStockCard ${expanded ? 'open' : ''}"><button class="portfolioStockSummary" data-portfolio-stock="${escapeHtml(stock.key)}"><div class="portfolioStockTop"><div><b>${escapeHtml(stock.display)}</b></div><div><b>NT$ ${formatNumber(stock.currentValueTwd)}</b></div></div><div class="portfolioStockMeta"><div><span>累計損益</span><b class="${tone}">NT$ ${formatNumber(stock.profitTwd)}</b></div><div><span>年化報酬率</span><b class="${tone}">${formatPercent(stock.xirr)}</b></div></div></button>${expanded ? portfolioStockDetail(stock) : ''}</article>`;
}

function portfolioListPage() {
  const model = ownerPortfolioModel(analysisOwner);
  const marketRows = portfolioMarket === 'all'
    ? model.positions
    : model.positions.filter(stock => stock.market === portfolioMarket);
  const rows = marketRows.filter(stock => portfolioShowExited || stock.shares > 0.0000001)
    .sort((a, b) => b.currentValueTwd - a.currentValueTwd || a.display.localeCompare(b.display, 'zh-Hant'));
  const bucket = portfolioMarket === '台股' ? model.tw : portfolioMarket === '美股' ? model.us : model.all;
  shell(`<div class="portfolioView"><div class="seg"><button data-portfolio-market="all" class="${portfolioMarket === 'all' ? 'on' : ''}">全部</button><button data-portfolio-market="台股" class="${portfolioMarket === '台股' ? 'on' : ''}">台股</button><button data-portfolio-market="美股" class="${portfolioMarket === '美股' ? 'on' : ''}">美股</button></div>${portfolioSummaryCards(bucket)}<label class="portfolioToolbar"><span>${rows.length} 檔標的</span><span><input type="checkbox" data-show-exited ${portfolioShowExited ? 'checked' : ''}> 顯示已出清</span></label><div class="portfolioList">${rows.length ? rows.map(stock => portfolioStockCard(stock, stock.key === expandedStock)).join('') : '<div class="portfolioEmpty">這個篩選條件目前沒有標的。</div>'}</div></div>`, `${ownerName(analysisOwner)}股票分析`);
  root.querySelectorAll('[data-portfolio-market]').forEach(button => { button.onclick = () => { portfolioMarket = button.dataset.portfolioMarket; render(); }; });
  root.querySelector('[data-show-exited]').onchange = event => { portfolioShowExited = event.target.checked; render(); };
  root.querySelectorAll('[data-portfolio-stock]').forEach(button => { button.onclick = () => {
    // 就地展開，不再跳頁；再點一次收起來。
    const key = button.dataset.portfolioStock;
    expandedStock = expandedStock === key ? null : key;
    renderKeepingAnchor('data-portfolio-stock', key);
  }; });
  root.querySelectorAll('[data-delete-portfolio-tx]').forEach(button => { button.onclick = async () => {
    if (!confirm('確定刪除這筆交易？')) return;
    button.disabled = true;
    const { error } = await sb.from('klfan_transactions').delete().eq('id', Number(button.dataset.deletePortfolioTx));
    if (error) { button.disabled = false; return setNonBlockingStatus(error.message, 'error'); }
    await loadData({ blocking: false });
    await syncPortfolioFinancialItem(expandedStock);
    await loadData({ blocking: false });
  }; });
}

function transactionRow(transaction, stock) {
  const positive = transaction.amount >= 0;
  const currency = stock.currency === 'USD' ? 'US$' : 'NT$';
  const action = transaction.kind === 'dividend' ? '股息' : transaction.shares < 0 ? '賣出' : '買進';
  return `<div class="portfolioTx"><div class="portfolioTxWhen"><b>${action}</b><small>${escapeHtml(transaction.date)} · ${escapeHtml(transaction.bank || '未填帳戶')}</small></div><div class="portfolioTxAmount"><b class="${positive ? 'positive' : 'negative'}">${positive ? '+' : '−'}${currency} ${twoDigitFormatter.format(Math.abs(transaction.amount))}</b><small>${transaction.shares ? `${transaction.shares > 0 ? '+' : ''}${transaction.shares} 股` : escapeHtml(transaction.note)}</small></div><button class="portfolioTxDelete" type="button" data-delete-portfolio-tx="${transaction.id}">刪除</button></div>`;
}

async function syncPortfolioFinancialItem(stockKey, { ownerScope, notes } = {}) {
  const metrics = portfolioPosition(stockKey);
  if (!metrics) return;
  const linked = items.find(item => item.portfolio_stock_key === stockKey);
  const market = metrics.market === '美股' ? 'US' : 'TW';
  const symbol = String(metrics.symbol || metrics.key).replace(/^[A-Za-z0-9]+:/, '').toUpperCase();
  const payload = {
    household_id: member.household_id,
    // 沒有指定就沿用這一列現在的歸屬 —— 寫死 husband 會在同步時把設成老婆的標的搬回老公。
    owner_scope: ownerScope ?? linked?.owner_scope ?? 'husband',
    kind: 'asset',
    category: market === 'US' ? '美股' : '台股', name: metrics.display,
    amount_twd: Math.max(0, metrics.currentValueTwd), symbol, market,
    quantity: Math.max(0, metrics.shares), quote_currency: metrics.currency,
    quote_source: market === 'US' ? 'twelve_data' : 'fugle',
    fx_rate_twd: market === 'US' ? fxRate : 1,
    portfolio_stock_key: stockKey, updated_by: session.user.id, updated_at: new Date().toISOString(),
  };
  if (notes !== undefined) payload.notes = notes;
  const result = linked
    ? await sb.from('financial_items').update(payload).eq('id', linked.id).eq('household_id', member.household_id)
    : metrics.shares > 0.0000001
      ? await sb.from('financial_items').insert({ ...payload, created_by: session.user.id })
      : { error: null };
  if (result.error) throw result.error;
}

function analysisPage() {
  if (analysisScreen === 'usd') return usdPage();
  if (analysisScreen === 'gold') return goldPage();
  if (analysisScreen === 'loans') return loanPage();
  // 點進來才去載台帳，載好會再 render 一次。
  if (!ledgerLoaded) {
    return shell('<div class="portfolioView"><div class="portfolioEmpty">載入交易紀錄…</div></div>',
      `${ownerName(analysisOwner)}股票分析`);
  }
  portfolioListPage();
}

const gramFormat = value => masked
  ? '\u2022\u2022\u2022\u2022'
  : fourDigitFormatter.format(toFiniteNumber(value));

function goldTransactionRow(row) {
  return `<div class="portfolioTx goldTx"><div class="portfolioTxWhen"><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.date)}${row.note ? ` · ${escapeHtml(row.note)}` : ''}</small></div><div class="portfolioTxAmount"><b class="negative">−NT$ ${formatNumber(row.costTwd)}</b><small>${gramFormat(row.grams)} g${row.workmanshipTwd ? ` · 含工錢 NT$ ${formatNumber(row.workmanshipTwd)}` : ''}${!row.stillHeld ? ' · 已送出，只留紀錄' : row.includeInPerformance ? '' : ' · 不計入年化'}</small></div></div>`;
}

// 目前重量與市值沿用資產頁的即時黃金行情；成本與投入時點來自 KLFAN 黃金工作表。
function goldPage() {
  const model = ownerGoldModel(analysisOwner);
  const rows = [...model.rows].reverse();
  const resultTone = model.trackedProfitTwd >= 0 ? 'up' : 'down';
  // 送出去的克數不進部位也不進核對，只在後面補一句說有這幾筆紀錄在
  const givenNote = model.givenGrams ? `；另有 ${gramFormat(model.givenGrams)} g 已送出，只留紀錄` : '';
  // 對得起來就不用講話 —— 重量跟「納入年化投入成本」那一格的克數是同一個數字，再寫一次是重複。
  // 對不起來才要出聲，不然少了買進成本會靜靜地不見。
  const reconciliation = model.reconciled ? ''
    : `<div class="goldReconcile warn"><b>尚有 ${gramFormat(model.untrackedGrams)} g 缺少買進成本</b><span>資產頁 ${gramFormat(model.holdingGrams)} g；台帳已記錄 ${gramFormat(model.trackedGrams + model.excludedGrams)} g。下方報酬不把差額當成零成本${givenNote}。</span></div>`;
  shell(`<div class="portfolioView"><div class="portfolioSummary"><div class="portfolioMetric"><span>納入年化投入成本</span><b>NT$ ${formatNumber(model.trackedCostTwd)}</b><small>${gramFormat(model.trackedGrams)} g</small></div><div class="portfolioMetric"><span>納入年化目前價值</span><b>NT$ ${formatNumber(model.trackedValueTwd)}</b><small>目前金價＋工錢 NT$ ${formatNumber(model.retainedWorkmanshipTwd)}</small></div><div class="portfolioMetric"><span>納入年化損益</span><b class="${resultTone}">NT$ ${formatNumber(model.trackedProfitTwd)}</b><small>${formatPercent(model.trackedReturnRate)}</small></div><div class="portfolioMetric"><span>年化報酬率</span><b class="${resultTone}">${formatPercent(model.xirr)}</b><small>排除標記不計入的紀錄</small></div></div>${reconciliation}<div class="sectionHead"><span>買進紀錄${model.firstTradeDate ? ` · 自 ${escapeHtml(model.firstTradeDate)}` : ''}</span><b>${model.transactions} 筆</b></div><div class="portfolioTxList">${rows.length ? rows.map(goldTransactionRow).join('') : '<div class="portfolioEmpty">還沒有黃金成本紀錄。</div>'}</div></div>`, `${ownerName(analysisOwner)}黃金分析`);
}

function ownerLoanRows(ownerScope) {
  return loanAccounts
    .filter(account => account.owner_scope === ownerScope)
    .map(account => {
      const linked = items.find(item => item.id === account.financial_item_id);
      return {
        ...account,
        currentBalance: account.status === 'active' ? toFiniteNumber(linked?.amount_twd) : 0,
        monthlyPayment: toFiniteNumber(linked?.monthly_payment_twd ?? account.contractual_monthly_payment_twd),
        annualRate: toFiniteNumber(linked?.interest_rate ?? account.nominal_annual_rate),
      };
    });
}

const normalizedLoanType = account => account.loan_type === 'topup'
  ? 'topup'
  : account.loan_type === 'mortgage' ? 'mortgage' : 'personal';

const loanTypeName = type => type === 'topup' ? '增貸' : type === 'mortgage' ? '房貸' : '信貸';

// 有 actual_date 的列才是銀行 App 已核對的實際繳款；舊資料若沒有實際日，
// 到期後仍會列在歷史區，但明確標成排程，不冒充實際扣款。
//
// 排程有一千九百多列，貸款頁一次要畫好幾張卡，而展開的那一筆卡片本體與明細各要一份 ——
// 以前每一次呼叫都把整份排程從頭 filter 一遍再算一次 XIRR。這裡改成：
// 依貸款分組一次，算過的結果留著。快取綁在 loanSchedule 這個陣列本身（重載一定是新陣列）
// 與台北日期上，兩者只要有一個換了就整包丟掉，不會拿到昨天的「下次繳款」。
let loanCashflowCache = { schedule: null, today: null, rows: null, plans: null };
function loanScheduleFor(accountId, today = taipeiDate()) {
  if (loanCashflowCache.schedule !== loanSchedule || loanCashflowCache.today !== today) {
    const rows = new Map();
    for (const row of loanSchedule) {
      const list = rows.get(row.loan_account_id);
      if (list) list.push(row);
      else rows.set(row.loan_account_id, [row]);
    }
    loanCashflowCache = { schedule: loanSchedule, today, rows, plans: new Map() };
  }
  const cached = loanCashflowCache.plans.get(accountId);
  if (cached) return cached;
  const plan = calculateLoanCashflow(loanCashflowCache.rows.get(accountId) ?? [], today);
  loanCashflowCache.plans.set(accountId, plan);
  return plan;
}

function loanCashflowRow(row, fallback) {
  const shownDate = row.actual_date || row.due_date;
  const dueNote = row.actual_date && row.actual_date !== row.due_date ? `應繳 ${row.due_date}` : '';
  const balanceNote = toFiniteNumber(row.balance_after_twd) > 0 ? `繳後本金 NT$ ${formatNumber(row.balance_after_twd)}` : '';
  return `<div class="loanPlanRow"><div><time>${escapeHtml(shownDate)}</time>${dueNote ? `<small>${escapeHtml(dueNote)}</small>` : ''}</div><div><small>${escapeHtml(row.note || fallback)}</small><b>NT$ ${formatNumber(Math.abs(row.amount))}</b>${balanceNote ? `<small>${escapeHtml(balanceNote)}</small>` : ''}</div></div>`;
}

function loanScheduleDetail(account) {
  const plan = loanScheduleFor(account.id);
  const feesPending = String(account.source_note || '').includes('其他費用待補');
  if (!plan.entries.length) return '<div class="loanDetail"><small>這一筆沒有現金流資料。</small></div>';
  const shown = plan.upcoming.slice(0, 12);
  const rest = plan.upcoming.length - shown.length;
  const historyLabel = '過往繳款';
  return `<div class="loanDetail"><div class="portfolioPair loanCashflowMetrics"><div><span>下次繳款</span><b>${plan.next ? escapeHtml(plan.next.due_date) : '已繳完'}</b></div><div><span>金額</span><b>${plan.next ? 'NT$ ' + formatNumber(Math.abs(plan.next.amount)) : '—'}</b></div><div><span>實收金額</span><b>NT$ ${formatNumber(plan.netProceeds)}</b></div><div><span>其他費用</span><b>${feesPending ? '—' : 'NT$ ' + formatNumber(plan.totalFees)}</b></div><div><span>已繳期數</span><b>${plan.pastPayments.length} / ${plan.payments.length}</b></div><div><span>過往已繳</span><b>NT$ ${formatNumber(plan.paidPayments)}</b></div><div><span>剩餘應還</span><b>NT$ ${formatNumber(plan.remaining)}</b></div><div><span>全期利息與費用</span><b>${feesPending ? '—' : 'NT$ ' + formatNumber(plan.totalInterestAndFees)}</b></div></div>${plan.inflows.length ? `<section class="loanFlowSection"><div class="sectionHead"><span>撥款</span><b>${plan.inflows.length} 筆</b></div><div class="loanPlan">${plan.inflows.map(row => loanCashflowRow(row, '撥款')).join('')}</div></section>` : ''}${plan.fees.length ? `<section class="loanFlowSection"><div class="sectionHead"><span>其他費用</span><b>NT$ ${formatNumber(plan.totalFees)}</b></div><div class="loanPlan">${plan.fees.map(row => loanCashflowRow(row, '開辦費')).join('')}</div></section>` : ''}${plan.pastPayments.length ? `<section class="loanFlowSection"><div class="sectionHead"><span>${historyLabel}</span><b>${plan.pastPayments.length} 期</b></div><div class="loanPlan">${plan.pastPayments.map(row => loanCashflowRow(row, row.actual_date ? '實際繳款' : '歷史還款排程')).join('')}</div></section>` : ''}${shown.length ? `<section class="loanFlowSection loanFutureSection"><div class="sectionHead"><span>未來繳款</span><b>${plan.upcoming.length} 期</b></div><div class="loanPlan">${shown.map(row => loanCashflowRow(row, '預計繳款')).join('')}</div>${rest > 0 ? `<small class="loanFoot">還有 ${rest} 期，最後一期 ${escapeHtml(plan.last.due_date)}</small>` : ''}</section>` : ''}</div>`;
}

function loanAccountCard(account, expanded = false) {
  const active = account.status === 'active';
  const original = toFiniteNumber(account.original_principal_twd);
  const paidPrincipal = Math.max(0, original - account.currentBalance);
  const progress = original > 0 ? Math.min(100, paidPrincipal / original * 100) : 0;
  const totalRepayment = toFiniteNumber(account.projected_total_repayment_twd);
  const borrowingCost = totalRepayment > original ? totalRepayment - original : 0;
  const plan = loanScheduleFor(account.id);
  const feesPending = String(account.source_note || '').includes('其他費用待補');
  // 排程還沒載入時 plan.annualCost 是 null，退回主檔存的那個值。fallback 一定要是 null ——
  // toFiniteNumber 預設吐 0，沒存年化成本的貸款就會變成「實際年化成本 0.00%」，
  // 等排程載進來才跳成真的數字。算不出來就該顯示「—」。
  const annualCost = feesPending ? null : (plan.annualCost ?? toFiniteNumber(account.effective_annual_cost, null));
  const dateLabel = active ? '預計到期' : '結清日期';
  const dateValue = active ? account.maturity_date : account.closed_on;
  const loanTypeLabel = loanTypeName(normalizedLoanType(account));
  const showNominalRate = active || normalizedLoanType(account) !== 'personal';
  const nominalRateFact = showNominalRate
    ? `<div><span>表定利率</span><b>${account.annualRate > 0 ? account.annualRate.toFixed(2) + '%' : '—'}</b></div>`
    : '';
  return `<article class="loanCard ${expanded ? 'open' : ''}" data-loan-card="${escapeHtml(account.id)}"><button type="button" class="loanCardTap" data-loan-account="${escapeHtml(account.id)}"><div class="loanCardHead"><div><b>${escapeHtml(account.name)}</b><small>${escapeHtml(account.lender)} · ${escapeHtml(loanTypeLabel)}</small></div><span class="loanStatus ${active ? 'active' : ''}">${active ? '進行中' : '已結清'}</span></div><div class="loanBalance"><span>${active ? '目前本金餘額' : '原貸款金額'}</span><b>NT$ ${formatNumber(active ? account.currentBalance : original)}</b></div><div class="loanProgress"><i style="--progress:${progress}%"></i></div><div class="loanFacts"><div><span>原貸款</span><b>NT$ ${formatNumber(original)}</b></div>${nominalRateFact}<div><span>${active ? '每月還款' : '總還款'}</span><b>${active ? 'NT$ ' + formatNumber(account.monthlyPayment) : totalRepayment ? 'NT$ ' + formatNumber(totalRepayment) : '—'}</b></div><div><span>實際年化成本</span><b>${annualCost !== null && Number.isFinite(annualCost) ? (annualCost * 100).toFixed(2) + '%' : '—'}</b></div><div><span>${dateLabel}</span><b>${dateValue ? escapeHtml(dateValue) : '—'}</b></div><div><span>全期利息與費用</span><b>${feesPending ? '—' : 'NT$ ' + formatNumber(plan.totalInterestAndFees || borrowingCost)}</b></div></div>${active ? `<small class="loanFoot">已償還本金約 NT$ ${formatNumber(paidPrincipal)} · ${progress.toFixed(1)}%</small>` : `<small class="loanFoot">實際年化成本已納入開辦費、提前清償與每筆現金流日期</small>`}</button>${expanded ? loanScheduleDetail(account) : ''}</article>`;
}

function loanPage() {
  const rows = ownerLoanRows(analysisOwner)
    .filter(account => normalizedLoanType(account) === loanTypeFilter);
  const active = rows
    .filter(account => account.status === 'active')
    .sort((a, b) => a.currentBalance - b.currentBalance
      || String(a.name).localeCompare(String(b.name), 'zh-Hant'));
  const closed = rows.filter(account => account.status === 'closed');
  const totalBalance = active.reduce((sum, account) => sum + account.currentBalance, 0);
  const totalMonthly = active.reduce((sum, account) => sum + account.monthlyPayment, 0);
  const weightedRate = totalBalance
    ? active.reduce((sum, account) => sum + account.currentBalance * account.annualRate, 0) / totalBalance
    : 0;
  const daily = totalMonthly * 12 / 365;
  const typeName = loanTypeName(loanTypeFilter);
  shell(`<div class="portfolioView"><div class="seg loanTypeSeg"><button data-loan-type="personal" class="${loanTypeFilter === 'personal' ? 'on' : ''}">信貸</button><button data-loan-type="topup" class="${loanTypeFilter === 'topup' ? 'on' : ''}">增貸</button><button data-loan-type="mortgage" class="${loanTypeFilter === 'mortgage' ? 'on' : ''}">房貸</button></div><div class="portfolioSummary loanSummary"><div class="portfolioMetric"><span>目前貸款餘額</span><b>NT$ ${formatNumber(totalBalance)}</b><small>${active.length} 筆進行中</small></div><div class="portfolioMetric"><span>每月還款</span><b>NT$ ${formatNumber(totalMonthly)}</b><small>平均每天 NT$ ${formatNumber(daily)}</small></div><div class="portfolioMetric"><span>加權平均利率</span><b>${weightedRate.toFixed(2)}%</b><small>按目前本金加權</small></div><div class="portfolioMetric"><span>已結清</span><b>${closed.length} 筆</b><small>保留歷史紀錄</small></div></div><div class="sectionHead"><span>進行中${typeName}</span><b>${active.length} 筆</b></div><div class="loanList">${active.length ? active.map(account => loanAccountCard(account, account.id === expandedLoan)).join('') : `<div class="portfolioEmpty">目前沒有進行中的${typeName}。</div>`}</div>${closed.length ? `<div class="sectionHead"><span>已結清${typeName}</span><b>${closed.length} 筆</b></div><div class="loanList">${closed.map(account => loanAccountCard(account, account.id === expandedLoan)).join('')}</div>` : ''}</div>`, `${ownerName(analysisOwner)}貸款分析`);

  root.querySelectorAll('[data-loan-type]').forEach(button => { button.onclick = () => {
    loanTypeFilter = button.dataset.loanType;
    expandedLoan = null;
    render();
  }; });

  bindLoanCards();
}

// 收放只換那一張卡片，不重繪整頁。重繪的話收合時頁面變矮，瀏覽器先把捲動量夾到新的
// 底部、錨點補正再拉一次，看起來就是跳一下；只換一張卡片就沒有這兩次強制捲動。
// 換的是整張卡片而不是只加減明細節點，因為 loan-ui-fix.js 會把卡片上的欄位搬進展開的
// 明細裡 —— 直接把明細拿掉會連那些被搬走的欄位一起刪掉。
function bindLoanCards() {
  root.querySelectorAll('[data-loan-account]').forEach(button => { button.onclick = () => {
    const id = button.dataset.loanAccount;
    // 被點的那張要留在原地。一次只開一張，所以點下面那張時，上面那張會同時收起來 ——
    // 收起來的高度差會把下面的內容整個往上拉，這就是「點開卻跳走」的來源。
    const topBefore = loanCardTop(id);
    expandedLoan = expandedLoan === id ? null : id;
    const accounts = ownerLoanRows(analysisOwner);
    root.querySelectorAll('.loanCard').forEach(card => {
      const key = card.dataset.loanCard;
      const shouldOpen = key === expandedLoan;
      if (card.classList.contains('open') === shouldOpen) return;   // 這張沒變就別動
      const account = accounts.find(row => row.id === key);
      if (account) card.outerHTML = loanAccountCard(account, shouldOpen);
    });
    bindLoanCards();   // outerHTML 會換掉節點，事件要重綁
    pinLoanCard(id, topBefore);
  }; });
}

function loanCardTop(id) {
  const card = root.querySelector(`.loanCard[data-loan-card="${String(id).replace(/["\\]/g, '\\$&')}"]`);
  return card ? card.getBoundingClientRect().top : null;
}

// 把卡片頂端拉回原本在視窗裡的位置。
//
// loan-ui-fix.js 用 MutationObserver 在後面的 frame 繼續搬 DOM（把卡片上的欄位移進明細、
// 拿掉 loanFoot），而它自己的改動又會再觸發自己一輪，所以高度要好幾個 frame 才會穩。
// 固定補正三次會漏掉最後一次改動 —— 實測會間歇性地從 371 掉到 641。
// 改成一直補到「連兩個 frame 都沒再動」為止，最多 20 個 frame（捲不動時不會空轉太久）。
const PIN_MAX_FRAMES = 20;
function pinLoanCard(id, topBefore) {
  if (topBefore === null) return;
  let steady = 0;
  let frames = 0;
  const settle = () => {
    const topNow = loanCardTop(id);
    if (topNow === null) return true;
    const drift = topNow - topBefore;
    if (Math.abs(drift) > 0.5) {
      window.scrollTo(0, window.scrollY + drift);
      steady = 0;
      return false;
    }
    steady += 1;
    return steady >= 2;
  };
  if (settle()) return;
  const tick = () => {
    frames += 1;
    if (settle() || frames >= PIN_MAX_FRAMES) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const usdFormat = value => masked
  ? '\u2022\u2022\u2022\u2022\u2022\u2022'
  : decimalFormatter.format(toFiniteNumber(value));
const rateFormat = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Number(value).toFixed(3)
  : '\u2014';

// 對照 KLFAN 試算表「美金」工作表的那塊「美元資產績效（全部以新台幣計算）」。
function usdPage() {
  const model = ownerUsdModel(analysisOwner);
  const tone = value => value >= 0 ? 'up' : 'down';
  const rows = [...model.rows].reverse();
  shell(`<div class="portfolioView"><div class="portfolioSummary"><div class="portfolioMetric"><span>目前美元部位</span><b>US$ ${usdFormat(model.balance)}</b><small>加權平均成本 ${rateFormat(model.averageCost)}</small></div><div class="portfolioMetric"><span>目前台幣市值</span><b>NT$ ${formatNumber(model.marketValueTwd)}</b><small>目前匯率 ${rateFormat(model.currentRate)}</small></div><div class="portfolioMetric"><span>累計淨投入</span><b>NT$ ${formatNumber(model.netInvestedTwd)}</b><small>買進－賣出</small></div><div class="portfolioMetric"><span>剩餘美元成本</span><b>NT$ ${formatNumber(model.remainingCostTwd)}</b><small>移動加權平均</small></div><div class="portfolioMetric"><span>已實現匯兌損益</span><b class="${tone(model.realizedTwd)}">NT$ ${formatNumber(model.realizedTwd)}</b><small>賣出時認列</small></div><div class="portfolioMetric"><span>未實現匯兌損益</span><b class="${tone(model.unrealizedTwd)}">NT$ ${formatNumber(model.unrealizedTwd)}</b><small>市值－剩餘成本</small></div><div class="portfolioMetric"><span>總匯兌損益</span><b class="${tone(model.totalProfitTwd)}">NT$ ${formatNumber(model.totalProfitTwd)}</b><small>已實現＋未實現</small></div><div class="portfolioMetric"><span>年化報酬率</span><b>${formatPercent(model.xirr)}</b><small>計入每筆買賣的時點</small></div></div><div class="sectionHead"><span>交易紀錄${model.firstTradeDate ? ` · 自 ${escapeHtml(model.firstTradeDate)}` : ''}</span><b>${model.transactions} 筆</b></div><div class="portfolioTxList">${rows.length ? rows.map(usdTransactionRow).join('') : '<div class="portfolioEmpty">還沒有美金交易，按右下角 ＋ 記第一筆。</div>'}</div></div>`, `${ownerName(analysisOwner)}美金分析`, true);

  root.querySelector('#add').onclick = () => editUsdTransaction();
  root.querySelectorAll('[data-delete-usd-tx]').forEach(button => { button.onclick = async () => {
    if (!confirm('確定刪除這筆美金交易？')) return;
    button.disabled = true;
    const { error } = await sb.from('usd_transactions').delete()
      .eq('id', Number(button.dataset.deleteUsdTx)).eq('household_id', member.household_id);
    if (error) { button.disabled = false; return setNonBlockingStatus(error.message, 'error'); }
    await loadData({ blocking: false });
  }; });
}

function usdTransactionRow(row) {
  const buying = row.usd >= 0;
  return `<div class="portfolioTx"><div class="portfolioTxWhen"><b>${buying ? '買進' : '賣出'}</b><small>${escapeHtml(row.date)} · 匯率 ${rateFormat(row.rate)}</small></div><div class="portfolioTxAmount"><b class="${buying ? 'negative' : 'positive'}">${buying ? '\u2212' : '+'}NT$ ${formatNumber(Math.abs(row.twd))}</b><small>${buying ? '+' : '\u2212'}US$ ${usdFormat(Math.abs(row.usd))}</small></div><button class="portfolioTxDelete" type="button" data-delete-usd-tx="${row.id}">刪除</button></div>`;
}

// 美金的買賣只寫 usd_transactions，不碰資產頁的任何一列。
function editUsdTransaction() {
  let saving = false;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `<section class="sheet"><div class="handle"></div><div class="sheetHead"><div><h2>新增美金交易</h2></div></div><form id="usdform" class="form" novalidate><label>類型<select id="usdKind"><option value="buy">買進</option><option value="sell">賣出</option></select></label><div class="two"><label>美元金額<input id="usdAmount" inputmode="decimal" placeholder="3152.59"></label><label>成交匯率<input id="usdRate" inputmode="decimal" value="${fxRate ? rateFormat(fxRate) : ''}"></label></div><div class="two"><label>台幣金額<input id="usdTwd" inputmode="decimal" placeholder="自動換算"></label><label>日期<input id="usdDate" type="date" value="${taipeiDate()}"></label></div><div id="usdMsg"></div><button id="usdSave" class="primary">儲存</button></form></section>`;
  document.body.append(backdrop);

  const form = backdrop.querySelector('#usdform');
  const kindInput = backdrop.querySelector('#usdKind');
  const amountInput = backdrop.querySelector('#usdAmount');
  const rateInput = backdrop.querySelector('#usdRate');
  const twdInput = backdrop.querySelector('#usdTwd');
  const dateInput = backdrop.querySelector('#usdDate');
  const message = backdrop.querySelector('#usdMsg');
  const close = () => backdrop.remove();
  backdrop.onclick = event => { if (event.target === backdrop && !saving) close(); };

  // 台幣欄沒動過就跟著美元×匯率走；使用者一旦自己填了就不再蓋掉他的數字。
  let twdEdited = false;
  twdInput.oninput = () => { twdEdited = true; };
  const syncTwd = () => {
    if (twdEdited) return;
    const usd = Math.abs(toFiniteNumber(amountInput.value));
    const rate = toFiniteNumber(rateInput.value);
    twdInput.value = usd > 0 && rate > 0 ? Math.round(usd * rate) : '';
  };
  amountInput.oninput = syncTwd;
  rateInput.oninput = syncTwd;

  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    const usd = Math.abs(toFiniteNumber(amountInput.value));
    const rate = toFiniteNumber(rateInput.value);
    const twd = Math.abs(toFiniteNumber(twdInput.value)) || Math.round(usd * rate);
    if (!(usd > 0) || !(rate > 0) || !(twd > 0) || !dateInput.value) {
      message.className = 'message error';
      message.textContent = '美元金額、匯率與日期都要填。';
      return;
    }
    const selling = kindInput.value === 'sell';
    saving = true;
    const { error } = await sb.from('usd_transactions').insert({
      household_id: member.household_id,
      owner_scope: analysisOwner,
      trade_date: dateInput.value,
      usd_amount: selling ? -usd : usd,
      rate,
      twd_amount: selling ? twd : -twd,
    });
    if (error) {
      saving = false;
      message.className = 'message error';
      message.textContent = error.message;
      return;
    }
    close();
    await loadData({ blocking: false });
  };
}

function personPage(ownerScope) {
  const totals = summary(ownerScope);
  const kind = pageKind[ownerScope];
  const list = kind === 'asset' ? totals.assets : totals.liabilities;
  const total = kind === 'asset' ? totals.totalAssets : totals.totalLiabilities;
  const name = ownerScope === 'husband' ? '老公' : '老婆';
  const distributionKind = distributionMode[ownerScope];
  const distributionRows = distributionKind === 'asset' ? totals.assets : totals.liabilities;
  const distributionTotal = distributionKind === 'asset' ? totals.totalAssets : totals.totalLiabilities;
  const distributionTitle = `${name}${distributionKind === 'asset' ? '資產' : '負債'}分布`;
  shell(`<section class="portfolioHero"><div class="heroLabel"><span>${name}淨資產</span><span>${totals.assets.length + totals.liabilities.length} 筆</span></div><div class="bigMoney">${formatMoney(totals.netWorth)}</div><div class="miniStats"><div><span>資產總額</span><b>NT$ ${formatNumber(totals.totalAssets)}</b></div><div><span>負債總額</span><b>NT$ ${formatNumber(totals.totalLiabilities)}</b></div></div></section>${trendChart(personalTrendRows(ownerScope, totals.netWorth))}${distributionPanel(distributionRows, distributionTotal, distributionTitle, distributionKind)}${analysisEntry()}<div class="seg personSeg" id="personSeg"><button data-kind="asset" class="${kind === 'asset' ? 'on' : ''}">資產</button><button data-kind="liability" class="${kind === 'liability' ? 'on' : ''}">負債</button></div><div class="sectionHead"><span>${kind === 'asset' ? '投資與資產' : '貸款與負債'}</span><b>NT$ ${formatNumber(total)}</b></div><div class="categoryList">${list.length ? groupedCards(list, ownerScope, kind) : `<div class="empty"><div><b>目前沒有${kind === 'asset' ? '資產' : '負債'}資料</b><span>按右下角 ＋ 新增財務項目。</span></div></div>`}</div>`, name, true);

  root.querySelector('#personSeg').onclick = event => {
    const button = event.target.closest('[data-kind]');
    if (!button || pageKind[ownerScope] === button.dataset.kind) return;
    pageKind[ownerScope] = button.dataset.kind;
    render();
  };
  root.querySelector('#add').onclick = () => void editItem(null, ownerScope, kind);
  const portfolioButton = root.querySelector('[data-open-portfolio]');
  if (portfolioButton) portfolioButton.onclick = () => openAnalysis('stocks', ownerScope);
  const usdButton = root.querySelector('[data-open-usd]');
  if (usdButton) usdButton.onclick = () => openAnalysis('usd', ownerScope);
  const goldButton = root.querySelector('[data-open-gold]');
  if (goldButton) goldButton.onclick = () => openAnalysis('gold', ownerScope);
  const loanButton = root.querySelector('[data-open-loans]');
  if (loanButton) loanButton.onclick = () => openAnalysis('loans', ownerScope);
  root.querySelector('.categoryList').onclick = event => {
    const group = event.target.closest('[data-group]');
    if (group) {
      const key = group.dataset.group;
      openGroups.has(key) ? openGroups.delete(key) : openGroups.add(key);
      renderKeepingAnchor('data-group', key);
      return;
    }
    const item = event.target.closest('[data-id]');
    if (item) {
      // 台股／美股以前會跳到「股票投資」的明細頁，現在交易就記在編輯表單裡，
      // 所以一律開表單；完整的交易歷史還是從上面的台帳卡片進去看。
      void editItem(items.find(row => row.id === item.dataset.id), ownerScope, kind);
    }
  };
}

// 主畫面的負債列跟貸款分析看的是同一份排程：這裡回傳這筆負債下一期還沒扣的款。
function loanNextDueForItem(itemId) {
  const account = loanAccounts.find(row => row.financial_item_id === itemId && row.status === 'active');
  return account ? loanNextDue[account.id] ?? null : null;
}

function itemCard(item, total) {
  const quote = quoteData[item.id];
  const percent = total ? item.amount_twd / total * 100 : 0;
  const percentLabel = percent > 0 && percent < 1 ? '&lt;1' : Math.round(percent);
  const isNativeUsd = item.native_currency === 'USD' && item.native_amount !== null;
  const subtitle = item.symbol ? escapeHtml(item.symbol) : escapeHtml(item.native_currency || '');
  const quantity = item.quantity === null ? '待設定' : formatNumber(item.quantity);
  const price = quote?.currency === 'USD'
    ? `US$ ${twoDigitFormatter.format(toFiniteNumber(quote.price))}`
    : `NT$ ${formatNumber(quote?.price)}`;
  const change = toFiniteNumber(quote?.changePercent);
  const tone = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const quoteLine = quote
    ? `<span class="quoteLive"><i></i>${price}<b class="${tone}">${change > 0 ? '+' : ''}${change.toFixed(2)}%</b></span>`
    : item.symbol ? '<span class="quotePending">沿用最近市值</span>' : '';
  const due = item.kind === 'liability' ? loanNextDueForItem(item.id) : null;
  const dueLine = due
    ? `<span>下次 ${escapeHtml(due.date.slice(5).replace('-', '/'))} NT$ ${formatNumber(due.amount)}</span>`
    : '';
  const meta = item.kind === 'asset'
    ? (item.market === 'GOLD' ? `<span>重量 ${quantity} g</span>${quoteLine}` : item.symbol ? `<span>持有 ${quantity} 股</span>${quoteLine}` : '')
    : `<span>利率 ${item.interest_rate !== null ? item.interest_rate.toFixed(2) + '%' : '待設定'}</span>${dueLine || `<span>月付 ${item.monthly_payment_twd !== null ? 'NT$ ' + formatNumber(item.monthly_payment_twd) : '待設定'}</span>`}`;
  const original = isNativeUsd
    ? `<span>US$ ${masked ? '••••••' : decimalFormatter.format(item.native_amount)}</span>`
    : '';
  return `<button class="itemCard compactCard" data-id="${item.id}"><div class="compactMain"><div class="allocationRing ${item.kind}" style="--pct:${Math.max(0, Math.min(100, percent))}%"><span>${percentLabel}%</span></div><div class="compactIdentity"><b>${escapeHtml(item.name)}</b>${subtitle ? `<span>${subtitle}</span>` : ''}</div><div class="compactAmount"><b>NT$ ${formatNumber(item.amount_twd)}</b>${original}</div></div>${meta ? `<div class="compactMeta ${item.kind}">${meta}</div>` : ''}</button>`;
}

// render() 會整個重建 DOM，捲動位置因此掉回頂部。但展開／收合是就地操作，
// 畫面不該跳走 —— 記下錨點元素在視窗裡的位置，重繪後把差值補回捲動量，
// 被點的那一張卡片就會留在原地。
function renderKeepingAnchor(attribute, value) {
  const selector = `[${attribute}="${String(value).replace(/["\\]/g, '\\$&')}"]`;
  const scrollBefore = window.scrollY;
  const anchor = root.querySelector(selector);
  const documentTopBefore = anchor ? anchor.getBoundingClientRect().top + scrollBefore : null;
  render();
  if (documentTopBefore === null) return;
  const next = root.querySelector(selector);
  if (!next) return;
  // 先回到原本的捲動位置，量測才有已知的基準 —— 剛 render() 完瀏覽器的捲動狀態是未定的。
  window.scrollTo(0, scrollBefore);
  const documentTopAfter = next.getBoundingClientRect().top + window.scrollY;
  // 展開／收合同一張卡片時錨點不會移動，這一步就是零；換開另一張時才會補正。
  if (documentTopAfter !== documentTopBefore) window.scrollTo(0, window.scrollY + (documentTopAfter - documentTopBefore));
}

// 進貸款分析預設停在「這個人真的有貸款」的那一頁。老婆只有房貸，一進來就停在信貸
// 會看到整頁的 0。都沒有的話還是回信貸，空狀態的文案本來就寫給那種情況。
function firstLoanTypeWithRows(ownerScope) {
  const mine = loanAccounts.filter(account => account.owner_scope === ownerScope && account.status === 'active');
  return ['personal', 'topup', 'mortgage'].find(type =>
    mine.some(account => normalizedLoanType(account) === type)) ?? 'personal';
}

function openAnalysis(screen, ownerScope) {
  if (screen === 'stocks') void ensureLedger().then(ok => { if (ok && analysisScreen === 'stocks') render(); });
  if (screen === 'loans') void ensureLoanSchedule().then(ok => { if (ok && analysisScreen === 'loans') render(); });
  expandedLoan = null;
  if (screen === 'loans') loanTypeFilter = firstLoanTypeWithRows(ownerScope);
  analysisOwner = ownerScope;
  expandedStock = null;   // 換人看就把展開的那張收掉，免得停在另一個人的標的上
  analysisReturnScroll = window.scrollY;
  analysisScreen = screen;
  window.history.pushState({ ks: 'analysis' }, '');
  analysisPushed = true;
  render();
  window.scrollTo(0, 0);
}

// 手勢、返回鍵、以及底部導覽切分頁都走這裡收回分析畫面。
window.addEventListener('popstate', () => {
  if (!analysisScreen) return;
  analysisScreen = null;
  expandedStock = null;
  analysisPushed = false;
  render();
  window.scrollTo(0, analysisReturnScroll);
});

function render() {
  if (!session || !member) return;
  if (analysisScreen) return analysisPage();
  if (tab === 'dashboard') dashboard();
  else personPage(tab);
}

// WebKit 會把「有 non-passive pointermove 監聽器」的範圍整塊標成主執行緒捲動區，
// 捲動前每一個 move 都要先回 JS 問過才交給合成器。這幾個監聽器本來掛在 #root 上，
// 等於整個 App 都是。改成：平常只有圖表自己有一個 passive 的 pointerdown，
// move／up／cancel 只在真的在拖曳的那幾百毫秒內存在。
// 判斷方向前至少要移動這麼多像素，一個取樣點不算數。
const TREND_AXIS_SLOP = 10;

function bindTrendChart(chart) {
  if (chart) chart.addEventListener('pointerdown', beginTrendDrag, { passive: true });
}

function endTrendDrag() {
  window.removeEventListener('pointermove', moveTrendDrag);
  window.removeEventListener('pointerup', finishTrendDrag);
  window.removeEventListener('pointercancel', abortTrendDrag);
  window.removeEventListener('touchmove', moveTrendTouch);
  window.removeEventListener('touchend', finishTrendTouch);
  window.removeEventListener('touchcancel', finishTrendTouch);
  if (!trendDrag) return;
  if (trendDrag.frame !== null) cancelAnimationFrame(trendDrag.frame);
  trendDrag = null;
}

function beginTrendDrag(event) {
  const chart = event.currentTarget;
  if (trendDrag) endTrendDrag();
  trendDrag = {
    chart,
    pointerId: event.pointerId,
    touch: event.pointerType === 'touch',
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    bounds: chart.getBoundingClientRect(),
    frame: null,
    clientX: event.clientX,
  };
  // 監聽掛在 window 上：手指滑出圖表外面時還要跟得住。
  window.addEventListener('pointermove', moveTrendDrag, { passive: true });
  window.addEventListener('pointerup', finishTrendDrag);
  window.addEventListener('pointercancel', abortTrendDrag);
  // touch-action: pan-y 把直向讓給瀏覽器，所以橫著刮的時候手指只要有一點上下位移，
  // 瀏覽器就會接手捲頁並丟一個 pointercancel 過來 —— 提示框當場停住，就是「被釘住」。
  // touchmove 不受這件事影響，會一路發到手指離開，所以觸控就多掛一組，靠它把刮動撐完。
  if (trendDrag.touch) {
    window.addEventListener('touchmove', moveTrendTouch, { passive: true });
    window.addEventListener('touchend', finishTrendTouch);
    window.addEventListener('touchcancel', finishTrendTouch);
  }
}

// 座標的來源有兩種（pointer 與 touch），判斷與更新的邏輯只有這一份。
function trackTrendDrag(clientX, clientY) {
  if (!trendDrag) return;
  const deltaX = clientX - trendDrag.startX;
  const deltaY = clientY - trendDrag.startY;
  if (!trendDrag.active) {
    // 直的先跨過門檻，就是要捲頁，把整組監聽收掉讓瀏覽器自己處理（連同它的慣性）。
    if (Math.abs(deltaY) >= TREND_AXIS_SLOP && Math.abs(deltaY) >= Math.abs(deltaX)) return endTrendDrag();
    // 橫的要「明顯」贏才算刮動。手指按下去的第一個取樣幾乎都是斜的，拿單一取樣去比
    // |dx| > |dy| 的話，明明是往上滑也會被判成刮動、整個手勢就被圖表吃掉。
    // 兩邊都還沒跨過門檻就先不決定，等下一個取樣。
    if (Math.abs(deltaX) < TREND_AXIS_SLOP || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;
    trendDrag.active = true;
    // 不抓 pointer capture：抓了瀏覽器就沒辦法把判斷錯的手勢收回去捲頁，整頁會被釘住。
    // 刮動被半路收走的問題改用上面那組 touchmove 解決。
  }
  const drag = trendDrag;
  drag.clientX = clientX;
  if (drag.frame === null) {
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      if (trendDrag === drag && drag.chart.isConnected) {
        showTrendPoint({ clientX: drag.clientX }, drag.chart);
      }
    });
  }
}

function moveTrendDrag(event) {
  if (!trendDrag || trendDrag.pointerId !== event.pointerId) return;
  trackTrendDrag(event.clientX, event.clientY);
}

function moveTrendTouch(event) {
  const touch = event.touches[0];
  if (touch) trackTrendDrag(touch.clientX, touch.clientY);
}

function finishTrendDrag(event) {
  if (!trendDrag || trendDrag.pointerId !== event.pointerId) return;
  // 觸控交給 touchend 收；pointerup 早一步進來的話會把還沒結束的刮動砍掉。
  if (trendDrag.touch) return;
  const drag = trendDrag;
  endTrendDrag();
  if (drag.active) showTrendPoint(event, drag.chart);
}

function finishTrendTouch(event) {
  if (!trendDrag) return;
  const drag = trendDrag;
  const touch = event.changedTouches?.[0];
  endTrendDrag();
  if (drag.active && touch) showTrendPoint({ clientX: touch.clientX }, drag.chart);
}

function abortTrendDrag(event) {
  if (!trendDrag || trendDrag.pointerId !== event.pointerId) return;
  // 觸控時 pointercancel 幾乎都是瀏覽器接手捲頁發出來的，不代表手指離開了。
  // 這時候收掉就是「刮到一半被釘住」，交給 touchend 決定什麼時候結束。
  if (trendDrag.touch) return;
  endTrendDrag();
}

root.addEventListener('click', event => {
  const trendChartElement = event.target.closest('[data-trend-chart]');
  if (trendChartElement) {
    showTrendPoint(event, trendChartElement);
    return;
  }
  clearTrendPoint();
  if (event.target.closest('[data-trend-toggle]')) {
    trendMode = trendMode === 'value' ? 'percent' : 'value';
    render();
    return;
  }
  if (event.target.closest('[data-distribution-toggle]')) {
    const scope = tab === 'dashboard' ? 'dashboard' : tab;
    distributionMode[scope] = distributionMode[scope] === 'asset' ? 'liability' : 'asset';
    render();
  }
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

// 這幾類沒有行情可抓，金額是手打的，但可能是美金計價 —— 給它們一個幣別選單，
// 選 USD 就跟現金那條一樣走 manual-usd（存原幣金額與當下匯率，之後跟著匯率重算）。
const CURRENCY_CHOICE_ATTRIBUTES = new Set(['insurance', 'other']);

const assetAttributes = [
  { value: 'cash-twd', label: '台幣', category: '現金及存款', mode: 'manual-twd' },
  { value: 'cash-usd', label: '美金', category: '現金及存款', mode: 'manual-usd' },
  { value: 'stock-tw', label: '台股', category: '台股', mode: 'stock-tw' },
  { value: 'stock-us', label: '美股', category: '美股', mode: 'stock-us' },
  { value: 'real-estate', label: '不動產', category: '不動產', mode: 'manual-twd' },
  { value: 'gold', label: '黃金', category: '黃金', mode: 'gold' },
  { value: 'insurance', label: '保險', category: '保險', mode: 'manual-twd' },
  { value: 'other', label: '其他', category: '其他', mode: 'manual-twd' },
];

function assetAttributeForItem(item) {
  const mode = modeForItem(item, 'asset');
  if (mode === 'stock-tw' || mode === 'stock-us' || mode === 'gold') return mode;
  if (item?.category === '現金及存款') return mode === 'manual-usd' ? 'cash-usd' : 'cash-twd';
  if (item?.category === '不動產') return 'real-estate';
  if (item?.category === '黃金') return 'gold';
  if (item?.category === '保險') return 'insurance';
  if (item?.category === '其他') return 'other';
  return 'cash-twd';
}

async function editItem(item, defaultOwner, defaultKind) {
  // 這一列是台帳連動的股票的話，表單要列出它的交易紀錄，得先把台帳載進來。
  if (item?.portfolio_stock_key) await ensureLedger();
  // 台股／美股的股數與市值是從交易推算出來的（klfan_transactions 一動，
  // sync_klfan_financial_item 觸發器就會把結果寫回 financial_items），所以這種
  // 項目在這張表單裡直接編台帳、記買賣，而不是手打股數。
  const ledgerStock = portfolioPosition(item?.portfolio_stock_key);
  let owner = item?.owner_scope || defaultOwner || 'husband';
  let kind = item?.kind || defaultKind || 'asset';
  let mode = modeForItem(item, kind);
  let assetAttribute = assetAttributeForItem(item);
  let manualCurrency = ['保險', '其他'].includes(item?.category)
    && (item?.native_currency ?? item?.original_currency) === 'USD' ? 'USD' : 'TWD';
  let saving = false;
  const initialNativeAmount = item?.native_amount ?? item?.original_amount ?? item?.amount_twd ?? '';
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.innerHTML = `<section class="sheet"><div class="handle"></div><div class="sheetHead"><div><h2>${item ? '編輯' : '新增'}財務項目</h2></div>${item ? '<button id="del" class="trash">刪除</button>' : ''}</div><form id="editform" class="form" novalidate><label>歸屬<select id="owner"><option value="husband">老公</option><option value="wife">老婆</option></select></label><div class="seg"><button type="button" data-kind="asset">資產</button><button type="button" data-kind="liability">負債</button></div><label><span id="categoryLabel">資產屬性</span><select id="cat"></select></label><label id="nameBox">名稱<input id="nm" required value="${escapeHtml(item?.name || '')}"></label><label id="currencyBox" class="hide">幣別<select id="manualCurrency"><option value="TWD">台幣（TWD）</option><option value="USD">美金（USD）</option></select></label><label id="modeBox">資料型態<select id="mode"><option value="manual-twd">手動台幣資產</option><option value="manual-usd">手動美元資產</option><option value="stock-tw">台股</option><option value="stock-us">美股</option><option value="gold">黃金（自動行情）</option></select><small id="modeHint" class="quoteHint"></small></label><div id="manualFields"><label id="amountLabel">台幣金額<input id="amt" inputmode="decimal" value="${initialNativeAmount}"></label><div id="usdFields" class="two hide"><label>USD/TWD 匯率<input id="fx" inputmode="decimal" readonly></label><label>自動換算台幣<input id="converted" readonly></label></div></div><div id="stockFields" class="hide"><div class="two"><label>代號或名稱<input id="symbol" value="${escapeHtml(ledgerStock ? ledgerStock.display : item?.symbol || '')}" placeholder="2330 或 台積電" autocapitalize="characters"></label><label id="qtyBox">持有股數<input id="qty" inputmode="decimal" value="${item?.quantity ?? ''}"></label><label id="txActionBox" class="hide">類型<select id="txAction"><option value="buy">買進</option><option value="sell">賣出</option><option value="dividend">股息</option></select></label></div><div class="quoteHint hide" id="stockHint"></div><div id="ledgerFields" class="hide"><div class="two"><label id="txAmountBox">總金額<input id="txAmount" inputmode="decimal"></label><label id="txSharesBox">股數<input id="txShares" inputmode="decimal"></label></div><div class="two"><label>日期<input id="txDate" type="date" value="${taipeiDate()}"></label><label>銀行／券商<input id="txBank"></label></div><div id="txHistoryBox" class="hide"><div class="sectionHead"><b>交易紀錄</b><span id="txCount"></span></div><div class="portfolioTxList" id="txHistory"></div></div></div></div><div id="goldFields" class="hide"><div class="two"><label>持有重量<input id="goldWeight" inputmode="decimal" value="${item?.market === 'GOLD' ? item.quantity ?? '' : ''}"></label><label>單位<select disabled><option>g 公克</option></select></label></div></div><div id="loanFields" class="hide"><label>剩餘本金（TWD）<input id="principal" inputmode="decimal" value="${item?.amount_twd ?? ''}"></label><div class="two"><label>年利率 %<input id="rate" inputmode="decimal" value="${item?.interest_rate ?? ''}"></label><label>每月還款（TWD）<input id="pay" inputmode="decimal" value="${item?.monthly_payment_twd ?? ''}"></label></div></div><label>備註（選填）<input id="note" value="${escapeHtml(item?.notes || '')}"></label><div id="emsg"></div><button id="save" class="primary">儲存並同步</button></form></section>`;
  document.body.append(backdrop);

  const form = backdrop.querySelector('#editform');
  const ownerInput = backdrop.querySelector('#owner');
  const nameBox = backdrop.querySelector('#nameBox');
  const nameInput = backdrop.querySelector('#nm');
  const categoryInput = backdrop.querySelector('#cat');
  const categoryLabel = backdrop.querySelector('#categoryLabel');
  const currencyBox = backdrop.querySelector('#currencyBox');
  const currencyInput = backdrop.querySelector('#manualCurrency');
  const modeBox = backdrop.querySelector('#modeBox');
  const modeInput = backdrop.querySelector('#mode');
  const modeHint = backdrop.querySelector('#modeHint');
  const manualFields = backdrop.querySelector('#manualFields');
  const amountLabel = backdrop.querySelector('#amountLabel');
  const amountInput = backdrop.querySelector('#amt');
  const usdFields = backdrop.querySelector('#usdFields');
  const fxInput = backdrop.querySelector('#fx');
  const convertedInput = backdrop.querySelector('#converted');
  const stockFields = backdrop.querySelector('#stockFields');
  const symbolInput = backdrop.querySelector('#symbol');
  const quantityBox = backdrop.querySelector('#qtyBox');
  const quantityInput = backdrop.querySelector('#qty');
  const stockHint = backdrop.querySelector('#stockHint');
  const ledgerFields = backdrop.querySelector('#ledgerFields');
  const txActionBox = backdrop.querySelector('#txActionBox');
  const txAction = backdrop.querySelector('#txAction');
  const txDate = backdrop.querySelector('#txDate');
  const txAmountBox = backdrop.querySelector('#txAmountBox');
  const txAmount = backdrop.querySelector('#txAmount');
  const txSharesBox = backdrop.querySelector('#txSharesBox');
  const txShares = backdrop.querySelector('#txShares');
  const txBank = backdrop.querySelector('#txBank');
  const txHistoryBox = backdrop.querySelector('#txHistoryBox');
  const txCountLabel = backdrop.querySelector('#txCount');
  const txHistory = backdrop.querySelector('#txHistory');
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
  currencyInput.value = manualCurrency;
  modeInput.value = mode;
  if (ledgerStock?.display) nameInput.value = ledgerStock.display;

  const currentFxRate = () => toFiniteNumber(fxRate || item?.fx_rate_twd);
  const updateConversion = () => {
    if (mode !== 'manual-usd') return;
    const rate = currentFxRate();
    fxInput.value = rate > 0 ? rate.toFixed(4) : '尚未取得';
    const amount = Number(String(amountInput.value).replace(/,/g, ''));
    convertedInput.value = Number.isFinite(amount) && amount >= 0 && rate > 0
      ? `NT$ ${integerFormatter.format(Math.round(amount * rate))}`
      : '等待有效美元金額與匯率';
  };
  // 台帳只認帶交易所前綴的代號（TPE:2330 / NASDAQ:QQQ），sync_klfan_financial_item
  // 也是靠這個前綴把裸代號切出來寫進 financial_items.symbol。使用者只打 2330 的話
  // 這裡補上去，並且把補完的結果顯示出來讓他確認。
  const QUOTE_PREFIXES = /^[A-Za-z0-9]+:/;
  const normalizeQuoteSymbol = (raw, marketLabel) => {
    const value = String(raw || '').trim().toUpperCase();
    if (!value) return '';
    if (value.includes(':')) return value;
    return marketLabel === '美股' ? `NASDAQ:${value}` : `TPE:${value}`;
  };

  // 台股欄位收代號或中文名都行 —— 只看代號記不住哪個是哪支股票。
  // tw_stock_names 是證交所與櫃買中心的清單，查到就一律用它們的正式名稱當標的名。
  let resolvedTw = ledgerStock && ledgerStock.market === '台股'
    ? { code: String(ledgerStock.symbol || '').replace(QUOTE_PREFIXES, ''), name: ledgerStock.display, board: String(ledgerStock.symbol || '').startsWith('TWO:') ? 'TWO' : 'TPE' }
    : null;
  let lookupSeq = 0;

  const lookupTwStock = async () => {
    const raw = symbolInput.value.trim().replace(QUOTE_PREFIXES, '');
    if (mode !== 'stock-tw' || !raw) { resolvedTw = null; stockHint.classList.add('hide'); return; }
    const seq = ++lookupSeq;
    // 純英數當代號查，其他（中文）當名稱查。
    const column = /^[0-9A-Za-z]+$/.test(raw) ? 'code' : 'name';
    const { data } = await sb.from('tw_stock_names').select('code,name,board').eq(column, raw.toUpperCase()).limit(1);
    if (seq !== lookupSeq) return;   // 打字很快時，只認最後一次查詢的結果
    resolvedTw = data?.[0] ?? null;
    stockHint.classList.remove('hide');
    stockHint.textContent = resolvedTw
      ? `${resolvedTw.name}（${resolvedTw.board}:${resolvedTw.code}）`
      : '證交所清單裡查不到，會照你輸入的存';
  };
  let lookupTimer = null;

  const MAX_TX_ROWS = 10;
  const updateLedgerFields = () => {
    const dividend = txAction.value === 'dividend';
    txSharesBox.classList.toggle('hide', dividend);
    txAmountBox.classList.toggle('wide', dividend);
    txAmountBox.firstChild.textContent = `總金額（${mode === 'stock-us' ? 'USD' : 'TWD'}）`;
    if (!ledgerStock) return;
    const all = ledgerStock.transactions.slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    txHistoryBox.classList.toggle('hide', all.length === 0);
    // 這張表單不是為了瀏覽全部歷史而存在的 —— 只列最近幾筆讓人補漏或刪掉打錯的，
    // 完整的紀錄在「股票投資」那一頁。
    txCountLabel.textContent = all.length > MAX_TX_ROWS
      ? `最近 ${MAX_TX_ROWS} 筆，共 ${all.length} 筆`
      : `${all.length} 筆`;
    txHistory.innerHTML = all.slice(0, MAX_TX_ROWS)
      .map(tx => transactionRow(tx, ledgerStock)).join('');
    txHistory.querySelectorAll('[data-delete-portfolio-tx]').forEach(button => { button.onclick = async () => {
      if (saving || !confirm('確定刪除這筆交易？')) return;
      button.disabled = true;
      const { error } = await sb.from('klfan_transactions').delete().eq('id', Number(button.dataset.deletePortfolioTx));
      if (error) {
        button.disabled = false;
        message.className = 'message error';
        message.textContent = error.message;
        return;
      }
      backdrop.remove();
      await loadData({ blocking: false });
      await syncPortfolioFinancialItem(ledgerStock.key, { ownerScope: owner });
      await loadData({ blocking: false });
    }; });
  };

  const fillCategories = () => {
    if (kind === 'asset') {
      categoryLabel.textContent = '資產屬性';
      categoryInput.innerHTML = assetAttributes
        .map(attribute => `<option value="${attribute.value}">${attribute.label}</option>`)
        .join('');
      categoryInput.value = assetAttribute;
      return;
    }
    categoryLabel.textContent = '分類';
    const selected = categoryInput.value || item?.category;
    categoryInput.innerHTML = categories.liability
      .map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join('');
    if (categories.liability.includes(selected)) categoryInput.value = selected;
  };
  const selectedAssetAttribute = () => assetAttributes.find(attribute => attribute.value === assetAttribute) || assetAttributes[0];
  const selectedCategory = () => kind === 'asset' ? selectedAssetAttribute().category : categoryInput.value;
  const updateFields = () => {
    if (kind === 'liability') mode = 'liability';
    else if (CURRENCY_CHOICE_ATTRIBUTES.has(assetAttribute)) mode = manualCurrency === 'USD' ? 'manual-usd' : 'manual-twd';
    else mode = selectedAssetAttribute().mode;
    currencyInput.value = manualCurrency;
    modeInput.value = mode;
    const manual = kind === 'asset' && mode.startsWith('manual-');
    const stock = kind === 'asset' && mode.startsWith('stock-');
    const gold = kind === 'asset' && mode === 'gold';
    // 新增的台股／美股一律走台帳；既有項目只有真的連著台帳的才走（沒連的還是手打股數）。
    const ledger = stock && (!item || Boolean(item.portfolio_stock_key));
    nameBox.classList.toggle('hide', stock);
    nameInput.required = !stock;
    categoryInput.disabled = false;
    modeHint.textContent = '';
    modeBox.classList.add('hide');
    currencyBox.classList.toggle('hide', kind !== 'asset' || !CURRENCY_CHOICE_ATTRIBUTES.has(assetAttribute));
    manualFields.classList.toggle('hide', !manual);
    stockFields.classList.toggle('hide', !stock);
    ledgerFields.classList.toggle('hide', !ledger);
    txActionBox.classList.toggle('hide', !ledger);
    quantityBox.classList.toggle('hide', ledger);
    quantityInput.required = stock && !ledger;
    if (ledger) updateLedgerFields();
    goldFields.classList.toggle('hide', !gold);
    loanFields.classList.toggle('hide', kind !== 'liability');
    usdFields.classList.toggle('hide', mode !== 'manual-usd');
    amountLabel.firstChild.textContent = mode === 'manual-usd' ? '美元金額（USD）' : '台幣金額（TWD）';
    stockHint.textContent = '';
    backdrop.querySelectorAll('[data-kind]').forEach(button => button.classList.toggle('on', button.dataset.kind === kind));
    updateConversion();
  };

  fillCategories();
  updateFields();
  modeInput.onchange = updateFields;
  currencyInput.onchange = () => {
    manualCurrency = currencyInput.value;
    updateFields();
  };
  categoryInput.onchange = () => {
    if (kind === 'asset') assetAttribute = categoryInput.value;
    updateFields();
  };
  amountInput.oninput = updateConversion;
  txAction.onchange = updateLedgerFields;
  symbolInput.oninput = () => { clearTimeout(lookupTimer); lookupTimer = setTimeout(lookupTwStock, 300); };
  backdrop.onclick = event => {
    if (event.target === backdrop && !saving) backdrop.remove();
    const button = event.target.closest('[data-kind]');
    if (!button || saving) return;
    kind = button.dataset.kind;
    fillCategories();
    updateFields();
  };

  // 讀「新增交易」那一區。既有標的可以整區留白，代表這次不記交易；新標的一定要有
  // 第一筆 —— sync_klfan_financial_item 只在股數不為零時才建 financial_items 那一列，
  // 沒有交易的話標的只會出現在「股票投資」，不會出現在資產裡。
  const readTransaction = ({ required }) => {
    const action = txAction.value;
    const amountRaw = txAmount.value.trim();
    const sharesRaw = txShares.value.trim();
    if (!required && !amountRaw && !sharesRaw) return null;
    const amountValue = parseNonNegative(amountRaw, '總金額', { positive: true });
    const sharesValue = action === 'dividend' ? 0 : parseNonNegative(sharesRaw, '股數', { positive: true });
    const date = txDate.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('請選擇交易日期。');
    return {
      tx_date: date,
      amount: action === 'buy' ? -amountValue : amountValue,
      shares: action === 'buy' ? sharesValue : action === 'sell' ? -sharesValue : 0,
      bank: txBank.value.trim(),
      kind: action === 'dividend' ? 'dividend' : 'trade',
      note: action === 'dividend' ? '股息' : '股票',
    };
  };

  const saveLedgerStock = async ({ ownerScope }) => {
    // 台帳是延遲載入的。沒載好就往下走，下面比對不到既有標的，同一檔會被開成第二筆。
    await ensureLedger();
    const marketLabel = mode === 'stock-us' ? '美股' : '台股';
    const currency = mode === 'stock-us' ? 'USD' : 'TWD';
    // 台股查得到就用證交所的代號與正式名稱，查不到才照使用者輸入的存。美股一律英文代號。
    await lookupTwStock();
    const symbol = marketLabel === '台股' && resolvedTw
      ? `${resolvedTw.board}:${resolvedTw.code}`
      : normalizeQuoteSymbol(symbolInput.value, marketLabel);
    if (!/^[0-9A-Z.:-]{1,32}$/.test(symbol)) throw new Error('代號格式不正確。');
    const display = marketLabel === '台股'
      ? (resolvedTw?.name || ledgerStock?.display || symbol.replace(QUOTE_PREFIXES, ''))
      : symbol.replace(QUOTE_PREFIXES, '');
    let key = item?.portfolio_stock_key ?? null;
    const isNewStock = !key;
    const transaction = readTransaction({ required: !key });

    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = '儲存中…';

    if (key) {
      const { error } = await sb.from('klfan_stocks')
        .update({ display, symbol, market: marketLabel, currency, owner_scope: ownerScope })
        .eq('key', key);
      if (error) throw error;
    } else {
      const bare = symbol.replace(QUOTE_PREFIXES, '');
      const existing = portfolioStocks.find(stock => stock.market === marketLabel
        && String(stock.symbol || stock.key).replace(QUOTE_PREFIXES, '').toUpperCase() === bare);
      if (existing) {
        key = existing.key;
      } else {
        const baseKey = bare || display;
        key = portfolioStocks.some(stock => stock.key === baseKey) ? `${baseKey}-${Date.now().toString(36)}` : baseKey;
        const { error } = await sb.from('klfan_stocks').insert({
          key, display, market: marketLabel, currency, symbol,
          household_id: member.household_id, owner_scope: ownerScope,
        });
        if (error) throw error;
      }
    }

    if (transaction) {
      const { error } = await sb.from('klfan_transactions').insert({ stock_key: key, ...transaction });
      if (error) throw error;
    }

    backdrop.remove();
    tab = ownerScope;
    pageKind[ownerScope] = 'asset';
    await loadData({ blocking: false });
    // 備註只存在 financial_items 上，觸發器不會碰它，所以跟著這次同步一起寫回去。
    await syncPortfolioFinancialItem(key, { ownerScope, notes: noteInput.value.trim() || null });
    await loadData({ blocking: false });
    // 只有全新的標的要立刻抓報價 —— 那個代號從來沒被報價過。既有標的記一筆交易並不會
    // 讓行情變動，強制重抓只是白白吃掉 Twelve Data 每分鐘 8 credits 的額度：連續存個
    // 幾筆就會超過，而被擋掉的永遠是排在最後的 XAU/USD（黃金）。
    if (isNewStock) void refreshQuotes({ force: true });
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    message.textContent = '';
    try {
      owner = ownerInput.value;
      const stockMode = kind === 'asset' && (mode === 'stock-tw' || mode === 'stock-us');
      let name = nameInput.value.trim();
      if (!OWNER_SCOPES.includes(owner)) throw new Error('歸屬設定不正確。');
      if (!ITEM_KINDS.includes(kind)) throw new Error('資產／負債設定不正確。');
      if (!stockMode && !name) throw new Error('請輸入名稱。');
      const category = selectedCategory();
      if (!categories[kind].includes(category)) throw new Error('資產屬性／分類設定不正確。');

      // 台帳項目的股數與市值是觸發器算出來的，financial_items 那一列完全是衍生的，
      // 所以這條路徑只寫 klfan_stocks / klfan_transactions，不自己組 payload。
      if (stockMode && (!item || item.portfolio_stock_key)) {
        await saveLedgerStock({ ownerScope: owner });
        return;
      }

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
        monthlyPayment = parseNonNegative(paymentInput.value, '每月還款', { required: false });
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
        const wasAlreadyStock = item?.market === 'TW' || item?.market === 'US';
        name = wasAlreadyStock && item?.name ? item.name : symbol;
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
        category,
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
    // 台帳項目刪掉 financial_items 那一列是沒有用的：klfan_stocks 還在，下一筆交易或
    // 報價更新會讓觸發器把它重建回來。要刪就得從台帳刪，交易會跟著 cascade。
    const txCount = ledgerStock?.transactions.length ?? 0;
    const warning = ledgerStock
      ? `確定刪除「${item.name}」？連同 ${txCount} 筆交易紀錄一起刪除，無法復原。`
      : `確定刪除「${item.name}」？`;
    if (saving || !confirm(warning)) return;
    saving = true;
    deleteButton.disabled = true;
    deleteButton.textContent = '刪除中…';
    if (ledgerStock) {
      const { error: ledgerError } = await sb.from('klfan_stocks').delete().eq('key', ledgerStock.key);
      if (ledgerError) {
        saving = false;
        deleteButton.disabled = false;
        deleteButton.textContent = '刪除';
        message.className = 'message error';
        message.textContent = ledgerError.message;
        return;
      }
    }
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
