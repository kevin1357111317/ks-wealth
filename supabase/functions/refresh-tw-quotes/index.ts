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
    .select("id,name,symbol,market,quantity,amount_twd")
    .eq("kind", "asset")
    .in("market", ["TW", "US"])
    .not("symbol", "is", null);

  if (itemError) return json({ error: "items_unavailable", detail: itemError.message }, 500);

  const validSymbol = (symbol: string) => /^[0-9A-Z.-]{1,16}$/.test(symbol);
  const twSymbols = [...new Set((items ?? []).filter((x) => x.market === "TW").map((x) => String(x.symbol).toUpperCase()))].filter(validSymbol);
  const usSymbols = [...new Set((items ?? []).filter((x) => x.market === "US").map((x) => String(x.symbol).toUpperCase()))].filter(validSymbol);

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

  let fxRate: number | null = null;
  let fxError: string | null = null;
  if (usSymbols.length && twelveKey) {
    try {
      const response = await fetch(
        `https://api.twelvedata.com/exchange_rate?symbol=USD%2FTWD&apikey=${encodeURIComponent(twelveKey)}`,
        { headers: { "Accept": "application/json" } },
      );
      const data = await response.json();
      const rate = Number(data.rate);
      if (!response.ok || data.status === "error" || !Number.isFinite(rate) || rate <= 0) fxError = data.code ? `twelve_${data.code}` : "fx_unavailable";
      else fxRate = rate;
    } catch {
      fxError = "twelve_unreachable";
    }
  } else if (usSymbols.length) {
    fxError = "twelve_key_missing";
  }

  const usEntries = await Promise.all(usSymbols.map(async (symbol) => {
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
      }] as const;
    } catch {
      return [`US:${symbol}`, { error: "twelve_unreachable" }] as const;
    }
  }));

  const quotes = new Map([...twEntries, ...usEntries]);
  const results = [];

  for (const item of items ?? []) {
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
        quote_source: item.market === "US" ? "twelve_data" : "fugle",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);

    results.push(updateError
      ? { id: item.id, name: item.name, symbol, market: item.market, status: "error", error: updateError.message, ...quote }
      : { id: item.id, name: item.name, symbol, market: item.market, status: "updated", quantity, amountTwd, ...quote });
  }

  return json({
    source: "fugle+twelve_data",
    requestedAt: new Date().toISOString(),
    fx: { symbol: "USD/TWD", rate: fxRate, error: fxError },
    updated: results.filter((x) => x.status === "updated").length,
    priceOnly: results.filter((x) => x.status === "price_only").length,
    failed: results.filter((x) => x.status === "error").length,
    results,
  });
});
