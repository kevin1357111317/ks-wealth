import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGold } from '../gold-core.js';
import { readFile } from 'node:fs/promises';

const klfan = [
  ['2025-08-21', 332157, 100, 'UBS', 0],
  ['2025-12-17', 141246, 31.1035, 'PAMP 女神', 0],
  ['2025-12-18', 12284, 2.5, 'PAMP 女神', 0],
  ['2025-12-18', 12284, 2.5, 'PAMP 女神', 0],
  ['2026-01-22', 52696, 6, 'PAMP 星座', 23080],
  ['2026-01-22', 158979, 31.1035, 'PAMP 女神', 0],
].map((row, index) => ({ id: index + 1, trade_date: row[0], cost_twd: row[1], grams: row[2], name: row[3], valuation_premium_twd: row[4] }));

test('依 KLFAN 黃金交易重算，不沿用漏掉兩筆 2.5g 的舊快取', () => {
  const model = calculateGold(klfan, [{ market: 'GOLD', quantity: 193.3105, amount_twd: 850558 }], '2026-09-09');
  assert.equal(model.transactions, 6);
  assert.equal(model.trackedGrams, 173.207);
  assert.equal(model.trackedCostTwd, 709646);
  assert.equal(model.retainedPremiumTwd, 23080);
  assert.ok(Math.abs(model.untrackedGrams - 20.1035) < 0.000001);
  assert.equal(model.reconciled, false);
  assert.ok(model.xirr > 0);
});

test('重量相符時標示已核對', () => {
  const model = calculateGold([
    { trade_date: '2025-12-05', cost_twd: 136474, grams: 31.1035, name: 'PAMP 馬年' },
  ], [{ market: 'GOLD', quantity: 31.1035, amount_twd: 136854 }], '2026-09-09');
  assert.equal(model.reconciled, true);
  assert.equal(model.untrackedGrams, 0);
});

test('黃金分析入口、資料表與頁面已接進 App', async () => {
  const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../supabase/migrations/20260909010000_gold_analysis.sql', import.meta.url), 'utf8');
  assert.match(app, /data-open-gold>黃金分析/);
  assert.match(app, /openAnalysis\('gold', ownerScope\)/);
  assert.match(app, /analysisScreen === 'gold'/);
  assert.match(app, /from\('gold_transactions'\)/);
  assert.match(app, /尚有 .*缺少買進成本/);
  assert.match(migration, /create table if not exists public\.gold_transactions/);
  assert.match(migration, /grant select, insert, update, delete on public\.gold_transactions to authenticated/);
});
