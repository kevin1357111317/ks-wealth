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

// portfolio-performance 不在 Vercel 的部署範圍，推 main 只會更新前端。它回的 fnVersion 是前端判斷
// 「數字是不是舊引擎算的」的依據。以前要求 FN_VERSION 跟 APP_VERSION 一致，結果每次前端改版
// 都得重新部署一支根本沒改的 Function（2026-10-02~03 兩天多部署了四次）。
//
// 現在改成：引擎版本只在引擎原始碼真的變動時才升。下面的指紋是三個檔案（去掉 FN_VERSION 那行）
// 的 sha256 —— 改了程式碼卻沒升版號，這裡會紅；升了版號就要部署，前端的
// PERFORMANCE_ENGINE_VERSION 也要一起改，畫面才不會一直亮「引擎停在舊版」。
const ENGINE = { version: 'V3.42.0', sha256: '276e4a0e5eeb1f541b5185dc7fb761da0d31f645123d44c2e338f838ac63772a' };

test('portfolio-performance：引擎版本、前端預期版本、原始碼指紋三者一致', async () => {
  const { createHash } = await import('node:crypto');
  const [versionScript, app, index, core, math] = await Promise.all([
    read('app-version.js'), read('app-v3.js'),
    read('supabase/functions/portfolio-performance/index.ts'),
    read('supabase/functions/portfolio-performance/core.js'),
    read('supabase/functions/portfolio-performance/return-math.js'),
  ]);
  const appVersion = versionScript.match(/const APP_VERSION = '([^']+)'/)?.[1];
  const fnVersion = index.match(/const FN_VERSION = "([^"]+)"/)?.[1];
  const expected = app.match(/const PERFORMANCE_ENGINE_VERSION = '([^']+)'/)?.[1];
  const fingerprint = createHash('sha256')
    .update([index.replace(/const FN_VERSION = "[^"]+";/, ''), core, math].join('\n\u0000\n'))
    .digest('hex');

  assert.ok(fnVersion, 'portfolio-performance/index.ts 找不到 FN_VERSION');
  assert.match(index, /fnVersion: FN_VERSION/, 'FN_VERSION 沒有放進回應，前端拿不到');
  assert.equal(expected, fnVersion, `前端預期引擎 ${expected}，Function 是 ${fnVersion}`);
  assert.equal(fingerprint, ENGINE.sha256,
    `portfolio-performance 的程式碼改了：FN_VERSION 與 PERFORMANCE_ENGINE_VERSION 改成 ${appVersion}、`
    + `更新這裡的 ENGINE、合併後部署那支 Function。新指紋 ${fingerprint}`);
  assert.equal(fnVersion, ENGINE.version, `指紋記錄的是 ${ENGINE.version}，FN_VERSION 是 ${fnVersion}`);
  const order = v => v.slice(1).split('.').map(Number).reduce((sum, part) => sum * 1000 + part, 0);
  assert.ok(order(fnVersion) <= order(appVersion), `引擎版本 ${fnVersion} 不能比 App ${appVersion} 新`);
});

test('舊制不得再往 V3P27 之後延伸', async () => {
  const source = (await read('app-version.js')).match(/const APP_VERSION = '([^']+)'/)?.[1];
  if (/^V\d+P\d+$/.test(source ?? '')) {
    assert.equal(source, 'V3P26', `舊制已凍結在 V3P26，不得新增 ${source}`);
  }
});
