import { xirr } from './portfolio-core.js?v=xirr-fast-1';

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
  const pastPayments = payments.filter(row => row.actual_date
    ? String(row.actual_date) <= date
    : row.due_date < date);
  const upcoming = payments.filter(row => row.actual_date
    ? String(row.actual_date) > date
    : row.due_date >= date);
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
