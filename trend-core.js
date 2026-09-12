export function buildPersonalTrendRows({ scopeHistory, ownerScope, currentNetWorth, today }) {
  const grouped = new Map();
  scopeHistory
    .filter(row => row.owner_scope === ownerScope)
    .sort((a, b) => a.recorded_on.localeCompare(b.recorded_on))
    .forEach(row => {
      const day = grouped.get(row.recorded_on) ?? {
        recorded_on: row.recorded_on,
        asset: null,
        liability: null,
      };
      day[row.kind] = Number(row.total_twd) || 0;
      grouped.set(row.recorded_on, day);
    });

  let latestAsset = null;
  let latestLiability = null;
  const byDate = new Map();
  for (const row of grouped.values()) {
    if (row.asset !== null) latestAsset = row.asset;
    if (row.liability !== null) latestLiability = row.liability;
    if (latestAsset !== null && latestLiability !== null) {
      byDate.set(row.recorded_on, latestAsset - latestLiability);
    }
  }
  byDate.set(today, currentNetWorth);
  return [...byDate]
    .map(([recorded_on, total_twd]) => ({ recorded_on, total_twd }))
    .sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
}
