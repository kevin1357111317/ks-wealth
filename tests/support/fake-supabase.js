// 假的 supabase client：資料放記憶體，行為對齊 PostgREST 的 builder 介面，
// 並且模擬 sync_klfan_financial_item 觸發器 —— 這個功能的正確性關鍵就在
// 「financial_items 那一列是衍生的」，測試裡不模擬觸發器就測不到重點。
export const db = {
  household_members: [{ household_id: 'H1', role: 'owner', user_id: 'U1' }],
  households: [{ id: 'H1', name: '布布一二的家' }],
  financial_items: [],
  net_worth_history: [],
  financial_scope_history: [],
  tw_stock_names: [
    { code: '2330', name: '台積電', board: 'TPE' },
    { code: '2317', name: '鴻海', board: 'TPE' },
    { code: '8390', name: '金益鼎', board: 'TWO' },
  ],
  klfan_stocks: [],
  klfan_transactions: [],
  usd_transactions: [],
  loan_accounts: [],
  loan_schedule: [],
  loan_events: [],
};
export const calls = [];
let txSeq = 1000;

const EPS = 1e-7;
const PREFIX = /^(TPE:|TWO:|NASDAQ:|NYSEARCA:|NYSE:)/i;
const QUOTES = { 'TPE:2330': 2400, 'TPE:2317': 200, 'NASDAQ:QQQ': 717.67 };
const FX = 31.7;

// 對應 supabase/migrations/20260903000000_integrate_klfan_portfolio.sql 裡的
// sync_klfan_financial_item()：股數為零而且還沒有列時不建列。
function syncTrigger(key) {
  const stock = db.klfan_stocks.find(s => s.key === key);
  if (!stock) return;
  const shares = db.klfan_transactions.filter(t => t.stock_key === key)
    .reduce((sum, t) => sum + Number(t.shares || 0), 0);
  const price = QUOTES[String(stock.symbol).toUpperCase()] ?? 0;
  const value = Math.max(0, shares) * price * (stock.currency === 'USD' ? FX : 1);
  const bare = String(stock.symbol || stock.key).replace(PREFIX, '').toUpperCase();
  const marketCode = stock.market === '美股' ? 'US' : 'TW';
  const existing = db.financial_items.find(i => i.portfolio_stock_key === key);
  if (Math.abs(shares) <= EPS && !existing) return;
  const patch = {
    household_id: stock.household_id, owner_scope: stock.owner_scope, kind: 'asset',
    category: marketCode === 'US' ? '美股' : '台股', name: stock.display,
    amount_twd: value, symbol: bare, market: marketCode, quantity: Math.max(0, shares),
    quote_currency: stock.currency, fx_rate_twd: marketCode === 'US' ? FX : 1,
    quote_source: marketCode === 'US' ? 'twelve_data' : 'fugle', portfolio_stock_key: key,
  };
  if (existing) Object.assign(existing, patch);
  else db.financial_items.push({ id: `fi-${key}`, sort_order: 99, notes: null, ...patch });
}

// 對應 supabase/migrations/20260908100000_loan_autopay.sql 的 apply_due_loan_payments()：
// 銀行用 actual/365，利息 = 餘額 × 年利率 × 相隔天數 ÷ 365，本金 = 月付 − 利息；
// 寬限期內本金一律 0。只有 entry_type='payment' 的列算還款，撥款與開辦費不扣。
// 同一期扣過就不再扣（applied_at 不是 null 就跳過）。
export function applyDueLoanPayments(today) {
  const applied = [];
  for (const acct of db.loan_accounts) {
    if (acct.status !== 'active' || acct.autopay === false) continue;
    const item = db.financial_items.find(i => i.id === acct.financial_item_id && i.kind === 'liability');
    if (!item) continue;
    const rate = Number(item.interest_rate ?? acct.nominal_annual_rate ?? 0);
    const startedFrom = String(acct.last_payment_applied_on ?? acct.start_date);
    let balance = Number(item.amount_twd);
    let prev = startedFrom;
    const due = db.loan_schedule
      .filter(row => row.loan_account_id === acct.id && row.entry_type === 'payment'
        && String(row.due_date) <= today && !row.applied_at)
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    for (const row of due) {
      const days = Math.round((Date.parse(row.due_date) - Date.parse(prev)) / 86400000);
      const interest = Math.round(balance * rate / 100 * days / 365);
      const grace = acct.grace_until && String(row.due_date) <= String(acct.grace_until);
      const principal = grace
        ? 0
        : Math.min(balance, Math.max(0, Math.round(Math.abs(Number(row.amount_twd)) - interest)));
      balance -= principal;
      Object.assign(row, { applied_at: new Date().toISOString(), applied_principal_twd: principal,
        applied_interest_twd: interest, applied_balance_twd: balance });
      prev = String(row.due_date);
      applied.push({ loan_account_id: acct.id, loan_name: acct.name, due_date: row.due_date,
        principal_twd: principal, interest_twd: interest, balance_twd: balance });
    }
    if (prev !== startedFrom) {
      item.amount_twd = balance;
      acct.last_payment_applied_on = prev;
    }
  }
  return applied;
}

function builder(table, rows) {
  let filtered = rows;
  const api = {
    select() { return api; },
    eq(col, val) { filtered = filtered.filter(r => r[col] === val); return api; },
    is(col, val) { filtered = filtered.filter(r => (r[col] ?? null) === val); return api; },
    order(col) { filtered = [...filtered].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? ''))); return api; },
    range() { return api; },
    limit(n) { filtered = filtered.slice(0, n); return api; },
    single() { return Promise.resolve({ data: filtered[0] ?? null, error: null }); },
    maybeSingle() { return Promise.resolve({ data: filtered[0] ?? null, error: null }); },
    then(resolve) { return Promise.resolve({ data: filtered, error: null }).then(resolve); },
  };
  return api;
}

export function makeClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'U1' } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
    functions: { invoke: async (name, options) => {
      // 自動更新的測試靠這個計數。台股走 scope='tw' 的輕量路徑，跟完整那一輪分開記。
      const scope = options?.body?.scope === 'tw' ? 'tw' : 'all';
      globalThis.__invokes = globalThis.__invokes ?? {};
      globalThis.__invokes[name] = (globalThis.__invokes[name] ?? 0) + 1;
      globalThis.__scopes = globalThis.__scopes ?? { tw: 0, all: 0 };
      globalThis.__scopes[scope] += 1;
      if (scope === 'tw') return { data: { scope: 'tw', results: [] }, error: null };
      return { data: { results: [], updated: 1, priceOnly: 0, failed: 0, fx: { symbol: 'USD/TWD', rate: FX }, gold: {} }, error: null };
    } },
    rpc: async name => {
      if (name === 'apply_due_loan_payments') {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        return { data: applyDueLoanPayments(today), error: null };
      }
      // 每次整包重載都會叫一次。台帳有一千多筆交易（92 KB），報價更新不該碰它。
      globalThis.__bootstraps = (globalThis.__bootstraps ?? 0) + 1;
      if (name !== 'klfan_bootstrap') return { data: null, error: null };
      const stocks = db.klfan_stocks;
      const index = new Map(stocks.map((s, i) => [s.key, i]));
      return { data: {
        s: stocks.map(s => [s.key, s.display, s.market, s.currency, s.symbol, null, s.owner_scope ?? 'husband']),
        q: Object.entries(QUOTES).map(([sym, price]) => [sym, price, sym.startsWith('TPE') ? 'TWD' : 'USD', 'fugle', 'x', Date.now()]),
        t: db.klfan_transactions.map(t => [t.id, index.get(t.stock_key), t.tx_date, t.amount, t.shares, 0, t.kind === 'dividend' ? 1 : 0, 0, t.kind === 'dividend' ? t.amount : t.amount]),
        d: { banks: [''], notes: [''], kinds: ['trade', 'dividend'] },
      }, error: null };
    },
    from(table) {
      const rows = db[table] ?? [];
      return {
        select: () => builder(table, rows),
        insert(payload) {
          const list = Array.isArray(payload) ? payload : [payload];
          list.forEach(row => {
            // Postgres 會給 id，沒給的話點卡片時 items.find(id) 會找不到那一列
            if (table === 'klfan_transactions' || table === 'usd_transactions') row = { id: txSeq++, ...row };
            else if (table === 'financial_items' && row.id === undefined) row = { id: `fi-new-${txSeq++}`, ...row };
            rows.push(row);
            calls.push({ op: 'insert', table, row });
            if (table === 'klfan_transactions') syncTrigger(row.stock_key);
          });
          return Promise.resolve({ error: null });
        },
        update(patch) {
          const q = { rows, patch };
          const chain = {
            eq(col, val) { q.rows = q.rows.filter(r => r[col] === val); return chain; },
            then(resolve) {
              q.rows.forEach(r => Object.assign(r, patch));
              calls.push({ op: 'update', table, patch, n: q.rows.length });
              if (table === 'klfan_stocks') q.rows.forEach(r => syncTrigger(r.key));
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
        delete() {
          const q = { pred: [] };
          const chain = {
            eq(col, val) { q.pred.push([col, val]); return chain; },
            then(resolve) {
              const hit = r => q.pred.every(([c, v]) => r[c] === v);
              const gone = rows.filter(hit);
              for (let i = rows.length - 1; i >= 0; i -= 1) if (hit(rows[i])) rows.splice(i, 1);
              calls.push({ op: 'delete', table, n: gone.length });
              // ON DELETE CASCADE：klfan_transactions.stock_key -> klfan_stocks
              if (table === 'klfan_stocks') {
                gone.forEach(stock => {
                  for (let i = db.klfan_transactions.length - 1; i >= 0; i -= 1) {
                    if (db.klfan_transactions[i].stock_key === stock.key) db.klfan_transactions.splice(i, 1);
                  }
                  // ON DELETE SET NULL：financial_items.portfolio_stock_key
                  db.financial_items.forEach(i => { if (i.portfolio_stock_key === stock.key) i.portfolio_stock_key = null; });
                });
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
}
export const createClient = () => makeClient();
globalThis.__fake = { db, calls };

