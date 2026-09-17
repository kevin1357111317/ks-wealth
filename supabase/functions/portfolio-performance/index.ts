import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { buildPerformanceSeries, transactionFlows } from "./core.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, max-age=300" },
});
const taipeiDate = (value = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
}).format(value);
const dayOf = (value: string) => taipeiDate(new Date(value));
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

type ScopeSnapshot = { date: string; twTwd: number; usTwd: number; usUsd: number };

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
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) return json({ error: "supabase_config_missing" }, 500);

  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authHeader.slice(7);
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);

  const { data: membership, error: memberError } = await userClient.from("household_members")
    .select("household_id").eq("user_id", userData.user.id).limit(1).maybeSingle();
  if (memberError || !membership?.household_id) return json({ error: "household_unavailable" }, 403);
  const householdId = String(membership.household_id);
  let ownerScope = "husband";
  try {
    const body = await req.json();
    if (body?.owner_scope === "wife") ownerScope = "wife";
  } catch { /* default husband */ }

  const { data: currentItems, error: itemError } = await service.from("financial_items")
    .select("id,owner_scope,market,amount_twd,quantity,fx_rate_twd,created_at,portfolio_stock_key")
    .eq("household_id", householdId).eq("kind", "asset").not("portfolio_stock_key", "is", null);
  if (itemError) return json({ error: "items_unavailable" }, 500);

  const today = taipeiDate();
  const scopeTotals = { husband: { twTwd: 0, usTwd: 0, usUsd: 0 }, wife: { twTwd: 0, usTwd: 0, usUsd: 0 } };
  for (const item of currentItems ?? []) {
    const scope = item.owner_scope === "wife" ? "wife" : "husband";
    if (item.market === "TW") scopeTotals[scope].twTwd += number(item.amount_twd);
    if (item.market === "US") {
      scopeTotals[scope].usTwd += number(item.amount_twd);
      const fx = number(item.fx_rate_twd);
      if (fx > 0) scopeTotals[scope].usUsd += number(item.amount_twd) / fx;
    }
  }

  // 每天第一次開啟股票分析時留一筆收盤附近快照；06:00 的排程即使沒開 App 也會再補。
  const dayStart = `${today}T00:00:00+08:00`;
  const { data: todaySnapshot } = await service.from("activity_log").select("id")
    .eq("household_id", householdId).eq("entity_type", "portfolio_snapshot")
    .gte("created_at", dayStart).limit(1).maybeSingle();
  if (!todaySnapshot) await service.from("activity_log").insert({
    household_id: householdId,
    user_id: userData.user.id,
    entity_type: "portfolio_snapshot",
    entity_id: householdId,
    action: "snapshot",
    payload: { recorded_on: today, scopes: scopeTotals },
  });

  const historyStart = "2026-09-01";
  const events = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: eventError } = await service.from("activity_log")
      .select("entity_id,entity_type,payload,created_at")
      .eq("household_id", householdId)
      .in("entity_type", ["financial_items", "portfolio_snapshot"])
      .gte("created_at", `${historyStart}T00:00:00+08:00`)
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (eventError) return json({ error: "history_unavailable" }, 500);
    events.push(...(page ?? []));
    if ((page?.length ?? 0) < 1000) break;
  }

  const itemState = new Map<string, Record<string, unknown>>();
  const createdOn = new Map((currentItems ?? []).map(item => [String(item.id), dayOf(String(item.created_at))]));
  const daily = new Map<string, Record<string, ScopeSnapshot>>();
  const eventsByDay = new Map<string, typeof events>();
  for (const event of events) {
    const day = dayOf(String(event.created_at));
    eventsByDay.set(day, [...(eventsByDay.get(day) ?? []), event]);
  }
  for (const [date, dayEvents] of eventsByDay) {
    let saved: Record<string, ScopeSnapshot> | null = null;
    for (const event of dayEvents ?? []) {
      if (event.entity_type === "portfolio_snapshot") {
        const scopes = event.payload?.scopes;
        if (scopes) saved = {
          husband: { date, ...scopes.husband }, wife: { date, ...scopes.wife },
        };
      } else if (event.payload?.portfolio_stock_key) itemState.set(String(event.entity_id), event.payload);
    }
    if (saved) {
      daily.set(date, saved);
      continue;
    }
    const required = (currentItems ?? []).filter(item => (createdOn.get(String(item.id)) ?? date) <= date);
    if (!required.length || required.some(item => !itemState.has(String(item.id)))) continue;
    const totals = { husband: { date, twTwd: 0, usTwd: 0, usUsd: 0 }, wife: { date, twTwd: 0, usTwd: 0, usUsd: 0 } };
    for (const item of required) {
      const state = itemState.get(String(item.id));
      if (!state) continue;
      const scope = state.owner_scope === "wife" ? "wife" : "husband";
      const amount = number(state.amount_twd);
      if (state.market === "TW") totals[scope].twTwd += amount;
      if (state.market === "US") {
        totals[scope].usTwd += amount;
        const fx = number(state.fx_rate_twd);
        if (fx > 0) totals[scope].usUsd += amount / fx;
      }
    }
    daily.set(date, totals);
  }
  daily.set(today, {
    husband: { date: today, ...scopeTotals.husband }, wife: { date: today, ...scopeTotals.wife },
  });
  const snapshots = [...daily.values()].map(scopes => scopes[ownerScope]).filter(Boolean);
  if (snapshots.length < 2) return json({ ownerScope, start: snapshots[0]?.date ?? today, all: [], tw: [], us: [], status: "building" });
  const start = snapshots[0].date;

  const [{ data: stocks }, { data: transactions }, { data: fxRows }] = await Promise.all([
    service.from("klfan_stocks").select("key,currency,owner_scope").eq("household_id", householdId),
    service.from("klfan_transactions").select("stock_key,tx_date,amount").gte("tx_date", start),
    service.from("klfan_fx_daily").select("fx_date,rate").gte("fx_date", start).order("fx_date"),
  ]);
  const ownedStocks = (stocks ?? []).filter(stock => (stock.owner_scope ?? "husband") === ownerScope);
  const stockByKey = new Map(ownedStocks.map(stock => [stock.key, stock]));
  const fxHistory = (fxRows ?? []).map(row => ({ date: String(row.fx_date), rate: number(row.rate) }));
  const txWithTwd = (transactions ?? []).filter(tx => stockByKey.has(tx.stock_key)).map(tx => {
    const stock = stockByKey.get(tx.stock_key);
    const rate = [...fxHistory].reverse().find(row => row.date <= String(tx.tx_date))?.rate ?? 0;
    return { ...tx, twd: stock?.currency === "USD" ? number(tx.amount) * rate : number(tx.amount) };
  });
  const flows = transactionFlows(txWithTwd, stockByKey);

  const [twResponse, usResponse] = await Promise.all([
    fugleKey ? fetch(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/0050?from=${start}&to=${today}&fields=close`, {
      headers: { "X-API-KEY": fugleKey, "Accept": "application/json" },
    }).catch(() => null) : null,
    twelveKey ? fetch(`https://api.twelvedata.com/time_series?symbol=VOO&interval=1day&start_date=${start}&end_date=${today}&outputsize=5000&order=ASC&apikey=${encodeURIComponent(twelveKey)}`, {
      headers: { "Accept": "application/json" },
    }).catch(() => null) : null,
  ]);
  const twJson = twResponse?.ok ? await twResponse.json().catch(() => ({})) : {};
  const usJson = usResponse?.ok ? await usResponse.json().catch(() => ({})) : {};
  const twBenchmark = (twJson.data ?? twJson.values ?? []).map((row: Record<string, unknown>) => ({
    date: String(row.date ?? row.datetime ?? "").slice(0, 10), value: number(row.close),
  })).filter((row: { date: string; value: number }) => row.date && row.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  const usBenchmark = (usJson.values ?? []).map((row: Record<string, unknown>) => ({
    date: String(row.datetime ?? row.date ?? "").slice(0, 10), value: number(row.close),
  })).filter((row: { date: string; value: number }) => row.date && row.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  return json({
    ownerScope,
    start,
    benchmarkLabels: { all: "0050＋VOO 混合", tw: "0050", us: "VOO" },
    all: buildPerformanceSeries({ snapshots, flows, twBenchmark, usBenchmark, fxHistory, market: "all" }),
    tw: buildPerformanceSeries({ snapshots, flows, twBenchmark, usBenchmark, fxHistory, market: "tw" }),
    us: buildPerformanceSeries({ snapshots, flows, twBenchmark, usBenchmark, fxHistory, market: "us" }),
    status: twBenchmark.length && usBenchmark.length ? "ok" : "benchmark_partial",
  });
});
