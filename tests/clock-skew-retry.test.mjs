// Supabase 伺服器之間時鐘差一兩秒：token 剛換好就打 PostgREST，偶爾會拿到
// 401 PGRST303「JWT issued at future」，首頁因此整個變成錯誤畫面（2026-09-28）。
// 只對這一種錯重送；其他回應原樣回去。兩個 client（auth-tools.js 先建、app-v3.js 沿用）
// 都要掛上，否則實際用的那一個沒有重送。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { withClockSkewRetry } from '../supabase-fetch.js';

const skewed = () => new Response(JSON.stringify({ code: 'PGRST303', message: 'JWT issued at future' }), { status: 401 });
const ok = () => new Response('[]', { status: 200 });
const expired = () => new Response(JSON.stringify({ code: 'PGRST301', message: 'JWT expired' }), { status: 401 });

function scripted(...responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return responses.shift()();
  };
  return { fetchImpl, calls };
}

test('JWT issued at future：等一下再送，第二次成功就回成功', async () => {
  const sleeps = [];
  const { fetchImpl, calls } = scripted(skewed, ok);
  const wrapped = withClockSkewRetry(fetchImpl, { sleep: async ms => { sleeps.push(ms); } });
  const response = await wrapped('https://x/rest/v1/financial_items', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(calls[1], calls[0], '重送要用同一組參數');
});

test('一直是時鐘誤差：最多重送兩次，最後照實回 401', async () => {
  const { fetchImpl, calls } = scripted(skewed, skewed, skewed);
  const wrapped = withClockSkewRetry(fetchImpl, { sleep: async () => {} });
  const response = await wrapped('u', {});
  assert.equal(response.status, 401);
  assert.equal(calls.length, 3);
});

test('其他 401 與成功回應不重送', async () => {
  for (const make of [expired, ok]) {
    const { fetchImpl, calls } = scripted(make);
    const response = await withClockSkewRetry(fetchImpl, { sleep: async () => assert.fail('不該等待') })('u', {});
    assert.equal(calls.length, 1);
    assert.equal(response.status, make === ok ? 200 : 401);
    assert.ok(await response.text(), '回應本體要還讀得到');
  }
});

test('兩個 supabase client 都掛上重送', async () => {
  const [app, auth] = await Promise.all([
    readFile(new URL('../app-v3.js', import.meta.url), 'utf8'),
    readFile(new URL('../auth-tools.js', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /global: \{ fetch: withClockSkewRetry\(/);
  assert.match(auth, /global:\{fetch:withClockSkewRetry\(/);
});
