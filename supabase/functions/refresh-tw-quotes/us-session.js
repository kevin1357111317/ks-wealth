// 美股時段判斷與夜盤報價合併。抽成純函式，index.ts 與 node 測試共用同一份。

// 美東時間的交易時段：盤前 04:00、盤中 09:30、盤後 16:00、20:00 收工。夏令時間由
// America/New_York 自己處理。國定假日不另外判斷 —— Yahoo 那天就沒有新的 K 棒，
// 回的是上一個交易日最後一筆，結果一樣對。
//
// 夜盤（Blue Ocean ATS）是週日到週四 20:00 到隔天 04:00，所以週五晚上、週六整天、
// 週日 20:00 以前都是 closed。
export function usSession(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  const weekday = part("weekday");
  if (weekday === "Sat") return "closed";
  if (weekday === "Sun") return minutes >= 1200 ? "overnight" : "closed";
  if (minutes >= 570 && minutes < 960) return "regular";
  if (minutes >= 240 && minutes < 570) return "pre";
  if (minutes >= 960 && minutes < 1200) return "post";
  if (minutes < 240) return "overnight";
  return weekday === "Fri" ? "closed" : "overnight";
}

// 夜盤價疊在 Yahoo 的報價上：Yahoo 那筆提供「最近一次正規收盤」當漲跌基準，
// 夜盤成交只換掉價格與時間。夜盤那筆比 Yahoo 舊（例如週日晚上剛開、還沒成交，
// Alpaca 回的是上週五凌晨那筆）就不用，維持 Yahoo 的盤後價。
export function mergeOvernight(base, hit) {
  if (!base || !hit || !(hit.price > 0)) return base;
  const baseAt = Date.parse(base.quotedAt ?? "");
  const hitAt = Date.parse(hit.at ?? "");
  if (!Number.isFinite(hitAt) || (Number.isFinite(baseAt) && hitAt <= baseAt)) return base;
  const previousClose = Number(base.price) - Number(base.change);
  if (!(previousClose > 0)) return base;
  const change = hit.price - previousClose;
  return {
    ...base,
    provider: "alpaca",
    price: hit.price,
    change,
    changePercent: change / previousClose * 100,
    session: "overnight",
    quotedAt: new Date(hitAt).toISOString(),
  };
}
