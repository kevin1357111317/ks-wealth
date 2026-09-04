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
const goldAmountTwd = (grams: number, xauUsd: number, usdTwd: number) =>
  Math.round((grams / TROY_OUNCE_GRAMS) * xauUsd * usdTwd);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const fugleKey = Deno.env.get("FUGLE_MARKETDATA_API_KEY") ?? "";
  const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
  if (!supabaseUrl || !publishableKey) return json({ error: "supabase_config_missing" }, 500);
  if (!fugleKey && !twelveKey) return json({ error: "market_keys_missing" }, 503);

  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = authHeader.slice(7);
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);

  const { data: items, error: itemError } = await client
    .from("financial_items")
    .select("id,name,symbol,market,quantity,amount_twd,native_currency,native_amount")
    .eq("kind", "asset");

  if (itemError) return json({ error: "items_unavailable", detail: itemError.message }, 500);

  const marketItems = (items ?? []).filter((item) => ["TW", "US"].includes(item.market) && item.symbol);
  const goldItems = (items ?? []).filter((item) => item.market === "GOLD");
  const usdCashItems = (items ?? []).filter((item) => item.market === "MANUAL" && item.native_currency === "USD" && Number(item.native_amount) >= 0);
  const validSymbol = (symbol: string) => /^[0-9A-Z.-]{1,16}$/.test(symbol);
  const twSymbols = [...new Set(marketItems.filter((x) => x.market === "TW").map((x) => String(x.symbol).toUpperCase()))].filter(validSymbol);
  const usSymbols = [...new Set(marketItems.filter((x) => x.market === "US").map((x) => String(x.symbol).toUpperCase()))].filter(validSymbol);

  // ── 共用報價快取 ───────────────────────────────────────────────────────────
  // 這個 Supabase 專案同時服務兩個 App（本專案與 KLFAN），兩邊共用同一把
  // TWELVE_DATA_API_KEY。免費方案是每分鐘 8 credits、一個 symbol 算一個，
  // 而各自抓一輪剛好是 9 個：這裡 USD/TWD + 三檔美股 + XAU/USD，KLFAN 三檔
  // 美股 + USD/TWD。超額的那一個被 429 擋掉，而且必然是排在最後的 XAU/USD
  // —— 2026-09-04 08:25 只有黃金沒更新就是這樣來的。
  //
  // KLFAN 的 klfan_quotes 已經是一張現成的報價表，它要的美股與匯率跟這裡完全
  // 重疊，所以：夠新就直接沿用，只有真的缺的才去打 API。台股走 Fugle、沒有額度
  // 問題，一律重抓，只記下 KLFAN 追哪幾檔（決定能不能寫回，見下方）。
  // 讀寫走 service role，不必為了快取放寬 klfan_quotes 的 RLS。
  const QUOTE_CACHE_TTL_MS = 10 * 60 * 1000;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cache = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  type CachedQuote = { price: number; change: number; changePercent: number; quotedAt: string | null };
  const cachedUs = new Map<string, CachedQuote>();  // 'QQQ' -> 夠新、可直接沿用的報價
  const cacheKeyFor = new Map<string, string>();    // 'QQQ' -> 'NASDAQ:QQQ'（KLFAN 的原始 key）
  const cachedTwCodes = new Set<string>();          // KLFAN 追蹤的台股代碼
  let cachedFx: number | null = null;
  let cacheError: string | null = null;

  if (cache) {
    const { data: cacheRows, error } = await cache
      .from("klfan_quotes")
      .select("symbol,price,change,change_percent,quoted_at,updated_at");
    if (error) cacheError = error.message;
    const floor = Date.now() - QUOTE_CACHE_TTL_MS;
    for (const row of cacheRows ?? []) {
      const raw = String(row.symbol ?? "").trim();
      if (!raw) continue;
      const price = Number(row.price);
      const fresh = Date.parse(String(row.updated_at ?? "")) >= floor && Number.isFinite(price) && price > 0;
      if (raw === "USD/TWD") {
        if (fresh) cachedFx = price;
        continue;
      }
      const code = raw.slice(raw.lastIndexOf(":") + 1).toUpperCase();
      if (!code) continue;
      cacheKeyFor.set(code, raw);
      if (raw.startsWith("TPE:") || raw.startsWith("TWO:")) {
        cachedTwCodes.add(code);
        continue;
      }
      if (fresh) cachedUs.set(code, { price, change: Number(row.change ?? 0), changePercent: Number(row.change_percent ?? 0), quotedAt: row.quoted_at ?? null });
    }
  }

  const twEntries = await Promise.all(twSymbols.map(async (symbol) => {
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
      }] as const;
    } catch {
      return [`TW:${symbol}`, { error: "fugle_unreachable" }] as const;
    }
  }));

  let fxRate: number | null = cachedFx;
  let fxError: string | null = null;
  let fxFetched = false;
  const needsUsdFx = usSymbols.length > 0 || usdCashItems.length > 0 || goldItems.length > 0;
  if (needsUsdFx && fxRate === null && twelveKey) {
    try {
      const response = await fetch(
        `https://api.twelvedata.com/exchange_rate?symbol=USD%2FTWD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const data = await response.json();
      const rate = Number(data.rate);
      if (!response.ok || data.status === "error" || !Number.isFinite(rate) || rate <= 0) fxError = data.code ? `twelve_${data.code}` : "fx_unavailable";
      else {
        fxRate = rate;
        fxFetched = true;
      }
    } catch {
      fxError = "twelve_unreachable";
    }
  } else if (needsUsdFx && fxRate === null) {
    fxError = "twelve_key_missing";
  }

  const usEntries = await Promise.all(usSymbols.map(async (symbol) => {
    const hit = cachedUs.get(symbol);
    if (hit) {
      return [`US:${symbol}`, {
        provider: "twelve_data",
        currency: "USD",
        price: hit.price,
        change: hit.change,
        changePercent: hit.changePercent,
        date: hit.quotedAt,
        lastUpdated: hit.quotedAt,
        fxRate,
        cached: true,
      }] as const;
    }
    if (!twelveKey) return [`US:${symbol}`, { error: "twelve_key_missing" }] as const;
    try {
      const response = await fetch(
        `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const quote = await response.json();
      if (!response.ok || quote.status === "error") return [`US:${symbol}`, { error: quote.code ? `twelve_${quote.code}` : `twelve_${response.status}` }] as const;
      const price = Number(quote.close);
      if (!Number.isFinite(price) || price <= 0) return [`US:${symbol}`, { error: "price_unavailable" }] as const;
      return [`US:${symbol}`, {
        provider: "twelve_data",
        currency: "USD",
        price,
        change: Number(quote.change ?? 0),
        changePercent: Number(quote.percent_change ?? 0),
        date: quote.datetime ?? null,
        lastUpdated: quote.timestamp ?? null,
        fxRate,
        cached: false,
      }] as const;
    } catch {
      return [`US:${symbol}`, { error: "twelve_unreachable" }] as const;
    }
  }));

  let xauUsd: number | null = null;
  let goldError: string | null = null;
  if (goldItems.length > 0 && twelveKey) {
    try {
      const response = await fetch(
        `https://api.twelvedata.com/quote?symbol=XAU%2FUSD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const quote = await response.json();
      const price = Number(quote.close);
      if (!response.ok || quote.status === "error" || !Number.isFinite(price) || price <= 0) {
        goldError = quote.code ? `twelve_${quote.code}` : "gold_unavailable";
      } else xauUsd = price;
    } catch {
      goldError = "twelve_unreachable";
    }
  } else if (goldItems.length > 0) {
    goldError = "twelve_key_missing";
  }

  const quotes = new Map([...twEntries, ...usEntries]);
  const results = [];

  for (const item of marketItems) {
    const symbol = String(item.symbol).toUpperCase();
    const quote = quotes.get(`${item.market}:${symbol}`);
    if (!quote || "error" in quote) {
      results.push({ id: item.id, name: item.name, symbol, market: item.market, status: "error", error: quote?.error ?? "invalid_symbol" });
      continue;
    }

    const quantity = Number(item.quantity);
    const conversion = item.market === "US" ? fxRate : 1;
    if (!Number.isFinite(quantity) || quantity <= 0 || !conversion) {
      results.push({
        id: item.id,
        name: item.name,
        symbol,
        market: item.market,
        status: "price_only",
        warning: !conversion ? fxError ?? "fx_unavailable" : "quantity_missing",
        ...quote,
      });
      continue;
    }

    const amountTwd = Math.round(quote.price * quantity * conversion);
    const { error: updateError } = await client
      .from("financial_items")
      .update({
        amount_twd: amountTwd,
        fx_rate_twd: item.market === "US" ? conversion : 1,
        quote_source: item.market === "US" ? "twelve_data" : "fugle",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);

    results.push(updateError
      ? { id: item.id, name: item.name, symbol, market: item.market, status: "error", error: updateError.message, ...quote }
      : { id: item.id, name: item.name, symbol, market: item.market, status: "updated", quantity, amountTwd, ...quote });
  }

  for (const item of usdCashItems) {
    if (!fxRate) {
      results.push({ id: item.id, name: item.name, market: "MANUAL", status: "error", error: fxError ?? "fx_unavailable" });
      continue;
    }
    const nativeAmount = Number(item.native_amount);
    const amountTwd = Math.round(nativeAmount * fxRate);
    const { error: updateError } = await client
      .from("financial_items")
      .update({
        amount_twd: amountTwd,
        fx_rate_twd: fxRate,
        quote_currency: "USD",
        quote_source: "twelve_data",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    results.push(updateError
      ? { id: item.id, name: item.name, market: "MANUAL", status: "error", error: updateError.message }
      : { id: item.id, name: item.name, market: "MANUAL", status: "updated", currency: "USD", nativeAmount, amountTwd, fxRate });
  }

  for (const item of goldItems) {
    const grams = Number(item.quantity);
    if (!Number.isFinite(grams) || grams <= 0) {
      results.push({ id: item.id, name: item.name, market: "GOLD", status: "price_only", warning: "weight_missing", currency: "USD", price: xauUsd });
      continue;
    }
    if (!xauUsd || !fxRate) {
      results.push({ id: item.id, name: item.name, market: "GOLD", status: "error", error: goldError ?? fxError ?? "gold_unavailable" });
      continue;
    }
    const amountTwd = goldAmountTwd(grams, xauUsd, fxRate);
    const { error: updateError } = await client
      .from("financial_items")
      .update({
        amount_twd: amountTwd,
        fx_rate_twd: fxRate,
        quote_currency: "USD",
        quote_source: "twelve_data",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    results.push(updateError
      ? { id: item.id, name: item.name, market: "GOLD", status: "error", error: updateError.message, currency: "USD", price: xauUsd }
      : { id: item.id, name: item.name, market: "GOLD", status: "updated", grams, amountTwd, currency: "USD", price: xauUsd, fxRate });
  }

  // 寫回共用快取。只有在這一輪「每一檔都真的重抓到」、而且涵蓋 klfan_quotes
  // 現有的每一個代碼時才寫 —— KLFAN 是用整張表最新的 updated_at 判斷要不要重抓，
  // 只補一半會讓它把沒更新的那幾檔也當成新的，看起來很新其實是舊價。
  // 沒寫回也沒關係：那代表這一輪本來就是沿用快取，KLFAN 那邊也還夠新。
  let cacheWrite: string | null = null;
  if (cache && fxFetched && fxRate !== null) {
    const freshUs = new Map<string, { price: number; change: number; changePercent: number }>();
    for (const [key, quote] of usEntries) {
      if ("error" in quote || quote.cached) continue;
      freshUs.set(key.slice(3), quote);
    }
    const freshTw = new Map<string, { price: number; change: number; changePercent: number }>();
    for (const [key, quote] of twEntries) {
      if ("error" in quote) continue;
      freshTw.set(key.slice(3), quote);
    }
    const covered = [...cacheKeyFor.keys()].every((code) =>
      cachedTwCodes.has(code) ? freshTw.has(code) : freshUs.has(code));

    if (covered && (freshUs.size > 0 || freshTw.size > 0)) {
      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [
        { symbol: "USD/TWD", price: fxRate, currency: "TWD", change: null, change_percent: null, source: "twelve_data", quoted_at: now, updated_at: now },
      ];
      for (const [code, key] of cacheKeyFor) {
        const tw = cachedTwCodes.has(code);
        const quote = tw ? freshTw.get(code) : freshUs.get(code);
        if (!quote) continue;
        rows.push({
          symbol: key,
          price: quote.price,
          currency: tw ? "TWD" : "USD",
          change: quote.change,
          change_percent: quote.changePercent,
          source: tw ? "fugle" : "twelve_data",
          quoted_at: now,
          updated_at: now,
        });
      }
      const { error } = await cache.from("klfan_quotes").upsert(rows, { onConflict: "symbol" });
      cacheWrite = error ? error.message : `wrote_${rows.length}`;
    } else {
      cacheWrite = "skipped_partial_coverage";
    }
  }

  return json({
    source: "fugle+twelve_data",
    requestedAt: new Date().toISOString(),
    cache: { read: cachedUs.size + (cachedFx === null ? 0 : 1), write: cacheWrite, error: cacheError },
    fx: { symbol: "USD/TWD", rate: fxRate, error: fxError },
    gold: { symbol: "XAU/USD", price: xauUsd, error: goldError },
    updated: results.filter((x) => x.status === "updated").length,
    priceOnly: results.filter((x) => x.status === "price_only").length,
    failed: results.filter((x) => x.status === "error").length,
    results,
  });
});
