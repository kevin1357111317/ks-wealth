import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../portfolio.css', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260907100000_loan_analysis.sql', import.meta.url), 'utf8');
const futureBank = await readFile(new URL('../supabase/migrations/20260908090000_future_bank_verified_loan.sql', import.meta.url), 'utf8');

test('loan analysis is a third per-owner analysis destination', () => {
  assert.match(app, /data-open-loans/);
  assert.match(app, /data-open-loans>貸款分析/);
  assert.match(app, /目前貸款餘額/);
  assert.match(app, /let loanTypeFilter = 'personal'/);
  assert.match(app, /data-loan-type="personal"/);
  assert.match(app, /data-loan-type="topup"/);
  assert.match(app, /data-loan-type="mortgage"/);
  assert.match(app, /normalizedLoanType\(account\) === loanTypeFilter/);
  assert.match(app, /openAnalysis\('loans', ownerScope\)/);
  assert.match(app, /analysisScreen === 'loans'/);
  assert.match(css, /grid-template-columns:repeat\(3,1fr\)/);
  assert.doesNotMatch(css, /\.loanSummary \.portfolioMetric:first-child\{grid-column:1\/-1\}/);
});

test('current balances reuse financial items instead of being counted twice', () => {
  assert.match(app, /items\.find\(item => item\.id === account\.financial_item_id\)/);
  assert.match(migration, /financial_item_id uuid unique references public\.financial_items/);
});

test('loan records are household-protected and indexed', () => {
  assert.match(migration, /alter table public\.loan_accounts enable row level security/);
  assert.match(migration, /hm\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /loan_accounts_household_idx/);
});

test('夫妻往來不再顯示，將來銀行以銀行畫面資料為準', () => {
  assert.doesNotMatch(app, /夫妻貸款結清紀錄|loanEventTimeline|from\('loan_events'\)/);
  assert.match(futureBank, /original_principal_twd = 7010000/);
  assert.match(futureBank, /amount_twd = 6750371/);
  assert.match(futureBank, /contractual_monthly_payment_twd = 65706/);
  assert.match(futureBank, /maturity_date = date '2036-03-23'/);
  assert.match(futureBank, /generate_series\(0, 119\)/);
  assert.match(futureBank, /s\.n between 0 and 4/);
});
