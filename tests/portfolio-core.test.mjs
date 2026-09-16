import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePortfolio, calculateStockMetrics, currentShares, decodePortfolioBootstrap, sortPortfolioPositions, xirr } from '../portfolio-core.js';

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


test('美股把股票本身損益與匯率影響拆開且仍能對帳', () => {
  const stock = {
    key: 'US', display: 'US', market: '美股', currency: 'USD', symbol: 'NASDAQ:US',
    manualPrice: null, quote: { price: 105 }, transactions: [
      { id: 1, date: '2025-01-01', amount: -100, shares: 1, twd: -3200, kind: 'trade' },
      { id: 2, date: '2026-01-01', amount: 105, shares: -1, twd: 3150, kind: 'trade' },
    ],
  };
  const metrics = calculateStockMetrics(stock, 30, '2026-01-01');
  assert.equal(metrics.profitNative, 5);
  assert.equal(metrics.realizedNative, 5);
  assert.equal(metrics.unrealizedNative, 0);
  assert.ok(Math.abs(metrics.nativeReturnRate - 0.05) < 1e-9);
  assert.equal(metrics.stockProfitTwd, 150);
  assert.equal(metrics.profitTwd, -50);
  assert.equal(metrics.fxImpactTwd, -200);
  assert.equal(metrics.stockProfitTwd + metrics.fxImpactTwd, metrics.profitTwd);
  assert.ok(Math.abs(metrics.nativeXirr - 0.05) < 1e-6);
});

test('美股帳戶彙總延續股票損益與匯率影響的不變式', () => {
  const makeUsStock = (key, buyUsd, buyTwd, sellUsd, sellTwd) => ({
    key, display: key, market: '美股', currency: 'USD', symbol: `NASDAQ:${key}`,
    manualPrice: null, quote: { price: sellUsd }, transactions: [
      { id: 1, date: '2025-01-01', amount: -buyUsd, shares: 1, twd: -buyTwd, kind: 'trade' },
      { id: 2, date: '2026-01-01', amount: sellUsd, shares: -1, twd: sellTwd, kind: 'trade' },
    ],
  });
  const result = calculatePortfolio([
    makeUsStock('AVGO', 100, 3200, 105, 3150),
    makeUsStock('VOO', 200, 6400, 220, 6600),
  ], 30, '2026-01-01');
  assert.equal(result.us.nativeCurrency, 'USD');
  assert.equal(result.us.profitNative, 25);
  assert.ok(Math.abs(result.us.nativeReturnRate - (25 / 300)) < 1e-9);
  assert.equal(result.us.stockProfitTwd, 750);
  assert.equal(result.us.profitTwd, 150);
  assert.equal(result.us.fxImpactTwd, -600);
  assert.equal(result.us.stockProfitTwd + result.us.fxImpactTwd, result.us.profitTwd);
});


test('分析依結算幣別分組，AMSC 類 TWD 美股歸到台股頁', () => {
  const usd = {
    key: 'VOO', display: 'VOO', market: '美股', currency: 'USD', quote: { price: 120 },
    transactions: [{ id: 1, date: '2025-01-01', amount: -100, shares: 1, twd: -3200, kind: 'trade' }],
  };
  const legacyTwd = {
    key: 'AMSC', display: 'AMSC', market: '美股', currency: 'TWD', quote: { price: 0 },
    transactions: [
      { id: 2, date: '2024-01-01', amount: -3000, shares: 1, twd: -3000, kind: 'trade' },
      { id: 3, date: '2024-02-01', amount: 3100, shares: -1, twd: 3100, kind: 'trade' },
    ],
  };
  const result = calculatePortfolio([usd, legacyTwd], 32, '2026-01-01');
  assert.equal(result.us.nativeCurrency, 'USD');
  assert.equal(result.tw.nativeCurrency, 'TWD');
  assert.equal(result.tw.netInvestedNative, -100);
  assert.equal(result.tw.profitNative, 100);
  assert.equal(result.us.netInvestedNative, 100);
  assert.equal(result.us.profitNative, 20);
  assert.ok(Number.isFinite(result.us.nativeXirr));
});

test('股票可依市值、損益與年化排序，空值永遠排最後', () => {
  const rows = [
    { display: 'A', currentValueTwd: 100, profitNative: 5, nativeReturnRate: 0.05, nativeXirr: 0.1 },
    { display: 'B', currentValueTwd: 300, profitNative: 20, nativeReturnRate: 0.2, nativeXirr: null },
    { display: 'C', currentValueTwd: 200, profitNative: -5, nativeReturnRate: -0.05, nativeXirr: 0.3 },
  ];
  assert.deepEqual(sortPortfolioPositions(rows, { criterion: 'marketValue', direction: 'desc' }).map(x => x.display), ['B', 'C', 'A']);
  assert.deepEqual(sortPortfolioPositions(rows, { criterion: 'profit', direction: 'asc', currency: 'USD' }).map(x => x.display), ['C', 'A', 'B']);
  assert.deepEqual(sortPortfolioPositions(rows, { criterion: 'xirr', direction: 'desc', currency: 'USD' }).map(x => x.display), ['C', 'A', 'B']);
});
