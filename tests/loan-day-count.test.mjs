// 拆本金／利息要照各家銀行自己的算法，而且寬限期內本金不能動。
//
// 玉山的鼎宇房貸是「年利率 ÷ 12」：每個月不管幾天都固定 43,219 就是證據 ——
// 23,790,000 × 2.18% ÷ 12 = 43,218.5，四捨五入剛好是 App 上的數字。其他信貸則是
// actual/365（元大、富邦、將來從撥款日重播到今天都完全對得上）。同一套公式套兩家
// 會差幾百塊，所以 loan_accounts 記 interest_day_count。
//
// 這支測純算法，不開瀏覽器。
import assert from 'node:assert/strict';
import test from 'node:test';
import { db, applyDueLoanPayments } from './support/fake-supabase.js';

function seed({ dayCount, graceUntil, rate, principal, payment, dues }) {
  db.financial_items.length = 0;
  db.loan_accounts.length = 0;
  db.loan_schedule.length = 0;
  db.financial_items.push({ id: 'fi', household_id: 'H1', kind: 'liability', category: '房貸',
    name: '測試貸款', owner_scope: 'husband', amount_twd: principal, interest_rate: rate, sort_order: 0 });
  db.loan_accounts.push({ id: 'L', household_id: 'H1', owner_scope: 'husband', financial_item_id: 'fi',
    source_key: 'test', lender: '測試銀行', name: '測試貸款', loan_type: 'mortgage',
    original_principal_twd: principal, nominal_annual_rate: rate, contractual_monthly_payment_twd: payment,
    start_date: '2024-03-01', grace_until: graceUntil, interest_day_count: dayCount,
    status: 'active', autopay: true, last_payment_applied_on: null });
  dues.forEach(due => db.loan_schedule.push({
    loan_account_id: 'L', due_date: due, amount_twd: -payment, entry_type: 'payment' }));
}

test('年利率 ÷ 12：每個月的利息一樣，跟那個月幾天無關', () => {
  // 天數不同的三個月：31 天、28 天、31 天
  seed({ dayCount: 'month12', graceUntil: null, rate: 2.18, principal: 11895000,
    payment: 21609.5, dues: ['2024-04-05', '2024-05-05', '2024-06-05'] });
  const applied = applyDueLoanPayments('2024-06-30');
  assert.equal(applied.length, 3);
  // 11,895,000 × 2.18% ÷ 12 = 21,609.25 -> 21,609
  assert.equal(applied[0].interest_twd, 21609);
  // 本金一開始只還 21,609.5 − 21,609 = 0.5 -> 1（四捨五入），餘額幾乎沒動，
  // 所以後面兩期的利息還是同一個數字
  assert.deepEqual(applied.map(row => row.interest_twd), [21609, 21609, 21609]);
});

test('actual/365：利息跟兩次繳款日相隔幾天有關', () => {
  seed({ dayCount: 'act365', graceUntil: null, rate: 2.18, principal: 11895000,
    payment: 21609.5, dues: ['2024-04-05', '2024-05-05', '2024-06-05'] });
  const applied = applyDueLoanPayments('2024-06-30');
  // 2024-03-01 -> 04-05 是 35 天，04-05 -> 05-05 是 30 天：兩期的利息不該一樣
  assert.notEqual(applied[0].interest_twd, applied[1].interest_twd);
  assert.equal(applied[0].interest_twd, Math.round(11895000 * 2.18 / 100 * 35 / 365));
});

test('寬限期內只繳息，本金一塊都不動', () => {
  const dues = [];
  for (let i = 0; i < 35; i += 1) {
    const month = 4 + i;
    dues.push(`${2024 + Math.floor((month - 1) / 12)}-${String((month - 1) % 12 + 1).padStart(2, '0')}-05`);
  }
  assert.equal(dues[0], '2024-04-05');
  assert.equal(dues[34], '2027-02-05', '寬限期最後一期');
  seed({ dayCount: 'month12', graceUntil: '2027-03-01', rate: 2.18, principal: 11895000,
    payment: 21609.5, dues });
  const applied = applyDueLoanPayments('2027-02-28');
  assert.equal(applied.length, 35);
  assert.ok(applied.every(row => row.principal_twd === 0), '寬限期內本金一律 0');
  assert.equal(db.financial_items[0].amount_twd, 11895000, '餘額跟 App 上的「本金已償還 0%」一樣');
});

test('出了寬限期就開始還本金', () => {
  seed({ dayCount: 'month12', graceUntil: '2027-03-01', rate: 2.18, principal: 11895000,
    payment: 48494, dues: ['2027-03-05'] });
  db.loan_accounts[0].last_payment_applied_on = '2027-02-05';
  const applied = applyDueLoanPayments('2027-03-31');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].interest_twd, 21609);
  assert.equal(applied[0].principal_twd, 48494 - 21609);
  assert.equal(db.financial_items[0].amount_twd, 11895000 - (48494 - 21609));
});

