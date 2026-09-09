import { localIsoDate, xirr } from './portfolio-core.js';

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function normalizeGoldTransaction(row) {
  return {
    id: row.id ?? null,
    date: String(row.trade_date ?? row.date ?? ''),
    costTwd: Math.max(0, number(row.cost_twd)),
    grams: Math.max(0, number(row.grams)),
    name: String(row.name ?? '黃金'),
    workmanshipTwd: Math.max(0, number(row.workmanship_twd)),
    includeInPerformance: row.include_in_performance !== false,
    note: String(row.note ?? ''),
  };
}

// 每筆買進視為台幣流出，並在今天用目前可變現金價做最後一筆流入。
// 工錢已包含在買進成本；沒有真實回售估價前，不假設工錢可以回收。
export function calculateGold(transactions, goldItems, today = localIsoDate()) {
  const rows = (transactions ?? []).map(normalizeGoldTransaction)
    .filter(row => row.date && row.costTwd > 0 && row.grams > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || number(a.id) - number(b.id));
  const items = (goldItems ?? []).filter(item => String(item.market ?? '').toUpperCase() === 'GOLD');
  const holdingGrams = items.reduce((sum, item) => sum + Math.max(0, number(item.quantity)), 0);
  const currentValueTwd = items.reduce((sum, item) => sum + Math.max(0, number(item.amount_twd)), 0);
  const pricePerGram = holdingGrams > 0 ? currentValueTwd / holdingGrams : 0;
  const performanceRows = rows.filter(row => row.includeInPerformance);
  const excludedRows = rows.filter(row => !row.includeInPerformance);
  const trackedGrams = performanceRows.reduce((sum, row) => sum + row.grams, 0);
  const excludedGrams = excludedRows.reduce((sum, row) => sum + row.grams, 0);
  const trackedCostTwd = performanceRows.reduce((sum, row) => sum + row.costTwd, 0);
  const workmanshipTwd = rows.reduce((sum, row) => sum + row.workmanshipTwd, 0);
  const trackedValueTwd = pricePerGram > 0 ? trackedGrams * pricePerGram : 0;
  const trackedProfitTwd = trackedValueTwd - trackedCostTwd;
  const cashflows = performanceRows.map(row => ({ date: row.date, amount: -row.costTwd }));
  if (trackedValueTwd > 0) cashflows.push({ date: today, amount: trackedValueTwd });
  const accountedGrams = trackedGrams + excludedGrams;
  const untrackedGrams = Math.max(0, holdingGrams - accountedGrams);
  return {
    rows,
    holdingGrams,
    currentValueTwd,
    pricePerGram,
    trackedGrams,
    excludedGrams,
    trackedCostTwd,
    workmanshipTwd,
    trackedValueTwd,
    trackedProfitTwd,
    trackedReturnRate: trackedCostTwd > 0 ? trackedProfitTwd / trackedCostTwd : null,
    xirr: xirr(cashflows),
    untrackedGrams,
    reconciled: Math.abs(holdingGrams - accountedGrams) < 0.0001,
    transactions: rows.length,
    performanceTransactions: performanceRows.length,
    firstTradeDate: rows[0]?.date ?? null,
  };
}
