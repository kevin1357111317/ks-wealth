// 台股／美股的股數與市值是從 klfan_transactions 推算出來的，financial_items 那一列
// 完全是 sync_klfan_financial_item() 觸發器寫出來的衍生資料。這裡在真的瀏覽器裡跑
// app-v3.js，把 supabase client 換成記憶體版（含觸發器與 FK cascade 的行為），
// 確認「新增財務項目 → 選台股 → 記交易」這條路徑不會重複記帳、股數確實由交易決定。
//
// 需要 playwright；沒裝就整支跳過，讓 node --test tests/*.test.mjs 在任何機器上都能跑完。
// 裝在專案外面（例如全域）的話，用 PLAYWRIGHT_PATH 指到它的進入點：
//   PLAYWRIGHT_PATH=$(npm root -g)/playwright node --test tests/*.test.mjs
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
    // playwright 是 CommonJS，用路徑載進來時具名匯出不一定認得出來，要退回 default。
    chromium = loaded.chromium ?? loaded.default?.chromium ?? null;
    if (chromium) break;
  } catch { /* 換下一個 */ }
}

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BROWSER = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const skip = !chromium ? 'playwright 未安裝'
  : !existsSync(BROWSER) ? '找不到 Chromium'
  : false;

test('新增財務項目選台股就能記交易，而且不會重複記帳', { skip }, async t => {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
  const stub = await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8');
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
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('console', entry => { if (entry.type() === 'error') failures.push(entry.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());

  const db = () => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__fake.db)));
  const settle = () => page.waitForTimeout(400);
  const openCard = async () => {
    // 資產列表的分類預設收合。
    if (!(await page.isVisible('.itemCard'))) await page.click('.categoryHead');
    await page.click('.itemCard');
    await page.waitForSelector('#editform');
  };
  const save = async () => {
    await page.click('#save');
    await page.waitForSelector('#editform', { state: 'detached', timeout: 10_000 });
    await settle();
  };

  await page.goto(`${base}/index.html`);
  await page.waitForSelector('[data-tab]', { timeout: 20_000 });
  await page.click('[data-tab="husband"]');   // ＋ 只在個人頁出現
  await page.waitForSelector('.fab');

  await t.test('選台股就換成交易輸入，不再問持有股數', async () => {
    await page.click('.fab');
    await page.waitForSelector('#editform');
    await page.selectOption('#cat', 'stock-tw');
    assert.ok(await page.isVisible('#ledgerFields'), '應該出現新增交易區');
    assert.ok(!(await page.isVisible('#qtyBox')), '股數由交易推算，不該再手打');
    assert.ok(!(await page.isVisible('#nameBox')), '股票沒有名稱欄，用代號當名字');
    assert.equal(await page.locator('#txNote').count(), 0, '交易備註拿掉了，只留項目自己的備註');
    // 代號＋類型／金額＋股數／日期＋銀行，三組都要是整齊的兩欄
    const widths = await page.$$eval('#stockFields .two', rows => rows
      .filter(row => row.getBoundingClientRect().height > 0)
      .map(row => [...row.children].filter(el => el.getBoundingClientRect().width > 0)
        .map(el => Math.round(el.getBoundingClientRect().width))));
    assert.equal(widths.length, 3, '應該是三組兩欄');
    for (const [a, b] of widths) assert.equal(a, b, `兩欄要等寬，實際 ${a} vs ${b}`);
    await page.fill('#symbol', '2330');
    await page.waitForFunction(() => document.querySelector('#stockHint')?.textContent.includes('台積電'), null, { timeout: 5000 });
    assert.match(await page.textContent('#stockHint'), /台積電（TPE:2330）/, '打代號要查出證交所名稱');
  });

  await t.test('打中文名也查得到，上櫃股要配 TWO 前綴', async () => {
    await page.fill('#symbol', '金益鼎');
    await page.waitForFunction(() => document.querySelector('#stockHint')?.textContent.includes('TWO'), null, { timeout: 5000 });
    assert.match(await page.textContent('#stockHint'), /金益鼎（TWO:8390）/);
    await page.fill('#symbol', '2330');
    await page.waitForFunction(() => document.querySelector('#stockHint')?.textContent.includes('台積電'), null, { timeout: 5000 });
  });

  await t.test('第一筆交易寫進台帳，資產列由觸發器產生', async () => {
    await page.fill('#txAmount', '2400000');
    await page.fill('#txShares', '1000');
    await save();
    const data = await db();
    assert.equal(data.klfan_stocks.length, 1);
    assert.equal(data.klfan_stocks[0].symbol, 'TPE:2330', '裸代號要自動補交易所前綴');
    assert.equal(data.klfan_stocks[0].display, '台積電', '台股用證交所的正式名稱當標的名');
    assert.equal(data.klfan_transactions.length, 1);
    assert.equal(data.klfan_transactions[0].amount, -2400000, '買進要存成負數現金流');
    assert.equal(data.klfan_transactions[0].shares, 1000);
    assert.equal(data.financial_items.length, 1, '不能同時自己再插一列，否則資產會被算兩次');
    assert.equal(data.financial_items[0].portfolio_stock_key, '2330');
    assert.equal(data.financial_items[0].amount_twd, 2_400_000);
  });

  await t.test('編輯既有標的看得到紀錄，賣出會改變股數', async () => {
    await openCard();
    assert.ok(await page.isVisible('#txHistoryBox'));
    assert.equal(await page.locator('#txHistory .portfolioTx').count(), 1);
    await page.selectOption('#txAction', 'sell');
    await page.fill('#txAmount', '500000');
    await page.fill('#txShares', '200');
    await save();
    const data = await db();
    assert.equal(data.klfan_transactions.length, 2);
    assert.equal(data.financial_items.length, 1);
    assert.equal(data.financial_items[0].quantity, 800);
    assert.equal(data.financial_items[0].amount_twd, 1_920_000);
  });

  await t.test('股息不動股數', async () => {
    await openCard();
    await page.selectOption('#txAction', 'dividend');
    assert.ok(!(await page.isVisible('#txSharesBox')), '股息沒有股數');
    await page.fill('#txAmount', '30000');
    await save();
    const data = await db();
    assert.equal(data.financial_items[0].quantity, 800);
    assert.equal(data.klfan_transactions.filter(row => row.kind === 'dividend').length, 1);
  });

  await t.test('交易區留白就只改標的本身', async () => {
    await openCard();
    await page.fill('#symbol', '2317');
    await page.waitForFunction(() => document.querySelector('#stockHint')?.textContent.includes('鴻海'), null, { timeout: 5000 });
    await save();
    const data = await db();
    assert.equal(data.klfan_transactions.length, 3, '留白不該多記一筆');
    assert.equal(data.klfan_stocks[0].symbol, 'TPE:2317', '改代號要寫回台帳');
    assert.equal(data.klfan_stocks[0].display, '鴻海', '名稱跟著證交所走');
  });

  await t.test('台帳卡片就地展開，不跳頁', async () => {
    await page.click('[data-open-portfolio]');
    await page.waitForSelector('[data-portfolio-stock]');
    assert.equal(await page.locator('.portfolioStockDetail').count(), 0, '一開始是收合的');
    await page.click('[data-portfolio-stock]');
    await page.waitForSelector('.portfolioStockDetail');
    // 還在同一頁：清單的市場切換與其他卡片都還在
    assert.ok(await page.isVisible('[data-portfolio-market="台股"]'), '沒有離開清單頁');
    assert.equal(await page.locator('#portfolioTxForm').count(), 0, '記交易只留在財務項目表單那一處');
    assert.equal(await page.locator('.portfolioTx').count(), 3, '完整歷史列在展開的卡片裡');
    const detail = await page.textContent('.portfolioStockDetail');
    for (const label of ['已實現損益', '未實現損益', '累計股息', '投資期間', '首筆交易', '持有股數']) {
      assert.match(detail, new RegExp(label), `展開的內容應該有「${label}」`);
    }
    await page.click('[data-portfolio-stock]');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.portfolioStockDetail').count(), 0, '再點一次收起來');
    await page.click('[data-close-portfolio]');
    await page.waitForSelector('.fab');
  });

  await t.test('刪除要連台帳一起刪，否則觸發器會把它重建回來', async () => {
    await openCard();
    await page.click('#del');
    await page.waitForTimeout(800);
    const data = await db();
    assert.equal(data.klfan_stocks.length, 0);
    assert.equal(data.klfan_transactions.length, 0, 'cascade 應該把交易一起帶走');
    assert.equal(data.financial_items.length, 0);
  });

  await t.test('其他資產類別完全不受影響', async () => {
    await page.click('.fab');
    await page.waitForSelector('#editform');
    await page.selectOption('#cat', 'cash-twd');
    assert.ok(!(await page.isVisible('#ledgerFields')));
    assert.ok(await page.isVisible('#manualFields'));
    await page.fill('#nm', '活存');
    await page.fill('#amt', '50000');
    await save();
    const data = await db();
    assert.equal(data.financial_items.length, 1);
    assert.equal(data.financial_items[0].amount_twd, 50000);
    assert.equal(data.klfan_stocks.length, 0, '現金不該碰台帳');
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
