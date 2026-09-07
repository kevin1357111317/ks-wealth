// 信貸卡片點開之後要看得到還款排程。排程是從 KLFAN 試算表匯進來的實際資料，
// 不是用公式現算的 —— 實際條件有寬限期、責任轉移這些例外，算出來對不上（元大那筆
// 就是：試算表的結算日期欄寫 7 年，但排程列一路到 10 年，用 7 年算月付會差 3,765）。
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

test('信貸卡片點開看得到還款排程', { skip }, async t => {
  // 一筆進行中的信貸：2026-08-07 撥款 1,060,000，之後每月 7 號還 10,606，共 120 期
  const schedule = [{ loan_account_id: 'L1', due_date: '2026-08-07', amount_twd: 1060000 }];
  for (let i = 0; i < 120; i += 1) {
    const month = 8 + i;
    const date = `${2026 + Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, '0')}-07`;
    schedule.push({ loan_account_id: 'L1', due_date: date, amount_twd: -10606 });
  }
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push({ id: 'fi-loan', household_id: 'H1', kind: 'liability', category: '信貸',
  name: '元大銀行信貸', owner_scope: 'husband', amount_twd: 1030000, monthly_payment_twd: 10606,
  interest_rate: 3.75, sort_order: 0 });
db.loan_accounts.push({ id: 'L1', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-loan',
  source_key: 'yuanta', lender: '元大銀行', name: '元大銀行信貸', loan_type: 'personal',
  original_principal_twd: 1060000, nominal_annual_rate: 3.75, contractual_monthly_payment_twd: 10606,
  start_date: '2026-08-07', maturity_date: '2036-08-07', projected_total_repayment_twd: 1275608,
  status: 'active' });
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

  await t.test('開 App 不載排程，點進信貸分析才載', async () => {
    // 837 列的排程只有這一頁要用
    assert.equal(await page.evaluate(() =>
      globalThis.__fake.calls.filter(call => call.table === 'loan_schedule').length), 0);
    await page.click('[data-open-loans]');
    await page.waitForSelector('.loanCard');
    assert.equal(await page.locator('.loanDetail').count(), 0, '一開始是收合的');
  });

  await t.test('點開看得到下次繳款、已繳期數與剩餘應還', async () => {
    await page.click('[data-loan-account]');
    await page.waitForSelector('.loanDetail');
    const detail = await page.textContent('.loanDetail');
    for (const label of ['下次繳款', '金額', '已繳期數', '剩餘應還']) {
      assert.match(detail, new RegExp(label), `展開的內容應該有「${label}」`);
    }
    assert.match(detail, /\/ 120/, '共 120 期');
    // 未來的期數只先列 12 筆，剩下的用一行帶過 —— 全部倒出來會有幾百列
    assert.equal(await page.locator('.loanPlanRow').count(), 12);
    assert.match(detail, /還有 108 期，最後一期 2036-08-07/);
    // 剩餘應還就是未繳的期數乘上金額：10,606 × 120
    assert.match(detail, /剩餘應還NT\$ 1,272,720/);
  });

  await t.test('再點一次收起來，而且一次只開一個', async () => {
    await page.click('[data-loan-account]');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.loanDetail').count(), 0);
  });

  await t.test('每月還款旁邊帶出平均每天要還多少', async () => {
    // 10,606 × 12 ÷ 365 ≈ 349
    assert.match(await page.textContent('.loanSummary'), /平均每天 NT\$ 349/);
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
