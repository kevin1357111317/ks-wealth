// 版號寫在三個地方：app-version.js（畫面唯一來源）、VERSIONING.md（正式版紀錄）、
// index.html 的 ?v=（PWA 快取字串）。三個要一致，漏掉任何一個畫面就會顯示舊版號，
// 或是新版的 app-version.js 根本不會被抓下來。
//
// git log 上「同步版號文件」「更新正式版號」「更新前端版號快取」這種補丁 commit 出現過
// 好幾輪，就是因為三邊會各自漏 —— 沒有測試守著就只能靠記性。
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
  const cacheBust = html.match(/\/app-version\.js\?v=([A-Za-z0-9]+)/)?.[1];

  assert.ok(source, 'app-version.js 找不到 APP_VERSION');
  assert.equal(released, source, `VERSIONING.md 的正式版是 ${released}，app-version.js 是 ${source}`);
  assert.equal(cacheBust, source, `index.html 的 ?v= 是 ${cacheBust}，app-version.js 是 ${source}`);
});

test('版號格式照 VERSIONING.md 的規則', async () => {
  const source = (await read('app-version.js')).match(/const APP_VERSION = '([^']+)'/)?.[1];
  // 大版 V2、小版 V2P4；大版升級時小版歸零，所以 V2P0 不該存在
  assert.match(source, /^V[1-9]\d*(P[1-9]\d*)?$/, `版號格式不對：${source}`);
});
