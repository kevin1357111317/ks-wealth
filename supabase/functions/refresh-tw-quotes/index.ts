import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const TROY_OUNCE_GRAMS = 31.1034768;
// 美股走 Finnhub，額度夠，所以快取只留 14 秒，多台裝置看到的價格才不會差一整分鐘。
// 匯率與黃金走 Twelve Data（免費額度較緊），維持 59 秒。
const US_QUOTE_TTL_MS = 14 * 1000;
const AUX_QUOTE_TTL_MS = 59 * 1000;
// 日圓存款用 USD/JPY 跟 USD/TWD 交叉出 JPY/TWD。日圓活存一天動不了幾次、金額也小，
// 不值得跟美股搶 Twelve Data 每分鐘 8 credits 的額度，快取放到 10 分鐘。
const JPY_QUOTE_TTL_MS = 10 * 60 * 1000;
// 對應 financial_items_quote_source_check；新增上游來源時要先改資料庫約束再加進來。
const ALLOWED_QUOTE_SOURCES = ["manual", "fugle", "twelve_data"];
const goldAmountTwd = (grams: number, xauUsd: number, usdTwd: number) =>
  Math.round((grams / TROY_OUNCE_GRAMS) * xauUsd * usdTwd);

// 美東時間的交易時段：盤前 04:00、盤中 09:30、盤後 16:00、20:00 收工。夏令時間由
// America/New_York 自己處理。國定假日不另外判斷 —— Yahoo 那天就沒有新的 K 棒，
// 回的是上一個交易日最後一筆，結果一樣對。
function usSession(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  if (part("weekday") === "Sat" || part("weekday") === "Sun") return "closed";
  if (minutes >= 570 && minutes < 960) return "regular";
  if (minutes >= 240 && minutes < 570) return "pre";
  if (minutes >= 960 && minutes < 1200) return "post";
  return "closed";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const fugleKey = Deno.env.get("FUGLE_MARKETDATA_API_KEY") ?? "";
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY") ?? "";
  const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
  if (!supabaseUrl || !publishableKey) return json({ error: "supabase_config_missing" }, 500);
  if (!fugleKey && !finnhubKey && !twelveKey) return json({ error: "market_keys_missing" }, 503);

  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const cache = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  if (!cache) return json({ error: "service_role_config_missing" }, 500);
  // 行情是系統衍生值：用 server-side writer 寫回，避免把每分鐘更新冒充成使用者編輯，
  // 也讓 audit trigger（只記 auth.uid()）保留給真正的人工變更。
  const quoteWriter = cache;

  const token = authHeader.slice(7);
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);

  let scope = "all";
  try {
    const body = await req.json();
    if (body?.scope === "tw" || body?.scope === "us") scope = body.scope;
  } catch { /* no body => all */ }

  const { data: items, error: itemError } = await client
    .from("financial_items")
    .select("id,name,symbol,market,quantity,amount_twd,native_currency,native_amount")
    .eq("kind", "asset");
  if (itemError) return json({ error: "items_unavailable", detail: itemError.message }, 500);

  const allItems = items ?? [];
  const marketItems = allItems.filter((item) => ["TW", "US"].includes(item.market) && item.symbol && Number(item.quantity) > 0);
  const goldItems = allItems.filter((item) => item.market === "GOLD");
  const usdCashItems = allItems.filter((item) => item.market === "MANUAL" && item.native_currency === "USD" && Number(item.native_amount) >= 0);
  const jpyCashItems = allItems.filter((item) => item.market === "MANUAL" && item.native_currency === "JPY" && Number(item.native_amount) >= 0);
  const validSymbol = (symbol: string) => /^[0-9A-Z.-]{1,16}$/.test(symbol);
  const twSymbols = [...new Set(marketItems.filter((x) => x.market === "TW").map((x) => String(x.symbol).toUpperCase()))].filter(validSymbol);
  const usSymbols = [...new Set(marketItems.filter((x) => x.market === "US").map((x) => String(x.symbol).toUpperCase()))].filter(validSymbol);

  const fetchTw = async (symbol: string) => {
    if (!fugleKey) return [`TW:${symbol}`, { error: "fugle_key_missing" }] as const;
    try {
      const response = await fetch(
        `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(symbol)}`,
        { headers: { "X-API-KEY": fugleKey, "Accept": "application/json" } },
      );
      if (!response.ok) return [`TW:${symbol}`, { error: `fugle_${response.status}` }] as const;
      const quote = await response.json();
      const price = Number(quote.lastPrice ?? quote.closePrice ?? quote.previousClose);
      if (!Number.isFinite(price) || price <= 0) return [`TW:${symbol}`, { error: "price_unavailable" }] as const;
      return [`TW:${symbol}`, {
        provider: "fugle",
        currency: "TWD",
        price,
        change: Number(quote.change ?? 0),
        changePercent: Number(quote.changePercent ?? 0),
        date: quote.date ?? null,
        lastUpdated: quote.lastUpdated ?? null,
        cached: false,
      }] as const;
    } catch {
      return [`TW:${symbol}`, { error: "fugle_unreachable" }] as const;
    }
  };

  // Finnhub 的美股報價。快車道與完整那一輪共用同一段，差別只在快車道不讀快取、不寫資料庫。
  const finnhubQuote = async (symbol: string) => {
    if (!finnhubKey) return null;
    try {
      const response = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(finnhubKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const quote = await response.json();
      const price = Number(quote.c);
      if (!response.ok || !Number.isFinite(price) || price <= 0) return null;
      return {
        provider: "finnhub",
        currency: "USD",
        price,
        change: Number(quote.d ?? 0),
        changePercent: Number(quote.dp ?? 0),
        quotedAt: quote.t ? new Date(Number(quote.t) * 1000).toISOString() : null,
        updatedAt: new Date().toISOString(),
        cached: false,
      } as const;
    } catch {
      return null;   // 改走 Twelve Data 備援
    }
  };

  // 盤前、盤後與收工時段 Finnhub 只會停在收盤價，改抓 Yahoo 的一分鐘線（含盤前盤後）。
  // Yahoo 的美股報價是即時的（Nasdaq Real Time Price），不用金鑰。盤中維持 Finnhub。
  // 漲跌一律對「前一個交易日收盤」：盤後看到的是整天加盤後的變化，盤前看到的是隔夜的變化。
  const yahooQuote = async (symbol: string) => {
    try {
      const response = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
        { headers: { "Accept": "application/json", "User-Agent": "KS-Wealth/1.0" } },
      );
      if (!response.ok) return null;
      const result = (await response.json())?.chart?.result?.[0];
      const meta = result?.meta ?? {};
      const stamps: number[] = result?.timestamp ?? [];
      const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
      let index = closes.length - 1;
      while (index >= 0 && !(Number(closes[index]) > 0)) index -= 1;
      const price = index >= 0 ? Number(closes[index]) : Number(meta.regularMarketPrice);
      const at = index >= 0 ? Number(stamps[index]) : Number(meta.regularMarketTime);
      const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose);
      if (!(price > 0) || !(previousClose > 0) || !Number.isFinite(at)) return null;
      const change = price - previousClose;
      return {
        provider: "yahoo",
        currency: "USD",
        price,
        change,
        changePercent: change / previousClose * 100,
        // 這一筆成交落在哪個時段，前端據此標「盤前」「盤後」。
        session: usSession(new Date(at * 1000)),
        quotedAt: new Date(at * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        cached: false,
      } as const;
    } catch {
      return null;   // 改走 Finnhub
    }
  };
  const extendedHours = usSession() !== "regular";
  const liveUsQuote = async (symbol: string) => extendedHours
    ? (await yahooQuote(symbol)) ?? (await finnhubQuote(symbol))
    : await finnhubQuote(symbol);

  // 台股走獨立快車道：前端每 5 秒呼叫，只回價格、不寫資料庫。
  if (scope === "tw") {
    const entries = await Promise.all(twSymbols.map(fetchTw));
    const bySymbol = new Map(entries);
    return json({
      scope: "tw",
      source: "fugle",
      requestedAt: new Date().toISOString(),
      results: marketItems.filter((item) => item.market === "TW").map((item) => {
        const quote = bySymbol.get(`TW:${String(item.symbol).toUpperCase()}`);
        return !quote || "error" in quote
          ? { id: item.id, name: item.name, symbol: item.symbol, market: "TW", status: "error", error: quote?.error ?? "invalid_symbol" }
          : { id: item.id, name: item.name, symbol: item.symbol, market: "TW", status: "quote_only", ...quote };
      }),
    });
  }

  // 美股快車道：前端每 15 秒呼叫，只打 Finnhub（盤前盤後改 Yahoo）、只回價格、不寫資料庫。理由跟台股同一條 ——
  // 寫 financial_items 會觸發 realtime 訂閱，每 15 秒把整本私帳重載一次。
  // 也不讀 klfan_quotes 的快取：快車道要的就是當下的價，讀快取反而拿到最多 14 秒前的值。
  // 台幣市值由前端用手上的匯率換算；匯率是慢變數，沿用 60 秒那輪的值就夠。
  if (scope === "us") {
    const entries = await Promise.all(usSymbols.map(async (symbol) =>
      [symbol, await liveUsQuote(symbol)] as const));
    const bySymbol = new Map(entries);
    return json({
      scope: "us",
      source: extendedHours ? "yahoo" : "finnhub",
      requestedAt: new Date().toISOString(),
      results: marketItems.filter((item) => item.market === "US").map((item) => {
        const quote = bySymbol.get(String(item.symbol).toUpperCase());
        return quote
          ? { id: item.id, name: item.name, symbol: item.symbol, market: "US", status: "quote_only", ...quote }
          : { id: item.id, name: item.name, symbol: item.symbol, market: "US", status: "error", error: finnhubKey ? "finnhub_unavailable" : "finnhub_key_missing" };
      }),
    });
  }

  type CachedQuote = {
    price: number;
    change: number;
    changePercent: number;
    quotedAt: string | null;
    updatedAt: string | null;
    provider: string;
  };

  const cachedUsFresh = new Map<string, CachedQuote>();
  const cachedUsStale = new Map<string, CachedQuote>();
  let cachedFxFresh: number | null = null;
  let cachedFxStale: number | null = null;
  let cachedFxRow: Record<string, unknown> | null = null;
  let cachedGoldFresh: number | null = null;
  let cachedGoldStale: number | null = null;
  let cachedUsdJpyFresh: number | null = null;
  let cachedUsdJpyStale: number | null = null;
  let cacheError: string | null = null;

  if (cache) {
    const [quotesResult, goldResult] = await Promise.all([
      cache.from("klfan_quotes").select("symbol,price,change,change_percent,source,quoted_at,updated_at"),
      cache.from("ks_quote_cache").select("symbol,price,updated_at").in("symbol", ["XAU/USD", "USD/JPY"]),
    ]);
    if (quotesResult.error) cacheError = quotesResult.error.message;
    // 14 秒的短快取是靠 Finnhub 的額度撐的。沒有 Finnhub 就會退回 Twelve Data，
    // 那把 key 跟 KLFAN 共用、額度很緊，這時要維持 59 秒，不能把 credit 燒成四倍。
    const usFreshFloor = Date.now() - (finnhubKey ? US_QUOTE_TTL_MS : AUX_QUOTE_TTL_MS);
    const auxFreshFloor = Date.now() - AUX_QUOTE_TTL_MS;
    for (const row of quotesResult.data ?? []) {
      const raw = String(row.symbol ?? "").trim();
      const price = Number(row.price);
      if (!raw || !Number.isFinite(price) || price <= 0) continue;
      const updatedAt = String(row.updated_at ?? "");
      if (raw === "USD/TWD") {
        cachedFxStale = price;
        // 沿用快取的匯率重寫回去時要保留原本的時間戳，不能假裝匯率也剛更新。
        cachedFxRow = {
          symbol: "USD/TWD", price, currency: "TWD", change: row.change ?? null,
          change_percent: row.change_percent ?? null, source: row.source ?? "twelve_data",
          quoted_at: row.quoted_at ?? null, updated_at: row.updated_at ?? null,
        };
        if (Date.parse(updatedAt) >= auxFreshFloor) cachedFxFresh = price;
        continue;
      }
      if (raw.startsWith("TPE:") || raw.startsWith("TWO:")) continue;
      const code = raw.slice(raw.lastIndexOf(":") + 1).toUpperCase();
      if (!code) continue;
      const hit = {
        price,
        change: Number(row.change ?? 0),
        changePercent: Number(row.change_percent ?? 0),
        quotedAt: row.quoted_at ?? null,
        updatedAt: row.updated_at ?? null,
        provider: String(row.source ?? "twelve_data"),
      };
      cachedUsStale.set(code, hit);
      if (Date.parse(updatedAt) >= usFreshFloor) cachedUsFresh.set(code, hit);
    }
    for (const row of goldResult.data ?? []) {
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const updatedAt = Date.parse(String(row.updated_at ?? ""));
      if (row.symbol === "XAU/USD") {
        cachedGoldStale = price;
        if (updatedAt >= auxFreshFloor) cachedGoldFresh = price;
      } else if (row.symbol === "USD/JPY") {
        cachedUsdJpyStale = price;
        if (updatedAt >= Date.now() - JPY_QUOTE_TTL_MS) cachedUsdJpyFresh = price;
      }
    }
  }

  let fxFetched = false;
  let fxError: string | null = null;
  const needsUsdFx = usSymbols.length > 0 || usdCashItems.length > 0 || goldItems.length > 0 || jpyCashItems.length > 0;
  const fetchFx = async () => {
    if (!needsUsdFx) return { rate: null as number | null, fetched: false, error: null as string | null };
    if (cachedFxFresh !== null) return { rate: cachedFxFresh, fetched: false, error: null as string | null };
    if (!twelveKey) return { rate: cachedFxStale, fetched: false, error: "twelve_key_missing" };
    try {
      const response = await fetch(
        `https://api.twelvedata.com/exchange_rate?symbol=USD%2FTWD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const data = await response.json();
      const rate = Number(data.rate);
      if (!response.ok || data.status === "error" || !Number.isFinite(rate) || rate <= 0) {
        return { rate: cachedFxStale, fetched: false, error: data.code ? `twelve_${data.code}` : "fx_unavailable" };
      }
      return { rate, fetched: true, error: null as string | null };
    } catch {
      return { rate: cachedFxStale, fetched: false, error: "twelve_unreachable" };
    }
  };

  const fetchUs = async (symbol: string) => {
    const fresh = cachedUsFresh.get(symbol);
    // 快取裡沒存時段；盤前盤後寫進去的也是那個時段的價，照現在的時段標（收工後沿用盤後）。
    if (fresh) return [`US:${symbol}`, { currency: "USD", ...fresh, cached: true, session: extendedHours ? (usSession() === "pre" ? "pre" : "post") : "regular" }] as const;
    // Finnhub 為主、Twelve Data 為備援：Finnhub 的免費額度高很多，撐得起 14 秒的快取。
    // 沒有 Finnhub key 時不要 await —— 多一個 microtask 會讓 Twelve Data 的請求晚一拍發出，
    // 額度用完時被餓死的就從黃金變成美股，那是既有行為，不該被這次重構改掉。
    if (extendedHours) {
      const extended = await yahooQuote(symbol);
      if (extended) return [`US:${symbol}`, extended] as const;
    }
    if (finnhubKey) {
      const live = await finnhubQuote(symbol);
      if (live) return [`US:${symbol}`, live] as const;
    }
    if (!twelveKey) {
      const stale = cachedUsStale.get(symbol);
      return stale
        ? [`US:${symbol}`, { currency: "USD", ...stale, cached: true, stale: true }] as const
        : [`US:${symbol}`, { error: finnhubKey ? "finnhub_unavailable" : "market_key_missing" }] as const;
    }
    try {
      const response = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const quote = await response.json();
      const price = Number(quote.close);
      if (!response.ok || quote.status === "error" || !Number.isFinite(price) || price <= 0) {
        const stale = cachedUsStale.get(symbol);
        return stale
          ? [`US:${symbol}`, { provider: "twelve_data", currency: "USD", ...stale, cached: true, stale: true }] as const
          : [`US:${symbol}`, { error: quote.code ? `twelve_${quote.code}` : "price_unavailable" }] as const;
      }
      return [`US:${symbol}`, {
        provider: "twelve_data",
        currency: "USD",
        price,
        change: Number(quote.change ?? 0),
        changePercent: Number(quote.percent_change ?? 0),
        quotedAt: quote.datetime ?? null,
        updatedAt: quote.timestamp ? new Date(Number(quote.timestamp) * 1000).toISOString() : new Date().toISOString(),
        cached: false,
      }] as const;
    } catch {
      const stale = cachedUsStale.get(symbol);
      return stale
        ? [`US:${symbol}`, { provider: "twelve_data", currency: "USD", ...stale, cached: true, stale: true }] as const
        : [`US:${symbol}`, { error: "twelve_unreachable" }] as const;
    }
  };

  const fetchGold = async () => {
    if (goldItems.length === 0) return { price: null as number | null, fetched: false, error: null as string | null, cached: false };
    if (cachedGoldFresh !== null) return { price: cachedGoldFresh, fetched: false, error: null as string | null, cached: true };
    if (!twelveKey) return { price: cachedGoldStale, fetched: false, error: "twelve_key_missing", cached: cachedGoldStale !== null };
    try {
      const response = await fetch(
        `https://api.twelvedata.com/quote?symbol=XAU%2FUSD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const quote = await response.json();
      const price = Number(quote.close);
      if (!response.ok || quote.status === "error" || !Number.isFinite(price) || price <= 0) {
        return { price: cachedGoldStale, fetched: false, error: quote.code ? `twelve_${quote.code}` : "gold_unavailable", cached: cachedGoldStale !== null };
      }
      return { price, fetched: true, error: null as string | null, cached: false };
    } catch {
      return { price: cachedGoldStale, fetched: false, error: "twelve_unreachable", cached: cachedGoldStale !== null };
    }
  };

  const fetchUsdJpy = async () => {
    if (jpyCashItems.length === 0) return { rate: null as number | null, fetched: false, error: null as string | null, cached: false };
    if (cachedUsdJpyFresh !== null) return { rate: cachedUsdJpyFresh, fetched: false, error: null as string | null, cached: true };
    if (!twelveKey) return { rate: cachedUsdJpyStale, fetched: false, error: "twelve_key_missing", cached: cachedUsdJpyStale !== null };
    try {
      const response = await fetch(
        `https://api.twelvedata.com/exchange_rate?symbol=USD%2FJPY&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const data = await response.json();
      const rate = Number(data.rate);
      if (!response.ok || data.status === "error" || !Number.isFinite(rate) || rate <= 0) {
        return { rate: cachedUsdJpyStale, fetched: false, error: data.code ? `twelve_${data.code}` : "jpy_unavailable", cached: cachedUsdJpyStale !== null };
      }
      return { rate, fetched: true, error: null as string | null, cached: false };
    } catch {
      return { rate: cachedUsdJpyStale, fetched: false, error: "twelve_unreachable", cached: cachedUsdJpyStale !== null };
    }
  };

  // 台股、匯率、美股、黃金同時發出去，避免原本串行等待造成的延遲。
  const [twEntries, fxResult, usEntries, goldResult, usdJpyResult] = await Promise.all([
    Promise.all(twSymbols.map(fetchTw)),
    fetchFx(),
    Promise.all(usSymbols.map(fetchUs)),
    fetchGold(),
    fetchUsdJpy(),
  ]);

  const fxRate = fxResult.rate;
  fxFetched = fxResult.fetched;
  fxError = fxResult.error;
  const xauUsd = goldResult.price;
  const goldError = goldResult.error;
  const usdJpy = usdJpyResult.rate;
  // 交叉匯率：1 JPY = (USD/TWD) ÷ (USD/JPY) TWD。
  const jpyTwd = fxRate && usdJpy ? Number((fxRate / usdJpy).toFixed(6)) : null;
  const jpyError = usdJpyResult.error ?? (usdJpy && !fxRate ? fxError ?? "fx_unavailable" : null);

  if (cache && goldResult.fetched && xauUsd) {
    await cache.from("ks_quote_cache")
      .upsert({ symbol: "XAU/USD", price: xauUsd, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
  }
  if (cache && usdJpyResult.fetched && usdJpy) {
    await cache.from("ks_quote_cache")
      .upsert({ symbol: "USD/JPY", price: usdJpy, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
  }

  let fxDailyError: string | null = null;
  if (cache && fxRate !== null) {
    const taipeiToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const { error } = await cache.from("klfan_fx_daily")
      .upsert({ fx_date: taipeiToday, rate: fxRate }, { onConflict: "fx_date" });
    if (error) fxDailyError = error.message;
  }

  const quotes = new Map([...twEntries, ...usEntries]);
  const pendingUpdates: Promise<Record<string, unknown>>[] = [];

  for (const item of marketItems) {
    pendingUpdates.push((async () => {
      const symbol = String(item.symbol).toUpperCase();
      const quote = quotes.get(`${item.market}:${symbol}`);
      if (!quote || "error" in quote) {
        return { id: item.id, name: item.name, symbol, market: item.market, status: "error", error: quote?.error ?? "invalid_symbol" };
      }
      const quantity = Number(item.quantity);
      const conversion = item.market === "US" ? fxRate : 1;
      if (!Number.isFinite(quantity) || quantity <= 0 || !conversion) {
        return { id: item.id, name: item.name, symbol, market: item.market, status: "price_only", warning: !conversion ? fxError ?? "fx_unavailable" : "quantity_missing", ...quote };
      }
      const amountTwd = Math.round(Number(quote.price) * quantity * conversion);
      const { error } = await quoteWriter.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: item.market === "US" ? conversion : 1,
        // financial_items.quote_source 有 CHECK 約束，只收 manual/fugle/twelve_data。
        // Finnhub 這類新來源寫進去會讓整筆 update 失敗，所以收斂成允許值；
        // 真正的上游來源留在 klfan_quotes.source。
        quote_source: item.market === "US"
          ? (ALLOWED_QUOTE_SOURCES.includes(String(quote.provider)) ? String(quote.provider) : "twelve_data")
          : "fugle",
      }).eq("id", item.id);
      return error
        ? { id: item.id, name: item.name, symbol, market: item.market, status: "error", error: error.message, ...quote }
        : { id: item.id, name: item.name, symbol, market: item.market, status: "updated", quantity, amountTwd, ...quote, fxRate: item.market === "US" ? conversion : 1 };
    })());
  }

  for (const item of usdCashItems) {
    pendingUpdates.push((async () => {
      if (!fxRate) return { id: item.id, name: item.name, market: "MANUAL", status: "error", error: fxError ?? "fx_unavailable" };
      const nativeAmount = Number(item.native_amount);
      const amountTwd = Math.round(nativeAmount * fxRate);
      const { error } = await quoteWriter.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: fxRate,
        quote_currency: "USD",
        quote_source: "twelve_data",
      }).eq("id", item.id);
      return error
        ? { id: item.id, name: item.name, market: "MANUAL", status: "error", error: error.message }
        : { id: item.id, name: item.name, market: "MANUAL", status: "updated", currency: "USD", nativeAmount, amountTwd, fxRate };
    })());
  }

  for (const item of jpyCashItems) {
    pendingUpdates.push((async () => {
      if (!jpyTwd) return { id: item.id, name: item.name, market: "MANUAL", status: "error", error: jpyError ?? "jpy_unavailable" };
      const nativeAmount = Number(item.native_amount);
      const amountTwd = Math.round(nativeAmount * jpyTwd);
      const { error } = await quoteWriter.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: jpyTwd,
        quote_currency: "JPY",
        quote_source: "twelve_data",
      }).eq("id", item.id);
      return error
        ? { id: item.id, name: item.name, market: "MANUAL", status: "error", error: error.message }
        : { id: item.id, name: item.name, market: "MANUAL", status: "updated", currency: "JPY", nativeAmount, amountTwd, fxRate: jpyTwd };
    })());
  }

  for (const item of goldItems) {
    pendingUpdates.push((async () => {
      const grams = Number(item.quantity);
      if (!Number.isFinite(grams) || grams <= 0) {
        return { id: item.id, name: item.name, market: "GOLD", status: "price_only", warning: "weight_missing", currency: "USD", price: xauUsd };
      }
      if (!xauUsd || !fxRate) {
        return { id: item.id, name: item.name, market: "GOLD", status: "error", error: goldError ?? fxError ?? "gold_unavailable" };
      }
      const amountTwd = goldAmountTwd(grams, xauUsd, fxRate);
      const { error } = await quoteWriter.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: fxRate,
        quote_currency: "USD",
        quote_source: "twelve_data",
      }).eq("id", item.id);
      return error
        ? { id: item.id, name: item.name, market: "GOLD", status: "error", error: error.message, currency: "USD", price: xauUsd }
        : { id: item.id, name: item.name, market: "GOLD", status: "updated", grams, amountTwd, currency: "USD", price: xauUsd, fxRate, cached: goldResult.cached };
    })());
  }

  const results = await Promise.all(pendingUpdates);

  // 美股每 14 秒更新；匯率沿用較長快取時要保留原時間戳，不能假裝匯率也剛更新。
  let cacheWrite: string | null = null;
  if (cache && fxRate !== null) {
    const freshUs = new Map<string, { price: number; change: number; changePercent: number; provider: string }>();
    for (const [key, quote] of usEntries) {
      if ("error" in quote || quote.cached) continue;
      freshUs.set(key.slice(3), { price: Number(quote.price), change: Number(quote.change ?? 0), changePercent: Number(quote.changePercent ?? 0), provider: String(quote.provider) });
    }
    const freshTw = new Map<string, { price: number; change: number; changePercent: number }>();
    for (const [key, quote] of twEntries) {
      if ("error" in quote) continue;
      freshTw.set(key.slice(3), { price: Number(quote.price), change: Number(quote.change ?? 0), changePercent: Number(quote.changePercent ?? 0) });
    }

    // 全部命中快取代表這一輪根本沒抓到新價，本來就沒東西好寫（cacheWrite 維持 null）。
    // 只有一部分是新的才是真的被擋下來 —— 那要留個字串，不然回應上看不出差別。
    const staleUs = usSymbols.filter((symbol) => !freshUs.has(symbol));
    if (staleUs.length) {
      cacheWrite = staleUs.length === usSymbols.length ? null : "skipped_stale_us";
    } else {
    const { data: liveRows, error: liveError } = await cache.from("klfan_live_symbols").select("symbol");
    if (liveError) {
      cacheWrite = liveError.message;
    } else {
      const live = new Map<string, string>();
      for (const row of liveRows ?? []) {
        const raw = String(row.symbol ?? "").trim();
        if (raw) live.set(raw.slice(raw.lastIndexOf(":") + 1).toUpperCase(), raw);
      }
      const quoteOf = (code: string) => freshTw.get(code) ?? freshUs.get(code);
      const covered = [...live.keys()].every((code) => quoteOf(code) !== undefined);
      if (!covered) {
        cacheWrite = "skipped_partial_coverage";
      } else {
        const now = new Date().toISOString();
        const rows: Record<string, unknown>[] = [fxFetched || cachedFxRow === null
          ? { symbol: "USD/TWD", price: fxRate, currency: "TWD", change: null, change_percent: null, source: "twelve_data", quoted_at: now, updated_at: now }
          : cachedFxRow];
        for (const [code, key] of live) {
          const tw = freshTw.has(code);
          const quote = quoteOf(code)!;
          rows.push({
            symbol: key,
            price: quote.price,
            currency: tw ? "TWD" : "USD",
            change: quote.change,
            change_percent: quote.changePercent,
            source: tw ? "fugle" : freshUs.get(code)?.provider ?? "twelve_data",
            quoted_at: now,
            updated_at: now,
          });
        }
        const { error } = await cache.from("klfan_quotes").upsert(rows, { onConflict: "symbol" });
        if (error) {
          cacheWrite = error.message;
        } else {
          const keep = rows.map((row) => `"${row.symbol}"`).join(",");
          const { error: pruneError } = await cache.from("klfan_quotes").delete().not("symbol", "in", `(${keep})`);
          cacheWrite = pruneError ? `wrote_${rows.length}_prune_failed` : `wrote_${rows.length}`;
        }
      }
    }
    }
  }

  return json({
    source: finnhubKey ? "fugle+finnhub+twelve_data" : "fugle+twelve_data",
    requestedAt: new Date().toISOString(),
    cache: { read: cachedUsFresh.size + (cachedFxFresh === null ? 0 : 1) + (cachedGoldFresh === null ? 0 : 1), write: cacheWrite, error: cacheError, usTtlMs: US_QUOTE_TTL_MS, auxTtlMs: AUX_QUOTE_TTL_MS },
    fx: { symbol: "USD/TWD", rate: fxRate, error: fxError, dailyError: fxDailyError, cached: !fxFetched && fxRate !== null },
    gold: { symbol: "XAU/USD", price: xauUsd, error: goldError, cached: goldResult.cached },
    jpy: { symbol: "JPY/TWD", rate: jpyTwd, usdJpy, error: jpyError, cached: usdJpyResult.cached },
    updated: results.filter((x) => x.status === "updated").length,
    priceOnly: results.filter((x) => x.status === "price_only").length,
    failed: results.filter((x) => x.status === "error").length,
    results,
  });
});
