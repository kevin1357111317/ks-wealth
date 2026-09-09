// 這支測試守的是「為了加速加上去的快取沒有拿錯資料」。
//
// 股票分析頁每次 render() 都會整份重算台帳（每檔一個 XIRR，外加台股／美股／全部三個
// 總計）。但 render() 的觸發多半是「展開一張卡片」「切換顯示已出清」這種純畫面的事，
// 數字一個都沒動 —— 所以模型改成看指紋決定要不要重算。
//
// 快取出錯的下場是畫面上出現別人的錢：指紋漏了 ownerScope，老婆頁就會顯示老公的部位。
// 這裡就照著使用者真的會按的順序按一遍，比對每個畫面上的數字。
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
const BROWSER = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const skip = !chromium ? 'playwright 未安裝'
  : !existsSync(BROWSER) ? '找不到 Chromium'
  : false;

test('分析頁的快取不會端出別人或過期的數字', { skip }, async t => {
  // 老公一檔台積電、老婆一檔鴻海，市值差很多 —— 拿錯人一眼就看得出來。
  // 假 client 的報價：TPE:2330 = 2400、TPE:2317 = 200。
  const stocks = [
    { key: 'TPE:2330', household_id: 'H1', display: '台積電', market: '台股', currency: 'TWD', symbol: 'TPE:2330', owner_scope: 'husband' },
    { key: 'TPE:2317', household_id: 'H1', display: '鴻海', market: '台股', currency: 'TWD', symbol: 'TPE:2317', owner_scope: 'wife' },
    // 出清的那一檔：預設要藏起來，勾了「顯示已出清」才出現
    { key: 'TWO:8390', household_id: 'H1', display: '金益鼎', market: '台股', currency: 'TWD', symbol: 'TWO:8390', owner_scope: 'husband' },
  ];
  const transactions = [
    { id: 1, stock_key: 'TPE:2330', tx_date: '2023-01-05', amount: -520_000, shares: 1000, kind: 'trade' },
    { id: 2, stock_key: 'TPE:2317', tx_date: '2023-02-06', amount: -150_000, shares: 2000, kind: 'trade' },
    { id: 3, stock_key: 'TWO:8390', tx_date: '2022-03-07', amount: -40_000, shares: 500, kind: 'trade' },
    { id: 4, stock_key: 'TWO:8390', tx_date: '2024-04-08', amount: 55_000, shares: -500, kind: 'trade' },
  ];
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.klfan_stocks.push(...${JSON.stringify(stocks)});
db.klfan_transactions.push(...${JSON.stringify(transactions)});
for (const stock of db.klfan_stocks) {
  const shares = db.klfan_transactions.filter(t => t.stock_key === stock.key).reduce((sum, t) => sum + t.shares, 0);
  const price = { 'TPE:2330': 2400, 'TPE:2317': 200, 'TWO:8390': 0 }[stock.key];
  db.financial_items.push({ id: 'fi-' + stock.key, household_id: 'H1', kind: 'asset', category: '台股',
    name: stock.display, owner_scope: stock.owner_scope, amount_twd: Math.max(0, shares) * price,
    quantity: Math.max(0, shares), symbol: stock.symbol, market: 'TW', quote_currency: 'TWD',
    portfolio_stock_key: stock.key, sort_order: 1 });
}`;

  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
  const requested = [];
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    requested.push(path);
    const file = join(REPO, path.replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(REPO) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/plain' });
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: BROWSER });
  t.after(async () => { await browser.close(); server.close(); });

  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, locale: 'zh-TW' });
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('console', entry => { if (entry.type() === 'error') failures.push(entry.text()); });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('[data-tab]', { timeout: 20_000 });

  const openPortfolio = async tab => {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForSelector('[data-open-portfolio]');
    await page.click('[data-open-portfolio]');
    await page.waitForSelector('.portfolioStockCard', { timeout: 20_000 });
  };
  const shownStocks = () => page.$$eval('.portfolioStockCard [data-portfolio-stock]',
    nodes => nodes.map(node => node.querySelector('b').textContent.trim()));
  const marketValue = () => page.$eval('.portfolioMetric b', node => node.textContent.trim());

  await t.test('頭像是真的圖檔而且載得起來', async () => {
    // 這兩張以前是 base64 內嵌在 app-v3.js 裡（82 KB，佔整支檔案四成），改成一般圖檔。
    // 路徑打錯的話下面的 naturalWidth 會是 0 —— 導覽列上就是兩個破圖。
    const bears = await page.$$eval('.bottomNav .navBear', nodes =>
      nodes.map(node => ({ src: new URL(node.src).pathname, width: node.naturalWidth })));
    assert.equal(bears.length, 2, '導覽列應該有兩張頭像');
    for (const bear of bears) assert.ok(bear.width > 0, `${bear.src} 載不起來`);
    assert.ok(requested.includes('/icons/nav-bubu.png'), '布布的頭像要真的被抓過');
    assert.ok(requested.includes('/icons/nav-yier.png'), '一二的頭像要真的被抓過');
    const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
    assert.ok(!app.includes('data:image/png;base64'), 'app-v3.js 裡不該再有內嵌圖片');
  });

  await t.test('老公的分析頁只有老公的部位', async () => {
    await openPortfolio('husband');
    assert.deepEqual(await shownStocks(), ['台積電']);
    assert.equal(await marketValue(), 'NT$ 2,400,000');
  });

  await t.test('純畫面的操作不會讓數字跑掉', async () => {
    const before = await marketValue();
    // 展開卡片 → 收起來：兩次 render()，中間走的都是快取
    await page.click('[data-portfolio-stock="TPE:2330"]');
    await page.waitForSelector('.portfolioStockCard.open');
    assert.equal(await marketValue(), before, '展開卡片不該改到市值');
    await page.click('[data-portfolio-stock="TPE:2330"]');
    await page.waitForSelector('.portfolioStockCard:not(.open)');
    assert.equal(await marketValue(), before, '收合卡片不該改到市值');
  });

  await t.test('顯示已出清是畫面篩選，總計仍然照全部的部位算', async () => {
    const before = await marketValue();
    await page.check('[data-show-exited]');
    await page.waitForFunction(() => document.querySelectorAll('.portfolioStockCard').length === 2);
    assert.deepEqual(await shownStocks(), ['台積電', '金益鼎']);
    assert.equal(await marketValue(), before, '出清的部位市值是 0，總計不該變');
    await page.uncheck('[data-show-exited]');
    await page.waitForFunction(() => document.querySelectorAll('.portfolioStockCard').length === 1);
  });

  // 快取的指紋漏掉 ownerScope 的話，這裡就會端出老公那 240 萬。
  await t.test('切到老婆看到的是老婆的部位，不是快取裡老公的', async () => {
    await page.click('[data-tab="wife"]');
    await page.waitForSelector('[data-open-portfolio]');
    await page.click('[data-open-portfolio]');
    await page.waitForSelector('.portfolioStockCard', { timeout: 20_000 });
    assert.deepEqual(await shownStocks(), ['鴻海']);
    assert.equal(await marketValue(), 'NT$ 400,000');
  });

  await t.test('再切回老公還是老公的數字', async () => {
    await openPortfolio('husband');
    assert.deepEqual(await shownStocks(), ['台積電']);
    assert.equal(await marketValue(), 'NT$ 2,400,000');
  });

  await t.test('全程沒有 console 錯誤', () => {
    assert.deepEqual(failures, []);
  });
});
