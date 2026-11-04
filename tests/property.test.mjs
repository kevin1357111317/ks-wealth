// 房子帳：取代「房子統計」試算表。數字全部是假的 —— 真的金額與坪數只在 Supabase。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketOf, calculatePropertyLedger, latestInCategory, propertyFacts, splitPayer } from '../property-core.js';

test('坪數與單價照試算表「詳細」的公式算', () => {
  const facts = propertyFacts({
    total_price_wan: 1000, parking_price_wan: 100,
    indoor_ping: 20, awning_ping: 1, balcony_ping: 2, common_ping: 7, parking_ping: 10,
  });
  assert.equal(facts.totalArea, 40);
  assert.equal(facts.buildingArea, 30, '建物面積 = 總面積 − 車位面積');
  assert.equal(facts.unitPrice, 25, '含車位：總價 ÷ 總面積');
  assert.equal(facts.unitPriceExParking, 30, '不含車位：(總價 − 車位價) ÷ 建物面積');
});

test('沒有車位時兩種單價一樣，沒有總價就不算單價', () => {
  const facts = propertyFacts({ total_price_wan: 600, indoor_ping: 20, common_ping: 10 });
  assert.equal(facts.unitPrice, 20);
  assert.equal(facts.unitPriceExParking, 20);
  assert.equal(propertyFacts({ indoor_ping: 10 }).unitPrice, null);
});

test('分類歸到購屋／裝潢家具家電／持有成本，對不到的算持有成本', () => {
  assert.equal(bucketOf('房屋款項'), 'purchase');
  assert.equal(bucketOf('房屋代書款項'), 'purchase');
  assert.equal(bucketOf('驗屋款項'), 'purchase');
  assert.equal(bucketOf('覓蜜裝潢款項'), 'furnish');
  assert.equal(bucketOf('傢俱款項'), 'furnish');
  assert.equal(bucketOf('冷氣款項'), 'furnish');
  assert.equal(bucketOf('家電款項'), 'furnish');
  for (const category of ['水費', '電費', '管理費', '房屋稅', '機車位', '新開的分類']) {
    assert.equal(bucketOf(category), 'holding', category);
  }
});

const rows = [
  { id: 1, category: '房屋款項', expense_date: '2024-01-01', amount_twd: -1000, item: '頭期款', payer: 'KL', sort_order: 1 },
  { id: 2, category: '房屋款項', expense_date: '2024-01-02', amount_twd: -800, item: '頭期款', payer: 'CH', sort_order: 2 },
  { id: 3, category: '房屋代書款項', expense_date: '2024-02-01', amount_twd: 50, item: '退款', payer: 'KL/CH', sort_order: 3 },
  { id: 4, category: '家電款項', expense_date: '2024-03-01', amount_twd: -300, item: '冰箱', payer: 'KL/CH', sort_order: 4 },
  { id: 5, category: '管理費', expense_date: '2025-10-31', amount_twd: -100, item: '管理費', detail: '114/10', payer: 'KL/CH', sort_order: 5 },
  { id: 6, category: '管理費', expense_date: '2025-11-01', amount_twd: -100, item: '管理費', detail: '114/11', payer: 'KL/CH', sort_order: 6 },
  { id: 7, category: '管理費', expense_date: '2026-11-01', amount_twd: -100, item: '管理費', detail: '115/11', payer: 'KL/CH', sort_order: 7 },
  { id: 8, category: '管理費', expense_date: '2026-12-01', amount_twd: -100, item: '管理費', detail: '115/12', payer: 'KL/CH', sort_order: 8 },
  { id: 9, category: '機車位', expense_date: '2026-03-01', amount_twd: 240, item: '出租', payer: 'KL', sort_order: 9 },
  { id: 10, category: '水費', expense_date: '2024-06-01', amount_twd: -20, item: '水費', payer: '建商', sort_order: 10 },
];

test('合計、三大塊、近 12 個月持有成本', () => {
  const model = calculatePropertyLedger(rows, '2026-11-01');
  assert.equal(model.count, 10);
  assert.equal(model.net, -2230);
  assert.deepEqual(model.buckets, { purchase: -1750, furnish: -300, holding: -180 });
  // 2025-11-01 往後到今天：2025-11-01 那筆剛好落在 365 天前 → 不算；2026-11-01 算；2026-12-01 是未來 → 不算
  // 2025-11-02 ~ 2026-11-01 之間：-100（2026-11-01）+ 240（機車位） = +140
  assert.equal(model.recentHolding, 140);
  assert.equal(model.firstDate, '2024-01-01');
});

test('分類照試算表順序，分類裡新的在上面', () => {
  const model = calculatePropertyLedger(rows, '2026-11-01');
  assert.deepEqual(model.categories.map(group => group.category),
    ['房屋款項', '房屋代書款項', '家電款項', '管理費', '機車位', '水費']);
  const fee = model.categories.find(group => group.category === '管理費');
  assert.deepEqual(fee.rows.map(row => row.id), [8, 7, 6, 5]);
  assert.equal(fee.total, -400);
  assert.equal(fee.lastDate, '2026-12-01');
});

test('付款分攤：KL/CH 各半，單一名字全付', () => {
  assert.deepEqual(splitPayer('KL/CH'), ['KL', 'CH']);
  assert.deepEqual(splitPayer(' KL '), ['KL']);
  assert.deepEqual(splitPayer(null), []);
  const payers = Object.fromEntries(calculatePropertyLedger(rows, '2026-11-01').payers.map(p => [p.name, p.amount]));
  // KL: -1000 + 240 + 半份(50 − 300 − 400) = -760 − 325 = -1085；CH: -800 − 325 = -1125
  assert.equal(payers.KL, -1085);
  assert.equal(payers.CH, -1125);
  assert.equal(payers['建商'], -20);
});

test('新增時預填：同分類最近一筆', () => {
  assert.equal(latestInCategory(rows, '管理費').id, 8);
  assert.equal(latestInCategory(rows, '沒有這類'), null);
});

// 瀏覽器流程 -------------------------------------------------------------------

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

test('房子頁：入口、切換房子、展開分類、記一筆、改、刪、比較', { skip }, async t => {
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.properties.push(
  { id: 1, household_id: 'H1', key: 'a', name: '甲房', label: '我家', total_price_wan: 1000, parking_price_wan: 100,
    indoor_ping: 20, awning_ping: 1, balcony_ping: 2, common_ping: 7, parking_ping: 10, has_ledger: true, sort_order: 1 },
  { id: 2, household_id: 'H1', key: 'b', name: '乙房', label: null, total_price_wan: 500, parking_price_wan: 0,
    original_price_twd: 4000000, acquired_on: '2021-01-01',
    indoor_ping: 10, awning_ping: 0, balcony_ping: 2, common_ping: 8, parking_ping: 0, has_ledger: true, sort_order: 2 },
  { id: 3, household_id: 'H1', key: 'c', name: '丙房', label: '參考', total_price_wan: 300, parking_price_wan: 0,
    indoor_ping: 10, awning_ping: 0, balcony_ping: 0, common_ping: 0, parking_ping: 0, has_ledger: false, sort_order: 3 },
);
db.property_expenses.push(
  { id: 1, household_id: 'H1', property_id: 1, category: '房屋款項', expense_date: '2024-01-01', amount_twd: -900, item: '頭期款', detail: null, payer: 'KL', sort_order: 1 },
  { id: 2, household_id: 'H1', property_id: 1, category: '房屋款項', expense_date: '2024-01-02', amount_twd: -100, item: '頭期款', detail: null, payer: 'CH', sort_order: 2 },
  { id: 3, household_id: 'H1', property_id: 1, category: '水費', expense_date: '2020-01-10', amount_twd: -30, item: '水費', detail: '109/01', payer: 'KL/CH', sort_order: 3 },
  { id: 4, household_id: 'H1', property_id: 2, category: '管理費', expense_date: '2020-01-10', amount_twd: -70, item: '管理費', detail: null, payer: 'KL', sort_order: 1 },
);`;

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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('[data-tab]', { timeout: 20_000 });
  await page.click('[data-tab="husband"]');
  await page.click('[data-open-property]');
  await page.waitForSelector('.propertySeg');

  const segLabels = await page.$$eval('.propertySeg button', buttons => buttons.map(b => b.textContent.trim()));
  assert.deepEqual(segLabels, ['甲房', '乙房', '比較'], '只有有帳的房子才有分頁，最後一格是比較');
  const metrics = await page.$$eval('.portfolioMetric', cards => cards.map(card => card.textContent.replace(/\s+/g, '')));
  assert.match(metrics[0], /累計支出NT\$1,0303筆·自2020-01-10/);
  assert.match(metrics[1], /購屋NT\$1,000/);
  assert.match(metrics[2], /裝潢家具家電NT\$0/);
  assert.match(await page.textContent('.propertyFacts'), /25\.00 萬\/坪/);
  assert.match(await page.textContent('.propertyFacts'), /30\.00 萬\/坪/);
  assert.match(await page.textContent('.propertyPayers'), /KL/);

  // 分類預設收起，點開才看得到明細
  assert.equal(await page.locator('.propertyTx').count(), 0);
  await page.click('[data-property-group="1|水費"]');
  await page.waitForSelector('.propertyTx[data-property-expense="3"]');

  // 新增：選了既有分類就預填項目與付款人
  await page.click('#add');
  await page.waitForSelector('#propertyForm');
  await page.fill('#propertyCategory', '水費');
  await page.dispatchEvent('#propertyCategory', 'change');
  assert.equal(await page.inputValue('#propertyItem'), '水費');
  assert.equal(await page.inputValue('#propertyPayer'), 'KL/CH');
  await page.fill('#propertyAmount', '45');
  await page.fill('#propertyDate', '2020-03-10');
  await page.click('#propertySave');
  await page.waitForSelector('#propertyForm', { state: 'detached' });
  const inserted = await page.evaluate(() => globalThis.__fake.db.property_expenses.find(row => row.expense_date === '2020-03-10'));
  assert.equal(inserted.amount_twd, -45, '支出存負數，跟試算表同一個慣例');
  assert.equal(inserted.property_id, 1);
  assert.equal(inserted.sort_order, 4);
  const order = await page.$$eval('[data-property-group="1|水費"] ~ .categoryItems .propertyTx', nodes => nodes.map(n => n.dataset.propertyExpense));
  assert.equal(order[0], String(inserted.id), '新的在上面');

  // 改成收入
  await page.click(`.propertyTx[data-property-expense="${inserted.id}"]`);
  await page.waitForSelector('#propertyForm');
  assert.equal(await page.inputValue('#propertyAmount'), '45');
  await page.selectOption('#propertyKind', 'in');
  await page.click('#propertySave');
  await page.waitForSelector('#propertyForm', { state: 'detached' });
  assert.equal(await page.evaluate(id => globalThis.__fake.db.property_expenses.find(row => row.id === id).amount_twd, inserted.id), 45);

  // 刪除
  page.once('dialog', dialog => dialog.accept());
  await page.click(`.propertyTx[data-property-expense="${inserted.id}"]`);
  await page.click('#propertyDelete');
  await page.waitForSelector('#propertyForm', { state: 'detached' });
  assert.equal(await page.evaluate(id => globalThis.__fake.db.property_expenses.some(row => row.id === id), inserted.id), false);

  // 換另一間
  await page.click('.propertySeg button[data-property-view="2"]');
  assert.match(await page.textContent('.portfolioMetric'), /NT\$\s*70/);
  assert.match(await page.textContent('.propertyFacts'), /轉手價差 NT\$ 1,000,000/);

  // 比較：每一間都列出來，沒有＋
  await page.click('.propertySeg button[data-property-view="compare"]');
  assert.equal(await page.locator('.propertyFacts').count(), 3);
  assert.equal(await page.locator('#add').count(), 0);

  // 版面不能橫向捲動
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
});
