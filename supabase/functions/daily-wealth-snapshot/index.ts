import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const CRON_SECRET_SHA256 = "6f3fa38700d6ca0ab69d39b60e6ddbcc5a24085193fd2c2eb7920c6c4ea23ef8";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const suppliedSecret = req.headers.get("x-cron-secret") ?? "";
  if (!suppliedSecret || await sha256(suppliedSecret) !== CRON_SECRET_SHA256) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const fugleKey = Deno.env.get("FUGLE_MARKETDATA_API_KEY") ?? "";
  const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "supabase_config_missing" }, 500);
  if (!fugleKey && !twelveKey) return json({ error: "market_keys_missing" }, 503);

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: items, error: itemError } = await client
    .from("financial_items")
    .select("id,household_id,owner_scope,kind,name,symbol,market,quantity,amount_twd,native_currency,native_amount")
    .order("created_at");
  if (itemError) return json({ error: "items_unavailable", detail: itemError.message }, 500);

  const marketItems = (items ?? []).filter((item) =>
    item.kind === "asset" && ["TW", "US"].includes(item.market) && item.symbol
  );
  const usdCashItems = (items ?? []).filter((item) =>
    item.kind === "asset" && item.market === "MANUAL" && item.native_currency === "USD" && Number(item.native_amount) >= 0
  );
  const validSymbol = (symbol: string) => /^[0-9A-Z.-]{1,16}$/.test(symbol);
  const twSymbols = [...new Set(marketItems.filter((item) => item.market === "TW").map((item) => String(item.symbol).toUpperCase()))].filter(validSymbol);
  const usSymbols = [...new Set(marketItems.filter((item) => item.market === "US").map((item) => String(item.symbol).toUpperCase()))].filter(validSymbol);

  const twEntries = await Promise.all(twSymbols.map(async (symbol) => {
    if (!fugleKey) return [`TW:${symbol}`, { error: "fugle_key_missing" }] as const;
    try {
      const response = await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(symbol)}`, {
        headers: { "X-API-KEY": fugleKey, "Accept": "application/json" },
      });
      const quote = await response.json();
      const price = Number(quote.lastPrice ?? quote.closePrice ?? quote.previousClose);
      if (!response.ok || !Number.isFinite(price) || price <= 0) return [`TW:${symbol}`, { error: `fugle_${response.status}` }] as const;
      return [`TW:${symbol}`, { price, provider: "fugle" }] as const;
    } catch {
      return [`TW:${symbol}`, { error: "fugle_unreachable" }] as const;
    }
  }));

  let fxRate: number | null = null;
  if ((usSymbols.length || usdCashItems.length) && twelveKey) {
    try {
      const response = await fetch(`https://api.twelvedata.com/exchange_rate?symbol=USD%2FTWD&apikey=${encodeURIComponent(twelveKey)}`);
      const data = await response.json();
      const rate = Number(data.rate);
      if (response.ok && data.status !== "error" && Number.isFinite(rate) && rate > 0) fxRate = rate;
    } catch { /* keep the previous stored values when FX is unavailable */ }
  }

  const usEntries = await Promise.all(usSymbols.map(async (symbol) => {
    if (!twelveKey) return [`US:${symbol}`, { error: "twelve_key_missing" }] as const;
    try {
      const response = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(twelveKey)}`);
      const quote = await response.json();
      const price = Number(quote.close);
      if (!response.ok || quote.status === "error" || !Number.isFinite(price) || price <= 0) return [`US:${symbol}`, { error: `twelve_${quote.code ?? response.status}` }] as const;
      return [`US:${symbol}`, { price, provider: "twelve_data" }] as const;
    } catch {
      return [`US:${symbol}`, { error: "twelve_unreachable" }] as const;
    }
  }));

  const quotes = new Map([...twEntries, ...usEntries]);
  let updated = 0;
  let failed = 0;
  for (const item of marketItems) {
    const symbol = String(item.symbol).toUpperCase();
    const quote = quotes.get(`${item.market}:${symbol}`);
    const quantity = Number(item.quantity);
    const conversion = item.market === "US" ? fxRate : 1;
    if (!quote || "error" in quote || !Number.isFinite(quantity) || quantity <= 0 || !conversion) {
      failed += 1;
      continue;
    }
    const amountTwd = Math.round(quote.price * quantity * conversion);
    const { error } = await client.from("financial_items").update({
      amount_twd: amountTwd,
      fx_rate_twd: item.market === "US" ? conversion : 1,
      quote_source: quote.provider,
      updated_at: new Date().toISOString(),
    }).eq("id", item.id);
    if (error) failed += 1;
    else updated += 1;
  }

  for (const item of usdCashItems) {
    if (!fxRate) {
      failed += 1;
      continue;
    }
    const amountTwd = Math.round(Number(item.native_amount) * fxRate);
    const { error } = await client.from("financial_items").update({
      amount_twd: amountTwd,
      fx_rate_twd: fxRate,
      quote_currency: "USD",
      quote_source: "twelve_data",
      updated_at: new Date().toISOString(),
    }).eq("id", item.id);
    if (error) failed += 1;
    else updated += 1;
  }

  const { data: refreshedItems, error: refreshedError } = await client
    .from("financial_items")
    .select("household_id,owner_scope,kind,amount_twd");
  if (refreshedError) return json({ error: "snapshot_read_failed", detail: refreshedError.message }, 500);

  const taipeiToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const snapshotDate = new Date(`${taipeiToday}T00:00:00Z`);
  snapshotDate.setUTCDate(snapshotDate.getUTCDate() - 1);
  const recordedOn = snapshotDate.toISOString().slice(0, 10);
  const households = new Set<string>();
  const scopeTotals = new Map<string, number>();
  const familyTotals = new Map<string, number>();
  for (const item of refreshedItems ?? []) {
    const hid = String(item.household_id);
    const amount = Number(item.amount_twd) || 0;
    households.add(hid);
    scopeTotals.set(`${hid}:${item.owner_scope}:${item.kind}`, (scopeTotals.get(`${hid}:${item.owner_scope}:${item.kind}`) ?? 0) + amount);
    familyTotals.set(hid, (familyTotals.get(hid) ?? 0) + (item.kind === "asset" ? amount : -amount));
  }

  const scopeRows = [...households].flatMap((householdId) =>
    ["husband", "wife"].flatMap((ownerScope) => ["asset", "liability"].map((kind) => ({
      household_id: householdId,
      owner_scope: ownerScope,
      kind,
      total_twd: scopeTotals.get(`${householdId}:${ownerScope}:${kind}`) ?? 0,
      recorded_on: recordedOn,
      source: "next-day-06-taipei",
      created_at: new Date().toISOString(),
    })))
  );
  const familyRows = [...households].map((householdId) => ({
    household_id: householdId,
    recorded_on: recordedOn,
    net_worth_twd: familyTotals.get(householdId) ?? 0,
    source: "next-day-06-taipei",
    created_by: null,
    created_at: new Date().toISOString(),
  }));

  const scopeWrite = scopeRows.length
    ? await client.from("financial_scope_history").upsert(scopeRows, { onConflict: "household_id,owner_scope,kind,recorded_on" })
    : { error: null };
  const familyWrite = familyRows.length
    ? await client.from("net_worth_history").upsert(familyRows, { onConflict: "household_id,recorded_on" })
    : { error: null };
  if (scopeWrite.error || familyWrite.error) return json({
    error: "snapshot_write_failed",
    scope: scopeWrite.error?.message ?? null,
    family: familyWrite.error?.message ?? null,
  }, 500);

  return json({ ok: true, recordedOn, updated, failed, fxRate, households: households.size });
});
