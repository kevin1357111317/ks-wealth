const n = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const latestOnOrBefore = (rows, date, key = 'value') => {
  let hit = null;
  for (const row of rows ?? []) {
    if (row.date > date) break;
    if (n(row[key]) > 0) hit = n(row[key]);
  }
  return hit;
};

export function buildPerformanceSeries({ snapshots, flows, twBenchmark, usBenchmark, fxHistory, market }) {
  const ordered = [...(snapshots ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!ordered.length) return [];

  const valueOf = row => market === 'tw' ? n(row.twTwd)
    : market === 'us' ? n(row.usUsd)
      : n(row.twTwd) + n(row.usTwd);
  const flowOf = date => {
    const row = flows?.[date] ?? {};
    return market === 'tw' ? n(row.twTwd)
      : market === 'us' ? n(row.usUsd)
        : n(row.twTwd) + n(row.usTwd);
  };

  const first = ordered.find(row => valueOf(row) > 0);
  if (!first) return [];
  const firstTw = latestOnOrBefore(twBenchmark, first.date);
  const firstUs = latestOnOrBefore(usBenchmark, first.date);
  const firstFx = latestOnOrBefore(fxHistory, first.date, 'rate');
  const firstTotal = n(first.twTwd) + n(first.usTwd);
  const twWeight = firstTotal > 0 ? n(first.twTwd) / firstTotal : 0;
  const usWeight = firstTotal > 0 ? n(first.usTwd) / firstTotal : 0;

  let portfolioIndex = 100;
  let previousValue = valueOf(first);
  const output = [];
  for (const row of ordered.filter(item => item.date >= first.date)) {
    const value = valueOf(row);
    if (value <= 0) continue;
    if (row !== first && previousValue > 0) {
      const dailyReturn = (value - flowOf(row.date)) / previousValue - 1;
      // 日資料不完整時，不讓單日異常值把整張圖炸掉；後續完整快照仍會自然接上。
      if (Number.isFinite(dailyReturn) && dailyReturn > -0.95 && dailyReturn < 2) {
        portfolioIndex *= 1 + dailyReturn;
      }
    }
    previousValue = value;

    const tw = latestOnOrBefore(twBenchmark, row.date);
    const us = latestOnOrBefore(usBenchmark, row.date);
    const fx = latestOnOrBefore(fxHistory, row.date, 'rate');
    let benchmarkIndex = null;
    if (market === 'tw' && firstTw && tw) benchmarkIndex = 100 * tw / firstTw;
    if (market === 'us' && firstUs && us) benchmarkIndex = 100 * us / firstUs;
    if (market === 'all') {
      const twRelative = firstTw && tw ? tw / firstTw : null;
      const usRelative = firstUs && firstFx && us && fx ? (us * fx) / (firstUs * firstFx) : null;
      if ((twWeight === 0 || twRelative) && (usWeight === 0 || usRelative)) {
        benchmarkIndex = 100 * (twWeight * (twRelative ?? 0) + usWeight * (usRelative ?? 0));
      }
    }
    output.push({
      date: row.date,
      portfolio: Math.round(portfolioIndex * 100) / 100,
      benchmark: benchmarkIndex === null ? null : Math.round(benchmarkIndex * 100) / 100,
    });
  }
  return output;
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
