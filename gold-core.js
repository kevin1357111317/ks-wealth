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
    premiumTwd: Math.max(0, number(row.valuation_premium_twd)),
    note: String(row.note ?? ''),
  };
}

// KLFAN 的黃金頁把每筆買進視為台幣流出，並在今天用目前價值做最後一筆流入。
// 收藏品工錢依原表邏輯保留在目前價值裡，但不重複加進成本。
export function calculateGold(transactions, goldItems, today = localIsoDate()) {
  const rows = (transactions ?? []).map(normalizeGoldTransaction)
    .filter(row => row.date && row.costTwd > 0 && row.grams > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || number(a.id) - number(b.id));
  const items = (goldItems ?? []).filter(item => String(item.market ?? '').toUpperCase() === 'GOLD');
  const holdingGrams = items.reduce((sum, item) => sum + Math.max(0, number(item.quantity)), 0);
  const currentValueTwd = items.reduce((sum, item) => sum + Math.max(0, number(item.amount_twd)), 0);
  const pricePerGram = holdingGrams > 0 ? currentValueTwd / holdingGrams : 0;
  const trackedGrams = rows.reduce((sum, row) => sum + row.grams, 0);
  const trackedCostTwd = rows.reduce((sum, row) => sum + row.costTwd, 0);
  const retainedPremiumTwd = rows.reduce((sum, row) => sum + row.premiumTwd, 0);
  const trackedValueTwd = pricePerGram > 0 ? trackedGrams * pricePerGram + retainedPremiumTwd : 0;
  const trackedProfitTwd = trackedValueTwd - trackedCostTwd;
  const cashflows = rows.map(row => ({ date: row.date, amount: -row.costTwd }));
  if (trackedValueTwd > 0) cashflows.push({ date: today, amount: trackedValueTwd });
  const untrackedGrams = Math.max(0, holdingGrams - trackedGrams);
  return {
    rows,
    holdingGrams,
    currentValueTwd,
    pricePerGram,
    trackedGrams,
    trackedCostTwd,
    retainedPremiumTwd,
    trackedValueTwd,
    trackedProfitTwd,
    trackedReturnRate: trackedCostTwd > 0 ? trackedProfitTwd / trackedCostTwd : null,
    xirr: xirr(cashflows),
    untrackedGrams,
    reconciled: Math.abs(holdingGrams - trackedGrams) < 0.0001,
    transactions: rows.length,
    firstTradeDate: rows[0]?.date ?? null,
  };
}
