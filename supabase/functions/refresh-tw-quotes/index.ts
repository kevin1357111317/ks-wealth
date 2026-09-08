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
const FULL_QUOTE_TTL_MS = 59 * 1000;
const goldAmountTwd = (grams: number, xauUsd: number, usdTwd: number) =>
  Math.round((grams / TROY_OUNCE_GRAMS) * xauUsd * usdTwd);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const fugleKey = Deno.env.get("FUGLE_MARKETDATA_API_KEY") ?? "";
  const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
  if (!supabaseUrl || !publishableKey) return json({ error: "supabase_config_missing" }, 500);
  if (!fugleKey && !twelveKey) return json({ error: "market_keys_missing" }, 503);

  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const cache = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  const token = authHeader.slice(7);
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);

  let scope = "all";
  try {
    const body = await req.json();
    if (body?.scope === "tw") scope = "tw";
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

  type CachedQuote = {
    price: number;
    change: number;
    changePercent: number;
    quotedAt: string | null;
    updatedAt: string | null;
  };

  const cachedUsFresh = new Map<string, CachedQuote>();
  const cachedUsStale = new Map<string, CachedQuote>();
  let cachedFxFresh: number | null = null;
  let cachedFxStale: number | null = null;
  let cachedGoldFresh: number | null = null;
  let cachedGoldStale: number | null = null;
  let cacheError: string | null = null;

  if (cache) {
    const [quotesResult, goldResult] = await Promise.all([
      cache.from("klfan_quotes").select("symbol,price,change,change_percent,quoted_at,updated_at"),
      cache.from("ks_quote_cache").select("price,updated_at").eq("symbol", "XAU/USD").maybeSingle(),
    ]);
    if (quotesResult.error) cacheError = quotesResult.error.message;
    const freshFloor = Date.now() - FULL_QUOTE_TTL_MS;
    for (const row of quotesResult.data ?? []) {
      const raw = String(row.symbol ?? "").trim();
      const price = Number(row.price);
      if (!raw || !Number.isFinite(price) || price <= 0) continue;
      const updatedAt = String(row.updated_at ?? "");
      const fresh = Date.parse(updatedAt) >= freshFloor;
      if (raw === "USD/TWD") {
        cachedFxStale = price;
        if (fresh) cachedFxFresh = price;
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
      };
      cachedUsStale.set(code, hit);
      if (fresh) cachedUsFresh.set(code, hit);
    }
    const goldPrice = Number(goldResult.data?.price);
    if (Number.isFinite(goldPrice) && goldPrice > 0) {
      cachedGoldStale = goldPrice;
      if (Date.parse(String(goldResult.data?.updated_at ?? "")) >= freshFloor) cachedGoldFresh = goldPrice;
    }
  }

  let fxFetched = false;
  let fxError: string | null = null;
  const needsUsdFx = usSymbols.length > 0 || usdCashItems.length > 0 || goldItems.length > 0;
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
    if (fresh) return [`US:${symbol}`, { provider: "twelve_data", currency: "USD", ...fresh, cached: true }] as const;
    if (!twelveKey) {
      const stale = cachedUsStale.get(symbol);
      return stale
        ? [`US:${symbol}`, { provider: "twelve_data", currency: "USD", ...stale, cached: true, stale: true }] as const
        : [`US:${symbol}`, { error: "twelve_key_missing" }] as const;
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

  // 台股、匯率、美股、黃金同時發出去，避免原本串行等待造成的延遲。
  const [twEntries, fxResult, usEntries, goldResult] = await Promise.all([
    Promise.all(twSymbols.map(fetchTw)),
    fetchFx(),
    Promise.all(usSymbols.map(fetchUs)),
    fetchGold(),
  ]);

  const fxRate = fxResult.rate;
  fxFetched = fxResult.fetched;
  fxError = fxResult.error;
  const xauUsd = goldResult.price;
  const goldError = goldResult.error;

  if (cache && goldResult.fetched && xauUsd) {
    await cache.from("ks_quote_cache")
      .upsert({ symbol: "XAU/USD", price: xauUsd, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
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
      const { error } = await client.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: item.market === "US" ? conversion : 1,
        quote_source: item.market === "US" ? "twelve_data" : "fugle",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
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
      const { error } = await client.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: fxRate,
        quote_currency: "USD",
        quote_source: "twelve_data",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      }).eq("id", item.id);
      return error
        ? { id: item.id, name: item.name, market: "MANUAL", status: "error", error: error.message }
        : { id: item.id, name: item.name, market: "MANUAL", status: "updated", currency: "USD", nativeAmount, amountTwd, fxRate };
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
      const { error } = await client.from("financial_items").update({
        amount_twd: amountTwd,
        fx_rate_twd: fxRate,
        quote_currency: "USD",
        quote_source: "twelve_data",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      }).eq("id", item.id);
      return error
        ? { id: item.id, name: item.name, market: "GOLD", status: "error", error: error.message, currency: "USD", price: xauUsd }
        : { id: item.id, name: item.name, market: "GOLD", status: "updated", grams, amountTwd, currency: "USD", price: xauUsd, fxRate, cached: goldResult.cached };
    })());
  }

  const results = await Promise.all(pendingUpdates);

  // KLFAN 共用行情表只在這輪真的拿到新 Twelve Data 匯率時更新，避免快取值被重新蓋上新時間戳。
  let cacheWrite: string | null = null;
  if (cache && fxFetched && fxRate !== null) {
    const freshUs = new Map<string, { price: number; change: number; changePercent: number }>();
    for (const [key, quote] of usEntries) {
      if ("error" in quote || quote.cached) continue;
      freshUs.set(key.slice(3), { price: Number(quote.price), change: Number(quote.change ?? 0), changePercent: Number(quote.changePercent ?? 0) });
    }
    const freshTw = new Map<string, { price: number; change: number; changePercent: number }>();
    for (const [key, quote] of twEntries) {
      if ("error" in quote) continue;
      freshTw.set(key.slice(3), { price: Number(quote.price), change: Number(quote.change ?? 0), changePercent: Number(quote.changePercent ?? 0) });
    }

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
        const rows: Record<string, unknown>[] = [
          { symbol: "USD/TWD", price: fxRate, currency: "TWD", change: null, change_percent: null, source: "twelve_data", quoted_at: now, updated_at: now },
        ];
        for (const [code, key] of live) {
          const tw = freshTw.has(code);
          const quote = quoteOf(code)!;
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

  return json({
    source: "fugle+twelve_data",
    requestedAt: new Date().toISOString(),
    cache: { read: cachedUsFresh.size + (cachedFxFresh === null ? 0 : 1) + (cachedGoldFresh === null ? 0 : 1), write: cacheWrite, error: cacheError, ttlMs: FULL_QUOTE_TTL_MS },
    fx: { symbol: "USD/TWD", rate: fxRate, error: fxError, dailyError: fxDailyError, cached: !fxFetched && fxRate !== null },
    gold: { symbol: "XAU/USD", price: xauUsd, error: goldError, cached: goldResult.cached },
    updated: results.filter((x) => x.status === "updated").length,
    priceOnly: results.filter((x) => x.status === "price_only").length,
    failed: results.filter((x) => x.status === "error").length,
    results,
  });
});
