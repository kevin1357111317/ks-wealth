import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSummary,
  calculateTwdAmount,
  isValidSymbol,
  normalizeFinancialItem,
  parseNonNegative,
} from '../financial-core.js';

test('TWD and USD use amount_twd as the canonical result', () => {
  assert.equal(calculateTwdAmount({ nativeCurrency: 'TWD', nativeAmount: 12_345, fxRateTwd: 99 }), 12_345);
  assert.equal(calculateTwdAmount({ nativeCurrency: 'USD', nativeAmount: 50_000, fxRateTwd: 31.62 }), 1_581_000);
});

test('legacy original fields remain readable without overriding amount_twd', () => {
  const normalized = normalizeFinancialItem({
    amount_twd: 316_200,
    original_currency: 'USD',
    original_amount: 10_000,
    native_currency: null,
    native_amount: null,
  });
  assert.equal(normalized.native_currency, 'USD');
  assert.equal(normalized.native_amount, 10_000);
  assert.equal(normalized.amount_twd, 316_200);
});

test('family and owner summaries share one amount_twd calculation path', () => {
  const items = [
    { owner_scope: 'husband', kind: 'asset', amount_twd: 100 },
    { owner_scope: 'husband', kind: 'liability', amount_twd: 30 },
    { owner_scope: 'wife', kind: 'asset', amount_twd: 80 },
    { owner_scope: 'wife', kind: 'liability', amount_twd: 20 },
  ];
  assert.deepEqual(calculateSummary(items), {
    assets: [items[0], items[2]], liabilities: [items[1], items[3]],
    totalAssets: 180, totalLiabilities: 50, netWorth: 130,
  });
  assert.equal(calculateSummary(items, 'husband').netWorth, 70);
  assert.equal(calculateSummary(items, 'wife').netWorth, 60);
});

test('invalid, infinite and negative input is rejected', () => {
  for (const value of ['NaN', Infinity, -1]) {
    assert.throws(() => parseNonNegative(value, '金額'));
  }
  assert.throws(() => parseNonNegative(0, '股數', { positive: true }));
});

test('stock symbols are normalized by a strict safe format', () => {
  assert.equal(isValidSymbol('2330'), true);
  assert.equal(isValidSymbol('00631L'), true);
  assert.equal(isValidSymbol('BRK.B'), true);
  assert.equal(isValidSymbol('<script>'), false);
});
