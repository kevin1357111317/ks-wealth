// Supabase 各台伺服器的時鐘會差個一兩秒。token 一換好就馬上打 PostgREST，偶爾會碰到時鐘
// 較慢的那台，它看 token 的 iat 還在「未來」就回 401 PGRST303「JWT issued at future」。
// 2026-09-28 13:08:52 換的 token，53.1 秒送出的 11 個請求裡只有 financial_items 被擋，
// 首頁就整個變成錯誤畫面。
//
// 401 代表請求在驗 JWT 時就被拒了，資料庫根本沒執行，所以寫入也能安全重送。只認這一種錯，
// 其他 401（真的過期、被登出）照原樣回去，不拖延。
const CLOCK_SKEW = /PGRST303|issued at future/i;

async function isClockSkew(response) {
  if (response?.status !== 401) return false;
  try {
    return CLOCK_SKEW.test(await response.clone().text());
  } catch {
    return false;
  }
}

export function withClockSkewRetry(fetchImpl, {
  delays = [1000, 2000],
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  return async (input, init) => {
    let response = await fetchImpl(input, init);
    for (const delay of delays) {
      if (!(await isClockSkew(response))) return response;
      await sleep(delay);
      response = await fetchImpl(input, init);
    }
    return response;
  };
}
