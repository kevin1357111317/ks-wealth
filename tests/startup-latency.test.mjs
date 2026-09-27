// 開 App 的等待時間守在這裡。正式站的請求紀錄顯示首屏前是三輪串起來的網路往返：
// 換 token → 查 household_members → 抓資料，查家庭那一輪冷的時候要 700 ms 上下。
//
// - 記得家庭成員資格的話，首屏不能再等 household_members（背景重查、不一樣就整頁重來）
// - loan-month-summary.js 不能拿過期 token 先打一次 REST（每次都 401，白送一個請求）
// - index.html 預先連線 Supabase、預載 supabase-js，版本要跟實際 import 的一致
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStoredAuthFresh, readStoredAuth } from '../loan-month-cache-core.js';

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

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const AUTH_KEY = 'sb-gbxsnwqbjmgfikpblyot-auth-token';

test('token 過期判斷：讀 expires_at（秒），留 10 秒餘裕，舊格式沒有欄位時當作可用', () => {
  const now = Date.parse('2026-09-27T08:45:00Z');
  const at = seconds => JSON.stringify({ access_token: 't', user: { id: 'U1' }, expires_at: seconds });
  assert.equal(readStoredAuth(at(1790502310)).expiresAt, 1790502310);
  assert.equal(isStoredAuthFresh(readStoredAuth(at(now / 1000 - 60)), now), false);
  assert.equal(isStoredAuthFresh(readStoredAuth(at(now / 1000 + 5)), now), false);
  assert.equal(isStoredAuthFresh(readStoredAuth(at(now / 1000 + 3600)), now), true);
  assert.equal(isStoredAuthFresh(readStoredAuth(JSON.stringify({ access_token: 't' })), now), true);
  assert.equal(isStoredAuthFresh(readStoredAuth(null), now), false);
});

test('預先連線與預載的 supabase-js 版本跟實際 import 一致', async () => {
  const [html, app, auth] = await Promise.all([read('index.html'), read('app-v3.js'), read('auth-tools.js')]);
  const preload = html.match(/rel="modulepreload" href="(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+)"/)?.[1];
  assert.ok(preload, 'index.html 沒有預載 supabase-js');
  assert.ok(app.includes(`from '${preload}'`), `app-v3.js 的 supabase-js 不是 ${preload}，預載等於白抓`);
  assert.ok(auth.includes(`from'${preload}'`) || auth.includes(`from '${preload}'`),
    `auth-tools.js 的 supabase-js 不是 ${preload}`);
  assert.match(html, /rel="preconnect" href="https:\/\/gbxsnwqbjmgfikpblyot\.supabase\.co" crossorigin/);
});

test('開 App 的關鍵路徑', { skip }, async t => {
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

  const openPage = async (initScript, initArg) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, locale: 'zh-TW' });
    await page.route('**/cdn.jsdelivr.net/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
    await page.route('**fonts.g**', route => route.abort());
    if (initScript) await page.addInitScript(initScript, initArg);
    return page;
  };
  const cachedMember = page => page.evaluate(() => JSON.parse(localStorage.getItem('ks-member|U1') ?? 'null'));

  await t.test('第一次開：要等查到家庭才進得去，查到後記下來', async () => {
    const page = await openPage(() => {
      window.__gates = { household_members: new Promise(resolve => { window.__releaseMembers = resolve; }) };
    });
    await page.goto(`${base}/index.html`);
    await page.waitForTimeout(800);
    assert.equal(await page.$('#root.app'), null, '沒有記錄時不能跳過查家庭');
    await page.evaluate(() => window.__releaseMembers());
    await page.waitForSelector('#root.app', { timeout: 20_000 });
    assert.deepEqual(await cachedMember(page), { household_id: 'H1', role: 'owner' });
    await page.close();
  });

  await t.test('記得家庭時：household_members 卡住也照樣開出首屏', async () => {
    const page = await openPage(() => {
      localStorage.setItem('ks-member|U1', JSON.stringify({ household_id: 'H1', role: 'owner' }));
      window.__gates = { household_members: new Promise(() => {}) };
    });
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#root.app', { timeout: 5_000 });
    await page.close();
  });

  await t.test('記錯家庭：背景重查後改正並整頁重來', async () => {
    // 重來可能發生在第一次 load 事件之前，所以用 sessionStorage 數「文件開始了幾次」。
    const page = await openPage(() => {
      sessionStorage.setItem('boots', String(Number(sessionStorage.getItem('boots') ?? 0) + 1));
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('ks-member|U1', JSON.stringify({ household_id: 'H9', role: 'owner' }));
    });
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ks-member|U1') ?? 'null')?.household_id === 'H1',
      null, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('#root.app'), null, { timeout: 20_000 });
    await page.waitForTimeout(300);
    const boots = Number(await page.evaluate(() => sessionStorage.getItem('boots')));
    assert.ok(boots >= 2, `記錯家庭要重新載入，實際載入 ${boots} 次`);
    assert.deepEqual(await cachedMember(page), { household_id: 'H1', role: 'owner' });
    await page.close();
  });

  await t.test('貸款摘要預熱：token 過期時不送請求，換新後才用新 token 查', async () => {
    const seen = [];
    const page = await openPage(authKey => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(authKey, JSON.stringify({
        access_token: 'stale', expires_at: Math.floor(Date.now() / 1000) - 60, user: { id: 'U1' },
      }));
    }, AUTH_KEY);
    await page.route('**/gbxsnwqbjmgfikpblyot.supabase.co/**', route => {
      const request = route.request();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      seen.push({ path: new URL(request.url()).pathname, auth: request.headers().authorization });
      return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '[]' });
    });
    await page.goto(`${base}/index.html`);
    await page.waitForSelector('#root.app', { timeout: 20_000 });
    await page.waitForTimeout(1500);
    assert.deepEqual(seen, [], '過期 token 不該送出去');

    await page.evaluate(authKey => localStorage.setItem(authKey, JSON.stringify({
      access_token: 'fresh', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'U1' },
    })), AUTH_KEY);
    for (let i = 0; i < 40 && !seen.length; i += 1) await page.waitForTimeout(100);
    assert.ok(seen.some(row => row.path === '/rest/v1/loan_accounts'), '換新 token 後要補查');
    assert.ok(seen.every(row => row.auth === 'Bearer fresh'), `用到舊 token：${JSON.stringify(seen)}`);
    await page.close();
  });
});
