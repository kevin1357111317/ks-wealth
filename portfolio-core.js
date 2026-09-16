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
    ownerScope: row[6] || 'husband',
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

// 把台幣現金流拆成「已實現」與「還壓在手上的成本」，用先進先出配對賣出。
// 賣掉的那幾股要用當初買它們的成本去算損益，不是用整體平均 —— 同一檔在不同價位
// 分批買進時兩者差很多。股息沒有對應的成本，整筆算已實現。
//
// 不變式：已實現 + 未實現 = 累計損益。未實現 = 目前市值 − 剩下的成本。
function splitRealizedBy(stock, cashField) {
  const lots = [];        // 先進先出佇列：{ qty, cost }，最舊的在前
  let realized = 0;
  const ordered = (stock.transactions ?? []).slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return number(a.id) - number(b.id);
  });
  ordered.forEach(tx => {
    const cash = number(tx[cashField]);
    const qty = number(tx.shares);
    if (tx.kind === 'dividend' || Math.abs(qty) < EPSILON) {
      realized += cash;
      return;
    }
    if (qty > 0) {
      lots.push({ qty, cost: -cash });
      return;
    }
    let unsold = -qty;
    let costOut = 0;
    while (unsold > EPSILON && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.qty, unsold);
      const unit = lot.qty > EPSILON ? lot.cost / lot.qty : 0;
      costOut += unit * take;
      lot.qty -= take;
      lot.cost -= unit * take;
      unsold -= take;
      if (lot.qty <= EPSILON) lots.shift();
    }
    realized += cash - costOut;
  });
  let shares = 0;
  let cost = 0;
  lots.forEach(lot => { shares += lot.qty; cost += lot.cost; });
  if (shares <= EPSILON) return { realized: realized + cost, remainingCost: 0 };
  return { realized, remainingCost: cost };
}

export function splitRealized(stock) {
  const { realized, remainingCost } = splitRealizedBy(stock, 'twd');
  return { realizedTwd: realized, remainingCostTwd: remainingCost };
}

export function firstTradeDate(stock) {
  return (stock.transactions ?? []).reduce(
    (earliest, tx) => (!earliest || tx.date < earliest ? tx.date : earliest), null);
}

// 出清後投資期間的結束點是最後一次買賣，不是今天 —— 錢已經拿回來了。
// 股息不算：賣光之後才入帳的配息只是尾款，不該把期間往後拉（XIRR 仍然吃它的日期）。
export function lastTradeDate(stock) {
  return (stock.transactions ?? []).reduce(
    (latest, tx) => (tx.kind !== 'dividend' && (!latest || tx.date > latest) ? tx.date : latest), null);
}

export function holdingYears(stock, today = localIsoDate()) {
  const first = firstTradeDate(stock);
  if (!first) return null;
  // 還握著就算到今天；已經出清就停在最後一次買賣那天。
  const closed = currentShares(stock) <= EPSILON;
  const end = closed ? (lastTradeDate(stock) ?? today) : today;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000;
  return days > 0 ? days / 365 : 0;
}

export function calculateStockMetrics(stock, fxRate, today = localIsoDate()) {
  const shares = currentShares(stock);
  const price = effectivePrice(stock);
  const currentValueNative = shares > EPSILON ? shares * price : 0;
  const currentValueTwd = stock.currency === 'USD' ? currentValueNative * number(fxRate) : currentValueNative;
  const cashflows = (stock.transactions ?? []).map(tx => ({ date: tx.date, amount: number(tx.twd) }));
  const nativeCashflows = (stock.transactions ?? []).map(tx => ({ date: tx.date, amount: number(tx.amount) }));
  const netInvestedTwd = -cashflows.reduce((sum, flow) => sum + flow.amount, 0);
  const netInvestedNative = -nativeCashflows.reduce((sum, flow) => sum + flow.amount, 0);
  const purchaseCostTwd = (stock.transactions ?? [])
    .filter(tx => tx.kind !== 'dividend' && number(tx.shares) > EPSILON)
    .reduce((sum, tx) => sum + Math.max(0, -number(tx.twd)), 0);
  const purchaseCostNative = (stock.transactions ?? [])
    .filter(tx => tx.kind !== 'dividend' && number(tx.shares) > EPSILON)
    .reduce((sum, tx) => sum + Math.max(0, -number(tx.amount)), 0);
  const dividendsTwd = (stock.transactions ?? []).filter(tx => tx.kind === 'dividend')
    .reduce((sum, tx) => sum + number(tx.twd), 0);
  const dividendsNative = (stock.transactions ?? []).filter(tx => tx.kind === 'dividend')
    .reduce((sum, tx) => sum + number(tx.amount), 0);
  if (currentValueTwd > 0) cashflows.push({ date: today, amount: currentValueTwd });
  if (currentValueNative > 0) nativeCashflows.push({ date: today, amount: currentValueNative });
  const { realizedTwd, remainingCostTwd } = splitRealized(stock);
  const { realized: realizedNative, remainingCost: remainingCostNative } = splitRealizedBy(stock, 'amount');
  const profitTwd = currentValueTwd - netInvestedTwd;
  const profitNative = currentValueNative - netInvestedNative;
  // 淨投入仍是畫面上的現金流口徑。部位全部出清後，賣出收入可能讓淨投入
  // 變成 0 或負數；這時不能讓報酬率消失，改以歷史買進成本當分母。
  // 尚有正淨投入的既有部位維持原本定義，避免改寫已上線數字。
  const returnBaseTwd = netInvestedTwd > EPSILON ? netInvestedTwd : purchaseCostTwd;
  const returnBaseNative = netInvestedNative > EPSILON ? netInvestedNative : purchaseCostNative;
  const stockProfitTwd = stock.currency === 'USD' ? profitNative * number(fxRate) : profitNative;
  return {
    ...stock, shares, price, currentValueNative, currentValueTwd,
    netInvestedTwd, netInvestedNative, purchaseCostTwd, purchaseCostNative,
    dividendsTwd, dividendsNative,
    profitTwd, profitNative, stockProfitTwd, fxImpactTwd: profitTwd - stockProfitTwd,
    realizedTwd, realizedNative,
    unrealizedTwd: currentValueTwd - remainingCostTwd,
    unrealizedNative: currentValueNative - remainingCostNative,
    remainingCostTwd, remainingCostNative,
    firstTradeDate: firstTradeDate(stock),
    lastTradeDate: lastTradeDate(stock),
    holdingYears: holdingYears(stock, today),
    returnRate: returnBaseTwd > EPSILON ? profitTwd / returnBaseTwd : null,
    nativeReturnRate: returnBaseNative > EPSILON ? profitNative / returnBaseNative : null,
    xirr: xirr(cashflows),
    nativeXirr: xirr(nativeCashflows),
  };
}

export function calculatePortfolio(stocks, fxRate, today = localIsoDate()) {
  const positions = (stocks ?? []).map(stock => calculateStockMetrics(stock, fxRate, today));
  const summarize = rows => {
    const nativeCurrency = rows.length > 0 && rows.every(row => row.currency === rows[0].currency)
      ? rows[0].currency : null;
    const totals = rows.reduce((result, row) => ({
      currentValueTwd: result.currentValueTwd + row.currentValueTwd,
      netInvestedTwd: result.netInvestedTwd + row.netInvestedTwd,
      purchaseCostTwd: result.purchaseCostTwd + row.purchaseCostTwd,
      purchaseCostNative: result.purchaseCostNative + row.purchaseCostNative,
      dividendsTwd: result.dividendsTwd + row.dividendsTwd,
      stockProfitTwd: result.stockProfitTwd + row.stockProfitTwd,
      fxImpactTwd: result.fxImpactTwd + row.fxImpactTwd,
      realizedTwd: result.realizedTwd + row.realizedTwd,
      unrealizedTwd: result.unrealizedTwd + row.unrealizedTwd,
      transactions: result.transactions + row.transactions.length,
      holdings: result.holdings + (row.shares > EPSILON ? 1 : 0),
    }), { currentValueTwd: 0, netInvestedTwd: 0, purchaseCostTwd: 0, purchaseCostNative: 0, dividendsTwd: 0, stockProfitTwd: 0, fxImpactTwd: 0, realizedTwd: 0, unrealizedTwd: 0, transactions: 0, holdings: 0 });
    const cashflows = rows.flatMap(row => row.transactions.map(tx => ({ date: tx.date, amount: number(tx.twd) })));
    const nativeCashflows = nativeCurrency
      ? rows.flatMap(row => row.transactions.map(tx => ({ date: tx.date, amount: number(tx.amount) })))
      : [];
    const currentValueNative = nativeCurrency
      ? rows.reduce((sum, row) => sum + row.currentValueNative, 0) : null;
    const netInvestedNative = nativeCurrency
      ? rows.reduce((sum, row) => sum + row.netInvestedNative, 0) : null;
    const dividendsNative = nativeCurrency
      ? rows.reduce((sum, row) => sum + row.dividendsNative, 0) : null;
    const profitNative = nativeCurrency ? currentValueNative - netInvestedNative : null;
    const returnBaseTwd = totals.netInvestedTwd > EPSILON
      ? totals.netInvestedTwd : totals.purchaseCostTwd;
    const returnBaseNative = nativeCurrency
      ? (netInvestedNative > EPSILON ? netInvestedNative : totals.purchaseCostNative)
      : null;
    if (totals.currentValueTwd > 0) cashflows.push({ date: today, amount: totals.currentValueTwd });
    if (nativeCurrency && currentValueNative > 0) nativeCashflows.push({ date: today, amount: currentValueNative });
    return {
      ...totals, nativeCurrency, currentValueNative, netInvestedNative, dividendsNative, profitNative,
      profitTwd: totals.currentValueTwd - totals.netInvestedTwd,
      nativeReturnRate: nativeCurrency && returnBaseNative > EPSILON ? profitNative / returnBaseNative : null,
      returnRate: returnBaseTwd > EPSILON ? (totals.currentValueTwd - totals.netInvestedTwd) / returnBaseTwd : null,
      xirr: xirr(cashflows),
      nativeXirr: nativeCurrency ? xirr(nativeCashflows) : null,
    };
  };
  return {
    positions,
    // 分析口徑依結算幣別分組：AMSC 雖在美國市場交易，但台帳以 TWD 結算，歸到台股頁計算。
    tw: summarize(positions.filter(row => row.currency === 'TWD')),
    us: summarize(positions.filter(row => row.currency === 'USD')),
    all: summarize(positions),
  };
}

export function sortPortfolioPositions(rows, { criterion = 'marketValue', direction = 'desc', currency = 'TWD' } = {}) {
  const valueOf = stock => {
    if (criterion === 'profit') return currency === 'USD' ? stock.profitNative : stock.profitTwd;
    if (criterion === 'xirr') return currency === 'USD' ? stock.nativeXirr : stock.xirr;
    return stock.currentValueTwd;
  };
  const sign = direction === 'asc' ? 1 : -1;
  return [...(rows ?? [])].sort((a, b) => {
    const aRaw = valueOf(a);
    const bRaw = valueOf(b);
    const aValue = Number(aRaw);
    const bValue = Number(bRaw);
    const aValid = aRaw !== null && aRaw !== undefined && Number.isFinite(aValue);
    const bValid = bRaw !== null && bRaw !== undefined && Number.isFinite(bValue);
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && aValue !== bValue) return (aValue - bValue) * sign;
    return String(a.display ?? '').localeCompare(String(b.display ?? ''), 'zh-Hant');
  });
}
