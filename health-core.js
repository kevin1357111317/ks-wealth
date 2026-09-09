const numberOrNull = value => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

export function buildHealthModel(checkups, metrics, ownerScope) {
  const reports = (checkups ?? [])
    .filter(report => report.owner_scope === ownerScope)
    .map(report => ({
      ...report,
      checkup_year: Number(report.checkup_year),
      metrics: (metrics ?? [])
        .filter(metric => metric.checkup_id === report.id)
        .map(metric => ({
          ...metric,
          value_numeric: numberOrNull(metric.value_numeric),
          reference_low: numberOrNull(metric.reference_low),
          reference_high: numberOrNull(metric.reference_high),
        }))
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)),
    }))
    .sort((a, b) => a.checkup_year - b.checkup_year);

  const latest = reports.at(-1) ?? null;
  const metric = (report, key) => report?.metrics.find(row => row.metric_key === key) ?? null;
  const series = key => reports
    .map(report => ({ year: report.checkup_year, metric: metric(report, key) }))
    .filter(point => point.metric?.value_numeric !== null)
    .map(point => ({ year: point.year, value: point.metric.value_numeric, metric: point.metric }));

  return { reports, latest, metric, series };
}

export function buildHealthInsights(model, ownerScope) {
  if (!model.latest) return [];
  const value = key => model.metric(model.latest, key)?.value_numeric;
  const row = key => model.metric(model.latest, key);
  const abnormal = key => row(key) && row(key).status !== 'normal' && row(key).status !== 'info';
  const insights = [];

  if (abnormal('mcv') || abnormal('hemoglobin') || abnormal('rbc')) {
    insights.push({
      tone: 'priority',
      badge: '備孕優先',
      title: '先釐清小球性紅血球的原因',
      body: `MCV ${value('mcv') ?? '—'}、血色素 ${value('hemoglobin') ?? '—'}，且紅血球 ${value('rbc') ?? '—'}。型態可能見於缺鐵或地中海型貧血帶因，單靠健檢無法確診。`,
      action: '1–2 週內安排家醫／血液科或備孕門診：先驗 ferritin、血清鐵、TIBC／轉鐵飽和度；未證實缺鐵前不要自行服用高劑量鐵。若鐵正常，再由醫師評估血紅蛋白分析或基因檢測，伴侶也一起確認。',
    });
  }

  if (abnormal('afp')) {
    insights.push({
      tone: 'watch', badge: '持續追蹤', title: 'AFP 輕度上升，安排非急診複查',
      body: `AFP 目前 ${value('afp') ?? '—'} ng/mL；這是非特異性指標，輕度升高本身不能診斷癌症。`,
      action: '帶歷年數值給肝膽胃腸科／家醫科，依醫師建議用同一實驗室複驗，並核對 B/C 型肝炎狀態與是否需要腹部超音波。',
    });
  }

  if (abnormal('urine_leukocyte') || abnormal('urine_protein') || abnormal('urine_turbidity')) {
    insights.push({
      tone: 'watch', badge: '需要複驗', title: '用乾淨中段尿排除污染或泌尿道問題',
      body: `尿白血球 ${row('urine_leukocyte')?.value_text ?? '—'}、尿蛋白 ${row('urine_protein')?.value_text ?? value('urine_protein') ?? '—'}。無症狀時也可能是採樣污染。`,
      action: '避開月經期，以清潔後中段尿複查；若有頻尿、尿痛、發燒、腰痛或已懷孕，應提早就醫並由醫師決定是否驗尿培養。',
    });
  }

  if (ownerScope === 'wife') {
    insights.push({
      tone: 'good', badge: '今天開始', title: '備孕基本盤：葉酸、用藥與疫苗一起盤點',
      body: '一般備孕者每天補充 400 mcg 葉酸，至少從受孕前 1 個月開始；若醫師判定為高風險族群，劑量另行調整。',
      action: '預約一次孕前諮詢，帶目前藥物／保健品與疫苗紀錄；維持規律睡眠、每週運動，兩人都戒菸並在嘗試懷孕期間避免酒精。',
    });
  }

  return insights;
}

