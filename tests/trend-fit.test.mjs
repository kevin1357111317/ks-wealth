// 淨資產趨勢圖的趨勢線與 R²（屋主 2026-11-06 要求）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { linearTrend } from '../trend-core.js';

test('完全在一條線上：R² = 1，斜率截距正確', () => {
  const fit = linearTrend([10, 12, 14, 16, 18]);
  assert.equal(fit.r2, 1);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 10);
  assert.equal(fit.at(4), 18);
});

test('手算的例子：y = 1, 3, 2, 5, 4', () => {
  // x̄=2、ȳ=3；Sxy=8、Sxx=10、Syy=10 → 斜率 0.8、截距 1.4、R² = 64/100
  const fit = linearTrend([1, 3, 2, 5, 4]);
  assert.ok(Math.abs(fit.slope - 0.8) < 1e-12);
  assert.ok(Math.abs(fit.intercept - 1.4) < 1e-12);
  assert.ok(Math.abs(fit.r2 - 0.64) < 1e-12);
});

test('金額模式跟 % 模式的 R² 一樣（線性轉換不變）', () => {
  const values = [100, 104, 101, 110, 108, 115];
  const percent = values.map(value => (value - 100) / 100 * 100);
  assert.ok(Math.abs(linearTrend(values).r2 - linearTrend(percent).r2) < 1e-12);
});

test('點太少、完全沒變化或有壞值時不畫', () => {
  assert.equal(linearTrend([1, 2]), null);
  assert.equal(linearTrend([5, 5, 5, 5]), null);
  assert.equal(linearTrend([1, NaN, 3]), null);
});
