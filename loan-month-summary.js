import { LOAN_OWNERS, LOAN_TYPES, loanMonthBucketKey, summarizeRemainingMonth } from './loan-month-core.js?v=V2P4';
import {
  LOAN_MONTH_CACHE_PREFIX,
  loanMonthDataKey,
  loanMonthStorageKey,
  readStoredAuth,
} from './loan-month-cache-core.js?v=V3P23';

const root = document.querySelector('#root');
const SUPABASE_URL = 'https://gbxsnwqbjmgfikpblyot.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VtGM8w7CqxDB_3NaROR8OA_H0txX-_I';
const AUTH_STORAGE_KEY = 'sb-gbxsnwqbjmgfikpblyot-auth-token';
function readAuth() {
  return readStoredAuth(localStorage.getItem(AUTH_STORAGE_KEY));
}

function taipeiDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const pick = type => Number(parts.find(part => part.type === type)?.value || 0);
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

function ymd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayKey() {
  const { year, month, day } = taipeiDateParts();
  return ymd(year, month, day);
}

function storageKey(key) {
  return loanMonthStorageKey(key);
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.total !== 'number' || typeof data.count !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(key, result) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(result));
  } catch {}
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function remainingMonthContext() {
  const title = document.querySelector('.brand h1')?.textContent?.trim() || '';
  if (!title.includes('貸款分析')) return null;

  const owner = title.startsWith('老公') ? 'husband' : title.startsWith('老婆') ? 'wife' : null;
  const selected = document.querySelector('.loanTypeSeg button.on')?.textContent?.trim() || '';
  const loanType = ({ 信貸: 'personal', 增貸: 'topup', 房貸: 'mortgage' })[selected];
  if (!owner || !loanType) return null;

  const summary = document.querySelector('.portfolioSummary.loanSummary');
  if (!summary) return null;
  const metric = [...summary.querySelectorAll(':scope > .portfolioMetric')]
    .find(item => ['每月還款', '本月剩餘還款'].includes(item.querySelector('span')?.textContent?.trim()));
  if (!metric) return null;

  return { owner, loanType, metric };
}

async function rest(path, params) {
  const token = readAuth().accessToken;
  if (!token) throw new Error('missing session');
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  for (const [key, value] of params) url.searchParams.append(key, value);
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return response.json();
}

let monthDataFlight = null;

async function loadRemainingMonthBatch() {
  if (monthDataFlight) return monthDataFlight;
  monthDataFlight = (async () => {
    const { year, month, day } = taipeiDateParts();
    const today = ymd(year, month, day);
    const next = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1);

    const accounts = await rest('loan_accounts', [
      ['select', 'id,owner_scope,loan_type,status'],
      ['status', 'eq.active'],
    ]);
    const ids = accounts.map(row => row.id).filter(Boolean);
    if (!ids.length) return summarizeRemainingMonth([], []);

    const rows = await rest('loan_schedule', [
      ['select', 'id,loan_account_id,due_date,actual_date,amount_twd,applied_at'],
      ['loan_account_id', `in.(${ids.join(',')})`],
      ['entry_type', 'eq.payment'],
      ['applied_at', 'is.null'],
      ['due_date', `gte.${today}`],
      ['due_date', `lt.${next}`],
      ['order', 'due_date.asc'],
    ]);

    return summarizeRemainingMonth(accounts, rows);
  })();
  try { return await monthDataFlight; }
  finally { monthDataFlight = null; }
}

async function loadRemainingMonth(owner, loanType) {
  const result = await loadRemainingMonthBatch();
  return result[loanMonthBucketKey(owner, loanType)] ?? { total: 0, count: 0, nextDue: null };
}

function formatMoney(value) {
  return `NT$ ${Math.round(value).toLocaleString('en-US')}`;
}

function formatShortDate(value) {
  if (!value) return '';
  const match = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${Number(match[1])}/${Number(match[2])}`;
}

function renderResult(metric, result) {
  const value = metric.querySelector('b');
  const note = metric.querySelector('small');
  setText(value, formatMoney(result.total));
  setText(
    note,
    result.count <= 0
      ? '本月已繳完'
      : `尚有 ${result.count} 筆待繳${result.nextDue ? ` · 最近 ${formatShortDate(result.nextDue)}` : ''}`,
  );
}

function refreshRemainingMonthSummary({ force = false } = {}) {
  const context = remainingMonthContext();
  if (!context) return;

  const { owner, loanType, metric } = context;
  const { userId } = readAuth();
  const key = loanMonthDataKey(userId, owner, loanType, todayKey());
  const label = metric.querySelector('span');
  const value = metric.querySelector('b');
  const note = metric.querySelector('small');

  setText(label, '本月剩餘還款');
  if (!key) {
    setText(value, '—');
    setText(note, '尚未登入');
    metric.dataset.remainingMonthKey = '';
    return;
  }

  // 同一個摘要節點已綁定今天的資料時直接離開，避免 observer 因文字更新再次觸發自己。
  if (!force && metric.dataset.remainingMonthKey === key) return;
  metric.dataset.remainingMonthKey = key;

  // 先同步畫出今日快取，讓 core render 出來的整月總額不會被看到。
  const cached = readCache(key);
  if (cached) renderResult(metric, cached);
  else {
    setText(value, '—');
    setText(note, '更新中…');
  }

  void loadRemainingMonth(owner, loanType).then(result => {
    writeCache(key, result);
    if (!metric.isConnected || metric.dataset.remainingMonthKey !== key) return;
    renderResult(metric, result);
  }).catch(() => {
    if (!metric.isConnected || metric.dataset.remainingMonthKey !== key) return;
    setText(value, '—');
    setText(note, '同步失敗，請稍後重試');
    metric.dataset.remainingMonthKey = '';
  });
}

async function prewarmRemainingMonth() {
  const { accessToken, userId } = readAuth();
  if (!accessToken || !userId) return false;
  try {
    const result = await loadRemainingMonthBatch();
    for (const owner of LOAN_OWNERS) {
      for (const loanType of LOAN_TYPES) {
        const key = loanMonthDataKey(userId, owner, loanType, todayKey());
        writeCache(key, result[loanMonthBucketKey(owner, loanType)]);
      }
    }
    return true;
  } catch {
    return false;
  }
}

refreshRemainingMonthSummary();
void prewarmRemainingMonth().then(ok => {
  // 剛登入時 auth token 可能比此模組晚落到 storage；補一次即可。
  if (!ok) setTimeout(() => void prewarmRemainingMonth(), 800);
});

if (root) {
  const observer = new MutationObserver(() => {
    // MutationObserver 會在 paint 前執行；同步套快取，但不重複改寫同一節點。
    refreshRemainingMonthSummary();
  });
  observer.observe(root, { childList: true, subtree: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshRemainingMonthSummary({ force: true });
});

document.addEventListener('ks:auth-change', event => {
  monthDataFlight = null;
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index) ?? '';
    if (key.startsWith(`${LOAN_MONTH_CACHE_PREFIX}|`)) localStorage.removeItem(key);
  }
  const expectedUserId = event.detail?.userId ?? '';
  if (!expectedUserId) return;
  // Auth 事件與 SDK 寫 localStorage 的先後不應影響隔離；只替事件指定的新帳號預熱。
  setTimeout(() => {
    if (readAuth().userId !== expectedUserId) return;
    refreshRemainingMonthSummary({ force: true });
    void prewarmRemainingMonth();
  }, 0);
});
