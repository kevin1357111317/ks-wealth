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
