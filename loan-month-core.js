export const LOAN_OWNERS = ['husband', 'wife'];
export const LOAN_TYPES = ['personal', 'topup', 'mortgage'];

export function loanMonthBucketKey(owner, loanType) {
  return `${owner}|${loanType}`;
}

export function summarizeRemainingMonth(accounts, rows) {
  const buckets = Object.fromEntries(LOAN_OWNERS.flatMap(owner =>
    LOAN_TYPES.map(loanType => [loanMonthBucketKey(owner, loanType), { total: 0, count: 0, nextDue: null }]),
  ));
  const accountBuckets = new Map();
  for (const account of accounts) {
    if (account?.status !== 'active') continue;
    const key = loanMonthBucketKey(account.owner_scope, account.loan_type);
    if (account.id && buckets[key]) accountBuckets.set(account.id, key);
  }
  const orderedRows = [...rows].sort((left, right) =>
    String(left.due_date || '').localeCompare(String(right.due_date || ''))
      || String(left.id || '').localeCompare(String(right.id || '')),
  );
  for (const row of orderedRows) {
    if (row?.applied_at) continue;
    const bucket = buckets[accountBuckets.get(row?.loan_account_id)];
    if (!bucket) continue;
    bucket.total += Math.abs(Number(row.amount_twd) || 0);
    bucket.count += 1;
    bucket.nextDue ||= row.actual_date || row.due_date || null;
  }
  return buckets;
}
