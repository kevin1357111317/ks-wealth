// 日圓存款跟美金活存走同一條路：存原幣金額，台幣市值由 refresh-tw-quotes 每輪用
// JPY/TWD（= USD/TWD ÷ USD/JPY）重算。卡片要看得到日圓本身有多少，不是只有台幣。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_CURRENCIES, calculateTwdAmount, normalizeFinancialItem } from '../financial-core.js';

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

test('日圓是可用的原幣，換算用 JPY/TWD', () => {
  assert.ok(NATIVE_CURRENCIES.includes('JPY'));
  assert.equal(calculateTwdAmount({ nativeCurrency: 'JPY', nativeAmount: 368999, fxRateTwd: 0.2014 }), 74316);
  assert.throws(() => calculateTwdAmount({ nativeCurrency: 'JPY', nativeAmount: 1000, fxRateTwd: 0 }), /日圓匯率/);
  const row = normalizeFinancialItem({ amount_twd: '74316', native_currency: 'JPY', native_amount: '368999', fx_rate_twd: '0.2014', market: 'MANUAL' });
  assert.equal(row.native_currency, 'JPY');
  assert.equal(row.native_amount, 368999);
});

test('兩支 Edge Function 都會重估日圓存款', async () => {
  for (const name of ['refresh-tw-quotes', 'daily-wealth-snapshot']) {
    const source = await readFile(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8');
    assert.match(source, /native_currency === "JPY"/, `${name} 要挑出日圓存款`);
    assert.match(source, /symbol=USD%2FJPY/, `${name} 要抓 USD/JPY`);
    assert.match(source, /fxRate \/ usdJpy/, `${name} 要用 USD/TWD ÷ USD/JPY 交叉`);
    assert.match(source, /quote_currency: "JPY"/, `${name} 寫回時要標日圓，不能被當成美金匯率`);
  }
});

test('日圓活存：卡片顯示日圓金額，編輯表單用 JPY/TWD 換算', { skip }, async t => {
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'fi-jpy', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '日圓活存', owner_scope: 'husband', amount_twd: 74316, native_currency: 'JPY', native_amount: 368999,
  fx_rate_twd: 0.2014, quote_currency: 'JPY', quote_source: 'twelve_data', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-02T02:00:00Z' });`;

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
  if (!(await page.isVisible('.itemCard[data-id="fi-jpy"]'))) await page.click('.categoryHead');

  await t.test('卡片同時顯示台幣與日圓', async () => {
    const card = await page.textContent('.itemCard[data-id="fi-jpy"]');
    assert.match(card, /NT\$ 74,316/);
    assert.match(card, /¥ 368,999/);
    assert.match(card, /JPY/);
  });

  await t.test('編輯：屬性是日圓、匯率是 JPY/TWD，存回去仍是日圓', async () => {
    await page.click('.itemCard[data-id="fi-jpy"]');
    await page.waitForSelector('#editform');
    assert.equal(await page.inputValue('#cat'), 'cash-jpy');
    assert.match(await page.textContent('#amountLabel'), /日圓金額（JPY）/);
    assert.match(await page.textContent('#fxLabel'), /JPY\/TWD/);
    assert.equal(await page.inputValue('#fx'), '0.201400', '不能拿美金匯率來算日圓');
    await page.fill('#amt', '370000');
    assert.equal(await page.inputValue('#converted'), 'NT$ 74,518');
    await page.click('#save');
    await page.waitForSelector('#editform', { state: 'detached', timeout: 10_000 });
    const row = await page.evaluate(() => globalThis.__fake.db.financial_items.find(item => item.id === 'fi-jpy'));
    assert.equal(row.native_currency, 'JPY');
    assert.equal(row.native_amount, 370000);
    assert.equal(row.amount_twd, 74518);
    assert.equal(row.fx_rate_twd, 0.2014);
    assert.equal(row.quote_currency, 'JPY');
  });
});
