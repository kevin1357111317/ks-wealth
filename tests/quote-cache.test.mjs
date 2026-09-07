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

// 仍持有的標的，預設就是快取裡那幾檔
const LIVE = Object.keys(KLFAN_KEYS);

async function refresh({ cache, gold = null, twelveBudget = 8, live = LIVE, requestBody = {} }) {
  let stored = cache;
  const pruned = [];
  let storedGold = gold;   // ks_quote_cache 裡的 XAU/USD，null = 沒有或已過期
  const used = { fugle: 0, twelve: 0 };
  const written = [];      // 這一輪往 financial_items 寫進去的每一筆
  let fxDaily = null;      // 寫進 klfan_fx_daily 的那一列

  const factory = () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table) => ({
      select: () => {
        if (table === 'financial_items') return { eq: () => Promise.resolve({ data: ITEMS, error: null }) };
        if (table === 'ks_quote_cache') return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: storedGold, error: null }) }) };
        // 仍持有的標的。KLFAN 的函式讀的也是這個 view，現在寫回與修剪都照它走。
        if (table === 'klfan_live_symbols') return Promise.resolve({ data: live.map(symbol => ({ symbol })), error: null });
        return Promise.resolve({ data: stored, error: null });
      },
      update: (patch) => ({ eq: (_column, id) => {
        if (table === 'financial_items') written.push({ id, ...patch });
        return Promise.resolve({ error: null });
      } }),
      upsert: (rows) => {
        if (table === 'ks_quote_cache') storedGold = { ...rows };
        else if (table === 'klfan_fx_daily') fxDaily = { ...rows };
        else {
          // 真的 upsert 是照主鍵合併，不是整張表換掉 —— 換掉的話就看不出修剪有沒有做事
          const next = stored.map(row => ({ ...row }));
          for (const row of rows) {
            const at = next.findIndex(existing => existing.symbol === row.symbol);
            if (at >= 0) next[at] = { ...next[at], ...row };
            else next.push({ ...row });
          }
          stored = next;
        }
        return Promise.resolve({ error: null });
      },
      delete: () => ({ not: (column, operator, list) => {
        // 只實作 .not('symbol','in','("a","b")')，修剪就是靠這一招
        const keep = new Set(String(list).slice(1, -1).split(',').map(v => v.replace(/^"|"$/g, '')));
        pruned.push(...stored.filter(row => !keep.has(row[column])).map(row => row.symbol));
        stored = stored.filter(row => keep.has(row[column]));
        return Promise.resolve({ error: null });
      } }),
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
    const body = await (await fn.handler(new Request('https://x/fn', { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: JSON.stringify(requestBody) }))).json();
    return { body, used, stored, storedGold, written, fxDaily, pruned };
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

test('快取過期就重抓全部並寫回 klfan_quotes', async () => {
  const { body, used, stored } = await refresh({ cache: cacheRows(28 * 60_000) });
  assert.equal(used.twelve, 5, '匯率 + 三檔美股 + XAU/USD');
  assert.equal(body.failed, 0);
  assert.match(body.cache.write, /^wrote_/);
  assert.deepEqual(stored.map(r => r.symbol).sort(), [...Object.keys(KLFAN_KEYS), 'USD/TWD'].sort());
  // 寫回要沿用帶交易所前綴的 key 與來源標記，股票分析那邊是照這個 key 對報價的。
  assert.deepEqual(
    stored.find(r => r.symbol === 'NYSEARCA:VOO'),
    { symbol: 'NYSEARCA:VOO', price: US_PRICE.VOO, currency: 'USD', change: 1, change_percent: 0.2, source: 'twelve_data', quoted_at: stored[0].updated_at, updated_at: stored[0].updated_at },
  );
  assert.equal(stored.find(r => r.symbol === 'TPE:2330').source, 'fugle');
});

test('已出清標的的舊報價要修剪掉，不能一直留在表裡', async () => {
  // 這件事以前是 KLFAN 的 refresh-klfan-quotes 在做。KS Wealth 不再呼叫它之後，
  // 沒有人修剪的話：舊價會被當成即時價顯示，而且它永遠不在「仍持有」名單裡，
  // 涵蓋率永遠不滿，整個寫回就此停擺 —— 所有報價一起凍住。
  const sold = [{ symbol: 'TPE:2317', price: 200, change: 0, change_percent: 0, quoted_at: 'x' }];
  const { body, stored, pruned } = await refresh({ cache: cacheRows(28 * 60_000, sold) });
  assert.match(body.cache.write, /^wrote_/, '出清的那一檔不該擋住寫回');
  assert.deepEqual(pruned, ['TPE:2317']);
  assert.ok(!stored.some(r => r.symbol === 'TPE:2317'), '出清的舊價要被清掉');
  assert.deepEqual(stored.map(r => r.symbol).sort(), [...LIVE, 'USD/TWD'].sort());
});

test('仍持有的標的少抓到一檔就整批不寫', async () => {
  // 只補一半的話，最新的 updated_at 會讓沒更新的那幾檔看起來也很新。
  const { body, stored, pruned } = await refresh({
    cache: cacheRows(28 * 60_000),
    live: [...LIVE, 'TPE:9999'],   // 名單裡有一檔這一輪抓不到價
  });
  assert.equal(body.cache.write, 'skipped_partial_coverage');
  assert.deepEqual(pruned, [], '不寫的時候也不該修剪');
  assert.deepEqual(stored.map(r => r.symbol).sort(), [...LIVE, 'USD/TWD'].sort(), '快取應該原封不動');
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

test('一輪只用一個匯率，而且觸發器讀的那張表也跟著同一個數字', async () => {
  // financial_items 的 fx_rate_twd 有兩個寫入者：這支函式，以及讀 klfan_fx_daily 的
  // sync_klfan_financial_item() 觸發器。兩邊各自取數的話，同一輪會在資料庫裡留下兩個
  // 不同的匯率 —— 2026-09-07 08:45 美股 31.61732、黃金與美元現金 31.62785 就是這樣。
  const { written, fxDaily, body } = await refresh({ cache: cacheRows(60_000) });

  const usdRates = [...new Set(written.filter(row => row.fx_rate_twd > 1).map(row => Number(row.fx_rate_twd)))];
  assert.equal(usdRates.length, 1, `一輪裡所有 USD 項目要共用一個匯率，實際有 ${usdRates.join('、')}`);
  assert.equal(usdRates[0], FX);
  // 美股、美元現金、黃金三種路徑都要走到，不然這條測試沒測到重點
  assert.ok(written.filter(row => row.fx_rate_twd > 1).length >= 5);

  assert.ok(fxDaily, '要把這一輪的匯率寫進 klfan_fx_daily，觸發器才會跟著走');
  assert.equal(Number(fxDaily.rate), FX, 'klfan_fx_daily 要跟這一輪用的匯率一致');
  assert.match(fxDaily.fx_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.fx.dailyError, null);
});

test('匯率抓不到就不要動 klfan_fx_daily', async () => {
  // 匯率是 null 的時候寫下去會把觸發器的來源弄壞，寧可讓它留著昨天的。
  const { fxDaily } = await refresh({ cache: [], twelveBudget: 0 });
  assert.equal(fxDaily, null);
});

test('只要台股那一輪完全不碰 Twelve Data，也不寫資料庫', async () => {
  // 台股每 5 秒抓一次，走的是這條路。Fugle 免費、沒有 credit；但要是順手寫了
  // financial_items，realtime 訂閱會被自己觸發，每 5 秒重載整本台帳（一千多筆交易）。
  const { body, used, written, stored, fxDaily } = await refresh({
    cache: cacheRows(28 * 60_000),   // 快取過期，完整那一輪本來會全部重抓
    requestBody: { scope: 'tw' },
  });
  assert.equal(used.twelve, 0, '一個 credit 都不該花');
  assert.equal(used.fugle, 4, '四檔台股照抓');
  assert.equal(body.scope, 'tw');
  assert.deepEqual(written, [], '不該寫 financial_items');
  assert.equal(fxDaily, null, '也不該動匯率表');
  assert.deepEqual(stored.map(r => r.symbol).sort(), [...LIVE, 'USD/TWD'].sort(), 'klfan_quotes 原封不動');

  const prices = body.results.filter(r => r.status === 'quote_only');
  assert.equal(prices.length, 4);
  assert.equal(prices.find(r => r.symbol === '2330').price, FUGLE_PRICE['2330']);
});
