// iOS 的 default 狀態列不會蓋在網頁上 —— 網頁從安全區下面才開始，狀態列那一條是
// 拿 html 的背景色去填的。所以 html 的背景只要跟畫面最上緣不一樣，那條就會跟畫面
// 接出一條硬邊（登入畫面上是 #dff5f1 對上漸層起頭的 #9fe4df，差很多）。
//
// 這支測試守的就是「html 的背景色 === 畫面最上緣實際畫出來的顏色」，三個畫面都要對。
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

test('狀態列那條顏色跟畫面接得起來', { skip }, async t => {
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

  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, locale: 'zh-TW' });
  await page.route('**/cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
  await page.route('**fonts.g**', route => route.abort());
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#root.app', { timeout: 20_000 });
  await page.waitForTimeout(400);

  // html 的 computed 背景色，對上畫面最上緣那一列實際畫出來的像素
  const compare = async () => {
    const htmlColour = await page.evaluate(() =>
      getComputedStyle(document.documentElement).backgroundColor);
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 390, height: 4 } });
    const topPixel = await page.evaluate(async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      const [r, g, b] = canvas.getContext('2d').getImageData(20, 1, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    }, `data:image/png;base64,${shot.toString('base64')}`);
    return { htmlColour, topPixel };
  };

  await t.test('App 畫面', async () => {
    const { htmlColour, topPixel } = await compare();
    assert.equal(htmlColour, topPixel, `html 是 ${htmlColour}，畫面最上緣是 ${topPixel}，狀態列會接出一條邊`);
  });

  for (const [className, label] of [['center', '載入畫面'], ['auth', '登入畫面']]) {
    await t.test(label, async () => {
      await page.evaluate(name => { document.getElementById('root').className = name; }, className);
      await page.waitForTimeout(150);
      const { htmlColour, topPixel } = await compare();
      assert.equal(htmlColour, topPixel, `html 是 ${htmlColour}，畫面最上緣是 ${topPixel}，狀態列會接出一條邊`);
    });
  }
});
