export const OWNER_SCOPES = Object.freeze(['husband', 'wife']);
export const ITEM_KINDS = Object.freeze(['asset', 'liability']);
export const NATIVE_CURRENCIES = Object.freeze(['TWD', 'USD']);
export const STOCK_MARKETS = Object.freeze(['TW', 'US']);

export function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseNonNegative(value, label, { required = true, positive = false } = {}) {
  if (!required && (value === null || value === undefined || String(value).trim() === '')) return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`${label}必須是有效數字。`);
  if (number < 0 || (positive && number <= 0)) {
    throw new Error(`${label}${positive ? '必須大於 0' : '不可小於 0'}。`);
  }
  return number;
}

export function calculateTwdAmount({ nativeCurrency, nativeAmount, fxRateTwd }) {
  if (!NATIVE_CURRENCIES.includes(nativeCurrency)) throw new Error('不支援的幣別。');
  const amount = parseNonNegative(nativeAmount, nativeCurrency === 'USD' ? '美元金額' : '台幣金額');
  if (nativeCurrency === 'TWD') return Math.round(amount);
  const rate = parseNonNegative(fxRateTwd, '美元匯率', { positive: true });
  return Math.round(amount * rate);
}

export function normalizeFinancialItem(row) {
  const amountTwd = toFiniteNumber(row.amount_twd);
  const legacyCurrency = NATIVE_CURRENCIES.includes(row.original_currency) ? row.original_currency : null;
  const nativeCurrency = NATIVE_CURRENCIES.includes(row.native_currency)
    ? row.native_currency
    : legacyCurrency ?? (row.market === 'MANUAL' ? 'TWD' : null);
  const nativeAmount = toOptionalNumber(row.native_amount)
    ?? toOptionalNumber(row.original_amount)
    ?? (nativeCurrency === 'TWD' ? amountTwd : null);

  return {
    ...row,
    amount_twd: amountTwd,
    native_currency: nativeCurrency,
    native_amount: nativeAmount,
    fx_rate_twd: toOptionalNumber(row.fx_rate_twd),
    quantity: toOptionalNumber(row.quantity),
    average_cost: toOptionalNumber(row.average_cost),
    interest_rate: toOptionalNumber(row.interest_rate),
    monthly_payment_twd: toOptionalNumber(row.monthly_payment_twd),
  };
}

// 台帳連動的股票出清後，那一列是被更新成 0 股 0 元、不是刪掉 —— 再買回來要能接回
// 同一列（唯一索引建在 portfolio_stock_key 上）。但 0 股的部位不是資產，不該出現在
// 列表與統計裡。這裡只擋顯示，原始的 items 陣列不動：同步邏輯還要靠它找到那一列。
const isSoldOutHolding = item =>
  Boolean(item.portfolio_stock_key) && toFiniteNumber(item.quantity) <= 0;

export function getItemsForScope(items, ownerScope = null) {
  const held = (items ?? []).filter(item => !isSoldOutHolding(item));
  if (ownerScope === null) return held;
  if (!OWNER_SCOPES.includes(ownerScope)) return [];
  return held.filter(item => item.owner_scope === ownerScope);
}

export function calculateSummary(items, ownerScope = null) {
  const scoped = getItemsForScope(items, ownerScope);
  const assets = scoped.filter(item => item.kind === 'asset');
  const liabilities = scoped.filter(item => item.kind === 'liability');
  const totalAssets = assets.reduce((sum, item) => sum + toFiniteNumber(item.amount_twd), 0);
  const totalLiabilities = liabilities.reduce((sum, item) => sum + toFiniteNumber(item.amount_twd), 0);
  return {
    assets,
    liabilities,
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
  };
}

export function calculateAllocation(assets, totalAssets) {
  const grouped = assets.reduce((map, item) => {
    map[item.category] = (map[item.category] || 0) + toFiniteNumber(item.amount_twd);
    return map;
  }, {});
  return Object.entries(grouped)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, value]) => ({
      category,
      value,
      percent: totalAssets > 0 ? value / totalAssets * 100 : 0,
    }));
}

export function isValidSymbol(value) {
  return /^[0-9A-Z.-]{1,16}$/.test(String(value ?? '').trim().toUpperCase());
}
