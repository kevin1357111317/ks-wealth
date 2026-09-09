import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const REPO = fileURLToPath(new URL('..', import.meta.url));

test('正式 migration 目錄不混入提案檔', async () => {
  const files = await readdir(join(REPO, 'supabase/migrations'));
  assert.deepEqual(files.filter(name => /proposed|not_yet_applied/i.test(name)), []);
});

test('貸款月份摘要使用共用批次請求與 single-flight', async () => {
  const source = await readFile(join(REPO, 'loan-month-summary.js'), 'utf8');
  assert.match(source, /monthDataFlight/);
  assert.match(source, /loadRemainingMonthBatch/);
  assert.doesNotMatch(source, /owners\.flatMap/);
});

// 同一支本地模組被兩種 specifier 匯入的話，瀏覽器會當成兩個不同的模組：抓兩次、
// 解析兩次、模組層的常數各存一份。portfolio-core.js 中過一次 —— app-v3.js 帶
// ?v=、usd/gold/loan-core 沒帶，所以它被載了兩遍。
test('同一支本地模組在所有匯入處都用同一個 specifier', async () => {
  const files = (await readdir(REPO)).filter(name => name.endsWith('.js'));
  const specifiers = new Map();   // 檔名 -> 用過的 specifier 集合
  for (const name of files) {
    const source = await readFile(join(REPO, name), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s*'(\.\/[^']+\.js[^']*)'/g)) {
      const target = specifier.slice(2).split('?')[0];
      if (!specifiers.has(target)) specifiers.set(target, new Map());
      const seen = specifiers.get(target);
      seen.set(specifier, [...(seen.get(specifier) ?? []), name]);
    }
  }
  for (const [target, seen] of specifiers) {
    assert.equal(seen.size, 1,
      `${target} 被用 ${seen.size} 種寫法匯入，瀏覽器會載成 ${seen.size} 份：\n` +
      [...seen].map(([specifier, from]) => `  ${specifier}  <- ${from.join(', ')}`).join('\n'));
  }
});

// 圖片內嵌成 base64 會被算進 JS，而且每次 bump ?v= 就得整包重新下載與解析。
test('前端 JS 裡沒有內嵌的 base64 圖片', async () => {
  const files = (await readdir(REPO)).filter(name => name.endsWith('.js'));
  for (const name of files) {
    const source = await readFile(join(REPO, name), 'utf8');
    assert.ok(!source.includes('data:image/'),
      `${name} 內嵌了圖片，改放 icons/ 底下當一般圖檔`);
  }
});
