// 這支測試守的是「加速沒有改到數字」。
//
// xirr() 被改寫過一次：日期解析從 npv() 裡搬出來先算好，二分法夾到相鄰浮點數就跳出。
// 兩件事都聲稱「結果完全一樣」，那就得證明它一樣 —— 而且是位元級一樣，不是「差不多」。
// 年化報酬率會印在畫面上、也會拿去跟 KLFAN 試算表核對，差一點點就是對不上。
//
// 下面 REFERENCE_XIRR 是改寫前那一版原封不動的抄本。它是這支測試的「拿掉修正就會紅」：
// 把 portfolio-core.js 的 xirr 換成任何算法上不等價的版本，這裡就會紅。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateStockMetrics,
  calculateStockValue,
  xirr,
} from '../portfolio-core.js';

function REFERENCE_XIRR(cashflows) {
  const flows = (cashflows ?? []).filter(flow => flow.date && Number.isFinite(Number(flow.amount)))
    .map(flow => ({ date: String(flow.date), amount: Number(flow.amount) }));
  if (!flows.some(flow => flow.amount > 0) || !flows.some(flow => flow.amount < 0)) return null;
  const base = flows.reduce((earliest, flow) => flow.date < earliest ? flow.date : earliest, flows[0].date);
  const baseMs = Date.parse(`${base}T00:00:00Z`);
  const npv = rate => flows.reduce((sum, flow) => {
    const years = (Date.parse(`${flow.date}T00:00:00Z`) - baseMs) / 86_400_000 / 365;
    return sum + flow.amount / ((1 + rate) ** years);
  }, 0);
  const rates = [-0.9999, -0.999, -0.995, -0.99, -0.98, -0.95, -0.9, -0.85, -0.8,
    -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1];
  for (let rate = -0.05; rate <= 1000; rate = rate < 1 ? rate + 0.01 : (rate < 10 ? rate + 0.1 : rate * 1.15)) {
    rates.push(Math.round(rate * 1e6) / 1e6);
  }
  rates.push(1000);
  let previousRate = null;
  let previousValue = null;
  for (const rate of rates) {
    const value = npv(rate);
    if (!Number.isFinite(value)) {
      previousRate = previousValue = null;
      continue;
    }
    if (Math.abs(value) < 1e-9) return rate;
    if (previousValue !== null && (previousValue < 0) !== (value < 0)) {
      let low = previousRate;
      let lowValue = previousValue;
      let high = rate;
      for (let i = 0; i < 200; i += 1) {
        const middle = (low + high) / 2;
        const middleValue = npv(middle);
        if (Math.abs(middleValue) < 1e-9) return middle;
        if ((lowValue < 0) === (middleValue < 0)) {
          low = middle;
          lowValue = middleValue;
        } else high = middle;
      }
      return (low + high) / 2;
    }
    previousRate = rate;
    previousValue = value;
  }
  return null;
}

// 固定種子的亂數：每次跑都是同一批現金流，紅了才好重現。
function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

test('改寫後的 xirr 跟改寫前逐位元相同', () => {
  const random = makeRandom(20260909);
  let compared = 0;
  for (let trial = 0; trial < 3000; trial += 1) {
    const count = 1 + Math.floor(random() * 40);
    const start = Date.UTC(2005 + Math.floor(random() * 20), Math.floor(random() * 12), 1 + Math.floor(random() * 27));
    const flows = [];
    for (let i = 0; i < count; i += 1) {
      flows.push({
        date: isoDate(start + Math.floor(random() * 8000) * 86_400_000),
        amount: (random() - 0.45) * 10 ** (1 + Math.floor(random() * 7)),
      });
    }
    // 也要餵一些壞掉的列進去：真的資料裡就有沒填日期、金額是 0 的
    if (trial % 17 === 0) flows.push({ date: '', amount: Number.NaN });
    if (trial % 23 === 0) flows.push({ date: isoDate(start), amount: 0 });
    assert.ok(Object.is(xirr(flows), REFERENCE_XIRR(flows)),
      `第 ${trial} 組不一致：${xirr(flows)} vs ${REFERENCE_XIRR(flows)}`);
    compared += 1;
  }
  assert.equal(compared, 3000);
});

test('邊界輸入也跟改寫前一樣', () => {
  const edges = [
    null,
    undefined,
    [],
    [{ date: '2020-01-01', amount: 5 }],                                        // 只有流入，無解
    [{ date: '2020-01-01', amount: -5 }],                                       // 只有流出，無解
    [{ date: '2020-01-01', amount: -100 }, { date: '2020-01-01', amount: 100 }], // 同一天進出
    [{ date: '2020-01-01', amount: -100 }, { date: '2030-01-01', amount: 0.0000001 }], // 幾乎全賠
    [{ date: '2020-01-01', amount: -100 }, { date: '2020-01-02', amount: 1e9 }], // 一天翻千萬倍
    [{ date: '2024-02-29', amount: -1000 }, { date: '2025-02-28', amount: 1100 }], // 閏日
  ];
  for (const edge of edges) {
    assert.ok(Object.is(xirr(edge), REFERENCE_XIRR(edge)), `${JSON.stringify(edge)} 不一致`);
  }
});

// 真的會跑到二分法、而且答案不是零的一組：確認上面比對的不是一堆 null。
test('比對的樣本裡確實有算得出年化的', () => {
  const flows = [
    { date: '2022-01-04', amount: -300_000 },
    { date: '2023-03-15', amount: -120_000 },
    { date: '2024-07-01', amount: 45_000 },
    { date: '2026-09-09', amount: 520_000 },
  ];
  const rate = xirr(flows);
  assert.ok(Number.isFinite(rate) && rate > 0.05 && rate < 0.5, `年化算成 ${rate}`);
  assert.ok(Object.is(rate, REFERENCE_XIRR(flows)));
});

// calculateStockValue 是從 calculateStockMetrics 裡切出來的「不跑 XIRR 的那半」，
// 給編輯表單與台帳同步用。切歪了 —— 例如美股忘了乘匯率 —— 資產列的市值就會錯。
test('calculateStockValue 的股數與市值跟完整版一致', () => {
  const stocks = [
    {
      key: 'TPE:2330', display: '台積電', market: '台股', currency: 'TWD', symbol: '2330',
      manualPrice: 1000, ownerScope: 'husband', quote: { price: 2390 },
      transactions: [
        { id: 1, date: '2023-01-05', shares: 1000, twd: -520_000, kind: 'trade' },
        { id: 2, date: '2024-06-20', shares: -300, twd: 270_000, kind: 'trade' },
        { id: 3, date: '2025-07-10', shares: 0, twd: 14_000, kind: 'dividend' },
      ],
    },
    {
      key: 'VOO', display: 'VOO', market: '美股', currency: 'USD', symbol: 'VOO',
      manualPrice: 700, ownerScope: 'wife', quote: null,
      transactions: [{ id: 4, date: '2021-03-01', shares: 100, twd: -1_200_000, kind: 'trade' }],
    },
    // 出清的部位：股數 0，市值必須是 0 而不是負數
    {
      key: 'TPE:0050', display: '元大台灣50', market: '台股', currency: 'TWD', symbol: '0050',
      manualPrice: 106.2, ownerScope: 'husband', quote: null,
      transactions: [
        { id: 5, date: '2020-01-02', shares: 500, twd: -50_000, kind: 'trade' },
        { id: 6, date: '2021-01-02', shares: -500, twd: 62_000, kind: 'trade' },
      ],
    },
    { key: 'EMPTY', display: '沒交易', market: '台股', currency: 'TWD', symbol: 'X', manualPrice: null, ownerScope: 'husband', quote: null, transactions: [] },
  ];
  const fxRate = 31.62785;
  for (const stock of stocks) {
    const full = calculateStockMetrics(stock, fxRate, '2026-09-09');
    const light = calculateStockValue(stock, fxRate);
    for (const field of ['shares', 'price', 'currentValueNative', 'currentValueTwd', 'key', 'display', 'market', 'currency', 'symbol']) {
      assert.ok(Object.is(full[field], light[field]), `${stock.key} 的 ${field}：${full[field]} vs ${light[field]}`);
    }
    assert.equal(light.transactions, stock.transactions, `${stock.key} 的交易紀錄要原封不動帶著（編輯表單要用）`);
  }
  assert.equal(calculateStockValue(stocks[2], fxRate).currentValueTwd, 0, '出清的部位市值應為 0');
  assert.ok(calculateStockValue(stocks[1], fxRate).currentValueTwd > 2_000_000, '美股要乘上匯率');
});
