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
    // 台股名字是中文、美股名字就是代號，標題不該再貼一組報價代號
    assert.doesNotMatch(await page.textContent('.portfolioStockTop'), /TPE:|NASDAQ:|NYSEARCA:/);
    // 標題列只留名字與市值：報酬率會被切掉，下面那一列也講得更清楚
    assert.doesNotMatch(await page.textContent('.portfolioStockTop'), /%/);
    // 收合摘要只留累計損益與年化報酬率；股數與淨投入移到展開區／不再重複
    const meta = await page.textContent('.portfolioStockMeta');
    assert.match(meta, /累計損益/);
    assert.match(meta, /年化報酬率/);
    assert.doesNotMatch(meta, /累計淨投入|持有股數/);
    await page.click('[data-portfolio-stock]');
    await page.waitForSelector('.portfolioStockDetail');
    // 還在同一頁：清單的市場切換與其他卡片都還在
    assert.ok(await page.isVisible('[data-portfolio-market="台股"]'), '沒有離開清單頁');
    assert.equal(await page.locator('#portfolioTxForm').count(), 0, '記交易只留在財務項目表單那一處');
    assert.equal(await page.locator('.portfolioTx').count(), 3, '完整歷史列在展開的卡片裡');
    const detail = await page.textContent('.portfolioStockDetail');
    for (const label of ['已實現損益', '未實現損益', '累計股息', '目前股價', '投資期間', '持有股數']) {
      assert.match(detail, new RegExp(label), `展開的內容應該有「${label}」`);
    }
    // 收合的摘要已經有這些了，展開不該再列一次
    for (const label of ['目前市值', '累計損益', '累計淨投入', '首筆交易']) {
      assert.doesNotMatch(detail, new RegExp(label), `「${label}」跟上面的摘要重複，不該出現在展開區`);
    }
    await page.click('[data-portfolio-stock]');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.portfolioStockDetail').count(), 0, '再點一次收起來');

    // render() 會重建整個 DOM，捲動位置本來會掉回頂部。把視窗壓矮讓頁面可捲，
    // 確認展開後畫面留在原地、被點的卡片也不動。
    await page.setViewportSize({ width: 390, height: 500 });
    // 卡片一定要先在畫面內：click() 會把視窗外的元素捲進來，那會蓋掉我們要量的東西。
    await page.evaluate(() => document.querySelector('[data-portfolio-stock]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(100);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    assert.ok(scrollBefore > 0, '測試前提：頁面要是可捲的');
    const topBefore = await page.$eval('[data-portfolio-stock]', el => Math.round(el.getBoundingClientRect().top));
    await page.click('[data-portfolio-stock]');
    await page.waitForSelector('.portfolioStockDetail');
    assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, '展開不該彈回頂部');
    const topAfter = await page.$eval('[data-portfolio-stock]', el => Math.round(el.getBoundingClientRect().top));
    assert.ok(Math.abs(topAfter - topBefore) <= 2, `被點的卡片要留在原位，實際差 ${topAfter - topBefore}px`);
    await page.click('[data-portfolio-stock]');
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goBack();
    await page.waitForSelector('.fab');
  });

  await t.test('台帳頁靠返回手勢離開，不再放返回按鈕', async () => {
    await page.click('[data-open-portfolio]');
    await page.waitForSelector('[data-portfolio-market]');
    assert.equal(await page.locator('[data-close-portfolio]').count(), 0, '返回按鈕已移除');

    // 台帳是狀態切換不是換頁，沒有推歷史的話返回手勢不會有反應
    await page.goBack();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-portfolio-market]').count(), 0, '返回鍵要能離開台帳');
    assert.ok(await page.isVisible('.fab'), '回到的是個人資產頁');

    // 底部導覽是拿掉按鈕後的另一條出口：render() 在台帳頁會直接回傳台帳畫面，
    // 不先收掉就會被困住
    await page.click('[data-open-portfolio]');
    await page.waitForSelector('[data-portfolio-market]');
    await page.click('[data-tab="dashboard"]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-portfolio-market]').count(), 0, '切分頁也要離得開');

    // 切分頁時是用 history.back() 收的，所以那一筆歷史要被消耗掉、不留在堆疊上
    assert.notEqual(await page.evaluate(() => window.history.state?.ks), 'portfolio',
      '切分頁後不該還留著台帳那一筆歷史');
    await page.click('[data-tab="husband"]');
    await page.waitForSelector('.fab');
  });

  await t.test('卡片每一列共用同一組左右邊界', async () => {
    await page.click('[data-open-portfolio]');
    await page.waitForSelector('[data-portfolio-stock]');
    await page.click('[data-portfolio-stock]');
    await page.waitForSelector('.portfolioStockDetail');
    const edges = await page.evaluate(() => {
      const card = document.querySelector('.portfolioStockCard');
      const rows = [];
      const push = (label, el) => {
        const box = el.getBoundingClientRect();
        rows.push({ label, left: Math.round(box.left), right: Math.round(box.right) });
      };
      const top = card.querySelector('.portfolioStockTop');
      push('title-name', top.children[0]);
      push('title-value', top.children[1]);
      const meta = card.querySelector('.portfolioStockMeta');
      push('meta-left', meta.children[0]);
      push('meta-right', meta.children[1]);
      card.querySelectorAll('.portfolioPair').forEach((pair, index) => {
        push(`pair${index}-left`, pair.children[0]);
        push(`pair${index}-right`, pair.children[1]);
      });
      return rows;
    });
    // 標題用 space-between、下面卻各佔一半的話，右欄會從卡片正中間開始，
    // 跟貼齊右緣的市值對不起來。所有列應該只有兩條邊界。
    const lefts = new Set(edges.filter(r => r.label.endsWith('-left') || r.label === 'title-name').map(r => r.left));
    const rights = new Set(edges.filter(r => r.label.endsWith('-right') || r.label === 'title-value').map(r => r.right));
    assert.equal(lefts.size, 1, `左邊界應該只有一種，實際 ${[...lefts].join(', ')}`);
    assert.equal(rights.size, 1, `右邊界應該只有一種，實際 ${[...rights].join(', ')}`);
    await page.click('[data-portfolio-stock]');
    await page.waitForTimeout(150);
    await page.goBack();
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

  await t.test('同一檔再買一次要併回原本的標的，不是另開一筆', async () => {
    // 先建一檔並全部賣掉 —— 出清後再買回來是最容易踩到的情境
    await page.click('.fab');
    await page.waitForSelector('#editform');
    await page.selectOption('#cat', 'stock-tw');
    await page.fill('#symbol', '2330');
    await page.waitForFunction(() => document.querySelector('#stockHint')?.textContent.includes('台積電'), null, { timeout: 5000 });
    await page.fill('#txAmount', '100000');
    await page.fill('#txShares', '100');
    await save();
    await openCard();
    await page.selectOption('#txAction', 'sell');
    await page.fill('#txAmount', '110000');
    await page.fill('#txShares', '100');
    await save();

    // 再從「＋」買回同一檔
    await page.click('.fab');
    await page.waitForSelector('#editform');
    await page.selectOption('#cat', 'stock-tw');
    await page.fill('#symbol', '2330');
    await page.waitForFunction(() => document.querySelector('#stockHint')?.textContent.includes('台積電'), null, { timeout: 5000 });
    await page.fill('#txAmount', '240000');
    await page.fill('#txShares', '100');
    await save();

    const data = await db();
    const tsmc = data.klfan_stocks.filter(row => String(row.symbol).endsWith('2330'));
    assert.equal(tsmc.length, 1, `同一檔不該變成兩個標的，實際 ${tsmc.map(r => r.key).join(', ')}`);
    assert.equal(data.klfan_transactions.filter(t => t.stock_key === tsmc[0].key).length, 3,
      '三筆交易要都掛在同一個標的下');
    assert.equal(data.financial_items.filter(i => i.portfolio_stock_key === tsmc[0].key).length, 1);
  });

  await t.test('分類展開後照金額由大到小排', async () => {
    // 刻意由小到大建立：照 sort_order（建立先後）與照金額會給出相反的結果
    for (const [name, amount] of [['小額', '10000'], ['中額', '500000'], ['大額', '9000000']]) {
      await page.click('.fab');
      await page.waitForSelector('#editform');
      await page.selectOption('#cat', 'cash-twd');
      await page.fill('#nm', name);
      await page.fill('#amt', amount);
      await save();
    }
    const cash = page.locator('.categoryGroup', { hasText: '現金及存款' });
    if (!(await cash.evaluate(el => el.classList.contains('open')))) await cash.locator('.categoryHead').click();
    await page.waitForTimeout(200);
    const order = await cash.locator('.itemCard .compactIdentity b').allTextContents();
    const mine = order.map(t => t.trim()).filter(name => ['大額', '中額', '小額'].includes(name));
    assert.deepEqual(mine, ['大額', '中額', '小額']);
  });


  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
