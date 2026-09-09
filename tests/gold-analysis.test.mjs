import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGold } from '../gold-core.js';
import { readFile } from 'node:fs/promises';

// 送父母那兩筆各 2.5g 是 still_held = false：留在買進紀錄裡，但不算部位也不算年化。
// 資產頁的重量已經是扣掉之後的 199.3105 g。
const klfan = [
  ['2025-08-21', 332157, 100, 'UBS', 0, true],
  ['2025-12-17', 141246, 31.1035, 'PAMP 女神', 0, true],
  ['2025-12-18', 12284, 2.5, 'PAMP 女神', 0, false],
  ['2025-12-18', 12284, 2.5, 'PAMP 女神', 0, false],
  ['2026-01-22', 52696, 6, 'PAMP 星座', 23080, true],
  ['2026-01-22', 158979, 31.1035, 'PAMP 女神', 0, true],
  ['2026-08-11', 145594, 31.1035, 'PAMP 女神', 0, true],
].map((row, index) => ({ id: index + 1, trade_date: row[0], cost_twd: row[1], grams: row[2], name: row[3], workmanship_twd: row[4], still_held: row[5] }));

test('依 KLFAN 黃金交易重算，不沿用漏掉兩筆 2.5g 的舊快取', () => {
  const model = calculateGold(klfan, [{ market: 'GOLD', quantity: 199.3105, amount_twd: 882215 }], '2026-09-09');
  assert.equal(model.transactions, 7);
  assert.equal(model.heldTransactions, 5);
  assert.equal(model.performanceTransactions, 5);
  assert.equal(model.trackedGrams, 199.3105);
  assert.equal(model.excludedGrams, 0);
  assert.equal(model.trackedCostTwd, 830672);
  assert.equal(model.workmanshipTwd, 23080);
  assert.equal(model.retainedWorkmanshipTwd, 23080);
  assert.ok(Math.abs(model.trackedValueTwd - (882215 + 23080)) < 0.01);   // 全部持有都納入年化
  assert.equal(model.untrackedGrams, 0);
  assert.equal(model.reconciled, true);
  assert.ok(model.xirr > 0);
});

test('送出去的黃金不進部位、不進年化，但留在買進紀錄裡', () => {
  const model = calculateGold(klfan, [{ market: 'GOLD', quantity: 199.3105, amount_twd: 882215 }], '2026-09-09');
  // 送出的 5g、24,568 元成本兩邊都不算：核對只比對還持有的重量
  assert.equal(model.givenGrams, 5);
  assert.equal(model.givenCostTwd, 24568);
  assert.equal(model.givenTransactions, 2);
  assert.equal(model.reconciled, true, '資產頁 199.3105 g 要跟還持有的台帳對得起來');
  assert.equal(model.rows.length, 7, '紀錄留著');
  assert.equal(model.rows.filter(row => !row.stillHeld).length, 2);
  // 成本裡不能混進送出去的那 24,568
  assert.equal(model.trackedCostTwd, 830672);
  assert.ok(!model.rows.filter(row => !row.stillHeld).some(row => row.includeInPerformance),
    '送出去的一定不計年化，兩個旗標不能互相矛盾');
});

test('資產頁重量沒扣掉送出的部分就會抓出來', () => {
  // 舊資料的樣子：台帳說送掉 5g，資產頁卻還記 204.3105 g
  const model = calculateGold(klfan, [{ market: 'GOLD', quantity: 204.3105, amount_twd: 904345 }], '2026-09-09');
  assert.equal(model.reconciled, false);
  assert.equal(Math.round(model.untrackedGrams * 10000) / 10000, 5);
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
  const given = await readFile(new URL('../supabase/migrations/20260909120000_gold_given_away.sql', import.meta.url), 'utf8');
  assert.match(app, /data-open-gold>黃金分析/);
  assert.match(app, /openAnalysis\('gold', ownerScope\)/);
  assert.match(app, /analysisScreen === 'gold'/);
  assert.match(app, /from\('gold_transactions'\)/);
  assert.match(app, /尚有 .*缺少買進成本/);
  assert.match(app, /目前金價＋工錢/);
  assert.match(app, /不計入年化/);
  assert.match(app, /已送出，只留紀錄/);
  assert.match(migration, /create table if not exists public\.gold_transactions/);
  assert.match(migration, /grant select, insert, update, delete on public\.gold_transactions to authenticated/);
  // 資產頁的重量一定要跟著扣，不然核對那一格會一直喊少 5g
  assert.match(given, /add column if not exists still_held boolean not null default true/);
  assert.match(given, /still_held = false/);
  assert.match(given, /quantity = 199\.3105/);
});
