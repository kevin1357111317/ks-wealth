// 房子帳：取代「房子統計」Google 試算表。
//
// properties 存的是試算表「詳細」那張的原始欄位（總價、車位價、五種面積），
// 總面積、建物面積、每坪單價都在這裡算 —— 試算表也是公式算的，存起來只會跟原始欄位對不上。
//
// property_expenses 照試算表的正負號：負數是付出去的錢，正數是退款或收入（機車位出租）。

const finite = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const round2 = value => Math.round(value * 100) / 100;

// 試算表「詳細」：總面積 = 五項相加；建物面積 = 總面積 − 車位面積；
// 單價（含車位）= 總價 ÷ 總面積；單價（不含車位）=（總價 − 車位價）÷ 建物面積。單位是萬元／坪。
export function propertyFacts(property) {
  const indoor = finite(property?.indoor_ping);
  const awning = finite(property?.awning_ping);
  const balcony = finite(property?.balcony_ping);
  const common = finite(property?.common_ping);
  const parking = finite(property?.parking_ping);
  const totalArea = round2(indoor + awning + balcony + common + parking);
  const buildingArea = round2(totalArea - parking);
  const totalPrice = property?.total_price_wan === null || property?.total_price_wan === undefined
    ? null : finite(property.total_price_wan);
  const parkingPrice = finite(property?.parking_price_wan);
  const buildingPrice = totalPrice === null ? null : totalPrice - parkingPrice;
  return {
    indoor, awning, balcony, common, parking, totalArea, buildingArea,
    totalPrice, parkingPrice, buildingPrice,
    unitPrice: totalPrice !== null && totalArea > 0 ? totalPrice / totalArea : null,
    unitPriceExParking: buildingPrice !== null && buildingArea > 0 ? buildingPrice / buildingArea : null,
  };
}

// 摘要的三大塊。分類名稱是自由文字（使用者可以自己開新分類），所以用關鍵字歸類；
// 對不到的一律算持有成本 —— 水電、稅、管理費、保險這些才是會一直新增的。
export const PROPERTY_BUCKETS = [
  { key: 'purchase', label: '購屋', match: /房屋款項|代書|驗屋|仲介|契稅/ },
  { key: 'furnish', label: '裝潢家具家電', match: /裝潢|傢俱|家具|冷氣|家電/ },
];
export const bucketOf = category => PROPERTY_BUCKETS.find(bucket => bucket.match.test(category ?? ''))?.key ?? 'holding';

const daysBefore = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

// 「KL/CH」是兩個人各半；只有一個名字就是那個人全付。
export const splitPayer = payer => String(payer ?? '').split('/').map(name => name.trim()).filter(Boolean);

export function calculatePropertyLedger(rows, today) {
  const list = (rows ?? []).map(row => ({
    id: row.id,
    category: String(row.category ?? '').trim() || '未分類',
    date: String(row.expense_date ?? ''),
    amount: finite(row.amount_twd),
    item: row.item ?? '',
    detail: row.detail ?? '',
    payer: row.payer ?? '',
    sortOrder: finite(row.sort_order),
    raw: row,
  }));

  const groups = new Map();
  for (const row of list) {
    const group = groups.get(row.category) ?? { category: row.category, total: 0, rows: [], firstOrder: Infinity, lastDate: '' };
    group.total += row.amount;
    group.rows.push(row);
    group.firstOrder = Math.min(group.firstOrder, row.sortOrder);
    if (row.date > group.lastDate) group.lastDate = row.date;
    groups.set(row.category, group);
  }
  // 分類照試算表的順序（第一筆的 sort_order）；App 新開的分類 sort_order 比較大，排在後面。
  const categories = [...groups.values()]
    .sort((a, b) => a.firstOrder - b.firstOrder || a.category.localeCompare(b.category, 'zh-Hant'))
    .map(group => ({
      ...group,
      bucket: bucketOf(group.category),
      // 分類裡面新的在上面：管理費、水電這種一年十幾筆的，要看的是最近幾期。
      rows: group.rows.sort((a, b) => b.date.localeCompare(a.date) || b.sortOrder - a.sortOrder || finite(b.id) - finite(a.id)),
    }));

  const buckets = { purchase: 0, furnish: 0, holding: 0 };
  for (const group of categories) buckets[group.bucket] += group.total;

  // 近 12 個月的持有成本：今天往回 365 天（不含當天往前第 365 天）到今天。未來日期的帳不算。
  const since = today ? daysBefore(today, 365) : '';
  const recentHolding = list
    .filter(row => bucketOf(row.category) === 'holding' && (!today || (row.date > since && row.date <= today)))
    .reduce((sum, row) => sum + row.amount, 0);

  const payers = new Map();
  for (const row of list) {
    const names = splitPayer(row.payer);
    if (!names.length || !row.amount) continue;
    for (const name of names) payers.set(name, (payers.get(name) ?? 0) + row.amount / names.length);
  }

  return {
    categories,
    count: list.length,
    net: list.reduce((sum, row) => sum + row.amount, 0),
    buckets,
    recentHolding,
    recentHoldingMonthly: recentHolding / 12,
    payers: [...payers].map(([name, amount]) => ({ name, amount })).sort((a, b) => a.amount - b.amount),
    firstDate: list.reduce((min, row) => (!min || (row.date && row.date < min) ? row.date : min), ''),
  };
}

// 同一個分類最近一筆，新增時拿來預填項目、說明與付款人（水電費每期都長一樣）。
export function latestInCategory(rows, category) {
  return [...(rows ?? [])]
    .filter(row => String(row.category ?? '').trim() === String(category ?? '').trim())
    .sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)) || finite(b.sort_order) - finite(a.sort_order))[0] ?? null;
}
