// 現金及存款不照金額排：活存在前、定存在後，同類再照幣別台幣 → 美金 → 日圓 → 歐元。
// 其他分類維持金額由大到小。
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

test('現金及存款：活存在前、定存在後，幣別台美日歐；其他分類照金額', { skip }, async t => {
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'usd-fixed', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '美金定存', owner_scope: 'husband', amount_twd: 1525048, native_currency: 'USD', native_amount: 46797,
  fx_rate_twd: 1, quote_currency: 'USD', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'twd', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '台幣活存', owner_scope: 'husband', amount_twd: 234553, native_currency: 'TWD', native_amount: 234553,
  fx_rate_twd: 1, quote_currency: 'TWD', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'jpy', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '日圓活存', owner_scope: 'husband', amount_twd: 8869, native_currency: 'JPY', native_amount: 42860,
  fx_rate_twd: 1, quote_currency: 'JPY', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'eur', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '歐元活存', owner_scope: 'husband', amount_twd: 869, native_currency: 'EUR', native_amount: 23.85,
  fx_rate_twd: 1, quote_currency: 'EUR', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'usd', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '美金活存', owner_scope: 'husband', amount_twd: 198, native_currency: 'USD', native_amount: 6.07,
  fx_rate_twd: 1, quote_currency: 'USD', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'ins-small', household_id: 'H1', kind: 'asset', category: '保險',
  name: '小保單', owner_scope: 'husband', amount_twd: 100, native_currency: 'TWD', native_amount: 100,
  fx_rate_twd: 1, quote_currency: 'TWD', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'ins-big', household_id: 'H1', kind: 'asset', category: '保險',
  name: '大保單', owner_scope: 'husband', amount_twd: 900, native_currency: 'TWD', native_amount: 900,
  fx_rate_twd: 1, quote_currency: 'TWD', quote_source: 'manual', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });`;

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
  // 點一下會整區重繪，手上的節點就失效了 —— 每次重新找下一個還沒展開的。
  while (await page.$('.categoryGroup:not(.open) .categoryHead')) {
    await page.click('.categoryGroup:not(.open) .categoryHead');
  }
  await page.waitForSelector('.itemCard[data-id="ins-big"]');

  const order = await page.$$eval('.itemCard', cards => cards.map(card => card.dataset.id));
  const cash = order.filter(id => ['usd-fixed', 'twd', 'jpy', 'eur', 'usd'].includes(id));
  assert.deepEqual(cash, ['twd', 'usd', 'jpy', 'eur', 'usd-fixed']);
  const insurance = order.filter(id => id.startsWith('ins-'));
  assert.deepEqual(insurance, ['ins-big', 'ins-small'], '其他分類仍照金額由大到小');
});
