const EPSILON = 1e-7;

export const MARKET_LABELS = Object.freeze({ 台股: '台股', 美股: '美股' });

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function localIsoDate(date = new Date(), timeZone = 'Asia/Taipei') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function decodePortfolioBootstrap(payload) {
  if (!payload || !Array.isArray(payload.s) || !Array.isArray(payload.t)) return [];
  const banks = payload.d?.banks ?? [];
  const notes = payload.d?.notes ?? [];
  const kinds = payload.d?.kinds ?? [];
  const quotes = new Map((payload.q ?? []).map(row => [String(row[0] ?? '').toUpperCase(), {
    price: number(row[1]), currency: row[2], source: row[3], quotedAt: row[4], updatedAt: number(row[5]),
  }]));
  const stocks = payload.s.map(row => ({
    key: row[0], display: row[1], market: row[2], currency: row[3], symbol: row[4] || '',
    manualPrice: row[5] === null ? null : number(row[5]),
    quote: quotes.get(String(row[4] ?? '').toUpperCase()) ?? null,
    transactions: [],
  }));
  (payload.t ?? []).forEach(row => {
    const stock = stocks[number(row[1])];
    if (!stock) return;
    stock.transactions.push({
      id: number(row[0]), date: row[2], amount: number(row[3]), shares: number(row[4]),
      bank: banks[number(row[5])] || '', kind: kinds[number(row[6])] || 'trade',
      note: notes[number(row[7])] || '', twd: number(row[8]),
    });
  });
  return stocks;
}

export function currentShares(stock) {
  return Math.round((stock.transactions ?? []).reduce((sum, tx) => sum + number(tx.shares), 0) * 1e6) / 1e6;
}

export function effectivePrice(stock) {
  const live = number(stock.quote?.price);
  return live > 0 ? live : Math.max(0, number(stock.manualPrice));
}

export function xirr(cashflows) {
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

export function calculateStockMetrics(stock, fxRate, today = localIsoDate()) {
  const shares = currentShares(stock);
  const price = effectivePrice(stock);
  const currentValueNative = shares > EPSILON ? shares * price : 0;
  const currentValueTwd = stock.currency === 'USD' ? currentValueNative * number(fxRate) : currentValueNative;
  const cashflows = (stock.transactions ?? []).map(tx => ({ date: tx.date, amount: number(tx.twd) }));
  const netInvestedTwd = -cashflows.reduce((sum, flow) => sum + flow.amount, 0);
  const dividendsTwd = (stock.transactions ?? []).filter(tx => tx.kind === 'dividend')
    .reduce((sum, tx) => sum + number(tx.twd), 0);
  if (currentValueTwd > 0) cashflows.push({ date: today, amount: currentValueTwd });
  return {
    ...stock, shares, price, currentValueNative, currentValueTwd, netInvestedTwd, dividendsTwd,
    profitTwd: currentValueTwd - netInvestedTwd,
    returnRate: netInvestedTwd > EPSILON ? (currentValueTwd - netInvestedTwd) / netInvestedTwd : null,
    xirr: xirr(cashflows),
  };
}

export function calculatePortfolio(stocks, fxRate, today = localIsoDate()) {
  const positions = (stocks ?? []).map(stock => calculateStockMetrics(stock, fxRate, today));
  const summarize = rows => {
    const totals = rows.reduce((result, row) => ({
      currentValueTwd: result.currentValueTwd + row.currentValueTwd,
      netInvestedTwd: result.netInvestedTwd + row.netInvestedTwd,
      dividendsTwd: result.dividendsTwd + row.dividendsTwd,
      transactions: result.transactions + row.transactions.length,
      holdings: result.holdings + (row.shares > EPSILON ? 1 : 0),
    }), { currentValueTwd: 0, netInvestedTwd: 0, dividendsTwd: 0, transactions: 0, holdings: 0 });
    const cashflows = rows.flatMap(row => row.transactions.map(tx => ({ date: tx.date, amount: number(tx.twd) })));
    if (totals.currentValueTwd > 0) cashflows.push({ date: today, amount: totals.currentValueTwd });
    return {
      ...totals,
      profitTwd: totals.currentValueTwd - totals.netInvestedTwd,
      returnRate: totals.netInvestedTwd > EPSILON ? (totals.currentValueTwd - totals.netInvestedTwd) / totals.netInvestedTwd : null,
      xirr: xirr(cashflows),
    };
  };
  return {
    positions,
    tw: summarize(positions.filter(row => row.market === '台股')),
    us: summarize(positions.filter(row => row.market === '美股')),
    all: summarize(positions),
  };
}
