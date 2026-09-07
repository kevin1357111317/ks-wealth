import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateLoanCashflow } from '../loan-core.js';

const dateForMonth = n => new Date(Date.UTC(2026, 5 + n, 5)).toISOString().slice(0, 10);

test('富邦費用不算期數，並納入實際年化成本', () => {
  const rows = [
    { due_date: '2026-04-30', actual_date: '2026-04-30', amount_twd: 2600000, entry_type: 'disbursement', note: '貸款撥款' },
    { due_date: '2026-04-30', actual_date: '2026-04-30', amount_twd: -1688, entry_type: 'fee', note: '開辦費' },
  ];
  for (let n = 0; n < 84; n += 1) {
    const actual = n === 0 ? '2026-06-05'
      : n === 1 ? '2026-07-06'
        : n === 2 ? '2026-08-05'
          : n === 3 ? '2026-09-07'
            : null;
    rows.push({ due_date: dateForMonth(n), actual_date: actual, amount_twd: -33888, entry_type: 'payment' });
  }

  const result = calculateLoanCashflow(rows, '2026-09-07');
  assert.equal(result.grossProceeds, 2600000);
  assert.equal(result.totalFees, 1688);
  assert.equal(result.netProceeds, 2598312);
  assert.equal(result.payments.length, 84, '開辦費不能算成一期');
  assert.equal(result.pastPayments.length, 4);
  assert.equal(result.upcoming.length, 80);
  assert.equal(result.paidPayments, 135552);
  assert.equal(result.remaining, 2711040);
  assert.equal(result.totalInterestAndFees, 248280);
  assert.equal(result.next.due_date, '2026-10-05');
  assert.ok(Math.abs(result.annualCost - 0.026362188059457878) < 1e-10,
    'XIRR 要包含開辦費及實際扣款日期');
});

test('沒有實際扣款日的舊資料明確視為已到期排程', () => {
  const result = calculateLoanCashflow([
    { due_date: '2024-01-05', amount_twd: 3000000, entry_type: 'disbursement' },
    { due_date: '2024-01-05', amount_twd: -888, entry_type: 'fee' },
    { due_date: '2024-02-05', amount_twd: -38276, entry_type: 'payment' },
    { due_date: '2027-02-05', amount_twd: -38276, entry_type: 'payment' },
  ], '2026-09-07');
  assert.equal(result.fees.length, 1);
  assert.equal(result.pastPayments.length, 1);
  assert.equal(result.upcoming.length, 1);
});
