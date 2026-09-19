import { summarizePerformance } from './return-math.js';

const n = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const latestOnOrBefore = (rows, date, key = 'value') => {
  const ordered = rows ?? [];
  let low = 0;
  let high = ordered.length - 1;
  let hit = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (ordered[middle].date <= date) {
      hit = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  // Yahoo 偶爾會在交易日留下 null；從定位點往前找最近的有效值，
  // 不再為每一個績效日從整段歷史的第一天重新掃描。
  while (hit >= 0) {
    const value = n(ordered[hit]?.[key]);
    if (value > 0) return value;
    hit -= 1;
  }
  return null;
};

export function buildPerformanceSeries({ snapshots, flows, twBenchmark, usBenchmark, fxHistory, market, benchmarkMode = market === 'all' ? 'mixed' : market }) {
  const ordered = [...(snapshots ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!ordered.length) return [];

  const valueOf = row => market === 'tw' ? n(row.twTwd)
    : market === 'us' ? n(row.usUsd)
      : n(row.twTwd) + n(row.usTwd);
  // 每日 TWR 的分子要跟市值同一把尺：快照自己帶的 flow 已用當日收盤價計價，優先採用；
  // 只有手工組出來、沒有 flow 的快照才退回私帳現金金額。
  const flowOf = row => {
    const source = row.flow ?? flows?.[row.date] ?? {};
    return market === 'tw' ? n(source.twTwd)
      : market === 'us' ? n(source.usUsd)
        : n(source.twTwd) + n(source.usTwd);
  };

  const first = ordered.find(row => valueOf(row) > 0);
  if (!first) return [];
  let portfolioIndex = 100;
  let benchmarkIndex = 100;
  let previousValue = valueOf(first);
  let previousRow = first;
  // 這個 market 當天市值是 0（例如美股頁在還沒有美股部位的日子）就沒有報酬可算，但當天的
  // 金流不能跟著消失，否則下一個有市值的日子會把整筆金流誤當成報酬。先寄放，下一天一起扣。
  let pendingFlow = 0;
  const output = [];
  for (const row of ordered.filter(item => item.date >= first.date)) {
    const value = valueOf(row);
    if (value <= 0) { pendingFlow += flowOf(row); continue; }
    if (row !== first && previousValue > 0) {
      const dailyReturn = (value - flowOf(row) - pendingFlow) / previousValue - 1;
      if (Number.isFinite(dailyReturn)) portfolioIndex *= 1 + dailyReturn;
    }
    pendingFlow = 0;
    previousValue = value;

    let comparable = true;
    if (row !== first) {
      const tw = latestOnOrBefore(twBenchmark, row.date);
      const previousTw = latestOnOrBefore(twBenchmark, previousRow.date);
      const us = latestOnOrBefore(usBenchmark, row.date);
      const previousUs = latestOnOrBefore(usBenchmark, previousRow.date);
      const fx = latestOnOrBefore(fxHistory, row.date, 'rate');
      const previousFx = latestOnOrBefore(fxHistory, previousRow.date, 'rate');
      let benchmarkReturn = 0;
      if (benchmarkMode === 'tw') {
        comparable = Boolean(tw && previousTw);
        if (comparable) benchmarkReturn = tw / previousTw - 1;
      } else if (benchmarkMode === 'us') {
        const includeFx = market === 'all';
        comparable = Boolean(us && previousUs && (!includeFx || fx && previousFx));
        if (comparable) benchmarkReturn = includeFx
          ? (us * fx) / (previousUs * previousFx) - 1
          : us / previousUs - 1;
      } else {
        const previousTotal = n(previousRow.twTwd) + n(previousRow.usTwd);
        const twWeight = previousTotal > 0 ? n(previousRow.twTwd) / previousTotal : 0;
        const usWeight = previousTotal > 0 ? n(previousRow.usTwd) / previousTotal : 0;
        const twReturn = tw && previousTw ? tw / previousTw - 1 : null;
        const usReturn = us && previousUs && fx && previousFx ? (us * fx) / (previousUs * previousFx) - 1 : null;
        comparable = (twWeight === 0 || twReturn !== null) && (usWeight === 0 || usReturn !== null);
        if (comparable) benchmarkReturn = twWeight * (twReturn ?? 0) + usWeight * (usReturn ?? 0);
      }
      if (comparable) benchmarkIndex *= 1 + benchmarkReturn;
    }
    output.push({
      date: row.date,
      portfolio: Math.round(portfolioIndex * 100) / 100,
      benchmark: comparable ? Math.round(benchmarkIndex * 100) / 100 : null,
      portfolioRaw: portfolioIndex,
      benchmarkRaw: comparable ? benchmarkIndex : null,
    });
    previousRow = row;
  }
  return output;
}

export function yahooPriceRows(result, field = 'close') {
  const timestamps = result?.timestamp ?? [];
  const values = field === 'adjusted'
    ? result?.indicators?.adjclose?.[0]?.adjclose ?? []
    : result?.indicators?.quote?.[0]?.close ?? [];
  return timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    value: n(values[index]),
  })).filter(row => row.value > 0);
}

// 沒有企業行動資料時只能從一組常見倍率裡猜。除了拆股，也要涵蓋長榮等現金減資造成的
// 反向股數調整：Yahoo close 會回溯調整企業行動，私帳仍是成交當時股數，倍率可能小於 1。
const GUESSED_SCALES = [0.1, 0.2, 0.25, 1 / 3, 0.4, 0.5, 1, 2, 3, 4, 5, 10, 20, 50, 100];

const recognizedScale = (ratio, candidates = GUESSED_SCALES) => {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  const closest = candidates.reduce((best, candidate) =>
    Math.abs(Math.log(ratio / candidate)) < Math.abs(Math.log(ratio / best)) ? candidate : best, 1);
  return Math.abs(Math.log(ratio / closest)) <= Math.log(1.18) ? closest : 1;
};

// Yahoo 的 chart API 不回報台灣 ETF 的受益權單位分割 —— 它把歷史價格調整了，卻不告訴你
// 調了幾倍（0050 的 2019 收盤直接從 87 變成 22，events 裡完全沒有 splits 欄位）。
// 美股與台灣個股都有回報（NVDA、TSLA、SOXX、長榮的現金減資都查得到），所以只有台灣 ETF
// 需要自己維護。日期用「分割後恢復交易日」，也就是第一個用新單位成交的日子。
//
// 新增一檔時去查投信公告，把價格對照一起寫進註解，之後才對得起來。
const TW_ETF_SPLITS = {
  // 元大投信公告：1 拆 4，分割前 188.65 元 → 恢復交易參考價 47.16 元
  '0050': [{ date: '2025-06-18', ratio: 4 }],
  // 元大投信公告：1 拆 22，分割前 443.15 元／張 → 恢復交易 20.14 元
  '00631L': [{ date: '2026-03-31', ratio: 22 }],
};

const splitsFor = (stock, splits) => {
  const yahoo = (splits ?? []).filter(split => n(split.ratio) > 0);
  if (yahoo.length) return yahoo;
  const code = String(stock?.symbol ?? stock?.key ?? '').replace(/^(TPE:|TWO:)/i, '').toUpperCase();
  return TW_ETF_SPLITS[code] ?? null;
};

// 私帳記的是成交當時的股數，Yahoo 的 close 卻回溯調整過，所以要知道兩者差幾倍。
//
// 有拆股資料（Yahoo 或上面那張表）就直接用：成交日之後的累計倍率就是答案，沒有就是 1。
// 以前這裡在「累計倍率剛好是 1」時會退回去猜十幾個候選，等於把已經確定的答案丟掉 ——
// TSLA 2025-11-13 被猜成 0.5、SOXX 2026-05-13 被猜成 0.4 都是這樣來的。
//
// 完全沒有拆股資料時才用成交單價反推，而且只在台股：Yahoo 對美股的拆股回報是可靠的，
// 沒回報就代表真的沒拆過，不該讓一筆對不上市價的零股交易（手續費、拆單）冒充成拆股證據。
export function transactionShareScale(transaction, stock, prices, splits) {
  if (!transaction?.shares || !transaction?.amount || stock?.market === '美股' && stock?.currency !== 'USD') return 1;
  const known = splitsFor(stock, splits);
  if (known) {
    const applied = appliedSplit(known, transaction.tx_date);
    // 成交日之後沒有拆股，倍率就確定是 1。以前這裡會退回去猜十幾個候選，
    // 等於把已經確定的答案丟掉。
    if (applied === 1) return 1;
    const close = latestOnOrBefore(prices, transaction.tx_date);
    if (!close) return 1;
    // 只剩兩種可能：私帳是成交當時股數（該倍率），或已經換算過（1）。用成交單價決定。
    return recognizedScale(Math.abs(n(transaction.amount) / n(transaction.shares)) / close, [1, applied]);
  }
  // Yahoo 對美股的拆股回報是可靠的，沒回報就是真的沒拆過 —— 不該讓一筆對不上市價的
  // 零股交易（手續費、拆單）冒充成拆股證據。只有台股沒資料時才反推。
  if (stock?.market === '美股') return 1;
  const close = latestOnOrBefore(prices, transaction.tx_date);
  if (!close) return 1;
  return recognizedScale(Math.abs(n(transaction.amount) / n(transaction.shares)) / close);
}

const appliedSplit = (splits, date) => {
  const total = (splits ?? []).filter(split => split.date > date)
    .reduce((product, split) => product * (n(split.ratio) > 0 ? n(split.ratio) : 1), 1);
  return Number.isFinite(total) && total > 0 ? total : 1;
};

// 同一檔、同一個拆股期間，私帳的單位只會有一種慣例：要嘛整段都是成交當時股數，要嘛整段
// 都已經換算成拆股後股數。逐筆各自判斷會被一筆壞資料帶走 —— 0050 的 2023-01-30 那筆金額
// 只記了一半，單價比值算出來剛好是 2，自己跑出一個不存在的倍率，整體股數就少了 120 股。
// 所以同一段期間只決定一次，少數服從多數。
function scalesByTransaction({ stocks, transactions, priceHistory, splitEvents }) {
  const stockByKey = new Map((stocks ?? []).map(stock => [stock.key, stock]));
  const eras = new Map();
  for (const transaction of transactions ?? []) {
    const stock = stockByKey.get(transaction.stock_key);
    if (!stock) continue;
    const prices = priceHistory.get(transaction.stock_key) ?? [];
    const splits = splitsFor(stock, splitEvents?.get(transaction.stock_key));
    const era = `${transaction.stock_key}|${splits ? appliedSplit(splits, transaction.tx_date) : 'guess'}`;
    const scale = transactionShareScale(transaction, stock, prices, splitEvents?.get(transaction.stock_key));
    if (!eras.has(era)) eras.set(era, { rows: [], tally: new Map() });
    const bucket = eras.get(era);
    bucket.rows.push(transaction);
    bucket.tally.set(scale, (bucket.tally.get(scale) ?? 0) + 1);
  }
  const output = new Map();
  for (const { rows, tally } of eras.values()) {
    const winner = [...tally].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    for (const transaction of rows) output.set(transaction, winner);
  }
  return output;
}

const DAY_MS = 86_400_000;
const dayGap = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// 私帳的股息記的是「入帳日」，但價格是在「除息日」掉下來的，兩者常差好幾週。TWR 把股息
// 算在入帳日，等於除息日先吃一次下跌、入帳日再補一次上漲；同一期間內大致抵銷，跨期間邊界
// 就會少算或多算。改成對齊 Yahoo 的除息日；抓不到（或差超過 120 天，不像同一次配息）就
// 退回私帳日期。XIRR 用的 transactionFlows 不動，資金加權本來就該用真實入帳時點。
const dividendFlowDate = (transaction, events) => {
  let hit = null;
  for (const event of events ?? []) {
    if (event.date > transaction.tx_date) break;
    hit = event.date;
  }
  return hit && dayGap(hit, transaction.tx_date) <= 120 ? hit : transaction.tx_date;
};

export function buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory, splitEvents, dividendEvents }) {
  const stockByKey = new Map((stocks ?? []).map(stock => [stock.key, stock]));
  const scales = scalesByTransaction({ stocks, transactions, priceHistory, splitEvents });
  const adjusted = (transactions ?? []).map(transaction => {
    const stock = stockByKey.get(transaction.stock_key);
    const scale = scales.get(transaction) ?? 1;
    return {
      ...transaction,
      adjustedShares: n(transaction.shares) * scale,
      flowDate: transaction.kind === 'dividend'
        ? dividendFlowDate(transaction, dividendEvents?.get(transaction.stock_key))
        : transaction.tx_date,
    };
  });
  const txByDate = new Map();
  for (const transaction of adjusted) {
    const rows = txByDate.get(transaction.flowDate) ?? [];
    rows.push(transaction);
    txByDate.set(transaction.flowDate, rows);
  }
  const dates = new Set(adjusted.flatMap(row => [row.tx_date, row.flowDate]));
  for (const rows of priceHistory.values()) for (const row of rows) dates.add(row.date);
  for (const row of fxHistory ?? []) dates.add(row.date);

  const pricesByDate = new Map();
  for (const [key, rows] of priceHistory) {
    for (const row of rows) {
      const day = pricesByDate.get(row.date) ?? [];
      day.push([key, n(row.value)]);
      pricesByDate.set(row.date, day);
    }
  }
  const fxByDate = new Map((fxHistory ?? []).map(row => [row.date, n(row.rate)]));
  const shares = new Map();
  const currentPrices = new Map();
  let currentFx = 0;
  const snapshots = [];
  // 有標的當天抓不到價格時整天不產生快照。那天的金流不能跟著消失，否則後面每一天的 TWR
  // 都會永久偏掉；先寄放到下一個算得出市值的日子一起扣。
  let pending = { twTwd: 0, usTwd: 0, usUsd: 0 };
  let unpriced = [];
  for (const date of [...dates].filter(Boolean).sort()) {
    for (const [key, value] of pricesByDate.get(date) ?? []) if (value > 0) currentPrices.set(key, value);
    if (fxByDate.get(date) > 0) currentFx = fxByDate.get(date);
    // 當日的外部金流。買賣用「當日收盤價 × 股數」計價，不用成交金額：市值本來就是收盤價，
    // 拿成交價去扣就會把成交價與收盤價的價差（手續費、盤中價位）當成報酬。部位很小時加碼，
    // 這個價差除以前一日市值會變成幾十趴的假單日報酬（2020-07-22、2020-08-18、2020-11-17）。
    const flow = { twTwd: pending.twTwd, usTwd: pending.usTwd, usUsd: pending.usUsd };
    const addTrade = (stock, movedShares) => {
      const price = currentPrices.get(stock.key);
      if (!price) return false;
      const moved = movedShares * price;
      if (stock.currency === 'USD') {
        flow.usUsd += moved;
        flow.usTwd += moved * currentFx;
      } else if (stock.market === '美股') flow.twTwd += moved * currentFx;
      else flow.twTwd += moved;
      return true;
    };
    // 還沒有報價的買賣：等它第一次有價格再計入金流，跟它進入市值的那一天一致。
    unpriced = unpriced.filter(trade => !addTrade(trade.stock, trade.movedShares));
    for (const transaction of txByDate.get(date) ?? []) {
      const stock = stockByKey.get(transaction.stock_key);
      if (!stock) continue;
      if (transaction.kind === 'dividend') {
        // 股息沒有股數，現金直接離開部位，照私帳金額當提款。
        if (stock.currency === 'USD') {
          flow.usUsd -= n(transaction.amount);
          flow.usTwd -= n(transaction.amount) * currentFx;
        } else flow.twTwd -= n(transaction.amount);
        continue;
      }
      const next = n(shares.get(transaction.stock_key)) + n(transaction.adjustedShares);
      shares.set(transaction.stock_key, Math.abs(next) < 0.000001 ? 0 : next);
      const movedShares = n(transaction.adjustedShares);
      if (!addTrade(stock, movedShares)) unpriced.push({ stock, movedShares });
    }
    let twTwd = 0;
    let usTwd = 0;
    let usUsd = 0;
    let complete = true;
    for (const [key, quantity] of shares) {
      if (Math.abs(quantity) < 0.000001) continue;
      const stock = stockByKey.get(key);
      const price = currentPrices.get(key);
      if (!stock || !price) { complete = false; break; }
      const quoteIsUsd = stock.market === '美股';
      if (stock.currency === 'USD') {
        if (!currentFx) { complete = false; break; }
        usUsd += quantity * price;
        usTwd += quantity * price * currentFx;
      } else if (quoteIsUsd) {
        if (!currentFx) { complete = false; break; }
        twTwd += quantity * price * currentFx;
      } else twTwd += quantity * price;
    }
    if (complete && twTwd + usTwd > 0) {
      snapshots.push({ date, twTwd, usTwd, usUsd, flow });
      pending = { twTwd: 0, usTwd: 0, usUsd: 0 };
    } else pending = flow;
  }
  return snapshots;
}

// 全部期間兩千多個交易日抽成 280 點，平均每七天才留一點，2025-04-09 那種單日 +10% 會整根
// 被跳過。均勻抽樣之後，把單日振幅 2% 以上、最大的幾天連同前一天補回來，圖上才看得到。
// 只影響圖形；累積 TWR、年化與 XIRR 一律用完整序列計算。
export function downsampleSeries(rows, maximum = 280, { keepExtremes = 12, threshold = 0.02 } = {}) {
  if ((rows?.length ?? 0) <= maximum) return rows ?? [];
  const selected = new Set([0, rows.length - 1]);
  for (let index = 1; index < maximum - 1; index += 1) {
    selected.add(Math.round(index * (rows.length - 1) / (maximum - 1)));
  }
  const moves = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = Number(rows[index - 1]?.portfolio);
    const current = Number(rows[index]?.portfolio);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) continue;
    const move = Math.abs(current / previous - 1);
    if (move >= threshold) moves.push([move, index]);
  }
  moves.sort((a, b) => b[0] - a[0]);
  for (const [, index] of moves.slice(0, keepExtremes)) {
    selected.add(index - 1);
    selected.add(index);
  }
  return [...selected].sort((a, b) => a - b).map(index => rows[index]);
}

// Yahoo 的 events：dividends 給除息日，splits 給拆股／減資倍率（numerator/denominator）。
export function yahooEventRows(result, kind = 'dividends') {
  return Object.values(result?.events?.[kind] ?? {}).map(event => {
    const seconds = n(event?.date);
    const ratio = kind === 'splits'
      ? n(event?.numerator) / (n(event?.denominator) || 1)
      : n(event?.amount);
    if (!Number.isFinite(seconds) || seconds <= 0 || !(ratio > 0)) return null;
    return { date: new Date(seconds * 1000).toISOString().slice(0, 10), ratio };
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

export function transactionFlows(transactions, stockByKey) {
  const result = {};
  for (const tx of transactions ?? []) {
    const stock = stockByKey.get(tx.stock_key);
    if (!stock || !tx.tx_date) continue;
    const day = result[tx.tx_date] ?? { twTwd: 0, usTwd: 0, usUsd: 0 };
    if (stock.currency === 'USD') {
      day.usTwd += -n(tx.twd);
      day.usUsd += -n(tx.amount);
    } else day.twTwd += -n(tx.twd);
    result[tx.tx_date] = day;
  }
  return result;
}

export { summarizePerformance };
