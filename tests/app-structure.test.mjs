import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../app-v3.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const authTools = await readFile(new URL('../auth-tools.js', import.meta.url), 'utf8');
const healthCss = await readFile(new URL('../health.css', import.meta.url), 'utf8');

test('initial data renders before realtime and background quotes', () => {
  const resolver = source.slice(source.indexOf('async function resolveMembership'), source.indexOf('async function applySession'));
  assert.ok(resolver.indexOf('await loadData') < resolver.indexOf('subscribeRealtime()'));
  assert.ok(resolver.indexOf('subscribeRealtime()') < resolver.indexOf('void refreshQuotes'));
});

test('quote refresh and data loads use single-flight guards', () => {
  assert.match(source, /if \(loadFlight\) return loadFlight/);
  assert.match(source, /if \(quoteFlight\) return quoteFlight/);
});

test('realtime reloads are household-filtered and debounced', () => {
  assert.match(source, /filter: `household_id=eq\.\$\{householdId\}`/);
  assert.match(source, /}, 300\);/);
});

test('production shell loads the current app and PWA metadata', () => {
  // 只檢查有帶 cache-buster，不釘死版本字串 —— 釘死的話每次改 app-v3.js 都得順手改測試，
  // 而忘了改的下場是測試紅著、但 PWA 其實載的是舊 bundle。
  assert.match(html, /app-v3\.js\?v=[\w-]+/);
  assert.match(html, /portfolio\.css\?v=[\w-]+/);
  assert.match(html, /health\.css\?v=[\w-]+/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /apple-mobile-web-app-title" content="布布一二的家"/);
  assert.doesNotMatch(html, /src="\/app\.js/);
});

test('auth helpers and the app reuse one Supabase auth client', () => {
  assert.match(authTools, /window\.KS_SUPABASE_CLIENT\?\?createClient/);
  assert.match(authTools, /window\.KS_SUPABASE_CLIENT=sbAuth/);
  assert.match(source, /window\.KS_SUPABASE_CLIENT \?\? createClient/);
  assert.match(html, /auth-tools\.js\?v=[\w-]+/);
});

test('health opens with a couple comparison before individual trends', () => {
  assert.match(source, /let healthViewMode = 'compare'/);
  assert.match(source, /data-health-view="compare"/);
  assert.match(source, /buildHealthComparison/);
  assert.match(source, /一起看差異，不排名/);
});

test('couple health card is the first card on the family dashboard', () => {
  const dashboard = source.slice(source.indexOf('function dashboard()'), source.indexOf('function distributionPanel'));
  const rendered = dashboard.slice(dashboard.indexOf('shell(`'));
  assert.ok(rendered.indexOf('${healthEntry}') < rendered.indexOf('<section class="portfolioHero">'));
});

test('health trend charts keep reference lines but hide per-person bound labels', () => {
  const trendCard = source.slice(source.indexOf('function coupleHealthTrendCard'), source.indexOf('function healthValueChip'));
  assert.match(source, /healthReferenceMarkers/);
  assert.match(trendCard, /const label = shared/);
  assert.doesNotMatch(trendCard, /ownerLabel/);
  assert.match(trendCard, /healthCoupleRef \$\{ownerScope\}/);
  assert.match(source, /viewBox="0 0 340 180"/);
  assert.match(source, /healthReferenceState/);
  assert.match(healthCss, /@media\(max-width:520px\)\{\.healthTrendGrid\{grid-template-columns:1fr\}/);
  assert.match(healthCss, /\.healthTrendHead b\{[^}]*font-size:\.84rem/);
});

test('health trends live at the bottom of couple comparison and overlay both partners', () => {
  const comparisonPage = source.slice(source.indexOf('function healthComparisonPage'), source.indexOf('function healthPage'));
  const personalPage = source.slice(source.indexOf('function healthPage'), source.indexOf('function ownerPortfolioModel'));
  assert.match(comparisonPage, /selectCoupleHealthTrendGroups/);
  assert.match(comparisonPage, /coupleHealthTrendCard\(husbandModel, wifeModel, key\)/);
  assert.ok(comparisonPage.indexOf('各自優先事項') < comparisonPage.indexOf('夫妻歷年趨勢'));
  assert.doesNotMatch(personalPage, /重要指標趨勢|healthTrendGrid/);
  assert.match(source, /healthCoupleLine \$\{ownerScope\}/);
  assert.match(source, /尚無資料/);
  assert.match(healthCss, /\.healthCoupleLine\.husband/);
  assert.match(healthCss, /\.healthCoupleLine\.wife/);
  assert.doesNotMatch(healthCss, /\.healthCoupleLine\.wife\{[^}]*stroke-dasharray/);
  assert.match(comparisonPage, /鎧麟｜藍色實線・圓點/);
  assert.match(comparisonPage, /佳軒｜橘色實線・菱形/);
});
