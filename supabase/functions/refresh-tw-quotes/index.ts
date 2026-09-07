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

  // ── 報價表 klfan_quotes ────────────────────────────────────────────────────
  // Twelve Data 免費方案是每分鐘 8 credits、一個 symbol 算一個。這一輪要 USD/TWD
  // + 美股 + XAU/USD，全抓就快貼著上限，所以 10 分鐘內抓過的直接沿用，只有真的
  // 缺的才打 API。台股走 Fugle、沒有額度問題，一律重抓。
  //
  // klfan_quotes 原本是 KLFAN 那支 refresh-klfan-quotes 在維護，這裡只是共用它的
  // 結果。KS Wealth 已經不再呼叫那一支（同樣 8 檔抓兩次是純粹的重複，還把額度用掉
  // 一半），所以整張表的寫回與修剪都由這裡接手，見下方。
  // 讀寫走 service role，不必為了這張表放寬 RLS。
  const QUOTE_CACHE_TTL_MS = 10 * 60 * 1000;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cache = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

  type CachedQuote = { price: number; change: number; changePercent: number; quotedAt: string | null };
  const cachedUs = new Map<string, CachedQuote>();  // 'QQQ' -> 夠新、可直接沿用的報價
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
      // 台股走 Fugle、沒有額度問題，一律重抓，所以不必沿用快取。
      if (raw.startsWith("TPE:") || raw.startsWith("TWO:")) continue;
      const code = raw.slice(raw.lastIndexOf(":") + 1).toUpperCase();
      if (!code) continue;
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

  // XAU/USD 沒辦法放進 klfan_quotes（KLFAN 沒追黃金、會 prune，而且多一個它不認得的
  // 代碼會弄壞它的 updated_at 新鮮度判斷），所以走自己的 ks_quote_cache。
  // 沒有這層快取的話它每一輪都要重抓，而它又是最後才發出的請求 —— 同一分鐘跑兩輪
  // 就會超過免費方案的 8 credits，被擋掉的必然是它。
  let xauUsd: number | null = null;
  let goldError: string | null = null;
  let goldCached = false;
  if (goldItems.length > 0 && cache) {
    const { data } = await cache
      .from("ks_quote_cache")
      .select("price,updated_at")
      .eq("symbol", "XAU/USD")
      .maybeSingle();
    const price = Number(data?.price);
    if (data && Number.isFinite(price) && price > 0 &&
        Date.parse(String(data.updated_at ?? "")) >= Date.now() - QUOTE_CACHE_TTL_MS) {
      xauUsd = price;
      goldCached = true;
    }
  }
  if (goldItems.length > 0 && xauUsd === null && twelveKey) {
    try {
      const response = await fetch(
        `https://api.twelvedata.com/quote?symbol=XAU%2FUSD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const quote = await response.json();
      const price = Number(quote.close);
      if (!response.ok || quote.status === "error" || !Number.isFinite(price) || price <= 0) {
        goldError = quote.code ? `twelve_${quote.code}` : "gold_unavailable";
      } else {
        xauUsd = price;
        if (cache) {
          await cache.from("ks_quote_cache")
            .upsert({ symbol: "XAU/USD", price, updated_at: new Date().toISOString() }, { onConflict: "symbol" });
        }
      }
    } catch {
      goldError = "twelve_unreachable";
    }
  } else if (goldItems.length > 0 && xauUsd === null) {
    goldError = "twelve_key_missing";
  }

  // financial_items 的 fx_rate_twd 有兩個寫入者：這支函式（一輪只用一個 fxRate），
  // 以及 sync_klfan_financial_item() 觸發器 —— 它讀的是 klfan_fx_daily 最新那一列。
  // 兩邊各自取數，同一輪就會在 financial_items 留下兩個不同的匯率：2026-09-07 08:45
  // 美股是 31.61732、黃金與美元現金是 31.62785，差 0.03%。
  // 先把這一輪要用的匯率寫進 klfan_fx_daily，觸發器才會跟著同一個數字走。
  let fxDailyError: string | null = null;
  if (cache && fxRate !== null) {
    const taipeiToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const { error } = await cache
      .from("klfan_fx_daily")
      .upsert({ fx_date: taipeiToday, rate: fxRate }, { onConflict: "fx_date" });
    if (error) fxDailyError = error.message;
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

  // 寫回 klfan_quotes。以前這張表由 KLFAN 的 refresh-klfan-quotes 負責維護，這裡只是
  // 順手把抓到的價補回去給它用；KS Wealth 現在不再呼叫那一支了（同樣 8 檔抓兩次是純粹
  // 的重複，還把 Twelve Data 每分鐘 8 credits 的額度用掉一半），所以整張表由這裡接手。
  //
  // 追蹤名單改成跟著 klfan_live_symbols 走，而不是「klfan_quotes 現在有哪些列」——
  // 後者會讓一檔剛買進的股票永遠進不了表（表裡沒有它就不會去寫），而已出清的舊列又
  // 會讓涵蓋率永遠不滿、整個寫回停擺。修剪也一起接手：舊價留著會被當成即時價顯示，
  // 一個看起來很新、其實早就過期的價格比沒有價格更糟。
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

    const { data: liveRows, error: liveError } = await cache
      .from("klfan_live_symbols")
      .select("symbol");
    if (liveError) {
      cacheWrite = liveError.message;
    } else {
      // 'NASDAQ:QQQ' -> 'QQQ'，價格是照裸代號抓的，但寫回要用原本帶前綴的 key。
      const live = new Map<string, string>();
      for (const row of liveRows ?? []) {
        const raw = String(row.symbol ?? "").trim();
        if (raw) live.set(raw.slice(raw.lastIndexOf(":") + 1).toUpperCase(), raw);
      }
      const quoteOf = (code: string) => freshTw.get(code) ?? freshUs.get(code);
      const covered = [...live.keys()].every((code) => quoteOf(code) !== undefined);

      if (!covered) {
        // 有標的這一輪沒抓到就整批不寫。只補一半的話，最新的 updated_at 會讓沒更新的
        // 那幾檔也看起來很新。
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
          const { error: pruneError } = await cache
            .from("klfan_quotes")
            .delete()
            .not("symbol", "in", `(${keep})`);
          cacheWrite = pruneError ? `wrote_${rows.length}_prune_failed` : `wrote_${rows.length}`;
        }
      }
    }
  }

  return json({
    source: "fugle+twelve_data",
    requestedAt: new Date().toISOString(),
    cache: { read: cachedUs.size + (cachedFx === null ? 0 : 1), write: cacheWrite, error: cacheError },
    fx: { symbol: "USD/TWD", rate: fxRate, error: fxError, dailyError: fxDailyError },
    gold: { symbol: "XAU/USD", price: xauUsd, error: goldError, cached: goldCached },
    updated: results.filter((x) => x.status === "updated").length,
    priceOnly: results.filter((x) => x.status === "price_only").length,
    failed: results.filter((x) => x.status === "error").length,
    results,
  });
});
