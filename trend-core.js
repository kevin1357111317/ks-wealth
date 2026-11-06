const numberValue = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const validScopeRow = row => (
  (row?.owner_scope === 'husband' || row?.owner_scope === 'wife')
  && (row.kind === 'asset' || row.kind === 'liability' || row.kind === 'net')
  && typeof row.recorded_on === 'string'
  && row.recorded_on.length > 0
);

export function filterTrendRowsFrom(rows = [], startDate) {
  if (!startDate) return [...rows];
  return rows.filter(row => (
    typeof row?.recorded_on === 'string'
    && row.recorded_on >= startDate
  ));
}

export function buildPersonalTrendRows({
  scopeHistory = [],
  ownerScope,
  currentNetWorth,
  today,
}) {
  const byDate = new Map();
  const grouped = new Map();
  for (const row of scopeHistory) {
    if (!validScopeRow(row) || row.owner_scope !== ownerScope) continue;
    const bucket = grouped.get(row.recorded_on) ?? {};
    bucket[row.kind] = numberValue(row.total_twd);
    grouped.set(row.recorded_on, bucket);
  }

  // 2026-08-27 前只留下淨資產總額，已正式回填成 husband/net；之後的每日資料
  // 仍以資產減負債計算。個人圖只讀個人 scope，不再借用家庭歷史。
  let assets = null;
  let liabilities = null;
  for (const [recordedOn, bucket] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    if (Object.hasOwn(bucket, 'net')) {
      byDate.set(recordedOn, bucket.net);
      continue;
    }
    if (Object.hasOwn(bucket, 'asset')) assets = bucket.asset;
    if (Object.hasOwn(bucket, 'liability')) liabilities = bucket.liability;
    if (assets === null || liabilities === null) continue;
    byDate.set(recordedOn, assets - liabilities);
  }

  if (today) byDate.set(today, numberValue(currentNetWorth));

  return [...byDate]
    .map(([recorded_on, total_twd]) => ({ recorded_on, total_twd }))
    .sort((left, right) => left.recorded_on.localeCompare(right.recorded_on));
}

// 淨資產趨勢圖的趨勢線（屋主 2026-11-06 要求）：最小平方法直線回歸，x 用點的順序，
// 跟圖上的橫軸一致（圖是一點一格等距畫的，不是照日期比例）。R² 對 y 做線性轉換不變，
// 所以金額模式跟 % 模式算出來同一個 R²。少於 3 點或 y 完全沒變化時沒有意義，回 null。
export function linearTrend(values = []) {
  const ys = values.map(Number);
  const n = ys.length;
  if (n < 3 || ys.some(value => !Number.isFinite(value))) return null;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  ys.forEach((value, index) => {
    sxx += (index - meanX) ** 2;
    sxy += (index - meanX) * (value - meanY);
    syy += (value - meanY) ** 2;
  });
  if (!(syy > 0)) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  return { slope, intercept, r2: (sxy * sxy) / (sxx * syy), at: index => intercept + slope * index };
}
