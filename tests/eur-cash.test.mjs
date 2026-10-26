// 歐元存款跟日圓存款走同一條路：存原幣金額，台幣市值由 refresh-tw-quotes 每輪用
// EUR/TWD（= EUR/USD × USD/TWD）重算。方向跟日圓相反，寫錯會差一千多倍。
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

test('歐元是可用的原幣，換算用 EUR/TWD', () => {
  assert.ok(NATIVE_CURRENCIES.includes('EUR'));
  assert.equal(calculateTwdAmount({ nativeCurrency: 'EUR', nativeAmount: 23.85, fxRateTwd: 36.497 }), 870);
  assert.throws(() => calculateTwdAmount({ nativeCurrency: 'EUR', nativeAmount: 10, fxRateTwd: 0 }), /歐元匯率/);
  const row = normalizeFinancialItem({ amount_twd: '870', native_currency: 'EUR', native_amount: '23.85', fx_rate_twd: '36.497', market: 'MANUAL' });
  assert.equal(row.native_currency, 'EUR');
  assert.equal(row.native_amount, 23.85);
});

test('兩支 Edge Function 都會重估歐元存款，而且是乘不是除', async () => {
  for (const name of ['refresh-tw-quotes', 'daily-wealth-snapshot']) {
    const source = await readFile(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8');
    assert.match(source, /native_currency === "EUR"/, `${name} 要挑出歐元存款`);
    assert.match(source, /symbol=EUR%2FUSD/, `${name} 要抓 EUR/USD`);
    assert.match(source, /eurUsd \* fxRate/, `${name} 要用 EUR/USD × USD/TWD 交叉`);
    assert.doesNotMatch(source, /fxRate \/ eurUsd/, `${name} 歐元不能照日圓的方向用除的`);
    assert.match(source, /quote_currency: "EUR"/, `${name} 寫回時要標歐元，不能被當成美金匯率`);
  }
});

test('歐元存款：卡片顯示歐元金額，編輯表單用 EUR/TWD 換算', { skip }, async t => {
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'fi-eur', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '歐元現金', owner_scope: 'husband', amount_twd: 870, native_currency: 'EUR', native_amount: 23.85,
  fx_rate_twd: 36.497, quote_currency: 'EUR', quote_source: 'twelve_data', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-10-26T02:00:00Z' });
db.financial_items.push({ id: 'fi-usd', household_id: 'H1', kind: 'asset', category: '現金及存款',
  name: '美金活存', owner_scope: 'husband', amount_twd: 3260, native_currency: 'USD', native_amount: 100,
  fx_rate_twd: 32.6, quote_currency: 'USD', quote_source: 'twelve_data', market: 'MANUAL',
  symbol: null, quantity: null, notes: null, sort_order: 2, updated_at: '2026-10-26T02:00:00Z' });`;

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
  if (!(await page.isVisible('.itemCard[data-id="fi-eur"]'))) await page.click('.categoryHead');

  await t.test('卡片同時顯示台幣與歐元', async () => {
    const card = await page.textContent('.itemCard[data-id="fi-eur"]');
    assert.match(card, /NT\$ 870/);
    assert.match(card, /€ 23\.85/);
    assert.match(card, /EUR/);
  });

  await t.test('編輯：屬性是歐元、匯率是 EUR/TWD，存回去仍是歐元', async () => {
    await page.click('.itemCard[data-id="fi-eur"]');
    await page.waitForSelector('#editform');
    assert.equal(await page.inputValue('#cat'), 'cash-eur');
    assert.match(await page.textContent('#amountLabel'), /歐元金額（EUR）/);
    assert.match(await page.textContent('#fxLabel'), /EUR\/TWD/);
    assert.equal(await page.inputValue('#fx'), '36.4970', '不能拿美金匯率來算歐元');
    await page.fill('#amt', '100');
    assert.equal(await page.inputValue('#converted'), 'NT$ 3,650');
    await page.click('#save');
    await page.waitForSelector('#editform', { state: 'detached', timeout: 10_000 });
    const row = await page.evaluate(() => globalThis.__fake.db.financial_items.find(item => item.id === 'fi-eur'));
    assert.equal(row.native_currency, 'EUR');
    assert.equal(row.native_amount, 100);
    assert.equal(row.amount_twd, 3650);
    assert.equal(row.fx_rate_twd, 36.497);
    assert.equal(row.quote_currency, 'EUR');
  });
});
