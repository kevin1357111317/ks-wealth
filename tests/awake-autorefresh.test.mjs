// 兩件事：開著的時候螢幕恆亮，以及行情自己會更新。
//
// 自動更新的間隔取的是 Edge Function 共用快取的 TTL（10 分鐘）。抓得比這個勤沒有
// 意義：10 分鐘內的第二次更新只會讀到同一份快取，行情不會變，只是白耗電跟吃額度。
// 兩件事都只在畫面看得到的時候做 —— Wake Lock 本來就會被系統收回，背景分頁的
// 計時器也會被降頻。
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
const TEN_MINUTES = 10 * 60 * 1000;

test('開著就恆亮，行情每 10 分鐘自己更新', { skip }, async t => {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
  // 記下每次 functions.invoke，並且假裝有 Wake Lock API（headless Chromium 沒有）
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
globalThis.__wakeLock = { requests: 0, released: 0, active: false };
Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
  request: async type => {
    if (type !== 'screen') throw new Error('unexpected wake lock type ' + type);
    if (document.visibilityState !== 'visible') throw new Error('not visible');
    globalThis.__wakeLock.requests += 1;
    globalThis.__wakeLock.active = true;
    const listeners = [];
    const lock = {
      released: false,
      addEventListener: (event, handler) => { if (event === 'release') listeners.push(handler); },
      __systemRelease() {
        this.released = true;
        globalThis.__wakeLock.active = false;
        globalThis.__wakeLock.released += 1;
        listeners.forEach(handler => handler());
      },
    };
    globalThis.__wakeLock.last = lock;
    return lock;
  },
} });`;

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

  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, locale: 'zh-TW' });
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('console', entry => { if (entry.type() === 'error') failures.push(entry.text()); });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());

  // 假時鐘：不然要等 10 分鐘才測得到一次自動更新。裝了之後時間就停住，
  // 開機過程中該跑的計時器要自己推。
  await page.clock.install();
  await page.goto(`${base}/index.html`);
  for (let tick = 0; tick < 100; tick += 1) {
    if (await page.locator('#root.app').count()) break;
    await page.clock.runFor(200);
    await page.waitForTimeout(50);
  }
  await page.waitForSelector('#root.app', { timeout: 20_000 });
  await page.clock.runFor(1000);

  // 一次更新會叫 refresh-tw-quotes 與 refresh-klfan-quotes 各一次，數前面那支就好
  const refreshes = () => page.evaluate(() => globalThis.__invokes?.['refresh-tw-quotes'] ?? 0);
  const lock = () => page.evaluate(() => globalThis.__wakeLock);

  await t.test('一開起來就要到螢幕恆亮', async () => {
    const state = await lock();
    assert.equal(state.requests, 1, '應該要過一次 screen wake lock');
    assert.equal(state.active, true);
  });

  await t.test('開著不動，每 10 分鐘會自己更新一次行情', async () => {
    const before = await refreshes();
    await page.clock.runFor(TEN_MINUTES);
    const once = await refreshes();
    assert.equal(once, before + 1, `10 分鐘要更新一次，實際 ${once - before} 次`);
    await page.clock.runFor(TEN_MINUTES);
    assert.equal(await refreshes(), before + 2, '第二個 10 分鐘再一次');
  });

  await t.test('抓得比快取 TTL 還勤沒有意義，所以不會提早更新', async () => {
    const before = await refreshes();
    await page.clock.runFor(TEN_MINUTES - 30_000);
    assert.equal(await refreshes(), before, '不到 10 分鐘不該更新');
  });

  await t.test('切到背景就停手，不在沒人看的時候耗電跟吃額度', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = await refreshes();
    await page.clock.runFor(TEN_MINUTES * 3);
    assert.equal(await refreshes(), before, '背景時不該更新');
  });

  await t.test('回到前景要補一次更新，而且重新要一次恆亮', async () => {
    // 系統在切背景時會自己收回 wake lock，並且發 release 事件
    await page.evaluate(() => { globalThis.__wakeLock.last.__systemRelease(); });
    assert.equal((await lock()).active, false, '收回之後就不是恆亮了');
    const before = await refreshes();
    const locksBefore = (await lock()).requests;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(1000);
    assert.equal(await refreshes(), before + 1, '離開超過 10 分鐘，回來要先補一次');
    assert.equal((await lock()).requests, locksBefore + 1, '回前景要重新要一次 wake lock');
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
