import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPerformanceSeries, transactionFlows } from '../supabase/functions/portfolio-performance/core.js';

test('績效指數排除新增投入，不把入金當成報酬', () => {
  const rows = buildPerformanceSeries({
    market: 'tw',
    snapshots: [
      { date: '2026-09-01', twTwd: 100, usTwd: 0, usUsd: 0 },
      { date: '2026-09-02', twTwd: 160, usTwd: 0, usUsd: 0 },
    ],
    flows: { '2026-09-02': { twTwd: 50 } },
    twBenchmark: [
      { date: '2026-09-01', value: 50 },
      { date: '2026-09-02', value: 52.5 },
    ],
    usBenchmark: [], fxHistory: [],
  });
  assert.equal(rows.at(-1).portfolio, 110);
  assert.equal(rows.at(-1).benchmark, 105);
});

test('全部頁用期初台美股權重組成含匯率的混合大盤', () => {
  const rows = buildPerformanceSeries({
    market: 'all', flows: {},
    snapshots: [
      { date: '2026-09-01', twTwd: 60, usTwd: 40, usUsd: 1 },
      { date: '2026-09-02', twTwd: 66, usTwd: 48, usUsd: 1.1 },
    ],
    twBenchmark: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 110 }],
    usBenchmark: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 110 }],
    fxHistory: [{ date: '2026-09-01', rate: 40 }, { date: '2026-09-02', rate: 43.6363636 }],
  });
  assert.equal(rows.at(-1).benchmark, 114);
});

test('買進是外部投入、賣出與股息是提款', () => {
  const stocks = new Map([
    ['TW', { currency: 'TWD' }],
    ['US', { currency: 'USD' }],
  ]);
  const flows = transactionFlows([
    { stock_key: 'TW', tx_date: '2026-09-01', amount: -100, twd: -100 },
    { stock_key: 'US', tx_date: '2026-09-01', amount: -10, twd: -320 },
    { stock_key: 'US', tx_date: '2026-09-02', amount: 3, twd: 96 },
  ], stocks);
  assert.deepEqual(flows['2026-09-01'], { twTwd: 100, usTwd: 320, usUsd: 10 });
  assert.deepEqual(flows['2026-09-02'], { twTwd: 0, usTwd: -96, usUsd: -3 });
});
