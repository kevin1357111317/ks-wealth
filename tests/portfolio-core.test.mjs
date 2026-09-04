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

// 先進先出的重點：賣掉的那幾股要用「當初買它們」的成本算損益，不是整體平均。
// 分批在不同價位買進時兩者差很多，而且只有 FIFO 拆得出真正的已實現。
const lots = (transactions, quotePrice) => ({
  key: 'T', display: 'T', market: '台股', currency: 'TWD', symbol: 'TPE:1',
  manualPrice: null, quote: { price: quotePrice }, transactions,
});

test('已實現用先進先出配對，不是加權平均', () => {
  // 100 股 @100、100 股 @200，賣掉 100 股 @250。
  // FIFO 賣掉的是第一批（成本 10,000）→ 已實現 15,000，手上剩第二批（成本 20,000）。
  // 加權平均會算成已實現 10,000 / 未實現 10,000，那是錯的配對。
  const stock = lots([
    { id: 1, date: '2025-01-01', amount: -10000, shares: 100, twd: -10000, kind: 'trade' },
    { id: 2, date: '2025-02-01', amount: -20000, shares: 100, twd: -20000, kind: 'trade' },
    { id: 3, date: '2025-03-01', amount: 25000, shares: -100, twd: 25000, kind: 'trade' },
  ], 250);
  const metrics = calculateStockMetrics(stock, 1, '2026-01-01');
  assert.equal(metrics.realizedTwd, 15000);
  assert.equal(metrics.remainingCostTwd, 20000);
  assert.equal(metrics.unrealizedTwd, 5000);   // 100 股 × 250 − 20,000
});

test('已實現加未實現等於累計損益', () => {
  const stock = lots([
    { id: 1, date: '2025-01-01', amount: -10000, shares: 100, twd: -10000, kind: 'trade' },
    { id: 2, date: '2025-02-01', amount: -20000, shares: 100, twd: -20000, kind: 'trade' },
    { id: 3, date: '2025-03-01', amount: 25000, shares: -100, twd: 25000, kind: 'trade' },
    { id: 4, date: '2025-04-01', amount: 500, shares: 0, twd: 500, kind: 'dividend' },
  ], 250);
  const metrics = calculateStockMetrics(stock, 1, '2026-01-01');
  assert.equal(metrics.realizedTwd + metrics.unrealizedTwd, metrics.profitTwd);
  assert.equal(metrics.realizedTwd, 15500, '股息整筆算已實現');
});

test('全部出清後未實現歸零', () => {
  const stock = lots([
    { id: 1, date: '2025-01-01', amount: -10000, shares: 100, twd: -10000, kind: 'trade' },
    { id: 2, date: '2025-03-01', amount: 12000, shares: -100, twd: 12000, kind: 'trade' },
  ], 250);
  const metrics = calculateStockMetrics(stock, 1, '2026-01-01');
  assert.equal(metrics.unrealizedTwd, 0);
  assert.equal(metrics.realizedTwd, 2000);
  assert.equal(metrics.realizedTwd, metrics.profitTwd);
});

test('投資期間從首筆交易起算', () => {
  const stock = lots([
    { id: 2, date: '2025-03-01', amount: -100, shares: 1, twd: -100, kind: 'trade' },
    { id: 1, date: '2024-03-01', amount: -100, shares: 1, twd: -100, kind: 'trade' },
  ], 250);
  const metrics = calculateStockMetrics(stock, 1, '2026-03-01');
  assert.equal(metrics.firstTradeDate, '2024-03-01', '不管交易順序，取最早那筆');
  assert.ok(Math.abs(metrics.holdingYears - 2) < 0.01);
});

test('彙總的已實現與未實現逐檔相加', () => {
  const a = lots([{ id: 1, date: '2025-01-01', amount: -10000, shares: 100, twd: -10000, kind: 'trade' }], 150);
  const b = { ...lots([{ id: 2, date: '2025-01-01', amount: -5000, shares: 50, twd: -5000, kind: 'trade' }], 80), key: 'B', market: '美股', currency: 'USD' };
  const result = calculatePortfolio([a, b], 1, '2026-01-01');
  assert.equal(result.all.realizedTwd, result.tw.realizedTwd + result.us.realizedTwd);
  assert.equal(result.all.unrealizedTwd, result.tw.unrealizedTwd + result.us.unrealizedTwd);
  assert.ok(Math.abs(result.all.realizedTwd + result.all.unrealizedTwd - result.all.profitTwd) < 1e-9);
});
