// 寶可夢卡牌從「其他」獨立成自己的資產分類（屋主 2026-11-11）。卡價多半是美金，
// 所以表單要跟保險、其他一樣能選幣別，而且分類排在保險之後、其他之前。
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

test('寶可夢卡牌是獨立分類，排在保險和其他之間，表單可選美金', { skip }, async t => {
  const item = (id, category, name, amount, extra = {}) => `db.financial_items.push(${JSON.stringify({
    id, household_id: 'H1', kind: 'asset', category, name, owner_scope: 'husband', amount_twd: amount,
    native_currency: 'TWD', native_amount: amount, fx_rate_twd: 1, quote_currency: 'TWD', quote_source: 'manual',
    market: 'MANUAL', symbol: null, quantity: null, notes: null, sort_order: 1, updated_at: '2026-11-11T02:00:00Z', ...extra,
  })});`;
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
${item('ins', '保險', '保單', 500)}
${item('other', '其他', '雜物', 100)}
${item('cards', '寶可夢卡牌', '寶可夢卡牌', 41000, { native_currency: 'USD', native_amount: 1246.68, quote_currency: 'USD', fx_rate_twd: 32.9 })}
${item('ray', '寶可夢卡牌', 'Rayquaza', 15000, { average_cost: 8500, native_currency: 'USD', native_amount: 456, quote_currency: 'USD', fx_rate_twd: 32.9 })}
${item('pika', '寶可夢卡牌', 'Pikachu', 3500, { average_cost: 9500, native_currency: 'USD', native_amount: 106, quote_currency: 'USD', fx_rate_twd: 32.9 })}`;

  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const file = join(REPO, req.url.split('?')[0].replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(REPO) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/plain' });
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, resolve));
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(async () => { await browser.close(); server.close(); });

  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, locale: 'zh-TW' });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForSelector('[data-tab="husband"]', { timeout: 20_000 });
  await page.click('[data-tab="husband"]');
  await page.waitForSelector('.categoryHead');

  const groups = await page.$$eval('.categoryHead span', nodes => nodes.map(node => node.textContent.trim()));
  assert.deepEqual(groups, ['保險', '寶可夢卡牌', '其他']);
  const legend = await page.$$eval('.legendRow span', nodes => nodes.map(node => node.textContent.trim()));
  assert.ok(legend.includes('寶可夢卡牌'), '資產分布圓餅也要列出來');

  // 分類標題只寫筆數，不顯示合計損益（屋主 2026-11-11：外面不用顯示）；損益只在每張卡上
  const head = await page.textContent('.categoryHead:has-text("寶可夢卡牌") small');
  assert.equal(head.trim(), '3 筆');
  await page.click('.categoryHead:has-text("寶可夢卡牌")');
  await page.waitForSelector('.itemCard[data-id="ray"]');
  const ray = await page.textContent('.itemCard[data-id="ray"] .compactMeta');
  assert.match(ray, /成本 8,500/);
  assert.match(ray, /\+6,500（\+76\.47%）/);
  assert.equal(await page.$eval('.itemCard[data-id="ray"] .cardProfit', node => node.classList.contains('up')), true, '賺是紅色');
  const pika = await page.textContent('.itemCard[data-id="pika"] .compactMeta');
  assert.match(pika, /\u22126,000（-63\.16%）/);
  assert.equal(await page.$eval('.itemCard[data-id="pika"] .cardProfit', node => node.classList.contains('down')), true, '賠是綠色');
  assert.equal(await page.locator('.itemCard[data-id="cards"] .cardProfit').count(), 0, '沒填成本就不顯示損益，不當成 0');

  // 表單填成本，存回 average_cost
  await page.click('.itemCard[data-id="cards"]');
  await page.waitForSelector('#editform');
  assert.equal(await page.isVisible('#costBox'), true, '寶可夢卡牌才有成本欄');
  await page.fill('#cost', '40,000');
  await page.click('#save');
  await page.waitForSelector('#editform', { state: 'detached' });
  assert.equal(await page.evaluate(() => globalThis.__fake.db.financial_items.find(row => row.id === 'cards').average_cost), 40000);
  await page.waitForSelector('.itemCard[data-id="cards"] .cardProfit');

  await page.click('.itemCard[data-id="cards"]');
  await page.waitForSelector('#editform');
  assert.equal(await page.inputValue('#cat'), 'pokemon');
  assert.equal(await page.isVisible('#currencyBox'), true, '寶可夢卡牌可以選幣別');
  assert.equal(await page.inputValue('#manualCurrency'), 'USD');
  const options = await page.$$eval('#cat option', nodes => nodes.map(node => node.textContent.trim()));
  assert.ok(options.indexOf('寶可夢卡牌') === options.indexOf('其他') - 1, `選單順序：${options}`);
  // 換成別的分類就沒有成本欄
  await page.selectOption('#cat', 'other');
  assert.equal(await page.isVisible('#costBox'), false);
});
