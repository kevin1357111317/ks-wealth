import assert from 'node:assert/strict';
import test from 'node:test';
import { LOAN_OWNERS, LOAN_TYPES, loanMonthBucketKey, summarizeRemainingMonth } from '../loan-month-core.js';

test('一次查回的貸款排程會依人與貸款類型正確分桶', () => {
  const accounts = [
    { id: 'h-personal', owner_scope: 'husband', loan_type: 'personal', status: 'active' },
    { id: 'w-mortgage', owner_scope: 'wife', loan_type: 'mortgage', status: 'active' },
    { id: 'closed', owner_scope: 'husband', loan_type: 'topup', status: 'closed' },
  ];
  const rows = [
    { id: '2', loan_account_id: 'h-personal', due_date: '2026-09-23', amount_twd: -1200 },
    { id: '1', loan_account_id: 'h-personal', due_date: '2026-09-12', actual_date: '2026-09-13', amount_twd: 800 },
    { id: '3', loan_account_id: 'w-mortgage', due_date: '2026-09-05', amount_twd: 30287 },
    { id: '4', loan_account_id: 'w-mortgage', due_date: '2026-09-06', amount_twd: 99, applied_at: '2026-09-06' },
    { id: '5', loan_account_id: 'closed', due_date: '2026-09-10', amount_twd: 5000 },
  ];
  const result = summarizeRemainingMonth(accounts, rows);
  assert.deepEqual(result['husband|personal'], { total: 2000, count: 2, nextDue: '2026-09-13' });
  assert.deepEqual(result['wife|mortgage'], { total: 30287, count: 1, nextDue: '2026-09-05' });
  assert.deepEqual(result['husband|topup'], { total: 0, count: 0, nextDue: null });
  assert.equal(Object.keys(result).length, LOAN_OWNERS.length * LOAN_TYPES.length);
  assert.equal(loanMonthBucketKey('wife', 'topup'), 'wife|topup');
});
