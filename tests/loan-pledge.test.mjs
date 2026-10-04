// 質押（股票質借）是貸款分析的第四個分類。它不按月攤還：到期一次還本付息、可以續借，
// 所以 autopay 是關的 —— 到期日到了也不能被 apply_due_loan_payments 自動把負債扣到 0。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOAN_TYPES, summarizeRemainingMonth } from '../loan-month-core.js';
import { maintenanceRatio, parseCollateral } from '../pledge-core.js';

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

test('本月剩餘還款的分桶包含質押', () => {
  assert.ok(LOAN_TYPES.includes('pledge'));
  const result = summarizeRemainingMonth(
    [{ id: 'P1', owner_scope: 'husband', loan_type: 'pledge', status: 'active' }],
    [{ id: 'r1', loan_account_id: 'P1', due_date: '2027-03-30', amount_twd: -1019518 }],
  );
  assert.deepEqual(result['husband|pledge'], { total: 1019518, count: 1, nextDue: '2027-03-30' });
});

test('擔保維持率：元大證金 140% 追繳，股價算出追繳價', () => {
  const parsed = parseCollateral('擔保品：2330 × 1,000 股；追繳維持率 140%');
  assert.deepEqual(parsed, { collateral: [{ symbol: '2330', shares: 1000 }], marginCall: 1.4 });
  assert.equal(parseCollateral('沒寫').marginCall, 1.4, '沒寫追繳線就用證金的 140%');
  const status = maintenanceRatio({ principal: 1000000, ...parsed, priceOf: () => 2500 });
  assert.equal(status.ratio, 2.5);
  assert.equal(status.callPrice, 1400);
  assert.equal(status.cushion.toFixed(2), '0.44');
  assert.equal(status.level, 'ok');
  assert.equal(maintenanceRatio({ principal: 1000000, ...parsed, priceOf: () => 1600 }).level, 'warn');
  assert.equal(maintenanceRatio({ principal: 1000000, ...parsed, priceOf: () => 1300 }).level, 'danger');
  assert.equal(maintenanceRatio({ principal: 1000000, ...parsed, priceOf: () => null }), null, '抓不到價就不顯示');
});

test('貸款分析有質押分頁，到期日當天也不會自動扣款', { skip }, async t => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'fi-pledge', household_id: 'H1', kind: 'liability', category: '質押',
  name: '元大股票質押', owner_scope: 'husband', amount_twd: 1000000, monthly_payment_twd: null,
  interest_rate: 3.98, sort_order: 1 });
db.loan_accounts.push({ id: 'P1', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-pledge',
  source_key: 'pledge', lender: '元大證金', name: '元大股票質押', loan_type: 'pledge',
  original_principal_twd: 1000000, nominal_annual_rate: 3.98, contractual_monthly_payment_twd: null,
  start_date: '2026-10-02', maturity_date: '${today}', projected_total_repayment_twd: 1019518,
  status: 'active', autopay: false, last_payment_applied_on: null, grace_until: null });
db.loan_schedule.push(
  { loan_account_id: 'P1', due_date: '2026-10-02', amount_twd: 1000000, entry_type: 'disbursement' },
  { loan_account_id: 'P1', due_date: '${today}', amount_twd: -1019518, entry_type: 'payment' });`;

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
  await page.waitForSelector('[data-open-loans]');
  await page.waitForTimeout(500);

  await t.test('autopay 關掉：到期日當天負債不被扣', async () => {
    const state = await page.evaluate(() => ({
      balance: globalThis.__fake.db.financial_items.find(item => item.id === 'fi-pledge').amount_twd,
      applied: globalThis.__fake.db.loan_schedule.filter(row => row.applied_at).length,
    }));
    assert.deepEqual(state, { balance: 1000000, applied: 0 });
  });

  await t.test('只有質押時直接開在質押分頁，卡片標示質押', async () => {
    await page.click('[data-open-loans]');
    await page.waitForSelector('.loanCard');
    assert.equal(await page.textContent('.loanTypeSeg button.on'), '質押');
    const card = await page.textContent('.loanCard');
    assert.match(card, /元大證金 · 質押/);
    assert.match(card, /NT\$ 1,000,000/);
  });

});

test('首頁的質押卡片只寫利息，不寫含本金的本息合計', { skip }, async t => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const maturity = `${Number(today.slice(0, 4)) + 1}-03-30`;
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'fi-pledge', household_id: 'H1', kind: 'liability', category: '質押',
  name: '元大股票質押', owner_scope: 'husband', amount_twd: 1000000, monthly_payment_twd: null,
  interest_rate: 3.98, sort_order: 1 });
db.loan_accounts.push({ id: 'P1', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-pledge',
  source_key: 'pledge', lender: '元大證金', name: '元大股票質押', loan_type: 'pledge',
  original_principal_twd: 1000000, nominal_annual_rate: 3.98, contractual_monthly_payment_twd: null,
  start_date: '${today}', maturity_date: '${maturity}', projected_total_repayment_twd: 1019518,
  status: 'active', autopay: false, last_payment_applied_on: null, grace_until: null });
db.loan_schedule.push({ loan_account_id: 'P1', due_date: '${maturity}', amount_twd: -1019518, entry_type: 'payment' });
db.loan_accounts[0].source_note = '擔保品：2330 × 1000 股；追繳維持率 140%';
db.financial_items.push({ id: 'fi-2330', household_id: 'H1', kind: 'asset', category: '台股', name: '台積電',
  owner_scope: 'husband', amount_twd: 10000000, symbol: '2330', market: 'TW', quantity: 4000, sort_order: 2 });`;

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
  await page.waitForSelector('[data-tab]', { timeout: 20_000 });
  await page.click('[data-tab="husband"]');
  await page.click('#personSeg [data-kind="liability"]');
  await page.waitForSelector('.categoryHead');
  if (!(await page.isVisible('.itemCard[data-id="fi-pledge"]'))) await page.click('.categoryHead');
  await page.waitForSelector('.itemCard[data-id="fi-pledge"] .compactMeta');
  const line = await page.textContent('.itemCard[data-id="fi-pledge"] .compactMeta');
  assert.match(line, /下次 03\/30 利息 NT\$ 19,518/, `實際：${line}`);
  assert.doesNotMatch(line, /1,019,518/);
  assert.match(line, /維持率 250%/, '台積電 2,500 × 1000 股 ÷ 100 萬');
  assert.doesNotMatch(line, /利率/, '質押卡片的第一格換成維持率');

  await page.click('[data-open-loans]');
  await page.waitForSelector('.loanCard');
  const card = await page.textContent('.loanCard');
  assert.match(card, /擔保維持率250%/);
  assert.match(card, /追繳線 140%股價 1,400，再跌 44%/);
});
