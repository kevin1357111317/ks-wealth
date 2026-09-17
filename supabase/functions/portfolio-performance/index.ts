import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { buildHistoricalSnapshots, buildPerformanceSeries, downsampleSeries, transactionFlows, yahooPriceRows } from "./core.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, max-age=1800" },
});
const taipeiDate = (value = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
}).format(value);
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const bareSymbol = (value: unknown) => String(value ?? "").replace(/^(TPE:|TWO:|NASDAQ:|NYSEARCA:|NYSE:|BATS:)/i, "").toUpperCase();
const dateShift = (date: string, { years = 0, days = 0 }) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() + years);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

type PriceRow = { date: string; value: number };
type StockRow = { key: string; symbol: string; market: string; currency: string; owner_scope: string };
type YahooHistory = { close: PriceRow[]; adjusted: PriceRow[] };

async function yahooHistory(symbol: string, start: string, end: string): Promise<YahooHistory> {
  const period1 = Math.floor(Date.parse(`${dateShift(start, { days: -7 })}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${dateShift(end, { days: 2 })}T00:00:00Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  try {
    const response = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "KS-Wealth/1.0" } });
    if (!response.ok) return { close: [], adjusted: [] };
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    // 持股市值用 close，因為台帳已另外記錄股息；Benchmark 用 adjusted close，
    // 才能把現金股息再投入納入總報酬，且不會和個人台帳重複計息。
    return { close: yahooPriceRows(result, "close"), adjusted: yahooPriceRows(result, "adjusted") };
  } catch { return { close: [], adjusted: [] }; }
}

async function fetchHistories(symbols: string[], start: string, end: string) {
  const output = new Map<string, YahooHistory>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, symbols.length) }, async () => {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor++];
      output.set(symbol, await yahooHistory(symbol, start, end));
    }
  });
  await Promise.all(workers);
  return output;
}

const periodStart = (period: string, today: string, earliest: string) => period === "ytd"
  ? `${today.slice(0, 4)}-01-01`
  : period === "year" ? dateShift(today, { years: -1 }) : earliest;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) return json({ error: "supabase_config_missing" }, 500);
  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser(authHeader.slice(7));
  if (userError || !userData.user) return json({ error: "unauthorized" }, 401);
  const { data: membership, error: memberError } = await userClient.from("household_members")
    .select("household_id").eq("user_id", userData.user.id).limit(1).maybeSingle();
  if (memberError || !membership?.household_id) return json({ error: "household_unavailable" }, 403);
  const householdId = String(membership.household_id);
  let ownerScope = "husband";
  try { if ((await req.json())?.owner_scope === "wife") ownerScope = "wife"; } catch { /* default husband */ }

  const { data: allStocks, error: stockError } = await service.from("klfan_stocks")
    .select("key,symbol,market,currency,owner_scope").eq("household_id", householdId);
  if (stockError) return json({ error: "stocks_unavailable" }, 500);
  const stocks = (allStocks ?? []).filter((stock: StockRow) => (stock.owner_scope ?? "husband") === ownerScope);
  if (!stocks.length) return json({ ownerScope, periods: {}, status: "building" });
  const stockKeys = stocks.map((stock: StockRow) => stock.key);
  const transactions = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error: txError } = await service.from("klfan_transactions")
      .select("id,stock_key,tx_date,amount,shares,kind").in("stock_key", stockKeys)
      .order("tx_date").order("id").range(from, from + 999);
    if (txError) return json({ error: "transactions_unavailable" }, 500);
    transactions.push(...(page ?? []));
    if ((page?.length ?? 0) < 1000) break;
  }
  const earliest = String(transactions?.[0]?.tx_date ?? taipeiDate());
  const today = taipeiDate();

  const twCodes = stocks.filter((stock: StockRow) => stock.market === "台股").map((stock: StockRow) => bareSymbol(stock.symbol));
  const { data: boards } = twCodes.length
    ? await service.from("tw_stock_names").select("code,board").in("code", twCodes)
    : { data: [] };
  const boardByCode = new Map((boards ?? []).map((row: { code: string; board: string }) => [row.code, row.board]));
  const yahooByKey = new Map(stocks.map((stock: StockRow) => {
    const code = bareSymbol(stock.symbol || stock.key);
    const yahoo = stock.market === "台股" ? `${code}.${boardByCode.get(code) === "TWO" ? "TWO" : "TW"}` : code;
    return [stock.key, yahoo];
  }));
  const requested = [...new Set([...yahooByKey.values(), "0050.TW", "VOO", "QQQ", "SOXX", "TWD=X"])];
  const histories = await fetchHistories(requested, earliest, today);
  const fxHistory = (histories.get("TWD=X")?.close ?? []).map(row => ({ date: row.date, rate: row.value }));
  const priceHistory = new Map(stocks.map((stock: StockRow) => [stock.key, histories.get(yahooByKey.get(stock.key) ?? "")?.close ?? []]));
  const missing = stocks.filter((stock: StockRow) => !(priceHistory.get(stock.key)?.length)).map((stock: StockRow) => stock.key);
  const snapshots = buildHistoricalSnapshots({ stocks, transactions, priceHistory, fxHistory });
  const stockByKey = new Map(stocks.map((stock: StockRow) => [stock.key, stock]));
  const txWithTwd = (transactions ?? []).map((transaction: Record<string, unknown>) => {
    const stock = stockByKey.get(String(transaction.stock_key));
    const rate = [...fxHistory].reverse().find(row => row.date <= String(transaction.tx_date))?.rate ?? 0;
    return { ...transaction, twd: stock?.currency === "USD" ? number(transaction.amount) * rate : number(transaction.amount) };
  });
  const flows = transactionFlows(txWithTwd, stockByKey);
  const twBenchmark = histories.get("0050.TW")?.adjusted ?? [];
  const usBenchmarks = new Map(["VOO", "QQQ", "SOXX"].map(symbol => [symbol, histories.get(symbol)?.adjusted ?? []]));
  const usBenchmark = usBenchmarks.get("VOO") ?? [];
  const periods: Record<string, unknown> = {};
  for (const period of ["ytd", "year", "all"]) {
    const start = periodStart(period, today, earliest);
    const periodSnapshots = snapshots.filter(row => row.date >= start);
    const series = (market: string, benchmarkMode: string, benchmark: PriceRow[]) => downsampleSeries(buildPerformanceSeries({
      snapshots: periodSnapshots, flows, twBenchmark,
      usBenchmark: benchmark, fxHistory, market, benchmarkMode,
    }));
    const allBenchmarks = {
      mixed: series("all", "mixed", usBenchmark),
      VOO: series("all", "us", usBenchmarks.get("VOO") ?? []),
      QQQ: series("all", "us", usBenchmarks.get("QQQ") ?? []),
      SOXX: series("all", "us", usBenchmarks.get("SOXX") ?? []),
    };
    const twBenchmarks = { "0050": series("tw", "tw", []) };
    const usComparisons = {
      VOO: series("us", "us", usBenchmarks.get("VOO") ?? []),
      QQQ: series("us", "us", usBenchmarks.get("QQQ") ?? []),
      SOXX: series("us", "us", usBenchmarks.get("SOXX") ?? []),
    };
    periods[period] = {
      start: periodSnapshots[0]?.date ?? start,
      all: allBenchmarks.mixed,
      tw: twBenchmarks["0050"],
      us: usComparisons.VOO,
      benchmarks: { all: allBenchmarks, tw: twBenchmarks, us: usComparisons },
    };
  }
  const ytd = periods.ytd as { all: unknown[]; tw: unknown[]; us: unknown[] };
  return json({
    ownerScope, earliest, periods, all: ytd.all, tw: ytd.tw, us: ytd.us,
    benchmarkLabels: { mixed: "0050＋VOO 動態混合", "0050": "0050", VOO: "VOO", QQQ: "QQQ", SOXX: "SOXX" },
    benchmarkOptions: { all: ["mixed", "VOO", "QQQ", "SOXX"], tw: ["0050"], us: ["VOO", "QQQ", "SOXX"] },
    coverage: { requested: stocks.length, missing: missing.length },
    status: missing.length || !twBenchmark.length || !usBenchmark.length ? "benchmark_partial" : "ok",
  });
});
