// PostgREST 一次最多回 1000 列，超出的直接被砍、而且不報錯。排程表現在有一千九百多列，
// 以前用 .range(0, 9999) 一次抓，尾巴就掉了 —— 潤隆房貸 360 期只拿到最早的 143 期，
// 卡片上「貸款年限 11 年 11 個月」「已繳期數 36 / 143」「實際年化成本 −8.94%」三個
// 數字一起錯（年限是從期數推的，年化成本是因為現金流看起來永遠還不完才變負的）。
// 這支測試就是把「排程列數超過單頁上限」重現出來：拿掉分頁就會紅。
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

const MONTHS = 360;

function monthly(start, count, amount, accountId) {
  const [y0, m0, day] = start.split('-');
  return Array.from({ length: count }, (_, i) => {
    const month = Number(m0) - 1 + i;
    const date = `${Number(y0) + Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, '0')}-${day}`;
    return { loan_account_id: accountId, due_date: date, amount_twd: amount, entry_type: 'payment' };
  });
}

test('排程超過單頁上限也要抓齊，期數與年化成本才不會少算', { skip }, async t => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  // 排程是照 due_date 排的，所以另一筆貸款在前段塞得夠密，就會把這筆 30 年房貸的
  // 尾巴擠出單頁範圍 —— 真實資料就是這個形狀：鼎宇 726 列集中在 2024 年之後，
  // 潤隆房貸 2053 年那段就被砍掉了。這裡用 900 列日繳排程重現同一件事。
  const filler = Array.from({ length: 900 }, (_, i) => ({
    loan_account_id: 'L9',
    due_date: new Date(Date.UTC(2023, 8, 6) + i * 86400000).toISOString().slice(0, 10),
    amount_twd: -5000,
    entry_type: 'payment',
  }));
  const mortgage = [
    { loan_account_id: 'L1', due_date: '2023-09-05', amount_twd: 8000000, entry_type: 'disbursement' },
    ...monthly('2023-10-05', MONTHS, -30287, 'L1'),
  ];
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.financial_items.push(
  { id: 'fi-mortgage', household_id: 'H1', kind: 'liability', category: '房貸', name: '潤隆房貸',
    owner_scope: 'husband', amount_twd: 7412586, monthly_payment_twd: 30287, interest_rate: 2.18, sort_order: 0 },
  { id: 'fi-filler', household_id: 'H1', kind: 'liability', category: '信貸', name: '填充信貸',
    owner_scope: 'husband', amount_twd: 100000, monthly_payment_twd: 5000, interest_rate: 3, sort_order: 1 },
);
db.loan_accounts.push(
  { id: 'L1', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-mortgage', source_key: 'runlong',
    lender: '中國信託', name: '潤隆房貸', loan_type: 'mortgage', original_principal_twd: 8000000,
    nominal_annual_rate: 2.18, contractual_monthly_payment_twd: 30287, start_date: '2023-09-05',
    maturity_date: '2053-09-05', status: 'active', autopay: false },
  { id: 'L9', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi-filler', source_key: 'filler',
    lender: '測試銀行', name: '填充信貸', loan_type: 'personal', original_principal_twd: 4500000,
    nominal_annual_rate: 3, contractual_monthly_payment_twd: 5000, start_date: '2023-09-06',
    status: 'active', autopay: false },
);
db.loan_schedule.push(...${JSON.stringify(filler)});
db.loan_schedule.push(...${JSON.stringify(mortgage)});`;

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
  await page.click('[data-open-loans]');
  await page.waitForSelector('.loanCard');

  await t.test('房貸期數是完整的 360 期，年限與年化成本跟著對', async () => {
    await page.click('[data-loan-type="mortgage"]');
    await page.waitForSelector('.loanCard');
    await page.click('[data-loan-account="L1"]');
    await page.waitForSelector('.loanDetail');
    const detail = await page.textContent('.loanDetail');
    const paid = mortgage.filter(row => row.amount_twd < 0 && row.due_date < today).length;
    // 沒分頁的話這裡是 100 出頭，年限變 8 年多，年化成本因為現金流缺尾巴而變負的
    assert.match(detail, new RegExp(`已繳期數${paid} / ${MONTHS}`), detail);
    assert.match(detail, /貸款年限30 年(?! )/, detail);
    assert.match(detail, /最後一期 2053-09-05/, detail);
  });

  // 年化成本在卡片上，不在展開的明細裡。少了尾巴的現金流看起來永遠還不完，XIRR 會
  // 掉到負值 —— 螢幕上那個 −8.94% 就是這樣來的。
  await t.test('年化成本貼著票面利率，不是負的', async () => {
    // 卡片是「表定利率／實際年化成本 2.18% ; 2.20%」這種一格兩個數字的寫法，
    // 要抓的是分號後面那個，只配「實際年化成本」後面第一個數字會抓到票面利率。
    const card = await page.textContent('[data-loan-account="L1"]');
    const cost = card.match(/實際年化成本[^%]*%\s*;\s*([−-]?[\d.]+)%/);
    assert.ok(cost, `卡片上找不到年化成本：${card}`);
    const value = Number(cost[1].replace('−', '-'));
    assert.ok(value > 2 && value < 2.5, `年化成本應該貼著 2.18%，算出來卻是 ${value}%`);
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
