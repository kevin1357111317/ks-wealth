const numberOrNull = value => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

const isAbnormal = metric => metric && !['normal', 'info'].includes(metric.status);
const isLow = metric => metric?.status === 'low';

export function healthReferenceBoundaries(metric) {
  return [...new Set([metric?.reference_low, metric?.reference_high]
    .map(numberOrNull)
    .filter(value => value !== null))];
}

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
    .filter(point => point.metric && point.metric.value_numeric !== null)
    .map(point => ({ year: point.year, value: point.metric.value_numeric, metric: point.metric }));

  return { reports, latest, metric, series };
}

export function selectHealthTrendKeys(model, ownerScope, limit = 6) {
  if (!model.latest) return [];
  const preferred = ownerScope === 'wife'
    ? ['mcv', 'hemoglobin', 'afp', 'total_cholesterol', 'egfr', 'hba1c', 'body_weight']
    : ['wbc', 'total_bilirubin', 'direct_bilirubin', 'ldl_c', 'hba1c', 'body_weight', 'body_fat'];
  const ignored = new Set(['age', 'management_score']);
  const candidates = model.latest.metrics
    .filter(metric => !ignored.has(metric.metric_key) && model.series(metric.metric_key).length >= 2)
    .map(metric => metric.metric_key);
  const preferredAvailable = preferred.filter(key => candidates.includes(key));
  const priorityAbnormal = preferredAvailable.filter(key => isAbnormal(model.metric(model.latest, key)));
  const otherAbnormal = candidates
    .filter(key => !preferred.includes(key) && isAbnormal(model.metric(model.latest, key)));
  return [...new Set([...priorityAbnormal, ...otherAbnormal, ...preferredAvailable])].slice(0, limit);
}

export function buildHealthInsights(model, ownerScope) {
  if (!model.latest) return [];
  const value = key => model.metric(model.latest, key)?.value_numeric;
  const row = key => model.metric(model.latest, key);
  const abnormal = key => isAbnormal(row(key));
  const insights = [];

  if (isLow(row('mcv')) || isLow(row('mch'))) {
    insights.push({
      tone: 'priority',
      badge: '備孕優先',
      title: '先釐清小球性紅血球的原因',
      body: `MCV ${value('mcv') ?? '—'}、血色素 ${value('hemoglobin') ?? '—'}，且紅血球 ${value('rbc') ?? '—'}。型態可能見於缺鐵或地中海型貧血帶因，單靠健檢無法確診。`,
      action: '1–2 週內安排家醫／血液科或備孕門診：先驗 ferritin、血清鐵、TIBC／轉鐵飽和度；未證實缺鐵前不要自行服用高劑量鐵。若鐵正常，再由醫師評估血紅蛋白分析或基因檢測，伴侶也一起確認。',
    });
  }

  if (abnormal('wbc')) {
    const wbc = value('wbc');
    const neutrophil = value('neutrophil');
    const anc = value('anc') ?? (Number.isFinite(wbc) && Number.isFinite(neutrophil)
      ? wbc * neutrophil / 100 : null);
    insights.push({
      tone: 'watch', badge: '持續追蹤', title: '白血球輕度偏低，先看趨勢與 ANC',
      body: `白血球目前 ${value('wbc') ?? '—'} ×10³/µL${anc === null ? '' : `，推算 ANC 約 ${anc.toFixed(2)} ×10³/µL`}。目前較像穩定的輕度偏低，不能只憑單次數值判定疾病。`,
      action: '健康狀態良好時於 1–3 個月重驗 CBC；若反覆發燒、感染、口腔潰瘍，或 WBC／ANC 繼續下降，提早至家醫科或血液科評估。',
    });
  }

  if (abnormal('total_bilirubin') || abnormal('direct_bilirubin')) {
    insights.push({
      tone: 'watch', badge: '持續追蹤', title: '膽紅素輕度偏高，搭配分型與肝功能追蹤',
      body: `總膽紅素 ${value('total_bilirubin') ?? '—'}、直接膽紅素 ${value('direct_bilirubin') ?? '—'} mg/dL；目前 AST／ALT 與腹部超音波沒有同步警訊。`,
      action: '3–6 個月或下次門診重驗總／直接／間接膽紅素與肝功能。若眼白變黃、深色尿、灰白便或右上腹痛，提早看肝膽胃腸科。',
    });
  }

  if (abnormal('afp')) {
    const series = model.series('afp');
    const rising = series.length >= 2 && series.at(-1).value > series.at(-2).value;
    insights.push({
      tone: 'watch', badge: '持續追蹤', title: rising ? 'AFP 輕度上升，安排非急診複查' : 'AFP 偏高，依趨勢安排複查',
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
    if ((value('age') ?? 0) >= 35) {
      insights.push({
        tone: 'watch', badge: '時間規劃', title: '備孕滿 6 個月未懷孕，就同步評估雙方',
        body: '女方年齡已達 35 歲，生育力評估的時間點會比 35 歲以下提早。',
        action: '規律未避孕 6 個月仍未懷孕時，安排婦產科／生殖醫學評估，並同步評估男方；若月經不規則或已有明確風險，可更早諮詢。',
      });
    }
  }

  if (ownerScope === 'husband' && row('thoracic_scoliosis')?.value_text) {
    insights.push({
      tone: 'good', badge: '日常維持', title: '代謝狀態良好，留意久坐與胸椎側彎',
      body: '血糖、血脂、體位與腎功能整體良好；胸椎側彎已連續出現在胸部 X 光報告。',
      action: '維持每週 150 分鐘有氧與 2 次阻力訓練，每 30–60 分鐘起身活動；若出現背痛、麻木、無力或活動受限，再安排復健科評估。',
    });
  }

  return insights;
}

export function buildHealthDomains(model, report, ownerScope) {
  if (!report) return [];
  const has = keys => keys.some(key => model.metric(report, key));
  const abnormal = keys => keys.some(key => isAbnormal(model.metric(report, key)));
  const domain = (title, keys, alert, normal, copy) => has(keys)
    ? { title, keys, status: abnormal(keys) ? alert : normal, copy }
    : null;

  const common = ownerScope === 'wife' ? [
    domain('紅血球型態', ['rbc', 'hemoglobin', 'mcv', 'mch', 'rdw_cv'], '備孕前優先釐清', '目前穩定', 'MCV／MCH 偏低時先區分缺鐵與血紅蛋白帶因，不直接當成單純缺鐵。'),
    domain('AFP', ['afp', 'alt'], '非急診追蹤', '目前正常', 'AFP 是非特異性指標；搭配肝功能、肝炎狀態與影像，由醫師判斷追蹤間隔。'),
    domain('尿液檢查', ['urine_turbidity', 'urine_leukocyte', 'urine_protein'], '重新採樣確認', '目前正常', '若出現白血球或蛋白，先用正確中段尿複查，再區分污染或泌尿道問題。'),
    domain('血脂結構', ['total_cholesterol', 'ldl_c', 'hdl_c', 'triglyceride', 'non_hdl_c'], '整體風險判讀', '維持目前狀態', '總膽固醇要連同 LDL、非 HDL、三酸甘油脂與整體風險一起看。'),
  ] : [
    domain('血液與免疫', ['wbc', 'anc', 'hemoglobin', 'hematocrit', 'platelet'], '輕度異常追蹤', '目前正常', '白血球需搭配 ANC 與症狀判讀；血色素與 MCV 正常時，不像典型貧血。'),
    domain('肝膽功能', ['total_bilirubin', 'direct_bilirubin', 'ast', 'alt', 'ggt', 'alp'], '定期複驗', '目前正常', '膽紅素要搭配分型、肝酵素與影像追蹤，不直接用單一數值下診斷。'),
    domain('心血管與代謝', ['bmi', 'waist', 'body_fat', 'fasting_glucose', 'hba1c', 'ldl_c'], '調整生活型態', '維持目前狀態', '體位、血糖與血脂整體一起看，長期重點是睡眠、運動與避免久坐。'),
    domain('影像與結構', ['thoracic_scoliosis', 'chest_xray', 'abdominal_ultrasound', 'thyroid_ultrasound', 'resting_ecg'], '有症狀再評估', '目前無急迫警訊', '影像以長期變化和症狀為主；穩定胸椎側彎若無不適，可先從姿勢與核心肌力管理。'),
  ];
  return common.filter(Boolean);
}
