// 繳款日到了就自動把負債扣掉，兩邊（資產負債頁與貸款分析）看同一個數字，
// 而且卡片收合是就地收、不重繪整頁。
//
// 拆本金／利息的規則是從實際餘額反推出來的，不是套年金公式：銀行用 actual/365，
// 利息 = 餘額 × 年利率 × 兩次繳款日相隔天數 ÷ 365，本金 = 月付 − 利息。這裡的固定
// 資料就是元大那筆的真實數字：31 天的第一期算出來是本金 7,230、利息 3,376。
//
// 日期一律相對今天算，測試不會因為放久了就過期。
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

const money = value => new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(value);
const addMonths = (iso, months) => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + months, day)).toISOString().slice(0, 10);
};
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

test('繳款日到了自己扣款，卡片收合不重繪整頁', { skip }, async t => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const start = addMonths(today, -1);          // 一個月前撥款，所以第一期就是今天
  const PAYMENT = 10606;
  const PRINCIPAL = 1060000;
  const RATE = 3.75;

  const schedule = [
    { loan_account_id: 'L1', due_date: start, amount_twd: PRINCIPAL, entry_type: 'disbursement' },
    { loan_account_id: 'L1', due_date: start, amount_twd: -2888, entry_type: 'fee' },
  ];
  for (let i = 0; i < 120; i += 1) {
    schedule.push({ loan_account_id: 'L1', due_date: addMonths(today, i), amount_twd: -PAYMENT, entry_type: 'payment' });
  }
  // 另外兩筆下個月才開始繳，今天沒有到期的期數 —— 順便讓清單有三張卡片，
  // 收合之後頁面仍然夠長，瀏覽器不會把捲動量夾掉（那是正常行為，不是這裡要測的）。
  for (const id of ['L2', 'L3']) {
    for (let i = 1; i <= 60; i += 1) {
      schedule.push({ loan_account_id: id, due_date: addMonths(today, i), amount_twd: -5000, entry_type: 'payment' });
    }
  }

  // 今天這一期還沒扣，照上面的規則算出來應該是：
  const interest = Math.round(PRINCIPAL * RATE / 100 * daysBetween(start, today) / 365);
  const principal = PAYMENT - interest;
  const balance = PRINCIPAL - principal;
  const nextDue = addMonths(today, 1);

  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'fi-loan', household_id: 'H1', kind: 'liability', category: '信貸',
  name: '元大銀行信貸', owner_scope: 'husband', amount_twd: ${PRINCIPAL}, monthly_payment_twd: ${PAYMENT},
  interest_rate: ${RATE}, sort_order: 0 });
db.loan_accounts.push({ id: 'L1', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-loan',
  source_key: 'yuanta', lender: '元大銀行', name: '元大銀行信貸', loan_type: 'personal',
  original_principal_twd: ${PRINCIPAL}, nominal_annual_rate: ${RATE}, contractual_monthly_payment_twd: ${PAYMENT},
  start_date: '${start}', maturity_date: '${addMonths(today, 119)}', projected_total_repayment_twd: 1275608,
  status: 'active', autopay: true, last_payment_applied_on: null, grace_until: null });
db.financial_items.push({ id: 'fi-loan2', household_id: 'H1', kind: 'liability', category: '信貸',
  name: '另一筆信貸', owner_scope: 'husband', amount_twd: 300000, monthly_payment_twd: 5000,
  interest_rate: 2.18, sort_order: 1 });
db.financial_items.push({ id: 'fi-loan3', household_id: 'H1', kind: 'liability', category: '信貸',
  name: '第三筆信貸', owner_scope: 'husband', amount_twd: 400000, monthly_payment_twd: 5000,
  interest_rate: 2.18, sort_order: 3 });
db.financial_items.push({ id: 'fi-card', household_id: 'H1', kind: 'liability', category: '信貸',
  name: '信用卡', owner_scope: 'husband', amount_twd: 20000, monthly_payment_twd: 3000,
  interest_rate: 15, sort_order: 2 });
db.loan_accounts.push({ id: 'L2', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-loan2',
  source_key: 'other', lender: '中國信託', name: '另一筆信貸', loan_type: 'personal',
  original_principal_twd: 300000, nominal_annual_rate: 2.18, contractual_monthly_payment_twd: 5000,
  start_date: '${today}', status: 'active', autopay: true, last_payment_applied_on: null });
db.loan_accounts.push({ id: 'L3', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-loan3',
  source_key: 'third', lender: '台北富邦', name: '第三筆信貸', loan_type: 'personal',
  original_principal_twd: 400000, nominal_annual_rate: 2.18, contractual_monthly_payment_twd: 5000,
  start_date: '${today}', status: 'active', autopay: true, last_payment_applied_on: null });
db.loan_schedule.push(...${JSON.stringify(schedule)});`;

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
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('console', entry => { if (entry.type() === 'error') failures.push(entry.text()); });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('[data-tab]', { timeout: 20_000 });
  await page.click('[data-tab="husband"]');
  await page.waitForSelector('.fab');

  await t.test('繳款日到了就自動扣掉，撥款與開辦費不算還款', async () => {
    await page.waitForFunction(
      expected => globalThis.__fake.db.financial_items[0].amount_twd === expected, balance, { timeout: 30_000 });
    const rows = await page.evaluate(() =>
      globalThis.__fake.db.loan_schedule.filter(r => r.applied_principal_twd != null));
    assert.equal(rows.length, 1, '只扣今天到期的那一期');
    assert.equal(rows[0].due_date, today);
    assert.equal(Number(rows[0].applied_principal_twd), principal);
    assert.equal(Number(rows[0].applied_interest_twd), interest);
    assert.deepEqual(
      await page.evaluate(() => globalThis.__fake.db.loan_schedule
        .filter(r => r.entry_type !== 'payment').map(r => r.applied_principal_twd ?? null)),
      [null, null], '撥款跟開辦費不該被當成還款');
  });

  await t.test('外面的負債列跟著變，而且看得到下次繳款', async () => {
    await page.click('#personSeg [data-kind="liability"]');
    await page.click('[data-group]');           // 分類預設收合
    await page.waitForSelector('.itemCard');
    const card = await page.textContent('.itemCard');
    assert.match(card, new RegExp(`NT\\$ ${money(balance)}`), '餘額已經扣過');
    assert.match(card, new RegExp(`下次 ${nextDue.slice(5).replace('-', '/')} NT\\$ ${money(PAYMENT)}`));
  });

  await t.test('沒有對應貸款的負債還是顯示月付', async () => {
    const cards = await page.locator('.itemCard').allTextContents();
    const card = cards.find(text => text.includes('信用卡'));
    assert.match(card, /月付 NT\$ 3,000/);
    assert.doesNotMatch(card, /下次 /, '信用卡沒有還款排程，不該冒出下次繳款');
  });

  await t.test('收合是就地收，不重繪整頁也不動捲動位置', async () => {
    await page.click('[data-open-loans]');
    await page.waitForSelector('.loanCard');
    await page.click('[data-loan-account]');
    await page.waitForSelector('.loanCard.open');
    // 在卡片外面做個記號：重繪整頁的話這個記號會不見
    await page.evaluate(() => { document.querySelector('.loanList').dataset.probe = 'kept'; });
    await page.evaluate(() => window.scrollTo(0, 120));
    const before = await page.evaluate(() => window.scrollY);
    await page.click('[data-loan-account]');
    await page.waitForFunction(() => document.querySelector('.loanCard.open') === null);
    assert.equal(await page.evaluate(() => document.querySelector('.loanList').dataset.probe), 'kept',
      '收合只該換那一張卡片 —— 重繪整頁時捲動量會被夾到新的底部，看起來就是跳一下');
    assert.equal(await page.evaluate(() => window.scrollY), before, '捲動位置不動');
    assert.equal(await page.locator('.loanDetail').count(), 0);
  });

  await t.test('收合後還能再點開，事件有重新綁上', async () => {
    await page.click('[data-loan-account]');
    await page.waitForSelector('.loanCard.open');
    assert.equal(await page.locator('.loanDetail').count(), 1);
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
