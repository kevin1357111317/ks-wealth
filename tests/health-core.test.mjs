import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHealthComparison,
  buildHealthDomains,
  buildHealthInsights,
  buildHealthModel,
  healthReferenceBoundaries,
  healthReferenceMarkers,
  healthReferenceState,
  selectCoupleHealthTrendGroups,
  selectHealthTrendKeys,
} from '../health-core.js';

const reports = [
  { id: 'older', owner_scope: 'wife', checkup_year: 2024 },
  { id: 'latest', owner_scope: 'wife', checkup_year: 2025 },
];
const metrics = [
  { checkup_id: 'older', metric_key: 'mcv', value_numeric: 88, status: 'normal' },
  { checkup_id: 'latest', metric_key: 'mcv', value_numeric: 70, status: 'low' },
  { checkup_id: 'latest', metric_key: 'hemoglobin', value_numeric: 11, status: 'low' },
  { checkup_id: 'latest', metric_key: 'rbc', value_numeric: 6, status: 'high' },
];

test('health history is grouped by owner and ordered for trends', () => {
  const model = buildHealthModel(reports, metrics, 'wife');
  assert.equal(model.latest.checkup_year, 2025);
  assert.deepEqual(model.series('mcv').map(point => point.year), [2024, 2025]);
  assert.equal(buildHealthModel(reports, metrics, 'husband').latest, null);
});

test('abnormal red-cell pattern creates a preconception follow-up, not a diagnosis', () => {
  const insights = buildHealthInsights(buildHealthModel(reports, metrics, 'wife'), 'wife');
  assert.match(insights[0].title, /釐清/);
  assert.match(insights[0].body, /可能/);
  assert.match(insights[0].action, /未證實缺鐵前不要自行/);
});

test('a missing metric in one year is skipped instead of breaking the trend', () => {
  const model = buildHealthModel(reports, [
    { checkup_id: 'latest', metric_key: 'afp', value_numeric: 12, status: 'high' },
  ], 'wife');
  assert.deepEqual(model.series('afp').map(point => point.year), [2025]);
});

test('a two-sided reference range keeps both lower and upper chart lines', () => {
  assert.deepEqual(healthReferenceBoundaries({ reference_low: 80, reference_high: 100 }), [80, 100]);
  assert.deepEqual(healthReferenceBoundaries({ reference_low: null, reference_high: 9 }), [9]);
  assert.deepEqual(healthReferenceMarkers({ reference_low: 80, reference_high: 100 }), [
    { kind: 'low', label: '下限', value: 80 },
    { kind: 'high', label: '上限', value: 100 },
  ]);
  assert.equal(healthReferenceState({ value_numeric: 72, reference_low: 80, reference_high: 100 }), '低於下限');
  assert.equal(healthReferenceState({ value_numeric: 90, reference_low: 80, reference_high: 100 }), '參考範圍內');
  assert.equal(healthReferenceState({ value_numeric: 110, reference_low: 80, reference_high: 100 }), '高於上限');
});

test('trend selection prioritizes abnormal metrics with two or more years', () => {
  const model = buildHealthModel(reports, [
    { checkup_id: 'older', metric_key: 'afp', value_numeric: 10.9, status: 'high' },
    { checkup_id: 'latest', metric_key: 'afp', value_numeric: 12, status: 'high' },
    { checkup_id: 'older', metric_key: 'hba1c', value_numeric: 5.2, status: 'normal' },
    { checkup_id: 'latest', metric_key: 'hba1c', value_numeric: 5.4, status: 'normal' },
  ], 'wife');
  assert.deepEqual(selectHealthTrendKeys(model, 'wife'), ['afp', 'hba1c']);
});

test('husband advice and domains use his actual follow-up items', () => {
  const husbandReports = [
    { id: 'h-2024', owner_scope: 'husband', checkup_year: 2024 },
    { id: 'h-2026', owner_scope: 'husband', checkup_year: 2026 },
  ];
  const husbandMetrics = [
    { checkup_id: 'h-2024', metric_key: 'wbc', value_numeric: 3.73, status: 'low' },
    { checkup_id: 'h-2026', metric_key: 'wbc', value_numeric: 3.93, status: 'low' },
    { checkup_id: 'h-2026', metric_key: 'neutrophil', value_numeric: 54.4, status: 'normal' },
    { checkup_id: 'h-2026', metric_key: 'total_bilirubin', value_numeric: 1.3, status: 'high' },
    { checkup_id: 'h-2026', metric_key: 'ldct_thymic_tissue', value_text: '需專科確認的影像發現', status: 'watch' },
    { checkup_id: 'h-2026', metric_key: 'ldct_pericardial_effusion', value_text: '需專科確認的影像發現', status: 'watch' },
    { checkup_id: 'h-2026', metric_key: 'thoracic_scoliosis', value_text: '胸椎脊柱側彎', status: 'watch' },
  ];
  const model = buildHealthModel(husbandReports, husbandMetrics, 'husband');
  const insights = buildHealthInsights(model, 'husband');
  assert.match(insights.map(row => row.title).join('、'), /白血球/);
  assert.match(insights.map(row => row.title).join('、'), /膽紅素/);
  assert.match(insights[0].title, /低劑量肺部 CT/);
  assert.match(insights[0].action, /胸腔科/);
  assert.match(insights.map(row => row.body).join('、'), /2\.14/);
  assert.deepEqual(buildHealthDomains(model, model.latest, 'husband').map(row => row.title), [
    '低劑量肺部 CT', '血液與免疫', '肝膽功能', '影像與結構',
  ]);
});

test('a low hemoglobin alone does not claim a microcytic pattern', () => {
  const model = buildHealthModel([
    { id: 'only', owner_scope: 'wife', checkup_year: 2026 },
  ], [
    { checkup_id: 'only', metric_key: 'hemoglobin', value_numeric: 11, status: 'low' },
    { checkup_id: 'only', metric_key: 'mcv', value_numeric: 88, status: 'normal' },
  ], 'wife');
  assert.doesNotMatch(buildHealthInsights(model, 'wife')[0].title, /小球性/);
});

test('couple comparison keeps both scores, dimensions and shared metrics', () => {
  const checkups = [
    { id: 'husband', owner_scope: 'husband', checkup_year: 2026 },
    { id: 'wife', owner_scope: 'wife', checkup_year: 2026 },
  ];
  const comparisonMetrics = [
    { checkup_id: 'husband', metric_key: 'management_score', value_numeric: 89, status: 'info' },
    { checkup_id: 'wife', metric_key: 'management_score', value_numeric: 84, status: 'info' },
    { checkup_id: 'husband', metric_key: 'score_blood', value_numeric: 17, status: 'info' },
    { checkup_id: 'wife', metric_key: 'score_blood', value_numeric: 14, status: 'info' },
    { checkup_id: 'husband', metric_key: 'hba1c', value_numeric: 5.4, status: 'normal' },
    { checkup_id: 'wife', metric_key: 'hba1c', value_numeric: 5.4, status: 'normal' },
  ];
  const result = buildHealthComparison(
    buildHealthModel(checkups, comparisonMetrics, 'husband'),
    buildHealthModel(checkups, comparisonMetrics, 'wife'),
  );
  assert.equal(result.husband.score, 89);
  assert.equal(result.wife.score, 84);
  assert.equal(result.husband.dimensions.find(row => row.key === 'score_blood').metric.value_numeric, 17);
  assert.equal(result.wife.dimensions.find(row => row.key === 'score_blood').metric.value_numeric, 14);
  assert.deepEqual(result.metrics.map(row => row.key), ['hba1c']);
});

test('three annual checkups render three-point trends and trend-aware advice', () => {
  const checkups = [2024, 2025, 2026].map(year => ({ id: `h-${year}`, owner_scope: 'husband', checkup_year: year }));
  // 白血球要真的低於統一標準下限（4.0）才算異常 —— 狀態現在是依數值重算的，
  // 報告上寫 low 但數值在區間內不會再被當成異常。
  const values = {
    2024: { wbc: 3.73, anc: 2.2, fasting_glucose: 85, total_cholesterol: 170, triglyceride: 70 },
    2025: { wbc: 3.58, anc: 2.0, fasting_glucose: 85, total_cholesterol: 165, triglyceride: 65 },
    2026: { wbc: 3.93, anc: 2.3, fasting_glucose: 86, total_cholesterol: 160, triglyceride: 60 },
  };
  const rows = checkups.flatMap(report => Object.entries(values[report.checkup_year]).map(([metric_key, value_numeric]) => ({
    checkup_id: report.id,
    metric_key,
    value_numeric,
    status: metric_key === 'wbc' ? 'low' : 'normal',
  })));
  const model = buildHealthModel(checkups, rows, 'husband');
  assert.deepEqual(model.series('wbc').map(point => point.year), [2024, 2025, 2026]);
  assert.deepEqual(selectHealthTrendKeys(model, 'husband').slice(0, 3), ['wbc', 'fasting_glucose', 'total_cholesterol']);
  const advice = buildHealthInsights(model, 'husband');
  assert.match(advice.find(row => /白血球/.test(row.title)).body, /2024.*2025.*2026/);
  assert.match(advice.find(row => /血糖持平/.test(row.title)).body, /三酸甘油脂/);
});

test('couple trend groups use the union of both partners and keep health categories', () => {
  const checkups = ['husband', 'wife'].flatMap(owner_scope => [2025, 2026]
    .map(year => ({ id: `${owner_scope}-${year}`, owner_scope, checkup_year: year })));
  const rows = [
    ['husband', 'wbc', 4.0, 'low'],
    ['husband', 'total_cholesterol', 170, 'normal'],
    ['wife', 'mcv', 76, 'low'],
    ['wife', 'afp', 11, 'high'],
  ].flatMap(([owner, metric_key, value, status]) => [2025, 2026].map((year, index) => ({
    checkup_id: `${owner}-${year}`, metric_key, value_numeric: value + index, status,
  })));
  const groups = selectCoupleHealthTrendGroups(
    buildHealthModel(checkups, rows, 'husband'),
    buildHealthModel(checkups, rows, 'wife'),
  );
  assert.deepEqual(groups.map(group => group.title), ['血液與造血', '血糖、血脂與體位', '備孕與荷爾蒙']);
  assert.deepEqual(groups.flatMap(group => group.keys), ['wbc', 'mcv', 'total_cholesterol', 'afp']);
});
