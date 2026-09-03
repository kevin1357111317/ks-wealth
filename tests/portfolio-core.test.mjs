import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePortfolio, calculateStockMetrics, currentShares, decodePortfolioBootstrap, xirr } from '../portfolio-core.js';

const payload = {
  s: [['VOO', 'VOO', '美股', 'USD', 'NYSEARCA:VOO', 700]],
  q: [['NYSEARCA:VOO', 710, 'USD', 'test', '2026-09-03', 1]],
  d: { banks: ['國泰'], kinds: ['trade', 'dividend'], notes: ['股票', '股息'] },
  t: [[1, 0, '2025-01-01', -100, 1, 0, 0, 0, -3200], [2, 0, '2025-06-01', 2, 0, 0, 1, 1, 64]],
};

test('bootstrap rows decode without losing transaction fields', () => {
  const [stock] = decodePortfolioBootstrap(payload);
  assert.equal(stock.transactions.length, 2);
  assert.equal(stock.transactions[1].kind, 'dividend');
  assert.equal(stock.quote.price, 710);
});

test('net invested includes sales and dividends by reversing all cashflows', () => {
  const [stock] = decodePortfolioBootstrap(payload);
  const metrics = calculateStockMetrics(stock, 32, '2026-01-01');
  assert.equal(currentShares(stock), 1);
  assert.equal(metrics.netInvestedTwd, 3136);
  assert.equal(metrics.currentValueTwd, 22720);
  assert.equal(metrics.profitTwd, 19584);
});

test('portfolio groups markets without adding positions twice', () => {
  const [us] = decodePortfolioBootstrap(payload);
  const tw = { ...us, key: '2330', market: '台股', currency: 'TWD', quote: { price: 100 }, transactions: [{ date: '2025-01-01', amount: -50, shares: 1, twd: -50, kind: 'trade' }] };
  const result = calculatePortfolio([us, tw], 32, '2026-01-01');
  assert.equal(result.all.currentValueTwd, result.tw.currentValueTwd + result.us.currentValueTwd);
  assert.equal(result.all.transactions, 3);
});

test('xirr returns the annualized root for a simple one-year investment', () => {
  const result = xirr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 110 }]);
  assert.ok(Math.abs(result - 0.1) < 1e-6);
});
