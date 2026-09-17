const DAY_MS = 86_400_000;

const n = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const daysBetween = (startDate, endDate) =>
  Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS);

export function xirr(cashflows) {
  const flows = (cashflows ?? []).filter(flow => flow.date && Number.isFinite(Number(flow.amount)))
    .map(flow => ({ date: String(flow.date), amount: Number(flow.amount) }));
  if (!flows.some(flow => flow.amount > 0) || !flows.some(flow => flow.amount < 0)) return null;
  const base = flows.reduce((earliest, flow) => flow.date < earliest ? flow.date : earliest, flows[0].date);
  const baseMs = Date.parse(`${base}T00:00:00Z`);
  const npv = rate => flows.reduce((sum, flow) => {
    const years = (Date.parse(`${flow.date}T00:00:00Z`) - baseMs) / DAY_MS / 365;
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
      for (let index = 0; index < 200; index += 1) {
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

export function annualizeReturn(cumulativeReturn, startDate, endDate) {
  const days = startDate && endDate ? daysBetween(startDate, endDate) : 0;
  const growth = 1 + Number(cumulativeReturn);
  if (days < 365 || !Number.isFinite(growth) || growth <= 0) return null;
  return growth ** (365 / days) - 1;
}

const snapshotValue = (snapshot, market) => market === 'tw' ? n(snapshot?.twTwd)
  : market === 'us' ? n(snapshot?.usUsd)
    : n(snapshot?.twTwd) + n(snapshot?.usTwd);

const externalFlow = (flow, market) => market === 'tw' ? n(flow?.twTwd)
  : market === 'us' ? n(flow?.usUsd)
    : n(flow?.twTwd) + n(flow?.usTwd);

const latestIndexOnOrBefore = (series, date, field) => {
  const rows = series ?? [];
  let low = 0;
  let high = rows.length - 1;
  let hit = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].date <= date) {
      hit = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  while (hit >= 0) {
    const value = rows[hit]?.[field];
    if (Number.isFinite(value) && value > 0) return value;
    hit -= 1;
  }
  return null;
};

// 用同一組期初資金、投入與提款日期模擬 Benchmark。期間第一天以前的歷史
// 已濃縮成期初市值，避免把「全部」以外期間誤當成從零開始的新帳戶。
export function buildBenchmarkCashflows({ series, snapshots, flows, market }) {
  const rows = series ?? [];
  const first = rows[0];
  const last = rows.at(-1);
  const firstBenchmark = Number.isFinite(first?.benchmarkRaw) ? first.benchmarkRaw : first?.benchmark;
  const lastBenchmark = Number.isFinite(last?.benchmarkRaw) ? last.benchmarkRaw : last?.benchmark;
  if (!first || !last || !Number.isFinite(firstBenchmark) || !Number.isFinite(lastBenchmark)) return null;
  const startSnapshot = (snapshots ?? []).find(row => row.date === first.date);
  const endSnapshot = [...(snapshots ?? [])].reverse().find(row => row.date === last.date);
  const startingValue = snapshotValue(startSnapshot, market);
  const endingValue = snapshotValue(endSnapshot, market);
  if (!(startingValue > 0) || !(endingValue > 0) || !(firstBenchmark > 0)) return null;

  const datedFlows = Object.entries(flows ?? {})
    .filter(([date]) => date > first.date && date <= last.date)
    .map(([date, flow]) => ({ date, amount: externalFlow(flow, market) }))
    .filter(flow => Math.abs(flow.amount) > 1e-9)
    .sort((a, b) => a.date.localeCompare(b.date));
  const portfolioCashflows = [{ date: first.date, amount: -startingValue },
    ...datedFlows.map(flow => ({ date: flow.date, amount: -flow.amount })),
    { date: last.date, amount: endingValue }];

  let benchmarkUnits = startingValue / firstBenchmark;
  for (const flow of datedFlows) {
    const benchmarkIndex = latestIndexOnOrBefore(rows, flow.date, 'benchmarkRaw')
      ?? latestIndexOnOrBefore(rows, flow.date, 'benchmark');
    if (!(benchmarkIndex > 0)) return null;
    benchmarkUnits += flow.amount / benchmarkIndex;
  }
  const benchmarkEndingValue = benchmarkUnits * lastBenchmark;
  const benchmarkCashflows = [{ date: first.date, amount: -startingValue },
    ...datedFlows.map(flow => ({ date: flow.date, amount: -flow.amount })),
    { date: last.date, amount: benchmarkEndingValue }];
  return { portfolioCashflows, benchmarkCashflows, benchmarkEndingValue, datedFlows };
}

export function summarizePerformance({ series, snapshots, flows, market, portfolioXirrOverride }) {
  const first = series?.[0];
  const last = series?.at(-1);
  if (!first || !last) return null;
  const days = daysBetween(first.date, last.date);
  const finalPortfolioIndex = Number.isFinite(last.portfolioRaw) ? last.portfolioRaw : last.portfolio;
  const finalBenchmarkIndex = Number.isFinite(last.benchmarkRaw) ? last.benchmarkRaw : last.benchmark;
  const portfolioCumulativeTwr = Number.isFinite(finalPortfolioIndex) ? finalPortfolioIndex / 100 - 1 : null;
  const benchmarkCumulativeTwr = Number.isFinite(finalBenchmarkIndex) ? finalBenchmarkIndex / 100 - 1 : null;
  const portfolioAnnualizedTwr = portfolioCumulativeTwr === null ? null
    : annualizeReturn(portfolioCumulativeTwr, first.date, last.date);
  const benchmarkAnnualizedTwr = benchmarkCumulativeTwr === null ? null
    : annualizeReturn(benchmarkCumulativeTwr, first.date, last.date);
  const comparableCashflows = buildBenchmarkCashflows({ series, snapshots, flows, market });
  const portfolioXirr = portfolioXirrOverride !== undefined ? portfolioXirrOverride
    : comparableCashflows ? xirr(comparableCashflows.portfolioCashflows) : null;
  const benchmarkXirr = comparableCashflows ? xirr(comparableCashflows.benchmarkCashflows) : null;
  return {
    startDate: first.date,
    endDate: last.date,
    days,
    portfolioCumulativeTwr,
    benchmarkCumulativeTwr,
    portfolioAnnualizedTwr,
    benchmarkAnnualizedTwr,
    annualizedExcess: portfolioAnnualizedTwr === null || benchmarkAnnualizedTwr === null
      ? null : portfolioAnnualizedTwr - benchmarkAnnualizedTwr,
    portfolioXirr,
    benchmarkXirr,
    xirrGap: portfolioXirr === null || benchmarkXirr === null ? null : portfolioXirr - benchmarkXirr,
    externalCashflowCount: comparableCashflows?.datedFlows.length ?? 0,
  };
}
