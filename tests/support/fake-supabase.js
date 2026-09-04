// 假的 supabase client：資料放記憶體，行為對齊 PostgREST 的 builder 介面，
// 並且模擬 sync_klfan_financial_item 觸發器 —— 這個功能的正確性關鍵就在
// 「financial_items 那一列是衍生的」，測試裡不模擬觸發器就測不到重點。
export const db = {
  household_members: [{ household_id: 'H1', role: 'owner', user_id: 'U1' }],
  households: [{ id: 'H1', name: '布布一二的家' }],
  financial_items: [],
  net_worth_history: [],
  financial_scope_history: [],
  klfan_stocks: [],
  klfan_transactions: [],
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

function builder(table, rows) {
  let filtered = rows;
  const api = {
    select() { return api; },
    eq(col, val) { filtered = filtered.filter(r => r[col] === val); return api; },
    order() { return api; },
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
    functions: { invoke: async () => ({ data: { results: [], updated: 0, priceOnly: 0, failed: 0, fx: {}, gold: {} }, error: null }) },
    rpc: async name => {
      if (name !== 'klfan_bootstrap') return { data: null, error: null };
      const stocks = db.klfan_stocks;
      const index = new Map(stocks.map((s, i) => [s.key, i]));
      return { data: {
        s: stocks.map(s => [s.key, s.display, s.market, s.currency, s.symbol, null]),
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
            if (table === 'klfan_transactions') row = { id: txSeq++, ...row };
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

