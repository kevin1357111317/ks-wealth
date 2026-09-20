import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildHistoricalSnapshots,
  buildPerformanceSeries,
  downsampleSeries,
  summarizePerformance,
  transactionFlows,
  transactionShareScale,
  yahooEventRows,
  yahooPriceRows,
} from '../supabase/functions/portfolio-performance/core.js';
import {
  annualizeReturn,
  buildBenchmarkCashflows,
  buildPortfolioCashflows,
} from '../supabase/functions/portfolio-performance/return-math.js';

test('累積 TWR 依實際日數年化，未滿一年不顯示', () => {
  assert.ok(Math.abs(annualizeReturn(0.44, '2024-01-01', '2025-12-31') - 0.2) < 0.00001);
  assert.equal(annualizeReturn(0.2, '2026-01-01', '2026-09-17'), null);
});

test('投資組合與 Benchmark 用同一期間計算年化 TWR 與超額報酬', () => {
  const series = [
    { date: '2025-01-01', portfolio: 100, benchmark: 100 },
    { date: '2026-01-01', portfolio: 121, benchmark: 110 },
  ];
  const snapshots = [
    { date: '2025-01-01', twTwd: 100, usTwd: 0, usUsd: 0 },
    { date: '2026-01-01', twTwd: 121, usTwd: 0, usUsd: 0 },
  ];
  const result = summarizePerformance({ series, snapshots, flows: {}, market: 'tw' });
  assert.equal(result.startDate, '2025-01-01');
  assert.equal(result.endDate, '2026-01-01');
  assert.ok(Math.abs(result.portfolioAnnualizedTwr - 0.21) < 1e-12);
  assert.ok(Math.abs(result.benchmarkAnnualizedTwr - 0.1) < 1e-12);
  assert.ok(Math.abs(result.annualizedExcess - 0.11) < 1e-12);
});

test('Benchmark XIRR 單次投入與同期間年化 TWR 一致', () => {
  const series = [
    { date: '2025-01-01', portfolio: 100, benchmark: 100 },
    { date: '2026-01-01', portfolio: 120, benchmark: 110 },
  ];
  const snapshots = [
    { date: '2025-01-01', twTwd: 100, usTwd: 0, usUsd: 0 },
    { date: '2026-01-01', twTwd: 120, usTwd: 0, usUsd: 0 },
  ];
  const result = summarizePerformance({ series, snapshots, flows: {}, market: 'tw' });
  assert.ok(Math.abs(result.portfolioXirr - 0.2) < 1e-8);
  assert.ok(Math.abs(result.benchmarkXirr - 0.1) < 1e-8);
  assert.ok(Math.abs(result.benchmarkXirr - result.benchmarkAnnualizedTwr) < 1e-8);
  assert.ok(Math.abs(result.xirrGap - 0.1) < 1e-8);
});

test('Benchmark XIRR 套用完全相同的多次資金時點與金額', () => {
  const series = [
    { date: '2025-01-01', portfolio: 100, benchmark: 100 },
    { date: '2025-07-02', portfolio: 150, benchmark: 50 },
    { date: '2026-01-01', portfolio: 300, benchmark: 100 },
  ];
  const snapshots = [
    { date: '2025-01-01', twTwd: 100, usTwd: 0, usUsd: 0 },
    { date: '2025-07-02', twTwd: 150, usTwd: 0, usUsd: 0 },
    { date: '2026-01-01', twTwd: 300, usTwd: 0, usUsd: 0 },
  ];
  const flows = { '2025-07-02': { twTwd: 100, usTwd: 0, usUsd: 0 } };
  const cashflows = buildBenchmarkCashflows({ series, snapshots, flows, market: 'tw' });
  assert.deepEqual(cashflows.datedFlows, [{ date: '2025-07-02', amount: 100 }]);
  assert.deepEqual(cashflows.benchmarkCashflows.map(row => [row.date, row.amount]), [
    ['2025-01-01', -100], ['2025-07-02', -100], ['2026-01-01', 300],
  ]);
  const result = summarizePerformance({ series, snapshots, flows, market: 'tw' });
  // 半年腰斬時加碼、年底回到原點：Benchmark TWR 為 0%，但資金加權結果約 +70%。
  assert.equal(result.benchmarkAnnualizedTwr, 0);
  assert.ok(result.benchmarkXirr > 0.69 && result.benchmarkXirr < 0.71);
});

test('Benchmark 行情缺漏時，自己的 XIRR 照算，只有 Benchmark 那欄是空的', () => {
  // 0050／VOO 的歷史行情有缺口時，benchmark 會整段算不出來。以前 portfolio 的 XIRR 是從
  // buildBenchmarkCashflows 順便拿的，所以連自己的報酬都跟著變 null；那是 benchmark 的問題，
  // 不該讓自己賺多少也消失。
  const series = [
    { date: '2025-01-01', portfolio: 100, benchmark: null, benchmarkRaw: null },
    { date: '2026-01-01', portfolio: 120, benchmark: null, benchmarkRaw: null },
  ];
  const snapshots = [
    { date: '2025-01-01', twTwd: 100, usTwd: 0, usUsd: 0 },
    { date: '2026-01-01', twTwd: 240, usTwd: 0, usUsd: 0 },
  ];
  const flows = { '2025-07-02': { twTwd: 100, usTwd: 0, usUsd: 0 } };

  assert.equal(buildBenchmarkCashflows({ series, snapshots, flows, market: 'tw' }), null);

  const own = buildPortfolioCashflows({ series, snapshots, flows, market: 'tw' });
  assert.deepEqual(own.cashflows.map(row => [row.date, row.amount]), [
    ['2025-01-01', -100], ['2025-07-02', -100], ['2026-01-01', 240],
  ]);

  const result = summarizePerformance({ series, snapshots, flows, market: 'tw' });
  assert.ok(Number.isFinite(result.portfolioXirr), '自己的 XIRR 不該因為 benchmark 缺漏而消失');
  // 期初 100、半年後加碼 100、年底 240：資金加權約 +27.2%。
  assert.ok(Math.abs(result.portfolioXirr - 0.271860) < 1e-5, `XIRR 是 ${result.portfolioXirr}`);
  assert.equal(result.benchmarkXirr, null);
  assert.equal(result.xirrGap, null);
  assert.equal(result.externalCashflowCount, 1, '入金筆數也不該被 benchmark 綁住');
  // TWR 本來就不經過 benchmark，順手確認沒被改壞。
  assert.ok(Math.abs(result.portfolioCumulativeTwr - 0.2) < 1e-12);
});

test('台股、美股與全部 scope 都能產生期間 TWR 與 XIRR 指標', () => {
  const series = [
    { date: '2025-01-01', portfolio: 100, benchmark: 100 },
    { date: '2026-01-01', portfolio: 110, benchmark: 105 },
  ];
  const snapshots = [
    { date: '2025-01-01', twTwd: 100, usTwd: 120, usUsd: 4 },
    { date: '2026-01-01', twTwd: 110, usTwd: 132, usUsd: 4.4 },
  ];
  for (const market of ['tw', 'us', 'all']) {
    const result = summarizePerformance({ series, snapshots, flows: {}, market });
    assert.ok(Math.abs(result.portfolioAnnualizedTwr - 0.1) < 1e-12, market);
    assert.ok(Math.abs(result.portfolioXirr - 0.1) < 1e-8, market);
    assert.ok(Math.abs(result.benchmarkXirr - 0.05) < 1e-8, market);
  }
});

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

test('真實的大幅單日報酬不會被固定上下限靜默略過', () => {
  const rows = buildPerformanceSeries({
    market: 'tw', flows: {},
    snapshots: [
      { date: '2026-01-01', twTwd: 100, usTwd: 0, usUsd: 0 },
      { date: '2026-01-02', twTwd: 350, usTwd: 0, usUsd: 0 },
    ],
    twBenchmark: [{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 100 }],
    usBenchmark: [], fxHistory: [],
  });
  assert.equal(rows.at(-1).portfolio, 350);
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

test('持股股息只由私帳現金流計入一次，不會再套 adjusted close', () => {
  const flows = transactionFlows([
    { stock_key: 'TW', tx_date: '2026-06-02', amount: 5, twd: 5, kind: 'dividend' },
  ], new Map([['TW', { currency: 'TWD' }]]));
  const rows = buildPerformanceSeries({
    market: 'tw', flows,
    snapshots: [
      { date: '2026-06-01', twTwd: 100, usTwd: 0, usUsd: 0 },
      { date: '2026-06-02', twTwd: 95, usTwd: 0, usUsd: 0 },
    ],
    twBenchmark: [{ date: '2026-06-01', value: 95 }, { date: '2026-06-02', value: 95 }],
    usBenchmark: [], fxHistory: [],
  });
  assert.equal(rows.at(-1).portfolio, 100);
  assert.equal(rows.at(-1).benchmark, 100);
});

test('拆股調整依私帳成交單價判斷，不會把已換算的 NVDA 再乘十倍', () => {
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

test('現金減資可用小於一的股數倍率重建，不再製造長榮單日假尖峰', () => {
  const evergreen = { key: '長榮', market: '台股', currency: 'TWD' };
  const scale = transactionShareScale(
    { tx_date: '2021-11-08', amount: -488917, shares: 4000 }, evergreen,
    [{ date: '2021-11-08', value: 310 }],
  );
  assert.equal(scale, 0.4);
  const rows = buildHistoricalSnapshots({
    stocks: [evergreen],
    transactions: [{ stock_key: '長榮', tx_date: '2021-11-08', amount: -488917, shares: 4000, kind: 'trade' }],
    priceHistory: new Map([['長榮', [{ date: '2021-11-08', value: 310 }]]]),
    fxHistory: [],
  });
  assert.equal(rows[0].twTwd, 496000);
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
  // flow 是當日買賣以「當日收盤價」計價的外部金流，跟同一列的市值同一把尺。
  assert.deepEqual(rows[0], {
    date: '2025-06-17', twTwd: 20000, usTwd: 15000, usUsd: 500,
    flow: { twTwd: 20000, usTwd: 15000, usUsd: 500 },
  });
  assert.deepEqual(rows[1], {
    date: '2025-06-18', twTwd: 20800, usTwd: 15810, usUsd: 510,
    flow: { twTwd: 0, usTwd: 0, usUsd: 0 },
  });
});

// 2020-07-22 把 0050 只剩一萬出頭的部位拿去買一張台積電：成交 381,336、當日收盤 384,000，
// 兩者差 2,664 除以前一日市值 10,956 就成了 +24.57% 的假單日報酬。同一個機制在 2020-08-18
// 與 2020-11-17 反向做出 -32.66% 與 -26.02%，全期累積 TWR 因此少了兩百多個百分點。
test('部位很小時加碼，成交價與收盤價的價差不會被當成單日報酬', () => {
  const stocks = [
    { key: '0050', market: '台股', currency: 'TWD' },
    { key: '台積電', market: '台股', currency: 'TWD' },
  ];
  const priceHistory = new Map([
    ['0050', [{ date: '2020-07-21', value: 100 }, { date: '2020-07-22', value: 101 }]],
    ['台積電', [{ date: '2020-07-21', value: 395 }, { date: '2020-07-22', value: 400 }]],
  ]);
  const transactions = [
    { stock_key: '0050', tx_date: '2020-07-21', amount: -10000, shares: 100, kind: 'trade' },
    { stock_key: '台積電', tx_date: '2020-07-22', amount: -390000, shares: 1000, kind: 'trade' },
  ];
  const snapshots = buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory: [] });
  assert.equal(snapshots[1].twTwd, 410100);
  assert.equal(snapshots[1].flow.twTwd, 400000, '金流要用當日收盤價，不是成交金額');
  const rows = buildPerformanceSeries({
    market: 'tw', benchmarkMode: 'tw', snapshots,
    flows: transactionFlows(transactions.map(row => ({ ...row, twd: row.amount })),
      new Map(stocks.map(stock => [stock.key, stock]))),
    twBenchmark: [{ date: '2020-07-21', value: 50 }, { date: '2020-07-22', value: 50 }],
    usBenchmark: [], fxHistory: [],
  });
  // 當天真正的報酬只有既有部位的 0050 +1%；用成交金額扣會變成 +101%。
  assert.equal(rows.at(-1).portfolio, 101);
});

// 私帳的股息記入帳日，價格卻是在除息日掉的。算在入帳日等於除息日先跌一次、入帳日再漲一次，
// 期間內大致抵銷，但除息與入帳落在不同期間時就會少算或多算。
test('股息對齊除息日，不會在除息日先跌一次、入帳日再漲一次', () => {
  const stocks = [{ key: '0050', market: '台股', currency: 'TWD' }];
  const priceHistory = new Map([['0050', [
    { date: '2020-01-30', value: 100 },
    { date: '2020-01-31', value: 95 },
    { date: '2020-03-26', value: 95 },
  ]]]);
  const transactions = [
    { stock_key: '0050', tx_date: '2020-01-30', amount: -100000, shares: 1000, kind: 'trade' },
    { stock_key: '0050', tx_date: '2020-03-26', amount: 5000, shares: 0, kind: 'dividend' },
  ];
  const dividendEvents = new Map([['0050', [{ date: '2020-01-31', ratio: 5 }]]]);
  const snapshots = buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory: [], dividendEvents });
  assert.equal(snapshots[1].date, '2020-01-31');
  assert.equal(snapshots[1].flow.twTwd, -5000, '股息要落在除息日');
  assert.equal(snapshots[2].flow.twTwd, 0, '入帳日不該再算一次');
  const rows = buildPerformanceSeries({
    market: 'tw', benchmarkMode: 'tw', snapshots, flows: {},
    twBenchmark: [], usBenchmark: [], fxHistory: [],
  });
  // 除息只是把錢從股價換成現金，TWR 在除息當天就不該掉。
  assert.equal(rows[1].portfolio, 100);
  assert.equal(rows.at(-1).portfolio, 100);
});

test('抓不到價格的日子不產生快照，當天的金流要留到下一天而不是消失', () => {
  const stocks = [
    { key: 'A', market: '台股', currency: 'TWD' },
    { key: 'B', market: '台股', currency: 'TWD' },
  ];
  // B 到 01-05 才有第一筆報價，但 01-02 就買了：那天整天不完整，不會產生快照。
  const priceHistory = new Map([
    ['A', [{ date: '2026-01-01', value: 10 }, { date: '2026-01-02', value: 10 }, { date: '2026-01-05', value: 10 }]],
    ['B', [{ date: '2026-01-05', value: 50 }]],
  ]);
  const transactions = [
    { stock_key: 'A', tx_date: '2026-01-01', amount: -1000, shares: 100, kind: 'trade' },
    { stock_key: 'B', tx_date: '2026-01-02', amount: -5000, shares: 100, kind: 'trade' },
  ];
  const snapshots = buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory: [] });
  assert.deepEqual(snapshots.map(row => row.date), ['2026-01-01', '2026-01-05'], '01-02 不完整不產生快照');
  assert.equal(snapshots[1].flow.twTwd, 5000, '買進 B 的金流要補在它第一次有市值的那天');
  const rows = buildPerformanceSeries({
    market: 'tw', benchmarkMode: 'tw', snapshots, flows: {},
    twBenchmark: [{ date: '2026-01-01', value: 1 }, { date: '2026-01-05', value: 1 }],
    usBenchmark: [], fxHistory: [],
  });
  assert.equal(rows.at(-1).portfolio, 100, '沒有漲跌，只是加碼，TWR 不該動');
});

test('不完整那幾天裡的買賣，金流要一路累到下一個有快照的日子', () => {
  const stocks = [
    { key: 'A', market: '台股', currency: 'TWD' },
    { key: 'B', market: '台股', currency: 'TWD' },
  ];
  const priceHistory = new Map([
    ['A', ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-06'].map(date => ({ date, value: 10 }))],
    ['B', [{ date: '2026-01-06', value: 50 }]],
  ]);
  const transactions = [
    { stock_key: 'A', tx_date: '2026-01-01', amount: -1000, shares: 100, kind: 'trade' },
    { stock_key: 'B', tx_date: '2026-01-02', amount: -5000, shares: 100, kind: 'trade' },
    // 01-03 賣掉一半 A：當天 A 有價格，但 B 還沒有，整天不會產生快照。
    { stock_key: 'A', tx_date: '2026-01-03', amount: 500, shares: -50, kind: 'trade' },
  ];
  const snapshots = buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory: [] });
  assert.deepEqual(snapshots.map(row => row.date), ['2026-01-01', '2026-01-06']);
  // B 買進 +5000、A 賣出 -500，兩筆都要出現在 01-06。
  assert.equal(snapshots[1].flow.twTwd, 4500);
  const rows = buildPerformanceSeries({
    market: 'tw', benchmarkMode: 'tw', snapshots, flows: {},
    twBenchmark: [{ date: '2026-01-01', value: 1 }, { date: '2026-01-06', value: 1 }],
    usBenchmark: [], fxHistory: [],
  });
  assert.equal(rows.at(-1).portfolio, 100, '價格都沒動，只有進出，TWR 不該動');
});

test('這個 market 當天沒有市值時，金流留到下一個有市值的日子', () => {
  const rows = buildPerformanceSeries({
    market: 'us', benchmarkMode: 'us', flows: {},
    snapshots: [
      { date: '2026-01-01', twTwd: 0, usTwd: 0, usUsd: 100, flow: { twTwd: 0, usTwd: 0, usUsd: 0 } },
      { date: '2026-01-02', twTwd: 0, usTwd: 0, usUsd: 0, flow: { twTwd: 0, usTwd: 0, usUsd: -110 } },
      { date: '2026-01-05', twTwd: 0, usTwd: 0, usUsd: 50, flow: { twTwd: 0, usTwd: 0, usUsd: 50 } },
    ],
    twBenchmark: [], usBenchmark: [], fxHistory: [],
  });
  // 賣光拿回 110（+10%）再買回 50。舊寫法會把賣出那天整筆丟掉，變成 -100%。
  assert.equal(rows.at(-1).portfolio, 110);
});

test('有 Yahoo 拆股事件時，股數倍率只在 1 與該倍率之間二選一', () => {
  const nvda = { key: 'NVDA', market: '美股', currency: 'USD' };
  const prices = [{ date: '2024-05-23', value: 103.5 }];
  const splits = [{ date: '2024-06-10', ratio: 10 }];
  // 私帳已換算成拆股後股數
  assert.equal(transactionShareScale({ tx_date: '2024-05-23', amount: -1035, shares: 10 }, nvda, prices, splits), 1);
  // 私帳是成交當時股數
  assert.equal(transactionShareScale({ tx_date: '2024-05-23', amount: -1035, shares: 1 }, nvda, prices, splits), 10);
  // 成交單價剛好是收盤價三倍。有拆股事件時 3 根本不是候選；沒有事件時美股也不該去猜 ——
  // Yahoo 對美股的拆股回報是可靠的，沒回報就是真的沒拆過，單價對不上只是手續費或拆單。
  assert.equal(transactionShareScale({ tx_date: '2024-05-23', amount: -310.5, shares: 1 }, nvda, prices), 1);
  assert.equal(transactionShareScale({ tx_date: '2024-05-23', amount: -310.5, shares: 1 }, nvda, prices, splits), 1);
  // 成交日之後沒有拆股，倍率就確定是 1，不能退回去猜（TSLA 2025-11-13 曾被猜成 0.5）
  assert.equal(transactionShareScale({ tx_date: '2024-06-20', amount: -200.4, shares: 1 },
    { key: 'TSLA', market: '美股', currency: 'USD' },
    [{ date: '2024-06-20', value: 401.99 }], [{ date: '2022-08-25', ratio: 3 }]), 1);
});

test('Yahoo events 解析成除息日與拆股倍率', () => {
  const result = {
    events: {
      dividends: { a: { amount: 2.5, date: Date.UTC(2020, 8, 17) / 1000 } },
      splits: { b: { numerator: 10, denominator: 1, date: Date.UTC(2024, 5, 10) / 1000 } },
    },
  };
  assert.deepEqual(yahooEventRows(result, 'dividends'), [{ date: '2020-09-17', ratio: 2.5 }]);
  assert.deepEqual(yahooEventRows(result, 'splits'), [{ date: '2024-06-10', ratio: 10 }]);
  assert.deepEqual(yahooEventRows({}, 'splits'), []);
});

test('抽樣保留單日極值，不會把 +10% 那根整根跳過', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ date: String(index), portfolio: 100 + index * 0.01 }));
  for (let index = 500; index < rows.length; index += 1) rows[index].portfolio = rows[499].portfolio * 1.1;
  const sampled = downsampleSeries(rows, 280);
  assert.ok(sampled.some(row => row.date === '500'), '極值那天要留著');
  assert.ok(sampled.some(row => row.date === '499'), '前一天也要留著，圖上才看得出那一根');
  assert.ok(sampled.length <= 280 + 24, '補回來的點數要有上限');
});

test('期間基準點取起算日當天或之前最後一個交易日的收盤', () => {
  const source = readFileSync(new URL('../supabase/functions/portfolio-performance/index.ts', import.meta.url), 'utf8');
  assert.match(source, /rows\[from\]\.date === start \? rows\.slice\(from\) : rows\.slice\(Math\.max\(0, from - 1\)\)/);
  assert.match(source, /const periodSnapshots = fromPeriodStart\(snapshots, start\)/);
  assert.match(source, /splits: yahooEventRows\(result, "splits"\)/);
  assert.match(source, /dividends: yahooEventRows\(result, "dividends"\)/);
  assert.match(source, /buildHistoricalSnapshots\(\{ stocks, transactions, priceHistory, fxHistory, splitEvents, dividendEvents \}\)/);
});

test('長期間只抽樣顯示，不改起點與終點', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ date: String(index), portfolio: 100 + index }));
  const sampled = downsampleSeries(rows, 280);
  assert.equal(sampled.length, 280);
  assert.deepEqual(sampled[0], rows[0]);
  assert.deepEqual(sampled.at(-1), rows.at(-1));
});

test('完整期間會分頁抓完超過一千筆的交易私帳', () => {
  const source = readFileSync(new URL('../supabase/functions/portfolio-performance/index.ts', import.meta.url), 'utf8');
  assert.match(source, /for \(let from = 0; ; from \+= 1000\)/);
  assert.match(source, /\.range\(from, from \+ 999\)/);
  assert.match(source, /if \(\(page\?\.length \?\? 0\) < 1000\) break/);
  assert.match(source, /for \(const period of \["ytd", "year", "all"\]\)/);
  assert.match(source, /metrics: \{[\s\S]*?all:[\s\S]*?tw:[\s\S]*?us:/);
});

test('台灣 ETF 的分割查表，不靠成交單價反推', () => {
  // Yahoo 的 chart API 不回報台灣 ETF 的受益權單位分割：0050 的 2019 收盤被調整成 1/4，
  // events 裡卻沒有 splits 欄位。日期查投信公告寫死，才不會被一筆壞資料帶走。
  const tw = { key: '0050', symbol: '0050', market: '台股', currency: 'TWD' };
  const prices = [{ date: '2025-06-17', value: 47.16 }, { date: '2026-09-15', value: 106.25 }];
  // 分割前成交（188.65 元／股，Yahoo 調整後 47.16）→私帳是成交當時股數，要乘 4
  assert.equal(transactionShareScale({ tx_date: '2025-06-17', amount: -188650, shares: 1000 }, tw, prices), 4);
  // 分割後成交 → 已經是新單位，倍率 1
  assert.equal(transactionShareScale({ tx_date: '2026-09-15', amount: -106490, shares: 1000 }, tw, prices), 1);
});

test('同一段期間的股數倍率只決定一次，一筆壞資料不會改掉整檔持股', () => {
  // 0050 私帳 2023-01-30 那筆金額只記了一半，單價比值算出來剛好是 2。逐筆各自判斷會讓
  // 這一筆自己跑出一個不存在的倍率，整檔就少 120 股；同一段期間多數決就不會。
  const tw = { key: '0050', symbol: '0050', market: '台股', currency: 'TWD' };
  const priceHistory = new Map([['0050', [{ date: '2023-01-30', value: 30.175 }]]]);
  const fxHistory = [{ date: '2023-01-30', rate: 30 }];
  const good = { stock_key: '0050', tx_date: '2023-01-30', kind: 'trade', amount: -120700, shares: 1000 };
  const bad = { stock_key: '0050', tx_date: '2023-01-30', kind: 'trade', amount: -3620, shares: 60 };
  const rows = buildHistoricalSnapshots({
    stocks: [tw], transactions: [good, good, good, bad], priceHistory, fxHistory,
  });
  // 四筆都該用多數決的 4 倍：(1000×3 + 60) × 4 = 12,240 股
  assert.equal(Math.round(rows.at(-1).twTwd / 30.175), 12240);
});
