// 版號寫在三個地方：app-version.js（畫面唯一來源）、VERSIONING.md（正式版紀錄）、
// index.html 的 ?v=（PWA 快取字串）。三個要一致，漏掉任何一個畫面就會顯示舊版號，
// 或是新版的 app-version.js 根本不會被抓下來。
//
// V3P26 是舊制最後一版；下一次產品出貨起使用 VMAJOR.MINOR.PATCH。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('版號三個地方要一致', async () => {
  const [script, doc, html] = await Promise.all([
    read('app-version.js'), read('VERSIONING.md'), read('index.html'),
  ]);

  const source = script.match(/const APP_VERSION = '([^']+)'/)?.[1];
  const released = doc.match(/目前正式版：\*\*([^*]+)\*\*/)?.[1];
  const cacheBust = html.match(/\/app-version\.js\?v=([A-Za-z0-9.-]+)/)?.[1];

  assert.ok(source, 'app-version.js 找不到 APP_VERSION');
  assert.equal(released, source, `VERSIONING.md 的正式版是 ${released}，app-version.js 是 ${source}`);
  assert.equal(cacheBust, source, `index.html 的 ?v= 是 ${cacheBust}，app-version.js 是 ${source}`);
});

test('正式 CSS、模組與內部 import 的快取字串跟版號一致', async () => {
  const [versionScript, html, app] = await Promise.all([
    read('app-version.js'), read('index.html'), read('app-v3.js'),
  ]);
  const version = versionScript.match(/const APP_VERSION = '([^']+)'/)?.[1];
  const shellAssets = [
    ...html.matchAll(/(?:href|src)="\/(?:[^"?]+\.(?:css|js))\?v=([^"&]+)"/g),
  ].map(match => match[1]);
  const moduleImports = [...app.matchAll(/from '\.\/[^'?]+\.js\?v=([^']+)'/g)]
    .map(match => match[1]);

  assert.ok(shellAssets.length > 0, 'index.html 找不到帶版號的正式資產');
  assert.ok(moduleImports.length > 0, 'app-v3.js 找不到帶版號的內部模組');
  assert.deepEqual([...new Set([...shellAssets, ...moduleImports])], [version],
    '正式資產的 cache-bust 不可各自停在舊版');
});

test('正式版號只允許 legacy V3P26 或 SemVer', async () => {
  const source = (await read('app-version.js')).match(/const APP_VERSION = '([^']+)'/)?.[1];
  const legacyBaseline = source === 'V3P26';
  const semver = /^V(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(source ?? '');

  assert.ok(
    legacyBaseline || semver,
    `版號格式不對：${source}；V3P26 之後必須使用 VMAJOR.MINOR.PATCH`,
  );
});

// portfolio-performance 不在 Vercel 的部署範圍，推 main 只會更新前端。它回的 fnVersion
// 就是前端用來判斷「數字是不是舊引擎算的」的依據，所以這個常數一定要跟 APP_VERSION 同步；
// 忘了改的話警示會永遠亮著，等於沒有警示。
test('Edge Function 回的 fnVersion 要跟 APP_VERSION 一致', async () => {
  const [versionScript, fn] = await Promise.all([
    read('app-version.js'), read('supabase/functions/portfolio-performance/index.ts'),
  ]);
  const version = versionScript.match(/const APP_VERSION = '([^']+)'/)?.[1];
  const fnVersion = fn.match(/const FN_VERSION = "([^"]+)"/)?.[1];

  assert.ok(fnVersion, 'portfolio-performance/index.ts 找不到 FN_VERSION');
  assert.equal(fnVersion, version,
    `FN_VERSION 是 ${fnVersion}，APP_VERSION 是 ${version}；改版號時兩邊要一起動`);
  assert.match(fn, /fnVersion: FN_VERSION/, 'FN_VERSION 沒有放進回應，前端拿不到');
});

test('舊制不得再往 V3P27 之後延伸', async () => {
  const source = (await read('app-version.js')).match(/const APP_VERSION = '([^']+)'/)?.[1];
  if (/^V\d+P\d+$/.test(source ?? '')) {
    assert.equal(source, 'V3P26', `舊制已凍結在 V3P26，不得新增 ${source}`);
  }
});
