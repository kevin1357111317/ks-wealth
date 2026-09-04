// 這支測試在意的是「一次更新會打掉幾個 Twelve Data credit」。
//
// 本專案與 KLFAN 共用同一個 Supabase 專案、同一把 TWELVE_DATA_API_KEY，
// 免費方案每分鐘 8 credits、一個 symbol 算一個。兩邊各自抓一輪是 9 個，
// 超額的必然是排在最後的 XAU/USD——2026-09-04 只有黃金沒更新就是這樣來的。
// 修法是共用 klfan_quotes 當快取，所以這裡直接跑真正的 Edge Function
// 原始碼、把 fetch 與 supabase client 換成假的，數 credit。
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const FUGLE_PRICE = { '0050': 106.2, '00631L': 35.41, '2330': 2390, '2454': 4340 };
const US_PRICE = { QQQ: 717.67, SOXX: 502.2, VOO: 710.72 };
const FX = 31.70519;
const XAU = 4479.1;

const ITEMS = [
  ...Object.keys(FUGLE_PRICE).map((symbol, i) => ({ id: `t${i}`, name: symbol, symbol, market: 'TW', quantity: 1000, native_currency: 'TWD' })),
  ...Object.keys(US_PRICE).map((symbol, i) => ({ id: `u${i}`, name: symbol, symbol, market: 'US', quantity: 100, native_currency: 'USD' })),
  { id: 'g1', name: '黃金', symbol: 'XAU/USD', market: 'GOLD', quantity: 193.3105, native_currency: 'USD' },
  { id: 'm1', name: '美金定存', symbol: null, market: 'MANUAL', quantity: null, native_currency: 'USD', native_amount: 46800 },
];

const KLFAN_KEYS = {
  'TPE:0050': '0050', 'TPE:00631L': '00631L', 'TPE:2330': '2330', 'TPE:2454': '2454',
  'NASDAQ:QQQ': 'QQQ', 'NASDAQ:SOXX': 'SOXX', 'NYSEARCA:VOO': 'VOO',
};

// klfan_quotes 的內容，ageMs 決定它算不算「夠新」（Edge Function 的 TTL 是 10 分鐘）。
function cacheRows(ageMs, extra = []) {
  const updated_at = new Date(Date.now() - ageMs).toISOString();
  const rows = Object.entries(KLFAN_KEYS).map(([symbol, code]) => ({
    symbol, price: FUGLE_PRICE[code] ?? US_PRICE[code], change: 1, change_percent: 1, quoted_at: 'x', updated_at,
  }));
  rows.push({ symbol: 'USD/TWD', price: FX, change: null, change_percent: null, quoted_at: 'x', updated_at });
  return [...rows, ...extra.map(r => ({ ...r, updated_at }))];
}

// 把 Edge Function 改成可以在 Node 底下 import：拿掉 Deno 專屬的部分，其餘原封不動。
const source = await readFile(new URL('../supabase/functions/refresh-tw-quotes/index.ts', import.meta.url), 'utf8');
const dir = await mkdtemp(join(tmpdir(), 'quote-cache-'));
const modulePath = join(dir, 'fn.ts');
await writeFile(modulePath, source
  .replace(/^import "jsr:.*$/m, '')
  .replace(/^import \{ createClient \} from "npm:.*$/m,
    'export let createClient: any; export let ENV: Record<string,string> = {};\nexport const __stub = (f: any, e: Record<string,string>) => { createClient = f; ENV = e; };')
  .replace(/Deno\.env\.get\(([^)]*)\)/g, '(ENV[$1] as string | undefined)')
  .replace('Deno.serve(async (req: Request) => {', 'export const handler = (async (req: Request) => {'));
const fn = await import(`file://${modulePath}`);

const ENV = {
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'ANON', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE',
  FUGLE_MARKETDATA_API_KEY: 'FUGLE', TWELVE_DATA_API_KEY: 'TWELVE',
};

async function refresh({ cache, gold = null, twelveBudget = 8 }) {
  let stored = cache;
  let storedGold = gold;   // ks_quote_cache 裡的 XAU/USD，null = 沒有或已過期
  const used = { fugle: 0, twelve: 0 };

  const factory = () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table) => ({
      select: () => {
        if (table === 'financial_items') return { eq: () => Promise.resolve({ data: ITEMS, error: null }) };
        if (table === 'ks_quote_cache') return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: storedGold, error: null }) }) };
        return Promise.resolve({ data: stored, error: null });
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      upsert: (rows) => {
        if (table === 'ks_quote_cache') storedGold = { ...rows };
        else stored = rows.map(r => ({ ...r }));
        return Promise.resolve({ error: null });
      },
    }),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('fugle.tw')) {
      used.fugle += 1;
      const code = decodeURIComponent(u.split('/').pop());
      return Response.json({ lastPrice: FUGLE_PRICE[code], change: 1, changePercent: 1, date: '2026-09-04' });
    }
    if (u.includes('twelvedata.com')) {
      used.twelve += 1;
      if (used.twelve > twelveBudget) return Response.json({ status: 'error', code: 429, message: 'run out of API credits' });
      if (u.includes('exchange_rate')) return Response.json({ rate: FX });
      if (u.includes('XAU')) return Response.json({ close: XAU, datetime: '2026-09-03' });
      return Response.json({ close: US_PRICE[/symbol=([^&]*)/.exec(u)[1]], change: 1, percent_change: 0.2, datetime: '2026-09-03', timestamp: 1 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  try {
    fn.__stub(factory, ENV);
    const body = await (await fn.handler(new Request('https://x/fn', { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: '{}' }))).json();
    return { body, used, stored, storedGold };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('快取夠新時只花 1 個 credit，黃金以外都沿用', async () => {
  const { body, used } = await refresh({ cache: cacheRows(60_000) });
  assert.equal(used.twelve, 1, '只該為 XAU/USD 打一次 Twelve Data');
  assert.equal(body.fx.rate, FX, '匯率該來自快取');
  assert.equal(body.failed, 0);
  assert.equal(body.cache.write, null, '沿用快取的那一輪不該寫回');
});

test('快取過期就重抓全部，並寫回給 KLFAN 用', async () => {
  const { body, used, stored } = await refresh({ cache: cacheRows(28 * 60_000) });
  assert.equal(used.twelve, 5, '匯率 + 三檔美股 + XAU/USD');
  assert.equal(body.failed, 0);
  assert.match(body.cache.write, /^wrote_/);
  assert.deepEqual(stored.map(r => r.symbol).sort(), [...Object.keys(KLFAN_KEYS), 'USD/TWD'].sort());
  // 寫回要沿用 KLFAN 自己的 key 與來源標記，否則它下一輪會把這些列 prune 掉。
  assert.deepEqual(
    stored.find(r => r.symbol === 'NYSEARCA:VOO'),
    { symbol: 'NYSEARCA:VOO', price: US_PRICE.VOO, currency: 'USD', change: 1, change_percent: 0.2, source: 'twelve_data', quoted_at: stored[0].updated_at, updated_at: stored[0].updated_at },
  );
  assert.equal(stored.find(r => r.symbol === 'TPE:2330').source, 'fugle');
});

test('只涵蓋一部分就不寫回，免得 KLFAN 把舊價當成新的', async () => {
  // KLFAN 多追一檔本專案沒有的台股。KLFAN 是看整張表最新的 updated_at 決定要不要重抓，
  // 這時候寫回會讓 2317 的舊價看起來是新的。
  const extra = [{ symbol: 'TPE:2317', price: 200, change: 0, change_percent: 0, quoted_at: 'x' }];
  const { body, stored } = await refresh({ cache: cacheRows(28 * 60_000, extra) });
  assert.equal(body.cache.write, 'skipped_partial_coverage');
  assert.ok(stored.some(r => r.symbol === 'TPE:2317'), '快取應該原封不動');
});

test('額度真的被吃光時，失敗的是黃金而且不會寫壞既有金額', async () => {
  // 這就是修好之前每次都會發生的情況：XAU/USD 排在最後，被 429 擋掉。
  const { body } = await refresh({ cache: cacheRows(28 * 60_000), twelveBudget: 4 });
  assert.equal(body.failed, 1);
  assert.equal(body.gold.error, 'twelve_429');
  assert.equal(body.results.find(r => r.market === 'GOLD').status, 'error', '抓不到價就不該寫 amount_twd');
});

test('XAU/USD 也要進快取，否則同一分鐘跑兩輪必定壓死黃金', async () => {
  // 第一輪冷快取：全部重抓，順手把金價寫進 ks_quote_cache。
  const first = await refresh({ cache: cacheRows(28 * 60_000) });
  assert.equal(first.used.twelve, 5);
  assert.equal(first.body.gold.price, XAU);
  assert.equal(first.body.gold.cached, false);
  assert.equal(first.storedGold.symbol, 'XAU/USD');
  assert.equal(first.storedGold.price, XAU);

  // 緊接著的第二輪（換 App 回來、頁面重載、手動按更新都會觸發）。修正前這一輪會再花
  // 5 個 credit，一分鐘合計 10 個、超過 8，被擋掉的必然是排最後的 XAU/USD。
  const second = await refresh({ cache: first.stored, gold: first.storedGold });
  assert.equal(second.used.twelve, 0, '兩邊都命中快取，一個 credit 都不該花');
  assert.equal(second.body.gold.price, XAU);
  assert.equal(second.body.gold.cached, true);
  assert.equal(second.body.failed, 0);
});

test('金價快取過期就重抓', async () => {
  const stale = { symbol: 'XAU/USD', price: 4000, updated_at: new Date(Date.now() - 28 * 60_000).toISOString() };
  const { body, used } = await refresh({ cache: cacheRows(60_000), gold: stale });
  assert.equal(used.twelve, 1, '只有 XAU/USD 要重抓');
  assert.equal(body.gold.price, XAU, '不該沿用過期的 4000');
  assert.equal(body.gold.cached, false);
});
