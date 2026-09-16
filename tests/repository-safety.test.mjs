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

test('migration 時間前綴不可重複', async () => {
  const files = (await readdir(join(REPO, 'supabase/migrations'))).filter(name => name.endsWith('.sql'));
  const versions = files.map(name => name.split('_', 1)[0]);
  assert.equal(new Set(versions).size, versions.length, '同一 migration version 只能對應一個檔案');
});

test('舊版 App 不再隨正式站部署', async () => {
  const files = new Set(await readdir(REPO));
  assert.equal(files.has('app.js'), false);
  assert.equal(files.has('style.css'), false);
});

test('貸款月份摘要使用共用批次請求與 single-flight', async () => {
  const source = await readFile(join(REPO, 'loan-month-summary.js'), 'utf8');
  assert.match(source, /monthDataFlight/);
  assert.match(source, /loadRemainingMonthBatch/);
  assert.doesNotMatch(source, /owners\.flatMap/);
});
