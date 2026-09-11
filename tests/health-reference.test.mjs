// 健檢報告每年換實驗室，同一個指標會出現不同參考區間（飯前血糖 70–99 vs 70–100、
// MCV 80–95 vs 80–100），並排比較時圖上就會多出一堆看不懂的參考線。
// 這支測試守的是：統一成國際通用標準之後，男女共用的指標只剩一組數字，
// 男女本來就有別的指標仍然分開，而且狀態要跟著新區間重算。
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHealthModel } from '../health-core.js';
import { applyHealthReferenceSpec, healthReferenceSpec } from '../health-reference.js';

const model = (ownerScope, metrics) => buildHealthModel(
  [{ id: 'latest', owner_scope: ownerScope, checkup_year: 2026 }],
  metrics.map(metric => ({ checkup_id: 'latest', ...metric })),
  ownerScope,
);

test('男女共用的指標只留一組國際標準區間', () => {
  const husband = model('husband', [
    { metric_key: 'fasting_glucose', value_numeric: 89, reference_low: 70, reference_high: 99, status: 'normal' },
    { metric_key: 'mcv', value_numeric: 88.8, reference_low: 81, reference_high: 97, status: 'normal' },
  ]);
  const wife = model('wife', [
    { metric_key: 'fasting_glucose', value_numeric: 82, reference_low: 70, reference_high: 100, status: 'normal' },
    { metric_key: 'mcv', value_numeric: 72.3, reference_low: 80, reference_high: 100, status: 'low' },
  ]);
  const range = (person, key) => {
    const metric = person.metric(person.latest, key);
    return [metric.reference_low, metric.reference_high];
  };
  assert.deepEqual(range(husband, 'fasting_glucose'), [70, 99]);
  assert.deepEqual(range(wife, 'fasting_glucose'), [70, 99]);
  assert.deepEqual(range(husband, 'mcv'), [80, 100]);
  assert.deepEqual(range(wife, 'mcv'), [80, 100]);
});

test('男女本來就不同的指標維持各自的標準', () => {
  assert.deepEqual(
    ['hemoglobin', 'alt', 'creatinine', 'hdl_c', 'uric_acid'].map(key => [
      healthReferenceSpec(key, 'husband').low, healthReferenceSpec(key, 'husband').high,
      healthReferenceSpec(key, 'wife').low, healthReferenceSpec(key, 'wife').high,
    ]),
    [
      [13.5, 17.5, 12, 15.5],
      [null, 33, null, 25],
      [0.74, 1.35, 0.59, 1.04],
      [40, null, 50, null],
      [3.4, 7, 2.4, 6],
    ],
  );
  // 精液分析只有男性有；不能因為找不到女性標準就掉回 both。
  assert.equal(healthReferenceSpec('semen_concentration', 'wife'), null);
  assert.equal(healthReferenceSpec('semen_concentration', 'husband').low, 16);
});

test('狀態跟著統一區間重算，不留報告原本的判定', () => {
  const wife = model('wife', [
    // 原報告用 26–34 判 low，統一標準 27–33 之後仍然偏低。
    { metric_key: 'mch', value_numeric: 21.1, reference_low: 26, reference_high: 34, status: 'low' },
    // 原報告用女性 3.9–5.4 判 high，國際標準 4.0–5.2 一樣偏高。
    { metric_key: 'rbc', value_numeric: 5.64, reference_low: 3.9, reference_high: 5.4, status: 'high' },
  ]);
  const husband = model('husband', [
    // 這家實驗室的 ANC 下限抓 1.85 判 low；國際常用下限是 1.5，屬正常。
    { metric_key: 'anc', value_numeric: 1.76, reference_low: 1.85, reference_high: 6.72, status: 'low' },
    { metric_key: 'wbc', value_numeric: 3.58, reference_low: 4, reference_high: 10, status: 'low' },
  ]);
  assert.equal(wife.metric(wife.latest, 'mch').status, 'low');
  assert.equal(wife.metric(wife.latest, 'rbc').status, 'high');
  assert.equal(husband.metric(husband.latest, 'anc').status, 'normal');
  assert.equal(husband.metric(husband.latest, 'wbc').status, 'low');
});

test('沒有國際統一標準的項目保留原報告數值', () => {
  // CEA、CA19-9、PSA 這些是方法決定的切點，不能拿別家的硬套。
  const husband = model('husband', [
    { metric_key: 'cea', value_numeric: 1.2, reference_low: 0, reference_high: 4.7, status: 'normal' },
  ]);
  const metric = husband.metric(husband.latest, 'cea');
  assert.equal(metric.reference_high, 4.7);
  assert.equal(metric.status, 'normal');
});

test('AFP 兩邊的實驗室切點不同，統一成 0–10', () => {
  const husband = model('husband', [
    { metric_key: 'afp', value_numeric: 5.73, reference_low: 0, reference_high: 7, status: 'normal' },
  ]);
  const wife = model('wife', [
    { metric_key: 'afp', value_numeric: 12, reference_low: null, reference_high: 9, status: 'high' },
  ]);
  const his = husband.metric(husband.latest, 'afp');
  const hers = wife.metric(wife.latest, 'afp');
  assert.deepEqual([his.reference_low, his.reference_high, his.status], [0, 10, 'normal']);
  assert.deepEqual([hers.reference_low, hers.reference_high, hers.status], [0, 10, 'high']);
});

test('直接膽紅素補上 0 下限，只有偏高會被標出來', () => {
  const husband = model('husband', [
    { metric_key: 'direct_bilirubin', value_numeric: 0.6, reference_low: 0.1, reference_high: 0.5, status: 'high' },
  ]);
  const metric = husband.metric(husband.latest, 'direct_bilirubin');
  assert.deepEqual([metric.reference_low, metric.reference_high, metric.status], [0, 0.3, 'high']);
  // 0.1 在某些實驗室的下限上，但直接膽紅素低沒有臨床意義，不能標成偏低。
  const low = model('husband', [
    { metric_key: 'direct_bilirubin', value_numeric: 0.05, reference_low: 0.1, reference_high: 0.5, status: 'low' },
  ]);
  assert.equal(low.metric(low.latest, 'direct_bilirubin').status, 'normal');
});

test('只有文字結果的項目不會被改寫', () => {
  const metric = { metric_key: 'urine_protein', value_text: 'Negative', value_numeric: null, status: 'positive' };
  assert.equal(applyHealthReferenceSpec(metric, 'wife'), metric);
});
