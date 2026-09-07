// 趨勢圖的手勢監聽本來掛在 #root（整個 App）上，而且因為 pointermove 裡有
// preventDefault() 所以是 non-passive 的。WebKit 會把這種範圍整塊標成主執行緒
// 捲動區，捲動前每個 move 都要先回 JS 問過 —— 整頁都會受影響。
//
// 現在改成：平常只有圖表自己一個 passive 的 pointerdown，move/up/cancel 只在
// 真的在拖曳時掛在 window 上，放開就收掉。這支測試守的是那個「放開就收掉」，
// 以及刮動本身沒有被改壞。
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

test('趨勢圖可以刮，放開之後不留下任何監聽器', { skip }, async t => {
  // 圖只有一個點的話 index 永遠是 0，刮不動也看不出差別，要有一整段歷史才測得到。
  const history = Array.from({ length: 153 }, (_, index) => ({
    household_id: 'H1',
    recorded_on: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
    net_worth_twd: 70_000_000 + Math.sin(index / 7) * 3_000_000 + index * 20_000,
  }));
  const stub = `${await readFile(new URL('./support/fake-supabase.js', import.meta.url), 'utf8')}
db.net_worth_history = ${JSON.stringify(history)};`;

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

  const page = await browser.newPage({
    viewport: { width: 390, height: 700 }, locale: 'zh-TW', hasTouch: true, isMobile: true,
  });
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  page.on('console', entry => { if (entry.type() === 'error') failures.push(entry.text()); });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('[data-trend-chart]', { timeout: 20_000 });
  await page.waitForTimeout(600);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
  const selected = () => page.evaluate(() => {
    const selection = document.querySelector('[data-trend-selection]');
    if (!selection) return null;
    return selection.hasAttribute('hidden') ? null : Number(selection.dataset.index);
  });
  const listenerTypes = async expression => {
    const { result } = await cdp.send('Runtime.evaluate', { expression });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
    // Playwright 自己也會往 window 掛一堆，只看我們在意的那幾種
    return listeners.filter(entry => entry.type.startsWith('pointer'))
      .map(entry => `${entry.type}${entry.passive ? ':passive' : ''}`);
  };

  const box = await page.locator('[data-trend-chart]').boundingBox();
  const midY = box.y + box.height / 2;

  await t.test('平常整個 App 上沒有 pointermove 監聽器', async () => {
    assert.deepEqual(await listenerTypes("document.getElementById('root')"), [],
      '#root 上不該再掛手勢監聽 —— 那會把整頁變成主執行緒捲動區');
    assert.deepEqual(await listenerTypes("document.querySelector('[data-trend-chart]')"),
      ['pointerdown:passive'], '圖表只留一個 passive 的 pointerdown');
    assert.equal((await listenerTypes('window')).filter(type => type.startsWith('pointermove')).length, 0);
  });

  await t.test('橫向刮動時提示框跟著手指走', async () => {
    await touch('touchStart', box.x + 20, midY);
    const seen = [];
    for (let step = 1; step <= 12; step += 1) {
      await touch('touchMove', box.x + 20 + (box.width - 40) * (step / 12), midY);
      await page.waitForTimeout(20);
      seen.push(await selected());
    }
    assert.ok(new Set(seen).size >= 8, `提示框應該一路跟著走，實際只停過 ${new Set(seen).size} 個點`);
    assert.ok(seen.at(-1) > 130, `刮到最右邊要接近最後一個資料點，實際 ${seen.at(-1)}`);

    // 拖曳中才會有 pointermove，而且是 passive 的
    assert.deepEqual((await listenerTypes('window')).filter(type => type.startsWith('pointermove')),
      ['pointermove:passive']);
    await touch('touchEnd', box.x + box.width - 20, midY);
    await page.waitForTimeout(150);
  });

  await t.test('放開之後監聽器收乾淨，指標再動也不會牽動提示框', async () => {
    assert.equal((await listenerTypes('window')).filter(type => type.startsWith('pointermove')).length, 0,
      'pointermove 要跟著手指離開一起收掉');
    const before = await selected();
    // 沒有按下去就掃過整張圖，提示框不該動
    await page.mouse.move(box.x + 20, midY);
    await page.mouse.move(box.x + box.width - 20, midY);
    await page.waitForTimeout(100);
    assert.equal(await selected(), before, '沒有按著就不該更新提示框');
  });

  // 手指按下去的第一個取樣幾乎都是斜的。以前只要那一下 |dx| > |dy|，就當成橫向刮動
  // latch 住並抓走 pointer capture —— 之後不管手指往上滑多遠，WebKit 都收不回這個手勢，
  // 整頁就被釘住捲不動。而且會不會中招完全看第一個取樣，所以是「有時候會有時候不會」。
  const swipeUp = async (firstDx, firstDy) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const x = box.x + box.width / 2;
    await touch('touchStart', x, midY);
    await touch('touchMove', x + firstDx, midY + firstDy);
    await page.waitForTimeout(30);
    const latched = await selected() !== null;
    for (let step = 1; step <= 18; step += 1) await touch('touchMove', x + firstDx, midY + firstDy - step * 14);
    await touch('touchEnd', x + firstDx, midY + firstDy - 252);
    await page.waitForTimeout(400);
    return { latched, scrolled: await page.evaluate(() => window.scrollY) };
  };

  await t.test('第一個取樣是斜的也不會被誤判成刮動', async () => {
    for (const [dx, dy] of [[2, -8], [8, -6], [7, -6], [9, -9]]) {
      await page.evaluate(() => document.querySelector('[data-trend-selection]').setAttribute('hidden', ''));
      const { latched, scrolled } = await swipeUp(dx, dy);
      assert.equal(latched, false, `第一個 move (${dx},${dy}) 之後就 latch 住了，往上滑會被釘住`);
      assert.ok(scrolled > 100, `第一個 move (${dx},${dy}) 的往上滑要捲得動，實際只捲了 ${scrolled}px`);
    }
  });

  await t.test('直向拖曳交還給瀏覽器捲動，不會被圖表吃掉', async () => {
    const { scrolled } = await swipeUp(0, 0);
    assert.ok(scrolled > 100, `從圖表上往上滑要能捲動頁面，實際 ${scrolled}px`);
    assert.equal((await listenerTypes('window')).filter(type => type.startsWith('pointermove')).length, 0,
      '判斷成直向之後也要把監聽器收掉');
  });

  const countCaptures = async run => {
    await page.evaluate(() => {
      globalThis.__captured = 0;
      if (!Element.prototype.__patchedCapture) {
        const original = Element.prototype.setPointerCapture;
        Element.prototype.setPointerCapture = function patched(...args) {
          globalThis.__captured += 1;
          return original.apply(this, args);
        };
        Element.prototype.__patchedCapture = true;
      }
    });
    await run();
    return page.evaluate(() => globalThis.__captured);
  };

  await t.test('完全不抓 pointer capture', async () => {
    // 抓了 capture，WebKit 就沒辦法把判斷錯的手勢收回去捲頁 —— 整頁被釘住。
    // 刮動被半路收走的問題改由 touchmove 解決，見下一支。
    const captured = await countCaptures(async () => {
      await swipeUp(8, -6);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      const box2 = await page.locator('[data-trend-chart]').boundingBox();
      await touch('touchStart', box2.x + 20, box2.y + box2.height / 2);
      for (let step = 1; step <= 8; step += 1) {
        await touch('touchMove', box2.x + 20 + step * 30, box2.y + box2.height / 2);
      }
      await touch('touchEnd', box2.x + 260, box2.y + box2.height / 2);
      await page.waitForTimeout(150);
    });
    assert.equal(captured, 0, '不管往上滑還是橫著刮，都不該抓 capture');
  });

  await t.test('刮到一半被 pointercancel 也要繼續跟著手指', async () => {
    // touch-action: pan-y 把直向讓給瀏覽器。橫著刮的時候手指只要有一點上下位移，
    // 瀏覽器就會接手捲頁並丟 pointercancel —— 這正是「左右滑到一半被釘住」。
    // touchmove 不受影響，會一路發到手指離開，刮動要靠它撐完。
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const chartBox = await page.locator('[data-trend-chart]').boundingBox();
    const chartY = chartBox.y + chartBox.height / 2;
    await page.evaluate(() => document.querySelector('[data-trend-selection]').setAttribute('hidden', ''));

    // pointercancel 的 pointerId 要跟真的那一顆對得起來，不然會被守衛擋掉、測不到東西
    await page.evaluate(() => {
      globalThis.__pointerId = null;
      document.querySelector('[data-trend-chart]').addEventListener('pointerdown',
        event => { globalThis.__pointerId = event.pointerId; }, { once: true });
    });
    await touch('touchStart', chartBox.x + 20, chartY);
    const pointerId = await page.evaluate(() => globalThis.__pointerId);
    assert.ok(pointerId !== null, '沒抓到 pointerdown，後面的 pointercancel 會打空');
    const seen = [];
    for (let step = 1; step <= 16; step += 1) {
      // 帶上下抖動，模擬真的用手指刮
      await touch('touchMove', chartBox.x + 20 + (chartBox.width - 40) * (step / 16),
        chartY + Math.sin(step / 2) * 6);
      // 刮到一半瀏覽器決定接手捲頁：pointer 被取消，但手指還在動
      if (step === 5) {
        await page.evaluate(id => window.dispatchEvent(
          new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true })), pointerId);
      }
      await page.waitForTimeout(18);
      seen.push(await selected());
    }
    await touch('touchEnd', chartBox.x + chartBox.width - 20, chartY);
    await page.waitForTimeout(150);

    const after = seen.slice(5);
    assert.ok(new Set(after.filter(v => v !== null)).size >= 8,
      `被取消之後還要一路跟到底，實際只走過 ${new Set(after.filter(v => v !== null)).size} 個點`);
    assert.ok(seen.at(-1) > 130, `刮到最右邊要接近最後一個資料點，實際 ${seen.at(-1)}`);
    assert.equal((await listenerTypes('window')).filter(t => t.startsWith('pointermove')).length, 0,
      '手指離開之後監聽器要收乾淨');
  });

  assert.deepEqual(failures, [], '瀏覽器不該有錯誤');
});
