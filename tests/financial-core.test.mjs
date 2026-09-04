import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateAllocation,
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

test('asset allocation uses each scope total and hides zero categories', () => {
  const husbandAssets = [
    { category: '台股', amount_twd: 60 },
    { category: '黃金', amount_twd: 40 },
    { category: '收藏', amount_twd: 0 },
  ];
  assert.deepEqual(calculateAllocation(husbandAssets, 100), [
    { category: '台股', value: 60, percent: 60 },
    { category: '黃金', value: 40, percent: 40 },
  ]);
});

test('出清的台帳部位不出現在列表與統計裡', () => {
  // 觸發器在股數歸零時是把那一列更新成 0，不是刪掉 —— 再買回來要接回同一列。
  // 但 0 股的部位不是資產。
  const items = [
    { id: 1, owner_scope: 'husband', kind: 'asset', amount_twd: 100, category: '現金及存款' },
    { id: 2, owner_scope: 'husband', kind: 'asset', amount_twd: 0, category: '美股', portfolio_stock_key: 'TSLA', quantity: 0 },
    { id: 3, owner_scope: 'husband', kind: 'asset', amount_twd: 500, category: '美股', portfolio_stock_key: 'VOO', quantity: 350 },
  ];
  const summary = calculateSummary(items, 'husband');
  assert.equal(summary.assets.length, 2, '出清的那筆不該被算進來');
  assert.ok(!summary.assets.some(item => item.portfolio_stock_key === 'TSLA'));
  assert.equal(summary.totalAssets, 600);
  // 原始陣列不能被動到：syncPortfolioFinancialItem 還要靠它找到那一列來更新
  assert.equal(items.length, 3);
});

test('手動建立的 0 元項目不受影響', () => {
  // 只擋台帳連動的部位，手動輸入 0 是使用者自己的選擇
  const items = [{ id: 1, owner_scope: 'wife', kind: 'asset', amount_twd: 0, category: '現金及存款' }];
  assert.equal(calculateSummary(items, 'wife').assets.length, 1);
});
