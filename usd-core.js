// 美金部位的成本用「移動加權平均」算，跟 KLFAN 試算表的「美金」工作表同一套：
// 買進把台幣成本加進去、重算平均；賣出用當下的平均成本認列已實現匯兌損益，
// 平均成本本身不動。股票那邊用的是 FIFO，兩者刻意不共用。
import { localIsoDate, xirr } from './portfolio-core.js';

const EPSILON = 1e-9;

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// 台幣現金流的正負號：買進是流出（負）、賣出是流入（正），跟試算表一致。
export function normalizeUsdTransaction(row) {
  const usd = number(row.usd_amount);
  const twd = number(row.twd_amount);
  const rate = number(row.rate) || (Math.abs(usd) > EPSILON ? Math.abs(twd / usd) : 0);
  return {
    id: row.id ?? null,
    date: String(row.trade_date ?? row.date ?? ''),
    usd,
    twd,
    rate,
    note: row.note ?? '',
  };
}

// 逐筆跑一次，回傳每一筆當下的餘額、剩餘成本、平均成本與已實現損益，
// 對應試算表右邊那四欄。
export function usdRunningRows(transactions) {
  const rows = (transactions ?? []).map(normalizeUsdTransaction)
    .sort((a, b) => a.date.localeCompare(b.date) || number(a.id) - number(b.id));
  let balance = 0;
  let cost = 0;
  return rows.map(row => {
    let realized = 0;
    if (row.usd >= 0) {
      balance += row.usd;
      cost += -row.twd;
    } else {
      // 賣掉的部分帶走當下的平均成本，剩下的每一塊美金成本不變。
      const average = balance > EPSILON ? cost / balance : 0;
      const sold = Math.min(-row.usd, balance);
      realized = row.twd - average * sold;
      cost -= average * sold;
      balance += row.usd;
      if (balance < EPSILON) { balance = 0; cost = 0; }
    }
    return {
      ...row,
      realized,
      balance,
      cost,
      average: balance > EPSILON ? cost / balance : null,
    };
  });
}

export function calculateUsd(transactions, rate, today = localIsoDate()) {
  const rows = usdRunningRows(transactions);
  const last = rows[rows.length - 1] ?? null;
  const balance = last ? last.balance : 0;
  const remainingCostTwd = last ? last.cost : 0;
  const currentRate = number(rate);
  const marketValueTwd = balance * currentRate;
  const realizedTwd = rows.reduce((sum, row) => sum + row.realized, 0);
  // 還沒賣的部分，市值減成本就是未實現。出清了沒有未實現可言；匯率還沒抓到時
  // 市值是 0，這時算出來會是「整筆虧光」的假數字，寧可先不給。
  const priced = balance > EPSILON && currentRate > 0;
  const unrealizedTwd = priced ? marketValueTwd - remainingCostTwd : 0;
  // || 0 是為了把 -0 收掉：沒有交易時 -(0) 會印成「-0」。
  const netInvestedTwd = -rows.reduce((sum, row) => sum + row.twd, 0) || 0;
  const cashflows = rows.map(row => ({ date: row.date, amount: row.twd }));
  if (marketValueTwd > 0) cashflows.push({ date: today, amount: marketValueTwd });
  return {
    rows,
    balance,
    remainingCostTwd,
    averageCost: balance > EPSILON ? remainingCostTwd / balance : null,
    currentRate,
    marketValueTwd,
    realizedTwd,
    unrealizedTwd,
    totalProfitTwd: realizedTwd + unrealizedTwd,
    netInvestedTwd,
    transactions: rows.length,
    firstTradeDate: rows.length ? rows[0].date : null,
    xirr: xirr(cashflows),
  };
}
