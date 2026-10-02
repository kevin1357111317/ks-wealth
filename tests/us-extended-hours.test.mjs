// 美股盤前盤後的價來自 Yahoo，卡片上要標「盤前」「盤後」，不然會以為是盤中成交。
// 盤中（session='regular'）或台股維持原樣，不多一個標籤。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium = null;
for (const specifier of [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean)) {
  try {
    const loaded = await import(specifier);
    chromium = loaded.chromium ?? loaded.default?.chromium ?? null;
    if (chromium) break;
  } catch { /* 換下一個 */ }
}

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CODEX_BROWSER = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BROWSER = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || (existsSync(CODEX_BROWSER) ? CODEX_BROWSER : chromium?.executablePath());
const skip = !chromium ? 'playwright 未安裝'
  : !BROWSER || !existsSync(BROWSER) ? '找不到 Chromium'
  : false;

test('美股卡片標出盤前盤後，盤中不標', { skip }, async t => {
  const item = (id, symbol) => `{ id: '${id}', household_id: 'H1', kind: 'asset', category: '美股', name: '${symbol}',
    owner_scope: 'husband', amount_twd: 100000, symbol: '${symbol}', market: 'US', quantity: 10, fx_rate_twd: 32,
    quote_currency: 'USD', quote_source: 'twelve_data', native_currency: null, native_amount: null, notes: null,
    sort_order: 1, updated_at: '2026-10-02T02:00:00Z' }`;
  const quote = (id, symbol, session) => `{ id: '${id}', symbol: '${symbol}', market: 'US', status: 'updated',
    provider: 'yahoo', currency: 'USD', price: 705.32, change: 4.46, changePercent: 0.64, session: '${session}' }`;
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push(${item('fi-voo', 'VOO')}, ${item('fi-soxx', 'SOXX')});
globalThis.__quoteResults = { all: [${quote('fi-voo', 'VOO', 'post')}, ${quote('fi-soxx', 'SOXX', 'regular')}] };`;

  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const file = join(REPO, req.url.split('?')[0].replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(REPO) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/plain' });
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(async () => { await browser.close(); server.close(); });

  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, locale: 'zh-TW' });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('[data-tab]', { timeout: 20_000 });
  await page.click('[data-tab="husband"]');
  await page.waitForSelector('.categoryHead');
  if (!(await page.isVisible('.itemCard[data-id="fi-voo"]'))) await page.click('.categoryHead');
  await page.waitForSelector('.itemCard[data-id="fi-voo"] .quoteLive', { timeout: 10_000 });

  assert.equal(await page.textContent('.itemCard[data-id="fi-voo"] .quoteSession'), '盤後');
  assert.match(await page.textContent('.itemCard[data-id="fi-voo"] .quoteLive'), /US\$ 705\.32.*\+0\.64%/);
  assert.equal(await page.$('.itemCard[data-id="fi-soxx"] .quoteSession'), null, '盤中不加標籤');
});
