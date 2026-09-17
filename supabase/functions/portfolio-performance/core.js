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

  const pick = row => market === 'tw' ? n(row.twTwd)
    : market === 'us' ? n(row.usUsd)
      : n(row.twTwd) + n(row.usTwd);
  const valueOf = pick;

  const first = ordered.find(row => valueOf(row) > 0);
  if (!first) return [];

  // 快照不是每天都有：持股裡只要有一檔當天沒有收盤價，buildHistoricalSnapshots 就整天
  // 不輸出；出清到市值 0 的日子也會被跳過。所以要扣的是「上一個有快照的日子之後到今天
  // 為止」的所有現金流，只扣當天的話，斷掉那幾天的買進與賣出會被當成報酬 —— 抓不到報價
  // 的冷門代號買進 50 萬、賣出時才接回快照，那 50 萬價金會整筆變成漲幅。
  const orderedFlows = Object.keys(flows ?? {}).sort()
    .map(date => ({ date, amount: pick(flows[date] ?? {}) }));
  let flowIndex = 0;
  // 起點當天（含）以前的現金流不計：那一天的指數本來就重設成 100。
  while (flowIndex < orderedFlows.length && orderedFlows[flowIndex].date <= first.date) flowIndex += 1;
  const flowsThrough = date => {
    let total = 0;
    while (flowIndex < orderedFlows.length && orderedFlows[flowIndex].date <= date) {
      total += orderedFlows[flowIndex].amount;
      flowIndex += 1;
    }
    return total;
  };
  let portfolioIndex = 100;
  let benchmarkIndex = 100;
  let previousValue = valueOf(first);
  let previousRow = first;
  const output = [];
  for (const row of ordered.filter(item => item.date >= first.date)) {
    const value = valueOf(row);
    if (value <= 0) continue;
    if (row !== first && previousValue > 0) {
      const dailyReturn = (value - flowsThrough(row.date)) / previousValue - 1;
      // 日資料不完整時，不讓單日異常值把整張圖炸掉；後續完整快照仍會自然接上。
      if (Number.isFinite(dailyReturn) && dailyReturn > -0.95 && dailyReturn < 2) {
        portfolioIndex *= 1 + dailyReturn;
      }
    }
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

const recognizedScale = ratio => {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  const candidates = [1, 2, 3, 4, 5, 10, 20, 50, 100];
  const closest = candidates.reduce((best, candidate) =>
    Math.abs(Math.log(ratio / candidate)) < Math.abs(Math.log(ratio / best)) ? candidate : best, 1);
  return Math.abs(Math.log(ratio / closest)) <= Math.log(1.18) ? closest : 1;
};

// Yahoo 的 close 會回溯調整拆股、但不調整現金股息。台帳有些舊交易已手動換算成
// 拆股後股數（NVDA），有些維持成交當時股數（0050），所以逐筆用成交單價判斷倍率。
export function transactionShareScale(transaction, stock, prices) {
  if (!transaction?.shares || !transaction?.amount || stock?.market === '美股' && stock?.currency !== 'USD') return 1;
  const close = latestOnOrBefore(prices, transaction.tx_date);
  if (!close) return 1;
  return recognizedScale(Math.abs(n(transaction.amount) / n(transaction.shares)) / close);
}

export function buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory }) {
  const stockByKey = new Map((stocks ?? []).map(stock => [stock.key, stock]));
  const adjusted = (transactions ?? []).map(transaction => {
    const stock = stockByKey.get(transaction.stock_key);
    const scale = transactionShareScale(transaction, stock, priceHistory.get(transaction.stock_key) ?? []);
    return { ...transaction, adjustedShares: n(transaction.shares) * scale };
  });
  const txByDate = new Map();
  for (const transaction of adjusted) {
    const rows = txByDate.get(transaction.tx_date) ?? [];
    rows.push(transaction);
    txByDate.set(transaction.tx_date, rows);
  }
  const dates = new Set(adjusted.map(row => row.tx_date));
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
  for (const date of [...dates].filter(Boolean).sort()) {
    for (const [key, value] of pricesByDate.get(date) ?? []) if (value > 0) currentPrices.set(key, value);
    if (fxByDate.get(date) > 0) currentFx = fxByDate.get(date);
    for (const transaction of txByDate.get(date) ?? []) {
      if (transaction.kind === 'dividend') continue;
      const next = n(shares.get(transaction.stock_key)) + n(transaction.adjustedShares);
      shares.set(transaction.stock_key, Math.abs(next) < 0.000001 ? 0 : next);
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
    if (complete && twTwd + usTwd > 0) snapshots.push({ date, twTwd, usTwd, usUsd });
  }
  return snapshots;
}

export function downsampleSeries(rows, maximum = 280) {
  if ((rows?.length ?? 0) <= maximum) return rows ?? [];
  const selected = new Set([0, rows.length - 1]);
  for (let index = 1; index < maximum - 1; index += 1) {
    selected.add(Math.round(index * (rows.length - 1) / (maximum - 1)));
  }
  return [...selected].sort((a, b) => a - b).map(index => rows[index]);
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
