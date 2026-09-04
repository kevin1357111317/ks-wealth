import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260903000000_integrate_klfan_portfolio.sql', import.meta.url), 'utf8');

test('portfolio is loaded through the authenticated bootstrap RPC', () => {
  assert.match(app, /sb\.rpc\('klfan_bootstrap'\)/);
  assert.match(app, /decodePortfolioBootstrap/);
  assert.match(app, /calculatePortfolio/);
});

test('ledger and net-worth rows are explicitly linked to prevent double counting', () => {
  assert.match(migration, /add column if not exists portfolio_stock_key/);
  assert.match(migration, /financial_items_portfolio_stock_unique/);
  assert.match(app, /portfolio_stock_key: stockKey/);
});

test('household RLS protects stocks and transactions', () => {
  assert.match(migration, /klfan_stocks_member_select/);
  assert.match(migration, /klfan_transactions_member_insert/);
  assert.match(migration, /hm\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /security_invoker = true/);
});

test('ledger changes synchronize the existing financial aggregation row', () => {
  assert.match(migration, /sync_klfan_financial_item/);
  assert.match(migration, /klfan_transactions_sync_financial/);
  assert.match(migration, /klfan_quotes_sync_financial/);
  assert.match(migration, /klfan_fx_sync_financial/);
});
