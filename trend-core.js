const numberValue = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const validScopeRow = row => (
  (row?.owner_scope === 'husband' || row?.owner_scope === 'wife')
  && (row.kind === 'asset' || row.kind === 'liability')
  && typeof row.recorded_on === 'string'
  && row.recorded_on.length > 0
);

const wifeCutoverDate = scopeHistory => {
  const dates = scopeHistory
    .filter(row => validScopeRow(row) && row.owner_scope === 'wife')
    .map(row => row.recorded_on)
    .sort();
  return dates[0] ?? null;
};

export function buildPersonalTrendRows({
  familyHistory = [],
  scopeHistory = [],
  ownerScope,
  currentNetWorth,
  today,
}) {
  const byDate = new Map();
  const cutover = wifeCutoverDate(scopeHistory);

  // 在老婆第一次出現在個人 scope 之前，家庭帳本裡只有老公，所以舊的家庭淨值
  // 本來就是老公自己的歷史。切分日起家庭淨值已可能包含老婆，絕不能再拿來補老公。
  if (ownerScope === 'husband') {
    for (const row of familyHistory) {
      if (typeof row?.recorded_on !== 'string' || !row.recorded_on) continue;
      if (cutover && row.recorded_on >= cutover) continue;
      byDate.set(row.recorded_on, numberValue(row.net_worth_twd ?? row.total_twd));
    }
  }

  const grouped = new Map();
  for (const row of scopeHistory) {
    if (!validScopeRow(row) || row.owner_scope !== ownerScope) continue;
    const bucket = grouped.get(row.recorded_on) ?? {};
    bucket[row.kind] = numberValue(row.total_twd);
    grouped.set(row.recorded_on, bucket);
  }

  // scope 紀錄有時只更新資產或負債其中一邊；只沿用同一個人的上一筆已知值。
  // 切分日之後即使某天個人 scope 缺資料，也不能退回家庭淨值，否則會把另一半算進來。
  let assets = null;
  let liabilities = null;
  for (const [recordedOn, bucket] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
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
