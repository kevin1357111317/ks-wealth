// 健檢報告的參考區間各家實驗室都不一樣（同一個人不同年度也會換），並排比較時
// 會出現「同一指標兩條參考線」這種看不懂的畫面。這支檔案把常用指標統一成國際
// 通用的成人參考標準；只有醫學上本來就男女有別的指標才分開列。
//
// 沒收錄在這裡的指標（CEA、CA19-9、PSA、肝炎與感染篩檢、胰島素、G6PD、體脂率等）
// 保留原報告數值：那些是儀器／方法決定的，不能拿別家的切點硬套。
// AFP 是例外 —— 兩人的報告一個寫 0–7 一個寫 <9，圖上會多出兩條意義一樣的線，
// 所以統一成常見成人切點 0–10；兩邊的判定都不受影響。
//
// 標準來源：
// - CBC：成人血液學常用參考區間（Wintrobe／MSD Manual）
// - 血糖與糖化血色素：ADA
// - 血脂：NCEP ATP III／AHA
// - 肝功能 ALT：AASLD 2017 健康人上限（男女不同）
// - 腎功能 eGFR：KDIGO（<60 為腎功能下降）
// - 精液分析：WHO 2021 第 6 版下限值
// - 體位：WHO BMI；腰圍為 IDF 亞洲切點（男女不同）

const range = (low, high, text) => ({ low, high, text });

// both：男女共用；male／female：醫學上本來就分開的指標。
export const HEALTH_REFERENCE_SPEC = {
  // 血液與造血
  wbc: { source: 'CBC 成人參考區間', both: range(4, 11, '4.0–11.0') },
  anc: { source: 'CBC 成人參考區間', both: range(1.5, 7, '1.5–7.0') },
  neutrophil: { source: 'CBC 成人參考區間', both: range(40, 75, '40–75') },
  lymphocyte: { source: 'CBC 成人參考區間', both: range(20, 45, '20–45') },
  rbc: {
    source: 'CBC 成人參考區間（男女不同）',
    male: range(4.5, 5.9, '男性 4.5–5.9'),
    female: range(4, 5.2, '女性 4.0–5.2'),
  },
  hemoglobin: {
    source: 'CBC 成人參考區間（男女不同）',
    male: range(13.5, 17.5, '男性 13.5–17.5'),
    female: range(12, 15.5, '女性 12.0–15.5'),
  },
  hematocrit: {
    source: 'CBC 成人參考區間（男女不同）',
    male: range(41, 53, '男性 41–53'),
    female: range(36, 46, '女性 36–46'),
  },
  mcv: { source: 'CBC 成人參考區間', both: range(80, 100, '80–100') },
  mch: { source: 'CBC 成人參考區間', both: range(27, 33, '27–33') },
  mchc: { source: 'CBC 成人參考區間', both: range(32, 36, '32–36') },
  rdw_cv: { source: 'CBC 成人參考區間', both: range(11.5, 14.5, '11.5–14.5') },
  platelet: { source: 'CBC 成人參考區間', both: range(150, 400, '150–400') },

  // 血糖與血脂
  fasting_glucose: { source: 'ADA 正常空腹血糖', both: range(70, 99, '70–99') },
  hba1c: { source: 'ADA 正常糖化血色素', both: range(null, 5.7, '<5.7') },
  total_cholesterol: { source: 'NCEP ATP III 理想值', both: range(null, 200, '<200') },
  ldl_c: { source: 'NCEP ATP III（<100 最理想）', both: range(null, 130, '<130') },
  non_hdl_c: { source: 'AHA 理想值', both: range(null, 130, '<130') },
  hdl_c: {
    source: 'NCEP／AHA（男女不同）',
    male: range(40, null, '男性 ≥40'),
    female: range(50, null, '女性 ≥50'),
  },
  triglyceride: { source: 'NCEP ATP III 理想值', both: range(null, 150, '<150') },

  // 肝膽功能
  ast: {
    source: '常用實驗室成人區間（男女不同）',
    male: range(8, 40, '男性 8–40'),
    female: range(8, 32, '女性 8–32'),
  },
  alt: {
    source: 'AASLD 2017 健康人上限（男女不同）',
    male: range(null, 33, '男性 ≤33'),
    female: range(null, 25, '女性 ≤25'),
  },
  ggt: {
    source: '常用實驗室成人區間（男女不同）',
    male: range(null, 55, '男性 ≤55'),
    female: range(null, 38, '女性 ≤38'),
  },
  alp: {
    source: 'IFCC 成人區間（男女不同）',
    male: range(40, 129, '男性 40–129'),
    female: range(35, 104, '女性 35–104'),
  },
  total_bilirubin: { source: '常用實驗室成人區間', both: range(0.2, 1.2, '0.2–1.2') },
  direct_bilirubin: { source: '常用實驗室成人區間', both: range(0, 0.3, '0–0.3') },
  albumin: { source: '常用實驗室成人區間', both: range(3.5, 5, '3.5–5.0') },
  total_protein: { source: '常用實驗室成人區間', both: range(6.4, 8.3, '6.4–8.3') },

  // 腎功能與尿酸
  bun: { source: '常用實驗室成人區間', both: range(8, 20, '8–20') },
  creatinine: {
    source: 'IDMS 校正成人區間（男女不同）',
    male: range(0.74, 1.35, '男性 0.74–1.35'),
    female: range(0.59, 1.04, '女性 0.59–1.04'),
  },
  egfr: { source: 'KDIGO（<60 為腎功能下降）', both: range(60, null, '≥60') },
  uric_acid: {
    source: '常用實驗室成人區間（男女不同）',
    male: range(3.4, 7, '男性 3.4–7.0'),
    female: range(2.4, 6, '女性 2.4–6.0'),
  },

  // 甲狀腺
  tsh: { source: 'ATA 成人區間', both: range(0.4, 4, '0.4–4.0') },
  free_t4: { source: '常用實驗室成人區間', both: range(0.8, 1.8, '0.8–1.8') },

  // 體位與血壓
  bmi: { source: 'WHO 正常體位', both: range(18.5, 24.9, '18.5–24.9') },
  waist: {
    source: 'IDF 亞洲切點（男女不同）',
    male: range(null, 90, '男性 <90'),
    female: range(null, 80, '女性 <80'),
  },
  systolic_bp: { source: 'ACC／AHA 正常血壓', both: range(null, 120, '<120') },
  diastolic_bp: { source: 'ACC／AHA 正常血壓', both: range(null, 80, '<80') },

  // 男性生育力：WHO 2021 第 6 版下限值
  semen_volume: { source: 'WHO 2021 下限值', male: range(1.4, null, '≥1.4') },
  semen_concentration: { source: 'WHO 2021 下限值', male: range(16, null, '≥16') },
  semen_progressive_motility: { source: 'WHO 2021 下限值', male: range(30, null, '≥30') },
  semen_morphology: { source: 'WHO 2021 下限值', male: range(4, null, '≥4') },
  semen_ph: { source: 'WHO 2021 下限值', male: range(7.2, null, '≥7.2') },
  semen_liquefaction: { source: 'WHO 2021 液化時間', male: range(null, 60, '≤60') },

  // 甲種胎兒蛋白：常見成人切點，男女共用
  afp: { source: '常見成人切點', both: range(0, 10, '0–10') },

  // 尿液
  urine_ph: { source: '常用實驗室成人區間', both: range(4.5, 8, '4.5–8.0') },
  urine_specific_gravity: { source: '常用實驗室成人區間', both: range(1.005, 1.03, '1.005–1.030') },
  urine_wbc_microscopy: { source: '常用實驗室成人區間', both: range(0, 5, '0–5') },
  urine_rbc_microscopy: { source: '常用實驗室成人區間', both: range(0, 3, '0–3') },
};

export function healthReferenceSpec(metricKey, ownerScope) {
  const entry = HEALTH_REFERENCE_SPEC[metricKey];
  if (!entry) return null;
  const bySex = ownerScope === 'wife' ? entry.female : entry.male;
  const chosen = bySex ?? entry.both ?? null;
  return chosen ? { ...chosen, source: entry.source } : null;
}

export function healthReferenceStatus(value, spec) {
  if (!Number.isFinite(value) || !spec) return null;
  if (spec.low !== null && spec.low !== undefined && value < spec.low) return 'low';
  if (spec.high !== null && spec.high !== undefined && value > spec.high) return 'high';
  return 'normal';
}

// 套用統一標準：只有數值型指標會被改寫，狀態也一併依統一區間重算，
// 不然畫面會出現「參考範圍內」卻標紅字的矛盾。
export function applyHealthReferenceSpec(metric, ownerScope) {
  const spec = healthReferenceSpec(metric?.metric_key, ownerScope);
  if (!spec || !Number.isFinite(metric?.value_numeric)) return metric;
  const status = healthReferenceStatus(metric.value_numeric, spec) ?? metric.status;
  return {
    ...metric,
    reference_low: spec.low ?? null,
    reference_high: spec.high ?? null,
    reference_text: `${spec.text}（${spec.source}）`,
    reference_source: spec.source,
    status,
  };
}
