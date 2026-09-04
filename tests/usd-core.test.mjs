// 美金的成本用移動加權平均，跟股票那邊的 FIFO 不一樣。基準是 KLFAN 試算表
// 「美金」工作表自己算出來的那塊績效表：同樣 107 筆交易，算出來要對得上。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { calculateUsd, usdRunningRows } from '../usd-core.js';

const ledger = JSON.parse(readFileSync(new URL('./fixtures/usd-ledger.json', import.meta.url), 'utf8'))
  .map((row, index) => ({ ...row, id: index + 1 }));

test('買進累加成本並重算平均', () => {
  const rows = usdRunningRows([
    { trade_date: '2024-01-01', usd_amount: 1000, rate: 30, twd_amount: -30_000 },
    { trade_date: '2024-02-01', usd_amount: 1000, rate: 32, twd_amount: -32_000 },
  ]);
  assert.equal(rows[1].balance, 2000);
  assert.equal(rows[1].cost, 62_000);
  assert.equal(rows[1].average, 31);
  assert.equal(rows[1].realized, 0);
});

test('賣出用當下的平均成本認列已實現，平均成本本身不動', () => {
  const rows = usdRunningRows([
    { trade_date: '2024-01-01', usd_amount: 1000, rate: 30, twd_amount: -30_000 },
    { trade_date: '2024-02-01', usd_amount: 1000, rate: 32, twd_amount: -32_000 },
    { trade_date: '2024-03-01', usd_amount: -500, rate: 33, twd_amount: 16_500 },
  ]);
  // 賣 500 美元，成本 31×500=15,500，收到 16,500
  assert.equal(rows[2].realized, 1000);
  assert.equal(rows[2].balance, 1500);
  assert.equal(rows[2].cost, 46_500);
  assert.equal(rows[2].average, 31);
});

test('出清後餘額與成本歸零，未實現不再計算', () => {
  const model = calculateUsd([
    { trade_date: '2024-01-01', usd_amount: 1000, rate: 30, twd_amount: -30_000 },
    { trade_date: '2024-03-01', usd_amount: -1000, rate: 33, twd_amount: 33_000 },
  ], 31, '2024-06-01');
  assert.equal(model.balance, 0);
  assert.equal(model.remainingCostTwd, 0);
  assert.equal(model.averageCost, null);
  assert.equal(model.realizedTwd, 3000);
  assert.equal(model.unrealizedTwd, 0);
  assert.equal(model.totalProfitTwd, 3000);
});

test('沒有匯率就只有成本面的數字，市值與未實現是零', () => {
  const model = calculateUsd([
    { trade_date: '2024-01-01', usd_amount: 1000, rate: 30, twd_amount: -30_000 },
  ], null, '2024-06-01');
  assert.equal(model.marketValueTwd, 0);
  assert.equal(model.unrealizedTwd, 0);
  assert.equal(model.netInvestedTwd, 30_000);
});

test('沒填 rate 時從美元與台幣推回成交匯率', () => {
  const [row] = usdRunningRows([{ trade_date: '2024-01-01', usd_amount: 2000, twd_amount: -64_000 }]);
  assert.equal(row.rate, 32);
});

test('順序不對的資料先照日期排好再算', () => {
  const rows = usdRunningRows([
    { id: 2, trade_date: '2024-02-01', usd_amount: -500, rate: 33, twd_amount: 16_500 },
    { id: 1, trade_date: '2024-01-01', usd_amount: 1000, rate: 30, twd_amount: -30_000 },
  ]);
  assert.deepEqual(rows.map(row => row.date), ['2024-01-01', '2024-02-01']);
  assert.equal(rows[1].realized, 1500);
});

test('107 筆實際交易算出來對得上試算表的績效表', () => {
  // 試算表顯示的匯率是四捨五入到小數三位的 31.625；市值 14,904,731 反推回去
  // 是 31.62530，用它才比得了那兩個跟市值連動的數字。
  const model = calculateUsd(ledger, 14_904_731 / 471_291.38, '2026-09-04');
  const near = (actual, expected, tolerance, label) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}：算出來 ${actual}，試算表 ${expected}`);

  assert.equal(model.transactions, 107);
  assert.equal(model.firstTradeDate, '2024-05-23');
  near(model.balance, 471_291.38, 0.005, '目前美元部位');
  near(model.remainingCostTwd, 14_982_086, 1, '剩餘美元成本');
  near(model.averageCost, 31.789, 0.0005, '加權平均成本');
  near(model.marketValueTwd, 14_904_731, 1, '目前台幣市值');
  near(model.netInvestedTwd, 14_979_153, 1, '累計淨投入');
  near(model.realizedTwd, 2_933, 1, '已實現匯兌損益');
  near(model.unrealizedTwd, -77_355, 1, '未實現匯兌損益');
  near(model.totalProfitTwd, -74_422, 1, '總匯兌損益');
  near(model.xirr, -0.0052, 0.00005, 'XIRR');
});

test('剩餘成本減去已實現就是累計淨投入', () => {
  // 試算表這兩欄是分開算的，兩邊要能互相對得起來才代表沒有算錯。
  const model = calculateUsd(ledger, 31.625, '2026-09-04');
  assert.ok(Math.abs((model.remainingCostTwd - model.realizedTwd) - model.netInvestedTwd) < 0.01);
});
