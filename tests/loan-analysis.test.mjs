import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../portfolio.css', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260907100000_loan_analysis.sql', import.meta.url), 'utf8');

test('loan analysis is a third per-owner analysis destination', () => {
  assert.match(app, /data-open-loans/);
  assert.match(app, /data-open-loans>貸款分析/);
  assert.match(app, /目前貸款餘額/);
  assert.match(app, /openAnalysis\('loans', ownerScope\)/);
  assert.match(app, /analysisScreen === 'loans'/);
  assert.match(css, /grid-template-columns:repeat\(3,1fr\)/);
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
