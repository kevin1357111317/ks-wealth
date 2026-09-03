import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const edgeSource = await readFile(new URL('../supabase/functions/refresh-tw-quotes/index.ts', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');

test('gold grams use the standard troy ounce and shared USD/TWD rate', () => {
  const grams = 31.1034768;
  const xauUsd = 3_500;
  const usdTwd = 31.5;
  assert.equal(Math.round((grams / 31.1034768) * xauUsd * usdTwd), 110_250);
  assert.match(edgeSource, /TROY_OUNCE_GRAMS = 31\.1034768/);
  assert.match(edgeSource, /goldAmountTwd\(grams, xauUsd, fxRate\)/);
  assert.match(edgeSource, /needsUsdFx = usSymbols\.length > 0 \|\| usdCashItems\.length > 0 \|\| goldItems\.length > 0/);
});

test('gold failures do not write amount_twd', () => {
  const start = edgeSource.indexOf('for (const item of goldItems)');
  const failureGuard = edgeSource.slice(start, edgeSource.indexOf('return json({', start));
  assert.ok(failureGuard.indexOf('if (!xauUsd || !fxRate)') < failureGuard.indexOf('.update({'));
  assert.match(failureGuard, /status: "error"/);
});

test('gold is a dedicated category and personal allocation is rendered', () => {
  assert.doesNotMatch(appSource, /黃金與收藏/);
  assert.match(appSource, /'不動產', '黃金', '保險'/);
  assert.match(appSource, /distributionPanel\(distributionRows, distributionTotal/);
});
