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

test('LINE Bank 實際流水對上 25 次已繳與 72 次未繳', () => {
  const rows = [
    { due_date: '2024-08-20', actual_date: '2024-08-20', amount_twd: 3500000, entry_type: 'disbursement' },
    { due_date: '2024-08-20', actual_date: '2024-08-20', amount_twd: -888, entry_type: 'fee' },
    { due_date: '2024-09-05', actual_date: '2024-09-05', amount_twd: -20523, entry_type: 'payment', balance_after_twd: 3482822 },
  ];
  for (let n = 0; n < 95; n += 1) {
    const dueDate = new Date(Date.UTC(2024, 9 + n, 5)).toISOString().slice(0, 10);
    rows.push({
      due_date: dueDate,
      actual_date: dueDate <= '2026-09-05' ? dueDate : null,
      amount_twd: -39763,
      entry_type: 'payment',
      balance_after_twd: dueDate === '2026-09-05' ? 2663371 : null,
    });
  }
  rows.push({ due_date: '2032-08-20', amount_twd: -19278, entry_type: 'payment' });

  const result = calculateLoanCashflow(rows, '2026-09-07');
  assert.equal(result.payments.length, 97);
  assert.equal(result.pastPayments.length, 25);
  assert.equal(result.upcoming.length, 72);
  assert.equal(result.netProceeds, 3499112);
  assert.equal(result.totalFees, 888);
  assert.equal(result.next.due_date, '2026-10-05');
  assert.equal(result.last.due_date, '2032-08-20');
  assert.equal(result.pastPayments.at(-1).balance_after_twd, 2663371);
  assert.ok(Math.abs(result.annualCost - 0.022082550246961295) < 1e-10);
});
