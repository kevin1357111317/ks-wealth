// 股票質押的擔保維持率 = 擔保品市值 ÷ 借款本金。元大證金整戶低於 140% 就寄追繳通知，
// 三個營業日內沒補足就處分擔保品（一般券商是 130%，證金比較嚴）。
//
// 擔保品寫在 loan_accounts.source_note，用人看得懂的一行字，不另外開欄位：
//   擔保品：2330 × 1000 股；追繳維持率 140%
// 多檔擔保品用「、」分開：擔保品：2330 × 1000 股、0050 × 2000 股
export const DEFAULT_MARGIN_CALL = 1.4;

export function parseCollateral(note) {
  const text = String(note ?? '');
  const line = /擔保品[:：]([^；;\n]+)/.exec(text)?.[1] ?? '';
  const collateral = [...line.matchAll(/([0-9A-Z]{2,8})\s*[×xX*]\s*([\d,]+)\s*股/g)]
    .map(match => ({ symbol: match[1], shares: Number(match[2].replace(/,/g, '')) }))
    .filter(row => row.shares > 0);
  const call = Number(/追繳維持率\s*(\d+(?:\.\d+)?)\s*%/.exec(text)?.[1]);
  return { collateral, marginCall: call > 0 ? call / 100 : DEFAULT_MARGIN_CALL };
}

// priceOf(symbol) 回目前股價；任何一檔抓不到價就整個不算，寧可不顯示也不要顯示錯的維持率。
export function maintenanceRatio({ principal, collateral, marginCall = DEFAULT_MARGIN_CALL, priceOf }) {
  const loan = Number(principal);
  if (!(loan > 0) || !collateral?.length) return null;
  let value = 0;
  for (const row of collateral) {
    const price = Number(priceOf(row.symbol));
    if (!(price > 0)) return null;
    value += price * row.shares;
  }
  const ratio = value / loan;
  // 擔保品整體再跌多少會碰到追繳線。只有一檔時就是「股價跌到多少」。
  const cushion = 1 - marginCall / ratio;
  const single = collateral.length === 1 ? collateral[0] : null;
  return {
    ratio,
    value,
    marginCall,
    cushion,
    callPrice: single ? marginCall * loan / single.shares : null,
    level: ratio < marginCall ? 'danger' : ratio < marginCall + 0.3 ? 'warn' : 'ok',
  };
}
