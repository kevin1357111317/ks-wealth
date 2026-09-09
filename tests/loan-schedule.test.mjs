// 貸款卡片點開之後要看得到還款排程。排程是從 KLFAN 試算表匯進來的實際資料，
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

test('貸款卡片點開看得到還款排程', { skip }, async t => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
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
db.financial_items.push(
  { id: 'fi-topup', household_id: 'H1', kind: 'liability', category: '增貸', name: '測試增貸', owner_scope: 'husband', amount_twd: 700000, monthly_payment_twd: 7000, interest_rate: 2.5, sort_order: 1 },
  { id: 'fi-mortgage', household_id: 'H1', kind: 'liability', category: '房貸', name: '測試房貸', owner_scope: 'husband', amount_twd: 9000000, monthly_payment_twd: 40000, interest_rate: 2.1, sort_order: 2 },
);
db.loan_accounts.push({ id: 'L1', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-loan',
  source_key: 'yuanta', lender: '元大銀行', name: '元大銀行信貸', loan_type: 'personal',
  original_principal_twd: 1060000, nominal_annual_rate: 3.75, contractual_monthly_payment_twd: 10606,
  start_date: '2026-08-07', maturity_date: '2036-08-07', projected_total_repayment_twd: 1275608,
  status: 'active' });
db.loan_accounts.push(
  { id: 'L2', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-topup', source_key: 'topup', lender: '中國信託', name: '測試增貸', loan_type: 'topup', original_principal_twd: 1000000, nominal_annual_rate: 2.5, contractual_monthly_payment_twd: 7000, status: 'active' },
  { id: 'L3', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-mortgage', source_key: 'mortgage', lender: '中國信託', name: '測試房貸', loan_type: 'mortgage', original_principal_twd: 10000000, nominal_annual_rate: 2.1, contractual_monthly_payment_twd: 40000, status: 'active' },
  { id: 'L4', household_id: 'H1', owner_scope: 'husband', source_key: 'closed-1', lender: 'LINE Bank', name: '舊信貸一', loan_type: 'personal', original_principal_twd: 500000, nominal_annual_rate: 2.18, status: 'closed' },
  { id: 'L5', household_id: 'H1', owner_scope: 'husband', source_key: 'closed-2', lender: '中國信託', name: '舊信貸二', loan_type: 'personal', original_principal_twd: 600000, nominal_annual_rate: 2.18, status: 'closed' },
);
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

  await t.test('開 App 不載排程，點進貸款分析才載', async () => {
    // 837 列的排程只有這一頁要用
    assert.equal(await page.evaluate(() =>
      globalThis.__fake.calls.filter(call => call.table === 'loan_schedule').length), 0);
    await page.click('[data-open-loans]');
    await page.waitForSelector('.loanCard');
    assert.equal(await page.locator('.loanDetail').count(), 0, '一開始是收合的');
  });

  await t.test('預設顯示信貸，切換後摘要與清單只留下同類貸款', async () => {
    assert.equal(await page.locator('[data-loan-type]').count(), 3);
    assert.equal(await page.locator('[data-loan-type="personal"].on').count(), 1);
    assert.match(await page.textContent('.loanSummary'), /目前貸款餘額NT\$ 1,030,000.*已結清2 筆/s);
    assert.match(await page.textContent('.portfolioView'), /進行中信貸1 筆/);
    assert.equal(await page.locator('.loanCard').count(), 3, '一筆進行中與兩筆已結清信貸');

    await page.click('[data-loan-type="topup"]');
    assert.match(await page.textContent('.loanSummary'), /NT\$ 700,000.*加權平均利率2\.50%/s);
    assert.match(await page.textContent('.loanList'), /測試增貸/);
    assert.doesNotMatch(await page.textContent('.loanList'), /元大銀行信貸/);

    await page.click('[data-loan-type="mortgage"]');
    assert.match(await page.textContent('.loanSummary'), /NT\$ 9,000,000.*加權平均利率2\.10%/s);
    assert.match(await page.textContent('.loanList'), /測試房貸/);

    await page.click('[data-loan-type="personal"]');
  });

  // 測試增貸與測試房貸都沒有排程列，主檔也沒存 effective_annual_cost，所以年化成本
  // 是真的算不出來。以前 toFiniteNumber 的預設值會把「沒有」變成 0，卡片就寫
  // 「實際年化成本 0.00%」—— 一筆 2.5% 的貸款顯示 0%，而且等排程載進來又會自己跳掉。
  await t.test('算不出年化成本就顯示破折號，不是 0.00%', async () => {
    for (const type of ['topup', 'mortgage']) {
      await page.click(`[data-loan-type="${type}"]`);
      await page.waitForSelector('.loanCard');
      const card = await page.textContent('.loanCard');
      assert.doesNotMatch(card, /0\.00%/, `${type} 卡片不該出現 0.00% 的年化成本：${card}`);
      assert.match(card, /—/, `${type} 卡片應該顯示破折號`);
    }
    await page.click('[data-loan-type="personal"]');
  });

  await t.test('點開看得到貸款條件、已繳期數與未來排程', async () => {
    await page.click('[data-loan-account]');
    await page.waitForSelector('.loanDetail');
    const detail = await page.textContent('.loanDetail');
    // 下次繳款、金額、剩餘應還這幾格由 loan-ui-fix.js 從明細裡拿掉了（下次繳款改在
    // 資產負債頁的負債列上顯示），這裡對的是實際留下來的欄位。
    for (const label of ['原貸款', '貸款年限', '已繳期數', '預計到期', '全期利息與費用']) {
      assert.match(detail, new RegExp(label), `展開的內容應該有「${label}」`);
    }
    // 期數照今天算，測試不會因為放久了就過期
    const paid = schedule.filter(row => row.amount_twd < 0 && row.due_date < today).length;
    assert.match(detail, new RegExp(`已繳期數${paid} / 120`));
    // 未來的期數只先列 12 筆，剩下的用一行帶過 —— 全部倒出來會有幾百列
    assert.equal(await page.locator('.loanFutureSection .loanPlanRow').count(), 12);
    assert.match(detail, new RegExp(`還有 ${120 - paid - 12} 期，最後一期 2036-08-07`));
  });

  await t.test('再點一次收起來，而且一次只開一個', async () => {
    await page.click('[data-loan-account]');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.loanDetail').count(), 0);
  });

  // 「每月還款／平均每天」那一格被 loan-month-summary.js 換成「本月剩餘還款」了，
  // 它自己去 Supabase 抓當月還沒扣的期數，測試環境連不出去所以停在「更新中…」。
  await t.test('摘要換成本月剩餘還款與加權平均利率', async () => {
    const summary = await page.textContent('.loanSummary');
    assert.match(summary, /本月剩餘還款/);
    assert.match(summary, /加權平均利率3\.75%/);
    assert.doesNotMatch(summary, /平均每天/, '舊的那一格已經被換掉');
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
