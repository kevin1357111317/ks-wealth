// 開 App 先畫上次的首頁，背景再換成最新資料（見 README「開 App 的等待時間」）。
//
// - 載入成功後把首頁的原始列存成快取；快取依 user id 分開
// - 有快取時，線上資料還卡著也先畫出上次的首頁，並標示「同步中」
// - 快取期間不能開編輯表單（會拿舊的 updated_at 存檔）
// - 線上資料回來就整個換掉，快取裡有、線上沒有的東西要消失
// - 別人的快取不會被畫出來，而且會被清掉；壞掉的快取不會讓 App 起不來
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHomeCache, encodeHomeCache, homeCacheKey, readStoredUser } from '../home-cache-core.js';

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

const AUTH_KEY = 'sb-gbxsnwqbjmgfikpblyot-auth-token';
const cachedItem = {
  id: 'cached-1', household_id: 'H1', kind: 'asset', category: '現金及存款', name: 'CACHED-ITEM',
  amount_twd: 12345, owner_scope: 'husband', sort_order: 1, native_currency: 'TWD', native_amount: 12345,
};
const cacheFor = (userId, householdId = 'H1') => encodeHomeCache({
  userId,
  member: { household_id: householdId, role: 'owner' },
  rows: { items: [cachedItem], history: [], scopeHistory: [], householdName: '布布一二的家',
    usd: [], gold: [], loanAccounts: [], nextDue: [] },
});

test('快取格式：依 user id 分開，版本或使用者對不上就當沒有', () => {
  const raw = cacheFor('U1');
  assert.equal(decodeHomeCache(raw, 'U1').rows.items[0].name, 'CACHED-ITEM');
  assert.equal(decodeHomeCache(raw, 'U2'), null);
  assert.equal(decodeHomeCache(JSON.stringify({ ...JSON.parse(raw), v: 999 }), 'U1'), null);
  assert.equal(decodeHomeCache('{壞掉', 'U1'), null);
  assert.equal(homeCacheKey('U1'), 'ks-home-cache|U1');
  assert.equal(homeCacheKey(''), '');
  assert.equal(readStoredUser(JSON.stringify({ access_token: 't', user: { id: 'U1' } })).id, 'U1');
  assert.equal(readStoredUser('{壞掉'), null);
});

test('先顯示上次的首頁再更新', { skip }, async t => {
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

  // initScript 每次導覽都會跑，所以只在第一次種資料。
  const openPage = async seed => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, locale: 'zh-TW' });
    await page.route('**/cdn.jsdelivr.net/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
    await page.route('**fonts.g**', route => route.abort());
    // loan-month-summary.js 會自己打 PostgREST，攔下來回空陣列。
    await page.route('**/gbxsnwqbjmgfikpblyot.supabase.co/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]',
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
    await page.addInitScript(({ authKey, seed }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(authKey, JSON.stringify({
        access_token: 't', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'U1', email: 'bubu@example.com' },
      }));
      for (const [key, value] of Object.entries(seed.storage ?? {})) localStorage.setItem(key, value);
      if (seed.gateItems) {
        window.__gates = { financial_items: new Promise(resolve => { window.__releaseItems = resolve; }) };
      }
    }, { authKey: AUTH_KEY, seed });
    return page;
  };
  const statusText = page => page.evaluate(() => document.querySelector('[data-status-text]')?.textContent ?? '');

  await t.test('載入成功後存下首頁快取', async () => {
    const page = await openPage({});
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#root.app', { timeout: 20_000 });
    await page.waitForFunction(() => localStorage.getItem('ks-home-cache|U1'), null, { timeout: 5_000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ks-home-cache|U1')));
    assert.equal(saved.userId, 'U1');
    assert.equal(saved.member.household_id, 'H1');
    assert.ok(Array.isArray(saved.rows.items));
    assert.equal(saved.rows.health, undefined, '健康資料不進快取');
    await page.close();
  });

  await t.test('線上資料卡住時先畫上次的首頁，快取期間不能編輯，回來後整個換掉', async () => {
    const page = await openPage({ gateItems: true, storage: { 'ks-home-cache|U1': cacheFor('U1') } });
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#root.app', { timeout: 5_000 });
    // 項目收在分類裡，看總額就好：12,345 只存在快取裡，線上假資料沒有。
    assert.match(await page.textContent('#root'), /NT\$ 12,345/);
    assert.match(await statusText(page), /上次的資料/);

    await page.click('#add');
    await page.waitForTimeout(200);
    assert.equal(await page.$('.backdrop'), null, '快取期間不能打開編輯表單');
    assert.match(await statusText(page), /還在同步/);

    await page.evaluate(() => window.__releaseItems());
    await page.waitForFunction(() => !document.querySelector('#root')?.textContent.includes('12,345'),
      null, { timeout: 10_000 });
    assert.doesNotMatch(await statusText(page), /上次的資料|還在同步/);
    await page.click('#add');
    await page.waitForSelector('.backdrop', { timeout: 5_000 });
    await page.close();
  });

  await t.test('別人的快取不畫、而且會被清掉', async () => {
    const page = await openPage({
      gateItems: true,
      storage: { 'ks-home-cache|U2': cacheFor('U2'), 'ks-home-cache|U1': 'null' },
    });
    await page.goto(`${base}/index.html`);
    await page.waitForTimeout(800);
    assert.equal(await page.$('#root.app'), null, '沒有自己的快取就不該先畫首頁');
    await page.evaluate(() => window.__releaseItems());
    await page.waitForSelector('#root.app', { timeout: 20_000 });
    assert.doesNotMatch(await page.textContent('#root'), /12,345/);
    assert.equal(await page.evaluate(() => localStorage.getItem('ks-home-cache|U2')), null);
    await page.close();
  });

  await t.test('快取內容壞掉：清掉、照正常流程開起來', async () => {
    const broken = JSON.stringify({ ...JSON.parse(cacheFor('U1')), rows: { items: [null] } });
    const page = await openPage({ storage: { 'ks-home-cache|U1': broken } });
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#root.app', { timeout: 20_000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ks-home-cache|U1')));
    assert.ok(saved.rows.items.every(Boolean), '壞掉的快取要被新的蓋掉');
    await page.close();
  });
});
