const root = document.querySelector('#root');
const SUPABASE_URL = 'https://gbxsnwqbjmgfikpblyot.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VtGM8w7CqxDB_3NaROR8OA_H0txX-_I';
const AUTH_STORAGE_KEY = 'sb-gbxsnwqbjmgfikpblyot-auth-token';

function readAccessToken() {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) return '';
  try {
    const data = JSON.parse(raw);
    return data?.access_token || data?.currentSession?.access_token || '';
  } catch {
    return '';
  }
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
  const token = readAccessToken();
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

async function loadRemainingMonth(owner, loanType) {
  const { year, month, day } = taipeiDateParts();
  const today = ymd(year, month, day);
  const next = month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1);

  const accounts = await rest('loan_accounts', [
    ['select', 'id'],
    ['status', 'eq.active'],
    ['owner_scope', `eq.${owner}`],
    ['loan_type', `eq.${loanType}`],
  ]);
  const ids = accounts.map(row => row.id).filter(Boolean);
  if (!ids.length) return { total: 0, count: 0, nextDue: null };

  const rows = await rest('loan_schedule', [
    ['select', 'loan_account_id,due_date,actual_date,amount_twd,applied_at'],
    ['loan_account_id', `in.(${ids.join(',')})`],
    ['entry_type', 'eq.payment'],
    ['applied_at', 'is.null'],
    ['due_date', `gte.${today}`],
    ['due_date', `lt.${next}`],
    ['order', 'due_date.asc'],
  ]);

  const validRows = rows.filter(row => !row.applied_at);
  const total = validRows.reduce((sum, row) => sum + Math.abs(Number(row.amount_twd) || 0), 0);
  return {
    total,
    count: validRows.length,
    nextDue: validRows[0]?.actual_date || validRows[0]?.due_date || null,
  };
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

function refreshRemainingMonthSummary() {
  const context = remainingMonthContext();
  if (!context) return;
  const { owner, loanType, metric } = context;
  const { year, month, day } = taipeiDateParts();
  const key = `${owner}|${loanType}|${ymd(year, month, day)}`;
  if (metric.dataset.remainingMonthKey === key) return;
  metric.dataset.remainingMonthKey = key;

  const label = metric.querySelector('span');
  const value = metric.querySelector('b');
  const note = metric.querySelector('small');
  if (label && label.textContent !== '本月剩餘還款') label.textContent = '本月剩餘還款';

  void loadRemainingMonth(owner, loanType).then(result => {
    if (!metric.isConnected || metric.dataset.remainingMonthKey !== key) return;
    if (value) value.textContent = formatMoney(result.total);
    if (note) {
      if (result.count <= 0) note.textContent = '本月已繳完';
      else note.textContent = `尚有 ${result.count} 筆待繳${result.nextDue ? ` · 最近 ${formatShortDate(result.nextDue)}` : ''}`;
    }
  }).catch(() => {
    if (!metric.isConnected || metric.dataset.remainingMonthKey !== key) return;
    metric.dataset.remainingMonthKey = '';
  });
}

refreshRemainingMonthSummary();

if (root) {
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refreshRemainingMonthSummary();
    });
  });
  observer.observe(root, { childList: true, subtree: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const context = remainingMonthContext();
  if (context) context.metric.dataset.remainingMonthKey = '';
  refreshRemainingMonthSummary();
});
