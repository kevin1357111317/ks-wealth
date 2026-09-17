import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildHistoricalSnapshots,
  buildPerformanceSeries,
  downsampleSeries,
  transactionFlows,
  transactionShareScale,
  yahooPriceRows,
} from '../supabase/functions/portfolio-performance/core.js';

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

test('全部頁用前一期台美股權重組成含匯率的混合大盤', () => {
  const rows = buildPerformanceSeries({
    market: 'all', flows: {},
    snapshots: [
      { date: '2026-09-01', twTwd: 60, usTwd: 40, usUsd: 1 },
      { date: '2026-09-02', twTwd: 66, usTwd: 48, usUsd: 1.1 },
      { date: '2026-09-03', twTwd: 72.6, usTwd: 48, usUsd: 1.1 },
    ],
    twBenchmark: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 110 }, { date: '2026-09-03', value: 121 }],
    usBenchmark: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 110 }, { date: '2026-09-03', value: 110 }],
    fxHistory: [{ date: '2026-09-01', rate: 40 }, { date: '2026-09-02', rate: 43.6363636 }, { date: '2026-09-03', rate: 43.6363636 }],
  });
  assert.equal(rows[1].benchmark, 114);
  assert.equal(rows.at(-1).benchmark, 120.6);
});

test('單一美股基準在全部頁包含匯率，在美股頁維持美元報酬', () => {
  const input = {
    flows: {}, benchmarkMode: 'us', twBenchmark: [],
    snapshots: [
      { date: '2026-09-01', twTwd: 60, usTwd: 40, usUsd: 1 },
      { date: '2026-09-02', twTwd: 66, usTwd: 48, usUsd: 1.1 },
    ],
    usBenchmark: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 110 }],
    fxHistory: [{ date: '2026-09-01', rate: 40 }, { date: '2026-09-02', rate: 44 }],
  };
  assert.equal(buildPerformanceSeries({ ...input, market: 'all' }).at(-1).benchmark, 121);
  assert.equal(buildPerformanceSeries({ ...input, market: 'us' }).at(-1).benchmark, 110);
});

test('多年每日資料與多組 Benchmark 能在 Edge Function 預算內完成', () => {
  const snapshots = [];
  const benchmark = [];
  const fxHistory = [];
  const start = Date.UTC(2019, 0, 1);
  for (let index = 0; index < 2800; index += 1) {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    snapshots.push({ date, twTwd: 100 + index / 20, usTwd: 100 + index / 15, usUsd: 4 + index / 10000 });
    benchmark.push({ date, value: 100 + index / 25 });
    fxHistory.push({ date, rate: 30 + index / 100000 });
  }
  const started = performance.now();
  for (let index = 0; index < 24; index += 1) {
    buildPerformanceSeries({
      snapshots, flows: {}, twBenchmark: benchmark, usBenchmark: benchmark, fxHistory,
      market: index % 3 === 0 ? 'tw' : index % 3 === 1 ? 'us' : 'all',
      benchmarkMode: index % 3 === 0 ? 'tw' : index % 3 === 1 ? 'us' : 'mixed',
    });
  }
  assert.ok(performance.now() - started < 1000, '多年資料的績效計算不應退化成逐日全表掃描');
});

test('Yahoo 持股用 close，Benchmark 用含股息的 adjusted close', () => {
  const result = {
    timestamp: [Date.UTC(2026, 0, 2) / 1000, Date.UTC(2026, 0, 5) / 1000],
    indicators: {
      quote: [{ close: [100, 98] }],
      adjclose: [{ adjclose: [95, 95] }],
    },
  };
  assert.deepEqual(yahooPriceRows(result, 'close').map(row => row.value), [100, 98]);
  assert.deepEqual(yahooPriceRows(result, 'adjusted').map(row => row.value), [95, 95]);
});

test('Edge Function 把持股與 Benchmark 接到正確的 Yahoo 價格欄位', () => {
  const source = readFileSync(new URL('../supabase/functions/portfolio-performance/index.ts', import.meta.url), 'utf8');
  assert.match(source, /priceHistory = new Map[\s\S]*?\?\.close \?\? \[\]/);
  assert.match(source, /histories\.get\("0050\.TW"\)\?\.adjusted \?\? \[\]/);
  assert.match(source, /histories\.get\(symbol\)\?\.adjusted \?\? \[\]/);
});

test('績效載入失敗不會永久快取，畫面提供立即重試', () => {
  const source = readFileSync(new URL('../app-v3.js', import.meta.url), 'utf8');
  assert.match(source, /cached\?\.status === 'error'\) portfolioPerformance\.delete/);
  assert.match(source, /data-performance-retry>重新載入/);
  assert.match(source, /performanceRetry\.onclick = async/);
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

test('拆股調整依台帳成交單價判斷，不會把已換算的 NVDA 再乘十倍', () => {
  const tw = { key: '0050', market: '台股', currency: 'TWD' };
  const nvda = { key: 'NVDA', market: '美股', currency: 'USD' };
  assert.equal(transactionShareScale(
    { tx_date: '2025-06-17', amount: -20000, shares: 100 }, tw,
    [{ date: '2025-06-17', value: 50 }],
  ), 4);
  assert.equal(transactionShareScale(
    { tx_date: '2024-05-23', amount: -1000, shares: 10 }, nvda,
    [{ date: '2024-05-23', value: 100 }],
  ), 1);
});

test('交易與拆股後價格可重建每日台美股市值', () => {
  const stocks = [
    { key: '0050', market: '台股', currency: 'TWD' },
    { key: 'VOO', market: '美股', currency: 'USD' },
  ];
  const priceHistory = new Map([
    ['0050', [{ date: '2025-06-17', value: 50 }, { date: '2025-06-18', value: 52 }]],
    ['VOO', [{ date: '2025-06-17', value: 500 }, { date: '2025-06-18', value: 510 }]],
  ]);
  const rows = buildHistoricalSnapshots({
    stocks, priceHistory,
    transactions: [
      { stock_key: '0050', tx_date: '2025-06-17', amount: -20000, shares: 100, kind: 'trade' },
      { stock_key: 'VOO', tx_date: '2025-06-17', amount: -500, shares: 1, kind: 'trade' },
    ],
    fxHistory: [{ date: '2025-06-17', rate: 30 }, { date: '2025-06-18', rate: 31 }],
  });
  assert.deepEqual(rows[0], { date: '2025-06-17', twTwd: 20000, usTwd: 15000, usUsd: 500 });
  assert.deepEqual(rows[1], { date: '2025-06-18', twTwd: 20800, usTwd: 15810, usUsd: 510 });
});

test('長期間只抽樣顯示，不改起點與終點', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ date: String(index), portfolio: 100 + index }));
  const sampled = downsampleSeries(rows, 280);
  assert.equal(sampled.length, 280);
  assert.deepEqual(sampled[0], rows[0]);
  assert.deepEqual(sampled.at(-1), rows.at(-1));
});

test('完整期間會分頁抓完超過一千筆的交易台帳', () => {
  const source = readFileSync(new URL('../supabase/functions/portfolio-performance/index.ts', import.meta.url), 'utf8');
  assert.match(source, /for \(let from = 0; ; from \+= 1000\)/);
  assert.match(source, /\.range\(from, from \+ 999\)/);
  assert.match(source, /if \(\(page\?\.length \?\? 0\) < 1000\) break/);
});
