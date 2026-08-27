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
  if (!supabaseUrl || !publishableKey) return json({ error: "supabase_config_missing" }, 500);
  if (!fugleKey) return json({ error: "fugle_key_missing" }, 503);

  const client = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = authHeader.slice(7);
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);

  const { data: items, error: itemError } = await client
    .from("financial_items")
    .select("id,name,symbol,quantity,amount_twd")
    .eq("kind", "asset")
    .eq("market", "TW")
    .not("symbol", "is", null);

  if (itemError) return json({ error: "items_unavailable", detail: itemError.message }, 500);

  const symbols = [...new Set((items ?? []).map((item) => String(item.symbol).toUpperCase()))]
    .filter((symbol) => /^[0-9A-Z]{2,12}$/.test(symbol));

  const quoteEntries = await Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await fetch(
        `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(symbol)}`,
        { headers: { "X-API-KEY": fugleKey, "Accept": "application/json" } },
      );
      if (!response.ok) return [symbol, { error: `fugle_${response.status}` }] as const;
      const quote = await response.json();
      const price = Number(quote.lastPrice ?? quote.closePrice ?? quote.previousClose);
      if (!Number.isFinite(price) || price <= 0) return [symbol, { error: "price_unavailable" }] as const;
      return [symbol, {
        price,
        change: Number(quote.change ?? 0),
        changePercent: Number(quote.changePercent ?? 0),
        date: quote.date ?? null,
        lastUpdated: quote.lastUpdated ?? null,
      }] as const;
    } catch {
      return [symbol, { error: "fugle_unreachable" }] as const;
    }
  }));

  const quotes = new Map(quoteEntries);
  const results = [];

  for (const item of items ?? []) {
    const symbol = String(item.symbol).toUpperCase();
    const quote = quotes.get(symbol);
    if (!quote || "error" in quote) {
      results.push({ id: item.id, name: item.name, symbol, status: "error", error: quote?.error ?? "invalid_symbol" });
      continue;
    }

    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      results.push({ id: item.id, name: item.name, symbol, status: "price_only", ...quote });
      continue;
    }

    const amountTwd = Math.round(quote.price * quantity);
    const { error: updateError } = await client
      .from("financial_items")
      .update({
        amount_twd: amountTwd,
        quote_source: "fugle",
        updated_by: userData.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);

    results.push(updateError
      ? { id: item.id, name: item.name, symbol, status: "error", error: updateError.message, ...quote }
      : { id: item.id, name: item.name, symbol, status: "updated", quantity, amountTwd, ...quote });
  }

  return json({
    source: "fugle",
    requestedAt: new Date().toISOString(),
    updated: results.filter((x) => x.status === "updated").length,
    priceOnly: results.filter((x) => x.status === "price_only").length,
    failed: results.filter((x) => x.status === "error").length,
    results,
  });
});
