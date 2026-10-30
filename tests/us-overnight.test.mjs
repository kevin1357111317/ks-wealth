// 美股夜盤：台灣白天（美東 20:00–04:00）Yahoo、Finnhub 都沒有資料，改疊 Alpaca overnight feed 的成交價。
// 時段切錯會讓週末也去抓、或夜盤時不抓；漲跌基準錯會把盤後跟夜盤的差當成整天漲跌。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mergeOvernight, usSession } from '../supabase/functions/refresh-tw-quotes/us-session.js';

// 美東時間（夏令 UTC-4，2026-10-26 那週還在夏令）
const et = text => new Date(`${text}-04:00`);

test('usSession：夜盤是週日到週四 20:00 到隔天 04:00', () => {
  assert.equal(usSession(et('2026-10-29T21:30:00')), 'overnight', '週四晚上');
  assert.equal(usSession(et('2026-10-30T03:59:00')), 'overnight', '週五凌晨收尾');
  assert.equal(usSession(et('2026-10-30T04:00:00')), 'pre');
  assert.equal(usSession(et('2026-10-30T09:30:00')), 'regular');
  assert.equal(usSession(et('2026-10-30T16:00:00')), 'post');
  assert.equal(usSession(et('2026-10-30T20:30:00')), 'closed', '週五晚上沒有夜盤');
  assert.equal(usSession(et('2026-10-31T12:00:00')), 'closed', '週六');
  assert.equal(usSession(et('2026-10-25T19:59:00')), 'closed', '週日 20:00 前');
  assert.equal(usSession(et('2026-10-25T20:00:00')), 'overnight', '週日晚上開夜盤');
  assert.equal(usSession(et('2026-10-26T01:00:00')), 'overnight', '週一凌晨');
});

const yahoo = { provider: 'yahoo', currency: 'USD', price: 159.70, change: 11.91, changePercent: 8.06,
  session: 'post', quotedAt: '2026-10-20T23:59:00.000Z' };   // 正規收盤 147.79

test('mergeOvernight：換成夜盤價，漲跌仍對最近一次正規收盤', () => {
  const merged = mergeOvernight(yahoo, { price: 161.46, at: '2026-10-21T03:46:00Z' });
  assert.equal(merged.price, 161.46);
  assert.equal(merged.session, 'overnight');
  assert.equal(merged.provider, 'alpaca');
  assert.equal(merged.change.toFixed(2), '13.67');
  assert.equal(merged.changePercent.toFixed(2), '9.25');
  assert.equal(merged.quotedAt, '2026-10-21T03:46:00.000Z');
});

test('mergeOvernight：夜盤那筆比盤後舊、沒有夜盤價或沒有 Yahoo，都不硬疊', () => {
  assert.equal(mergeOvernight(yahoo, { price: 139.5, at: '2026-10-16T07:56:00Z' }), yahoo, '上週的夜盤成交不能蓋掉今天盤後');
  assert.equal(mergeOvernight(yahoo, undefined), yahoo);
  assert.equal(mergeOvernight(yahoo, { price: 0, at: '2026-10-21T03:46:00Z' }), yahoo);
  assert.equal(mergeOvernight(null, { price: 161.46, at: '2026-10-21T03:46:00Z' }), null);
});

test('refresh-tw-quotes 用 Alpaca overnight feed，快照不受影響', async () => {
  const source = await readFile(new URL('../supabase/functions/refresh-tw-quotes/index.ts', import.meta.url), 'utf8');
  assert.match(source, /from "\.\/us-session\.js"/);
  assert.match(source, /feed=overnight/);
  assert.match(source, /ALPACA_API_KEY_ID/);
  assert.doesNotMatch(source, /function usSession/, '時段判斷只留一份，在 us-session.js');
  const snapshot = await readFile(new URL('../supabase/functions/daily-wealth-snapshot/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(snapshot, /alpaca|overnight/i, '每日快照只記正規收盤，不能接夜盤價');
});
