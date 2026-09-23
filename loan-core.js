import { xirr } from './portfolio-core.js';

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const kindOf = row => row.entry_type
  || (number(row.amount_twd) > 0 ? 'disbursement' : 'payment');

export function calculateLoanCashflow(rows, today) {
  const date = String(today);
  const entries = (rows ?? []).filter(row => row?.due_date && number(row.amount_twd) !== 0)
    .map((row, index) => ({
      ...row,
      index,
      type: kindOf(row),
      amount: number(row.amount_twd),
      effectiveDate: String(row.actual_date || row.due_date),
    }))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.index - b.index);
  const payments = entries.filter(row => row.type === 'payment');
  const fees = entries.filter(row => row.type === 'fee');
  const inflows = entries.filter(row => row.type === 'disbursement' || (row.type === 'adjustment' && row.amount > 0));
  // actual_date 是銀行核對後的實際扣款日；applied_at 是系統已把本期本金套用到
  // 負債餘額的憑證。到期日當天只要已套用，就應立即列入過往繳款；尚未套用的
  // 當期款仍留在未來繳款，避免單靠日期冒充已扣款。
  const isPastPayment = row => row.actual_date
    ? String(row.actual_date) <= date
    : Boolean(row.applied_at) || row.due_date < date;
  const pastPayments = payments.filter(isPastPayment);
  const upcoming = payments.filter(row => !isPastPayment(row));
  const grossProceeds = inflows.reduce((sum, row) => sum + Math.max(0, row.amount), 0);
  const totalFees = fees.reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const totalPayments = payments.reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const paidPayments = pastPayments.reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const remaining = upcoming.reduce((sum, row) => sum + Math.abs(row.amount), 0);
  const annualCost = xirr(entries.map(row => ({ date: row.effectiveDate, amount: row.amount })));
  return {
    entries,
    payments,
    fees,
    inflows,
    pastPayments,
    upcoming,
    grossProceeds,
    netProceeds: grossProceeds - totalFees,
    totalFees,
    totalPayments,
    paidPayments,
    remaining,
    totalInterestAndFees: Math.max(0, totalPayments + totalFees - grossProceeds),
    annualCost,
    next: upcoming[0] ?? null,
    last: payments[payments.length - 1] ?? null,
  };
}
