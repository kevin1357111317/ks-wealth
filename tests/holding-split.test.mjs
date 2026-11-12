// 股票分析的持股分布可以切成台股／美股比例（屋主 2026-11-12）。只有「全部」分頁、兩邊都有持股才有切換鈕。
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

test('持股分布右上角可以切換台美股比例', { skip }, async t => {
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.klfan_stocks.push({ key: '台積電', display: '台積電', market: '台股', currency: 'TWD', symbol: 'TPE:2330', owner_scope: 'husband', household_id: 'H1' });
db.klfan_stocks.push({ key: 'QQQ', display: 'QQQ', market: '美股', currency: 'USD', symbol: 'NASDAQ:QQQ', owner_scope: 'husband', household_id: 'H1' });
db.klfan_transactions.push({ id: 1, stock_key: '台積電', tx_date: '2026-01-05', amount: -20000, shares: 10, kind: 'trade' });
db.klfan_transactions.push({ id: 2, stock_key: 'QQQ', tx_date: '2026-01-05', amount: -600, shares: 1, kind: 'trade' });
syncTrigger('台積電'); syncTrigger('QQQ');`;

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
  await page.click('[data-open-portfolio]');
  await page.waitForSelector('.portfolioAllocation');

  assert.match(await page.textContent('.portfolioAllocation'), /持股分布.*2 檔/s);
  assert.equal(await page.textContent('[data-holding-toggle]'), '台美');
  await page.click('[data-holding-toggle]');
  const text = await page.textContent('.portfolioAllocation');
  // 台積電 10 × 2,400 = 24,000；QQQ 1 × 717.67 × 31.7 = 22,750 → 51.3% / 48.7%
  assert.match(text, /台美股比例.*台股.*51\.3%.*美股.*48\.7%/s, text);
  assert.equal(await page.textContent('[data-holding-toggle]'), '個股');

  // 切到台股分頁就只有一個市場，不給切換鈕，圓餅回到個股
  await page.click('[data-portfolio-market="台股"]');
  assert.equal(await page.locator('[data-holding-toggle]').count(), 0);
  assert.match(await page.textContent('.portfolioAllocation'), /持股分布.*台積電.*100\.0%/s);

  // 回到全部，維持上次選的台美比例
  await page.click('[data-portfolio-market="all"]');
  assert.match(await page.textContent('.portfolioAllocation'), /台美股比例/);
  await page.click('[data-holding-toggle]');
  assert.match(await page.textContent('.portfolioAllocation'), /持股分布.*台積電/s);
});
