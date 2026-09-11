import { applyHealthReferenceSpec } from './health-reference.js?v=V3P11';

const numberOrNull = value => value === null || value === undefined || value === ''
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

const isAbnormal = metric => metric && !['normal', 'info'].includes(metric.status);
const isLow = metric => metric?.status === 'low';
const seriesText = series => series.map(point => `${point.year}：${point.value}`).join(' → ');

export const HEALTH_SCORE_DIMENSIONS = [
  { key: 'score_cardio_metabolic', label: '心血管／代謝', max: 20 },
  { key: 'score_organ_function', label: '肝腎／尿液與器官', max: 20 },
  { key: 'score_blood', label: '血液系統', max: 20 },
  { key: 'score_endocrine_structure', label: '內分泌／結構', max: 10 },
  { key: 'score_fertility', label: '備孕準備度', max: 20 },
  { key: 'score_lifestyle', label: '工作型態／生活韌性', max: 10 },
];

export const HEALTH_COMPARISON_METRICS = [
  { key: 'hba1c', label: '糖化血色素' },
  { key: 'ldl_c', label: 'LDL 膽固醇' },
  { key: 'hdl_c', label: 'HDL 膽固醇' },
  { key: 'triglyceride', label: '三酸甘油脂' },
  { key: 'alt', label: 'ALT 肝功能' },
  { key: 'egfr', label: '腎絲球過濾率' },
  { key: 'hemoglobin', label: '血色素' },
  { key: 'mcv', label: '平均紅血球容積' },
];

export const HEALTH_TREND_CATEGORIES = [
  { key: 'blood', title: '血液與造血', keys: ['wbc', 'anc', 'neutrophil', 'rbc', 'hemoglobin', 'hematocrit', 'mcv', 'mch', 'mchc', 'platelet', 'rdw_cv'] },
  { key: 'metabolic', title: '血糖、血脂與體位', keys: ['fasting_glucose', 'hba1c', 'total_cholesterol', 'ldl_c', 'hdl_c', 'triglyceride', 'non_hdl_c', 'body_weight', 'bmi', 'waist', 'body_fat'] },
  { key: 'organ', title: '肝膽與腎臟功能', keys: ['ast', 'alt', 'ggt', 'alp', 'total_bilirubin', 'direct_bilirubin', 'bun', 'creatinine', 'egfr', 'uric_acid'] },
  { key: 'fertility', title: '備孕與荷爾蒙', keys: ['afp', 'tsh', 'free_t4', 'amh', 'semen_volume', 'semen_concentration', 'semen_progressive_motility', 'semen_morphology'] },
];

export function healthReferenceBoundaries(metric) {
  return [...new Set(healthReferenceMarkers(metric).map(marker => marker.value))];
}

export function healthReferenceMarkers(metric) {
  const low = numberOrNull(metric?.reference_low);
  const high = numberOrNull(metric?.reference_high);
  return [
    low === null ? null : { kind: 'low', label: '下限', value: low },
    high === null ? null : { kind: 'high', label: '上限', value: high },
  ].filter(Boolean);
}

export function healthReferenceState(metric) {
  const value = numberOrNull(metric?.value_numeric);
  const low = numberOrNull(metric?.reference_low);
  const high = numberOrNull(metric?.reference_high);
  if (value === null || (low === null && high === null)) return null;
  if (low !== null && value < low) return '低於下限';
  if (high !== null && value > high) return '高於上限';
  return '參考範圍內';
}

export function buildHealthModel(checkups, metrics, ownerScope) {
  const reports = (checkups ?? [])
    .filter(report => report.owner_scope === ownerScope)
    .map(report => ({
      ...report,
      checkup_year: Number(report.checkup_year),
      metrics: (metrics ?? [])
        .filter(metric => metric.checkup_id === report.id)
        .map(metric => applyHealthReferenceSpec({
          ...metric,
          value_numeric: numberOrNull(metric.value_numeric),
          reference_low: numberOrNull(metric.reference_low),
          reference_high: numberOrNull(metric.reference_high),
        }, ownerScope))
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

export function buildHealthComparison(husbandModel, wifeModel) {
  const profile = model => {
    const report = model?.latest ?? null;
    const score = model?.metric(report, 'management_score')?.value_numeric ?? null;
    const dimensions = HEALTH_SCORE_DIMENSIONS.map(dimension => ({
      ...dimension,
      metric: model?.metric(report, dimension.key) ?? null,
    }));
    return { report, score, dimensions };
  };
  const husband = profile(husbandModel);
  const wife = profile(wifeModel);
  const metrics = HEALTH_COMPARISON_METRICS.map(item => ({
    ...item,
    husband: husbandModel?.metric(husband.report, item.key) ?? null,
    wife: wifeModel?.metric(wife.report, item.key) ?? null,
  })).filter(item => item.husband || item.wife);
  return { husband, wife, metrics };
}

export function selectHealthTrendKeys(model, ownerScope, limit = 6) {
  if (!model.latest) return [];
  const preferred = ownerScope === 'wife'
    ? ['mcv', 'hemoglobin', 'afp', 'total_cholesterol', 'egfr', 'hba1c', 'body_weight']
    : ['wbc', 'direct_bilirubin', 'total_bilirubin', 'fasting_glucose', 'total_cholesterol', 'triglyceride', 'creatinine', 'hemoglobin', 'mcv', 'platelet', 'ldl_c', 'hba1c', 'body_weight', 'body_fat'];
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

export function selectCoupleHealthTrendGroups(husbandModel, wifeModel) {
  const selected = [...new Set([
    ...selectHealthTrendKeys(husbandModel, 'husband'),
    ...selectHealthTrendKeys(wifeModel, 'wife'),
  ])];
  const assigned = new Set();
  const groups = HEALTH_TREND_CATEGORIES.map(category => {
    const keys = category.keys.filter(key => selected.includes(key));
    keys.forEach(key => assigned.add(key));
    return { key: category.key, title: category.title, keys };
  }).filter(group => group.keys.length);
  const other = selected.filter(key => !assigned.has(key));
  if (other.length) groups.push({ key: 'other', title: '其他重要指標', keys: other });
  return groups;
}

export function buildHealthInsights(model, ownerScope) {
  if (!model.latest) return [];
  const value = key => model.metric(model.latest, key)?.value_numeric;
  const row = key => model.metric(model.latest, key);
  const abnormal = key => isAbnormal(row(key));
  const insights = [];

  if (row('ldct_thymic_tissue') || row('ldct_pericardial_effusion')) {
    insights.push({
      tone: 'priority',
      badge: '門診確認',
      title: '低劑量肺部 CT 有建議專科追蹤的項目',
      body: '影像報告在前縱隔腔與心包膜項目提出進一步追蹤建議；這些是影像描述，仍需由醫師結合原始影像與症狀確認。',
      action: '攜帶影像光碟與報告安排胸腔科，並由心臟科／家醫科評估是否需心臟超音波。若出現胸痛、呼吸困難、昏厥或明顯心悸，立即就醫。',
    });
  }

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
    const wbcSeries = model.series('wbc');
    const ancSeries = model.series('anc');
    insights.push({
      tone: 'watch', badge: '持續追蹤', title: '白血球輕度偏低，先看趨勢與 ANC',
      body: wbcSeries.length >= 3
        ? `白血球三年趨勢為 ${seriesText(wbcSeries)} ×10³/µL${ancSeries.length ? `；ANC 為 ${seriesText(ancSeries)} ×10³/µL，未呈持續下滑` : ''}。白血球持續略低。`
        : `白血球目前 ${value('wbc') ?? '—'} ×10³/µL${anc === null ? '' : `，推算 ANC 約 ${anc.toFixed(2)} ×10³/µL`}。目前較像穩定的輕度偏低，不能只憑單次數值判定疾病。`,
      action: '健康狀態良好時於 1–3 個月重驗 CBC；若反覆發燒、感染、口腔潰瘍，或 WBC／ANC 繼續下降，提早至家醫科或血液科評估。',
    });
  }

  if (abnormal('total_bilirubin') || abnormal('direct_bilirubin')) {
    const totalSeries = model.series('total_bilirubin');
    const directSeries = model.series('direct_bilirubin');
    insights.push({
      tone: 'watch', badge: '持續追蹤', title: '膽紅素輕度偏高，搭配分型與肝功能追蹤',
      body: totalSeries.length >= 3
        ? `總膽紅素三年為 ${seriesText(totalSeries)} mg/dL${directSeries.length ? `，直接膽紅素為 ${seriesText(directSeries)} mg/dL` : ''}；數值小幅波動，AST／ALT 持續正常。`
        : `總膽紅素 ${value('total_bilirubin') ?? '—'}、直接膽紅素 ${value('direct_bilirubin') ?? '—'} mg/dL；目前 AST／ALT 與腹部超音波沒有同步警訊。`,
      action: '3–6 個月或下次門診重驗總／直接／間接膽紅素與肝功能。若眼白變黃、深色尿、灰白便或右上腹痛，提早看肝膽胃腸科。',
    });
  }

  if (ownerScope === 'husband' && row('semen_concentration') && row('semen_progressive_motility')) {
    insights.push({
      tone: 'good', badge: '備孕基準', title: '精液主要參數均達這份報告的參考值',
      body: `精液量 ${value('semen_volume') ?? '—'} mL、精蟲濃度 ${value('semen_concentration') ?? '—'} ×10⁶/mL、前進運動 ${value('semen_progressive_motility') ?? '—'}%、正常型態 ${value('semen_morphology') ?? '—'}%。`,
      action: '保留為備孕基準。精液參數會波動；若規律未避孕仍未懷孕，依生殖醫學／泌尿科建議決定是否複驗，夫妻同步評估。',
    });
  }

  if (ownerScope === 'husband' && model.series('fasting_glucose').length >= 3) {
    insights.push({
      tone: 'good', badge: '三年穩定', title: '血糖持平，血脂與肝腎功能維持良好',
      body: `飯前血糖為 ${seriesText(model.series('fasting_glucose'))} mg/dL；總膽固醇為 ${seriesText(model.series('total_cholesterol'))} mg/dL，三酸甘油脂為 ${seriesText(model.series('triglyceride'))} mg/dL。`,
      action: '維持目前體重、規律運動與飲食型態；長時間工作每 30–60 分鐘起身活動，年度健檢繼續用相同指標觀察即可。',
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
    domain('低劑量肺部 CT', ['ldct_exam', 'ldct_lung_pleura', 'ldct_calcified_lymph_nodes', 'ldct_thymic_tissue', 'ldct_arterial_ligament_calcification', 'ldct_pericardial_effusion'], '安排專科確認', '目前無急迫警訊', '把舊發炎相關變化與需要確認的胸腺／心包膜發現分開追蹤；以原始影像及專科判讀為準。'),
    domain('男性備孕', ['semen_volume', 'semen_liquefaction', 'semen_ph', 'semen_progressive_motility', 'semen_nonprogressive_motility', 'semen_immotile', 'semen_concentration', 'semen_morphology', 'semen_wbc', 'semen_rbc'], '依醫師建議複驗', '主要參數達參考值', '精液分析是單次基準而非受孕保證；若有需要，依生殖醫學／泌尿科建議複驗並同步評估夫妻雙方。'),
    domain('尿液檢查', ['urine_appearance', 'urine_leukocyte', 'urine_nitrite', 'urine_glucose', 'urine_protein', 'urine_ph', 'urine_occult_blood', 'urine_specific_gravity', 'urine_wbc_microscopy', 'urine_rbc_microscopy', 'urine_crystal', 'urine_bacteria'], '補水後複驗觀察', '目前正常', '結晶體需搭配尿液酸鹼值、潛血、蛋白、細菌與症狀判讀；單次結果不直接等同結石。'),
    domain('感染篩檢與免疫', ['hbs_ag', 'anti_hbs', 'anti_hcv', 'vdrl', 'hiv', 'chlamydia_igg', 'g6pd'], '依醫師評估', '目前無異常', '保留肝炎、感染篩檢與抗體結果，作為備孕及日後醫療紀錄。'),
    domain('血液與免疫', ['wbc', 'anc', 'hemoglobin', 'hematocrit', 'platelet'], '輕度異常追蹤', '目前正常', '白血球需搭配 ANC 與症狀判讀；血色素與 MCV 正常時，不像典型貧血。'),
    domain('肝膽功能', ['total_bilirubin', 'direct_bilirubin', 'ast', 'alt', 'ggt', 'alp'], '定期複驗', '目前正常', '膽紅素要搭配分型、肝酵素與影像追蹤，不直接用單一數值下診斷。'),
    domain('心血管與代謝', ['bmi', 'waist', 'body_fat', 'fasting_glucose', 'hba1c', 'ldl_c'], '調整生活型態', '維持目前狀態', '體位、血糖與血脂整體一起看，長期重點是睡眠、運動與避免久坐。'),
    domain('影像與結構', ['thoracic_scoliosis', 'chest_xray', 'abdominal_ultrasound', 'thyroid_ultrasound', 'resting_ecg'], '有症狀再評估', '目前無急迫警訊', '影像以長期變化和症狀為主；穩定胸椎側彎若無不適，可先從姿勢與核心肌力管理。'),
  ];
  return common.filter(Boolean);
}
