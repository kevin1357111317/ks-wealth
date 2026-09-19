import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  INSURANCE_NOTE_PREFIX,
  calculateInsuranceSummary,
  decodeInsuranceNote,
  groupInsurancePolicies,
  insurancePoliciesFromItems,
} from '../insurance-core.js';

const note = policies => `${INSURANCE_NOTE_PREFIX}${JSON.stringify({ v: 1, policies })}`;

const app = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('保險分析入口、畫面與獨立樣式已接進正式 App', () => {
  assert.match(app, /data-open-insurance aria-label="保險分析">保險/);
  assert.match(app, /analysisScreen === 'insurance'/);
  assert.match(app, /calculateInsuranceSummary\(items, analysisOwner\)/);
  assert.match(index, /insurance\.css\?v=V3\.36\.2/);
});

test('只解析有版本標記的保單 notes，壞資料不拖垮資產頁', () => {
  assert.equal(decodeInsuranceNote('一般備註'), null);
  assert.equal(decodeInsuranceNote(`${INSURANCE_NOTE_PREFIX}{bad`), null);
  assert.equal(decodeInsuranceNote(note([])).v, 1);
});

test('同一保險資產列可以拆成多張有效主約', () => {
  const rows = [{
    id: 'provider-a', kind: 'asset', category: '保險', owner_scope: 'husband', name: '測試保險',
    notes: note([
      { id: 'a', name: '保障甲', status: 'active_paying', annualPremium: 10, coverage: ['medical'] },
      { id: 'b', name: '保障乙', status: 'active_paid_up', coverage: ['life'] },
    ]),
  }];
  const policies = insurancePoliciesFromItems(rows, 'husband');
  assert.deepEqual(policies.map(policy => policy.name), ['保障甲', '保障乙']);
});

test('同一保險公司的保單整合顯示但仍保留逐張計數', () => {
  const policies = [
    { insurer: '南山人壽', status: 'active_paying', nextDue: '2027-05-06' },
    { insurer: '新光人壽', status: 'active_paying', nextDue: '2027-05-12' },
    { insurer: '南山人壽', status: 'active_paid_up', nextDue: null },
  ];
  const groups = groupInsurancePolicies(policies);
  assert.deepEqual(groups.map(group => group.insurer), ['南山人壽', '新光人壽']);
  assert.equal(groups[0].activePolicies, 2);
  assert.equal(groups[0].payingPolicies, 1);
  assert.equal(groups[0].paidUpPolicies, 1);
});

test('淨資產只加 financial_items 現金價值，不把保額加進去', () => {
  const rows = [{
    id: 'provider-a', kind: 'asset', category: '保險', owner_scope: 'husband', name: '測試保險',
    amount_twd: 200,
    notes: note([
      { name: '保障甲', status: 'active_paying', faceAmount: 9999, annualPremium: 10, riderAnnualPremium: 2, coverage: ['cancer'], missing: ['附約額度'] },
      { name: '保障乙', status: 'active_paid_up', faceAmount: 8888, coverage: ['life'] },
    ]),
  }];
  const summary = calculateInsuranceSummary(rows, 'husband');
  assert.equal(summary.cashValueTwd, 200);
  assert.equal(summary.knownAnnualPremium, 12);
  assert.equal(summary.activePolicies, 2);
  assert.equal(summary.payingPolicies, 1);
  assert.equal(summary.missingFields, 1);
  assert.equal(summary.coverage.has('cancer'), true);
});
