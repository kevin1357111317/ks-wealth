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
    // 送出去的黃金（例如送父母）已經不是自己的部位了，只留買進紀錄。既然不再持有，
    // 期末就沒有對應的價值可以配對，所以一定也不能算進年化 —— 兩個旗標不容許互相矛盾。
    stillHeld: row.still_held !== false,
    includeInPerformance: row.include_in_performance !== false && row.still_held !== false,
    note: String(row.note ?? ''),
  };
}

// 每筆買進視為台幣流出，並在今天用目前金價加上保留工錢做最後一筆流入。
// 工錢已包含在買進成本，期末價值依使用者的資產估值口徑加回。
export function calculateGold(transactions, goldItems, today = localIsoDate()) {
  const rows = (transactions ?? []).map(normalizeGoldTransaction)
    .filter(row => row.date && row.costTwd > 0 && row.grams > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || number(a.id) - number(b.id));
  const items = (goldItems ?? []).filter(item => String(item.market ?? '').toUpperCase() === 'GOLD');
  const holdingGrams = items.reduce((sum, item) => sum + Math.max(0, number(item.quantity)), 0);
  const currentValueTwd = items.reduce((sum, item) => sum + Math.max(0, number(item.amount_twd)), 0);
  const pricePerGram = holdingGrams > 0 ? currentValueTwd / holdingGrams : 0;
  // 送出去的那幾筆完全不進部位：資產頁的重量已經是扣掉之後的數字，核對也只比對還持有的。
  const heldRows = rows.filter(row => row.stillHeld);
  const givenRows = rows.filter(row => !row.stillHeld);
  const givenGrams = givenRows.reduce((sum, row) => sum + row.grams, 0);
  const givenCostTwd = givenRows.reduce((sum, row) => sum + row.costTwd, 0);
  const performanceRows = heldRows.filter(row => row.includeInPerformance);
  const excludedRows = heldRows.filter(row => !row.includeInPerformance);
  const trackedGrams = performanceRows.reduce((sum, row) => sum + row.grams, 0);
  const excludedGrams = excludedRows.reduce((sum, row) => sum + row.grams, 0);
  const trackedCostTwd = performanceRows.reduce((sum, row) => sum + row.costTwd, 0);
  const workmanshipTwd = heldRows.reduce((sum, row) => sum + row.workmanshipTwd, 0);
  const retainedWorkmanshipTwd = performanceRows.reduce((sum, row) => sum + row.workmanshipTwd, 0);
  const trackedValueTwd = pricePerGram > 0 ? trackedGrams * pricePerGram + retainedWorkmanshipTwd : 0;
  const trackedProfitTwd = trackedValueTwd - trackedCostTwd;
  const cashflows = performanceRows.map(row => ({ date: row.date, amount: -row.costTwd }));
  if (trackedValueTwd > 0) cashflows.push({ date: today, amount: trackedValueTwd });
  const accountedGrams = trackedGrams + excludedGrams;   // 還持有的那幾筆，送出的不算
  const untrackedGrams = Math.max(0, holdingGrams - accountedGrams);
  return {
    rows,
    holdingGrams,
    currentValueTwd,
    pricePerGram,
    trackedGrams,
    excludedGrams,
    givenGrams,
    givenCostTwd,
    givenTransactions: givenRows.length,
    trackedCostTwd,
    workmanshipTwd,
    retainedWorkmanshipTwd,
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
