import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildPersonalTrendRows } from '../trend-core.js';
import {
  loanMonthDataKey,
  loanMonthStorageKey,
  readStoredAuth,
} from '../loan-month-cache-core.js';

const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const loanMonth = await readFile(new URL('../loan-month-summary.js', import.meta.url), 'utf8');
const quotes = await readFile(new URL('../supabase/functions/refresh-tw-quotes/index.ts', import.meta.url), 'utf8');
const snapshot = await readFile(new URL('../supabase/functions/daily-wealth-snapshot/index.ts', import.meta.url), 'utf8');
const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const supabaseSafety = await readFile(new URL('../supabase/README.md', import.meta.url), 'utf8');
const legacyBackfill = await readFile(new URL('../supabase/proposals/20260912_backfill_legacy_husband_net_history.sql', import.meta.url), 'utf8');

test('老公趨勢只讀正式歸戶的個人歷史，舊 net 與新資產負債自然接續', () => {
  const scopeHistory = [
    { recorded_on: '2026-01-01', owner_scope: 'husband', kind: 'net', total_twd: 29_000_000 },
    { recorded_on: '2026-08-26', owner_scope: 'husband', kind: 'net', total_twd: 31_500_000 },
    { recorded_on: '2026-08-27', owner_scope: 'husband', kind: 'asset', total_twd: 40_000_000 },
    { recorded_on: '2026-08-27', owner_scope: 'husband', kind: 'liability', total_twd: 8_000_000 },
    { recorded_on: '2026-08-29', owner_scope: 'husband', kind: 'asset', total_twd: 40_200_000 },
    { recorded_on: '2026-08-27', owner_scope: 'wife', kind: 'asset', total_twd: 20_000_000 },
    { recorded_on: '2026-08-27', owner_scope: 'wife', kind: 'liability', total_twd: 0 },
  ];
  assert.deepEqual(buildPersonalTrendRows({
    scopeHistory, ownerScope: 'husband', currentNetWorth: 32_300_000, today: '2026-08-30',
  }), [
    { recorded_on: '2026-01-01', total_twd: 29_000_000 },
    { recorded_on: '2026-08-26', total_twd: 31_500_000 },
    { recorded_on: '2026-08-27', total_twd: 32_000_000 },
    { recorded_on: '2026-08-29', total_twd: 32_200_000 },
    { recorded_on: '2026-08-30', total_twd: 32_300_000 },
  ]);
});

test('老婆趨勢只讀老婆 scope，不會拿到老公的舊 net 歷史', () => {
  const scopeHistory = [
    { recorded_on: '2026-01-01', owner_scope: 'husband', kind: 'net', total_twd: 29_000_000 },
    { recorded_on: '2026-08-27', owner_scope: 'wife', kind: 'asset', total_twd: 4_000_000 },
    { recorded_on: '2026-08-27', owner_scope: 'wife', kind: 'liability', total_twd: 0 },
  ];
  assert.deepEqual(buildPersonalTrendRows({
    scopeHistory, ownerScope: 'wife', currentNetWorth: 4_100_000, today: '2026-08-28',
  }), [
    { recorded_on: '2026-08-27', total_twd: 4_000_000 },
    { recorded_on: '2026-08-28', total_twd: 4_100_000 },
  ]);
});

test('個人趨勢同一 owner 的資產或負債單邊更新會沿用上一筆', () => {
  const scopeHistory = [
    { recorded_on: '2026-08-27', owner_scope: 'husband', kind: 'asset', total_twd: 40_000_000 },
    { recorded_on: '2026-08-27', owner_scope: 'husband', kind: 'liability', total_twd: 8_000_000 },
    { recorded_on: '2026-08-28', owner_scope: 'husband', kind: 'asset', total_twd: 40_200_000 },
    { recorded_on: '2026-08-27', owner_scope: 'wife', kind: 'asset', total_twd: 4_000_000 },
    { recorded_on: '2026-08-27', owner_scope: 'wife', kind: 'liability', total_twd: 0 },
  ];
  assert.deepEqual(buildPersonalTrendRows({
    scopeHistory, ownerScope: 'husband', currentNetWorth: 32_300_000, today: '2026-08-29',
  }), [
    { recorded_on: '2026-08-27', total_twd: 32_000_000 },
    { recorded_on: '2026-08-28', total_twd: 32_200_000 },
    { recorded_on: '2026-08-29', total_twd: 32_300_000 },
  ]);
});

test('前端個人趨勢只傳個人 scope，不再借用家庭歷史', () => {
  const personalResolver = app.slice(
    app.indexOf('function personalTrendRows'),
    app.indexOf('// Auth / startup'),
  );
  assert.match(personalResolver, /scopeHistory/);
  assert.doesNotMatch(personalResolver, /\bhistory\b/);
});

test('回填提案把切分日前家庭淨值正式寫成 husband net，且可重跑', () => {
  assert.match(legacyBackfill, /'husband', 'net'/);
  assert.match(legacyBackfill, /h\.recorded_on < coalesce\(w\.recorded_on/);
  assert.match(legacyBackfill, /on conflict .* do nothing/is);
  assert.match(legacyBackfill, /proposals/);
});

test('貸款摘要快取依使用者隔離', () => {
  const first = loanMonthStorageKey(loanMonthDataKey('U1', 'husband', 'personal', '2026-09-12'));
  const second = loanMonthStorageKey(loanMonthDataKey('U2', 'husband', 'personal', '2026-09-12'));
  assert.notEqual(first, second);
  assert.match(first, /^ks-loan-month-summary\|U1\|/);
  assert.deepEqual(readStoredAuth(JSON.stringify({ access_token: 'token', user: { id: 'U1' } })), {
    accessToken: 'token', userId: 'U1',
  });
});

test('完整載入會排隊補抓，financial_items 只接受最新回應', () => {
  assert.match(app, /loadRequested = true;\s*if \(loadFlight\) return loadFlight;/);
  assert.match(app, /while \(loadRequested && member\)/);
  assert.match(app, /generation !== itemReloadGeneration/);
  assert.match(app, /Date\.now\(\) - lastSuccessfulLoadAt >= QUOTE_FULL_INTERVAL_MS/);
  assert.match(app, /realtimeStatus !== 'SUBSCRIBED'/);
});

test('換帳號會清除帳號快取，失敗狀態不保留前一筆金額', () => {
  assert.match(app, /key\.startsWith\('ks-loan-month-summary\|'\)/);
  assert.match(app, /key\.startsWith\('ks:last-quote:'\)/);
  assert.match(app, /new CustomEvent\('ks:auth-change'/);
  assert.match(loanMonth, /setText\(value, '—'\);\s*setText\(note, '同步失敗，請稍後重試'\)/);
});

test('行情錯誤文字不把名稱或遠端錯誤直接放進 HTML', () => {
  assert.match(app, /replace\(\/\[<>&\]\/g/);
  assert.match(app, /'<': '＜', '>': '＞', '&': '＆'/);
});

test('人工編輯有版本衝突保護，系統行情不改人工版本欄位', () => {
  assert.match(app, /\.eq\('updated_at', item\.updated_at\)\s*\.select\('id'\)\.maybeSingle\(\)/);
  assert.match(app, /這筆資料已在另一台裝置更新/);
  assert.match(quotes, /const quoteWriter = cache/);
  assert.doesNotMatch(quotes, /quoteWriter\.from\("financial_items"\)\.update\(\{[^}]*updated_at/s);
  assert.doesNotMatch(quotes, /quoteWriter\.from\("financial_items"\)\.update\(\{[^}]*updated_by/s);
});

test('每日快照限制排程時段，函式 JWT 設定已納入版控', () => {
  assert.match(snapshot, /taipeiHour < 5 \|\| taipeiHour > 7/);
  assert.match(snapshot, /outside_snapshot_window/);
  assert.match(config, /\[functions\.refresh-tw-quotes\]\s*verify_jwt = true/);
  assert.match(config, /\[functions\.daily-wealth-snapshot\]\s*verify_jwt = false/);
});

test('migration 目錄明確阻擋 production db push', () => {
  assert.match(supabaseSafety, /禁止直接執行\s*`supabase db push`/);
  assert.match(supabaseSafety, /migration list/);
});
