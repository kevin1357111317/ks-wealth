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
